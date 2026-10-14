package com.civitas.server.integration;

import com.civitas.server.db.Db;
import com.civitas.server.helpers.ApiClient;
import com.civitas.server.helpers.ApiClient.ApiResponse;
import com.civitas.server.helpers.ApiClient.AuthedUser;
import com.civitas.server.helpers.IntegrationTest;
import com.civitas.server.helpers.TestDb;
import com.civitas.server.repositories.RefreshTokensRepository;
import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 集成测试：账户体系 —— 与 TS 版 `test/integration/auth.spec.ts` 对位。
 *
 * 注册 / 登录 / 刷新轮换与重用检测 / 改密 / 登出 / 设备 / 审计 / 注销。
 */
class AuthIntegrationTest extends IntegrationTest {

    private Db db() {
        return TestDb.getTestDb();
    }

    /** 便捷构造请求体（键值交替） */
    private static Map<String, Object> map(Object... kv) {
        Map<String, Object> map = new LinkedHashMap<>();
        for (int i = 0; i < kv.length; i += 2) map.put((String) kv[i], kv[i + 1]);
        return map;
    }

    private static AuthedUser authedOf(ApiResponse res) {
        return new AuthedUser(ApiClient.dataOf(res).path("user"), ApiClient.dataOf(res).path("tokens"));
    }

    // ── 注册 ────────────────────────────────────────────────────────────

    @Test
    void 注册成功返回201与令牌_且密码以argon2id存储() {
        ApiResponse res = client().post("/v1/auth/register", map(
                "email", "Alice@Example.com",
                "password", "Passw0rd123",
                "displayName", "爱丽丝"), null);
        assertEquals(201, res.status());
        var data = ApiClient.dataOf(res);
        assertEquals("alice@example.com", data.path("user").path("email").asText()); // 规范化
        assertEquals("爱丽丝", data.path("user").path("displayName").asText());
        assertEquals(3, data.path("tokens").path("accessToken").asText().split("\\.").length);
        assertTrue(data.path("tokens").path("refreshToken").asText().length() > 20);

        Map<String, Object> row = db().one("SELECT password_hash, email_lower FROM users");
        assertNotNull(row);
        assertTrue(Db.str(row, "password_hash").startsWith("$argon2id$"));
        assertFalse(Db.str(row, "password_hash").contains("Passw0rd123"));
        assertEquals("alice@example.com", Db.str(row, "email_lower"));
    }

    @Test
    void 重复邮箱注册409_弱密码400() {
        client().register("dup@example.com");
        ApiResponse dup = client().post("/v1/auth/register", map(
                "email", "dup@example.com", "password", "Passw0rd123"), null);
        assertEquals(409, dup.status());
        assertEquals("CONFLICT", dup.errorCode());

        ApiResponse weak = client().post("/v1/auth/register", map(
                "email", "weak@example.com", "password", "short"), null);
        assertEquals(400, weak.status());
        assertEquals("VALIDATION_ERROR", weak.errorCode());
    }

    // ── 登录 ────────────────────────────────────────────────────────────

    @Test
    void 登录_密码错误与邮箱不存在返回同一错误_不泄露账号是否存在() {
        client().register("bob@example.com");

        ApiResponse badPassword = client().login("bob@example.com", "WrongPass123");
        assertEquals(401, badPassword.status());
        assertEquals("INVALID_CREDENTIALS", badPassword.errorCode());

        ApiResponse noUser = client().login("nobody@example.com", "Passw0rd123");
        assertEquals(401, noUser.status());
        assertEquals("INVALID_CREDENTIALS", noUser.errorCode());
        assertEquals(badPassword.errorMessage(), noUser.errorMessage());
    }

    @Test
    void 访问受保护接口_无令牌坏令牌401_正常令牌200() {
        AuthedUser user = client().register("carol@example.com");

        assertEquals(401, client().get("/v1/me", null).status());
        assertEquals(401, client().get("/v1/me", "not-a-jwt").status());

        ApiResponse me = client().get("/v1/me", user.accessToken());
        assertEquals(200, me.status());
        assertEquals("carol@example.com", ApiClient.dataOf(me).path("email").asText());
    }

    // ── 刷新轮换 ────────────────────────────────────────────────────────

    @Test
    void 刷新令牌会轮换_新令牌可用_旧令牌再用TOKEN_REUSED且整族失效() {
        AuthedUser user = client().register("dave@example.com");

        ApiResponse first = client().post("/v1/auth/refresh",
                map("refreshToken", user.refreshToken()), null);
        assertEquals(200, first.status());
        AuthedUser rotated = authedOf(first);
        assertNotEquals(user.refreshToken(), rotated.refreshToken());

        // 正常路径：新令牌可继续刷新
        ApiResponse second = client().post("/v1/auth/refresh",
                map("refreshToken", rotated.refreshToken()), null);
        assertEquals(200, second.status());
        AuthedUser latest = authedOf(second);

        // 盗用检测：已轮换掉的旧令牌再次使用
        ApiResponse reuse = client().post("/v1/auth/refresh",
                map("refreshToken", user.refreshToken()), null);
        assertEquals(401, reuse.status());
        assertEquals("TOKEN_REUSED", reuse.errorCode());

        // 整族已被吊销：连最新的令牌也失效
        ApiResponse afterFamilyRevoke = client().post("/v1/auth/refresh",
                map("refreshToken", latest.refreshToken()), null);
        assertEquals(401, afterFamilyRevoke.status());
        assertEquals("TOKEN_REUSED", afterFamilyRevoke.errorCode());

        Map<String, Object> audit = db().one(
                "SELECT COUNT(*)::int AS count FROM audit_log WHERE action = 'auth.refresh' AND outcome = 'failure'");
        assertTrue(Db.longOf(audit, "count") >= 1);
    }

    @Test
    void 伪造未知刷新令牌401_UNAUTHENTICATED() {
        ApiResponse res = client().post("/v1/auth/refresh",
                map("refreshToken", "x".repeat(43)), null);
        assertEquals(401, res.status());
        assertEquals("UNAUTHENTICATED", res.errorCode());
    }

    // ── 改密 ────────────────────────────────────────────────────────────

    @Test
    void 改密_旧密码校验_新密码生效_其他会话被吊销并换发新令牌() {
        AuthedUser user = client().register("erin@example.com");
        // 第二个设备登录
        AuthedUser secondDevice = authedOf(client().login("erin@example.com"));

        ApiResponse wrongCurrent = client().post("/v1/auth/change-password", map(
                "currentPassword", "WrongPass123", "newPassword", "NewPassw0rd1"), user.accessToken());
        assertEquals(401, wrongCurrent.status());
        assertEquals("INVALID_CREDENTIALS", wrongCurrent.errorCode());

        ApiResponse samePassword = client().post("/v1/auth/change-password", map(
                "currentPassword", "Passw0rd123", "newPassword", "Passw0rd123"), user.accessToken());
        assertEquals(409, samePassword.status());

        ApiResponse changed = client().post("/v1/auth/change-password", map(
                "currentPassword", "Passw0rd123", "newPassword", "NewPassw0rd1"), user.accessToken());
        assertEquals(200, changed.status());
        String freshRefreshToken = ApiClient.dataOf(changed).path("tokens").path("refreshToken").asText();
        assertNotEquals(user.refreshToken(), freshRefreshToken);

        // 其他设备会话已失效
        ApiResponse secondDeviceRefresh = client().post("/v1/auth/refresh",
                map("refreshToken", secondDevice.refreshToken()), null);
        assertEquals(401, secondDeviceRefresh.status());

        // 新密码可登录，旧密码不可
        assertEquals(200, client().login("erin@example.com", "NewPassw0rd1").status());
        assertEquals(401, client().login("erin@example.com", "Passw0rd123").status());

        // 当前设备的换发令牌可用
        assertEquals(200, client().post("/v1/auth/refresh",
                map("refreshToken", freshRefreshToken), null).status());
    }

    // ── 设备会话 ────────────────────────────────────────────────────────

    @Test
    void 设备会话_可列出_可单独吊销() {
        AuthedUser user = client().register("frank@example.com");
        client().login("frank@example.com");

        ApiResponse sessions = client().get("/v1/me/sessions", user.accessToken());
        assertEquals(200, sessions.status());
        assertEquals(2, ApiClient.dataOf(sessions).path("sessions").size());

        String targetSessionId = null;
        for (var session : ApiClient.dataOf(sessions).path("sessions")) {
            String sessionId = session.path("sessionId").asText();
            if (!sessionId.equals(user.refreshToken())) {
                targetSessionId = sessionId;
                break;
            }
        }
        assertNotNull(targetSessionId);

        ApiResponse del = client().delete("/v1/me/sessions/" + targetSessionId, user.accessToken());
        assertEquals(200, del.status());

        ApiResponse after = client().get("/v1/me/sessions", user.accessToken());
        assertEquals(1, ApiClient.dataOf(after).path("sessions").size());

        // 已吊销的会话不能再用
        ApiResponse reuse = client().post("/v1/auth/refresh",
                map("refreshToken", targetSessionId), null);
        assertEquals(401, reuse.status());
    }

    // ── 登出 ────────────────────────────────────────────────────────────

    @Test
    void 登出_单设备与全部设备() {
        AuthedUser user = client().register("grace@example.com");
        AuthedUser other = authedOf(client().login("grace@example.com"));

        ApiResponse one = client().post("/v1/auth/logout",
                map("refreshToken", user.refreshToken()), user.accessToken());
        assertEquals(1, ApiClient.dataOf(one).path("revoked").asInt());
        assertEquals(401, client().post("/v1/auth/refresh",
                map("refreshToken", user.refreshToken()), null).status());

        ApiResponse all = client().post("/v1/auth/logout",
                map("allDevices", true), other.accessToken());
        assertTrue(ApiClient.dataOf(all).path("revoked").asInt() >= 1);
        assertEquals(401, client().post("/v1/auth/refresh",
                map("refreshToken", other.refreshToken()), null).status());
    }

    // ── 资料与审计 ──────────────────────────────────────────────────────

    @Test
    void 资料更新与审计记录() {
        AuthedUser user = client().register("henry@example.com");

        ApiResponse patched = client().patch("/v1/me",
                map("displayName", "亨利"), user.accessToken());
        assertEquals("亨利", ApiClient.dataOf(patched).path("displayName").asText());

        ApiResponse audit = client().get("/v1/me/audit", user.accessToken());
        List<String> actions = ApiClient.dataOf(audit).path("entries").findValuesAsText("action");
        assertTrue(actions.contains("auth.register"), "实际: " + actions);
    }

    // ── 注销账号 ────────────────────────────────────────────────────────

    @Test
    void 注销账号_需密码确认_数据级联删除() {
        AuthedUser user = client().register("ivan@example.com");
        String userId = user.user().path("id").asText();
        // 关联数据直接落库（settings/memories 的路由属 M3 数据域）
        db().execute("INSERT INTO user_settings (user_id, data) VALUES ($1, '{\"theme\":\"dark\"}')", userId);
        db().execute("INSERT INTO memories (user_id, title, content, created_at, last_accessed_at) "
                + "VALUES ($1, 't', 'c', now(), now())", userId);

        ApiResponse wrong = client().request("DELETE", "/v1/me",
                map("password", "WrongPass123"), user.accessToken(), null);
        assertEquals(401, wrong.status());

        ApiResponse okDel = client().request("DELETE", "/v1/me",
                map("password", "Passw0rd123"), user.accessToken(), null);
        assertEquals(200, okDel.status());

        Map<String, Object> counts = db().one("""
                SELECT (SELECT COUNT(*)::int FROM users) AS users,
                       (SELECT COUNT(*)::int FROM user_settings) AS settings,
                       (SELECT COUNT(*)::int FROM memories) AS memories
                """);
        assertEquals(0L, Db.longOf(counts, "users"));
        assertEquals(0L, Db.longOf(counts, "settings"));
        assertEquals(0L, Db.longOf(counts, "memories"));

        // 登录已不可用
        assertEquals(401, client().login("ivan@example.com").status());
    }

    // ── 安全回归 ────────────────────────────────────────────────────────

    @Test
    void SV004_purgeInactive清理超龄历史令牌_未超龄或有效会话保留() {
        AuthedUser user = client().register("purge@example.com"); // 该用户持有 1 条真实有效令牌

        // 伪造 4 条历史令牌：①超龄已吊销 ②超龄已过期 ③近期已过期 ④近期有效
        db().execute("""
                INSERT INTO refresh_tokens (user_id, token_hash, family_id, issued_at, expires_at, revoked_at, revoked_reason)
                VALUES
                  ($1, 'purge-test-revoked-old',    '00000000-0000-4000-8000-000000000001', now() - interval '90 days', now() - interval '85 days', now() - interval '89 days', 'rotated'),
                  ($1, 'purge-test-expired-old',    '00000000-0000-4000-8000-000000000002', now() - interval '61 days', now() - interval '32 days', NULL, NULL),
                  ($1, 'purge-test-expired-recent', '00000000-0000-4000-8000-000000000003', now() - interval '3 days',  now() - interval '1 hour',  NULL, NULL),
                  ($1, 'purge-test-active',         '00000000-0000-4000-8000-000000000004', now() - interval '3 days',  now() + interval '10 days', NULL, NULL)
                """, user.user().path("id").asText());

        // 只清理「（已吊销或已过期）且签发超过 60 天」的记录
        assertEquals(2, RefreshTokensRepository.purgeInactive(db(), 60));

        List<String> hashes = db().query("SELECT token_hash FROM refresh_tokens WHERE user_id = $1",
                        user.user().path("id").asText())
                .stream().map(row -> Db.str(row, "token_hash")).toList();
        assertFalse(hashes.contains("purge-test-revoked-old"));
        assertFalse(hashes.contains("purge-test-expired-old"));
        assertTrue(hashes.contains("purge-test-expired-recent")); // 未超龄：即使已过期也保留
        assertTrue(hashes.contains("purge-test-active")); // 活跃会话保留
        assertEquals(3, hashes.size()); // 保留的 2 条伪造行 + 注册产生的 1 条真实令牌
    }

    @Test
    void SV002_改密后旧访问令牌立即失效_不必等TTL() {
        AuthedUser user = client().register("irene@example.com"); // 设备 1
        AuthedUser secondDevice = authedOf(client().login("irene@example.com")); // 设备 2

        // 前置：两台设备的访问令牌均可用
        assertEquals(200, client().get("/v1/me", user.accessToken()).status());
        assertEquals(200, client().get("/v1/me", secondDevice.accessToken()).status());

        // 设备 1 改密：吊销全部会话，并为当前设备换发新令牌
        ApiResponse changed = client().post("/v1/auth/change-password", map(
                "currentPassword", "Passw0rd123", "newPassword", "NewPassw0rd1"), user.accessToken());
        assertEquals(200, changed.status());
        String freshAccessToken = ApiClient.dataOf(changed).path("tokens").path("accessToken").asText();

        // 旧访问令牌（两台设备）在下一个请求即失效，不再等 TTL 窗口
        ApiResponse oldOther = client().get("/v1/me", secondDevice.accessToken());
        assertEquals(401, oldOther.status());
        assertEquals("UNAUTHENTICATED", oldOther.errorCode());
        assertEquals(401, client().get("/v1/me", user.accessToken()).status());

        // 当前设备换发的新访问令牌可用
        assertEquals(200, client().get("/v1/me", freshAccessToken).status());
    }

    @Test
    void SV002_登出后旧访问令牌立即失效_单设备立即_全部设备一并() {
        AuthedUser user = client().register("jack@example.com"); // 设备 1
        AuthedUser other = authedOf(client().login("jack@example.com")); // 设备 2

        // 设备 2 单设备登出（用自身访问令牌 + 自身刷新令牌）
        ApiResponse one = client().post("/v1/auth/logout",
                map("refreshToken", other.refreshToken()), other.accessToken());
        assertEquals(1, ApiClient.dataOf(one).path("revoked").asInt());

        // 设备 2 的访问令牌立即失效；设备 1 不受影响
        assertEquals(401, client().get("/v1/me", other.accessToken()).status());
        assertEquals(200, client().get("/v1/me", user.accessToken()).status());

        // 设备 1 登出全部设备 → 其访问令牌一并立即失效
        ApiResponse all = client().post("/v1/auth/logout",
                map("allDevices", true), user.accessToken());
        assertTrue(ApiClient.dataOf(all).path("revoked").asInt() >= 1);
        ApiResponse afterAll = client().get("/v1/me", user.accessToken());
        assertEquals(401, afterAll.status());
        assertEquals("UNAUTHENTICATED", afterAll.errorCode());
    }
}
