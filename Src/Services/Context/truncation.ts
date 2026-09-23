/**
 * @module Context/truncation
 * @description
 * 上下文截断策略——Docs/02 §5.4�?
 *
 * 只在上下文使用率 �?92% 时触发实际截断�?
 * 截断后必须触�?GoalReanchorMiddleware（下轮开头）�?
 */

import type { Result } from '../../Infra/types.js';
import { ok } from '../../Infra/types.js';

import {
  type PartitionId,
  type PartitionState,
  PARTITION_CONFIG,
  PARTITION_ORDER,
  getTotalTokens,
} from './partitions/index.js';
import { scoreAllEntries } from './scoring.js';

// ── 类型 ──────────────────────────────────────────────

/** 截断结果 */
export interface TruncationResult {
  /** 是否执行了截�?*/
  truncated: boolean;
  /** 丢弃的条�?ID 列表 */
  droppedEntryIds: string[];
  /** 截断前�?token */
  tokensBefore: number;
  /** 截断后�?token */
  tokensAfter: number;
  /** 是否需要触�?GoalReanchor（压缩后必须触发�?*/
  needsGoalReanchor: boolean;
}

/** 截断选项 */
export interface TruncationOptions {
  /** 上下�?*/
  context: Record<PartitionId, PartitionState>;
  /** �?token 预算 */
  budgetTokens: number;
  /** 触发阈值（默认 0.92�?*/
  threshold?: number;
  /** 目标比例（截断到此比例以下），默�?0.80 */
  targetRatio?: number;
  /** 是否保护 S 区（默认 true，S 区不可丢弃） */
  protectStatic?: boolean;
}

// ── 截断函数 ──────────────────────────────────────────

/**
 * 执行延迟截断�?
 * 仅在使用�?�?threshold 时触发，按评分从低到高丢弃�?
 */
export function truncateContext(options: TruncationOptions): Result<TruncationResult> {
  const {
    context,
    budgetTokens,
    threshold = 0.92,
    targetRatio = 0.80,
    protectStatic = true,
  } = options;

  const tokensBefore = getTotalTokens(context);
  const usageRatio = tokensBefore / budgetTokens;

  // 未达阈值，不截�?
  if (usageRatio < threshold) {
    return ok({
      truncated: false,
      droppedEntryIds: [],
      tokensBefore,
      tokensAfter: tokensBefore,
      needsGoalReanchor: false,
    });
  }

  const targetTokens = budgetTokens * targetRatio;
  const scores = scoreAllEntries(context);
  const droppedEntryIds: string[] = [];
  let currentTokens = tokensBefore;

  for (const score of scores) {
    if (currentTokens <= targetTokens) break;

    // 保护 S �?
    if (protectStatic && score.partition === 'S') continue;

    const partition = context[score.partition];
    const entry = partition.entries.find(e => e.id === score.entryId);

    if (entry && !entry.markedForDrop) {
      entry.markedForDrop = true;
      partition.totalTokens -= entry.tokenEstimate;
      currentTokens -= entry.tokenEstimate;
      droppedEntryIds.push(entry.id);
    }
  }

  // 清理已标记丢弃的条目
  for (const p of PARTITION_ORDER) {
    const partition = context[p];
    partition.entries = partition.entries.filter(e => !e.markedForDrop);
  }

  return ok({
    truncated: true,
    droppedEntryIds,
    tokensBefore,
    tokensAfter: currentTokens,
    needsGoalReanchor: true,
  });
}

/**
 * 检查是否需要截断（使用�?�?阈值）�?
 */
export function needsTruncation(
  context: Record<PartitionId, PartitionState>,
  budgetTokens: number,
  threshold: number = 0.92,
): boolean {
  return getTotalTokens(context) / budgetTokens >= threshold;
}

/**
 * 按分区预算裁剪：如果某分区超出其 ceilingRatio，丢弃该分区内低分条目�?
 */
export function trimPartitionToBudget(
  context: Record<PartitionId, PartitionState>,
  budgetTokens: number,
  partition: PartitionId,
): number {
  const ceiling = budgetTokens * PARTITION_CONFIG[partition].ceilingRatio;
  const state = context[partition];

  if (state.totalTokens <= ceiling) return 0;

  const scores = scoreAllEntries(context)
    .filter(s => s.partition === partition)
    .sort((a, b) => a.totalScore - b.totalScore);

  let dropped = 0;
  let currentTokens = state.totalTokens;

  for (const score of scores) {
    if (currentTokens <= ceiling) break;

    const entry = state.entries.find(e => e.id === score.entryId);
    if (entry && !entry.markedForDrop) {
      entry.markedForDrop = true;
      state.totalTokens -= entry.tokenEstimate;
      currentTokens -= entry.tokenEstimate;
      dropped++;
    }
  }

  return dropped;
}
