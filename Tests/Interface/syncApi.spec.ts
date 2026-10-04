/**
 * 本地统计派生（账号同步用）
 *
 * `deriveStatsEvents()` 从本地库派生三类可上行事件：
 *   chat.turn（助手消息）/ token.consumed（交易流水）/ tool.call（副作用日志）
 * 口径与幂等键必须稳定，否则重复上报会污染云端统计。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join, resolve } from 'node:path';
import { existsSync, mkdirSync, rmSync } from 'node:fs';

import { initDatabase, closeDatabase, getMainDb } from '../../Src/Infra/Db/database.js';
import { initMigrations, migrateUp, clearMigrations } from '../../Src/Infra/Db/migrations.js';
import { deriveStatsEvents } from '../../Src/Interface/RestApi/syncApi.js';

const TEST_DB_DIR = join(resolve(import.meta.dirname, '..', '..'), 'Data', '_test_syncstats');

function initTestDb(): void {
  closeDatabase();
  if (existsSync(TEST_DB_DIR)) rmSync(TEST_DB_DIR, { recursive: true, force: true });
  clearMigrations();
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
  // 派生测试关注"读"逻辑，父表行不必要 → 关闭外键约束避免构造无关数据
  getMainDb().pragma('foreign_keys = OFF');
}

function cleanupDb(): void {
  closeDatabase();
  clearMigrations();
  if (existsSync(TEST_DB_DIR)) rmSync(TEST_DB_DIR, { recursive: true, force: true });
}

/** 写入一条助手/用户消息 */
function insertMessage(params: { id: string; role: string; at: number; model?: string }): void {
  getMainDb().prepare(
    `INSERT INTO chat_messages (message_id, session_id, role, content, model, created_at)
     VALUES (?, 'sess-1', ?, '内容', ?, ?)`,
  ).run(params.id, params.role, params.model ?? null, params.at);
}

function insertWallet(walletId: string): void {
  getMainDb().prepare(
    `INSERT INTO token_wallets (wallet_id, agent_id, balance, created_at, updated_at)
     VALUES (?, 'agent-1', 0, 0, 0)`,
  ).run(walletId);
}

function insertTransaction(params: { id: string; amount: number; at: number; type?: string }): void {
  getMainDb().prepare(
    `INSERT INTO token_transactions (transaction_id, wallet_id, type, amount, balance_after, created_at)
     VALUES (?, 'w1', ?, ?, 0, ?)`,
  ).run(params.id, params.type ?? 'consume', params.amount, params.at);
}

function insertEffect(params: { id: string; kind: string; at: number; status?: string; toolCallId?: string }): void {
  getMainDb().prepare(
    `INSERT INTO effect_journal (effect_id, loop_id, iteration, kind, idempotency_key, payload_hash, status, started_at, timeout_ms, tool_call_id)
     VALUES (?, 'loop-1', 1, ?, ?, 'hash', ?, ?, 1000, ?)`,
  ).run(params.id, params.kind, `key-${params.id}`, params.status ?? 'SUCCEEDED', params.at, params.toolCallId ?? null);
}

/** 写入一条工具调用结果事件（ai_events，FE-027 的统计主源） */
function insertToolEvent(params: {
  id: string; toolCallId: string; toolName: string; at: number; status?: string;
}): void {
  getMainDb().prepare(
    `INSERT INTO ai_events (event_id, session_id, owner_user_id, type, data_json, ts, seq)
     VALUES (?, NULL, 'local', 'agent:tool_call_result', ?, ?, NULL)`,
  ).run(
    params.id,
    JSON.stringify({
      toolCallId: params.toolCallId,
      toolName: params.toolName,
      status: params.status ?? 'success',
      iteration: 1,
    }),
    params.at,
  );
}

describe('本地统计派生 deriveStatsEvents', () => {
  beforeEach(() => {
    initTestDb();
  });
  afterEach(() => {
    cleanupDb();
  });

  it('只统计助手消息（用户消息不计入），幂等键为 msg:<id>', () => {
    insertMessage({ id: 'm1', role: 'user', at: 1000 });
    insertMessage({ id: 'm2', role: 'assistant', at: 2000, model: 'GLM-5.1' });
    insertMessage({ id: 'm3', role: 'assistant', at: 3000 });

    const result = deriveStatsEvents(0, 500, 10_000);
    const turns = result.events.filter((e) => e.kind === 'chat.turn');
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ value: 1, occurredAt: 2000, clientEventId: 'msg:m2', meta: { model: 'GLM-5.1' } });
    expect(turns[1]?.clientEventId).toBe('msg:m3');
    expect(result.counts.chatTurn).toBe(2);
  });

  it('Token 消耗取流水绝对值，幂等键为 tx:<id>', () => {
    insertWallet('w1');
    insertTransaction({ id: 't1', amount: -120, at: 1500 });
    insertTransaction({ id: 't2', amount: 80, at: 2500, type: 'earn' });

    const result = deriveStatsEvents(0, 500, 10_000);
    const tokens = result.events.filter((e) => e.kind === 'token.consumed');
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).toMatchObject({ value: 120, occurredAt: 1500, clientEventId: 'tx:t1', meta: { type: 'consume' } });
    expect(tokens[1]).toMatchObject({ value: 80, clientEventId: 'tx:t2' });
  });

  it('工具调用来自副作用日志，幂等键为 eff:<id>', () => {
    insertEffect({ id: 'e1', kind: 'shell.exec', at: 1700 });
    insertEffect({ id: 'e2', kind: 'file.write', at: 2700, status: 'FAILED' });

    const result = deriveStatsEvents(0, 500, 10_000);
    const calls = result.events.filter((e) => e.kind === 'tool.call');
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      value: 1,
      occurredAt: 1700,
      clientEventId: 'eff:e1',
      meta: { effectKind: 'shell.exec', status: 'SUCCEEDED' },
    });
  });

  // ── FE-027：工具调用全量覆盖 + 与副作用日志配对（不重复计数）──────────

  it('★ FE-027：安全只读工具（无副作用记录）现在也计入，幂等键为 tool:<event_id>', () => {
    // 安全工具只有工具调用事件，没有 effect_journal 记录（这是此前的口径缺口）
    insertToolEvent({ id: 'ev-1', toolCallId: 'call_aaa', toolName: 'dir.list', at: 1500, status: 'success' });

    const result = deriveStatsEvents(0, 500, 10_000);
    const calls = result.events.filter((e) => e.kind === 'tool.call');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      value: 1,
      occurredAt: 1500,
      clientEventId: 'tool:ev-1',
      meta: { toolName: 'dir.list', status: 'success', source: 'event' },
    });
    expect(result.counts.toolCall).toBe(1);
  });

  it('★ FE-027：同一次危险工具调用同时有事件与副作用记录时，沿用历史键 eff:<id> 且只计一次', () => {
    // 同一个 toolCallId：事件 + effect（新数据带 tool_call_id → 精确配对）
    insertEffect({ id: 'e-pair', kind: 'shell.exec', at: 2000, toolCallId: 'call_bbb' });
    insertToolEvent({ id: 'ev-2', toolCallId: 'call_bbb', toolName: 'shell.exec', at: 2010, status: 'success' });

    const result = deriveStatsEvents(0, 500, 10_000);
    const calls = result.events.filter((e) => e.kind === 'tool.call');
    expect(calls).toHaveLength(1); // 不重复计数
    expect(calls[0]!.clientEventId).toBe('eff:e-pair'); // 键保持不变 → 全量重传也不会重复
    expect(result.counts.toolCall).toBe(1);
  });

  it('★ FE-027：旧数据（effect 无 tool_call_id）按时间近似配对，同样只计一次', () => {
    insertEffect({ id: 'e-legacy', kind: 'shell.exec', at: 3000 }); // 无 toolCallId（历史数据）
    insertToolEvent({ id: 'ev-3', toolCallId: 'call_ccc', toolName: 'shell.exec', at: 3020, status: 'success' });

    const result = deriveStatsEvents(0, 500, 10_000);
    const calls = result.events.filter((e) => e.kind === 'tool.call');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.clientEventId).toBe('eff:e-legacy');
  });

  it('★ FE-027：有事件但无配对 effect 的调用与仅有 effect 的旧调用可并存，互不吞并', () => {
    // 两者相隔远超配对窗口（180s），因此不会被误配成同一次调用
    insertEffect({ id: 'e-only', kind: 'shell.exec', at: 500 });                                // 事件持久化之前的老数据
    insertToolEvent({ id: 'ev-4', toolCallId: 'call_ddd', toolName: 'file.read', at: 300_000, status: 'success' });

    const result = deriveStatsEvents(0, 500, 400_000);
    const keys = result.events.filter((e) => e.kind === 'tool.call').map((e) => e.clientEventId).sort();
    expect(keys).toEqual(['eff:e-only', 'tool:ev-4']);
    expect(result.counts.toolCall).toBe(2);
  });

  it('★ FE-027：幂等键在重复派生时保持稳定（同一次调用两次派生得到同一组键）', () => {
    insertEffect({ id: 'e-s1', kind: 'shell.exec', at: 1000, toolCallId: 'call_e1' });
    insertToolEvent({ id: 'ev-5', toolCallId: 'call_e1', toolName: 'shell.exec', at: 1010, status: 'success' });
    insertToolEvent({ id: 'ev-6', toolCallId: 'call_e2', toolName: 'dir.list', at: 1200, status: 'success' });

    const first = deriveStatsEvents(0, 500, 10_000).events.filter((e) => e.kind === 'tool.call').map((e) => e.clientEventId).sort();
    const second = deriveStatsEvents(0, 500, 10_000).events.filter((e) => e.kind === 'tool.call').map((e) => e.clientEventId).sort();
    expect(first).toEqual(second);
    expect(first).toEqual(['eff:e-s1', 'tool:ev-6']);
  });

  it('三类合并后按时间升序，且 since 过滤、nextSince 指向本批最后一条', () => {
    insertMessage({ id: 'm1', role: 'assistant', at: 3000 });
    insertWallet('w1');
    insertTransaction({ id: 't1', amount: 10, at: 1000 });
    insertEffect({ id: 'e1', kind: 'shell.exec', at: 2000 });

    const result = deriveStatsEvents(0, 500, 10_000);
    expect(result.events.map((e) => e.occurredAt)).toEqual([1000, 2000, 3000]);
    expect(result.nextSince).toBe(3000);

    const after = deriveStatsEvents(1000, 500, 10_000);
    expect(after.events.map((e) => e.occurredAt)).toEqual([2000, 3000]);
    expect(after.since).toBe(1000);
  });

  it('limit 截断时 truncated=true（客户端可带 nextSince 续拉）', () => {
    for (let i = 1; i <= 5; i++) insertMessage({ id: `m${i}`, role: 'assistant', at: i * 1000 });

    const result = deriveStatsEvents(0, 3, 10_000);
    expect(result.events).toHaveLength(3);
    expect(result.truncated).toBe(true);
    expect(result.nextSince).toBe(3000);
  });

  it('未来时间（> now）不计入，避免未同步数据被提前上报', () => {
    insertMessage({ id: 'future', role: 'assistant', at: 99_000 });
    const result = deriveStatsEvents(0, 500, 10_000);
    expect(result.events).toHaveLength(0);
  });

  it('空库返回空结果（不抛错）', () => {
    const result = deriveStatsEvents(0, 500, 10_000);
    expect(result.events).toHaveLength(0);
    expect(result.counts).toEqual({ chatTurn: 0, tokenConsumed: 0, toolCall: 0 });
    expect(result.truncated).toBe(false);
  });

  it('数据库未初始化时优雅降级为空结果', () => {
    cleanupDb();
    const result = deriveStatsEvents(0, 500, 10_000);
    expect(result.events).toHaveLength(0);
    expect(result.nextSince).toBe(0);
  });
});
