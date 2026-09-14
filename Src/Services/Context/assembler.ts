/**
 * @module Context/assembler
 * @description
 * 上下文装配器——Docs/02 §5 步骤④�?
 *
 * �?S→L→M→H 顺序装配上下文，检查分区预算上限，
 * 处理 Cache 命中（S/L 区不变内容可�?Prompt Cache 缓存）�?
 */

import {
  type PartitionId,
  type PartitionState,
  PARTITION_CONFIG,
  PARTITION_ORDER,
  getTotalTokens,
} from './partitions/index.js';
import { scoreAllEntries, type EntryScore } from './scoring.js';
import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';

// ── 类型 ──────────────────────────────────────────────

/** 装配结果 */
export interface AssemblyResult {
  /** 装配后的消息列表（按 S→L→M→H 排序�?*/
  messages: AssembledMessage[];
  /** �?token 估算 */
  totalTokens: number;
  /** 各分�?token 分布 */
  partitionTokens: Record<PartitionId, number>;
  /** 是否触发了截�?*/
  truncated: boolean;
  /** 被截断的条目�?*/
  droppedCount: number;
  /** Cache 命中前缀 hash（S+L 区内�?hash�?*/
  cachePrefixHash: string;
}

/** 装配后的消息 */
export interface AssembledMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** 来源分区 */
  partition: PartitionId;
  /** 来源条目 ID */
  entryId: string;
}

/** 装配选项 */
export interface AssemblyOptions {
  /** �?token 预算（输入侧�?*/
  budgetTokens: number;
  /** 上下�?*/
  context: Record<PartitionId, PartitionState>;
  /** 是否启用截断（默�?true�?*/
  enableTruncation?: boolean;
  /** 截断触发阈值（上下文使用率 �?此值时触发），默认 0.92 */
  truncationThreshold?: number;
}

// ── 装配函数 ──────────────────────────────────────────

/**
 * 装配上下文为消息列表�?
 * �?S→L→M→H 顺序拼接，检查分区预算，必要时截断�?
 */
export function assembleContext(options: AssemblyOptions): Result<AssemblyResult> {
  const {
    budgetTokens,
    context,
    enableTruncation = true,
    truncationThreshold = 0.92,
  } = options;

  if (budgetTokens <= 0) {
    return err('INVALID_ARGUMENT', 'budgetTokens 必须 > 0');
  }

  // 检查是否需要截�?
  const totalTokens = getTotalTokens(context);
  const usageRatio = totalTokens / budgetTokens;
  let truncated = false;
  let droppedCount = 0;

  if (enableTruncation && usageRatio >= truncationThreshold) {
    // 执行截断
    const truncationResult = truncateToFit(context, budgetTokens, truncationThreshold);
    truncated = truncationResult.modified;
    droppedCount = truncationResult.droppedCount;
  }

  // 装配消息
  const messages: AssembledMessage[] = [];
  const partitionTokens: Record<PartitionId, number> = { S: 0, L: 0, M: 0, H: 0 };

  for (const p of PARTITION_ORDER) {
    const partitionBudget = budgetTokens * PARTITION_CONFIG[p].ceilingRatio;

    for (const entry of context[p].entries) {
      if (entry.markedForDrop) continue;

      // 检查分区预�?
      if (partitionTokens[p] + entry.tokenEstimate > partitionBudget) {
        continue; // 跳过此条目（分区超预算）
      }

      const role = partitionToRole(p);
      messages.push({
        role,
        content: entry.content,
        partition: p,
        entryId: entry.id,
      });
      partitionTokens[p] += entry.tokenEstimate;
    }
  }

  const finalTotal = Object.values(partitionTokens).reduce((a, b) => a + b, 0);

  // 计算 Cache 前缀 hash（S+L 区内容）
  const cachePrefixHash = computeCachePrefixHash(context);

  return ok({
    messages,
    totalTokens: finalTotal,
    partitionTokens,
    truncated,
    droppedCount,
    cachePrefixHash,
  });
}

/** 分区到消息角色的映射 */
function partitionToRole(partition: PartitionId): AssembledMessage['role'] {
  switch (partition) {
    case 'S': return 'system';
    case 'L': return 'system'; // 工具 Schema / 长期记忆归入 system
    case 'M': return 'user';   // 对话历史归入 user
    case 'H': return 'assistant'; // Agent 输出 / 工具结果归入 assistant
  }
}

/**
 * 计算 S+L 区内容的 hash（用�?Prompt Cache 命中检测）�?
 * 压缩后必须保�?S 区前缀 hash 不变（Gate G5 要求）�?
 */
export function computeCachePrefixHash(
  context: Record<PartitionId, PartitionState>,
): string {
  const prefixParts: string[] = [];

  for (const p of ['S', 'L'] as PartitionId[]) {
    for (const entry of context[p].entries) {
      if (!entry.markedForDrop) {
        prefixParts.push(`${entry.id}:${entry.content.length}`);
      }
    }
  }

  // 简�?hash（FNV-1a�?
  const str = prefixParts.join('|');
  return fnv1aHash(str);
}

/** FNV-1a 32-bit hash */
function fnv1aHash(str: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * 截断至预算内：按评分从低到高丢弃，直到使用率低于阈值�?
 * 注意：S 区条目不丢弃（静态区不可变）�?
 */
function truncateToFit(
  context: Record<PartitionId, PartitionState>,
  budgetTokens: number,
  threshold: number,
): { modified: boolean; droppedCount: number } {
  const scores = scoreAllEntries(context);
  let droppedCount = 0;
  const targetTokens = budgetTokens * threshold * 0.95; // �?5% 余量

  let currentTokens = getTotalTokens(context);

  for (const score of scores) {
    if (currentTokens <= targetTokens) break;

    // S 区不丢弃
    if (score.partition === 'S') continue;

    const partition = context[score.partition];
    const entry = partition.entries.find(e => e.id === score.entryId);
    if (entry && !entry.markedForDrop) {
      entry.markedForDrop = true;
      partition.totalTokens -= entry.tokenEstimate;
      currentTokens -= entry.tokenEstimate;
      droppedCount++;
    }
  }

  return { modified: droppedCount > 0, droppedCount };
}
