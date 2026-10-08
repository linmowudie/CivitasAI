/**
 * Tests/A2A/cardSync.spec.ts
 *
 * P0a · 注册表 ↔ 卡片同步（设计 §18 #2/#3）
 * 不变量：
 *  1. 注册即签发卡片（含 `father/lineage`，来自**正式字段**）
 *  2. 父关系变化 → 卡片重签且父信息落进卡片（否则 L2→L1 会被越级规则拒）
 *  3. 状态变化 → **只同步运行态**（指纹不变、版本不升）
 *  4. 注销 → 卡片标记 `destroyed`（行保留，可审计）
 *  5. 回灌对账：缺卡补签、幽灵卡标记销毁
 *  6. 卸载钩子后不再自动签发
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve, join } from 'node:path';
import { existsSync, rmSync, mkdirSync } from 'node:fs';

import { initDatabase, closeDatabase } from '../../Src/Infra/Db/database.js';
import { initMigrations, clearMigrations, migrateUp } from '../../Src/Infra/Db/migrations.js';
import { setActiveOwner } from '../../Src/Services/AccountScope/activeAccount.js';
import {
  registerAgent, setAgentParent, updateAgentStatus, unregisterAgent, resetAgentRegistry, getAgent,
} from '../../Src/Core/AgentRuntime/agentRegistry.js';
import {
  attachAgentCardSync, detachAgentCardSync, reconcileAgentCards, resolveFather,
} from '../../Src/Services/A2A/cardSync.js';
import { listCards, loadCard, resetA2aStore, resetStoreProbe } from '../../Src/Services/A2A/a2aStore.js';
import type { AgentInstance, AgentRole } from '../../Src/Core/AgentRuntime/types.js';

const DIR = resolve(import.meta.dirname, '../../Data/_test_a2a_cardsync');

function initDb(): void {
  closeDatabase(); clearMigrations();
  if (existsSync(DIR)) rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  initDatabase({
    mainPath: join(DIR, 'm.db'), eventsPath: join(DIR, 'e.db'), memoryPath: join(DIR, 'mm.db'),
    walMode: true, busyTimeoutMs: 5000,
  });
  initMigrations();
  const up = migrateUp();
  expect(up.ok, up.ok ? '' : String(up.error)).toBe(true);
  resetStoreProbe(); resetA2aStore(); setActiveOwner('alice'); resetAgentRegistry();
}

function mkAgent(role: AgentRole, over: Partial<AgentInstance> = {}): AgentInstance {
  return {
    agentId: `agent-${role}-1`, role, status: 'ready', model: 'test-model',
    createdAt: Date.now() - 1000, updatedAt: Date.now(), consecutiveFailures: 0, awaitingApproval: false,
    ...over,
  };
}

describe('P0a · 注册表 ↔ 卡片同步', () => {
  beforeEach(() => { initDb(); attachAgentCardSync(); });
  afterEach(() => {
    detachAgentCardSync(); closeDatabase(); clearMigrations();
    if (existsSync(DIR)) rmSync(DIR, { recursive: true, force: true });
  });

  it('① 注册即签发卡片（初始无父）', () => {
    expect(registerAgent(mkAgent('worker')).ok).toBe(true);
    const card = loadCard('agent-worker-1');
    expect(card).not.toBeNull();
    expect(card!.permission.tier).toBe('L2');
    expect(card!.father).toBeNull();
    expect(card!.status).toBe('ready');
  });

  it('② 设置父关系 → 卡片重签并带上父信息（版本自动 +1）', () => {
    registerAgent(mkAgent('prime_director'));
    registerAgent(mkAgent('worker'));
    const before = loadCard('agent-worker-1')!;
    setAgentParent('agent-worker-1', 'agent-prime_director-1');

    const after = loadCard('agent-worker-1')!;
    expect(after.father).toEqual({ agentId: 'agent-prime_director-1', role: 'prime_director' });
    expect(after.lineage).toContain('agent-prime_director-1');
    expect(after.cardVersion).toBe(before.cardVersion + 1);   // father 属签发语义内容
    // 正式字段已写入实例（§18 #3）
    expect(getAgent('agent-worker-1')!.father).toEqual({ agentId: 'agent-prime_director-1', role: 'prime_director' });
    expect(resolveFather(getAgent('agent-worker-1')!)).toEqual({ agentId: 'agent-prime_director-1', role: 'prime_director' });
  });

  it('③ 状态变化 → 只同步运行态（指纹不变、版本不升）', () => {
    registerAgent(mkAgent('worker'));
    const before = loadCard('agent-worker-1')!;
    updateAgentStatus('agent-worker-1', 'running');
    const after = loadCard('agent-worker-1')!;
    expect(after.status).toBe('running');
    expect(after.fingerprint).toBe(before.fingerprint);
    expect(after.cardVersion).toBe(before.cardVersion);

    updateAgentStatus('agent-worker-1', 'suspended');
    expect(loadCard('agent-worker-1')!.status).toBe('suspended');
  });

  it('④ 注销 → 卡片标记 destroyed（不删行）', () => {
    registerAgent(mkAgent('worker'));
    expect(unregisterAgent('agent-worker-1').ok).toBe(true);
    const card = loadCard('agent-worker-1');
    expect(card!.status).toBe('destroyed');
    expect(listCards({ limit: 10 }).some(c => c.agentId === 'agent-worker-1')).toBe(true);
  });

  it('⑤ 回灌对账：缺卡补签；实例已消失的卡标记销毁', () => {
    detachAgentCardSync();
    registerAgent(mkAgent('worker'));          // 无钩子 → 不签发
    registerAgent(mkAgent('reviewer'));
    expect(loadCard('agent-worker-1')).toBeNull();
    // 制造"幽灵卡"：先签发再移除实例
    attachAgentCardSync();
    const stats1 = reconcileAgentCards();
    expect(stats1.issued).toBe(2);
    expect(loadCard('agent-reviewer-1')).not.toBeNull();

    unregisterAgent('agent-reviewer-1');       // 钩子会标记 destroyed
    const stats2 = reconcileAgentCards();
    expect(stats2.destroyed).toBe(0);          // 已被钩子处理
    expect(loadCard('agent-reviewer-1')!.status).toBe('destroyed');
  });

  it('⑥ 卸载钩子后不再自动签发', () => {
    detachAgentCardSync();
    registerAgent(mkAgent('worker'));
    expect(loadCard('agent-worker-1')).toBeNull();
  });
});
