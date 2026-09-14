/**
 * @module Loop/iterationController
 * @description
 * Iteration controller - Docs/02 3 step 10.
 */

import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';

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
  if (state.consecutiveNoToolCalls >= 5 && !input.hasOutput) {
    state.terminated = true; state.exitReason = 'no_progress';
    state.exitMessage = `No progress for ${state.consecutiveNoToolCalls} rounds`;
    return { shouldContinue: false, exitReason: 'no_progress', exitMessage: state.exitMessage };
  }
  if (input.hasOutput && !input.hadToolCall) {
    state.terminated = true; state.exitReason = 'success';
    state.exitMessage = 'Task completed';
    return { shouldContinue: false, exitReason: 'success', exitMessage: state.exitMessage };
  }
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
