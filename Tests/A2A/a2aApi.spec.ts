/**
 * Tests/A2A/a2aApi.spec.ts
 *
 * P0a · A2A REST 面（设计 §9 + §14.5 D1/D5 + G-09 身份门）
 * 不变量：
 *  1. 身份门：携带令牌但**验真失败** → 403（fail-closed，不降级为本地账号）
 *  2. 可见性由**后端**决定：agent 视角跨域消息 `payload` 为空、`redacted=true`
 *  3. 治理队列/申请查看 仅 L0/所有者；其他角色 403
 *  4. 处置走角色绑定（非匹配角色 409）
 *  5. 确认（ack）：仅接收方或治理观察者可确认；不要求确认的消息 409
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve, join } from 'node:path';
import { existsSync, rmSync, mkdirSync } from 'node:fs';

import { initDatabase, closeDatabase } from '../../Src/Infra/Db/database.js';
import { initMigrations, clearMigrations, migrateUp } from '../../Src/Infra/Db/migrations.js';
import { setActiveOwner } from '../../Src/Services/AccountScope/activeAccount.js';
import { registerAgent, resetAgentRegistry, setAgentParent } from '../../Src/Core/AgentRuntime/agentRegistry.js';
import { registerA2ARoutes } from '../../Src/Interface/RestApi/a2aApi.js';
import { clearRoutes, matchRoute } from '../../Src/Interface/RestApi/router.js';
import { issueCardForAgent, sendA2A } from '../../Src/Services/A2A/a2aBroker.js';
import { listMessages, persistAlert, resetA2aStore, resetStoreProbe } from '../../Src/Services/A2A/a2aStore.js';
import { resetServerIdentityCache } from '../../Src/Services/Governance/serverIdentity.js';
import type { AgentInstance, AgentRole } from '../../Src/Core/AgentRuntime/types.js';
import type { CollusionAlert } from '../../Src/Services/A2A/types.js';

const DIR = resolve(import.meta.dirname, '../../Data/_test_a2a_api');

function mkAgent(role: AgentRole, agentId: string, over: Partial<AgentInstance> = {}): AgentInstance {
  return {
    agentId, role, status: 'ready', model: 'test-model',
    createdAt: Date.now() - 1000, updatedAt: Date.now(), consecutiveFailures: 0, awaitingApproval: false, ...over,
  };
}

interface FakeReq {
  method: string; path: string; params: Record<string, string>;
  query: Record<string, string>; body: Record<string, unknown>; headers?: Record<string, unknown>;
}

/** 调用路由并**解包** `{ ok, data }` 信封（router.json 的既有约定） */
async function call(
  method: string, path: string,
  opts: { query?: Record<string, string>; body?: Record<string, unknown>; headers?: Record<string, unknown> } = {},
): Promise<{ status: number; data: Record<string, unknown>; error?: string }> {
  const m = matchRoute(method as never, path);
  if (!m) throw new Error(`路由未注册：${method} ${path}`);
  const req: FakeReq = {
    method, path, params: m.params ?? {}, query: opts.query ?? {}, body: opts.body ?? {},
    ...(opts.headers ? { headers: opts.headers } : {}),
  };
  const res = await m.handler(req as never);
  const raw = res.body as { ok?: boolean; data?: unknown; error?: string } | undefined;
  return {
    status: res.status,
    data: (raw?.data ?? {}) as Record<string, unknown>,
    ...(raw?.error !== undefined ? { error: raw.error } : {}),
  };
}

const W1 = 'agent-worker-1';
const DIRECTOR = 'agent-prime_director-1';

describe('P0a · A2A REST 面', () => {
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
    resetServerIdentityCache();
    clearRoutes(); registerA2ARoutes();

    registerAgent(mkAgent('prime_director', DIRECTOR));
    registerAgent(mkAgent('worker', W1));
    registerAgent(mkAgent('auditor', 'agent-auditor-1'), { allowGovernance: true });
    setAgentParent(W1, DIRECTOR);   // 卡片可见性依赖注册表父关系
    issueCardForAgent(mkAgent('prime_director', DIRECTOR), { cardVersion: 1 });
    issueCardForAgent(mkAgent('worker', W1), { cardVersion: 1, father: { agentId: DIRECTOR, role: 'prime_director' }, lineage: [DIRECTOR] });

    // 一条域内消息（要求确认）+ 一条跨域消息
    sendA2A({ sourceAgentId: DIRECTOR, targetAgentId: W1, kind: 'query', taskId: 't1', payload: { text: '域内正文' }, requiresAck: true });
    sendA2A({
      sourceAgentId: W1, targetAgentId: 'agent-unknown-9', kind: 'query', taskId: 't1',
      payload: { text: '跨域正文机密' }, summary: '跨域摘要',
    });
  });
  afterEach(() => {
    clearRoutes(); resetServerIdentityCache(); closeDatabase(); clearMigrations();
    if (existsSync(DIR)) rmSync(DIR, { recursive: true, force: true });
  });

  it('① 身份门：令牌验真失败 → 403（fail-closed，不降级为本地账号）', async () => {
    const res = await call('GET', '/api/a2a/messages', { headers: { authorization: 'Bearer dead-token' } });
    expect(res.status).toBe(403);
    expect(String(res.error ?? '')).toContain('身份验真失败');
  });

  it('② 无令牌 → 本地活动账号视角（所有者）：全部正文可见', async () => {
    const res = await call('GET', '/api/a2a/messages', { query: { taskId: 't1' } });
    expect(res.status).toBe(200);
    const items = res.data['items'] as Array<Record<string, unknown>>;
    expect(items.length).toBe(2);
    expect(items.every(i => i['redacted'] === false)).toBe(true);
  });

  it('② ★ agent 视角：跨域消息 payload 为空、redacted=true（后端摘除，非前端隐藏）', async () => {
    const res = await call('GET', '/api/a2a/messages', { query: { taskId: 't1', viewerAgentId: DIRECTOR } });
    expect(res.status).toBe(200);
    const items = res.data['items'] as Array<Record<string, unknown>>;
    const cross = items.find(i => i['redacted'] === true)!;
    expect(JSON.stringify(cross['payload'])).not.toContain('跨域正文机密');
    expect(cross['payload']).toEqual({});
    expect(cross['summary']).toBe('跨域摘要');
    expect(cross['redactedReason']).toBe('cross_domain_summary_only');
    expect((res.data['viewer'] as Record<string, unknown>)['tier']).toBe('L1');
  });

  it('② 未注册 agent 视角 → 404（不得伪造视角）', async () => {
    const res = await call('GET', '/api/a2a/messages', { query: { viewerAgentId: 'agent-ghost-1' } });
    expect(res.status).toBe(404);
  });

  it('③ 治理队列：所有者可读；worker 视角 403', async () => {
    sendA2A({ sourceAgentId: W1, targetAgentId: 'governance:inbox', kind: 'escalate', taskId: 't1', payload: { reason: 'x' } });
    const owner = await call('GET', '/api/a2a/inbox');
    expect(owner.status).toBe(200);
    expect((owner.data['items'] as unknown[]).length).toBe(1);

    const worker = await call('GET', '/api/a2a/inbox', { query: { viewerAgentId: W1 } });
    expect(worker.status).toBe(403);

    const drained = await call('POST', '/api/a2a/inbox/drain', { body: { max: 5 } });
    expect(drained.status).toBe(200);
    expect((drained.data['drained'] as unknown[]).length).toBe(1);
  });

  it('③ 申请查看被摘除正文：worker 视角 403（指引走审批门）；所有者可见全文', async () => {
    const msg = listMessages({ taskId: 't1' }).find(m => m.envelope.targetAgentId === 'agent-unknown-9')!;
    const denied = await call('POST', '/api/a2a/reveal', { body: { messageId: msg.envelope.messageId }, query: { viewerAgentId: W1 } });
    expect(denied.status).toBe(403);

    const owner = await call('POST', '/api/a2a/reveal', { body: { messageId: msg.envelope.messageId } });
    expect(owner.status).toBe(200);
    expect(JSON.stringify(owner.data['payload'])).toContain('跨域正文机密');
  });

  it('④ 处置告警：所有者（user）可 warned；worker 视角 403（非 L0 被治理门拦）', async () => {
    persistAlert({
      alertId: 'alert-C1-api', ruleId: 'C1', severity: 'medium', participants: [W1, DIRECTOR],
      taskId: 't1', evidence: {}, disposition: 'pending', raisedAt: Date.now(), ownerUserId: 'alice',
    } as CollusionAlert);

    const denied = await call('POST', '/api/a2a/alerts/alert-C1-api/dispose', {
      body: { disposition: 'warned' }, query: { viewerAgentId: W1 },
    });
    expect(denied.status).toBe(403);

    const owner = await call('POST', '/api/a2a/alerts/alert-C1-api/dispose', { body: { disposition: 'warned', reason: '首次提醒' } });
    expect(owner.status).toBe(200);
    expect(owner.data['disposition']).toBe('warned');
  });

  it('④ 告警查询：L1 视角仅计数（证据不返回）', async () => {
    persistAlert({
      alertId: 'alert-C1-api2', ruleId: 'C1', severity: 'high', participants: [W1, DIRECTOR],
      taskId: 't1', evidence: { secret: '证据' }, disposition: 'pending', raisedAt: Date.now(), ownerUserId: 'alice',
    } as CollusionAlert);
    const l1 = await call('GET', '/api/a2a/alerts', { query: { viewerAgentId: DIRECTOR } });
    expect(l1.status).toBe(200);
    expect(l1.data['count']).toBe(1);
    expect(l1.data['items']).toEqual([]);
    expect(l1.data['evidenceRedacted']).toBe(true);
  });

  it('⑤ ack：接收方可确认；非接收方 403；不要求确认的消息 409', async () => {
    const ackable = listMessages({ taskId: 't1' }).find(m => m.envelope.requiresAck && m.verdict === 'allow')!;
    const wrong = await call('POST', '/api/a2a/ack', { body: { messageId: ackable.envelope.messageId }, query: { viewerAgentId: DIRECTOR } });
    expect(wrong.status).toBe(403);          // director 是发送方

    const okAck = await call('POST', '/api/a2a/ack', { body: { messageId: ackable.envelope.messageId }, query: { viewerAgentId: W1 } });
    expect(okAck.status).toBe(200);
    expect(okAck.data['acked']).toBe(true);

    const cross = listMessages({ taskId: 't1' }).find(m => m.envelope.targetAgentId === 'agent-unknown-9')!;
    const noAckNeeded = await call('POST', '/api/a2a/ack', { body: { messageId: cross.envelope.messageId } });
    expect(noAckNeeded.status).toBe(409);
  });

  it('④b 角色绑定不降级：auditor 请求 arbitrated → 409（授权通过但角色不匹配）', async () => {
    persistAlert({
      alertId: 'alert-C1-api3', ruleId: 'C1', severity: 'high', participants: [W1, DIRECTOR],
      taskId: 't1', evidence: {}, disposition: 'pending', raisedAt: Date.now(), ownerUserId: 'alice',
    } as CollusionAlert);
    const res = await call('POST', '/api/a2a/alerts/alert-C1-api3/dispose', {
      body: { disposition: 'arbitrated' }, query: { viewerAgentId: 'agent-auditor-1' },
    });
    expect(res.status).toBe(409);
    expect(String(res.error ?? '')).toContain('需角色 arbitrator');
  });
  it('卡片：worker 视角只能看自己与直达父', async () => {
    const self = await call('GET', `/api/a2a/cards/${W1}`, { query: { viewerAgentId: W1 } });
    expect(self.status).toBe(200);
    const father = await call('GET', `/api/a2a/cards/${DIRECTOR}`, { query: { viewerAgentId: W1 } });
    expect(father.status).toBe(200);
    const l0Card = await call('GET', '/api/a2a/cards/agent-auditor-1', { query: { viewerAgentId: W1 } });
    expect(l0Card.status).toBe(403);
  });
});
