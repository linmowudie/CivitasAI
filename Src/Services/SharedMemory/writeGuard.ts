/**
 * @module SharedMemory/writeGuard
 * @description
 * 写入守卫——Docs/07 §3.2 + §8.1 + §8.4。
 * 拦截异常写入，检测版本冲突与语义冲突。
 *
 * 红线：goal / immutable_constraints / successCriteria 禁止写入 GlobalWorkspace。
 * assertion='inferred' 的内容不进入 L 低频分区与长期记忆。
 */

import type { WorkspaceEntry, WriteResult, VersionConflict } from './versionedEntry.js';
import { EventType } from '../EventBus/eventTypes.js';
import { createEvent, publish } from '../EventBus/eventBus.js';
import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';

// ── 禁止写入的键（Docs/07 §8.1 红线）───────────────────────────────

const FORBIDDEN_KEYS = new Set([
  'goal', 'immutable_constraints', 'successCriteria',
  'goal.originalRequirement', 'goal.immutableConstraints', 'goal.successCriteria',
]);

// ── 拦截写入 ────────────────────────────────────────────────────────

/**
 * 检查写入是否合法：
 * 1. 禁止写入 goal/immutable_constraints/successCriteria
 * 2. 版本号校验（乐观锁）
 * 3. assertion 级别标记
 */
export function interceptWrite(
  entry: WorkspaceEntry,
  currentVersion: number,
  expectedVersion: number,
): Result<WriteResult> {
  // [1] 红线检查
  if (FORBIDDEN_KEYS.has(entry.key)) {
    return err(`写入守卫红线: key "${entry.key}" 禁止写入 GlobalWorkspace（仅允许 LoopState）`);
  }

  // [2] 版本号校验（乐观锁）
  if (expectedVersion !== currentVersion) {
    const conflict: VersionConflict = {
      entryId: entry.entryId,
      key: entry.key,
      expectedVersion,
      actualVersion: currentVersion,
      agentId: entry.agentId,
    };

    // 发布 VERSION_CONFLICT 事件
    publish(createEvent({
      eventType: EventType.MEMORY_VERSION_CONFLICT,
      source: 'SharedMemory/WriteGuard',
      traceId: entry.traceId,
      payload: { conflict },
    }));

    return ok({ success: false, conflict });
  }

  // [3] assertion 级别检查
  if (entry.assertion === 'inferred' || entry.assertion === 'assumed') {
    // 标记为可进入 M/H 分区，不进入 L 低频分区
    return ok({ success: true, entry, warning: `assertion=${entry.assertion}: 不进入 L 分区与长期记忆` });
  }

  return ok({ success: true, entry });
}

/**
 * 检查键是否被禁止写入 GlobalWorkspace
 */
export function isForbiddenKey(key: string): boolean {
  return FORBIDDEN_KEYS.has(key);
}

/**
 * 检查 assertion 级别是否允许进入长期记忆
 */
export function isEligibleForLongTerm(assertion: string): boolean {
  return assertion === 'observed';
}
