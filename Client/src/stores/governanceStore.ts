/**
 * @module stores/governanceStore
 * @description 治理动作留痕的前端视图（2026-10-04 新增，配合清单 G-10）。
 *
 * 数据来源两条通路（与 `todoStore` 同构）：
 *  - **实时**：`governance:action_recorded` 事件 → `useEventStore.pushEvent` → 本 store `applyEvent`；
 *  - **回填**：`GET /api/governance/records` 拉取历史（页面刷新后仍有内容）。
 *
 * 展示口径：谁（角色/身份）· 何时 · 做了什么治理动作 · 结果（放行/拒绝）· 依据/目标。
 */

import { create } from 'zustand';

import { useEventStore } from '@/stores/eventStore';
import { apiGet } from '@/services/api';

/** 与后端 `GovernanceRecord` 对齐（前端只读展示，故为宽松类型） */
export interface GovernanceRecordView {
  recordId: string;
  timestamp: number;
  actorRole: string;
  actorId: string;
  traceId: string | null;
  taskId: string | null;
  action: string;
  outcome: 'allowed' | 'denied' | 'failed';
  reason?: string;
  targetIds?: readonly string[];
}

export const GOVERNANCE_EVENT_TYPE = 'governance:action_recorded';

/** 面板保留的最大条数（防止长跑膨胀） */
export const MAX_VISIBLE_RECORDS = 300;

/** 动作标识 → 中文可读标签 */
const ACTION_LABELS: Record<string, string> = {
  'approval.decide': '裁决审批',
  'approval.identity_mismatch': '身份不符（已绑定活动账号）',
  'audit.freeze': '冻结 Agent',
  'audit.unfreeze': '解冻 Agent',
  'audit.investigate': '审计调查',
  'audit.patrol': '审计巡查',
  'arbitration.verdict': '仲裁裁决',
  'arbitration.suspension': '仲裁停职',
  'arbitration.consolidate': '知识沉淀',
  'regulation.intervene': '紧急干预',
  'regulation.escalate': '僵局升级',
  'regulation.rule_add': '新增行为规则',
  'regulation.rule_remove': '删除行为规则',
  'regulation.broadcast': '治理广播',
  'memory.governance_write': '写入治理记忆',
};

export function labelOfAction(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

interface GovernanceState {
  records: GovernanceRecordView[];
  /** 是否已从后端回填过（避免重复拉取） */
  hydrated: boolean;
  filterOutcome: 'all' | 'allowed' | 'denied';
  /** 视图分组：时间线 / 按任务（taskId ?? traceId） */
  groupBy: 'timeline' | 'task';
  applyEvent: (payload: Partial<GovernanceRecordView>) => void;
  hydrate: () => Promise<void>;
  setFilter: (f: GovernanceState['filterOutcome']) => void;
  setGroupBy: (g: GovernanceState['groupBy']) => void;
  clear: () => void;
}

/** 规整事件 payload（后端可能给 null/缺字段） */
function normalize(p: Partial<GovernanceRecordView>): GovernanceRecordView | null {
  if (!p || !p.recordId || !p.action) return null;
  return {
    recordId: String(p.recordId),
    timestamp: Number(p.timestamp ?? Date.now()),
    actorRole: String(p.actorRole ?? 'unknown'),
    actorId: String(p.actorId ?? ''),
    traceId: (p.traceId as string | null) ?? null,
    taskId: (p.taskId as string | null) ?? null,
    action: String(p.action),
    outcome: (p.outcome as GovernanceRecordView['outcome']) ?? 'allowed',
    ...(p.reason !== undefined ? { reason: String(p.reason) } : {}),
    ...(p.targetIds !== undefined ? { targetIds: p.targetIds } : {}),
  };
}

export const useGovernanceStore = create<GovernanceState>((set, get) => ({
  records: [],
  hydrated: false,
  filterOutcome: 'all',
  groupBy: 'timeline',

  applyEvent: (payload) => {
    const rec = normalize(payload);
    if (!rec) return;
    // 幂等：同一 recordId 不重复入列（实时 + 回填可能重叠）
    if (get().records.some(r => r.recordId === rec.recordId)) return;
    const next = [...get().records, rec];
    set({ records: next.length > MAX_VISIBLE_RECORDS ? next.slice(-MAX_VISIBLE_RECORDS) : next });
  },

  hydrate: async () => {
    if (get().hydrated) return;
    set({ hydrated: true });
    try {
      const res = await apiGet('/api/governance/records');
      const list = ((res as { data?: { records?: GovernanceRecordView[] } })?.data?.records) ?? [];
      for (const r of list) get().applyEvent(r);
    } catch {
      // 回填失败不影响实时视图（治理留痕是观测面，不应阻断界面）
      set({ hydrated: false });
    }
  },

  setFilter: (f) => set({ filterOutcome: f }),

  setGroupBy: (g) => set({ groupBy: g }),

  clear: () => set({ records: [] }),
}));

/** 过滤后的记录（面板用） */
export function selectVisibleRecords(state: GovernanceState): GovernanceRecordView[] {
  if (state.filterOutcome === 'all') return state.records;
  return state.records.filter(r => r.outcome === state.filterOutcome);
}

/** 概览统计 */
export function selectSummary(state: GovernanceState): {
  total: number; denied: number; allowed: number;
} {
  const denied = state.records.filter(r => r.outcome === 'denied').length;
  return { total: state.records.length, denied, allowed: state.records.length - denied };
}

// ── 事件接入（实时 + 回放共用一条通路）────────────────────────────────
useEventStore.subscribe((state, prev) => {
  if (state.events === prev.events) return;
  const last = state.events[state.events.length - 1];
  if (!last || last.type !== GOVERNANCE_EVENT_TYPE) return;
  useGovernanceStore.getState().applyEvent((last.data ?? {}) as Partial<GovernanceRecordView>);
});
