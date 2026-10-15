/**
 * 《Docs/Agent/17-控制论审查》P0 修复的回归锁（E1 / E2 / E3 的最小可执行形式）
 *
 * - E1（P0-1）：StopRules 判据在生产路径**必然被评估**（修复前整段不可达）
 * - E2（P0-2）：安全门按回路作用域隔离 + 句柄注销（修复前 A 的收尾会摘掉 B 的安全门）
 * - E3（P0-3 / P1-4）：预算哨兵走短路通道并给出显式退出类别（修复前伪造 success）
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
import { createLoopState } from "../../Src/Core/Loop/loopEngine.js";
import { createLoopConfig } from "../../Src/Core/Loop/loopConfig.js";
import {
  clearMiddlewares,
  registerMiddleware,
  getMiddlewaresForHook,
  getMiddlewareCount,
  unregisterMiddleware,
} from "../../Src/Core/Middleware/middlewareRegistry.js";
import { budgetSentinelMiddleware } from "../../Src/Core/Middleware/builtin/budgetSentinel.js";
import {
  getControlTriggerCounts,
  resetControlTriggerCounts,
  getDanglingCircuits,
} from "../../Src/Infra/Logging/controlTriggers.js";
import {
  setActiveStopRuleSet,
  clearActiveStopRuleSet,
  buildStopRuleSet,
} from "../../Src/Services/LoopControl/stopRules.js";
import { resetEventBus } from "../../Src/Services/EventBus/eventBus.js";
import type {
  AgentMiddleware,
  MiddlewareContext,
} from "../../Src/Infra/Contracts/middlewareTypes.js";

const OK_MODEL = {
  ok: true as const,
  value: {
    content: "任务完成。",
    finish_reason: "stop",
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    model: "test-model",
  },
};

function makeCtx() {
  return {
    userInput: "把这件事做完",
    sessionId: "sess-p0",
    agentId: "agent-p0",
    agentRole: "worker",
    chatMessages: [{ role: "user" as const, content: "把这件事做完" }],
    recentCallTimestamps: [],
  };
}

async function runOnce(control = createLoopControlView()) {
  const cfg = createLoopConfig({ model: "test-model", stream: false });
  if (!cfg.ok) throw new Error("loop config failed");
  const loopState = createLoopState({
    loopId: "loop-p0",
    agentId: "agent-p0",
    traceId: "trace-p0",
    config: cfg.value,
  });
  return runIteration(
    loopState,
    {
      ...makeCtx(),
      config: cfg.value,
      currentIteration: 1,
      totalTokensConsumed: 0,
    },
    control,
  );
}

beforeEach(() => {
  resetControlTriggerCounts();
  resetEventBus();
  resetSystemPromptCache();
  clearMiddlewares();
  clearActiveStopRuleSet();
  h.callModel.mockReset();
  h.callModelStream.mockReset();
});

// ═══════════════════════════════════════════════════════════════════
// E1 · P0-1：StopRules 不可达 → 可达
// ═══════════════════════════════════════════════════════════════════

describe("E1 · P0-1 StopRules 生产可达", () => {
  it("每轮都评估一次 StopRules（修复前恒 0）", async () => {
    h.callModel.mockResolvedValue(OK_MODEL);
    const result = await runOnce();
    expect(result.ok).toBe(true);
    expect(getControlTriggerCounts().stopRules_evaluated).toBe(1);
    expect(getDanglingCircuits()).not.toContain("stopRules_evaluated");
  });

  it("toolCallCount 判据真正生效（修复前该整段不可达）", async () => {
    h.callModel.mockResolvedValue(OK_MODEL);
    // 规则：工具调用上限 1；视图报告已调用 5 次 → 必须命中 limits 退出
    setActiveStopRuleSet(
      buildStopRuleSet({
        tokenBudget: 100_000,
        softRatio: 0.6,
        hardRatio: 1.0,
        warmRatio: 0.36,
        expandRequestRatio: 0.8,
        limits: {
          maxIterations: 30,
          maxWallClockMs: 900_000,
          maxToolCalls: 1,
          maxConsecutiveErrors: 3,
        },
        noProgress: {
          metric: "custom",
          stagnationWindow: 3,
          minDelta: 0.05,
          action: "switch_strategy",
        },
      }),
    );

    const result = await runOnce(createLoopControlView({ toolCallCount: 5 }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const last = result.value.decision;
    expect(last.shouldContinue).toBe(false);
    expect(last.exitReason).toBe("max_iterations");
    expect(last.exitMessage).toContain("最大工具调用数");
  });

  it("风险信号经视图进入 StopRules → risk 退出", async () => {
    h.callModel.mockResolvedValue(OK_MODEL);
    setActiveStopRuleSet(
      buildStopRuleSet({
        tokenBudget: 100_000,
        softRatio: 0.6,
        hardRatio: 1.0,
        warmRatio: 0.36,
        expandRequestRatio: 0.8,
        limits: {
          maxIterations: 30,
          maxWallClockMs: 900_000,
          maxToolCalls: 100,
          maxConsecutiveErrors: 3,
        },
        noProgress: {
          metric: "custom",
          stagnationWindow: 3,
          minDelta: 0.05,
          action: "switch_strategy",
        },
      }),
    );

    const result = await runOnce(
      createLoopControlView({ riskSignals: ["repetitive_output"] }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.decision.exitReason).toBe("risk");
  });
});

// ═══════════════════════════════════════════════════════════════════
// E2 · P0-2：回路作用域 + 句柄注销
// ═══════════════════════════════════════════════════════════════════

function scoped(name: string, ownerId: string): AgentMiddleware {
  return {
    name,
    hook: "wrapToolCall",
    priority: 10,
    canShortCircuit: true,
    execute: async (_ctx, input, next) => next(input as never) as never,
  };
}

describe("E2 · P0-2 安全门回路作用域", () => {
  it("不同回路可各自持有同名实例（修复前 B 注册重名直接失败）", () => {
    const a = registerMiddleware(scoped("ToolSafetyGate", "loop-A"), "loop-A");
    const b = registerMiddleware(scoped("ToolSafetyGate", "loop-B"), "loop-B");
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(getMiddlewareCount()).toBe(2);
  });

  it("同回路重名才拒绝，且失败被计数留痕（修复前返回值被静默丢弃）", () => {
    registerMiddleware(scoped("ToolSafetyGate", "loop-A"), "loop-A");
    const dup = registerMiddleware(
      scoped("ToolSafetyGate", "loop-A"),
      "loop-A",
    );
    expect(dup.ok).toBe(false);
    expect(getControlTriggerCounts().middleware_registered_failed).toBe(1);
  });

  it("执行时按 loopId 隔离：A 的轮次看不到 B 的安全门", () => {
    registerMiddleware(scoped("GateA", "loop-A"), "loop-A");
    registerMiddleware(scoped("GateB", "loop-B"), "loop-B");
    expect(
      getMiddlewaresForHook("wrapToolCall", "loop-A").map((m) => m.name),
    ).toEqual(["GateA"]);
    expect(
      getMiddlewaresForHook("wrapToolCall", "loop-B").map((m) => m.name),
    ).toEqual(["GateB"]);
    // loopId 缺失 → 回路作用域中间件一律不跑（fail-closed）
    expect(getMiddlewaresForHook("wrapToolCall", undefined)).toHaveLength(0);
  });

  it("按句柄注销：A 收尾摘不掉 B 的安全门（修复前按名删除会全摘）", () => {
    const a = registerMiddleware(scoped("ToolSafetyGate", "loop-A"), "loop-A");
    const b = registerMiddleware(scoped("ToolSafetyGate", "loop-B"), "loop-B");
    if (!a.ok || !b.ok) throw new Error("register failed");

    expect(unregisterMiddleware(a.value)).toBe(true);
    expect(
      getMiddlewaresForHook("wrapToolCall", "loop-B").map((m) => m.name),
    ).toEqual(["ToolSafetyGate"]);
    expect(getMiddlewareCount()).toBe(1);
    // 重复注销同一句柄 → false（不误伤他人）
    expect(unregisterMiddleware(a.value)).toBe(false);
  });

  it("全局中间件（无 ownerId）在所有回路都执行", () => {
    registerMiddleware(scoped("GlobalGate"));
    expect(getMiddlewaresForHook("wrapToolCall", "loop-A")).toHaveLength(1);
    expect(getMiddlewaresForHook("wrapToolCall", "loop-B")).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════
// E3 · P0-3 / P1-4：预算哨兵改走短路通道
// ═══════════════════════════════════════════════════════════════════

function mwCtx(data: Record<string, unknown>): MiddlewareContext {
  return {
    agentId: "a",
    agentRole: "worker",
    sessionId: "s",
    iteration: 1,
    traceId: "t",
    loopId: "loop-p0",
    data,
  };
}

describe("E3 · P0-3/P1-4 预算哨兵", () => {
  it("投影消耗 ≥ 95% → 短路 + 显式 budget_exhausted（修复前返回伪正文 → 被记为 success）", async () => {
    const ctx = mwCtx({
      tokenBudget: 1000,
      tokensConsumed: 900,
      estimatedPromptTokens: 100,
    });
    const out = await budgetSentinelMiddleware.execute(ctx, []);
    expect(out).toMatchObject({ shortCircuit: true });
    const result = (out as { result: { exitReason?: string; content: string } })
      .result;
    expect(result.exitReason).toBe("budget_exhausted");
    expect(ctx.data["budgetStatus"]).toBe("critical");
  });

  it("半轮前瞻：上轮累计 800 + 本轮 prompt 估算 180 → 触发（修复前只用 800/1000=0.8 不触发）", async () => {
    const ctx = mwCtx({
      tokenBudget: 1000,
      tokensConsumed: 800,
      estimatedPromptTokens: 180,
    });
    const out = await budgetSentinelMiddleware.execute(ctx, []);
    expect(out).toMatchObject({ shortCircuit: true });
  });

  it("未达阈值 → 放行，且只标记 warning", async () => {
    const ctx = mwCtx({
      tokenBudget: 1000,
      tokensConsumed: 700,
      estimatedPromptTokens: 100,
    });
    const messages = [{ role: "user", content: "x" }];
    const out = await budgetSentinelMiddleware.execute(ctx, messages);
    expect(out).toBe(messages);
    expect(ctx.data["budgetStatus"]).toBe("warning");
  });

  it("未配置预算 → 恒放行", async () => {
    const ctx = mwCtx({});
    const out = await budgetSentinelMiddleware.execute(ctx, []);
    expect(out).toEqual([]);
    expect(ctx.data["budgetStatus"]).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════
// 退出类别收敛（P1-4）
// ═══════════════════════════════════════════════════════════════════

describe("P1-4 · 退出类别不再坍缩为 risk", () => {
  it("模型调用失败 → model_error", async () => {
    h.callModel.mockResolvedValue({ ok: false, error: "upstream 500" });
    const cfg = createLoopConfig({ model: "test-model", stream: false });
    if (!cfg.ok) throw new Error("cfg");
    const loopState = createLoopState({
      loopId: "loop-e",
      agentId: "a",
      traceId: "t",
      config: cfg.value,
    });
    const result = await runIteration(
      loopState,
      {
        ...makeCtx(),
        config: cfg.value,
        currentIteration: 1,
        totalTokensConsumed: 0,
      },
      createLoopControlView(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.decision.exitReason).toBe("model_error");
  });

  it("mapStoppedReasonToExitReason：human_abort 归入 intercepted（不再折进 risk）", async () => {
    const { mapStoppedReasonToExitReason, mapShortCircuitExitReason } =
      await import("../../Src/Core/Loop/runIteration.js");
    expect(mapStoppedReasonToExitReason("human_abort")).toBe("intercepted");
    expect(mapStoppedReasonToExitReason("risk")).toBe("risk");
    expect(mapStoppedReasonToExitReason("budget_hard")).toBe(
      "budget_exhausted",
    );
    // 短路类别白名单：非法值一律回落 intercepted，绝不回落 success
    expect(mapShortCircuitExitReason("budget_exhausted")).toBe(
      "budget_exhausted",
    );
    expect(mapShortCircuitExitReason("success")).toBe("success");
    expect(mapShortCircuitExitReason("nonsense")).toBe("intercepted");
    expect(mapShortCircuitExitReason(undefined)).toBe("intercepted");
  });

  it("StoppedReason 是单一事实源：全部取值都有确定投影（编译期由 Record<StoppedReason, ExitReason> 强制）", async () => {
    const { mapStoppedReasonToExitReason } =
      await import("../../Src/Core/Loop/runIteration.js");
    const { EXIT_REASONS } =
      await import("../../Src/Core/Loop/iterationController.js");
    // 与 Services/LoopControl/types.ts 的 StoppedReason 全集一一对应
    const allStoppedReasons = [
      "success",
      "limits",
      "budget_soft",
      "budget_hard",
      "no_progress",
      "risk",
      "human_abort",
    ] as const;

    const projected = allStoppedReasons.map((r) =>
      mapStoppedReasonToExitReason(r),
    );
    // 多对一收敛：7 → 6 个不同类别（budget_soft/hard 合一）
    expect(new Set(projected).size).toBe(6);
    expect(new Set(projected)).toEqual(
      new Set([
        "success",
        "max_iterations",
        "budget_exhausted",
        "no_progress",
        "risk",
        "intercepted",
      ]),
    );
    // 每个投影都必须是合法 ExitReason（下游不再各自维护一套枚举）
    for (const r of allStoppedReasons) {
      expect(EXIT_REASONS).toContain(mapStoppedReasonToExitReason(r));
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// 13 · 元监控
// ═══════════════════════════════════════════════════════════════════

describe("13 · 控制回路触发计数（断线自动暴露）", () => {
  it("全零时断线清单非空；评估过一次 StopRules 后该项出列", async () => {
    expect(getDanglingCircuits()).toContain("stopRules_evaluated");
    h.callModel.mockResolvedValue(OK_MODEL);
    await runOnce();
    expect(getDanglingCircuits()).not.toContain("stopRules_evaluated");
  });

  it("计数快照包含全部受监控项", () => {
    const counts = getControlTriggerCounts();
    expect(Object.keys(counts).sort()).toEqual([
      "anomaly_poll_invoked",
      "approval_gate_invoked",
      "fingerprint_hit",
      "goal_reanchor_injected",
      "injection_detected",
      "ledger_mismatch",
      "middleware_registered_failed",
      "middleware_short_circuit",
      "pause_observed",
      "rate_limit_checked",
      "stopRules_evaluated",
      "verifier_pipeline_invoked",
    ]);
  });
});
