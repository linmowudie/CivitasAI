package com.civitas.server.http;

import com.civitas.server.json.Json;
import com.fasterxml.jackson.annotation.JsonInclude;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.http.ResponseEntity;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Map;

/**
 * 统一响应约定 —— 与 TS 版 `src/http/respond.ts` 对位：
 *   成功：{ ok: true,  data: <payload> }
 *   失败：{ ok: false, error: { code, message, details? } }
 *
 * 控制器返回 {@link #ok(Object)}；异常经 GlobalExceptionHandler 返回 {@link #fail(AppException)}；
 * 过滤器（无法走 @RestControllerAdvice）用 {@link #writeError(HttpServletResponse, AppException)} 直写。
 */
public final class ApiResponse {
    private ApiResponse() {}

    public record OkBody<T>(boolean ok, T data) {}

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record ErrorPayload(String code, String message, Map<String, Object> details) {}

    public record ErrBody(boolean ok, ErrorPayload error) {}

    public static <T> OkBody<T> ok(T data) {
        return new OkBody<>(true, data);
    }

    public static <T> ResponseEntity<OkBody<T>> okResponse(T data) {
        return ResponseEntity.ok(ok(data));
    }

    public static <T> ResponseEntity<OkBody<T>> okResponse(T data, int status) {
        return ResponseEntity.status(status).body(ok(data));
    }

    public static ErrBody errorBody(AppException error) {
        return new ErrBody(false, error.toPayload());
    }

    /** 失败响应（RATE_LIMITED 时补 Retry-After：max(1, ceil(retryAfterSec))） */
    public static ResponseEntity<ErrBody> fail(AppException error) {
        ResponseEntity.BodyBuilder builder = ResponseEntity.status(error.status());
        applyRetryAfter(error, builder::header);
        return builder.body(errorBody(error));
    }

    /** 供过滤器使用：直接把错误写成 JSON 响应（含 Retry-After） */
    public static void writeError(HttpServletResponse response, AppException error) throws IOException {
        String json;
        try {
            json = Json.MAPPER.writeValueAsString(errorBody(error));
        } catch (Exception e) {
            // 序列化失败不能反过来打断错误响应：退回最小 JSON
            json = "{\"ok\":false,\"error\":{\"code\":\"INTERNAL\",\"message\":\"服务器内部错误\"}}";
        }
        response.setStatus(error.status());
        response.setContentType("application/json; charset=utf-8");
        applyRetryAfter(error, response::setHeader);
        response.getOutputStream().write(json.getBytes(StandardCharsets.UTF_8));
    }

    private static void applyRetryAfter(AppException error, HeaderSetter setter) {
        if (error.code() != ApiErrorCode.RATE_LIMITED) return;
        Object raw = error.details() == null ? null : error.details().get("retryAfterSec");
        double retryAfter = raw instanceof Number number ? number.doubleValue() : 60;
        setter.set("Retry-After", String.valueOf(Math.max(1, (long) Math.ceil(retryAfter))));
    }

    @FunctionalInterface
    private interface HeaderSetter {
        void set(String name, String value);
    }
}
