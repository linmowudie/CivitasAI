package com.civitas.server.http;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * 进程内限流器（滑动窗口）—— 与 TS 版 `src/http/rateLimit.ts` 的 `createRateLimiter` 对位。
 *
 * 单机语义：按时间戳精确统计最近 60s 的请求数；多实例部署请改用
 * {@link PostgresRateLimiter}（本服务已依赖 PostgreSQL，无需引入 Redis）。
 */
public final class MemoryRateLimiter implements RateLimiter {
    private static final long WINDOW_MS = 60_000;

    private final Map<String, List<Long>> buckets = new HashMap<>();
    private ScheduledExecutorService pruneTimer;

    public MemoryRateLimiter() {
        this(60_000);
    }

    /**
     * @param cleanupIntervalMs 过期桶清理间隔（毫秒）；0 表示不启动清理定时器（测试用）
     */
    public MemoryRateLimiter(long cleanupIntervalMs) {
        if (cleanupIntervalMs > 0) {
            pruneTimer = Executors.newSingleThreadScheduledExecutor(runnable -> {
                Thread thread = new Thread(runnable, "civitas-rate-limit-prune");
                thread.setDaemon(true); // 不阻止进程退出
                return thread;
            });
            pruneTimer.scheduleWithFixedDelay(() -> {
                long now = System.currentTimeMillis();
                synchronized (buckets) {
                    for (String key : new ArrayList<>(buckets.keySet())) {
                        prune(key, now);
                    }
                }
            }, cleanupIntervalMs, cleanupIntervalMs, TimeUnit.MILLISECONDS);
        }
    }

    /** 剔除滑出窗口的旧记录；空桶删除 */
    private List<Long> prune(String key, long now) {
        List<Long> hits = buckets.get(key);
        if (hits == null) hits = new ArrayList<>();
        long cutoff = now - WINDOW_MS;
        hits.removeIf(timestamp -> timestamp <= cutoff);
        if (hits.isEmpty()) buckets.remove(key);
        else buckets.put(key, hits);
        return hits;
    }

    @Override
    public RateLimitDecision consume(String key, int limitPerMin) {
        return consume(key, limitPerMin, System.currentTimeMillis());
    }

    @Override
    public synchronized RateLimitDecision consume(String key, int limitPerMin, long now) {
        List<Long> hits = prune(key, now);
        if (hits.size() >= limitPerMin) {
            long oldest = hits.isEmpty() ? now : hits.get(0);
            return new RateLimitDecision(false, hits.size(), limitPerMin,
                    (int) Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1000.0)));
        }
        hits.add(now);
        buckets.put(key, hits);
        return new RateLimitDecision(true, hits.size(), limitPerMin, 0);
    }

    @Override
    public synchronized long peek(String key) {
        return prune(key, System.currentTimeMillis()).size();
    }

    @Override
    public synchronized void reset() {
        buckets.clear();
    }

    @Override
    public synchronized void dispose() {
        if (pruneTimer != null) {
            pruneTimer.shutdownNow();
            pruneTimer = null;
        }
        buckets.clear();
    }
}
