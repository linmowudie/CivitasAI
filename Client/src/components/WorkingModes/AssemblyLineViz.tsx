/**
 * ASSEMBLY_LINE 模式可视化——SOP 步骤条 + 传送带时序。
 *
 * 设计参考：
 *   - GitHub Actions Workflow 视图（节点圆点 + 连线 + 当前节点脉冲 + 完成打勾）
 *   - Jenkins Blue Ocean Pipeline（Stage Bar + 每段耗时）
 *   - 前端分阶段流程 StepBar（圆点+线段动画切换，见 CSDN 分阶段进度条方案）
 *
 * 回答的问题：N 个节点串行，当前卡在哪一步？每个节点用多久？交接延迟多少？总吞吐受何限制？
 */
import ModeShell from './ModeShell';
import { DEMO_ASSEMBLY, fmtMs, STATUS_COLOR, type AssemblyLineDemo, type StepStatus } from './demoData';

function StepperNode({ status, active }: { status: StepStatus; active: boolean }) {
  const color = STATUS_COLOR[status];
  return (
    <div className="relative flex items-center justify-center" style={{ width: 40, height: 40 }}>
      {active && (
        <span className="absolute inset-0 rounded-full"
          style={{ background: color, opacity: 0.2, animation: 'ripple 1.6s ease-out infinite' }} />
      )}
      <div className="relative w-8 h-8 rounded-full flex items-center justify-center"
        style={{ background: color, boxShadow: `0 0 12px ${color}66` }}>
        {status === 'done' ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"
            strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        ) : status === 'failed' ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"
            strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        ) : status === 'running' ? (
          <span className="w-2.5 h-2.5 rounded-full bg-white animate-pulse-dot" />
        ) : status === 'suspended' ? (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="white">
            <rect x="6" y="4" width="4" height="16" rx="1" />
            <rect x="14" y="4" width="4" height="16" rx="1" />
          </svg>
        ) : (
          <span className="w-1.5 h-1.5 rounded-full bg-white/60" />
        )}
      </div>
    </div>
  );
}

export default function AssemblyLineViz({ data = DEMO_ASSEMBLY }: { data?: AssemblyLineDemo }) {
  const totalSpan = Math.max(...data.nodes.map(n => n.end));
  const doneCount = data.nodes.filter(n => n.status === 'done').length;
  const totalHandoffDelay = data.nodes.reduce((s, n) => s + n.handoffDelay, 0);
  const totalProcessTime = data.nodes.reduce((s, n) => s + (n.end - n.start), 0);
  const throughput = ` ${(data.nodes.length / (totalSpan / 1000)).toFixed(2)} 节点/s`;
  const beltHeight = 32;

  return (
    <ModeShell
      mode="ASSEMBLY_LINE"
      title={`SOP 流水线 · ${data.sopName}`}
      question="N 个节点串行，当前卡在哪一步？每个节点用多久？交接延迟吃掉多少时间？"
      reference="GitHub Actions + Jenkins Blue Ocean Stage Bar + CI/CD 圆点 StepBar"
    >
      {/* 顶部：任务描述 */}
      <div className="text-[11px] text-text-secondary mb-3">
        <span className="font-mono text-text-muted">任务：</span>{data.description}
      </div>

      {/* ── Stepper 步骤条 ──────────────────────── */}
      <div className="flex items-start justify-between mb-4">
        {data.nodes.map((n, i) => {
          const isLast = i === data.nodes.length - 1;
          const active = n.status === 'running';
          const lineColor = n.status === 'done' && data.nodes[i + 1]?.status !== 'pending'
            ? STATUS_COLOR.done : STATUS_COLOR.pending;
          return (
            <div key={n.nodeId} className="flex items-center flex-1 min-w-0">
              <div className="flex flex-col items-center flex-shrink-0">
                <StepperNode status={n.status} active={active} />
                <div className="text-[11px] text-text-primary mt-1.5 whitespace-nowrap">{n.name}</div>
                <div className="text-[10px] font-mono text-text-muted">{fmtMs(n.end - n.start)}</div>
              </div>
              {!isLast && (
                <div className="flex-1 mx-2 relative" style={{ height: 2, background: lineColor, minWidth: 24 }}>
                  {/* 交接延迟标签 */}
                  <div className="absolute -top-5 left-1/2 -translate-x-1/2 text-[9px] font-mono whitespace-nowrap"
                    style={{ color: n.handoffDelay > 200 ? '#f59e0b' : '#8b95a8' }}>
                    +{n.handoffDelay}ms
                  </div>
                  {n.status === 'done' && (
                    <div className="absolute inset-0 overflow-hidden">
                      <div className="data-flow-line h-full" />
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* ── 传送带时序（Conveyor Belt）──────────── */}
      <div>
        <div className="text-[10px] text-text-muted mb-1.5 font-mono">串行时间轴（传送带）</div>
        <div className="rounded bg-surface-900 border border-surface-700 p-2 overflow-x-auto">
          <svg width={720} height={beltHeight * data.nodes.length + 24} className="block">
            {data.nodes.map((n, i) => {
              const color = STATUS_COLOR[n.status];
              const y = 4 + i * beltHeight;
              const x = (n.start / totalSpan) * 620 + 60;
              const w = ((n.end - n.start) / totalSpan) * 620;
              return (
                <g key={n.nodeId}>
                  <text x={54} y={y + 18} textAnchor="end" className="text-[10px] fill-text-secondary font-mono">
                    #{i + 1}
                  </text>
                  <rect x={x} y={y + 4} width={w} height={22} rx={3} fill={color} fillOpacity={0.85} />
                  <text x={x + 6} y={y + 19} className="text-[10px] fill-white font-semibold">
                    {n.name}
                  </text>
                  {/* 交接延迟遮罩 */}
                  {n.handoffDelay > 0 && i < data.nodes.length - 1 && (
                    <rect x={x + w} y={y + 4} width={(n.handoffDelay / totalSpan) * 620 + 4} height={22}
                      rx={2} fill="#f59e0b" fillOpacity={0.35}>
                      <title>交接延迟 {n.handoffDelay}ms</title>
                    </rect>
                  )}
                  <text x={x + w + 8} y={y + 19} className="text-[10px] fill-text-muted font-mono">
                    {fmtMs(n.end - n.start)}
                  </text>
                </g>
              );
            })}
            <line x1={60} y1={beltHeight * data.nodes.length + 12}
              x2={680} y2={beltHeight * data.nodes.length + 12}
              stroke="currentColor" strokeOpacity={0.1} />
            <text x={60} y={beltHeight * data.nodes.length + 22} className="text-[9px] fill-text-muted font-mono">0ms</text>
            <text x={680} y={beltHeight * data.nodes.length + 22} textAnchor="end" className="text-[9px] fill-text-muted font-mono">
              {fmtMs(totalSpan)}
            </text>
          </svg>
        </div>
      </div>

      {/* ── 底部指标 ───────────────────────────── */}
      <div className="grid grid-cols-4 gap-2 mt-3">
        <Cell label="完成度" value={`${doneCount}/${data.nodes.length}`}
          hint="已走完节点 / 总节点" color="success" />
        <Cell label="纯处理" value={fmtMs(totalProcessTime)}
          hint="所有节点耗时之和" />
        <Cell label="交接成本" value={fmtMs(totalHandoffDelay)}
          hint={`${((totalHandoffDelay / totalSpan) * 100).toFixed(1)}% 总耗时`}
          color={totalHandoffDelay / totalSpan > 0.1 ? 'warning' : 'default'} />
        <Cell label="串行吞吐" value={throughput}
          hint="maxParallelism = 1" color="info" />
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
