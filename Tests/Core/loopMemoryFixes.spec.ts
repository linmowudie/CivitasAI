/**
 * 《Docs/Agent/17-控制论审查》第 2 批（回路记忆）回归锁 —— E4 / E8 / E9
 *
 * - E4（P1-5）：指纹历史跨轮持久 + 振荡检测可命中 + 真进展度量
 * - E8（P1-7）：压缩后置位重锚、只注入一次、闩锁无条件清零
 * - E9（P1-6 / P2-12）：限流按回路分桶（跨会话不串扰）+ 真实调用时刻入窗
 * - P2-11：引擎侧 LoopState 满足跨层控制面契约
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({ callModel: vi.fn(), callModelStream: vi.fn() }));
vi.mock("../../Src/Core/Model/modelCaller.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../Src/Core/Model/modelCaller.js")
    >();
  return {
    ...actual,
    callModel: h.callModel,
    callModelStream: h.callModelStream,
  };
});

import {
  runIteration,
  createLoopControlView,
  resetSystemPromptCache,
} from "../../Src/Core/Loop/runIteration.js";
import {
  createLoopState,
  detectRepetitiveFingerprint,
} from "../../Src/Core/Loop/loopEngine.js";
import { createLoopConfig } from "../../Src/Core/Loop/loopConfig.js";
import { computeOutputFingerprint } from "../../Src/Core/Middleware/builtin/fingerprintDetector.js";
import { fingerprintDetectorMiddleware } from "../../Src/Core/Middleware/builtin/fingerprintDetector.js";
import { createGoalReanchorControlMiddleware } from "../../Src/Services/LoopControl/middleware/goalReanchorControl.js";
import {
  rateLimiterMiddleware,
  initRateLimiter,
  getRateLimiterStatus,
  resetRateLimiter,
  rateLimitBucketKey,
} from "../../Src/Core/Middleware/builtin/rateLimiter.js";
import {
  clearMiddlewares,
  registerMiddleware,
} from "../../Src/Core/Middleware/middlewareRegistry.js";
import {
  configureContextCompression,
  resetContextCompression,
} from "../../Src/Core/Loop/contextCompression.js";
import { resetEventBus } from "../../Src/Services/EventBus/eventBus.js";
import {
  getControlTriggerCounts,
  resetControlTriggerCounts,
} from "../../Src/Infra/Logging/controlTriggers.js";
import { clearActiveStopRuleSet } from "../../Src/Services/LoopControl/stopRules.js";
import type { MiddlewareContext } from "../../Src/Infra/Contracts/middlewareTypes.js";

const REPLY = "同样的答复，一字不差。";

beforeEach(() => {
  resetControlTriggerCounts();
  resetEventBus();
  resetSystemPromptCache();
  clearMiddlewares();
  clearActiveStopRuleSet();
  resetContextCompression();
  resetRateLimiter();
  h.callModel.mockReset();
  h.callModelStream.mockReset();
});

// ═══════════════════════════════════════════════════════════════════
// E4 · P1-5
// ═══════════════════════════════════════════════════════════════════

describe("E4 · P1-5 回路装记忆：指纹与进展", () => {
  it("detectRepetitiveFingerprint：连续 N 轮同指纹才命中", () => {
    expect(detectRepetitiveFingerprint(["a", "a", "a"], 3)).toBe(true);
    expect(detectRepetitiveFingerprint(["a", "a", "b"], 3)).toBe(false);
    expect(detectRepetitiveFingerprint(["a", "a"], 3)).toBe(false);
    expect(detectRepetitiveFingerprint([], 3)).toBe(false);
    expect(detectRepetitiveFingerprint(["a", "a", "a"], 0)).toBe(false);
  });

  it("指纹历史**按引用**注入 → 中间件的 push 跨轮持久（修复前长度恒 ≤1）", async () => {
    // 模拟 runIteration 的注入方式：把 LoopState 上的数组按引用放进 data
    const history: string[] = [];
    const ctx = (): MiddlewareContext => ({
      agentId: "a",
      agentRole: "worker",
      sessionId: "s",
      iteration: 1,
      traceId: "t",
      loopId: "loop-fp",
      data: { fingerprintHistory: history },
    });

    (await fingerprintDetectorMiddleware.execute(ctx(), {
      content: "第一轮",
    })) as never;
    (await fingerprintDetectorMiddleware.execute(ctx(), {
      content: "第一轮",
    })) as never;
    (await fingerprintDetectorMiddleware.execute(ctx(), {
      content: "第一轮",
    })) as never;

    expect(history).toHaveLength(3);
    expect(new Set(history).size).toBe(1);
    expect(detectRepetitiveFingerprint(history, 3)).toBe(true);
  });

  it("runIteration 每轮把指纹写入 LoopState（跨轮不丢）", async () => {
    registerMiddleware(fingerprintDetectorMiddleware);
    h.callModel.mockResolvedValue({
      ok: true,
      value: {
        content: REPLY,
        finish_reason: "stop",
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        model: "test-model",
      },
    });

    const cfg = createLoopConfig({ model: "test-model", stream: false });
    if (!cfg.ok) throw new Error("cfg");
    const loopState = createLoopState({
      loopId: "loop-fp2",
      agentId: "a",
      traceId: "t",
      config: cfg.value,
    });
    const base = {
      userInput: "重复做同一件事",
      sessionId: "s",
      agentId: "a",
      agentRole: "worker",
      chatMessages: [{ role: "user" as const, content: "重复做同一件事" }],
      recentCallTimestamps: [],
    };

    await runIteration(
      loopState,
      {
        ...base,
        config: cfg.value,
        currentIteration: 1,
        totalTokensConsumed: 0,
      },
      createLoopControlView(),
    );
    await runIteration(
      loopState,
      {
        ...base,
        config: cfg.value,
        currentIteration: 2,
        totalTokensConsumed: 0,
      },
      createLoopControlView(),
    );

    expect(loopState.fingerprintHistory).toEqual([
      computeOutputFingerprint(REPLY),
      computeOutputFingerprint(REPLY),
    ]);
    expect(detectRepetitiveFingerprint(loopState.fingerprintHistory, 2)).toBe(
      true,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// E8 · P1-7
// ═══════════════════════════════════════════════════════════════════

describe("E8 · P1-7 压缩后重锚通路", () => {
  it("压缩成功后置位 loopState.needsGoalReanchor（修复前无任何置位方）", async () => {
    // 摘要调用 + 主调用各一次
    h.callModel
      .mockResolvedValueOnce({
        ok: true,
        value: {
          content: "压缩摘要",
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
          model: "m",
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          content: REPLY,
          finish_reason: "stop",
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          model: "m",
        },
      });

    configureContextCompression({
      triggerTokens: 50,
      keepRecentMessages: 2,
      minMessagesToCompress: 4,
    });
    const cfg = createLoopConfig({ model: "test-model", stream: false });
    if (!cfg.ok) throw new Error("cfg");
    const loopState = createLoopState({
      loopId: "loop-e8",
      agentId: "a",
      traceId: "t",
      config: cfg.value,
    });
    const history = Array.from({ length: 8 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `第 ${i + 1} 轮：${"x".repeat(400)}`,
    }));

    await runIteration(
      loopState,
      {
        userInput: "继续完成剩余工作",
        sessionId: "s",
        agentId: "a",
        agentRole: "worker",
        config: cfg.value,
        currentIteration: 1,
        totalTokensConsumed: 0,
        chatMessages: history.map((m) => ({ ...m })),
        recentCallTimestamps: [],
      },
      createLoopControlView(),
    );

    expect(loopState.needsGoalReanchor).toBe(true);
  });

  it("GoalReanchorControl 注入一次并**无条件清零**闩锁（修复前每轮重复注入）", async () => {
    registerMiddleware(
      createGoalReanchorControlMiddleware(undefined, {
        reanchorEveryRounds: 0,
      }),
    );
    h.callModel.mockResolvedValue({
      ok: true,
      value: {
        content: REPLY,
        finish_reason: "stop",
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        model: "test-model",
      },
    });

    const cfg = createLoopConfig({ model: "test-model", stream: false });
    if (!cfg.ok) throw new Error("cfg");
    const loopState = createLoopState({
      loopId: "loop-e8b",
      agentId: "a",
      traceId: "t",
      config: cfg.value,
    });
    loopState.goal.originalRequirement = "把登录接口实现完";

    const base = {
      userInput: "把登录接口实现完",
      sessionId: "s",
      agentId: "a",
      agentRole: "worker",
      chatMessages: [{ role: "user" as const, content: "把登录接口实现完" }],
      recentCallTimestamps: [],
    };

    // 第一轮前压缩发生了 → 置位
    loopState.needsGoalReanchor = true;
    await runIteration(
      loopState,
      {
        ...base,
        config: cfg.value,
        currentIteration: 1,
        totalTokensConsumed: 0,
      },
      createLoopControlView(),
    );
    const firstMessages = h.callModel.mock.calls[0]![1] as Array<{
      role: string;
      content: string;
    }>;
    expect(
      firstMessages.some((m) =>
        m.content.includes("【任务原始目标（不可修改，仅可参考）】"),
      ),
    ).toBe(true);
    expect(
      firstMessages.some((m) => m.content.includes("把登录接口实现完")),
    ).toBe(true);
    expect(loopState.needsGoalReanchor).toBe(false); // 闩锁已清零
    expect(getControlTriggerCounts().goal_reanchor_injected).toBe(1);

    // 第二轮：不应再次注入（修复前闩锁不清 → 每轮重复）
    h.callModel.mockClear();
    await runIteration(
      loopState,
      {
        ...base,
        config: cfg.value,
        currentIteration: 2,
        totalTokensConsumed: 0,
      },
      createLoopControlView(),
    );
    const secondMessages = h.callModel.mock.calls[0]![1] as Array<{
      role: string;
      content: string;
    }>;
    expect(
      secondMessages.some((m) =>
        m.content.includes("【任务原始目标（不可修改，仅可参考）】"),
      ),
    ).toBe(false);
    expect(getControlTriggerCounts().goal_reanchor_injected).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════
// E9 · P1-6 / P2-12
// ═══════════════════════════════════════════════════════════════════

function toolCtx(sessionId: string, agentId: string): MiddlewareContext {
  return {
    agentId,
    agentRole: "worker",
    sessionId,
    iteration: 1,
    traceId: "t",
    loopId: `loop-${sessionId}`,
    data: {},
  };
}

const TOOL_INPUT = { toolName: "FileWrite", arguments: {}, toolCallId: "c1" };

describe("E9 · P1-6/P2-12 限流回路作用域", () => {
  it("会话 A 跑满窗口 → 会话 B 不受影响（修复前共享全局计数器）", async () => {
    initRateLimiter({ maxToolCallsPerMinute: 2, burstAllowance: 1 });
    const next = async () => ({
      status: "success",
      content: "ok",
      recoverable: false,
    });

    const a = toolCtx("sess-A", "agent-1");
    const b = toolCtx("sess-B", "agent-1");

    // A 打满
    (await rateLimiterMiddleware.execute(a, TOOL_INPUT, next)) as never;
    (await rateLimiterMiddleware.execute(a, TOOL_INPUT, next)) as never;
    const aBlocked = (await rateLimiterMiddleware.execute(
      a,
      TOOL_INPUT,
      next,
    )) as { status: string; content: string };
    expect(aBlocked.status).toBe("error");
    // P2-13：退避建议可行动（retryAfterMs 真正被消费）
    expect(aBlocked.content).toContain("秒后重试");

    // B 完全不受影响
    const bOk = (await rateLimiterMiddleware.execute(b, TOOL_INPUT, next)) as {
      status: string;
    };
    expect(bOk.status).toBe("success");

    expect(rateLimitBucketKey("sess-A", "agent-1")).toBe("sess-A|agent-1");
    // 第 3 次被拦（不计入窗口）→ A 的窗口计数仍是 2
    expect(
      getRateLimiterStatus(rateLimitBucketKey("sess-A", "agent-1"))
        .currentToolCallCount,
    ).toBe(2);
    expect(
      getRateLimiterStatus(rateLimitBucketKey("sess-B", "agent-1"))
        .currentToolCallCount,
    ).toBe(1);
  });

  it("限流检查被计数（P1-6：该计数长期为 0 即意味着速率维无闭环）", async () => {
    initRateLimiter({ maxToolCallsPerMinute: 10, burstAllowance: 1 });
    (await rateLimiterMiddleware.execute(
      toolCtx("s", "a"),
      TOOL_INPUT,
      async () => ({ status: "success", content: "", recoverable: false }),
    )) as never;
    expect(getControlTriggerCounts().rate_limit_checked).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// P2-11 · 两套 LoopState 收敛到共享控制面
// ═══════════════════════════════════════════════════════════════════

describe("P2-11 · LoopState 控制面", () => {
  it("引擎侧 LoopState 具备控制器所需的 goal / failedAttempts / 回路记忆字段", () => {
    const cfg = createLoopConfig({ model: "test-model", stream: false });
    if (!cfg.ok) throw new Error("cfg");
    const state = createLoopState({
      loopId: "l",
      agentId: "a",
      traceId: "t",
      config: cfg.value,
    });

    expect(state.goal).toEqual({
      originalRequirement: "",
      immutableConstraints: [],
    });
    expect(state.failedAttempts).toEqual([]);
    expect(state.needsGoalReanchor).toBe(false);
    expect(state.fingerprintHistory).toEqual([]);
    expect(state.riskSignals).toEqual([]);
    // 控制器只需 `ControlLoopStateView` 的四个必填面
    const view: {
      loopId: string;
      traceId: string;
      goal: {
        originalRequirement: string;
        immutableConstraints: readonly string[];
      };
      failedAttempts: readonly unknown[];
    } = state;
    expect(view.loopId).toBe("l");
  });
});
