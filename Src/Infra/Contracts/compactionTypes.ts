/**
 * @module Infra/Contracts/compactionTypes
 * @description
 * 上下文压缩「管理策略机」的跨层共享契约——纯类型、零运行时、零 import（ADR-0006）。
 *
 * 为什么下沉到 Infra/Contracts：
 *  - 策略机的**实现**与既有监管层同址（`Services/Supervision/`），
 *    策略机的**编排入口**在 `Core/Loop/contextCompression.ts`；
 *  - 二者必须共享同一份「消息 / 水位 / 难度档 / 策略 / 结果」契约，
 *    但五层红线不允许 `Services → Core`；
 *  - 故按 ADR-0006 把纯类型契约放在 `Infra/Contracts`，供 Core / Services / 组合根共同向下依赖。
 *
 * 本契约是《一些思考3》（上下文压缩时机与相关度评分机制研究报告）的落地层，
 * 对应其 §1（水位线）、§2（成本模型）、§3（难度分级）、§5.1（模块划分）。
 *
 * 红线：本文件不得 import 任何模块，不得含任何运行时代码。
 */

// ── 消息（结构类型，避免 Services 依赖 Core/Model 的 ChatMessage）─────────

/**
 * 工具调用（OpenAI 兼容形）。
 * 字段与 `Infra/Llm/Provider.providerBase` 的 `ToolCallSpec` **逐字段同构**，
 * 因此 `ChatMessage[]` 与本契约消息数组可**双向结构化赋值**（无需断言）。
 */
export interface CompactableToolCall {
  readonly id: string;
  readonly type: string;
  readonly function: {
    readonly name: string;
    readonly arguments: string;
  };
}

/** 可压缩消息（与 Core/Model 的 ChatMessage 结构等价） */
export interface CompactableMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  readonly name?: string;
  readonly tool_call_id?: string;
  readonly tool_calls?: CompactableToolCall[];
}

// ── 难度档（§3）────────────────────────────────────────────────────

/** 任务复杂度档（由难度旁路模块给出，策略机不自行判定触发） */
export type ComplexityClass = "simple" | "medium" | "complex";

/** 前缀缓存敏感度（§2.3：越敏感越只能动尾部） */
export type CacheSensitivity = "low" | "medium" | "high";

/** 多级触发层级（§1.6） */
export type CompactionLayer =
  "none" | "micro" | "auto" | "emergency" | "manual";

/** 难度档 → 压缩参数（§3.3；触发水位口径按 §3.4/§6 叙述取值，见 compactionPolicy 说明） */
export interface CompactionProfile {
  /** Auto 层触发水位（对有效窗口占用率）；简单请求更低（更早压缩），复杂请求更高 */
  triggerRatio: number;
  /** 尾部原文保护比例（0-1，对有效窗口） */
  tailProtect: number;
  /** 前缀缓存敏感度 */
  cacheSensitivity: CacheSensitivity;
  /** 是否允许把「高相关旧片段」逐条提升为原文保留（复杂请求才开） */
  promoteRelevant: boolean;
}

/** 水位线（§1.1） */
export interface CompactionWatermarks {
  /** 轻度拥挤：只记录指标 / 只做免费裁剪 */
  light: number;
  /** 主触发区 */
  main: number;
  /** 高风险区：强制压缩 */
  high: number;
  /** 溢出边缘 */
  overflow: number;
}

// ── 决策输入 / 输出（§1.7 / §2.4）──────────────────────────────────

/** 触发侧信号（主决策器的输入） */
export interface CompactionSignals {
  /** 难度档（旁路输入，不单独决定触发） */
  complexity: ComplexityClass;
  /** 有效窗口占用率 = current_prompt_tokens / effective_window */
  usageRatio: number;
  /** 剩余可用空间（tokens） */
  remainingTokens: number;
  /** 下一轮预期增长（tokens）；用于 §1.2 提前触发 */
  expectedNextGrowthTokens: number;
  /** 最大单条工具结果 tokens；超限时提前触发（§1.7） */
  toolOutputTokens: number;
  /** 是否有子任务在本轮结束（§1.5 事件边界） */
  subtaskEnded: boolean;
  /** 是否人工 / Agent 主动请求压缩（§1.6 Manual 层） */
  manualRequested: boolean;
  /** 前缀缓存命中率（§2.2，用于成本估算） */
  prefixHitRate: number;
}

/** 触发决策（纯函数输出，不含副作用） */
export interface CompactionDecision {
  /** 是否建议动手 */
  compact: boolean;
  /** 命中层级 */
  layer: CompactionLayer;
  /** 决策原因（诊断 / 事件载荷） */
  reason: string;
  /** 本次生效的触发水位 */
  triggerRatio: number;
}

// ── 策略机（§5.1 压缩策略选择器）────────────────────────────────────

/** 策略机类别 */
export type StrategyKind = "rule" | "llm" | "isolation" | "flush" | "fallback";

/** 单次运行的上下文；由编排入口构造，策略机只读 + 通过回调产生副作用 */
export interface StrategyContext {
  /** 待处理消息（策略机不得改动数组本身；返回新数组） */
  readonly messages: readonly CompactableMessage[];
  /** 命中层级 */
  readonly layer: CompactionLayer;
  /** 难度档 */
  readonly complexity: ComplexityClass;
  /** 有效窗口（tokens） */
  readonly effectiveWindow: number;
  /** 预算：压缩后目标 tokens 上限 */
  readonly budgetTokens: number;
  /** 尾部必须保护的原文 tokens */
  readonly tailProtectTokens: number;
  /** 单条工具结果裁剪上限（tokens）；规则裁剪策略机用 */
  readonly toolOutputTokenLimit: number;
  /** 当前目标（重锚 / 摘要用） */
  readonly goal: string;
  /** 归属 trace（memory flush 落盘溯源用） */
  readonly traceId: string;
  /** 归属 loop（可选） */
  readonly loopId?: string;
  /** 活跃子任务 id（子任务隔离策略用） */
  readonly activeSubtasks: readonly string[];
  /** 触发侧信号 */
  readonly signals: CompactionSignals;
  /** 摘要回调（LLM 类策略机用；由编排入口注入，Services 侧不 import Core/Model） */
  readonly summarize?: (historyText: string) => Promise<string | null>;
  /** 持久化回调（memory flush 策略机用） */
  readonly flushMemory?: (
    keyPoints: string,
    meta: { traceId: string; loopId?: string },
  ) => Promise<boolean>;
}

/** 策略机执行结果 */
export interface StrategyResult {
  /** 是否真的改动了上下文 */
  changed: boolean;
  /** 改动后的消息 */
  messages: readonly CompactableMessage[];
  /** 被丢弃的消息片段类型（供 compressSupervision 的 criticalEntriesLost 判定） */
  droppedEntryTypes: readonly string[];
  /** 策略机自述摘要（事件载荷 / 日志） */
  note: string;
}

/** 单个管理策略机的执行契约 */
export interface CompactionStrategy {
  /** 唯一 id（注册去重键） */
  readonly id: string;
  /** 类别 */
  readonly kind: StrategyKind;
  /** 适用层级（命中的 layer 之一） */
  readonly layers: readonly CompactionLayer[];
  /** 适用难度档（省略 = 全档适用） */
  readonly complexities?: readonly ComplexityClass[];
  /** 排序优先级：小的先跑（本轮首策略） */
  readonly priority: number;
  /** 是否调用 LLM（用于 §1.6「从免费策略开始」的排序与成本统计） */
  readonly usesLlm: boolean;
  /** 该策略机是否适用于本次上下文 */
  applies(ctx: StrategyContext): boolean;
  /** 执行（返回新消息；fail-soft：失败应返回 changed:false 而非抛出） */
  execute(ctx: StrategyContext): Promise<StrategyResult>;
}

// ── 结果 / 指标（§1.3 / §1.8 / §5.3）──────────────────────────────

/** 一次压缩运行的合成结果 */
export interface CompactionOutcome {
  /** 是否发生实际压缩 */
  compressed: boolean;
  /** 参与的层级 */
  layer: CompactionLayer;
  /** 实际执行过的策略机 id（按执行顺序） */
  appliedStrategies: readonly string[];
  /** 压缩前 / 后 tokens */
  tokensBefore: number;
  tokensAfter: number;
  /** 节省比 = 1 - after/before（§1.3） */
  gainRatio: number;
  /** 未压缩原因（诊断） */
  reason?: string;
}
