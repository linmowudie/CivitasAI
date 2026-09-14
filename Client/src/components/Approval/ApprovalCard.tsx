/**
 * ApprovalCard — 审批卡片组件。
 * 展示风险等级、payload 摘要、请求方、决策角色集合、剩余超时。
 * CRITICAL 显示"需双角色"进度（如 1/2）。
 */
import { useState, useEffect } from 'react';
import { ShieldCheck, Clock, Check, X, Users } from 'lucide-react';
import { type Approval, getApprovalProgress } from '@/stores/approvalStore';

const riskStyle: Record<string, string> = {
  CRITICAL: 'badge badge-danger',
  HIGH: 'badge badge-warning',
  MEDIUM: 'badge badge-info',
  LOW: 'badge',
};

const riskIconColor: Record<string, string> = {
  CRITICAL: 'bg-danger/15 text-danger',
  HIGH: 'bg-warning/15 text-warning',
  MEDIUM: 'bg-info/15 text-info',
  LOW: 'bg-surface-300 text-text-secondary',
};

interface ApprovalCardProps {
  approval: Approval;
  onDecide: (approvalId: string, approve: boolean) => void;
}

export default function ApprovalCard({ approval, onDecide }: ApprovalCardProps) {
  const a = approval;
  const [remaining, setRemaining] = useState<number | null>(null);
  const progress = getApprovalProgress(a);

  // 倒计时（基于后端 requestedAt + timeoutSec，不做假递减）
  useEffect(() => {
    if (a.status !== 'PENDING') { setRemaining(null); return; }
    const calc = () => {
      const expiresAt = a.requestedAt + a.timeoutSec * 1000;
      setRemaining(Math.max(0, Math.floor((expiresAt - Date.now()) / 1000)));
    };
    calc();
    const timer = setInterval(calc, 1000);
    return () => clearInterval(timer);
  }, [a.status, a.requestedAt, a.timeoutSec]);

  const formatTimer = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
  const payloadStr = typeof a.payload === 'string' ? a.payload : JSON.stringify(a.payload, null, 2);
  const truncatedPayload = payloadStr.length > 120 ? payloadStr.slice(0, 120) + '…' : payloadStr;

  return (
    <div className={`card ${a.status === 'PENDING' ? 'card-glow' : ''} ${a.status !== 'PENDING' ? 'opacity-60' : ''}`}>
      <div className="flex items-start justify-between gap-4">
        {/* 左侧：信息区 */}
        <div className="flex items-start gap-3 min-w-0">
          <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${riskIconColor[a.riskLevel] ?? riskIconColor.LOW}`}>
            <ShieldCheck size={18} />
          </div>
          <div className="min-w-0">
            {/* 标题行 */}
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <span className={`text-xs font-mono font-semibold ${a.status === 'PENDING' ? 'text-text-primary' : 'text-text-muted'}`}>
                {a.approvalId}
              </span>
              <span className={riskStyle[a.riskLevel]}>{a.riskLevel}</span>
              <span className="badge badge-brand text-[10px]">{a.kind}</span>
            </div>

            {/* Payload 摘要 */}
            <div className="text-xs text-text-secondary mb-1.5 truncate" title={payloadStr}>
              {truncatedPayload}
            </div>

            {/* 元信息行 */}
            <div className="flex items-center gap-3 text-[10px] text-text-muted font-mono flex-wrap">
              <span>Loop: {a.loopId}</span>
              <span>·</span>
              <span>请求方: {a.requestedBy}</span>
              {a.deciders && (
                <>
                  <span>·</span>
                  <span className="flex items-center gap-1">
                    <Users size={10} />
                    {a.deciders.map(d => d.role).join(' + ')}
                  </span>
                </>
              )}
            </div>

            {/* CRITICAL 双角色进度 */}
            {progress && (
              <div className="mt-2 flex items-center gap-2">
                <div className="flex gap-1">
                  {Array.from({ length: progress.requiredCount }).map((_, i) => (
                    <div
                      key={i}
                      className={`w-2 h-2 rounded-full ${
                        i < progress.approvedCount
                          ? progress.isRejected ? 'bg-danger' : 'bg-success'
                          : 'bg-surface-400'
                      }`}
                    />
                  ))}
                </div>
                <span className="text-[10px] text-text-muted font-mono">
                  {progress.isRejected
                    ? '已拒绝'
                    : progress.isComplete
                      ? `${progress.approvedCount}/${progress.requiredCount} 已通过`
                      : `${progress.approvedCount}/${progress.requiredCount} 已审批`}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* 右侧：操作区 */}
        <div className="flex flex-col items-end gap-2 shrink-0">
          {a.status === 'PENDING' ? (
            <>
              {/* 剩余超时 */}
              <div className={`flex items-center gap-1 text-xs font-mono ${
                remaining !== null && remaining < 60 ? 'text-danger' : 'text-text-secondary'
              }`}>
                <Clock size={12} />
                {remaining !== null ? formatTimer(remaining) : '--:--'}
              </div>
              {/* 批准/拒绝按钮 */}
              <div className="flex gap-2">
                <button
                  onClick={() => onDecide(a.approvalId, true)}
                  className="btn btn-success text-xs"
                >
                  <Check size={14} />批准
                </button>
                <button
                  onClick={() => onDecide(a.approvalId, false)}
                  className="btn btn-danger text-xs"
                >
                  <X size={14} />拒绝
                </button>
              </div>
            </>
          ) : (
            <span className={`badge ${
              a.status === 'APPROVED' ? 'badge-success' : 'badge-danger'
            }`}>
              {a.status === 'APPROVED' ? '已通过' : a.status === 'TIMEOUT' ? '超时拒绝' : '已拒绝'}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
