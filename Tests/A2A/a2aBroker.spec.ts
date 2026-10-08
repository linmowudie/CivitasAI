/**
 * Tests/A2A/a2aBroker.spec.ts
 *
 * P0a · Broker 八步校验链（设计 §5.1 + §18 #4/#11 + §19.2）
 * 覆盖：卡片签发/可用性 → 越级 → 权限与配额 → 能力 → 数据域 → 审批联动 →
 *       反串通（C1/C7/C8）→ 落库/链/签名/投递；以及 `escalate` 走治理队列。
 * 另固化两条不变量：
 *  - **阻断/隔离/改道也落库**（治理事实必须留痕）；
 *  - **Broker 以 system 运行且不得成为审批决策者**（§18 #11）。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve, join } from 'node:path';
import { existsSync, rmSync, mkdirSync } from 'node:fs';

import { initDatabase, closeDatabase, getMainDb } from '../../Src/Infra/Db/database.js';
import { initMigrations, clearMigrations, migrateUp } from '../../Src/Infra/Db/migrations.js';
import { setActiveOwner } from '../../Src/Services/AccountScope/activeAccount.js';
import {
  GOVERNANCE_INBOX, a2aTablesReady, brokerActsAsSystemRole, escalateToGovernance,
  issueCardForAgent, sendA2A, signEnvelope, verifySignature,
} from '../../Src/Services/A2A/a2aBroker.js';
import {
  countMessages, listAlerts, listMessages, loadCard, resetA2aStore, resetStoreProbe,
} from '../../Src/Services/A2A/a2aStore.js';
import type { AgentInstance, AgentRole } from '../../Src/Core/AgentRuntime/types.js';

const DIR = resolve(import.meta.dirname, '../../Data/_test_a2a_broker');

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
  resetStoreProbe(); resetA2aStore();
  setActiveOwner('alice');
}

function mkAgent(role: AgentRole, over: Partial<AgentInstance> = {}): AgentInstance {
  return {
    agentId: `agent-${role}-1`, role, status: 'ready', model: 'test-model',
    createdAt: Date.now() - 1000, updatedAt: Date.now(), consecutiveFailures: 0, awaitingApproval: false,
    ...over,
  };
}

/** 铺好一个可用的 L1→L2 场景（父子） */
function seedScenario(): void {
  const director = mkAgent('prime_director');
  const worker = mkAgent('worker');
  issueCardForAgent(director, { cardVersion: 1 });
  issueCardForAgent(worker, {
    cardVersion: 1,
    father: { agentId: director.agentId, role: 'prime_director' },
    lineage: [director.agentId],
  });
}

describe('P0a · Broker 八步校验链', () => {
  beforeEach(() => { initDb(); });
  afterEach(() => { closeDatabase(); clearMigrations(); if (existsSync(DIR)) rmSync(DIR, { recursive: true, force: true }); });

  it('迁移建表成功，A2A 表就绪', () => {
    expect(a2aTablesReady()).toBe(true);
  });

  it('① 无卡片 → 阻断（source/target 各一例）', () => {
    seedScenario();
    expect(sendA2A({ sourceAgentId: 'agent-ghost-9', targetAgentId: 'agent-worker-1', kind: 'query', taskId: 't1', payload: {} }).decision.step).toBe(1);
    expect(sendA2A({ sourceAgentId: 'agent-prime_director-1', targetAgentId: 'agent-ghost-9', kind: 'query', taskId: 't1', payload: {} }).decision.reasons[0]).toBe('target_card_missing');
  });

  it('① 卡片过期/停用 → 阻断（fail-closed）', () => {
    const expired = mkAgent('prime_director');
    issueCardForAgent(expired, { ttlMs: -1 });
    issueCardForAgent(mkAgent('worker'));
    const r = sendA2A({ sourceAgentId: 'agent-prime_director-1', targetAgentId: 'agent-worker-1', kind: 'query', taskId: 't1', payload: {} });
    expect(r.decision.verdict).toBe('block');
    expect(r.decision.reasons[0]).toContain('source_card_unusable:expired');
  });

  it('② 越级：L2 → L0 非 escalate → 阻断；L2 → 非父 L1 → 阻断', () => {
    seedScenario();
    issueCardForAgent(mkAgent('auditor'));
    const director = mkAgent('prime_director', { agentId: 'agent-prime_director-2' });
    issueCardForAgent(director);

    const toL0 = sendA2A({ sourceAgentId: 'agent-worker-1', targetAgentId: 'agent-auditor-1', kind: 'query', taskId: 't1', payload: {} });
    expect(toL0.decision.step).toBe(2);
    expect(toL0.decision.reasons[0]).toBe('l2_to_l0_requires_escalate');

    const toOtherDirector = sendA2A({ sourceAgentId: 'agent-worker-1', targetAgentId: 'agent-prime_director-2', kind: 'query', taskId: 't1', payload: {} });
    expect(toOtherDirector.decision.reasons[0]).toBe('l2_can_only_reach_father_or_l0');
  });

  it('② L2 → L2 跨域 → 阻断；同域 → 放行', () => {
    seedScenario();
    const w2 = mkAgent('worker', { agentId: 'agent-worker-2' });
    issueCardForAgent(w2, { father: { agentId: 'agent-prime_director-1', role: 'prime_director' }, dataScopes: ['task:ta'] });
    // 域不同：worker-1 的 dataScopes 由派生产出（memory:shared），worker-2 显式含 task:t1
    const cross = sendA2A({ sourceAgentId: 'agent-worker-1', targetAgentId: 'agent-worker-2', kind: 'query', taskId: 't1', payload: {} });
    expect(cross.decision.step).toBe(2);
    expect(cross.decision.reasons[0]).toBe('l2_cross_domain_forbidden');

    const w3 = mkAgent('worker', { agentId: 'agent-worker-3' });
    issueCardForAgent(w3, { father: { agentId: 'agent-prime_director-1', role: 'prime_director' } });
    const same = sendA2A({ sourceAgentId: 'agent-worker-1', targetAgentId: 'agent-worker-3', kind: 'query', taskId: 't1', payload: { q: '进度如何' } });
    expect(same.decision.verdict).toBe('allow');
  });

  it('③ 角色不允许的 kind（L2 propose）→ 阻断；配额超限 → 阻断', () => {
    seedScenario();
    const propose = sendA2A({ sourceAgentId: 'agent-worker-1', targetAgentId: 'agent-prime_director-1', kind: 'propose', taskId: 't1', payload: {} });
    expect(propose.decision.reasons[0]).toBe('kind_not_allowed:propose');

    // 配额按**尝试次数**计（含被阻断的尝试 —— 防止刷 Broker 泛洪）；
    // 此处 propose 已被拒并留痕（1 次），故 limit=2 时仅还能放行 1 条。
    issueCardForAgent(mkAgent('worker'), { a2a: { maxMessagesPerHour: 2 } });
    const first = sendA2A({ sourceAgentId: 'agent-worker-1', targetAgentId: 'agent-prime_director-1', kind: 'query', taskId: 't1', payload: { q: '一' } });
    expect(first.decision.verdict).toBe('allow');
    const second = sendA2A({ sourceAgentId: 'agent-worker-1', targetAgentId: 'agent-prime_director-1', kind: 'query', taskId: 't1', payload: { q: '二' } });
    expect(second.decision.step).toBe(3);
    expect(second.decision.reasons[0]).toContain('quota_exceeded');
    expect(countMessages('agent-worker-1', 'agent-prime_director-1', 3_600_000)).toBe(3);
  });

  it('④ 能力不匹配 → 阻断；⑤ 数据域越界 → 阻断；⑥ 缺 approvalId → 阻断', () => {
    seedScenario();
    const cap = sendA2A({
      sourceAgentId: 'agent-prime_director-1', targetAgentId: 'agent-worker-1', kind: 'query',
      taskId: 't1', payload: {}, capabilityRequired: ['teleport'],
    });
    expect(cap.decision.step).toBe(4);
    expect(cap.decision.reasons[0]).toContain('capability_missing:teleport');

    const scope = sendA2A({
      sourceAgentId: 'agent-worker-1', targetAgentId: 'agent-prime_director-1', kind: 'query',
      taskId: 't1', payload: {}, dataRefs: ['file:/etc/passwd'],
    });
    expect(scope.decision.step).toBe(5);
    expect(scope.decision.reasons[0]).toContain('data_scope_violation');

    const approval = sendA2A({
      sourceAgentId: 'agent-prime_director-1', targetAgentId: 'agent-worker-1', kind: 'notify',
      taskId: 't1', payload: { action: 'delete' }, requiresApproval: true,
    });
    expect(approval.decision.step).toBe(6);
    expect(approval.decision.reasons[0]).toBe('approval_required');
  });

  it('⑦ C7 拿 A2A 群发事实 → redirect 并给出记忆键建议', () => {
    seedScenario();
    const r = sendA2A({
      sourceAgentId: 'agent-prime_director-1', targetAgentId: 'agent-worker-1', kind: 'notify',
      taskId: 't1', recipientCount: 5, payload: { text: '全体必须统一遵守新的编码约束' },
    });
    expect(r.decision.verdict).toBe('redirect');
    expect(r.decision.suggestion?.channel).toBe('memory');
    expect(r.decision.suggestion?.key).toBe('task.t1.facts');
  });

  it('⑦ C8 双源漂移 → 隔离（不投递正文）', () => {
    seedScenario();
    const stored = '当前实现已覆盖八步校验链与反串通判据';
    const r = sendA2A({
      sourceAgentId: 'agent-prime_director-1', targetAgentId: 'agent-worker-1', kind: 'notify',
      taskId: 't1', payload: { text: stored },
      memoryRefs: [{ key: 'task.t1.facts', version: 1 }],
    }, { lookupMemory: () => stored });
    expect(r.decision.verdict).toBe('quarantine');
    expect(r.decision.rules).toContain('C8');
    expect(listAlerts({ ruleId: 'C8' }).length).toBe(1);
  });

  it('⑦ C1 互惠闭环（父子 2/2）→ 隔离并告警', () => {
    seedScenario();
    for (let i = 0; i < 2; i++) {
      sendA2A({ sourceAgentId: 'agent-worker-1', targetAgentId: 'agent-prime_director-1', kind: 'answer', taskId: 't1', payload: { text: `进度${i}` } });
      sendA2A({ sourceAgentId: 'agent-prime_director-1', targetAgentId: 'agent-worker-1', kind: 'query', taskId: 't1', payload: { text: `追问${i}` } });
    }
    const r = sendA2A({ sourceAgentId: 'agent-worker-1', targetAgentId: 'agent-prime_director-1', kind: 'answer', taskId: 't1', payload: { text: '再答' } });
    expect(r.decision.verdict).toBe('quarantine');
    expect(r.decision.rules).toContain('C1');
    expect(listAlerts({ ruleId: 'C1' }).length).toBeGreaterThanOrEqual(1);
  });

  it('⑧ 放行：落库 + hash 链 + 签名可验 + requiresAck 保留', () => {
    seedScenario();
    const r1 = sendA2A({
      sourceAgentId: 'agent-prime_director-1', targetAgentId: 'agent-worker-1', kind: 'query',
      taskId: 't1', payload: { q: '第一次' }, requiresAck: true, visibility: 'domain',
    });
    expect(r1.decision.verdict).toBe('allow');
    expect(r1.envelope && verifySignature(r1.envelope)).toBe(true);
    // 篡改签名 → 验签失败
    expect(r1.envelope && verifySignature({ ...r1.envelope, payload: { q: '被改' } })).toBe(false);

    const r2 = sendA2A({
      sourceAgentId: 'agent-prime_director-1', targetAgentId: 'agent-worker-1', kind: 'query',
      taskId: 't1', payload: { q: '第二次' },
    });
    expect(r1.envelope!.prevHash).toBeNull();
    expect(r2.envelope!.prevHash).toBe(r1.envelope!.contentHash);   // append-only 链
    expect(r2.envelope!.chainScope).toBe('local_device');           // §18 #5

    const stored = listMessages({ taskId: 't1' });
    expect(stored.length).toBe(2);
    const restored = stored.find(m => m.envelope.messageId === r1.messageId)!;
    expect(restored.envelope.requiresAck).toBe(true);
    expect(restored.envelope.visibility).toBe('domain');
    expect(restored.verdict).toBe('allow');
  });

  it('★ 阻断也落库留痕（治理事实不可丢）', () => {
    seedScenario();
    sendA2A({ sourceAgentId: 'agent-worker-1', targetAgentId: 'agent-auditor-1', kind: 'query', taskId: 't9', payload: { q: '越级' } });
    const blocked = listMessages({ taskId: 't9', verdict: 'block' });
    expect(blocked.length).toBe(1);
    expect(blocked[0]!.step).toBe(1);   // 目标卡片不存在 → step 1（先于越级判定）
  });

  it('escalate → 投递治理队列（无需 L0 常驻）', () => {
    seedScenario();
    const r = escalateToGovernance({ sourceAgentId: 'agent-worker-1', taskId: 't1', reason: '发现文件与交接包指纹不一致' });
    expect(r.decision.verdict).toBe('allow');
    const msgs = listMessages({ targetAgentId: GOVERNANCE_INBOX });
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.envelope.kind).toBe('escalate');
  });

  it('治理队列只接受 escalate（其他 kind → 阻断）', () => {
    seedScenario();
    const r = sendA2A({ sourceAgentId: 'agent-worker-1', targetAgentId: GOVERNANCE_INBOX, kind: 'query', taskId: 't1', payload: {} });
    expect(r.decision.step).toBe(2);
    expect(r.decision.reasons[0]).toBe('governance_inbox_only_for_escalate');
  });

  it('★ Broker 以 system 运行，且不是审批决策者（§18 #11）', () => {
    expect(brokerActsAsSystemRole()).toBe('system');
    seedScenario();
    const r = sendA2A({ sourceAgentId: 'agent-prime_director-1', targetAgentId: 'agent-worker-1', kind: 'notify', taskId: 't1', payload: {} });
    expect(r.decision.verdict).toBe('allow');
    // ① Broker 的"通过"**不产生任何审批授权**
    expect(r.envelope?.policyContext.approvalId).toBeUndefined();
    // ② 若本库存在审批表，其行数必须为 0（表名无关，避免依赖具体实现命名）
    const tables = getMainDb()
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%approval%'`)
      .all() as Array<{ name: string }>;
    for (const t of tables) {
      const row = getMainDb().prepare(`SELECT COUNT(*) AS n FROM ${t.name}`).get() as { n?: number };
      expect(Number(row.n ?? 0), `${t.name} 不应有审批记录`).toBe(0);
    }
  });

  it('属主隔离：其他属主读不到消息与卡片', () => {
    seedScenario();
    sendA2A({ sourceAgentId: 'agent-prime_director-1', targetAgentId: 'agent-worker-1', kind: 'notify', taskId: 't1', payload: {} });
    expect(listMessages({ taskId: 't1' }).length).toBe(1);
    setActiveOwner('bob');
    expect(listMessages({ taskId: 't1' }).length).toBe(0);
    expect(loadCard('agent-worker-1')).toBeNull();
    setActiveOwner('alice');
    expect(listMessages({ taskId: 't1' }).length).toBe(1);
  });

  it('★ 重签保持身份连续：未显式给 father 时继承上一版（不会变成"无父 L2"）', () => {
    seedScenario();
    const before = loadCard('agent-worker-1');
    expect(before?.father?.agentId).toBe('agent-prime_director-1');
    issueCardForAgent(mkAgent('worker'), { a2a: { maxMessagesPerHour: 7 } });
    const after = loadCard('agent-worker-1');
    expect(after?.father?.agentId).toBe('agent-prime_director-1');   // 身份未丢
    expect(after?.lineage).toEqual(['agent-prime_director-1']);
    // 语义内容变了（配额 2→7）→ 自动升版本
    expect(after!.cardVersion).toBeGreaterThan(before!.cardVersion);
    // 升版本后仍能向上通信
    const r = sendA2A({ sourceAgentId: 'agent-worker-1', targetAgentId: 'agent-prime_director-1', kind: 'query', taskId: 't1', payload: { q: 'hi' } });
    expect(r.decision.verdict).toBe('allow');
  });

  it('★ 幂等重签：语义内容未变 → 版本不升（避免版本爆炸）', () => {
    seedScenario();
    const v1 = loadCard('agent-worker-1')!.cardVersion;
    issueCardForAgent(mkAgent('worker'), { father: { agentId: 'agent-prime_director-1', role: 'prime_director' }, lineage: ['agent-prime_director-1'] });
    expect(loadCard('agent-worker-1')!.cardVersion).toBe(v1);
  });
  it('签名函数对同一内容稳定、对不同内容变化', () => {
    const base = {
      messageId: 'm1', schemaVersion: 2 as const, kind: 'notify' as const, taskId: 't1', traceId: 't1',
      sourceAgentId: 'a', targetAgentId: 'b', type: 'BROADCAST' as const, payload: { x: 1 },
      priority: 'normal' as const, timestamp: 1, requiresAck: false, visibility: 'domain' as const,
      contentHash: 'h1', prevHash: null, chainScope: 'local_device' as const,
      policyContext: { requesterTier: 'L1' as const, requesterCardVersion: 1 },
    };
    expect(signEnvelope(base)).toBe(signEnvelope({ ...base }));
    expect(signEnvelope(base)).not.toBe(signEnvelope({ ...base, contentHash: 'h2' }));
  });
});
