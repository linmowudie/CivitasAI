package com.civitas.server.http;

import java.util.Map;

/**
 * 统一应用错误 —— 与 TS 版 `src/http/errors.ts` 的 `AppError` 对位。
 *
 * 对外只暴露 `code` + 安全文案；内部细节（SQL 错误、堆栈）只进日志，绝不返回给客户端。
 */
public class AppException extends RuntimeException {
    private final ApiErrorCode code;
    private final Map<String, Object> details;
    /** 是否可安全地把 message 返回给客户端（默认 true；INTERNAL 建议 false） */
    private final boolean expose;

    public AppException(ApiErrorCode code, String message) {
        this(code, message, null, code != ApiErrorCode.INTERNAL);
    }

    public AppException(ApiErrorCode code, String message, Map<String, Object> details) {
        this(code, message, details, code != ApiErrorCode.INTERNAL);
    }

    public AppException(ApiErrorCode code, String message, Map<String, Object> details, boolean expose) {
        super(message);
        this.code = code;
        this.details = details;
        this.expose = expose;
    }

    public ApiErrorCode code() {
        return code;
    }

    public int status() {
        return code.status();
    }

    public Map<String, Object> details() {
        return details;
    }

    public boolean expose() {
        return expose;
    }

    /** 对外错误体（details 仅在 expose 时携带；文案在 !expose 时固定为『服务器内部错误』） */
    public ApiResponse.ErrorPayload toPayload() {
        if (!expose) {
            return new ApiResponse.ErrorPayload(code.name(), "服务器内部错误", null);
        }
        return new ApiResponse.ErrorPayload(code.name(), getMessage(), details);
    }
}
