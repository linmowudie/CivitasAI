/**
 * S2 Infra/DurableExecution 模块测试
 *
 * 覆盖：effectJournal / checkpointStore / idempotencyStore / recoveryScanner / recoveryExecutor
 * Gate G2：DUR-003 / DUR-005 / DUR-006
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve, join } from 'node:path';
import { existsSync, rmSync, mkdirSync } from 'node:fs';

import { initDatabase, closeDatabase, getMainDb } from '../../Src/Infra/Db/database.js';
import { initMigrations, migrateUp, clearMigrations } from '../../Src/Infra/Db/migrations.js';

import {
  initEffectJournal, hashPayload, recordIntent, markExecuting, markSucceeded, markFailed,
  resolveTimedOutEffects, getUnknownEffects, getPendingEffects, findByIdepotencyKey, getPendingCount,
} from '../../Src/Infra/DurableExecution/effectJournal.js';
import {
  createCheckpoint, loadLatestCheckpoint, loadCheckpoint, listCheckpoints, pruneCheckpoints,
} from '../../Src/Infra/DurableExecution/checkpointStore.js';
import {
  initIdempotencyStore, makeIdempotencyKey, lookup, store, purgeExpired, getCacheSize,
} from '../../Src/Infra/DurableExecution/idempotencyStore.js';
import {
  initRecoveryScanner, scanAndProposeRecovery, getHumanRequiredPlans, getAutoResumePlans,
} from '../../Src/Infra/DurableExecution/recoveryScanner.js';
import {
  executeRecovery, resume, validateRecoveryPlan,
} from '../../Src/Infra/DurableExecution/recoveryExecutor.js';

const ROOT = resolve(import.meta.dirname, '..', '..');
const TEST_DB_DIR = join(ROOT, 'Data', '_test_durable');

function cleanup(): void {
  closeDatabase();
  if (existsSync(TEST_DB_DIR)) {
    rmSync(TEST_DB_DIR, { recursive: true, force: true });
  }
  clearMigrations();
}

function initTestDb(): void {
  cleanup();
  mkdirSync(TEST_DB_DIR, { recursive: true });
  const result = initDatabase({
    mainPath: join(TEST_DB_DIR, 'test_main.db'),
    eventsPath: join(TEST_DB_DIR, 'test_events.db'),
    memoryPath: join(TEST_DB_DIR, 'test_memory.db'),
    walMode: true,
    busyTimeoutMs: 5000,
  });
  expect(result.ok).toBe(true);
  const migResult = initMigrations();
  expect(migResult.ok).toBe(true);
  const migUp = migrateUp();
  expect(migUp.ok).toBe(true);
}

/** 插入测试用 loop 行（effect_journal 和 checkpoints 依赖 loops 表） */
function insertTestLoop(loopId: string = 'loop-1'): void {
  const db = getMainDb();
  db.prepare(`
    INSERT INTO loops (loop_id, trace_id, session_key, agent_id, task_id,
      goal_json, state_json, phase, created_at, updated_at)
    VALUES (?, 'trace-1', 'sess-1', 'agent-1', 'task-1', '{}', '{}', 'acting', ?, ?)
  `).run(loopId, Date.now(), Date.now());
}

describe('S2 DurableExecution 模块', () => {
  afterEach(() => { cleanup(); });

  // ===== Effect Journal =====
  describe('effectJournal', () => {
    beforeEach(() => {
      initTestDb();
      initEffectJournal({ defaultTimeoutMs: 30000 });
      insertTestLoop();
    });

    it('recordIntent 写入 INTENT 记录', () => {
      const result = recordIntent({
        effectId: 'eff-1', loopId: 'loop-1', iteration: 1,
        kind: 'tool_execute', idempotencyKey: 'idem-1',
        payloadHash: hashPayload({ tool: 'read' }),
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.status).toBe('INTENT');
        expect(result.value.timeoutMs).toBe(30000);
      }
    });

    it('状态流转 INTENT → EXECUTING → SUCCEEDED', () => {
      recordIntent({
        effectId: 'eff-2', loopId: 'loop-1', iteration: 1,
        kind: 'file_write', idempotencyKey: 'idem-2',
        payloadHash: 'hash2',
      });
      markExecuting('eff-2');
      markSucceeded('eff-2', { written: true });

      const pending = getPendingEffects('loop-1');
      expect(pending.ok).toBe(true);
      if (pending.ok) {
        expect(pending.value.length).toBe(0); // 已完成不在 pending 中
      }
    });

    it('状态流转 INTENT → EXECUTING → FAILED', () => {
      recordIntent({
        effectId: 'eff-3', loopId: 'loop-1', iteration: 1,
        kind: 'http_call', idempotencyKey: 'idem-3',
        payloadHash: 'hash3',
      });
      markExecuting('eff-3');
      markFailed('eff-3', 'retryable', { error: 'timeout' });

      const unknowns = getUnknownEffects('loop-1');
      expect(unknowns.ok).toBe(true);
      if (unknowns.ok) {
        expect(unknowns.value.length).toBe(0); // FAILED 不是 UNKNOWN
      }
    });

    it('resolveTimedOutEffects 将超时 EXECUTING 标记为 UNKNOWN', () => {
      recordIntent({
        effectId: 'eff-timeout', loopId: 'loop-1', iteration: 1,
        kind: 'external_api', idempotencyKey: 'idem-t',
        payloadHash: 'hash', timeoutMs: 1000,
      });
      markExecuting('eff-timeout');

      // 手动将 started_at 回拨到已超时
      const db = getMainDb();
      db.prepare(`UPDATE effect_journal SET started_at = started_at - 5000 WHERE effect_id = ?`).run('eff-timeout');

      const result = resolveTimedOutEffects();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(1);
      }

      const unknowns = getUnknownEffects('loop-1');
      expect(unknowns.ok).toBe(true);
      if (unknowns.ok) {
        expect(unknowns.value.length).toBe(1);
        expect(unknowns.value[0].status).toBe('UNKNOWN');
      }
    });

    it('findByIdepotencyKey 查找已有记录', () => {
      recordIntent({
        effectId: 'eff-idem', loopId: 'loop-1', iteration: 1,
        kind: 'db_write', idempotencyKey: 'unique-key',
        payloadHash: 'hash',
      });

      const found = findByIdepotencyKey('loop-1', 'unique-key');
      expect(found.ok).toBe(true);
      if (found.ok) {
        expect(found.value).not.toBeNull();
        expect(found.value!.effectId).toBe('eff-idem');
      }

      const notFound = findByIdepotencyKey('loop-1', 'nonexistent');
      expect(notFound.ok).toBe(true);
      if (notFound.ok) {
        expect(notFound.value).toBeNull();
      }
    });

    it('getPendingCount 返回待处理数量', () => {
      recordIntent({
        effectId: 'eff-c1', loopId: 'loop-1', iteration: 1,
        kind: 'tool_execute', idempotencyKey: 'k1', payloadHash: 'h1',
      });
      recordIntent({
        effectId: 'eff-c2', loopId: 'loop-1', iteration: 1,
        kind: 'tool_execute', idempotencyKey: 'k2', payloadHash: 'h2',
      });

      expect(getPendingCount()).toBe(2);
    });
  });

  // ===== Checkpoint Store =====
  describe('checkpointStore', () => {
    beforeEach(() => {
      initTestDb();
      insertTestLoop();
    });

    it('createCheckpoint + loadLatestCheckpoint', () => {
      const result = createCheckpoint({
        loopId: 'loop-1', iteration: 1,
        stateSnapshot: { iteration: 1, phase: 'acting', completedSteps: 1, failedAttempts: 0 },
        artifactManifest: [{ path: '/tmp/test.txt', hash: 'abc', sizeBytes: 100 }],
        pendingEffects: [],
        nextStepHint: '继续执行',
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.checkpointId).toContain('loop-1#1#');
      }

      const latest = loadLatestCheckpoint('loop-1');
      expect(latest.ok).toBe(true);
      if (latest.ok && latest.value) {
        expect(latest.value.iteration).toBe(1);
        expect(latest.value.stateSnapshot.phase).toBe('acting');
        expect(latest.value.nextStepHint).toBe('继续执行');
      }
    });

    it('loadCheckpoint 按 ID 加载', () => {
      const created = createCheckpoint({
        loopId: 'loop-1', iteration: 2,
        stateSnapshot: { iteration: 2, phase: 'verifying', completedSteps: 2, failedAttempts: 0 },
        artifactManifest: [],
        pendingEffects: ['eff-1'],
      });
      expect(created.ok).toBe(true);

      if (created.ok) {
        const loaded = loadCheckpoint(created.value.checkpointId);
        expect(loaded.ok).toBe(true);
        if (loaded.ok && loaded.value) {
          expect(loaded.value.pendingEffects).toEqual(['eff-1']);
        }
      }
    });

    it('listCheckpoints 按迭代降序', () => {
      createCheckpoint({
        loopId: 'loop-1', iteration: 1,
        stateSnapshot: { iteration: 1, phase: 'acting', completedSteps: 1, failedAttempts: 0 },
        artifactManifest: [], pendingEffects: [],
      });
      createCheckpoint({
        loopId: 'loop-1', iteration: 2,
        stateSnapshot: { iteration: 2, phase: 'acting', completedSteps: 2, failedAttempts: 0 },
        artifactManifest: [], pendingEffects: [],
      });

      const list = listCheckpoints('loop-1');
      expect(list.ok).toBe(true);
      if (list.ok) {
        expect(list.value.length).toBe(2);
        expect(list.value[0].iteration).toBeGreaterThanOrEqual(list.value[1].iteration);
      }
    });

    it('pruneCheckpoints 保留最近 N 个', () => {
      const db = getMainDb();
      for (let i = 0; i < 5; i++) {
        createCheckpoint({
          loopId: 'loop-1', iteration: i,
          stateSnapshot: { iteration: i, phase: 'acting', completedSteps: i, failedAttempts: 0 },
          artifactManifest: [], pendingEffects: [],
        });
        // 确保每个 checkpoint 有不同的 created_at
        db.prepare(`UPDATE loop_checkpoints SET created_at = ? WHERE loop_id = ? AND iteration = ?`)
          .run(Date.now() + i * 100, 'loop-1', i);
      }

      const pruned = pruneCheckpoints('loop-1', 3);
      expect(pruned.ok).toBe(true);

      const remaining = listCheckpoints('loop-1');
      if (remaining.ok) {
        expect(remaining.value.length).toBeLessThanOrEqual(3);
      }
    });

    it('DUR-003: Checkpoint 写入失败不损坏旧快照', () => {
      // 先创建一个有效 checkpoint
      const first = createCheckpoint({
        loopId: 'loop-1', iteration: 1,
        stateSnapshot: { iteration: 1, phase: 'acting', completedSteps: 1, failedAttempts: 0 },
        artifactManifest: [], pendingEffects: [],
      });
      expect(first.ok).toBe(true);

      // 模拟写入失败（loop_id 不存在的外键约束）
      const bad = createCheckpoint({
        loopId: 'nonexistent-loop', iteration: 1,
        stateSnapshot: { iteration: 1, phase: 'acting', completedSteps: 1, failedAttempts: 0 },
        artifactManifest: [], pendingEffects: [],
      });
      expect(bad.ok).toBe(false);

      // 旧快照完好
      const latest = loadLatestCheckpoint('loop-1');
      expect(latest.ok).toBe(true);
      if (latest.ok) {
        expect(latest.value).not.toBeNull();
        expect(latest.value!.iteration).toBe(1);
      }
    });
  });

  // ===== Idempotency Store =====
  describe('idempotencyStore', () => {
    beforeEach(() => {
      initTestDb();
      initIdempotencyStore({ cacheTtlHour: 24 });
    });

    it('makeIdempotencyKey 生成确定性键', () => {
      const key1 = makeIdempotencyKey('read', { path: '/a' }, 'loop-1');
      const key2 = makeIdempotencyKey('read', { path: '/a' }, 'loop-1');
      expect(key1).toBe(key2);

      // 不同参数生成不同键
      const key3 = makeIdempotencyKey('read', { path: '/b' }, 'loop-1');
      expect(key3).not.toBe(key1);
    });

    it('DUR-005: 同幂等键二次调用返回首次结果', () => {
      const key = makeIdempotencyKey('write', { content: 'hello' }, 'loop-1');

      // 首次查询：未命中
      const first = lookup(key);
      expect(first.ok).toBe(true);
      if (first.ok) {
        expect(first.value.hit).toBe(false);
      }

      // 存储首次结果
      const storeResult = store(key, 'loop-1', { written: true, bytes: 5 });
      expect(storeResult.ok).toBe(true);

      // 二次查询：命中，返回首次结果
      const second = lookup(key);
      expect(second.ok).toBe(true);
      if (second.ok) {
        expect(second.value.hit).toBe(true);
        expect(second.value.result).toEqual({ written: true, bytes: 5 });
      }
    });

    it('purgeExpired 清理过期记录', () => {
      const key = 'expired-key';
      const db = getMainDb();
      // 手动插入一条已过期的记录
      db.prepare(`
        INSERT INTO idempotency_cache (idem_key, loop_id, result_json, result_hash, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(key, 'loop-1', '{}', 'hash', Date.now() - 100000, Date.now() - 1);

      expect(getCacheSize()).toBe(0); // 已过期不计入

      const purged = purgeExpired();
      expect(purged.ok).toBe(true);
    });

    it('getCacheSize 返回有效缓存数量', () => {
      store('k1', 'loop-1', 'r1');
      store('k2', 'loop-1', 'r2');
      expect(getCacheSize()).toBe(2);
    });
  });

  // ===== Recovery Scanner + Executor =====
  describe('recovery', () => {
    beforeEach(() => {
      initTestDb();
      initEffectJournal({ defaultTimeoutMs: 30000 });
      initIdempotencyStore({ cacheTtlHour: 24 });
      initRecoveryScanner({
        autoResumeMaxUnknownEffects: 0,
        autoResumeMaxBudgetUsedRatio: 0.8,
        requireHumanOnArtifactDrift: true,
      });
    });

    it('无未完成 Loop 时扫描返回空', () => {
      const result = scanAndProposeRecovery();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(0);
      }
    });

    it('有 checkpoint 且无 UNKNOWN → AUTO_RESUME', () => {
      insertTestLoop('loop-auto');

      createCheckpoint({
        loopId: 'loop-auto', iteration: 1,
        stateSnapshot: { iteration: 1, phase: 'acting', completedSteps: 1, failedAttempts: 0 },
        artifactManifest: [], pendingEffects: [],
      });

      const plans = scanAndProposeRecovery();
      expect(plans.ok).toBe(true);
      if (plans.ok) {
        expect(plans.value.length).toBe(1);
        expect(plans.value[0].strategy).toBe('AUTO_RESUME');
      }
    });

    it('无 checkpoint（首轮崩溃）→ RESTART_FROM_SCRATCH', () => {
      insertTestLoop('loop-scratch');

      const plans = scanAndProposeRecovery();
      expect(plans.ok).toBe(true);
      if (plans.ok) {
        expect(plans.value.length).toBe(1);
        expect(plans.value[0].strategy).toBe('RESTART_FROM_SCRATCH');
      }
    });

    it('有 UNKNOWN 副作用 → REQUIRE_HUMAN', () => {
      insertTestLoop('loop-human');

      // 创建一个 effect 并标记为 UNKNOWN
      recordIntent({
        effectId: 'eff-unk', loopId: 'loop-human', iteration: 1,
        kind: 'external_api', idempotencyKey: 'idem-unk',
        payloadHash: 'hash', timeoutMs: 1000,
      });
      markExecuting('eff-unk');
      // 手动回拨 started_at 使其已超时
      const db = getMainDb();
      db.prepare(`UPDATE effect_journal SET started_at = started_at - 10000 WHERE effect_id = ?`).run('eff-unk');
      resolveTimedOutEffects(); // EXECUTING → UNKNOWN

      const plans = scanAndProposeRecovery();
      if (plans.ok) {
        const humanPlans = getHumanRequiredPlans(plans.value);
        expect(humanPlans.length).toBe(1);
        expect(humanPlans[0].strategy).toBe('REQUIRE_HUMAN');
      }
    });

    it('executeRecovery 从 checkpoint 恢复', () => {
      insertTestLoop('loop-resume');

      const ckpt = createCheckpoint({
        loopId: 'loop-resume', iteration: 3,
        stateSnapshot: { iteration: 3, phase: 'acting', completedSteps: 3, failedAttempts: 1 },
        artifactManifest: [], pendingEffects: [],
        nextStepHint: '写文件',
      });

      if (ckpt.ok) {
        const result = executeRecovery({
          loopId: 'loop-resume',
          strategy: 'AUTO_RESUME',
          lastCheckpointId: ckpt.value.checkpointId,
          unknownEffects: [],
          estimatedWastedTokens: 0,
          reason: '测试恢复',
        });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.iteration).toBe(4); // 从 iteration+1 继续
          expect(result.value.stateSnapshot).toHaveProperty('phase', 'acting');
        }
      }
    });

    it('validateRecoveryPlan 验证各策略', () => {
      const autoPlan = {
        loopId: 'l1', strategy: 'AUTO_RESUME' as const,
        lastCheckpointId: 'ckpt-1', unknownEffects: [],
        estimatedWastedTokens: 0, reason: 'ok',
      };
      expect(validateRecoveryPlan(autoPlan).ok).toBe(true);

      const humanPlan = {
        loopId: 'l2', strategy: 'REQUIRE_HUMAN' as const,
        unknownEffects: [], estimatedWastedTokens: 0, reason: '需人工',
      };
      const vr = validateRecoveryPlan(humanPlan);
      expect(vr.ok).toBe(true);
      if (vr.ok) {
        expect(vr.value).toBe(false); // 不自动执行
      }
    });
  });
});
