/**
 * REGULATION 模式可视化——广播扩散环 + ACK 进度条 + 未确认列表。
 *
 * 设计参考：
 *   - Android 16 Progress-Centric Notification（Segments 色段 + Points 里程碑）
 *   - 推送通知漏斗（送达 / 已读 / 确认 三段式转化）
 *   - 应急指挥大屏（中心源点 → 目标节点辐射图 + 倒计时）
 *
 * 回答的问题：监管令下发时刻？各 Agent 何时收到？谁在超时未 ACK？ACK 截止时间还剩多少？
 */
import { useEffect, useState } from 'react';
import ModeShell from './ModeShell';
import { DEMO_REGULATION, type RegulationDemo, type AckTarget } from './demoData';

const TYPE_LABEL: Record<RegulationDemo['type'], { label: string; color: string }> = {
  rule_update:     { label: '行为准则更新', color: '#22d3ee' },
  emergency_alert: { label: '紧急干预', color: '#ef4444' },
  verdict_notice:  { label: '裁决告知', color: '#8b5cf6' },
  patrol_result:   { label: '巡检结果', color: '#10b981' },
};

/**
 * 广播扩散环（Radar Ripple）：中心监管局 + 三层涟漪 + 目标节点按送达时刻分布。
 */
function BroadcastRipple({ targets, ackDeadline }: {
  targets: AckTarget[]; ackDeadline: number;
}) {
  const size = 380;
  const cx = size / 2;
  const cy = size / 2;
  const maxRadius = size / 2 - 30;
  const minRadius = 55;
  const maxDelivered = Math.max(...targets.map(t => t.deliveredAt), ackDeadline * 0.5);

  return (
    <svg width={size} height={size} className="block">
      <defs>
        <radialGradient id="ripple" cx="50%" cy="50%">
          <stop offset="0%" stopColor="#22d3ee" stopOpacity={0.35} />
          <stop offset="70%" stopColor="#22d3ee" stopOpacity={0.05} />
          <stop offset="100%" stopColor="#22d3ee" stopOpacity={0} />
        </radialGradient>
      </defs>
      {/* 三层同心网格环 */}
      {[0.33, 0.66, 1].map(p => (
        <circle key={p} cx={cx} cy={cy} r={maxRadius * p}
          fill="none" stroke="#252f47" strokeDasharray="2 4" />
      ))}
      {/* 扩散涟漪（当前时刻） */}
      <circle cx={cx} cy={cy} r={maxRadius * 0.6} fill="url(#ripple)" style={{
        animation: 'ripple 3s ease-out infinite',
        transformBox: 'fill-box',
        transformOrigin: 'center',
      }} />
      {/* 中心：监管局 */}
      <circle cx={cx} cy={cy} r={22} fill="#0891b2" stroke="#22d3ee" strokeWidth={2} />
      <text x={cx} y={cy - 3} textAnchor="middle" className="text-[10px] fill-white font-semibold">
        监管局
      </text>
      <text x={cx} y={cy + 9} textAnchor="middle" className="text-[8px] fill-white/70 font-mono">
        BROADCAST
      </text>

      {/* 目标节点：按送达时刻沿不同方向、半径布置 */}
      {targets.map((t, i) => {
        const angle = (i / targets.length) * 2 * Math.PI - Math.PI / 2;
        const r = minRadius + ((t.deliveredAt / maxDelivered) * (maxRadius - minRadius - 6));
        const x = cx + r * Math.cos(angle);
        const y = cy + r * Math.sin(angle);
        const ackedColor = t.ackedAt ? '#10b981' : '#6b7280';
        const deliveredColor = t.ackedAt ? '#10b981' : '#3b82f6';
        const isOverdue = !t.ackedAt && t.deliveredAt + 30_000 < ackDeadline;
        const dotColor = t.ackedAt ? ackedColor : isOverdue ? '#f59e0b' : deliveredColor;

        return (
          <g key={t.agentId}>
            {/* 中心 → 节点的送达线 */}
            <line x1={cx} y1={cy} x2={x} y2={y}
              stroke={dotColor} strokeOpacity={t.ackedAt ? 0.5 : 0.25} strokeWidth={1} />
            {/* 节点 */}
            <circle cx={x} cy={y} r={9} fill={dotColor} fillOpacity={0.9}
              stroke="#0f1420" strokeWidth={2} />
            {t.ackedAt && (
              <polyline
                points={`${x - 3},${y} ${x - 1},${y + 2.5} ${x + 3.5},${y - 2.5}`}
                fill="none" stroke="white" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
            )}
            <text x={x} y={y + 22} textAnchor="middle"
              className="text-[9px] fill-text-secondary font-mono">
              {t.agentId.replace('agent-', '')}
            </text>
            <text x={x} y={y + 32} textAnchor="middle"
              className="text-[8px] fill-text-muted font-mono">
              {t.ackedAt ? `+${t.ackedAt}ms` : '未确认'}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/**
 * ACK 进度条：三段式（送达 / 已 ACK / 超时未确认）。
 */
function AckFunnel({ targets, ackDeadline }: { targets: AckTarget[]; ackDeadline: number }) {
  const acked = targets.filter(t => t.ackedAt !== null).length;
  const delivered = targets.filter(t => t.deliveredAt <= ackDeadline).length;
  const overdue = targets.length - acked;
  const total = targets.length;

  return (
    <div>
      <div className="text-[10px] text-text-muted font-mono mb-1.5">
        ACK 三段漏斗 · 截止 <span className="text-brand-400">{(ackDeadline / 1000).toFixed(0)}s</span>
      </div>
      <div className="flex h-7 rounded overflow-hidden border border-surface-700">
        <div style={{ width: `${(acked / total) * 100}%`, background: '#10b981', transition: 'width 400ms ease' }}
          className="flex items-center justify-center text-[10px] text-white font-semibold">
          {acked > 0 && `已 ACK ${acked}`}
        </div>
        <div style={{ width: `${((delivered - acked) / total) * 100}%`, background: '#3b82f6', transition: 'width 400ms ease' }}
          className="flex items-center justify-center text-[10px] text-white font-semibold">
          {delivered - acked > 0 && `未 ACK ${delivered - acked}`}
        </div>
        <div style={{ width: `${((total - delivered) / total) * 100}%`, background: '#4b5563', transition: 'width 400ms ease' }}
          className="flex items-center justify-center text-[10px] text-white/80 font-semibold">
          {total - delivered > 0 && `未送达 ${total - delivered}`}
        </div>
      </div>
      <div className="mt-1 flex items-center justify-between text-[10px] font-mono">
        <span className="text-success">✓ {acked} ACK</span>
        <span className="text-info">→ {delivered}/{total} 送达</span>
        <span className={overdue > 0 ? 'text-warning' : 'text-text-muted'}>
          ⚠ {overdue} 未确认
        </span>
      </div>
    </div>
  );
}

export default function RegulationViz({ data = DEMO_REGULATION }: { data?: RegulationDemo }) {
  const meta = TYPE_LABEL[data.type];
  const [now, setNow] = useState(data.issuedAt);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [data.issuedAt]);

  const elapsed = now - data.issuedAt;
  const remaining = Math.max(data.ackDeadlineMs - elapsed, 0);
  const remainingSec = Math.ceil(remaining / 1000);
  const unacked = data.targets.filter(t => !t.ackedAt);
  const ackLatencies = data.targets.filter(t => t.ackedAt).map(t => t.ackedAt! - t.deliveredAt);
  const avgAckLatency = ackLatencies.length
    ? Math.round(ackLatencies.reduce((s, v) => s + v, 0) / ackLatencies.length) : 0;

  return (
    <ModeShell
      mode="REGULATION"
      title="监管广播 · 扩散环 + ACK 漏斗 + 超时预警"
      question="监管令下发时刻？各 Agent 何时收到？谁在超时未 ACK？还剩多少时间？"
      reference="Android 16 Progress Segments + 推送漏斗三段式 + 应急指挥辐射图"
      extra={
        <div className="text-right">
          <div className="text-[10px] text-text-muted font-mono">
            {remaining > 0 ? '距离 ACK 截止' : '已超过 ACK 截止'}
          </div>
          <div className={`text-xl font-mono font-bold ${remaining > 30_000 ? 'text-success' : remaining > 0 ? 'text-warning' : 'text-danger'}`}>
            {remaining > 0 ? `${Math.floor(remainingSec / 60)}:${(remainingSec % 60).toString().padStart(2, '0')}` : '超时'}
          </div>
        </div>
      }
    >
      {/* 顶部：广播类型 + 标题 */}
      <div className="flex items-center gap-3 mb-3">
        <span className="w-2 h-2 rounded-full" style={{ background: meta.color }} />
        <span className="text-[11px] font-mono" style={{ color: meta.color }}>{data.type}</span>
        <span className="text-sm text-text-primary font-semibold">{data.title}</span>
        <span className="flex-1" />
        <span className="text-[10px] font-mono text-text-muted">{data.broadcastId}</span>
      </div>

      <div className="grid grid-cols-[380px_1fr] gap-6 items-start">
        {/* 左：扩散环 */}
        <div className="flex flex-col items-center">
          <BroadcastRipple targets={data.targets} ackDeadline={data.ackDeadlineMs} />
        </div>

        {/* 右：漏斗 + 列表 */}
        <div className="min-w-0 space-y-3">
          <AckFunnel targets={data.targets} ackDeadline={data.ackDeadlineMs} />

          <div>
            <div className="text-[10px] text-text-muted font-mono mb-1.5">目标 Agent 明细</div>
            <div className="space-y-1 max-h-[280px] overflow-y-auto pr-1">
              {data.targets.map(t => (
                <div key={t.agentId}
                  className="flex items-center gap-2 px-2 py-1.5 rounded border"
                  style={{
                    background: t.ackedAt ? '#10b98115' : '#151b2b',
                    borderColor: t.ackedAt ? '#10b98155' : '#1c2438',
                  }}>
                  <span className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                    style={{ background: t.ackedAt ? '#10b981' : '#f59e0b' }} />
                  <span className="text-[11px] font-mono text-text-primary truncate">{t.agentId}</span>
                  <span className="text-[10px] text-text-muted font-mono flex-shrink-0">{t.role}</span>
                  <span className="flex-1" />
                  <span className="text-[10px] font-mono text-info flex-shrink-0">
                    送达 +{t.deliveredAt}ms
                  </span>
                  <span className="text-[10px] font-mono flex-shrink-0"
                    style={{ color: t.ackedAt ? '#10b981' : '#f59e0b' }}>
                    {t.ackedAt ? `ACK +${t.ackedAt - t.deliveredAt}ms` : '待 ACK'}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2 text-center">
            <Cell label="送达延迟" value={`+${Math.round(data.targets.reduce((s, t) => s + t.deliveredAt, 0) / data.targets.length)}ms`}
              hint="广播 → Agent 接收" color="info" />
            <Cell label="ACK 平均" value={`+${avgAckLatency}ms`} hint="送达 → ACK 回复" color="success" />
            <Cell label="未确认" value={`${unacked.length}`} hint={unacked.length > 0 ? '需催办或降权' : '全部达成'}
              color={unacked.length > 0 ? 'warning' : 'success'} />
          </div>
        </div>
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
      <div className={`text-base font-mono font-semibold ${colorClass}`}>{value}</div>
      {hint && <div className="text-[10px] text-text-muted mt-0.5">{hint}</div>}
    </div>
  );
}
