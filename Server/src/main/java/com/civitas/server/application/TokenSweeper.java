package com.civitas.server.application;

import com.civitas.server.db.Db;
import com.civitas.server.logging.JsonLogger;
import com.civitas.server.repositories.RefreshTokensRepository;
import org.springframework.beans.factory.DisposableBean;

import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * 历史刷新令牌定期清理（SV-004）—— 与 TS 版 `src/index.ts` 的 `sweepTokens` 对位：
 * 启动即扫一次，此后每 6 小时一次；失败不阻断服务。
 *
 * 定时线程为守护线程（≈ Node 定时器 `unref()`：不阻止进程自然退出）；
 * 仅真实启动时注册（测试上下文不注册，与 ShutdownCleanup 同条件）。
 */
public class TokenSweeper implements DisposableBean {
    /** 历史刷新令牌保留天数：已吊销/已过期且签发超过该天数的记录会被清理 */
    private static final int TOKEN_RETENTION_DAYS = 60;
    /** 令牌清理间隔：6 小时 */
    private static final long TOKEN_PURGE_INTERVAL_MS = 6L * 60 * 60 * 1_000;

    private final Db db;
    private final ScheduledExecutorService executor;

    public TokenSweeper(Db db) {
        this.db = db;
        this.executor = Executors.newSingleThreadScheduledExecutor(runnable -> {
            Thread thread = new Thread(runnable, "civitas-token-sweeper");
            thread.setDaemon(true);
            return thread;
        });
        // initialDelay=0：启动即扫（异步，不阻塞启动流程）
        executor.scheduleWithFixedDelay(this::sweep, 0, TOKEN_PURGE_INTERVAL_MS, TimeUnit.MILLISECONDS);
    }

    private void sweep() {
        try {
            int purged = RefreshTokensRepository.purgeInactive(db, TOKEN_RETENTION_DAYS);
            if (purged > 0) {
                JsonLogger.info("已清理历史刷新令牌",
                        Map.of("purged", purged, "olderThanDays", TOKEN_RETENTION_DAYS));
            }
        } catch (RuntimeException e) {
            JsonLogger.warn("历史刷新令牌清理失败（不影响服务）",
                    Map.of("err", e.getMessage() == null ? e.toString() : e.getMessage()));
        }
    }

    @Override
    public void destroy() {
        executor.shutdownNow();
    }
}
