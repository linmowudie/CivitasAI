package com.civitas.server.http;

import com.civitas.server.config.ServerConfig;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.Set;

/**
 * 按 IP 的粗粒度限流 —— 与 TS 版 `src/app.ts` 的 onRequest 钩子对位。
 *
 *  - /healthz 与 /readyz 为探测端点，不参与限流；
 *  - /v1/auth/ 前缀使用更严的 auth 桶，其余用 api 桶；
 *  - X-RateLimit-Limit / X-RateLimit-Remaining 头**在判定前**设置（与 TS 版一致）；
 *  - 命中上限 → 429『请求过于频繁，请稍后再试』（Retry-After）。
 */
public final class IpRateLimitFilter extends OncePerRequestFilter {
    private static final Set<String> PUBLIC_EXACT = Set.of("/healthz", "/readyz");

    private final ServerConfig cfg;
    private final RateLimiter rateLimiter;

    public IpRateLimitFilter(ServerConfig cfg, RateLimiter rateLimiter) {
        this.cfg = cfg;
        this.rateLimiter = rateLimiter;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String path = request.getRequestURI();
        if (PUBLIC_EXACT.contains(path)) {
            chain.doFilter(request, response);
            return;
        }

        boolean isAuth = path.startsWith("/v1/auth/");
        int limit = isAuth ? cfg.limits().authPerMin() : cfg.limits().apiPerMin();
        String key = (isAuth ? "auth:" : "api:") + ClientIp.of(request, cfg.trustProxy());
        RateLimitDecision decision = rateLimiter.consume(key, limit);
        response.setHeader("X-RateLimit-Limit", String.valueOf(decision.limit()));
        response.setHeader("X-RateLimit-Remaining", String.valueOf(Math.max(0, decision.limit() - decision.used())));
        if (!decision.allowed()) {
            ApiResponse.writeError(response, new AppException(ApiErrorCode.RATE_LIMITED,
                    "请求过于频繁，请稍后再试", Errors.details("retryAfterSec", decision.retryAfterSec())));
            return;
        }
        chain.doFilter(request, response);
    }
}
