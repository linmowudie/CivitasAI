package com.civitas.server.security;

import org.bouncycastle.crypto.generators.Argon2BytesGenerator;
import org.bouncycastle.crypto.params.Argon2Parameters;

import java.security.MessageDigest;
import java.util.Base64;

/**
 * 密码哈希 —— 与 TS 版 `src/security/password.ts` 对位：
 * Argon2id（OWASP 推荐参数：19 MiB / t=2 / p=1 / 32B）。
 *
 * 跨语言约束：PHC 串格式与 `@node-rs/argon2` 完全互认——
 * `$argon2id$v=19$m=<KB>,t=<iters>,p=<lanes>$<标准 base64 无填充 salt>$<标准 base64 无填充 hash>`。
 */
public final class PasswordService {
    /** OWASP 2024 推荐的最小 Argon2id 配置 */
    public static final int MEMORY_COST_KB = 19_456;
    public static final int TIME_COST = 2;
    public static final int PARALLELISM = 1;
    public static final int OUTPUT_LEN = 32;
    private static final int SALT_LEN = 16;

    /** 密码最小/最大长度（与校验层 passwordSchema 保持一致） */
    public static final int PASSWORD_MIN_LENGTH = 8;
    public static final int PASSWORD_MAX_LENGTH = 200;

    private static final String ARGON2_ID = "argon2id";
    private static final int VERSION_19 = 0x13;

    /** 恒定开销的假校验用固定哈希（与 TS 版逐字节一致） */
    static final String DUMMY_HASH =
            "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$0000000000000000000000000000000000000000000";

    private PasswordService() {}

    public static String hashPassword(String plain) {
        byte[] salt = new byte[SALT_LEN];
        Hashes.secureRandom().nextBytes(salt);
        byte[] out = argon2id(plain, salt, MEMORY_COST_KB, TIME_COST, PARALLELISM, OUTPUT_LEN);
        return "$" + ARGON2_ID + "$v=" + VERSION_19
                + "$m=" + MEMORY_COST_KB + ",t=" + TIME_COST + ",p=" + PARALLELISM
                + "$" + b64(salt) + "$" + b64(out);
    }

    /**
     * 校验密码。哈希串损坏/算法不支持时返回 false（不抛错，避免把内部细节带出去）。
     */
    public static boolean verifyPassword(String storedHash, String plain) {
        if (storedHash == null || storedHash.isEmpty() || plain == null || plain.isEmpty()) return false;
        try {
            String[] parts = storedHash.split("\\$", -1);
            // ['', 'argon2id', 'v=19', 'm=..,t=..,p=..', salt, hash]
            if (parts.length != 6 || !ARGON2_ID.equals(parts[1])) return false;
            if (!parts[2].startsWith("v=")) return false;
            int version = Integer.parseInt(parts[2].substring(2));
            if (version != VERSION_19) return false;

            int memory = 0;
            int iterations = 0;
            int parallelism = 0;
            for (String pair : parts[3].split(",")) {
                String[] kv = pair.split("=", 2);
                if (kv.length != 2) return false;
                switch (kv[0]) {
                    case "m" -> memory = Integer.parseInt(kv[1]);
                    case "t" -> iterations = Integer.parseInt(kv[1]);
                    case "p" -> parallelism = Integer.parseInt(kv[1]);
                    default -> { /* 未知参数忽略（向前兼容） */ }
                }
            }
            if (memory <= 0 || iterations <= 0 || parallelism <= 0) return false;

            byte[] salt = Base64.getDecoder().decode(parts[4]);
            byte[] expected = Base64.getDecoder().decode(parts[5]);
            if (expected.length == 0) return false;
            byte[] actual = argon2id(plain, salt, memory, iterations, parallelism, expected.length);
            return MessageDigest.isEqual(expected, actual);
        } catch (RuntimeException e) {
            return false;
        }
    }

    /**
     * 恒定开销的假校验：用户不存在时也执行一次同等成本的哈希运算，
     * 避免通过响应时间差枚举已注册邮箱。
     */
    public static void fakeVerify() {
        verifyPassword(DUMMY_HASH, "dummy-password");
    }

    private static byte[] argon2id(String plain, byte[] salt, int memoryKb, int iterations, int parallelism, int outputLen) {
        Argon2Parameters params = new Argon2Parameters.Builder(Argon2Parameters.ARGON2_id)
                .withVersion(VERSION_19)
                .withMemoryAsKB(memoryKb)
                .withIterations(iterations)
                .withParallelism(parallelism)
                .withSalt(salt)
                .build();
        Argon2BytesGenerator generator = new Argon2BytesGenerator();
        generator.init(params);
        byte[] out = new byte[outputLen];
        generator.generateBytes(plain.toCharArray(), out);
        return out;
    }

    /** 标准 base64 无填充（与 @node-rs/argon2 的 PHC 串一致） */
    private static String b64(byte[] bytes) {
        return Base64.getEncoder().withoutPadding().encodeToString(bytes);
    }
}
