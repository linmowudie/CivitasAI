package com.civitas.server.integration;

import com.civitas.server.config.ServerConfig;
import com.civitas.server.db.Db;
import com.civitas.server.helpers.ApiClient;
import com.civitas.server.helpers.IntegrationTest;
import com.civitas.server.helpers.TestApp;
import com.civitas.server.helpers.TestConfig;
import com.civitas.server.helpers.TestDb;
import com.civitas.server.http.PostgresRateLimiter;
import com.civitas.server.http.RateLimitDecision;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 限流共享存储（SV-003）：多实例部署时阈值不再 ×N。
 * 与 TS 版 `test/integration/rateLimitStore.spec.ts` 对位。
 *
 * 覆盖：
 *  - 两个限流器实例（模拟两个进程）共享同一份计数；
 *  - 超限拒绝并给出重试秒数（固定窗口）；
 *  - 窗口滚动后计数重置；
 *  - 存储不可用时回退到进程内限流（仍然限流，不放开）；
 *  - 应用级：`RATE_LIMIT_STORE=postgres` 时 HTTP 429 由共享计数决定。
 */
class RateLimitStoreIntegrationTest extends IntegrationTest {

    /** 便捷构造请求体（键值交替） */
    private static Map<String, Object> map(Object... kv) {
        Map<String, Object> map = new LinkedHashMap<>();
        for (int i = 0; i < kv.length; i += 2) map.put((String) kv[i], kv[i + 1]);
        return map;
    }

    @BeforeEach
    void clearRateLimitBuckets() {
        TestDb.getTestDb().execute("DELETE FROM rate_limit_buckets");
    }

    @Test
    void SV003_两个实例共享同一计数() {
        // 两个 limiter = 模拟两个服务端进程（各自内存独立，只共享 PG）
        PostgresRateLimiter instanceA = new PostgresRateLimiter(TestDb.getTestDb(), 60_000, 0);
        PostgresRateLimiter instanceB = new PostgresRateLimiter(TestDb.getTestDb(), 60_000, 0);
        try {
            // 实例 A 消耗 3 次
            for (int i = 0; i < 3; i++) {
                RateLimitDecision decision = instanceA.consume("auth:1.2.3.4", 5);
                assertTrue(decision.allowed());
                assertEquals(i + 1, decision.used());
            }

            // 实例 B 看到的计数应包含 A 的消耗（共享）
            RateLimitDecision b1 = instanceB.consume("auth:1.2.3.4", 5);
            assertEquals(4, b1.used());
            RateLimitDecision b2 = instanceB.consume("auth:1.2.3.4", 5);
            assertEquals(5, b2.used());
            assertTrue(b2.allowed());

            // 第 6 次（跨实例）→ 超限
            RateLimitDecision denied = instanceA.consume("auth:1.2.3.4", 5);
            assertFalse(denied.allowed());
            assertEquals(6, denied.used());
            assertTrue(denied.retryAfterSec() > 0);
        } finally {
            instanceA.dispose();
            instanceB.dispose();
        }
    }

    @Test
    void 不同键互不影响() {
        PostgresRateLimiter limiter = new PostgresRateLimiter(TestDb.getTestDb(), 60_000, 0);
        try {
            assertTrue(limiter.consume("auth:10.0.0.1", 1).allowed());
            assertTrue(limiter.consume("auth:10.0.0.2", 1).allowed());
            assertFalse(limiter.consume("auth:10.0.0.1", 1).allowed());
        } finally {
            limiter.dispose();
        }
    }

    @Test
    void 窗口滚动后计数重置_固定窗口() {
        PostgresRateLimiter limiter = new PostgresRateLimiter(TestDb.getTestDb(), 60_000, 0);
        try {
            assertTrue(limiter.consume("api:9.9.9.9", 2).allowed());
            assertTrue(limiter.consume("api:9.9.9.9", 2).allowed());
            assertFalse(limiter.consume("api:9.9.9.9", 2).allowed());

            // 人为把窗口起点拨回 2 分钟前 → 下一次消费应重置计数
            TestDb.getTestDb().execute(
                    "UPDATE rate_limit_buckets SET window_start = now() - interval '2 minutes' WHERE bucket_key = $1",
                    "api:9.9.9.9");
            RateLimitDecision after = limiter.consume("api:9.9.9.9", 2);
            assertTrue(after.allowed());
            assertEquals(1, after.used());
        } finally {
            limiter.dispose();
        }
    }

    @Test
    void peek反映共享计数() {
        PostgresRateLimiter limiter = new PostgresRateLimiter(TestDb.getTestDb(), 60_000, 0);
        try {
            limiter.consume("write:user-1", 10);
            limiter.consume("write:user-1", 10);
            assertEquals(2, limiter.peek("write:user-1"));
        } finally {
            limiter.dispose();
        }
    }

    @Test
    void 存储不可用时回退到进程内限流_不放开限流() {
        // 指向不可达端口模拟存储故障（查询/写入均失败 → 走内存兜底）
        Db brokenDb = Db.create("postgres://postgres@127.0.0.1:1/civitas_broken",
                new ServerConfig.DbConfig(2, 1_000, 1_000, 5_000));
        try {
            PostgresRateLimiter limiter = new PostgresRateLimiter(brokenDb, 60_000, 0);
            try {
                // 限流仍然生效（回退到内存计数）
                assertTrue(limiter.consume("auth:1.1.1.1", 2).allowed());
                assertTrue(limiter.consume("auth:1.1.1.1", 2).allowed());
                assertFalse(limiter.consume("auth:1.1.1.1", 2).allowed());
            } finally {
                limiter.dispose();
            }
        } finally {
            brokenDb.close();
        }
    }

    @Test
    void 应用级_postgres存储时429由共享计数决定_且写入桶表() {
        ServerConfig base = TestConfig.withRateLimitStore(ServerConfig.RateLimitStore.postgres);
        ServerConfig postgresCfg = new ServerConfig(
                base.env(), base.host(), base.port(), base.databaseUrl(), base.db(),
                base.auth(), base.mail(),
                new ServerConfig.LimitsConfig(3, 3, base.limits().writePerMin(),
                        base.limits().bodyLimitBytes(), base.limits().maxSettingsBytes(),
                        base.limits().maxMemoriesPerBulk(), base.limits().maxStatsEventsPerBatch()),
                base.rateLimitStore(), base.corsOrigins(), base.logLevel(), base.statsTimezone(), base.trustProxy());
        try (TestApp postgresApp = TestApp.build(postgresCfg)) {
            // /v1/auth/* 走 auth 桶（limit=3）
            List<Integer> codes = new ArrayList<>();
            for (int i = 0; i < 4; i++) {
                codes.add(postgresApp.client.post("/v1/auth/login",
                        map("email", "nobody@example.com", "password", "Passw0rd123"), null).status());
            }
            for (int i = 0; i < 3; i++) assertFalse(codes.get(i) == 429, "前 3 次不应 429");
            assertEquals(429, codes.get(3));

            // 计数确实落在共享表里（多实例可见）
            List<Map<String, Object>> rows = TestDb.getTestDb().query(
                    "SELECT bucket_key, used FROM rate_limit_buckets WHERE bucket_key LIKE 'auth:%'");
            assertTrue(rows.size() > 0);
            assertTrue(Db.longOf(rows.get(0), "used") >= 4);
        }
    }
}
