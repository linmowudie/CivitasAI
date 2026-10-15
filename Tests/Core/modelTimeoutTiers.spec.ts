/**
 * REV-326 回归测试：非流式模型调用的**分档墙钟**
 *
 * 登记的缺陷：`routing.timeoutMs`（出厂 60s）是全仓唯一挂着的墙钟，而它只作用于非流式路径，
 * 于是"L3 Judge 写整段评审意见""上下文压缩写整篇摘要"这类必然长跑的一次性调用，
 * 与 Loop 里一次普通回合共用 60s——实测一次 `max_tokens:400` 的长回答确实跑过 60s，
 * 后果在 Judge 侧是"判不了"、在压缩侧是"静默降级"。
 *
 * 本文件锁住分档本身（不依赖网络，假 Provider 只 sleep）：
 *  - `purpose:'default'` 读 `timeoutMs`，`purpose:'internal'` 读 `internalTimeoutMs`；
 *  - 两档**互不串档**（正反两个方向都测，写反了必红）；
 *  - `internalTimeoutMs` 缺省未配时用 `INTERNAL_TIMEOUT_MS`，而不是退回交互档。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  callModel,
  INTERNAL_TIMEOUT_MS,
} from "../../Src/Core/Model/modelCaller.js";
import {
  registerProvider,
  setRoutingConfig,
  resetRouter,
} from "../../Src/Infra/Llm/Router/modelRouter.js";
import type { RoutingConfig } from "../../Src/Infra/Llm/Router/modelRouter.js";
import type { LlmProvider } from "../../Src/Infra/Llm/Provider/providerBase.js";
import { ok, err } from "../../Src/Infra/types.js";

/** 等到 ms 后返回 'done'；期间 signal 触发 abort 则立刻返回 'aborted' */
function waitOrAbort(
  ms: number,
  signal?: AbortSignal,
): Promise<"done" | "aborted"> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve("aborted");
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve("aborted");
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve("done");
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * 假 Provider：`answerMs` 后才回内容。
 *
 * 被墙钟掐断时回的是 `请求已取消`——刻意不含"超时/Aborted"字样，
 * 这样错误分类落到不可重试的 `unknown`，测试观察到的就是**这一档墙钟本身**，
 * 而不是重试序列叠加后的耗时。
 */
function makeFakeProvider(answerMs: number): LlmProvider {
  const model = {
    id: "slow",
    context_window: 8000,
    max_output: 4096,
    supports_vision: false,
    supports_tools: true,
    cost_per_1k_input: 0,
    cost_per_1k_output: 0,
  };
  return {
    name: "fake-tier",
    getModels: () => [model],
    supportsModel: () => true,
    chat: async (opts: { signal?: AbortSignal }) => {
      const outcome = await waitOrAbort(answerMs, opts.signal);
      if (outcome === "aborted") return err("请求已取消", "ERROR");
      return ok({
        content: "long-form answer",
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        model: "slow",
      });
    },
    chatStream: async () => err("不使用流式", "ERROR"),
  } as unknown as LlmProvider;
}

function routing(overrides: Partial<RoutingConfig>): RoutingConfig {
  return {
    defaultModel: "fake-tier/slow",
    directorModel: "fake-tier/slow",
    workerModel: "fake-tier/slow",
    verifierModel: "fake-tier/slow",
    arbitrationModels: [],
    fallbackOrder: ["fake-tier"],
    timeoutMs: 60_000,
    firstByteTimeoutMs: 10_000,
    interChunkTimeoutMs: 15_000,
    ...overrides,
  };
}

const MESSAGES = [{ role: "user" as const, content: "hi" }];

async function callOnce(
  overrides: Partial<RoutingConfig>,
  purpose?: "default" | "internal",
): Promise<{ ok: boolean; elapsedMs: number }> {
  setRoutingConfig(routing(overrides));
  const started = Date.now();
  const res = await callModel(
    "fake-tier/slow",
    MESSAGES,
    purpose ? { purpose } : undefined,
  );
  return { ok: res.ok, elapsedMs: Date.now() - started };
}

describe("REV-326 · 模型调用分档墙钟", () => {
  // 一次回答固定 120ms：远小于 5000ms、远大于 60ms，两档的差别就在这
  const ANSWER_MS = 120;

  beforeEach(() => {
    resetRouter();
    registerProvider(makeFakeProvider(ANSWER_MS));
  });

  afterEach(() => {
    resetRouter();
  });

  it("交互档：purpose 缺省时读 timeoutMs，60ms 墙钟掐断 120ms 的回答", async () => {
    const r = await callOnce({ timeoutMs: 60 });
    expect(r.ok).toBe(false);
    expect(r.elapsedMs).toBeLessThan(ANSWER_MS);
  });

  it("内部档：同一份配置下 internal 读 internalTimeoutMs，不被交互档掐断", async () => {
    const r = await callOnce(
      { timeoutMs: 60, internalTimeoutMs: 5_000 },
      "internal",
    );
    expect(r.ok).toBe(true);
    expect(r.elapsedMs).toBeGreaterThanOrEqual(ANSWER_MS);
  });

  it("反向不串档：交互档放宽而内部档收紧时，internal 必须是被掐断的那个", async () => {
    const internal = await callOnce(
      { timeoutMs: 5_000, internalTimeoutMs: 60 },
      "internal",
    );
    const interactive = await callOnce({
      timeoutMs: 5_000,
      internalTimeoutMs: 60,
    });
    expect(internal.ok).toBe(false);
    expect(interactive.ok).toBe(true);
  });

  it("internalTimeoutMs 未配置时用缺省 180s 档，绝不退回交互档", async () => {
    const r = await callOnce(
      { timeoutMs: 60, internalTimeoutMs: undefined },
      "internal",
    );
    expect(r.ok).toBe(true);
    expect(INTERNAL_TIMEOUT_MS).toBe(180_000);
  });
});
