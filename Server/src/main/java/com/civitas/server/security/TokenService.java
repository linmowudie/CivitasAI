package com.civitas.server.security;

import com.civitas.server.config.ServerConfig;
import com.civitas.server.http.ApiErrorCode;
import com.civitas.server.http.AppException;
import com.civitas.server.http.Errors;
import io.jsonwebtoken.Claims;
import io.jsonwebtoken.ExpiredJwtException;
import io.jsonwebtoken.Jws;
import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.security.Keys;

import javax.crypto.SecretKey;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Base64;
import java.util.Date;
import java.util.UUID;

/**
 * 令牌 —— 与 TS 版 `src/security/tokens.ts` 对位：
 *  - 访问令牌：JWT（HS256，短时效），只放最小声明（sub / sid / typ），不放邮箱等 PII；
 *  - 刷新令牌：256 位随机不透明串（base64url），服务端只存 sha256 哈希；按"家族"轮换。
 *
 * 跨语言约束：jose 签名（iss/aud/claims/时间戳）与 jjwt 互认，向量的集成测试见 CryptoVectorsTest。
 */
public final class TokenService {
    public static final String JWT_ISSUER = "civitas-server";
    public static final String JWT_AUDIENCE = "civitas-client";

    private TokenService() {}

    public record AccessTokenClaims(String sub, String sid) {}

    public record SignedAccessToken(String token, int expiresIn, long expiresAtMs) {}

    public record GeneratedRefreshToken(String raw, String hash) {}

    private static SecretKey secretKey(ServerConfig.AuthConfig cfg) {
        return Keys.hmacShaKeyFor(cfg.jwtSecret().getBytes(StandardCharsets.UTF_8));
    }

    /** 签发访问令牌（iat = floor(now/1000)，exp = iat + ttl） */
    public static SignedAccessToken signAccessToken(ServerConfig.AuthConfig cfg, String sub, String sid) {
        return signAccessToken(cfg, sub, sid, System.currentTimeMillis());
    }

    public static SignedAccessToken signAccessToken(ServerConfig.AuthConfig cfg, String sub, String sid, long nowMs) {
        long iat = nowMs / 1000;
        long exp = iat + cfg.accessTokenTtlSec();
        String token = Jwts.builder()
                .subject(sub)
                .issuer(JWT_ISSUER)
                .audience().add(JWT_AUDIENCE).and()
                .issuedAt(Date.from(Instant.ofEpochSecond(iat)))
                .expiration(Date.from(Instant.ofEpochSecond(exp)))
                .claim("sid", sid)
                .claim("typ", "access")
                .header().type("JWT").and()
                .signWith(secretKey(cfg), Jwts.SIG.HS256)
                .compact();
        return new SignedAccessToken(token, cfg.accessTokenTtlSec(), exp * 1000);
    }

    /** 校验访问令牌；过期与非法分别抛出可区分的错误码（对位 jose 的 JWTExpired 特判） */
    public static AccessTokenClaims verifyAccessToken(ServerConfig.AuthConfig cfg, String token) {
        try {
            Jws<Claims> jws = Jwts.parser()
                    .verifyWith(secretKey(cfg))
                    .requireIssuer(JWT_ISSUER)
                    .requireAudience(JWT_AUDIENCE)
                    .build()
                    .parseSignedClaims(token);
            // 与 jose `algorithms: ['HS256']` 的限制对齐：头算法不匹配一律拒绝
            if (!"HS256".equals(jws.getHeader().getAlgorithm())) {
                throw Errors.unauthenticated("访问令牌无效");
            }
            Claims claims = jws.getPayload();
            Object sub = claims.get("sub");
            Object sid = claims.get("sid");
            if (!(sub instanceof String subText) || !(sid instanceof String sidText)) {
                throw Errors.unauthenticated("令牌缺少必要声明");
            }
            return new AccessTokenClaims(subText, sidText);
        } catch (AppException e) {
            throw e;
        } catch (ExpiredJwtException e) {
            throw new AppException(ApiErrorCode.TOKEN_EXPIRED, "访问令牌已过期，请刷新令牌");
        } catch (RuntimeException e) {
            throw Errors.unauthenticated("访问令牌无效");
        }
    }

    // ── 刷新令牌（不透明串）─────────────────────────────────────────────

    public static String hashRefreshToken(String raw) {
        return Hashes.sha256Hex(raw);
    }

    /** 32 字节 CSPRNG → base64url（无填充），等价 `randomBytes(32).toString('base64url')` */
    public static GeneratedRefreshToken generateRefreshToken() {
        byte[] bytes = new byte[32];
        Hashes.secureRandom().nextBytes(bytes);
        String raw = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
        return new GeneratedRefreshToken(raw, hashRefreshToken(raw));
    }

    public static String newFamilyId() {
        return UUID.randomUUID().toString();
    }
}
