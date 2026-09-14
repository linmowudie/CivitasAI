/**
 * @module Loop/loopConfig
 * @description
 * LoopConfig - Docs/02 12. Required 7 fields per loop instance.
 */

import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';

export interface LoopConfig {
  model: string;
  max_iterations: number;
  timeout_ms: number;
  temperature: number;
  token_budget: number;
  stream: boolean;
  pauseSignal?: AbortController;
}

export const DEFAULT_LOOP_CONFIG: LoopConfig = {
  model: 'workerModel',
  max_iterations: 30,
  timeout_ms: 60_000,
  temperature: 0.2,
  token_budget: 100_000,
  stream: true,
};

export const LOOP_LIMITS = {
  maxIterationsHardCap: 200,
  maxTokenBudget: 1_000_000,
  minTimeoutMs: 5_000,
  maxTimeoutMs: 300_000,
} as const;

export function validateLoopConfig(config: LoopConfig): Result<LoopConfig> {
  if (!config.model || typeof config.model !== 'string')
    return err('INVALID_CONFIG', 'LoopConfig.model missing or not string');
  if (typeof config.max_iterations !== 'number' || config.max_iterations < 1)
    return err('INVALID_CONFIG', 'LoopConfig.max_iterations missing or < 1');
  if (config.max_iterations > LOOP_LIMITS.maxIterationsHardCap)
    return err('INVALID_CONFIG', `LoopConfig.max_iterations exceeds hard cap ${LOOP_LIMITS.maxIterationsHardCap}`);
  if (typeof config.timeout_ms !== 'number' || config.timeout_ms < LOOP_LIMITS.minTimeoutMs)
    return err('INVALID_CONFIG', `LoopConfig.timeout_ms missing or < ${LOOP_LIMITS.minTimeoutMs}`);
  if (config.timeout_ms > LOOP_LIMITS.maxTimeoutMs)
    return err('INVALID_CONFIG', `LoopConfig.timeout_ms exceeds cap ${LOOP_LIMITS.maxTimeoutMs}`);
  if (typeof config.temperature !== 'number' || config.temperature < 0 || config.temperature > 2)
    return err('INVALID_CONFIG', 'LoopConfig.temperature missing or not in [0, 2]');
  if (typeof config.token_budget !== 'number' || config.token_budget < 1)
    return err('INVALID_CONFIG', 'LoopConfig.token_budget missing or < 1');
  if (config.token_budget > LOOP_LIMITS.maxTokenBudget)
    return err('INVALID_CONFIG', `LoopConfig.token_budget exceeds hard cap ${LOOP_LIMITS.maxTokenBudget}`);
  if (typeof config.stream !== 'boolean')
    return err('INVALID_CONFIG', 'LoopConfig.stream missing or not boolean');
  return ok(config);
}

export function createLoopConfig(overrides?: Partial<LoopConfig>): Result<LoopConfig> {
  const config: LoopConfig = { ...DEFAULT_LOOP_CONFIG, ...overrides };
  return validateLoopConfig(config);
}

export const ROLE_OVERRIDES: Record<string, Partial<LoopConfig>> = {
  prime_director: { max_iterations: 50, token_budget: 200_000, temperature: 0.2 },
  partner:        { max_iterations: 30, token_budget: 100_000, temperature: 0.2 },
  worker:         {},
  reviewer:       { max_iterations: 10, token_budget: 50_000, temperature: 0 },
  assembly_node:  { max_iterations: 20, token_budget: 80_000, temperature: 0.2 },
  arbitrator:     { max_iterations: 15, token_budget: 60_000, temperature: 0 },
  auditor:        { max_iterations: 10, token_budget: 40_000, temperature: 0 },
  regulator:      { max_iterations: 20, token_budget: 80_000, temperature: 0.1 },
};

export function createRoleLoopConfig(role: string): Result<LoopConfig> {
  const overrides = ROLE_OVERRIDES[role];
  if (!overrides)
    return err('INVALID_CONFIG', `Unknown role: ${role}, valid: ${Object.keys(ROLE_OVERRIDES).join(', ')}`);
  return createLoopConfig({ ...overrides });
}
