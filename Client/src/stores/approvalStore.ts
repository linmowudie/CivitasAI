/**
 * 审批状态 store。
 */
import { create } from 'zustand';
import { apiGet, apiPost } from '@/services/api';

export interface ApprovalDecider {
  role: string;
  weight: number;
}

export interface Approval {
  approvalId: string;
  loopId: string;
  iteration: number;
  kind: string;
  riskLevel: string;
  requestedBy: string;
  payload: unknown;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'TIMEOUT';
  timeoutSec: number;
  requestedAt: number;
  deciders: ApprovalDecider[];
  decisionPolicy: string;
  decidedBy?: string[];
  decidedAt?: number;
  decisionReason?: string;
  /** 关联的工具调用 ID（用于把审批内嵌到对话中的工具行） */
  toolCallId?: string;
  /** 关联工具名 */
  toolName?: string;
  /** 触发该审批的会话 ID */
  sessionId?: string;
  /** 是否为自动审批（策略白名单，无需用户确认） */
  autoApproved?: boolean;
}

/** CRITICAL unanimous 审批进度：已批准数 / 需批准总数 */
export interface ApprovalProgress {
  approvedCount: number;
  requiredCount: number;
  isComplete: boolean;
  isRejected: boolean;
}

export function getApprovalProgress(a: Approval): ApprovalProgress | null {
  if (a.decisionPolicy !== 'unanimous') return null;
  const requiredCount = a.deciders.length;
  // 与后端一致（FE-003）：按「已满足的角色」计数（decidedBy 形如 `role:identity`），
  // 同一身份重复提交不重复计数。
  const requiredRoles = a.deciders.map(d => d.role);
  const satisfied = new Set<string>();
  for (const entry of a.decidedBy ?? []) {
    const sep = entry.indexOf(':');
    const role = sep > 0 ? entry.slice(0, sep) : entry;
    if (requiredRoles.includes(role)) satisfied.add(role);
  }
  const approvedCount = satisfied.size;
  return {
    approvedCount,
    requiredCount,
    isComplete: a.status === 'APPROVED',
    isRejected: a.status === 'REJECTED' || a.status === 'TIMEOUT',
  };
}

interface ApprovalState {
  approvals: Approval[];
  loading: boolean;
  /** 正在提交决策的审批 ID（FE-012：提交中状态，避免按钮"看似无效"） */
  decidingId: string | null;
  /** 最近一次决策失败原因（FE-012：失败原文可见） */
  lastError: string | null;
  hydrate: () => Promise<void>;
  decide: (approvalId: string, approve: boolean, decidedBy: string, reason?: string) => Promise<boolean>;
  applyEvent: (type: string) => void;
}

export const useApprovalStore = create<ApprovalState>((set, get) => ({
  approvals: [],
  loading: false,
  decidingId: null,
  lastError: null,

  hydrate: async () => {
    set({ loading: true });
    // ?status=all：含已决历史（FE-005）——超时/拒绝后条目不再从列表消失
    const res = await apiGet<Approval[]>('/api/approvals?status=all');
    if (res.ok) set({ approvals: res.data, loading: false });
    else set({ loading: false });
  },

  decide: async (approvalId, approve, decidedBy, reason) => {
    set({ decidingId: approvalId, lastError: null });
    try {
      // 单操作者模式：CRITICAL/unanimous 审批需要多个角色（如 user + prime_director），
      // 而客户端只有一位人工操作者。若不补齐角色，工具会一直阻塞到超时（默认拒绝）。
      // 因此一次点击按顺序以各所需角色提交，审计记录里保留 `role:操作者` 痕迹。
      let approval = get().approvals.find(a => a.approvalId === approvalId);
      if (!approval) {
        // 审批可能在点击时还没被轮询拉取到 → 取详情，否则拿不到所需角色列表（只会满足 1/N）
        const detail = await apiGet<Approval>(`/api/approvals/${approvalId}`);
        if (detail.ok) {
          approval = detail.data;
          set({ approvals: [...get().approvals, detail.data] });
        }
      }

      const roles = approval?.decisionPolicy === 'unanimous' && approval.deciders.length > 0
        ? approval.deciders.map(d => d.role)
        : [null];

      let last: Approval | null = null;
      for (const role of roles) {
        const res = await apiPost<Approval>(`/api/approvals/${approvalId}/decide`, {
          approve,
          decidedBy: role ? `${role}:${decidedBy}` : decidedBy,
          reason,
        });
        if (!res.ok) {
          // FE-012：失败原因暴露给 UI（限流等待/网络错误不再"静默无反应"）
          const hint = res.error.retryAfter ? `（限流，${res.error.retryAfter}s 后自动重试）` : '';
          set({ lastError: `${res.error.message}${hint}` });
          return false;
        }
        last = res.data;
        // 拒绝或已落定即可停止；PENDING 说明还需其他角色（继续补齐）
        if (!approve) break;
        const st = String(res.data.status).toUpperCase();
        if (st !== 'PENDING') break;
      }

      if (last) {
        set({
          approvals: get().approvals.map(a => (a.approvalId === approvalId ? last! : a)),
        });
      }
      return true;
    } finally {
      set({ decidingId: null });
    }
  },

  applyEvent: (type) => {
    if (type === 'loop:approval_requested' || type === 'loop:approval_decided' || type === 'loop:approval_timeout_rejected') {
      useApprovalStore.getState().hydrate();
    }
  },
}));
