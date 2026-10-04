/**
 * RateLimiter 中间件单元测试
 *
 * 覆盖：正常调用通过、超限返回错误、窗口滑动后恢复、配置热加载生效。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  rateLimiterMiddleware,
  initRateLimiter,
  resetRateLimiter,
  getRateLimiterStatus,
} from '../../Src/Core/Middleware/builtin/rateLimiter.js';
import type { MiddlewareContext, ToolCallInput, ToolCallOutput } from '../../Src/Infra/Contracts/middlewareTypes.js';

function makeCtx(overrides: Partial<MiddlewareContext> = {}): MiddlewareContext {
  return {
    agentId: 'test-agent',
    agentRole: 'worker',
    sessionId: 'test-session',
    iteration: 1,
    traceId: 'test-trace',
    data: {},
    ...overrides,
  };
}

const TEST_INPUT: ToolCallInput = {
  toolName: 'read_file',
  arguments: { path: '/tmp/test.txt' },
  toolCallId: 'tc-1',
};

const MOCK_OUTPUT: ToolCallOutput = {
  status: 'success',
  content: 'file content',
  recoverable: false,
};

describe('RateLimiter Middleware', () => {
  beforeEach(() => {
    resetRateLimiter();
  });

  it('should have correct metadata', () => {
    expect(rateLimiterMiddleware.name).toBe('RateLimiter');
    expect(rateLimiterMiddleware.hook).toBe('wrapToolCall');
    expect(rateLimiterMiddleware.priority).toBe(30);
    expect(rateLimiterMiddleware.canShortCircuit).toBe(true);
  });

  it('should allow calls within rate limit', async () => {
    // 显式给出 burstAllowance：测试只应验证"窗口内放行 + 计数正确"，
    // 不应随全局默认值变化而失败（默认值曾从 1.5 调整为 2）
    initRateLimiter({ maxToolCallsPerMinute: 10, burstAllowance: 1.5 });
    const next = vi.fn().mockResolvedValue(MOCK_OUTPUT);
    const ctx = makeCtx();

    const result = await (rateLimiterMiddleware.execute as Function)(ctx, TEST_INPUT, next);

    expect(result).toEqual(MOCK_OUTPUT);
    expect(next).toHaveBeenCalledWith(TEST_INPUT);
    // effectiveMax = floor(10 * 1.5) = 15, remaining = 15 - 1 = 14
    expect(ctx.data['rateLimitRemaining']).toBe(14);
  });

  it('should block calls when rate limit exceeded', async () => {
    initRateLimiter({ maxToolCallsPerMinute: 3, burstAllowance: 1.0 });
    const next = vi.fn().mockResolvedValue(MOCK_OUTPUT);

    // 连续调用直到超限
    for (let i = 0; i < 3; i++) {
      const ctx = makeCtx();
      await (rateLimiterMiddleware.execute as Function)(ctx, TEST_INPUT, next);
    }

    // 第 4 次应被限流
    const ctx = makeCtx();
    const result = await (rateLimiterMiddleware.execute as Function)(ctx, TEST_INPUT, next);

    expect(result.status).toBe('error');
    expect(result.content).toContain('RateLimiter');
    expect(result.recoverable).toBe(true);
    expect(next).toHaveBeenCalledTimes(3);
    expect(ctx.data['rateLimited']).toBe(true);
  });

  it('should respect burstAllowance multiplier', async () => {
    initRateLimiter({ maxToolCallsPerMinute: 10, burstAllowance: 1.5 });
    const next = vi.fn().mockResolvedValue(MOCK_OUTPUT);

    // effectiveMax = floor(10 * 1.5) = 15
    for (let i = 0; i < 15; i++) {
      const ctx = makeCtx();
      await (rateLimiterMiddleware.execute as Function)(ctx, TEST_INPUT, next);
    }

    // 第 16 次应被限流
    const ctx = makeCtx();
    const result = await (rateLimiterMiddleware.execute as Function)(ctx, TEST_INPUT, next);

    expect(result.status).toBe('error');
    expect(next).toHaveBeenCalledTimes(15);
  });

  it('should recover after window slides', async () => {
    initRateLimiter({ maxToolCallsPerMinute: 2, burstAllowance: 1.0 });
    const next = vi.fn().mockResolvedValue(MOCK_OUTPUT);

    // 填满窗口
    await (rateLimiterMiddleware.execute as Function)(makeCtx(), TEST_INPUT, next);
    await (rateLimiterMiddleware.execute as Function)(makeCtx(), TEST_INPUT, next);

    // 此时应被限流
    const blockedResult = await (rateLimiterMiddleware.execute as Function)(makeCtx(), TEST_INPUT, next);
    expect(blockedResult.status).toBe('error');

    // 模拟时间前进 61 秒（窗口滑过）
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 61_000);

    // 应恢复
    const recoveredResult = await (rateLimiterMiddleware.execute as Function)(makeCtx(), TEST_INPUT, next);
    expect(recoveredResult).toEqual(MOCK_OUTPUT);

    vi.useRealTimers();
  });

  it('should report status correctly', () => {
    initRateLimiter({ maxToolCallsPerMinute: 50 });
    const status = getRateLimiterStatus();

    expect(status.config.maxToolCallsPerMinute).toBe(50);
    expect(status.currentToolCallCount).toBe(0);
  });

  it('should reset state on initRateLimiter', async () => {
    initRateLimiter({ maxToolCallsPerMinute: 2, burstAllowance: 1.0 });
    const next = vi.fn().mockResolvedValue(MOCK_OUTPUT);

    // 填满
    await (rateLimiterMiddleware.execute as Function)(makeCtx(), TEST_INPUT, next);
    await (rateLimiterMiddleware.execute as Function)(makeCtx(), TEST_INPUT, next);

    // 重新初始化（重置计数）
    initRateLimiter({ maxToolCallsPerMinute: 2, burstAllowance: 1.0 });

    // 应恢复可用
    const result = await (rateLimiterMiddleware.execute as Function)(makeCtx(), TEST_INPUT, next);
    expect(result).toEqual(MOCK_OUTPUT);
  });
});
