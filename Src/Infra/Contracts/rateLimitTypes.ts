/**
 * @module Infra/Contracts/rateLimitTypes
 * @description
 * 跨层共享限流类型契约——统一限流配置与状态定义。
 *
 * 依据 Docs/Agent/02 §1.1 五层单向依赖红线：本模块为纯类型、零 import、零运行时，
 * 供 Core/Services/Interface 层共同向下依赖。
 *
 * 配置事实源：`Configs/supervision.json`（FE-040 解耦后分两段）：
 * - `supervision.rateLimit` → 监管侧（前置监管频率 / 工具调用限流），见 `RateLimitConfig`；
 * - `supervision.apiRateLimit` → HTTP API 层（UI 交互），见 `ApiRateLimitConfig`。
 * 为 UI 放宽 API 额度不再影响 Agent 监管阈值。
 */

// ── 限流配置（supervision.json → rateLimit）────────────────────────

/** 统一限流配置——监管侧速率控制参数的单一事实源（supervision.json → rateLimit） */
export interface RateLimitConfig {
  /** 前置监管：每 Agent 每分钟最大调用次数 */
  maxRequestsPerMinute: number;
  /** 每分钟最大 Token 消耗量 */
  maxTokensPerMinute: number;
  /** 每分钟最大工具调用次数 */
  maxToolCallsPerMinute: number;
  /** 突发允许倍数（1.5 = 允许 1.5x 峰值） */
  burstAllowance: number;
}

/** 默认监管限流配置（当 supervision.json 缺失 rateLimit 键时回退） */
export const DEFAULT_RATE_LIMIT_CONFIG: RateLimitConfig = {
  maxRequestsPerMinute: 30,
  maxTokensPerMinute: 100_000,
  maxToolCallsPerMinute: 60,
  burstAllowance: 2,
};

// ── HTTP API 层限流配置（supervision.json → apiRateLimit）────────────

/**
 * HTTP API 层限流配置——FE-040：与监管配置（RateLimitConfig）解耦，独立配置键。
 * 仅约束本地 UI/API 交互频率，放宽（如 FE-039 的 30→600）不应波及监管阈值。
 */
export interface ApiRateLimitConfig {
  /** 每分钟最大 HTTP 请求数 */
  maxRequestsPerMinute: number;
  /** 突发允许倍数（1.5 = 允许 1.5x 峰值） */
  burstAllowance: number;
}

/** 默认 HTTP API 限流配置（当 supervision.json 缺失 apiRateLimit 键时回退） */
export const DEFAULT_API_RATE_LIMIT_CONFIG: ApiRateLimitConfig = {
  maxRequestsPerMinute: 600,
  burstAllowance: 2,
};

// ── 限流状态（运行时计数器）────────────────────────────────────────

/** 滑动窗口限流状态 */
export interface RateLimitState {
  /** 当前窗口内请求计数 */
  requestCount: number;
  /** 当前窗口内 Token 消耗计数 */
  tokenCount: number;
  /** 当前窗口内工具调用计数 */
  toolCallCount: number;
  /** 窗口起始时间戳（Unix 毫秒） */
  windowStart: number;
}

/** 创建初始限流状态 */
export function createInitialRateLimitState(): RateLimitState {
  return {
    requestCount: 0,
    tokenCount: 0,
    toolCallCount: 0,
    windowStart: Date.now(),
  };
}

// ── 限流检查结果 ────────────────────────────────────────────────────

/** 限流检查结果 */
export interface RateLimitCheckResult {
  /** 是否被限流 */
  limited: boolean;
  /** 限流原因 */
  reason?: 'requests_exceeded' | 'tokens_exceeded' | 'tool_calls_exceeded';
  /** 距离窗口重置的剩余毫秒数 */
  retryAfterMs: number;
  /** 当前窗口剩余可用额度 */
  remaining: number;
}
