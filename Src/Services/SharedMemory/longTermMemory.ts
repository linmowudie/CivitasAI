/**
 * @module SharedMemory/longTermMemory
 * @description
 * 长期记忆——Docs/Agent/07 §3.4。
 * 从工作区提炼的静态知识，跨任务持久化。
 * 仅 assertion='observed' 的内容可进入。
 *
 * 2026-10-02：写入/访问/状态变更**同步落库**（`long_term_memory` 表），
 * 启动时用 `hydrateLongTermMemory()` 回灌并恢复 ID 计数器——
 * 修复"重启即丢记忆"与"memory_id 重启后重用"（后者会污染云端幂等键）。
 */

import type { AssertionLevel } from '../EventBus/eventTypes.js';
import { EventType } from '../EventBus/eventTypes.js';
import { createEvent, publish } from '../EventBus/eventBus.js';
import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';
import { logger } from '../../Infra/Logging/logger.js';

import { isEligibleForLongTerm } from './writeGuard.js';
import { textRelevanceScore } from '../Retrieval/textScore.js';
import {
  persistMemory,
  persistAccess,
  persistStatus,
  loadAllRows,
  rowToEntry,
  isPersistenceAvailable,
} from './longTermMemoryStore.js';
import { projectMemoryEntry, backfillMemoryEntries } from './memoryEntryStore.js';

// ── 类型 ────────────────────────────────────────────────────────────

export type MemoryCategory = 'rule' | 'fact' | 'decision' | 'pattern';
export type MemoryStatus = 'active' | 'deprecated' | 'contradicted';

export interface LongTermMemoryEntry {
  memoryId: string;
  title: string;
  content: string;
  category: MemoryCategory;
  sourceTraceIds: string[];
  sourceArbitrationIds?: string[];
  assertion: AssertionLevel;
  createdAt: number;
  lastAccessedAt: number;
  accessCount: number;
  status: MemoryStatus;
  contradictedBy?: string;
}

// ── 内部状态 ────────────────────────────────────────────────────────

const memories: Map<string, LongTermMemoryEntry> = new Map();
let memoryCounter = 0;

/**
 * 当前记忆属主（跨账号数据隔离，FE-032）——**委托给中央账号作用域模块**。
 *
 * 所有"属于某个人的数据"（会话/消息、审批队列、长时记忆……）都以
 * `Src/Services/AccountScope/activeAccount.ts` 的属主为唯一真源，
 * 避免各处各有一套状态导致隔离出现缺口。
 */
import { getActiveOwner } from '../AccountScope/activeAccount.js';

export { LOCAL_OWNER, setActiveOwner, getActiveOwner } from '../AccountScope/activeAccount.js';

// ── 写入 ────────────────────────────────────────────────────────────

/**
 * 写入长期记忆——仅 assertion='observed' 允许。
 */
export function writeMemory(params: {
  title: string;
  content: string;
  category: MemoryCategory;
  sourceTraceIds: string[];
  sourceArbitrationIds?: string[];
  assertion?: AssertionLevel;
}): Result<LongTermMemoryEntry> {
  const assertion = params.assertion ?? 'observed';

  // §8.4: inferred/assumed 不进入长期记忆
  if (!isEligibleForLongTerm(assertion)) {
    return err(`assertion="${assertion}" 不允许进入长期记忆（仅 observed 可入）`);
  }

  const now = Date.now();
  const memoryId = `ltm-${++memoryCounter}`;

  const entry: LongTermMemoryEntry = {
    memoryId,
    title: params.title,
    content: params.content,
    category: params.category,
    sourceTraceIds: [...params.sourceTraceIds],
    sourceArbitrationIds: params.sourceArbitrationIds,
    assertion,
    createdAt: now,
    lastAccessedAt: now,
    accessCount: 0,
    status: 'active',
  };

  memories.set(memoryId, entry);
  // 持久化（fail-safe：失败只告警，内存副本仍可用，不中断调用方）
  const persisted = persistMemory(entry, getActiveOwner());
  if (!persisted.ok) {
    logger.warn('长时记忆写入未落库（重启后会丢失）', {
      source: 'SharedMemory/LongTermMemory',
      memoryId,
      error: persisted.error,
    });
  }
  // 同步镜像到共享记忆 KV 视图（memory_entries，FE-034；失败仅告警）
  projectMemoryEntry(entry, getActiveOwner());
  return ok(entry);
}

// ── 启动回灌 / 批量导入 ─────────────────────────────────────────────

/** 从 `ltm-<n>` 解析计数器序号（非法返回 0） */
function parseCounter(memoryId: string): number {
  const m = /^ltm-(\d+)$/.exec(memoryId);
  return m ? Number(m[1]) : 0;
}

/**
 * 启动时回灌：把库中的长时记忆载入内存，并把 ID 计数器推进到最大序号之后。
 *
 * 为什么要恢复计数器：原先每次启动都从 `ltm-1` 重新分配，
 * 重启后新建的记忆会**复用**旧 ID——不仅覆盖本地旧记录，还会在云端
 * 按 `clientMemoryId` 幂等 upsert 时把**另一条记忆的内容**写进同一条云端记录。
 */
export function hydrateLongTermMemory(): Result<number> {
  if (!isPersistenceAvailable()) {
    return err('数据库未初始化，无法回灌长时记忆');
  }
  // 回灌 = "把当前属主的记忆载入内存"：先清空，
  // 否则切换账号后内存里仍残留上一个账号的记忆（FE-032 的关键一环）
  memories.clear();
  memoryCounter = 0;

  const rows = loadAllRows(getActiveOwner());
  let maxCounter = 0;
  for (const row of rows) {
    const entry = rowToEntry(row);
    memories.set(entry.memoryId, entry);
    maxCounter = Math.max(maxCounter, parseCounter(entry.memoryId));
  }
  memoryCounter = maxCounter;
  // 补齐共享记忆 KV 视图的存量投影（FE-034：历史记忆可能从未投影过；
  // INSERT OR IGNORE 幂等，不覆盖已有投影、不误 bump version）
  backfillMemoryEntries([...memories.values()], getActiveOwner());
  logger.info('长时记忆已按属主回灌', {
    source: 'SharedMemory/LongTermMemory',
    owner: getActiveOwner(),
    count: rows.length,
    counter: memoryCounter,
  });
  return ok(rows.length);
}

/** 导出的领域对象（供 REST / 同步使用；不产生访问统计副作用） */
export function listAllMemories(): LongTermMemoryEntry[] {
  return [...memories.values()].map((m) => ({ ...m }));
}

/**
 * 批量导入（从云端恢复或本地库回灌）：按 memoryId 幂等 upsert，
 * 同时落库并把 ID 计数器推进到最大序号之后。导入目标为**当前属主**。
 */
export function importMemories(entries: LongTermMemoryEntry[]): Result<{ imported: number; updated: number }> {
  for (const entry of entries) {
    // 类型/字段兜底：云端数据可能缺字段（防御性校验，避免脏数据入库）
    if (!entry.memoryId || typeof entry.title !== 'string' || typeof entry.content !== 'string') {
      return err(`导入失败：记忆条目缺少必要字段（memoryId=${String(entry.memoryId)}）`);
    }
  }
  let imported = 0;
  let updated = 0;
  for (const entry of entries) {
    const existed = memories.has(entry.memoryId);
    memories.set(entry.memoryId, { ...entry });
    memoryCounter = Math.max(memoryCounter, parseCounter(entry.memoryId));
    const persisted = persistMemory(entry, getActiveOwner());
    if (!persisted.ok) {
      return err(`导入 ${entry.memoryId} 失败: ${persisted.error}`);
    }
    // 同步镜像到共享记忆 KV 视图（FE-034）
    projectMemoryEntry(entry, getActiveOwner());
    if (existed) updated++;
    else imported++;
  }
  return ok({ imported, updated });
}

// ── 自增强检测阈值 ────────────────────────────────────────

const SELF_REINFORCING_THRESHOLD = 5;

// ── 查询 ────────────────────────────────────────────────────────────

export function searchMemory(query: {
  category?: MemoryCategory;
  status?: MemoryStatus;
  limit?: number;
}): LongTermMemoryEntry[] {
  let result = [...memories.values()].filter(m => m.status !== 'deprecated');
  if (query.category) result = result.filter(m => m.category === query.category);
  if (query.status) result = result.filter(m => m.status === query.status);
  if (query.limit && query.limit > 0) result = result.slice(0, query.limit);
  // 更新访问时间
  const now = Date.now();
  for (const m of result) {
    m.lastAccessedAt = now;
    m.accessCount++;
    persistAccess(m.memoryId, m.accessCount, m.lastAccessedAt, getActiveOwner());
  }
  return result.map(m => ({ ...m }));
}

/**
 * 文本检索长时记忆（FE-058）——对 title+content 打分排序，返回带分数结果。
 *
 * 打分：`title 分 × 0.6 + content 分 × 0.4`（标题命中权重更高），低于 minScore 不召回；
 * 空查询退化为“按最近访问/频次浏览”（score=0）。命中条目更新访问统计（与 searchMemory 一致）。
 *
 * 说明：本函数为同步确定性检索（无外部依赖）；语义重排（可选嵌入增强）由
 * `Retrieval/retriever.ts` 在其上叠加（`semanticRescore`）。
 */
export function searchMemories(
  query: string,
  options: {
    category?: MemoryCategory;
    status?: MemoryStatus;
    limit?: number;
    minScore?: number;
  } = {},
): Array<{ entry: LongTermMemoryEntry; score: number }> {
  const limit = options.limit && options.limit > 0 ? options.limit : 10;
  const minScore = options.minScore ?? 0.05;

  let pool = [...memories.values()].filter(m => m.status !== 'deprecated');
  if (options.category) pool = pool.filter(m => m.category === options.category);
  if (options.status) pool = pool.filter(m => m.status === options.status);

  const q = query.trim();
  let scored: Array<{ entry: LongTermMemoryEntry; score: number }>;

  if (q === '') {
    // 空查询：浏览语义——按最近访问/访问频次排序（score=0，可由调用方忽略）
    scored = pool
      .sort((a, b) => b.lastAccessedAt - a.lastAccessedAt || b.accessCount - a.accessCount)
      .map(entry => ({ entry, score: 0 }));
  } else {
    scored = pool
      .map(entry => ({
        entry,
        score: Math.min(1,
          textRelevanceScore(q, entry.title) * 0.6 + textRelevanceScore(q, entry.content) * 0.4,
        ),
      }))
      .filter(s => s.score >= minScore)
      .sort((a, b) => b.score - a.score || b.entry.lastAccessedAt - a.entry.lastAccessedAt);
  }

  const result = scored.slice(0, limit);
  const now = Date.now();
  for (const { entry } of result) {
    entry.lastAccessedAt = now;
    entry.accessCount++;
    persistAccess(entry.memoryId, entry.accessCount, entry.lastAccessedAt, getActiveOwner());
  }
  return result.map(r => ({ entry: { ...r.entry }, score: r.score }));
}

export function getMemory(memoryId: string): LongTermMemoryEntry | undefined {
  const m = memories.get(memoryId);
  if (!m) return undefined;
  m.lastAccessedAt = Date.now();
  m.accessCount++;
  persistAccess(m.memoryId, m.accessCount, m.lastAccessedAt);

  // 自增强检测：当访问次数达到阈值时，发布 memory:self_reinforcing 事件
  if (m.accessCount >= SELF_REINFORCING_THRESHOLD && m.status === 'active') {
    publish(createEvent({
      eventType: EventType.MEMORY_SELF_REINFORCING,
      source: 'SharedMemory/LongTermMemory',
      payload: {
        memoryId: m.memoryId,
        title: m.title,
        accessCount: m.accessCount,
        category: m.category,
      },
    }));
  }

  return { ...m };
}

export function deprecateMemory(memoryId: string, _reason?: string): Result<void> {
  const m = memories.get(memoryId);
  if (!m) return err(`Memory ${memoryId} 不存在`);
  m.status = 'deprecated';
  persistStatus(memoryId, 'deprecated', undefined, getActiveOwner());
  // 状态变更同步镜像到 KV 视图（FE-034）
  projectMemoryEntry(m, getActiveOwner());
  return ok(undefined);
}

export function contradictMemory(memoryId: string, contradictedBy: string): Result<void> {
  const m = memories.get(memoryId);
  if (!m) return err(`Memory ${memoryId} 不存在`);
  m.status = 'contradicted';
  m.contradictedBy = contradictedBy;
  persistStatus(memoryId, 'contradicted', contradictedBy, getActiveOwner());
  // 状态变更同步镜像到 KV 视图（FE-034）
  projectMemoryEntry(m, getActiveOwner());
  return ok(undefined);
}

export function getMemoryCount(): number {
  return memories.size;
}

// ── 清理 ────────────────────────────────────────────────────────────

/**
 * 仅清空**内存**副本（测试用）。
 * 数据库中的记录不会被删除——需要彻底清空请另行删除 `long_term_memory` 行。
 */
export function resetLongTermMemory(): void {
  memories.clear();
  memoryCounter = 0;
}
