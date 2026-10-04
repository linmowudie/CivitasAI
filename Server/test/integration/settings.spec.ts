/**
 * 集成测试：设置管理（修订号乐观并发 / 浅合并 / 体积上限 / 重置）。
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { getTestDb, isDbAvailable, truncateAll, closeTestDb } from '../helpers/pg.js';
import { buildTestApp, createClient, dataOf, errorCodeOf, type TestApp, type TestClient, type AuthedUser } from '../helpers/app.js';
import type { Db } from '../../src/db/pool.js';

const dbAvailable = await isDbAvailable();
const d = dbAvailable ? describe : describe.skip;

interface SettingsDto {
  revision: number;
  data: Record<string, unknown>;
  updatedAt: string;
}

d('设置管理（集成）', () => {
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
    user = await api.register('settings@example.com');
  });
  afterEach(async () => {
    await t.close();
  });
  afterAll(async () => {
    await closeTestDb();
  });

  it('初始为空（revision=0），写入后 revision=1 且可读回', async () => {
    const empty = await api.get<SettingsDto>('/v1/settings', user.tokens.accessToken);
    expect(dataOf(empty)).toMatchObject({ revision: 0, data: {} });

    const put = await api.put<SettingsDto>(
      '/v1/settings',
      { data: { theme: 'dark', ui: { fontScale: 1.1 } } },
      user.tokens.accessToken,
    );
    expect(put.status).toBe(200);
    expect(dataOf(put).revision).toBe(1);

    const read = await api.get<SettingsDto>('/v1/settings', user.tokens.accessToken);
    expect(dataOf(read).data).toEqual({ theme: 'dark', ui: { fontScale: 1.1 } });
  });

  it('每次写入 revision 递增（服务端权威）', async () => {
    const r1 = dataOf(await api.put<SettingsDto>('/v1/settings', { data: { a: 1 } }, user.tokens.accessToken));
    const r2 = dataOf(await api.put<SettingsDto>('/v1/settings', { data: { a: 2 } }, user.tokens.accessToken));
    const r3 = dataOf(await api.put<SettingsDto>('/v1/settings', { data: { a: 3 } }, user.tokens.accessToken));
    expect([r1.revision, r2.revision, r3.revision]).toEqual([1, 2, 3]);
  });

  it('乐观并发：expectedRevision 不匹配 → 409 REVISION_MISMATCH（附当前版本）', async () => {
    await api.put('/v1/settings', { data: { a: 1 } }, user.tokens.accessToken);

    const stale = await api.put(
      '/v1/settings',
      { data: { a: 2 }, expectedRevision: 0 },
      user.tokens.accessToken,
    );
    expect(stale.status).toBe(409);
    expect(errorCodeOf(stale)).toBe('REVISION_MISMATCH');
    const details = stale.body.ok ? undefined : (stale.body.error.details as Record<string, unknown> | undefined);
    expect(details?.['currentRevision']).toBe(1);

    const fresh = await api.put<SettingsDto>(
      '/v1/settings',
      { data: { a: 2 }, expectedRevision: 1 },
      user.tokens.accessToken,
    );
    expect(fresh.status).toBe(200);
    expect(dataOf(fresh).revision).toBe(2);
  });

  it('PATCH 浅合并；null 删除键', async () => {
    await api.put('/v1/settings', { data: { theme: 'dark', lang: 'zh', keep: true } }, user.tokens.accessToken);

    const patched = await api.patch<SettingsDto>(
      '/v1/settings',
      { patch: { theme: 'light', lang: null, added: 42 } },
      user.tokens.accessToken,
    );
    expect(dataOf(patched).data).toEqual({ theme: 'light', keep: true, added: 42 });
    expect(dataOf(patched).revision).toBe(2);
  });

  it('PATCH 也支持乐观并发', async () => {
    await api.put('/v1/settings', { data: { a: 1 } }, user.tokens.accessToken);
    const conflict = await api.patch(
      '/v1/settings',
      { patch: { a: 2 }, expectedRevision: 5 },
      user.tokens.accessToken,
    );
    expect(conflict.status).toBe(409);
  });

  it('超过体积上限 → 413（含合并后的总体积）', async () => {
    const big = { blob: 'x'.repeat(5000) }; // testConfig 上限 4096 字节
    const res = await api.put('/v1/settings', { data: big }, user.tokens.accessToken);
    expect(res.status).toBe(413);
    expect(errorCodeOf(res)).toBe('PAYLOAD_TOO_LARGE');

    // 分多次 patch 也不能绕过：合并后的总体积仍受上限约束
    await api.put('/v1/settings', { data: { first: 'x'.repeat(3000) } }, user.tokens.accessToken);
    const patchBig = await api.patch(
      '/v1/settings',
      { patch: { second: 'y'.repeat(3000) } }, // 3000 + 3000 > 4096
      user.tokens.accessToken,
    );
    expect(patchBig.status).toBe(413);
  });

  it('重置设置后回到 revision=0', async () => {
    await api.put('/v1/settings', { data: { a: 1 } }, user.tokens.accessToken);
    const reset = await api.del<{ reset: boolean }>('/v1/settings', user.tokens.accessToken);
    expect(dataOf(reset).reset).toBe(true);
    const after = await api.get<SettingsDto>('/v1/settings', user.tokens.accessToken);
    expect(dataOf(after)).toMatchObject({ revision: 0, data: {} });
  });

  it('未鉴权访问 → 401；用户间设置互相隔离', async () => {
    expect((await api.get('/v1/settings')).status).toBe(401);

    const other = await api.register('other-settings@example.com');
    await api.put('/v1/settings', { data: { mine: true } }, user.tokens.accessToken);
    const otherRead = await api.get<SettingsDto>('/v1/settings', other.tokens.accessToken);
    expect(dataOf(otherRead).data).toEqual({});
  });

  it('请求体缺 data 字段 → 400', async () => {
    const res = await api.put('/v1/settings', { wrong: true }, user.tokens.accessToken);
    expect(res.status).toBe(400);
    expect(errorCodeOf(res)).toBe('VALIDATION_ERROR');
  });
});
