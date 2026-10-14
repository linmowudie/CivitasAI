package com.civitas.server.integration;

import com.civitas.server.config.ServerConfig;
import com.civitas.server.db.Db;
import com.civitas.server.helpers.ApiClient;
import com.civitas.server.helpers.ApiClient.ApiResponse;
import com.civitas.server.helpers.IntegrationTest;
import com.civitas.server.helpers.TestApp;
import com.civitas.server.helpers.TestConfig;
import com.civitas.server.helpers.TestDb;
import com.civitas.server.security.Hashes;
import org.junit.jupiter.api.BeforeEach;
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
 * 集成测试：验证码认证 + 设备管理 —— 与 TS 版 `test/integration/verificationCode.spec.ts` 对位。
 *
 * 覆盖安全审计 SV-011（新功能无测试）、SV-012（验证码加固）、SV-014 + FE-033（设备绑定可用性）。
 */
class VerificationCodeIntegrationTest extends IntegrationTest {

    private static int seq = 0;

    @BeforeEach
    void freshAppWithDefaultConfig() {
        // 与 TS 版 beforeEach 每次 buildTestApp 对位：单个用例换配置后不影响后续用例
        app.close();
        app = TestApp.build(TestConfig.testConfig());
    }

    private Db db() {
        return TestDb.getTestDb();
    }

    private static String nextEmail() {
        return "code-" + System.currentTimeMillis() + "-" + (++seq) + "@example.com";
    }

    /** 换一个应用实例（用于切换 deviceBindingMode / 冷却等配置） */
    private static void rebuild(ServerConfig cfg) {
        app.close();
        app = TestApp.build(cfg);
    }

    private static ServerConfig.AuthConfig copyAuth(
            ServerConfig.AuthConfig a, ServerConfig.DeviceBindingMode mode, Boolean allowDevCode, Integer cooldownSec) {
        return new ServerConfig.AuthConfig(
                a.jwtSecret(), a.accessTokenTtlSec(), a.refreshTokenTtlDays(), a.allowRefreshReuse(),
                mode == null ? a.deviceBindingMode() : mode,
                allowDevCode == null ? a.allowDevCode() : allowDevCode,
                a.codeTtlSec(), a.codeMaxPerWindow(), a.codeWindowSec(),
                cooldownSec == null ? a.codeResendCooldownSec() : cooldownSec,
                a.codeMaxAttempts());
    }

    /** 发送验证码并取回 devCode（测试配置默认开启 allowDevCode） */
    private String sendCode(String email) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("email", email);
        payload.put("purpose", "login");
        ApiResponse res = client().post("/v1/auth/send-code", payload, null);
        assertEquals(200, res.status(), res.rawBody());
        assertTrue(res.ok());
        String devCode = res.data().path("devCode").asText(null);
        assertNotNull(devCode, "expected devCode in response: " + res.rawBody());
        return devCode;
    }

    private ApiResponse loginWithCode(String email, String deviceId, String code) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("email", email);
        payload.put("code", code);
        payload.put("deviceId", deviceId);
        payload.put("deviceCredential", "cred-" + deviceId);
        return client().post("/v1/auth/login-with-code", payload, null);
    }

    private static String tokenOf(ApiResponse res) {
        return ApiClient.dataOf(res).path("tokens").path("accessToken").asText();
    }

    // ── 验证码存储与生成（SV-012）──────────────────────────────────────

    @Test
    void 验证码只存哈希_明文不落库_且为6位CSPRNG码() {
        String email = nextEmail();
        String code = sendCode(email);
        assertTrue(code.matches("^\\d{6}$"), "实际: " + code);

        List<Map<String, Object>> rows = db().query(
                "SELECT code_hash, attempts FROM verification_codes WHERE email_lower = $1", email);
        assertEquals(1, rows.size());
        assertEquals(Hashes.sha256Hex(code), Db.str(rows.get(0), "code_hash"));
        assertNotEquals(code, Db.str(rows.get(0), "code_hash"));

        List<Map<String, Object>> cols = db().query(
                "SELECT column_name FROM information_schema.columns WHERE table_name = 'verification_codes'");
        assertFalse(cols.stream().map(c -> Db.str(c, "column_name")).toList().contains("code"));
    }

    @Test
    void 签发新码会作废旧码_同一时刻只有一个有效码() {
        String email = nextEmail();
        String first = sendCode(email);
        String second = sendCode(email);
        assertNotEquals(first, second);

        List<Map<String, Object>> unused = db().query(
                "SELECT id FROM verification_codes WHERE email_lower = $1 AND used_at IS NULL", email);
        assertEquals(1, unused.size());

        assertEquals(401, loginWithCode(email, "d1", first).status());
        assertEquals(200, loginWithCode(email, "d1", second).status());
    }

    @Test
    void 发送配额_窗口内超过上限429_RATE_LIMITED() {
        String email = nextEmail();
        sendCode(email);
        sendCode(email);
        sendCode(email);
        ApiResponse fourth = client().post("/v1/auth/send-code",
                Map.of("email", email, "purpose", "login"), null);
        assertEquals(429, fourth.status());
        assertEquals("RATE_LIMITED", fourth.errorCode());
    }

    @Test
    void 发送冷却_间隔不足429_且给出retryAfterSec() {
        rebuild(TestConfig.withAuth(a -> copyAuth(a, null, null, 60)));
        String email = nextEmail();
        sendCode(email);
        ApiResponse again = client().post("/v1/auth/send-code",
                Map.of("email", email, "purpose", "login"), null);
        assertEquals(429, again.status());
        int retryAfterSec = again.error().path("details").path("retryAfterSec").asInt();
        assertTrue(retryAfterSec > 0, "实际: " + again.rawBody());
    }

    @Test
    void devCode仅在显式开启时返回_默认不返回() {
        rebuild(TestConfig.withAuth(a -> copyAuth(a, null, false, null)));
        ApiResponse res = client().post("/v1/auth/send-code",
                Map.of("email", nextEmail(), "purpose", "login"), null);
        assertEquals(200, res.status());
        assertEquals(null, res.data().path("devCode").asText(null));
        assertEquals("console", res.data().path("channel").asText());
    }

    // ── 验证码校验（SV-012）─────────────────────────────────────────────

    @Test
    void 一次性_同一验证码不能用两次() {
        String email = nextEmail();
        String code = sendCode(email);
        assertEquals(200, loginWithCode(email, "d1", code).status());
        assertEquals(401, loginWithCode(email, "d1", code).status());
    }

    @Test
    void 失败锁定_错5次即作废_之后正确码也不再可用() {
        String email = nextEmail();
        String code = sendCode(email);

        for (int i = 1; i <= 4; i++) {
            ApiResponse res = client().post("/v1/auth/login-with-code",
                    Map.of("email", email, "code", "000000", "deviceId", "d1"), null);
            assertEquals(401, res.status());
            assertEquals("验证码错误", res.errorMessage());
        }
        ApiResponse fifth = client().post("/v1/auth/login-with-code",
                Map.of("email", email, "code", "000000", "deviceId", "d1"), null);
        assertEquals(401, fifth.status());
        assertTrue(fifth.errorMessage().contains("次数过多"), "实际: " + fifth.errorMessage());

        assertEquals(401, loginWithCode(email, "d1", code).status());

        Map<String, Object> row = db().one(
                "SELECT attempts, used_at FROM verification_codes WHERE email_lower = $1", email);
        assertEquals(5L, Db.longOf(row, "attempts"));
        assertNotNull(row.get("used_at"));
    }

    @Test
    void 过期验证码被拒() {
        String email = nextEmail();
        String code = sendCode(email);
        db().execute("UPDATE verification_codes SET expires_at = now() - interval '1 second' WHERE email_lower = $1", email);
        ApiResponse res = client().post("/v1/auth/login-with-code",
                Map.of("email", email, "code", code, "deviceId", "d1"), null);
        assertEquals(401, res.status());
        assertTrue(res.errorMessage().contains("无效或已过期"), "实际: " + res.errorMessage());
    }

    // ── 自动注册与设备登记 ──────────────────────────────────────────────

    @Test
    void 首次验证码登录自动注册并登记设备_凭据以哈希存储() {
        String email = nextEmail();
        ApiResponse res = loginWithCode(email, "install-1", sendCode(email));
        assertEquals(200, res.status(), res.rawBody());
        assertTrue(ApiClient.dataOf(res).path("isNewUser").asBoolean());

        ApiResponse devices = client().get("/v1/me/devices", tokenOf(res));
        assertEquals(200, devices.status());
        var list = ApiClient.dataOf(devices).path("devices");
        assertEquals(1, list.size());
        assertEquals("install-1", list.get(0).path("deviceId").asText());
        assertEquals("install", list.get(0).path("kind").asText());

        Map<String, Object> row = db().one(
                "SELECT credential_hash FROM user_devices WHERE device_id = 'install-1'");
        assertEquals(Hashes.sha256Hex("cred-install-1"), Db.str(row, "credential_hash"));
    }

    @Test
    void warn模式_默认_换机后仍可登录_并审计为新设备() {
        String email = nextEmail();
        assertEquals(200, loginWithCode(email, "old-device", sendCode(email)).status());

        ApiResponse second = loginWithCode(email, "new-device-after-reinstall", sendCode(email));
        assertEquals(200, second.status());
        String token = tokenOf(second);

        ApiResponse devices = client().get("/v1/me/devices", token);
        assertEquals(2, ApiClient.dataOf(devices).path("devices").size());

        List<Map<String, Object>> audit = db().query(
                "SELECT action FROM audit_log WHERE action = 'auth.new_device'");
        assertTrue(audit.size() >= 2);
    }

    // ── 严格设备模式 + 自助解绑（FE-033 / SV-014）────────────────────────

    @Test
    void strict模式_首个设备放行_新设备被拒_解绑后可登录() {
        rebuild(TestConfig.withAuth(a -> copyAuth(a, ServerConfig.DeviceBindingMode.strict, null, null)));
        String email = nextEmail();

        // ① 首个设备放行（否则新账号永远无法登录）
        ApiResponse first = loginWithCode(email, "device-A", sendCode(email));
        assertEquals(200, first.status(), first.rawBody());
        String tokenA = tokenOf(first);

        // ② 换机被拒
        ApiResponse blocked = loginWithCode(email, "device-B", sendCode(email));
        assertEquals(403, blocked.status());
        assertTrue(blocked.errorMessage().contains("严格设备模式"), "实际: " + blocked.errorMessage());

        // ③ 在已登录设备 A 上自助解绑 device-A
        ApiResponse revoke = client().delete("/v1/me/devices/device-A", tokenA);
        assertEquals(200, revoke.status());
        assertTrue(ApiClient.dataOf(revoke).path("revoked").asBoolean());

        // ④ 旧设备已移除 → B 可登录
        assertEquals(200, loginWithCode(email, "device-B", sendCode(email)).status());
    }

    @Test
    void 解绑需要鉴权_且不能移除他人设备() {
        String emailA = nextEmail();
        String emailB = nextEmail();
        ApiResponse a = loginWithCode(emailA, "a-device", sendCode(emailA));
        ApiResponse b = loginWithCode(emailB, "b-device", sendCode(emailB));
        String tokenA = tokenOf(a);
        String tokenB = tokenOf(b);

        assertEquals(401, client().delete("/v1/me/devices/a-device", null).status());
        assertEquals(404, client().delete("/v1/me/devices/a-device", tokenB).status());

        ApiResponse devices = client().get("/v1/me/devices", tokenA);
        assertEquals(1, ApiClient.dataOf(devices).path("devices").size());
    }

    @Test
    void off模式_不登记设备() {
        rebuild(TestConfig.withAuth(a -> copyAuth(a, ServerConfig.DeviceBindingMode.off, null, null)));
        String email = nextEmail();
        ApiResponse res = loginWithCode(email, "any-device", sendCode(email));
        assertEquals(200, res.status());
        String token = tokenOf(res);
        ApiResponse devices = client().get("/v1/me/devices", token);
        assertEquals(0, ApiClient.dataOf(devices).path("devices").size());
    }

    @Test
    void 闭环_验证码登录后用令牌访问受保护资源_数据隔离为空() {
        String email = nextEmail();
        ApiResponse res = loginWithCode(email, "install-9", sendCode(email));
        String token = tokenOf(res);

        ApiResponse me = client().get("/v1/me", token);
        assertEquals(200, me.status());
        assertEquals(email, ApiClient.dataOf(me).path("email").asText());

        // memories 列表路由属 M3；此处直接核对该用户没有任何数据行
        String userId = ApiClient.dataOf(res).path("user").path("id").asText();
        Map<String, Object> count = db().one("SELECT COUNT(*)::int AS count FROM memories WHERE user_id = $1", userId);
        assertEquals(0L, Db.longOf(count, "count"));
    }
}
