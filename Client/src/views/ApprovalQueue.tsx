import { useEffect } from 'react';
import { ShieldCheck, AlertTriangle } from 'lucide-react';
import { useApprovalStore } from '@/stores/approvalStore';
import ApprovalCard from '@/components/Approval/ApprovalCard';

export default function ApprovalQueue() {
  const { approvals, hydrate, decide } = useApprovalStore();

  useEffect(() => { hydrate(); }, []);

  const handleDecide = async (id: string, approve: boolean) => {
    await decide(id, approve, 'human-operator');
  };

  const pending = approvals.filter(a => a.status === 'PENDING');

  return (
    <div className="p-6 space-y-5">
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

      {approvals.length === 0 ? (
        <div className="card text-center py-12">
          <ShieldCheck size={32} className="mx-auto text-text-muted mb-3" />
          <p className="text-sm text-text-secondary">暂无审批请求</p>
        </div>
      ) : (
        <div className="space-y-3">
          {approvals.map(a => (
            <ApprovalCard
              key={a.approvalId}
              approval={a}
              onDecide={handleDecide}
            />
          ))}
        </div>
      )}
    </div>
  );
}
