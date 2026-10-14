package com.civitas.server.config;

import com.civitas.server.config.ServerConfig.AuthConfig;
import com.civitas.server.config.ServerConfig.DbConfig;
import com.civitas.server.config.ServerConfig.DeviceBindingMode;
import com.civitas.server.config.ServerConfig.Env;
import com.civitas.server.config.ServerConfig.LimitsConfig;
import com.civitas.server.config.ServerConfig.MailConfig;
import com.civitas.server.config.ServerConfig.RateLimitStore;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 服务端配置：读取 .env + 进程环境变量，校验，生产环境 fail-closed —— 与 TS 版 `src/config.ts` 逐项对位。
 *
 * 设计取舍（与 TS 版一致）：
 *  - 不引入 dotenv 类库：自带极简 .env 解析；
 *  - 真实环境变量优先于 .env 文件（容器/CI 注入的配置不会被文件覆盖；空值不覆盖）；
 *  - 生产环境缺少 JWT_SECRET / MAIL_WEBHOOK_URL / 误开 ALLOW_DEV_CODE 直接拒绝启动。
 */
public final class ConfigLoader {
    private ConfigLoader() {}

    /** 开发环境缺省密钥（TS 版同值；生产环境会被 fail-closed 拦下） */
    public static final String DEV_JWT_SECRET = "dev-only-insecure-secret-change-me-0123456789";

    /** Server/ 根目录（.env 与 migrations/ 的定位基准；等价 TS 的 SERVER_ROOT） */
    public static Path serverRoot() {
        return Path.of(System.getProperty("user.dir"));
    }

    public record LoadConfigResult(boolean ok, ServerConfig config, List<String> errors, List<String> warnings) {
        static LoadConfigResult failure(List<String> errors, List<String> warnings) {
            return new LoadConfigResult(false, null, List.copyOf(errors), List.copyOf(warnings));
        }

        static LoadConfigResult success(ServerConfig config, List<String> warnings) {
            return new LoadConfigResult(true, config, List.of(), List.copyOf(warnings));
        }
    }

    /** 极简 .env 解析：KEY=VALUE、支持 # 注释、去掉成对引号 */
    public static Map<String, String> parseEnvFile(String text) {
        Map<String, String> out = new LinkedHashMap<>();
        for (String rawLine : text.split("\r?\n", -1)) {
            String line = rawLine.trim();
            if (line.isEmpty() || line.startsWith("#")) continue;
            int eq = line.indexOf('=');
            if (eq <= 0) continue;
            String key = line.substring(0, eq).trim();
            String value = line.substring(eq + 1).trim();
            boolean quotedDouble = value.length() >= 2 && value.startsWith("\"") && value.endsWith("\"");
            boolean quotedSingle = value.length() >= 2 && value.startsWith("'") && value.endsWith("'");
            if (quotedDouble || quotedSingle) {
                value = value.substring(1, value.length() - 1);
            }
            out.put(key, value);
        }
        return out;
    }

    /** 合并 .env 文件与真实环境变量（真实环境优先；空值不覆盖文件值） */
    public static Map<String, String> readEnv(Path envDir, Map<String, String> base) {
        Map<String, String> merged = new LinkedHashMap<>();
        Path envPath = envDir.resolve(".env");
        if (Files.exists(envPath)) {
            try {
                merged.putAll(parseEnvFile(Files.readString(envPath, StandardCharsets.UTF_8)));
            } catch (IOException e) {
                throw new IllegalStateException(".env 读取失败: " + envPath, e);
            }
        }
        for (Map.Entry<String, String> entry : base.entrySet()) {
            String value = entry.getValue();
            if (value != null && !value.isEmpty()) merged.put(entry.getKey(), value);
        }
        return merged;
    }

    public static Map<String, String> readEnv() {
        return readEnv(serverRoot(), System.getenv());
    }

    // ── 校验辅助（对位 config.ts 的 num / nonNegativeNum / int / bool）────────

    private record Issue(String path, String message) {}

    /** num(def)：空/缺省 → def；否则必须是正有限数，错误文案 '必须是正数' */
    private static Double num(Map<String, String> env, String key, double def, List<Issue> issues) {
        String raw = env.get(key);
        if (raw == null || raw.isEmpty()) return def;
        Double parsed = parseJsNumber(raw);
        if (parsed == null || !Double.isFinite(parsed) || parsed <= 0) {
            issues.add(new Issue(key, "必须是正数"));
            return null;
        }
        return parsed;
    }

    /** nonNegativeNum(def)：允许 0（`0 表示关闭`） */
    private static Double nonNegativeNum(Map<String, String> env, String key, double def, List<Issue> issues) {
        String raw = env.get(key);
        if (raw == null || raw.isEmpty()) return def;
        Double parsed = parseJsNumber(raw);
        if (parsed == null || !Double.isFinite(parsed) || parsed < 0) {
            issues.add(new Issue(key, "必须是非负数（0 表示关闭）"));
            return null;
        }
        return parsed;
    }

    /** int(def)：Math.trunc(Number(v))，必须非负 */
    private static Long intValue(Map<String, String> env, String key, long def, List<Issue> issues) {
        String raw = env.get(key);
        if (raw == null || raw.isEmpty()) return def;
        Double parsed = parseJsNumber(raw);
        if (parsed == null || !Double.isFinite(parsed)) {
            issues.add(new Issue(key, "必须是非负整数"));
            return null;
        }
        double truncated = parsed < 0 ? Math.ceil(parsed) : Math.floor(parsed);
        if (truncated < 0) {
            issues.add(new Issue(key, "必须是非负整数"));
            return null;
        }
        return (long) truncated;
    }

    /** bool(def)：'1'/'true'/'yes'/'on'（忽略大小写）→ true；其余为 false */
    private static boolean bool(Map<String, String> env, String key, boolean def) {
        String raw = env.get(key);
        if (raw == null || raw.isEmpty()) return def;
        String lower = raw.toLowerCase();
        return lower.equals("1") || lower.equals("true") || lower.equals("yes") || lower.equals("on");
    }

    /** 近似 JS Number(v)：非法 → null（NaN） */
    private static Double parseJsNumber(String raw) {
        try {
            return Double.parseDouble(raw.trim());
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private static String enumValue(Map<String, String> env, String key, String def, List<String> allowed, List<Issue> issues) {
        String raw = env.get(key);
        if (raw == null) return def;
        if (!allowed.contains(raw)) {
            issues.add(new Issue(key, "Invalid enum value. Expected "
                    + String.join(" | ", allowed.stream().map(v -> "'" + v + "'").toList())
                    + ", received '" + raw + "'"));
            return null;
        }
        return raw;
    }

    // ── 主入口 ──────────────────────────────────────────────────────────

    public static LoadConfigResult loadConfig(Map<String, String> env) {
        List<Issue> issues = new ArrayList<>();

        String nodeEnv = enumValue(env, "NODE_ENV", "development",
                List.of("development", "test", "production"), issues);
        String host = env.getOrDefault("HOST", "");
        if (host.isEmpty()) {
            // Zod: z.string().min(1).default('127.0.0.1') —— 缺省给默认值，显式空串报错
            if (env.containsKey("HOST")) {
                issues.add(new Issue("HOST", "String must contain at least 1 character(s)"));
                host = null;
            } else {
                host = "127.0.0.1";
            }
        }
        Double port = num(env, "PORT", 8787, issues);

        String databaseUrl;
        if (!env.containsKey("DATABASE_URL")) {
            issues.add(new Issue("DATABASE_URL", "Required"));
            databaseUrl = null;
        } else {
            databaseUrl = env.get("DATABASE_URL");
            if (databaseUrl.isEmpty()) {
                issues.add(new Issue("DATABASE_URL", "DATABASE_URL 必填"));
                databaseUrl = null;
            }
        }

        Double dbPoolMax = num(env, "DB_POOL_MAX", 10, issues);
        Double dbIdleTimeout = num(env, "DB_IDLE_TIMEOUT_MS", 30_000, issues);
        Double dbConnectionTimeout = num(env, "DB_CONNECTION_TIMEOUT_MS", 5_000, issues);
        Double dbStatementTimeout = num(env, "DB_STATEMENT_TIMEOUT_MS", 15_000, issues);

        String jwtSecret = env.getOrDefault("JWT_SECRET", "");
        Double accessTokenTtlSec = num(env, "ACCESS_TOKEN_TTL_SEC", 900, issues);
        Double refreshTokenTtlDays = num(env, "REFRESH_TOKEN_TTL_DAYS", 30, issues);
        boolean allowRefreshReuse = bool(env, "ALLOW_REFRESH_REUSE", false);

        String deviceBindingModeRaw = enumValue(env, "DEVICE_BINDING_MODE", "warn",
                List.of("off", "warn", "strict"), issues);
        boolean allowDevCodeEnv = bool(env, "ALLOW_DEV_CODE", false);
        Double codeTtlSec = num(env, "CODE_TTL_SEC", 300, issues);
        Long codeMaxPerWindow = intValue(env, "CODE_MAX_PER_WINDOW", 3, issues);
        Double codeWindowSec = num(env, "CODE_WINDOW_SEC", 600, issues);
        Double codeResendCooldownSec = nonNegativeNum(env, "CODE_RESEND_COOLDOWN_SEC", 60, issues);
        Long codeMaxAttempts = intValue(env, "CODE_MAX_ATTEMPTS", 5, issues);

        String mailWebhookUrl = env.getOrDefault("MAIL_WEBHOOK_URL", "");
        String mailFrom = env.getOrDefault("MAIL_FROM", "Civitas-AI <no-reply@civitas.local>");
        Double mailTimeoutMs = num(env, "MAIL_TIMEOUT_MS", 10_000, issues);

        Double rateLimitAuthPerMin = num(env, "RATE_LIMIT_AUTH_PER_MIN", 20, issues);
        Double rateLimitApiPerMin = num(env, "RATE_LIMIT_API_PER_MIN", 240, issues);
        Double rateLimitWritePerMin = num(env, "RATE_LIMIT_WRITE_PER_MIN", 120, issues);
        String rateLimitStoreRaw = enumValue(env, "RATE_LIMIT_STORE", null,
                List.of("memory", "postgres"), issues);

        Double bodyLimitBytes = num(env, "BODY_LIMIT_BYTES", 1024 * 1024, issues);
        Double maxSettingsBytes = num(env, "MAX_SETTINGS_BYTES", 256 * 1024, issues);
        Long maxMemoriesPerBulk = intValue(env, "MAX_MEMORIES_PER_BULK", 1000, issues);
        Long maxStatsEventsPerBatch = intValue(env, "MAX_STATS_EVENTS_PER_BATCH", 500, issues);

        String corsOriginsRaw = env.getOrDefault("CORS_ORIGINS", "");
        String logLevel = env.getOrDefault("LOG_LEVEL", "info");
        String statsTimezone = env.getOrDefault("STATS_TIMEZONE", "UTC");
        boolean trustProxy = bool(env, "TRUST_PROXY", false);

        if (!issues.isEmpty()) {
            List<String> errors = new ArrayList<>();
            for (Issue issue : issues) {
                errors.add((issue.path().isEmpty() ? "env" : issue.path()) + ": " + issue.message());
            }
            return LoadConfigResult.failure(errors, List.of());
        }

        // ── 语义校验（对位 config.ts 的 fail-closed 段落）──────────────────
        List<String> errors = new ArrayList<>();
        List<String> warnings = new ArrayList<>();
        boolean production = "production".equals(nodeEnv);

        if (production) {
            if (jwtSecret.length() < 32) {
                errors.add("JWT_SECRET 在生产环境必须 ≥32 字符（请用随机值，勿用示例值）");
            }
            if (jwtSecret.contains("dev-only-insecure")) {
                errors.add("JWT_SECRET 仍是示例值，禁止在生产环境使用");
            }
        } else if (jwtSecret.length() < 32) {
            warnings.add("JWT_SECRET 偏短或未设置：仅限本地开发使用");
        }

        if (!databaseUrl.matches("^postgres(ql)?://.*")) {
            errors.add("DATABASE_URL 必须是 postgres:// 或 postgresql:// 连接串");
        }
        if (allowRefreshReuse && production) {
            warnings.add("ALLOW_REFRESH_REUSE=true 会削弱令牌盗用防护，生产环境不建议开启");
        }
        if (production && allowDevCodeEnv) {
            errors.add("ALLOW_DEV_CODE=true 在生产环境被禁止（会导致验证码随响应泄露）");
        }
        if (production && mailWebhookUrl.isEmpty()) {
            errors.add("生产环境必须配置 MAIL_WEBHOOK_URL（否则验证码无法送达，用户将无法登录）");
        }
        if (!production && mailWebhookUrl.isEmpty()) {
            warnings.add("未配置 MAIL_WEBHOOK_URL：验证码只会打印到服务端控制台（仅限开发/自测）");
        }
        if ("strict".equals(deviceBindingModeRaw) && production) {
            warnings.add("DEVICE_BINDING_MODE=strict：新设备会被拒绝，请确保已提供设备管理（/v1/me/devices）与解绑流程");
        }

        if (!errors.isEmpty()) {
            return LoadConfigResult.failure(errors, warnings);
        }

        List<String> corsOrigins = new ArrayList<>();
        for (String origin : corsOriginsRaw.split(",")) {
            String trimmed = origin.trim();
            if (!trimmed.isEmpty()) corsOrigins.add(trimmed);
        }

        ServerConfig config = new ServerConfig(
                Env.valueOf(nodeEnv),
                host,
                port.intValue(),
                databaseUrl,
                new DbConfig(
                        dbPoolMax.intValue(),
                        dbIdleTimeout.longValue(),
                        dbConnectionTimeout.longValue(),
                        dbStatementTimeout.longValue()),
                new AuthConfig(
                        jwtSecret.isEmpty() ? DEV_JWT_SECRET : jwtSecret,
                        accessTokenTtlSec.intValue(),
                        refreshTokenTtlDays.intValue(),
                        allowRefreshReuse,
                        DeviceBindingMode.valueOf(deviceBindingModeRaw),
                        // 生产环境即使显式开启也已被上面的 errors 拦下；这里再兜一层
                        allowDevCodeEnv && !production,
                        codeTtlSec.intValue(),
                        codeMaxPerWindow.intValue(),
                        codeWindowSec.intValue(),
                        codeResendCooldownSec.intValue(),
                        codeMaxAttempts.intValue()),
                new MailConfig(mailWebhookUrl, mailFrom, mailTimeoutMs.intValue()),
                new LimitsConfig(
                        rateLimitAuthPerMin.intValue(),
                        rateLimitApiPerMin.intValue(),
                        rateLimitWritePerMin.intValue(),
                        bodyLimitBytes.intValue(),
                        maxSettingsBytes.intValue(),
                        maxMemoriesPerBulk.intValue(),
                        maxStatsEventsPerBatch.intValue()),
                rateLimitStoreRaw != null
                        ? RateLimitStore.valueOf(rateLimitStoreRaw)
                        : (production ? RateLimitStore.postgres : RateLimitStore.memory),
                List.copyOf(corsOrigins),
                logLevel,
                statsTimezone,
                trustProxy);

        return LoadConfigResult.success(config, warnings);
    }
}
