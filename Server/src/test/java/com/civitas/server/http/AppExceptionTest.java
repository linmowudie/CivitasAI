package com.civitas.server.http;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 错误对象与响应体 —— 与 TS 版 `test/unit/core.spec.ts` 的错误用例对位。
 */
class AppExceptionTest {

    @Test
    void 状态码映射正确() {
        assertEquals(404, Errors.notFound().status());
        assertEquals(429, Errors.rateLimited(30).status());
        assertEquals(7, Errors.rateLimited(7).details().get("retryAfterSec"));
        assertEquals(ApiErrorCode.RATE_LIMITED, Errors.rateLimited(7).code());
    }

    @Test
    void INTERNAL不向外暴露内部文案_但保留给日志() {
        AppException error = Errors.internal("数据库连接串里有密码");
        ApiResponse.ErrorPayload payload = error.toPayload();
        assertEquals("INTERNAL", payload.code());
        assertEquals("服务器内部错误", payload.message());
        assertNull(payload.details());
        assertEquals("数据库连接串里有密码", error.getMessage());
    }

    @Test
    void 非暴露错误体不含details() {
        AppException error = Errors.internal("boom", Errors.details("sql", "select 1"));
        ApiResponse.ErrorPayload payload = error.toPayload();
        assertNull(payload.details());
    }

    @Test
    void 默认文案与TS版逐字一致() {
        assertEquals("未登录或凭证无效", Errors.unauthenticated().getMessage());
        assertEquals("邮箱或密码不正确", Errors.invalidCredentials().getMessage());
        assertEquals("无权访问", Errors.forbidden().getMessage());
        assertEquals("资源不存在", Errors.notFound().getMessage());
        assertEquals("请求过于频繁，请稍后再试", Errors.rateLimited(5).getMessage());
        assertEquals("服务暂时不可用", Errors.unavailable().getMessage());
        assertEquals("设置已被其他设备修改，请拉取最新版本后重试", Errors.revisionMismatch(7).getMessage());
    }

    @Test
    void revisionMismatch携带当前修订号() {
        AppException error = Errors.revisionMismatch(7);
        assertEquals(ApiErrorCode.REVISION_MISMATCH, error.code());
        assertEquals(409, error.status());
        assertEquals(7L, ((Number) error.details().get("currentRevision")).longValue());
    }

    @Test
    void 响应体结构与TS版一致() {
        ApiResponse.OkBody<String> ok = ApiResponse.ok("payload");
        assertTrue(ok.ok());
        assertEquals("payload", ok.data());

        ApiResponse.ErrBody err = ApiResponse.errorBody(Errors.notFound("接口不存在"));
        assertFalse(err.ok());
        assertNotNull(err.error());
        assertEquals("NOT_FOUND", err.error().code());
        assertEquals("接口不存在", err.error().message());
    }
}
