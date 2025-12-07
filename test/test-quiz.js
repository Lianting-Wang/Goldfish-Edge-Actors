// End-to-end test for the classroom quiz system.
//
// Flow:
//  1. Teacher creates a room.
//  2. Teacher creates 3 questions for that room.
//  3. Three students join the room.
//  4. For each question:
//     - Teacher starts the question.
//     - All students submit answers.
//     - Teacher finishes the current question (Room aggregates scores).
//  5. Teacher finishes the room and shows final ranking.
//  6. Test calls /reset-router to clear all state.
//
// Requirements:
//  - Node 18+ (built-in fetch)
//  - Your Worker running at BASE (default: http://localhost:8787)
//    and exposing:
//      POST /invoke
//      GET  /actor-status
//      POST /reset-router

const BASE = process.env.BASE_URL || "http://localhost:8787";

async function postJSON(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {})
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }

  return { status: res.status, body: json };
}

async function getJSON(path) {
  const res = await fetch(`${BASE}${path}`);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, body: json };
}

async function postActor(actorType, actorId, payload) {
  return postJSON("/invoke", { actorType, actorId, payload });
}

async function getActorStatus(actorType, actorId) {
  const qs =
    `?actorType=${encodeURIComponent(actorType)}` +
    `&actorId=${encodeURIComponent(actorId)}`;
  return getJSON(`/actor-status${qs}`);
}

function logStep(title) {
  console.log("\n==================================================");
  console.log(title);
  console.log("==================================================");
}

async function main() {
  // IDs we will use for this run
  const teacherId = "teacher-1";
  const roomId = "room-101";
  const students = [
    { id: "s1", name: "Alice" },
    { id: "s2", name: "Bob" },
    { id: "s3", name: "Carol" }
  ];

  const questions = [
    {
      questionId: "q1",
      text: "1 + 1 = ?",
      options: ["A. 1", "B. 2", "C. 3"],
      correctOption: "B",
      durationMs: 10000
    },
    {
      questionId: "q2",
      text: "What is the default HTTP port?",
      options: ["A. 22", "B. 80", "C. 443"],
      correctOption: "B",
      durationMs: 10000
    },
    {
      questionId: "q3",
      text: "Cloudflare Workers are best suited to run on?",
      options: ["A. Edge nodes", "B. Local PC", "C. Inside a database"],
      correctOption: "A",
      durationMs: 10000
    }
  ];

  // Predefined answers for all 3 questions (some right, some wrong)
  const questionAnswers = {
    q1: {
      s1: "B", // correct
      s2: "A", // wrong
      s3: "B"  // correct
    },
    q2: {
      s1: "B", // correct
      s2: "B", // correct
      s3: "C"  // wrong
    },
    q3: {
      s1: "A", // correct
      s2: "A", // correct
      s3: "B"  // wrong
    }
  };

  /* STEP 1: Teacher creates room */
  logStep("STEP 1: Teacher creates room");

  let resp = await postActor("teacher", teacherId, {
    type: "createRoom",
    roomId,
    roomName: "Networks Class - Quiz Demo"
  });
  console.log("createRoom response:", JSON.stringify(resp.body, null, 2));

  resp = await getActorStatus("room", roomId);
  console.log("Room initial state:", JSON.stringify(resp.body, null, 2));

  /* STEP 2: Teacher creates 3 questions */
  logStep("STEP 2: Teacher creates 3 questions");

  resp = await postActor("teacher", teacherId, {
    type: "createQuestions",
    roomId,
    questions
  });
  console.log("createQuestions response:", JSON.stringify(resp.body, null, 2));

  resp = await getActorStatus("room", roomId);
  console.log(
    "Room after registerQuestions:",
    JSON.stringify(resp.body, null, 2)
  );

  resp = await getActorStatus("question", "q1");
  console.log("Question q1 initial state:", JSON.stringify(resp.body, null, 2));

  /* STEP 3: Students join room */
  logStep("STEP 3: Students join the room");

  for (const s of students) {
    const joinResp = await postActor("room", roomId, {
      type: "join",
      studentId: s.id,
      name: s.name
    });
    console.log(
      `join room response (${s.id}):`,
      JSON.stringify(joinResp.body, null, 2)
    );
  }

  resp = await getActorStatus("room", roomId);
  console.log(
    "Room after students join:",
    JSON.stringify(resp.body, null, 2)
  );

  resp = await getActorStatus("student", "s1");
  console.log("Student s1 state:", JSON.stringify(resp.body, null, 2));

  /* STEP 4–6: Run all 3 questions */
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const qId = q.questionId;
    logStep(`QUESTION ${i + 1}: ${qId} - start, answer, finish`);

    // 4.1 Teacher starts this question (delegated to RoomActor)
    resp = await postActor("teacher", teacherId, {
      type: "startQuestion",
      roomId
    });
    console.log("startQuestion response:", JSON.stringify(resp.body, null, 2));

    // Show question state after start
    resp = await getActorStatus("question", qId);
    console.log(
      `Question ${qId} after start:`,
      JSON.stringify(resp.body, null, 2)
    );

    // 4.2 Students submit answers for this question
    console.log(`Submitting answers for ${qId}...`);
    const answersForQ = questionAnswers[qId];
    for (const s of students) {
      const option = answersForQ[s.id];
      const ansResp = await postActor("question", qId, {
        type: "submitAnswer",
        studentId: s.id,
        option
      });
      console.log(
        `submitAnswer ${s.id} (${option}):`,
        JSON.stringify(ansResp.body, null, 2)
      );
    }

    // Show question state including all answers
    resp = await getActorStatus("question", qId);
    console.log(
      `Question ${qId} with answers:`,
      JSON.stringify(resp.body, null, 2)
    );

    // 4.3 Teacher finishes this question (Room aggregates scores)
    resp = await postActor("teacher", teacherId, {
      type: "finishCurrentQuestion",
      roomId
    });
    console.log(
      "finishCurrentQuestion response:",
      JSON.stringify(resp.body, null, 2)
    );

    // Show room scores after this question
    resp = await getActorStatus("room", roomId);
    console.log(
      `Room state after finishing ${qId}:`,
      JSON.stringify(resp.body, null, 2)
    );
  }

  /* STEP 7: Finish the room and show final ranking */
  logStep("STEP 7: Finish room and show final ranking");

  resp = await postActor("teacher", teacherId, {
    type: "finishRoom",
    roomId
  });
  console.log("finishRoom response:", JSON.stringify(resp.body, null, 2));

  // Final room state with ranking
  resp = await getActorStatus("room", roomId);
  console.log("Final room state:", JSON.stringify(resp.body, null, 2));

  // Final student states
  for (const s of students) {
    const sResp = await getActorStatus("student", s.id);
    console.log(
      `Final state of student ${s.id}:`,
      JSON.stringify(sResp.body, null, 2)
    );
  }

  /* STEP 8: Reset all router/actor state */
  logStep("STEP 8: Reset router / clear all state");

  /**
   * Order does not matter, but resetting student/question/teacher/room covers everything.
   * Each reset hits the Router DO for that actorType.
   */
  const actorTypesToReset = ["student", "question", "teacher", "room"];

  for (const type of actorTypesToReset) {
    const resetRes = await postJSON("/reset-router", { actorType: type });
    console.log(
      `reset-router response for actorType=${type}:`,
      JSON.stringify(resetRes.body, null, 2)
    );
  }

  console.log("\n All router states have been reset.");

  console.log(
    "\n✅ Test script finished. If all steps look correct, your actor-based quiz system is working end-to-end."
  );
}

main().catch((err) => {
  console.error("❌ Test script failed with error:", err);
  process.exit(1);
});
