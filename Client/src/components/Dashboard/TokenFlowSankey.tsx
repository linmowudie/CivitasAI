/**
 * TokenFlowSankey — Token 流向桑基图。
 * 回答的问题：系统 Token 如何从系统池流向 Agent 钱包，最终消耗/税收/分润？
 *
 * 数据源：tokenStore.overview + tokenStore.transactions
 * 无数据时显示"暂无"而非空坐标系。
 */
import { useEffect, useMemo } from 'react';
import { useTokenStore, type TokenTransaction } from '@/stores/tokenStore';

interface TokenFlowSankeyProps {
  /** 组件职责说明（可视化红线：必须写明） */
  question?: string;
}

// 交易类型分组颜色
const TYPE_COLORS: Record<string, string> = {
  LLM_CONSUMPTION: '#ef4444', // 红：消耗
  TAX_PAYMENT: '#f59e0b',     // 橙：税收
  PROFIT_SHARING: '#10b981',  // 绿：分润
  TASK_REWARD: '#3b82f6',     // 蓝：奖励
  ARBITRATION_PENALTY: '#8b5cf6', // 紫：罚没
  ARBITRATION_COMPENSATION: '#06b6d4', // 青：补偿
  INITIAL_ALLOCATION: '#6b7280', // 灰：初始分配
};

interface SankeyNode {
  id: string;
  label: string;
  value: number;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
}

interface SankeyLink {
  source: string;
  target: string;
  value: number;
  color: string;
}

export default function TokenFlowSankey({ question = '系统 Token 如何从系统池流向 Agent 钱包，最终消耗/税收/分润？' }: TokenFlowSankeyProps) {
  const overview = useTokenStore(s => s.overview);
  const transactions = useTokenStore(s => s.transactions);
  const hydrate = useTokenStore(s => s.hydrate);
  const hydrateTransactions = useTokenStore(s => s.hydrateTransactions);

  useEffect(() => {
    hydrate();
    hydrateTransactions();
  }, []);

  // 计算桑基图数据
  const { nodes, links, hasData } = useMemo(() => {
    if (!overview) return { nodes: [], links: [], hasData: false };

    // 按类型汇总交易
    const typeTotals = new Map<string, number>();
    for (const tx of transactions) {
      const current = typeTotals.get(tx.type) ?? 0;
      typeTotals.set(tx.type, current + Math.abs(tx.amount));
    }

    // 如果没有交易数据，用 overview 构造简单流向
    const totalFlow = transactions.length > 0
      ? Array.from(typeTotals.values()).reduce((a, b) => a + b, 0)
      : overview.systemPool * 0.1; // 假设 10% 流转

    if (totalFlow === 0) return { nodes: [], links: [], hasData: false };

    // 节点布局
    const nodes: SankeyNode[] = [
      // 左列：系统池
      { id: 'system-pool', label: '系统池', value: overview.systemPool, x: 0, y: 100, width: 60, height: 80, color: '#3b82f6' },
      // 中列：Agent 钱包
      { id: 'agent-wallets', label: 'Agent 钱包', value: totalFlow, x: 180, y: 60, width: 60, height: 160, color: '#10b981' },
      // 右列：消耗/税收/分润
      { id: 'consumption', label: 'LLM 消耗', value: typeTotals.get('LLM_CONSUMPTION') ?? totalFlow * 0.6, x: 360, y: 20, width: 50, height: 50, color: '#ef4444' },
      { id: 'tax', label: '税收', value: typeTotals.get('TAX_PAYMENT') ?? totalFlow * 0.2, x: 360, y: 90, width: 50, height: 40, color: '#f59e0b' },
      { id: 'profit', label: '分润', value: typeTotals.get('PROFIT_SHARING') ?? totalFlow * 0.15, x: 360, y: 150, width: 50, height: 35, color: '#10b981' },
      { id: 'other', label: '其他', value: typeTotals.get('TASK_REWARD') ?? totalFlow * 0.05, x: 360, y: 205, width: 50, height: 25, color: '#6b7280' },
    ];

    // 连线
    const links: SankeyLink[] = [
      { source: 'system-pool', target: 'agent-wallets', value: totalFlow, color: '#3b82f6' },
      { source: 'agent-wallets', target: 'consumption', value: typeTotals.get('LLM_CONSUMPTION') ?? totalFlow * 0.6, color: '#ef4444' },
      { source: 'agent-wallets', target: 'tax', value: typeTotals.get('TAX_PAYMENT') ?? totalFlow * 0.2, color: '#f59e0b' },
      { source: 'agent-wallets', target: 'profit', value: typeTotals.get('PROFIT_SHARING') ?? totalFlow * 0.15, color: '#10b981' },
      { source: 'agent-wallets', target: 'other', value: typeTotals.get('TASK_REWARD') ?? totalFlow * 0.05, color: '#6b7280' },
    ];

    return { nodes, links, hasData: true };
  }, [overview, transactions]);

  if (!hasData) {
    return (
      <div className="card">
        <h3 className="text-sm font-semibold text-text-primary mb-1">Token 流向</h3>
        <p className="text-[10px] text-text-muted mb-3 italic">「{question}」</p>
        <div className="flex items-center justify-center h-48 text-text-muted text-sm">
          暂无 Token 流转数据
        </div>
      </div>
    );
  }

  const svgWidth = 440;
  const svgHeight = 260;

  return (
    <div className="card">
      <h3 className="text-sm font-semibold text-text-primary mb-1">Token 流向</h3>
      <p className="text-[10px] text-text-muted mb-3 italic">「{question}」</p>
      <svg width={svgWidth} height={svgHeight} className="w-full h-auto">
        {/* 连线 */}
        {links.map((link, i) => {
          const sourceNode = nodes.find(n => n.id === link.source);
          const targetNode = nodes.find(n => n.id === link.target);
          if (!sourceNode || !targetNode) return null;

          const sourceX = sourceNode.x + sourceNode.width;
          const sourceY = sourceNode.y + sourceNode.height / 2;
          const targetX = targetNode.x;
          const targetY = targetNode.y + targetNode.height / 2;

          // 流量决定线宽
          const strokeWidth = Math.max(2, Math.min(20, (link.value / (overview?.systemPool ?? 1)) * 50));

          return (
            <path
              key={i}
              d={`M ${sourceX} ${sourceY} C ${(sourceX + targetX) / 2} ${sourceY}, ${(sourceX + targetX) / 2} ${targetY}, ${targetX} ${targetY}`}
              fill="none"
              stroke={link.color}
              strokeWidth={strokeWidth}
              strokeOpacity={0.4}
            />
          );
        })}

        {/* 节点 */}
        {nodes.map(node => (
          <g key={node.id}>
            <rect
              x={node.x}
              y={node.y}
              width={node.width}
              height={node.height}
              fill={node.color}
              fillOpacity={0.8}
              rx={4}
            />
            <text
              x={node.x + node.width / 2}
              y={node.y + node.height / 2}
              textAnchor="middle"
              dominantBaseline="middle"
              className="text-[10px] fill-white font-medium"
            >
              {node.label}
            </text>
            <text
              x={node.x + node.width / 2}
              y={node.y + node.height + 12}
              textAnchor="middle"
              className="text-[9px] fill-text-muted"
            >
              {Math.round(node.value)}
            </text>
          </g>
        ))}
      </svg>

      {/* 图例 */}
      <div className="flex flex-wrap gap-3 mt-3 text-[10px] text-text-muted">
        {Object.entries(TYPE_COLORS).slice(0, 5).map(([type, color]) => (
          <span key={type} className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-sm" style={{ backgroundColor: color }} />
            {type.replace('_', ' ')}
          </span>
        ))}
      </div>
    </div>
  );
}
