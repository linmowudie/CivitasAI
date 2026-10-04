/**
 * 限流共享存储（SV-003）：多实例部署时阈值不再 ×N。
 *
 * 覆盖：
 *  - 两个限流器实例（模拟两个进程）共享同一份计数；
 *  - 超限拒绝并给出重试秒数（固定窗口）；
 *  - 窗口滚动后计数重置；
 *  - 存储不可用时回退到进程内限流（仍然限流，不放开）；
 *  - 应用级：`RATE_LIMIT_STORE=postgres` 时 HTTP 429 由共享计数决定。
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { getTestDb, isDbAvailable, truncateAll, closeTestDb } from '../helpers/pg.js';
import { buildTestApp, createClient, testConfig, type TestApp } from '../helpers/app.js';
import { createPostgresRateLimiter } from '../../src/http/rateLimit.js';
import type { Db } from '../../src/db/pool.js';

const dbAvailable = await isDbAvailable();
const d = dbAvailable ? describe : describe.skip;

d('限流共享存储（集成）', () => {
  let db: Db;

  beforeAll(async () => {
    db = await getTestDb();
  });
  afterAll(async () => {
    await closeTestDb();
  });

  beforeEach(async () => {
    await truncateAll(db);
    await db.execute('DELETE FROM rate_limit_buckets');
  });

  it('★ SV-003：两个实例共享同一计数（改动前各算一份 → 阈值 ×实例数）', async () => {
    // 两个 limiter = 模拟两个服务端进程（各自内存独立，只共享 PG）
    const instanceA = createPostgresRateLimiter({ db, cleanupIntervalMs: 0 });
    const instanceB = createPostgresRateLimiter({ db, cleanupIntervalMs: 0 });

    // 实例 A 消耗 3 次
    for (let i = 0; i < 3; i++) {
      const d1 = await instanceA.consume('auth:1.2.3.4', 5);
      expect(d1.allowed).toBe(true);
      expect(d1.used).toBe(i + 1);
    }

    // 实例 B 看到的计数应包含 A 的消耗（共享）
    const b1 = await instanceB.consume('auth:1.2.3.4', 5);
    expect(b1.used).toBe(4);
    const b2 = await instanceB.consume('auth:1.2.3.4', 5);
    expect(b2.used).toBe(5);
    expect(b2.allowed).toBe(true);

    // 第 6 次（跨实例）→ 超限
    const denied = await instanceA.consume('auth:1.2.3.4', 5);
    expect(denied.allowed).toBe(false);
    expect(denied.used).toBe(6);
    expect(denied.retryAfterSec).toBeGreaterThan(0);

    instanceA.dispose();
    instanceB.dispose();
  });

  it('不同键互不影响', async () => {
    const rl = createPostgresRateLimiter({ db, cleanupIntervalMs: 0 });
    expect((await rl.consume('auth:10.0.0.1', 1)).allowed).toBe(true);
    expect((await rl.consume('auth:10.0.0.2', 1)).allowed).toBe(true);
    expect((await rl.consume('auth:10.0.0.1', 1)).allowed).toBe(false);
    rl.dispose();
  });

  it('窗口滚动后计数重置（固定窗口）', async () => {
    const rl = createPostgresRateLimiter({ db, windowMs: 60_000, cleanupIntervalMs: 0 });
    expect((await rl.consume('api:9.9.9.9', 2)).allowed).toBe(true);
    expect((await rl.consume('api:9.9.9.9', 2)).allowed).toBe(true);
    expect((await rl.consume('api:9.9.9.9', 2)).allowed).toBe(false);

    // 人为把窗口起点拨回 2 分钟前 → 下一次消费应重置计数
    await db.execute(
      `UPDATE rate_limit_buckets SET window_start = now() - interval '2 minutes' WHERE bucket_key = $1`,
      ['api:9.9.9.9'],
    );
    const after = await rl.consume('api:9.9.9.9', 2);
    expect(after.allowed).toBe(true);
    expect(after.used).toBe(1);
    rl.dispose();
  });

  it('peek 反映共享计数', async () => {
    const rl = createPostgresRateLimiter({ db, cleanupIntervalMs: 0 });
    await rl.consume('write:user-1', 10);
    await rl.consume('write:user-1', 10);
    expect(await rl.peek('write:user-1')).toBe(2);
    rl.dispose();
  });

  it('存储不可用时回退到进程内限流（不放开限流）', async () => {
    const brokenDb = {
      one: async () => { throw new Error('db down'); },
      execute: async () => { throw new Error('db down'); },
    } as unknown as Db;
    const rl = createPostgresRateLimiter({ db: brokenDb, cleanupIntervalMs: 0 });

    // 限流仍然生效（回退到内存计数）
    expect((await rl.consume('auth:1.1.1.1', 2)).allowed).toBe(true);
    expect((await rl.consume('auth:1.1.1.1', 2)).allowed).toBe(true);
    const third = await rl.consume('auth:1.1.1.1', 2);
    expect(third.allowed).toBe(false);
    rl.dispose();
  });

  it('应用级：RATE_LIMIT_STORE=postgres 时 429 由共享计数决定，且写入桶表', async () => {
    const t: TestApp = await buildTestApp(db, {
      cfg: testConfig({ rateLimitStore: 'postgres', limits: { ...testConfig().limits, authPerMin: 3, apiPerMin: 3 } }),
    });
    try {
      const api = createClient(t.app);
      // /v1/auth/* 走 auth 桶（limit=3）
      const codes: number[] = [];
      for (let i = 0; i < 4; i++) {
        const res = await api.post('/v1/auth/login', { email: 'nobody@example.com', password: 'Passw0rd123' });
        codes.push(res.status);
      }
      expect(codes.slice(0, 3).every((c) => c !== 429)).toBe(true);
      expect(codes[3]).toBe(429);

      // 计数确实落在共享表里（多实例可见）
      const rows = await db.query<{ bucket_key: string; used: number }>(
        `SELECT bucket_key, used FROM rate_limit_buckets WHERE bucket_key LIKE 'auth:%'`,
      );
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0]!.used).toBeGreaterThanOrEqual(4);
    } finally {
      await t.close();
    }
  });
});
