/**
 * @module TokenEconomy/index
 * @description
 * Token 经济系统统一导出——Docs/04。
 */

// ── 类型 ────────────────────────────────────────────────────────────
export type {
  TransactionType, WalletStatus, TokenWallet, TokenTransaction,
  ConsumptionRecord, TaxConfig, ModelPricing, EfficiencyMetrics,
  ProfitSharingConfig, BudgetLimits, RollingWindowConfig,
} from './types.js';

// ── WalletManager ───────────────────────────────────────────────────
export {
  initWalletManager, createWallet, checkBalance, debit, credit,
  freezeWallet, unfreezeWallet, confiscate, getWallet, getAllWallets,
  getTransactions, verifyConservation, resetWalletManager,
  getSystemPool, recordTaxPayment,
} from './walletManager.js';
export type { WalletManagerConfig } from './walletManager.js';

// ── TokenLedger ─────────────────────────────────────────────────────
export {
  appendTransaction, getLedgerTransactions, getTransactionCount,
  verifyLedgerConservation, summarizeTrace, getMismatchCount, clearLedger,
} from './tokenLedger.js';

// ── ConsumptionRecorder ─────────────────────────────────────────────
export {
  registerPricing, getPricing, recordConsumption,
  getConsumptionRecords, getTotalConsumption, clearConsumptionRecords,
} from './consumptionRecorder.js';
export type { RecordConsumptionInput } from './consumptionRecorder.js';

// ── DualBudget ──────────────────────────────────────────────────────
export {
  initDualBudget, detectPhase, getBudgetStatus, recordUsage,
  checkSingleCallLimit, checkTraceBudget, recordUsageAndDetect,
  resetDualBudget, getTraceUsage,
} from './dualBudget.js';
export type { BudgetPhase, DualBudgetConfig, BudgetStatus, BudgetEvent } from './dualBudget.js';

// ── TaxCollector ────────────────────────────────────────────────────
export {
  initTaxCollector, getCurrentTaxRate, getTaxConfig, calculateTax,
  adjustTaxRate, distributeTax, getTotalTaxCollected, getTotalDestroyed,
  resetTaxCollector,
} from './taxCollector.js';

// ── ProfitDistributor ───────────────────────────────────────────────
export {
  calculateDistribution, executeDistribution,
} from './profitDistributor.js';
export type { PartnerContribution, DistributionResult } from './profitDistributor.js';
