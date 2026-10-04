/**
 * FE-052：agentFactory / agentRegistry 角色提示词装载测试。
 *
 * 覆盖：装载注册表后 createAgent 携带角色提示词并**写透落库**（agents.system_prompt，
 *       此前该列无任何写入方）；显式传入优先；未装载时 undefined（向后兼容）；
 *       招募链路（recruiter）落库。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve, join } from 'node:path';
import { existsSync, rmSync, mkdirSync } from 'node:fs';

import { initDatabase, closeDatabase, getMainDb } from '../../Src/Infra/Db/database.js';
import { initMigrations, clearMigrations, migrateUp } from '../../Src/Infra/Db/migrations.js';
import { setActiveOwner, LOCAL_OWNER } from '../../Src/Services/AccountScope/activeAccount.js';
import { createAgent, resetAgentFactory } from '../../Src/Core/AgentRuntime/agentFactory.js';
import { resetAgentRegistry, getAgent } from '../../Src/Core/AgentRuntime/agentRegistry.js';
import { recruitAgent } from '../../Src/Services/Recruitment/recruiter.js';
import { loadRolePrompts, resetRolePrompts } from '../../Src/Services/Prompts/promptRegistry.js';

const TEST_DB_DIR = resolve(import.meta.dirname, '../../.tmp/test-db-prompt-factory');

function initTestDb(): void {
  closeDatabase();
  clearMigrations();
  if (existsSync(TEST_DB_DIR)) rmSync(TEST_DB_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DB_DIR, { recursive: true });
  const result = initDatabase({
    mainPath: join(TEST_DB_DIR, 'test_main.db'),
    eventsPath: join(TEST_DB_DIR, 'test_events.db'),
    memoryPath: join(TEST_DB_DIR, 'test_memory.db'),
    walMode: true,
    busyTimeoutMs: 5000,
  });
  expect(result.ok).toBe(true);
  initMigrations();
  migrateUp();
  setActiveOwner(LOCAL_OWNER);
}

function agentRow(agentId: string): Record<string, unknown> {
  return getMainDb().prepare('SELECT * FROM agents WHERE agent_id = ?').get(agentId) as Record<string, unknown>;
}

describe('FE-052 · agentFactory 角色提示词装载', () => {
  beforeEach(() => {
    initTestDb();
    resetAgentRegistry();
    resetAgentFactory();
    resetRolePrompts();
  });

  afterEach(() => {
    closeDatabase();
    clearMigrations();
    if (existsSync(TEST_DB_DIR)) rmSync(TEST_DB_DIR, { recursive: true, force: true });
    resetRolePrompts();
  });

  it('装载注册表后：createAgent 自动携带角色提示词并写透落库', () => {
    loadRolePrompts();
    const r = createAgent({ role: 'worker', model: 'test-model' }, 'trace-1');
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // 内存实例
    expect(r.value.systemPrompt).toBeTruthy();
    expect(r.value.systemPrompt).toContain('Worker');

    // 落库（registerAgent 写透；此前 system_prompt 无任何写入方）
    const row = agentRow(r.value.agentId);
    expect(row).toBeTruthy();
    expect(String(row['system_prompt'])).toContain('Worker');

    // hydrateAgents 回读的内存视图一致
    expect(getAgent(r.value.agentId)?.systemPrompt).toContain('Worker');
  });

  it('显式传入 systemPrompt 优先于注册表', () => {
    loadRolePrompts();
    const r = createAgent({ role: 'worker', model: 'test-model', systemPrompt: '自定义提示词' }, 'trace-1');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.systemPrompt).toBe('自定义提示词');
  });

  it('未装载时 → undefined（行为与修复前一致，不破坏既有调用方）', () => {
    const r = createAgent({ role: 'worker', model: 'test-model' }, 'trace-1');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.systemPrompt).toBeUndefined();
    // 落库为空串（与修复前一致）
    expect(String(agentRow(r.value.agentId)['system_prompt'])).toBe('');
  });

  it('招募链路：agents.system_prompt 落库（recruiter 显式透传）', () => {
    loadRolePrompts();
    const parent = createAgent({ role: 'prime_director', model: 'test-model' }, 'trace-1');
    expect(parent.ok).toBe(true);
    if (!parent.ok) return;

    const recruited = recruitAgent({
      role: 'worker', domain: 'general', taskPrompt: '统计目录',
      requiredTools: [], tokenBudget: 5_000, maxIterations: 5, timeLimitMs: 60_000,
      traceId: 'trace-1', parentAgentId: parent.value.agentId,
    });
    expect(recruited.ok).toBe(true);
    if (!recruited.ok) return;

    const row = agentRow(recruited.value.agentId);
    expect(row).toBeTruthy();
    expect(String(row['system_prompt'])).toContain('Worker');
  });
});
