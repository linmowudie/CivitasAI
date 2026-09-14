/**
 * @module SharedMemory/globalWorkspace
 * @description
 * 全局工作区——Docs/07 §3.1 + §8.2。
 * 所有 Agent 可读写，受 WriteGuard 保护。
 * 乐观锁版本控制，并发写同 key 时 expectedVersion 不匹配方被拒。
 */

import type { WorkspaceEntry, WriteResult, WorkspaceQuery } from './versionedEntry.js';
import { interceptWrite, isForbiddenKey } from './writeGuard.js';
import { incrementClock, clockToTokens, mergeClocks, tokensToClock } from './causalTokens.js';
import { EventType } from '../EventBus/eventTypes.js';
import { createEvent, publish } from '../EventBus/eventBus.js';
import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';

// ── 内部状态 ────────────────────────────────────────────────────────

const entries: Map<string, WorkspaceEntry> = new Map(); // entryId → entry
const keyIndex: Map<string, string[]> = new Map();       // key → entryId[]
let entryCounter = 0;

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
  },
): Result<WriteResult> {
  // 红线检查
  if (isForbiddenKey(params.key)) {
    return err(`key "${params.key}" 禁止写入 GlobalWorkspace`);
  }

  const existing = getLatestByKey(params.key);
  const currentVersion = existing ? existing.version : 0;
  const expectedVersion = params.expectedVersion ?? currentVersion;

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

  // 存储新条目
  entries.set(entryId, entry);
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
  let result: WorkspaceEntry[];

  if (query.key) {
    const latest = getLatestByKey(query.key);
    result = latest ? [latest] : [];
  } else {
    result = [...entries.values()];
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

// ── 删除 ────────────────────────────────────────────────────────────

export function discardEntry(entryId: string, agentId: string): Result<void> {
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
    const entry = entries.get(ids[i]);
    if (entry && entry.status === 'active') return entry;
  }
  return undefined;
}

export function getByTrace(traceId: string): WorkspaceEntry[] {
  return read({ traceId });
}

export function getEntryCount(): number {
  return entries.size;
}

export function getKeyCount(): number {
  return keyIndex.size;
}

// ── 清理（测试用）──────────────────────────────────────────────────

export function resetGlobalWorkspace(): void {
  entries.clear();
  keyIndex.clear();
  entryCounter = 0;
}
