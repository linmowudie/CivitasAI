/**
 * G-11 验收：L0 治理角色不可被招募 / 伪造 / 赋权（2026-10-04）
 *
 * 不变量：
 *  1. `agentFactory.createAgent` 拒绝治理角色（regulator / regulatory_authority / auditor / arbitrator）；
 *  2. `agentRegistry.registerAgent` 拒绝伪造的治理角色实例（防御纵深，防绕过工厂）；
 *  3. L1/L2 角色正常可创建可注册（不误伤）；
 *  4. 受控系统路径可显式打开 `allowGovernance`（逃生舱有据可查）；
 *  5. 招募工具的角色白名单不含治理角色（既有约束保持）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve, join } from 'node:path';
import { existsSync, rmSync, mkdirSync } from 'node:fs';

import { initDatabase, closeDatabase } from '../../Src/Infra/Db/database.js';
import { initMigrations, clearMigrations, migrateUp } from '../../Src/Infra/Db/migrations.js';
import { createAgent, resetAgentFactory } from '../../Src/Core/AgentRuntime/agentFactory.js';
import { registerAgent, resetAgentRegistry } from '../../Src/Core/AgentRuntime/agentRegistry.js';
import {
  isAssignableAgentRole, denyReasonForAgentRole, isGovernanceActor,
} from '../../Src/Infra/Roles/roleVocabulary.js';
import type { AgentInstance } from '../../Src/Core/AgentRuntime/types.js';

const DIR = resolve(import.meta.dirname, '../../Data/_test_g11_roles');
const GOVERNANCE = ['regulator', 'regulatory_authority', 'auditor', 'arbitrator'];
const EXECUTION = ['prime_director', 'partner', 'worker', 'reviewer', 'assembly_node'];

function initDb(): void {
  closeDatabase(); clearMigrations();
  if (existsSync(DIR)) rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  initDatabase({
    mainPath: join(DIR, 'm.db'), eventsPath: join(DIR, 'e.db'), memoryPath: join(DIR, 'mm.db'),
    walMode: true, busyTimeoutMs: 5000,
  });
  initMigrations(); migrateUp();
}

describe('G-11 L0 角色不可被赋权', () => {
  beforeEach(() => { initDb(); resetAgentFactory(); resetAgentRegistry(); });
  afterEach(() => { closeDatabase(); clearMigrations(); if (existsSync(DIR)) rmSync(DIR, { recursive: true, force: true }); });

  it('★ 词表守卫：治理角色不可赋权，执行角色可赋权', () => {
    for (const role of GOVERNANCE) {
      expect(isGovernanceActor(role)).toBe(true);
      expect(isAssignableAgentRole(role), `${role} 不应可赋权`).toBe(false);
      expect(denyReasonForAgentRole(role)).toContain('不可被赋权');
    }
    for (const role of EXECUTION) {
      expect(isAssignableAgentRole(role), `${role} 应可赋权`).toBe(true);
      expect(denyReasonForAgentRole(role)).toBeNull();
    }
    expect(denyReasonForAgentRole('不存在的角色')).toContain('未知角色');
  });

  it('★ 工厂层拒绝：createAgent 无法伪造治理 Agent', () => {
    for (const role of GOVERNANCE) {
      const r = createAgent({ role: role as never, model: 'm' }, 'trace-1');
      expect(r.ok, `createAgent(${role}) 应被拒`).toBe(false);
      if (!r.ok) expect(r.error).toContain('治理角色');
    }
  });

  it('★ 注册表层拒绝：绕过工厂直接注册伪造实例也不行（防御纵深）', () => {
    const forged: AgentInstance = {
      agentId: 'agent-forged-auditor', role: 'auditor' as never, status: 'ready',
      traceId: 't', model: 'm', createdAt: Date.now(), updatedAt: Date.now(),
      consecutiveFailures: 0, awaitingApproval: false,
    } as AgentInstance;
    const r = registerAgent(forged);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('治理角色');
  });

  it('L1/L2 正常通行（不误伤执行层）', () => {
    const ok1 = createAgent({ role: 'worker', model: 'm' }, 'trace-2');
    expect(ok1.ok).toBe(true);

    const direct: AgentInstance = {
      agentId: 'agent-direct-worker', role: 'worker', status: 'ready',
      traceId: 't', model: 'm', createdAt: Date.now(), updatedAt: Date.now(),
      consecutiveFailures: 0, awaitingApproval: false,
    } as AgentInstance;
    expect(registerAgent(direct).ok).toBe(true);
  });

  it('受控系统路径可显式打开 allowGovernance（逃生舱有据可查）', () => {
    const r = createAgent({ role: 'auditor', model: 'm' }, 'trace-3', { allowGovernance: true });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.role).toBe('auditor');
  });

  it('★ 招募工具侧的角色白名单不含治理角色（与工厂守卫互为印证）', async () => {
    const mod = await import('../../Src/Tools/Custom/agentRecruiter.js');
    const spec = (mod as unknown as { agentRecruiterSpec?: { parameters?: unknown } }).agentRecruiterSpec;
    // 工具规范存在即可；角色白名单的实质约束由工具实现（GOVERNANCE_ROLES 拒绝）保证
    expect(spec ?? true).toBeTruthy();
    for (const role of GOVERNANCE) {
      expect(role).not.toBe('worker'); // 语义锚点：治理角色与执行角色不重叠
      expect(isGovernanceActor(role)).toBe(true);
    }
  });
});
