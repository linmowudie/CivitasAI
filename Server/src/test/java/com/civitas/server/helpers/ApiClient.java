package com.civitas.server.helpers;

import com.civitas.server.json.Json;
import com.fasterxml.jackson.databind.JsonNode;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 轻量 HTTP 客户端 —— 与 TS 版 `test/helpers/app.ts` 的 createClient 对位。
 *
 * 走真实 HTTP（连接运行中的随机端口），因此过滤器链、错误分发、响应头
 * 都与生产路径一致。
 */
public final class ApiClient {
    public record ApiResponse(int status, JsonNode body, String rawBody, HttpResponse<String> raw) {
        public boolean ok() {
            return body != null && body.path("ok").asBoolean();
        }

        public JsonNode data() {
            return body == null ? null : body.path("data");
        }

        public JsonNode error() {
            return body == null ? null : body.path("error");
        }

        public String errorCode() {
            return body == null || ok() ? "" : body.path("error").path("code").asText("");
        }

        public String errorMessage() {
            return body == null || ok() ? "" : body.path("error").path("message").asText("");
        }

        /** 读取响应头（大小写不敏感；缺失时 null） */
        public String header(String name) {
            return raw.headers().firstValue(name).orElse(null);
        }
    }

    private final HttpClient http = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(5))
            .followRedirects(HttpClient.Redirect.NEVER)
            .build();
    private final String baseUrl;

    public ApiClient(int port) {
        this.baseUrl = "http://127.0.0.1:" + port;
    }

    public ApiResponse request(String method, String url, Object payload, String token,
                               Map<String, String> extraHeaders) {
        HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create(baseUrl + url))
                .timeout(Duration.ofSeconds(30));
        Map<String, String> headers = new LinkedHashMap<>();
        if (extraHeaders != null) headers.putAll(extraHeaders);
        if (token != null) headers.put("Authorization", "Bearer " + token);
        String body = null;
        if (payload != null) {
            try {
                body = Json.MAPPER.writeValueAsString(payload);
            } catch (Exception e) {
                throw new IllegalStateException("请求体序列化失败", e);
            }
            if (!headers.containsKey("Content-Type")) headers.put("Content-Type", "application/json");
        }
        for (Map.Entry<String, String> entry : headers.entrySet()) {
            builder.header(entry.getKey(), entry.getValue());
        }
        builder.method(method, body == null
                ? HttpRequest.BodyPublishers.noBody()
                : HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8));

        HttpResponse<String> response = send(builder.build());
        return new ApiResponse(response.statusCode(), parseBody(response.body()), response.body(), response);
    }

    /** 发送原始字符串请求体（用于“非法 JSON”等场景；不进序列化） */
    public ApiResponse postRaw(String url, String rawBody, String token, String contentType) {
        HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create(baseUrl + url))
                .timeout(Duration.ofSeconds(30));
        if (token != null) builder.header("Authorization", "Bearer " + token);
        if (contentType != null) builder.header("Content-Type", contentType);
        builder.POST(HttpRequest.BodyPublishers.ofString(rawBody, StandardCharsets.UTF_8));
        HttpResponse<String> response = send(builder.build());
        return new ApiResponse(response.statusCode(), parseBody(response.body()), response.body(), response);
    }

    private HttpResponse<String> send(HttpRequest request) {
        try {
            return http.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        } catch (Exception e) {
            throw new IllegalStateException("HTTP 请求失败: " + request.method() + " " + request.uri(), e);
        }
    }

    private static JsonNode parseBody(String body) {
        try {
            return Json.MAPPER.readTree(body);
        } catch (Exception ignored) {
            // 非 JSON 响应保留原文，断言时可见
            return null;
        }
    }

    public ApiResponse get(String url, String token) {
        return request("GET", url, null, token, null);
    }

    public ApiResponse post(String url, Object payload, String token) {
        return request("POST", url, payload, token, null);
    }

    public ApiResponse put(String url, Object payload, String token) {
        return request("PUT", url, payload, token, null);
    }

    public ApiResponse patch(String url, Object payload, String token) {
        return request("PATCH", url, payload, token, null);
    }

    public ApiResponse delete(String url, String token) {
        return request("DELETE", url, null, token, null);
    }

    /** 断言辅助：取出成功响应的 data（失败时给出可读错误） */
    public static JsonNode dataOf(ApiResponse response) {
        if (!response.ok()) {
            throw new AssertionError("期望成功响应，实际 " + response.status() + ": " + response.rawBody());
        }
        return response.data();
    }

    /** 断言辅助：取出错误码 */
    public static String errorCodeOf(ApiResponse response) {
        return response.errorCode();
    }

    // ── 鉴权辅助（与 TS 版 createClient 的 register/login 对位）──────────

    public record AuthedUser(JsonNode user, JsonNode tokens) {
        public String accessToken() {
            return tokens.path("accessToken").asText();
        }

        public String refreshToken() {
            return tokens.path("refreshToken").asText();
        }
    }

    public AuthedUser register(String email) {
        return register(email, "Passw0rd123", null);
    }

    /** 注册并返回用户与令牌（失败时抛出可读错误） */
    public AuthedUser register(String email, String password, String displayName) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("email", email);
        payload.put("password", password);
        if (displayName != null) payload.put("displayName", displayName);
        ApiResponse res = post("/v1/auth/register", payload, null);
        if (res.status() != 201 || !res.ok()) {
            throw new AssertionError("注册失败: " + res.status() + " " + res.rawBody());
        }
        return new AuthedUser(res.data().path("user"), res.data().path("tokens"));
    }

    public ApiResponse login(String email) {
        return login(email, "Passw0rd123");
    }

    public ApiResponse login(String email, String password) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("email", email);
        payload.put("password", password);
        return post("/v1/auth/login", payload, null);
    }
}
