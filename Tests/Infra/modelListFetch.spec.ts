/**
 * `/models` 拉取的降级语义（2026-10-17）。
 *
 * 背景（实测）：华为云 MaaS Token Plan 的 base_url 是
 * `https://api.modelarts-maas.com/plan/v2`，该端点**不提供** `GET /models`
 * （404 `APIG.0101: The API does not exist or has not been published in the environment`），
 * 而同一个 Key 打 `POST /chat/completions` 完全正常（GLM-5.1 / DeepSeek-V4-Flash / Kimi-K2.6 均 200）。
 *
 * 旧实现把原始 404 文本当成错误返回给界面，用户看到
 * `HTTP 404: {"error_code":"APIG.0101"...}` → 只能得出"华为 Token Plan 有问题"的错误结论；
 * 更糟的是列表为空 ⇒ 勾不到模型 ⇒ "添加供应商"流程整条卡死。
 *
 * 本测试锁住：404/405 = "端点不提供该能力"（可降级继续），
 * 而 401/403/5xx 仍是真的错误（不得被同一个分支吞掉）。
 */

import { describe, it, expect, afterEach, vi } from "vitest";

import { fetchUpstreamModels } from "../../Src/Interface/IpcBridge/ipcBridge.js";

const BASE = "https://api.modelarts-maas.com/plan/v2";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 固定返回一个状态码 + 响应体，并记录请求 URL 与头 */
function stubFetch(status: number, body: unknown = {}) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url: String(url),
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        text: async () => JSON.stringify(body),
      } as unknown as Response;
    }),
  );
  return calls;
}

describe("fetchUpstreamModels · GET /models", () => {
  it("200 → 返回模型清单（带默认规格）并带上 Bearer 头", async () => {
    const calls = stubFetch(200, {
      data: [{ id: "qwen-plus" }, { id: "gpt-4o-mini" }],
    });

    const result = await fetchUpstreamModels({
      base_url: BASE,
      api_key: "sk-1",
    });

    expect(calls[0]!.url).toBe(`${BASE}/models`);
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer sk-1");
    expect(result.ok).toBe(true);
    expect(result.listNotProvided).toBe(false);
    expect(result.data?.map((m) => m.id)).toEqual(["qwen-plus", "gpt-4o-mini"]);
    // context_window 必须 > 0：`providerBase` 对 0 值直接拒注
    expect(result.data?.[0]!.context_window).toBeGreaterThan(0);
  });

  it("404 → 不是错误：ok=true + listNotProvided，且不伪造模型", async () => {
    stubFetch(404, {
      error_code: "APIG.0101",
      error_msg:
        "The API does not exist or has not been published in the environment",
    });

    const result = await fetchUpstreamModels({
      base_url: BASE,
      api_key: "sk-1",
    });

    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.listNotProvided).toBe(true);
    expect(result.listStatus).toBe(404);
    expect(result.data).toEqual([]);
    expect(result.modelsFromFallback).toBe(false);
  });

  it("404 + fallbackModels → 把内置候选作为可勾选列表返回，并标注来源", async () => {
    stubFetch(404, { error_code: "APIG.0101" });

    const result = await fetchUpstreamModels({
      base_url: BASE,
      api_key: "sk-1",
      fallbackModels: ["GLM-5.1", "  DeepSeek-V4-Flash  ", "", "Kimi-K2.6"],
    });

    expect(result.ok).toBe(true);
    expect(result.listNotProvided).toBe(true);
    expect(result.modelsFromFallback).toBe(true);
    expect(result.data?.map((m) => m.id)).toEqual([
      "GLM-5.1",
      "DeepSeek-V4-Flash",
      "Kimi-K2.6",
    ]);
    expect(result.data?.[0]!.context_window).toBeGreaterThan(0);
  });

  it('405 与 404 同样按"端点不提供"处理（HEAD/方法不支持的网关）', async () => {
    stubFetch(405, {});
    const result = await fetchUpstreamModels({
      base_url: BASE,
      api_key: "sk-1",
    });
    expect(result.ok).toBe(true);
    expect(result.listNotProvided).toBe(true);
    expect(result.listStatus).toBe(405);
  });

  it('403 → 仍是真的错误，绝不能被当成"端点不提供"（否则 Key 无效会被掩盖）', async () => {
    stubFetch(403, {
      error: {
        code: "ModelArts.81004",
        message: "Invalid request because you do not have access to it.",
      },
    });

    const result = await fetchUpstreamModels({
      base_url: BASE,
      api_key: "sk-bad",
    });

    expect(result.ok).toBe(false);
    expect(result.listNotProvided).toBeUndefined();
    expect(result.error).toContain("HTTP 403");
    expect(result.error).toContain("ModelArts.81004");
  });

  it("5xx → 仍是真的错误（可重试），不降级", async () => {
    stubFetch(500, { message: "boom" });
    const result = await fetchUpstreamModels({
      base_url: BASE,
      api_key: "sk-1",
    });
    expect(result.ok).toBe(false);
    expect(result.listNotProvided).toBeUndefined();
    expect(result.error).toContain("HTTP 500");
  });

  it("网络异常 → ok=false 且带原因（不抛异常给 IPC 调用方）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("fetch failed: ENOTFOUND");
      }),
    );

    const result = await fetchUpstreamModels({
      base_url: "https://nope.invalid/v1",
      api_key: "sk-1",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("ENOTFOUND");
  });
});
