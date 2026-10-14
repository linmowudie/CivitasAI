package com.civitas.server.http;

import com.civitas.server.db.Db;
import com.civitas.server.logging.JsonLogger;

import java.time.Instant;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * 基于 PostgreSQL 的限流器：多实例共享同一份计数（SV-003）—— 与 TS 版
 * `src/http/rateLimit.ts` 的 `createPostgresRateLimiter` 对位。
 *
 * 并发安全依靠**单条原子 UPSERT**（无需事务/SELECT FOR UPDATE）：
 *  - 桶不存在 → 插入 (now, 1)；
 *  - 桶存在且窗口已过期 → 重置为 (now, 1)；
 *  - 桶存在且窗口内 → used + 1。
 *
 * 可用性：数据库查询失败时**回退到进程内内存限流**（仍然限流，只是退回单实例口径），
 * 并记录错误日志——避免“存储抖动导致全员被拒”或“完全不限流”两种极端。
 */
public final class PostgresRateLimiter implements RateLimiter {
    private final Db db;
    private final long windowMs;
    /** 数据库不可用时的兜底（仍然限流） */
    private final MemoryRateLimiter fallback = new MemoryRateLimiter(0);

    private ScheduledExecutorService cleanupTimer;

    public PostgresRateLimiter(Db db) {
        this(db, 60_000, 10 * 60_000);
    }

    /**
     * @param windowMs          计数窗口（毫秒，默认 60s；与内存实现一致）
     * @param cleanupIntervalMs 过期桶清理间隔（毫秒，默认 10 分钟；0 表示不清理）
     */
    public PostgresRateLimiter(Db db, long windowMs, long cleanupIntervalMs) {
        this.db = db;
        this.windowMs = windowMs;
        if (cleanupIntervalMs > 0) {
            cleanupTimer = Executors.newSingleThreadScheduledExecutor(runnable -> {
                Thread thread = new Thread(runnable, "civitas-rate-limit-cleanup");
                thread.setDaemon(true); // 不阻止进程退出
                return thread;
            });
            cleanupTimer.scheduleWithFixedDelay(() -> {
                try {
                    db.execute(
                            "DELETE FROM rate_limit_buckets WHERE window_start < now() - make_interval(secs => ?)",
                            (double) (windowMs / 1000) * 3);
                } catch (Exception e) {
                    JsonLogger.warn("限流桶清理失败", Map.of(
                            "source", "rateLimit",
                            "error", e instanceof RuntimeException runtime && runtime.getMessage() != null
                                    ? runtime.getMessage() : e));
                }
            }, cleanupIntervalMs, cleanupIntervalMs, TimeUnit.MILLISECONDS);
        }
    }

    @Override
    public RateLimitDecision consume(String key, int limitPerMin) {
        return consume(key, limitPerMin, System.currentTimeMillis());
    }

    @Override
    public RateLimitDecision consume(String key, int limitPerMin, long now) {
        try {
            Map<String, Object> row = db.one(
                    """
                    INSERT INTO rate_limit_buckets (bucket_key, window_start, used)
                    VALUES (?, to_timestamp(? / 1000.0), 1)
                    ON CONFLICT (bucket_key) DO UPDATE SET
                      used = CASE
                        WHEN rate_limit_buckets.window_start <= to_timestamp(? / 1000.0) - make_interval(secs => ?)
                          THEN 1
                        ELSE rate_limit_buckets.used + 1
                      END,
                      window_start = CASE
                        WHEN rate_limit_buckets.window_start <= to_timestamp(? / 1000.0) - make_interval(secs => ?)
                          THEN to_timestamp(? / 1000.0)
                        ELSE rate_limit_buckets.window_start
                      END
                    RETURNING used, window_start
                    """,
                    key, (double) now, (double) now, windowMs / 1000.0, (double) now, windowMs / 1000.0, (double) now);
            long used = row == null || row.get("used") == null ? 1L : ((Number) row.get("used")).longValue();
            if (used > limitPerMin) {
                Instant windowStart = row == null ? null : Db.instantOf(row, "window_start");
                long startMillis = windowStart != null ? windowStart.toEpochMilli() : now;
                return new RateLimitDecision(false, (int) used, limitPerMin,
                        (int) Math.max(1, Math.ceil((startMillis + windowMs - now) / 1000.0)));
            }
            return new RateLimitDecision(true, (int) used, limitPerMin, 0);
        } catch (Exception e) {
            JsonLogger.error("限流共享存储不可用，回退到进程内限流", Map.of(
                    "source", "rateLimit", "key", key,
                    "error", e.getMessage() != null ? e.getMessage() : e));
            return fallback.consume(key, limitPerMin, now);
        }
    }

    @Override
    public long peek(String key) {
        try {
            Map<String, Object> row = db.one(
                    "SELECT used FROM rate_limit_buckets WHERE bucket_key = ?", key);
            return row == null || row.get("used") == null ? 0L : ((Number) row.get("used")).longValue();
        } catch (Exception e) {
            return fallback.peek(key);
        }
    }

    @Override
    public void reset() {
        db.execute("DELETE FROM rate_limit_buckets");
        fallback.reset();
    }

    @Override
    public void dispose() {
        if (cleanupTimer != null) {
            cleanupTimer.shutdownNow();
            cleanupTimer = null;
        }
        fallback.dispose();
    }
}
