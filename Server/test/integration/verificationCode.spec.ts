/**
 * 集成测试：验证码认证 + 设备管理
 * 覆盖安全审计 SV-011（新功能无测试）/ SV-012（验证码加固）/ SV-014 + FE-033（设备绑定可用性）。
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { getTestDb, isDbAvailable, truncateAll, closeTestDb } from '../helpers/pg.js';
import { buildTestApp, createClient, testConfig, type TestApp, type TestClient } from '../helpers/app.js';
import type { Db } from '../../src/db/pool.js';

const dbAvailable = await isDbAvailable();
const d = dbAvailable ? describe : describe.skip;

interface CodeLoginData {
  user: { id: string; email: string };
  tokens: { accessToken: string; refreshToken: string };
  isNewUser: boolean;
}
interface DeviceListData {
  devices: Array<{ deviceId: string; kind: string; lastSeenAt: string | null; isPrimary: boolean }>;
}

d('验证码认证与设备管理（集成）', () => {
  let db: Db;
  let t: TestApp;
  let api: TestClient;
  let seq = 0;
  const nextEmail = () => `code-${Date.now()}-${++seq}@example.com`;

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

  /** 换一个应用实例（用于切换 deviceBindingMode / 冷却等配置） */
  async function rebuild(cfgOverrides: Parameters<typeof testConfig>[0]): Promise<void> {
    await t.close();
    t = await buildTestApp(db, { cfg: testConfig(cfgOverrides) });
    api = createClient(t.app);
  }

  /** 发送验证码并取回 devCode（测试配置默认开启 allowDevCode） */
  async function sendCode(email: string): Promise<string> {
    const res = await api.post<{ success: boolean; devCode?: string; expiresIn: number; channel: string }>(
      '/v1/auth/send-code', { email, purpose: 'login' },
    );
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const data = res.body.ok ? res.body.data : null;
    expect(typeof data?.devCode).toBe('string');
    return data!.devCode!;
  }

  const loginWithCode = (email: string, deviceId: string, code: string) =>
    api.post<CodeLoginData>('/v1/auth/login-with-code', {
      email, code, deviceId, deviceCredential: `cred-${deviceId}`,
    });

  // ── 验证码存储与生成（SV-012）────────────────────────────────────────

  it('验证码只存哈希（明文不落库），且为 6 位 CSPRNG 码', async () => {
    const email = nextEmail();
    const code = await sendCode(email);
    expect(code).toMatch(/^\d{6}$/);

    const rows = await db.query<{ code_hash: string; attempts: number }>(
      `SELECT code_hash, attempts FROM verification_codes WHERE email_lower = $1`, [email],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.code_hash).toBe(createHash('sha256').update(code).digest('hex'));
    expect(rows[0]!.code_hash).not.toBe(code);

    const cols = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'verification_codes'`,
    );
    expect(cols.map((c) => c.column_name)).not.toContain('code');
  });

  it('签发新码会作废旧码（同一时刻只有一个有效码）', async () => {
    const email = nextEmail();
    const first = await sendCode(email);
    const second = await sendCode(email);
    expect(first).not.toBe(second);

    const unused = await db.query(`SELECT id FROM verification_codes WHERE email_lower = $1 AND used_at IS NULL`, [email]);
    expect(unused).toHaveLength(1);

    expect((await loginWithCode(email, 'd1', first)).status).toBe(401);
    expect((await loginWithCode(email, 'd1', second)).status).toBe(200);
  });

  it('发送配额：窗口内超过上限 → 429 RATE_LIMITED', async () => {
    const email = nextEmail();
    await sendCode(email);
    await sendCode(email);
    await sendCode(email);
    const fourth = await api.post('/v1/auth/send-code', { email, purpose: 'login' });
    expect(fourth.status).toBe(429);
    expect(fourth.body.ok ? '' : fourth.body.error.code).toBe('RATE_LIMITED');
  });

  it('发送冷却：间隔不足 → 429 且给出 retryAfterSec', async () => {
    await rebuild({ auth: { ...testConfig().auth, codeResendCooldownSec: 60 } });
    const email = nextEmail();
    await sendCode(email);
    const again = await api.post<unknown>('/v1/auth/send-code', { email, purpose: 'login' });
    expect(again.status).toBe(429);
    const details = again.body.ok ? undefined : (again.body.error.details as { retryAfterSec?: number } | undefined);
    expect(details?.retryAfterSec).toBeGreaterThan(0);
  });

  it('devCode 仅在显式开启时返回（默认不返回）', async () => {
    await rebuild({ auth: { ...testConfig().auth, allowDevCode: false } });
    const res = await api.post<{ success: boolean; devCode?: string; channel: string }>(
      '/v1/auth/send-code', { email: nextEmail(), purpose: 'login' },
    );
    expect(res.status).toBe(200);
    const data = res.body.ok ? res.body.data : null;
    expect(data?.devCode).toBeUndefined();
    expect(data?.channel).toBe('console');
  });

  // ── 验证码校验（SV-012）──────────────────────────────────────────────

  it('一次性：同一验证码不能用两次', async () => {
    const email = nextEmail();
    const code = await sendCode(email);
    expect((await loginWithCode(email, 'd1', code)).status).toBe(200);
    expect((await loginWithCode(email, 'd1', code)).status).toBe(401);
  });

  it('失败锁定：错 5 次即作废，之后正确码也不再可用', async () => {
    const email = nextEmail();
    const code = await sendCode(email);

    for (let i = 1; i <= 4; i++) {
      const res = await api.post<unknown>('/v1/auth/login-with-code', { email, code: '000000', deviceId: 'd1' });
      expect(res.status).toBe(401);
      expect(res.body.ok ? '' : res.body.error.message).toBe('验证码错误');
    }
    const fifth = await api.post<unknown>('/v1/auth/login-with-code', { email, code: '000000', deviceId: 'd1' });
    expect(fifth.status).toBe(401);
    expect(fifth.body.ok ? '' : fifth.body.error.message).toContain('次数过多');

    expect((await loginWithCode(email, 'd1', code)).status).toBe(401);

    const row = await db.one<{ attempts: number; used_at: Date | null }>(
      `SELECT attempts, used_at FROM verification_codes WHERE email_lower = $1`, [email],
    );
    expect(row!.attempts).toBe(5);
    expect(row!.used_at).not.toBeNull();
  });

  it('过期验证码被拒', async () => {
    const email = nextEmail();
    const code = await sendCode(email);
    await db.execute(`UPDATE verification_codes SET expires_at = now() - interval '1 second' WHERE email_lower = $1`, [email]);
    const res = await api.post<unknown>('/v1/auth/login-with-code', { email, code, deviceId: 'd1' });
    expect(res.status).toBe(401);
    expect(res.body.ok ? '' : res.body.error.message).toContain('无效或已过期');
  });

  // ── 自动注册与设备登记 ──────────────────────────────────────────────

  it('首次验证码登录自动注册并登记设备（凭据以哈希存储）', async () => {
    const email = nextEmail();
    const res = await loginWithCode(email, 'install-1', await sendCode(email));
    expect(res.status).toBe(200);
    const data = res.body.ok ? res.body.data : null;
    expect(data?.isNewUser).toBe(true);

    const devices = await api.get<DeviceListData>('/v1/me/devices', data!.tokens.accessToken);
    expect(devices.status).toBe(200);
    const list = devices.body.ok ? devices.body.data.devices : [];
    expect(list).toHaveLength(1);
    expect(list[0]!.deviceId).toBe('install-1');
    expect(list[0]!.kind).toBe('install');

    const row = await db.one<{ credential_hash: string | null }>(
      `SELECT credential_hash FROM user_devices WHERE device_id = 'install-1'`,
    );
    expect(row!.credential_hash).toBe(createHash('sha256').update('cred-install-1').digest('hex'));
  });

  it('warn 模式（默认）：换机后仍可登录，并审计为新设备', async () => {
    const email = nextEmail();
    expect((await loginWithCode(email, 'old-device', await sendCode(email))).status).toBe(200);

    const second = await loginWithCode(email, 'new-device-after-reinstall', await sendCode(email));
    expect(second.status).toBe(200);
    const token = (second.body.ok ? second.body.data : null)!.tokens.accessToken;

    const devices = await api.get<DeviceListData>('/v1/me/devices', token);
    expect((devices.body.ok ? devices.body.data.devices : [])).toHaveLength(2);

    const audit = await db.query<{ action: string }>(`SELECT action FROM audit_log WHERE action = 'auth.new_device'`);
    expect(audit.length).toBeGreaterThanOrEqual(2);
  });

  // ── 严格设备模式 + 自助解绑（FE-033 / SV-014 修复的核心）─────────────

  it('strict 模式：首个设备放行 → 新设备被拒 → 解绑后可登录', async () => {
    await rebuild({ auth: { ...testConfig().auth, deviceBindingMode: 'strict' } });
    const email = nextEmail();

    // ① 首个设备放行（否则新账号永远无法登录）
    const first = await loginWithCode(email, 'device-A', await sendCode(email));
    expect(first.status).toBe(200);
    const tokenA = (first.body.ok ? first.body.data : null)!.tokens.accessToken;

    // ② 换机被拒
    const blocked = await loginWithCode(email, 'device-B', await sendCode(email));
    expect(blocked.status).toBe(403);
    expect(blocked.body.ok ? '' : blocked.body.error.message).toContain('严格设备模式');

    // ③ 在已登录设备 A 上自助解绑 device-A
    const revoke = await api.del<{ revoked: boolean }>('/v1/me/devices/device-A', tokenA);
    expect(revoke.status).toBe(200);
    expect(revoke.body.ok ? revoke.body.data.revoked : false).toBe(true);

    // ④ 旧设备已移除 → B 可登录
    const after = await loginWithCode(email, 'device-B', await sendCode(email));
    expect(after.status).toBe(200);
  });

  it('解绑需要鉴权，且不能移除他人设备', async () => {
    const emailA = nextEmail();
    const emailB = nextEmail();
    const a = await loginWithCode(emailA, 'a-device', await sendCode(emailA));
    const b = await loginWithCode(emailB, 'b-device', await sendCode(emailB));
    const tokenA = (a.body.ok ? a.body.data : null)!.tokens.accessToken;
    const tokenB = (b.body.ok ? b.body.data : null)!.tokens.accessToken;

    expect((await api.del('/v1/me/devices/a-device')).status).toBe(401);
    expect((await api.del('/v1/me/devices/a-device', tokenB)).status).toBe(404);

    const devices = await api.get<DeviceListData>('/v1/me/devices', tokenA);
    expect((devices.body.ok ? devices.body.data.devices : [])).toHaveLength(1);
  });

  it('off 模式：不登记设备', async () => {
    await rebuild({ auth: { ...testConfig().auth, deviceBindingMode: 'off' } });
    const email = nextEmail();
    const res = await loginWithCode(email, 'any-device', await sendCode(email));
    expect(res.status).toBe(200);
    const token = (res.body.ok ? res.body.data : null)!.tokens.accessToken;
    const devices = await api.get<DeviceListData>('/v1/me/devices', token);
    expect((devices.body.ok ? devices.body.data.devices : [])).toHaveLength(0);
  });

  it('闭环：验证码登录后用令牌访问受保护资源（数据隔离为空）', async () => {
    const email = nextEmail();
    const res = await loginWithCode(email, 'install-9', await sendCode(email));
    const token = (res.body.ok ? res.body.data : null)!.tokens.accessToken;

    const me = await api.get<{ email: string }>('/v1/me', token);
    expect(me.status).toBe(200);
    expect(me.body.ok ? me.body.data.email : '').toBe(email);

    const memories = await api.get<{ items: unknown[] }>('/v1/memories', token);
    expect((memories.body.ok ? memories.body.data.items : [null])).toHaveLength(0);
  });
});
