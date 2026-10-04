/**
 * 集成测试：平台行为（健康检查 / 统一响应约定 / 404 / 限流 / 安全响应头 / 迁移幂等）。
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { getTestDb, isDbAvailable, truncateAll, closeTestDb } from '../helpers/pg.js';
import {
  buildTestApp, createClient, dataOf, errorCodeOf, headerOf, testConfig,
  type TestApp, type TestClient,
} from '../helpers/app.js';
import { createDb, type Db } from '../../src/db/pool.js';
import { runMigrations, loadMigrations, listApplied } from '../../src/db/migrate.js';
import { SERVER_ROOT } from '../../src/config.js';
import { resolve } from 'node:path';
import { TEST_DATABASE_URL } from '../helpers/pg.js';

const dbAvailable = await isDbAvailable();
const d = dbAvailable ? describe : describe.skip;

d('平台行为（集成）', () => {
  let db: Db;
  let t: TestApp;
  let api: TestClient;

  beforeAll(async () => {
    db = await getTestDb();
  });
  beforeEach(async () => {
    await truncateAll(db);
    t = await buildTestApp(db);
    api = createClient(t.app);
  });
  afterEach(async () => {
    await t.close();
  });
  afterAll(async () => {
    await closeTestDb();
  });

  it('/healthz 与 /readyz 可用且不鉴权', async () => {
    const health = await api.get<{ status: string; uptimeSec: number }>('/healthz');
    expect(health.status).toBe(200);
    expect(dataOf(health).status).toBe('ok');
    expect(typeof dataOf(health).uptimeSec).toBe('number');

    const ready = await api.get<{ status: string; db: string }>('/readyz');
    expect(ready.status).toBe(200);
    expect(dataOf(ready)).toMatchObject({ status: 'ready', db: 'up' });
  });

  it('★ SV-008：/readyz 数据库不可用 → 503 且走统一错误体（UNAVAILABLE）', async () => {
    // 用 ping 恒定失败的 stub 包一层，模拟数据库不可用
    const downDb: Db = { ...db, ping: async () => false };
    const down = await buildTestApp(downDb);
    try {
      const res = await down.app.inject({ method: 'GET', url: '/readyz' });
      expect(res.statusCode).toBe(503);
      const body = JSON.parse(res.body) as { ok: boolean; error?: { code: string; message: string } };
      expect(body.ok).toBe(false);
      expect(body.error?.code).toBe('UNAVAILABLE');
      expect(body.error?.message).toBe('数据库不可用');
    } finally {
      await down.close();
    }
  });

  it('未知路由返回统一错误体', async () => {
    const res = await api.get('/v1/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
    expect(errorCodeOf(res)).toBe('NOT_FOUND');
  });

  it('安全响应头齐备，且不缓存', async () => {
    const res = await api.get('/healthz');
    expect(headerOf(res, 'x-content-type-options')).toBe('nosniff');
    expect(headerOf(res, 'x-frame-options')).toBe('DENY');
    expect(headerOf(res, 'referrer-policy')).toBe('no-referrer');
    expect(headerOf(res, 'cache-control')).toBe('no-store');
  });

  it('限流：超过阈值返回 429 且带 Retry-After（含 X-RateLimit 头）', async () => {
    const tight = await buildTestApp(db, {
      cfg: testConfig({ limits: { authPerMin: 2 } as never }),
    });
    const tightApi = createClient(tight.app);
    try {
      const first = await tightApi.post('/v1/auth/login', { email: 'x@example.com', password: 'Passw0rd123' });
      expect(first.status).toBe(401); // 未注册 → 凭证错误（已消耗一次配额）
      expect(headerOf(first, 'x-ratelimit-limit')).toBe('2');

      const second = await tightApi.post('/v1/auth/login', { email: 'x@example.com', password: 'Passw0rd123' });
      expect(second.status).toBe(401);

      const third = await tightApi.post('/v1/auth/login', { email: 'x@example.com', password: 'Passw0rd123' });
      expect(third.status).toBe(429);
      expect(errorCodeOf(third)).toBe('RATE_LIMITED');
      expect(Number(headerOf(third, 'retry-after'))).toBeGreaterThan(0);
    } finally {
      await tight.close();
    }
  });

  it('请求体不是合法 JSON → 400 统一错误体', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: '{not-json',
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { ok: boolean; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('超大请求体 → 413', async () => {
    const huge = { data: { blob: 'x'.repeat(2 * 1024 * 1024) } };
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      headers: { 'content-type': 'application/json' },
      payload: huge,
    });
    expect(res.statusCode).toBe(413);
  });

  it('迁移幂等：重复执行不报错且已应用记录不变', async () => {
    const dir = resolve(SERVER_ROOT, 'migrations');
    const before = await listApplied(db);
    const result = await runMigrations(db, dir);
    const after = await listApplied(db);
    expect(result.alreadyUpToDate).toBe(true);
    expect(result.applied).toEqual([]);
    expect(after.length).toBe(before.length);
    expect(loadMigrations(dir).length).toBeGreaterThanOrEqual(1);
  });

  it('迁移漂移检测：已应用迁移内容被改动时拒绝执行', async () => {
    const temp = await createDb(TEST_DATABASE_URL, {
      poolMax: 2, idleTimeoutMs: 1000, connectionTimeoutMs: 2000, statementTimeoutMs: 5000,
    });
    try {
      // 伪造一条"已应用"记录，checksum 与真实文件不一致
      await temp.execute(
        `INSERT INTO schema_migrations (version, name, checksum)
         VALUES ('999', '999_fake.sql', 'deadbeef')
         ON CONFLICT (version) DO UPDATE SET checksum = 'deadbeef'`,
      );
      const dir = resolve(SERVER_ROOT, 'migrations');
      // 999 不在文件集中 → 只做漂移检查，不应抛错
      await expect(runMigrations(temp, dir)).resolves.toBeDefined();

      // 现在伪造一个真实存在但 checksum 不符的版本 → 必须抛错
      const files = loadMigrations(dir);
      const target = files[0]!;
      await temp.execute(
        `UPDATE schema_migrations SET checksum = 'tampered' WHERE version = $1`,
        [target.version],
      );
      await expect(runMigrations(temp, dir)).rejects.toThrow(/checksum 不一致/);
      // 复原，避免影响其它用例
      await temp.execute(`UPDATE schema_migrations SET checksum = $2 WHERE version = $1`, [
        target.version,
        target.checksum,
      ]);
      // 清除伪造行：否则会残留在共享测试库中，
      // 导致 `migrate --status` 显示"已应用 3 / 共 2"这类假象（SV-006）
      await temp.execute(`DELETE FROM schema_migrations WHERE version = '999'`);
    } finally {
      await temp.close();
    }
  });
});
