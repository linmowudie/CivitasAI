package com.civitas.server.repositories;

import com.civitas.server.db.Db;
import com.civitas.server.security.Hashes;

import java.security.SecureRandom;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.Map;

/**
 * 验证码存储与校验（安全审计 SV-012 加固后）—— 与 TS 版 `src/repositories/verificationCodes.ts` 对位。
 *
 * 加固点：
 *  - **只存哈希**：`code_hash = sha256(code)`，明文不落库；
 *  - **CSPRNG**：密码学安全随机 6 位码；
 *  - **失败锁定**：`attempts` 计数，达到上限即作废；
 *  - **单活码**：签发新码时作废该邮箱同用途的旧码；
 *  - **配额与冷却**：`countRecentCodes` / `lastIssuedAt` 供服务层限流。
 */
public final class VerificationCodesRepository {
    private VerificationCodesRepository() {}

    private static final SecureRandom RANDOM = Hashes.secureRandom();

    public record VerificationCodeRow(
            String id,
            String emailLower,
            String codeHash,
            String purpose,
            Instant expiresAt,
            Instant usedAt,
            int attempts,
            Instant createdAt) {}

    public record CreateCodeInput(String email, String code, String purpose, Long ttlMs) {}

    private static VerificationCodeRow map(Map<String, Object> row) {
        if (row == null) return null;
        Long attempts = Db.longOf(row, "attempts");
        return new VerificationCodeRow(
                Db.str(row, "id"),
                Db.str(row, "email_lower"),
                Db.str(row, "code_hash"),
                Db.str(row, "purpose"),
                Db.instantOf(row, "expires_at"),
                Db.instantOf(row, "used_at"),
                attempts == null ? 0 : attempts.intValue(),
                Db.instantOf(row, "created_at"));
    }

    /** 生成 6 位数字验证码（密码学安全随机） */
    public static String generateCode() {
        return String.valueOf(RANDOM.nextInt(100_000, 1_000_000));
    }

    /** 验证码哈希（sha256 十六进制） */
    public static String hashCode(String code) {
        return Hashes.sha256Hex(code);
    }

    /** 常量时间比较（防时序侧信道） */
    public static boolean verifyCodeHash(String storedHash, String code) {
        byte[] a = hexToBytes(storedHash);
        byte[] b = hexToBytes(hashCode(code));
        if (a.length != b.length || a.length == 0) return false;
        return MessageDigest.isEqual(a, b);
    }

    private static byte[] hexToBytes(String hex) {
        if (hex == null || hex.length() % 2 != 0) return new byte[0];
        try {
            byte[] out = new byte[hex.length() / 2];
            for (int i = 0; i < out.length; i++) {
                int hi = Character.digit(hex.charAt(i * 2), 16);
                int lo = Character.digit(hex.charAt(i * 2 + 1), 16);
                if (hi < 0 || lo < 0) return new byte[0];
                out[i] = (byte) ((hi << 4) | lo);
            }
            return out;
        } catch (RuntimeException e) {
            return new byte[0];
        }
    }

    /**
     * 签发验证码：先作废该邮箱同用途的未用码（保证**同一时刻只有一个有效码**），再插入新码（存哈希）。
     */
    public static VerificationCodeRow createVerificationCode(Db db, CreateCodeInput input) {
        long ttlMs = input.ttlMs() == null ? 5 * 60 * 1000 : input.ttlMs();
        Instant expiresAt = Instant.now().plusMillis(ttlMs);
        return db.tx(tx -> {
            tx.execute(
                    "UPDATE verification_codes SET used_at = now() "
                            + "WHERE email_lower = $1 AND purpose = $2 AND used_at IS NULL",
                    input.email().toLowerCase(), input.purpose());
            Map<String, Object> row = tx.one(
                    "INSERT INTO verification_codes (email_lower, code_hash, purpose, expires_at) "
                            + "VALUES ($1, $2, $3, $4) RETURNING *",
                    input.email().toLowerCase(), hashCode(input.code()), input.purpose(), expiresAt);
            if (row == null) throw new IllegalStateException("验证码写入失败");
            return map(row);
        });
    }

    /** 查找当前有效验证码（未过期 + 未使用 + 未超失败次数），返回最新一条 */
    public static VerificationCodeRow findValidCode(Db db, String email, String purpose, int maxAttempts) {
        return map(db.one(
                "SELECT * FROM verification_codes "
                        + "WHERE email_lower = $1 AND purpose = $2 AND used_at IS NULL "
                        + "AND expires_at > now() AND attempts < $3 "
                        + "ORDER BY created_at DESC LIMIT 1",
                email.toLowerCase(), purpose, maxAttempts));
    }

    public record FailedAttempt(int attempts, boolean invalidated) {}

    /** 记录一次失败尝试；达到上限即作废（返回是否已作废） */
    public static FailedAttempt registerFailedAttempt(Db db, String codeId, int maxAttempts) {
        Map<String, Object> row = db.one(
                "UPDATE verification_codes SET attempts = attempts + 1 WHERE id = $1 RETURNING attempts",
                codeId);
        Long attemptsValue = row == null ? null : Db.longOf(row, "attempts");
        int attempts = attemptsValue == null ? 0 : attemptsValue.intValue();
        boolean invalidated = attempts >= maxAttempts;
        if (invalidated) {
            db.execute("UPDATE verification_codes SET used_at = now() WHERE id = $1 AND used_at IS NULL", codeId);
        }
        return new FailedAttempt(attempts, invalidated);
    }

    /** 标记验证码已使用 */
    public static void markCodeUsed(Db db, String codeId) {
        db.execute("UPDATE verification_codes SET used_at = now() WHERE id = $1 AND used_at IS NULL", codeId);
    }

    /** 统计窗口内该邮箱签发次数（发送配额） */
    public static int countRecentCodes(Db db, String email, String purpose, int windowSec) {
        Map<String, Object> row = db.one(
                "SELECT COUNT(*)::int AS n FROM verification_codes "
                        + "WHERE email_lower = $1 AND purpose = $2 AND created_at > now() - ($3 || ' seconds')::interval",
                email.toLowerCase(), purpose, String.valueOf(Math.max(1, windowSec)));
        Long count = Db.longOf(row, "n");
        return count == null ? 0 : count.intValue();
    }

    /** 最近一次签发时间（冷却判断） */
    public static Instant lastIssuedAt(Db db, String email, String purpose) {
        Map<String, Object> row = db.one(
                "SELECT created_at FROM verification_codes "
                        + "WHERE email_lower = $1 AND purpose = $2 ORDER BY created_at DESC LIMIT 1",
                email.toLowerCase(), purpose);
        return row == null ? null : Db.instantOf(row, "created_at");
    }

    /** 清理过期验证码（定期维护） */
    public static int cleanupExpiredCodes(Db db, int olderThanDays) {
        return db.execute(
                "DELETE FROM verification_codes WHERE expires_at < now() - ($1 || ' days')::interval",
                String.valueOf(Math.max(1, olderThanDays)));
    }
}
