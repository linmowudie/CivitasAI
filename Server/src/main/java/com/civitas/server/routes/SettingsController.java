package com.civitas.server.routes;

import com.civitas.server.http.ApiResponse;
import com.civitas.server.http.AuthContext;
import com.civitas.server.http.RequireAuth;
import com.civitas.server.http.validation.SettingsBodies;
import com.civitas.server.services.SettingsService;
import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/**
 * 设置管理：GET / PUT（整体）/ PATCH（浅合并）—— 与 TS 版 `src/routes/settings.ts` 对位。
 */
@RestController
public final class SettingsController {
    private final SettingsService settings;

    public SettingsController(SettingsService settings) {
        this.settings = settings;
    }

    public record ResetBody(boolean reset) {}

    @GetMapping("/v1/settings")
    @RequireAuth
    public ResponseEntity<ApiResponse.OkBody<SettingsService.SettingsDto>> get(AuthContext authCtx) {
        return ApiResponse.okResponse(settings.get(authCtx.userId()));
    }

    /** 整体替换（expectedRevision 传入时做乐观并发校验） */
    @PutMapping("/v1/settings")
    @RequireAuth
    public ResponseEntity<ApiResponse.OkBody<SettingsService.SettingsDto>> put(
            AuthContext authCtx, @RequestBody(required = false) JsonNode body) {
        SettingsBodies.PutBody parsed = SettingsBodies.put(body);
        return ApiResponse.okResponse(settings.put(authCtx.userId(), parsed.data(), parsed.expectedRevision()));
    }

    /** 浅合并：值为 null 表示删除该键 */
    @PatchMapping("/v1/settings")
    @RequireAuth
    public ResponseEntity<ApiResponse.OkBody<SettingsService.SettingsDto>> patch(
            AuthContext authCtx, @RequestBody(required = false) JsonNode body) {
        SettingsBodies.PatchBody parsed = SettingsBodies.patch(body);
        return ApiResponse.okResponse(settings.patch(authCtx.userId(), parsed.patch(), parsed.expectedRevision()));
    }

    /** 重置为默认（删除服务端设置记录） */
    @DeleteMapping("/v1/settings")
    @RequireAuth
    public ResponseEntity<ApiResponse.OkBody<ResetBody>> reset(AuthContext authCtx) {
        settings.reset(authCtx.userId());
        return ApiResponse.okResponse(new ResetBody(true));
    }
}
