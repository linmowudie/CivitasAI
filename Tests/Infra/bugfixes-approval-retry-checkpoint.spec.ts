/**
 * 修复验证（2026-10-04）：三处代码级缺陷
 *
 * ① 审批红线：CRITICAL 双角色必须由**不同身份**满足（同一人换角色名不得自批）
 * ② 合法重试：`effect_journal` 唯一约束不再拒绝"失败后的重试"，但成功/进行中仍 fail-closed
 * ③ 迭代快照：`createCheckpoint` 有运行期调用方（修复前全仓无调用）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve, join } from 'node:path';
import { existsSync, rmSync, mkdirSync } from 'node:fs';

import { initDatabase, closeDatabase, getMainDb } from '../../Src/Infra/Db/database.js';
import { initMigrations, clearMigrations, migrateUp } from '../../Src/Infra/Db/migrations.js';
import { rolesSatisfiedByDistinctIdentities } from '../../Src/Services/LoopControl/approvalGate.js';
import { recordIntent, updateEffectStatus, getUnknownEffects } from '../../Src/Infra/DurableExecution/effectJournal.js';
import { writeIterationCheckpoint } from '../../Src/Infra/DurableExecution/iterationCheckpoint.js';
import { loadLatestCheckpoint, listCheckpoints } from '../../Src/Infra/DurableExecution/checkpointStore.js';

const TEST_DB_DIR = resolve(import.meta.dirname, '../../.tmp/test-db-bugfixes');

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
}

beforeEach(() => initTestDb());
afterEach(() => {
  closeDatabase();
  clearMigrations();
  if (existsSync(TEST_DB_DIR)) rmSync(TEST_DB_DIR, { recursive: true, force: true });
});

// ── ① 审批身份级去重 ────────────────────────────────────────────────

describe('① 审批：必需角色须由不同身份分别满足', () => {
  const ROLES = ['user', 'prime_director'];

  it('★ 同一人换角色名自报 → 不满足（修复前会被判定通过）', () => {
    expect(rolesSatisfiedByDistinctIdentities(ROLES, ['user:alice', 'prime_director:alice'])).toBe(false);
  });

  it('两个不同身份分别确认 → 满足', () => {
    expect(rolesSatisfiedByDistinctIdentities(ROLES, ['user:alice', 'prime_director:bob'])).toBe(true);
    expect(rolesSatisfiedByDistinctIdentities(ROLES, ['prime_director:bob', 'user:alice'])).toBe(true);
  });

  it('缺少任一必需角色 → 不满足', () => {
    expect(rolesSatisfiedByDistinctIdentities(ROLES, ['user:alice'])).toBe(false);
    expect(rolesSatisfiedByDistinctIdentities(ROLES, ['prime_director:bob'])).toBe(false);
  });

  it('单角色策略：一个身份即可满足（不误伤普通审批）', () => {
    expect(rolesSatisfiedByDistinctIdentities(['user'], ['user:alice'])).toBe(true);
  });

  it('无冒号的旧格式条目按"角色=身份"处理', () => {
    // 旧格式 ['user', 'prime_director']：身份名与角色名相同 → 两个不同身份 → 满足
    expect(rolesSatisfiedByDistinctIdentities(ROLES, ['user', 'prime_director'])).toBe(true);
    // 同一身份重复提交只算一次
    expect(rolesSatisfiedByDistinctIdentities(['user', 'auditor'], ['user', 'user'])).toBe(false);
  });

  it('三人场景：a 同时占了两个角色，但 b 能顶上 → 满足（匹配而非简单去重）', () => {
    expect(rolesSatisfiedByDistinctIdentities(
      ['user', 'auditor', 'prime_director'],
      ['user:alice', 'auditor:alice', 'prime_director:bob', 'auditor:carol'],
    )).toBe(true);
  });
});

// ── ② 幂等键：合法重试 ──────────────────────────────────────────────

describe('② 副作用日志：失败可重试、成功/进行中仍 fail-closed', () => {
  const base = {
    loopId: 'loop-sess-test-1',
    iteration: 1,
    kind: 'tool_execute' as const,
    idempotencyKey: 'same-key-after-failure',
    payloadHash: 'hash-1',
    toolCallId: 'call_1',
  };

  it('★ 首次 INTENT 后标记 FAILED → 同键重试应被允许（修复前一律拒绝）', () => {
    const first = recordIntent({ ...base, effectId: 'eff-1' });
    expect(first.ok).toBe(true);
    updateEffectStatus({ effectId: 'eff-1', status: 'FAILED', errorClass: 'retryable', completedAt: Date.now() });

    const retry = recordIntent({ ...base, effectId: 'eff-2' });
    expect(retry.ok).toBe(true);
    if (retry.ok) {
      // 复用同一行（effect_id 不变），避免出现"同一调用两条记录"
      expect(retry.value.effectId).toBe('eff-1');
      expect(retry.value.status).toBe('INTENT');
    }
    const rows = getMainDb().prepare('SELECT COUNT(*) AS n FROM effect_journal WHERE idempotency_key = ?')
      .get(base.idempotencyKey) as { n: number };
    expect(rows.n).toBe(1);
  });

  it('★ 已 SUCCEEDED 的调用再次提交 → 拒绝（防重复副作用）', () => {
    recordIntent({ ...base, effectId: 'eff-ok' });
    updateEffectStatus({ effectId: 'eff-ok', status: 'SUCCEEDED', result: { ok: true }, completedAt: Date.now() });

    const again = recordIntent({ ...base, effectId: 'eff-ok-2' });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error).toContain('已成功执行过');
  });

  it('★ 进行中（未超时）的重复提交 → 拒绝（防并发重复执行）', () => {
    recordIntent({ ...base, effectId: 'eff-running', timeoutMs: 60_000 });
    const again = recordIntent({ ...base, effectId: 'eff-running-2' });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error).toContain('正在执行中');
  });

  it('★ 陈旧进行中（超过 timeout_ms）→ 允许重试（崩溃后恢复场景）', () => {
    // 手工把 started_at 改到很久以前，模拟"进程崩溃留下的悬挂 INTENT"
    recordIntent({ ...base, effectId: 'eff-stale', timeoutMs: 1_000 });
    getMainDb().prepare('UPDATE effect_journal SET started_at = ? WHERE effect_id = ?')
      .run(Date.now() - 60_000, 'eff-stale');

    const retry = recordIntent({ ...base, effectId: 'eff-stale-2', timeoutMs: 1_000 });
    expect(retry.ok).toBe(true);
    if (retry.ok) expect(retry.value.effectId).toBe('eff-stale');
  });

  it('UNKNOWN 状态（崩溃无法判定）→ 允许重试', () => {
    recordIntent({ ...base, effectId: 'eff-unknown' });
    updateEffectStatus({ effectId: 'eff-unknown', status: 'UNKNOWN', completedAt: Date.now() });
    const retry = recordIntent({ ...base, effectId: 'eff-unknown-2' });
    expect(retry.ok).toBe(true);
  });

  it('不同幂等键互不影响（正常并行调用不被误伤）', () => {
    const a = recordIntent({ ...base, effectId: 'eff-a', idempotencyKey: 'key-a' });
    const b = recordIntent({ ...base, effectId: 'eff-b', idempotencyKey: 'key-b' });
    expect(a.ok && b.ok).toBe(true);
  });
});

// ── ③ 迭代快照运行期写入 ────────────────────────────────────────────

describe('③ 迭代快照：运行期真实写入并可被恢复链路读取', () => {
  it('★ writeIterationCheckpoint 写入后 loadLatestCheckpoint 能读到（修复前无调用方/永远为空）', () => {
    const ok = writeIterationCheckpoint({
      loopId: 'loop-sess-cp-1',
      iteration: 1,
      decision: 'continue',
      completedSteps: 1,
      failedAttempts: 0,
      toolNames: ['dir.list'],
      nextStepHint: '继续第 2 轮',
    });
    expect(ok).toBe(true);

    const latest = loadLatestCheckpoint('loop-sess-cp-1');
    expect(latest.ok).toBe(true);
    if (latest.ok) {
      expect(latest.value).toBeTruthy();
      expect(latest.value!.iteration).toBe(1);
      expect(latest.value!.nextStepHint).toBe('继续第 2 轮');
      expect((latest.value!.stateSnapshot as Record<string, unknown>)['toolNames']).toEqual(['dir.list']);
    }
  });

  it('多轮快照按 iteration 递增，取最新一份', () => {
    for (const it of [1, 2, 3]) {
      writeIterationCheckpoint({
        loopId: 'loop-sess-cp-2', iteration: it, decision: 'continue',
        completedSteps: it, failedAttempts: 0,
      });
    }
    const list = listCheckpoints('loop-sess-cp-2', 10);
    expect(list.ok).toBe(true);
    if (list.ok) expect(list.value.length).toBe(3);
    const latest = loadLatestCheckpoint('loop-sess-cp-2');
    if (latest.ok) expect(latest.value!.iteration).toBe(3);
  });

  it('写入未完成副作用列表（恢复时需要续跑/裁决）', () => {
    recordIntent({
      effectId: 'eff-pending', loopId: 'loop-sess-cp-3', iteration: 1,
      kind: 'tool_execute', idempotencyKey: 'k-pending', payloadHash: 'h',
    });
    updateEffectStatus({ effectId: 'eff-pending', status: 'UNKNOWN', completedAt: Date.now() });
    const unknown = getUnknownEffects('loop-sess-cp-3');
    expect(unknown.ok).toBe(true);
    const ids = unknown.ok ? unknown.value.map(e => e.effectId) : [];

    writeIterationCheckpoint({
      loopId: 'loop-sess-cp-3', iteration: 1, decision: 'continue',
      completedSteps: 1, failedAttempts: 0,
      pendingEffects: ids.map(id => ({ effectId: id })),
    });
    const latest = loadLatestCheckpoint('loop-sess-cp-3');
    if (latest.ok) expect(latest.value!.pendingEffects).toContain('eff-pending');
  });

  it('loopId 隔离：不同 loop 的快照互不串', () => {
    writeIterationCheckpoint({ loopId: 'loop-A', iteration: 1, decision: 'continue', completedSteps: 1, failedAttempts: 0 });
    writeIterationCheckpoint({ loopId: 'loop-B', iteration: 7, decision: 'continue', completedSteps: 7, failedAttempts: 0 });
    const a = loadLatestCheckpoint('loop-A');
    const b = loadLatestCheckpoint('loop-B');
    if (a.ok) expect(a.value!.iteration).toBe(1);
    if (b.ok) expect(b.value!.iteration).toBe(7);
  });
});
