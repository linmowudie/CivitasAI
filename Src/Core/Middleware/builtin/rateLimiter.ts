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
 * ## P2-12 修复（2026-10-11 控制论审查）：限流计数按**回路**分桶
 *
 * 原实现用模块级单一 `toolCallCounter`，不按 `sessionId`/`agentId` 分桶 ——
 * 一个会话跑满窗口会把**其他会话一起饿死**（跨回路串扰，审查 P2-12）。
 * 现在按 `sessionId|agentId` 分桶，并淘汰窗口外的空桶避免无界增长。
 *
 * ## P2-13 修复：`retryAfterMs` 真正被消费
 *
 * 原实现的 `retryAfterMs` 只写进 `ctx.data` 就没人用。现在把它写进给模型的
 * 限流提示（"请在 N 秒后重试"），使退避建议**可行动**而不是一句无声拒绝。
 */

import type {
  AgentMiddleware,
  MiddlewareContext,
  ToolCallInput,
  ToolCallOutput,
} from "../../../Infra/Contracts/middlewareTypes.js";
import type {
  RateLimitConfig,
  RateLimitCheckResult,
} from "../../../Infra/Contracts/rateLimitTypes.js";
import { DEFAULT_RATE_LIMIT_CONFIG } from "../../../Infra/Contracts/rateLimitTypes.js";
import { recordControlTrigger } from "../../../Infra/Logging/controlTriggers.js";

// ── 滑动窗口计数器 ──────────────────────────────────────────────────

interface SlidingWindowCounter {
  /** 每个时间桶的调用计数（桶粒度 = 1 秒） */
  buckets: Map<number, number>;
  /** 窗口大小（毫秒） */
  windowMs: number;
}

function createSlidingWindowCounter(
  windowMs: number = 60_000,
): SlidingWindowCounter {
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
  const oldest =
    counter.buckets.size > 0 ? Math.min(...counter.buckets.keys()) : now;
  const retryAfterMs = limited
    ? Math.max(1000, counter.windowMs - (now - oldest))
    : 0;

  return {
    limited,
    reason: limited ? "tool_calls_exceeded" : undefined,
    retryAfterMs,
    remaining,
  };
}

// ── 模块级状态 ──────────────────────────────────────────────────────

let rateLimitConfig: RateLimitConfig = { ...DEFAULT_RATE_LIMIT_CONFIG };

/** P2-12：按回路分桶（key = `sessionId|agentId`），不再是全局单计数器 */
let counters = new Map<string, SlidingWindowCounter>();

/** 分桶键：会话 + Agent（两者任一变化即视为不同回路，互不干扰） */
export function rateLimitBucketKey(sessionId: string, agentId: string): string {
  return `${sessionId}|${agentId}`;
}

function counterFor(key: string, now: number): SlidingWindowCounter {
  let counter = counters.get(key);
  if (!counter) {
    counter = createSlidingWindowCounter(60_000);
    counters.set(key, counter);
  }
  // 顺带淘汰：窗口内已无调用且不是本次的分桶（避免长跑进程无界增长）
  if (counters.size > 64) {
    for (const [k, c] of counters) {
      if (k !== key && getWindowCount(c, now) === 0) counters.delete(k);
    }
  }
  return counter;
}

/** 初始化/更新限流配置（支持配置热加载） */
export function initRateLimiter(config: Partial<RateLimitConfig> = {}): void {
  rateLimitConfig = { ...DEFAULT_RATE_LIMIT_CONFIG, ...config };
  counters = new Map();
}

/** 获取当前限流状态（供监控/测试使用）；不传 key 时返回全局分桶数与总值 */
export function getRateLimiterStatus(key?: string): {
  config: RateLimitConfig;
  currentToolCallCount: number;
  buckets: number;
} {
  const now = Date.now();
  if (key !== undefined) {
    const counter = counters.get(key);
    return {
      config: { ...rateLimitConfig },
      currentToolCallCount: counter ? getWindowCount(counter, now) : 0,
      buckets: counters.size,
    };
  }
  let total = 0;
  for (const counter of counters.values())
    total += getWindowCount(counter, now);
  return {
    config: { ...rateLimitConfig },
    currentToolCallCount: total,
    buckets: counters.size,
  };
}

/** 重置限流器状态（仅测试使用） */
export function resetRateLimiter(): void {
  rateLimitConfig = { ...DEFAULT_RATE_LIMIT_CONFIG };
  counters = new Map();
}

// ── 中间件定义 ──────────────────────────────────────────────────────

export const rateLimiterMiddleware: AgentMiddleware = {
  name: "RateLimiter",
  hook: "wrapToolCall",
  priority: 30,
  canShortCircuit: true,

  execute: async (
    ctx: MiddlewareContext,
    input: ToolCallInput,
    next: (input: ToolCallInput) => Promise<ToolCallOutput>,
  ) => {
    const now = Date.now();
    const key = rateLimitBucketKey(ctx.sessionId, ctx.agentId);
    const counter = counterFor(key, now);

    // 计算突发上限（burstAllowance × 基础限额）
    const effectiveMax = Math.floor(
      rateLimitConfig.maxToolCallsPerMinute * rateLimitConfig.burstAllowance,
    );

    recordControlTrigger("rate_limit_checked");

    // 检查限流（本回路窗口）
    const check = checkRateLimit(counter, effectiveMax, now);
    if (check.limited) {
      ctx.data["rateLimited"] = true;
      ctx.data["rateLimitRetryAfterMs"] = check.retryAfterMs;
      // P2-13：把退避建议写进给模型的提示，使 retryAfterMs 真正被消费（可行动反馈）
      const retrySec = Math.max(1, Math.ceil(check.retryAfterMs / 1000));
      return {
        status: "error",
        content: `[RateLimiter] 本回路工具调用频率超限（${effectiveMax}/分钟）。请在约 ${retrySec} 秒后重试，或合并/减少工具调用。`,
        recoverable: true,
      };
    }

    // 通过限流，增加计数
    incrementCounter(counter, now);
    ctx.data["rateLimitRemaining"] = check.remaining - 1;

    // 继续执行后续中间件/核心工具
    return next(input);
  },
};
