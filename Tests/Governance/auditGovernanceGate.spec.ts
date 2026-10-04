/**
 * G-01 验收：审计执法动作必须由 L0 治理角色执行（2026-10-04）
 *
 * 治理规则（产品裁定）：治理层只由 L0 承担，L1/L2 只做事。
 * 本用例锁定审计执法四入口的角色门：investigate / runPatrol / freeze / unfreeze。
 *
 * 参见 `Docs/Dev/治理层完善清单.md` G-01。
 */
import { describe, it, expect, beforeEach } from 'vitest';

import {
  investigate, runPatrol, freeze, unfreeze,
  resetResourceAuditBureau, addAgentSnapshot,
} from '../../Src/Services/Audit/resourceAuditBureau.js';
import { requireGovernanceRole, tierOf, isGovernanceRole } from '../../Src/Services/Governance/governanceGuard.js';
import { reasonVerdict, issueSuspension } from '../../Src/Services/Arbitration/tribunal.js';
import {
  emergencyIntervene, addBehaviorRule, validateBehavior, resetRegulatoryAuthority, initRegulatoryAuthority,
} from '../../Src/Services/Regulation/regulatoryAuthority.js';
import { resetBroadcastChannel } from '../../Src/Services/Regulation/broadcastChannel.js';

describe('G-01 审计执法角色门', () => {
  beforeEach(() => {
    resetResourceAuditBureau();
  });

  it('★ 执行层角色不得冻结 Agent（L1/L2 只做事）', () => {
    for (const role of ['prime_director', 'partner', 'worker', 'reviewer', 'assembly_node']) {
      const r = freeze('agent-l2', '试图越权冻结', role);
      expect(r.ok, `${role} 不应被允许冻结`).toBe(false);
      if (!r.ok) expect(r.error).toContain('治理');
    }
  });

  it('★ L0 治理角色可以冻结 / 解冻', () => {
    const f = freeze('agent-gov', '审计发现异常', 'auditor');
    expect(f.ok).toBe(true);

    const u = unfreeze('agent-gov', 'regulatory_authority');
    expect(u.ok).toBe(true);
  });

  it('★ 执行层角色不得触发审计调查与巡查', () => {
    addAgentSnapshot({
      agentId: 'agent-x', windowStartMs: Date.now() - 1000, tokensUsed: 10,
      toolCalls: 1, iterations: 1, violations: [], timestamp: Date.now(),
    } as never);

    const inv = investigate('agent-x', 'worker');
    expect(inv.ok).toBe(false);
    if (!inv.ok) expect(inv.error).toContain('治理');

    const patrol = runPatrol('partner');
    expect(patrol.ok).toBe(false);
    if (!patrol.ok) expect(patrol.error).toContain('治理');
  });

  it('L0 可执行调查与巡查（角色门不误伤治理自身）', () => {
    const patrol = runPatrol('auditor');
    expect(patrol.ok).toBe(true);
  });

  it('层级判定：L0 与所有者具备治理资格，L1/L2 不具备', () => {
    expect(isGovernanceRole('user')).toBe(true);
    expect(isGovernanceRole('auditor')).toBe(true);
    expect(isGovernanceRole('regulatory_authority')).toBe(true);
    expect(isGovernanceRole('regulator')).toBe(true);      // 执行域词表别名
    expect(isGovernanceRole('arbitrator')).toBe(true);
    expect(isGovernanceRole('prime_director')).toBe(false);
    expect(isGovernanceRole('worker')).toBe(false);

    expect(tierOf('user')).toBe('owner');
    expect(tierOf('auditor')).toBe('L0');
    expect(tierOf('partner')).toBe('L1');
    expect(tierOf('assembly_node')).toBe('L2');
  });

  it('requireGovernanceRole：拒绝执行层并给出可读原因', () => {
    const denied = requireGovernanceRole('worker', '仲裁裁定');
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.error).toContain('仲裁裁定被拒绝');
      expect(denied.error).toContain('L0');
    }
    expect(requireGovernanceRole('auditor', '仲裁裁定').ok).toBe(true);
    expect(requireGovernanceRole(undefined, '仲裁裁定').ok).toBe(false); // fail-closed
  });
});

describe('G-02 仲裁裁决角色门', () => {
  it('★ 执行层角色不得裁决（reasonVerdict / issueSuspension）', () => {
    for (const role of ['prime_director', 'worker', 'reviewer']) {
      const v = reasonVerdict('case-not-exist', role);
      // 先被治理门拦下（而不是"案件不存在"）
      expect(v.ok, `${role} 不应被允许裁决`).toBe(false);
      if (!v.ok) expect(v.error).toContain('治理');

      const s = issueSuspension('case-not-exist', role);
      expect(s.ok).toBe(false);
      if (!s.ok) expect(s.error).toContain('治理');
    }
  });

  it('治理角色通过角色门（随后因案件不存在而失败 —— 证明不是被治理门拦下）', () => {
    const v = reasonVerdict('case-not-exist', 'arbitrator');
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.error).not.toContain('治理');
      expect(v.error).toContain('不存在');
    }
  });

  it('内容审查（reviewer）不属治理：reviewer 不参与裁决与停职', () => {
    // reviewer 是"审查生成内容"的 L2 角色，不得执行副作用/行为治理动作
    expect(requireGovernanceRole('reviewer', '仲裁裁决').ok).toBe(false);
    expect(tierOf('reviewer')).toBe('L2');
  });
});

describe('G-03 / G-04 监管执法与立法角色门（借鉴 MongoTerminalAgent 监管理念）', () => {
  beforeEach(() => {
    resetRegulatoryAuthority();
    resetBroadcastChannel();
    initRegulatoryAuthority();
  });

  it('★ 紧急干预必须 L0：执行层角色被拒', () => {
    for (const role of ['prime_director', 'worker', 'reviewer']) {
      const r = emergencyIntervene({ type: 'pause_all', reason: '越权尝试', actorRole: role });
      expect(r.ok, `${role} 不应被允许紧急干预`).toBe(false);
      if (!r.ok) expect(r.error).toContain('治理');
    }
  });

  it('★ 立法（新增行为规则）必须 L0', () => {
    const bad = addBehaviorRule({
      ruleId: 'R-X', name: '越权规则', description: 'x',
      severity: 'warning', checkType: 'pattern', pattern: 'x',
    } as never, 'worker');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain('治理');
  });

  it('L0 可执法，且留痕 actedByRole', () => {
    const r = emergencyIntervene({
      type: 'pause_all', reason: '监管发现全局异常', actorRole: 'regulatory_authority',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.actedByRole).toBe('regulatory_authority');
  });

  it('★ 理念区分：判据查询不限角色，只有裁量执法才要 L0', () => {
    // 与 MongoTerminalAgent 一致：监管"检测"可自动运行，"执法"才需授权
    const check = validateBehavior({ agentId: 'agent-1', action: 'read_file' });
    expect(typeof check.violated).toBe('boolean');
    expect(check.violated).toBe(false);

    // 命中规则时给出判据（仍不需要治理角色）
    const hit = validateBehavior({ agentId: 'agent-1', action: 'access_private_key' });
    expect(hit.violated).toBe(true);
    expect(hit.rules.length).toBeGreaterThan(0);
  });
});
