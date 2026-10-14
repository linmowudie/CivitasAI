package com.civitas.server.application;

import com.civitas.server.db.Db;
import com.civitas.server.http.RateLimiter;
import com.civitas.server.logging.JsonLogger;
import org.springframework.beans.factory.DisposableBean;

import java.util.Map;

/**
 * 优雅退出清理 —— 与 TS 版 `src/index.ts` 的 shutdown() 对位。
 *
 * 仅在真实启动时注册（测试上下文不注册，避免误关共享资源）。
 * Spring 优雅关闭先停止对外服务，随后触发本清理：限流器定时器 → 连接池。
 */
public class ShutdownCleanup implements DisposableBean {
    private final RateLimiter rateLimiter;
    private final Db db;

    public ShutdownCleanup(RateLimiter rateLimiter, Db db) {
        this.rateLimiter = rateLimiter;
        this.db = db;
    }

    @Override
    public void destroy() {
        JsonLogger.info("正在优雅关闭", Map.of());
        try {
            rateLimiter.dispose();
        } finally {
            db.close();
        }
    }
}
