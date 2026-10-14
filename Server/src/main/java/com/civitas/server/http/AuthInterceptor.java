package com.civitas.server.http;

import com.civitas.server.config.ServerConfig;
import com.civitas.server.db.Db;
import com.civitas.server.security.TokenService;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.web.method.HandlerMethod;
import org.springframework.web.servlet.HandlerInterceptor;

import java.time.Instant;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 访问令牌校验 —— 与 TS 版 `src/http/authGuard.ts` 的 preHandler 对位：
 * 验签 + 回查会话状态（SV-002），把 {@link AuthContext} 注入请求属性。
 */
public final class AuthInterceptor implements HandlerInterceptor {
    private static final Pattern BEARER = Pattern.compile("^Bearer\\s+(.+)$", Pattern.CASE_INSENSITIVE);

    private final ServerConfig cfg;
    private final Db db;

    public AuthInterceptor(ServerConfig cfg, Db db) {
        this.cfg = cfg;
        this.db = db;
    }

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) {
        if (!(handler instanceof HandlerMethod method)) return true;
        if (!method.hasMethodAnnotation(RequireAuth.class)) return true;

        String token = extractBearer(request.getHeader("Authorization"));
        if (token == null) throw Errors.unauthenticated("缺少 Bearer 访问令牌");
        TokenService.AccessTokenClaims claims = TokenService.verifyAccessToken(cfg.auth(), token);

        // SV-002：访问令牌自身无状态，但 `sid` 指向会话行（refresh_tokens.id）——
        // 改密/登出/单会话吊销会立即吊销该行，旧访问令牌不等 TTL 到期即失效
        Map<String, Object> session = db.one(
                "SELECT revoked_at, expires_at FROM refresh_tokens WHERE id = $1", claims.sid());
        if (session == null) throw Errors.unauthenticated("会话已失效，请重新登录");
        Instant revokedAt = Db.instantOf(session, "revoked_at");
        Instant expiresAt = Db.instantOf(session, "expires_at");
        if (revokedAt != null || !expiresAt.isAfter(Instant.now())) {
            throw Errors.unauthenticated("会话已失效，请重新登录");
        }

        request.setAttribute(AuthContext.ATTRIBUTE, new AuthContext(claims.sub(), claims.sid()));
        return true;
    }

    /** 从 Authorization 头取 Bearer 令牌（对位 TS 的 extractBearer） */
    public static String extractBearer(String header) {
        if (header == null) return null;
        Matcher match = BEARER.matcher(header.trim());
        if (!match.matches()) return null;
        String token = match.group(1) == null ? "" : match.group(1).trim();
        return token.isEmpty() ? null : token;
    }
}
