/**
 * @module services/a2aService
 * @description A2A 镜像服务（P0c）—— 设计 §15.1/§15.3/§15.4。
 *
 * 三条硬规则：
 *  1. **本机权威**：服务端只镜像，不产生 verdict/签名；拉回时不会反向覆盖本机判定；
 *  2. **脱敏**：客户端应上传前脱敏；服务端再做**防御性扫描**（密钥/令牌模式 → 替换 + 记录字段路径）；
 *  3. **限额**：单条载荷 ≤ 64KB，超出则截断并置 `truncated=true`（保留 `contentHash` 供本机校验）。
 *
 * 刻意不做：告警证据正文、`signature` 的存储与验签（见 Q6）。
 */

import type { Db } from '../db/pool.js';
import * as repo from '../repositories/a2a.js';

/** 单条载荷上限（序列化后字节） */
export const MAX_PAYLOAD_BYTES = 64 * 1024;

export interface A2AMessageInputDto {
  messageId: string;
  taskId: string;
  traceId: string;
  kind: string;
  sourceAgentId: string;
  targetAgentId: string;
  parentMessageId?: string;
  correlationId?: string;
  visibility: string;
  contentHash: string;
  prevHash?: string | null;
  payload?: Record<string, unknown>;
  summary?: string;
  verdict: string;
  blockReason?: string;
  priority?: string;
  memoryRefs?: Array<{ key: string; version: number }>;
  redactedFields?: string[];
  createdAt: number;
}

export interface A2AMessageDto {
  messageId: string;
  taskId: string;
  traceId: string;
  kind: string;
  sourceAgentId: string;
  targetAgentId: string;
  parentMessageId: string | null;
  correlationId: string | null;
  visibility: string;
  contentHash: string;
  prevHash: string | null;
  payload: unknown;
  summary: string | null;
  verdict: string;
  blockReason: string | null;
  priority: string;
  memoryRefs: unknown;
  redactedFields: string[];
  truncated: boolean;
  createdAt: number;
}

export interface A2ACardInputDto {
  cardId: string;
  agentId: string;
  cardVersion: number;
  role: string;
  createTime: number;
  fatherAgentId?: string | null;
  fatherRole?: string | null;
  lineage?: string[];
  status: string;
  health?: unknown;
  ability?: unknown;
  permission?: unknown;
  fingerprint: string;
  expiresAt: number;
}

export interface A2AService {
  upsertMessages(userId: string, items: A2AMessageInputDto[]): Promise<{ created: number; updated: number; total: number; redacted: number; truncated: number }>;
  listMessages(userId: string, options: { taskId?: string; agentId?: string; since?: number; limit?: number; cursor?: string }): Promise<{ items: A2AMessageDto[]; nextCursor: string | null; total: number }>;
  upsertCards(userId: string, items: A2ACardInputDto[]): Promise<{ created: number; updated: number; total: number }>;
}

/** 常见密钥/令牌模式（防御性扫描；命中即替换为占位符） */
const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,                 // OpenAI 风格
  /\bBearer\s+[A-Za-z0-9._-]{16,}\b/g,         // Bearer 令牌
  /\bAKIA[0-9A-Z]{12,}\b/g,                     // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,            // GitHub token
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,   // JWT
];

/** 递归脱敏（返回替换后的值与被改动的字段路径） */
export function redactSecrets(value: unknown, path = '$', out: string[] = []): { value: unknown; redactedFields: string[] } {
  if (typeof value === 'string') {
    let next = value;
    for (const re of SECRET_PATTERNS) {
      if (re.test(next)) {
        next = next.replace(re, '«redacted:secret»');
        if (!out.includes(path)) out.push(path);
      }
      re.lastIndex = 0;
    }
    return { value: next, redactedFields: out };
  }
  if (Array.isArray(value)) {
    const arr = value.map((v, i) => redactSecrets(v, `${path}[${i}]`, out).value);
    return { value: arr, redactedFields: out };
  }
  if (value && typeof value === 'object') {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // 键名本身也可能是敏感标记（如 token/password 字段）→ 直接替换值
      if (/^(token|password|secret|api[_-]?key|authorization)$/i.test(k)) {
        obj[k] = '«redacted:secret»';
        if (!out.includes(`${path}.${k}`)) out.push(`${path}.${k}`);
        continue;
      }
      obj[k] = redactSecrets(v, `${path}.${k}`, out).value;
    }
    return { value: obj, redactedFields: out };
  }
  return { value, redactedFields: out };
}

function encodeCursor(createdAt: number, messageId: string): string {
  return Buffer.from(`${createdAt}|${messageId}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): { createdAt: number; messageId: string } | null {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const [createdAt, ...rest] = raw.split('|');
    const messageId = rest.join('|');
    const n = Number(createdAt);
    if (!Number.isFinite(n) || !messageId) return null;
    return { createdAt: n, messageId };
  } catch { return null; }
}

function toDto(row: repo.A2AMessageRow): A2AMessageDto {
  return {
    messageId: row.message_id,
    taskId: row.task_id,
    traceId: row.trace_id,
    kind: row.kind,
    sourceAgentId: row.source_agent_id,
    targetAgentId: row.target_agent_id,
    parentMessageId: row.parent_message_id,
    correlationId: row.correlation_id,
    visibility: row.visibility,
    contentHash: row.content_hash,
    prevHash: row.prev_hash,
    payload: row.payload_json,
    summary: row.summary,
    verdict: row.verdict,
    blockReason: row.block_reason,
    priority: row.priority,
    memoryRefs: row.memory_refs_json,
    redactedFields: Array.isArray(row.redacted_fields) ? (row.redacted_fields as string[]) : [],
    truncated: Boolean(row.truncated),
    createdAt: Number(row.created_at),
  };
}

export function createA2AService(deps: { db: Db }): A2AService {
  const { db } = deps;

  return {
    async upsertMessages(userId, items) {
      let redactedCount = 0;
      let truncatedCount = 0;
      const prepared: repo.A2AMessageInsert[] = items.map(it => {
        const declared = Array.isArray(it.redactedFields) ? [...it.redactedFields] : [];
        const { value: safePayload, redactedFields } = redactSecrets(it.payload ?? {});
        const serverRedacted = redactedFields.filter(f => !declared.includes(f));
        if (serverRedacted.length > 0) redactedCount++;
        declared.push(...serverRedacted);

        let payload = safePayload;
        let truncated = false;
        const size = Buffer.byteLength(JSON.stringify(payload ?? {}), 'utf8');
        if (size > MAX_PAYLOAD_BYTES) {
          // 截断但**保留 contentHash**（本机据此校验，不作正文权威）
          payload = { __truncated: true, originalBytes: size };
          truncated = true;
          truncatedCount++;
        }
        return {
          messageId: it.messageId, taskId: it.taskId, traceId: it.traceId, kind: it.kind,
          sourceAgentId: it.sourceAgentId, targetAgentId: it.targetAgentId,
          parentMessageId: it.parentMessageId ?? null, correlationId: it.correlationId ?? null,
          visibility: it.visibility, contentHash: it.contentHash, prevHash: it.prevHash ?? null,
          payload, summary: it.summary ?? null, verdict: it.verdict, blockReason: it.blockReason ?? null,
          priority: it.priority ?? 'normal', memoryRefs: it.memoryRefs ?? [],
          redactedFields: declared, truncated, createdAt: it.createdAt,
        };
      });

      const { created, updated } = await repo.upsertMessages(db, userId, prepared);
      return { created, updated, total: prepared.length, redacted: redactedCount, truncated: truncatedCount };
    },

    async listMessages(userId, options) {
      const limit = Math.min(Math.max(options.limit ?? 200, 1), 500);
      const cursor = options.cursor ? decodeCursor(options.cursor) : null;
      const rows = await repo.listMessages(db, userId, {
        ...(options.taskId ? { taskId: options.taskId } : {}),
        ...(options.agentId ? { agentId: options.agentId } : {}),
        ...(options.since !== undefined ? { since: options.since } : {}),
        limit, ...(cursor ? { cursor } : {}),
      });
      const items = rows.map(toDto);
      const last = rows[rows.length - 1];
      const nextCursor = rows.length === limit && last
        ? encodeCursor(Number(last.created_at), last.message_id)
        : null;
      return { items, nextCursor, total: items.length };
    },

    async upsertCards(userId, items) {
      const { created, updated } = await repo.upsertCards(db, userId, items.map(c => ({
        cardId: c.cardId, agentId: c.agentId, cardVersion: c.cardVersion, role: c.role,
        createTime: c.createTime, fatherAgentId: c.fatherAgentId ?? null,
        fatherRole: c.fatherRole ?? null, lineage: c.lineage ?? [], status: c.status,
        health: c.health ?? {}, ability: c.ability ?? {}, permission: c.permission ?? {},
        fingerprint: c.fingerprint, expiresAt: c.expiresAt,
      })));
      return { created, updated, total: items.length };
    },
  };
}
