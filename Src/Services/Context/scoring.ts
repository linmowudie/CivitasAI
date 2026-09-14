/**
 * @module Context/scoring
 * @description
 * 评分延迟压缩机制——Docs/02 §5.4。
 *
 * 不即时压缩。先评分（重要性 = 时间衰减 + 访问频率反向加权 + 语义相关性 + 分件系数），
 * 低分优先丢弃。只在上下文使用率 ≥ 92% 时触发实际截断。
 */

import {
  type PartitionId,
  type ContextEntry,
  type PartitionState,
  PARTITION_CONFIG,
  PARTITION_ORDER,
} from './partitions/index.js';

// ── 类型 ──────────────────────────────────────────────

/** 条目评分结果 */
export interface EntryScore {
  entryId: string;
  partition: PartitionId;
  /** 综合评分（0~1，越高越重要） */
  totalScore: number;
  /** 时间衰减分（0~1，越新越高） */
  recencyScore: number;
  /** 频率反向加权分（0~1，访问越少越高） */
  frequencyScore: number;
  /** 语义相关性分（0~1，当前为固定值，待检索模块接入） */
  relevanceScore: number;
  /** 分件系数（分区固有） */
  coefficient: number;
  /** 是否建议丢弃 */
  shouldDrop: boolean;
}

/** 评分配置 */
export interface ScoringConfig {
  /** 时间衰减半衰期（ms），默认 30 分钟 */
  recencyHalfLifeMs: number;
  /** 频率反向权重（访问次数 * 此值 = 惩罚），默认 0.1 */
  frequencyPenaltyWeight: number;
  /** 默认语义相关性（暂无检索模块，使用固定值），默认 0.5 */
  defaultRelevance: number;
  /** 丢弃阈值（低于此分数的条目优先丢弃），默认 0.15 */
  dropThreshold: number;
}

/** 默认评分配置 */
export const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  recencyHalfLifeMs: 30 * 60 * 1000,
  frequencyPenaltyWeight: 0.1,
  defaultRelevance: 0.5,
  dropThreshold: 0.15,
};

// ── 评分函数 ──────────────────────────────────────────

/**
 * 计算时间衰减分（指数衰减，半衰期模型）。
 * 新条目 → 接近 1.0；老条目 → 接近 0.0。
 */
export function computeRecencyScore(
  timestamp: number,
  now: number,
  halfLifeMs: number,
): number {
  const age = Math.max(0, now - timestamp);
  const decay = Math.pow(0.5, age / halfLifeMs);
  return decay;
}

/**
 * 计算频率反向加权分。
 * 访问次数越多，分数越低（反向加权 = 越频繁访问的越不值得保留）。
 */
export function computeFrequencyScore(
  accessCount: number,
  penaltyWeight: number,
): number {
  return Math.max(0, 1 - accessCount * penaltyWeight);
}

/**
 * 计算条目综合评分。
 * 公式：importance = recency + frequency(inverse) + relevance + coefficient
 * 归一化到 [0, 1]。
 */
export function scoreEntry(
  entry: ContextEntry,
  now: number,
  config: ScoringConfig = DEFAULT_SCORING_CONFIG,
): EntryScore {
  const partitionConfig = PARTITION_CONFIG[entry.partition];
  const coefficient = partitionConfig.tokenCoefficient;

  const recencyScore = computeRecencyScore(
    entry.timestamp, now, config.recencyHalfLifeMs,
  );
  const frequencyScore = computeFrequencyScore(
    entry.accessCount, config.frequencyPenaltyWeight,
  );
  const relevanceScore = config.defaultRelevance;

  // 综合评分：四维度加权平均
  // 权重：时间衰减 0.35 + 频率 0.15 + 相关性 0.30 + 分件系数 0.20
  const totalScore =
    recencyScore * 0.35 +
    frequencyScore * 0.15 +
    relevanceScore * 0.30 +
    coefficient * 0.20;

  return {
    entryId: entry.id,
    partition: entry.partition,
    totalScore,
    recencyScore,
    frequencyScore,
    relevanceScore,
    coefficient,
    shouldDrop: totalScore < config.dropThreshold,
  };
}

/**
 * 对上下文所有条目评分并排序（低分在前，优先丢弃）。
 */
export function scoreAllEntries(
  context: Record<PartitionId, PartitionState>,
  now: number = Date.now(),
  config: ScoringConfig = DEFAULT_SCORING_CONFIG,
): EntryScore[] {
  const scores: EntryScore[] = [];

  for (const p of PARTITION_ORDER) {
    for (const entry of context[p].entries) {
      scores.push(scoreEntry(entry, now, config));
    }
  }

  // 按评分升序排列（低分在前 = 优先丢弃）
  scores.sort((a, b) => a.totalScore - b.totalScore);
  return scores;
}

/**
 * 获取建议丢弃的条目 ID 列表。
 */
export function getDroppableEntries(
  context: Record<PartitionId, PartitionState>,
  now: number = Date.now(),
  config: ScoringConfig = DEFAULT_SCORING_CONFIG,
): string[] {
  return scoreAllEntries(context, now, config)
    .filter(s => s.shouldDrop)
    .map(s => s.entryId);
}
