/**
 * FE-065 回归测试：Token 经济记账接线（主循环 ↔ 钱包/税/双预算）
 *
 * 覆盖：
 *  - `recordIterationEconomy`：定价成本 + 税 → 钱包扣费 + 消费记录 + TOKEN_CONSUMED/TAX_PAID 事件；
 *  - 双预算档位事件（BUDGET_WARMING 等，按 trace 累计与阶段变化触发）；
 *  - fail-soft：定价缺失 / 模型名非全限定 / token=0 → 不扣费、不抛错；
 *  - `startTaxAdjustment` 周期评估（含 stop 对称）。
 *
 * 说明：无数据库/网络依赖；事件断言用 eventLog。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { recordIterationEconomy } from '../../Src/Core/Loop/loopEconomy.js';
import {
  initWalletManager, resetWalletManager, createWallet, getWallet,
} from '../../Src/Services/TokenEconomy/walletManager.js';
import { registerPricing, getConsumptionRecords, clearConsumptionRecords } from '../../Src/Services/TokenEconomy/consumptionRecorder.js';
import { initDualBudget, resetDualBudget, getTraceUsage } from '../../Src/Services/TokenEconomy/dualBudget.js';
import {
  initTaxCollector, resetTaxCollector, getCurrentTaxRate,
  startTaxAdjustment, stopTaxAdjustment,
} from '../../Src/Services/TokenEconomy/taxCollector.js';
import { resetEventBus, getEventLog } from '../../Src/Services/EventBus/eventBus.js';
import { EventType } from '../../Src/Services/EventBus/eventTypes.js';

const AGENT = 'agent-econ-1';
const TRACE = 'trace-econ-1';
const MODEL = 'huawei-maas/GLM-5.1';

function setupEconomy(): void {
  resetWalletManager();
  initWalletManager({ initialSupply: 1_000_000, defaultWalletBalance: 10_000 });
  createWallet(AGENT, TRACE);

  resetTaxCollector();
  initTaxCollector({
    baseRate: 0.05,
    dynamicEnabled: true,
    adjustmentIntervalSec: 0,
    maxRate: 0.2,
    minRate: 0.02,
    highLoadMultiplier: 1.5,
    lowLoadDiscount: 0.8,
    loadThresholdAgents: 10,
  });

  resetDualBudget();
  initDualBudget({ tokenBudget: 100_000, warmRatio: 0.36, softRatio: 0.6, expandRequestRatio: 0.8, hardRatio: 1.0 });

  clearConsumptionRecords();
  registerPricing({
    provider: 'huawei-maas',
    modelId: 'GLM-5.1',
    costPer1kInput: 2.0,
    costPer1kOutput: 8.0,
    contextWindow: 128_000,
  });

  resetEventBus();
}

beforeEach(setupEconomy);
afterEach(() => stopTaxAdjustment());

describe('FE-065 · recordIterationEconomy', () => {
  it('全链记账：扣费（成本+税）+ 消费记录 + TOKEN_CONSUMED/TAX_PAID 事件', () => {
    const before = getWallet(AGENT)!.balance;

    recordIterationEconomy({
      traceId: TRACE,
      agentId: AGENT,
      iteration: 1,
      model: MODEL,
      promptTokens: 1000,
      completionTokens: 500,
    });

    // 成本 = 1000×2/1000 + 500×8/1000 = 6；税 = ceil(6×0.05)=1 → 扣 7
    const after = getWallet(AGENT)!.balance;
    expect(before - after).toBe(7);

    const records = getConsumptionRecords({ agentId: AGENT });
    expect(records).toHaveLength(1);
    expect(records[0]!.totalTokens).toBe(1500);
    expect(records[0]!.calculatedCost).toBe(6);
    expect(records[0]!.taxAmount).toBe(1);

    expect(getEventLog({ eventType: EventType.TOKEN_CONSUMED })).toHaveLength(1);
    expect(getEventLog({ eventType: EventType.TAX_PAID })).toHaveLength(1);

    // 双预算累计（trace）
    expect(getTraceUsage(TRACE)).toBe(1500);
  });

  it('双预算档位事件：跨过 warm 阈值 → BUDGET_WARMING', () => {
    resetDualBudget();
    initDualBudget({ tokenBudget: 1000, warmRatio: 0.1, softRatio: 0.6, expandRequestRatio: 0.8, hardRatio: 1.0 });

    recordIterationEconomy({
      traceId: 'trace-econ-2', agentId: AGENT, iteration: 1, model: MODEL,
      promptTokens: 120, completionTokens: 30, // 150 > warm=100
    });

    const warming = getEventLog({ eventType: EventType.BUDGET_WARMING });
    expect(warming).toHaveLength(1);
    expect(warming[0]!.traceId).toBe('trace-econ-2');
    expect(warming[0]!.payload['tokensUsed']).toBe(150);
  });

  it('定价缺失 → fail-soft：不扣费、不抛错、无 TOKEN_CONSUMED', () => {
    const before = getWallet(AGENT)!.balance;
    recordIterationEconomy({
      traceId: TRACE, agentId: AGENT, iteration: 1,
      model: 'unknown-provider/unknown-model',
      promptTokens: 100, completionTokens: 50,
    });
    expect(getWallet(AGENT)!.balance).toBe(before);
    expect(getEventLog({ eventType: EventType.TOKEN_CONSUMED })).toHaveLength(0);
    // 双预算仍累计（记名失败不影响档位统计）
    expect(getTraceUsage(TRACE)).toBe(150);
  });

  it('模型名非全限定 / token=0 → 跳过钱包记账（双预算仍计量真实消耗）', () => {
    const before = getWallet(AGENT)!.balance;
    recordIterationEconomy({
      traceId: TRACE, agentId: AGENT, iteration: 1, model: 'plain-model',
      promptTokens: 100, completionTokens: 50,
    });
    recordIterationEconomy({
      traceId: TRACE, agentId: AGENT, iteration: 2, model: MODEL,
      promptTokens: 0, completionTokens: 0,
    });
    // 钱包：两者均不扣费（非全限定无法定价；token=0 无账）
    expect(getWallet(AGENT)!.balance).toBe(before);
    // 双预算：计量“真实消耗”（与钱包记账解耦；token=0 不求计）——仅第一条 150 入账
    expect(getTraceUsage(TRACE)).toBe(150);
  });
});

describe('FE-065 · 税率周期评估', () => {
  it('startTaxAdjustment：高负载 → 税率上调；stop 后不再调整', async () => {
    const base = getCurrentTaxRate();

    // 心跳 10ms（内部 adjustmentIntervalSec=0 → 每次 tick 均调整）
    startTaxAdjustment(() => 20, 10); // 20 > loadThresholdAgents(10) → 高负载
    await new Promise(r => setTimeout(r, 40));
    const raised = getCurrentTaxRate();
    expect(raised).toBeGreaterThan(base);
    expect(raised).toBeCloseTo(0.05 * 1.5, 5);

    stopTaxAdjustment();
    const frozen = getCurrentTaxRate();
    await new Promise(r => setTimeout(r, 40));
    expect(getCurrentTaxRate()).toBe(frozen);
  });

  it('低负载 → 税率下调（lowLoadDiscount）', async () => {
    startTaxAdjustment(() => 0, 10); // 0 <= 10 → 低负载
    await new Promise(r => setTimeout(r, 40));
    expect(getCurrentTaxRate()).toBeCloseTo(0.05 * 0.8, 5);
  });
});
