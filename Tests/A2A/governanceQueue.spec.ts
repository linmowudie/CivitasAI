/**
 * Tests/A2A/governanceQueue.spec.ts
 *
 * P0a · 治理队列与 L0 按需唤醒（设计 §18 #4 + G-19）
 * 不变量：
 *  1. `escalate` 落进队列（不指向具体 L0 Agent）；普通 kind 不得进队列
 *  2. drain 时**按需唤醒/创建**对应治理角色（G-19：复用已存在、受上限约束）
 *  3. drain 后消息标记已投递 → **幂等**（再 drain 不重复取出）
 *  4. 角色路由：`payload.requiredRole` 生效（含审批域称呼 `regulatory_authority` → `regulator`）；缺省归审计局
 *  5. 统计接口与队列一致
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve, join } from 'node:path';
import { existsSync, rmSync, mkdirSync } from 'node:fs';

import { initDatabase, closeDatabase } from '../../Src/Infra/Db/database.js';
import { initMigrations, clearMigrations, migrateUp } from '../../Src/Infra/Db/migrations.js';
import { setActiveOwner } from '../../Src/Services/AccountScope/activeAccount.js';
import { getAgent, resetAgentRegistry } from '../../Src/Core/AgentRuntime/agentRegistry.js';
import { issueCardForAgent, sendA2A } from '../../Src/Services/A2A/a2aBroker.js';
import { drainGovernanceInbox, governanceInboxStats, listGovernanceInbox, GOVERNANCE_INBOX } from '../../Src/Services/A2A/governanceQueue.js';
import { resetA2aStore, resetStoreProbe } from '../../Src/Services/A2A/a2aStore.js';
import { resetRoleAgentLimits } from '../../Src/Services/Governance/governanceProvisioning.js';
import type { AgentInstance, AgentRole } from '../../Src/Core/AgentRuntime/types.js';

const DIR = resolve(import.meta.dirname, '../../Data/_test_a2a_queue');

function mkAgent(role: AgentRole, agentId: string): AgentInstance {
  return {
    agentId, role, status: 'ready', model: 'test-model',
    createdAt: Date.now() - 1000, updatedAt: Date.now(), consecutiveFailures: 0, awaitingApproval: false,
  };
}

function escalate(agentId: string, taskId: string, payload: Record<string, unknown>) {
  return sendA2A({
    sourceAgentId: agentId, targetAgentId: GOVERNANCE_INBOX, kind: 'escalate',
    taskId, payload, priority: 'high',
  });
}

describe('P0a · 治理队列 + L0 按需唤醒', () => {
  beforeEach(() => {
    closeDatabase(); clearMigrations();
    if (existsSync(DIR)) rmSync(DIR, { recursive: true, force: true });
    mkdirSync(DIR, { recursive: true });
    initDatabase({
      mainPath: join(DIR, 'm.db'), eventsPath: join(DIR, 'e.db'), memoryPath: join(DIR, 'mm.db'),
      walMode: true, busyTimeoutMs: 5000,
    });
    initMigrations();
    expect(migrateUp().ok).toBe(true);
    resetStoreProbe(); resetA2aStore(); setActiveOwner('alice'); resetAgentRegistry(); resetRoleAgentLimits();
    issueCardForAgent(mkAgent('prime_director', 'agent-prime_director-1'), { cardVersion: 1 });
    issueCardForAgent(mkAgent('worker', 'agent-worker-1'), {
      cardVersion: 1, father: { agentId: 'agent-prime_director-1', role: 'prime_director' }, lineage: ['agent-prime_director-1'],
    });
  });
  afterEach(() => {
    resetRoleAgentLimits(); closeDatabase(); clearMigrations();
    if (existsSync(DIR)) rmSync(DIR, { recursive: true, force: true });
  });

  it('① escalate 落进队列；查询参数不得进队列（治理队列是唯一收件方）', () => {
    const sent = escalate('agent-worker-1', 't1', { reason: '指纹不一致' });
    expect(sent.decision.verdict).toBe('allow');
    expect(listGovernanceInbox().length).toBe(1);
    expect(listGovernanceInbox()[0]!.message.envelope.targetAgentId).toBe(GOVERNANCE_INBOX);

    const queryToInbox = sendA2A({
      sourceAgentId: 'agent-worker-1', targetAgentId: GOVERNANCE_INBOX, kind: 'query', taskId: 't1', payload: {},
    });
    expect(queryToInbox.decision.verdict).toBe('block');
    expect(listGovernanceInbox().length).toBe(1);
  });

  it('② ★ drain 时按需唤醒 L0（此前仓库内无 auditor 实例）', () => {
    escalate('agent-worker-1', 't1', { reason: '需要稽查' });
    expect(getAgent('agent-auditor-1')).toBeUndefined();          // 唤醒前不存在
    const r = drainGovernanceInbox({ max: 5 });
    expect(r.drained.length).toBe(1);
    expect(r.ensuredRoles).toContain('auditor');
    expect(r.drained[0]!.assignedAgentId).toBeTruthy();
    expect(getAgent(r.drained[0]!.assignedAgentId!)).toBeDefined(); // 确已创建/唤醒
  });

  it('③ ★ drain 幂等：已投递的消息不再取出', () => {
    escalate('agent-worker-1', 't1', { reason: '一' });
    escalate('agent-worker-1', 't2', { reason: '二' });
    expect(listGovernanceInbox().length).toBe(2);
    const first = drainGovernanceInbox({ max: 10 });
    expect(first.drained.length).toBe(2);
    expect(listGovernanceInbox().length).toBe(0);
    const second = drainGovernanceInbox({ max: 10 });
    expect(second.drained.length).toBe(0);
  });

  it('④ 角色路由：requiredRole 生效（含审批域称呼归一化）；缺省归审计局', () => {
    escalate('agent-worker-1', 't1', { reason: 'a', requiredRole: 'arbitrator' });
    escalate('agent-worker-1', 't2', { reason: 'b', requiredRole: 'regulatory_authority' });
    escalate('agent-worker-1', 't3', { reason: 'c' });
    const items = listGovernanceInbox();
    const roles = items.map(i => i.requiredRole).sort();
    expect(roles).toEqual(['arbitrator', 'auditor', 'regulator']);

    const stats = governanceInboxStats();
    expect(stats.pending).toBe(3);
    expect(stats.byRole['arbitrator']).toBe(1);
    expect(stats.byRole['regulator']).toBe(1);
    expect(stats.byRole['auditor']).toBe(1);
  });

  it('④b 唤醒按角色分别创建（arbitrator/regulator 各自可承接）', () => {
    escalate('agent-worker-1', 't1', { reason: 'a', requiredRole: 'arbitrator' });
    escalate('agent-worker-1', 't2', { reason: 'b', requiredRole: 'regulator' });
    const r = drainGovernanceInbox({ max: 5 });
    expect(Object.keys(r.assignments).sort()).toEqual(['arbitrator', 'regulator']);
    for (const role of ['arbitrator', 'regulator']) {
      const agentId = r.assignments[role]!;
      expect(getAgent(agentId)?.role).toBe(role);
    }
  });

  it('③b ensureAgents=false 时只取出、不创建（用于纯观察/演练）', () => {
    escalate('agent-worker-1', 't1', { reason: 'x' });
    const r = drainGovernanceInbox({ max: 5, ensureAgents: false });
    expect(r.drained.length).toBe(1);
    expect(r.drained[0]!.assignedAgentId).toBeNull();
    expect(r.ensuredRoles).toEqual([]);
  });
});
