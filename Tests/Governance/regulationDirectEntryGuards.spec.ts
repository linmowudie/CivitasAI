/**
 * FE-042 / FE-043 验收：监管域直接入口治理守卫（2026-10-04）
 *
 * 背景（缺陷清单）：
 *  - FE-042：`finalArbiter.issueFinalVerdict` 直接入口无守卫（清单 G-03 声称已实现，实际未接线）；
 *  - FE-043：`behaviorCode.addRule/removeRule/updateVersion` 底层无守卫（G-04 声称已实现，实际存在旁路）。
 *
 * 不变量：
 *  1. 非 L0 角色调用上述直接入口 → fail-closed 拒绝 + 留痕（outcome=denied）；
 *  2. L0（regulatory_authority）调用 → 放行 + 留痕（outcome=allowed）；
 *  3. 代理链路（regulatoryAuthority.addBehaviorRule）单次留痕，不因两层守卫双重记录。
 */
import { describe, it, expect, beforeEach } from 'vitest';

import { issueFinalVerdict, resetFinalArbiter } from '../../Src/Services/Regulation/finalArbiter.js';
import {
  addRule, removeRule, updateVersion, getRule, initBehaviorCode, resetBehaviorCode,
} from '../../Src/Services/Regulation/behaviorCode.js';
import { addBehaviorRule } from '../../Src/Services/Regulation/regulatoryAuthority.js';
import { fileCase, assembleCapsule, getCase, resetTribunal } from '../../Src/Services/Arbitration/tribunal.js';
import { listGovernanceRecords, resetGovernanceLedger } from '../../Src/Services/Governance/governanceAudit.js';
import { resetEventBus } from '../../Src/Services/EventBus/eventBus.js';

function makeDeadlockedCase() {
  const filed = fileCase({
    conflictId: `fe042-${Math.random().toString(36).slice(2, 8)}`,
    traceId: 'fe042-trace',
    conflictType: 'contradiction',
    plaintiffAgentId: 'a1',
    defendantAgentId: 'a2',
  });
  if (!filed.ok) throw new Error('立案失败');
  assembleCapsule(filed.value.caseId, {
    newMemoryContent: 'A', oldMemoryContent: 'B', taskDescription: 'T',
  });
  const c = getCase(filed.value.caseId);
  if (!c) throw new Error('案件不存在');
  c.status = 'deadlocked';
  return c;
}

describe('FE-042 终局裁决（issueFinalVerdict）直接入口守卫', () => {
  beforeEach(() => {
    resetFinalArbiter();
    resetTribunal();
    resetGovernanceLedger();
    resetEventBus();
  });

  it('★ 非 L0 直接调用 → fail-closed 拒绝并留痕', () => {
    const c = makeDeadlockedCase();
    const denied = issueFinalVerdict({ case_: c, reason: 'deadlock', actorRole: 'worker' });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error).toContain('治理');

    const records = listGovernanceRecords({ action: 'regulation.final_verdict' });
    expect(records.length).toBe(1);
    expect(records[0]!.outcome).toBe('denied');
    expect(records[0]!.actorRole).toBe('worker');
  });

  it('★ L0（regulatory_authority）调用 → 放行并留痕', () => {
    const c = makeDeadlockedCase();
    const allowed = issueFinalVerdict({ case_: c, reason: 'deadlock', actorRole: 'regulatory_authority' });
    expect(allowed.ok).toBe(true);

    const records = listGovernanceRecords({ action: 'regulation.final_verdict' });
    expect(records.length).toBe(1);
    expect(records[0]!.outcome).toBe('allowed');
  });
});

describe('FE-043 行为准则底层入口守卫', () => {
  const newRule = {
    ruleId: 'fe043-rule', category: 'safety' as const,
    description: '底层入口守卫测试', condition: 'c', action: 'warn' as const,
    severity: 'low' as const, enforceable: false,
  };

  beforeEach(() => {
    resetBehaviorCode();
    resetGovernanceLedger();
    resetEventBus();
    initBehaviorCode();
  });

  it('★ addRule 底层直调：非 L0 被拒 / L0 放行', () => {
    const denied = addRule({ ...newRule }, 'prime_director');
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error).toContain('治理');
    expect(getRule('fe043-rule')).toBeUndefined();

    const allowed = addRule({ ...newRule }, 'regulatory_authority');
    expect(allowed.ok).toBe(true);
    expect(getRule('fe043-rule')).toBeDefined();
  });

  it('★ removeRule / updateVersion 底层直调：非 L0 被拒', () => {
    expect(removeRule('resource-001', 'worker').ok).toBe(false);
    expect(getRule('resource-001')).toBeDefined(); // 未被删除

    expect(updateVersion('2.0.0', 'reviewer').ok).toBe(false);

    expect(removeRule('resource-001', 'auditor').ok).toBe(true);
    expect(updateVersion('2.0.0', 'auditor').ok).toBe(true);
  });

  it('★ 代理链路单次留痕（守卫下沉后不双重记录）', () => {
    const viaProxy = addBehaviorRule({ ...newRule }, 'regulatory_authority');
    expect(viaProxy.ok).toBe(true);

    const records = listGovernanceRecords({ action: 'regulation.rule_add' });
    expect(records.length).toBe(1);
    expect(records[0]!.outcome).toBe('allowed');
  });

  it('★ 代理链路拒绝路径同样单次留痕', () => {
    const viaProxy = addBehaviorRule({ ...newRule }, 'worker');
    expect(viaProxy.ok).toBe(false);

    const records = listGovernanceRecords({ action: 'regulation.rule_add' });
    expect(records.length).toBe(1);
    expect(records[0]!.outcome).toBe('denied');
  });
});
