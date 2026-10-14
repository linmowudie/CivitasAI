package com.civitas.server.http;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 内存限流器（滑动窗口）—— 与 TS 版 `test/unit/core.spec.ts` 的限流用例对位。
 */
class RateLimiterTest {

    @Test
    void 达到上限后拒绝_并给出重试秒数() {
        MemoryRateLimiter limiter = new MemoryRateLimiter(0);
        long t0 = 1_000_000;
        assertTrue(limiter.consume("k", 2, t0).allowed());
        assertTrue(limiter.consume("k", 2, t0 + 10).allowed());
        RateLimitDecision third = limiter.consume("k", 2, t0 + 20);
        assertFalse(third.allowed());
        assertTrue(third.retryAfterSec() > 0);
        limiter.dispose();
    }

    @Test
    void 滑动窗口_超出60s的旧记录不再计数() {
        MemoryRateLimiter limiter = new MemoryRateLimiter(0);
        long t0 = 2_000_000;
        limiter.consume("k", 2, t0);
        limiter.consume("k", 2, t0 + 1_000);
        assertFalse(limiter.consume("k", 2, t0 + 2_000).allowed());
        // 61 秒后第一条滑出窗口
        assertTrue(limiter.consume("k", 2, t0 + 61_000).allowed());
        limiter.dispose();
    }

    @Test
    void 不同键互不影响_reset清空() {
        MemoryRateLimiter limiter = new MemoryRateLimiter(0);
        assertTrue(limiter.consume("a", 1).allowed());
        assertTrue(limiter.consume("b", 1).allowed());
        assertFalse(limiter.consume("a", 1).allowed());
        limiter.reset();
        assertTrue(limiter.consume("a", 1).allowed());
        limiter.dispose();
    }

    @Test
    void 判定值携带limit与used() {
        MemoryRateLimiter limiter = new MemoryRateLimiter(0);
        RateLimitDecision first = limiter.consume("k", 5);
        assertTrue(first.allowed());
        assertEquals(5, first.limit());
        assertEquals(1, first.used());
        assertEquals(0, first.retryAfterSec());
        limiter.dispose();
    }
}
