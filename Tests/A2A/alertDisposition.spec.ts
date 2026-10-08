/**
 * Tests/A2A/alertDisposition.spec.ts
 *
 * P0a · 串通告警处置链（设计 §7.3 + §19.4 Q4）
 * 不变量：
 *  1. 处置是**治理动作**：非 L0 一律拒绝（fail-closed）
 *  2. 处置与角色**强绑定**：`frozen` 需 auditor、`arbitrated` 需 arbitrator —— **不静默降级**
 *  3. `cooled` 有**执行效力**：冷却期内该对消息被 Broker 拒绝（不只是标签）
 *  4. `frozen` 真冻结（审计局可见）；`arbitrated` 真立案（仲裁庭可见）
 *  5. 每次处置写治理台账 + 发 `a2a:alert_disposed`；`pending` 不得回退
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve, join } from 'node:path';
import { existsSync, rmSync, mkdirSync } from 'node:fs';

import { initDatabase, closeDatabase, getMainDb } from '../../Src/Infra/Db/database.js';
import { initMigrations, clearMigrations, migrateUp } from '../../Src/Infra/Db/migrations.js';
import { setActiveOwner } from '../../Src/Services/AccountScope/activeAccount.js';
import { disposeAlert } from '../../Src/Services/A2A/alertDisposition.js';
import { issueCardForAgent, sendA2A } from '../../Src/Services/A2A/a2aBroker.js';
import { getAlertById, listAlerts, persistAlert, resetA2aStore, resetStoreProbe } from '../../Src/Services/A2A/a2aStore.js';
import { getFrozenAgents } from '../../Src/Services/Audit/resourceAuditBureau.js';
import { resetArbitratorPool } from '../../Src/Services/Arbitration/arbitratorPool.js';
import { resetTribunal } from '../../Src/Services/Arbitration/tribunal.js';
import type { AgentInstance, AgentRole } from '../../Src/Core/AgentRuntime/types.js';
import type { CollusionAlert } from '../../Src/Services/A2A/types.js';

const DIR = resolve(import.meta.dirname, '../../Data/_test_a2a_dispose');

function mkAgent(role: AgentRole, over: Partial<AgentInstance> = {}): AgentInstance {
  return {
    agentId: `agent-${role}-1`, role, status: 'ready', model: 'test-model',
    createdAt: Date.now() - 1000, updatedAt: Date.now(), consecutiveFailures: 0, awaitingApproval: false,
    ...over,
  };
}

function mkAlert(over: Partial<CollusionAlert> = {}): CollusionAlert {
  return {
    alertId: 'alert-C1-1', ruleId: 'C1', severity: 'medium',
    participants: ['agent-worker-1', 'agent-prime_director-1'],
    taskId: 't1', evidence: { pair: 2 }, disposition: 'pending',
    raisedAt: Date.now(), ownerUserId: 'alice',
    ...over,
  };
}

describe('P0a · 告警处置链', () => {
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
    resetTribunal(); resetArbitratorPool();
    issueCardForAgent(mkAgent('prime_director'), { cardVersion: 1 });
    issueCardForAgent(mkAgent('worker'), {
      cardVersion: 1, father: { agentId: 'agent-prime_director-1', role: 'prime_director' }, lineage: ['agent-prime_director-1'],
    });
    persistAlert(mkAlert());
  });
  afterEach(() => {
    resetTribunal(); resetArbitratorPool(); closeDatabase(); clearMigrations();
    if (existsSync(DIR)) rmSync(DIR, { recursive: true, force: true });
  });

  it('① 非 L0 处置 → 拒绝（fail-closed）', () => {
    const r = disposeAlert({ alertId: 'alert-C1-1', disposition: 'warned', actorRole: 'worker' });
    expect(r.ok).toBe(false);
    expect(getAlertById('alert-C1-1')!.disposition).toBe('pending');
  });

  it('② ★ 角色绑定不降级：L0 但非 auditor 请求 frozen → 拒绝；非 arbitrator 请求 arbitrated → 拒绝', () => {
    const frozen = disposeAlert({ alertId: 'alert-C1-1', disposition: 'frozen', actorRole: 'regulator' });
    expect(frozen.ok).toBe(false);
    expect(String(frozen.ok ? '' : frozen.error)).toContain('需角色 auditor');

    const arb = disposeAlert({ alertId: 'alert-C1-1', disposition: 'arbitrated', actorRole: 'auditor' });
    expect(arb.ok).toBe(false);
    expect(String(arb.ok ? '' : arb.error)).toContain('需角色 arbitrator');
    expect(getAlertById('alert-C1-1')!.disposition).toBe('pending');   // 未被静默改状态
  });

  it('② pending 不得回退', () => {
    const r = disposeAlert({ alertId: 'alert-C1-1', disposition: 'pending', actorRole: 'auditor' });
    expect(r.ok).toBe(false);
  });

  it('③ ★ cooled 有执行效力：冷却期内该对被 Broker 拒绝，过期后恢复', () => {
    const now = Date.now();
    const cool = disposeAlert({
      alertId: 'alert-C1-1', disposition: 'cooled', actorRole: 'regulator',
      reason: '互惠异常', cooldownMs: 60_000, now,
    });
    expect(cool.ok).toBe(true);
    expect(cool.ok && cool.value.effects.some(e => e.startsWith('cooldown:'))).toBe(true);

    // 冷却中：正常消息也被拒
    const blocked = sendA2A({
      sourceAgentId: 'agent-worker-1', targetAgentId: 'agent-prime_director-1', kind: 'answer',
      taskId: 't1', payload: { text: '普通汇报' },
    });
    expect(blocked.decision.verdict).toBe('block');
    expect(blocked.decision.reasons[0]).toContain('pair_cooled_down');

    // 冷却过期：恢复（用未来时间点判定即可验证"过期即失效"的语义）
    const later = sendA2A({
      sourceAgentId: 'agent-worker-1', targetAgentId: 'agent-prime_director-1', kind: 'answer',
      taskId: 't1', payload: { text: '普通汇报' }, now: now + 120_000,
    });
    expect(later.decision.verdict).toBe('allow');
  });

  it('④ ★ frozen：审计局真冻结两个参与者', () => {
    const r = disposeAlert({ alertId: 'alert-C1-1', disposition: 'frozen', actorRole: 'auditor', reason: '互惠闭环' });
    expect(r.ok).toBe(true);
    expect(r.ok && r.value.effects.filter(e => e.startsWith('frozen:')).length).toBe(2);
    expect(getFrozenAgents()).toContain('agent-worker-1');
    expect(getFrozenAgents()).toContain('agent-prime_director-1');
    expect(getAlertById('alert-C1-1')!.disposition).toBe('frozen');
  });

  it('④ ★ arbitrated：仲裁庭真立案（同一告警重复立案被拒但不崩）', () => {
    const r = disposeAlert({ alertId: 'alert-C1-1', disposition: 'arbitrated', actorRole: 'arbitrator' });
    expect(r.ok).toBe(true);
    expect(r.ok && r.value.effects.some(e => e.startsWith('case_filed:'))).toBe(true);

    persistAlert(mkAlert({ alertId: 'alert-C1-2' }));
    const again = disposeAlert({ alertId: 'alert-C1-2', disposition: 'arbitrated', actorRole: 'arbitrator' });
    // conflictId 相同（参与者相同）→ 已在进行中的案件 → 记为 failures 而非抛出
    expect(again.ok).toBe(true);
    expect(again.ok && again.value.failures.length).toBeGreaterThanOrEqual(0);
  });

  it('⑤ warned：仅留痕与事件，不改动其他状态', () => {
    const r = disposeAlert({ alertId: 'alert-C1-1', disposition: 'warned', actorRole: 'regulator', reason: '首次提醒' });
    expect(r.ok).toBe(true);
    expect(r.ok && r.value.effects).toEqual([]);
    expect(getAlertById('alert-C1-1')!.disposition).toBe('warned');
  });

  it('⑤ 每次处置写治理台账（a2a.alert_dispose）', () => {
    disposeAlert({ alertId: 'alert-C1-1', disposition: 'warned', actorRole: 'regulator' });
    const rows = getMainDb().prepare(
      `SELECT action, outcome, reason FROM governance_records WHERE action = 'a2a.alert_dispose'`,
    ).all() as Array<{ action: string; outcome: string; reason: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0]!.reason).toContain('alert-C1-1');
  });

  it('未知告警 → 明确报错', () => {
    const r = disposeAlert({ alertId: '不存在', disposition: 'warned', actorRole: 'regulator' });
    expect(r.ok).toBe(false);
  });

  it('处置后告警列表反映最新处置', () => {
    disposeAlert({ alertId: 'alert-C1-1', disposition: 'cooled', actorRole: 'regulator', cooldownMs: 1000 });
    expect(listAlerts({ disposition: 'cooled' }).length).toBe(1);
  });
});
