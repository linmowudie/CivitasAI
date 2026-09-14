/**
 * @module TokenEconomy/taxCollector
 * @description
 * 税收征收器——Docs/04 §4。
 * 支持固定税率 + 动态税率调节（高负载/低负载）。
 * 税收用途：60% 系统运转基金 / 30% 风险准备金 / 10% 销毁。
 */

import type { TaxConfig } from './types.js';
import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';

// ── 内部状态 ────────────────────────────────────────────────────────

let config: TaxConfig | null = null;
let currentRate = 0.05;
let lastAdjustmentTime = 0;
let totalTaxCollected = 0;
let totalDestroyed = 0;

// ── 初始化 ──────────────────────────────────────────────────────────

export function initTaxCollector(taxConfig: TaxConfig): void {
  config = { ...taxConfig };
  currentRate = taxConfig.baseRate;
  lastAdjustmentTime = Date.now();
}

// ── 税率查询 ────────────────────────────────────────────────────────

export function getCurrentTaxRate(): number {
  return currentRate;
}

export function getTaxConfig(): TaxConfig | null {
  return config ? { ...config } : null;
}

// ── 税额计算 ────────────────────────────────────────────────────────

/**
 * 计算税额
 */
export function calculateTax(amount: number): Result<number> {
  if (!config) return err('税收系统未初始化');
  if (amount < 0) return err(`税额计算基数不能为负 (${amount})`);
  return ok(Math.ceil(amount * currentRate));
}

// ── 动态税率调节（Docs/04 §4.2）─────────────────────────────────────

/**
 * 根据系统负载调整税率
 *
 * 每 adjustmentIntervalSec 秒执行一次：
 * - 高负载（活跃 Agent > 阈值）→ 税率 × highLoadMultiplier（上限 maxRate）
 * - 低负载 → 税率 × lowLoadDiscount（下限 minRate）
 */
export function adjustTaxRate(activeAgentCount: number, now: number = Date.now()): Result<{ oldRate: number; newRate: number }> {
  if (!config) return err('税收系统未初始化');

  // 检查是否到达调整时间
  const elapsed = (now - lastAdjustmentTime) / 1000;
  if (elapsed < config.adjustmentIntervalSec) {
    return ok({ oldRate: currentRate, newRate: currentRate });
  }

  const oldRate = currentRate;

  if (!config.dynamicEnabled) {
    currentRate = config.baseRate;
  } else if (activeAgentCount > config.loadThresholdAgents) {
    // 高负载
    currentRate = Math.min(config.baseRate * config.highLoadMultiplier, config.maxRate);
  } else {
    // 低负载
    currentRate = Math.max(config.baseRate * config.lowLoadDiscount, config.minRate);
  }

  lastAdjustmentTime = now;
  return ok({ oldRate, newRate: currentRate });
}

// ── 税收分配（Docs/04 §4.3）─────────────────────────────────────────

/**
 * 分配税收：60% 系统运转基金 / 30% 风险准备金 / 10% 销毁
 */
export function distributeTax(taxAmount: number): {
  systemFund: number;
  riskReserve: number;
  destroyed: number;
} {
  const systemFund = Math.floor(taxAmount * 0.6);
  const riskReserve = Math.floor(taxAmount * 0.3);
  const destroyed = taxAmount - systemFund - riskReserve;

  totalTaxCollected += taxAmount;
  totalDestroyed += destroyed;

  return { systemFund, riskReserve, destroyed };
}

// ── 统计 ────────────────────────────────────────────────────────────

export function getTotalTaxCollected(): number {
  return totalTaxCollected;
}

export function getTotalDestroyed(): number {
  return totalDestroyed;
}

export function resetTaxCollector(): void {
  config = null;
  currentRate = 0.05;
  lastAdjustmentTime = 0;
  totalTaxCollected = 0;
  totalDestroyed = 0;
}
