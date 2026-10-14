package com.civitas.server.http;

/** 限流判定 —— 与 TS 版 `src/http/rateLimit.ts` 的 `RateLimitDecision` 对位 */
public record RateLimitDecision(boolean allowed, int used, int limit, int retryAfterSec) {}
