/**
 * @module Middleware/builtin/rateLimiter
 * @description
 * 工具调用限流中间件——Docs/Agent/02 §4.4 目标态全景表 wrapToolCall 优先级 30。
 *
 * 核心架构 §3 硬约束⑧："必须包裹 wrapToolCall：幂等、审批门、限流、日志"。
 * 本中间件实现其中的"限流"环节，与 toolSafetyGate（审批门，优先级 10）共存。
 *
 * 配置唯一事实源：`Configs/supervision.json → supervision.rateLimit.maxToolCallsPerMinute`。
 * 运行时通过 `initRateLimiter()` 注入配置，支持热加载。
 *
 * 实现机制：滑动窗口计数器。
 * - 窗口大小固定 60 秒
 * - 超限后返回错误，不调用 next()
 * - 窗口自动滑动（每次检查时清除过期计数）
 */

import type {
  AgentMiddleware, MiddlewareContext, ToolCallInput, ToolCallOutput,
} from '../../../Infra/Contracts/middlewareTypes.js';
import type { RateLimitConfig, RateLimitCheckResult } from '../../../Infra/Contracts/rateLimitTypes.js';
import { DEFAULT_RATE_LIMIT_CONFIG } from '../../../Infra/Contracts/rateLimitTypes.js';

// ── 滑动窗口计数器 ──────────────────────────────────────────────────

interface SlidingWindowCounter {
  /** 每个时间桶的调用计数（桶粒度 = 1 秒） */
  buckets: Map<number, number>;
  /** 窗口大小（毫秒） */
  windowMs: number;
}

function createSlidingWindowCounter(windowMs: number = 60_000): SlidingWindowCounter {
  return { buckets: new Map(), windowMs };
}

/** 清理过期桶并返回当前窗口内的总计数 */
function getWindowCount(counter: SlidingWindowCounter, now: number): number {
  const cutoff = now - counter.windowMs;
  // 清理过期桶
  for (const key of counter.buckets.keys()) {
    if (key < cutoff) counter.buckets.delete(key);
  }
  // 统计当前窗口内总数
  let total = 0;
  for (const count of counter.buckets.values()) total += count;
  return total;
}

/** 在当前时间桶中增加一次计数 */
function incrementCounter(counter: SlidingWindowCounter, now: number): void {
  const bucketKey = Math.floor(now / 1000) * 1000; // 1 秒粒度
  counter.buckets.set(bucketKey, (counter.buckets.get(bucketKey) ?? 0) + 1);
}

/** 检查限流结果 */
function checkRateLimit(
  counter: SlidingWindowCounter,
  maxPerWindow: number,
  now: number,
): RateLimitCheckResult {
  const currentCount = getWindowCount(counter, now);
  const remaining = Math.max(0, maxPerWindow - currentCount);
  const limited = currentCount >= maxPerWindow;
  const retryAfterMs = limited
    ? Math.max(1000, counter.windowMs - (now - Math.min(...counter.buckets.keys())))
    : 0;

  return {
    limited,
    reason: limited ? 'tool_calls_exceeded' : undefined,
    retryAfterMs,
    remaining,
  };
}

// ── 模块级状态 ──────────────────────────────────────────────────────

let rateLimitConfig: RateLimitConfig = { ...DEFAULT_RATE_LIMIT_CONFIG };
let toolCallCounter = createSlidingWindowCounter(60_000);

/** 初始化/更新限流配置（支持配置热加载） */
export function initRateLimiter(config: Partial<RateLimitConfig> = {}): void {
  rateLimitConfig = { ...DEFAULT_RATE_LIMIT_CONFIG, ...config };
  toolCallCounter = createSlidingWindowCounter(60_000);
}

/** 获取当前限流状态（供监控/测试使用） */
export function getRateLimiterStatus(): {
  config: RateLimitConfig;
  currentToolCallCount: number;
} {
  const now = Date.now();
  return {
    config: { ...rateLimitConfig },
    currentToolCallCount: getWindowCount(toolCallCounter, now),
  };
}

/** 重置限流器状态（仅测试使用） */
export function resetRateLimiter(): void {
  rateLimitConfig = { ...DEFAULT_RATE_LIMIT_CONFIG };
  toolCallCounter = createSlidingWindowCounter(60_000);
}

// ── 限流错误输出 ────────────────────────────────────────────────────

const RATE_LIMITED_OUTPUT: ToolCallOutput = {
  status: 'error',
  content: '[RateLimiter] Tool call rate limit exceeded. Please retry after the window resets.',
  recoverable: true,
};

// ── 中间件定义 ──────────────────────────────────────────────────────

export const rateLimiterMiddleware: AgentMiddleware = {
  name: 'RateLimiter',
  hook: 'wrapToolCall',
  priority: 30,
  canShortCircuit: true,

  execute: async (
    ctx: MiddlewareContext,
    input: ToolCallInput,
    next: (input: ToolCallInput) => Promise<ToolCallOutput>,
  ) => {
    const now = Date.now();

    // 计算突发上限（burstAllowance × 基础限额）
    const effectiveMax = Math.floor(
      rateLimitConfig.maxToolCallsPerMinute * rateLimitConfig.burstAllowance,
    );

    // 检查限流
    const check = checkRateLimit(toolCallCounter, effectiveMax, now);
    if (check.limited) {
      ctx.data['rateLimited'] = true;
      ctx.data['rateLimitRetryAfterMs'] = check.retryAfterMs;
      return RATE_LIMITED_OUTPUT;
    }

    // 通过限流，增加计数
    incrementCounter(toolCallCounter, now);
    ctx.data['rateLimitRemaining'] = check.remaining - 1;

    // 继续执行后续中间件/核心工具
    return next(input);
  },
};
