/**
 * P0-2 验收：监听地址策略 + 控制面凭据门（REV-001/133/280）
 *
 * 覆盖两件事：
 *  1. `resolveBindHost`：非回环绑定必须显式授权，否则回退 127.0.0.1 且留告警；
 *  2. `apiToken`：真实 HTTP 链路上 `/api/*` 无凭据一律 401，
 *     凭据可用 `X-Civitas-Api-Token` 或 `Authorization: Bearer`，
 *     领取通道只在"回环 + 同源 + 未开放远程"三重门下放行。
 */
import { afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";

import {
  resolveBindHost,
  DEFAULT_BIND_HOST,
  isLoopbackHost,
} from "../../Src/Interface/WebServer/bindPolicy.js";
import {
  API_TOKEN_BOOTSTRAP_PATH,
  initApiToken,
  isApiAuthorized,
  resetApiToken,
} from "../../Src/Interface/WebServer/apiToken.js";
import {
  startHttpServer,
  stopHttpServer,
} from "../../Src/Interface/WebServer/httpServer.js";
import {
  registerRoute,
  json,
  clearRoutes,
} from "../../Src/Interface/RestApi/router.js";

const TEST_PORT = 14042;
const PING_PATH = "/api/_test/ping";
const BASE = `http://127.0.0.1:${TEST_PORT}`;

describe("监听地址策略（bindPolicy）", () => {
  it("未配置时取回环默认值，不算对外开放", () => {
    const decision = resolveBindHost({});
    expect(decision.host).toBe(DEFAULT_BIND_HOST);
    expect(decision.remoteEnabled).toBe(false);
    expect(decision.warnings).toEqual([]);
  });

  it.each(["127.0.0.1", "localhost", "::1", "[::1]"])(
    "%s 视为回环，无告警",
    (host) => {
      expect(isLoopbackHost(host)).toBe(true);
      const decision = resolveBindHost({ configuredHost: host });
      expect(decision).toEqual({ host, remoteEnabled: false, warnings: [] });
    },
  );

  it("非回环 + 未授权 → 回退 127.0.0.1 并说明原因（不静默丢弃用户意图）", () => {
    const decision = resolveBindHost({ configuredHost: "0.0.0.0" });
    expect(decision.host).toBe(DEFAULT_BIND_HOST);
    expect(decision.remoteEnabled).toBe(false);
    expect(decision.warnings.join("")).toContain("0.0.0.0");
    expect(decision.warnings.join("")).toContain("allowRemoteAccess");
  });

  it('非回环 + 显式授权 → 保留该地址，但告警"鉴权门必须在生效"', () => {
    const decision = resolveBindHost({
      configuredHost: "0.0.0.0",
      allowRemoteAccess: true,
    });
    expect(decision.host).toBe("0.0.0.0");
    expect(decision.remoteEnabled).toBe(true);
    expect(decision.warnings.join("")).toContain("鉴权门");
  });

  it("空串/空白/非字符串一律回落默认值", () => {
    for (const bad of ["", "   ", undefined, 3000, null]) {
      expect(resolveBindHost({ configuredHost: bad }).host).toBe(
        DEFAULT_BIND_HOST,
      );
    }
  });
});

describe("控制面凭据判定（纯函数侧）", () => {
  afterEach(() => resetApiToken());

  it('未初始化 = 全关（fail-closed，不存在"忘了装配 = 无鉴权"）', () => {
    resetApiToken();
    expect(isApiAuthorized({ "x-civitas-api-token": "anything" })).toBe(false);
    expect(isApiAuthorized({})).toBe(false);
  });

  it("配置令牌优先于进程内生成；两种头都接受；错误令牌与空值拒绝", () => {
    const state = initApiToken({
      configuredToken: "configured-token-value",
      remoteEnabled: false,
    });
    expect(state.fromConfig).toBe(true);
    expect(
      isApiAuthorized({ "x-civitas-api-token": "configured-token-value" }),
    ).toBe(true);
    expect(
      isApiAuthorized({ authorization: "Bearer configured-token-value" }),
    ).toBe(true);
    expect(
      isApiAuthorized({ authorization: "bearer configured-token-value" }),
    ).toBe(true);
    expect(
      isApiAuthorized({ "x-civitas-api-token": "wrong-token-value!!" }),
    ).toBe(false);
    expect(isApiAuthorized({ "x-civitas-api-token": "   " })).toBe(false);
    expect(
      isApiAuthorized({ authorization: "Basic configured-token-value" }),
    ).toBe(false);
  });

  it("未配置时生成高强度随机令牌，且开启远程访问就关闭领取通道", () => {
    const local = initApiToken({ remoteEnabled: false });
    expect(local.token.length).toBeGreaterThanOrEqual(32);
    expect(local.fromConfig).toBe(false);
    const remote = initApiToken({ remoteEnabled: true });
    expect(remote.bootstrapEnabled).toBe(false);
  });
});

describe("真实 HTTP 链路上的凭据门", () => {
  beforeAll(async () => {
    clearRoutes();
    registerRoute("GET", PING_PATH, async () => json({ pong: true }));
    await startHttpServer({
      host: "127.0.0.1",
      port: TEST_PORT,
      corsOrigins: ["http://localhost:5173"],
    });
  });

  afterAll(async () => {
    await stopHttpServer();
    clearRoutes();
    resetApiToken();
  });

  it("门未装配时 /api 直接 401（而不是放行）", async () => {
    resetApiToken();
    const res = await fetch(`${BASE}${PING_PATH}`);
    expect(res.status).toBe(401);
  });

  it("无凭据 401、错凭据 401、有效凭据 200", async () => {
    const state = initApiToken({
      configuredToken: "real-chain-token-value",
      remoteEnabled: false,
    });
    expect(state.token).toBe("real-chain-token-value");

    expect((await fetch(`${BASE}${PING_PATH}`)).status).toBe(401);
    expect(
      (
        await fetch(`${BASE}${PING_PATH}`, {
          headers: { "X-Civitas-Api-Token": "nope-nope-nope" },
        })
      ).status,
    ).toBe(401);

    const ok = await fetch(`${BASE}${PING_PATH}`, {
      headers: { "X-Civitas-Api-Token": state.token },
    });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { data: { pong?: boolean } }).data.pong).toBe(
      true,
    );

    const bearer = await fetch(`${BASE}${PING_PATH}`, {
      headers: { Authorization: `Bearer ${state.token}` },
    });
    expect(bearer.status).toBe(200);
  });

  it("非 /api 路径不受门管辖（静态/SPA 分支）", async () => {
    initApiToken({
      configuredToken: "real-chain-token-value",
      remoteEnabled: false,
    });
    const res = await fetch(`${BASE}/_test/not-an-api-path`);
    expect(res.status).not.toBe(401);
  });

  it("领取通道：回环同源 POST 可拿到令牌，GET 与跨站 Origin 被拒", async () => {
    const state = initApiToken({ remoteEnabled: false });

    const granted = await fetch(`${BASE}${API_TOKEN_BOOTSTRAP_PATH}`, {
      method: "POST",
    });
    expect(granted.status).toBe(200);
    const body = (await granted.json()) as {
      ok: boolean;
      data: { token: string };
    };
    expect(body.ok).toBe(true);
    expect(body.data.token).toBe(state.token);
    expect(granted.headers.get("cache-control")).toBe("no-store");

    expect((await fetch(`${BASE}${API_TOKEN_BOOTSTRAP_PATH}`)).status).toBe(
      403,
    );

    const crossSite = await fetch(`${BASE}${API_TOKEN_BOOTSTRAP_PATH}`, {
      method: "POST",
      headers: { Origin: "https://evil.example.com" },
    });
    expect(crossSite.status).toBe(403);
    expect(((await crossSite.json()) as { ok: boolean }).ok).toBe(false);
  });

  it("开启远程访问后领取通道关闭（必须改用 server.apiToken）", async () => {
    initApiToken({ remoteEnabled: true });
    const res = await fetch(`${BASE}${API_TOKEN_BOOTSTRAP_PATH}`, {
      method: "POST",
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error?: string }).error ?? "").toContain(
      "远程",
    );
  });
});
