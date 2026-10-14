package com.civitas.server.util;

/**
 * JS `Number(string)` 语义 —— 查询参数强制转型与游标解析用（对位 `z.coerce.number()`）。
 *
 * 空串 → 0；支持 0x 十六进制前缀；其余按十进制解析；无法解析 → NaN。
 */
public final class JsNumber {
    private JsNumber() {}

    public static double parse(String value) {
        String trimmed = value.trim();
        if (trimmed.isEmpty()) return 0;
        if (trimmed.regionMatches(true, 0, "0x", 0, 2)) {
            try {
                return Long.parseLong(trimmed.substring(2), 16);
            } catch (NumberFormatException e) {
                return Double.NaN;
            }
        }
        try {
            return Double.parseDouble(trimmed);
        } catch (NumberFormatException e) {
            return Double.NaN;
        }
    }
}
