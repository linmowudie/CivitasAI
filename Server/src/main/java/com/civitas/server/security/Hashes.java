package com.civitas.server.security;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.HexFormat;

/**
 * 哈希与随机数工具 —— 与 TS 版 `node:crypto` 的用法对位。
 *
 * 用于：刷新令牌/验证码/设备凭据的 sha256 入库哈希（明文一律不落库）。
 */
public final class Hashes {
    private static final SecureRandom SECURE_RANDOM = new SecureRandom();

    private Hashes() {}

    public static SecureRandom secureRandom() {
        return SECURE_RANDOM;
    }

    /** sha256 十六进制（等价 `createHash('sha256').update(v).digest('hex')`） */
    public static String sha256Hex(String input) {
        return sha256Hex(input.getBytes(StandardCharsets.UTF_8));
    }

    public static String sha256Hex(byte[] input) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(input));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 不可用", e);
        }
    }
}
