package com.civitas.server.repositories;

import com.civitas.server.db.Db;

import java.time.Instant;
import java.util.List;
import java.util.Map;

/**
 * 刷新令牌读写（只存哈希）+ 会话管理 —— 与 TS 版 `src/repositories/refreshTokens.ts` 对位。
 */
public final class RefreshTokensRepository {
    private RefreshTokensRepository() {}

    private static final String COLUMNS = "id, user_id, token_hash, family_id, device_label, user_agent, ip, "
            + "issued_at, expires_at, revoked_at, revoked_reason, rotated_to";

    public record RefreshTokenRow(
            String id,
            String userId,
            String tokenHash,
            String familyId,
            String deviceLabel,
            String userAgent,
            String ip,
            Instant issuedAt,
            Instant expiresAt,
            Instant revokedAt,
            String revokedReason,
            String rotatedTo) {}

    public record InsertRefreshTokenInput(
            String userId,
            String tokenHash,
            String familyId,
            Instant expiresAt,
            String deviceLabel,
            String userAgent,
            String ip) {}

    private static RefreshTokenRow map(Map<String, Object> row) {
        if (row == null) return null;
        return new RefreshTokenRow(
                Db.str(row, "id"),
                Db.str(row, "user_id"),
                Db.str(row, "token_hash"),
                Db.str(row, "family_id"),
                Db.str(row, "device_label"),
                Db.str(row, "user_agent"),
                Db.str(row, "ip"),
                Db.instantOf(row, "issued_at"),
                Db.instantOf(row, "expires_at"),
                Db.instantOf(row, "revoked_at"),
                Db.str(row, "revoked_reason"),
                Db.str(row, "rotated_to"));
    }

    public static RefreshTokenRow insertRefreshToken(Db db, InsertRefreshTokenInput input) {
        Map<String, Object> row = db.one(
                "INSERT INTO refresh_tokens (user_id, token_hash, family_id, expires_at, device_label, user_agent, ip) "
                        + "VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING " + COLUMNS,
                input.userId(), input.tokenHash(), input.familyId(), input.expiresAt(),
                input.deviceLabel(), input.userAgent(), input.ip());
        if (row == null) throw new IllegalStateException("刷新令牌写入失败");
        return map(row);
    }

    public static RefreshTokenRow findByHash(Db db, String tokenHash) {
        return map(db.one("SELECT " + COLUMNS + " FROM refresh_tokens WHERE token_hash = $1", tokenHash));
    }

    public static RefreshTokenRow findById(Db db, String id) {
        return map(db.one("SELECT " + COLUMNS + " FROM refresh_tokens WHERE id = $1", id));
    }

    public static void revokeById(Db db, String id, String reason) {
        db.execute(
                "UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = $2 "
                        + "WHERE id = $1 AND revoked_at IS NULL",
                id, reason);
    }

    /** 吊销整个轮换家族（检测到令牌重用时的标准处置） */
    public static int revokeFamily(Db db, String familyId, String reason) {
        return db.execute(
                "UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = $2 "
                        + "WHERE family_id = $1 AND revoked_at IS NULL",
                familyId, reason);
    }

    public static int revokeAllForUser(Db db, String userId, String reason) {
        return db.execute(
                "UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = $2 "
                        + "WHERE user_id = $1 AND revoked_at IS NULL",
                userId, reason);
    }

    public static void markRotated(Db db, String oldId, String newId) {
        db.execute("UPDATE refresh_tokens SET rotated_to = $2 WHERE id = $1", oldId, newId);
    }

    /** 活跃会话（未吊销且未过期） */
    public static List<RefreshTokenRow> listActiveSessions(Db db, String userId) {
        return db.query(
                "SELECT " + COLUMNS + " FROM refresh_tokens "
                        + "WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now() "
                        + "ORDER BY issued_at DESC",
                userId).stream().map(RefreshTokensRepository::map).toList();
    }

    public static int countActiveSessions(Db db, String userId) {
        Map<String, Object> row = db.one(
                "SELECT COUNT(*)::int AS count FROM refresh_tokens "
                        + "WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()",
                userId);
        Long count = Db.longOf(row, "count");
        return count == null ? 0 : count.intValue();
    }

    /** 清理过期/已吊销的历史记录（定期维护用） */
    public static int purgeInactive(Db db, int olderThanDays) {
        return db.execute(
                "DELETE FROM refresh_tokens "
                        + "WHERE (revoked_at IS NOT NULL OR expires_at < now()) "
                        + "AND issued_at < now() - ($1 || ' days')::interval",
                String.valueOf(olderThanDays));
    }
}
