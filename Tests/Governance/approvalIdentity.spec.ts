/**
 * G-09 验收：审批决策者身份绑定（2026-10-04）
 *
 * 不变量：
 *  1. `user` 角色身份**绑定活动账号** —— 自报身份一律作废（并留痕 mismatch）；
 *  2. Agent 角色必须是**真实注册 Agent**，且其真实角色与所报角色一致（两套词表等价判定）；
 *  3. 校验失败一律 **fail-closed**（拒绝）并写入治理留痕；
 *  4. 不破坏本地单账号场景：人类（user:local）与 Agent（auditor:agent-xxx）是不同主体。
 */
import { describe, it, expect, beforeEach } from 'vitest';

import { bindApprovalIdentity } from '../../Src/Services/Governance/approvalIdentity.js';
import { listGovernanceRecords, resetGovernanceLedger } from '../../Src/Services/Governance/governanceAudit.js';

const AGENTS: Record<string, { agentId: string; role: string }> = {
  'agent-prime_director-1': { agentId: 'agent-prime_director-1', role: 'prime_director' },
  'agent-auditor-1': { agentId: 'agent-auditor-1', role: 'auditor' },
  'agent-worker-1': { agentId: 'agent-worker-1', role: 'worker' },
  // 执行域称呼 regulator（与审批域 regulatory_authority 等价）
  'agent-regulator-1': { agentId: 'agent-regulator-1', role: 'regulator' },
};

const deps = {
  getOwner: () => 'alice',
  getAgentById: (id: string) => AGENTS[id],
};

describe('G-09 审批身份绑定', () => {
  beforeEach(() => resetGovernanceLedger());

  it('★ user 角色：自报身份被作废，绑定活动账号', () => {
    const r = bindApprovalIdentity('user:我是审计员', deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.decidedBy).toBe('user:alice');
    expect(r.value.rewritten).toBe(true);
    // 越权自报必须留痕（可见，不静默）
    const rec = listGovernanceRecords({ action: 'approval.identity_mismatch' });
    expect(rec.length).toBe(1);
    expect(rec[0]!.outcome).toBe('denied');
  });

  it('user 角色：自报与活动账号一致则无改写、无 mismatch 留痕', () => {
    const r = bindApprovalIdentity('user:alice', deps);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.rewritten).toBe(false);
    expect(listGovernanceRecords({ action: 'approval.identity_mismatch' }).length).toBe(0);
  });

  it('★ Agent 角色：必须是真实注册 Agent，否则 403 语义（拒绝 + 留痕）', () => {
    // 用符合 Agent ID 形态（gent-<role>-<n>）但未注册的 ID：走严格校验并被拒
    const r = bindApprovalIdentity('auditor:agent-ghost-9', deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('不是已注册 Agent');
    expect(listGovernanceRecords({ outcome: 'denied' }).length).toBe(1);
  });

  it('★ Agent 角色：真实角色与所报角色不符 → 拒绝（防借他角色身份）', () => {
    // 用 worker 的实例冒充 auditor
    const r = bindApprovalIdentity('auditor:agent-worker-1', deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('与所报');
  });

  it('★ 两套词表等价：执行域 regulator 可承担审批域 regulatory_authority 身份', () => {
    const r = bindApprovalIdentity('regulatory_authority:agent-regulator-1', deps);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.identity).toBe('agent-regulator-1');
  });

  it('Agent 角色未提供 ID → 拒绝（fail-closed）', () => {
    const r = bindApprovalIdentity('auditor', deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('必须提供身份');
  });

  it('本地单账号场景不被破坏：人类与 Agent 是两个不同身份（法定人数可满足）', () => {
    const human = bindApprovalIdentity('user:随便写', deps);
    const agent = bindApprovalIdentity('auditor:agent-auditor-1', deps);
    expect(human.ok && agent.ok).toBe(true);
    if (human.ok && agent.ok) {
      expect(human.value.identity).not.toBe(agent.value.identity); // 不同身份 → 满足"两方"
      expect(human.value.decidedBy).toBe('user:alice');
      expect(agent.value.decidedBy).toBe('auditor:agent-auditor-1');
    }
  });

  it('缺少 decidedBy → 拒绝', () => {
    expect(bindApprovalIdentity('', deps).ok).toBe(false);
  });
});
