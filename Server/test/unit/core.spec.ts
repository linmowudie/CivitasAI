/**
 * 密码哈希、访问令牌、刷新令牌、限流、校验、游标 等纯逻辑单元测试。
 */
import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword, fakeVerify } from '../../src/security/password.js';
import {
  signAccessToken,
  verifyAccessToken,
  generateRefreshToken,
  hashRefreshToken,
  newFamilyId,
} from '../../src/security/tokens.js';
import { createRateLimiter } from '../../src/http/rateLimit.js';
import { emailSchema, passwordSchema, parseOrThrow, paginationSchema } from '../../src/http/validate.js';
import { AppError, internal, notFound, rateLimited } from '../../src/http/errors.js';
import { containsCjk, encodeCursor, decodeCursor } from '../../src/repositories/memories.js';
import { resolveRange } from '../../src/routes/stats.js';
import type { AuthConfig } from '../../src/config.js';

const authCfg: AuthConfig = {
  jwtSecret: 'unit-test-secret-unit-test-secret-123456',
  accessTokenTtlSec: 900,
  refreshTokenTtlDays: 30,
  allowRefreshReuse: false,
  deviceBindingMode: 'warn',
  allowDevCode: false,
  codeTtlSec: 300,
  codeMaxPerWindow: 3,
  codeWindowSec: 600,
  codeResendCooldownSec: 60,
  codeMaxAttempts: 5,
};

describe('密码哈希', () => {
  it('哈希后可校验，且同一密码两次哈希不同（加盐）', async () => {
    const h1 = await hashPassword('Passw0rd123');
    const h2 = await hashPassword('Passw0rd123');
    expect(h1).not.toBe(h2);
    expect(h1.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(h1, 'Passw0rd123')).toBe(true);
    expect(await verifyPassword(h2, 'Passw0rd123')).toBe(true);
  });

  it('错误密码与损坏哈希都返回 false（不抛错）', async () => {
    const h = await hashPassword('Passw0rd123');
    expect(await verifyPassword(h, 'wrong-password')).toBe(false);
    expect(await verifyPassword('not-a-hash', 'Passw0rd123')).toBe(false);
    expect(await verifyPassword('', 'Passw0rd123')).toBe(false);
  });

  it('fakeVerify 不抛错（用于抹平"用户不存在"的时间差）', async () => {
    await expect(fakeVerify()).resolves.toBeUndefined();
  });
});

describe('访问令牌', () => {
  it('签发后可校验，声明完整', async () => {
    const { token, expiresIn } = await signAccessToken(authCfg, { sub: 'user-1', sid: 'sess-1' });
    expect(expiresIn).toBe(900);
    const claims = await verifyAccessToken(authCfg, token);
    expect(claims).toEqual({ sub: 'user-1', sid: 'sess-1' });
  });

  it('被篡改的令牌 → UNAUTHENTICATED', async () => {
    const { token } = await signAccessToken(authCfg, { sub: 'user-1', sid: 'sess-1' });
    const tampered = `${token.slice(0, -3)}abc`;
    await expect(verifyAccessToken(authCfg, tampered)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
  });

  it('过期令牌 → TOKEN_EXPIRED（可区分）', async () => {
    const { token } = await signAccessToken({ ...authCfg, accessTokenTtlSec: -10 }, {
      sub: 'user-1',
      sid: 'sess-1',
    });
    await expect(verifyAccessToken(authCfg, token)).rejects.toMatchObject({ code: 'TOKEN_EXPIRED' });
  });

  it('换密钥后校验失败（不能跨部署混用）', async () => {
    const { token } = await signAccessToken(authCfg, { sub: 'u', sid: 's' });
    await expect(
      verifyAccessToken({ ...authCfg, jwtSecret: 'another-secret-another-secret-123456' }, token),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });
});

describe('刷新令牌', () => {
  it('明文与哈希不同，哈希稳定且可复现', () => {
    const gen = generateRefreshToken();
    expect(gen.raw.length).toBeGreaterThan(20);
    expect(gen.hash).not.toBe(gen.raw);
    expect(hashRefreshToken(gen.raw)).toBe(gen.hash);
    expect(gen.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('每次生成都不同；家族 ID 唯一', () => {
    expect(generateRefreshToken().raw).not.toBe(generateRefreshToken().raw);
    expect(newFamilyId()).not.toBe(newFamilyId());
  });
});

describe('限流', () => {
  it('达到上限后拒绝，并给出重试秒数', async () => {
    const rl = createRateLimiter({ cleanupIntervalMs: 0 });
    const t0 = 1_000_000;
    expect((await rl.consume('k', 2, t0)).allowed).toBe(true);
    expect((await rl.consume('k', 2, t0 + 10)).allowed).toBe(true);
    const third = await rl.consume('k', 2, t0 + 20);
    expect(third.allowed).toBe(false);
    expect(third.retryAfterSec).toBeGreaterThan(0);
    rl.dispose();
  });

  it('滑动窗口：超出 60s 的旧记录不再计数', async () => {
    const rl = createRateLimiter({ cleanupIntervalMs: 0 });
    const t0 = 2_000_000;
    await rl.consume('k', 2, t0);
    await rl.consume('k', 2, t0 + 1_000);
    expect((await rl.consume('k', 2, t0 + 2_000)).allowed).toBe(false);
    // 61 秒后第一条滑出窗口
    expect((await rl.consume('k', 2, t0 + 61_000)).allowed).toBe(true);
    rl.dispose();
  });

  it('不同键互不影响；reset 清空', async () => {
    const rl = createRateLimiter({ cleanupIntervalMs: 0 });
    expect((await rl.consume('a', 1)).allowed).toBe(true);
    expect((await rl.consume('b', 1)).allowed).toBe(true);
    expect((await rl.consume('a', 1)).allowed).toBe(false);
    await rl.reset();
    expect((await rl.consume('a', 1)).allowed).toBe(true);
    rl.dispose();
  });
});

describe('校验', () => {
  it('邮箱规范化（去空格、统一小写）', () => {
    expect(emailSchema.parse('  User@Example.COM ')).toBe('user@example.com');
    expect(() => emailSchema.parse('not-an-email')).toThrow();
  });

  it('密码强度：至少 8 位且含字母与数字', () => {
    expect(passwordSchema.parse('Passw0rd123')).toBe('Passw0rd123');
    expect(() => passwordSchema.parse('short1')).toThrow();
    expect(() => passwordSchema.parse('onlyletters')).toThrow();
    expect(() => passwordSchema.parse('12345678')).toThrow();
  });

  it('parseOrThrow 抛出带字段路径的 VALIDATION_ERROR', () => {
    try {
      parseOrThrow(paginationSchema, { limit: 0 }, { scope: 'query' });
      throw new Error('应当抛错');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      const e = err as AppError;
      expect(e.code).toBe('VALIDATION_ERROR');
      expect(e.status).toBe(400);
      const issues = (e.details?.['issues'] ?? []) as { path: string }[];
      expect(issues[0]?.path).toBe('query.limit');
    }
  });
});

describe('错误对象', () => {
  it('状态码映射正确', () => {
    expect(notFound().status).toBe(404);
    expect(rateLimited(30).status).toBe(429);
    expect(rateLimited(7).details?.['retryAfterSec']).toBe(7);
  });

  it('INTERNAL 不向外暴露内部文案，但保留给日志', () => {
    const err = internal('数据库连接串里有密码');
    const payload = err.toPayload();
    expect(payload.code).toBe('INTERNAL');
    expect(payload.message).toBe('服务器内部错误');
    expect(err.message).toBe('数据库连接串里有密码');
  });
});

describe('记忆检索与游标', () => {
  it('CJK 检测（决定走 ILIKE 还是全文检索）', () => {
    expect(containsCjk('项目记忆')).toBe(true);
    expect(containsCjk('记忆 memory')).toBe(true);
    expect(containsCjk('project memory')).toBe(false);
  });

  it('游标编解码可往返；非法游标返回 null', () => {
    const row = { created_at: new Date('2026-01-02T03:04:05.000Z'), id: 'abc-123' };
    const cursor = encodeCursor(row);
    const decoded = decodeCursor(cursor);
    expect(decoded?.id).toBe('abc-123');
    expect(decoded?.createdAt.toISOString()).toBe('2026-01-02T03:04:05.000Z');

    expect(decodeCursor('!!!not-base64!!!')).toBeNull();
    expect(decodeCursor(Buffer.from('no-separator').toString('base64url'))).toBeNull();
  });
});

describe('统计区间默认值', () => {
  it('缺省为最近 30 天', () => {
    const now = new Date('2026-03-31T00:00:00.000Z');
    const { from, to } = resolveRange({}, now);
    expect(to.toISOString()).toBe(now.toISOString());
    expect(Math.round((to.getTime() - from.getTime()) / 86_400_000)).toBe(30);
  });

  it('显式区间原样返回', () => {
    const from = new Date('2026-01-01T00:00:00.000Z');
    const to = new Date('2026-01-31T00:00:00.000Z');
    expect(resolveRange({ from, to })).toEqual({ from, to });
  });
});
