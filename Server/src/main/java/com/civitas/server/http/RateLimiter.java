package com.civitas.server.http;

/**
 * 限流器接口 —— 与 TS 版 `src/http/rateLimit.ts` 的 `RateLimiter` 对位。
 *
 * TS 版接口为异步（PG 实现需要 IO）；Java 版全程同步（JDBC 同步语义），
 * 调用点均为过滤器/拦截器内部，语义与 TS 一致。
 */
public interface RateLimiter {
    /** 消费一次配额（默认当前时间） */
    RateLimitDecision consume(String key, int limitPerMin);

    /** 消费一次配额（可注入时间，便于测试） */
    RateLimitDecision consume(String key, int limitPerMin, long now);

    /** 当前键的已用次数（测试/观测用） */
    long peek(String key);

    /** 清空（测试用） */
    void reset();

    /** 停止内部清理定时器 */
    void dispose();
}
