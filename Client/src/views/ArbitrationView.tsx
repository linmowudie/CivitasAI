import { useEffect } from 'react';
import { Scale, AlertTriangle, CheckCircle2, Clock, ArrowRight, Eye } from 'lucide-react';
import { useLoopStore } from '@/stores/loopStore';

const caseStatusSteps = ['filed', 'assembling', 'reasoning', 'verdict_ready', 'suspended', 'restoring', 'completed'];
const statusLabel: Record<string, string> = {
  filed: '已立案', assembling: '胶囊组装', reasoning: '裁决推理', verdict_ready: '裁决就绪',
  suspended: '已挂起', restoring: '恢复中', completed: '已完成', deadlocked: '死锁', timeout: '超时',
};
const statusStyle: Record<string, string> = {
  completed: 'badge-success', reasoning: 'badge-brand', deadlocked: 'badge-danger', filed: 'badge-info',
};

export default function ArbitrationView() {
  const { events, hydrate } = useLoopStore();

  useEffect(() => { hydrate({ limit: 200 }); }, []);

  // 从事件流中提取仲裁案件
  const arbitrationEvents = events.filter(e => e.eventType.startsWith('arbitration:'));
  const cases = arbitrationEvents.map(e => ({
    caseId: e.eventId,
    conflictId: e.traceId ?? '',
    conflictType: String(e.payload?.conflictType ?? 'unknown'),
    status: e.eventType.includes('filed') ? 'filed' : 'reasoning',
    plaintiff: e.source,
    defendant: '',
    verdict: null as string | null,
    filedAt: e.timestamp,
    verdictAt: undefined as number | undefined,
  }));

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-text-primary">仲裁中心</h1>
          <p className="text-xs text-text-muted mt-0.5">六步治理闭环 · 9 态案件流转 · 死锁升级</p>
        </div>
        <div className="flex gap-2 text-[11px]">
          <span className="badge badge-success">完成 {cases.filter(c => c.status === 'completed').length}</span>
          <span className="badge badge-brand">进行中 {cases.filter(c => !['completed', 'deadlocked'].includes(c.status)).length}</span>
          <span className="badge badge-danger">死锁 {cases.filter(c => c.status === 'deadlocked').length}</span>
        </div>
      </div>

      {cases.length === 0 ? (
        <div className="card text-center py-12">
          <Scale size={32} className="mx-auto text-text-muted mb-3" />
          <p className="text-sm text-text-secondary">暂无仲裁案件</p>
          <p className="text-xs text-text-muted mt-1">当 Agent 间产生冲突时，仲裁案件将在此显示</p>
        </div>
      ) : (
        <div className="space-y-4">
          {cases.map(c => (
            <div key={c.caseId} className={`card ${c.status === 'deadlocked' ? 'border-danger/30 card-glow' : ''}`}>
              <div className="flex items-start justify-between mb-3">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <Scale size={14} className={c.status === 'deadlocked' ? 'text-danger' : 'text-brand-400'} />
                    <span className="text-sm font-mono font-semibold text-text-primary">{c.caseId}</span>
                    <span className={`badge ${statusStyle[c.status] ?? 'badge-warning'} text-[10px]`}>
                      {c.status === 'deadlocked' && <AlertTriangle size={10} />}
                      {statusLabel[c.status] ?? c.status}
                    </span>
                  </div>
                  <div className="text-[10px] text-text-muted font-mono">
                    {c.conflictId} · {c.conflictType}
                  </div>
                </div>
                <div className="text-right text-[10px] text-text-muted font-mono">
                  <div>原告: {c.plaintiff}</div>
                  {c.defendant && <div>被告: {c.defendant}</div>}
                </div>
              </div>

              {/* 状态机流转 */}
              <div className="flex items-center gap-1 mb-3 overflow-x-auto pb-1">
                {caseStatusSteps.map((step, i) => {
                  const currentIdx = caseStatusSteps.indexOf(c.status);
                  const isPast = i < currentIdx || c.status === 'completed';
                  const isCurrent = step === c.status;
                  return (
                    <div key={step} className="flex items-center gap-1 flex-shrink-0">
                      <div className={`px-2 py-0.5 rounded text-[10px] font-mono ${
                        isCurrent ? 'bg-brand-600 text-white' :
                        isPast ? 'bg-success/20 text-success' :
                        'bg-surface-700 text-text-muted'
                      }`}>
                        {statusLabel[step]}
                      </div>
                      {i < caseStatusSteps.length - 1 && (
                        <ArrowRight size={10} className={isPast ? 'text-success' : 'text-text-muted'} />
                      )}
                    </div>
                  );
                })}
              </div>

              {c.status === 'reasoning' && (
                <div className="flex items-center gap-2 p-2 rounded-lg bg-brand-600/5 border border-brand-600/20">
                  <Clock size={14} className="text-brand-400 animate-pulse-dot" />
                  <span className="text-xs text-brand-400">仲裁者正在推理中...</span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
