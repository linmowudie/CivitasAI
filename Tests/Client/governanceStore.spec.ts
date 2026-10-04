/**
 * 治理记录前端视图单测（2026-10-04）
 *
 * 覆盖：事件入列（幂等 / 上限）、结果过滤、概览统计、动作标签、事件类型契约。
 */
import { describe, it, expect, beforeEach } from 'vitest';

import {
  useGovernanceStore, selectVisibleRecords, selectSummary, labelOfAction,
  GOVERNANCE_EVENT_TYPE, MAX_VISIBLE_RECORDS,
  type GovernanceRecordView,
} from '../../Client/src/stores/governanceStore';

const base: Partial<GovernanceRecordView> = {
  timestamp: 1_700_000_000_000,
  actorRole: 'auditor',
  actorId: 'agent-auditor-1',
  traceId: 't-1',
  taskId: 'k-1',
  outcome: 'allowed',
};

function reset(): void {
  useGovernanceStore.setState({ records: [], hydrated: true, filterOutcome: 'all' });
}

describe('治理记录 store', () => {
  beforeEach(reset);

  it('事件入列并保留四类元数据', () => {
    useGovernanceStore.getState().applyEvent({ ...base, recordId: 'gov-1', action: 'audit.freeze' });
    const recs = useGovernanceStore.getState().records;
    expect(recs.length).toBe(1);
    expect(recs[0]!.actorRole).toBe('auditor');
    expect(recs[0]!.actorId).toBe('agent-auditor-1');
    expect(recs[0]!.taskId).toBe('k-1');
    expect(recs[0]!.timestamp).toBe(1_700_000_000_000);
  });

  it('同一 recordId 幂等（实时 + 回填重叠不重复）', () => {
    const s = useGovernanceStore.getState();
    s.applyEvent({ ...base, recordId: 'gov-dup', action: 'audit.patrol' });
    s.applyEvent({ ...base, recordId: 'gov-dup', action: 'audit.patrol' });
    expect(useGovernanceStore.getState().records.length).toBe(1);
  });

  it('缺 recordId 或 action 的事件被忽略（防御脏数据）', () => {
    const s = useGovernanceStore.getState();
    s.applyEvent({ ...base, action: 'audit.patrol' } as Partial<GovernanceRecordView>);
    s.applyEvent({ ...base, recordId: 'gov-x' } as Partial<GovernanceRecordView>);
    expect(useGovernanceStore.getState().records.length).toBe(0);
  });

  it('★ 拒绝同样入列（越权尝试是有价值的治理事实）', () => {
    const s = useGovernanceStore.getState();
    s.applyEvent({ ...base, recordId: 'gov-ok', action: 'audit.freeze', outcome: 'allowed' });
    s.applyEvent({ ...base, recordId: 'gov-no', action: 'audit.freeze', outcome: 'denied', actorRole: 'worker' });

    const all = selectVisibleRecords(useGovernanceStore.getState());
    expect(all.length).toBe(2);
    const summary = selectSummary(useGovernanceStore.getState());
    expect(summary.denied).toBe(1);
    expect(summary.allowed).toBe(1);

    useGovernanceStore.getState().setFilter('denied');
    const denied = selectVisibleRecords(useGovernanceStore.getState());
    expect(denied.length).toBe(1);
    expect(denied[0]!.actorRole).toBe('worker');
  });

  it('上限裁剪：超过 MAX_VISIBLE_RECORDS 只保留最近若干条', () => {
    const s = useGovernanceStore.getState();
    for (let i = 0; i < MAX_VISIBLE_RECORDS + 20; i++) {
      s.applyEvent({ ...base, recordId: `gov-${i}`, action: 'audit.patrol' });
    }
    const recs = useGovernanceStore.getState().records;
    expect(recs.length).toBe(MAX_VISIBLE_RECORDS);
    // 保留的是最近的（最后一条在列）
    expect(recs[recs.length - 1]!.recordId).toBe(`gov-${MAX_VISIBLE_RECORDS + 19}`);
  });

  it('clear 只清前端视图', () => {
    useGovernanceStore.getState().applyEvent({ ...base, recordId: 'gov-c', action: 'audit.patrol' });
    useGovernanceStore.getState().clear();
    expect(useGovernanceStore.getState().records.length).toBe(0);
  });

  it('动作标签：已知动作中文化，未知动作原样显示', () => {
    expect(labelOfAction('audit.freeze')).toBe('冻结 Agent');
    expect(labelOfAction('regulation.broadcast')).toBe('治理广播');
    expect(labelOfAction('future.unknown_action')).toBe('future.unknown_action');
  });

  it('事件类型契约与后端一致', () => {
    expect(GOVERNANCE_EVENT_TYPE).toBe('governance:action_recorded');
  });
});

describe('治理记录：按任务聚合视图（G-21 前端）', () => {
  beforeEach(reset);

  it('groupBy 切换：默认时间线，可切按任务', () => {
    expect(useGovernanceStore.getState().groupBy).toBe('timeline');
    useGovernanceStore.getState().setGroupBy('task');
    expect(useGovernanceStore.getState().groupBy).toBe('task');
    useGovernanceStore.getState().setGroupBy('timeline');
    expect(useGovernanceStore.getState().groupBy).toBe('timeline');
  });

  it('按任务聚合：taskId 优先、无 taskId 退回 traceId、都没有则归入"无任务标识"', () => {
    const s = useGovernanceStore.getState();
    s.applyEvent({ ...base, recordId: 'g1', action: 'approval.decide', taskId: 'task-A', traceId: 'trace-1' });
    s.applyEvent({ ...base, recordId: 'g2', action: 'audit.patrol', taskId: 'task-A', traceId: 'trace-1' });
    s.applyEvent({ ...base, recordId: 'g3', action: 'regulation.broadcast', taskId: null, traceId: 'trace-9' });
    s.applyEvent({ ...base, recordId: 'g4', action: 'arbitration.verdict', taskId: null, traceId: null });

    // 与面板同一聚合口径（taskId ?? traceId ?? 无任务标识）
    const groups = new Map<string, number>();
    for (const r of useGovernanceStore.getState().records) {
      const key = r.taskId ?? r.traceId ?? '（无任务标识）';
      groups.set(key, (groups.get(key) ?? 0) + 1);
    }
    expect(groups.get('task-A')).toBe(2);
    expect(groups.get('trace-9')).toBe(1);
    expect(groups.get('（无任务标识）')).toBe(1);
    expect(groups.size).toBe(3);
  });
});