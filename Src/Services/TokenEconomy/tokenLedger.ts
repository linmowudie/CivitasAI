/**
 * @module TokenEconomy/tokenLedger
 * @description
 * Token 账本——Docs/04 §7。
 * 保证 Token 总量守恒，每笔交易可追溯。
 * 每次交易后验证守恒，异常时广播 LEDGER_MISMATCH。
 */

import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';

import type { TokenTransaction, TransactionType } from './types.js';

// ── 内部状态 ────────────────────────────────────────────────────────

const ledger: TokenTransaction[] = [];
let mismatchCount = 0;

// ── 记录交易 ────────────────────────────────────────────────────────

export function appendTransaction(tx: TokenTransaction): void {
  ledger.push({ ...tx });
}

// ── 查询 ────────────────────────────────────────────────────────────

export function getLedgerTransactions(filter?: {
  walletId?: string;
  traceId?: string;
  type?: TransactionType;
}): TokenTransaction[] {
  let result = ledger;
  if (filter?.walletId) result = result.filter(t => t.walletId === filter.walletId);
  if (filter?.traceId) result = result.filter(t => t.traceId === filter.traceId);
  if (filter?.type) result = result.filter(t => t.type === filter.type);
  return [...result];
}

export function getTransactionCount(): number {
  return ledger.length;
}

// ── 守恒验证（Docs/04 §7.1）────────────────────────────────────────

/**
 * 全局守恒校验：
 * Σ(wallet.balance) + systemPool + destroyed = initialSupply + Σ(外部注入) - Σ(销毁)
 */
export function verifyLedgerConservation(
  totalWalletBalance: number,
  systemPool: number,
  destroyedTotal: number,
  initialSupply: number,
  externalInjections: number = 0,
): Result<{ expected: number; actual: number; delta: number }> {
  const actual = totalWalletBalance + systemPool + destroyedTotal;
  const expected = initialSupply + externalInjections - destroyedTotal;
  const delta = actual - expected;

  if (Math.abs(delta) > 0.01) {
    mismatchCount++;
    return err(`LEDGER_MISMATCH #${mismatchCount}: expected=${expected}, actual=${actual}, delta=${delta}`);
  }
  return ok({ expected, actual, delta });
}

/**
 * 单 trace 交易汇总校验
 */
export function summarizeTrace(traceId: string): {
  totalConsumed: number;
  totalEarned: number;
  totalTax: number;
  transactionCount: number;
} {
  const traceTxs = ledger.filter(t => t.traceId === traceId);
  let totalConsumed = 0;
  let totalEarned = 0;
  let totalTax = 0;

  for (const tx of traceTxs) {
    switch (tx.type) {
      case 'LLM_CONSUMPTION':
        totalConsumed += Math.abs(tx.amount);
        break;
      case 'TASK_REWARD':
      case 'PROFIT_SHARING':
      case 'ARBITRATION_COMPENSATION':
      case 'REFUND':
        totalEarned += tx.amount;
        break;
      case 'TAX_PAYMENT':
        totalTax += Math.abs(tx.amount);
        break;
    }
  }

  return { totalConsumed, totalEarned, totalTax, transactionCount: traceTxs.length };
}

/**
 * 获取不匹配计数
 */
export function getMismatchCount(): number {
  return mismatchCount;
}

/**
 * 清空账本（测试用）
 */
export function clearLedger(): void {
  ledger.length = 0;
  mismatchCount = 0;
}
