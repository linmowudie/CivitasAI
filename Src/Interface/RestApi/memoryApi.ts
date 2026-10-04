/**
 * @module Interface/RestApi/memoryApi
 * @description
 * Memory API——共享记忆只读视图（前端 FeatureView memory 子视图数据源）。
 *
 * 读取 Data/db/civitas_memory.db 中的记忆条目（memory_entries，由长时记忆镜像投影写入，
 * FE-034）；所有查询按当前属主过滤（FE-032）。
 */

import { json, apiError, registerRoute } from './router.js';
import { getDatabases } from '../../Infra/Db/database.js';

/** 记忆条目类型 */
export interface MemoryEntry {
  key: string;
  value: unknown;
  version: number;
  namespace: string;
  updatedAt: number;
  createdAt: number;
}

/**
 * GET /api/memory/entries — 记忆列表
 *
 * 未指定 namespace 时返回当前属主的全部条目（视图语义）；
 * 数据来自长时记忆的镜像投影（memory_entries，FE-034），按属主隔离（FE-032）。
 */
function listMemoryEntries(query: Record<string, string>): MemoryEntry[] {
  try {
    const db = getDatabases();
    const memoryDb = db.memory;
    if (!memoryDb) return [];

    const limit = Math.min(parseInt(query['limit'] ?? '50', 10), 200);
    const offset = parseInt(query['offset'] ?? '0', 10);

    // 属主条件恒有；namespace 仅显式指定时过滤
    let sql = `SELECT key, value, version, namespace, updated_at, created_at
       FROM memory_entries
       WHERE owner_user_id = ?`;
    const params: Array<string | number> = [getActiveOwner()];
    const namespace = query['namespace'];
    if (namespace) {
      sql += ' AND namespace = ?';
      params.push(namespace);
    }
    sql += ' ORDER BY updated_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const rows = memoryDb.prepare(sql).all(...params) as Array<{
      key: string; value: string; version: number; namespace: string;
      updated_at: number; created_at: number;
    }>;

    return rows.map(row => ({
      key: row.key,
      value: safeJsonParse(row.value),
      version: row.version,
      namespace: row.namespace,
      updatedAt: row.updated_at,
      createdAt: row.created_at,
    }));
  } catch {
    // 查询失败（如迁移未应用），返回空数组
    return [];
  }
}

function safeJsonParse(str: string): unknown {
  try { return JSON.parse(str); } catch { return str; }
}

// ── 长时记忆（long_term_memory 表）──────────────────────────────────
//
// 2026-10-02 新增：长时记忆此前仅在进程内 Map，且没有 REST 端点，
// 导致「账号同步」无法把它上传/恢复到云端。这里提供只读列表与批量导入（恢复用）。

import {
  listAllMemories,
  importMemories,
  searchMemories,
  getActiveOwner,
  setActiveOwner,
  hydrateLongTermMemory,
  type LongTermMemoryEntry,
  type MemoryCategory,
  type MemoryStatus,
} from '../../Services/SharedMemory/longTermMemory.js';

/** 长时记忆 DTO（字段与服务端 `memories` 表对齐，便于无损同步） */
export interface LongTermMemoryDto {
  memoryId: string;
  title: string;
  content: string;
  category: string;
  assertion: string;
  sourceTraceIds: string[];
  sourceArbitrationIds?: string[];
  status: string;
  contradictedBy?: string;
  accessCount: number;
  createdAt: number;
  lastAccessedAt: number;
  /** 检索模式下的相关性分数（FE-058；列表模式无此字段） */
  score?: number;
}

function toDto(entry: LongTermMemoryEntry): LongTermMemoryDto {
  return {
    memoryId: entry.memoryId,
    title: entry.title,
    content: entry.content,
    category: entry.category,
    assertion: entry.assertion,
    sourceTraceIds: entry.sourceTraceIds ?? [],
    sourceArbitrationIds: entry.sourceArbitrationIds,
    status: entry.status,
    contradictedBy: entry.contradictedBy,
    accessCount: entry.accessCount,
    createdAt: entry.createdAt,
    lastAccessedAt: entry.lastAccessedAt,
  };
}

function listLongTermMemory(query: Record<string, string>): LongTermMemoryDto[] {
  const category = query['category'] as MemoryCategory | undefined;
  const status = query['status'] as MemoryStatus | undefined;
  const limit = Math.min(parseInt(query['limit'] ?? '1000', 10) || 1000, 5000);

  // FE-058：带 query 参数时走文本检索（打分排序，仅返回命中）；否则列表语义
  const q = (query['query'] ?? '').trim();
  if (q) {
    return searchMemories(q, { category, status, limit }).map(h => ({
      ...toDto(h.entry),
      score: Number(h.score.toFixed(4)),
    }));
  }

  let items = listAllMemories();
  if (category) items = items.filter((m) => m.category === category);
  if (status) items = items.filter((m) => m.status === status);
  return items.slice(0, limit).map(toDto);
}

/** 请求体 → 领域对象（字段缺失有默认值，非法值直接拒绝） */
function parseEntry(raw: unknown): { ok: true; entry: LongTermMemoryEntry } | { ok: false; reason: string } {
  if (typeof raw !== 'object' || raw === null) return { ok: false, reason: '条目必须是对象' };
  const r = raw as Record<string, unknown>;
  const memoryId = typeof r['memoryId'] === 'string' ? r['memoryId'] : '';
  const title = typeof r['title'] === 'string' ? r['title'] : '';
  const content = typeof r['content'] === 'string' ? r['content'] : '';
  if (!memoryId || !title || !content) return { ok: false, reason: 'memoryId/title/content 必填' };

  const categories: MemoryCategory[] = ['rule', 'fact', 'decision', 'pattern'];
  const statuses: MemoryStatus[] = ['active', 'deprecated', 'contradicted'];
  const category = (typeof r['category'] === 'string' && categories.includes(r['category'] as MemoryCategory)
    ? r['category']
    : 'fact') as MemoryCategory;
  const status = (typeof r['status'] === 'string' && statuses.includes(r['status'] as MemoryStatus)
    ? r['status']
    : 'active') as MemoryStatus;

  const entry: LongTermMemoryEntry = {
    memoryId,
    title,
    content,
    category,
    sourceTraceIds: Array.isArray(r['sourceTraceIds']) ? r['sourceTraceIds'].map(String) : [],
    assertion: (typeof r['assertion'] === 'string' ? r['assertion'] : 'observed') as LongTermMemoryEntry['assertion'],
    createdAt: typeof r['createdAt'] === 'number' ? r['createdAt'] : Date.now(),
    lastAccessedAt: typeof r['lastAccessedAt'] === 'number' ? r['lastAccessedAt'] : Date.now(),
    accessCount: typeof r['accessCount'] === 'number' ? r['accessCount'] : 0,
    status,
  };
  if (Array.isArray(r['sourceArbitrationIds'])) entry.sourceArbitrationIds = r['sourceArbitrationIds'].map(String);
  if (typeof r['contradictedBy'] === 'string') entry.contradictedBy = r['contradictedBy'];
  return { ok: true, entry };
}

// ── 路由注册 ────────────────────────────────────────────────────────

export function registerMemoryRoutes(): void {
  registerRoute('GET', '/api/memory/long-term', async (req) => {
    const isSearch = typeof req.query['query'] === 'string' && req.query['query'].trim() !== '';
    const items = listLongTermMemory(req.query);
    return json({ items, total: items.length, mode: isSearch ? 'search' : 'list', owner: getActiveOwner() });
  });

  /** 批量导入（从云端恢复）——按 memoryId 幂等 upsert，写入**当前属主** */
  registerRoute('POST', '/api/memory/long-term/bulk', async (req) => {
    const body = (req.body ?? {}) as { items?: unknown[] };
    if (!Array.isArray(body.items)) return apiError('items 必须是数组', 400);
    if (body.items.length > 5000) return apiError('单次最多导入 5000 条', 413);

    const entries: LongTermMemoryEntry[] = [];
    for (const raw of body.items) {
      const parsed = parseEntry(raw);
      if (!parsed.ok) return apiError(`条目非法: ${parsed.reason}`, 400);
      entries.push(parsed.entry);
    }
    const result = importMemories(entries);
    if (!result.ok) return apiError(result.error, 500);
    return json({ ...result.value, total: entries.length, owner: getActiveOwner() });
  });

  // ── 账号数据命名空间（跨账号数据隔离，FE-032）────────────────────────
  // 客户端在登录/登出时调用：本地长时记忆按属主分区，切换后只读写该账号的数据。

  /** 读取当前属主 */
  registerRoute('GET', '/api/account/active-user', async () => {
    return json({ owner: getActiveOwner() });
  });

  /**
   * 切换当前属主（登录传 userId，登出传 null）。
   * 切换后会按新属主回灌内存，保证 Agent 与同步看到的都只是该账号的数据。
   */
  registerRoute('PUT', '/api/account/active-user', async (req) => {
    const body = (req.body ?? {}) as { userId?: string | null };
    if (body.userId !== null && body.userId !== undefined && typeof body.userId !== 'string') {
      return apiError('userId 必须是字符串或 null', 400);
    }
    const changed = setActiveOwner(body.userId ?? null);
    const hydrated = hydrateLongTermMemory();
    return json({
      owner: getActiveOwner(),
      changed,
      hydrated: hydrated.ok ? hydrated.value : null,
      error: hydrated.ok ? undefined : hydrated.error,
    });
  });

  registerRoute('GET', '/api/memory/entries', async (req) => {
    const entries = listMemoryEntries(req.query);
    return json({ items: entries, total: entries.length });
  });

  registerRoute('GET', '/api/memory/entries/:key', async (req) => {
    const key = req.params.key;
    if (!key) return apiError('key is required', 400);

    try {
      const db = getDatabases();
      const memoryDb = db.memory;
      if (!memoryDb) return apiError('Memory database not available', 503);

      const row = memoryDb.prepare(
        `SELECT key, value, version, namespace, updated_at, created_at
         FROM memory_entries WHERE key = ? AND owner_user_id = ?`
      ).get(key, getActiveOwner()) as {
        key: string; value: string; version: number; namespace: string;
        updated_at: number; created_at: number;
      } | undefined;

      if (!row) return apiError('Memory entry not found', 404);

      return json({
        key: row.key,
        value: safeJsonParse(row.value),
        version: row.version,
        namespace: row.namespace,
        updatedAt: row.updated_at,
        createdAt: row.created_at,
      });
    } catch {
      return apiError('Memory database error', 500);
    }
  });
}
