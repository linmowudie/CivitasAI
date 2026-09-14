/**
 * TokenLedger — Token 账本视图。
 * 钱包总览 / 流水筛选 / 消耗柱状 / 税率折线。
 *
 * 数据源：tokenStore（GET /api/tokens/overview + /transactions + /wallets）
 */
import { useState, useEffect, useMemo } from 'react';
import { Wallet, ArrowUpRight, ArrowDownRight, Filter } from 'lucide-react';
import { useTokenStore, type TokenTransaction } from '@/stores/tokenStore';
import { apiGet } from '@/services/api';

interface WalletInfo {
  agentId: string;
  balance: number;
  status: string;
  createdAt: number;
}

const TX_TYPE_COLORS: Record<string, string> = {
  LLM_CONSUMPTION: 'text-danger',
  TASK_REWARD: 'text-success',
  PROFIT_SHARING: 'text-success',
  TAX_PAYMENT: 'text-warning',
  ARBITRATION_PENALTY: 'text-danger',
  ARBITRATION_COMPENSATION: 'text-info',
  INITIAL_ALLOCATION: 'text-text-muted',
  FREEZE: 'text-text-muted',
  UNFREEZE: 'text-brand-400',
  CONFISCATION: 'text-danger',
  REFUND: 'text-info',
};

export default function TokenLedger() {
  const overview = useTokenStore(s => s.overview);
  const transactions = useTokenStore(s => s.transactions);
  const hydrate = useTokenStore(s => s.hydrate);
  const hydrateTransactions = useTokenStore(s => s.hydrateTransactions);

  const [wallets, setWallets] = useState<WalletInfo[]>([]);
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [walletFilter, setWalletFilter] = useState<string>('all');

  useEffect(() => {
    hydrate();
    hydrateTransactions();
    apiGet<WalletInfo[]>('/api/tokens/wallets').then(res => {
      if (res.ok) setWallets(res.data);
    });
  }, []);

  // 过滤后的交易
  const filteredTx = useMemo(() => {
    let txs = [...transactions];
    if (typeFilter !== 'all') txs = txs.filter(t => t.type === typeFilter);
    if (walletFilter !== 'all') txs = txs.filter(t => t.walletId === walletFilter);
    return txs.sort((a, b) => b.createdAt - a.createdAt);
  }, [transactions, typeFilter, walletFilter]);

  // 消耗统计（按类型分组）
  const consumptionByType = useMemo(() => {
    const map = new Map<string, number>();
    for (const tx of transactions) {
      if (tx.type === 'LLM_CONSUMPTION' || tx.type === 'TAX_PAYMENT') {
        map.set(tx.type, (map.get(tx.type) ?? 0) + Math.abs(tx.amount));
      }
    }
    return map;
  }, [transactions]);

  // 唯一钱包 ID 列表
  const walletIds = useMemo(() =>
    [...new Set(transactions.map(t => t.walletId))],
    [transactions]
  );

  const txTypes = [...new Set(transactions.map(t => t.type))];

  return (
    <div className="p-6 space-y-5">
      <div>
        <h1 className="text-xl font-bold text-text-primary">Token 账本</h1>
        <p className="text-xs text-text-muted mt-0.5">钱包总览 · 流水筛选 · 消耗统计</p>
      </div>

      {/* ── 钱包总览卡片 ─────────────────────────── */}
      <div className="grid grid-cols-5 gap-4">
        <MetricCard label="系统池" value={overview?.systemPool ?? 0} color="text-brand-400" />
        <MetricCard label="已征税" value={overview?.totalTaxCollected ?? 0} color="text-warning" />
        <MetricCard label="已销毁" value={overview?.totalDestroyed ?? 0} color="text-danger" />
        <MetricCard label="当前税率" value={`${((overview?.currentTaxRate ?? 0) * 100).toFixed(1)}%`} color="text-info" isString />
        <MetricCard label="钱包数" value={overview?.walletCount ?? 0} color="text-success" />
      </div>

      {/* ── 消耗柱状（简化 SVG）────────────────────── */}
      {consumptionByType.size > 0 && (
        <div className="card">
          <h3 className="text-sm font-semibold text-text-primary mb-3">消耗分布</h3>
          <div className="flex items-end gap-6 h-24">
            {Array.from(consumptionByType.entries()).map(([type, amount]) => {
              const maxAmount = Math.max(...consumptionByType.values());
              const heightPct = maxAmount > 0 ? (amount / maxAmount) * 100 : 0;
              return (
                <div key={type} className="flex flex-col items-center gap-1 flex-1">
                  <span className="text-[10px] text-text-muted font-mono">{Math.round(amount)}</span>
                  <div
                    className={`w-full rounded-t ${type === 'LLM_CONSUMPTION' ? 'bg-danger/60' : 'bg-warning/60'}`}
                    style={{ height: `${Math.max(4, heightPct)}%` }}
                  />
                  <span className="text-[9px] text-text-muted">{type === 'LLM_CONSUMPTION' ? 'LLM消耗' : '税收'}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── 钱包列表 ─────────────────────────────── */}
      {wallets.length > 0 && (
        <div className="card">
          <h3 className="text-sm font-semibold text-text-primary mb-3">钱包列表</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-text-muted text-left border-b border-surface-700">
                  <th className="pb-2 font-medium">Agent</th>
                  <th className="pb-2 font-medium text-right">余额</th>
                  <th className="pb-2 font-medium text-right">状态</th>
                </tr>
              </thead>
              <tbody>
                {wallets.map(w => (
                  <tr key={w.agentId} className="border-b border-surface-800">
                    <td className="py-2 font-mono text-text-primary">{w.agentId.slice(0, 16)}</td>
                    <td className="py-2 text-right font-mono text-text-primary">{Math.round(w.balance)}</td>
                    <td className="py-2 text-right">
                      <span className={`badge text-[9px] ${w.status === 'active' ? 'badge-success' : 'badge'}`}>
                        {w.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── 流水筛选 ─────────────────────────────── */}
      <div className="card">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-text-primary">交易流水</h3>
          <div className="flex items-center gap-2">
            <Filter size={12} className="text-text-muted" />
            <select
              value={typeFilter}
              onChange={e => setTypeFilter(e.target.value)}
              className="bg-surface-800 text-xs text-text-primary border border-surface-700 rounded px-2 py-1 outline-none"
            >
              <option value="all">全部类型</option>
              {txTypes.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <select
              value={walletFilter}
              onChange={e => setWalletFilter(e.target.value)}
              className="bg-surface-800 text-xs text-text-primary border border-surface-700 rounded px-2 py-1 outline-none"
            >
              <option value="all">全部钱包</option>
              {walletIds.map(id => <option key={id} value={id}>{id.slice(0, 12)}</option>)}
            </select>
          </div>
        </div>

        {filteredTx.length === 0 ? (
          <div className="text-center py-8 text-text-muted text-sm">暂无交易数据</div>
        ) : (
          <div className="space-y-1 max-h-80 overflow-y-auto">
            {filteredTx.slice(0, 50).map(tx => (
              <div key={tx.transactionId} className="flex items-center gap-3 p-2.5 rounded-lg hover:bg-surface-700/50 transition-colors">
                <div className={`w-6 h-6 rounded flex items-center justify-center ${tx.amount > 0 ? 'bg-success/15' : 'bg-danger/15'}`}>
                  {tx.amount > 0 ? <ArrowDownRight size={12} className="text-success" /> : <ArrowUpRight size={12} className="text-danger" />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={`text-xs font-mono ${TX_TYPE_COLORS[tx.type] ?? 'text-text-secondary'}`}>
                      {tx.type}
                    </span>
                    <span className="text-[10px] text-text-muted font-mono truncate">{tx.description}</span>
                  </div>
                  <div className="text-[10px] text-text-muted font-mono">
                    {tx.walletId.slice(0, 12)} · {new Date(tx.createdAt).toLocaleTimeString('zh-CN')}
                  </div>
                </div>
                <span className={`text-xs font-mono font-semibold ${tx.amount > 0 ? 'text-success' : 'text-danger'}`}>
                  {tx.amount > 0 ? '+' : ''}{tx.amount}
                </span>
              </div>
            ))}
            {filteredTx.length > 50 && (
              <div className="text-center text-[10px] text-text-muted py-2">
                显示前 50 条，共 {filteredTx.length} 条
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── 指标卡片 ─────────────────────────────────────── */
function MetricCard({ label, value, color, isString }: { label: string; value: number | string; color: string; isString?: boolean }) {
  return (
    <div className="card">
      <div className="text-[10px] text-text-muted uppercase tracking-wider mb-1">{label}</div>
      <div className={`text-lg font-bold font-mono ${color}`}>
        {isString ? value : Math.round(value as number).toLocaleString()}
      </div>
    </div>
  );
}
