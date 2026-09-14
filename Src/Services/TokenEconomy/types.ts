/**
 * @module TokenEconomy/types
 * @description
 * Token 经济系统公共类型——Docs/04 §2。
 * 钱包、交易、消耗记录、税率等核心数据结构。
 */

// ── TransactionType（Docs/04 §2.2 · 11 成员）───────────────────────

export type TransactionType =
  | 'LLM_CONSUMPTION'
  | 'TASK_REWARD'
  | 'PROFIT_SHARING'
  | 'TAX_PAYMENT'
  | 'ARBITRATION_PENALTY'
  | 'ARBITRATION_COMPENSATION'
  | 'INITIAL_ALLOCATION'
  | 'FREEZE'
  | 'UNFREEZE'
  | 'CONFISCATION'
  | 'REFUND';

// ── WalletStatus ────────────────────────────────────────────────────

export type WalletStatus = 'active' | 'frozen' | 'closed';

// ── TokenWallet（Docs/04 §2.1）─────────────────────────────────────

export interface TokenWallet {
  walletId: string;
  agentId: string;
  balance: number;
  totalEarned: number;
  totalSpent: number;
  totalTaxPaid: number;
  totalFrozen: number;
  status: WalletStatus;
  createdAt: number;
  updatedAt: number;
}

// ── TokenTransaction（Docs/04 §2.2）────────────────────────────────

export interface TokenTransaction {
  transactionId: string;
  walletId: string;
  traceId: string;
  operationId?: string;
  type: TransactionType;
  amount: number;
  balanceAfter: number;
  description: string;
  metadata: Record<string, unknown>;
  createdAt: number;
}

// ── ConsumptionRecord（Docs/04 §2.3）───────────────────────────────

export interface ConsumptionRecord {
  recordId: string;
  traceId: string;
  agentId: string;
  operationId: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  unitCostPer1K: number;
  calculatedCost: number;
  taxAmount: number;
  netDeduction: number;
  startedAt: number;
  completedAt: number;
}

// ── TaxConfig（Docs/04 §4.1）───────────────────────────────────────

export interface TaxConfig {
  baseRate: number;
  dynamicEnabled: boolean;
  adjustmentIntervalSec: number;
  maxRate: number;
  minRate: number;
  highLoadMultiplier: number;
  lowLoadDiscount: number;
  loadThresholdAgents: number;
}

// ── ModelPricing（Docs/04 §6.1）────────────────────────────────────

export interface ModelPricing {
  provider: string;
  modelId: string;
  costPer1kInput: number;
  costPer1kOutput: number;
  contextWindow: number;
}

// ── EfficiencyMetrics（Docs/04 §5.2.2）─────────────────────────────

export interface EfficiencyMetrics {
  iteration: number;
  tokensSpent: number;
  goalDelta: number;
  newInformationBytes: number;
  repeatRatio: number;
}

// ── ProfitSharingConfig（Docs/04 §3.3）─────────────────────────────

export interface ProfitSharingConfig {
  qualityWeight: number;
  quantityWeight: number;
  efficiencyWeight: number;
}

// ── BudgetLimits ────────────────────────────────────────────────────

export interface BudgetLimits {
  singleCallMaxTokens: number;
  globalTraceHardTokens: number;
  globalTraceSoftRatio: number;
}

// ── RollingWindowConfig ─────────────────────────────────────────────

export interface RollingWindowConfig {
  tokens: number;
  windowSec: number;
  checkIntervalSec: number;
  deviationMultiplierWarn: number;
  deviationMultiplierCritical: number;
  budgetWarnRatio: number;
}
