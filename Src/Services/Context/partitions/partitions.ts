/**
 * @module Context/partitions
 * @description
 * 上下文四级分区（缓存感知）——Docs/Agent/02 §5。
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
export type PartitionId = "S" | "L" | "M" | "H";

/** 追加式写入格式：类型|元数据|时间戳|内容（Docs/Agent/02 §5.2） */
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

/** 四级分区默认配置（Docs/Agent/02 §5.1） */
export const PARTITION_CONFIG: Record<PartitionId, PartitionConfig> = {
  S: { ceilingRatio: 0.15, tokenCoefficient: 0.05 },
  L: { ceilingRatio: 0.15, tokenCoefficient: 0.5 },
  M: { ceilingRatio: 0.15, tokenCoefficient: 0.3 },
  H: { ceilingRatio: 0.45, tokenCoefficient: 1.0 },
};

/** 分区顺序（装配时按此顺序拼接） */
export const PARTITION_ORDER: PartitionId[] = ["S", "L", "M", "H"];

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
 * 追加式写入上下文条目（Docs/Agent/02 §5.2 强制格式）。
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
export function getTotalTokens(
  context: Record<PartitionId, PartitionState>,
): number {
  return PARTITION_ORDER.reduce((sum, p) => sum + context[p].totalTokens, 0);
}

/** 获取上下文总条目数 */
export function getTotalEntries(
  context: Record<PartitionId, PartitionState>,
): number {
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

// ── 分区装配与执行链预算（MEM1-GAP-PARTITION，设计 §5）──────────────
//
// 背景：S/L/M/H 分区与预算规则此前只有数据结构（零生产引入）——
// 装配链从未按分区预算截断，于是"分区"只是文档里的表。
// 下面两个入口让分区在执行链上真正生效：
//  - `assembleContext({entries, budgetTokens})`：按分区上限装配（分区内**保新弃旧**）；
//  - `enforcePartitionBudget(messages, budgetTokens)`：对装配后的消息做预算截断
//    （S 区不可丢；assistant.tool_calls 与其 tool 结果成组保留，绝不拆散配对）。

/** 分区装配结果 */
export interface PartitionAssemblyResult {
  partitions: Record<PartitionId, ContextEntry[]>;
  totalTokens: number;
  /** 被丢弃（超预算/已标记）的条目 ID */
  dropped: string[];
  usageRatio: number;
}

/** 按 partition 字段分组（非法分区归入 H），组内按时间升序 */
export function partitionEntries(
  entries: readonly ContextEntry[],
): Record<PartitionId, ContextEntry[]> {
  const out: Record<PartitionId, ContextEntry[]> = {
    S: [],
    L: [],
    M: [],
    H: [],
  };
  for (const entry of entries) {
    const partition = (PARTITION_ORDER as readonly string[]).includes(
      entry.partition,
    )
      ? (entry.partition as PartitionId)
      : "H";
    out[partition].push(entry);
  }
  for (const p of PARTITION_ORDER) {
    out[p].sort((a, b) => a.timestamp - b.timestamp);
  }
  return out;
}

/**
 * 分区装配：按每区预算上限（budgetTokens × ceilingRatio）保留条目。
 * 分区内**保留最新的条目**（保新弃旧），S 区不丢（静态区不可变，只统计）。
 */
export function assembleContext(input: {
  entries: readonly ContextEntry[];
  budgetTokens: number;
}): PartitionAssemblyResult {
  const budget = Math.max(1, input.budgetTokens);
  const grouped = partitionEntries(input.entries);
  const kept: Record<PartitionId, ContextEntry[]> = {
    S: [],
    L: [],
    M: [],
    H: [],
  };
  const dropped: string[] = [];

  for (const p of PARTITION_ORDER) {
    const ceiling = budget * PARTITION_CONFIG[p].ceilingRatio;
    const list = grouped[p];
    let used = 0;
    for (let i = list.length - 1; i >= 0; i--) {
      const entry = list[i];
      if (!entry) continue;
      if (entry.markedForDrop) {
        dropped.push(entry.id);
        continue;
      }
      // S 区不丢（静态前缀不可变）；其余分区超上限则丢旧条目
      if (p === "S" || used + entry.tokenEstimate <= ceiling) {
        kept[p].unshift(entry);
        used += entry.tokenEstimate;
      } else {
        dropped.push(entry.id);
      }
    }
  }

  const totalTokens = PARTITION_ORDER.reduce(
    (sum, p) => sum + kept[p].reduce((a, e) => a + e.tokenEstimate, 0),
    0,
  );
  return {
    partitions: kept,
    totalTokens,
    dropped,
    usageRatio: totalTokens / budget,
  };
}

/** 可参与分区预算截断的最小消息结构（避免与 Infra/Llm 的 ChatMessage 形成环依赖） */
export interface PartitionableMessage {
  role: string;
  content?: unknown;
  tool_calls?: unknown;
  tool_call_id?: string;
}

/** 消息 → 分区：system=S，user=M，assistant/tool=H */
export function partitionOfMessage(message: PartitionableMessage): PartitionId {
  if (message.role === "system") return "S";
  if (message.role === "user") return "M";
  return "H";
}

/** 单条消息的 token 估算（委托 estimateTokens） */
export function messageTokenEstimate(message: PartitionableMessage): number {
  const content = message.content;
  const text =
    typeof content === "string"
      ? content
      : content === undefined || content === null
        ? ""
        : JSON.stringify(content);
  return estimateTokens(text);
}

/** 分区预算执行结果 */
export interface PartitionEnforcement<T> {
  messages: T[];
  droppedCount: number;
  partitionTokens: Record<PartitionId, number>;
  usageRatio: number;
}

/**
 * 执行链预算截断：总 token 超过 `threshold × budget` 时，从最旧的**安全消息**开始丢弃。
 *
 * 安全规则：
 * - S 区（system）永不丢；
 * - `tool` 消息与"带 tool_calls 的 assistant 消息"不成单条丢弃（配对拆散会让供应商
 *   直接判请求非法，见 REV-341）——成组保留；
 * - 只丢非配对的 user/assistant 文本消息（从旧到新）。
 */
export function enforcePartitionBudget<T extends PartitionableMessage>(
  messages: readonly T[],
  budgetTokens: number,
  threshold = 0.92,
): PartitionEnforcement<T> {
  const budget = Math.max(1, budgetTokens);
  const tokens = messages.map((m) => messageTokenEstimate(m));
  const total = tokens.reduce((a, b) => a + b, 0);
  const partitionTokens: Record<PartitionId, number> = {
    S: 0,
    L: 0,
    M: 0,
    H: 0,
  };
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m) continue;
    partitionTokens[partitionOfMessage(m)] += tokens[i] ?? 0;
  }
  const usageRatio = total / budget;
  if (total <= budget * threshold) {
    return {
      messages: [...messages],
      droppedCount: 0,
      partitionTokens,
      usageRatio,
    };
  }

  const drop = new Set<number>();
  let current = total;
  const target = budget * threshold;
  for (let i = 0; i < messages.length && current > target; i++) {
    const message = messages[i];
    if (!message) continue;
    if (partitionOfMessage(message) === "S") continue;
    // 配对安全：tool 消息 / 带 tool_calls 的 assistant 一律不单条丢
    if (message.role === "tool" || message.tool_call_id) continue;
    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0)
      continue;
    drop.add(i);
    current -= tokens[i] ?? 0;
  }

  const droppedCount = drop.size;
  return {
    messages: messages.filter((_m, i) => !drop.has(i)),
    droppedCount,
    partitionTokens,
    usageRatio: current / budget,
  };
}
