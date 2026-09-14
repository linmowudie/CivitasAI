/**
 * @module Context/partitions
 * @description
 * 上下文四级分区（缓存感知）——Docs/02 §5。
 *
 * 核心原则：**不变的内容在前，变化的内容在后**，以最大化 Prompt Cache 命中。
 *
 * | 分区 | 含义 | 预算上限 | 分件系数 | 变动频率 |
 * |------|------|---------|---------|---------|
 * | S Static | 系统提示词 | ≤15% | 0.05 | 极低 |
 * | L Low-freq | 工具Schema/长期记忆 | ≤15% | 0.5 | 低 |
 * | M Mid-freq | 对话历史/LoopState摘要 | ≤15% | 0.3 | 中 |
 * | H High-freq | Agent输出/工具结果 | ≤45% | 1.0 | 高 |
 */

// ── 类型定义 ──────────────────────────────────────────

/** 四级分区标识 */
export type PartitionId = 'S' | 'L' | 'M' | 'H';

/** 追加式写入格式：类型|元数据|时间戳|内容（Docs/02 §5.2） */
export interface ContextEntry {
  /** 条目唯一 ID */
  id: string;
  /** 所属分区 */
  partition: PartitionId;
  /** 条目类型（如 SYSTEM_PROMPT, TOOL_SCHEMA, MEM_RECALL, TOOL_RESULT, AGENT_OUTPUT） */
  type: string;
  /** 元数据（JSON 对象） */
  metadata: Record<string, unknown>;
  /** 写入时间戳（Unix ms） */
  timestamp: number;
  /** 内容文本 */
  content: string;
  /** Token 估算数 */
  tokenEstimate: number;
  /** 访问次数（用于评分） */
  accessCount: number;
  /** 是否已标记为可丢弃 */
  markedForDrop: boolean;
}

/** 分区配置 */
export interface PartitionConfig {
  /** 预算上限比例（四项和 = 0.9，剩 0.1 余量） */
  ceilingRatio: number;
  /** 分件系数（评分第四维度成本折算因子） */
  tokenCoefficient: number;
}

/** 分区运行时状态 */
export interface PartitionState {
  entries: ContextEntry[];
  /** 当前分区总 token 估算 */
  totalTokens: number;
}

// ── 常量 ──────────────────────────────────────────────

/** 四级分区默认配置（Docs/02 §5.1） */
export const PARTITION_CONFIG: Record<PartitionId, PartitionConfig> = {
  S: { ceilingRatio: 0.15, tokenCoefficient: 0.05 },
  L: { ceilingRatio: 0.15, tokenCoefficient: 0.5 },
  M: { ceilingRatio: 0.15, tokenCoefficient: 0.3 },
  H: { ceilingRatio: 0.45, tokenCoefficient: 1.0 },
};

/** 分区顺序（装配时按此顺序拼接） */
export const PARTITION_ORDER: PartitionId[] = ['S', 'L', 'M', 'H'];

// ── 分区管理器 ────────────────────────────────────────

let counter = 0;

function generateEntryId(): string {
  return `ctx-${Date.now()}-${++counter}`;
}

/** 创建空分区状态 */
export function createEmptyPartition(): PartitionState {
  return { entries: [], totalTokens: 0 };
}

/** 创建空上下文（四级分区全空） */
export function createEmptyContext(): Record<PartitionId, PartitionState> {
  return {
    S: createEmptyPartition(),
    L: createEmptyPartition(),
    M: createEmptyPartition(),
    H: createEmptyPartition(),
  };
}

/**
 * 追加式写入上下文条目（Docs/02 §5.2 强制格式）。
 * 格式：类型|元数据|时间戳|内容
 */
export function appendEntry(
  context: Record<PartitionId, PartitionState>,
  partition: PartitionId,
  type: string,
  content: string,
  metadata: Record<string, unknown> = {},
  tokenEstimate?: number,
): ContextEntry {
  const entry: ContextEntry = {
    id: generateEntryId(),
    partition,
    type,
    metadata,
    timestamp: Date.now(),
    content,
    tokenEstimate: tokenEstimate ?? estimateTokens(content),
    accessCount: 0,
    markedForDrop: false,
  };

  const state = context[partition];
  state.entries.push(entry);
  state.totalTokens += entry.tokenEstimate;

  return entry;
}

/**
 * 将条目序列化为追加式格式：类型|元数据|时间戳|内容
 */
export function serializeEntry(entry: ContextEntry): string {
  const meta = JSON.stringify(entry.metadata);
  return `${entry.type}|${meta}|${entry.timestamp}|${entry.content}`;
}

/** 获取上下文总 token 估算 */
export function getTotalTokens(context: Record<PartitionId, PartitionState>): number {
  return PARTITION_ORDER.reduce((sum, p) => sum + context[p].totalTokens, 0);
}

/** 获取上下文总条目数 */
export function getTotalEntries(context: Record<PartitionId, PartitionState>): number {
  return PARTITION_ORDER.reduce((sum, p) => sum + context[p].entries.length, 0);
}

/** 获取分区当前 token 占比 */
export function getPartitionRatio(
  context: Record<PartitionId, PartitionState>,
  partition: PartitionId,
  totalBudgetTokens: number,
): number {
  if (totalBudgetTokens <= 0) return 0;
  return context[partition].totalTokens / totalBudgetTokens;
}

/** 检查分区是否超出预算上限 */
export function isPartitionOverBudget(
  context: Record<PartitionId, PartitionState>,
  partition: PartitionId,
  totalBudgetTokens: number,
): boolean {
  const ratio = getPartitionRatio(context, partition, totalBudgetTokens);
  return ratio > PARTITION_CONFIG[partition].ceilingRatio;
}

/** 简单 token 估算（英文 1 token ≈ 4 字符，中文 1 token ≈ 1.5 字符） */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  // 粗略估算：混合中英文
  const cjkChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const otherChars = text.length - cjkChars;
  return Math.ceil(cjkChars / 1.5 + otherChars / 4);
}

/** 清空高频区（每轮开始时可选） */
export function clearHighFreqPartition(
  context: Record<PartitionId, PartitionState>,
): void {
  context.H = createEmptyPartition();
}
