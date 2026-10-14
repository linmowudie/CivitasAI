package com.civitas.server.http;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 便捷错误构造 —— 与 TS 版 `src/http/errors.ts` 的工厂函数对位。
 *
 * 文案（含标点）与 TS 版逐字一致，客户端按文案断言的测试不受改写影响。
 */
public final class Errors {
    private Errors() {}

    public static AppException badRequest(String message, Map<String, Object> details) {
        return new AppException(ApiErrorCode.VALIDATION_ERROR, message, details);
    }

    public static AppException unauthenticated() {
        return new AppException(ApiErrorCode.UNAUTHENTICATED, "未登录或凭证无效");
    }

    public static AppException unauthenticated(String message) {
        return new AppException(ApiErrorCode.UNAUTHENTICATED, message);
    }

    /**
     * 凭证类失败（登录密码/验证码等）。
     *
     * 默认文案刻意不区分“邮箱不存在”与“密码错误”（防账号枚举）；
     * 验证码场景需要可区分提示，因此接受可选 message。
     */
    public static AppException invalidCredentials() {
        return new AppException(ApiErrorCode.INVALID_CREDENTIALS, "邮箱或密码不正确");
    }

    public static AppException invalidCredentials(String message) {
        return new AppException(ApiErrorCode.INVALID_CREDENTIALS, message);
    }

    public static AppException forbidden() {
        return new AppException(ApiErrorCode.FORBIDDEN, "无权访问");
    }

    public static AppException forbidden(String message) {
        return new AppException(ApiErrorCode.FORBIDDEN, message);
    }

    public static AppException notFound() {
        return new AppException(ApiErrorCode.NOT_FOUND, "资源不存在");
    }

    public static AppException notFound(String message) {
        return new AppException(ApiErrorCode.NOT_FOUND, message);
    }

    public static AppException conflict(String message, Map<String, Object> details) {
        return new AppException(ApiErrorCode.CONFLICT, message, details);
    }

    public static AppException revisionMismatch(long currentRevision) {
        return new AppException(ApiErrorCode.REVISION_MISMATCH,
                "设置已被其他设备修改，请拉取最新版本后重试",
                details("currentRevision", currentRevision));
    }

    public static AppException payloadTooLarge(String message, Map<String, Object> details) {
        return new AppException(ApiErrorCode.PAYLOAD_TOO_LARGE, message, details);
    }

    public static AppException rateLimited(int retryAfterSec) {
        return new AppException(ApiErrorCode.RATE_LIMITED, "请求过于频繁，请稍后再试",
                details("retryAfterSec", retryAfterSec));
    }

    /** 服务暂不可用（503）：如就绪探测失败（SV-008 统一纳入错误码管理） */
    public static AppException unavailable() {
        return new AppException(ApiErrorCode.UNAVAILABLE, "服务暂时不可用");
    }

    public static AppException unavailable(String message, Map<String, Object> details) {
        return new AppException(ApiErrorCode.UNAVAILABLE, message, details);
    }

    public static AppException internal(String message) {
        return new AppException(ApiErrorCode.INTERNAL, message, null, false);
    }

    public static AppException internal(String message, Map<String, Object> details) {
        return new AppException(ApiErrorCode.INTERNAL, message, details, false);
    }

    /** details 构造成对键值（保持插入顺序，JSON 字段顺序与 TS 版一致） */
    public static Map<String, Object> details(Object... keyValues) {
        Map<String, Object> map = new LinkedHashMap<>();
        for (int i = 0; i + 1 < keyValues.length; i += 2) {
            map.put(String.valueOf(keyValues[i]), keyValues[i + 1]);
        }
        return map;
    }
}
