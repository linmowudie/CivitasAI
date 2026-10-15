/**
 * P0-2 验收：渲染进程侧的控制面凭据装配（REV-133 的前端一半）
 *
 * 后端把 `/api/*` 全部门住之后，51 个调用点都只经过 `api()` 这一处装配 headers，
 * 所以这里锁的是**那唯一一处**：
 *  - 桌面态：令牌由主进程 IPC 下发（打包态是 `file://`，用不了 HTTP 领取通道）；
 *  - 浏览器/开发态：向同源领取通道 `POST /internal/api-token` 换取；
 *  - 401（后端重启换了进程内令牌）→ 丢缓存重取，只重试一次；
 *  - 非 `/api` 路径不附凭据；领取失败不缓存，下一次请求会再试。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type FetchCall = {
  url: string;
  method: string;
  headers: Record<string, string>;
};

function jsonResponse(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
    json: async () => payload,
    headers: { get: () => null },
  };
}

/**
 * 每个用例都要重新加载模块：api.ts 的令牌/基址是模块级缓存。
 */
async function loadApi() {
  vi.resetModules();
  return import("@/services/api");
}

/**
 * installFetch：handler 返回值可带 `__status` 指定 HTTP 状态码
 * （凭据门是在 **HTTP 层**回 401，`api()` 的重试也只看状态码，不看响应体的 ok 字段）。
 */
function installFetch(handler: (call: FetchCall) => unknown): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (
        input: unknown,
        init?: { method?: string; headers?: Record<string, string> },
      ) => {
        const call: FetchCall = {
          url: String(input),
          method: init?.method ?? "GET",
          headers: { ...(init?.headers ?? {}) },
        };
        calls.push(call);
        const result = handler(call) as { __status?: number };
        return jsonResponse(result, result.__status ?? 200);
      },
    ),
  );
  return calls;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("浏览器/开发态：经同源领取通道取凭据", () => {
  it("先领取再附带 X-Civitas-Api-Token，领取只发生一次", async () => {
    const calls = installFetch((call) => {
      if (call.url === "/internal/api-token")
        return { ok: true, data: { token: "boot-token" } };
      return { ok: true, data: { seen: call.headers } };
    });

    const { apiGet } = await loadApi();
    const first = await apiGet<{ seen: Record<string, string> }>(
      "/api/sessions",
    );
    const second = await apiGet<{ seen: Record<string, string> }>(
      "/api/agents",
    );

    expect(first.ok).toBe(true);
    expect(first.data.seen["X-Civitas-Api-Token"]).toBe("boot-token");
    expect(second.data.seen["X-Civitas-Api-Token"]).toBe("boot-token");

    const bootstraps = calls.filter((c) => c.url === "/internal/api-token");
    expect(bootstraps).toHaveLength(1);
    expect(bootstraps[0]?.method).toBe("POST");
  });

  it("领取通道不可用（后端未就绪）时不缓存失败，下一次请求会重试", async () => {
    let bootstrapReady = false;
    const calls = installFetch((call) => {
      if (call.url === "/internal/api-token") {
        if (!bootstrapReady) {
          bootstrapReady = true;
          return { ok: false, error: "鉴权门尚未初始化" };
        }
        return { ok: true, data: { token: "late-token" } };
      }
      return { ok: true, data: { seen: call.headers } };
    });

    const { apiGet } = await loadApi();
    const denied = await apiGet<{ seen: Record<string, string> }>(
      "/api/sessions",
    );
    const granted = await apiGet<{ seen: Record<string, string> }>(
      "/api/sessions",
    );

    expect(denied.data.seen["X-Civitas-Api-Token"]).toBeUndefined();
    expect(granted.data.seen["X-Civitas-Api-Token"]).toBe("late-token");
    expect(calls.filter((c) => c.url === "/internal/api-token")).toHaveLength(
      2,
    );
  });

  it("非 /api 路径不领取、不附凭据", async () => {
    const calls = installFetch((call) => ({
      ok: true,
      data: { seen: call.headers },
    }));
    const { api } = await loadApi();
    await api<{ seen: Record<string, string> }>("/healthz");
    expect(calls.filter((c) => c.url === "/internal/api-token")).toHaveLength(
      0,
    );
    expect(calls[0]?.url).toBe("/healthz");
    expect(calls[0]?.headers["X-Civitas-Api-Token"]).toBeUndefined();
  });

  it("401 → 丢缓存重新领取并重试一次（后端重启换令牌）", async () => {
    let issued = 0;
    let accepted: string | null = null;
    const sent: Array<string | undefined> = [];
    installFetch((call) => {
      if (call.url === "/internal/api-token") {
        issued += 1;
        accepted = `token-${issued}`;
        return { ok: true, data: { token: accepted } };
      }
      const credential = call.headers["X-Civitas-Api-Token"];
      sent.push(credential);
      return credential === accepted
        ? { ok: true, data: { pong: true } }
        : { ok: false, error: "未授权", __status: 401 };
    });

    const { apiGet } = await loadApi();
    const first = await apiGet<{ pong?: boolean }>("/api/sessions");
    expect(first.ok).toBe(true);

    // 后端重启：旧令牌失效，新令牌只有重新领取才能拿到
    accepted = "token-2";
    const second = await apiGet<{ pong?: boolean }>("/api/sessions");
    expect(second.ok).toBe(true);
    expect(second.data.pong).toBe(true);
    expect(sent).toEqual(["token-1", "token-1", "token-2"]);
    expect(issued).toBe(2);
  });

  it("重试只有一次：持续 401 不会无限递归", async () => {
    const calls = installFetch((call) => {
      if (call.url === "/internal/api-token")
        return { ok: true, data: { token: "never-matches" } };
      return { ok: false, error: "未授权", __status: 401 };
    });
    const { apiGet } = await loadApi();
    const res = await apiGet<unknown>("/api/sessions");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.status).toBe(401);
    expect(calls.filter((c) => c.url === "/api/sessions")).toHaveLength(2);
  });
});

describe("桌面态：凭据由主进程 IPC 下发", () => {
  it("走 serverFetch 且带上主进程给的令牌，不发起任何 HTTP 领取", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, data: {} }));
    vi.stubGlobal("fetch", fetchMock);

    const fetched: Array<{ url: string; headers?: Record<string, string> }> =
      [];
    const electronAPI = {
      getServerPorts: async () => ({ httpPort: 3000 }),
      getApiToken: async () => "main-process-token",
      serverFetch: async (req: {
        url: string;
        headers?: Record<string, string>;
      }) => {
        fetched.push(req);
        return {
          ok: true as const,
          status: 200,
          body: JSON.stringify({ ok: true, data: { pong: true } }),
        };
      },
    };
    vi.stubGlobal("window", { electronAPI });

    const { apiGet } = await loadApi();
    const res = await apiGet<{ pong: boolean }>("/api/sessions");

    expect(res.ok).toBe(true);
    expect(fetched).toHaveLength(1);
    expect(fetched[0]?.url).toBe("http://127.0.0.1:3000/api/sessions");
    expect(fetched[0]?.headers?.["X-Civitas-Api-Token"]).toBe(
      "main-process-token",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("主进程尚未就绪（令牌为 null）时请求照发，凭据留空待下一次补齐", async () => {
    const electronAPI = {
      getServerPorts: async () => ({ httpPort: 3000 }),
      getApiToken: async () => null,
      serverFetch: async (_req: {
        url: string;
        headers?: Record<string, string>;
      }) => ({
        ok: true as const,
        status: 401,
        body: JSON.stringify({ ok: false, error: "未授权" }),
      }),
    };
    vi.stubGlobal("window", { electronAPI });

    const { apiGet } = await loadApi();
    const res = await apiGet<unknown>("/api/sessions");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.status).toBe(401);
  });
});
