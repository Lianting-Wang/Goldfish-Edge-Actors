// src/actor.js

/**
 * GoldfishActor: 多类型 Actor 实现，用于课堂抢答系统。
 *
 * 支持的 actorType：
 *  - "teacher"  老师
 *  - "room"     房间（一个教室/一场活动）
 *  - "student"  学生
 *  - "question" 单个题目
 *
 * 所有请求都来自 router.js：
 *  body: { actorType, actorId, payload }
 *
 * 本文件做三件事：
 *  1. 初始化 / 恢复内存 memory
 *  2. 根据 actorType 分发到对应的 handleXxxMessage(...)
 *  3. 把更新后的 memory 存回 Durable Storage
 *
 * 额外提供：
 *  - GET /status 可以查看当前 Actor 的完整内存，用于课堂展示。
 */

export class GoldfishActor {
  /**
   * @param {DurableObjectState} state
   * @param {any} env
   */
  constructor(state, env) {
    this.state = state;
    this.env = env;

    this.memory = null;      // 短期 + 可快照的状态
    this.initialized = false;
  }

  async fetch(request) {
    const url = new URL(request.url);

    // 业务调用入口：由 Router DO 通过 /invoke 进入
    if (url.pathname === "/invoke" && request.method === "POST") {
      await this.ensureInitialized();

      const body = await request.json().catch(() => ({}));
      const { payload, actorType, actorId } = body;

      const now = Date.now();

      const ctx = {
        actorType,
        actorId,
        memory: this.memory,
        storage: this.state.storage,
        env: this.env,
        now
      };

      const { result, nextPolicy, spawn } = await this.handleMessage(payload, ctx);

      // 把 memory 存回 Durable Storage（快照）
      await this.state.storage.put("memory", this.memory);

      return new Response(
        JSON.stringify({ result, nextPolicy, spawn }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // 状态查看入口：GET /status → 返回整个 memory（课堂展示用）
    if (url.pathname === "/status" && request.method === "GET") {
      await this.ensureInitialized();
      return new Response(
        JSON.stringify(this.memory || {}, null, 2),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // 管理员重置入口，清除 storage & memory
    if (url.pathname === "/admin-reset" && request.method === "POST") {
        // 删掉持久化的 "memory"
        await this.state.storage.delete("memory");
        // 清空内存里的 memory，并标记未初始化
        this.memory = {};
        this.initialized = false;

        return new Response(
        JSON.stringify({ ok: true, action: "admin-reset" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
        );
    }

    return new Response("GoldfishActor DO", { status: 200 });
  }

  async ensureInitialized() {
    if (this.initialized) return;

    const stored = await this.state.storage.get("memory");
    this.memory = stored || {};
    this.initialized = true;
  }

  /**
   * 顶层分发：根据 actorType 调用不同的 handler。
   * 所有 handler 都返回 { result, nextPolicy, spawn }。
   */
  async handleMessage(payload, ctx) {
    const { actorType, actorId, memory, now } = ctx;

    // 为所有 actor 记录一些通用元信息
    memory.actorType = memory.actorType || actorType;
    memory.actorId = memory.actorId || actorId;
    memory.lastActiveAt = now;

    let res;

    if (actorType === "teacher") {
      res = await handleTeacherMessage(payload, ctx);
    } else if (actorType === "room") {
      res = await handleRoomMessage(payload, ctx);
    } else if (actorType === "student") {
      res = await handleStudentMessage(payload, ctx);
    } else if (actorType === "question") {
      res = await handleQuestionMessage(payload, ctx);
    } else {
      res = {
        result: { error: "Unknown actorType", actorType },
        nextPolicy: { mode: "immediate" },
        spawn: []
      };
    }

    // 确保默认值存在
    if (!res.nextPolicy) {
      res.nextPolicy = { mode: "immediate" };
    }
    if (!res.spawn) {
      res.spawn = [];
    }

    return res;
  }
}

/* -------------------------------------------------------------------------- */
/*                              TeacherActor 逻辑                              */
/* -------------------------------------------------------------------------- */

/**
 * TeacherActor 用来：
 *  - 记录自己创建的 room 与 question
 *  - 通过 Router 向 Room / Question 发送消息，实现“用 Actor 创建 Actor”
 *
 * memory 结构示例：
 * {
 *   actorType: "teacher",
 *   actorId: "t1",
 *   rooms: ["class-101", "class-202"],
 *   questionsByRoom: {
 *     "class-101": ["q1", "q2", "q3"]
 *   },
 *   lastActiveAt: ...
 * }
 */
async function handleTeacherMessage(payload, ctx) {
  const { actorId, memory, env } = ctx;
  const type = payload?.type;

  memory.kind = memory.kind || "teacher";
  memory.teacherId = memory.teacherId || actorId;
  memory.rooms = memory.rooms || [];
  memory.questionsByRoom = memory.questionsByRoom || {};

  if (!type) {
    return {
      result: { error: "Missing payload.type for teacher" },
      nextPolicy: { mode: "immediate" },
      spawn: []
    };
  }

  // 老师创建房间
  if (type === "createRoom") {
    const roomId = payload.roomId;
    const roomName = payload.roomName || roomId;

    if (!roomId) {
      return {
        result: { error: "roomId is required" },
        nextPolicy: { mode: "immediate" }
      };
    }

    if (!memory.rooms.includes(roomId)) {
      memory.rooms.push(roomId);
    }

    // 通过 Router 发送消息给 RoomActor，初始化房间
    await sendToActor(env, "room", roomId, {
      type: "initRoom",
      teacherId: actorId,
      roomName
    });

    return {
      result: {
        ok: true,
        action: "createRoom",
        roomId,
        roomName
      },
      nextPolicy: { mode: "immediate" }
    };
  }

  // 老师为某房间创建题目
  if (type === "createQuestions") {
    const roomId = payload.roomId;
    const questions = payload.questions || [];

    if (!roomId) {
      return {
        result: { error: "roomId is required" },
        nextPolicy: { mode: "immediate" }
      };
    }

    const qIds = [];
    for (const q of questions) {
      const qId = q.questionId;
      if (!qId) continue;
      qIds.push(qId);

      // 初始化 QuestionActor
      await sendToActor(env, "question", qId, {
        type: "initQuestion",
        roomId,
        text: q.text,
        options: q.options,
        correctOption: q.correctOption,
        durationMs: q.durationMs
      });
    }

    // 告诉 RoomActor 这些 question 的列表
    if (qIds.length > 0) {
      await sendToActor(env, "room", roomId, {
        type: "registerQuestions",
        questionIds: qIds
      });
    }

    memory.questionsByRoom[roomId] = qIds;

    return {
      result: {
        ok: true,
        action: "createQuestions",
        roomId,
        questionIds: qIds
      },
      nextPolicy: { mode: "immediate" }
    };
  }

  // 老师开始当前题目
  if (type === "startQuestion") {
    const roomId = payload.roomId;
    if (!roomId) {
      return {
        result: { error: "roomId is required" },
        nextPolicy: { mode: "immediate" }
      };
    }

    const resp = await sendToActor(env, "room", roomId, {
      type: "startCurrentQuestion"
    });

    return {
      result: {
        ok: resp.ok,
        roomId,
        fromRoom: resp.result || resp.error
      },
      nextPolicy: { mode: "immediate" }
    };
  }

  // 老师结束当前题目（触发统计）
  if (type === "finishCurrentQuestion") {
    const roomId = payload.roomId;
    if (!roomId) {
      return {
        result: { error: "roomId is required" },
        nextPolicy: { mode: "immediate" }
      };
    }

    const resp = await sendToActor(env, "room", roomId, {
      type: "finishCurrentQuestion"
    });

    return {
      result: {
        ok: resp.ok,
        roomId,
        fromRoom: resp.result || resp.error
      },
      nextPolicy: { mode: "immediate" }
    };
  }

  // 老师结束整场房间（统计总分 + 排名）
  if (type === "finishRoom") {
    const roomId = payload.roomId;
    if (!roomId) {
      return {
        result: { error: "roomId is required" },
        nextPolicy: { mode: "immediate" }
      };
    }

    const resp = await sendToActor(env, "room", roomId, {
      type: "finishRoom"
    });

    return {
      result: {
        ok: resp.ok,
        roomId,
        fromRoom: resp.result || resp.error
      },
      nextPolicy: { mode: "immediate" }
    };
  }

  return {
    result: { error: `Unknown teacher payload.type: ${type}` },
    nextPolicy: { mode: "immediate" }
  };
}

/* -------------------------------------------------------------------------- */
/*                               RoomActor 逻辑                               */
/* -------------------------------------------------------------------------- */

function unwrapRouterResult(resp) {
  if (!resp) return {};
  // Router 外层: { ok, result: { result: inner, actorKey } }
  if (resp.result && resp.result.result) return resp.result.result;
  if (resp.result) return resp.result;
  return resp;
}

/**
 * RoomActor 负责：
 *  - 维护房间元信息（teacher, students, questions）
 *  - 管理当前进行到第几题
 *  - 在每题结束时向 QuestionActor 拉取 summary，更新 scores & 排名
 *
 * memory 示例：
 * {
 *   kind: "room",
 *   roomId: "class-101",
 *   teacherId: "t1",
 *   roomName: "网络课程01",
 *   students: ["s1", "s2"],
 *   questions: ["q1", "q2", "q3"],
 *   currentQuestionIndex: 0,
 *   scores: { "s1": 2, "s2": 1 },
 *   status: "waiting" | "in_question" | "finished"
 * }
 */
async function handleRoomMessage(payload, ctx) {
  const { actorId, memory, env, now } = ctx;
  const type = payload?.type;

  memory.kind = memory.kind || "room";
  memory.roomId = memory.roomId || actorId;
  memory.students = memory.students || [];
  memory.questions = memory.questions || [];
  memory.currentQuestionIndex = memory.currentQuestionIndex || 0;
  memory.scores = memory.scores || {};
  memory.status = memory.status || "waiting";
  memory.roomName = memory.roomName || payload?.roomName || memory.roomId;

  if (!type) {
    return {
      result: { error: "Missing payload.type for room" },
      nextPolicy: { mode: "immediate" }
    };
  }

  // 初始化房间（来自 TeacherActor）
  if (type === "initRoom") {
    memory.teacherId = payload.teacherId || memory.teacherId;
    memory.roomName = payload.roomName || memory.roomName;

    return {
      result: {
        ok: true,
        action: "initRoom",
        roomId: memory.roomId,
        teacherId: memory.teacherId,
        roomName: memory.roomName
      },
      nextPolicy: { mode: "immediate" }
    };
  }

  // 注册题目列表（来自 TeacherActor）
  if (type === "registerQuestions") {
    const ids = payload.questionIds || [];
    memory.questions = ids;
    memory.currentQuestionIndex = 0;
    memory.status = "waiting";

    return {
      result: {
        ok: true,
        action: "registerQuestions",
        roomId: memory.roomId,
        questions: memory.questions
      },
      nextPolicy: { mode: "immediate" }
    };
  }

  // 学生加入房间
  if (type === "join") {
    const studentId = payload.studentId;
    const name = payload.name;

    if (!studentId) {
      return {
        result: { error: "studentId is required" },
        nextPolicy: { mode: "immediate" }
      };
    }

    if (!memory.students.includes(studentId)) {
      memory.students.push(studentId);
    }

    // 通知 StudentActor 记录自己加入了这个 room
    await sendToActor(env, "student", studentId, {
      type: "joinRoom",
      roomId: memory.roomId,
      name
    });

    return {
      result: {
        ok: true,
        action: "join",
        roomId: memory.roomId,
        studentId,
        students: memory.students
      },
      nextPolicy: { mode: "immediate" }
    };
  }

  // 老师开始当前题目
  if (type === "startCurrentQuestion") {
    if (memory.questions.length === 0) {
      return {
        result: { error: "No questions registered for this room" },
        nextPolicy: { mode: "immediate" }
      };
    }

    if (memory.currentQuestionIndex >= memory.questions.length) {
      return {
        result: { error: "All questions already finished" },
        nextPolicy: { mode: "immediate" }
      };
    }

    const qId = memory.questions[memory.currentQuestionIndex];

    // 通知 QuestionActor 开始（记录 startTime）
    const resp = await sendToActor(env, "question", qId, {
      type: "start"
    });

    memory.status = "in_question";
    memory.currentQuestionId = qId;
    memory.questionStartedAt = now;

    return {
      result: {
        ok: resp.ok,
        action: "startCurrentQuestion",
        roomId: memory.roomId,
        questionId: qId,
        fromQuestion: resp.result || resp.error
      },
      nextPolicy: { mode: "immediate" }
    };
  }

  // 教师结束当前题目：拉 summary，更新 scores
  if (type === "finishCurrentQuestion") {
    if (memory.questions.length === 0) {
      return {
        result: { error: "No questions registered for this room" },
        nextPolicy: { mode: "immediate" }
      };
    }

    if (memory.currentQuestionIndex >= memory.questions.length) {
      return {
        result: { error: "All questions already finished" },
        nextPolicy: { mode: "immediate" }
      };
    }

    const qId = memory.questions[memory.currentQuestionIndex];

    const resp = await sendToActor(env, "question", qId, {
      type: "getSummary"
    });

    if (!resp.ok) {
      return {
        result: { error: "Failed to get question summary", fromQuestion: resp },
        nextPolicy: { mode: "immediate" }
      };
    }

    const sum = unwrapRouterResult(resp);
    const correctStudents = sum.correctStudents || [];
    const allAnswers = sum.answers || {};

    // 为所有答对的学生加 1 分
    for (const sid of correctStudents) {
      memory.scores[sid] = (memory.scores[sid] || 0) + 1;

      // 也通知 StudentActor 更新自己的记录
      const ans = allAnswers[sid] || {};
      const timeUsedMs = ans.answeredAt && sum.startTime
        ? ans.answeredAt - sum.startTime
        : null;

      await sendToActor(env, "student", sid, {
        type: "updateScore",
        roomId: memory.roomId,
        questionId: qId,
        correct: true,
        scoreDelta: 1,
        timeUsedMs
      });
    }

    // 更新当前题目索引
    memory.currentQuestionIndex += 1;
    memory.status = memory.currentQuestionIndex >= memory.questions.length
      ? "finished"
      : "waiting";

    // 如果全部结束，计算排名
    if (memory.status === "finished") {
      const ranking = Object.entries(memory.scores)
        .sort(([, a], [, b]) => b - a)
        .map(([sid, score], idx) => ({
          rank: idx + 1,
          studentId: sid,
          score
        }));
      memory.ranking = ranking;
    }

    return {
      result: {
        ok: true,
        action: "finishCurrentQuestion",
        roomId: memory.roomId,
        questionId: qId,
        correctStudents,
        scores: memory.scores,
        status: memory.status,
        ranking: memory.ranking || null
      },
      nextPolicy: { mode: "immediate" }
    };
  }

  // 结束整场房间（如果没有提前 finishCurrentQuestion，也可以在此处补齐）
  if (type === "finishRoom") {
    // 简单处理：如果还有未完成的题目，就提示错误
    if (memory.currentQuestionIndex < memory.questions.length) {
      return {
        result: {
          error: "Not all questions have been finished. Please call finishCurrentQuestion for each first.",
          currentQuestionIndex: memory.currentQuestionIndex,
          totalQuestions: memory.questions.length
        },
        nextPolicy: { mode: "immediate" }
      };
    }

    memory.status = "finished";

    // 若前面已经算过 ranking，这里直接返回；否则计算一次
    if (!memory.ranking) {
      const ranking = Object.entries(memory.scores)
        .sort(([, a], [, b]) => b - a)
        .map(([sid, score], idx) => ({
          rank: idx + 1,
          studentId: sid,
          score
        }));
      memory.ranking = ranking;
    }

    return {
      result: {
        ok: true,
        action: "finishRoom",
        roomId: memory.roomId,
        scores: memory.scores,
        ranking: memory.ranking
      },
      nextPolicy: { mode: "immediate" }
    };
  }

  return {
    result: { error: `Unknown room payload.type: ${type}` },
    nextPolicy: { mode: "immediate" }
  };
}

/* -------------------------------------------------------------------------- */
/*                             StudentActor 逻辑                               */
/* -------------------------------------------------------------------------- */

/**
 * StudentActor 负责：
 *  - 记录自己加入过哪些房间
 *  - 记录每道题的答题情况
 *  - 计算自己的总分
 *
 * memory 示例：
 * {
 *   kind: "student",
 *   studentId: "s1",
 *   name: "Alice",
 *   rooms: ["class-101"],
 *   answers: [
 *     { roomId, questionId, correct, scoreDelta, timeUsedMs }
 *   ],
 *   totalScore: 2
 * }
 */
async function handleStudentMessage(payload, ctx) {
  const { actorId, memory } = ctx;
  const type = payload?.type;

  memory.kind = memory.kind || "student";
  memory.studentId = memory.studentId || actorId;
  memory.rooms = memory.rooms || [];
  memory.answers = memory.answers || [];
  memory.totalScore = memory.totalScore || 0;

  if (!type) {
    return {
      result: { error: "Missing payload.type for student" },
      nextPolicy: { mode: "immediate" }
    };
  }

  // 学生加入房间
  if (type === "joinRoom") {
    const roomId = payload.roomId;
    const name = payload.name;

    if (name && !memory.name) {
      memory.name = name;
    }
    if (roomId && !memory.rooms.includes(roomId)) {
      memory.rooms.push(roomId);
    }

    return {
      result: {
        ok: true,
        action: "joinRoom",
        studentId: memory.studentId,
        name: memory.name,
        rooms: memory.rooms
      },
      nextPolicy: { mode: "immediate" }
    };
  }

  // 题目结束后由 RoomActor 更新分数
  if (type === "updateScore") {
    const record = {
      roomId: payload.roomId,
      questionId: payload.questionId,
      correct: !!payload.correct,
      scoreDelta: payload.scoreDelta || 0,
      timeUsedMs: payload.timeUsedMs ?? null
    };

    memory.answers.push(record);
    memory.totalScore += record.scoreDelta;

    return {
      result: {
        ok: true,
        action: "updateScore",
        studentId: memory.studentId,
        totalScore: memory.totalScore,
        lastRecord: record
      },
      nextPolicy: { mode: "immediate" }
    };
  }

  return {
    result: { error: `Unknown student payload.type: ${type}` },
    nextPolicy: { mode: "immediate" }
  };
}

/* -------------------------------------------------------------------------- */
/*                            QuestionActor 逻辑                               */
/* -------------------------------------------------------------------------- */

/**
 * QuestionActor 负责：
 *  - 保存题面 / 选项 / 正确答案 / 时长
 *  - 管理一题的倒计时窗口（startTime ~ startTime + durationMs）
 *  - 记录所有学生的答案
 *  - 提供 getSummary 给 RoomActor 统计成绩
 *
 * memory 示例：
 * {
 *   kind: "question",
 *   questionId: "q1",
 *   roomId: "class-101",
 *   text: "...",
 *   options: ["A...", "B...", ...],
 *   correctOption: "B",
 *   durationMs: 10000,
 *   startTime: 1733512400000,
 *   status: "pending" | "running" | "ended",
 *   answers: {
 *     "s1": { option: "B", correct: true, answeredAt: 1733512403000, late: false }
 *   }
 * }
 */
async function handleQuestionMessage(payload, ctx) {
  const { actorId, memory, now } = ctx;
  const type = payload?.type;

  memory.kind = memory.kind || "question";
  memory.questionId = memory.questionId || actorId;
  memory.answers = memory.answers || {};
  memory.status = memory.status || "pending";

  if (!type) {
    return {
      result: { error: "Missing payload.type for question" },
      nextPolicy: { mode: "immediate" }
    };
  }

  // 初始化题目（来自 TeacherActor）
  if (type === "initQuestion") {
    memory.roomId = payload.roomId;
    memory.text = payload.text || "";
    memory.options = payload.options || [];
    memory.correctOption = payload.correctOption;
    memory.durationMs = payload.durationMs || 10000;
    memory.startTime = null;
    memory.status = "pending";
    memory.answers = {};

    return {
      result: {
        ok: true,
        action: "initQuestion",
        questionId: memory.questionId,
        roomId: memory.roomId,
        durationMs: memory.durationMs
      },
      nextPolicy: { mode: "immediate" }
    };
  }

  // 开始倒计时（来自 RoomActor）
  if (type === "start") {
    memory.startTime = now;
    memory.status = "running";
    memory.answers = {}; // 清空旧答案（如果有的话）

    return {
      result: {
        ok: true,
        action: "start",
        questionId: memory.questionId,
        roomId: memory.roomId,
        startTime: memory.startTime,
        durationMs: memory.durationMs
      },
      nextPolicy: { mode: "immediate" }
    };
  }

  // 学生提交答案（通过 Router，actorType=question, actorId=questionId）
  if (type === "submitAnswer") {
    const studentId = payload.studentId;
    const option = payload.option;

    if (!studentId) {
      return {
        result: { error: "studentId is required" },
        nextPolicy: { mode: "immediate" }
      };
    }

    if (!option) {
      return {
        result: { error: "option is required" },
        nextPolicy: { mode: "immediate" }
      };
    }

    if (memory.status !== "running" || !memory.startTime) {
      // 不在计时时间内，直接标为错误（或拒绝）
      memory.answers[studentId] = {
        option,
        correct: false,
        answeredAt: now,
        late: true
      };
      return {
        result: {
          ok: false,
          reason: "Question not running or expired",
          questionId: memory.questionId,
          roomId: memory.roomId
        },
        nextPolicy: { mode: "immediate" }
      };
    }

    const deadline = memory.startTime + memory.durationMs;
    const late = now > deadline;

    const correct = !late && option === memory.correctOption;

    memory.answers[studentId] = {
      option,
      correct,
      answeredAt: now,
      late
    };

    return {
      result: {
        ok: true,
        action: "submitAnswer",
        questionId: memory.questionId,
        roomId: memory.roomId,
        studentId,
        correct,
        late
      },
      nextPolicy: { mode: "immediate" }
    };
  }

  // RoomActor 在题目结束后调用 getSummary 做统计
  if (type === "getSummary") {
    // 可以在这里把状态改为 ended
    memory.status = "ended";

    const correctStudents = [];
    const allAnswers = memory.answers || {};

    for (const [sid, ans] of Object.entries(allAnswers)) {
      if (ans.correct) correctStudents.push(sid);
    }

    const summary = {
      questionId: memory.questionId,
      roomId: memory.roomId,
      status: memory.status,
      startTime: memory.startTime,
      durationMs: memory.durationMs,
      correctStudents,
      answers: allAnswers
    };

    return {
      result: summary,
      nextPolicy: { mode: "immediate" }
    };
  }

  return {
    result: { error: `Unknown question payload.type: ${type}` },
    nextPolicy: { mode: "immediate" }
  };
}

/* -------------------------------------------------------------------------- */
/*                               工具函数：消息发送                            */
/* -------------------------------------------------------------------------- */

/**
 * 从一个 Actor 发消息给“另一个 actorType + actorId”。
 * 实现方式：通过对应 actorType 的 Router DO /route 入口转发。
 *
 * 这样可以：
 *  - 保证所有消息仍然经过 Router 的队列与串行语义
 *  - 逻辑上完全符合“Actor 之间通过消息通信”的模式
 *
 * 返回值形如：
 *  { ok: true, result: ... }
 * 或
 *  { ok: false, error: "..." }
 */
async function sendToActor(env, actorType, actorId, payload) {
  // 每个 actorType 对应一个 Router DO 实例
  const routerId = env.GOLDFISH_ROUTER.idFromName(actorType);
  const routerStub = env.GOLDFISH_ROUTER.get(routerId);

  const resp = await routerStub.fetch("https://router.internal/route", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ actorType, actorId, payload })
  });

  if (!resp.ok) {
    return {
      ok: false,
      error: `Router responded with status ${resp.status}`
    };
  }

  const json = await resp.json().catch(() => null);
  if (!json) {
    return { ok: false, error: "Invalid JSON from router" };
  }

  return json; // { ok, result } 来自 router.handleRoute
}
