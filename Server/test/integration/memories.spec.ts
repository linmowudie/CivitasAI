/**
 * 集成测试：记忆存储（幂等 upsert / 分页 / 中文与拉丁检索 / 软删除 / 批量 / 隔离）。
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { getTestDb, isDbAvailable, truncateAll, closeTestDb } from '../helpers/pg.js';
import { buildTestApp, createClient, dataOf, errorCodeOf, type TestApp, type TestClient, type AuthedUser } from '../helpers/app.js';
import type { Db } from '../../src/db/pool.js';

const dbAvailable = await isDbAvailable();
const d = dbAvailable ? describe : describe.skip;

interface MemoryDto {
  id: string;
  clientMemoryId: string | null;
  title: string;
  content: string;
  category: string;
  status: string;
  assertion: string;
  accessCount: number;
  createdAt: string;
}

interface PageDto {
  items: MemoryDto[];
  nextCursor: string | null;
}

d('记忆存储（集成）', () => {
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
    user = await api.register('memory@example.com');
  });
  afterEach(async () => {
    await t.close();
  });
  afterAll(async () => {
    await closeTestDb();
  });

  const token = () => user.tokens.accessToken;

  it('新建返回 201；同 clientMemoryId 再传 → 200 且原地更新（幂等）', async () => {
    const created = await api.post<{ memory: MemoryDto; created: boolean }>(
      '/v1/memories',
      {
        clientMemoryId: 'client-m-1',
        title: '项目偏好',
        content: '用户偏好暗色主题',
        category: 'preference',
        sourceTraceIds: ['trace-1'],
      },
      token(),
    );
    expect(created.status).toBe(201);
    const first = dataOf(created);
    expect(first.created).toBe(true);
    expect(first.memory.clientMemoryId).toBe('client-m-1');
    expect(first.memory.accessCount).toBe(0);

    const again = await api.post<{ memory: MemoryDto; created: boolean }>(
      '/v1/memories',
      { clientMemoryId: 'client-m-1', title: '项目偏好（更新）', content: '改为浅色主题' },
      token(),
    );
    expect(again.status).toBe(200);
    const second = dataOf(again);
    expect(second.created).toBe(false);
    expect(second.memory.id).toBe(first.memory.id); // 同一条记录
    expect(second.memory.title).toBe('项目偏好（更新）');
    expect(second.memory.content).toBe('改为浅色主题');

    const count = await db.one<{ count: number }>('SELECT COUNT(*)::int AS count FROM memories');
    expect(count?.count).toBe(1);
  });

  it('无 clientMemoryId 时每次新建独立记录', async () => {
    await api.post('/v1/memories', { title: 'a', content: 'x' }, token());
    await api.post('/v1/memories', { title: 'b', content: 'y' }, token());
    const list = dataOf(await api.get<PageDto>('/v1/memories', token()));
    expect(list.items).toHaveLength(2);
  });

  it('键集分页：limit + nextCursor 连续翻页且不重复', async () => {
    for (let i = 1; i <= 5; i++) {
      await api.post('/v1/memories', { title: `记忆${i}`, content: `内容${i}`, clientMemoryId: `m${i}` }, token());
      await new Promise((r) => setTimeout(r, 2)); // 保证 created_at 递增，分页稳定
    }

    const page1 = dataOf(await api.get<PageDto>('/v1/memories?limit=2', token()));
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBeTruthy();

    const page2 = dataOf(
      await api.get<PageDto>(`/v1/memories?limit=2&cursor=${encodeURIComponent(page1.nextCursor!)}`, token()),
    );
    expect(page2.items).toHaveLength(2);

    const page3 = dataOf(
      await api.get<PageDto>(`/v1/memories?limit=2&cursor=${encodeURIComponent(page2.nextCursor!)}`, token()),
    );
    expect(page3.items).toHaveLength(1);
    expect(page3.nextCursor).toBeNull();

    const ids = [...page1.items, ...page2.items, ...page3.items].map((m) => m.id);
    expect(new Set(ids).size).toBe(5);
  });

  it('检索：中文走 ILIKE、拉丁走全文检索；可按分类与状态过滤', async () => {
    await api.post('/v1/memories', { title: '部署流程', content: '服务器使用 docker compose 启动', category: 'ops' }, token());
    await api.post('/v1/memories', { title: 'deployment notes', content: 'use docker compose for release', category: 'ops' }, token());
    await api.post('/v1/memories', { title: '读书笔记', content: '关于分布式系统', category: 'reading' }, token());
    await api.post('/v1/memories', { title: '归档项', content: '服务器的旧记录', category: 'ops', status: 'archived' }, token());

    const cjk = dataOf(await api.get<PageDto>('/v1/memories?q=' + encodeURIComponent('服务器'), token()));
    expect(cjk.items).toHaveLength(2); // 部署流程 + 归档项（archived 仍在列表中，只是 status 不同）

    const latin = dataOf(await api.get<PageDto>('/v1/memories?q=deployment', token()));
    expect(latin.items).toHaveLength(1);
    expect(latin.items[0]?.title).toBe('deployment notes');

    const byCategory = dataOf(await api.get<PageDto>('/v1/memories?category=reading', token()));
    expect(byCategory.items).toHaveLength(1);

    const byStatus = dataOf(await api.get<PageDto>('/v1/memories?status=archived', token()));
    expect(byStatus.items).toHaveLength(1);
    expect(byStatus.items[0]?.status).toBe('archived');
  });

  it('更新（PATCH）与软删除（默认不出现在列表，hard=true 物理删除）', async () => {
    const created = dataOf(
      await api.post<{ memory: MemoryDto }>('/v1/memories', { title: '可更新', content: 'v1' }, token()),
    ).memory;

    const patched = dataOf(
      await api.patch<MemoryDto>(
        `/v1/memories/${created.id}`,
        { content: 'v2', accessCount: 7, status: 'archived' },
        token(),
      ),
    );
    expect(patched.content).toBe('v2');
    expect(patched.accessCount).toBe(7);
    expect(patched.status).toBe('archived');

    const softDeleted = await api.del<{ hard: boolean }>(`/v1/memories/${created.id}`, token());
    expect(dataOf(softDeleted).hard).toBe(false);

    const list = dataOf(await api.get<PageDto>('/v1/memories', token()));
    expect(list.items).toHaveLength(0);

    const stillThere = await db.one<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM memories WHERE status = 'deleted'`,
    );
    expect(stillThere?.count).toBe(1);

    // 详情仍可查（墓碑）
    const detail = await api.get<MemoryDto>(`/v1/memories/${created.id}`, token());
    expect(detail.status).toBe(200);

    // 重复删除 → 404
    expect((await api.del(`/v1/memories/${created.id}`, token())).status).toBe(404);
  });

  it('批量 upsert：区分新增与更新，且原子提交', async () => {
    await api.post('/v1/memories', { clientMemoryId: 'b1', title: '原有', content: 'c' }, token());

    const res = await api.post<{ created: number; updated: number; total: number }>(
      '/v1/memories/bulk',
      {
        items: [
          { clientMemoryId: 'b1', title: '原有（改）', content: 'c2' },
          { clientMemoryId: 'b2', title: '新增一', content: 'c3' },
          { clientMemoryId: 'b3', title: '新增二', content: 'c4' },
        ],
      },
      token(),
    );
    expect(res.status).toBe(200);
    expect(dataOf(res)).toEqual({ created: 2, updated: 1, total: 3 });

    const list = dataOf(await api.get<PageDto>('/v1/memories', token()));
    expect(list.items).toHaveLength(3);
  });

  it('批量超过上限 → 413（testConfig 上限 100）', async () => {
    const items = Array.from({ length: 101 }, (_, i) => ({ title: `t${i}`, content: 'c' }));
    const res = await api.post('/v1/memories/bulk', { items }, token());
    expect(res.status).toBe(413);
    expect(errorCodeOf(res)).toBe('PAYLOAD_TOO_LARGE');
  });

  it('用户隔离：不能读取/修改/删除他人记忆', async () => {
    const mine = dataOf(
      await api.post<{ memory: MemoryDto }>('/v1/memories', { title: '我的秘密', content: 'secret' }, token()),
    ).memory;

    const other = await api.register('memory-other@example.com');
    const otherToken = other.tokens.accessToken;

    expect((await api.get(`/v1/memories/${mine.id}`, otherToken)).status).toBe(404);
    expect((await api.patch(`/v1/memories/${mine.id}`, { content: '篡改' }, otherToken)).status).toBe(404);
    expect((await api.del(`/v1/memories/${mine.id}`, otherToken)).status).toBe(404);

    const otherList = dataOf(await api.get<PageDto>('/v1/memories', otherToken));
    expect(otherList.items).toHaveLength(0);

    // 原数据未被篡改
    const mineAfter = dataOf(await api.get<MemoryDto>(`/v1/memories/${mine.id}`, token()));
    expect(mineAfter.content).toBe('secret');
  });

  it('校验：标题必填、状态枚举非法 → 400；未鉴权 → 401', async () => {
    expect((await api.post('/v1/memories', { content: 'no title' }, token())).status).toBe(400);
    expect(
      (await api.post('/v1/memories', { title: 'x', content: 'y', status: 'weird' }, token())).status,
    ).toBe(400);
    expect((await api.get('/v1/memories')).status).toBe(401);
  });
});
