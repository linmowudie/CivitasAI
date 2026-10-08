/**
 * Tests/A2A/handoff.spec.ts
 *
 * P0a · 交接对账与复核（设计 §6.2 R1/R2/R5 + §18 #6）
 * 不变量：
 *  1. **R1 指纹对账**：哈希一致 → verified；不一致/缺失 → conflict（**不进自动仲裁**，交合并流程）
 *  2. **§18 #6 交叉校验**：系统事实存在但前任未声明 ⇒ 漏报被识别，且事实**自动附加**进交接包
 *  3. **R2 复核义务**：标"未验证"的区域未认领复核前 **不可依赖**；认领后放行并留痕
 *  4. 对账与复核均写治理台账（可审计）
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolve, join } from 'node:path';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

import { resetEventBus, subscribeMany } from '../../Src/Services/EventBus/eventBus.js';
import { EventType } from '../../Src/Services/EventBus/eventTypes.js';
import { initDatabase, closeDatabase, getMainDb } from '../../Src/Infra/Db/database.js';
import { initMigrations, clearMigrations, migrateUp } from '../../Src/Infra/Db/migrations.js';
import { setActiveOwner } from '../../Src/Services/AccountScope/activeAccount.js';
import {
  acknowledgeSelfLimits, augmentBundleWithSystemFacts, canRelyOnFact, collectSystemFacts,
  crossCheckSelfLimits, requiresRevalidation, verifyHandoff, verifyHandoffArtifacts,
} from '../../Src/Services/A2A/handoff.js';
import { issueCardForAgent, sendHandoff } from '../../Src/Services/A2A/a2aBroker.js';
import { loadHandoff, persistHandoff, resetA2aStore, resetStoreProbe } from '../../Src/Services/A2A/a2aStore.js';
import type { AgentInstance, AgentRole } from '../../Src/Core/AgentRuntime/types.js';
import type { HandoffBundle, HandoffSystemFacts } from '../../Src/Services/A2A/types.js';

const DIR = resolve(import.meta.dirname, '../../Data/_test_a2a_handoff');

function mkAgent(role: AgentRole, over: Partial<AgentInstance> = {}): AgentInstance {
  return {
    agentId: `agent-${role}-1`, role, status: 'ready', model: 'test-model',
    createdAt: Date.now() - 1000, updatedAt: Date.now(), consecutiveFailures: 0, awaitingApproval: false,
    ...over,
  };
}

function mkBundle(over: Partial<HandoffBundle> = {}): HandoffBundle {
  return {
    handoffId: 'ho-1', taskId: 't1', fromAgentId: 'agent-worker-1', toAgentId: 'agent-worker-2',
    createTime: Date.now(),
    artifacts: [{ path: 'Data/workspaces/t1/a.ts', sha256: 'aaa', sizeBytes: 10, lastModifiedBy: 'agent-worker-1', intent: '重构解析层' }],
    intent: { goal: '重构解析层并通过测试', done: ['解析层骨架'], remaining: ['补测试'] },
    knownPitfalls: ['旧版本忽略空行'],
    openQuestions: ['并发改造是否需要锁'],
    acceptance: ['全部测试通过'],
    selfLimits: [{ area: '并发改造', limitation: '未做全量验证', verified: false }],
    systemFacts: { failedAttempts: [], rejectedApprovals: [], revertedEdits: [] },
    provenance: { traceId: 'trace-1', loopId: 'loop-1', eventRange: [1, 2], prevHash: null },
    ...over,
  };
}

const sha = (content: string) => createHash('sha256').update(content).digest('hex');

describe('P0a · R1 指纹对账', () => {
  it('哈希一致 → verified', () => {
    const content = 'export const a = 1;';
    const bundle = mkBundle({ artifacts: [{ path: 'a.ts', sha256: sha(content), sizeBytes: content.length, lastModifiedBy: 'agent-worker-1', intent: 'x' }] });
    const r = verifyHandoffArtifacts(bundle, () => ({ sha256: sha(content), sizeBytes: content.length }));
    expect(r.status).toBe('verified');
    expect(r.diffs).toEqual([]);
    expect(r.checked).toBe(1);
  });

  it('★ 哈希不一致 → conflict（并给出期望/实际哈希）', () => {
    const bundle = mkBundle();
    const r = verifyHandoffArtifacts(bundle, () => ({ sha256: 'bbb', sizeBytes: 10 }));
    expect(r.status).toBe('conflict');
    expect(r.diffs[0]).toMatchObject({ path: 'Data/workspaces/t1/a.ts', expected: 'aaa', actual: 'bbb', reason: 'hash_mismatch' });
  });

  it('产物缺失 → conflict（reason=missing）', () => {
    const r = verifyHandoffArtifacts(mkBundle(), () => null);
    expect(r.diffs[0]!.reason).toBe('missing');
    expect(r.diffs[0]!.actual).toBeNull();
  });

  it('大小不符（哈希相同）→ conflict（reason=size_mismatch）', () => {
    const bundle = mkBundle({ artifacts: [{ path: 'a.ts', sha256: 'aaa', sizeBytes: 999, lastModifiedBy: 'agent-worker-1', intent: 'x' }] });
    const r = verifyHandoffArtifacts(bundle, () => ({ sha256: 'aaa', sizeBytes: 10 }));
    expect(r.diffs[0]!.reason).toBe('size_mismatch');
  });
});

describe('P0a · §18 #6 前任自述交叉校验', () => {
  it('系统事实存在但前任未声明 → 识别为漏报', () => {
    const bundle = mkBundle({
      systemFacts: { failedAttempts: [{ toolName: 'test.run', errorClass: 'ASSERTION', at: 1 }], rejectedApprovals: [], revertedEdits: [] },
    });
    const check = crossCheckSelfLimits(bundle);
    expect(check.systemFactCount).toBe(1);
    expect(check.missingDeclarations[0]!.detail).toContain('test.run');
  });

  it('★ 自动附加：系统事实进入 systemFacts 与 knownPitfalls（不依赖前任自述）', () => {
    const facts: HandoffSystemFacts = {
      failedAttempts: [{ toolName: 'test.run', errorClass: 'ASSERTION', at: 5 }], rejectedApprovals: [], revertedEdits: [],
    };
    const augmented = augmentBundleWithSystemFacts(mkBundle(), facts);
    expect(augmented.systemFacts.failedAttempts.length).toBe(1);
    expect(augmented.knownPitfalls.some(p => p.includes('[系统事实]') && p.includes('test.run'))).toBe(true);
    // 附加后仍保持原意图与未决问题（不得篡改前任内容）
    expect(augmented.knownPitfalls[0]).toBe('旧版本忽略空行');
    expect(augmented.intent.remaining).toEqual(['补测试']);
  });

  it('前任声明与系统事实一致 → 无漏报；声明无据 → 提示', () => {
    const bundle = mkBundle({
      selfLimits: [{ area: 'test.run', limitation: '该工具在该任务中不可用', verified: true }],
      systemFacts: { failedAttempts: [{ toolName: 'test.run', at: 1 }], rejectedApprovals: [], revertedEdits: [] },
    });
    const check = crossCheckSelfLimits(bundle);
    expect(check.missingDeclarations).toEqual([]);

    const unsupported = crossCheckSelfLimits(mkBundle());   // 声明了"并发改造"但无系统痕迹
    expect(unsupported.unsupportedClaims).toContain('并发改造');
  });

  it('collectSystemFacts：按 loopId 从 effect_journal 采集失败尝试（无 loopId 则空）', () => {
    expect(collectSystemFacts({}).failedAttempts).toEqual([]);
    const facts = collectSystemFacts({ loopId: 'loop-xyz' });
    expect(Array.isArray(facts.failedAttempts)).toBe(true);   // 无库数据时为空数组，但不抛错
  });
});

describe('P0a · R2 复核义务 + 落库留痕', () => {
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
    resetStoreProbe(); resetA2aStore(); setActiveOwner('alice');
  });
  afterEach(() => { resetEventBus(); closeDatabase(); clearMigrations(); if (existsSync(DIR)) rmSync(DIR, { recursive: true, force: true }); });

  it('★ 未认领复核前不可依赖；认领后放行', () => {
    persistHandoff(mkBundle(), 'hash-1');
    expect(requiresRevalidation(mkBundle(), '并发改造')).toBe(true);
    expect(canRelyOnFact('ho-1', '并发改造')).toEqual({ canRely: false, reason: 'requires_revalidation' });

    const review = acknowledgeSelfLimits('ho-1', ['并发改造'], { reviewerAgentId: 'agent-worker-2' });
    expect(review!.acknowledgedAreas).toEqual(['并发改造']);
    expect(canRelyOnFact('ho-1', '并发改造')).toEqual({ canRely: true, reason: 'revalidation_acknowledged' });
  });

  it('未被标"未验证"的区域可直接依赖', () => {
    persistHandoff(mkBundle(), 'hash-1');
    expect(canRelyOnFact('ho-1', '解析层')).toEqual({ canRely: true, reason: 'not_flagged_unverified' });
  });

  it('handoff 不存在 → fail-closed（不可依赖）', () => {
    expect(canRelyOnFact('不存在', 'x').canRely).toBe(false);
  });

  it('★ 对账后状态落库 + 治理台账留痕（verified 与 conflict 都记录）', () => {
    persistHandoff(mkBundle(), 'hash-1');
    const ok = verifyHandoff('ho-1', { readArtifact: () => ({ sha256: 'aaa', sizeBytes: 10 }), actorRole: 'auditor' });
    expect(ok!.status).toBe('verified');
    expect(loadHandoff('ho-1')).not.toBeNull();

    const rows = getMainDb().prepare(
      `SELECT action, outcome, reason FROM governance_records WHERE action = 'a2a.handoff_verify' ORDER BY timestamp DESC`,
    ).all() as Array<{ action: string; outcome: string; reason?: string }>;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]!.outcome).toBe('allowed');

    // 冲突路径
    const conflict = verifyHandoff('ho-1', { readArtifact: () => ({ sha256: 'zzz', sizeBytes: 10 }) });
    expect(conflict!.status).toBe('conflict');
    const rows2 = getMainDb().prepare(
      `SELECT outcome FROM governance_records WHERE action = 'a2a.handoff_verify' ORDER BY timestamp DESC LIMIT 1`,
    ).get() as { outcome: string };
    expect(rows2.outcome).toBe('denied');

    const status = getMainDb().prepare(`SELECT verification_status FROM a2a_handoffs WHERE handoff_id = 'ho-1'`).get() as { verification_status: string };
    expect(status.verification_status).toBe('conflict');
  });

  it('复核认领写入 review_json（可查）', () => {
    persistHandoff(mkBundle(), 'hash-1');
    acknowledgeSelfLimits('ho-1', ['并发改造', 'test.run'], { reviewerAgentId: 'agent-worker-2' });
    const row = getMainDb().prepare(`SELECT review_json FROM a2a_handoffs WHERE handoff_id = 'ho-1'`).get() as { review_json: string };
    const parsed = JSON.parse(row.review_json) as { acknowledgedAreas: string[]; reviewerAgentId?: string };
    expect(parsed.acknowledgedAreas.sort()).toEqual(['test.run', '并发改造'].sort());
    expect(parsed.reviewerAgentId).toBe('agent-worker-2');
  });

  it('★ sendHandoff：系统事实自动附加并发出漏报事件；消息只带指针', () => {
    const worker1 = mkAgent('worker');
    const worker2 = mkAgent('worker', { agentId: 'agent-worker-2' });
    issueCardForAgent(mkAgent('prime_director'), { cardVersion: 1 });
    issueCardForAgent(worker1, { cardVersion: 1, father: { agentId: 'agent-prime_director-1', role: 'prime_director' }, lineage: ['agent-prime_director-1'] });
    issueCardForAgent(worker2, { cardVersion: 1, father: { agentId: 'agent-prime_director-1', role: 'prime_director' }, lineage: ['agent-prime_director-1'] });

    // 真实订阅：断言"前任漏报"事件确实发出（§18 #6）
    const seen: Array<Record<string, unknown>> = [];
    subscribeMany([EventType.A2A_SELFREPORT_MISMATCH], (e) => {
      seen.push(e.payload as Record<string, unknown>);
    });
    const collect = vi.fn(() => ({
      failedAttempts: [{ toolName: 'test.run', errorClass: 'ASSERTION', at: Date.now() }],
      rejectedApprovals: [], revertedEdits: [],
    } satisfies HandoffSystemFacts));

    const r = sendHandoff({
      bundle: mkBundle({ fromAgentId: 'agent-worker-1', toAgentId: 'agent-worker-2' }),
      sourceAgentId: 'agent-worker-1', targetAgentId: 'agent-worker-2',
    }, { collectSystemFacts: collect });

    expect(collect).toHaveBeenCalled();
    expect(r.decision.verdict).toBe('allow');
    // 交接包已落库，且系统事实已附加
    expect(r.handoffBundleHash).toHaveLength(64);
    // ★ 前任漏报 → 事件已发出，且带系统事实明细
    expect(seen.length).toBe(1);
    expect(seen[0]!['handoffId']).toBe('ho-1');
    expect(String(seen[0]!['missingDeclarations'])).toContain('test.run');

    // 消息只带**指针**（H2：禁止正文副本）
    expect(r.envelope?.memoryRefs?.[0]?.key).toBe('handoff.t1.agent-worker-1');
  });
});
