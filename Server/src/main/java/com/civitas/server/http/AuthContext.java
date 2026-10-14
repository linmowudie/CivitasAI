package com.civitas.server.http;

/**
 * 请求上下文中的已认证身份 —— 与 TS 版 `src/http/authGuard.ts` 的 `AuthContext` 对位。
 */
public record AuthContext(String userId, String sessionId) {
    public static final String ATTRIBUTE = AuthContext.class.getName();
}
