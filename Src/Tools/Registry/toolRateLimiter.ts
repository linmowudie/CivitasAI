/**
 * @module Tools/Registry/toolRateLimiter
 * @description
 * 工具级**每 Agent 限流**执行方（矩阵 cell `TOOL-SEC-RATE`）。
 *
 * 背景：`ToolSpec.rateLimitPerAgent` 长期只是声明字段，无任何执行方 —— 于是
 * "每 Agent 每分钟最多 N 次"既不生效也不报错（文档 §3.1 断链）。
 * 本模块是它的执行体：滑动窗口计数，超限即拒，并由调用方留痕。
 *
 * 设计约束：
 * - **进程内**计数（与既有 `circuitBreaker` / `dedupMiddleware` 同口径）；多实例部署需换共享存储。
 * - 只按 `agentId + toolName` 隔离：同一 Agent 的其它工具不受牵连，避免一个慢工具拖垮全部。
 * - 配置非法（max/windowMs ≤ 0 或非有限数）时**不误杀**，按放行处理（fail-open 仅限配置错误，
 *   运行期超限仍 fail-closed）。
 */

import type { RateLimit } from "../Traits/toolSpec.js";

interface Bucket {
  /** 窗口内每次放行的时间戳（升序） */
  timestamps: number[];
}

const buckets = new Map<string, Bucket>();

export interface RateGateResult {
  readonly ok: boolean;
  /** 被拒时：距离下一个可用槽位的毫秒数 */
  readonly retryAfterMs?: number;
  /** 当前窗口内已用次数（放行后的计数） */
  readonly used: number;
  readonly max: number;
}

const SEP = "\u0000";

/**
 * 尝试为一次工具调用占用一个限流槽位。
 *
 * @param now 注入时钟（测试用；默认 `Date.now()`）
 */
export function consumeToolRate(
  agentId: string,
  toolName: string,
  limit: RateLimit,
  now: number = Date.now(),
): RateGateResult {
  const max = limit.max;
  const windowMs = limit.windowMs;
  if (
    !Number.isFinite(max) ||
    max <= 0 ||
    !Number.isFinite(windowMs) ||
    windowMs <= 0
  ) {
    return { ok: true, used: 0, max: Number.isFinite(max) ? max : 0 };
  }

  const key = `${agentId}${SEP}${toolName}`;
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { timestamps: [] };
    buckets.set(key, bucket);
  }

  const cutoff = now - windowMs;
  bucket.timestamps = bucket.timestamps.filter((t) => t > cutoff);

  if (bucket.timestamps.length >= max) {
    const oldest = bucket.timestamps[0]!;
    return {
      ok: false,
      retryAfterMs: Math.max(0, oldest + windowMs - now),
      used: bucket.timestamps.length,
      max,
    };
  }

  bucket.timestamps.push(now);
  return { ok: true, used: bucket.timestamps.length, max };
}

/** 清空全部计数（测试用） */
export function resetToolRateLimiter(): void {
  buckets.clear();
}

/** 只读快照（诊断/测试用） */
export function getToolRateSnapshot(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, bucket] of buckets) {
    out[key.replace(SEP, "/")] = bucket.timestamps.length;
  }
  return out;
}
