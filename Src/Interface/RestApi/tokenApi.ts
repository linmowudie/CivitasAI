/**
 * @module Interface/RestApi/tokenApi
 * @description
 * Token API——Docs/09 §2.4。
 * 钱包总览 / 交易流水 / 系统池余额 / 税率。
 */

import { json, apiError, registerRoute } from './router.js';
import { getAllWallets, getWallet, getTransactions, getSystemPool } from '../../Services/TokenEconomy/walletManager.js';
import { getCurrentTaxRate, getTotalTaxCollected, getTotalDestroyed } from '../../Services/TokenEconomy/taxCollector.js';

/**
 * GET /api/tokens/overview — Token 总览
 */
export function getTokenOverview(): {
  systemPool: number;
  totalTaxCollected: number;
  totalDestroyed: number;
  currentTaxRate: number;
  walletCount: number;
} {
  return {
    systemPool: getSystemPool(),
    totalTaxCollected: getTotalTaxCollected(),
    totalDestroyed: getTotalDestroyed(),
    currentTaxRate: getCurrentTaxRate(),
    walletCount: getAllWallets().length,
  };
}

/**
 * GET /api/tokens/wallets — 钱包列表
 */
export function listWallets(): unknown[] {
  return getAllWallets();
}

/**
 * GET /api/tokens/wallets/:agentId — Agent 钱包详情
 */
export function getWalletDetail(agentId: string): unknown | undefined {
  return getWallet(agentId);
}

/**
 * GET /api/tokens/transactions — 交易流水
 */
export function listTransactions(filter?: { walletId?: string }): unknown[] {
  return getTransactions(filter?.walletId);
}

// ── 路由注册 ────────────────────────────────────────────────────────

export function registerTokenRoutes(): void {
  registerRoute('GET', '/api/tokens/overview', async () => {
    return json(getTokenOverview());
  });

  registerRoute('GET', '/api/tokens/wallets', async () => {
    return json(listWallets());
  });

  registerRoute('GET', '/api/tokens/wallets/:agentId', async (req) => {
    const wallet = getWalletDetail(req.params.agentId);
    if (!wallet) return apiError('Wallet not found', 404);
    return json(wallet);
  });

  registerRoute('GET', '/api/tokens/transactions', async (req) => {
    const filter = req.query.walletId ? { walletId: req.query.walletId } : undefined;
    return json(listTransactions(filter));
  });
}
