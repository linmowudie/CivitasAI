/**
 * 治理角色按需创建 / 按需扩容（2026-10-04）
 *
 * 依据用户裁定：「L0 级不是常驻的，而是按需求创建，同时会按需求扩容」。
 *
 * 不变量：
 *  1. 无实例 → **创建**（治理角色走受控播种通道，且留痕 `governance.agent_provisioned`）；
 *  2. 已有实例 → **复用**（幂等，不无谓扩容）；
 *  3. 达到上限 → 不再创建（扩容有度）；
 *  4. 两套词表归一化（`regulatory_authority` → `regulator`）；
 *  5. 非法角色 → 拒绝；L1/L2 角色同样支持按需创建（供 L2 自治域决策池用）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve, join } from 'node:path';
import { existsSync, rmSync, mkdirSync } from 'node:fs';

import { initDatabase, closeDatabase } from '../../Src/Infra/Db/database.js';
import { initMigrations, clearMigrations, migrateUp } from '../../Src/Infra/Db/migrations.js';
import { resetAgentRegistry, getAgentsByRole } from '../../Src/Core/AgentRuntime/agentRegistry.js';
import { resetAgentFactory } from '../../Src/Core/AgentRuntime/agentFactory.js';
import {
  ensureAgentForRole, ensureAgentsForRoles, setRoleAgentLimit, resetRoleAgentLimits,
} from '../../Src/Services/Governance/governanceProvisioning.js';
import { listGovernanceRecords, resetGovernanceLedger } from '../../Src/Services/Governance/governanceAudit.js';

const DIR = resolve(import.meta.dirname, '../../Data/_test_provisioning');

function initDb(): void {
  closeDatabase(); clearMigrations();
  if (existsSync(DIR)) rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  initDatabase({
    mainPath: join(DIR, 'm.db'), eventsPath: join(DIR, 'e.db'), memoryPath: join(DIR, 'mm.db'),
    walMode: true, busyTimeoutMs: 5000,
  });
  initMigrations();
  expect(migrateUp().ok).toBe(true);
}

describe('治理角色按需创建 / 扩容', () => {
  beforeEach(() => {
    initDb(); resetAgentRegistry(); resetAgentFactory(); resetRoleAgentLimits(); resetGovernanceLedger();
  });
  afterEach(() => { closeDatabase(); clearMigrations(); if (existsSync(DIR)) rmSync(DIR, { recursive: true, force: true }); });

  it('★ 无实例 → 按需创建 L0 Agent（并留痕）', () => {
    const r = ensureAgentForRole('auditor', { reason: '不可逆操作审批需要 L0' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.created).toBe(true);
    expect(r.value.role).toBe('auditor');
    expect(getAgentsByRole('auditor' as never).length).toBe(1);

    const trail = listGovernanceRecords({ action: 'governance.agent_provisioned' });
    expect(trail.length).toBe(1);
    expect(trail[0]!.reason).toContain('按需创建');
  });

  it('★ 已有实例 → 复用（幂等，不无谓扩容）', () => {
    const first = ensureAgentForRole('auditor');
    const second = ensureAgentForRole('auditor');
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.value.agentId).toBe(second.value.agentId);
      expect(second.value.created).toBe(false);
    }
    expect(getAgentsByRole('auditor' as never).length).toBe(1);
  });

  it('★ 两套词表归一化：regulatory_authority 与 regulator 是同一角色', () => {
    const a = ensureAgentForRole('regulatory_authority');
    expect(a.ok).toBe(true);
    if (a.ok) expect(a.value.role).toBe('regulator');   // 归一化为执行域称呼
    const b = ensureAgentForRole('regulator');
    if (a.ok && b.ok) expect(b.value.agentId).toBe(a.value.agentId); // 复用同一实例
  });

  it('★ 扩容有度：达到上限后不再创建', () => {
    setRoleAgentLimit('auditor', 1);
    const a = ensureAgentForRole('auditor');
    expect(a.ok).toBe(true);
    // 上限 1：再次请求仍复用，实例数不增长
    ensureAgentForRole('auditor');
    expect(getAgentsByRole('auditor' as never).length).toBe(1);
  });

  it('批量确保（审批决策池）：多角色各自就位', () => {
    const map = ensureAgentsForRoles(['user', 'auditor', 'prime_director']);
    // `user` 是人类所有者、非 UserRole → 不可创建（不在执行域词表），其余两个应就位
    expect(map.size).toBe(2);
    expect(map.get('auditor')).toMatch(/^agent-auditor-\d+$/);
    expect(map.get('prime_director')).toMatch(/^agent-prime_director-\d+$/);
  });

  it('非法角色 → 拒绝，且不产生 Agent', () => {
    const r = ensureAgentForRole('hacker');
    expect(r.ok).toBe(false);
    expect(getAgentsByRole('worker' as never).length).toBe(0);
  });

  it('L1/L2 角色同样支持按需创建（供 L2 自治域决策池）', () => {
    const w = ensureAgentForRole('worker', { reason: 'L2 自治域审批需要 L1 参与' });
    expect(w.ok).toBe(true);
    if (w.ok) expect(w.value.role).toBe('worker');
  });
});
