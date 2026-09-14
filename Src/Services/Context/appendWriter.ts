/**
 * @module Context/appendWriter
 * @description
 * 追加式写入器——强制所有上下文写入遵循四段式格式（Docs/02 §5.2）�?
 * 提供类型安全的写入接口，自动路由到对应分区�?
 */

import {
  type PartitionId,
  type ContextEntry,
  type PartitionState,
  appendEntry,
  serializeEntry,
} from './partitions/index.js';
import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';

// ── 类型 ──────────────────────────────────────────────

/** 写入条目类型到分区的映射 */
export const TYPE_PARTITION_MAP: Record<string, PartitionId> = {
  SYSTEM_PROMPT: 'S',
  ROLE_DEFINITION: 'S',
  IMMUTABLE_CONSTRAINT: 'S',
  TOOL_SCHEMA: 'L',
  LONG_TERM_MEMORY: 'L',
  SKILL_DEFINITION: 'L',
  CONVERSATION_HISTORY: 'M',
  LOOP_STATE_SUMMARY: 'M',
  USER_MESSAGE: 'M',
  AGENT_OUTPUT: 'H',
  TOOL_RESULT: 'H',
  RETRIEVAL_FRAGMENT: 'H',
  MEM_RECALL: 'H',
};

/** 追加式写入选项 */
export interface AppendWriteOptions {
  /** 条目类型（自动映射分区，也可手动覆盖�?*/
  type: string;
  /** 内容 */
  content: string;
  /** 元数�?*/
  metadata?: Record<string, unknown>;
  /** 手动覆盖目标分区 */
  partitionOverride?: PartitionId;
  /** Token 估算覆盖 */
  tokenEstimate?: number;
}

// ── 写入�?────────────────────────────────────────────

/**
 * 追加式写入上下文条目�?
 * 自动根据类型路由到对应分区，除非指定 partitionOverride�?
 */
export function writeEntry(
  context: Record<PartitionId, PartitionState>,
  options: AppendWriteOptions,
): Result<ContextEntry> {
  const { type, content, metadata, partitionOverride, tokenEstimate } = options;

  if (!content) {
    return err('INVALID_ARGUMENT', '写入内容不能为空');
  }

  const partition = partitionOverride ?? TYPE_PARTITION_MAP[type];
  if (!partition) {
    return err('INVALID_ARGUMENT', `未知条目类型 "${type}"，且未指�?partitionOverride`);
  }

  const entry = appendEntry(
    context,
    partition,
    type,
    content,
    metadata ?? {},
    tokenEstimate,
  );

  return ok(entry);
}

/**
 * 批量写入多个条目�?
 */
export function writeEntries(
  context: Record<PartitionId, PartitionState>,
  entries: AppendWriteOptions[],
): Result<ContextEntry[]> {
  const results: ContextEntry[] = [];

  for (const options of entries) {
    const result = writeEntry(context, options);
    if (!result.ok) return result;
    results.push(result.value);
  }

  return ok(results);
}

/**
 * 将上下文所有条目序列化为追加式格式文本（按 S→L→M→H 顺序）�?
 */
export function serializeContext(
  context: Record<PartitionId, PartitionState>,
): string {
  const lines: string[] = [];
  const order: PartitionId[] = ['S', 'L', 'M', 'H'];

  for (const p of order) {
    for (const entry of context[p].entries) {
      lines.push(serializeEntry(entry));
    }
  }

  return lines.join('\n');
}
