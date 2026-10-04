import { ShieldCheck, AlertTriangle, RefreshCw, History } from 'lucide-react';
import { useApprovalStore } from '@/stores/approvalStore';
import { useApprovalPolling } from '@/hooks/useApprovalPolling';
import ApprovalCard from '@/components/Approval/ApprovalCard';

interface ApprovalQueueProps {
  /** 嵌入三栏工作区主容器时为 true：隐藏页面级标题（由 TitleBar 统一显示），改用紧凑工具栏 */
  embedded?: boolean;
}

export default function ApprovalQueue({ embedded = false }: ApprovalQueueProps = {}) {
  const { approvals, hydrate, decide, decidingId, lastError } = useApprovalStore();

  useApprovalPolling();

  const handleDecide = async (id: string, approve: boolean) => {
    await decide(id, approve, 'human-operator');
  };

  const pending = approvals.filter(a => a.status === 'PENDING');
  // FE-005：已决条目（通过/拒绝/超时）不再消失，分区展示供回溯
  const decided = approvals.filter(a => a.status !== 'PENDING');

  return (
    <div className={embedded ? 'p-4 space-y-3' : 'p-6 space-y-5'}>
      {embedded ? (
        /* 嵌入模式：紧凑工具栏（标题由 TitleBar 提供） */
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-text-secondary">
            {pending.length > 0
              ? `${pending.length} 项待处理 · CRITICAL 级需双角色审批，超时默认拒绝`
              : '暂无待处理审批 · 工具安全门拦截到危险工具时会在此出现'}
          </span>
          <button className="btn btn-ghost text-xs" onClick={() => { void hydrate(); }}>
            <RefreshCw size={12} />刷新
          </button>
        </div>
      ) : (
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-text-primary">审批队列</h1>
            <p className="text-xs text-text-muted mt-0.5">
              CRITICAL 级需双角色审批 · 超时默认拒绝
            </p>
          </div>
          <span className="badge badge-danger">
            <AlertTriangle size={12} />{pending.length} 待处理
          </span>
        </div>
      )}

      {/* FE-012：决策失败原因可见（限流/网络错误不再"点了没反应"） */}
      {lastError && (
        <div className="rounded-lg border border-danger/40 bg-danger/10 text-danger text-xs px-3 py-2">
          决策提交失败：{lastError}
        </div>
      )}

      {approvals.length === 0 ? (
        <div className={`card text-center ${embedded ? 'py-8' : 'py-12'}`}>
          <ShieldCheck size={32} className="mx-auto text-text-muted mb-3" />
          <p className="text-sm text-text-secondary">暂无审批请求</p>
        </div>
      ) : (
        <div className="space-y-5">
          {/* 待处理分区 */}
          <section className="space-y-3">
            <h2 className="text-xs font-semibold text-text-secondary flex items-center gap-1.5">
              <AlertTriangle size={12} className="text-warning" />
              待处理（{pending.length}）
            </h2>
            {pending.length === 0 ? (
              <div className="card text-center py-6">
                <ShieldCheck size={24} className="mx-auto text-text-muted mb-2" />
                <p className="text-xs text-text-secondary">暂无待处理审批</p>
              </div>
            ) : (
              pending.map(a => (
                <ApprovalCard
                  key={a.approvalId}
                  approval={a}
                  onDecide={handleDecide}
                  deciding={decidingId === a.approvalId}
                />
              ))
            )}
          </section>

          {/* 已决分区（FE-005）：超时/拒绝/通过均保留，供回溯 */}
          {decided.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-xs font-semibold text-text-secondary flex items-center gap-1.5">
                <History size={12} />
                已决（{decided.length}）
              </h2>
              {decided.map(a => (
                <ApprovalCard
                  key={a.approvalId}
                  approval={a}
                  onDecide={handleDecide}
                />
              ))}
            </section>
          )}
        </div>
      )}
    </div>
  );
}
