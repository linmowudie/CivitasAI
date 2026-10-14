package com.civitas.server.http;

/**
 * 统一错误码 —— 与 TS 版 `src/http/errors.ts` 的 ErrorCode 联合类型逐一对应。
 *
 * 枚举常量名即对外 `code` 字段的取值（UPPER_SNAKE），顺序与 TS 版保持一致。
 */
public enum ApiErrorCode {
    VALIDATION_ERROR(400),
    UNAUTHENTICATED(401),
    INVALID_CREDENTIALS(401),
    TOKEN_EXPIRED(401),
    TOKEN_REUSED(401),
    FORBIDDEN(403),
    NOT_FOUND(404),
    CONFLICT(409),
    REVISION_MISMATCH(409),
    PAYLOAD_TOO_LARGE(413),
    RATE_LIMITED(429),
    UNSUPPORTED(415),
    UNAVAILABLE(503),
    INTERNAL(500);

    private final int status;

    ApiErrorCode(int status) {
        this.status = status;
    }

    public int status() {
        return status;
    }
}
