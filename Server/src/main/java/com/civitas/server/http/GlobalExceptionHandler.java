package com.civitas.server.http;

import com.civitas.server.logging.JsonLogger;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.HttpMediaTypeNotSupportedException;
import org.springframework.web.HttpRequestMethodNotSupportedException;
import org.springframework.web.bind.ServletRequestBindingException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.servlet.NoHandlerFoundException;
import org.springframework.web.servlet.resource.NoResourceFoundException;

import java.util.Map;

/**
 * 统一异常处理 —— 与 TS 版 `src/app.ts` 的 `setErrorHandler` / `setNotFoundHandler` 对位。
 *
 * 只暴露安全文案，内部错误（INTERNAL 且 expose=false）文案被替换为『服务器内部错误』并进日志。
 * 状态码 → 文案映射与 TS 版一致：
 *  404 → NOT_FOUND『接口不存在』；413 → PAYLOAD_TOO_LARGE『请求体过大』；
 *  415 → UNSUPPORTED『不支持的请求格式（需 application/json）』；400 → VALIDATION_ERROR『请求格式不正确』。
 */
@RestControllerAdvice
public class GlobalExceptionHandler {

    @ExceptionHandler(AppException.class)
    public ResponseEntity<ApiResponse.ErrBody> handleAppException(AppException error) {
        if (error.status() >= 500) {
            JsonLogger.error("请求处理失败", Map.of("err", error));
        }
        return ApiResponse.fail(error);
    }

    /** 路由/资源不存在（等价 Fastify 的 setNotFoundHandler） */
    @ExceptionHandler({NoHandlerFoundException.class, NoResourceFoundException.class,
            HttpRequestMethodNotSupportedException.class})
    public ResponseEntity<ApiResponse.ErrBody> handleNotFound(Exception error) {
        return ApiResponse.fail(new AppException(ApiErrorCode.NOT_FOUND, "接口不存在"));
    }

    @ExceptionHandler(HttpMediaTypeNotSupportedException.class)
    public ResponseEntity<ApiResponse.ErrBody> handleUnsupported(HttpMediaTypeNotSupportedException error) {
        return ApiResponse.fail(new AppException(ApiErrorCode.UNSUPPORTED, "不支持的请求格式（需 application/json）"));
    }

    /** 请求体解析失败：超过上限 → 413；其余格式问题 → 400 */
    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<ApiResponse.ErrBody> handleNotReadable(HttpMessageNotReadableException error) {
        if (causedByBodyTooLarge(error)) {
            return ApiResponse.fail(new AppException(ApiErrorCode.PAYLOAD_TOO_LARGE, "请求体过大"));
        }
        return ApiResponse.fail(new AppException(ApiErrorCode.VALIDATION_ERROR, "请求格式不正确"));
    }

    @ExceptionHandler(BodyTooLargeException.class)
    public ResponseEntity<ApiResponse.ErrBody> handleBodyTooLarge(BodyTooLargeException error) {
        return ApiResponse.fail(new AppException(ApiErrorCode.PAYLOAD_TOO_LARGE, "请求体过大"));
    }

    /** 参数绑定类错误（等价 TS 版状态码 400 分支） */
    @ExceptionHandler({MethodArgumentTypeMismatchException.class, ServletRequestBindingException.class})
    public ResponseEntity<ApiResponse.ErrBody> handleBinding(Exception error) {
        return ApiResponse.fail(new AppException(ApiErrorCode.VALIDATION_ERROR, "请求格式不正确"));
    }

    /** 兜底：未处理的服务端异常（文案不外露，原始信息进日志） */
    @ExceptionHandler(Exception.class)
    public ResponseEntity<ApiResponse.ErrBody> handleUnexpected(Exception error, HttpServletRequest request) {
        if (causedByBodyTooLarge(error)) {
            return ApiResponse.fail(new AppException(ApiErrorCode.PAYLOAD_TOO_LARGE, "请求体过大"));
        }
        JsonLogger.error("未处理的服务端错误", Map.of("err", error));
        String message = error.getMessage() != null ? error.getMessage() : String.valueOf(error);
        return ApiResponse.fail(Errors.internal(message));
    }

    private static boolean causedByBodyTooLarge(Throwable error) {
        Throwable cursor = error;
        int depth = 0;
        while (cursor != null && depth < 16) {
            if (cursor instanceof BodyTooLargeException) return true;
            cursor = cursor.getCause();
            depth++;
        }
        return false;
    }
}
