/**
 * DELEGATION 模式可视化——扇形分叉 + 并行轨道条。
 *
 * 设计参考：
 *   - Apache Airflow Graph View + Gantt 联动
 *   - ZenML Timeline View（Gantt 风格，横向条长度 = 执行时长）
 *   - Jenkins Blue Ocean Pipeline 视图（扇形分叉 + 并行 Stage）
 *
 * 回答的问题：多 Worker 并行，谁是短木板？并行度多少？理论最快 vs 实际耗时，冗余比是多少？
 */
import ModeShell, { StatusDot } from './ModeShell';
import { TimeAxis } from './ModeShell';
import { DEMO_DELEGATION, fmtMs, STATUS_COLOR, type DelegationDemo } from './demoData';

export default function DelegationViz({ data = DEMO_DELEGATION }: { data?: DelegationDemo }) {
  const totalSpan = Math.max(
    data.aggregateEnd,
    ...data.workers.map(w => w.end),
    data.directorEnd,
  );
  const workerSpan = Math.max(...data.workers.map(w => w.end - w.start));
  const wallClock = totalSpan;
  const theoreticalFastest = data.directorEnd + workerSpan + (data.aggregateEnd - data.aggregateStart);
  const parallelism = data.workers.length;
  const utilization = ((theoreticalFastest > 0 ? wallClock / theoreticalFastest : 1) * 100).toFixed(0);

  const laneH = 24;
  const gap = 8;
  const topPad = 8;
  const directorH = 20;
  const aggH = 20;
  const chartHeight = topPad + directorH + 8
    + data.workers.length * (laneH + gap)
    + 8 + aggH + 4;
  const width = 720;
  const leftGutter = 120;
  const rightGutter = 60;
  const chartW = width - leftGutter - rightGutter;

  const xOf = (ms: number) => leftGutter + (ms / totalSpan) * chartW;
  const wOf = (ms: number) => (ms / totalSpan) * chartW;

  // 扇形分叉：从 director 末端到各 worker 起点
  const directorEndX = xOf(data.directorEnd);
  const directorY = topPad + directorH / 2;

  return (
    <ModeShell
      mode="DELEGATION"
      title="多 Worker 并行 · 扇形分叉 + 轨道甘特"
      question="并行度多少？谁是短木板？理论最快 vs 实际耗时的冗余比是多少？"
      reference="Airflow Graph + ZenML Timeline + Jenkins Blue Ocean Parallel Stages"
    >
      {/* 顶部指标 */}
      <div className="grid grid-cols-4 gap-2 mb-3">
        <Metric label="并行度" value={`${parallelism}`} hint="同时运行的 Worker 数" color="brand" />
        <Metric label="理论最快" value={fmtMs(theoreticalFastest)} hint="Director + 最长 Worker + 聚合" />
        <Metric label="实际耗时" value={fmtMs(wallClock)} hint="从任务接收到聚合完成" color="info" />
        <Metric label="轨道利用率" value={`${utilization}%`}
          hint={Number(utilization) > 100 ? '存在调度串行化损耗' : '并行了但被最长 Worker 决定'}
          color={Number(utilization) > 100 ? 'warning' : 'success'} />
      </div>

      {/* 甘特图 */}
      <div className="rounded bg-surface-900 border border-surface-700 p-2 overflow-x-auto">
        <svg width={width} height={chartHeight + 22} className="block">
          {/* Director 拆解条 */}
          <rect x={xOf(data.directorStart)} y={topPad} width={wOf(data.directorEnd - data.directorStart)}
            height={directorH} rx={4} fill="#8b5cf6" fillOpacity={0.85} />
          <text x={xOf(data.directorStart) + 6} y={topPad + 14} className="text-[10px] fill-white font-semibold">
            Director 拆解
          </text>
          <text x={xOf(data.directorStart) - 6} y={topPad + 14} textAnchor="end" className="text-[10px] fill-text-secondary">
            规划
          </text>
          <text x={xOf(data.directorEnd) + 4} y={topPad + 14} className="text-[10px] fill-text-muted font-mono">
            {fmtMs(data.directorEnd - data.directorStart)}
          </text>

          {/* 扇形分叉连线 */}
          {data.workers.map((w, i) => {
            const y = topPad + directorH + 8 + i * (laneH + gap) + laneH / 2;
            const startX = xOf(w.start);
            const midX = directorEndX + (startX - directorEndX) / 2;
            return (
              <path key={`fan-${i}`}
                d={`M ${directorEndX} ${directorY} Q ${midX} ${directorY} ${startX} ${y}`}
                fill="none" stroke="#8b5cf6" strokeOpacity={0.35} strokeWidth={1.2} />
            );
          })}

          {/* Worker 并行轨道 */}
          {data.workers.map((w, i) => {
            const y = topPad + directorH + 8 + i * (laneH + gap);
            const color = STATUS_COLOR[w.status];
            return (
              <g key={w.workerId}>
                <text x={leftGutter - 6} y={y + laneH / 2 + 4} textAnchor="end"
                  className="text-[10px] fill-text-secondary font-mono">
                  {w.domain}
                </text>
                <rect x={xOf(w.start)} y={y} width={wOf(w.end - w.start)} height={laneH}
                  rx={4} fill={color} fillOpacity={0.85} />
                {/* 名称 */}
                <text x={xOf(w.start) + 6} y={y + 15} className="text-[10px] fill-white font-semibold">
                  {w.workerId}
                </text>
                {/* 时长 */}
                <text x={xOf(w.end) + 4} y={y + 15} className="text-[10px] fill-text-muted font-mono">
                  {fmtMs(w.end - w.start)}
                </text>
                {/* 状态点 */}
                <circle cx={xOf(w.start) - 6} cy={y + laneH / 2} r={3} fill={color} />
                {/* 尾部 → 聚合 */}
                <path
                  d={`M ${xOf(w.end)} ${y + laneH / 2} Q ${xOf(w.end) + 20} ${y + laneH / 2} ${xOf(data.aggregateStart)} ${topPad + directorH + 8 + data.workers.length * (laneH + gap) + aggH / 2}`}
                  fill="none" stroke={color} strokeOpacity={0.28} strokeWidth={1} />
              </g>
            );
          })}

          {/* 聚合条 */}
          <g>
            <rect x={xOf(data.aggregateStart)}
              y={topPad + directorH + 8 + data.workers.length * (laneH + gap)}
              width={wOf(data.aggregateEnd - data.aggregateStart)} height={aggH}
              rx={4} fill="#10b981" fillOpacity={0.85} />
            <text x={xOf(data.aggregateStart) - 6}
              y={topPad + directorH + 8 + data.workers.length * (laneH + gap) + 14}
              textAnchor="end" className="text-[10px] fill-text-secondary">
              聚合
            </text>
            <text x={xOf(data.aggregateStart) + 6}
              y={topPad + directorH + 8 + data.workers.length * (laneH + gap) + 14}
              className="text-[10px] fill-white font-semibold">
              Aggregate
            </text>
          </g>
        </svg>
        <TimeAxis total={totalSpan} width={width} ticks={6} />
      </div>

      {/* Worker 列表 */}
      <div className="mt-3 grid grid-cols-2 gap-1.5">
        {data.workers.map(w => (
          <div key={w.workerId}
            className="flex items-center gap-2 px-2 py-1.5 rounded bg-surface-900 border border-surface-700">
            <StatusDot status={w.status} />
            <span className="text-[11px] font-mono text-text-secondary">{w.workerId}</span>
            <span className="text-[10px] text-text-muted">·</span>
            <span className="text-[11px] text-text-primary">{w.domain}</span>
            <span className="flex-1" />
            <span className="text-[10px] font-mono text-brand-400">{w.tokensConsumed} tok</span>
            <span className="text-[10px] font-mono text-text-muted">{fmtMs(w.end - w.start)}</span>
          </div>
        ))}
      </div>
    </ModeShell>
  );
}

function Metric({ label, value, hint, color = 'default' }: {
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
