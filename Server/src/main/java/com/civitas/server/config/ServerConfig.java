package com.civitas.server.config;

import java.util.List;

/**
 * 服务端配置快照（等价 TS 版 `src/config.ts` 的 ServerConfig 结构）。
 *
 * 字段访问器为小驼峰（如 {@code cfg.limits().authPerMin()}），与 TS 版逐项对位。
 */
public record ServerConfig(
        Env env,
        String host,
        int port,
        String databaseUrl,
        DbConfig db,
        AuthConfig auth,
        MailConfig mail,
        LimitsConfig limits,
        RateLimitStore rateLimitStore,
        List<String> corsOrigins,
        String logLevel,
        String statsTimezone,
        boolean trustProxy) {

    public enum Env { development, test, production }

    /**
     * 设备绑定模式：
     *  - off    不记录/不校验设备
     *  - warn   记录并审计新设备，但允许登录（默认；换机/换网不再被锁死）
     *  - strict 拒绝未登记设备（企业场景；配合 /v1/me/devices 自助解绑）
     */
    public enum DeviceBindingMode { off, warn, strict }

    /** 限流计数存储：memory（进程内）| postgres（多实例共享，SV-003） */
    public enum RateLimitStore { memory, postgres }

    public record DbConfig(
            int poolMax,
            long idleTimeoutMs,
            long connectionTimeoutMs,
            long statementTimeoutMs) {}

    public record AuthConfig(
            String jwtSecret,
            int accessTokenTtlSec,
            int refreshTokenTtlDays,
            boolean allowRefreshReuse,
            DeviceBindingMode deviceBindingMode,
            /** 是否允许在响应里回传验证码（仅开发；生产启动校验强制关闭） */
            boolean allowDevCode,
            /** 验证码有效期（秒） */
            int codeTtlSec,
            /** 同一邮箱在窗口内最多请求几次验证码 */
            int codeMaxPerWindow,
            /** 验证码发送窗口（秒） */
            int codeWindowSec,
            /** 两次发送之间的最小间隔（秒） */
            int codeResendCooldownSec,
            /** 单个验证码允许的最大失败尝试次数（超过即作废） */
            int codeMaxAttempts) {}

    public record MailConfig(
            /** 邮件通道 webhook（POST JSON）；为空表示未配置 */
            String webhookUrl,
            /** 发件人标识（仅展示/转发用） */
            String from,
            int timeoutMs) {}

    public record LimitsConfig(
            int authPerMin,
            int apiPerMin,
            int writePerMin,
            int bodyLimitBytes,
            int maxSettingsBytes,
            int maxMemoriesPerBulk,
            int maxStatsEventsPerBatch) {}
}
