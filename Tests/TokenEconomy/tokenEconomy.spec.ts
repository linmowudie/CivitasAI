/**
 * S7 Token 计量与双预算测试——Gate G7 验证
 *
 * 覆盖：
 * - WalletManager（创建/扣减/入账/冻结/解冻/罚没/守恒）
 * - TokenLedger（交易记录/守恒验证/trace 汇总）
 * - ConsumptionRecorder（成本计算/定价/税额）
 * - DualBudget（四档阶段检测/预算事件/单次上限）
 * - TaxCollector（固定/动态税率/税收分配）
 * - ProfitDistributor（三维贡献/分润计算/舍入误差）
 * - Gate G7 综合验证
 */

import { describe, it, expect, beforeEach } from 'vitest';

// ── WalletManager ──────────────────────────────────────
import {
  initWalletManager, createWallet, checkBalance, debit, credit,
  freezeWallet, unfreezeWallet, confiscate, getWallet, getAllWallets,
  verifyConservation, resetWalletManager, getSystemPool,
} from '../../Src/Services/TokenEconomy/walletManager.js';

// ── TokenLedger ────────────────────────────────────────
import {
  verifyLedgerConservation, summarizeTrace, getTransactionCount, clearLedger,
} from '../../Src/Services/TokenEconomy/tokenLedger.js';

// ── ConsumptionRecorder ────────────────────────────────
import {
  registerPricing, recordConsumption, getConsumptionRecords,
  getTotalConsumption, clearConsumptionRecords,
} from '../../Src/Services/TokenEconomy/consumptionRecorder.js';

// ── DualBudget ─────────────────────────────────────────
import {
  initDualBudget, detectPhase, getBudgetStatus, recordUsage,
  checkSingleCallLimit, checkTraceBudget, recordUsageAndDetect,
  resetDualBudget, getTraceUsage,
} from '../../Src/Services/TokenEconomy/dualBudget.js';

// ── TaxCollector ───────────────────────────────────────
import {
  initTaxCollector, getCurrentTaxRate, calculateTax,
  adjustTaxRate, distributeTax, getTotalTaxCollected,
  getTotalDestroyed, resetTaxCollector,
} from '../../Src/Services/TokenEconomy/taxCollector.js';

// ── ProfitDistributor ──────────────────────────────────
import {
  calculateDistribution, executeDistribution,
} from '../../Src/Services/TokenEconomy/profitDistributor.js';

// ── 辅助 ──────────────────────────────────────────────

const INIT_SUPPLY = 1_000_000;
const DEFAULT_BALANCE = 10_000;

function setupWallets() {
  resetWalletManager();
  initWalletManager({ initialSupply: INIT_SUPPLY, defaultWalletBalance: DEFAULT_BALANCE });
}

// ═══════════════════════════════════════════════════════
// 1. WalletManager
// ═══════════════════════════════════════════════════════

describe('S7 · WalletManager', () => {
  beforeEach(setupWallets);

  it('创建钱包：从系统池扣减默认余额', () => {
    const result = createWallet('agent-1', 'trace-1');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.balance).toBe(DEFAULT_BALANCE);
      expect(result.value.agentId).toBe('agent-1');
    }
    expect(getSystemPool()).toBe(INIT_SUPPLY - DEFAULT_BALANCE);
  });

  it('重复创建 → 拒绝', () => {
    createWallet('agent-1', 'trace-1');
    const result = createWallet('agent-1', 'trace-1');
    expect(result.ok).toBe(false);
  });

  it('余额检查', () => {
    createWallet('agent-1', 'trace-1');
    const r1 = checkBalance('agent-1', 5000);
    expect(r1.ok && r1.value).toBe(true);
    const r2 = checkBalance('agent-1', 20000);
    expect(r2.ok && r2.value).toBe(false);
  });

  it('扣减 + 入账', () => {
    createWallet('agent-1', 'trace-1');
    const debitResult = debit('agent-1', 3000, 'trace-1');
    expect(debitResult.ok).toBe(true);
    if (debitResult.ok) expect(debitResult.value.balance).toBe(7000);

    const creditResult = credit('agent-1', 2000, 'trace-1');
    expect(creditResult.ok).toBe(true);
    if (creditResult.ok) expect(creditResult.value.balance).toBe(9000);
  });

  it('余额不足 → 拒绝', () => {
    createWallet('agent-1', 'trace-1');
    const result = debit('agent-1', 20000, 'trace-1');
    expect(result.ok).toBe(false);
  });

  it('冻结 → 扣减被拒 → 解冻 → 扣减成功', () => {
    createWallet('agent-1', 'trace-1');
    freezeWallet('agent-1', '稽查', 'trace-1');
    const debitResult = debit('agent-1', 1000, 'trace-1');
    expect(debitResult.ok).toBe(false);

    unfreezeWallet('agent-1', 'trace-1');
    const debitResult2 = debit('agent-1', 1000, 'trace-1');
    expect(debitResult2.ok).toBe(true);
  });

  it('罚没', () => {
    createWallet('agent-1', 'trace-1');
    const result = confiscate('agent-1', 5000, 'trace-1');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.balance).toBe(5000);
  });

  it('Token 守恒验证', () => {
    createWallet('agent-1', 'trace-1');
    createWallet('agent-2', 'trace-1');
    debit('agent-1', 2000, 'trace-1');
    credit('agent-2', 1000, 'trace-1');

    const result = verifyConservation();
    expect(result.ok).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════
// 2. ConsumptionRecorder
// ═══════════════════════════════════════════════════════

describe('S7 · ConsumptionRecorder', () => {
  beforeEach(() => {
    setupWallets();
    clearConsumptionRecords();
    registerPricing({
      provider: 'openai', modelId: 'gpt-4o',
      costPer1kInput: 2.5, costPer1kOutput: 10.0, contextWindow: 128000,
    });
  });

  it('记录消耗：计算成本 + 税', () => {
    createWallet('agent-1', 'trace-1');
    const result = recordConsumption({
      traceId: 'trace-1', agentId: 'agent-1', operationId: 'op-1',
      provider: 'openai', model: 'gpt-4o',
      promptTokens: 1000, completionTokens: 500,
      currentTaxRate: 0.05,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // cost = 1000*2.5/1000 + 500*10/1000 = 2.5 + 5 = 7.5 → ceil = 8
      expect(result.value.calculatedCost).toBe(8);
      // tax = ceil(8 * 0.05) = 1
      expect(result.value.taxAmount).toBe(1);
      expect(result.value.netDeduction).toBe(9);
    }
  });

  it('未注册定价 → 拒绝', () => {
    createWallet('agent-1', 'trace-1');
    const result = recordConsumption({
      traceId: 'trace-1', agentId: 'agent-1', operationId: 'op-1',
      provider: 'unknown', model: 'unknown',
      promptTokens: 100, completionTokens: 100,
      currentTaxRate: 0.05,
    });
    expect(result.ok).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════
// 3. DualBudget
// ═══════════════════════════════════════════════════════

describe('S7 · DualBudget', () => {
  const budgetConfig = {
    tokenBudget: 100000,
    warmRatio: 0.36, softRatio: 0.6,
    expandRequestRatio: 0.8, hardRatio: 1.0,
  };

  beforeEach(() => {
    resetDualBudget();
    initDualBudget(budgetConfig);
  });

  it('四档阶段检测', () => {
    expect(detectPhase(10000, budgetConfig)).toBe('normal');
    expect(detectPhase(36000, budgetConfig)).toBe('warm');
    expect(detectPhase(60000, budgetConfig)).toBe('soft');
    expect(detectPhase(80000, budgetConfig)).toBe('expand_request');
    expect(detectPhase(100000, budgetConfig)).toBe('hard');
  });

  it('预算状态查询', () => {
    recordUsage('trace-1', 50000);
    const status = getBudgetStatus('trace-1');
    expect(status.ok).toBe(true);
    if (status.ok) {
      expect(status.value.phase).toBe('warm');
      expect(status.value.remaining).toBe(50000);
    }
  });

  it('硬预算耗尽 → 拒绝', () => {
    recordUsage('trace-1', 95000);
    const result = checkTraceBudget('trace-1', 10000);
    expect(result.ok).toBe(false);
  });

  it('预算事件检测：阶段跨越产生事件', () => {
    const event1 = recordUsageAndDetect('trace-1', 30000);
    expect(event1).toBeNull(); // normal → normal (30000 < 36000)

    const event2 = recordUsageAndDetect('trace-1', 10000);
    expect(event2).not.toBeNull();
    expect(event2!.type).toBe('BUDGET_WARMING'); // 40000 >= 36000
  });

  it('单次调用上限检查', () => {
    expect(checkSingleCallLimit(3000).ok).toBe(true);
    expect(checkSingleCallLimit(6000).ok).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════
// 4. TaxCollector
// ═══════════════════════════════════════════════════════

describe('S7 · TaxCollector', () => {
  beforeEach(() => {
    resetTaxCollector();
    initTaxCollector({
      baseRate: 0.05, dynamicEnabled: true,
      adjustmentIntervalSec: 300, maxRate: 0.20, minRate: 0.02,
      highLoadMultiplier: 1.5, lowLoadDiscount: 0.8,
      loadThresholdAgents: 10,
    });
  });

  it('基础税额计算', () => {
    const result = calculateTax(1000);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(50); // 1000 * 0.05
  });

  it('动态税率：高负载上调', () => {
    const now = Date.now();
    const result = adjustTaxRate(15, now + 301000);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.newRate).toBeCloseTo(0.075); // 0.05 * 1.5
      expect(result.value.newRate).toBeLessThanOrEqual(0.20);
    }
  });

  it('动态税率：低负载下调', () => {
    const now = Date.now();
    const result = adjustTaxRate(5, now + 301000);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.newRate).toBeCloseTo(0.04); // 0.05 * 0.8
      expect(result.value.newRate).toBeGreaterThanOrEqual(0.02);
    }
  });

  it('税收分配：60/30/10', () => {
    const dist = distributeTax(100);
    expect(dist.systemFund).toBe(60);
    expect(dist.riskReserve).toBe(30);
    expect(dist.destroyed).toBe(10);
    expect(getTotalTaxCollected()).toBe(100);
    expect(getTotalDestroyed()).toBe(10);
  });
});

// ═══════════════════════════════════════════════════════
// 5. ProfitDistributor
// ═══════════════════════════════════════════════════════

describe('S7 · ProfitDistributor', () => {
  beforeEach(setupWallets);

  it('三维贡献分润', () => {
    const result = calculateDistribution([
      { agentId: 'a1', qualityScore: 0.9, outputTokens: 5000, elapsedMs: 10000 },
      { agentId: 'a2', qualityScore: 0.7, outputTokens: 3000, elapsedMs: 15000 },
      { agentId: 'a3', qualityScore: 0.5, outputTokens: 2000, elapsedMs: 20000 },
    ], 10000);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBe(3);
      // a1 综合分最高 → 份额最大
      expect(result.value[0].share).toBeGreaterThanOrEqual(result.value[1].share);
      // 总额 = tokenPool
      const total = result.value.reduce((sum, r) => sum + r.share, 0);
      expect(total).toBe(10000);
    }
  });

  it('空贡献 → 拒绝', () => {
    const result = calculateDistribution([], 10000);
    expect(result.ok).toBe(false);
  });

  it('权重和 ≠ 1 → 拒绝', () => {
    const result = calculateDistribution(
      [{ agentId: 'a1', qualityScore: 0.9, outputTokens: 5000, elapsedMs: 10000 }],
      10000,
      { qualityWeight: 0.5, quantityWeight: 0.3, efficiencyWeight: 0.3 },
    );
    expect(result.ok).toBe(false);
  });

  it('执行分润入账', () => {
    createWallet('a1', 'trace-1');
    createWallet('a2', 'trace-1');
    const dist = calculateDistribution([
      { agentId: 'a1', qualityScore: 0.8, outputTokens: 5000, elapsedMs: 10000 },
      { agentId: 'a2', qualityScore: 0.6, outputTokens: 3000, elapsedMs: 12000 },
    ], 5000);
    expect(dist.ok).toBe(true);
    if (dist.ok) {
      const execResult = executeDistribution(dist.value, 'trace-1', 'contract-1');
      expect(execResult.ok).toBe(true);
      // 验证钱包余额增加
      const w1 = getWallet('a1');
      expect(w1!.balance).toBeGreaterThan(DEFAULT_BALANCE);
    }
  });
});

// ═══════════════════════════════════════════════════════
// 6. Gate G7 综合验证
// ═══════════════════════════════════════════════════════

describe('S7 · Gate G7 综合验证', () => {
  beforeEach(() => {
    setupWallets();
    clearConsumptionRecords();
    clearLedger();
    resetDualBudget();
    resetTaxCollector();
    registerPricing({
      provider: 'openai', modelId: 'gpt-4o',
      costPer1kInput: 2.5, costPer1kOutput: 10.0, contextWindow: 128000,
    });
    initDualBudget({
      tokenBudget: 100000, warmRatio: 0.36, softRatio: 0.6,
      expandRequestRatio: 0.8, hardRatio: 1.0,
    });
    initTaxCollector({
      baseRate: 0.05, dynamicEnabled: true,
      adjustmentIntervalSec: 300, maxRate: 0.20, minRate: 0.02,
      highLoadMultiplier: 1.5, lowLoadDiscount: 0.8,
      loadThresholdAgents: 10,
    });
  });

  it('G7-1: Token 总量守恒（多次交易后）', () => {
    createWallet('agent-1', 'trace-1');
    createWallet('agent-2', 'trace-1');

    // 多次交易
    debit('agent-1', 2000, 'trace-1');
    credit('agent-2', 1500, 'trace-1');
    debit('agent-2', 500, 'trace-1');
    credit('agent-1', 1000, 'trace-1');

    const result = verifyConservation();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Math.abs(result.value.delta)).toBeLessThan(0.01);
    }
  });

  it('G7-2: 软预算 → 降级标记', () => {
    createWallet('agent-1', 'trace-1');
    const event = recordUsageAndDetect('trace-1', 65000);
    expect(event).not.toBeNull();
    expect(event!.type).toBe('BUDGET_SOFT_REACHED');
  });

  it('G7-3: 硬预算 → 拒绝', () => {
    createWallet('agent-1', 'trace-1');
    recordUsage('trace-1', 95000);
    const result = checkTraceBudget('trace-1', 10000);
    expect(result.ok).toBe(false);
  });

  it('G7-4: 每次消耗产生交易记录', () => {
    createWallet('agent-1', 'trace-1');
    recordConsumption({
      traceId: 'trace-1', agentId: 'agent-1', operationId: 'op-1',
      provider: 'openai', model: 'gpt-4o',
      promptTokens: 1000, completionTokens: 500,
      currentTaxRate: 0.05,
    });
    const records = getConsumptionRecords({ agentId: 'agent-1' });
    expect(records.length).toBe(1);
    expect(records[0].netDeduction).toBeGreaterThan(0);
    // 钱包余额应减少
    const wallet = getWallet('agent-1');
    expect(wallet!.balance).toBeLessThan(DEFAULT_BALANCE);
  });
});
