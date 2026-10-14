package com.civitas.server.platform;

import com.civitas.server.config.ConfigLoader;
import com.civitas.server.config.ServerConfig;
import com.civitas.server.db.Db;
import com.civitas.server.db.MigrationRunner;
import com.civitas.server.helpers.ApiClient;
import com.civitas.server.helpers.IntegrationTest;
import com.civitas.server.helpers.TestApp;
import com.civitas.server.helpers.TestConfig;
import com.civitas.server.helpers.TestDb;
import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;

import java.nio.file.Path;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.Statement;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 平台基础行为：健康检查、安全响应头、404 兜底、请求体上限、限流、非法 JSON、迁移幂等/漂移。
 * 与 TS 版 `test/integration/platform.spec.ts` 对位。
 */
class PlatformBasicsTest extends IntegrationTest {

    /** 便捷构造请求体（键值交替） */
    private static Map<String, Object> map(Object... kv) {
        Map<String, Object> map = new LinkedHashMap<>();
        for (int i = 0; i < kv.length; i += 2) map.put((String) kv[i], kv[i + 1]);
        return map;
    }

    @Test
    void healthz_返回ok与运行时长_且带安全头_不限流() {
        ApiClient.ApiResponse response = client().get("/healthz", null);
        assertEquals(200, response.status());
        assertTrue(response.ok());
        JsonNode data = ApiClient.dataOf(response);
        assertEquals("ok", data.path("status").asText());
        assertTrue(data.path("uptimeSec").isNumber());

        // 安全响应头
        assertEquals("nosniff", response.header("X-Content-Type-Options"));
        assertEquals("DENY", response.header("X-Frame-Options"));
        assertEquals("no-referrer", response.header("Referrer-Policy"));
        assertEquals("no-store", response.header("Cache-Control"));
        // 探测端点不参与限流：无 X-RateLimit-* 头
        assertNull(response.header("X-RateLimit-Limit"));
        assertNull(response.header("X-RateLimit-Remaining"));
    }

    @Test
    void readyz_数据库可用时返回ready() {
        ApiClient.ApiResponse response = client().get("/readyz", null);
        assertEquals(200, response.status());
        JsonNode data = ApiClient.dataOf(response);
        assertEquals("ready", data.path("status").asText());
        assertEquals("up", data.path("db").asText());
    }

    @Test
    void 未知路径返回404接口不存在_且带限流头与安全头() {
        ApiClient.ApiResponse response = client().get("/v1/definitely-not-a-route", null);
        assertEquals(404, response.status());
        assertEquals("NOT_FOUND", response.errorCode());
        assertEquals("接口不存在", response.errorMessage());
        assertEquals("nosniff", response.header("X-Content-Type-Options"));
        assertNotNull(response.header("X-RateLimit-Limit"));
        assertNotNull(response.header("X-RateLimit-Remaining"));
    }

    @Test
    void 声明超限的请求体直接413() {
        String big = "x".repeat(1024 * 1024 + 1);
        ApiClient.ApiResponse response = client().post("/healthz", big, null);
        assertEquals(413, response.status());
        assertEquals("PAYLOAD_TOO_LARGE", response.errorCode());
        assertEquals("请求体过大", response.errorMessage());
    }

    @Test
    void 成功响应符合统一信封约定() {
        ApiClient.ApiResponse response = client().get("/healthz", null);
        assertNotNull(response.body());
        assertTrue(response.body().path("ok").asBoolean());
        assertTrue(response.body().has("data"));
        // Content-Type 与 TS 版一致（含 charset）
        String contentType = response.header("Content-Type");
        assertNotNull(contentType);
        assertTrue(contentType.startsWith("application/json"));
    }

    @Test
    void SV008_readyz数据库不可用返回503统一错误体() {
        // 指向不可达端口模拟数据库不可用（ping 恒失败；连接被拒绝即刻返回）
        Db downDb = Db.create("postgres://postgres@127.0.0.1:1/civitas_down",
                new ServerConfig.DbConfig(2, 1_000, 1_000, 5_000));
        try (TestApp down = TestApp.build(cfg(), downDb)) {
            ApiClient.ApiResponse res = down.client.get("/readyz", null);
            assertEquals(503, res.status());
            assertFalse(res.ok());
            assertEquals("UNAVAILABLE", res.errorCode());
            assertEquals("数据库不可用", res.errorMessage());
        } finally {
            downDb.close();
        }
    }

    @Test
    void 限流超过阈值返回429且带RetryAfter与XRateLimit头() {
        ServerConfig tight = TestConfig.withLimits(limits -> new ServerConfig.LimitsConfig(
                2, limits.apiPerMin(), limits.writePerMin(), limits.bodyLimitBytes(),
                limits.maxSettingsBytes(), limits.maxMemoriesPerBulk(), limits.maxStatsEventsPerBatch()));
        try (TestApp tightApp = TestApp.build(tight)) {
            Map<String, Object> credentials = map("email", "x@example.com", "password", "Passw0rd123");

            ApiClient.ApiResponse first = tightApp.client.post("/v1/auth/login", credentials, null);
            assertEquals(401, first.status()); // 未注册 → 凭证错误（已消耗一次配额）
            assertEquals("2", first.header("X-RateLimit-Limit"));

            assertEquals(401, tightApp.client.post("/v1/auth/login", credentials, null).status());

            ApiClient.ApiResponse third = tightApp.client.post("/v1/auth/login", credentials, null);
            assertEquals(429, third.status());
            assertEquals("RATE_LIMITED", third.errorCode());
            assertTrue(Integer.parseInt(third.header("Retry-After")) > 0);
        }
    }

    @Test
    void SV015_已鉴权写请求进入write桶_达上限返回429() {
        // 每用户写限流=2：验证 Java 版写限流真实生效（TS 版因钩子顺序为死代码，SV-015）
        ServerConfig tight = TestConfig.withLimits(limits -> new ServerConfig.LimitsConfig(
                limits.authPerMin(), limits.apiPerMin(), 2, limits.bodyLimitBytes(),
                limits.maxSettingsBytes(), limits.maxMemoriesPerBulk(), limits.maxStatsEventsPerBatch()));
        try (TestApp tightApp = TestApp.build(tight)) {
            ApiClient.AuthedUser user = tightApp.client.register("write-bucket@example.com");

            for (int i = 0; i < 2; i++) {
                ApiClient.ApiResponse write = tightApp.client.delete("/v1/stats/events", user.accessToken());
                assertEquals(200, write.status(), "第 " + (i + 1) + " 次写入不应被限流");
            }
            ApiClient.ApiResponse third = tightApp.client.delete("/v1/stats/events", user.accessToken());
            assertEquals(429, third.status());
            assertEquals("RATE_LIMITED", third.errorCode());
            assertEquals("写入过于频繁，请稍后再试", third.errorMessage());
            assertTrue(Integer.parseInt(third.header("Retry-After")) > 0);

            // 未鉴权请求不占 write 桶（401 由鉴权守卫给出，非 429）
            ApiClient.ApiResponse anonymous = tightApp.client.delete("/v1/stats/events", null);
            assertEquals(401, anonymous.status());
        }
    }

    @Test
    void 请求体不是合法JSON返回400统一错误体() {
        ApiClient.ApiResponse res = client().postRaw("/v1/auth/login", "{not-json", null, "application/json");
        assertEquals(400, res.status());
        assertFalse(res.ok());
        assertEquals("VALIDATION_ERROR", res.errorCode());
    }

    @Test
    void 迁移幂等_重复执行不报错且已应用记录不变() throws Exception {
        Path dir = ConfigLoader.serverRoot().resolve("migrations");
        try (Connection connection = MigrationRunner.open(TestDb.TEST_DATABASE_URL)) {
            List<MigrationRunner.AppliedMigration> before = MigrationRunner.listApplied(connection);
            MigrationRunner.MigrateResult result = MigrationRunner.runMigrations(connection, dir, false);
            List<MigrationRunner.AppliedMigration> after = MigrationRunner.listApplied(connection);
            assertTrue(result.alreadyUpToDate());
            assertEquals(List.of(), result.applied());
            assertEquals(before.size(), after.size());
            assertTrue(MigrationRunner.loadMigrations(dir).size() >= 1);
        }
    }

    @Test
    void 迁移漂移检测_已应用迁移内容被改动时拒绝执行() throws Exception {
        Path dir = ConfigLoader.serverRoot().resolve("migrations");
        try (Connection connection = MigrationRunner.open(TestDb.TEST_DATABASE_URL)) {
            // 伪造一条“已应用”记录，checksum 与真实文件不一致
            try (Statement statement = connection.createStatement()) {
                statement.execute("INSERT INTO schema_migrations (version, name, checksum) "
                        + "VALUES ('999', '999_fake.sql', 'deadbeef') "
                        + "ON CONFLICT (version) DO UPDATE SET checksum = 'deadbeef'");
            }
            MigrationRunner.MigrationFile target = MigrationRunner.loadMigrations(dir).get(0);
            try {
                // 999 不在文件集中 → 只做漂移检查，不应抛错
                MigrationRunner.runMigrations(connection, dir, false);

                // 现在伪造一个真实存在但 checksum 不符的版本 → 必须抛错
                try (PreparedStatement statement = connection.prepareStatement(
                        "UPDATE schema_migrations SET checksum = 'tampered' WHERE version = ?")) {
                    statement.setString(1, target.version());
                    statement.executeUpdate();
                }
                IllegalStateException error = assertThrows(IllegalStateException.class,
                        () -> MigrationRunner.runMigrations(connection, dir, false));
                assertTrue(error.getMessage().contains("checksum 不一致"));
            } finally {
                // 复原，避免影响其它用例；并清除伪造行（否则 migrate --status 会显示假象，SV-006）
                try (PreparedStatement statement = connection.prepareStatement(
                        "UPDATE schema_migrations SET checksum = ? WHERE version = ?")) {
                    statement.setString(1, target.checksum());
                    statement.setString(2, target.version());
                    statement.executeUpdate();
                }
                try (Statement statement = connection.createStatement()) {
                    statement.execute("DELETE FROM schema_migrations WHERE version = '999'");
                }
            }
        }
    }
}
