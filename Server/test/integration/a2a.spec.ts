/**
 * 集成测试：A2A 对话消息镜像（P0c）
 *
 * 覆盖（设计 §15）：
 *  - bulk upsert **幂等**（同 messageId 重复上行不产生重复项，且可更新）
 *  - **账号隔离**（B 看不到 A 的消息）
 *  - **游标增量拉取**（`(created_at, message_id)` 键集分页，不重不漏）
 *  - **服务端二次脱敏**（密钥/令牌模式 → 占位符 + 记录 `redactedFields`；敏感键名直接替换）
 *  - **限额截断**（>64KB 载荷 → `truncated=true`，**保留 contentHash**）
 *  - 卡片镜像上行（幂等）
 *  - 契约校验（批量上限、枚举值）与认证（无令牌 → 401）
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { getTestDb, isDbAvailable, truncateAll, closeTestDb } from '../helpers/pg.js';
import { buildTestApp, createClient, dataOf, type TestApp, type TestClient, type AuthedUser } from '../helpers/app.js';
import type { Db } from '../../src/db/pool.js';

const dbAvailable = await isDbAvailable();
const d = dbAvailable ? describe : describe.skip;

interface A2AMessageDto {
  messageId: string; taskId: string; kind: string; sourceAgentId: string; targetAgentId: string;
  visibility: string; contentHash: string; prevHash: string | null; payload: unknown;
  verdict: string; memoryRefs: unknown; redactedFields: string[]; truncated: boolean; createdAt: number;
}
interface ListData { items: A2AMessageDto[]; nextCursor: string | null; total: number }

const NOW = 1_800_000_000_000;

function msg(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    messageId: 'm-1', taskId: 't1', traceId: 't1', kind: 'answer',
    sourceAgentId: 'agent-worker-1', targetAgentId: 'agent-prime_director-1',
    visibility: 'domain', contentHash: 'hash-1', verdict: 'allow',
    payload: { text: '解析层已完成' }, createdAt: NOW,
    ...over,
  };
}

d('A2A 镜像（集成）', () => {
  let db: Db;
  let t: TestApp;
  let api: TestClient;
  let user: AuthedUser;
  let token: string;

  beforeAll(async () => { db = await getTestDb(); });
  beforeEach(async () => {
    await truncateAll(db);
    t = await buildTestApp(db);
    api = createClient(t.app);
    user = await api.register(`a2a-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`);
    token = user.tokens.accessToken;
  });
  afterEach(async () => { await t.close(); });
  afterAll(async () => { await closeTestDb(); });

  it('认证：无令牌 → 401', async () => {
    const res = await api.post('/v1/a2a/messages/bulk', { items: [msg()] });
    expect(res.status).toBe(401);
  });

  it('★ bulk upsert 幂等：重复上行不新增，且可更新', async () => {
    const first = await api.post<{ created: number; updated: number }>('/v1/a2a/messages/bulk', { items: [msg()] }, token);
    expect(first.status).toBe(200);
    expect(dataOf(first).created).toBe(1);

    const again = await api.post<{ created: number; updated: number }>('/v1/a2a/messages/bulk', { items: [msg()] }, token);
    expect(dataOf(again).created).toBe(0);
    expect(dataOf(again).updated).toBe(1);

    const updated = await api.post<{ updated: number }>('/v1/a2a/messages/bulk', {
      items: [msg({ payload: { text: '更新后的内容' }, verdict: 'block' })],
    }, token);
    expect(dataOf(updated).updated).toBe(1);

    const list = dataOf<ListData>(await api.get<ListData>('/v1/a2a/messages?taskId=t1', token));
    expect(list.items.length).toBe(1);
    expect(list.items[0]!.verdict).toBe('block');
  });

  it('★ 账号隔离：B 看不到 A 的消息', async () => {
    await api.post('/v1/a2a/messages/bulk', { items: [msg()] }, token);
    const other = await api.register(`b-${Date.now()}@test.local`);
    const otherList = dataOf<ListData>(await api.get<ListData>('/v1/a2a/messages', other.tokens.accessToken));
    expect(otherList.items.length).toBe(0);
    const ownList = dataOf<ListData>(await api.get<ListData>('/v1/a2a/messages', token));
    expect(ownList.items.length).toBe(1);
  });

  it('★ 游标增量拉取：limit=2 分页不重不漏', async () => {
    const items = [1, 2, 3, 4, 5].map(i => msg({ messageId: `m-${i}`, contentHash: `hash-${i}`, createdAt: NOW + i }));
    await api.post('/v1/a2a/messages/bulk', { items }, token);

    const page1 = dataOf<ListData>(await api.get<ListData>('/v1/a2a/messages?taskId=t1&limit=2', token));
    expect(page1.items.map(i => i.messageId)).toEqual(['m-1', 'm-2']);
    expect(page1.nextCursor).toBeTruthy();

    const page2 = dataOf<ListData>(await api.get<ListData>(
      `/v1/a2a/messages?taskId=t1&limit=2&cursor=${encodeURIComponent(page1.nextCursor!)}`, token));
    expect(page2.items.map(i => i.messageId)).toEqual(['m-3', 'm-4']);

    const page3 = dataOf<ListData>(await api.get<ListData>(
      `/v1/a2a/messages?taskId=t1&limit=2&cursor=${encodeURIComponent(page2.nextCursor!)}`, token));
    expect(page3.items.map(i => i.messageId)).toEqual(['m-5']);
    expect(page3.nextCursor).toBeNull();
  });

  it('按 agent 过滤（发送方或接收方命中）', async () => {
    await api.post('/v1/a2a/messages/bulk', { items: [
      msg({ messageId: 'm-1' }),
      msg({ messageId: 'm-2', sourceAgentId: 'agent-other-9', targetAgentId: 'agent-other-8' }),
    ] }, token);
    const mine = dataOf<ListData>(await api.get<ListData>('/v1/a2a/messages?agentId=agent-worker-1', token));
    expect(mine.items.map(i => i.messageId)).toEqual(['m-1']);
  });

  it('★ 服务端二次脱敏：密钥模式替换 + 记录字段路径；敏感键名直接替换', async () => {
    const res = await api.post('/v1/a2a/messages/bulk', { items: [
      msg({
        messageId: 'm-secret',
        payload: {
          note: 'token is sk-abcdefghijklmnopqrstuvwxyz123456 now',
          apiKey: 'plain-value',
          nested: { authorization: 'Bearer abcdefghijklmnopqrstuvwxyz' },
        },
      }),
    ] }, token);
    expect(res.status).toBe(200);

    const list = dataOf<ListData>(await api.get<ListData>('/v1/a2a/messages?taskId=t1', token));
    const payload = list.items[0]!.payload as Record<string, unknown>;
    expect(JSON.stringify(payload)).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456');
    expect(JSON.stringify(payload)).toContain('«redacted:secret»');
    expect(payload['apiKey']).toBe('«redacted:secret»');
    expect((payload['nested'] as Record<string, unknown>)['authorization']).toBe('«redacted:secret»');
    expect(list.items[0]!.redactedFields.length).toBeGreaterThan(0);
  });

  it('★ 限额截断：>64KB 载荷 → truncated=true 且保留 contentHash', async () => {
    const big = 'x'.repeat(70 * 1024);
    await api.post('/v1/a2a/messages/bulk', { items: [
      msg({ messageId: 'm-big', contentHash: 'hash-big', payload: { text: big } }),
    ] }, token);
    const list = dataOf<ListData>(await api.get<ListData>('/v1/a2a/messages?taskId=t1', token));
    expect(list.items[0]!.truncated).toBe(true);
    expect(list.items[0]!.contentHash).toBe('hash-big');
    expect(JSON.stringify(list.items[0]!.payload)).not.toContain(big.slice(0, 100));
  });

  it('卡片镜像上行（幂等）', async () => {
    const card = {
      cardId: 'card-agent-worker-1-v1', agentId: 'agent-worker-1', cardVersion: 1, role: 'worker',
      createTime: NOW, fatherAgentId: 'agent-prime_director-1', fatherRole: 'prime_director',
      lineage: ['agent-prime_director-1'], status: 'ready',
      ability: { tools: ['file.read'] }, permission: { tier: 'L2' },
      fingerprint: 'fp-1', expiresAt: NOW + 86_400_000,
    };
    const first = await api.post<{ created: number }>('/v1/a2a/cards/bulk', { items: [card] }, token);
    expect(dataOf(first).created).toBe(1);
    const again = await api.post<{ created: number; updated: number }>('/v1/a2a/cards/bulk', { items: [card] }, token);
    expect(dataOf(again).created).toBe(0);
    expect(dataOf(again).updated).toBe(1);
  });

  it('契约：批量上限与字段校验', async () => {
    const tooMany = await api.post('/v1/a2a/messages/bulk', {
      items: Array.from({ length: 501 }, (_, i) => msg({ messageId: `m-${i}` })),
    }, token);
    expect(tooMany.status).toBe(400);

    const badVerdict = await api.post('/v1/a2a/messages/bulk', {
      items: [msg({ verdict: 'unknown' })],
    }, token);
    expect(badVerdict.status).toBe(400);
  });
});
