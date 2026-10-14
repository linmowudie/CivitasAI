package com.civitas.server.helpers;

import com.civitas.server.config.ServerConfig;
import com.civitas.server.config.ServerConfig.AuthConfig;
import com.civitas.server.config.ServerConfig.DbConfig;
import com.civitas.server.config.ServerConfig.Env;
import com.civitas.server.config.ServerConfig.LimitsConfig;
import com.civitas.server.config.ServerConfig.MailConfig;
import com.civitas.server.config.ServerConfig.RateLimitStore;

import java.util.List;
import java.util.function.UnaryOperator;

/**
 * 测试配置 —— 与 TS 版 `test/helpers/app.ts` 的 testConfig() 对位。
 *
 * 短时效、宽松限流（需要严格限流的用例自行注入限流器）。
 */
public final class TestConfig {
    private TestConfig() {}

    public static ServerConfig testConfig() {
        return new ServerConfig(
                Env.test,
                "127.0.0.1",
                0,
                "postgres://unused",
                new DbConfig(5, 1_000, 1_000, 10_000),
                new AuthConfig(
                        "test-secret-test-secret-test-secret-1234",
                        900,
                        30,
                        false,
                        ServerConfig.DeviceBindingMode.warn,
                        // 测试默认开启：便于断言验证码流程（生产会被 config 拒绝）
                        true,
                        300,
                        3,
                        600,
                        0,
                        5),
                new MailConfig("", "Civitas Test <no-reply@test.local>", 2_000),
                new LimitsConfig(
                        10_000, 10_000, 10_000,
                        1024 * 1024,
                        4096,
                        100,
                        50),
                // 测试默认进程内限流（PG 共享计数见 rateLimitStore 相关用例）
                RateLimitStore.memory,
                List.of(),
                "silent",
                "Asia/Shanghai",
                false);
    }

    /** 以 testConfig 为基底，替换 auth 段 */
    public static ServerConfig withAuth(UnaryOperator<AuthConfig> override) {
        ServerConfig base = testConfig();
        return new ServerConfig(base.env(), base.host(), base.port(), base.databaseUrl(), base.db(),
                override.apply(base.auth()), base.mail(), base.limits(), base.rateLimitStore(),
                base.corsOrigins(), base.logLevel(), base.statsTimezone(), base.trustProxy());
    }

    /** 以 testConfig 为基底，替换 limits 段 */
    public static ServerConfig withLimits(UnaryOperator<LimitsConfig> override) {
        ServerConfig base = testConfig();
        return new ServerConfig(base.env(), base.host(), base.port(), base.databaseUrl(), base.db(),
                base.auth(), base.mail(), override.apply(base.limits()), base.rateLimitStore(),
                base.corsOrigins(), base.logLevel(), base.statsTimezone(), base.trustProxy());
    }

    /** 以 testConfig 为基底，替换限流存储（postgres 走共享计数真实路径） */
    public static ServerConfig withRateLimitStore(RateLimitStore store) {
        ServerConfig base = testConfig();
        return new ServerConfig(base.env(), base.host(), base.port(), base.databaseUrl(), base.db(),
                base.auth(), base.mail(), base.limits(), store,
                base.corsOrigins(), base.logLevel(), base.statsTimezone(), base.trustProxy());
    }

    /** 以 testConfig 为基底，替换信任代理开关 */
    public static ServerConfig withTrustProxy(boolean trustProxy) {
        ServerConfig base = testConfig();
        return new ServerConfig(base.env(), base.host(), base.port(), base.databaseUrl(), base.db(),
                base.auth(), base.mail(), base.limits(), base.rateLimitStore(),
                base.corsOrigins(), base.logLevel(), base.statsTimezone(), trustProxy);
    }

    /** 以 testConfig 为基底，替换 CORS 来源 */
    public static ServerConfig withCorsOrigins(List<String> origins) {
        ServerConfig base = testConfig();
        return new ServerConfig(base.env(), base.host(), base.port(), base.databaseUrl(), base.db(),
                base.auth(), base.mail(), base.limits(), base.rateLimitStore(),
                origins, base.logLevel(), base.statsTimezone(), base.trustProxy());
    }

    /** 以 testConfig 为基底，替换邮件通道 */
    public static ServerConfig withMail(UnaryOperator<MailConfig> override) {
        ServerConfig base = testConfig();
        return new ServerConfig(base.env(), base.host(), base.port(), base.databaseUrl(), base.db(),
                base.auth(), override.apply(base.mail()), base.limits(), base.rateLimitStore(),
                base.corsOrigins(), base.logLevel(), base.statsTimezone(), base.trustProxy());
    }
}
