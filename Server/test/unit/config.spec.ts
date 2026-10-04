/**
 * 配置加载与校验（含生产环境 fail-closed）。
 */
import { describe, it, expect } from 'vitest';
import { loadConfig, parseEnvFile } from '../../src/config.js';

const BASE = { DATABASE_URL: 'postgres://u:p@localhost:5432/db', JWT_SECRET: 'x'.repeat(40) };

describe('parseEnvFile', () => {
  it('解析键值、忽略注释与空行、去掉成对引号', () => {
    const env = parseEnvFile(`
      # 注释
      PORT=8787
      HOST="127.0.0.1"
      EMPTY=
      SPACED = value with spaces
      QUOTED='single'
    `);
    expect(env['PORT']).toBe('8787');
    expect(env['HOST']).toBe('127.0.0.1');
    expect(env['EMPTY']).toBe('');
    expect(env['SPACED']).toBe('value with spaces');
    expect(env['QUOTED']).toBe('single');
  });
});

describe('loadConfig', () => {
  it('缺少 DATABASE_URL 时报错', () => {
    const result = loadConfig({ JWT_SECRET: 'x'.repeat(40) });
    expect(result.ok).toBe(false);
    expect(result.errors?.join(' ')).toContain('DATABASE_URL');
  });

  it('DATABASE_URL 必须是 postgres 连接串', () => {
    const result = loadConfig({ ...BASE, DATABASE_URL: 'mysql://localhost/db' });
    expect(result.ok).toBe(false);
    expect(result.errors?.join(' ')).toContain('postgres://');
  });

  it('默认值可用（本地开发）', () => {
    const result = loadConfig({ ...BASE });
    expect(result.ok).toBe(true);
    const cfg = result.config!;
    expect(cfg.port).toBe(8787);
    expect(cfg.host).toBe('127.0.0.1');
    expect(cfg.auth.accessTokenTtlSec).toBe(900);
    expect(cfg.auth.refreshTokenTtlDays).toBe(30);
    expect(cfg.trustProxy).toBe(false);
    expect(cfg.corsOrigins).toEqual([]);
  });

  it('数值与布尔会被转换', () => {
    const result = loadConfig({
      ...BASE,
      PORT: '9000',
      ACCESS_TOKEN_TTL_SEC: '60',
      ALLOW_REFRESH_REUSE: 'true',
      TRUST_PROXY: '1',
      CORS_ORIGINS: 'https://a.example, https://b.example',
      DB_POOL_MAX: '20',
    });
    expect(result.ok).toBe(true);
    const cfg = result.config!;
    expect(cfg.port).toBe(9000);
    expect(cfg.auth.accessTokenTtlSec).toBe(60);
    expect(cfg.auth.allowRefreshReuse).toBe(true);
    expect(cfg.trustProxy).toBe(true);
    expect(cfg.corsOrigins).toEqual(['https://a.example', 'https://b.example']);
    expect(cfg.db.poolMax).toBe(20);
  });

  it('生产环境缺少/过短的 JWT_SECRET 直接拒绝启动', () => {
    const missing = loadConfig({ ...BASE, NODE_ENV: 'production', JWT_SECRET: '' });
    expect(missing.ok).toBe(false);
    expect(missing.errors?.join(' ')).toContain('JWT_SECRET');

    const example = loadConfig({
      ...BASE,
      NODE_ENV: 'production',
      JWT_SECRET: 'dev-only-insecure-secret-change-me-0123456789',
    });
    expect(example.ok).toBe(false);

    const good = loadConfig({ ...BASE, NODE_ENV: 'production', MAIL_WEBHOOK_URL: 'https://mail.example.com/send' });
    expect(good.ok).toBe(true);
  });

  it('生产环境未配置邮件通道 → 拒绝启动（验证码发不出去等于无法登录）', () => {
    const result = loadConfig({ ...BASE, NODE_ENV: 'production' });
    expect(result.ok).toBe(false);
    expect(result.errors?.join(' ')).toContain('MAIL_WEBHOOK_URL');
  });

  it('生产环境禁止回传验证码（ALLOW_DEV_CODE=true 直接拒绝启动）', () => {
    const result = loadConfig({
      ...BASE,
      NODE_ENV: 'production',
      MAIL_WEBHOOK_URL: 'https://mail.example.com/send',
      ALLOW_DEV_CODE: 'true',
    });
    expect(result.ok).toBe(false);
    expect(result.errors?.join(' ')).toContain('ALLOW_DEV_CODE');
  });

  it('新增认证配置项有安全默认值（设备模式 warn、验证码 5 次上限/3 次每 10 分钟/60s 冷却）', () => {
    const result = loadConfig({ ...BASE });
    expect(result.ok).toBe(true);
    expect(result.config?.auth.deviceBindingMode).toBe('warn');
    expect(result.config?.auth.allowDevCode).toBe(false);
    expect(result.config?.auth.codeMaxAttempts).toBe(5);
    expect(result.config?.auth.codeMaxPerWindow).toBe(3);
    expect(result.config?.auth.codeResendCooldownSec).toBe(60);
  });

  it('开发环境密钥过短只告警不阻塞', () => {
    const result = loadConfig({ ...BASE, JWT_SECRET: 'short' });
    expect(result.ok).toBe(true);
    expect(result.warnings?.join(' ')).toContain('JWT_SECRET');
  });

  it('非法端口报错', () => {
    const result = loadConfig({ ...BASE, PORT: 'abc' });
    expect(result.ok).toBe(false);
  });
});
