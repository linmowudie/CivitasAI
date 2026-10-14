package com.civitas.server.http;

import jakarta.servlet.http.HttpServletRequest;

/**
 * 客户端 IP 解析（限流键与审计共用）—— 与 Fastify `trustProxy` 语义对位：
 * 开启时取 X-Forwarded-For 首项，否则用 socket 远端地址。
 */
public final class ClientIp {
    private ClientIp() {}

    public static String of(HttpServletRequest request, boolean trustProxy) {
        if (trustProxy) {
            String forwarded = request.getHeader("X-Forwarded-For");
            if (forwarded != null && !forwarded.isEmpty()) {
                String first = forwarded.split(",")[0].trim();
                if (!first.isEmpty()) return first;
            }
        }
        return request.getRemoteAddr();
    }
}
