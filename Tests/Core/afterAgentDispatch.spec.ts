/**
 * S0 · 负向测试②：`afterAgent` 必须被**真实派发**。
 *
 * 现状缺陷（已核实）：
 *   `runIteration` 只派发 5 个钩子（beforeAgent / beforeModel / wrapModelCall /
 *   wrapToolCall / afterModel），**从不派发 `afterAgent`**。
 *   而 `Src/Services/LoopControl/middleware/checkpointWriter.ts` 与
 *   `stopRuleEvaluator.ts` 都挂在该钩子上 ⇒ 两个中间件是**死代码**。
 *
 * 纪律（Docs/Dev/L1编排设计/25 §1）：负向用例必须**真实调用**（跑一次真循环），
 * 不能只断言"注册表里有这个钩子"。本测试在修复前**必须红**。
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
import {
  registerMiddleware,
  clearMiddlewares,
} from "../../Src/Core/Middleware/middlewareRegistry.js";
import type { AgentMiddleware } from "../../Src/Infra/Contracts/middlewareTypes.js";
import type { ChatMessage } from "../../Src/Core/Model/modelCaller.js";
import type { IterationContext } from "../../Src/Core/Loop/runIteration.js";

const AGENT = "agent-s0-after";

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
    sessionId: "sess-s0-after",
    agentId: AGENT,
    agentRole: "worker",
    config: configResult.value,
    chatMessages,
    recentCallTimestamps: [],
  };
}

function newLoopState() {
  const configResult = createLoopConfig({ model: "test-model", stream: false });
  if (!configResult.ok) throw new Error("config");
  return createLoopState({
    loopId: "loop-s0-after",
    agentId: AGENT,
    traceId: "trace-s0-after",
    config: configResult.value,
  });
}

describe("S0 · afterAgent 必须被真实派发", () => {
  beforeEach(() => {
    clearMiddlewares();
    resetSystemPromptCache();
    h.callModel.mockReset();
  });

  it("【负向】挂在 afterAgent 上的中间件在跑完一轮后必须被调用", async () => {
    let called = 0;
    const probe: AgentMiddleware = {
      name: "s0-after-agent-probe",
      hook: "afterAgent",
      priority: 1,
      canShortCircuit: false,
      execute: async () => {
        called += 1;
      },
    };
    registerMiddleware(probe);

    h.callModel.mockResolvedValue(textReply("done"));

    const result = await executeLoop(
      newLoopState(),
      baseCtx([{ role: "user", content: "hi" }]),
    );

    // 循环本身应正常结束（前置条件）
    expect(result.ok).toBe(true);
    // 修复前：called === 0（钩子从不派发）⇒ 本断言失败
    expect(called).toBeGreaterThan(0);
  });
});
