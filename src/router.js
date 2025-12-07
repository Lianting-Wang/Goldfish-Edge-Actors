export class GoldfishRouter {
  /**
   * @param {DurableObjectState} state
   * @param {any} env
   */
  constructor(state, env) {
    this.state = state;
    this.env = env;

    // 每个 actor 的调度状态（内存）：actorKey -> { busy, queue, policy, ... }
    this.actors = new Map();

    // messageId -> Promise 的 resolve/reject
    this.pendingResults = new Map();

    this.isDraining = false;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/route" && request.method === "POST") {
      return this.handleRoute(request);
    }

    if (url.pathname === "/status" && request.method === "GET") {
      return this.handleStatus(request);
    }

    // 管理员重置该 Router 管的所有 actor 的 meta（并可选通知 Actor 本身清理）
    if (url.pathname === "/admin-reset" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const { actorTypePrefix } = body; 
      // 比如传 "room:" 或 "" 表示全部

      const prefix = "meta:" + (actorTypePrefix || "");
      const all = await this.state.storage.list({ prefix });

      for (const [key, meta] of all.entries()) {
        const actorKey = key.slice("meta:".length); // 去掉 meta:
        // 调用对应的 Actor /admin-reset（可选）
        const actorDoId = this.env.GOLDFISH_ACTOR.idFromName(actorKey);
        const actorStub = this.env.GOLDFISH_ACTOR.get(actorDoId);
        await actorStub.fetch("https://actor.internal/admin-reset", {
          method: "POST"
        });
        // 删除 meta
        await this.state.storage.delete(key);
      }

      return new Response(
        JSON.stringify({ ok: true, cleared: [...all.keys()] }, null, 2),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response("GoldfishRouter DO", { status: 200 });
  }

  /**
   * 来自 Worker 的调用入口
   */
  async handleRoute(request) {
    const body = await request.json().catch(() => null);
    if (!body) {
      return new Response("Invalid JSON", { status: 400 });
    }

    const { actorType, actorId, payload } = body;
    const actorKey = `${actorType}:${actorId}`;

    let actorState = this.actors.get(actorKey);
    if (!actorState) {
      actorState = {
        actorKey,
        actorType,
        actorId,
        busy: false,
        queue: [],
        policy: {
          queueLimit: 100,           // 队列长度上限
          timeoutMs: 30_000,         // 单请求超时
          maxPayloadBytes: 64 * 1024 // 简单的 payload 大小限制
        }
      };
      this.actors.set(actorKey, actorState);
    }

    // 粗略 payload size 检查（JSON 长度）
    const payloadSize = payload ? JSON.stringify(payload).length : 0;
    if (payloadSize > actorState.policy.maxPayloadBytes) {
      return new Response(
        JSON.stringify({ ok: false, error: "Payload too large" }),
        { status: 413, headers: { "Content-Type": "application/json" } }
      );
    }

    // 队列限流
    if (actorState.queue.length >= actorState.policy.queueLimit) {
      return new Response(
        JSON.stringify({ ok: false, error: "Queue is full" }),
        { status: 429, headers: { "Content-Type": "application/json" } }
      );
    }

    const messageId = crypto.randomUUID();
    const message = {
      messageId,
      payload,
      enqueuedAt: Date.now()
    };

    actorState.queue.push(message);

    // 为当前 HTTP 请求准备一个 Promise
    const resultPromise = new Promise((resolve, reject) => {
      this.pendingResults.set(messageId, { resolve, reject });
    });

    // 启动异步调度
    this.triggerDraining();

    // 超时保护
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        this.pendingResults.delete(messageId);
        reject(new Error("Processing timeout"));
      }, actorState.policy.timeoutMs);
    });

    try {
      const result = await Promise.race([resultPromise, timeoutPromise]);
      clearTimeout(timeoutId);
      return new Response(
        JSON.stringify({ ok: true, result }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    } catch (err) {
      return new Response(
        JSON.stringify({ ok: false, error: err.message }),
        { status: 504, headers: { "Content-Type": "application/json" } }
      );
    }
  }

  /**
   * 查看当前 Router 管理的 actor 状态
   * 支持 query: /status?actorTypePrefix=room:
   * - 读取 Durable Storage 中的 meta:*（和 /admin-reset 一致）
   * - 合并内存中的 this.actors（内存优先）
   */
  async handleStatus(request) {
    const url = new URL(request.url);
    const actorTypePrefix = url.searchParams.get("actorTypePrefix") || "";

    const prefix = "meta:" + actorTypePrefix;

    // 1. 从 Durable Storage 读取所有 meta
    const allMeta = await this.state.storage.list({ prefix });

    // 2. 先用 storage 的 meta 建一个 map
    /** @type {Map<string, any>} */
    const statusMap = new Map();

    for (const [key, meta] of allMeta.entries()) {
      const actorKey = key.slice("meta:".length); // 去掉 "meta:"
      statusMap.set(actorKey, {
        actorKey,
        actorType: meta.actorType,
        actorId: meta.actorId,
        busy: meta.busy,
        queueLength: meta.queueLength,
        policy: null,          // storage 里没有 policy，只在内存有
        metaUpdatedAt: meta.updatedAt,
        fromStorage: true,
        fromMemory: false
      });
    }

    // 3. 合并内存中的 actorState（内存优先，覆盖 storage 里的 busy/queue）
    for (const actorState of this.actors.values()) {
      // 只返回符合前缀过滤的
      if (actorTypePrefix && !actorState.actorKey.startsWith(actorTypePrefix)) {
        continue;
      }

      const existing = statusMap.get(actorState.actorKey);
      if (existing) {
        // 已有 storage 信息，覆盖运行时字段
        existing.busy = actorState.busy;
        existing.queueLength = actorState.queue.length;
        existing.policy = actorState.policy;
        existing.fromMemory = true;
      } else {
        // 只在内存存在，还没有 persist 过 meta
        statusMap.set(actorState.actorKey, {
          actorKey: actorState.actorKey,
          actorType: actorState.actorType,
          actorId: actorState.actorId,
          busy: actorState.busy,
          queueLength: actorState.queue.length,
          policy: actorState.policy,
          metaUpdatedAt: null,
          fromStorage: false,
          fromMemory: true
        });
      }
    }

    const snapshot = Array.from(statusMap.values());

    return new Response(JSON.stringify({ actors: snapshot }, null, 2), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  /**
   * 启动队列 draining（确保只有一个 drainLoop 在跑）
   */
  triggerDraining() {
    if (this.isDraining) return;

    this.isDraining = true;
    const p = this.drainLoop()
      .catch(err => {
        console.error("Error in drainLoop:", err);
      })
      .finally(() => {
        this.isDraining = false;
        // 如果还有未处理的消息，再来一次
        if (this.hasPendingWork()) {
          this.triggerDraining();
        }
      });

    this.state.waitUntil(p);
  }

  hasPendingWork() {
    for (const actorState of this.actors.values()) {
      if (!actorState.busy && actorState.queue.length > 0) {
        return true;
      }
    }
    return false;
  }

  /**
   * 简单轮询：对每个 actor 处理队列
   */
  async drainLoop() {
    for (const actorState of this.actors.values()) {
      if (actorState.busy) continue;
      if (actorState.queue.length === 0) continue;
      await this.processActorQueue(actorState);
    }
  }

  /**
   * 核心 SIM 逻辑：串行处理某个 actor 的队列
   */
  async processActorQueue(actorState) {
    if (actorState.busy) return;
    actorState.busy = true;

    try {
      while (actorState.queue.length > 0) {
        const message = actorState.queue[0];

        const actorDoId = this.env.GOLDFISH_ACTOR.idFromName(actorState.actorKey);
        const actorStub = this.env.GOLDFISH_ACTOR.get(actorDoId);

        const resp = await actorStub.fetch("https://actor.internal/invoke", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            payload: message.payload,
            actorType: actorState.actorType,
            actorId: actorState.actorId
          })
        });

        if (!resp.ok) {
          const pending = this.pendingResults.get(message.messageId);
          if (pending) {
            pending.reject(new Error(`Actor DO error: ${resp.status}`));
            this.pendingResults.delete(message.messageId);
          }
          actorState.queue.shift();
          break;
        }

        const body = await resp.json().catch(() => ({}));
        const {
          result,
          nextPolicy = { mode: "immediate" },
          spawn = []
        } = body || {};

        // spawn: 为新 actorId 建立本地状态占位（不主动发消息）
        for (const childId of spawn) {
          const childKey = `${actorState.actorType}:${childId}`;
          if (!this.actors.has(childKey)) {
            this.actors.set(childKey, {
              actorKey: childKey,
              actorType: actorState.actorType,
              actorId: childId,
              busy: false,
              queue: [],
              policy: { ...actorState.policy }
            });
          }
        }

        // 把结果返回给 HTTP 调用方
        const pending = this.pendingResults.get(message.messageId);
        if (pending) {
          pending.resolve({
            result,
            actorKey: actorState.actorKey
          });
          this.pendingResults.delete(message.messageId);
        }

        // 当前消息处理完
        actorState.queue.shift();

        // 根据 nextPolicy 处理后续消息
        if (nextPolicy.mode === "wait") {
          // 暂停：留在队列里，下次 drainLoop 再继续
          break;
        } else if (nextPolicy.mode === "reject") {
          // 简单实现：拒绝并清空后续所有消息
          // TODO: 支持 nextPolicy.redirectTo 把消息转到别的 actor
          while (actorState.queue.length > 0) {
            const m = actorState.queue.shift();
            const pending2 = this.pendingResults.get(m.messageId);
            if (pending2) {
              pending2.reject(new Error("Message rejected by actor"));
              this.pendingResults.delete(m.messageId);
            }
          }
          break;
        } else {
          // "immediate"：继续 while，处理下一条
        }
      }

      await this.persistActorState(actorState);
    } finally {
      actorState.busy = false;
    }
  }

  /**
   * 可选：把 actor 的简要状态存储到 Durable Storage
   */
  async persistActorState(actorState) {
    const meta = {
      busy: actorState.busy,
      queueLength: actorState.queue.length,
      actorType: actorState.actorType,
      actorId: actorState.actorId,
      updatedAt: Date.now()
    };
    await this.state.storage.put(`meta:${actorState.actorKey}`, meta);
  }
}
