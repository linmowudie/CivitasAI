/**
 * @module SharedMemory/globalWorkspace
 * @description
 * 全局工作区——Docs/Agent/07 §3.1 + §8.2。
 * 所有 Agent 可读写，受 WriteGuard 保护。
 * 乐观锁版本控制，并发写同 key 时 expectedVersion 不匹配方被拒。
 */

import { EventType } from '../EventBus/eventTypes.js';
import { getMainDb } from '../../Infra/Db/database.js';
import { getActiveOwner } from '../AccountScope/activeAccount.js';
import { logger } from '../../Infra/Logging/logger.js';
import { createEvent, publish } from '../EventBus/eventBus.js';
import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';

import { incrementClock, clockToTokens, tokensToClock } from './causalTokens.js';
import { interceptWrite, isForbiddenKey } from './writeGuard.js';
import { requireWritePermission, detectSemanticConflict } from './memoryGovernance.js';
import type { WorkspaceEntry, WriteResult, WorkspaceQuery } from './versionedEntry.js';

// ── 内部状态 ────────────────────────────────────────────────────────

const entries: Map<string, WorkspaceEntry> = new Map(); // entryId → entry
const keyIndex: Map<string, string[]> = new Map();       // key → entryId[]
let entryCounter = 0;
/** 条目 → 属主（内存缓存无属主字段，用旁表实现属主隔离判定，2026-10-04 G-13③） */
const entryOwners: Map<string, string> = new Map();

// ── 写入 ────────────────────────────────────────────────────────────

/**
 * 写入条目——受 WriteGuard 保护 + 乐观锁。
 * expectedVersion 不匹配 → 拒写 + VERSION_CONFLICT 事件。
 */
export function write(
  params: {
    key: string;
    content: string;
    contentType: WorkspaceEntry['contentType'];
    assertion: WorkspaceEntry['assertion'];
    traceId: string;
    agentId: string;
    taskId?: string;
    taskAuthority?: number;
    evidenceChain?: string[];
    expectedVersion?: number;
    conflictStrategy?: WorkspaceEntry['conflictStrategy'];
    /** 写入者角色（2026-10-04）：治理键仅 L0 / user 可写（灵感源 §1.3 分层） */
    actorRole?: string;
  },
): Result<WriteResult> {
  // 红线检查
  if (isForbiddenKey(params.key)) {
    return err(`key "${params.key}" 禁止写入 GlobalWorkspace`);
  }

  // ★ 分层写入权限（2026-10-04，灵感源《一些思考2》§1.3）：
  //   治理键 → 仅 L0 / 所有者；隔离键 → 拒绝进入共享层（中间过程物理隔离）。
  const perm = requireWritePermission({
    key: params.key,
    ...(params.actorRole !== undefined ? { actorRole: params.actorRole } : {}),
    agentId: params.agentId,
  });
  if (!perm.ok) return err(perm.error);

  const existing = getLatestByKey(params.key);
  const currentVersion = existing ? existing.version : 0;
  const expectedVersion = params.expectedVersion ?? currentVersion;

  // ★ 语义冲突检测（2026-10-04，灵感源 §3.3）：
  //   新旧内容相似度 ≥ 0.85 且极性相反 → 阻断写入、发布 CONFLICT_DETECTED、打包新旧 ID 交仲裁者。
  if (existing) {
    const conflict = detectSemanticConflict(params.content, existing.content);
    if (conflict) {
      publish(createEvent({
        eventType: EventType.CONFLICT_DETECTED,
        source: 'SharedMemory/globalWorkspace/write',
        payload: {
          key: params.key,
          newEntryId: `pending:${params.agentId}`,
          existingEntryId: existing.entryId,
          newContent: params.content,
          existingContent: existing.content,
          reason: conflict,
          traceId: params.traceId,
        },
      }));
      return err(`写入被阻止（语义冲突）：${conflict}；新旧记忆 ID 已上报仲裁者`);
    }
  }

  const now = Date.now();
  const entryId = `ws-${++entryCounter}`;

  // 构建因果令牌
  const existingClock = existing ? tokensToClock(existing.causalTokens) : new Map<string, number>();
  const newClock = incrementClock(existingClock, params.agentId);

  const entry: WorkspaceEntry = {
    entryId,
    traceId: params.traceId,
    agentId: params.agentId,
    taskId: params.taskId,
    key: params.key,
    content: params.content,
    contentType: params.contentType,
    assertion: params.assertion,
    metadata: {
      timestamp: now,
      sourceAgentId: params.agentId,
      taskAuthority: params.taskAuthority ?? 0.5,
      evidenceChain: params.evidenceChain,
    },
    version: currentVersion + 1,
    lastModifiedBy: params.agentId,
    conflictStrategy: params.conflictStrategy ?? 'lww',
    causalTokens: clockToTokens(newClock),
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };

  // WriteGuard 拦截
  const guardResult = interceptWrite(entry, currentVersion, expectedVersion);
  if (!guardResult.ok) return guardResult;
  if (!guardResult.value.success) {
    return ok(guardResult.value); // 版本冲突
  }

  // 标记旧条目为 superseded
  if (existing) {
    existing.status = 'superseded';
    existing.supersededBy = entryId;
    existing.updatedAt = now;
  }

  // 存储新条目（内存热缓存）+ 写穿落库（含属主，2026-10-04）
  entries.set(entryId, entry);
  entryOwners.set(entryId, getActiveOwner());
  persistEntry(entry, getActiveOwner());
  const keyEntries = keyIndex.get(params.key) ?? [];
  keyEntries.push(entryId);
  keyIndex.set(params.key, keyEntries);

  // 发布 MEMORY_WRITTEN 事件
  publish(createEvent({
    eventType: EventType.MEMORY_WRITTEN,
    source: 'SharedMemory/GlobalWorkspace',
    traceId: params.traceId,
    payload: { entryId, key: params.key, agentId: params.agentId, assertion: params.assertion },
  }));

  return ok({ success: true, entry, warning: guardResult.value.warning });
}

// ── 读取 ────────────────────────────────────────────────────────────

export function read(query: WorkspaceQuery): WorkspaceEntry[] {
  // ★ 属主隔离（2026-10-04，G-13③）：只返回**当前属主**可见的条目。
  //   内存缓存条目经 `entryOwners` 旁表判定属主；持久化条目由 SQL 按 owner 过滤后并入。
  const owner = getActiveOwner();
  let result: WorkspaceEntry[];

  if (query.key) {
    const latest = getLatestByKey(query.key);
    result = latest && ownedBy(latest.entryId, owner) ? [latest] : [];
  } else {
    result = [...entries.values()].filter(e => ownedBy(e.entryId, owner));
  }

  // 合并持久化条目（跨重启可见；同 entryId 以内存为准）
  const seen = new Set(result.map(e => e.entryId));
  for (const persisted of loadPersistedEntries(owner)) {
    if (!seen.has(persisted.entryId)) result.push(persisted);
  }

  // 过滤
  if (query.traceId) result = result.filter(e => e.traceId === query.traceId);
  if (query.agentId) result = result.filter(e => e.agentId === query.agentId);
  if (query.taskId) result = result.filter(e => e.taskId === query.taskId);
  if (query.contentType) result = result.filter(e => e.contentType === query.contentType);
  if (query.status) result = result.filter(e => e.status === query.status);
  if (query.assertion) result = result.filter(e => e.assertion === query.assertion);
  if (query.limit && query.limit > 0) result = result.slice(-query.limit);

  return result.map(e => ({ ...e }));
}

/** 条目是否属于指定属主（无属主记录者视为当前属主写入，兼容旧内存条目） */
function ownedBy(entryId: string, owner: string): boolean {
  const recorded = entryOwners.get(entryId);
  return recorded === undefined || recorded === owner;
}

// ── 删除 ────────────────────────────────────────────────────────────

export function discardEntry(entryId: string, _agentId: string): Result<void> {
  const entry = entries.get(entryId);
  if (!entry) return err(`Entry ${entryId} 不存在`);
  entry.status = 'discarded';
  entry.updatedAt = Date.now();
  return ok(undefined);
}

// ── 查询辅助 ────────────────────────────────────────────────────────

function getLatestByKey(key: string): WorkspaceEntry | undefined {
  const ids = keyIndex.get(key);
  if (!ids || ids.length === 0) return undefined;
  // 返回最新的 active 条目
  for (let i = ids.length - 1; i >= 0; i--) {
    const id = ids[i];
    if (id === undefined) continue;
    const entry = entries.get(id);
    if (entry && entry.status === 'active') return entry;
  }
  return undefined;
}

export function getByTrace(traceId: string): WorkspaceEntry[] {
  return read({ traceId });
}

/**
 * 按 entryId 查询条目（FE-062：仲裁接线从 CONFLICT_DETECTED 的 existingEntryId
 * 解析归属 Agent 与内容）。
 */
export function getEntryById(entryId: string): WorkspaceEntry | undefined {
  const entry = entries.get(entryId);
  return entry ? { ...entry } : undefined;
}

export function getEntryCount(): number {
  return entries.size;
}

export function getKeyCount(): number {
  return keyIndex.size;
}

// ── 持久化与属主隔离（2026-10-04，G-13③）──────────────────────────────
//
// 此前 `global_workspace` 表**无任何读写方**（纯内存 Map）：重启即丢治理记忆（如广播），
// 且无属主概念 ⇒ 跨账号可见。现补齐：写穿落库 + 按属主隔离读取 + 启动回灌。
//
// 设计取舍：内存 Map 保留为**热缓存**；落库失败**不阻断写入**（观感与治理动作一致：
// 记忆能力降级不应打断主流程），但打日志。读取时**合并**内存与库，避免测试/无库场景失效。

/** 是否已初始化主库（避免无库环境下抛错） */
function canPersist(): boolean {
  try {
    getMainDb();
    return true;
  } catch {
    return false;
  }
}

/** 写穿：把条目落库（含属主） */
function persistEntry(entry: WorkspaceEntry, owner: string): void {
  if (!canPersist()) return;
  try {
    getMainDb().prepare(`
      INSERT INTO global_workspace (
        entry_id, key, trace_id, agent_id, task_id, content, content_type, assertion,
        metadata_json, version, last_modified_by, conflict_strategy, causal_tokens_json,
        status, superseded_by, created_at, updated_at, owner_user_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(entry_id) DO UPDATE SET
        version = excluded.version, status = excluded.status, superseded_by = excluded.superseded_by,
        updated_at = excluded.updated_at, metadata_json = excluded.metadata_json
    `).run(
      entry.entryId, entry.key, entry.traceId, entry.agentId, entry.taskId ?? null,
      entry.content, entry.contentType, entry.assertion,
      JSON.stringify(entry.metadata ?? {}), entry.version, entry.lastModifiedBy,
      entry.conflictStrategy, JSON.stringify(entry.causalTokens ?? []),
      entry.status, entry.supersededBy ?? null, entry.createdAt, entry.updatedAt, owner,
    );
  } catch (e) {
    logger.warn('共享记忆落库失败（内存缓存仍生效）', {
      source: 'globalWorkspace/persistEntry',
      entryId: entry.entryId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/** 行 → 条目 */
function rowToEntry(row: Record<string, unknown>): WorkspaceEntry {
  return {
    entryId: row['entry_id'] as string,
    traceId: row['trace_id'] as string,
    agentId: row['agent_id'] as string,
    ...(row['task_id'] ? { taskId: row['task_id'] as string } : {}),
    key: row['key'] as string,
    content: row['content'] as string,
    contentType: row['content_type'] as WorkspaceEntry['contentType'],
    assertion: row['assertion'] as WorkspaceEntry['assertion'],
    metadata: JSON.parse((row['metadata_json'] as string) || '{}'),
    version: Number(row['version']),
    lastModifiedBy: row['last_modified_by'] as string,
    conflictStrategy: row['conflict_strategy'] as WorkspaceEntry['conflictStrategy'],
    causalTokens: JSON.parse((row['causal_tokens_json'] as string) || '[]'),
    status: row['status'] as WorkspaceEntry['status'],
    ...(row['superseded_by'] ? { supersededBy: row['superseded_by'] as string } : {}),
    createdAt: Number(row['created_at']),
    updatedAt: Number(row['updated_at']),
  } as WorkspaceEntry;
}

/** 从库中按属主加载条目（不改变内存状态；供回灌与读取合并使用） */
export function loadPersistedEntries(owner: string = getActiveOwner()): WorkspaceEntry[] {
  if (!canPersist()) return [];
  try {
    const rows = getMainDb().prepare(
      'SELECT * FROM global_workspace WHERE owner_user_id = ? ORDER BY created_at ASC',
    ).all(owner) as Record<string, unknown>[];
    return rows.map(rowToEntry);
  } catch (e) {
    logger.warn('共享记忆读取失败（降级为内存视图）', {
      source: 'globalWorkspace/loadPersistedEntries',
      error: e instanceof Error ? e.message : String(e),
    });
    return [];
  }
}

/**
 * 启动期回灌：把当前属主的持久化条目装回内存缓存（并恢复 ID 计数器，避免主键冲突）。
 *
 * @returns 回灌条目数
 */
export function hydrateGlobalWorkspace(): Result<number> {
  const owner = getActiveOwner();
  const persisted = loadPersistedEntries(owner);
  for (const entry of persisted) {
    entries.set(entry.entryId, entry);
    entryOwners.set(entry.entryId, owner);
    const list = keyIndex.get(entry.key) ?? [];
    list.push(entry.entryId);
    keyIndex.set(entry.key, list);
  }
  // 恢复计数器：`ws-<n>` 的最大 n
  for (const e of persisted) {
    const m = /^ws-(\d+)$/.exec(e.entryId);
    if (m) entryCounter = Math.max(entryCounter, Number(m[1]));
  }
  return ok(persisted.length);
}

/** 统计当前内存视图的条目数（诊断用；与 getEntryCount 同义，语义更明确） */
export function getMemoryEntryCount(): number {
  return entries.size;
}

// ── 清理（测试用）──────────────────────────────────────────────────

export function resetGlobalWorkspace(): void {
  entries.clear();
  keyIndex.clear();
  entryOwners.clear();
  entryCounter = 0;
}
