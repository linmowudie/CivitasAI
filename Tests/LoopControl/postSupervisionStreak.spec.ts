/**
 * 后置监管 · 连续工具错误阈值（BUG-2026-10-08-1/3 的收口回归）
 *
 * 修复背景：原实现只要出现一条 `status==='error' && !recoverable` 的工具结果即
 * `shouldExit:true`，于是模型一次路径写错（PATH_DENIED）就会终止整个 Loop，
 * 且没有机会看到错误文本并纠正。现改为"连续错误达到 maxConsecutiveErrors 才终止"，
 * 阈值取自 Configs/loopConfig.json 的 stopRules.limits.maxConsecutiveErrors（默认 3）。
 */
import { describe, it, expect } from 'vitest';

import {
  runPostSupervision,
  accumulateConsecutiveErrors,
  DEFAULT_MAX_CONSECUTIVE_ERRORS,
} from '../../Src/Services/Supervision/postSupervision.js';

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    outputText: '',
    toolResults: [] as Array<{ toolName: string; status: string; recoverable: boolean }>,
    tokensConsumed: 100,
    totalTokensConsumed: 100,
    tokenBudget: 100000,
    currentIteration: 1,
    maxIterations: 30,
    ...overrides,
  };
}

const errResult = (toolName = 'dir.list', recoverable = false) => ({ toolName, status: 'error', recoverable });
const okResult = (toolName = 'dir.list') => ({ toolName, status: 'success', recoverable: false });

describe('postSupervision · 连续工具错误阈值', () => {
  it('第 1 次失败不退出（此前这里会直接终止 Loop）', () => {
    const r = runPostSupervision(baseInput({ toolResults: [errResult()], consecutiveErrors: 0 }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.exitDecision.shouldExit).toBe(false);
    expect(r.value.anomalies).toEqual([]);
  });

  it('第 2 次失败仍不退出', () => {
    const r = runPostSupervision(baseInput({ toolResults: [errResult()], consecutiveErrors: 1 }));
    if (!r.ok) throw new Error(r.error);
    expect(r.value.exitDecision.shouldExit).toBe(false);
    expect(r.value.anomalies).toEqual([]);
  });

  it('第 3 次失败（达到默认阈值）才退出，并登记致命异常', () => {
    const r = runPostSupervision(baseInput({ toolResults: [errResult()], consecutiveErrors: 2 }));
    if (!r.ok) throw new Error(r.error);
    expect(r.value.exitDecision.shouldExit).toBe(true);
    expect(r.value.exitDecision.exitReason).toBe('error');
    expect(r.value.anomalies).toEqual(['UNRECOVERABLE_TOOL_ERROR']);
  });

  it('退出说明点名工具与次数（原实现只有一句 Unrecoverable tool error）', () => {
    const r = runPostSupervision(baseInput({
      toolResults: [errResult('file.write')],
      consecutiveErrors: 2,
    }));
    if (!r.ok) throw new Error(r.error);
    expect(r.value.exitDecision.message).toContain('file.write');
    expect(r.value.exitDecision.message).toContain('3');
    expect(r.value.exitDecision.message).toContain('不可恢复');
  });

  it('阈值可由 stopRules.limits.maxConsecutiveErrors 覆盖', () => {
    const r = runPostSupervision(baseInput({
      toolResults: [errResult()],
      consecutiveErrors: 0,
      maxConsecutiveErrors: 1,
    }));
    if (!r.ok) throw new Error(r.error);
    expect(r.value.exitDecision.shouldExit).toBe(true);
  });

  it('可恢复错误同样累计（不在首次失败即退，但持续失败仍会终止）', () => {
    const recoverable = { toolName: 'shell.exec', status: 'error', recoverable: true };
    const first = runPostSupervision(baseInput({ toolResults: [recoverable], consecutiveErrors: 0 }));
    const third = runPostSupervision(baseInput({ toolResults: [recoverable], consecutiveErrors: 2 }));
    if (!first.ok || !third.ok) throw new Error('unexpected');
    expect(first.value.exitDecision.shouldExit).toBe(false);
    expect(third.value.exitDecision.shouldExit).toBe(true);
  });

  it('默认阈值与配置默认值一致（3）', () => {
    expect(DEFAULT_MAX_CONSECUTIVE_ERRORS).toBe(3);
  });

  it('预算耗尽优先级不受影响（无工具错误时仍按预算退出）', () => {
    const r = runPostSupervision(baseInput({
      toolResults: [],
      tokensConsumed: 1000,
      totalTokensConsumed: 100000,
      tokenBudget: 100000,
    }));
    if (!r.ok) throw new Error(r.error);
    expect(r.value.exitDecision.exitReason).toBe('budget_exhausted');
  });
});

describe('accumulateConsecutiveErrors · 跨轮累计', () => {
  it('本轮无错误 → 归零（模型已自我纠正）', () => {
    expect(accumulateConsecutiveErrors(2, [okResult()])).toBe(0);
    expect(accumulateConsecutiveErrors(5, [])).toBe(0);
  });

  it('本轮有错误 → 在上轮基础上累加', () => {
    expect(accumulateConsecutiveErrors(0, [errResult()])).toBe(1);
    expect(accumulateConsecutiveErrors(2, [errResult()])).toBe(3);
  });

  it('同一轮内多个工具失败按实际条数累计', () => {
    expect(accumulateConsecutiveErrors(0, [errResult('a'), errResult('b')])).toBe(2);
  });

  it('成功与失败混合的轮次仍按失败数累计（不归零）', () => {
    expect(accumulateConsecutiveErrors(1, [okResult('a'), errResult('b')])).toBe(2);
  });

  it('异常入参（负数）被夹到 0，不产生负计数', () => {
    expect(accumulateConsecutiveErrors(-3, [errResult()])).toBe(1);
  });
});
