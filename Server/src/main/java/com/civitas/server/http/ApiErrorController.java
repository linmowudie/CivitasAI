package com.civitas.server.http;

import com.civitas.server.logging.JsonLogger;
import jakarta.servlet.RequestDispatcher;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.boot.web.servlet.error.ErrorController;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * `/error` 错误分发控制器（替换 Spring 默认的 BasicErrorController）。
 *
 * 触发场景：容器层 sendError（如 URI 非法）等无法进入 @RestControllerAdvice 的路径。
 * 状态码 → 文案映射与 TS 版 `setErrorHandler` 的状态码分支一致。
 */
@RestController
public class ApiErrorController implements ErrorController {

    @RequestMapping("${server.error.path:${error.path:/error}}")
    public ResponseEntity<ApiResponse.ErrBody> handleError(HttpServletRequest request) {
        Object statusAttribute = request.getAttribute(RequestDispatcher.ERROR_STATUS_CODE);
        int status = statusAttribute instanceof Integer value ? value : 0;
        AppException error = switch (status) {
            case 404 -> new AppException(ApiErrorCode.NOT_FOUND, "接口不存在");
            case 413 -> new AppException(ApiErrorCode.PAYLOAD_TOO_LARGE, "请求体过大");
            case 415 -> new AppException(ApiErrorCode.UNSUPPORTED, "不支持的请求格式（需 application/json）");
            case 400 -> new AppException(ApiErrorCode.VALIDATION_ERROR, "请求格式不正确");
            default -> {
                Object thrown = request.getAttribute(RequestDispatcher.ERROR_EXCEPTION);
                String message = thrown instanceof Throwable throwable && throwable.getMessage() != null
                        ? throwable.getMessage()
                        : String.valueOf(request.getAttribute(RequestDispatcher.ERROR_MESSAGE));
                JsonLogger.error("未处理的服务端错误", Map.of("err", Errors.internal(message)));
                yield Errors.internal(message);
            }
        };
        return ApiResponse.fail(error);
    }
}
