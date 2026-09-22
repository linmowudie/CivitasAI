/**
 * AUDIT 模式可视化——消耗曲线 + 阈值带 + 冻结斜纹 + 稽查判定。
 *
 * 设计参考：
 *   - AWS OpenSearch Anomaly Detection（Live Anomalies + Anomaly Occurrence 事件旗标）
 *   - Grafana Annotation Bands（时间轴上的事件遮罩带）
 *   - SOC 仪表盘（severity tier + 严重性色标 + MTT-Detect 指标）
 *
 * 回答的问题：Agent 消耗曲线什么时候跨过阈值？冻结期覆盖了多久？稽查结论是什么？
 */
import { useState } from 'react';
import ModeShell from './ModeShell';
import { DEMO_AUDIT, fmtMs, type AuditDemo } from './demoData';

const LEVEL_COLOR = { warn: '#f59e0b', soft: '#fb923c', critical: '#ef4444' } as const;
const RULE_LABEL = { rolling: '滚动预算', deviation: '偏离均值', loop: '死循环' } as const;

export default function AuditViz({ data = DEMO_AUDIT }: { data?: AuditDemo }) {
  const [hovered, setHovered] = useState<number | null>(null);

  const width = 720;
  const height = 220;
  const pad = { l: 60, r: 20, t: 20, b: 60 };
  const chartW = width - pad.l - pad.r;
  const chartH = height - pad.t - pad.b;

  const maxTs = Math.max(...data.samples.map(s => s.ts));
  const maxTokens = Math.max(data.rollingBudgetTokens * 1.4, ...data.samples.map(s => s.tokens));

  const xOf = (ts: number) => pad.l + (ts / maxTs) * chartW;
  const yOf = (v: number) => pad.t + chartH - (v / maxTokens) * chartH;

  const linePath = data.samples.map((s, i) =>
    `${i === 0 ? 'M' : 'L'} ${xOf(s.ts).toFixed(1)} ${yOf(s.tokens).toFixed(1)}`
  ).join(' ');
  const areaPath = `${linePath} L ${xOf(maxTs)} ${yOf(0)} L ${xOf(0)} ${yOf(0)} Z`;

  const thresholdY = yOf(data.rollingBudgetTokens);
  const warnY = yOf(data.rollingBudgetTokens * 0.8);

  const verdictColor = {
    pending: '#6b7280',
    false_positive: '#10b981',
    confirmed_anomaly: '#f59e0b',
    attack: '#ef4444',
  }[data.verdict.finding];

  const verdictLabel = {
    pending: '稽查中',
    false_positive: '误报',
    confirmed_anomaly: '确认异常',
    attack: '判定为攻击',
  }[data.verdict.finding];

  const actionLabel = {
    none: '无处罚',
    throttle: '降权限流',
    confiscate: 'Token 罚没',
    destroy: 'Agent 销毁',
  }[data.verdict.action];

  const freezeTotal = data.freezeWindows.reduce((s, f) => s + ((f.end ?? maxTs) - f.start), 0);
  const anomalyTotal = data.anomalies.length;

  return (
    <ModeShell
      mode="AUDIT"
      title="资源稽查 · 消耗曲线 + 阈值带 + 冻结斜纹 + 判定"
      question="消耗曲线什么时候跨过阈值？冻结期覆盖多久？稽查结论是什么？"
      reference="OpenSearch Anomaly Live + Grafana Annotation Band + SOC 严重性色标"
    >
      {/* ── 主图：消耗曲线 ────────────────────── */}
      <div className="rounded bg-surface-900 border border-surface-700 p-2 overflow-x-auto">
        <svg width={width} height={height} className="block">
          <defs>
            <linearGradient id="auditAreaGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#22d3ee" stopOpacity={0.35} />
              <stop offset="100%" stopColor="#22d3ee" stopOpacity={0} />
            </linearGradient>
            <pattern id="hatch" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"
              width="8" height="8">
              <line x1="0" y1="0" x2="0" y2="8" stroke="#ef4444" strokeWidth="4" strokeOpacity={0.35} />
            </pattern>
          </defs>

          {/* Y 轴刻度 */}
          {[0, 0.25, 0.5, 0.75, 1].map(pct => {
            const v = maxTokens * pct;
            const y = yOf(v);
            return (
              <g key={pct}>
                <line x1={pad.l} y1={y} x2={width - pad.r} y2={y} stroke="currentColor" strokeOpacity={0.06} />
                <text x={pad.l - 6} y={y + 3} textAnchor="end" className="text-[9px] fill-text-muted font-mono">
                  {Math.round(v)}
                </text>
              </g>
            );
          })}

          {/* 阈值带（y 轴反向：值越大 y 越小） */}
          {/* 0.8x ~ 1x rollingBudget = 软警告带（thresholdY 之上到 warnY） */}
          <rect x={pad.l} y={thresholdY} width={chartW} height={Math.max(warnY - thresholdY, 0)}
            fill="#f59e0b" fillOpacity={0.12} />
          {/* >=1x = 危险带（图顶到 thresholdY） */}
          <rect x={pad.l} y={pad.t} width={chartW} height={Math.max(thresholdY - pad.t, 0)}
            fill="#ef4444" fillOpacity={0.08} />
          <line x1={pad.l} y1={thresholdY} x2={width - pad.r} y2={thresholdY}
            stroke="#ef4444" strokeWidth={1.2} strokeDasharray="4 3" />
          <text x={width - pad.r - 2} y={thresholdY - 4} textAnchor="end"
            className="text-[10px] fill-danger font-mono">
            rollingBudget = {data.rollingBudgetTokens}
          </text>

          {/* 冻结斜纹带 */}
          {data.freezeWindows.map((f, i) => {
            const x = xOf(f.start);
            const w = xOf(f.end ?? maxTs) - x;
            return (
              <g key={i}>
                <rect x={x} y={pad.t} width={w} height={chartH} fill="url(#hatch)" />
                <line x1={x} y1={pad.t} x2={x} y2={pad.t + chartH}
                  stroke="#ef4444" strokeWidth={1.5} />
                {f.end === null && (
                  <line x1={x + w} y1={pad.t} x2={x + w} y2={pad.t + chartH}
                    stroke="#ef4444" strokeWidth={1.5} strokeDasharray="3 2" />
                )}
                <text x={x + 4} y={pad.t + 12} className="text-[10px] fill-danger font-semibold">
                  ❄ FROZEN {fmtMs((f.end ?? maxTs) - f.start)}
                </text>
              </g>
            );
          })}

          {/* 面积 + 曲线 */}
          <path d={areaPath} fill="url(#auditAreaGrad)" />
          <path d={linePath} fill="none" stroke="#22d3ee" strokeWidth={1.8} strokeLinejoin="round" />

          {/* 采样点 */}
          {data.samples.map((s, i) => {
            const over = s.tokens > data.rollingBudgetTokens;
            const near = !over && s.tokens > data.rollingBudgetTokens * 0.8;
            return (
              <circle key={i} cx={xOf(s.ts)} cy={yOf(s.tokens)} r={hovered === i ? 4 : 2.5}
                fill={over ? '#ef4444' : near ? '#f59e0b' : '#22d3ee'}
                onMouseEnter={() => setHovered(i)}
                onMouseLeave={() => setHovered(null)}
                style={{ cursor: 'pointer' }} />
            );
          })}

          {/* 异常旗标 */}
          {data.anomalies.map((a, i) => {
            const color = LEVEL_COLOR[a.level];
            return (
              <g key={i}>
                <line x1={xOf(a.ts)} y1={pad.t - 4} x2={xOf(a.ts)} y2={pad.t + 8}
                  stroke={color} strokeWidth={1.5} />
                <circle cx={xOf(a.ts)} cy={pad.t - 6} r={4} fill={color} stroke="#0f1420" strokeWidth={1.5}>
                  <title>{a.message}</title>
                </circle>
              </g>
            );
          })}

          {/* X 轴 */}
          <line x1={pad.l} y1={height - pad.b} x2={width - pad.r} y2={height - pad.b}
            stroke="currentColor" strokeOpacity={0.15} />
          {[0, 0.25, 0.5, 0.75, 1].map(p => {
            const ts = maxTs * p;
            return (
              <text key={p} x={xOf(ts)} y={height - pad.b + 12}
                textAnchor={p === 0 ? 'start' : p === 1 ? 'end' : 'middle'}
                className="text-[9px] fill-text-muted font-mono">
                {fmtMs(ts)}
              </text>
            );
          })}

          {/* Tooltip */}
          {hovered !== null && (
            <g>
              <rect x={Math.min(xOf(data.samples[hovered].ts) + 8, width - 130)}
                y={Math.max(yOf(data.samples[hovered].tokens) - 34, 4)}
                width={122} height={30} rx={4}
                fill="#0f1420" stroke="#252f47" />
              <text x={Math.min(xOf(data.samples[hovered].ts) + 16, width - 122)}
                y={Math.max(yOf(data.samples[hovered].tokens) - 20, 20)}
                className="text-[10px] fill-text-primary font-mono">
                t={fmtMs(data.samples[hovered].ts)}
              </text>
              <text x={Math.min(xOf(data.samples[hovered].ts) + 16, width - 122)}
                y={Math.max(yOf(data.samples[hovered].tokens) - 8, 32)}
                className="text-[10px] fill-brand-400 font-mono">
                {data.samples[hovered].tokens} tok ({((data.samples[hovered].tokens / data.rollingBudgetTokens) * 100).toFixed(0)}%)
              </text>
            </g>
          )}
        </svg>
      </div>

      {/* ── 异常 + 判定卡片 ──────────────────── */}
      <div className="grid grid-cols-[1fr_260px] gap-4 mt-3">
        {/* 异常明细 */}
        <div>
          <div className="text-[10px] text-text-muted font-mono mb-1.5">
            异常事件（{anomalyTotal}）· 冻结窗口（{data.freezeWindows.length}）
          </div>
          <div className="space-y-1">
            {data.anomalies.map((a, i) => (
              <div key={i} className="flex items-center gap-2 px-2 py-1.5 rounded bg-surface-900 border border-surface-700">
                <span className="w-2 h-2 rounded-full flex-shrink-0"
                  style={{ background: LEVEL_COLOR[a.level] }} />
                <span className="text-[10px] font-mono text-text-muted w-16">{fmtMs(a.ts)}</span>
                <span className="text-[11px] font-mono px-1.5 py-0.5 rounded"
                  style={{ background: `${LEVEL_COLOR[a.level]}25`, color: LEVEL_COLOR[a.level] }}>
                  {a.level.toUpperCase()}
                </span>
                <span className="text-[10px] text-text-muted">{RULE_LABEL[a.rule]}</span>
                <span className="text-[11px] text-text-secondary truncate">{a.message}</span>
              </div>
            ))}
            {data.freezeWindows.map((f, i) => (
              <div key={`f-${i}`} className="flex items-center gap-2 px-2 py-1.5 rounded border"
                style={{ background: '#ef444415', borderColor: '#ef444455' }}>
                <span className="text-[12px]">❄</span>
                <span className="text-[10px] font-mono text-text-muted w-16">{fmtMs(f.start)}</span>
                <span className="text-[11px] font-mono text-danger">
                  FROZEN {f.end === null ? '→ now' : `→ ${fmtMs(f.end)}`}
                </span>
                <span className="text-[11px] text-text-secondary truncate">{f.reason}</span>
              </div>
            ))}
          </div>
        </div>

        {/* 稽查判定 */}
        <div className="rounded border p-3"
          style={{ background: `${verdictColor}10`, borderColor: `${verdictColor}55` }}>
          <div className="text-[10px] text-text-muted font-mono mb-1">稽查判定 · investigation</div>
          <div className="text-lg font-bold mb-1" style={{ color: verdictColor }}>
            {verdictLabel}
          </div>
          <div className="text-[11px] text-text-secondary mb-2">
            执行建议：<span className="font-mono" style={{ color: verdictColor }}>{actionLabel}</span>
          </div>
          <div className="text-[10px] font-mono text-text-muted space-y-0.5">
            <div>agent: <span className="text-text-primary">{data.agentId}</span></div>
            <div>异常数: <span className="text-text-primary">{anomalyTotal}</span></div>
            <div>冻结总时长: <span className="text-text-primary">{fmtMs(freezeTotal)}</span></div>
            <div>
              稽查时刻: <span className="text-text-primary">
                {data.verdict.investigatedAt ? fmtMs(data.verdict.investigatedAt) : '—'}
              </span>
            </div>
          </div>
        </div>
      </div>
    </ModeShell>
  );
}
