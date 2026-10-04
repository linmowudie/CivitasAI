/**
 * 集成测试：个人数据统计（批量上报幂等 / 区间汇总 / 按日时区分桶 / 概览 / 清空）。
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { getTestDb, isDbAvailable, truncateAll, closeTestDb } from '../helpers/pg.js';
import { buildTestApp, createClient, dataOf, errorCodeOf, type TestApp, type TestClient, type AuthedUser } from '../helpers/app.js';
import type { Db } from '../../src/db/pool.js';

const dbAvailable = await isDbAvailable();
const d = dbAvailable ? describe : describe.skip;

interface SummaryDto {
  from: string;
  to: string;
  totalEvents: number;
  totalValue: number;
  activeDays: number;
  byKind: { kind: string; count: number; value: number }[];
}

interface DailyDto {
  timezone: string;
  days: { day: string; kind: string; count: number; value: number }[];
}

interface OverviewDto {
  lifetime: { events: number; value: number; activeDays: number; firstAt: string | null; lastAt: string | null };
  memories: { total: number };
  settings: { revision: number };
  sessions: { active: number };
}

d('个人数据统计（集成）', () => {
  let db: Db;
  let t: TestApp;
  let api: TestClient;
  let user: AuthedUser;

  beforeAll(async () => {
    db = await getTestDb();
  });
  beforeEach(async () => {
    await truncateAll(db);
    t = await buildTestApp(db);
    api = createClient(t.app);
    user = await api.register('stats@example.com');
  });
  afterEach(async () => {
    await t.close();
  });
  afterAll(async () => {
    await closeTestDb();
  });

  const token = () => user.tokens.accessToken;

  it('批量上报：写入条数正确，clientEventId 幂等（重复上报不翻倍）', async () => {
    const events = [
      { kind: 'chat.turn', value: 120, occurredAt: '2026-03-01T01:00:00.000Z', clientEventId: 'e1' },
      { kind: 'chat.turn', value: 80, occurredAt: '2026-03-01T02:00:00.000Z', clientEventId: 'e2' },
      { kind: 'tool.call', value: 1, occurredAt: '2026-03-01T03:00:00.000Z', clientEventId: 'e3' },
    ];
    const first = await api.post<{ accepted: number; submitted: number }>(
      '/v1/stats/events',
      { events },
      token(),
    );
    expect(first.status).toBe(201);
    expect(dataOf(first)).toEqual({ accepted: 3, submitted: 3 });

    // 重复上报同一批（同 clientEventId）→ 全部忽略
    const again = await api.post<{ accepted: number; submitted: number }>(
      '/v1/stats/events',
      { events },
      token(),
    );
    expect(dataOf(again).accepted).toBe(0);

    const summary = dataOf(
      await api.get<SummaryDto>(
        '/v1/stats/summary?from=2026-03-01T00:00:00.000Z&to=2026-03-02T00:00:00.000Z',
        token(),
      ),
    );
    expect(summary.totalEvents).toBe(3);
    expect(summary.totalValue).toBe(201);
  });

  it('无 clientEventId 时允许重复写入（不误判为幂等）', async () => {
    const events = [{ kind: 'app.launch', value: 0, occurredAt: '2026-03-01T01:00:00.000Z' }];
    await api.post('/v1/stats/events', { events }, token());
    await api.post('/v1/stats/events', { events }, token());
    const summary = dataOf(
      await api.get<SummaryDto>(
        '/v1/stats/summary?from=2026-03-01T00:00:00.000Z&to=2026-03-02T00:00:00.000Z',
        token(),
      ),
    );
    expect(summary.totalEvents).toBe(2);
  });

  it('按种类汇总并按数量排序', async () => {
    await api.post(
      '/v1/stats/events',
      {
        events: [
          { kind: 'tool.call', value: 1, occurredAt: '2026-03-01T01:00:00.000Z' },
          { kind: 'tool.call', value: 1, occurredAt: '2026-03-01T02:00:00.000Z' },
          { kind: 'tool.call', value: 1, occurredAt: '2026-03-01T03:00:00.000Z' },
          { kind: 'chat.turn', value: 50, occurredAt: '2026-03-01T04:00:00.000Z' },
        ],
      },
      token(),
    );
    const summary = dataOf(
      await api.get<SummaryDto>(
        '/v1/stats/summary?from=2026-03-01T00:00:00.000Z&to=2026-03-02T00:00:00.000Z',
        token(),
      ),
    );
    expect(summary.byKind[0]).toMatchObject({ kind: 'tool.call', count: 3, value: 3 });
    expect(summary.byKind[1]).toMatchObject({ kind: 'chat.turn', count: 1, value: 50 });
  });

  it('按日分桶遵循配置时区（Asia/Shanghai）：UTC 16:30 归到次日', async () => {
    await api.post(
      '/v1/stats/events',
      {
        events: [
          { kind: 'chat.turn', value: 10, occurredAt: '2026-03-01T15:30:00.000Z' }, // 沪 03-01 23:30
          { kind: 'chat.turn', value: 20, occurredAt: '2026-03-01T16:30:00.000Z' }, // 沪 03-02 00:30
        ],
      },
      token(),
    );
    const daily = dataOf(
      await api.get<DailyDto>(
        '/v1/stats/daily?from=2026-02-28T00:00:00.000Z&to=2026-03-04T00:00:00.000Z',
        token(),
      ),
    );
    expect(daily.timezone).toBe('Asia/Shanghai');
    const days = daily.days.map((x) => x.day);
    expect(days).toEqual(['2026-03-01', '2026-03-02']);
    expect(daily.days.find((x) => x.day === '2026-03-02')?.value).toBe(20);

    // 只看某一种类
    const filtered = dataOf(
      await api.get<DailyDto>(
        '/v1/stats/daily?from=2026-02-28T00:00:00.000Z&to=2026-03-04T00:00:00.000Z&kind=tool.call',
        token(),
      ),
    );
    expect(filtered.days).toHaveLength(0);
  });

  it('缺省区间为最近 30 天；活跃天数去重统计', async () => {
    const now = Date.now();
    await api.post(
      '/v1/stats/events',
      {
        events: [
          { kind: 'a', value: 1, occurredAt: new Date(now - 1000).toISOString() },
          { kind: 'a', value: 1, occurredAt: new Date(now - 2000).toISOString() },
          { kind: 'a', value: 1, occurredAt: new Date(now - 40 * 86_400_000).toISOString() }, // 范围外
        ],
      },
      token(),
    );
    const summary = dataOf(await api.get<SummaryDto>('/v1/stats/summary', token()));
    expect(summary.totalEvents).toBe(2);
    expect(summary.activeDays).toBe(1);

    const lifetime = dataOf(await api.get<OverviewDto>('/v1/stats/overview', token()));
    expect(lifetime.lifetime.events).toBe(3); // 概览统计终身
  });

  it('概览包含记忆数、设置版本与活跃设备数', async () => {
    await api.post('/v1/stats/events', {
      events: [{ kind: 'a', value: 5, occurredAt: new Date().toISOString() }],
    }, token());
    await api.post('/v1/memories', { title: '记忆一', content: '内容' }, token());
    await api.post('/v1/memories', { title: '记忆二', content: '内容' }, token());
    await api.put('/v1/settings', { data: { theme: 'dark' } }, token());

    const overview = dataOf(await api.get<OverviewDto>('/v1/stats/overview', token()));
    expect(overview.lifetime.events).toBe(1);
    expect(overview.lifetime.value).toBe(5);
    expect(overview.memories.total).toBe(2);
    expect(overview.settings.revision).toBe(1);
    expect(overview.sessions.active).toBe(1);
  });

  it('清空统计事件', async () => {
    await api.post('/v1/stats/events', {
      events: [{ kind: 'a', value: 1, occurredAt: new Date().toISOString() }],
    }, token());
    const cleared = dataOf(await api.del<{ deleted: number }>('/v1/stats/events', token()));
    expect(cleared.deleted).toBe(1);
    const summary = dataOf(await api.get<SummaryDto>('/v1/stats/summary', token()));
    expect(summary.totalEvents).toBe(0);
  });

  it('校验：空数组 / 非法时间 / 超过单批上限 → 400，超限 → 413', async () => {
    expect((await api.post('/v1/stats/events', { events: [] }, token())).status).toBe(400);
    expect(
      (await api.post('/v1/stats/events', { events: [{ kind: 'a', occurredAt: 'not-a-date' }] }, token())).status,
    ).toBe(400);

    // testConfig: maxStatsEventsPerBatch = 50
    const many = Array.from({ length: 51 }, (_, i) => ({
      kind: 'a',
      value: 1,
      occurredAt: new Date(Date.now() + i).toISOString(),
    }));
    const tooMany = await api.post('/v1/stats/events', { events: many }, token());
    expect(tooMany.status).toBe(413);
    expect(errorCodeOf(tooMany)).toBe('PAYLOAD_TOO_LARGE');
  });

  it('统计在用户间隔离', async () => {
    await api.post('/v1/stats/events', {
      events: [{ kind: 'a', value: 9, occurredAt: new Date().toISOString() }],
    }, token());
    const other = await api.register('stats-other@example.com');
    const otherSummary = dataOf(await api.get<SummaryDto>('/v1/stats/summary', other.tokens.accessToken));
    expect(otherSummary.totalEvents).toBe(0);
  });
});
