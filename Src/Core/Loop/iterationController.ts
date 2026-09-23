/**
 * @module Loop/iterationController
 * @description
 * Iteration controller - Docs/02 3 step 10.
 */

export type ExitReason = 'success' | 'max_iterations' | 'budget_exhausted' | 'no_progress' | 'risk';

export interface IterationState {
  current: number;
  max: number;
  totalTokensConsumed: number;
  tokenBudget: number;
  consecutiveNoToolCalls: number;
  terminated: boolean;
  exitReason?: ExitReason;
  exitMessage?: string;
  startedAt: number;
}

export interface IterationDecisionInput {
  hadToolCall: boolean;
  tokensConsumed: number;
  hasOutput: boolean;
  riskDetected: boolean;
}

export interface IterationDecision {
  shouldContinue: boolean;
  exitReason?: ExitReason;
  exitMessage?: string;
}

export function createIterationState(maxIterations: number, tokenBudget: number): IterationState {
  return {
    current: 0, max: maxIterations, totalTokensConsumed: 0, tokenBudget,
    consecutiveNoToolCalls: 0, terminated: false, startedAt: Date.now(),
  };
}

export function decideIteration(state: IterationState, input: IterationDecisionInput): IterationDecision {
  state.current++;
  state.totalTokensConsumed += input.tokensConsumed;
  if (input.hadToolCall) { state.consecutiveNoToolCalls = 0; }
  else { state.consecutiveNoToolCalls++; }

  if (input.riskDetected) {
    state.terminated = true; state.exitReason = 'risk';
    state.exitMessage = 'Risk detected, forced exit';
    return { shouldContinue: false, exitReason: 'risk', exitMessage: state.exitMessage };
  }
  if (state.totalTokensConsumed >= state.tokenBudget) {
    state.terminated = true; state.exitReason = 'budget_exhausted';
    state.exitMessage = `Token budget exhausted (${state.totalTokensConsumed}/${state.tokenBudget})`;
    return { shouldContinue: false, exitReason: 'budget_exhausted', exitMessage: state.exitMessage };
  }
  if (state.current >= state.max) {
    state.terminated = true; state.exitReason = 'max_iterations';
    state.exitMessage = `Max iterations reached (${state.current}/${state.max})`;
    return { shouldContinue: false, exitReason: 'max_iterations', exitMessage: state.exitMessage };
  }
  // 连续多轮无工具调用且无输出 → 无进展退出
  if (state.consecutiveNoToolCalls >= 5 && !input.hasOutput) {
    state.terminated = true; state.exitReason = 'no_progress';
    state.exitMessage = `No progress for ${state.consecutiveNoToolCalls} rounds`;
    return { shouldContinue: false, exitReason: 'no_progress', exitMessage: state.exitMessage };
  }
  // 注意：不再因「有文本输出但无工具调用」而立即退出。
  // 在对话场景中，模型可能先输出中间文本（如"好的，我先看看文件"），
  // 随后才调用工具。过早退出会导致"聊着聊着就不干活了"。
  // 循环将在 max_iterations / budget_exhausted / no_progress 时自然终止。
  return { shouldContinue: true };
}

export function getIterationStats(state: IterationState): Record<string, unknown> {
  return {
    iterations: state.current, maxIterations: state.max,
    totalTokensConsumed: state.totalTokensConsumed, tokenBudget: state.tokenBudget,
    tokenUsageRatio: state.tokenBudget > 0 ? state.totalTokensConsumed / state.tokenBudget : 0,
    elapsedMs: Date.now() - state.startedAt, terminated: state.terminated, exitReason: state.exitReason,
  };
}
