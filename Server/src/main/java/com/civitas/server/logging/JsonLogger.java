package com.civitas.server.logging;

import com.civitas.server.json.IsoTimes;
import com.civitas.server.json.Json;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 服务端极简结构化日志（JSON 行输出）——与 TS 版 `src/logger.ts` 对位。
 *
 * 安全：默认对敏感字段（code / password / token / credential 等）做脱敏，
 * 避免验证码、密码、令牌被写进日志。
 */
public final class JsonLogger {
    private JsonLogger() {}

    private static final Map<String, Integer> LEVEL_ORDER = Map.of(
            "debug", 10, "info", 20, "warn", 30, "error", 40, "silent", 100);

    /** 需要脱敏的键（大小写不敏感、含子串匹配） */
    private static final List<String> SENSITIVE_KEY_PATTERNS = List.of(
            "password", "passwd", "secret", "token", "credential", "authorization", "cookie", "devcode", "code");

    private static volatile String minLevel = envLevel();

    private static String envLevel() {
        String value = System.getenv("LOG_LEVEL");
        return (value == null || value.isEmpty()) ? "info" : value;
    }

    public static void setLevel(String level) {
        minLevel = level;
    }

    /** 未知级别与 TS 的 `x < undefined === false` 等价：放行全部级别 */
    private static int orderOf(String level) {
        Integer order = LEVEL_ORDER.get(level);
        return order == null ? 0 : order;
    }

    public static boolean isSensitiveKey(String key) {
        String lower = key.toLowerCase();
        return SENSITIVE_KEY_PATTERNS.stream().anyMatch(lower::contains);
    }

    /** 递归脱敏（仅处理列表/映射；深度上限防环） */
    public static Object redact(Object value) {
        return redact(value, 0);
    }

    private static Object redact(Object value, int depth) {
        if (depth > 4) return "[deep]";
        if (value instanceof List<?> list) {
            List<Object> out = new ArrayList<>(list.size());
            for (Object item : list) out.add(redact(item, depth + 1));
            return out;
        }
        if (value instanceof Map<?, ?> map) {
            Map<String, Object> out = new LinkedHashMap<>();
            for (Map.Entry<?, ?> entry : map.entrySet()) {
                String key = String.valueOf(entry.getKey());
                out.put(key, isSensitiveKey(key) ? "[REDACTED]" : redact(entry.getValue(), depth + 1));
            }
            return out;
        }
        if (value instanceof Throwable throwable) {
            // TS 的 JSON.stringify(new Error(...)) 会丢失信息（{}）；此处保留名称与信息，便于排障
            Map<String, Object> info = new LinkedHashMap<>();
            info.put("name", throwable.getClass().getSimpleName());
            info.put("message", String.valueOf(throwable.getMessage()));
            return info;
        }
        return value;
    }

    public static void debug(String message, Map<String, Object> fields) {
        emit("debug", message, fields);
    }

    public static void info(String message, Map<String, Object> fields) {
        emit("info", message, fields);
    }

    public static void warn(String message, Map<String, Object> fields) {
        emit("warn", message, fields);
    }

    public static void error(String message, Map<String, Object> fields) {
        emit("error", message, fields);
    }

    private static void emit(String level, String message, Map<String, Object> fields) {
        if (orderOf(level) < orderOf(minLevel)) return;
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("ts", IsoTimes.format(Instant.now()));
        payload.put("level", level);
        payload.put("message", message);
        if (fields != null) {
            @SuppressWarnings("unchecked")
            Map<String, Object> redacted = (Map<String, Object>) redact(fields);
            payload.putAll(redacted);
        }
        String line;
        try {
            line = Json.MAPPER.writeValueAsString(payload);
        } catch (Exception e) {
            // 序列化失败不能反过来把日志系统打挂：退化为仅 message 的最小行
            line = "{\"ts\":\"" + IsoTimes.format(Instant.now()) + "\",\"level\":\"" + level
                    + "\",\"message\":\"日志字段序列化失败\",\"logError\":\"" + e.getClass().getSimpleName() + "\"}";
        }
        if ("error".equals(level) || "warn".equals(level)) {
            System.err.println(line);
        } else {
            System.out.println(line);
        }
    }
}
