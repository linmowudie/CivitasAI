/**
 * @module config
 * @description 服务端配置：读取 .env + 进程环境变量，Zod 校验，生产环境 fail-closed。
 *
 * 设计取舍：
 *  - 不引入 dotenv：自带 20 行 .env 解析，避免多一个依赖，也不依赖 --env-file 的版本差异
 *  - 真实环境变量优先于 .env 文件（容器/CI 注入的配置不会被文件覆盖）
 *  - 生产环境缺少 JWT_SECRET / DATABASE_URL 直接拒绝启动（禁止"默认密钥"上生产）
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Server/ 根目录（本文件位于 Server/src/） */
export const SERVER_ROOT = resolve(__dirname, '..');

export interface DbConfig {
  poolMax: number;
  idleTimeoutMs: number;
  connectionTimeoutMs: number;
  statementTimeoutMs: number;
}

export interface AuthConfig {
  jwtSecret: string;
  accessTokenTtlSec: number;
  refreshTokenTtlDays: number;
  allowRefreshReuse: boolean;
  /**
   * 设备绑定模式（安全审计后新增）：
   *  - `off`    不记录/不校验设备
   *  - `warn`   记录并审计新设备，但**允许**登录（默认；换机/换网不再被锁死）
   *  - `strict` 拒绝未登记设备（企业场景；必须配合 /v1/me/devices 自助解绑）
   */
  deviceBindingMode: 'off' | 'warn' | 'strict';
  /** 是否允许在响应里回传验证码（仅开发；生产强制关闭，启动时校验） */
  allowDevCode: boolean;
  /** 验证码有效期（秒） */
  codeTtlSec: number;
  /** 同一邮箱在窗口内最多请求几次验证码 */
  codeMaxPerWindow: number;
  /** 验证码发送窗口（秒） */
  codeWindowSec: number;
  /** 两次发送之间的最小间隔（秒） */
  codeResendCooldownSec: number;
  /** 单个验证码允许的最大失败尝试次数（超过即作废） */
  codeMaxAttempts: number;
}

export interface MailConfig {
  /** 邮件通道 webhook（POST JSON）；为空表示未配置 */
  webhookUrl: string;
  /** 发件人标识（仅展示/转发用） */
  from: string;
  timeoutMs: number;
}

export interface LimitsConfig {
  authPerMin: number;
  apiPerMin: number;
  writePerMin: number;
  bodyLimitBytes: number;
  maxSettingsBytes: number;
  maxMemoriesPerBulk: number;
  maxStatsEventsPerBatch: number;
}

export interface ServerConfig {
  env: 'development' | 'test' | 'production';
  host: string;
  port: number;
  databaseUrl: string;
  db: DbConfig;
  auth: AuthConfig;
  mail: MailConfig;
  limits: LimitsConfig;
  /**
   * 限流计数存储：memory（进程内，单实例）| postgres（多实例共享，SV-003）。
   * 生产默认 postgres（多实例下阈值才准确）。
   */
  rateLimitStore: 'memory' | 'postgres';
  corsOrigins: string[];
  logLevel: string;
  statsTimezone: string;
  /** 是否信任反代头（X-Forwarded-For）；仅在确实位于可信反代之后时开启 */
  trustProxy: boolean;
}

/** 极简 .env 解析：KEY=VALUE、支持 # 注释、去掉成对引号 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** 合并 .env 文件与真实环境变量（真实环境优先） */
export function readEnv(envDir: string = SERVER_ROOT, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const merged: Record<string, string> = {};
  const envPath = resolve(envDir, '.env');
  if (existsSync(envPath)) {
    Object.assign(merged, parseEnvFile(readFileSync(envPath, 'utf8')));
  }
  for (const [k, v] of Object.entries(base)) {
    if (typeof v === 'string' && v.length > 0) merged[k] = v;
  }
  return merged;
}

const num = (def: number) =>
  z
    .union([z.string(), z.number()])
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number(v)))
    .refine((v) => Number.isFinite(v) && v > 0, { message: '必须是正数' });

/**
 * 非负数字（允许 0）——用于"0 表示关闭"的开关型阈值，
 * 例如 `CODE_RESEND_COOLDOWN_SEC=0` 表示不做发送冷却（开发/自测常用）。
 */
const nonNegativeNum = (def: number) =>
  z
    .union([z.string(), z.number()])
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number(v)))
    .refine((v) => Number.isFinite(v) && v >= 0, { message: '必须是非负数（0 表示关闭）' });

const int = (def: number) =>
  z
    .union([z.string(), z.number()])
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Math.trunc(Number(v))))
    .refine((v) => Number.isFinite(v) && v >= 0, { message: '必须是非负整数' });

const bool = (def: boolean) =>
  z
    .union([z.string(), z.boolean()])
    .optional()
    .transform((v) => {
      if (v === undefined || v === '') return def;
      if (typeof v === 'boolean') return v;
      return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
    });

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: num(8787),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL 必填'),

  DB_POOL_MAX: num(10),
  DB_IDLE_TIMEOUT_MS: num(30_000),
  DB_CONNECTION_TIMEOUT_MS: num(5_000),
  DB_STATEMENT_TIMEOUT_MS: num(15_000),

  JWT_SECRET: z.string().default(''),
  ACCESS_TOKEN_TTL_SEC: num(900),
  REFRESH_TOKEN_TTL_DAYS: num(30),
  ALLOW_REFRESH_REUSE: bool(false),

  // ── 验证码与设备绑定（安全审计后新增）──
  DEVICE_BINDING_MODE: z.enum(['off', 'warn', 'strict']).default('warn'),
  ALLOW_DEV_CODE: bool(false),
  CODE_TTL_SEC: num(300),
  CODE_MAX_PER_WINDOW: int(3),
  CODE_WINDOW_SEC: num(600),
  CODE_RESEND_COOLDOWN_SEC: nonNegativeNum(60),
  CODE_MAX_ATTEMPTS: int(5),

  // ── 邮件通道（生产必填，否则拒绝启动）──
  MAIL_WEBHOOK_URL: z.string().default(''),
  MAIL_FROM: z.string().default('Civitas-AI <no-reply@civitas.local>'),
  MAIL_TIMEOUT_MS: num(10_000),

  RATE_LIMIT_AUTH_PER_MIN: num(20),
  RATE_LIMIT_API_PER_MIN: num(240),
  RATE_LIMIT_WRITE_PER_MIN: num(120),
  /** 限流计数存储：memory | postgres（缺省按环境决定，见 cfg 组装） */
  RATE_LIMIT_STORE: z.enum(['memory', 'postgres']).optional(),

  BODY_LIMIT_BYTES: num(1024 * 1024),
  MAX_SETTINGS_BYTES: num(256 * 1024),
  MAX_MEMORIES_PER_BULK: int(1000),
  MAX_STATS_EVENTS_PER_BATCH: int(500),

  CORS_ORIGINS: z.string().default(''),
  LOG_LEVEL: z.string().default('info'),
  STATS_TIMEZONE: z.string().default('UTC'),
  TRUST_PROXY: bool(false),
});

export interface LoadConfigResult {
  ok: boolean;
  config?: ServerConfig;
  errors?: string[];
  warnings?: string[];
}

/**
 * 加载并校验配置。
 *
 * @param env 已合并的环境变量表（默认从 .env + process.env 读取）
 */
export function loadConfig(env: Record<string, string> = readEnv()): LoadConfigResult {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join('.') || 'env'}: ${i.message}`),
    };
  }
  const e = parsed.data;
  const errors: string[] = [];
  const warnings: string[] = [];

  // 生产环境：密钥强度与安全开关 fail-closed
  if (e.NODE_ENV === 'production') {
    if (e.JWT_SECRET.length < 32) {
      errors.push('JWT_SECRET 在生产环境必须 ≥32 字符（请用随机值，勿用示例值）');
    }
    if (e.JWT_SECRET.includes('dev-only-insecure')) {
      errors.push('JWT_SECRET 仍是示例值，禁止在生产环境使用');
    }
  } else if (e.JWT_SECRET.length < 32) {
    warnings.push('JWT_SECRET 偏短或未设置：仅限本地开发使用');
  }

  if (!/^postgres(ql)?:\/\//.test(e.DATABASE_URL)) {
    errors.push('DATABASE_URL 必须是 postgres:// 或 postgresql:// 连接串');
  }
  if (e.ALLOW_REFRESH_REUSE && e.NODE_ENV === 'production') {
    warnings.push('ALLOW_REFRESH_REUSE=true 会削弱令牌盗用防护，生产环境不建议开启');
  }

  // 生产环境禁止回传验证码（否则任意邮箱可被直接登录/接管）
  if (e.NODE_ENV === 'production' && e.ALLOW_DEV_CODE) {
    errors.push('ALLOW_DEV_CODE=true 在生产环境被禁止（会导致验证码随响应泄露）');
  }
  // 生产环境必须配置邮件通道，否则用户根本收不到验证码（fail-closed）
  if (e.NODE_ENV === 'production' && !e.MAIL_WEBHOOK_URL) {
    errors.push('生产环境必须配置 MAIL_WEBHOOK_URL（否则验证码无法送达，用户将无法登录）');
  }
  if (e.NODE_ENV !== 'production' && !e.MAIL_WEBHOOK_URL) {
    warnings.push('未配置 MAIL_WEBHOOK_URL：验证码只会打印到服务端控制台（仅限开发/自测）');
  }
  if (e.DEVICE_BINDING_MODE === 'strict' && e.NODE_ENV === 'production') {
    warnings.push('DEVICE_BINDING_MODE=strict：新设备会被拒绝，请确保已提供设备管理（/v1/me/devices）与解绑流程');
  }

  if (errors.length > 0) return { ok: false, errors, warnings };

  return {
    ok: true,
    warnings,
    config: {
      env: e.NODE_ENV,
      host: e.HOST,
      port: e.PORT,
      databaseUrl: e.DATABASE_URL,
      db: {
        poolMax: e.DB_POOL_MAX,
        idleTimeoutMs: e.DB_IDLE_TIMEOUT_MS,
        connectionTimeoutMs: e.DB_CONNECTION_TIMEOUT_MS,
        statementTimeoutMs: e.DB_STATEMENT_TIMEOUT_MS,
      },
      auth: {
        // 开发环境允许空密钥（用固定开发密钥，保证本地可跑）
        jwtSecret: e.JWT_SECRET || 'dev-only-insecure-secret-change-me-0123456789',
        accessTokenTtlSec: e.ACCESS_TOKEN_TTL_SEC,
        refreshTokenTtlDays: e.REFRESH_TOKEN_TTL_DAYS,
        allowRefreshReuse: e.ALLOW_REFRESH_REUSE,
        deviceBindingMode: e.DEVICE_BINDING_MODE,
        // 生产环境即使显式开启也已被上面的 errors 拦下；这里再兜一层
        allowDevCode: e.ALLOW_DEV_CODE && e.NODE_ENV !== 'production',
        codeTtlSec: e.CODE_TTL_SEC,
        codeMaxPerWindow: e.CODE_MAX_PER_WINDOW,
        codeWindowSec: e.CODE_WINDOW_SEC,
        codeResendCooldownSec: e.CODE_RESEND_COOLDOWN_SEC,
        codeMaxAttempts: e.CODE_MAX_ATTEMPTS,
      },
      mail: {
        webhookUrl: e.MAIL_WEBHOOK_URL,
        from: e.MAIL_FROM,
        timeoutMs: e.MAIL_TIMEOUT_MS,
      },
      // 生产默认使用 PG 共享计数（多实例下阈值才准确）；开发/测试默认进程内，零额外往返
      rateLimitStore: e.RATE_LIMIT_STORE ?? (e.NODE_ENV === 'production' ? 'postgres' : 'memory'),
      limits: {
        authPerMin: e.RATE_LIMIT_AUTH_PER_MIN,
        apiPerMin: e.RATE_LIMIT_API_PER_MIN,
        writePerMin: e.RATE_LIMIT_WRITE_PER_MIN,
        bodyLimitBytes: e.BODY_LIMIT_BYTES,
        maxSettingsBytes: e.MAX_SETTINGS_BYTES,
        maxMemoriesPerBulk: e.MAX_MEMORIES_PER_BULK,
        maxStatsEventsPerBatch: e.MAX_STATS_EVENTS_PER_BATCH,
      },
      corsOrigins: e.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
      logLevel: e.LOG_LEVEL,
      statsTimezone: e.STATS_TIMEZONE,
      trustProxy: e.TRUST_PROXY,
    },
  };
}
