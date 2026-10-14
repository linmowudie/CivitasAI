package com.civitas.server.routes;

import com.civitas.server.config.ServerConfig;
import com.civitas.server.http.ApiErrorCode;
import com.civitas.server.http.ApiResponse;
import com.civitas.server.http.AppException;
import com.civitas.server.http.AuthContext;
import com.civitas.server.http.ClientIp;
import com.civitas.server.http.RequireAuth;
import com.civitas.server.http.validation.AuthBodies;
import com.civitas.server.services.AuthService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;


/**
 * 账户路由：注册 / 登录 / 刷新 / 登出 / 改密 / 验证码 / 设备管理
 * —— 与 TS 版 `src/routes/auth.ts` 对位。
 */
@RestController
public final class AuthController {
    private final AuthService auth;
    private final ServerConfig cfg;

    public AuthController(AuthService auth, ServerConfig cfg) {
        this.auth = auth;
        this.cfg = cfg;
    }

    public record DevicesBody(List<AuthService.DeviceDto> devices) {}

    public record DeviceRevoked(boolean revoked) {}

    @PostMapping("/v1/auth/register")
    public ResponseEntity<ApiResponse.OkBody<AuthService.AuthResult>> register(
            @RequestBody(required = false) JsonNode body, HttpServletRequest request) {
        AuthBodies.RegisterBody parsed = AuthBodies.register(body);
        AuthService.AuthResult result = auth.register(
                new AuthService.RegisterInput(parsed.email(), parsed.password(), parsed.displayName()),
                deviceOf(request, parsed.deviceLabel(), null, null));
        return ApiResponse.okResponse(result, 201);
    }

    @PostMapping("/v1/auth/login")
    public ResponseEntity<ApiResponse.OkBody<AuthService.AuthResult>> login(
            @RequestBody(required = false) JsonNode body, HttpServletRequest request) {
        AuthBodies.LoginBody parsed = AuthBodies.login(body);
        AuthService.AuthResult result = auth.login(
                new AuthService.LoginInput(parsed.email(), parsed.password()),
                deviceOf(request, parsed.deviceLabel(), null, null));
        return ApiResponse.okResponse(result);
    }

    @PostMapping("/v1/auth/refresh")
    public ResponseEntity<ApiResponse.OkBody<AuthService.AuthResult>> refresh(
            @RequestBody(required = false) JsonNode body, HttpServletRequest request) {
        AuthBodies.RefreshBody parsed = AuthBodies.refresh(body);
        AuthService.AuthResult result = auth.refresh(
                new AuthService.RefreshInput(parsed.refreshToken()),
                deviceOf(request, parsed.deviceLabel(), null, null));
        return ApiResponse.okResponse(result);
    }

    @PostMapping("/v1/auth/logout")
    @RequireAuth
    public ResponseEntity<ApiResponse.OkBody<AuthService.LogoutResult>> logout(
            AuthContext authCtx, @RequestBody(required = false) JsonNode body, HttpServletRequest request) {
        AuthBodies.LogoutBody parsed = AuthBodies.logout(orEmpty(body));
        AuthService.LogoutResult result = auth.logout(
                new AuthService.LogoutInput(authCtx.userId(), parsed.refreshToken(), parsed.allDevices()),
                deviceOf(request, null, null, null));
        return ApiResponse.okResponse(result);
    }

    @PostMapping("/v1/auth/change-password")
    @RequireAuth
    public ResponseEntity<ApiResponse.OkBody<AuthService.ChangePasswordResult>> changePassword(
            AuthContext authCtx, @RequestBody(required = false) JsonNode body, HttpServletRequest request) {
        AuthBodies.ChangePasswordBody parsed = AuthBodies.changePassword(body);
        AuthService.ChangePasswordResult result = auth.changePassword(
                new AuthService.ChangePasswordInput(authCtx.userId(), parsed.currentPassword(), parsed.newPassword()),
                deviceOf(request, parsed.deviceLabel(), null, null));
        return ApiResponse.okResponse(result);
    }

    // ── 验证码认证 ────────────────────────────────────────────────────────

    @PostMapping("/v1/auth/send-code")
    public ResponseEntity<ApiResponse.OkBody<AuthService.SendCodeResult>> sendCode(
            @RequestBody(required = false) JsonNode body) {
        AuthBodies.SendCodeBody parsed = AuthBodies.sendCode(body);
        return ApiResponse.okResponse(auth.sendVerificationCode(parsed.email(), parsed.purpose()));
    }

    @PostMapping("/v1/auth/login-with-code")
    public ResponseEntity<ApiResponse.OkBody<AuthService.LoginWithCodeResult>> loginWithCode(
            @RequestBody(required = false) JsonNode body, HttpServletRequest request) {
        AuthBodies.LoginWithCodeBody parsed = AuthBodies.loginWithCode(body);
        AuthService.LoginWithCodeResult result = auth.loginWithCode(
                new AuthService.LoginWithCodeInput(parsed.email(), parsed.code(), parsed.displayName()),
                deviceOf(request, parsed.deviceLabel(), parsed.deviceId(), parsed.deviceCredential()));
        return ApiResponse.okResponse(result);
    }

    // ── 设备管理（自助）────────────────────────────────────────────────────
    // 严格设备模式下的官方恢复路径：在任一已登录设备上移除旧设备

    @GetMapping("/v1/me/devices")
    @RequireAuth
    public ResponseEntity<ApiResponse.OkBody<DevicesBody>> listDevices(AuthContext authCtx) {
        return ApiResponse.okResponse(new DevicesBody(auth.listDevices(authCtx.userId())));
    }

    @DeleteMapping("/v1/me/devices/{deviceId}")
    @RequireAuth
    public ResponseEntity<ApiResponse.OkBody<DeviceRevoked>> revokeDevice(
            AuthContext authCtx, @PathVariable("deviceId") String deviceId) {
        if (deviceId == null || deviceId.isEmpty()) {
            throw new AppException(ApiErrorCode.VALIDATION_ERROR, "deviceId is required");
        }
        auth.revokeDevice(authCtx.userId(), deviceId);
        return ApiResponse.okResponse(new DeviceRevoked(true));
    }

    // ── 内部 ─────────────────────────────────────────────────────────────

    private AuthService.DeviceInfo deviceOf(
            HttpServletRequest request, String label, String deviceId, String deviceCredential) {
        return new AuthService.DeviceInfo(
                label,
                request.getHeader("User-Agent"),
                ClientIp.of(request, cfg.trustProxy()),
                deviceId,
                deviceCredential);
    }

    /** 对位 TS 的 `request.body ?? {}`（缺失/null 体按空对象处理） */
    private static JsonNode orEmpty(JsonNode body) {
        return body == null || body.isNull() ? JsonNodeFactory.instance.objectNode() : body;
    }
}
