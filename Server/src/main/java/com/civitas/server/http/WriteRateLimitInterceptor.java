package com.civitas.server.http;

import com.civitas.server.config.ServerConfig;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.web.servlet.HandlerInterceptor;

import java.util.Set;

/**
 * 写限流（按用户）—— 与 TS 版 `src/app.ts` 的写限流钩子对位。
 *
 * 注意：TS 版该限流挂在全局 preHandler，但 Fastify 的实例钩子先于路由钩子执行，
 * 检查时 `request.auth` 尚未注入，实际从未生效；此处按注释声明的意图
 * （"按用户；在鉴权之后执行"）落地——注册顺序在 {@link AuthInterceptor} 之后。
 */
public final class WriteRateLimitInterceptor implements HandlerInterceptor {
    private static final Set<String> WRITE_METHODS = Set.of("POST", "PUT", "PATCH", "DELETE");

    private final ServerConfig cfg;
    private final RateLimiter rateLimiter;

    public WriteRateLimitInterceptor(ServerConfig cfg, RateLimiter rateLimiter) {
        this.cfg = cfg;
        this.rateLimiter = rateLimiter;
    }

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) {
        if (!WRITE_METHODS.contains(request.getMethod())) return true;
        AuthContext auth = (AuthContext) request.getAttribute(AuthContext.ATTRIBUTE);
        if (auth == null) return true; // 未鉴权的写请求由各自的鉴权守卫拦截

        RateLimitDecision decision = rateLimiter.consume("write:" + auth.userId(), cfg.limits().writePerMin());
        if (!decision.allowed()) {
            throw new AppException(ApiErrorCode.RATE_LIMITED, "写入过于频繁，请稍后再试",
                    Errors.details("retryAfterSec", decision.retryAfterSec()));
        }
        return true;
    }
}
