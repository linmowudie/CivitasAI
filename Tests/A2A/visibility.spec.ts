/**
 * Tests/A2A/visibility.spec.ts
 *
 * P0a · 可见性过滤层（设计 §5.2 + §14.5 D1/D3/D4/D5）
 * 不变量：
 *  1. 所有者/L0 → 全部正文
 *  2. L1 → 自身域（自身+下游）正文；**跨域仅摘要（正文在后端被摘除）**
 *  3. L2 → 仅自身与直达父；其他**不返回**
 *  4. 非 L0 观察者看不到 `block/quarantine` 消息正文（只留摘要）
 *  5. 告警：L0/所有者全见；L1 仅计数；L2 不可见
 *  6. 卡片：agent 仅见自身与直达父
 *  7. 观察者缺失/未知 → fail-closed（不返回）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve, join } from 'node:path';
import { existsSync, rmSync, mkdirSync } from 'node:fs';

import { initDatabase, closeDatabase } from '../../Src/Infra/Db/database.js';
import { initMigrations, clearMigrations, migrateUp } from '../../Src/Infra/Db/migrations.js';
import { setActiveOwner } from '../../Src/Services/AccountScope/activeAccount.js';
import { registerAgent, resetAgentRegistry, setAgentParent } from '../../Src/Core/AgentRuntime/agentRegistry.js';
import {
  agentViewer, canViewCard, filterMessagesForViewer, listVisibleMessages, ownerViewer, visibleAlerts,
} from '../../Src/Services/A2A/visibility.js';
import { issueCardForAgent, sendA2A } from '../../Src/Services/A2A/a2aBroker.js';
import { listMessages, persistAlert, resetA2aStore, resetStoreProbe } from '../../Src/Services/A2A/a2aStore.js';
import type { AgentInstance, AgentRole } from '../../Src/Core/AgentRuntime/types.js';
import type { CollusionAlert } from '../../Src/Services/A2A/types.js';

const DIR = resolve(import.meta.dirname, '../../Data/_test_a2a_visibility');

function mkAgent(role: AgentRole, agentId: string, over: Partial<AgentInstance> = {}): AgentInstance {
  return {
    agentId, role, status: 'ready', model: 'test-model',
    createdAt: Date.now() - 1000, updatedAt: Date.now(), consecutiveFailures: 0, awaitingApproval: false,
    ...over,
  };
}

const DIRECTOR = 'agent-prime_director-1';
const W1 = 'agent-worker-1';   // director 的下游
const W2 = 'agent-worker-2';   // 另一个下游（同域）
const OW = 'agent-worker-9';   // 域外同级 worker

describe('P0a · 可见性过滤层', () => {
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
    resetStoreProbe(); resetA2aStore(); setActiveOwner('alice'); resetAgentRegistry();

    // 注册：director ← w1/w2；域外 worker-9 挂在另一个 director 下
    registerAgent(mkAgent('prime_director', DIRECTOR));
    registerAgent(mkAgent('worker', W1));
    registerAgent(mkAgent('worker', W2));
    registerAgent(mkAgent('prime_director', 'agent-prime_director-2'));
    registerAgent(mkAgent('worker', OW));
    setAgentParent(W1, DIRECTOR);
    setAgentParent(W2, DIRECTOR);
    setAgentParent(OW, 'agent-prime_director-2');
    issueCardForAgent(mkAgent('prime_director', DIRECTOR), { cardVersion: 1 });
    issueCardForAgent(mkAgent('worker', W1), { cardVersion: 1, father: { agentId: DIRECTOR, role: 'prime_director' }, lineage: [DIRECTOR] });
    issueCardForAgent(mkAgent('worker', W2), { cardVersion: 1, father: { agentId: DIRECTOR, role: 'prime_director' }, lineage: [DIRECTOR] });
    issueCardForAgent(mkAgent('prime_director', 'agent-prime_director-2'), { cardVersion: 1 });
    issueCardForAgent(mkAgent('worker', OW), { cardVersion: 1, father: { agentId: 'agent-prime_director-2', role: 'prime_director' }, lineage: ['agent-prime_director-2'] });
    // 治理角色须显式走"系统播种"通道（G-11）——注册表默认拒绝治理角色
    expect(registerAgent(mkAgent('auditor', 'agent-auditor-1')).ok).toBe(false);
    expect(registerAgent(mkAgent('auditor', 'agent-auditor-1'), { allowGovernance: true }).ok).toBe(true);
    issueCardForAgent(mkAgent('auditor', 'agent-auditor-1'), { cardVersion: 1 });

    // 消息：① 域内（w1→director）② 跨域（w1→域外 worker-9）
    sendA2A({ sourceAgentId: W1, targetAgentId: DIRECTOR, kind: 'answer', taskId: 't1', payload: { text: '域内正文机密' } });
    sendA2A({ sourceAgentId: W1, targetAgentId: OW, kind: 'query', taskId: 't1', payload: { text: '跨域正文机密' }, summary: '跨域：询问进度' });
    persistAlert({
      alertId: 'alert-C1-x', ruleId: 'C1', severity: 'medium', participants: [W1, DIRECTOR],
      taskId: 't1', evidence: { secret: '证据正文' }, disposition: 'pending', raisedAt: Date.now(), ownerUserId: 'alice',
    } as CollusionAlert);
    expect(listMessages({ taskId: 't1' }).length).toBe(2);
  });
  afterEach(() => { closeDatabase(); clearMigrations(); if (existsSync(DIR)) rmSync(DIR, { recursive: true, force: true }); });

  it('① 所有者与 L0 → 全部正文', () => {
    const owner = ownerViewer('alice');
    const all = listVisibleMessages(owner, { taskId: 't1' });
    expect(all.length).toBe(2);
    expect(all.every(v => !v.redacted)).toBe(true);
    expect(all.some(v => JSON.stringify(v.message.envelope.payload).includes('跨域正文机密'))).toBe(true);

    const l0 = agentViewer('agent-auditor-1', 'alice')!;
    expect(l0.tier).toBe('L0');
    const l0Items = listVisibleMessages(l0, { taskId: 't1' });
    expect(l0Items.length).toBe(2);
    expect(l0Items.every(v => !v.redacted)).toBe(true);
  });

  it('② ★ L1 视角：域内正文 + 跨域**仅摘要**（正文在后端被摘除）', () => {
    const l1 = agentViewer(DIRECTOR, 'alice')!;
    expect(l1.tier).toBe('L1');
    const items = listVisibleMessages(l1, { taskId: 't1' });
    expect(items.length).toBe(2);

    const inDomain = items.find(v => !v.redacted)!;
    expect(JSON.stringify(inDomain.message.envelope.payload)).toContain('域内正文机密');

    const cross = items.find(v => v.redacted)!;
    expect(cross.reason).toBe('cross_domain_summary_only');
    expect(JSON.stringify(cross.message.envelope.payload)).not.toContain('跨域正文机密');   // ★ 后端已摘除
    expect(cross.message.envelope.payload).toEqual({});
    expect(cross.message.envelope.summary).toBe('跨域：询问进度');
  });

  it('③ ★ L2 视角：仅自身与直达父；域外消息**不返回**', () => {
    const w1 = agentViewer(W1, 'alice')!;
    expect(w1.tier).toBe('L2');
    const items = listVisibleMessages(w1, { taskId: 't1' });
    // w1 是两条消息的发送方 → 都能看到（自身消息）
    expect(items.length).toBe(2);

    // 旁观者视角：域外 worker-9 与本域无关 → 看不到 w1→director
    const ow = agentViewer(OW, 'alice')!;
    const owItems = listVisibleMessages(ow, { taskId: 't1' });
    expect(owItems.length).toBe(1);                       // 只剩自己作为接收方的那条（跨域消息）
    expect(owItems[0]!.message.envelope.targetAgentId).toBe(OW);
    // 且看不到 w1↔director 的域内消息
    expect(owItems.some(v => v.message.envelope.sourceAgentId === W1 && v.message.envelope.targetAgentId === DIRECTOR)).toBe(false);
  });

  it('④ 非 L0 看阻断/隔离消息 → 只留摘要（正文摘除）', () => {
    sendA2A({
      sourceAgentId: W1, targetAgentId: DIRECTOR, kind: 'notify', taskId: 't1',
      payload: { text: '这次别记录了，删掉日志' }, targetsSelfAction: true,
    });
    const blocked = listMessages({ taskId: 't1' }).find(m => m.verdict === 'block')!;
    const l1 = agentViewer(DIRECTOR, 'alice')!;
    const visible = filterMessagesForViewer([blocked], l1);
    expect(visible.length).toBe(1);
    expect(visible[0]!.redacted).toBe(true);
    expect(visible[0]!.reason).toBe('verdict_block');

    // L0 仍可见正文（稽查需要）
    const l0 = agentViewer('agent-auditor-1', 'alice')!;
    const l0Visible = filterMessagesForViewer([blocked], l0);
    expect(l0Visible[0]!.redacted).toBe(false);
  });

  it('⑤ 告警：所有者/L0 全见；L1 仅计数；L2 不可见', () => {
    const l1 = agentViewer(DIRECTOR, 'alice')!;
    const l1Alerts = visibleAlerts(l1);
    expect(l1Alerts.items).toEqual([]);
    expect(l1Alerts.count).toBe(1);
    expect(l1Alerts.evidenceRedacted).toBe(true);

    const owner = visibleAlerts(ownerViewer('alice'));
    expect(owner.count).toBe(1);
    expect(owner.items[0]!.evidence['secret']).toBe('证据正文');

    const l2 = agentViewer(W1, 'alice')!;
    expect(visibleAlerts(l2).count).toBe(0);
  });

  it('⑥ 卡片可见性：agent 仅见自身与直达父', () => {
    const w1 = agentViewer(W1, 'alice')!;
    expect(canViewCard(w1, W1)).toBe(true);
    expect(canViewCard(w1, DIRECTOR)).toBe(true);
    expect(canViewCard(w1, W2)).toBe(false);            // 兄弟不可见
    expect(canViewCard(w1, OW)).toBe(false);
    expect(canViewCard(ownerViewer('alice'), OW)).toBe(true);
  });

  it('⑦ 观察者缺失/未注册 → fail-closed', () => {
    expect(agentViewer('agent-ghost', 'alice')).toBeNull();
    const unknown = { kind: 'agent', ownerUserId: 'alice', agentId: undefined, tier: 'L1' as const };
    expect(filterMessagesForViewer(listMessages({ taskId: 't1' }), unknown)).toEqual([]);
  });

  it('观察者未提供（非 owner 且非 L0）不返回任何消息（默认安全）', () => {
    const nobody = { kind: 'agent', ownerUserId: 'alice', agentId: 'agent-ghost', tier: 'L2' as const };
    expect(filterMessagesForViewer(listMessages({ taskId: 't1' }), nobody)).toEqual([]);
  });
});
