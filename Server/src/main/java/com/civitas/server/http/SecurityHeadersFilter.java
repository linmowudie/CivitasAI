package com.civitas.server.http;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;

/**
 * 安全响应头（无需额外依赖的最小集合）—— 与 TS 版 `src/app.ts` 的 onSend 钩子对位。
 *
 * 在所有响应（含错误响应）上设置：nosniff / DENY / no-referrer / no-store。
 */
public final class SecurityHeadersFilter extends OncePerRequestFilter {

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.setHeader("X-Frame-Options", "DENY");
        response.setHeader("Referrer-Policy", "no-referrer");
        response.setHeader("Cache-Control", "no-store");
        chain.doFilter(request, response);
    }

    /** error 分发也要重新补头（sendError 可能清空过响应头） */
    @Override
    protected boolean shouldNotFilterErrorDispatch() {
        return false;
    }
}
