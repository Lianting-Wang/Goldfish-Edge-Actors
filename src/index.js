// src/index.js
import { GoldfishRouter } from "./router.js";
import { GoldfishActor } from "./actor.js";

/**
 * Worker 入口：
 * - 对外暴露 HTTP API
 * - 把请求转发到 GoldfishRouter Durable Object
 */
const worker = {
  /**
   * 对外：POST /invoke
   * body: { actorType: string, actorId: string, payload: any }
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

		// 1) API: 统一向某个 Actor 发送消息
    if (url.pathname === "/invoke" && request.method === "POST") {
      const body = await request.json().catch(() => null);
      if (!body) {
        return new Response("Invalid JSON body", { status: 400 });
      }

      const { actorType, actorId, payload } = body;

      if (!actorType || !actorId) {
        return new Response("actorType and actorId are required", { status: 400 });
      }

      // 约定：相同 actorType → 同一个 Router DO 实例
      const routerId = env.GOLDFISH_ROUTER.idFromName(actorType);
      const routerStub = env.GOLDFISH_ROUTER.get(routerId);

      // 把请求转发给 Router DO 统一调度
      return routerStub.fetch("https://router.internal/route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actorType, actorId, payload })
      });
    }

		// 2) API: 查询某个 Actor 的状态（调用 DO 的 /status）
		if (url.pathname === "/actor-status") {
			const actorType = url.searchParams.get("actorType");
			const actorId = url.searchParams.get("actorId");
			const actorKey = `${actorType}:${actorId}`;

			const actorDoId = env.GOLDFISH_ACTOR.idFromName(actorKey);
			const actorStub = env.GOLDFISH_ACTOR.get(actorDoId);
			return actorStub.fetch("https://actor.internal/status");
		}

		// 3) API: 查询某个 actorType 的 Router 状态（队列、busy 等）
    if (url.pathname === "/router-status" && request.method === "GET") {
      const actorType = url.searchParams.get("actorType");
      if (!actorType) {
        return new Response("actorType is required", { status: 400 });
      }

      const routerId = env.GOLDFISH_ROUTER.idFromName(actorType);
      const routerStub = env.GOLDFISH_ROUTER.get(routerId);
      return routerStub.fetch("https://router.internal/status");
    }

		// 4) API: 初始化某个 Actor 的状态
		if (url.pathname === "/reset-actor" && request.method === "POST") {
			const body = await request.json().catch(() => null);
			if (!body) {
				return new Response("Invalid JSON", { status: 400 });
			}

			const { actorType, actorId } = body;
			if (!actorType || !actorId) {
				return new Response("actorType and actorId are required", { status: 400 });
			}

			const actorKey = `${actorType}:${actorId}`;
			const actorDoId = env.GOLDFISH_ACTOR.idFromName(actorKey);
			const actorStub = env.GOLDFISH_ACTOR.get(actorDoId);

			const resp = await actorStub.fetch("https://actor.internal/admin-reset", {
				method: "POST"
			});

			return resp;
		}

		// 5) API: 初始化某类 Actor Type 的状态
		if (url.pathname === "/reset-router" && request.method === "POST") {
			const body = await request.json().catch(() => null);
			if (!body) return new Response("Invalid JSON", { status: 400 });

			const { actorType } = body;  // 例如 "room"

			const routerId = env.GOLDFISH_ROUTER.idFromName(actorType);
			const routerStub = env.GOLDFISH_ROUTER.get(routerId);

			return routerStub.fetch("https://router.internal/admin-reset", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ actorTypePrefix: `${actorType}:` })
			});
		}

		// 6) 静态资源
		if (url.pathname === "/student" || url.pathname === "/") {
      // 把路径改成 /question_board.html 交给 ASSETS
      const assetUrl = new URL(request.url);
      assetUrl.pathname = "/student_answer.html";
      const assetRequest = new Request(assetUrl.toString(), request);
      return env.ASSETS.fetch(assetRequest);
    }

    if (url.pathname === "/board") {
      // 把路径改成 /question_board.html 交给 ASSETS
      const assetUrl = new URL(request.url);
      assetUrl.pathname = "/question_board.html";
      const assetRequest = new Request(assetUrl.toString(), request);
      return env.ASSETS.fetch(assetRequest);
    }

		return new Response("Not Found", { status: 404 });
    // 7) 其他任何路径（例如 /question_board.html /xxx.js /xxx.css）
    //    直接交给 ASSETS 处理，如果里面没有这个文件，就返回 404
    // return env.ASSETS.fetch(request);
  }
};

// 必须导出 default.fetch 作为 Worker 入口
export default worker;

// 必须导出 DO 类，让 wrangler 按 class_name 绑定
export { GoldfishRouter, GoldfishActor };
