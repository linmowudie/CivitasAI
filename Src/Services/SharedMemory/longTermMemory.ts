/**
 * @module SharedMemory/longTermMemory
 * @description
 * 长期记忆——Docs/07 §3.4。
 * 从工作区提炼的静态知识，跨任务持久化。
 * 仅 assertion='observed' 的内容可进入。
 */

import type { AssertionLevel } from '../EventBus/eventTypes.js';
import { isEligibleForLongTerm } from './writeGuard.js';
import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';

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
  return ok(entry);
}

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
  }
  return result.map(m => ({ ...m }));
}

export function getMemory(memoryId: string): LongTermMemoryEntry | undefined {
  const m = memories.get(memoryId);
  if (!m) return undefined;
  m.lastAccessedAt = Date.now();
  m.accessCount++;
  return { ...m };
}

export function deprecateMemory(memoryId: string, reason?: string): Result<void> {
  const m = memories.get(memoryId);
  if (!m) return err(`Memory ${memoryId} 不存在`);
  m.status = 'deprecated';
  return ok(undefined);
}

export function contradictMemory(memoryId: string, contradictedBy: string): Result<void> {
  const m = memories.get(memoryId);
  if (!m) return err(`Memory ${memoryId} 不存在`);
  m.status = 'contradicted';
  m.contradictedBy = contradictedBy;
  return ok(undefined);
}

export function getMemoryCount(): number {
  return memories.size;
}

// ── 清理 ────────────────────────────────────────────────────────────

export function resetLongTermMemory(): void {
  memories.clear();
  memoryCounter = 0;
}
