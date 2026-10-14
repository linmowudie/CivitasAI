package com.civitas.server.services;

import com.civitas.server.config.ServerConfig;
import com.civitas.server.db.Db;
import com.civitas.server.http.ApiErrorCode;
import com.civitas.server.http.AppException;
import com.civitas.server.http.Errors;
import com.civitas.server.json.IsoTimes;
import com.civitas.server.logging.JsonLogger;
import com.civitas.server.repositories.AuditRepository;
import com.civitas.server.repositories.RefreshTokensRepository;
import com.civitas.server.repositories.UsersRepository;
import com.civitas.server.repositories.VerificationCodesRepository;
import com.civitas.server.security.PasswordService;
import com.civitas.server.security.TokenService;
import com.fasterxml.jackson.annotation.JsonInclude;

import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 账户体系：注册 / 登录 / 刷新（轮换 + 重用检测）/ 登出 / 改密 / 资料 / 设备会话 / 验证码登录
 * —— 与 TS 版 `src/services/authService.ts` 对位。
 *
 * 安全要点：
 *  - 登录失败一律返回同一错误（不区分"邮箱不存在"与"密码错误"），并对不存在的用户做等价耗时校验；
 *  - 刷新令牌轮换：每次刷新签发新令牌并吊销旧的；旧令牌被再次使用 → 判定盗用 → 吊销整族；
 *  - 改密/登出后吊销该用户全部会话（旧访问令牌经 sid 会话回查立即失效，SV-002）。
 */
public final class AuthService {
    private final Db db;
    private final ServerConfig cfg;
    private final MailTransport mail;

    public AuthService(Db db, ServerConfig cfg) {
        this.db = db;
        this.cfg = cfg;
        this.mail = MailTransport.create(cfg.mail());
    }

    // ── DTO ──────────────────────────────────────────────────────────────

    public record TokenBundle(
            String tokenType,
            String accessToken,
            String refreshToken,
            int expiresIn,
            long accessExpiresAt,
            String refreshExpiresAt) {}

    public record UserDto(
            String id,
            String email,
            String displayName,
            String status,
            String createdAt,
            String lastLoginAt,
            String boundDeviceId) {}

    public record SessionDto(
            String sessionId,
            String deviceLabel,
            String userAgent,
            String ip,
            String issuedAt,
            String expiresAt) {}

    public record DeviceDto(
            String deviceId,
            String label,
            String kind,
            String ip,
            String userAgent,
            String firstSeenAt,
            String lastSeenAt,
            boolean isPrimary) {}

    /** 设备信息采集（登录设备列表与审计用） */
    public record DeviceInfo(String label, String userAgent, String ip, String deviceId, String deviceCredential) {}

    // ── 输入 ─────────────────────────────────────────────────────────────

    public record RegisterInput(String email, String password, String displayName) {}

    public record LoginInput(String email, String password) {}

    public record RefreshInput(String refreshToken) {}

    public record LogoutInput(String userId, String refreshToken, Boolean allDevices) {}

    public record ChangePasswordInput(String userId, String currentPassword, String newPassword) {}

    public record LoginWithCodeInput(String email, String code, String displayName) {}

    // ── 结果 ─────────────────────────────────────────────────────────────

    public record AuthResult(UserDto user, TokenBundle tokens) {}

    public record ChangePasswordResult(TokenBundle tokens) {}

    public record LogoutResult(int revoked) {}

    public record SendCodeResult(
            boolean success,
            @JsonInclude(JsonInclude.Include.NON_NULL) String devCode,
            int expiresIn,
            String channel) {}

    public record LoginWithCodeResult(UserDto user, TokenBundle tokens, boolean isNewUser) {}

    private record Issued(TokenBundle bundle, String sessionId, String familyId) {}

    // ── DTO 映射 ─────────────────────────────────────────────────────────

    public static UserDto toUserDto(UsersRepository.UserRow row) {
        return new UserDto(
                row.id(),
                row.email(),
                row.displayName(),
                row.status(),
                IsoTimes.format(row.createdAt()),
                row.lastLoginAt() == null ? null : IsoTimes.format(row.lastLoginAt()),
                row.boundDeviceId());
    }

    public static SessionDto toSessionDto(RefreshTokensRepository.RefreshTokenRow row) {
        return new SessionDto(
                row.id(),
                row.deviceLabel(),
                row.userAgent(),
                row.ip(),
                IsoTimes.format(row.issuedAt()),
                IsoTimes.format(row.expiresAt()));
    }

    /** 签发"访问 + 刷新"令牌对；familyId 传入时表示轮换同一会话家族 */
    private Issued issueTokens(String userId, DeviceInfo device, String familyId) {
        String family = familyId == null ? TokenService.newFamilyId() : familyId;
        TokenService.GeneratedRefreshToken generated = TokenService.generateRefreshToken();
        Instant expiresAt = Instant.now().plus(Duration.ofDays(cfg.auth().refreshTokenTtlDays()));
        RefreshTokensRepository.RefreshTokenRow session = RefreshTokensRepository.insertRefreshToken(db,
                new RefreshTokensRepository.InsertRefreshTokenInput(
                        userId, generated.hash(), family, expiresAt,
                        device.label(), device.userAgent(), device.ip()));
        TokenService.SignedAccessToken access = TokenService.signAccessToken(cfg.auth(), userId, session.id());
        return new Issued(
                new TokenBundle(
                        "Bearer",
                        access.token(),
                        generated.raw(),
                        access.expiresIn(),
                        access.expiresAtMs(),
                        IsoTimes.format(expiresAt)),
                session.id(),
                family);
    }

    private Map<String, Object> auditDetail(Object... keyValues) {
        Map<String, Object> map = new LinkedHashMap<>();
        for (int i = 0; i + 1 < keyValues.length; i += 2) {
            map.put(String.valueOf(keyValues[i]), keyValues[i + 1]);
        }
        return map;
    }

    private void audit(String userId, String action, String outcome, DeviceInfo device, Map<String, Object> detail) {
        AuditRepository.recordAudit(db, new AuditRepository.AuditInput(
                userId, action, outcome,
                device == null ? null : device.ip(),
                device == null ? null : device.userAgent(),
                detail));
    }

    // ── 注册 / 登录 ──────────────────────────────────────────────────────

    public AuthResult register(RegisterInput input, DeviceInfo device) {
        String passwordHash = PasswordService.hashPassword(input.password());
        UsersRepository.UserRow created = UsersRepository.createUser(db, new UsersRepository.CreateUserInput(
                input.email(), input.email().toLowerCase(), passwordHash, input.displayName()));
        audit(created.id(), "auth.register", "success", device, null);
        Issued issued = issueTokens(created.id(), device, null);
        return new AuthResult(toUserDto(created), issued.bundle());
    }

    public AuthResult login(LoginInput input, DeviceInfo device) {
        UsersRepository.UserRow row = UsersRepository.findUserByEmail(db, input.email().toLowerCase());
        if (row == null) {
            // 等价耗时：避免通过响应时间枚举已注册邮箱
            PasswordService.fakeVerify();
            audit(null, "auth.login", "failure", device, auditDetail("reason", "user_not_found"));
            throw Errors.invalidCredentials();
        }
        if (!PasswordService.verifyPassword(row.passwordHash(), input.password())) {
            audit(row.id(), "auth.login", "failure", device, auditDetail("reason", "bad_password"));
            throw Errors.invalidCredentials();
        }
        if (!"active".equals(row.status())) {
            audit(row.id(), "auth.login", "failure", device, auditDetail("reason", "disabled"));
            throw Errors.forbidden("账号已停用，请联系管理员");
        }

        UsersRepository.touchLastLogin(db, row.id());
        audit(row.id(), "auth.login", "success", device, null);
        Issued issued = issueTokens(row.id(), device, null);
        UsersRepository.UserRow fresh = UsersRepository.findUserById(db, row.id());
        return new AuthResult(toUserDto(fresh != null ? fresh : row), issued.bundle());
    }

    // ── 刷新 / 登出 / 改密 ───────────────────────────────────────────────

    public AuthResult refresh(RefreshInput input, DeviceInfo device) {
        String hash = TokenService.hashRefreshToken(input.refreshToken());
        RefreshTokensRepository.RefreshTokenRow session = RefreshTokensRepository.findByHash(db, hash);
        if (session == null) {
            audit(null, "auth.refresh", "failure", device, auditDetail("reason", "unknown_token"));
            throw Errors.unauthenticated("刷新令牌无效");
        }

        // 已吊销的令牌被再次使用 → 视为泄漏：吊销整族
        if (session.revokedAt() != null) {
            int revoked = RefreshTokensRepository.revokeFamily(db, session.familyId(), "token_reuse_detected");
            audit(session.userId(), "auth.refresh", "failure", device,
                    auditDetail("reason", "token_reuse", "familyId", session.familyId(), "revokedSessions", revoked));
            throw new AppException(ApiErrorCode.TOKEN_REUSED,
                    "检测到刷新令牌被重复使用，该会话已全部失效，请重新登录");
        }

        if (!session.expiresAt().isAfter(Instant.now())) {
            RefreshTokensRepository.revokeById(db, session.id(), "expired");
            throw new AppException(ApiErrorCode.TOKEN_EXPIRED, "登录已过期，请重新登录");
        }

        UsersRepository.UserRow user = UsersRepository.findUserById(db, session.userId());
        if (user == null || !"active".equals(user.status())) {
            RefreshTokensRepository.revokeAllForUser(db, session.userId(), "user_inactive");
            throw Errors.unauthenticated("账号不可用，请重新登录");
        }

        // 轮换：同族签发新令牌，旧令牌立即失效（除非显式允许重用）
        Issued issued = issueTokens(user.id(), device, session.familyId());
        if (!cfg.auth().allowRefreshReuse()) {
            RefreshTokensRepository.revokeById(db, session.id(), "rotated");
            RefreshTokensRepository.markRotated(db, session.id(), issued.sessionId());
        }
        return new AuthResult(toUserDto(user), issued.bundle());
    }

    public LogoutResult logout(LogoutInput input, DeviceInfo device) {
        int revoked = 0;
        if (Boolean.TRUE.equals(input.allDevices())) {
            revoked = RefreshTokensRepository.revokeAllForUser(db, input.userId(), "logout_all");
        } else if (input.refreshToken() != null && !input.refreshToken().isEmpty()) {
            RefreshTokensRepository.RefreshTokenRow session =
                    RefreshTokensRepository.findByHash(db, TokenService.hashRefreshToken(input.refreshToken()));
            if (session != null && session.userId().equals(input.userId())) {
                RefreshTokensRepository.revokeById(db, session.id(), "logout");
                revoked = 1;
            }
        } else {
            throw Errors.unauthenticated("缺少 refreshToken（或使用 allDevices=true 登出全部设备）");
        }
        audit(input.userId(), Boolean.TRUE.equals(input.allDevices()) ? "auth.logout_all" : "auth.logout",
                "success", device, auditDetail("revoked", revoked));
        return new LogoutResult(revoked);
    }

    public ChangePasswordResult changePassword(ChangePasswordInput input, DeviceInfo device) {
        UsersRepository.UserRow user = UsersRepository.findUserById(db, input.userId());
        if (user == null) throw Errors.notFound("用户不存在");

        if (!PasswordService.verifyPassword(user.passwordHash(), input.currentPassword())) {
            audit(user.id(), "auth.change_password", "failure", device,
                    auditDetail("reason", "bad_current_password"));
            throw Errors.invalidCredentials();
        }
        if (input.currentPassword().equals(input.newPassword())) {
            throw Errors.conflict("新密码不能与当前密码相同", null);
        }

        String passwordHash = PasswordService.hashPassword(input.newPassword());
        UsersRepository.UserRow target = user;
        db.tx(tx -> {
            UsersRepository.updatePasswordHash(tx, target.id(), passwordHash);
            RefreshTokensRepository.revokeAllForUser(tx, target.id(), "password_changed");
            return null;
        });
        audit(user.id(), "auth.change_password", "success", device, null);
        // 当前设备换发新令牌，其他设备需重新登录
        Issued issued = issueTokens(user.id(), device, null);
        return new ChangePasswordResult(issued.bundle());
    }

    // ── 资料 / 会话 / 设备 ───────────────────────────────────────────────

    public UserDto getProfile(String userId) {
        UsersRepository.UserRow user = UsersRepository.findUserById(db, userId);
        if (user == null) throw Errors.notFound("用户不存在");
        return toUserDto(user);
    }

    public UserDto updateProfile(String userId, String displayName) {
        UsersRepository.UserRow updated = UsersRepository.updateDisplayName(db, userId, displayName);
        if (updated == null) throw Errors.notFound("用户不存在");
        return toUserDto(updated);
    }

    public List<SessionDto> listSessions(String userId) {
        return RefreshTokensRepository.listActiveSessions(db, userId).stream()
                .map(AuthService::toSessionDto)
                .toList();
    }

    public record AuditEntryDto(
            String action,
            String outcome,
            String ip,
            String userAgent,
            Object detail,
            String createdAt) {}

    /** 登录/安全审计记录（个人中心"登录记录"用） */
    public List<AuditEntryDto> listAudit(String userId, int limit) {
        return AuditRepository.listAuditForUser(db, userId, limit).stream()
                .map(row -> new AuditEntryDto(
                        row.action(),
                        row.outcome(),
                        row.ip(),
                        row.userAgent(),
                        AuditRepository.detailToJson(row.detail()),
                        IsoTimes.format(row.createdAt())))
                .toList();
    }

    /**
     * 注销账号：需密码确认；数据随外键级联删除（设置/记忆/统计/令牌）。
     * 审计记录保留（user_id 置空），用于安全追溯。
     */
    public void deleteAccount(String userId, String password) {
        UsersRepository.UserRow user = UsersRepository.findUserById(db, userId);
        if (user == null) throw Errors.notFound("用户不存在");
        if (!PasswordService.verifyPassword(user.passwordHash(), password)) {
            throw Errors.invalidCredentials();
        }
        db.tx(tx -> {
            tx.execute("UPDATE audit_log SET user_id = NULL WHERE user_id = $1", userId);
            UsersRepository.deleteUser(tx, userId);
            return null;
        });
    }

    public void revokeSession(String userId, String sessionId) {
        RefreshTokensRepository.RefreshTokenRow session = RefreshTokensRepository.findById(db, sessionId);
        if (session == null) throw Errors.notFound("会话不存在");
        if (!session.userId().equals(userId)) throw Errors.forbidden("无权操作该会话");
        RefreshTokensRepository.revokeById(db, sessionId, "revoked_by_user");
        AuditRepository.recordAudit(db, new AuditRepository.AuditInput(
                userId, "auth.revoke_session", "success", null, null, auditDetail("sessionId", sessionId)));
    }

    public List<DeviceDto> listDevices(String userId) {
        return UsersRepository.listUserDevices(db, userId).stream()
                .map(row -> new DeviceDto(
                        row.deviceId(),
                        row.deviceLabel(),
                        row.deviceKind(),
                        row.ip(),
                        row.userAgent(),
                        IsoTimes.format(row.boundAt()),
                        row.lastSeenAt() == null ? null : IsoTimes.format(row.lastSeenAt()),
                        row.isPrimary()))
                .toList();
    }

    /**
     * 移除设备（解绑）——"换机/重装后被设备策略挡住"的官方恢复路径：
     * 用户在任一已登录设备上移除旧设备，即可在新设备上完成登录（严格模式）。
     */
    public void revokeDevice(String userId, String deviceId) {
        boolean revoked = UsersRepository.revokeDevice(db, userId, deviceId);
        AuditRepository.recordAudit(db, new AuditRepository.AuditInput(
                userId, "auth.revoke_device", revoked ? "success" : "failure", null, null,
                auditDetail("deviceId", deviceId, "revoked", revoked)));
        if (!revoked) throw Errors.notFound("设备不存在或已移除");
    }

    // ── 验证码认证 ────────────────────────────────────────────────────────

    /** 发送验证码到邮箱（未配置邮件通道时降级为控制台，仅开发） */
    public SendCodeResult sendVerificationCode(String email, String purpose) {
        String emailLower = email.toLowerCase();

        // ① 发送配额（按邮箱，防刷码/信箱轰炸）
        int recent = VerificationCodesRepository.countRecentCodes(db, emailLower, purpose, cfg.auth().codeWindowSec());
        if (recent >= cfg.auth().codeMaxPerWindow()) {
            audit(null, "auth.send_code", "failure", null,
                    auditDetail("reason", "quota_exceeded", "email", emailLower, "purpose", purpose));
            throw Errors.rateLimited(cfg.auth().codeWindowSec());
        }

        // ② 冷却（两次发送最小间隔）
        Instant last = VerificationCodesRepository.lastIssuedAt(db, emailLower, purpose);
        if (last != null) {
            double elapsedSec = (System.currentTimeMillis() - last.toEpochMilli()) / 1000.0;
            if (elapsedSec < cfg.auth().codeResendCooldownSec()) {
                throw Errors.rateLimited((int) Math.ceil(cfg.auth().codeResendCooldownSec() - elapsedSec));
            }
        }

        // ③ 生成（CSPRNG）并**只存哈希**；签发新码会作废该邮箱同用途的旧码
        String code = VerificationCodesRepository.generateCode();
        long ttlMs = cfg.auth().codeTtlSec() * 1000L;
        VerificationCodesRepository.createVerificationCode(db, new VerificationCodesRepository.CreateCodeInput(
                emailLower, code, purpose, ttlMs));

        // ④ 投递：webhook（生产）或控制台（开发）
        int minutes = (int) Math.round(cfg.auth().codeTtlSec() / 60.0);
        mail.send(new MailTransport.MailMessage(
                email,
                "Civitas-AI 登录验证码",
                "你的登录验证码是 " + code + "，" + minutes + " 分钟内有效。若非本人操作请忽略本邮件。"));
        if ("console".equals(mail.name())) {
            Map<String, Object> fields = new LinkedHashMap<>();
            fields.put("source", "authService");
            fields.put("email", emailLower);
            fields.put("purpose", purpose);
            fields.put("code", code);
            fields.put("mailConfigured", MailTransport.isMailConfigured(cfg.mail()));
            JsonLogger.warn("验证码未通过邮件送达（控制台通道，仅开发）", fields);
        }

        audit(null, "auth.send_code", "success", null,
                auditDetail("email", emailLower, "purpose", purpose, "channel", mail.name()));

        return new SendCodeResult(
                true,
                // 仅当显式开启且非生产环境才回传（生产由 config 拒绝启动）
                cfg.auth().allowDevCode() ? code : null,
                cfg.auth().codeTtlSec(),
                mail.name());
    }

    /** 使用验证码登录（自动注册新用户） */
    public LoginWithCodeResult loginWithCode(LoginWithCodeInput input, DeviceInfo device) {
        String emailLower = input.email().toLowerCase();

        // ① 查找有效验证码（未过期 + 未使用 + 未超失败次数）
        VerificationCodesRepository.VerificationCodeRow validCode =
                VerificationCodesRepository.findValidCode(db, emailLower, "login", cfg.auth().codeMaxAttempts());
        if (validCode == null) {
            PasswordService.fakeVerify(); // 等价耗时，避免通过响应时间判断"是否存在待用验证码"
            audit(null, "auth.login_with_code", "failure", device,
                    auditDetail("reason", "code_not_found_or_locked", "email", emailLower));
            throw Errors.invalidCredentials("验证码无效或已过期，请重新获取");
        }

        // ② 哈希 + 常量时间比较（明文不落库，SV-012）
        if (!VerificationCodesRepository.verifyCodeHash(validCode.codeHash(), input.code())) {
            VerificationCodesRepository.FailedAttempt attempt =
                    VerificationCodesRepository.registerFailedAttempt(db, validCode.id(), cfg.auth().codeMaxAttempts());
            audit(null, "auth.login_with_code", "failure", device,
                    auditDetail("reason", "code_mismatch", "email", emailLower,
                            "attempts", attempt.attempts(), "invalidated", attempt.invalidated()));
            throw Errors.invalidCredentials(attempt.invalidated()
                    ? "验证码错误次数过多（" + attempt.attempts() + " 次），该验证码已作废，请重新获取"
                    : "验证码错误");
        }

        // ③ 标记验证码已使用（一次性）
        VerificationCodesRepository.markCodeUsed(db, validCode.id());

        // ④ 查找或创建用户
        UsersRepository.UserRow user = UsersRepository.findUserByEmail(db, emailLower);
        boolean isNewUser = false;

        if (user == null) {
            // 自动注册（随机密码哈希：该账号仅走验证码登录；后续可通过改密设置密码）
            String randomPasswordHash = PasswordService.hashPassword(TokenService.generateRefreshToken().raw());
            user = UsersRepository.createUser(db, new UsersRepository.CreateUserInput(
                    input.email(), emailLower, randomPasswordHash, input.displayName()));
            isNewUser = true;
            audit(user.id(), "auth.register_with_code", "success", device, null);
        }

        // ⑤ 设备处理（安全审计修复：默认不再硬拒绝新设备）
        boolean deviceRecorded = false;
        boolean isNewDevice = false;
        String mode = cfg.auth().deviceBindingMode().name();
        boolean hasDeviceId = device.deviceId() != null && !device.deviceId().isEmpty();
        if (!"off".equals(mode) && hasDeviceId) {
            boolean trusted = UsersRepository.isDeviceTrusted(db, user.id(), device.deviceId());
            // 严格模式：拒绝**未登记**设备；但首个设备必须放行——
            // 验证码已证明邮箱控制权，否则新账号在严格模式下永远无法完成首次登录。
            boolean strictBlocked = "strict".equals(mode) && !trusted
                    && !UsersRepository.listUserDevices(db, user.id()).isEmpty();
            if (strictBlocked) {
                audit(user.id(), "auth.login_with_code", "failure", device,
                        auditDetail("reason", "device_not_registered",
                                "requestedDevice", device.deviceId(), "mode", mode));
                throw Errors.forbidden("该账号处于严格设备模式：请先在已登录设备的「账号 → 登录设备」中移除旧设备，再于本机重试");
            }
            boolean hasCredential = device.deviceCredential() != null && !device.deviceCredential().isEmpty();
            UsersRepository.DeviceUpsert upsert = UsersRepository.upsertDevice(db, user.id(), device.deviceId(),
                    new UsersRepository.DeviceUpsertOptions(
                            device.label(), device.userAgent(), device.ip(),
                            hasCredential ? device.deviceCredential() : null,
                            hasCredential ? "install" : "legacy"));
            deviceRecorded = true;
            isNewDevice = upsert.isNew();
            if (isNewDevice) {
                audit(user.id(), "auth.new_device", "success", device,
                        auditDetail("deviceId", device.deviceId(), "mode", mode));
            } else {
                UsersRepository.touchDevice(db, user.id(), device.deviceId(), device.ip());
            }
        }

        // ⑥ 账号状态
        if (!"active".equals(user.status())) {
            throw Errors.forbidden("账号已停用，请联系管理员");
        }

        // ⑦ 更新最后登录时间
        UsersRepository.touchLastLogin(db, user.id());

        audit(user.id(), "auth.login_with_code", "success", device,
                auditDetail("isNewUser", isNewUser, "deviceRecorded", deviceRecorded,
                        "isNewDevice", isNewDevice, "deviceMode", mode));

        // 签发令牌
        Issued issued = issueTokens(user.id(), device, null);
        UsersRepository.UserRow fresh = UsersRepository.findUserById(db, user.id());
        return new LoginWithCodeResult(toUserDto(fresh != null ? fresh : user), issued.bundle(), isNewUser);
    }
}
