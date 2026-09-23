/**
 * @module SharedMemory/memoryConsolidator
 * @description
 * 知识沉淀器——Docs/07 §3.4。
 * 从 GlobalWorkspace 提炼有价值的观察到 LongTermMemory。
 * 触发条件：仲裁裁决完成 / 任务完成 / 定期巡检。
 */

import { EventType } from '../EventBus/eventTypes.js';
import { createEvent, publish } from '../EventBus/eventBus.js';
import type { Result } from '../../Infra/types.js';
import { ok } from '../../Infra/types.js';

import { isEligibleForLongTerm } from './writeGuard.js';
import { writeMemory } from './longTermMemory.js';
import { read } from './globalWorkspace.js';

// ── 沉淀触发 ────────────────────────────────────────────────────────

/**
 * 从指定 trace 沉淀知识到长期记忆。
 * 仅 assertion='observed' 的条目可沉淀。
 */
export function consolidateFromTrace(params: {
  traceId: string;
  taskId?: string;
  arbitrationId?: string;
}): Result<{ consolidated: number; skipped: number }> {
  const entries = read({ traceId: params.traceId, assertion: 'observed', status: 'active' });

  let consolidated = 0;
  let skipped = 0;

  for (const entry of entries) {
    if (!isEligibleForLongTerm(entry.assertion)) {
      skipped++;
      continue;
    }

    const result = writeMemory({
      title: `${entry.contentType}: ${entry.content.slice(0, 80)}`,
      content: entry.content,
      category: mapContentTypeToCategory(entry.contentType),
      sourceTraceIds: [entry.traceId],
      sourceArbitrationIds: params.arbitrationId ? [params.arbitrationId] : undefined,
      assertion: entry.assertion,
    });

    if (result.ok) consolidated++;
    else skipped++;
  }

  // 发布 KNOWLEDGE_CONSOLIDATION 事件
  if (consolidated > 0) {
    publish(createEvent({
      eventType: EventType.KNOWLEDGE_CONSOLIDATION,
      source: 'SharedMemory/MemoryConsolidator',
      traceId: params.traceId,
      payload: { consolidated, skipped, taskId: params.taskId },
    }));
  }

  return ok({ consolidated, skipped });
}

function mapContentTypeToCategory(contentType: string): 'rule' | 'fact' | 'decision' | 'pattern' {
  switch (contentType) {
    case 'decision': return 'decision';
    case 'verdict': return 'rule';
    case 'contract': return 'rule';
    case 'status': return 'fact';
    default: return 'fact';
  }
}

// ── 清理 ────────────────────────────────────────────────────────────

export function resetMemoryConsolidator(): void {
  // 无状态，无需清理
}
