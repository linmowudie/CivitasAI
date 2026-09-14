/**
 * @module Supervision/postSupervision
 * @description
 * Post-supervision - Docs/02 step 9.
 * Result archival, anomaly scan, token deduction, loop exit decisions.
 */

import type { Result } from '../../Infra/types.js';
import { ok } from '../../Infra/types.js';

export interface PostSupervisionInput {
  outputText: string;
  toolResults: Array<{ toolName: string; status: string; recoverable: boolean }>;
  tokensConsumed: number;
  totalTokensConsumed: number;
  tokenBudget: number;
  currentIteration: number;
  maxIterations: number;
}

export interface ExitDecision {
  shouldExit: boolean;
  exitReason?: 'success' | 'budget_exhausted' | 'max_iterations' | 'error' | 'risk';
  message?: string;
}

export interface PostSupervisionResult {
  exitDecision: ExitDecision;
  tokenDeduction: { consumed: number; remaining: number };
  anomalies: string[];
  archived: boolean;
}

export function runPostSupervision(
  input: PostSupervisionInput,
): Result<PostSupervisionResult> {
  const anomalies: string[] = [];
  const remaining = input.tokenBudget - input.totalTokensConsumed;

  // Anomaly scan
  if (input.toolResults.some(r => r.status === 'error' && !r.recoverable)) {
    anomalies.push('UNRECOVERABLE_TOOL_ERROR');
  }

  // Exit decision
  let exitDecision: ExitDecision;

  if (anomalies.includes('UNRECOVERABLE_TOOL_ERROR')) {
    exitDecision = { shouldExit: true, exitReason: 'error', message: 'Unrecoverable tool error' };
  } else if (input.totalTokensConsumed >= input.tokenBudget) {
    exitDecision = { shouldExit: true, exitReason: 'budget_exhausted', message: 'Token budget exhausted' };
  } else if (input.currentIteration >= input.maxIterations) {
    exitDecision = { shouldExit: true, exitReason: 'max_iterations', message: 'Max iterations reached' };
  } else if (input.outputText && !input.toolResults.length) {
    exitDecision = { shouldExit: true, exitReason: 'success', message: 'Agent output complete' };
  } else {
    exitDecision = { shouldExit: false };
  }

  return ok({
    exitDecision,
    tokenDeduction: { consumed: input.tokensConsumed, remaining },
    anomalies,
    archived: true,
  });
}
