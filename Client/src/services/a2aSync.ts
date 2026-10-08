/**
 * @module services/a2aSync
 * @description A2A **客户端同步编排**（P0c）—— 设计 §15.3 / §15.4。
 *
 * 职责（全部在渲染进程）：
 *  1. **上行**：取本地待上行消息（主进程 IPC）→ **客户端脱敏** → 分批（≤500/批）`POST /v1/a2a/messages/bulk`
 *     → **成功后**才标记已上行（失败留待下次重试，天然幂等）；
 *  2. **拉回**：`GET /v1/a2a/messages` 游标增量 → 交主进程应用（**本机优先**：已有则跳过，不覆盖本机判定）；
 *  3. **编排**：`syncA2A()` 串起两者，**永不抛出**（同步失败不得打断主流程，错误以结果形式返回）。
 *
 * 依赖注入：`A2ASyncDeps` 可整体替换（测试无需 Electron/网络）。
 */

import {
  ipcA2AApplyPulled, ipcA2AListUnsynced, ipcA2AMarkSynced, type IpcSyncRow,
} from './ipcApi';
import { serverGet, serverPost, type ServerResult } from './serverApi';

/** 单批上限（与服务端契约一致） */
export const MAX_BATCH_SIZE = 500;
/** 拉回分页大小 */
export const PULL_PAGE_SIZE = 200;
/** 拉回最多页数（防止长时间占用） */
export const PULL_MAX_PAGES = 20;

/** 服务端 A2A 消息 DTO（与 Server 端 `a2aService` 的 DTO 对齐） */
export interface ServerA2AMessage {
  messageId: string;
  taskId: string;
  traceId: string;
  kind: string;
  sourceAgentId: string;
  targetAgentId: string;
  visibility: string;
  contentHash: string;
  prevHash: string | null;
  payload: unknown;
  summary: string | null;
  verdict: string;
  redactedFields: string[];
  truncated: boolean;
  createdAt: number;
}

export interface A2ASyncDeps {
  listUnsynced(limit: number): Promise<{ ok: boolean; data?: IpcSyncRow[]; error?: string }>;
  markSynced(ids: string[]): Promise<{ ok: boolean; data?: { marked: number }; error?: string }>;
  applyPulled(items: unknown[]): Promise<{ ok: boolean; data?: { applied: number; skipped: number }; error?: string }>;
  postServer<T>(path: string, body: unknown): Promise<ServerResult<T>>;
  getServer<T>(path: string, query?: Record<string, string | number>): Promise<ServerResult<T>>;
}

/** 默认依赖（Electron IPC + 服务端 API） */
export function defaultA2ASyncDeps(): A2ASyncDeps {
  return {
    listUnsynced: ipcA2AListUnsynced,
    markSynced: ipcA2AMarkSynced,
    applyPulled: ipcA2AApplyPulled,
    postServer: serverPost,
    getServer: serverGet,
  };
}

// ── 客户端脱敏（上传前，主要防线）──────────────────────────────────

/** 密钥/令牌模式（与服务端防御性扫描同源；客户端为首要防线） */
const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bBearer\s+[A-Za-z0-9._-]{16,}\b/g,
  /\bAKIA[0-9A-Z]{12,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
];
/** 敏感键名（值直接替换） */
const SENSITIVE_KEY = /^(token|password|secret|api[_-]?key|authorization)$/i;

/** 递归脱敏：返回替换后的载荷与被改动字段路径 */
export function redactForUpload(value: unknown, path = '$', out: string[] = []): { payload: unknown; redactedFields: string[] } {
  if (typeof value === 'string') {
    let next = value;
    for (const re of SECRET_PATTERNS) {
      if (re.test(next)) {
        next = next.replace(re, '«redacted:secret»');
        if (!out.includes(path)) out.push(path);
      }
      re.lastIndex = 0;
    }
    return { payload: next, redactedFields: out };
  }
  if (Array.isArray(value)) {
    return { payload: value.map((v, i) => redactForUpload(v, `${path}[${i}]`, out).payload), redactedFields: out };
  }
  if (value && typeof value === 'object') {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY.test(k)) {
        obj[k] = '«redacted:secret»';
        if (!out.includes(`${path}.${k}`)) out.push(`${path}.${k}`);
        continue;
      }
      obj[k] = redactForUpload(v, `${path}.${k}`, out).payload;
    }
    return { payload: obj, redactedFields: out };
  }
  return { payload: value, redactedFields: out };
}

/** 本地行 → 上行条目（含脱敏结果） */
export function toServerItem(row: IpcSyncRow): { item: Record<string, unknown>; redactedFields: string[] } {
  const { payload, redactedFields } = redactForUpload(row.payload ?? {});
  return {
    item: {
      messageId: row.messageId,
      taskId: row.taskId,
      traceId: row.traceId,
      kind: row.kind,
      sourceAgentId: row.sourceAgentId,
      targetAgentId: row.targetAgentId,
      ...(row.parentMessageId ? { parentMessageId: row.parentMessageId } : {}),
      ...(row.correlationId ? { correlationId: row.correlationId } : {}),
      visibility: row.visibility,
      contentHash: row.contentHash,
      ...(row.prevHash ? { prevHash: row.prevHash } : {}),
      payload,
      ...(row.summary ? { summary: row.summary } : {}),
      verdict: row.verdict,
      priority: row.priority,
      ...(row.memoryRefs && row.memoryRefs.length > 0 ? { memoryRefs: row.memoryRefs } : {}),
      ...(redactedFields.length > 0 ? { redactedFields } : {}),
      createdAt: row.createdAt,
    },
    redactedFields,
  };
}

// ── 上行 ───────────────────────────────────────────────────────────

export interface PushA2AResult {
  pushed: number;
  batches: number;
  redacted: number;
  errors: string[];
}

/** 上行待同步消息；**每批成功后**才标记已同步 */
export async function pushA2A(deps: A2ASyncDeps, options: { limit?: number; batchSize?: number } = {}): Promise<PushA2AResult> {
  const limit = Math.max(1, options.limit ?? 1000);
  const batchSize = Math.min(Math.max(1, options.batchSize ?? MAX_BATCH_SIZE), MAX_BATCH_SIZE);
  const result: PushA2AResult = { pushed: 0, batches: 0, redacted: 0, errors: [] };

  const listed = await deps.listUnsynced(limit);
  if (!listed.ok) { result.errors.push(listed.error ?? 'listUnsynced 失败'); return result; }
  const rows = listed.data ?? [];
  if (rows.length === 0) return result;

  const prepared = rows.map(toServerItem);
  for (let i = 0; i < prepared.length; i += batchSize) {
    const slice = prepared.slice(i, i + batchSize);
    const res = await deps.postServer<{ created: number; updated: number; total: number }>(
      '/v1/a2a/messages/bulk',
      { items: slice.map(s => s.item) },
    );
    if (!res.ok) {
      result.errors.push(`批 ${result.batches + 1} 上行失败：${String(res.error?.message ?? res.error)}`);
      break;                                   // 失败即停：不标记，下次重试
    }
    const marked = await deps.markSynced(slice.map(s => String(s.item['messageId'])));
    if (!marked.ok) { result.errors.push(marked.error ?? 'markSynced 失败'); break; }
    result.pushed += slice.length;
    result.batches += 1;
    result.redacted += slice.filter(s => s.redactedFields.length > 0).length;
  }
  return result;
}

// ── 拉回 ───────────────────────────────────────────────────────────

export interface PullA2AResult {
  pages: number;
  received: number;
  applied: number;
  skipped: number;
  errors: string[];
}

/** 拉回服务端消息（游标增量）；`applyPulled` **本机优先**，已有则跳过 */
export async function pullA2A(
  deps: A2ASyncDeps,
  options: { pageSize?: number; maxPages?: number; since?: number } = {},
): Promise<PullA2AResult> {
  const pageSize = Math.min(Math.max(1, options.pageSize ?? PULL_PAGE_SIZE), MAX_BATCH_SIZE);
  const maxPages = Math.max(1, options.maxPages ?? PULL_MAX_PAGES);
  const out: PullA2AResult = { pages: 0, received: 0, applied: 0, skipped: 0, errors: [] };
  let cursor: string | null = null;

  for (let page = 0; page < maxPages; page++) {
    const query: Record<string, string | number> = { limit: pageSize };
    if (cursor) query['cursor'] = cursor;
    if (options.since !== undefined && page === 0) query['since'] = options.since;

    const res = await deps.getServer<{ items: ServerA2AMessage[]; nextCursor: string | null }>('/v1/a2a/messages', query);
    if (!res.ok) { out.errors.push(`拉回失败：${String(res.error?.message ?? res.error)}`); break; }

    const items = res.data?.items ?? [];
    out.pages += 1;
    out.received += items.length;
    if (items.length > 0) {
      const applied = await deps.applyPulled(items);
      if (!applied.ok) { out.errors.push(applied.error ?? 'applyPulled 失败'); break; }
      out.applied += applied.data?.applied ?? 0;
      out.skipped += applied.data?.skipped ?? 0;
    }
    cursor = res.data?.nextCursor ?? null;
    if (!cursor || items.length === 0) break;
  }
  return out;
}

// ── 编排 ───────────────────────────────────────────────────────────

export interface A2ASyncResult {
  ok: boolean;
  skipped?: 'disabled';
  push: PushA2AResult;
  pull: PullA2AResult;
  errors: string[];
}

/**
 * 一次完整同步（上行 → 拉回）。
 * @param options.enabled 关闭时直接返回 `{ ok:true, skipped:'disabled' }`（同步开关，默认开）
 */
export async function syncA2A(options: { deps?: A2ASyncDeps; enabled?: boolean; limit?: number; maxPages?: number } = {}): Promise<A2ASyncResult> {
  const deps = options.deps ?? defaultA2ASyncDeps();
  const empty: PushA2AResult = { pushed: 0, batches: 0, redacted: 0, errors: [] };
  const emptyPull: PullA2AResult = { pages: 0, received: 0, applied: 0, skipped: 0, errors: [] };
  if (options.enabled === false) {
    return { ok: true, skipped: 'disabled', push: empty, pull: emptyPull, errors: [] };
  }
  const push = await pushA2A(deps, { ...(options.limit !== undefined ? { limit: options.limit } : {}) });
  const pull = await pullA2A(deps, { ...(options.maxPages !== undefined ? { maxPages: options.maxPages } : {}) });
  const errors = [...push.errors, ...pull.errors];
  return { ok: errors.length === 0, push, pull, errors };
}
