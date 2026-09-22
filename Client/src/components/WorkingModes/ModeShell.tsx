/**
 * ModeShell——六种工作方式可视化通用外壳。
 * 提供：面板标题、回答的问题、数据源徽标（演示 / 实时）、时间标尺。
 */
import type { ReactNode } from 'react';

export interface ModeShellProps {
  mode: string;
  title: string;
  question: string;
  reference: string;
  children: ReactNode;
  extra?: ReactNode;
  demoBadge?: boolean;
}

export default function ModeShell({
  mode, title, question, reference, children, extra, demoBadge = true,
}: ModeShellProps) {
  return (
    <div className="card">
      <div className="flex items-start justify-between gap-4 mb-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span className="badge badge-brand font-mono">{mode}</span>
            {demoBadge && (
              <span className="badge badge-warning" title="后端尚未回流路由模式与结构化的 assignments，当前使用演示数据展示可视化形态">
                演示数据
              </span>
            )}
          </div>
          <h2 className="text-base font-semibold text-text-primary">{title}</h2>
          <p className="text-[11px] text-text-muted italic mt-0.5">「{question}」</p>
        </div>
        {extra && <div className="flex-shrink-0">{extra}</div>}
      </div>

      <div className="mb-3">{children}</div>

      <p className="text-[10px] text-text-muted leading-relaxed">
        <span className="font-mono text-text-secondary">设计参考：</span>{reference}
      </p>
    </div>
  );
}

/**
 * TimeAxis——通用时间标尺（毫秒偏移）。
 */
export function TimeAxis({ total, ticks = 5, width = 720 }: {
  total: number; ticks?: number; width?: number;
}) {
  const items = Array.from({ length: ticks + 1 }, (_, i) => {
    const pct = (i / ticks) * 100;
    const ms = (i / ticks) * total;
    return { pct, ms };
  });
  return (
    <svg width={width} height={22} viewBox={`0 0 ${width} 22`} className="block">
      <line x1={0} y1={4} x2={width} y2={4} stroke="currentColor" strokeOpacity={0.15} />
      {items.map(({ pct, ms }, i) => {
        const x = (pct / 100) * width;
        return (
          <g key={i}>
            <line x1={x} y1={4} x2={x} y2={9} stroke="currentColor" strokeOpacity={0.25} />
            <text x={x} y={18} textAnchor={i === 0 ? 'start' : i === ticks ? 'end' : 'middle'}
              className="text-[9px] fill-text-muted font-mono">
              {ms < 1000 ? `${ms.toFixed(0)}ms` : `${(ms / 1000).toFixed(1)}s`}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/**
 * StatusDot——带脉冲的执行状态小点。
 */
export function StatusDot({ status, size = 8 }: { status: 'pending' | 'running' | 'done' | 'failed' | 'suspended'; size?: number }) {
  const colorMap = {
    pending:   'bg-slate-500',
    running:   'bg-brand-400 animate-pulse-dot',
    done:      'bg-success',
    failed:    'bg-danger',
    suspended: 'bg-warning',
  } as const;
  return <span className={`inline-block rounded-full ${colorMap[status]}`} style={{ width: size, height: size }} />;
}
