package com.civitas.server.helpers;

import com.civitas.server.CivitasServerApplication;
import com.civitas.server.application.Bootstrap;
import com.civitas.server.config.ServerConfig;
import com.civitas.server.db.Db;
import com.civitas.server.http.MemoryRateLimiter;
import com.civitas.server.http.PostgresRateLimiter;
import com.civitas.server.http.RateLimiter;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.web.servlet.context.ServletWebServerApplicationContext;
import org.springframework.context.ConfigurableApplicationContext;

import java.util.Map;

/**
 * 测试用应用构建 —— 与 TS 版 `test/helpers/app.ts` 的 buildTestApp 对位。
 *
 * 走真实 Spring 装配（CivitasServerApplication + InfrastructureConfiguration），
 * 监听 127.0.0.1 随机端口；请求经 ApiClient 走真实 HTTP。
 */
public final class TestApp implements AutoCloseable {
    public final ConfigurableApplicationContext context;
    public final int port;
    public final RateLimiter rateLimiter;
    public final ServerConfig cfg;
    public final ApiClient client;

    private TestApp(ConfigurableApplicationContext context, int port, RateLimiter rateLimiter, ServerConfig cfg) {
        this.context = context;
        this.port = port;
        this.rateLimiter = rateLimiter;
        this.cfg = cfg;
        this.client = new ApiClient(port);
    }

    public static TestApp build(ServerConfig cfg) {
        return build(cfg, TestDb.getTestDb());
    }

    public static TestApp build(ServerConfig cfg, Db db) {
        // 仅“进程内限流”注入测试限流器；配置为 postgres（共享计数，SV-003）时
        // 走真实 PG 路径，避免测试覆盖生产分支
        RateLimiter limiter = cfg.rateLimitStore() == ServerConfig.RateLimitStore.postgres
                ? new PostgresRateLimiter(db)
                : new MemoryRateLimiter(0);
        Bootstrap.install(cfg, db, limiter);

        SpringApplication application = new SpringApplication(CivitasServerApplication.class);
        application.setDefaultProperties(Map.of(
                "server.address", "127.0.0.1",
                "server.port", "0"));
        ConfigurableApplicationContext context = application.run();
        int port = ((ServletWebServerApplicationContext) context).getWebServer().getPort();
        return new TestApp(context, port, limiter, cfg);
    }

    public static TestApp build() {
        return build(TestConfig.testConfig());
    }

    @Override
    public void close() {
        context.close();
        rateLimiter.dispose();
    }
}
