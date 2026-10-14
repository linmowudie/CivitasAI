package com.civitas.server.http;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/**
 * 路由级鉴权标记 —— 与 TS 版路由的 `{ preHandler: guard }` 对位。
 * 标注后的路由由 {@link AuthInterceptor} 校验访问令牌并回查会话状态（SV-002）。
 */
@Target(ElementType.METHOD)
@Retention(RetentionPolicy.RUNTIME)
public @interface RequireAuth {}
