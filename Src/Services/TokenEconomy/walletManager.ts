/**
 * @module TokenEconomy/walletManager
 * @description
 * 钱包管理器——Docs/04 §3。
 * 为每个 Agent 创建/销毁独立 Token 钱包，处理余额变动、冻结/解冻。
 * 每次变动产生一条交易记录，保证可追溯。
 */

import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';

import type { TokenWallet, TokenTransaction, TransactionType } from './types.js';

// ── 内部状态 ────────────────────────────────────────────────────────

const wallets: Map<string, TokenWallet> = new Map();
const transactions: TokenTransaction[] = [];
let initialSupply = 0;
let systemPool = 0;
let destroyedTotal = 0;
let defaultBalance = 10000;

// ── 初始化 ──────────────────────────────────────────────────────────

export interface WalletManagerConfig {
  initialSupply: number;
  defaultWalletBalance: number;
}

export function initWalletManager(config: WalletManagerConfig): void {
  initialSupply = config.initialSupply;
  systemPool = config.initialSupply;
  defaultBalance = config.defaultWalletBalance;
}

// ── 钱包 CRUD ───────────────────────────────────────────────────────

/**
 * 创建钱包——新建 Agent 时调用。
 * 从系统池扣减默认余额。
 */
export function createWallet(agentId: string, traceId: string): Result<TokenWallet> {
  if (wallets.has(agentId)) {
    return err(`Agent ${agentId} 钱包已存在`);
  }
  if (systemPool < defaultBalance) {
    return err(`系统池余额不足 (pool=${systemPool}, need=${defaultBalance})`);
  }

  const now = Date.now();
  const walletId = `w-${agentId}-${now}`;

  const wallet: TokenWallet = {
    walletId,
    agentId,
    balance: defaultBalance,
    totalEarned: defaultBalance,
    totalSpent: 0,
    totalTaxPaid: 0,
    totalFrozen: 0,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };

  wallets.set(agentId, wallet);
  systemPool -= defaultBalance;

  // 记录初始分配交易
  recordTransaction({
    walletId,
    traceId,
    type: 'INITIAL_ALLOCATION',
    amount: defaultBalance,
    balanceAfter: defaultBalance,
    description: `初始分配 ${defaultBalance} Token`,
    metadata: { agentId },
  });

  return ok(wallet);
}

/**
 * 检查余额是否充足
 */
export function checkBalance(agentId: string, estimatedCost: number): Result<boolean> {
  const wallet = wallets.get(agentId);
  if (!wallet) return err(`Agent ${agentId} 钱包不存在`);
  if (wallet.status === 'frozen') return err(`Agent ${agentId} 钱包已冻结`);
  if (wallet.status === 'closed') return err(`Agent ${agentId} 钱包已关闭`);
  return ok(wallet.balance >= estimatedCost);
}

/**
 * 扣减钱包余额——LLM 调用消耗时调用。
 */
export function debit(
  agentId: string,
  amount: number,
  traceId: string,
  type: TransactionType = 'LLM_CONSUMPTION',
  metadata: Record<string, unknown> = {},
): Result<TokenWallet> {
  const wallet = wallets.get(agentId);
  if (!wallet) return err(`Agent ${agentId} 钱包不存在`);
  if (wallet.status !== 'active') return err(`Agent ${agentId} 钱包状态 ${wallet.status}，不可扣减`);
  if (amount <= 0) return err(`扣减金额必须为正数 (${amount})`);
  if (wallet.balance < amount) return err(`余额不足 (balance=${wallet.balance}, need=${amount})`);

  wallet.balance -= amount;
  wallet.totalSpent += amount;
  systemPool += amount; // Token 回到系统池
  wallet.updatedAt = Date.now();

  recordTransaction({
    walletId: wallet.walletId,
    traceId,
    type,
    amount: -amount,
    balanceAfter: wallet.balance,
    description: `扣减 ${amount} Token (${type})`,
    metadata: { agentId, ...metadata },
  });

  return ok({ ...wallet });
}

/**
 * 增加钱包余额——任务奖励/分润时调用。
 */
export function credit(
  agentId: string,
  amount: number,
  traceId: string,
  type: TransactionType = 'TASK_REWARD',
  metadata: Record<string, unknown> = {},
): Result<TokenWallet> {
  const wallet = wallets.get(agentId);
  if (!wallet) return err(`Agent ${agentId} 钱包不存在`);
  if (wallet.status === 'closed') return err(`Agent ${agentId} 钱包已关闭`);
  if (amount <= 0) return err(`入账金额必须为正数 (${amount})`);
  if (systemPool < amount) return err(`系统池余额不足 (pool=${systemPool}, need=${amount})`);

  wallet.balance += amount;
  wallet.totalEarned += amount;
  systemPool -= amount;
  wallet.updatedAt = Date.now();

  recordTransaction({
    walletId: wallet.walletId,
    traceId,
    type,
    amount,
    balanceAfter: wallet.balance,
    description: `入账 ${amount} Token (${type})`,
    metadata: { agentId, ...metadata },
  });

  return ok({ ...wallet });
}

/**
 * 冻结钱包——Audit Bureau 触发。
 */
export function freezeWallet(agentId: string, reason: string, traceId: string): Result<TokenWallet> {
  const wallet = wallets.get(agentId);
  if (!wallet) return err(`Agent ${agentId} 钱包不存在`);
  if (wallet.status === 'frozen') return err(`Agent ${agentId} 钱包已冻结`);

  wallet.status = 'frozen';
  wallet.totalFrozen = wallet.balance;
  wallet.updatedAt = Date.now();

  recordTransaction({
    walletId: wallet.walletId,
    traceId,
    type: 'FREEZE',
    amount: 0,
    balanceAfter: wallet.balance,
    description: `钱包冻结: ${reason}`,
    metadata: { agentId, reason },
  });

  return ok({ ...wallet });
}

/**
 * 解冻钱包——稽查误报时调用。
 */
export function unfreezeWallet(agentId: string, traceId: string): Result<TokenWallet> {
  const wallet = wallets.get(agentId);
  if (!wallet) return err(`Agent ${agentId} 钱包不存在`);
  if (wallet.status !== 'frozen') return err(`Agent ${agentId} 钱包未冻结`);

  wallet.status = 'active';
  wallet.totalFrozen = 0;
  wallet.updatedAt = Date.now();

  recordTransaction({
    walletId: wallet.walletId,
    traceId,
    type: 'UNFREEZE',
    amount: 0,
    balanceAfter: wallet.balance,
    description: '钱包解冻',
    metadata: { agentId },
  });

  return ok({ ...wallet });
}

/**
 * 罚没——稽查确认后调用。
 */
export function confiscate(agentId: string, amount: number, traceId: string): Result<TokenWallet> {
  const wallet = wallets.get(agentId);
  if (!wallet) return err(`Agent ${agentId} 钱包不存在`);
  if (wallet.balance < amount) return err(`余额不足罚没 (balance=${wallet.balance}, confiscate=${amount})`);

  wallet.balance -= amount;
  wallet.totalSpent += amount;
  wallet.updatedAt = Date.now();

  recordTransaction({
    walletId: wallet.walletId,
    traceId,
    type: 'CONFISCATION',
    amount: -amount,
    balanceAfter: wallet.balance,
    description: `罚没 ${amount} Token`,
    metadata: { agentId },
  });

  return ok({ ...wallet });
}

// ── 查询 ────────────────────────────────────────────────────────────

export function getWallet(agentId: string): TokenWallet | undefined {
  const w = wallets.get(agentId);
  return w ? { ...w } : undefined;
}

export function getAllWallets(): TokenWallet[] {
  return [...wallets.values()].map(w => ({ ...w }));
}

export function getTransactions(walletId?: string): TokenTransaction[] {
  if (walletId) return transactions.filter(t => t.walletId === walletId);
  return [...transactions];
}

// ── 守恒验证（Docs/04 §7.1）────────────────────────────────────────

/**
 * 验证 Token 总量守恒：
 * Σ(wallet.balance) + systemPool + destroyed = initialSupply - Σ(销毁)
 */
export function verifyConservation(): Result<{ expected: number; actual: number; delta: number }> {
  const totalBalance = getAllWallets().reduce((sum, w) => sum + w.balance, 0);
  const actual = totalBalance + systemPool + destroyedTotal;
  const expected = initialSupply;
  const delta = actual - expected;

  if (Math.abs(delta) > 0.01) {
    return err(`Token 守恒异常: expected=${expected}, actual=${actual}, delta=${delta}`);
  }
  return ok({ expected, actual, delta });
}

// ── 内部辅助 ────────────────────────────────────────────────────────

function recordTransaction(input: {
  walletId: string;
  traceId: string;
  type: TransactionType;
  amount: number;
  balanceAfter: number;
  description: string;
  metadata: Record<string, unknown>;
}): void {
  transactions.push({
    transactionId: `tx-${Date.now()}-${transactions.length}`,
    walletId: input.walletId,
    traceId: input.traceId,
    type: input.type,
    amount: input.amount,
    balanceAfter: input.balanceAfter,
    description: input.description,
    metadata: input.metadata,
    createdAt: Date.now(),
  });
}

/**
 * 清空所有状态（测试用）
 */
export function resetWalletManager(): void {
  wallets.clear();
  transactions.length = 0;
  initialSupply = 0;
  systemPool = 0;
  destroyedTotal = 0;
}

/** 获取系统池余额 */
export function getSystemPool(): number {
  return systemPool;
}

/** 记录纳税（由 taxCollector 调用） */
export function recordTaxPayment(agentId: string, taxAmount: number, _traceId: string): Result<TokenWallet> {
  const wallet = wallets.get(agentId);
  if (!wallet) return err(`Agent ${agentId} 钱包不存在`);

  wallet.totalTaxPaid += taxAmount;
  wallet.updatedAt = Date.now();
  return ok({ ...wallet });
}
