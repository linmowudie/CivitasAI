package com.civitas.server.http.validation;

import com.fasterxml.jackson.databind.JsonNode;

import java.util.regex.Pattern;

/**
 * 鉴权相关请求体校验 —— 与 TS 版 `src/http/schemas.ts` 对位（M2 部分）。
 *
 * 字段顺序与 TS 中的 schema 声明保持一致，保证 issues 的报错顺序一致。
 */
public final class AuthBodies {
    private static final Pattern LETTER = Pattern.compile("[A-Za-z]");
    private static final Pattern DIGIT = Pattern.compile("\\d");

    private AuthBodies() {}

    public record RegisterBody(String email, String password, String displayName, String deviceLabel) {}

    public record LoginBody(String email, String password, String deviceLabel) {}

    public record RefreshBody(String refreshToken, String deviceLabel) {}

    public record LogoutBody(String refreshToken, Boolean allDevices) {}

    public record ChangePasswordBody(String currentPassword, String newPassword, String deviceLabel) {}

    public record SendCodeBody(String email, String purpose) {}

    public record LoginWithCodeBody(
            String email,
            String code,
            String displayName,
            String deviceLabel,
            String deviceId,
            String deviceCredential) {}

    public record UpdateProfileBody(String displayName) {}

    public record DeleteAccountBody(String password) {}

    // ── 字段 ────────────────────────────────────────────────────────────

    /** 邮箱：trim + 小写；长度上限防滥用 */
    private static String email(Validator.Obj v, String field) {
        return v.field(field).str().trim().minLen(3, "邮箱过短").maxLen(254, "邮箱过长")
                .email("邮箱格式不正确").lower().text();
    }

    /** 密码：至少 8 位，且必须包含字母与数字（可用符号） */
    private static Validator.Field password(Validator.Obj v, String field) {
        return v.field(field).str().minLen(8, "密码至少 8 位").maxLen(200, "密码过长")
                .regex(LETTER, "密码需包含字母").regex(DIGIT, "密码需包含数字");
    }

    // ── schema ─────────────────────────────────────────────────────────

    public static RegisterBody register(JsonNode body) {
        Validator.Obj v = Validator.object(body, "body");
        String email = email(v, "email");
        String password = password(v, "password").text();
        String displayName = v.field("displayName").nullish().str().trim().minLen(1, null).maxLen(64, null).text();
        String deviceLabel = v.field("deviceLabel").nullish().str().trim().maxLen(64, null).text();
        v.finish();
        return new RegisterBody(email, password, displayName, deviceLabel);
    }

    public static LoginBody login(JsonNode body) {
        Validator.Obj v = Validator.object(body, "body");
        String email = email(v, "email");
        String password = v.field("password").str().minLen(1, "密码必填").maxLen(200, null).text();
        String deviceLabel = v.field("deviceLabel").nullish().str().trim().maxLen(64, null).text();
        v.finish();
        return new LoginBody(email, password, deviceLabel);
    }

    public static RefreshBody refresh(JsonNode body) {
        Validator.Obj v = Validator.object(body, "body");
        String refreshToken = v.field("refreshToken").str().minLen(20, "刷新令牌格式不正确").maxLen(512, null).text();
        String deviceLabel = v.field("deviceLabel").nullish().str().trim().maxLen(64, null).text();
        v.finish();
        return new RefreshBody(refreshToken, deviceLabel);
    }

    public static LogoutBody logout(JsonNode body) {
        Validator.Obj v = Validator.object(body, "body");
        String refreshToken = v.field("refreshToken").optional().str().minLen(20, null).maxLen(512, null).text();
        Boolean allDevices = v.field("allDevices").optional().bool().flag();
        v.refine(refreshToken != null || Boolean.TRUE.equals(allDevices), "需提供 refreshToken 或 allDevices=true");
        v.finish();
        return new LogoutBody(refreshToken, allDevices);
    }

    public static ChangePasswordBody changePassword(JsonNode body) {
        Validator.Obj v = Validator.object(body, "body");
        String currentPassword = v.field("currentPassword").str().minLen(1, "当前密码必填").maxLen(200, null).text();
        String newPassword = password(v, "newPassword").text();
        String deviceLabel = v.field("deviceLabel").nullish().str().trim().maxLen(64, null).text();
        v.finish();
        return new ChangePasswordBody(currentPassword, newPassword, deviceLabel);
    }

    public static SendCodeBody sendCode(JsonNode body) {
        Validator.Obj v = Validator.object(body, "body");
        String email = email(v, "email");
        String purpose = v.field("purpose").defaultTo("login")
                .enumOf("register", "login", "reset_password").text();
        v.finish();
        return new SendCodeBody(email, purpose);
    }

    public static LoginWithCodeBody loginWithCode(JsonNode body) {
        Validator.Obj v = Validator.object(body, "body");
        String email = email(v, "email");
        String code = v.field("code").str().minLen(6, "验证码为6位数字").maxLen(6, null).text();
        String displayName = v.field("displayName").nullish().str().trim().minLen(1, null).maxLen(64, null).text();
        String deviceLabel = v.field("deviceLabel").nullish().str().trim().maxLen(64, null).text();
        String deviceId = v.field("deviceId").nullish().str().trim().maxLen(128, null).text();
        String deviceCredential = v.field("deviceCredential").nullish().str().trim().maxLen(256, null).text();
        v.finish();
        return new LoginWithCodeBody(email, code, displayName, deviceLabel, deviceId, deviceCredential);
    }

    public static UpdateProfileBody updateProfile(JsonNode body) {
        Validator.Obj v = Validator.object(body, "body");
        String displayName = v.field("displayName").nullable().str().trim().maxLen(64, null).text();
        v.finish();
        return new UpdateProfileBody(displayName);
    }

    public static DeleteAccountBody deleteAccount(JsonNode body) {
        Validator.Obj v = Validator.object(body, "body");
        String password = v.field("password").str().minLen(1, "需输入密码以确认注销").maxLen(200, null).text();
        v.finish();
        return new DeleteAccountBody(password);
    }
}
