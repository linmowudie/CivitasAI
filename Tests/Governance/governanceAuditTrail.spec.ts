/**
 * G-10 验收：治理动作统一留痕（2026-10-04）
 *
 * 依据灵感源《一些思考2》§1.2：
 *  > **全链路可追溯**：所有上下文变更强制携带元数据
 *  > （全局唯一 ID、时间戳、来源 Agent 标识、任务标识），确保数据血缘清晰。
 *
 * 覆盖：四类元数据强制字段、放行/拒绝均留痕、事件发布、动作标识规范化。
 */
import { describe, it, expect, beforeEach } from 'vitest';

import {
  listGovernanceRecords, getGovernanceRecord, governanceRecordCount, resetGovernanceLedger,
} from '../../Src/Services/Governance/governanceAudit.js';
import { requireGovernanceRole } from '../../Src/Services/Governance/governanceGuard.js';
import { subscribeMany } from '../../Src/Services/EventBus/eventBus.js';
import { EventType } from '../../Src/Services/EventBus/eventTypes.js';

describe('G-10 治理动作统一留痕', () => {
  beforeEach(() => resetGovernanceLedger());

  it('★ 四类元数据强制存在（全局唯一 ID / 时间戳 / 来源 Agent / 任务标识）', () => {
    requireGovernanceRole('auditor', '审计调查', {
      actorId: 'agent-auditor-1', traceId: 'trace-42', taskId: 'task-7', targetIds: ['agent-x'],
    });

    const records = listGovernanceRecords();
    expect(records.length).toBe(1);
    const r = records[0]!;
    expect(r.recordId).toMatch(/^gov-/);           // ① 全局唯一 ID
    expect(typeof r.timestamp).toBe('number');     // ② 时间戳
    expect(r.actorRole).toBe('auditor');           // ③ 来源（角色）
    expect(r.actorId).toBe('agent-auditor-1');     // ③ 来源（Agent）
    expect(r.traceId).toBe('trace-42');            // ④ 任务标识
    expect(r.taskId).toBe('task-7');
    expect(r.outcome).toBe('allowed');
    expect(r.targetIds).toEqual(['agent-x']);
  });

  it('★ 拒绝也留痕（治理事实：谁试图越权、被什么拦下）', () => {
    const denied = requireGovernanceRole('worker', '仲裁裁决', { actorId: 'agent-w1' });
    expect(denied.ok).toBe(false);

    const records = listGovernanceRecords({ outcome: 'denied' });
    expect(records.length).toBe(1);
    expect(records[0]!.action).toBe('arbitration.verdict');
    expect(records[0]!.actorRole).toBe('worker');
    expect(records[0]!.reason).toContain('执行层');
  });

  it('★ 缺少角色同样留痕（fail-closed 且可追溯）', () => {
    const r = requireGovernanceRole(undefined, '治理广播');
    expect(r.ok).toBe(false);
    const records = listGovernanceRecords();
    expect(records.length).toBe(1);
    expect(records[0]!.outcome).toBe('denied');
    expect(records[0]!.actorRole).toBe('unknown');
  });

  it('★ 动作标识规范化（中文动作名 → 域.动作）', () => {
    requireGovernanceRole('regulatory_authority', '治理广播');
    requireGovernanceRole('arbitrator', '仲裁裁决');
    requireGovernanceRole('auditor', '冻结 Agent（审计执法）');

    expect(listGovernanceRecords({ action: 'regulation.broadcast' }).length).toBe(1);
    expect(listGovernanceRecords({ action: 'arbitration.verdict' }).length).toBe(1);
    expect(listGovernanceRecords({ action: 'audit.freeze' }).length).toBe(1);
    expect(governanceRecordCount()).toBe(3);
  });

  it('★ 发布 governance:action_recorded 事件（前端/审计台可实时订阅）', () => {
    const seen: Array<Record<string, unknown>> = [];
    const sub = subscribeMany([EventType.GOVERNANCE_ACTION_RECORDED], (e) => {
      seen.push(e.payload as Record<string, unknown>);
    });

    requireGovernanceRole('auditor', '审计巡查', { traceId: 't-1', taskId: 'k-1' });

    expect(seen.length).toBe(1);
    expect(seen[0]!['action']).toBe('audit.patrol');
    expect(seen[0]!['outcome']).toBe('allowed');
    // 事件 payload 必须带齐四类元数据
    expect(String(seen[0]!['recordId'])).toMatch(/^gov-/);
    expect(typeof seen[0]!['timestamp']).toBe('number');
    expect(seen[0]!['actorRole']).toBe('auditor');
    expect(seen[0]!['taskId']).toBe('k-1');

    sub.unsubscribe?.();
  });

  it('recordId 全局唯一（连续动作不重复）', () => {
    for (let i = 0; i < 5; i++) requireGovernanceRole('auditor', '审计巡查');
    const ids = listGovernanceRecords().map(r => r.recordId);
    expect(new Set(ids).size).toBe(5);
    expect(getGovernanceRecord(ids[0]!)).toBeTruthy();
  });

  it('端到端：审计冻结动作自动产生治理留痕', () => {
    // 经真实治理入口（审计局 freeze）走一遍，验证守卫级留痕确实生效
    return import('../../Src/Services/Audit/resourceAuditBureau.js').then(({ freeze, resetResourceAuditBureau }) => {
      resetResourceAuditBureau();
      const okFreeze = freeze('agent-g10', '审计发现异常', 'auditor');
      expect(okFreeze.ok).toBe(true);

      const records = listGovernanceRecords({ action: 'audit.freeze' });
      expect(records.length).toBe(1);
      expect(records[0]!.outcome).toBe('allowed');
      expect(records[0]!.actorRole).toBe('auditor');
    });
  });
});
