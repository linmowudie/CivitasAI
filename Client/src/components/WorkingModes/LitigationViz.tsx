/**
 * LITIGATION 模式可视化——六步治理 Stepper + 3 仲裁者裁决矩阵 + 事件时间轴。
 *
 * 设计参考：
 *   - Azure DevOps Boards Workflow State Category（Stepper + 状态色）
 *   - OpenShift Incidents Timeline UI（分组警报 + 严重性色带）
 *   - ProcessOn 仲裁案件时间轴（垂直步骤 + 时间戳 + 参与方）
 *   - 仲裁程序流程图（graph LR：申请 → 受理 → 组庭 → 开庭 → 裁决）
 *
 * 回答的问题：六步闭环走到哪一步？3 仲裁者是否达成一致？有没有升级至监管局？
 */
import ModeShell from './ModeShell';
import { DEMO_LITIGATION, fmtMs, STATUS_COLOR, type LitigationDemo } from './demoData';

const VERDICT_LABEL: Record<string, string> = {
  new_wins: '新值胜出 (LWW)',
  old_wins: '旧值保留',
  merge: '双值合并',
  abstract: '抽象上抽',
};

const VERDICT_COLOR: Record<string, string> = {
  new_wins: '#10b981',
  old_wins: '#3b82f6',
  merge: '#8b5cf6',
  abstract: '#f59e0b',
};

export default function LitigationViz({ data = DEMO_LITIGATION }: { data?: LitigationDemo }) {
  const completedSteps = data.steps.filter(s => s.status === 'done').length;
  const currentStep = data.steps.find(s => s.status === 'running') ?? data.steps[data.steps.length - 1];
  const totalSpan = data.steps[data.steps.length - 1].ts;
  const verdictCount: Record<string, number> = {};
  data.verdicts.forEach(v => { verdictCount[v.choice] = (verdictCount[v.choice] ?? 0) + 1; });
  const majority = Object.entries(verdictCount).sort((a, b) => b[1] - a[1])[0];
  const arbitrationLatency = Math.max(...data.verdicts.map(v => v.latencyMs));

  return (
    <ModeShell
      mode="LITIGATION"
      title="六步治理闭环 · Stepper + 3 仲裁者 + 事件时间轴"
      question="六步闭环走到哪一步？3 仲裁者是否达成一致？是否升级至监管局？"
      reference="Azure Boards State Category + Sentinel Alert Timeline + 仲裁案件时间轴"
    >
      {/* ── 六步 Stepper ─────────────────────── */}
      <div className="mb-4">
        <div className="text-[10px] text-text-muted font-mono mb-2">
          案件 {data.caseId} · 冲突类型 <span className="font-mono text-brand-400">{data.conflictType}</span>
        </div>
        <div className="flex items-start justify-between">
          {data.steps.map((s, i) => {
            const color = STATUS_COLOR[s.status];
            const isLast = i === data.steps.length - 1;
            const lineColor = s.status === 'done' ? STATUS_COLOR.done : STATUS_COLOR.pending;
            return (
              <div key={s.key} className="flex items-start flex-1 min-w-0">
                <div className="flex flex-col items-center flex-shrink-0" style={{ minWidth: 62 }}>
                  <div className="w-8 h-8 rounded-full flex items-center justify-center"
                    style={{ background: color, boxShadow: s.status === 'running' ? `0 0 12px ${color}88` : undefined }}>
                    {s.status === 'done' ? (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"
                        strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    ) : s.status === 'running' ? (
                      <span className="w-2.5 h-2.5 rounded-full bg-white animate-pulse-dot" />
                    ) : (
                      <span className="text-[10px] text-white/70 font-mono">{i + 1}</span>
                    )}
                  </div>
                  <div className="text-[11px] text-text-primary mt-1.5 whitespace-nowrap">{s.label}</div>
                  <div className="text-[10px] font-mono text-text-muted">{fmtMs(s.ts)}</div>
                </div>
                {!isLast && (
                  <div className="flex-1 mx-1 mt-3.5 h-0.5 relative overflow-hidden"
                    style={{ background: lineColor, minWidth: 12 }}>
                    {s.status === 'done' && <div className="data-flow-line h-full" />}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── 3 仲裁者裁决矩阵 ─────────────────── */}
      <div className="mb-4">
        <div className="text-[10px] text-text-muted font-mono mb-2">
          3-LLM 仲裁庭 · 独立性保证（Maker-Checker · ADR-0004）· 最大延迟 {fmtMs(arbitrationLatency)}
        </div>
        <div className="grid grid-cols-3 gap-2">
          {data.verdicts.map(v => {
            const color = VERDICT_COLOR[v.choice];
            const isMajority = majority && v.choice === majority[0];
            return (
              <div key={v.arbitratorId}
                className="rounded border p-3 transition-all"
                style={{
                  background: isMajority ? `${color}15` : '#151b2b',
                  borderColor: isMajority ? color : '#1c2438',
                  boxShadow: isMajority ? `0 0 0 1px ${color}44` : undefined,
                }}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[11px] font-mono text-text-secondary">{v.arbitratorId}</span>
                  <span className="text-[10px] font-mono text-text-muted">{v.latencyMs}ms</span>
                </div>
                <div className="text-[10px] text-text-muted font-mono mb-1.5">{v.model}</div>
                <div className="flex items-center gap-1.5 mb-1">
                  <span className="w-2 h-2 rounded-full" style={{ background: color }} />
                  <span className="text-xs font-semibold" style={{ color }}>{VERDICT_LABEL[v.choice]}</span>
                  {isMajority && data.isUnanimous && (
                    <span className="text-[9px] px-1.5 py-0.5 rounded bg-success/20 text-success font-mono">
                      MAJORITY
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-text-secondary leading-relaxed">{v.reasoning}</div>
              </div>
            );
          })}
        </div>
        {data.isDeadlocked && (
          <div className="mt-2 flex items-center gap-2 px-3 py-2 rounded bg-danger/10 border border-danger/40">
            <span className="text-danger animate-pulse-dot">⚡</span>
            <span className="text-sm text-danger font-semibold">3 仲裁者未达成一致 → 死锁</span>
            {data.escalatedToRegulator && (
              <>
                <span className="text-text-muted">→</span>
                <span className="text-sm text-warning">升级至监管局（regulatory_intervention）</span>
              </>
            )}
          </div>
        )}
        {data.isUnanimous && !data.isDeadlocked && (
          <div className="mt-2 flex items-center gap-2 px-3 py-2 rounded bg-success/10 border border-success/30">
            <span className="text-success">✓</span>
            <span className="text-sm text-success">3 仲裁者一致判定：{VERDICT_LABEL[data.verdicts[0].choice]}</span>
          </div>
        )}
      </div>

      {/* ── 事件时间轴（垂直）─────────────────── */}
      <div>
        <div className="text-[10px] text-text-muted font-mono mb-2">
          EventBus 事件流 · 六步闭环时间线（{completedSteps}/{data.steps.length} 已完成，当前：<span className="text-brand-400">{currentStep.label}</span>）
        </div>
        <div className="rounded bg-surface-900 border border-surface-700 p-3">
          {data.steps.map((s, i) => {
            const color = STATUS_COLOR[s.status];
            const isLast = i === data.steps.length - 1;
            return (
              <div key={s.event} className="flex items-stretch gap-3">
                {/* 竖线 + 圆点 */}
                <div className="flex flex-col items-center flex-shrink-0" style={{ width: 12 }}>
                  <div className="w-2.5 h-2.5 rounded-full mt-2 flex-shrink-0"
                    style={{ background: color, boxShadow: `0 0 6px ${color}88` }} />
                  {!isLast && <div className="flex-1 w-px" style={{ background: '#252f47', minHeight: 24 }} />}
                </div>
                <div className="flex-1 pb-2 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-mono text-text-muted w-16">{fmtMs(s.ts)}</span>
                    <span className="text-sm text-text-primary">{s.label}</span>
                    <span className="text-[10px] font-mono text-brand-400/70">{s.event}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </ModeShell>
  );
}
