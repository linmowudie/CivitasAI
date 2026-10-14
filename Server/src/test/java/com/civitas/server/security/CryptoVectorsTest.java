package com.civitas.server.security;

import com.civitas.server.config.ServerConfig;
import com.civitas.server.http.ApiErrorCode;
import com.civitas.server.http.AppException;
import com.civitas.server.json.Json;
import com.civitas.server.helpers.TestConfig;
import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;

import java.io.InputStream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 跨语言加密向量 —— 与 TS 版 `test/unit/core.spec.ts` 的向量部分对位。
 *
 * `src/test/resources/vectors.json` 由 TS 版（node:crypto + jose + @node-rs/argon2）生成：
 *  - Argon2id PHC：Java（BouncyCastle）必须能验证 TS 生成的哈希；
 *  - JWT：Java（jjwt）必须能验证 jose 签发的令牌（含过期特判）；
 *  - 刷新令牌：sha256 十六进制与 node:crypto 一致。
 */
class CryptoVectorsTest {

    private static JsonNode vectors() {
        try (InputStream in = CryptoVectorsTest.class.getClassLoader().getResourceAsStream("vectors.json")) {
            if (in == null) throw new IllegalStateException("vectors.json 缺失");
            return Json.MAPPER.readTree(in);
        } catch (Exception e) {
            throw new IllegalStateException("读取 vectors.json 失败", e);
        }
    }

    // ── Argon2id ────────────────────────────────────────────────────────

    @Test
    void argon2Phc由Ts生成_Java可验证() {
        JsonNode vectors = vectors();
        String plain = vectors.path("password").path("plain").asText();
        String phc = vectors.path("password").path("phc").asText();
        assertTrue(PasswordService.verifyPassword(phc, plain), "Java 必须能验证 TS 生成的 Argon2id 哈希");
        assertFalse(PasswordService.verifyPassword(phc, "WrongPass123"));
    }

    @Test
    void argon2参数与Ts一致() {
        JsonNode argon2 = vectors().path("password").path("argon2");
        assertEquals(argon2.path("memoryCost").asInt(), PasswordService.MEMORY_COST_KB);
        assertEquals(argon2.path("timeCost").asInt(), PasswordService.TIME_COST);
        assertEquals(argon2.path("parallelism").asInt(), PasswordService.PARALLELISM);
        assertEquals(argon2.path("outputLen").asInt(), PasswordService.OUTPUT_LEN);
    }

    @Test
    void java生成的哈希格式为argon2id_且可回验() {
        String hash = PasswordService.hashPassword("Passw0rd123");
        assertTrue(hash.startsWith("$argon2id$v=19$m=19456,t=2,p=1$"), "实际: " + hash);
        assertFalse(hash.contains("Passw0rd123"));
        assertTrue(PasswordService.verifyPassword(hash, "Passw0rd123"));
        assertFalse(PasswordService.verifyPassword(hash, "wrong"));
    }

    // ── JWT ────────────────────────────────────────────────────────────

    private static ServerConfig.AuthConfig authConfig(String secret) {
        ServerConfig.AuthConfig base = TestConfig.testConfig().auth();
        return new ServerConfig.AuthConfig(secret, base.accessTokenTtlSec(), base.refreshTokenTtlDays(),
                base.allowRefreshReuse(), base.deviceBindingMode(), base.allowDevCode(),
                base.codeTtlSec(), base.codeMaxPerWindow(), base.codeWindowSec(),
                base.codeResendCooldownSec(), base.codeMaxAttempts());
    }

    @Test
    void jose签发的有效令牌_Java可验证() {
        JsonNode jwt = vectors().path("jwt");
        ServerConfig.AuthConfig cfg = authConfig(jwt.path("secret").asText());
        TokenService.AccessTokenClaims claims =
                TokenService.verifyAccessToken(cfg, jwt.path("validToken").asText());
        assertEquals(jwt.path("expectedSub").asText(), claims.sub());
        assertEquals(jwt.path("expectedSid").asText(), claims.sid());
    }

    @Test
    void 过期令牌_Java抛TOKEN_EXPIRED() {
        JsonNode jwt = vectors().path("jwt");
        ServerConfig.AuthConfig cfg = authConfig(jwt.path("secret").asText());
        AppException e = assertThrows(AppException.class,
                () -> TokenService.verifyAccessToken(cfg, jwt.path("expiredToken").asText()));
        assertEquals(ApiErrorCode.TOKEN_EXPIRED, e.code());
        assertEquals("访问令牌已过期，请刷新令牌", e.getMessage());
    }

    @Test
    void 篡改签名令牌_非法() {
        JsonNode jwt = vectors().path("jwt");
        ServerConfig.AuthConfig cfg = authConfig(jwt.path("secret").asText());
        String valid = jwt.path("validToken").asText();
        char last = valid.charAt(valid.length() - 1);
        String tampered = valid.substring(0, valid.length() - 1) + (last == 'A' ? 'B' : 'A');
        AppException e = assertThrows(AppException.class, () -> TokenService.verifyAccessToken(cfg, tampered));
        assertEquals(ApiErrorCode.UNAUTHENTICATED, e.code());
        assertEquals("访问令牌无效", e.getMessage());
    }

    @Test
    void 换密钥_令牌非法() {
        JsonNode jwt = vectors().path("jwt");
        ServerConfig.AuthConfig cfg = authConfig("another-secret-another-secret-1234567890");
        AppException e = assertThrows(AppException.class,
                () -> TokenService.verifyAccessToken(cfg, jwt.path("validToken").asText()));
        assertEquals(ApiErrorCode.UNAUTHENTICATED, e.code());
    }

    @Test
    void 自行签发的令牌_claims一致() {
        ServerConfig.AuthConfig cfg = authConfig("test-secret-test-secret-test-secret-1234");
        long now = System.currentTimeMillis();
        TokenService.SignedAccessToken signed =
                TokenService.signAccessToken(cfg, "user-1", "sess-1", now);
        TokenService.AccessTokenClaims claims = TokenService.verifyAccessToken(cfg, signed.token());
        assertEquals("user-1", claims.sub());
        assertEquals("sess-1", claims.sid());
        long iat = now / 1000;
        assertEquals((iat + cfg.accessTokenTtlSec()) * 1000L, signed.expiresAtMs());
        assertEquals(cfg.accessTokenTtlSec(), signed.expiresIn());
    }

    // ── 刷新令牌 ────────────────────────────────────────────────────────

    @Test
    void 刷新令牌sha256与node_crypto一致() {
        JsonNode refresh = vectors().path("refreshToken");
        assertEquals(refresh.path("sha256").asText(),
                TokenService.hashRefreshToken(refresh.path("raw").asText()));
    }

    @Test
    void 生成的刷新令牌为base64url的256位随机串() {
        TokenService.GeneratedRefreshToken first = TokenService.generateRefreshToken();
        TokenService.GeneratedRefreshToken second = TokenService.generateRefreshToken();
        assertTrue(first.raw().matches("^[A-Za-z0-9_-]{43}$"), "实际: " + first.raw());
        assertEquals(TokenService.hashRefreshToken(first.raw()), first.hash());
        assertNotEquals(first.raw(), second.raw());
    }
}
