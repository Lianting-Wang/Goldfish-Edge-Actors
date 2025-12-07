# Goldfish – Cloudflare Workers Durable-Object Actor System

Goldfish is an implementation of the **Goldfish actor model** on top of **Cloudflare Workers + Durable Objects (DOs)**.
This repository is a **from-scratch re-implementation and extension** of the *GoldFish* actor model, originally proposed for serverless edge applications, but adapted to **Cloudflare Durable Objects**, with significant enhancements:

* **Router-Actor architecture** that preserves ordering, lifecycle, and isolation
* **Short-term actor memory** (restored across activations)
* **Middleware-like queue & scheduling logic**
* **Message routing across many actor types**
* **Typed Actor states (Teacher, Room, Student, Question)**
* **Full demonstration system: a real-time classroom quiz**
* **All running serverlessly on Cloudflare’s global edge network**

This repo is primarily a port of the Goldfish actor model to Cloudflare Workers + Durable Objects. The classroom quiz is just a concrete demo; the core work is the Router DO + Actor DO design (lifecycle, middleware-style guards, spawn semantics) that keeps each logical actor serialized and observable.

---

# Core Architecture: Router DO + Actor DO

The system consists of **two durable object layers**, each with a distinct responsibility.

---

## 1. Router DO (`GoldfishRouter`)

**One Router DO per `actorType`**
(e.g., one for `teacher`, one for `room`, etc.)

The Router acts as the **front door** and **middleware** for all logical actors of the same type.

### Responsibilities

#### **Message dispatch & serialization**

Each logical actor instance (`actorType:actorId`) gets its own **in-memory queue** inside the Router.
This guarantees that messages for the same actor are processed **strictly in order**, mirroring Goldfish semantics.

#### **Queue governance**

* Maximum queue length
* Payload size limit
* Per-message timeout
* Rejection or backpressure if limits are exceeded

#### **Lifecycle metadata**

The Router periodically persists lightweight metadata snapshots:

```json
{
  "busy": false,
  "queueLength": 2,
  "updatedAt": 1731234567890
}
```

This provides observability into a large distributed actor system.

#### **Spawn hints**

If an Actor DO returns:

```js
{ spawn: ["childA", "childB"] }
```

the Router pre-allocates (initializes) sibling actors in advance.
This is critical for patterns such as:

* fan-out workers
* pre-warming children
* cascading actor creation

#### **Admin & test endpoints**

* `/status` returns all known actors and queue states
* `/reset` wipes in-memory tables + stored metadata (useful for integration tests)

---

## 2. Actor DO (`GoldfishActor`)

**One Actor DO per `actorType:actorId`**
(e.g., `teacher:teacher-1`, `room:room-101`, `question:q3`)

The Actor DO contains **the actual business logic**.

### Responsibilities

#### **Load / persist memory snapshot**

Each actor has its own `memory` object:

```js
{
  roomId: "room-101",
  students: ["s1", "s2"],
  currentQuestionIndex: 1,
  scores: { "s1": 2, "s2": 1 }
}
```

Memory is loaded once when the DO boots, and saved after every invocation.

#### **Message handler**

Every invocation returns the full Goldfish envelope:

```js
{
  result,
  nextPolicy: { mode: "immediate" | "wait" | "reject", redirectTo? },
  spawn: ["child1", "child2"]
}
```

This enables the Router to decide:

* continue immediately
* pause for the next drain cycle
* reject pending messages
* or propagate messages to a different actor

#### **Status endpoints**

Every Actor DO exposes:

* `/invoke` — main message handler
* `/status` — dumps its current memory (used heavily in the demo + debugging)
* `/admin-reset` — wipes memory snapshot

---

## 3. Middleware-Like Flow

The Router layer acts roughly like an **Express middleware stack**:

| Layer     | Responsibility                                                                                               |
| --------- | ------------------------------------------------------------------------------------------------------------ |
| Router DO | Authentication, payload validation, rate limit, serialization, timeout fencing, spawn prep, meta persistence |
| Actor DO  | Business rules, domain logic, state mutation, lifecycle bookkeeping                                          |

Together, they reproduce the **Goldfish lifecycle** inside Cloudflare:

1. Validate & enqueue message
2. Serialize actor messages
3. Load short-lived state
4. Run handler
5. Save memory
6. Enforce pacing/failure/backpressure policies

This enables **safe concurrency**, **deterministic sequencing**, and **observability** without locks or centralized schedulers.

---

# Architecture Overview

```
+----------------+
|   Worker API   |
|  /actor        |
|  /actor-status |
|  /router-status|
+--------+-------+
         |
         v
+------------------------+
|   GoldfishRouter DO    |  (per actorType)
| - Message queues       |
| - Scheduling loop      |
| - Overflow control     |
| - Timeout logic        |
+-----------+------------+
            |
            v
+------------------------+
|     GoldfishActor DO   |  (per actorKey)
| - Short-term memory    |
| - Business handlers    |
| - Next-policy control  |
| - Spawn logic          |
+------------------------+
```

---

# Demo Domain: Four Actor Types

To prove that the runtime is expressive, the repo includes a multi-actor "Classroom Quiz" demo with four actors:

| Actor Type | Examples      | Responsibilities                                          |
| ---------- | ------------- | --------------------------------------------------------- |
| `teacher`  | `teacher-1`   | create room, create questions, start/finish rounds        |
| `room`     | `room-101`    | track students, orchestrate questions, score aggregation  |
| `student`  | `s1`  | submit answers, track personal history                    |
| `question` | `q1` | countdown state, accept/validate answers, compute summary |

This demo stresses the actor system in ways that typical CRUD apps do not:

* **Multi-actor coordination**: teacher → room → question → students → room
* **Fan-out / fan-in** across actors
* **Countdown & timing-sensitive logic**
* **Score aggregation** across independent actors
* **Serialization guarantees** during concurrent answer submissions
* **High observability** through DO `/status` endpoints

The result is a realistic demonstration of how a distributed actor system behaves in a real application.

---

# Repository layout
- `src/index.js` – Worker fetch handler and public API wiring.
- `src/router.js` – GoldfishRouter Durable Object (queueing + dispatch).
- `src/actor.js` – GoldfishActor Durable Object (state machines for teacher/room/student/question).
- `public/` – Static UIs (`/board`, `/student`) shipped via the Workers Assets binding.
- `test/` – Node-based end-to-end test script (`npm test`) that drives the HTTP API.
- `wrangler.jsonc` – Worker + Durable Object bindings and assets configuration.

---

# How the Pieces Fit Together

## Router DO (`src/router.js`)

* One router per actorType (`teacher`, `student`, etc.)
* Stores per-actor queues (`actorId → queue[]`)
* Tracks whether an actor is currently `busy`
* Uses a draining loop to process one message at a time
* Persists metadata so external clients can observe system state

## Actor DO (`src/actor.js`)

* One DO per logical actor
* Loads short-lived memory
* Runs domain-specific handlers (e.g., handleTeacherMessage)
* Saves memory snapshot every time
* Returns `{ result, nextPolicy, spawn }` to Router
* Exposes `/status` to dump current actor state

## Worker entry (`src/index.js`)

The public API surface:

| Endpoint             | Purpose                           |
| -------------------- | --------------------------------- |
| `POST /invoke`        | Send a message to Router → Actor  |
| `GET /actor-status`  | Read DO memory                    |
| `GET /router-status` | Inspect queue/busy/metadata       |
| `POST /reset-router` | Clean slate for integration tests |
| Serves `/public`     | scoreboard + student-answer UIs   |

It is intentionally minimal – nearly all logic is in DOs.

## Frontend

Two small pages in `/public` demonstrate how to call the system:

* **`question_board.html`** (teacher dashboard)

  * Create/start questions
  * See countdown timers
  * Watch real-time scores and rankings

* **`student_answer.html`** (student page)

  * Join room
  * Answer questions
  * Receive correctness + score updates

Despite being static HTML, these pages illustrate how to interact with:
`/invoke`, `/actor-status`, `/router-status`.

---

# Running Locally

## Prerequisites
- Node 18+ (uses built-in `fetch`).
- Cloudflare Wrangler v4 (`npm install --global wrangler`) and a Cloudflare account for deploys.

## Install dependencies
```bash
npm install
```

## Run locally
```bash
# Start the Worker locally (defaults to http://localhost:8787)
npm run dev
```
- Teacher board: `http://localhost:8787/board`
- Student client: `http://localhost:8787/student`
- The dev server also hosts the API endpoints below.

## HTTP API
- `POST /invoke` – Send a message to an actor. Body: `{ actorType, actorId, payload }`.
- `GET /actor-status?actorType=room&actorId=room-101` – Snapshot of a single Actor DO’s memory (for dashboards).
- `GET /router-status?actorType=room` – Router queue/busy/policy summary for an actor type.
- `POST /reset-actor` – Body: `{ actorType, actorId }` → clears a single actor instance.
- `POST /reset-router` – Body: `{ actorType }` → clears router metadata for that actor type and asks all child actors to reset.
- Static: `/board` (teacher view) and `/student` (student view). Root `/` also points to the student page.

## Running tests
`npm test` runs `test/run-all-tests.js`, which drives the full quiz workflow over HTTP.
```bash
# In one terminal, keep the Worker running locally:
npm run dev

# In another terminal:
npm test
```

### Testing Strategy

**`test-quiz.js`**

The script will:

* Creates a room, three questions, and three students
* Starts all three questions sequentially
* Students submit answers
* Scores are aggregated
* Rankings are computed
* Finally `/reset-router` cleans all state

The test proves that the actor system correctly handles:

* actor scheduling
* message ordering
* multi-actor workflows
* durability of snapshots
* reset / cleanup logic

## State resets during development
- Clear a single actor instance: `curl -X POST http://localhost:8787/reset-actor -d '{"actorType":"question","actorId":"q1"}'`.
- Clear all router metadata (and ask child actors to reset) for one actor type: `curl -X POST http://localhost:8787/reset-router -d '{"actorType":"room"}'`.

## Deploy to Cloudflare
```bash
# First deploy will run the DO migration tag "v1"
npm run deploy
```
Wrangler will create/upgrade Durable Object classes `GoldfishRouter` and `GoldfishActor` and bind the static assets directory.

---

# Acknowledgements

* **GoldFish: Serverless Actors with Short-Term Memory State for the Edge-Cloud Continuum**
  Provided the conceptual foundation for lifecycle + middleware + short-lived actor memory.
* Cloudflare Workers & Durable Objects
  Provided a modern, global actor runtime.
