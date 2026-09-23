/**
 * @module Loop/loopEngine
 * @description
 * Main loop engine - Docs/02 3 ten-step sequence.
 */

import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';

import type { LoopConfig } from './loopConfig.js';
import { createIterationState, type IterationState } from './iterationController.js';

export type LoopPhase = 'idle' | 'running' | 'paused' | 'completed' | 'failed';

export interface LoopState {
  loopId: string;
  agentId: string;
  traceId: string;
  parentAgentId?: string;
  phase: LoopPhase;
  iteration: IterationState;
  config: LoopConfig;
  startedAt: number;
  lastActivityAt: number;
}

export type LoopStep =
  | '① InputReceived' | '② PreSupervision' | '③ Middleware'
  | '④ ContextAssembly' | '⑤ LazySupervision' | '⑥ ModelCall'
  | '⑦ OutputParse' | '⑧ ToolExecute' | '⑨ PostSupervision'
  | '⑩ IterationDecision';

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
    loopId: options.loopId, agentId: options.agentId, traceId: options.traceId,
    parentAgentId: options.parentAgentId, phase: 'idle',
    iteration: createIterationState(options.config.max_iterations, options.config.token_budget),
    config: options.config, startedAt: 0, lastActivityAt: 0,
  };
}

export function startLoop(state: LoopState): Result<LoopState> {
  if (state.phase !== 'idle') return err('INVALID_STATE', `Loop ${state.loopId} not idle`);
  state.phase = 'running'; state.startedAt = Date.now(); state.lastActivityAt = Date.now();
  return ok(state);
}

export function pauseLoop(state: LoopState): Result<LoopState> {
  if (state.phase !== 'running') return err('INVALID_STATE', `Loop ${state.loopId} not running`);
  state.phase = 'paused'; return ok(state);
}

export function resumeLoop(state: LoopState): Result<LoopState> {
  if (state.phase !== 'paused') return err('INVALID_STATE', `Loop ${state.loopId} not paused`);
  state.phase = 'running'; state.lastActivityAt = Date.now(); return ok(state);
}

export function terminateLoop(state: LoopState, _reason: string): Result<LoopState> {
  state.phase = 'completed'; state.lastActivityAt = Date.now(); return ok(state);
}

export function failLoop(state: LoopState, _reason: string): Result<LoopState> {
  state.phase = 'failed'; state.lastActivityAt = Date.now(); return ok(state);
}

export function recordLoopEvent(state: LoopState, step: LoopStep, data: Record<string, unknown> = {}): LoopEvent {
  state.lastActivityAt = Date.now();
  return { loopId: state.loopId, step, iteration: state.iteration.current, timestamp: Date.now(), data };
}

export function getLoopSummary(state: LoopState): Record<string, unknown> {
  return {
    loopId: state.loopId, agentId: state.agentId, traceId: state.traceId,
    parentAgentId: state.parentAgentId, phase: state.phase,
    iteration: state.iteration.current, maxIterations: state.iteration.max,
    totalTokensConsumed: state.iteration.totalTokensConsumed, tokenBudget: state.iteration.tokenBudget,
    elapsedMs: state.startedAt > 0 ? Date.now() - state.startedAt : 0,
    terminated: state.iteration.terminated, exitReason: state.iteration.exitReason,
  };
}

export function assertStepOrder(steps: LoopStep[]): boolean {
  const order: LoopStep[] = [
    '① InputReceived', '② PreSupervision', '③ Middleware',
    '④ ContextAssembly', '⑤ LazySupervision', '⑥ ModelCall',
    '⑦ OutputParse', '⑧ ToolExecute', '⑨ PostSupervision', '⑩ IterationDecision',
  ];
  for (let i = 1; i < steps.length; i++) {
    const prevIdx = order.indexOf(steps[i - 1]);
    const currIdx = order.indexOf(steps[i]);
    if (prevIdx === -1 || currIdx === -1) return false;
    if (currIdx < prevIdx) return false;
  }
  return true;
}
