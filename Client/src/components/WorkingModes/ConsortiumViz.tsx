/**
 * CONSORTIUM 模式可视化——多域 Partner 泳道 + Token 液面柱 + 全局屏障。
 *
 * 设计参考：
 *   - ZenML Timeline View + Swimlane Diagram（每 Partner 一条泳道）
 *   - Fluid Token Dashboard（Bilibili：AI 账单流体仪表盘，液面下降 + 三色阈值）
 *   - Kimi Agent 集群模式（树状监控各子 Agent 状态、负载、心跳）
 *
 * 回答的问题：多 Partner 各自攻坚进度如何？钱包消耗是否均衡？屏障对齐时刻谁在拖延？
 */
import ModeShell, { TimeAxis } from './ModeShell';
import { DEMO_CONSORTIUM, fmtMs, STATUS_COLOR, type ConsortiumDemo } from './demoData';

function WalletLiquid({ initial, balance }: { initial: number; balance: number }) {
  const used = initial - balance;
  const pct = used / initial; // 已消耗占比
  const fillPct = balance / initial; // 液面剩余
  const color = pct > 0.3 ? '#ef4444' : pct > 0.15 ? '#f59e0b' : '#22d3ee';
  const height = 60;
  const liquidHeight = height * fillPct;
  return (
    <div className="flex flex-col items-center gap-1">
      <div className="relative" style={{ width: 24, height }}>
        <svg width={24} height={height}>
          <defs>
            <clipPath id={`clip-${initial}-${balance}`}>
              <rect x={0} y={0} width={24} height={height} rx={4} />
            </clipPath>
            <linearGradient id={`grad-${color.slice(1)}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.85} />
              <stop offset="100%" stopColor={color} stopOpacity={0.4} />
            </linearGradient>
          </defs>
          {/* 外框 */}
          <rect x={0.5} y={0.5} width={23} height={height - 1} rx={4}
            fill="none" stroke="#252f47" />
          <g clipPath={`url(#clip-${initial}-${balance})`}>
            <rect x={0} y={height - liquidHeight} width={24} height={liquidHeight}
              fill={`url(#grad-${color.slice(1)})`}
              style={{ transition: 'y 400ms ease, height 400ms ease' }} />
            {/* 波浪顶 */}
            <ellipse cx={12} cy={height - liquidHeight} rx={12} ry={2} fill={color} fillOpacity={0.9} />
          </g>
        </svg>
      </div>
      <div className="text-[10px] font-mono" style={{ color }}>
        {balance}
      </div>
    </div>
  );
}

export default function ConsortiumViz({ data = DEMO_CONSORTIUM }: { data?: ConsortiumDemo }) {
  const totalSpan = Math.max(data.barrierAt, ...data.partners.map(p => p.end));
  const laneH = 32;
  const laneGap = 8;
  const topPad = 8;
  const width = 720;
  const leftGutter = 90;
  const rightGutter = 90;
  const chartW = width - leftGutter - rightGutter;
  const barrierX = (data.barrierAt / totalSpan) * chartW + leftGutter;

  const xOf = (ms: number) => leftGutter + (ms / totalSpan) * chartW;
  const wOf = (ms: number) => (ms / totalSpan) * chartW;

  const totalConsumed = data.partners.reduce((s, p) => s + (p.walletInitial - p.walletBalance), 0);
  const wallets = data.partners.map(p => p.walletInitial - p.walletBalance);
  const walletVariance = Math.max(...wallets) - Math.min(...wallets);
  const balanceHealth = walletVariance > 1000 ? '负载失衡' : walletVariance > 400 ? '轻微失衡' : '钱包消耗均衡';

  return (
    <ModeShell
      mode="CONSORTIUM"
      title="多 Partner 攻坚 · 泳道 + 独立钱包 + 收敛屏障"
      question="多 Partner 各自进度如何？钱包消耗是否均衡？屏障时刻谁在拖延？"
      reference="ZenML Timeline Swimlane + Fluid Token 液面 + Kimi 集群模式心跳监控"
    >
      <div className="text-[11px] text-text-secondary mb-3">
        <span className="font-mono text-text-muted">任务：</span>{data.description}
      </div>

      {/* ── 泳道甘特 ─────────────────────────── */}
      <div className="rounded bg-surface-900 border border-surface-700 p-2 overflow-x-auto">
        <svg width={width} height={topPad + data.partners.length * (laneH + laneGap) + 4} className="block">
          {data.partners.map((p, i) => {
            const y = topPad + i * (laneH + laneGap);
            const color = STATUS_COLOR[p.status];
            return (
              <g key={p.partnerId}>
                <text x={leftGutter - 6} y={y + laneH / 2 + 4} textAnchor="end"
                  className="text-[11px] fill-text-primary font-semibold">
                  {p.domain}
                </text>
                {/* 轨道背景 */}
                <rect x={leftGutter} y={y + 4} width={chartW} height={laneH - 8} rx={3}
                  fill="#1c2438" fillOpacity={0.4} />
                {/* 执行条 */}
                <rect x={xOf(p.start)} y={y + 4} width={wOf(p.end - p.start)} height={laneH - 8}
                  rx={3} fill={color} fillOpacity={0.85} />
                <text x={xOf(p.start) + 6} y={y + laneH / 2 + 4}
                  className="text-[10px] fill-white font-semibold">
                  {p.partnerId}
                </text>
                <text x={xOf(p.end) + 4} y={y + laneH / 2 + 4}
                  className="text-[10px] fill-text-muted font-mono">
                  {fmtMs(p.end - p.start)}
                </text>
                {/* 右侧液面 */}
                <foreignObject x={width - rightGutter + 8} y={y - 12} width={72} height={laneH + 20}>
                  <div style={{ display: 'flex', justifyContent: 'center' }}>
                    <WalletLiquid initial={p.walletInitial} balance={p.walletBalance} />
                  </div>
                </foreignObject>
              </g>
            );
          })}
          {/* 屏障线 */}
          <line x1={barrierX} y1={0} x2={barrierX} y2={topPad + data.partners.length * (laneH + laneGap)}
            stroke="#f59e0b" strokeWidth={2} strokeDasharray="4 3" strokeOpacity={0.7} />
          <text x={barrierX + 4} y={12} className="text-[10px] fill-warning font-mono">
            Barrier · {fmtMs(data.barrierAt)}
          </text>
        </svg>
        <TimeAxis total={totalSpan} width={width} ticks={6} />
      </div>

      {/* ── 底部指标 ───────────────────────── */}
      <div className="grid grid-cols-4 gap-2 mt-3">
        <Cell label="Partner 数" value={`${data.partners.length}`} hint="每域一个 Partner" color="brand" />
        <Cell label="钱包总消耗" value={`${totalConsumed.toLocaleString()}`}
          hint="Token 守恒 = 系统池扣减" color="info" />
        <Cell label="消耗方差" value={`${walletVariance}`}
          hint={balanceHealth}
          color={walletVariance > 1000 ? 'warning' : 'success'} />
        <Cell label="屏障等待" value={fmtMs(data.barrierAt - Math.max(...data.partners.map(p => p.end)))}
          hint="最晚 Partner → Barrier" />
      </div>
    </ModeShell>
  );
}

function Cell({ label, value, hint, color = 'default' }: {
  label: string; value: string; hint?: string;
  color?: 'brand' | 'info' | 'success' | 'warning' | 'default';
}) {
  const colorClass = {
    brand: 'text-brand-400',
    info: 'text-info',
    success: 'text-success',
    warning: 'text-warning',
    default: 'text-text-primary',
  }[color];
  return (
    <div className="px-3 py-2 rounded bg-surface-900 border border-surface-700">
      <div className="text-[10px] text-text-muted font-mono">{label}</div>
      <div className={`text-lg font-mono font-semibold ${colorClass}`}>{value}</div>
      {hint && <div className="text-[10px] text-text-muted mt-0.5">{hint}</div>}
    </div>
  );
}
