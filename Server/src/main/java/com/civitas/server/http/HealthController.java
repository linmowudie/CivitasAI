package com.civitas.server.http;

import com.civitas.server.db.Db;
import com.civitas.server.util.Uptime;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.Map;

/** 健康检查（不参与限流与鉴权）—— 与 TS 版 `src/app.ts` 的 /healthz 与 /readyz 对位 */
@RestController
public class HealthController {
    private final Db db;

    public HealthController(Db db) {
        this.db = db;
    }

    @GetMapping("/healthz")
    public ResponseEntity<ApiResponse.OkBody<Map<String, Object>>> healthz() {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("status", "ok");
        body.put("uptimeSec", Uptime.seconds());
        return ApiResponse.okResponse(body);
    }

    @GetMapping("/readyz")
    public ResponseEntity<ApiResponse.OkBody<Map<String, Object>>> readyz() {
        if (!db.ping()) {
            // SV-008：失败响应走 AppError + 统一错误链（503 由 UNAVAILABLE 承载）
            throw Errors.unavailable("数据库不可用", null);
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("status", "ready");
        body.put("db", "up");
        return ApiResponse.okResponse(body);
    }
}
