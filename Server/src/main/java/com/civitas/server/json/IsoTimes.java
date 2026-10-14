package com.civitas.server.json;

import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.time.temporal.ChronoUnit;

/**
 * 时间格式化：与 JS `new Date(...).toISOString()` 完全一致（毫秒固定 3 位 + Z）。
 */
public final class IsoTimes {
    private static final DateTimeFormatter ISO_MILLIS_UTC =
            DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC);

    private IsoTimes() {}

    public static String format(Instant instant) {
        return ISO_MILLIS_UTC.format(instant.truncatedTo(ChronoUnit.MILLIS));
    }

    /**
     * 解析 ISO 8601 时间（含时区偏移）—— 输入须已通过 {@link com.civitas.server.http.validation.Validator} 的
     * datetime 正则（秒可省略，偏移允许 `+HHMM`）。
     */
    public static Instant parseOffsetDateTime(String text) {
        try {
            if (text.endsWith("Z")) return Instant.parse(text);
            String normalized = text;
            int length = text.length();
            if (length >= 5) {
                char sign = text.charAt(length - 5);
                if ((sign == '+' || sign == '-') && text.indexOf(':', length - 5) < 0) {
                    normalized = text.substring(0, length - 2) + ":" + text.substring(length - 2);
                }
            }
            return OffsetDateTime.parse(normalized).toInstant();
        } catch (RuntimeException e) {
            throw new IllegalArgumentException("时间格式解析失败: " + text, e);
        }
    }
}
