/**
 * @module http/errors
 * @description 统一错误类型与错误码。
 *
 * 对外只暴露 `code` + 安全文案；内部细节（SQL 错误、堆栈）只进日志，绝不返回给客户端。
 */

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'INVALID_CREDENTIALS'
  | 'TOKEN_EXPIRED'
  | 'TOKEN_REUSED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'REVISION_MISMATCH'
  | 'PAYLOAD_TOO_LARGE'
  | 'RATE_LIMITED'
  | 'UNSUPPORTED'
  | 'UNAVAILABLE'
  | 'INTERNAL';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  TOKEN_EXPIRED: 401,
  TOKEN_REUSED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  REVISION_MISMATCH: 409,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  UNSUPPORTED: 415,
  UNAVAILABLE: 503,
  INTERNAL: 500,
};

export interface ErrorDetails {
  [key: string]: unknown;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: ErrorDetails;
  /** 是否可安全地把 message 返回给客户端（默认 true；INTERNAL 建议 false） */
  readonly expose: boolean;

  constructor(code: ErrorCode, message: string, details?: ErrorDetails, options: { expose?: boolean } = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = details;
    this.expose = options.expose ?? code !== 'INTERNAL';
  }

  toPayload(): { code: ErrorCode; message: string; details?: ErrorDetails } {
    return {
      code: this.code,
      message: this.expose ? this.message : '服务器内部错误',
      ...(this.details && this.expose ? { details: this.details } : {}),
    };
  }
}

// ── 便捷构造 ────────────────────────────────────────────────────────

export const badRequest = (message: string, details?: ErrorDetails) =>
  new AppError('VALIDATION_ERROR', message, details);

export const unauthenticated = (message = '未登录或凭证无效') =>
  new AppError('UNAUTHENTICATED', message);

/**
 * 凭证类失败（登录密码/验证码等）。
 *
 * 注意：默认文案刻意不区分"邮箱不存在"与"密码错误"（防账号枚举）；
 * 但验证码场景需要给出可区分的提示，因此接受可选 message——
 * 之前该参数被丢弃，导致"验证码错误"也显示"邮箱或密码不正确"（误导）。
 */
export const invalidCredentials = (message = '邮箱或密码不正确') =>
  new AppError('INVALID_CREDENTIALS', message);

export const forbidden = (message = '无权访问') => new AppError('FORBIDDEN', message);

export const notFound = (message = '资源不存在') => new AppError('NOT_FOUND', message);

export const conflict = (message: string, details?: ErrorDetails) =>
  new AppError('CONFLICT', message, details);

export const revisionMismatch = (currentRevision: number) =>
  new AppError('REVISION_MISMATCH', '设置已被其他设备修改，请拉取最新版本后重试', { currentRevision });

export const payloadTooLarge = (message: string, details?: ErrorDetails) =>
  new AppError('PAYLOAD_TOO_LARGE', message, details);

export const rateLimited = (retryAfterSec: number) =>
  new AppError('RATE_LIMITED', '请求过于频繁，请稍后再试', { retryAfterSec });

/** 服务暂不可用（503）：如就绪探测失败（SV-008 统一纳入错误码管理） */
export const unavailable = (message = '服务暂时不可用', details?: ErrorDetails) =>
  new AppError('UNAVAILABLE', message, details);

export const internal = (message: string, details?: ErrorDetails) =>
  new AppError('INTERNAL', message, details, { expose: false });
