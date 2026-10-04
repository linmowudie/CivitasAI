/**
 * @module http/validate
 * @description Zod 校验辅助：把 ZodError 转成统一的 VALIDATION_ERROR（含字段路径）。
 */

import { z } from 'zod';
import { badRequest } from './errors.js';
import type { ErrorDetails } from './errors.js';

export interface ParseOptions {
  /** 字段前缀（用于报错定位，如 'body' / 'query'） */
  scope?: string;
}

function toDetails(error: z.ZodError, scope?: string): ErrorDetails {
  return {
    issues: error.issues.map((i) => ({
      path: [scope, ...i.path.map(String)].filter(Boolean).join('.'),
      message: i.message,
      code: i.code,
    })),
  };
}

/** 解析并返回数据；失败抛 VALIDATION_ERROR */
export function parseOrThrow<T extends z.ZodTypeAny>(
  schema: T,
  value: unknown,
  options: ParseOptions = {},
): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw badRequest('请求参数校验失败', toDetails(result.error, options.scope));
  }
  return result.data as z.infer<T>;
}

// ── 常用字段 ────────────────────────────────────────────────────────

/** 邮箱：trim + 小写；长度上限防滥用 */
export const emailSchema = z
  .string()
  .trim()
  .min(3, '邮箱过短')
  .max(254, '邮箱过长')
  .email('邮箱格式不正确')
  .transform((v) => v.toLowerCase());

/** 密码：至少 8 位，且必须包含字母与数字（可用符号） */
export const passwordSchema = z
  .string()
  .min(8, '密码至少 8 位')
  .max(200, '密码过长')
  .refine((v) => /[A-Za-z]/.test(v), { message: '密码需包含字母' })
  .refine((v) => /\d/.test(v), { message: '密码需包含数字' });

/** ISO 时间字符串 → Date */
export const isoTimestampSchema = z
  .string()
  .datetime({ offset: true, message: '需为 ISO 8601 时间（含时区）' })
  .transform((v) => new Date(v));

/** 分页：limit + cursor */
export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  cursor: z.string().max(200).optional(),
});
