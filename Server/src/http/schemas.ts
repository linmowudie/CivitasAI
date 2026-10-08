/**
 * @module http/schemas
 * @description 全部请求体的 Zod 校验（路由层唯一入口，禁止裸读 req.body）。
 */

import { z } from 'zod';
import { emailSchema, isoTimestampSchema, paginationSchema, passwordSchema } from './validate.js';
import { BACKUP_FORMAT } from '../services/backupService.js';

const deviceLabel = z.string().trim().max(64).nullish();

// ── 鉴权 ────────────────────────────────────────────────────────────

export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  displayName: z.string().trim().min(1).max(64).nullish(),
  deviceLabel,
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, '密码必填').max(200),
  deviceLabel,
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(20, '刷新令牌格式不正确').max(512),
  deviceLabel,
});

export const logoutSchema = z
  .object({
    refreshToken: z.string().min(20).max(512).optional(),
    allDevices: z.boolean().optional(),
  })
  .refine((v) => !!v.refreshToken || v.allDevices === true, {
    message: '需提供 refreshToken 或 allDevices=true',
  });

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, '当前密码必填').max(200),
  newPassword: passwordSchema,
  deviceLabel,
});

// ── 验证码认证 ───────────────────────────────────────────────────────

export const sendCodeSchema = z.object({
  email: emailSchema,
  purpose: z.enum(['register', 'login', 'reset_password']).default('login'),
});

export const loginWithCodeSchema = z.object({
  email: emailSchema,
  code: z.string().min(6, '验证码为6位数字').max(6),
  displayName: z.string().trim().min(1).max(64).nullish(),
  deviceLabel,
  /** 安装 ID（展示与审计用） */
  deviceId: z.string().trim().max(128).nullish(),
  /** 安装期设备凭据（服务端只存 sha256；作为设备身份依据，替代易变硬件指纹） */
  deviceCredential: z.string().trim().max(256).nullish(),
});

// ── 资料 ────────────────────────────────────────────────────────────

export const updateProfileSchema = z.object({
  displayName: z.string().trim().max(64).nullable(),
});

export const deleteAccountSchema = z.object({
  password: z.string().min(1, '需输入密码以确认注销').max(200),
});

// ── 设置 ────────────────────────────────────────────────────────────

const expectedRevision = z.number().int().min(0).optional();

export const settingsPutSchema = z.object({
  data: z.record(z.unknown()),
  expectedRevision,
});

export const settingsPatchSchema = z.object({
  patch: z.record(z.unknown()),
  expectedRevision,
});

// ── 统计 ────────────────────────────────────────────────────────────

export const statsEventSchema = z.object({
  kind: z.string().trim().min(1).max(64),
  value: z.number().finite().optional().default(0),
  occurredAt: isoTimestampSchema,
  clientEventId: z.string().trim().max(128).nullish(),
  meta: z.record(z.unknown()).nullish(),
});

export const statsIngestSchema = z.object({
  events: z.array(statsEventSchema).min(1, 'events 不能为空').max(5000),
});

export const statsRangeQuerySchema = z.object({
  from: isoTimestampSchema.optional(),
  to: isoTimestampSchema.optional(),
  kind: z.string().trim().max(64).optional(),
});

// ── 记忆 ────────────────────────────────────────────────────────────

export const memoryAssertionSchema = z.enum(['observed', 'inferred', 'verified', 'disputed']);
export const memoryStatusSchema = z.enum(['active', 'archived', 'deleted']);

export const memoryCreateSchema = z.object({
  clientMemoryId: z.string().trim().max(128).nullish(),
  title: z.string().trim().min(1, '标题必填').max(500),
  content: z.string().min(1, '内容必填').max(200_000),
  category: z.string().trim().min(1).max(64).optional(),
  assertion: memoryAssertionSchema.optional(),
  sourceTraceIds: z.array(z.unknown()).optional(),
  sourceArbitrationIds: z.array(z.unknown()).nullish(),
  status: memoryStatusSchema.optional(),
  contradictedBy: z.string().trim().max(200).nullish(),
  accessCount: z.number().int().min(0).optional(),
  createdAt: isoTimestampSchema.optional(),
  lastAccessedAt: isoTimestampSchema.optional(),
});

export const memoryUpdateSchema = memoryCreateSchema
  .omit({ clientMemoryId: true })
  .partial();

export const memoryListQuerySchema = paginationSchema.extend({
  category: z.string().trim().max(64).optional(),
  status: memoryStatusSchema.optional(),
  q: z.string().trim().min(1).max(200).optional(),
});

export const memoryBulkSchema = z.object({
  items: z.array(memoryCreateSchema).min(1, 'items 不能为空'),
});

// ── 任务（会话）元数据 ───────────────────────────────────────────────

/** 客户端上行的任务元数据（仅标题 + 归档状态；正文不上行） */
export const taskUpsertSchema = z.object({
  clientSessionId: z.string().trim().min(1).max(128),
  title: z.string().trim().max(200).optional(),
  /** 本机创建/更新时间（epoch ms） */
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  /** 归档时间（epoch ms）；null/缺省 = 未归档 */
  archivedAt: z.number().int().nonnegative().nullable().optional(),
});

export const taskBulkSchema = z.object({
  items: z.array(taskUpsertSchema).min(1, 'items 不能为空').max(500, '单批最多 500 条'),
});

export const taskListQuerySchema = z.object({
  /** true=仅已归档；false=仅未归档；all=全部（缺省=全部） */
  archived: z
    .union([z.string(), z.boolean()])
    .optional()
    .transform((v) => (v === true || v === 'true' || v === '1' ? true : v === false || v === 'false' || v === '0' ? false : 'all'))
    .pipe(z.union([z.boolean(), z.literal('all')])),
  limit: z
    .union([z.string(), z.number()])
    .optional()
    .transform((v) => (v === undefined || v === '' ? 500 : Number(v)))
    .refine((v) => Number.isInteger(v) && v > 0 && v <= 2000, { message: 'limit 必须是 1..2000 的整数' }),
});

// ── 备份 / 恢复 ─────────────────────────────────────────────────────

export const backupExportQuerySchema = z.object({
  includeStats: z
    .union([z.string(), z.boolean()])
    .optional()
    .transform((v) => v === true || v === 'true' || v === '1'),
  /**
   * 统计事件导出的**显式**上限（SV-001 闭环）。
   *
   * 缺省（不传）→ 键集分页全量导出，包内无 `truncated` 标记；
   * 传入 → 只导出前 N 条，并在 `truncated.stats` 如实标注，绝不静默截断。
   */
  statsLimit: z
    .union([z.string(), z.number()])
    .optional()
    .transform((v) => (v === undefined || v === '' ? undefined : Number(v)))
    .refine((v) => v === undefined || (Number.isInteger(v) && v > 0 && v <= 100_000), {
      message: 'statsLimit 必须是 1..100000 的整数',
    }),
});

export const backupMemorySchema = z.object({
  id: z.string().min(1),
  clientMemoryId: z.string().nullable(),
  title: z.string().min(1),
  content: z.string(),
  category: z.string(),
  assertion: memoryAssertionSchema,
  status: memoryStatusSchema,
  contradictedBy: z.string().nullable(),
  sourceTraceIds: z.array(z.unknown()).default([]),
  sourceArbitrationIds: z.array(z.unknown()).nullable(),
  accessCount: z.number().int().min(0).default(0),
  createdAt: z.string(),
  lastAccessedAt: z.string(),
  updatedAt: z.string(),
});

export const backupBundleSchema = z.object({
  format: z.literal(BACKUP_FORMAT),
  version: z.number().int().min(1),
  exportedAt: z.string(),
  account: z.object({ email: z.string(), displayName: z.string().nullable() }).optional(),
  settings: z
    .object({
      revision: z.number().int().min(0),
      data: z.record(z.unknown()),
      updatedAt: z.string(),
    })
    .nullable()
    .optional()
    .default(null),
  memories: z.array(backupMemorySchema).default([]),
  /**
   * 任务（会话）元数据：标题 + 归档状态（正文只存本机）。
   * 必须在此显式声明：否则 zod 会把该字段**剥掉**（曾导致恢复后任务元数据丢失）。
   * 老备份包不含 tasks 时保持默认空数组。
   */
  tasks: z
    .array(
      z.object({
        clientSessionId: z.string().min(1),
        title: z.string().default(''),
        createdAt: z.number().int().nonnegative(),
        updatedAt: z.number().int().nonnegative(),
        archivedAt: z.number().int().nonnegative().nullable().optional().default(null),
      }),
    )
    .optional()
    .default([]),
  stats: z
    .object({
      events: z.array(
        z.object({
          kind: z.string(),
          value: z.number(),
          occurredAt: z.string(),
          clientEventId: z.string().nullable(),
          meta: z.record(z.unknown()).nullable(),
        }),
      ),
    })
    .nullable()
    .optional()
    .default(null),
});

export const restoreSchema = z.object({
  bundle: backupBundleSchema,
  mode: z.enum(['replace', 'merge']).default('merge'),
});

// ── A2A 镜像（P0c）─────────────────────────────────────────────────

const a2aMemoryRefSchema = z.object({
  key: z.string().min(1).max(300),
  version: z.number().int().nonnegative(),
});

export const a2aMessageUpsertSchema = z.object({
  messageId: z.string().min(1).max(200),
  taskId: z.string().min(1).max(200),
  traceId: z.string().min(1).max(200),
  kind: z.string().min(1).max(40),
  sourceAgentId: z.string().min(1).max(200),
  targetAgentId: z.string().min(1).max(200),
  parentMessageId: z.string().max(200).optional(),
  correlationId: z.string().max(200).optional(),
  visibility: z.enum(['public', 'domain', 'private']),
  contentHash: z.string().min(1).max(128),
  prevHash: z.string().max(128).nullable().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  summary: z.string().max(4000).optional(),
  verdict: z.enum(['allow', 'block', 'quarantine', 'redirect']),
  blockReason: z.string().max(2000).optional(),
  priority: z.enum(['low', 'normal', 'high', 'critical']).optional(),
  memoryRefs: z.array(a2aMemoryRefSchema).max(50).optional(),
  redactedFields: z.array(z.string().max(300)).max(200).optional(),
  createdAt: z.number().int().nonnegative(),
});

export const a2aMessageBulkSchema = z.object({
  items: z.array(a2aMessageUpsertSchema).min(1, 'items 不能为空').max(500, '单批最多 500 条'),
});

export const a2aMessageListQuerySchema = z.object({
  taskId: z.string().max(200).optional(),
  agentId: z.string().max(200).optional(),
  since: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  cursor: z.string().max(600).optional(),
});

const a2aCardUpsertSchema = z.object({
  cardId: z.string().min(1).max(200),
  agentId: z.string().min(1).max(200),
  cardVersion: z.number().int().positive(),
  role: z.string().min(1).max(60),
  createTime: z.number().int().nonnegative(),
  fatherAgentId: z.string().max(200).nullable().optional(),
  fatherRole: z.string().max(60).nullable().optional(),
  lineage: z.array(z.string().max(200)).max(50).optional(),
  status: z.string().min(1).max(40),
  health: z.record(z.string(), z.unknown()).optional(),
  ability: z.record(z.string(), z.unknown()).optional(),
  permission: z.record(z.string(), z.unknown()).optional(),
  fingerprint: z.string().min(1).max(128),
  expiresAt: z.number().int().nonnegative(),
});

export const a2aCardBulkSchema = z.object({
  items: z.array(a2aCardUpsertSchema).min(1, 'items 不能为空').max(500, '单批最多 500 条'),
});
