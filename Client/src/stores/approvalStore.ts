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
  const approvedCount = (a.decidedBy ?? []).length;
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
  hydrate: () => Promise<void>;
  decide: (approvalId: string, approve: boolean, decidedBy: string, reason?: string) => Promise<boolean>;
  applyEvent: (type: string) => void;
}

export const useApprovalStore = create<ApprovalState>((set, get) => ({
  approvals: [],
  loading: false,

  hydrate: async () => {
    set({ loading: true });
    const res = await apiGet<Approval[]>('/api/approvals');
    if (res.ok) set({ approvals: res.data, loading: false });
    else set({ loading: false });
  },

  decide: async (approvalId, approve, decidedBy, reason) => {
    const res = await apiPost<Approval>(`/api/approvals/${approvalId}/decide`, { approve, decidedBy, reason });
    if (res.ok) {
      set({
        approvals: get().approvals.map(a =>
          a.approvalId === approvalId ? res.data : a,
        ),
      });
      return true;
    }
    return false;
  },

  applyEvent: (type) => {
    if (type === 'loop:approval_requested' || type === 'loop:approval_decided' || type === 'loop:approval_timeout_rejected') {
      useApprovalStore.getState().hydrate();
    }
  },
}));
