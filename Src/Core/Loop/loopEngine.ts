/**
 * @module Loop/loopEngine
 * @description
 * Main loop engine - Docs/Agent/02 3 ten-step sequence.
 */

import type { Result } from "../../Infra/types.js";
import { ok, err } from "../../Infra/types.js";
import type { ControlLoopStateView } from "../../Infra/Contracts/loopStateTypes.js";
import {
  getControlTriggerCounts,
  getDanglingCircuits,
} from "../../Infra/Logging/controlTriggers.js";

import type { LoopConfig } from "./loopConfig.js";
import {
  createIterationState,
  type IterationState,
} from "./iterationController.js";

export type LoopPhase = "idle" | "running" | "paused" | "completed" | "failed";

/**
 * 引擎侧 LoopState。
 *
 * P2-11（控制论审查）：补齐**回路记忆**字段，使本类型满足跨层契约
 * `ControlLoopStateView`——控制器（如 `GoalReanchorControl`）据此拿到真实运行态，
 * 而不是"只在测试里存在"的另一套状态对象。
 *  - `goal`（不可变区，ADR-0005：压缩/摘要不得修改）
 *  - `needsGoalReanchor`（P1-7：由 ⑤ 步压缩成功后置位）
 *  - `fingerprintHistory`（P1-5：跨轮保留，修复前写在每轮重建的 `ctx.data` 上 → 长度恒 ≤1）
 *  - `riskSignals`（跨轮累积，进 StopRules 的 riskTriggers）
 */
export interface LoopState extends ControlLoopStateView {
  agentId: string;
  parentAgentId?: string;
  phase: LoopPhase;
  iteration: IterationState;
  config: LoopConfig;
  startedAt: number;
  lastActivityAt: number;
  /** 不可变区（ADR-0005） */
  goal: { originalRequirement: string; immutableConstraints: string[] };
  /** 失败尝试历史（供重锚器回灌） */
  failedAttempts: Array<{
    iteration: number;
    strategy: string;
    failureCategory: string;
  }>;
  /** 压缩后置位的重锚请求（P1-7） */
  needsGoalReanchor: boolean;
  /** 跨轮输出指纹历史（P1-5） */
  fingerprintHistory: string[];
  /** 跨轮累积风险信号 */
  riskSignals: string[];
}

export type LoopStep =
  | "① InputReceived"
  | "② PreSupervision"
  | "③ Middleware"
  | "④ ContextAssembly"
  | "⑤ LazySupervision"
  | "⑥ ModelCall"
  | "⑦ OutputParse"
  | "⑧ ToolExecute"
  | "⑨ PostSupervision"
  | "⑩ IterationDecision";

export interface LoopEvent {
  loopId: string;
  step: LoopStep;
  iteration: number;
  timestamp: number;
  data: Record<string, unknown>;
}

export interface LoopEngineOptions {
  loopId: string;
  agentId: string;
  traceId: string;
  parentAgentId?: string;
  config: LoopConfig;
}

export function createLoopState(options: LoopEngineOptions): LoopState {
  return {
    loopId: options.loopId,
    agentId: options.agentId,
    traceId: options.traceId,
    parentAgentId: options.parentAgentId,
    phase: "idle",
    iteration: createIterationState(
      options.config.max_iterations,
      options.config.token_budget,
    ),
    config: options.config,
    startedAt: 0,
    lastActivityAt: 0,
    // P2-11 控制面（executeLoop 启动时用 userInput 填充 originalRequirement）
    goal: { originalRequirement: "", immutableConstraints: [] },
    failedAttempts: [],
    needsGoalReanchor: false,
    fingerprintHistory: [],
    riskSignals: [],
  };
}

export function startLoop(state: LoopState): Result<LoopState> {
  if (state.phase !== "idle")
    return err(`INVALID_STATE: Loop ${state.loopId} not idle`);
  state.phase = "running";
  state.startedAt = Date.now();
  state.lastActivityAt = Date.now();
  return ok(state);
}

export function pauseLoop(state: LoopState): Result<LoopState> {
  if (state.phase !== "running")
    return err(`INVALID_STATE: Loop ${state.loopId} not running`);
  state.phase = "paused";
  return ok(state);
}

export function resumeLoop(state: LoopState): Result<LoopState> {
  if (state.phase !== "paused")
    return err(`INVALID_STATE: Loop ${state.loopId} not paused`);
  state.phase = "running";
  state.lastActivityAt = Date.now();
  return ok(state);
}

export function terminateLoop(
  state: LoopState,
  _reason: string,
): Result<LoopState> {
  state.phase = "completed";
  state.lastActivityAt = Date.now();
  return ok(state);
}

export function failLoop(state: LoopState, _reason: string): Result<LoopState> {
  state.phase = "failed";
  state.lastActivityAt = Date.now();
  return ok(state);
}

export function recordLoopEvent(
  state: LoopState,
  step: LoopStep,
  data: Record<string, unknown> = {},
): LoopEvent {
  state.lastActivityAt = Date.now();
  return {
    loopId: state.loopId,
    step,
    iteration: state.iteration.current,
    timestamp: Date.now(),
    data,
  };
}

export function getLoopSummary(state: LoopState): Record<string, unknown> {
  return {
    loopId: state.loopId,
    agentId: state.agentId,
    traceId: state.traceId,
    parentAgentId: state.parentAgentId,
    phase: state.phase,
    iteration: state.iteration.current,
    maxIterations: state.iteration.max,
    totalTokensConsumed: state.iteration.totalTokensConsumed,
    tokenBudget: state.iteration.tokenBudget,
    elapsedMs: state.startedAt > 0 ? Date.now() - state.startedAt : 0,
    terminated: state.iteration.terminated,
    exitReason: state.iteration.exitReason,
    // ── P2-11 回路记忆（控制器据以工作的状态面）──
    goalConfigured: state.goal.originalRequirement.length > 0,
    immutableConstraints: state.goal.immutableConstraints.length,
    failedAttempts: state.failedAttempts.length,
    needsGoalReanchor: state.needsGoalReanchor,
    riskSignals: [...state.riskSignals],
    fingerprintRounds: state.fingerprintHistory.length,
    // ── 元监控（审查建议 13）：控制组件触发矩阵 + 断线清单 ──
    controlTriggers: getControlTriggerCounts(),
    danglingCircuits: getDanglingCircuits(),
  };
}

/**
 * P1-5：检测「连续 N 轮输出指纹完全相同」的极限环。
 *
 * 修复背景：指纹历史原先写在每轮重建的中间件 `ctx.data` 上，数组长度恒 ≤1，
 * 任何重复输出都无法命中——系统唯一的振荡探测**结构上不可能成立**。
 * 历史改挂到 `LoopState.fingerprintHistory`（跨轮持久）后，本函数第一次可能返回 true。
 */
export function detectRepetitiveFingerprint(
  history: readonly string[],
  consecutiveRounds: number,
): boolean {
  if (consecutiveRounds <= 0 || history.length < consecutiveRounds)
    return false;
  const tail = history.slice(-consecutiveRounds);
  const first = tail[0];
  return first !== undefined && tail.every((f) => f === first);
}

export function assertStepOrder(steps: LoopStep[]): boolean {
  const order: LoopStep[] = [
    "① InputReceived",
    "② PreSupervision",
    "③ Middleware",
    "④ ContextAssembly",
    "⑤ LazySupervision",
    "⑥ ModelCall",
    "⑦ OutputParse",
    "⑧ ToolExecute",
    "⑨ PostSupervision",
    "⑩ IterationDecision",
  ];
  for (let i = 1; i < steps.length; i++) {
    const prev = steps[i - 1];
    const curr = steps[i];
    if (prev === undefined || curr === undefined) return false;
    const prevIdx = order.indexOf(prev);
    const currIdx = order.indexOf(curr);
    if (prevIdx === -1 || currIdx === -1) return false;
    if (currIdx < prevIdx) return false;
  }
  return true;
}
