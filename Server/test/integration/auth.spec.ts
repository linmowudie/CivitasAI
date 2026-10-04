/**
 * 集成测试：账户体系（注册 / 登录 / 刷新轮换与重用检测 / 改密 / 登出 / 设备 / 审计）。
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { getTestDb, isDbAvailable, truncateAll, closeTestDb } from '../helpers/pg.js';
import { buildTestApp, createClient, dataOf, errorCodeOf, type TestApp, type TestClient, type AuthedUser } from '../helpers/app.js';
import type { Db } from '../../src/db/pool.js';
import { purgeInactive } from '../../src/repositories/refreshTokens.js';

const dbAvailable = await isDbAvailable();
const d = dbAvailable ? describe : describe.skip;

interface SessionDto {
  sessionId: string;
  deviceLabel: string | null;
  issuedAt: string;
}

d('账户体系（集成）', () => {
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

  it('注册成功返回 201 与令牌，且密码以 argon2id 存储', async () => {
    const res = await api.post<AuthedUser>('/v1/auth/register', {
      email: 'Alice@Example.com',
      password: 'Passw0rd123',
      displayName: '爱丽丝',
    });
    expect(res.status).toBe(201);
    const data = dataOf(res);
    expect(data.user.email).toBe('alice@example.com'); // 规范化
    expect(data.user.displayName).toBe('爱丽丝');
    expect(data.tokens.accessToken.split('.')).toHaveLength(3);
    expect(data.tokens.refreshToken.length).toBeGreaterThan(20);

    const row = await db.one<{ password_hash: string; email_lower: string }>(
      'SELECT password_hash, email_lower FROM users',
    );
    expect(row?.password_hash.startsWith('$argon2id$')).toBe(true);
    expect(row?.password_hash).not.toContain('Passw0rd123');
    expect(row?.email_lower).toBe('alice@example.com');
  });

  it('重复邮箱注册 → 409；弱密码 → 400', async () => {
    await api.register('dup@example.com');
    const dup = await api.post('/v1/auth/register', { email: 'dup@example.com', password: 'Passw0rd123' });
    expect(dup.status).toBe(409);
    expect(errorCodeOf(dup)).toBe('CONFLICT');

    const weak = await api.post('/v1/auth/register', { email: 'weak@example.com', password: 'short' });
    expect(weak.status).toBe(400);
    expect(errorCodeOf(weak)).toBe('VALIDATION_ERROR');
  });

  it('登录：密码错误与邮箱不存在返回同一错误（不泄露账号是否存在）', async () => {
    await api.register('bob@example.com');

    const badPassword = await api.login('bob@example.com', 'WrongPass123');
    expect(badPassword.status).toBe(401);
    expect(errorCodeOf(badPassword)).toBe('INVALID_CREDENTIALS');

    const noUser = await api.login('nobody@example.com', 'Passw0rd123');
    expect(noUser.status).toBe(401);
    expect(errorCodeOf(noUser)).toBe('INVALID_CREDENTIALS');
    expect(noUser.body.ok ? '' : noUser.body.error.message).toBe(
      badPassword.body.ok ? '' : badPassword.body.error.message,
    );
  });

  it('访问受保护接口：无令牌/坏令牌 401，正常令牌 200', async () => {
    const user = await api.register('carol@example.com');

    expect((await api.get('/v1/me')).status).toBe(401);
    expect((await api.get('/v1/me', 'not-a-jwt')).status).toBe(401);

    const me = await api.get<{ email: string }>('/v1/me', user.tokens.accessToken);
    expect(me.status).toBe(200);
    expect(dataOf(me).email).toBe('carol@example.com');
  });

  it('刷新令牌会轮换：新令牌可用，旧令牌再用 → TOKEN_REUSED 且整族失效', async () => {
    const user = await api.register('dave@example.com');

    const first = await api.post<AuthedUser>('/v1/auth/refresh', {
      refreshToken: user.tokens.refreshToken,
    });
    expect(first.status).toBe(200);
    const rotated = dataOf(first);
    expect(rotated.tokens.refreshToken).not.toBe(user.tokens.refreshToken);

    // 正常路径：新令牌可继续刷新
    const second = await api.post<AuthedUser>('/v1/auth/refresh', {
      refreshToken: rotated.tokens.refreshToken,
    });
    expect(second.status).toBe(200);
    const latest = dataOf(second);

    // 盗用检测：已轮换掉的旧令牌再次使用
    const reuse = await api.post('/v1/auth/refresh', { refreshToken: user.tokens.refreshToken });
    expect(reuse.status).toBe(401);
    expect(errorCodeOf(reuse)).toBe('TOKEN_REUSED');

    // 整族已被吊销：连最新的令牌也失效
    const afterFamilyRevoke = await api.post('/v1/auth/refresh', {
      refreshToken: latest.tokens.refreshToken,
    });
    expect(afterFamilyRevoke.status).toBe(401);
    expect(errorCodeOf(afterFamilyRevoke)).toBe('TOKEN_REUSED');

    const audit = await db.one<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM audit_log WHERE action = 'auth.refresh' AND outcome = 'failure'`,
    );
    expect(audit?.count).toBeGreaterThanOrEqual(1);
  });

  it('伪造/未知刷新令牌 → 401 UNAUTHENTICATED', async () => {
    const res = await api.post('/v1/auth/refresh', { refreshToken: 'x'.repeat(43) });
    expect(res.status).toBe(401);
    expect(errorCodeOf(res)).toBe('UNAUTHENTICATED');
  });

  it('改密：旧密码校验、新密码生效、其他会话被吊销并换发新令牌', async () => {
    const user = await api.register('erin@example.com');
    // 第二个设备登录
    const secondDevice = dataOf(await api.login('erin@example.com'));

    const wrongCurrent = await api.post(
      '/v1/auth/change-password',
      { currentPassword: 'WrongPass123', newPassword: 'NewPassw0rd1' },
      user.tokens.accessToken,
    );
    expect(wrongCurrent.status).toBe(401);
    expect(errorCodeOf(wrongCurrent)).toBe('INVALID_CREDENTIALS');

    const samePassword = await api.post(
      '/v1/auth/change-password',
      { currentPassword: 'Passw0rd123', newPassword: 'Passw0rd123' },
      user.tokens.accessToken,
    );
    expect(samePassword.status).toBe(409);

    const changed = await api.post<{ tokens: AuthedUser['tokens'] }>(
      '/v1/auth/change-password',
      { currentPassword: 'Passw0rd123', newPassword: 'NewPassw0rd1' },
      user.tokens.accessToken,
    );
    expect(changed.status).toBe(200);
    const fresh = dataOf(changed).tokens;
    expect(fresh.refreshToken).not.toBe(user.tokens.refreshToken);

    // 其他设备会话已失效
    const secondDeviceRefresh = await api.post('/v1/auth/refresh', {
      refreshToken: secondDevice.tokens.refreshToken,
    });
    expect(secondDeviceRefresh.status).toBe(401);

    // 新密码可登录，旧密码不可
    expect((await api.login('erin@example.com', 'NewPassw0rd1')).status).toBe(200);
    expect((await api.login('erin@example.com', 'Passw0rd123')).status).toBe(401);

    // 当前设备的换发令牌可用
    expect((await api.post('/v1/auth/refresh', { refreshToken: fresh.refreshToken })).status).toBe(200);
  });

  it('设备会话：可列出、可单独吊销', async () => {
    const user = await api.register('frank@example.com');
    await api.login('frank@example.com');

    const sessions = await api.get<{ sessions: SessionDto[] }>('/v1/me/sessions', user.tokens.accessToken);
    expect(sessions.status).toBe(200);
    expect(dataOf(sessions).sessions).toHaveLength(2);

    const target = dataOf(sessions).sessions.find((s) => s.sessionId !== user.tokens.refreshToken)!;
    const del = await api.del<{ revoked: string }>(`/v1/me/sessions/${target.sessionId}`, user.tokens.accessToken);
    expect(del.status).toBe(200);

    const after = await api.get<{ sessions: SessionDto[] }>('/v1/me/sessions', user.tokens.accessToken);
    expect(dataOf(after).sessions).toHaveLength(1);

    // 已吊销的会话不能再用
    const reuse = await api.post('/v1/auth/refresh', { refreshToken: target.sessionId });
    expect(reuse.status).toBe(401);
  });

  it('登出：单设备与全部设备', async () => {
    const user = await api.register('grace@example.com');
    const other = dataOf(await api.login('grace@example.com'));

    const one = await api.post<{ revoked: number }>(
      '/v1/auth/logout',
      { refreshToken: user.tokens.refreshToken },
      user.tokens.accessToken,
    );
    expect(dataOf(one).revoked).toBe(1);
    expect((await api.post('/v1/auth/refresh', { refreshToken: user.tokens.refreshToken })).status).toBe(401);

    const all = await api.post<{ revoked: number }>(
      '/v1/auth/logout',
      { allDevices: true },
      other.tokens.accessToken,
    );
    expect(dataOf(all).revoked).toBeGreaterThanOrEqual(1);
    expect((await api.post('/v1/auth/refresh', { refreshToken: other.tokens.refreshToken })).status).toBe(401);
  });

  it('资料更新与审计记录', async () => {
    const user = await api.register('henry@example.com');

    const patched = await api.patch<{ displayName: string | null }>(
      '/v1/me',
      { displayName: '亨利' },
      user.tokens.accessToken,
    );
    expect(dataOf(patched).displayName).toBe('亨利');

    const audit = await api.get<{ entries: { action: string; outcome: string }[] }>(
      '/v1/me/audit',
      user.tokens.accessToken,
    );
    const actions = dataOf(audit).entries.map((e) => e.action);
    expect(actions).toContain('auth.register');
  });

  it('注销账号：需密码确认，数据级联删除', async () => {
    const user = await api.register('ivan@example.com');
    await api.put('/v1/settings', { data: { theme: 'dark' } }, user.tokens.accessToken);
    await api.post('/v1/memories', { title: 't', content: 'c' }, user.tokens.accessToken);

    const wrong = await api.request('DELETE', '/v1/me', {
      payload: { password: 'WrongPass123' },
      token: user.tokens.accessToken,
    });
    expect(wrong.status).toBe(401);

    const okDel = await api.request('DELETE', '/v1/me', {
      payload: { password: 'Passw0rd123' },
      token: user.tokens.accessToken,
    });
    expect(okDel.status).toBe(200);

    const counts = await db.one<{ users: number; settings: number; memories: number }>(`
      SELECT (SELECT COUNT(*)::int FROM users) AS users,
             (SELECT COUNT(*)::int FROM user_settings) AS settings,
             (SELECT COUNT(*)::int FROM memories) AS memories
    `);
    expect(counts).toEqual({ users: 0, settings: 0, memories: 0 });

    // 登录已不可用
    expect((await api.login('ivan@example.com')).status).toBe(401);
  });

  it('★ SV-004：purgeInactive 清理超龄历史令牌，未超龄/有效会话保留', async () => {
    const user = await api.register('purge@example.com'); // 该用户持有 1 条真实有效令牌

    // 伪造 4 条历史令牌：①超龄已吊销 ②超龄已过期 ③近期已过期 ④近期有效
    await db.execute(
      `INSERT INTO refresh_tokens (user_id, token_hash, family_id, issued_at, expires_at, revoked_at, revoked_reason)
       VALUES
         ($1, 'purge-test-revoked-old',    '00000000-0000-4000-8000-000000000001', now() - interval '90 days', now() - interval '85 days', now() - interval '89 days', 'rotated'),
         ($1, 'purge-test-expired-old',    '00000000-0000-4000-8000-000000000002', now() - interval '61 days', now() - interval '32 days', NULL, NULL),
         ($1, 'purge-test-expired-recent', '00000000-0000-4000-8000-000000000003', now() - interval '3 days',  now() - interval '1 hour',  NULL, NULL),
         ($1, 'purge-test-active',         '00000000-0000-4000-8000-000000000004', now() - interval '3 days',  now() + interval '10 days', NULL, NULL)`,
      [user.user.id],
    );

    // 只清理「（已吊销或已过期）且签发超过 60 天」的记录
    expect(await purgeInactive(db, 60)).toBe(2);

    const remaining = await db.query<{ token_hash: string }>(
      'SELECT token_hash FROM refresh_tokens WHERE user_id = $1',
      [user.user.id],
    );
    const hashes = remaining.map((r) => r.token_hash);
    expect(hashes).not.toContain('purge-test-revoked-old');
    expect(hashes).not.toContain('purge-test-expired-old');
    expect(hashes).toContain('purge-test-expired-recent'); // 未超龄：即使已过期也保留
    expect(hashes).toContain('purge-test-active'); // 活跃会话保留
    expect(hashes).toHaveLength(3); // 保留的 2 条伪造行 + 注册产生的 1 条真实令牌
  });

  it('★ SV-002：改密后旧访问令牌立即失效（≤1 请求周期，不必等 TTL）', async () => {
    const user = await api.register('irene@example.com'); // 设备 1
    const secondDevice = dataOf(await api.login('irene@example.com')); // 设备 2

    // 前置：两台设备的访问令牌均可用
    expect((await api.get('/v1/me', user.tokens.accessToken)).status).toBe(200);
    expect((await api.get('/v1/me', secondDevice.tokens.accessToken)).status).toBe(200);

    // 设备 1 改密：吊销全部会话，并为当前设备换发新令牌
    const changed = await api.post<{ tokens: AuthedUser['tokens'] }>(
      '/v1/auth/change-password',
      { currentPassword: 'Passw0rd123', newPassword: 'NewPassw0rd1' },
      user.tokens.accessToken,
    );
    expect(changed.status).toBe(200);
    const fresh = dataOf(changed).tokens;

    // 旧访问令牌（两台设备）在下一个请求即失效，不再等 TTL 窗口
    const oldOther = await api.get('/v1/me', secondDevice.tokens.accessToken);
    expect(oldOther.status).toBe(401);
    expect(errorCodeOf(oldOther)).toBe('UNAUTHENTICATED');
    expect((await api.get('/v1/me', user.tokens.accessToken)).status).toBe(401);

    // 当前设备换发的新访问令牌可用
    expect((await api.get('/v1/me', fresh.accessToken)).status).toBe(200);
  });

  it('★ SV-002：登出后旧访问令牌立即失效（单设备立即、全部设备一并）', async () => {
    const user = await api.register('jack@example.com'); // 设备 1
    const other = dataOf(await api.login('jack@example.com')); // 设备 2

    // 设备 2 单设备登出（用自身访问令牌 + 自身刷新令牌）
    const one = await api.post<{ revoked: number }>(
      '/v1/auth/logout',
      { refreshToken: other.tokens.refreshToken },
      other.tokens.accessToken,
    );
    expect(dataOf(one).revoked).toBe(1);

    // 设备 2 的访问令牌立即失效；设备 1 不受影响
    expect((await api.get('/v1/me', other.tokens.accessToken)).status).toBe(401);
    expect((await api.get('/v1/me', user.tokens.accessToken)).status).toBe(200);

    // 设备 1 登出全部设备 → 其访问令牌一并立即失效
    const all = await api.post<{ revoked: number }>(
      '/v1/auth/logout',
      { allDevices: true },
      user.tokens.accessToken,
    );
    expect(dataOf(all).revoked).toBeGreaterThanOrEqual(1);
    const afterAll = await api.get('/v1/me', user.tokens.accessToken);
    expect(afterAll.status).toBe(401);
    expect(errorCodeOf(afterAll)).toBe('UNAUTHENTICATED');
  });
});
