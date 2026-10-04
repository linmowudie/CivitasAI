/**
 * 集成测试：任务（会话）元数据 —— 标题 + 归档状态。
 *
 * 覆盖：
 *  - upsert 幂等（同一 clientSessionId 重复上行不产生重复项）；
 *  - 归档状态后端权威（archivedAt 置值/清空）；
 *  - 按归档状态过滤（active / archived / all）；
 *  - 账号隔离（B 看不到 A 的任务，批量上行也只落自己名下）；
 *  - 备份包包含任务元数据，且 replace 恢复能重建归档状态。
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { getTestDb, isDbAvailable, truncateAll, closeTestDb } from '../helpers/pg.js';
import { buildTestApp, createClient, dataOf, type TestApp, type TestClient, type AuthedUser } from '../helpers/app.js';
import type { Db } from '../../src/db/pool.js';

const dbAvailable = await isDbAvailable();
const d = dbAvailable ? describe : describe.skip;

interface TaskDto {
  clientSessionId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}
interface TaskListData {
  items: TaskDto[];
  total: number;
}

const NOW = 1_800_000_000_000;

d('任务元数据（集成）', () => {
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
    user = await api.register(`tasks-${Date.now()}@example.com`);
  });
  afterEach(async () => {
    await t.close();
  });
  afterAll(async () => {
    await closeTestDb();
  });

  const token = () => user.tokens.accessToken;

  it('批量上行后可按归档状态查询；重复上行幂等', async () => {
    const first = dataOf(await api.post<{ created: number; updated: number }>(
      '/v1/tasks/bulk',
      {
        items: [
          { clientSessionId: 'sess-1', title: '任务一', createdAt: NOW, updatedAt: NOW },
          { clientSessionId: 'sess-2', title: '任务二', createdAt: NOW, updatedAt: NOW + 1 },
        ],
      },
      token(),
    ));
    expect(first.created).toBe(2);
    expect(first.updated).toBe(0);

    // 再次上行同一批 → 全部为 updated，不产生重复
    const again = dataOf(await api.post<{ created: number; updated: number }>(
      '/v1/tasks/bulk',
      { items: [{ clientSessionId: 'sess-1', title: '任务一（改名）', createdAt: NOW, updatedAt: NOW + 5 }] },
      token(),
    ));
    expect(again.created).toBe(0);
    expect(again.updated).toBe(1);

    const all = dataOf(await api.get<TaskListData>('/v1/tasks', token()));
    expect(all.items).toHaveLength(2);
    expect(all.items.find((i) => i.clientSessionId === 'sess-1')?.title).toBe('任务一（改名）');
  });

  it('归档状态：置值后可筛选，清空后回到未归档', async () => {
    await api.post('/v1/tasks/bulk', {
      items: [
        { clientSessionId: 'keep', title: '保留', createdAt: NOW, updatedAt: NOW },
        { clientSessionId: 'old', title: '旧任务', createdAt: NOW, updatedAt: NOW + 1, archivedAt: NOW + 2 },
      ],
    }, token());

    const active = dataOf(await api.get<TaskListData>('/v1/tasks?archived=false', token()));
    expect(active.items.map((i) => i.clientSessionId)).toEqual(['keep']);

    const archived = dataOf(await api.get<TaskListData>('/v1/tasks?archived=true', token()));
    expect(archived.items.map((i) => i.clientSessionId)).toEqual(['old']);
    expect(archived.items[0]!.archivedAt).toBe(NOW + 2);

    const all = dataOf(await api.get<TaskListData>('/v1/tasks?archived=all', token()));
    expect(all.items).toHaveLength(2);

    // 取消归档（archivedAt 清空）
    await api.post('/v1/tasks/bulk', {
      items: [{ clientSessionId: 'old', title: '旧任务', createdAt: NOW, updatedAt: NOW + 9, archivedAt: null }],
    }, token());
    const activeAfter = dataOf(await api.get<TaskListData>('/v1/tasks?archived=false', token()));
    expect(activeAfter.items.map((i) => i.clientSessionId).sort()).toEqual(['keep', 'old']);
  });

  it('账号隔离：B 看不到 A 的任务', async () => {
    await api.post('/v1/tasks/bulk', {
      items: [{ clientSessionId: 'a-1', title: 'A 的任务', createdAt: NOW, updatedAt: NOW }],
    }, token());

    const other = await api.register(`tasks-b-${Date.now()}@example.com`);
    const bList = dataOf(await api.get<TaskListData>('/v1/tasks', other.tokens.accessToken));
    expect(bList.items).toHaveLength(0);

    // B 上行同名 clientSessionId 也只落在 B 名下，不影响 A
    await api.post('/v1/tasks/bulk', {
      items: [{ clientSessionId: 'a-1', title: 'B 的同名任务', createdAt: NOW, updatedAt: NOW }],
    }, other.tokens.accessToken);

    const aList = dataOf(await api.get<TaskListData>('/v1/tasks', token()));
    expect(aList.items).toHaveLength(1);
    expect(aList.items[0]!.title).toBe('A 的任务');
  });

  it('校验：空 items / 缺少时间戳 / 超 500 条 均 400', async () => {
    expect((await api.post('/v1/tasks/bulk', { items: [] }, token())).status).toBe(400);
    expect((await api.post('/v1/tasks/bulk', { items: [{ clientSessionId: 'x' }] }, token())).status).toBe(400);
    const tooMany = Array.from({ length: 501 }, (_, i) => ({
      clientSessionId: `s-${i}`, title: 't', createdAt: NOW, updatedAt: NOW,
    }));
    expect((await api.post('/v1/tasks/bulk', { items: tooMany }, token())).status).toBe(400);
  });

  it('未鉴权无法读写任务', async () => {
    expect((await api.get('/v1/tasks')).status).toBe(401);
    expect((await api.post('/v1/tasks/bulk', { items: [{ clientSessionId: 'x', createdAt: NOW, updatedAt: NOW }] })).status).toBe(401);
  });

  it('★ 备份包含任务元数据；replace 恢复后归档状态完整回来', async () => {
    await api.post('/v1/tasks/bulk', {
      items: [
        { clientSessionId: 'sess-a', title: '正常任务', createdAt: NOW, updatedAt: NOW },
        { clientSessionId: 'sess-b', title: '已归档任务', createdAt: NOW, updatedAt: NOW + 1, archivedAt: NOW + 2 },
      ],
    }, token());

    const bundle = dataOf(await api.get<{ tasks?: TaskDto[] }>('/v1/backup', token()));
    expect(bundle.tasks).toHaveLength(2);
    expect(bundle.tasks!.find((x) => x.clientSessionId === 'sess-b')?.archivedAt).toBe(NOW + 2);

    // 模拟重装：清空服务端任务元数据后再恢复
    await db.execute('DELETE FROM user_tasks WHERE user_id = $1', [user.user.id]);
    expect(dataOf(await api.get<TaskListData>('/v1/tasks', token())).items).toHaveLength(0);

    const report = dataOf(await api.post<{ tasks?: { created: number; total: number } }>(
      '/v1/restore',
      { bundle, mode: 'replace' },
      token(),
    ));
    expect(report.tasks?.created).toBe(2);

    const restored = dataOf(await api.get<TaskListData>('/v1/tasks?archived=true', token()));
    expect(restored.items.map((i) => i.clientSessionId)).toEqual(['sess-b']);
    expect(restored.items[0]!.title).toBe('已归档任务');
  });
});
