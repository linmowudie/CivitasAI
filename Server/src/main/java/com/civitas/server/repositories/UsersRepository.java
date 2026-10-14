package com.civitas.server.repositories;

import com.civitas.server.db.Db;
import com.civitas.server.http.Errors;
import com.civitas.server.security.Hashes;

import java.sql.SQLException;
import java.time.Instant;
import java.util.List;
import java.util.Map;

/**
 * 用户表读写 —— 与 TS 版 `src/repositories/users.ts` 对位（含设备登记）。
 */
public final class UsersRepository {
    private UsersRepository() {}

    private static final String COLUMNS = "id, email, email_lower, password_hash, display_name, status, "
            + "created_at, updated_at, last_login_at, password_changed_at, bound_device_id, device_bound_at";

    public record UserRow(
            String id,
            String email,
            String emailLower,
            String passwordHash,
            String displayName,
            String status,
            Instant createdAt,
            Instant updatedAt,
            Instant lastLoginAt,
            Instant passwordChangedAt,
            String boundDeviceId,
            Instant deviceBoundAt) {}

    public record UserDeviceRow(
            String id,
            String userId,
            String deviceId,
            String deviceLabel,
            String userAgent,
            String ip,
            boolean isPrimary,
            Instant boundAt,
            Instant revokedAt,
            String credentialHash,
            String deviceKind,
            Instant lastSeenAt) {}

    public record CreateUserInput(String email, String emailLower, String passwordHash, String displayName) {}

    public record DeviceUpsertOptions(String label, String userAgent, String ip, String credential, String kind) {}

    private static UserRow mapUser(Map<String, Object> row) {
        if (row == null) return null;
        return new UserRow(
                Db.str(row, "id"),
                Db.str(row, "email"),
                Db.str(row, "email_lower"),
                Db.str(row, "password_hash"),
                Db.str(row, "display_name"),
                Db.str(row, "status"),
                Db.instantOf(row, "created_at"),
                Db.instantOf(row, "updated_at"),
                Db.instantOf(row, "last_login_at"),
                Db.instantOf(row, "password_changed_at"),
                Db.str(row, "bound_device_id"),
                Db.instantOf(row, "device_bound_at"));
    }

    /** 创建用户；邮箱冲突抛 CONFLICT */
    public static UserRow createUser(Db db, CreateUserInput input) {
        try {
            Map<String, Object> row = db.one(
                    "INSERT INTO users (email, email_lower, password_hash, display_name) "
                            + "VALUES ($1, $2, $3, $4) RETURNING " + COLUMNS,
                    input.email(), input.emailLower(), input.passwordHash(), input.displayName());
            if (row == null) throw Errors.conflict("用户创建失败", null);
            return mapUser(row);
        } catch (RuntimeException err) {
            if (isUniqueViolation(err)) {
                throw Errors.conflict("该邮箱已被注册", null);
            }
            throw err;
        }
    }

    public static UserRow findUserByEmail(Db db, String emailLower) {
        return mapUser(db.one("SELECT " + COLUMNS + " FROM users WHERE email_lower = $1", emailLower));
    }

    public static UserRow findUserById(Db db, String id) {
        return mapUser(db.one("SELECT " + COLUMNS + " FROM users WHERE id = $1", id));
    }

    public static UserRow updateDisplayName(Db db, String id, String displayName) {
        return mapUser(db.one(
                "UPDATE users SET display_name = $2, updated_at = now() WHERE id = $1 RETURNING " + COLUMNS,
                id, displayName));
    }

    public static void updatePasswordHash(Db db, String id, String passwordHash) {
        db.execute(
                "UPDATE users SET password_hash = $2, password_changed_at = now(), updated_at = now() WHERE id = $1",
                id, passwordHash);
    }

    public static void touchLastLogin(Db db, String id) {
        db.execute("UPDATE users SET last_login_at = now() WHERE id = $1", id);
    }

    public static void setUserStatus(Db db, String id, String status) {
        db.execute("UPDATE users SET status = $2, updated_at = now() WHERE id = $1", id, status);
    }

    /** 注销账号：级联删除该用户全部数据（设置/记忆/统计/令牌/审计保留匿名记录） */
    public static boolean deleteUser(Db db, String id) {
        return db.execute("DELETE FROM users WHERE id = $1", id) > 0;
    }

    /** PG 唯一约束冲突（23505）—— Spring 会把 SQLException 包装进 DataAccessException */
    public static boolean isUniqueViolation(Throwable err) {
        Throwable current = err;
        while (current != null) {
            if (current instanceof SQLException sql && "23505".equals(sql.getSQLState())) return true;
            current = current.getCause();
        }
        return false;
    }

    // ── 设备登记 ──────────────────────────────────────────────────────────

    private static UserDeviceRow mapDevice(Map<String, Object> row) {
        if (row == null) return null;
        return new UserDeviceRow(
                Db.str(row, "id"),
                Db.str(row, "user_id"),
                Db.str(row, "device_id"),
                Db.str(row, "device_label"),
                Db.str(row, "user_agent"),
                Db.str(row, "ip"),
                Db.bool(row, "is_primary"),
                Db.instantOf(row, "bound_at"),
                Db.instantOf(row, "revoked_at"),
                Db.str(row, "credential_hash"),
                Db.str(row, "device_kind"),
                Db.instantOf(row, "last_seen_at"));
    }

    /**
     * 登记/更新设备（登录时调用）。
     *
     * 设备由客户端安装期生成的稳定凭据标识，服务端只存 `sha256(credential)`；
     * 是否拒绝新设备由配置模式决定（off / warn / strict），默认 warn。
     */
    public static DeviceUpsert upsertDevice(Db db, String userId, String deviceId, DeviceUpsertOptions options) {
        return db.tx(tx -> {
            Map<String, Object> existing = tx.one(
                    "SELECT * FROM user_devices WHERE user_id = $1 AND device_id = $2", userId, deviceId);
            String credentialHash = options.credential() != null && !options.credential().isEmpty()
                    ? Hashes.sha256Hex(options.credential())
                    : null;
            Map<String, Object> row = tx.one(
                    "INSERT INTO user_devices (user_id, device_id, device_label, user_agent, ip, credential_hash, device_kind, last_seen_at) "
                            + "VALUES ($1, $2, $3, $4, $5, $6, $7, now()) "
                            + "ON CONFLICT (user_id, device_id) "
                            + "DO UPDATE SET device_label = COALESCE(EXCLUDED.device_label, user_devices.device_label), "
                            + "              user_agent = EXCLUDED.user_agent, "
                            + "              ip = EXCLUDED.ip, "
                            + "              credential_hash = COALESCE(EXCLUDED.credential_hash, user_devices.credential_hash), "
                            + "              device_kind = EXCLUDED.device_kind, "
                            + "              last_seen_at = now(), "
                            + "              revoked_at = NULL "
                            + "RETURNING *",
                    userId, deviceId, options.label(), options.userAgent(), options.ip(), credentialHash,
                    options.kind() == null ? "install" : options.kind());
            if (row == null) {
                throw new IllegalStateException(
                        "设备登记失败：user_devices 未返回记录（user=" + userId + " device=" + deviceId + "）");
            }

            // 兼容字段：首次登记的设备写入 users.bound_device_id（仅展示用，不再作为硬门禁）
            if (existing == null) {
                tx.execute(
                        "UPDATE users SET bound_device_id = COALESCE(bound_device_id, $2), "
                                + "device_bound_at = COALESCE(device_bound_at, now()), updated_at = now() "
                                + "WHERE id = $1",
                        userId, deviceId);
            }
            return new DeviceUpsert(mapDevice(row), existing == null);
        });
    }

    public record DeviceUpsert(UserDeviceRow device, boolean isNew) {}

    /** 更新设备最近活跃（登录成功后调用，失败静默） */
    public static void touchDevice(Db db, String userId, String deviceId, String ip) {
        try {
            db.execute(
                    "UPDATE user_devices SET last_seen_at = now(), ip = COALESCE($3, ip) "
                            + "WHERE user_id = $1 AND device_id = $2",
                    userId, deviceId, ip);
        } catch (RuntimeException ignored) {
            // 非关键路径
        }
    }

    /** 该设备是否处于"已登记且未吊销"状态 */
    public static boolean isDeviceTrusted(Db db, String userId, String deviceId) {
        Map<String, Object> row = db.one(
                "SELECT COUNT(*)::int AS n FROM user_devices "
                        + "WHERE user_id = $1 AND device_id = $2 AND revoked_at IS NULL",
                userId, deviceId);
        return Db.longOf(row, "n") != null && Db.longOf(row, "n") > 0;
    }

    /** 列出用户的有效设备（按最近活跃排序） */
    public static List<UserDeviceRow> listUserDevices(Db db, String userId) {
        return db.query(
                "SELECT * FROM user_devices WHERE user_id = $1 AND revoked_at IS NULL "
                        + "ORDER BY COALESCE(last_seen_at, bound_at) DESC",
                userId).stream().map(UsersRepository::mapDevice).toList();
    }

    /** 解绑/吊销设备（自助入口：DELETE /v1/me/devices/:deviceId）。返回是否命中 */
    public static boolean revokeDevice(Db db, String userId, String deviceId) {
        int affected = db.execute(
                "UPDATE user_devices SET revoked_at = now(), is_primary = false "
                        + "WHERE user_id = $1 AND device_id = $2 AND revoked_at IS NULL",
                userId, deviceId);
        // 若吊销的是兼容字段里的绑定设备，清空该字段（避免展示与状态不一致）
        db.execute(
                "UPDATE users SET bound_device_id = NULL, device_bound_at = NULL WHERE id = $1 AND bound_device_id = $2",
                userId, deviceId);
        return affected > 0;
    }
}
