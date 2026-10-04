/**
 * @module http/respond
 * @description 统一响应约定（与桌面端后端保持一致）：
 *   成功：{ ok: true,  data: <payload> }
 *   失败：{ ok: false, error: { code, message, details? } }
 */

import type { FastifyReply } from 'fastify';
import { AppError } from './errors.js';

export interface OkBody<T> {
  ok: true;
  data: T;
}

export interface ErrBody {
  ok: false;
  error: { code: string; message: string; details?: Record<string, unknown> };
}

/** 成功响应 */
export function ok<T>(reply: FastifyReply, data: T, status = 200): FastifyReply {
  return reply.code(status).send({ ok: true, data } satisfies OkBody<T>);
}

/** 失败响应（AppError → 状态码与错误体） */
export function fail(reply: FastifyReply, error: AppError): FastifyReply {
  if (error.code === 'RATE_LIMITED') {
    const retryAfter = Number(error.details?.['retryAfterSec'] ?? 60);
    reply.header('Retry-After', String(Math.max(1, Math.ceil(retryAfter))));
  }
  return reply.code(error.status).send({ ok: false, error: error.toPayload() } satisfies ErrBody);
}
