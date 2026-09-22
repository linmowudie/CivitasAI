/**
 * 实验矩阵 · 对抗面-环境故障（ENV）脚手架
 *
 * 覆盖可确定性注入、无需真实进程/混沌环境的 ENV-* cell。
 * 崩溃/满盘/超时等 DUR-* 由 Tests/Durable/faultInjection.spec.ts 既有覆盖（矩阵中 existing-covered）。
 * 用例以 `// @matrix:<ID>` 标签与 Benchmarks/experimentMatrix.json 关联。
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

import { initDualBudget, detectPhase, checkTraceBudget, recordUsage, resetDualBudget, type DualBudgetConfig } from '../../../Src/Services/TokenEconomy/dualBudget.js';
import { initCircuitBreaker, checkBreaker, isTripped, resetCircuitBreaker } from '../../../Src/Services/LoopScheduler/circuitBreaker.js';
import { Time } from '../../../Src/Infra/Time/timeService.js';

const BUDGET_CFG: DualBudgetConfig = {
  tokenBudget: 1000, warmRatio: 0.5, softRatio: 0.7, expandRequestRatio: 0.9, hardRatio: 1.0,
};

describe('实验矩阵 · 环境故障（ENV）', () => {
  afterEach(() => {
    resetDualBudget();
    resetCircuitBreaker();
    vi.restoreAllMocks();
  });

  // @matrix:ENV-BUDHARD
  it('ENV-BUDHARD usage≥hard 立即中止（checkTraceBudget 返回 err）', () => {
    initDualBudget(BUDGET_CFG);
    // 边界档位判定
    expect(detectPhase(100, BUDGET_CFG)).toBe('normal');
    expect(detectPhase(600, BUDGET_CFG)).toBe('warm');
    expect(detectPhase(700, BUDGET_CFG)).toBe('soft');
    expect(detectPhase(1000, BUDGET_CFG)).toBe('hard');
    // 逼近硬预算后再次追加 → 拒绝（触发中止/回滚）
    recordUsage('trace-hard', 950);
    const before = checkTraceBudget('trace-hard', 10); // 960 < 1000 → 非 hard
    expect(before.ok).toBe(true);
    const after = checkTraceBudget('trace-hard', 60); // 1010 ≥ hard → err
    expect(after.ok).toBe(false);
  });

  // @matrix:ENV-STORM
  it('ENV-STORM 窗口内高频触发熔断生效', () => {
    initCircuitBreaker({ threshold: 5, windowMs: 60_000, cooldownMs: 120_000 });
    const now = Date.now();
    let allowed = 0;
    for (let i = 0; i < 8; i++) {
      const r = checkBreaker('storm-key', now); // 固定时间戳 → 同一窗口
      if (r.ok) allowed++;
    }
    // 阈值 5：放行前若干次后熔断，后续被拒
    expect(allowed).toBeLessThan(8);
    expect(isTripped('storm-key', now)).toBe(true);
  });

  // @matrix:ENV-CLOCK
  it('ENV-CLOCK 时钟回拨被检测且返回值保持单调', () => {
    const base = Time.now(); // 建立 lastKnownTime 基线
    const driftBefore = Time.getState().driftCount;
    // 模拟系统时钟回退
    vi.spyOn(Date, 'now').mockReturnValue(base - 5000);
    const compensated = Time.now();
    const driftAfter = Time.getState().driftCount;

    expect(driftAfter).toBeGreaterThan(driftBefore); // 回拨被计数
    expect(compensated).toBeGreaterThan(base);        // 仍单调递增
  });
});
