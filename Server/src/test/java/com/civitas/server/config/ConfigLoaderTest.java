package com.civitas.server.config;

import com.civitas.server.config.ConfigLoader.LoadConfigResult;
import org.junit.jupiter.api.Test;

import java.util.HashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 配置加载与校验（含生产环境 fail-closed）—— 与 TS 版 `test/unit/config.spec.ts` 对位。
 */
class ConfigLoaderTest {

    private static Map<String, String> base() {
        Map<String, String> env = new HashMap<>();
        env.put("DATABASE_URL", "postgres://u:p@localhost:5432/db");
        env.put("JWT_SECRET", "x".repeat(40));
        return env;
    }

    private static Map<String, String> env(Object... keyValues) {
        Map<String, String> env = base();
        for (int i = 0; i + 1 < keyValues.length; i += 2) {
            env.put(String.valueOf(keyValues[i]), String.valueOf(keyValues[i + 1]));
        }
        return env;
    }

    @Test
    void parseEnvFile_解析键值_忽略注释与空行_去掉成对引号() {
        Map<String, String> parsed = ConfigLoader.parseEnvFile("""
            # 注释
            PORT=8787
            HOST="127.0.0.1"
            EMPTY=
            SPACED = value with spaces
            QUOTED='single'
            """);
        assertEquals("8787", parsed.get("PORT"));
        assertEquals("127.0.0.1", parsed.get("HOST"));
        assertEquals("", parsed.get("EMPTY"));
        assertEquals("value with spaces", parsed.get("SPACED"));
        assertEquals("single", parsed.get("QUOTED"));
    }

    @Test
    void 缺少DATABASE_URL时报错() {
        Map<String, String> env = new HashMap<>();
        env.put("JWT_SECRET", "x".repeat(40));
        LoadConfigResult result = ConfigLoader.loadConfig(env);
        assertFalse(result.ok());
        assertTrue(String.join(" ", result.errors()).contains("DATABASE_URL"));
    }

    @Test
    void DATABASE_URL必须是postgres连接串() {
        LoadConfigResult result = ConfigLoader.loadConfig(env("DATABASE_URL", "mysql://localhost/db"));
        assertFalse(result.ok());
        assertTrue(String.join(" ", result.errors()).contains("postgres://"));
    }

    @Test
    void 默认值可用_本地开发() {
        LoadConfigResult result = ConfigLoader.loadConfig(base());
        assertTrue(result.ok());
        ServerConfig cfg = result.config();
        assertEquals(8787, cfg.port());
        assertEquals("127.0.0.1", cfg.host());
        assertEquals(900, cfg.auth().accessTokenTtlSec());
        assertEquals(30, cfg.auth().refreshTokenTtlDays());
        assertFalse(cfg.trustProxy());
        assertEquals(0, cfg.corsOrigins().size());
    }

    @Test
    void 数值与布尔会被转换() {
        LoadConfigResult result = ConfigLoader.loadConfig(env(
                "PORT", "9000",
                "ACCESS_TOKEN_TTL_SEC", "60",
                "ALLOW_REFRESH_REUSE", "true",
                "TRUST_PROXY", "1",
                "CORS_ORIGINS", "https://a.example, https://b.example",
                "DB_POOL_MAX", "20"));
        assertTrue(result.ok());
        ServerConfig cfg = result.config();
        assertEquals(9000, cfg.port());
        assertEquals(60, cfg.auth().accessTokenTtlSec());
        assertTrue(cfg.auth().allowRefreshReuse());
        assertTrue(cfg.trustProxy());
        assertEquals(java.util.List.of("https://a.example", "https://b.example"), cfg.corsOrigins());
        assertEquals(20, cfg.db().poolMax());
    }

    @Test
    void 生产环境缺少或过短的JWT_SECRET直接拒绝启动() {
        LoadConfigResult missing = ConfigLoader.loadConfig(env("NODE_ENV", "production", "JWT_SECRET", ""));
        assertFalse(missing.ok());
        assertTrue(String.join(" ", missing.errors()).contains("JWT_SECRET"));

        LoadConfigResult example = ConfigLoader.loadConfig(env(
                "NODE_ENV", "production",
                "JWT_SECRET", "dev-only-insecure-secret-change-me-0123456789"));
        assertFalse(example.ok());

        LoadConfigResult good = ConfigLoader.loadConfig(env(
                "NODE_ENV", "production",
                "MAIL_WEBHOOK_URL", "https://mail.example.com/send"));
        assertTrue(good.ok());
    }

    @Test
    void 生产环境未配置邮件通道_拒绝启动() {
        LoadConfigResult result = ConfigLoader.loadConfig(env("NODE_ENV", "production"));
        assertFalse(result.ok());
        assertTrue(String.join(" ", result.errors()).contains("MAIL_WEBHOOK_URL"));
    }

    @Test
    void 生产环境禁止回传验证码() {
        LoadConfigResult result = ConfigLoader.loadConfig(env(
                "NODE_ENV", "production",
                "MAIL_WEBHOOK_URL", "https://mail.example.com/send",
                "ALLOW_DEV_CODE", "true"));
        assertFalse(result.ok());
        assertTrue(String.join(" ", result.errors()).contains("ALLOW_DEV_CODE"));
    }

    @Test
    void 认证配置项的安全默认值() {
        LoadConfigResult result = ConfigLoader.loadConfig(base());
        assertTrue(result.ok());
        assertEquals(ServerConfig.DeviceBindingMode.warn, result.config().auth().deviceBindingMode());
        assertFalse(result.config().auth().allowDevCode());
        assertEquals(5, result.config().auth().codeMaxAttempts());
        assertEquals(3, result.config().auth().codeMaxPerWindow());
        assertEquals(60, result.config().auth().codeResendCooldownSec());
    }

    @Test
    void 开发环境密钥过短只告警不阻塞() {
        LoadConfigResult result = ConfigLoader.loadConfig(env("JWT_SECRET", "short"));
        assertTrue(result.ok());
        assertTrue(String.join(" ", result.warnings()).contains("JWT_SECRET"));
    }

    @Test
    void 非法端口报错() {
        LoadConfigResult result = ConfigLoader.loadConfig(env("PORT", "abc"));
        assertFalse(result.ok());
    }

    @Test
    void 枚举非法值报错_文案与Zod一致() {
        LoadConfigResult result = ConfigLoader.loadConfig(env("DEVICE_BINDING_MODE", "lockdown"));
        assertFalse(result.ok());
        assertTrue(String.join(" ", result.errors())
                .contains("Invalid enum value. Expected 'off' | 'warn' | 'strict', received 'lockdown'"));
    }

    @Test
    void 未设置JWT_SECRET时使用开发缺省值并告警() {
        Map<String, String> env = base();
        env.remove("JWT_SECRET");
        LoadConfigResult result = ConfigLoader.loadConfig(env);
        assertTrue(result.ok());
        assertEquals(ConfigLoader.DEV_JWT_SECRET, result.config().auth().jwtSecret());

        LoadConfigResult explicitShort = ConfigLoader.loadConfig(env("JWT_SECRET", "abc"));
        assertTrue(explicitShort.ok());
        assertEquals("abc", explicitShort.config().auth().jwtSecret());
    }

    @Test
    void 限流存储缺省_开发内存_生产postgres() {
        assertEquals(ServerConfig.RateLimitStore.memory, ConfigLoader.loadConfig(base()).config().rateLimitStore());
        assertEquals(ServerConfig.RateLimitStore.postgres, ConfigLoader.loadConfig(env(
                        "NODE_ENV", "production", "MAIL_WEBHOOK_URL", "https://mail.example.com/send"))
                .config().rateLimitStore());
        assertEquals(ServerConfig.RateLimitStore.memory, ConfigLoader.loadConfig(env("RATE_LIMIT_STORE", "memory"))
                .config().rateLimitStore());
        assertNull(ConfigLoader.loadConfig(env("RATE_LIMIT_STORE", "redis")).config());
    }
}
