/**
 * @module logger
 * @description Server 包的极简结构化日志（零依赖，JSON 行输出）。
 *
 * 为什么不直接用 pino：Server 包的运行期依赖刻意保持精简（fastify/pg/jose/argon2/zod），
 * 服务层需要日志时不应引入新的直接依赖；需要更完整的可观测性时可在 main 里替换实现。
 *
 * 安全：默认对敏感字段（code / password / token / credential 等）做脱敏，
 * 避免验证码、密码、令牌被写进日志。
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

let minLevel: LogLevel = (process.env['LOG_LEVEL'] as LogLevel) || 'info';

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

/** 需要脱敏的键（大小写不敏感、含子串匹配） */
const SENSITIVE_KEY_PATTERNS = [
  'password',
  'passwd',
  'secret',
  'token',
  'credential',
  'authorization',
  'cookie',
  'devcode',
  'code',
];

export function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_KEY_PATTERNS.some((p) => lower.includes(p));
}

/** 递归脱敏（仅处理普通对象/数组；深度上限防环） */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[deep]';
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSensitiveKey(k) ? '[REDACTED]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

type Fields = Record<string, unknown>;

function emit(level: LogLevel, message: string, fields?: Fields): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
  const payload = {
    ts: new Date().toISOString(),
    level,
    message,
    ...(fields ? (redact(fields) as Fields) : {}),
  };
  const line = JSON.stringify(payload);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (message: string, fields?: Fields) => emit('debug', message, fields),
  info: (message: string, fields?: Fields) => emit('info', message, fields),
  warn: (message: string, fields?: Fields) => emit('warn', message, fields),
  error: (message: string, fields?: Fields) => emit('error', message, fields),
};
