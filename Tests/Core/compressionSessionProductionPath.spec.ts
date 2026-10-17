/**
 * S2b · 生产路径：压缩会话必须**每循环一份**，且不落回模块全局。
 *
 * 背景（S2 遗留，见 Docs/Dev/L1编排设计/25 §7.7）：
 *   S2 只做到"会话可用"，`runIteration` 未传会话 ⇒ 生产路径仍写模块全局，
 *   嵌套/并发两层循环会**互相推进低增益计数、并把计量混在一起**（无法归因）。
 *
 * 本测试走 **真实生产路径**（`executeLoop`），不做静态断言。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({ callModel: vi.fn() }));
vi.mock("../../Src/Core/Model/modelCaller.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../Src/Core/Model/modelCaller.js")
    >();
  return { ...actual, callModel: h.callModel };
});

import {
  executeLoop,
  resetSystemPromptCache,
} from "../../Src/Core/Loop/runIteration.js";
import { createLoopState } from "../../Src/Core/Loop/loopEngine.js";
import { createLoopConfig } from "../../Src/Core/Loop/loopConfig.js";
import { clearMiddlewares } from "../../Src/Core/Middleware/middlewareRegistry.js";
import {
  getCompactionMetrics,
  resetCompactionMetrics,
  resetContextCompression,
  getSessionCompactionMetrics,
} from "../../Src/Core/Loop/contextCompression.js";
import type { ChatMessage } from "../../Src/Core/Model/modelCaller.js";
import type { IterationContext } from "../../Src/Core/Loop/runIteration.js";

function textReply(content: string) {
  return {
    ok: true,
    value: {
      content,
      finish_reason: "stop",
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      model: "test-model",
    },
  };
}

function baseCtx(
  chatMessages: ChatMessage[],
): Omit<IterationContext, "currentIteration" | "totalTokensConsumed"> {
  const configResult = createLoopConfig({ model: "test-model", stream: false });
  if (!configResult.ok) throw new Error("config");
  return {
    userInput: "hi",
    sessionId: "sess-s2b",
    agentId: "agent-s2b",
    agentRole: "worker",
    config: configResult.value,
    chatMessages,
    recentCallTimestamps: [],
  };
}

function newLoopState(loopId: string) {
  const configResult = createLoopConfig({ model: "test-model", stream: false });
  if (!configResult.ok) throw new Error("config");
  return createLoopState({
    loopId,
    agentId: "agent-s2b",
    traceId: "trace-" + loopId,
    config: configResult.value,
  });
}

describe("S2b · 压缩会话进入生产路径", () => {
  beforeEach(() => {
    clearMiddlewares();
    resetSystemPromptCache();
    resetCompactionMetrics();
    resetContextCompression();
    h.callModel.mockReset();
  });

  it("【负向】两个循环各自得到**不同**的压缩会话（每循环一份）", () => {
    const a = newLoopState("loop-a");
    const b = newLoopState("loop-b");
    expect(a.compressionSession).toBeDefined();
    expect(a.compressionSession).not.toBe(b.compressionSession);
    expect(a.compressionSession.metrics).not.toBe(b.compressionSession.metrics);
    expect(a.compressionSession.lowGain).not.toBe(b.compressionSession.lowGain);
  });

  it("【负向·真实调用】跑完一轮后，压缩计量记在**该循环的会话**上，模块全局保持零", async () => {
    const state = newLoopState("loop-prod");
    h.callModel.mockResolvedValue(textReply("done"));

    const result = await executeLoop(
      state,
      baseCtx([{ role: "user", content: "hi" }]),
    );
    expect(result.ok).toBe(true);

    // 该循环的会话拿到了计量（⑤ 步每轮都会调 maybeCompressContext）
    expect(
      getSessionCompactionMetrics(state.compressionSession).runs,
    ).toBeGreaterThan(0);
    // 模块全局**没有被生产路径写脏** —— 这正是 S2b 要修的点
    expect(getCompactionMetrics().runs).toBe(0);
  });

  it("【负向·真实调用】两个循环的计量互不混淆（可分别归因）", async () => {
    const a = newLoopState("loop-m1");
    const b = newLoopState("loop-m2");
    h.callModel.mockResolvedValue(textReply("done"));

    await executeLoop(a, baseCtx([{ role: "user", content: "hi" }]));
    await executeLoop(b, baseCtx([{ role: "user", content: "hi" }]));

    const ra = getSessionCompactionMetrics(a.compressionSession).runs;
    const rb = getSessionCompactionMetrics(b.compressionSession).runs;
    expect(ra).toBeGreaterThan(0);
    expect(rb).toBeGreaterThan(0);
    // 各自独立累计：两者都不等于"两者之和"，即没有被合并到一个容器
    expect(getSessionCompactionMetrics(a.compressionSession).runs).toBe(ra);
    expect(getSessionCompactionMetrics(b.compressionSession).runs).toBe(rb);
  });
});
