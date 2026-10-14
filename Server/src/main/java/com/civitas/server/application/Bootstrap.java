package com.civitas.server.application;

import com.civitas.server.config.ConfigLoader;
import com.civitas.server.config.ServerConfig;
import com.civitas.server.db.Db;
import com.civitas.server.http.MemoryRateLimiter;
import com.civitas.server.http.PostgresRateLimiter;
import com.civitas.server.http.RateLimiter;
import com.civitas.server.logging.JsonLogger;

/**
 * 启动引导：在 Spring 容器启动前完成“加载配置 → 连接数据库 → 构造限流器”。
 *
 * 失败即退出（fail-fast）：配置错误、数据库不可用都不会“半启动”——
 * 与 TS 版 `src/index.ts` 的行为一致。容器内的 Bean 从这里读取已就绪的实例
 * （见 InfrastructureConfiguration），避免 Spring 启动期再去碰外部资源。
 */
public final class Bootstrap {
    private static ServerConfig config;
    private static Db db;
    private static RateLimiter rateLimiter;

    private Bootstrap() {}

    public static synchronized void fromEnvironment() {
        ConfigLoader.LoadConfigResult result = ConfigLoader.loadConfig(ConfigLoader.readEnv());
        if (!result.ok() || result.config() == null) {
            System.err.println("✖ 配置校验失败，服务端拒绝启动：");
            for (String error : result.errors()) System.err.println("  - " + error);
            System.exit(1);
        }
        for (String warn : result.warnings()) System.err.println("⚠  " + warn);

        ServerConfig cfg = result.config();
        // 让服务层日志与配置级别一致（测试可在构建上下文前覆盖）
        JsonLogger.setLevel(cfg.logLevel());

        Db createdDb = Db.create(cfg.databaseUrl(), cfg.db());
        if (!createdDb.ping()) {
            System.err.println("✖ 数据库不可用，请检查 DATABASE_URL 或先启动数据库（docker compose up -d db）");
            createdDb.close();
            System.exit(1);
        }

        RateLimiter limiter = cfg.rateLimitStore() == ServerConfig.RateLimitStore.postgres
                ? new PostgresRateLimiter(createdDb)
                : new MemoryRateLimiter();

        install(cfg, createdDb, limiter);
    }

    /**
     * 直接装配（测试用）：把测试配置与测试库接入同一容器装配路径，
     * 避免测试另起一套 Spring 配置而与生产产生偏差。
     */
    public static synchronized void install(ServerConfig cfg, Db database, RateLimiter limiter) {
        JsonLogger.setLevel(cfg.logLevel());
        config = cfg;
        db = database;
        rateLimiter = limiter;
    }

    public static ServerConfig config() {
        if (config == null) throw new IllegalStateException("Bootstrap 未初始化：请先调用 fromEnvironment()");
        return config;
    }

    public static Db db() {
        if (db == null) throw new IllegalStateException("Bootstrap 未初始化：请先调用 fromEnvironment()");
        return db;
    }

    public static RateLimiter rateLimiter() {
        if (rateLimiter == null) throw new IllegalStateException("Bootstrap 未初始化：请先调用 fromEnvironment()");
        return rateLimiter;
    }
}
