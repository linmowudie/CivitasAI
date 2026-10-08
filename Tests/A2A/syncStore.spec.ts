/**
 * Tests/A2A/syncStore.spec.ts
 *
 * P0c · 本地同步支撑（迁移 v32 + 存储三函数）
 * 不变量：
 *  1. `a2a_messages.synced_at` 列存在（迁移 v32）
 *  2. 新消息默认**未上行**；`markMessagesSynced` 后计数归零（幂等重试安全）
 *  3. `applyPulledMessages` **本机优先**：新消息落库；已存在的**跳过且不覆盖**
 *  4. 拉回的历史消息标记为已同步（不会因为"本地没有"而在下一轮被上行回去）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve, join } from 'node:path';
import { existsSync, rmSync, mkdirSync } from 'node:fs';

import { initDatabase, closeDatabase, getMainDb } from '../../Src/Infra/Db/database.js';
import { initMigrations, clearMigrations, migrateUp } from '../../Src/Infra/Db/migrations.js';
import { setActiveOwner } from '../../Src/Services/AccountScope/activeAccount.js';
import { issueCardForAgent, sendA2A } from '../../Src/Services/A2A/a2aBroker.js';
import {
  applyPulledMessages, countUnsyncedMessages, listMessages, listUnsyncedMessages,
  markMessagesSynced, resetA2aStore, resetStoreProbe,
} from '../../Src/Services/A2A/a2aStore.js';
import type { AgentInstance, AgentRole } from '../../Src/Core/AgentRuntime/types.js';

const DIR = resolve(import.meta.dirname, '../../Data/_test_a2a_syncstore');

function mkAgent(role: AgentRole, agentId: string, over: Partial<AgentInstance> = {}): AgentInstance {
  return {
    agentId, role, status: 'ready', model: 'test-model',
    createdAt: Date.now() - 1000, updatedAt: Date.now(), consecutiveFailures: 0, awaitingApproval: false, ...over,
  };
}

describe('P0c · 本地同步支撑', () => {
  beforeEach(() => {
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
    resetStoreProbe(); resetA2aStore(); setActiveOwner('alice');
    issueCardForAgent(mkAgent('prime_director', 'agent-prime_director-1'), { cardVersion: 1 });
    issueCardForAgent(mkAgent('worker', 'agent-worker-1'), {
      cardVersion: 1, father: { agentId: 'agent-prime_director-1', role: 'prime_director' }, lineage: ['agent-prime_director-1'],
    });
  });
  afterEach(() => { closeDatabase(); clearMigrations(); if (existsSync(DIR)) rmSync(DIR, { recursive: true, force: true }); });

  it('① 迁移 v32：synced_at 列存在', () => {
    const cols = getMainDb().prepare(`PRAGMA table_info(a2a_messages)`).all() as Array<{ name: string }>;
    expect(cols.map(c => c.name)).toContain('synced_at');
  });

  it('② 新消息未上行 → 标记后归零（可重复标记）', () => {
    const sent = sendA2A({
      sourceAgentId: 'agent-worker-1', targetAgentId: 'agent-prime_director-1',
      kind: 'answer', taskId: 't1', payload: { text: '待上行' },
    });
    expect(countUnsyncedMessages()).toBe(1);
    const pending = listUnsyncedMessages(10);
    expect(pending.length).toBe(1);
    expect(pending[0]!.envelope.messageId).toBe(sent.messageId);

    expect(markMessagesSynced([sent.messageId])).toBe(1);
    expect(countUnsyncedMessages()).toBe(0);
    expect(listUnsyncedMessages(10)).toEqual([]);
    expect(markMessagesSynced([sent.messageId])).toBe(1);   // 幂等：仍可再次 UPDATE（不报错）
  });

  it('③ ★ 拉回本机优先：新消息落库；已存在的跳过且**不覆盖本机内容**', () => {
    // 本机已有（本地权威）
    const local = sendA2A({
      sourceAgentId: 'agent-worker-1', targetAgentId: 'agent-prime_director-1',
      kind: 'answer', taskId: 't1', payload: { text: '本机版本' },
    });
    markMessagesSynced([local.messageId]);

    const pulled = applyPulledMessages([
      // 同一 messageId：服务端内容不同 → 必须**跳过**（不覆盖本机）
      { messageId: local.messageId, taskId: 't1', kind: 'answer', sourceAgentId: 'agent-worker-1', targetAgentId: 'agent-prime_director-1', visibility: 'domain', contentHash: 'server-hash', payload: { text: '服务端版本' }, verdict: 'allow', createdAt: 1 },
      // 新消息（仅存在于服务端）→ 落库
      { messageId: 'server-only-1', taskId: 't1', kind: 'notify', sourceAgentId: 'agent-worker-1', targetAgentId: 'agent-prime_director-1', visibility: 'domain', contentHash: 'server-hash-2', payload: { text: '服务端新增' }, verdict: 'allow', createdAt: 2 },
    ]);
    expect(pulled).toEqual({ applied: 1, skipped: 1 });

    const rows = listMessages({ taskId: 't1' });
    const localRow = rows.find(r => r.envelope.messageId === local.messageId)!;
    expect(JSON.stringify(localRow.envelope.payload)).toContain('本机版本');       // ★ 未被覆盖
    expect(rows.some(r => r.envelope.messageId === 'server-only-1')).toBe(true);
  });

  it('④ 拉回的消息标记为已同步（不会下一轮被上行回去）', () => {
    applyPulledMessages([
      { messageId: 'server-only-2', taskId: 't1', kind: 'notify', sourceAgentId: 'a', targetAgentId: 'b', visibility: 'domain', contentHash: 'h', payload: {}, verdict: 'allow', createdAt: 3 },
    ]);
    expect(countUnsyncedMessages()).toBe(0);
  });

  it('⑤ 属主隔离：换属主后看不到待上行消息', () => {
    sendA2A({ sourceAgentId: 'agent-worker-1', targetAgentId: 'agent-prime_director-1', kind: 'answer', taskId: 't1', payload: { text: 'x' } });
    expect(countUnsyncedMessages()).toBe(1);
    setActiveOwner('bob');
    expect(countUnsyncedMessages()).toBe(0);
    expect(listUnsyncedMessages(10)).toEqual([]);
  });
});
