/**
 * @module http/rateLimit
 * @description 限流：**内存滑动窗口**（默认）与 **PostgreSQL 固定窗口**（多实例共享，SV-003）。
 *
 * 为什么需要共享存储：进程内计数在多实例部署下每个实例各算一份，
 * 实际阈值 = 配置 × 实例数（暴力破解防护被稀释）。本服务已依赖 PostgreSQL，
 * 因此用 PG 做共享计数，**无需引入 Redis**；若将来上 Redis，实现同一 `RateLimiter` 接口即可。
 *
 * 语义差异（已知且刻意）：
 *  - `createRateLimiter`（内存）：**滑动窗口**，按时间戳精确计数；
 *  - `createPostgresRateLimiter`（PG）：**固定窗口**（每 windowMs 重置一次），
 *    单条原子 UPSERT，多实例一致；跨窗口边界可能多放行一小段，属固定窗口的固有特性。
 */

import type { Db } from '../db/pool.js';
import { logger } from '../logger.js';

export interface RateLimitDecision {
  allowed: boolean;
  /** 窗口内已用次数（含本次） */
  used: number;
  limit: number;
  /** 建议的重试等待秒数（仅 allowed=false 时有意义） */
  retryAfterSec: number;
}

export interface RateLimiter {
  /**
   * 消费一次配额（**统一异步**）。
   *
   * 内存实现内部是同步计算，但接口保持 Promise：
   * 这样 PG 共享实现无需改变调用方签名（调用点均为 async hook）。
   */
  consume(key: string, limitPerMin: number, now?: number): Promise<RateLimitDecision>;
  /** 当前键的已用次数（测试/观测用） */
  peek(key: string, now?: number): Promise<number>;
  /** 清空（测试用） */
  reset(): Promise<void>;
  /** 停止内部清理定时器 */
  dispose(): void;
}

const WINDOW_MS = 60_000;

export function createRateLimiter(options: { cleanupIntervalMs?: number } = {}): RateLimiter {
  const buckets = new Map<string, number[]>();
  const cleanupIntervalMs = options.cleanupIntervalMs ?? 60_000;

  const prune = (key: string, now: number): number[] => {
    const hits = buckets.get(key) ?? [];
    const cutoff = now - WINDOW_MS;
    const fresh = hits.filter((t) => t > cutoff);
    if (fresh.length === 0) buckets.delete(key);
    else buckets.set(key, fresh);
    return fresh;
  };

  const timer =
    cleanupIntervalMs > 0
      ? setInterval(() => {
          const now = Date.now();
          for (const key of [...buckets.keys()]) prune(key, now);
        }, cleanupIntervalMs)
      : null;
  // 不阻止进程退出
  timer?.unref?.();

  return {
    async consume(key, limitPerMin, now = Date.now()): Promise<RateLimitDecision> {
      const hits = prune(key, now);
      if (hits.length >= limitPerMin) {
        const oldest = hits[0] ?? now;
        return {
          allowed: false,
          used: hits.length,
          limit: limitPerMin,
          retryAfterSec: Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1000)),
        };
      }
      hits.push(now);
      buckets.set(key, hits);
      return { allowed: true, used: hits.length, limit: limitPerMin, retryAfterSec: 0 };
    },
    async peek(key, now = Date.now()): Promise<number> {
      return prune(key, now).length;
    },
    async reset(): Promise<void> {
      buckets.clear();
    },
    dispose(): void {
      if (timer) clearInterval(timer);
      buckets.clear();
    },
  };
}

// ── PostgreSQL 共享计数（多实例安全，SV-003）──────────────────────────

export interface PostgresRateLimiterOptions {
  db: Db;
  /** 计数窗口（毫秒，默认 60s；与内存实现一致） */
  windowMs?: number;
  /** 过期桶清理间隔（毫秒，默认 10 分钟；0 表示不清理） */
  cleanupIntervalMs?: number;
}

/**
 * 基于 PostgreSQL 的限流器：多实例共享同一份计数。
 *
 * 并发安全依靠**单条原子 UPSERT**（无需事务/SELECT FOR UPDATE）：
 *  - 桶不存在 → 插入 (now, 1)；
 *  - 桶存在且窗口已过期 → 重置为 (now, 1)；
 *  - 桶存在且窗口内 → used + 1。
 *
 * 可用性：数据库查询失败时**回退到进程内内存限流**（仍然限流，只是退回单实例口径），
 * 并记录错误日志——避免"存储抖动导致全员被拒"或"完全不限流"两种极端。
 */
export function createPostgresRateLimiter(options: PostgresRateLimiterOptions): RateLimiter {
  const { db } = options;
  const windowMs = options.windowMs ?? 60_000;
  const cleanupIntervalMs = options.cleanupIntervalMs ?? 10 * 60_000;
  /** 数据库不可用时的兜底（仍然限流） */
  const fallback = createRateLimiter({ cleanupIntervalMs });

  const timer =
    cleanupIntervalMs > 0
      ? setInterval(() => {
          void db
            .execute(`DELETE FROM rate_limit_buckets WHERE window_start < now() - make_interval(secs => $1)`, [
              (windowMs / 1000) * 3,
            ])
            .catch((e: unknown) => {
              logger.warn('限流桶清理失败', {
                source: 'rateLimit', error: e instanceof Error ? e.message : String(e),
              });
            });
        }, cleanupIntervalMs)
      : null;
  timer?.unref?.();

  return {
    async consume(key, limitPerMin, now = Date.now()): Promise<RateLimitDecision> {
      try {
        const row = await db.one<{ used: number; window_start: Date }>(
          `INSERT INTO rate_limit_buckets (bucket_key, window_start, used)
           VALUES ($1, to_timestamp($2 / 1000.0), 1)
           ON CONFLICT (bucket_key) DO UPDATE SET
             used = CASE
               WHEN rate_limit_buckets.window_start <= to_timestamp($2 / 1000.0) - make_interval(secs => $3)
                 THEN 1
               ELSE rate_limit_buckets.used + 1
             END,
             window_start = CASE
               WHEN rate_limit_buckets.window_start <= to_timestamp($2 / 1000.0) - make_interval(secs => $3)
                 THEN to_timestamp($2 / 1000.0)
               ELSE rate_limit_buckets.window_start
             END
           RETURNING used, window_start`,
          [key, now, windowMs / 1000],
        );
        const used = row?.used ?? 1;
        if (used > limitPerMin) {
          const windowStart = row?.window_start ? new Date(row.window_start).getTime() : now;
          return {
            allowed: false,
            used,
            limit: limitPerMin,
            retryAfterSec: Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000)),
          };
        }
        return { allowed: true, used, limit: limitPerMin, retryAfterSec: 0 };
      } catch (e) {
        logger.error('限流共享存储不可用，回退到进程内限流', {
          source: 'rateLimit', key, error: e instanceof Error ? e.message : String(e),
        });
        return await fallback.consume(key, limitPerMin, now);
      }
    },

    async peek(key): Promise<number> {
      try {
        const row = await db.one<{ used: number }>(
          `SELECT used FROM rate_limit_buckets WHERE bucket_key = $1`, [key],
        );
        return row?.used ?? 0;
      } catch {
        return await fallback.peek(key);
      }
    },

    async reset(): Promise<void> {
      await db.execute('DELETE FROM rate_limit_buckets');
      fallback.reset();
    },

    dispose(): void {
      if (timer) clearInterval(timer);
      fallback.dispose();
    },
  };
}
