/**
 * @module Loop/relevanceScoring
 * @description
 * 相关度五维评分（《一些思考3》§4）——决定「复杂请求下保留什么」。
 *
 * 五个维度（§4.1）：
 *  1. 语义相关 `semantic`   —— 当前请求与片段的语义相似度（默认走确定性关键词/词元层，
 *     可注入 embedding / LLM 重排，对应 §4.6 的三层分级）
 *  2. 结构重要性 `structural` —— system > 用户约束 > 已确认结论 > 用户消息 > 工具结果
 *  3. 时间衰减 `temporal`    —— `exp(-0.3 × age)`，age 以**轮次序号**为单位
 *  4. 引用强度 `citation`    —— 入度 0.6 + 出度 0.3，封顶 1.0
 *  5. 子任务状态 `subtask`   —— 活跃子任务 1.0 / 已关闭 0.2 / 无归属 0.5
 *
 * 加权总分按 §4.5 的三套权重档（简单 / 复杂 / 缓存敏感）取一。
 * 预算填充为**贪心降序**（§4.3），并强制保留 `system` 与用户约束（§4.3 末段）。
 *
 * ⚠️ 单位校准：源文档 `timestamp` 单位未定义（毫秒时间戳会让 `exp(-0.3×age)` 恒为 0）。
 * 本实现把 `timestamp` 固定为**轮次序号**（0,1,2…），公式保持 `exp(-0.3 × age)` 不变。
 *
 * 分层：`Core/Loop` 可向下依赖 `Services/Retrieval`（Core → Services 为合法下行）。
 */

import { textRelevanceScore } from "../../Services/Retrieval/textScore.js";

// ── 类型（§4.2）────────────────────────────────────────────────────

/** 历史片段 */
export interface ContextChunk {
  chunkId: string;
  role: string;
  content: string;
  tokens: number;
  /** 轮次序号（0 起递增；**不是**毫秒时间戳） */
  timestamp: number;
  subtaskId?: string;
  isConstraint?: boolean;
  isConfirmedConclusion?: boolean;
  /** 被哪些片段引用（入度） */
  referencedBy?: string[];
  /** 引用了哪些片段（出度） */
  referencesTo?: string[];
}

/** 五维评分结果 */
export interface RelevanceScore {
  chunkId: string;
  total: number;
  semantic: number;
  structural: number;
  temporal: number;
  citation: number;
  subtask: number;
  keep: boolean;
}

/** 五维权重（和应为 1.0） */
export interface RelevanceWeights {
  semantic: number;
  structural: number;
  temporal: number;
  citation: number;
  subtask: number;
}

/** §4.5 权重档 */
export const WEIGHT_PROFILES: Record<
  "simple" | "complex" | "cacheSensitive",
  RelevanceWeights
> = {
  simple: {
    semantic: 0.5,
    structural: 0.1,
    temporal: 0.3,
    citation: 0.05,
    subtask: 0.05,
  },
  complex: {
    semantic: 0.35,
    structural: 0.25,
    temporal: 0.15,
    citation: 0.15,
    subtask: 0.1,
  },
  cacheSensitive: {
    semantic: 0.35,
    structural: 0.3,
    temporal: 0.15,
    citation: 0.1,
    subtask: 0.1,
  },
};

/** 时间衰减系数（§4.3；单位 = 轮次） */
export const TEMPORAL_DECAY = 0.3;

// ── 单维打分（§4.3 内部逻辑，拆出便于单测）──────────────────────────

/** 结构重要性 */
export function structuralScore(chunk: ContextChunk): number {
  if (chunk.role === "system") return 1.0;
  if (chunk.isConstraint) return 0.95;
  if (chunk.isConfirmedConclusion) return 0.85;
  if (chunk.role === "user") return 0.7;
  if (chunk.role === "tool" && chunk.content) return 0.5;
  if (chunk.role === "assistant") return 0.4;
  return 0.3;
}

/** 时间衰减：越近越高（`age` 以轮次计） */
export function temporalScore(
  chunk: ContextChunk,
  maxTimestamp: number,
): number {
  if (maxTimestamp <= 0) return 1.0;
  const age = Math.max(0, maxTimestamp - chunk.timestamp);
  return Math.exp(-TEMPORAL_DECAY * age);
}

/** 引用强度：入度 0.6 + 出度 0.3，封顶 1.0 */
export function citationScore(chunk: ContextChunk): number {
  const inDegree = chunk.referencedBy?.length ?? 0;
  const outDegree = chunk.referencesTo?.length ?? 0;
  return Math.min(1.0, inDegree * 0.6 + outDegree * 0.3);
}

/** 子任务状态 */
export function subtaskScore(
  chunk: ContextChunk,
  activeSubtasks: ReadonlySet<string>,
): number {
  if (!chunk.subtaskId) return 0.5;
  return activeSubtasks.has(chunk.subtaskId) ? 1.0 : 0.2;
}

// ── 五维总分（§4.3）─────────────────────────────────────────────────

export interface ComputeRelevanceOptions {
  /** 五维权重（缺省 = 复杂档） */
  weights?: RelevanceWeights;
  /** 活跃子任务 id 集合 */
  activeSubtasks?: ReadonlySet<string> | readonly string[];
  /** 语义相似度函数（§4.6 第 2/3 层：embedding / LLM 重排）；缺省走关键词层 */
  semanticFn?: (request: string, content: string) => number;
  /** 时间衰减系数覆盖 */
  temporalDecay?: number;
}

/** 计算五维总分（不涉预算，返回原序） */
export function computeRelevanceScores(
  currentRequest: string,
  chunks: readonly ContextChunk[],
  options: ComputeRelevanceOptions = {},
): RelevanceScore[] {
  const weights = options.weights ?? WEIGHT_PROFILES.complex;
  const active: ReadonlySet<string> =
    options.activeSubtasks instanceof Set
      ? options.activeSubtasks
      : new Set(options.activeSubtasks ?? []);
  const semanticFn = options.semanticFn ?? defaultSemanticFn;

  let maxTimestamp = 0;
  for (const c of chunks) {
    if (c.timestamp > maxTimestamp) maxTimestamp = c.timestamp;
  }

  return chunks.map((chunk) => {
    const semantic = clamp01(semanticFn(currentRequest, chunk.content));
    const structural = clamp01(structuralScore(chunk));
    const age = Math.max(0, maxTimestamp - chunk.timestamp);
    const temporal =
      options.temporalDecay !== undefined
        ? Math.exp(-options.temporalDecay * age)
        : clamp01(temporalScore(chunk, maxTimestamp));
    const citation = clamp01(citationScore(chunk));
    const subtask = clamp01(subtaskScore(chunk, active));

    const total =
      weights.semantic * semantic +
      weights.structural * structural +
      weights.temporal * temporal +
      weights.citation * citation +
      weights.subtask * subtask;

    return {
      chunkId: chunk.chunkId,
      total,
      semantic,
      structural,
      temporal,
      citation,
      subtask,
      keep: false,
    };
  });
}

/** 默认语义层：关键词/词元覆盖（§4.6 第 1 层，确定性、零模型调用） */
export function defaultSemanticFn(request: string, content: string): number {
  return textRelevanceScore(request, content);
}

// ── 预算填充（§4.3 贪心 + 强制保留）────────────────────────────────

export interface PartitionOptions extends ComputeRelevanceOptions {
  /** 压缩后目标 tokens 上限 */
  budgetTokens: number;
  /** 保底保留 tokens（即使超预算） */
  minKeepTokens?: number;
  /** 保留 tokens 占总量上限（§4.3 max_keep_ratio，缺省 0.85） */
  maxKeepRatio?: number;
}

/**
 * 按相关度把片段切成「保留 / 淘汰」。
 *
 * 规则（对齐 §4.3 伪码）：
 *  1. 分数降序；
 *  2. 能塞进预算 → 保留；否则若尚未达到 `minKeepTokens` → 仍保留；
 *  3. 强制保留 `role === 'system'` 与 `isConstraint` 的片段（不因时间衰减丢失，§4.7-3）；
 *  4. 保留总量不得超过 `maxKeepRatio × 总量`（防"全留 = 没压"）。
 */
export function partitionByRelevance(
  currentRequest: string,
  chunks: readonly ContextChunk[],
  options: PartitionOptions,
): { scores: RelevanceScore[]; keepIds: string[]; evictIds: string[] } {
  const scores = computeRelevanceScores(currentRequest, chunks, options);
  const minKeepTokens = options.minKeepTokens ?? 0;
  const maxKeepRatio = options.maxKeepRatio ?? 0.85;

  const totalTokens = chunks.reduce((s, c) => s + c.tokens, 0);
  const keepCeiling = Math.max(0, Math.floor(totalTokens * maxKeepRatio));

  const byId = new Map(chunks.map((c) => [c.chunkId, c]));
  const ordered = [...scores].sort(
    (a, b) => b.total - a.total || a.chunkId.localeCompare(b.chunkId),
  );

  let used = 0;
  const keep = new Set<string>();

  // 强制保留优先（system / 约束），它们不受 maxKeepRatio 限制
  for (const s of scores) {
    const chunk = byId.get(s.chunkId);
    if (!chunk) continue;
    if (chunk.role === "system" || chunk.isConstraint) {
      keep.add(s.chunkId);
      used += chunk.tokens;
    }
  }

  for (const s of ordered) {
    const chunk = byId.get(s.chunkId);
    if (!chunk || keep.has(s.chunkId)) continue;
    const withinBudget = used + chunk.tokens <= options.budgetTokens;
    const withinCeiling = used + chunk.tokens <= keepCeiling;
    if ((withinBudget && withinCeiling) || used < minKeepTokens) {
      keep.add(s.chunkId);
      used += chunk.tokens;
    }
  }

  const keepIds = scores
    .filter((s) => keep.has(s.chunkId))
    .map((s) => s.chunkId);
  const evictIds = scores
    .filter((s) => !keep.has(s.chunkId))
    .map((s) => s.chunkId);
  for (const s of scores) s.keep = keep.has(s.chunkId);

  return { scores, keepIds, evictIds };
}

// ── 内部 ────────────────────────────────────────────────────────────

function clamp01(v: number): number {
  if (Number.isNaN(v)) return 0;
  return Math.min(1, Math.max(0, v));
}
