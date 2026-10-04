/**
 * @module Loop/loopConfig
 * @description
 * LoopConfig - Docs/Agent/02 12. Required 7 fields per loop instance.
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

// 硬上限（唯一事实源 = Configs/loopConfig.json 的 hardLimits 段）。
// 默认值对齐 hardLimits：tokenBudgetCeiling=2000000 / timeoutMsCeiling=600000 / maxIterationsCeiling=200。
// main.ts 启动时通过 setLoopLimits() 注入配置值，消除与 hardLimits 的双源漂移。
export interface LoopLimits {
  maxIterationsHardCap: number;
  maxTokenBudget: number;
  minTimeoutMs: number;
  maxTimeoutMs: number;
}

export const LOOP_LIMITS: LoopLimits = {
  maxIterationsHardCap: 200,
  maxTokenBudget: 2_000_000,
  minTimeoutMs: 5_000,
  maxTimeoutMs: 600_000,
};

/** 注入硬上限（由 main.ts 从 hardLimits 段读取后调用）。 */
export function setLoopLimits(limits: Partial<LoopLimits>): void {
  Object.assign(LOOP_LIMITS, limits);
}

/** 读取当前硬上限快照。 */
export function getLoopLimits(): LoopLimits {
  return { ...LOOP_LIMITS };
}

export function validateLoopConfig(config: LoopConfig): Result<LoopConfig> {
  if (!config.model || typeof config.model !== 'string')
    return err('INVALID_CONFIG: LoopConfig.model missing or not string');
  if (typeof config.max_iterations !== 'number' || config.max_iterations < 1)
    return err('INVALID_CONFIG: LoopConfig.max_iterations missing or < 1');
  if (config.max_iterations > LOOP_LIMITS.maxIterationsHardCap)
    return err(`INVALID_CONFIG: LoopConfig.max_iterations exceeds hard cap ${LOOP_LIMITS.maxIterationsHardCap}`);
  if (typeof config.timeout_ms !== 'number' || config.timeout_ms < LOOP_LIMITS.minTimeoutMs)
    return err(`INVALID_CONFIG: LoopConfig.timeout_ms missing or < ${LOOP_LIMITS.minTimeoutMs}`);
  if (config.timeout_ms > LOOP_LIMITS.maxTimeoutMs)
    return err(`INVALID_CONFIG: LoopConfig.timeout_ms exceeds cap ${LOOP_LIMITS.maxTimeoutMs}`);
  if (typeof config.temperature !== 'number' || config.temperature < 0 || config.temperature > 2)
    return err('INVALID_CONFIG: LoopConfig.temperature missing or not in [0, 2]');
  if (typeof config.token_budget !== 'number' || config.token_budget < 1)
    return err('INVALID_CONFIG: LoopConfig.token_budget missing or < 1');
  if (config.token_budget > LOOP_LIMITS.maxTokenBudget)
    return err(`INVALID_CONFIG: LoopConfig.token_budget exceeds hard cap ${LOOP_LIMITS.maxTokenBudget}`);
  if (typeof config.stream !== 'boolean')
    return err('INVALID_CONFIG: LoopConfig.stream missing or not boolean');
  return ok(config);
}

export function createLoopConfig(overrides?: Partial<LoopConfig>): Result<LoopConfig> {
  const config: LoopConfig = { ...DEFAULT_LOOP_CONFIG, ...overrides };
  return validateLoopConfig(config);
}

// ── Role Overrides（从 loopConfig.json 读取，消除硬编码）────────────

let _roleOverrides: Record<string, Partial<LoopConfig>> | null = null;

/**
 * 注入从 loopConfig.json 加载的 roleOverrides。
 * 由 main.ts 启动时调用。
 */
export function setRoleOverrides(overrides: Record<string, Partial<LoopConfig>>): void {
  _roleOverrides = { ...overrides };
}

/**
 * 获取当前 roleOverrides（仅使用注入值）。
 * 未注入时返回空对象——createRoleLoopConfig 会据此报 unknown role，督促 main.ts 必须注入配置。
 * 消除了硬编码 ROLE_OVERRIDES 与 Configs/loopConfig.json 的双源漂移。
 */
export function getRoleOverrides(): Record<string, Partial<LoopConfig>> {
  if (_roleOverrides) return _roleOverrides;
  return {};
}

/** @deprecated 使用 getRoleOverrides() 替代 */
export const ROLE_OVERRIDES: Record<string, Partial<LoopConfig>> = new Proxy({} as Record<string, Partial<LoopConfig>>, {
  get(_target, prop: string) {
    return getRoleOverrides()[prop];
  },
  ownKeys() {
    return Object.keys(getRoleOverrides());
  },
  getOwnPropertyDescriptor(_target, prop: string) {
    const overrides = getRoleOverrides();
    if (prop in overrides) {
      return { configurable: true, enumerable: true, value: overrides[prop] };
    }
    return undefined;
  },
});

export function createRoleLoopConfig(role: string): Result<LoopConfig> {
  const overrides = getRoleOverrides()[role];
  if (!overrides)
    return err(`INVALID_CONFIG: Unknown role: ${role}, valid: ${Object.keys(getRoleOverrides()).join(', ')}`);
  return createLoopConfig({ ...overrides });
}
