package com.civitas.server.routes;

import com.civitas.server.http.ApiResponse;
import com.civitas.server.http.AuthContext;
import com.civitas.server.http.RequireAuth;
import com.civitas.server.http.validation.AuthBodies;
import com.civitas.server.services.AuthService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * 个人资料 / 登录设备 / 登录审计 / 注销账号 —— 与 TS 版 `src/routes/me.ts` 对位。
 */
@RestController
public final class MeController {
    private final AuthService auth;

    public MeController(AuthService auth) {
        this.auth = auth;
    }

    public record SessionsBody(List<AuthService.SessionDto> sessions) {}

    public record SessionRevoked(String revoked) {}

    public record AuditBody(List<AuthService.AuditEntryDto> entries) {}

    public record DeletedBody(boolean deleted) {}

    @GetMapping("/v1/me")
    @RequireAuth
    public ResponseEntity<ApiResponse.OkBody<AuthService.UserDto>> profile(AuthContext authCtx) {
        return ApiResponse.okResponse(auth.getProfile(authCtx.userId()));
    }

    @PatchMapping("/v1/me")
    @RequireAuth
    public ResponseEntity<ApiResponse.OkBody<AuthService.UserDto>> updateProfile(
            AuthContext authCtx, @RequestBody(required = false) JsonNode body) {
        AuthBodies.UpdateProfileBody parsed = AuthBodies.updateProfile(body);
        return ApiResponse.okResponse(auth.updateProfile(authCtx.userId(), parsed.displayName()));
    }

    /** 登录设备（活跃会话） */
    @GetMapping("/v1/me/sessions")
    @RequireAuth
    public ResponseEntity<ApiResponse.OkBody<SessionsBody>> sessions(AuthContext authCtx) {
        return ApiResponse.okResponse(new SessionsBody(auth.listSessions(authCtx.userId())));
    }

    /** 按设备登出 */
    @DeleteMapping("/v1/me/sessions/{sessionId}")
    @RequireAuth
    public ResponseEntity<ApiResponse.OkBody<SessionRevoked>> revokeSession(
            AuthContext authCtx, @PathVariable("sessionId") String sessionId) {
        auth.revokeSession(authCtx.userId(), sessionId == null ? "" : sessionId);
        return ApiResponse.okResponse(new SessionRevoked(sessionId));
    }

    /** 登录/安全审计记录 */
    @GetMapping("/v1/me/audit")
    @RequireAuth
    public ResponseEntity<ApiResponse.OkBody<AuditBody>> audit(
            AuthContext authCtx, @RequestParam(value = "limit", required = false) String limitParam) {
        int limit = auditLimit(limitParam);
        return ApiResponse.okResponse(new AuditBody(auth.listAudit(authCtx.userId(), limit)));
    }

    /**
     * 注销账号：需密码确认；数据随外键级联删除（设置/记忆/统计/令牌）。
     * 审计记录保留（user_id 置空），用于安全追溯。
     */
    @DeleteMapping("/v1/me")
    @RequireAuth
    public ResponseEntity<ApiResponse.OkBody<DeletedBody>> deleteAccount(
            AuthContext authCtx, @RequestBody(required = false) JsonNode body) {
        JsonNode effective = body == null || body.isNull() ? JsonNodeFactory.instance.objectNode() : body;
        AuthBodies.DeleteAccountBody parsed = AuthBodies.deleteAccount(effective);
        auth.deleteAccount(authCtx.userId(), parsed.password());
        return ApiResponse.okResponse(new DeletedBody(true));
    }

    /** 对位 TS：`Math.min(200, Number(q.limit ?? 50) || 50)` */
    private static int auditLimit(String raw) {
        double parsed = 50;
        if (raw != null) {
            try {
                parsed = Double.parseDouble(raw.trim());
            } catch (NumberFormatException e) {
                parsed = 50;
            }
            // JS `NaN || 50` 与 `0 || 50`
            if (Double.isNaN(parsed) || parsed == 0) parsed = 50;
        }
        return (int) Math.min(200, parsed);
    }
}
