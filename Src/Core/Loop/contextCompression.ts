/**
 * @module Loop/contextCompression
 * @description
 * ⑤ 步懒监听——上下文压缩（原 FE-055；本版升级为**多台管理策略机 + 成本/难度决策**）。
 *
 * 本模块从「单条写死的压缩链路」升级为**编排入口**：
 *
 * ```
 *  信号采集(占用/剩余/增长/工具膨胀/子任务边界)
 *      ↓
 *  compactionPolicy.decideCompaction  ← 水位线 + 难度档 + 成本模型   (纯判定)
 *      ↓
 *  Supervision.strategyRegistry.selectStrategies  ← 可插拔策略机选择器
 *      ↓
 *  顺序执行策略机（先免费后 LLM；逐个 fail-soft）
 *      ↓
 *  收益门槛(≥10%) + 连续低收益抑制
 *      ↓
 *  ★ 既有监管层事后关卡：runCompressSupervision / runSummarySupervision
 *      ↓
 *  发布 CONTEXT_COMPRESSED + 指标累加
 * ```
 *
 * 与既有监管层的关系（**不移除、不替换、只接上**）：
 *  - `Services/Supervision/` 的六个监管函数全部保留原名原语义；
 *  - 其中 `runCompressSupervision` / `runSummarySupervision` 此前**零生产调用方**，
 *    本版把它们接成压缩后关卡：前者保留「关键条目丢失」的**否决权**（对齐 ADR-0005），
 *    后者只做摘要质量记录；
 *  - 策略机的实现与监管层同址（`Services/Supervision/compactionStrategies.ts`）。
 *
 * 红线（ADR-0005）：只处理对话历史，不触碰 goal 与 immutableConstraints；
 * 前缀（系统提示）由调用方在装配时置于 `messages[0]` 之外，本模块不改动它。
 */

import type { Result } from "../../Infra/types.js";
import { ok, err } from "../../Infra/types.js";
import type {
  CompactableMessage,
  CompactionDecision,
  CompactionLayer,
  CompactionOutcome,
  CompactionSignals,
  ComplexityClass,
  StrategyContext,
} from "../../Infra/Contracts/compactionTypes.js";
import { EventType } from "../../Services/EventBus/eventTypes.js";
import { createEvent, publish } from "../../Services/EventBus/eventBus.js";
import { resolveModel } from "../../Infra/Llm/Router/modelRouter.js";
import { runCompressSupervision } from "../../Services/Supervision/compressSupervision.js";
import { runSummarySupervision } from "../../Services/Supervision/summarySupervision.js";
import {
  safeSplitIndex,
  tailStartIndex,
} from "../../Services/Supervision/compactionStrategies.js";
import { selectStrategies } from "../../Services/Supervision/strategyRegistry.js";
import { callModel, type ChatMessage } from "../Model/modelCaller.js";
import {
  DEFAULT_COMPACTION_POLICY,
  LowGainTracker,
  classifyRequestComplexity,
  compactionGainRatio,
  decideCompaction,
  estimateCacheInvalidation,
  estimateCompactionCost,
  meetsGainGate,
  mergeCompactionPolicy,
  resolveCacheSensitivity,
  resolveProfile,
  resolveTailProtectTokens,
  type CompactionPolicyConfig,
  type ComplexityHints,
} from "./compactionPolicy.js";
import {
  WEIGHT_PROFILES,
  partitionByRelevance,
  type ContextChunk,
  type RelevanceWeights,
} from "./relevanceScoring.js";
import { logger } from "../../Infra/Logging/logger.js";

/**
 * 策略机自述中的「失败类」前缀——这类 note 会在压缩未生效时**原样回传**为
 * `CompressContextResult.reason`，保住调用方（与既有测试）对失败原因的既有口径。
 */
const STRATEGY_FAILURE_NOTE_RE = /^(summarize-|empty-summary|记忆落盘异常)/;

// ── 配置 ────────────────────────────────────────────────────────────

/** 相关度评分配置（§4.3 / §4.5） */
export interface RelevanceConfig {
  /** 保留 tokens 上限占总量比例（缺省 0.85） */
  maxKeepRatio: number;
  /** 保底保留 tokens */
  minKeepTokens: number;
  /** 三套权重档 */
  weights: {
    simple: RelevanceWeights;
    complex: RelevanceWeights;
    cacheSensitive: RelevanceWeights;
  };
}

export interface ContextCompressionConfig {
  /** 总开关（缺省 true） */
  enabled: boolean;
  /** 显式触发阈值（tokens 估算）；配置后**优先于**水位线推导（兼容旧行为） */
  triggerTokens?: number;
  /** 触发比例（对有效窗口）；仅在未给难度档时作为兼容口径使用 */
  contextWindowRatio: number;
  /** 输出预留 tokens（对齐 loopConfig.json context.outputReserveTokens，缺省 4096） */
  outputReserveTokens: number;
  /** 无法解析模型 context_window 时的兜底阈值（tokens） */
  fallbackTriggerTokens: number;
  /** 保留最近 N 条消息原文（不参与压缩，缺省 6） */
  keepRecentMessages: number;
  /** 消息数下限——低于该值不压缩（缺省 8） */
  minMessagesToCompress: number;
  /** 摘要请求 max_tokens（缺省 800） */
  summaryMaxTokens: number;
  /** 策略机决策配置（水位线 / 难度档 / 成本模型，§1-§3） */
  compaction: CompactionPolicyConfig;
  /** 相关度评分配置（§4） */
  relevance: RelevanceConfig;
}

const DEFAULT_RELEVANCE: RelevanceConfig = {
  maxKeepRatio: 0.85,
  minKeepTokens: 8_000,
  weights: {
    simple: WEIGHT_PROFILES.simple,
    complex: WEIGHT_PROFILES.complex,
    cacheSensitive: WEIGHT_PROFILES.cacheSensitive,
  },
};

const DEFAULTS: ContextCompressionConfig = {
  enabled: true,
  contextWindowRatio: 0.8,
  outputReserveTokens: 4096,
  fallbackTriggerTokens: 32_000,
  keepRecentMessages: 6,
  minMessagesToCompress: 8,
  summaryMaxTokens: 800,
  compaction: DEFAULT_COMPACTION_POLICY,
  relevance: DEFAULT_RELEVANCE,
};

let _config: ContextCompressionConfig = cloneDefaults();

/** 连续低收益抑制器（§1.3）；配置变更时重建 */
let _lowGain = new LowGainTracker(DEFAULTS.compaction.maxConsecutiveLowGain);

function cloneDefaults(): ContextCompressionConfig {
  return {
    ...DEFAULTS,
    compaction: mergeCompactionPolicy(DEFAULT_COMPACTION_POLICY),
    relevance: {
      ...DEFAULT_RELEVANCE,
      weights: { ...DEFAULT_RELEVANCE.weights },
    },
  };
}

// ── 摘要调用（可注入，缺省走统一模型调用入口）──────────────────────

export type ContextSummaryCaller = (
  model: string,
  messages: ChatMessage[],
  opts: { max_tokens: number; temperature: number },
) => Promise<Result<{ content: string }>>;

export interface ContextCompressionDeps {
  /** 摘要调用函数（测试注入；缺省走 Core/Model.callModel） */
  modelCaller?: ContextSummaryCaller;
  /**
   * memory-flush 落盘回调（`memory-flush` 策略机用；§2.6-4）。
   * 由组合根注入为 SharedMemory 写入，避免 Core→Services 的具体耦合。
   */
  memoryFlusher?: (
    keyPoints: string,
    meta: { traceId: string; loopId?: string },
  ) => Promise<boolean>;
  /**
   * 难度旁路探针（§3.1）。由组合根注入（可用 Decision/complexityAssessor）；
   * Core/Loop 不直接 import Core/Decision——那会与 `Decision → AgentRuntime → Loop`
   * 形成循环依赖。
   */
  complexityProbe?: (
    request: string,
    hints: ComplexityHints,
  ) => ComplexityClass;
  /** 语义相似度函数（§4.6 第 2/3 层：embedding / LLM 重排）；缺省走关键词层 */
  semanticFn?: (request: string, content: string) => number;
}

let _deps: ContextCompressionDeps = {};

async function defaultSummaryCaller(
  model: string,
  messages: ChatMessage[],
  opts: { max_tokens: number; temperature: number },
): Promise<Result<{ content: string }>> {
  const result = await callModel(model, messages, {
    ...opts,
    purpose: "internal",
  });
  if (!result.ok) return err(result.error, result.severity);
  return ok({ content: result.value.content });
}

/**
 * 配置补丁（浅层字段 + 两段深度合并的嵌套配置）。
 * `compaction` / `relevance` 允许只给部分键——深层合并保留其余默认值。
 */
export interface ContextCompressionConfigPatch extends Omit<
  Partial<ContextCompressionConfig>,
  "compaction" | "relevance"
> {
  compaction?: Partial<CompactionPolicyConfig>;
  relevance?: Partial<Omit<RelevanceConfig, "weights">> & {
    weights?: Partial<RelevanceConfig["weights"]>;
  };
}

/** 注入压缩配置 / 依赖（main.ts 启动时从配置注入；缺省值即生产默认） */
export function configureContextCompression(
  partial: ContextCompressionConfigPatch = {},
  deps?: ContextCompressionDeps,
): void {
  const { compaction, relevance, ...rest } = partial;
  const next: ContextCompressionConfig = { ..._config, ...rest };
  if (compaction) {
    next.compaction = mergeCompactionPolicy(_config.compaction, compaction);
  }
  if (relevance) {
    next.relevance = {
      ..._config.relevance,
      ...relevance,
      weights: { ..._config.relevance.weights, ...(relevance.weights ?? {}) },
    };
  }
  _config = next;
  _lowGain = new LowGainTracker(_config.compaction.maxConsecutiveLowGain);
  if (deps) _deps = { ..._deps, ...deps };
}

/** 测试/诊断用：恢复默认配置 */
export function resetContextCompression(): void {
  _config = cloneDefaults();
  _deps = {};
  _lowGain = new LowGainTracker(_config.compaction.maxConsecutiveLowGain);
  resetCompactionMetrics();
}

/** 当前配置快照（诊断用） */
export function getContextCompressionConfig(): ContextCompressionConfig {
  return {
    ..._config,
    compaction: mergeCompactionPolicy(_config.compaction),
    relevance: {
      ..._config.relevance,
      weights: { ..._config.relevance.weights },
    },
  };
}

// ── 规模估算 ────────────────────────────────────────────────────────

/** 估算消息数组的 token 规模（chars/4 口径，与此前 ⑤ 步记录一致） */
export function estimateMessageTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + (m.content?.length ?? 0) / 4, 0);
}

/** 解析有效窗口（context_window - 输出预留）；无法解析返回 0 */
export function resolveEffectiveWindow(loopModel: string): number {
  const resolved = resolveModel(loopModel);
  if (!resolved.ok || resolved.value.spec.context_window <= 0) return 0;
  return Math.max(
    resolved.value.spec.context_window - _config.outputReserveTokens,
    1,
  );
}

/**
 * 解析触发阈值：显式配置 > 有效窗口 × 难度档水位 > 兜底值。
 * 未传 `complexity` 时退回历史口径 `contextWindowRatio`（兼容旧调用方）。
 */
export function resolveTriggerTokens(
  loopModel: string,
  complexity?: ComplexityClass,
): number {
  if (_config.triggerTokens !== undefined && _config.triggerTokens > 0) {
    return _config.triggerTokens;
  }
  const effectiveWindow = resolveEffectiveWindow(loopModel);
  if (effectiveWindow > 0) {
    const ratio = complexity
      ? resolveProfile(_config.compaction, complexity).triggerRatio
      : _config.contextWindowRatio;
    return Math.floor(effectiveWindow * ratio);
  }
  return _config.fallbackTriggerTokens;
}

// ── 指标（§1.8 / §5.3）─────────────────────────────────────────────

export interface CompactionMetrics {
  /** 运行次数 */
  runs: number;
  /** 实际发生压缩的次数 */
  compressions: number;
  /** 按层级计数 */
  byLayer: Record<CompactionLayer, number>;
  /** 累计节省 tokens */
  tokensSaved: number;
  /** 因收益不足被跳过的次数（§1.3） */
  skippedLowGain: number;
  /** 被监管层否决的次数 */
  vetoedBySupervision: number;
  /** 累计压缩耗时（ms） */
  totalLatencyMs: number;
}

function emptyMetrics(): CompactionMetrics {
  return {
    runs: 0,
    compressions: 0,
    byLayer: { none: 0, micro: 0, auto: 0, emergency: 0, manual: 0 },
    tokensSaved: 0,
    skippedLowGain: 0,
    vetoedBySupervision: 0,
    totalLatencyMs: 0,
  };
}

let _metrics: CompactionMetrics = emptyMetrics();

/** 压缩指标快照（§1.8 / §5.3 监控指标） */
export function getCompactionMetrics(): CompactionMetrics {
  return { ..._metrics, byLayer: { ..._metrics.byLayer } };
}

/**
 * ★ S2（2026-10-15）：**会话级**指标快照。
 * 与 `getCompactionMetrics()` 的区别：只读该会话自己的计量，不混入其他运行。
 * 计量必须可归因（见 Docs/Dev/L1编排设计/13-ReAct跨切面约束.md §17）。
 */
export function getSessionCompactionMetrics(
  session: CompressionSession,
): CompactionMetrics {
  return { ...session.metrics, byLayer: { ...session.metrics.byLayer } };
}

/** ★ S2：重置**会话级**指标（不触碰模块全局） */
export function resetSessionCompactionMetrics(
  session: CompressionSession,
): void {
  session.metrics = emptyMetrics();
  session.lowGain = new LowGainTracker(
    _config.compaction.maxConsecutiveLowGain,
  );
}

/** 重置指标（测试用） */
export function resetCompactionMetrics(): void {
  _metrics = emptyMetrics();
}

// ── 输入 / 输出 ─────────────────────────────────────────────────────

export interface CompressContextInput {
  /** 装配素材（对话历史段，含可能的钩子注入；不含系统提示与追加区） */
  messages: ChatMessage[];
  /** 当前 Loop 模型全限定名（摘要默认用它） */
  loopModel: string;
  /** 当前目标（重锚消息用；通常为 ctx.userInput） */
  goal: string;
  /** 归属 trace（事件用） */
  traceId: string;
  /** 归属 loop（事件用，可选） */
  loopId?: string;
  /** 难度档（旁路输入）；缺省由复杂度探针或启发式给出 */
  complexity?: ComplexityClass;
  /** 难度旁路信号（探针用） */
  complexityHints?: ComplexityHints;
  /** 本轮是否有子任务结束（§1.5 事件边界） */
  subtaskEnded?: boolean;
  /** 本轮观测到的最大单条工具结果 tokens（§1.7 提前触发信号） */
  toolOutputTokens?: number;
  /** 下一轮预期增长 tokens（§1.2 提前触发） */
  expectedNextGrowthTokens?: number;
  /** 是否人工/Agent 主动请求压缩（§1.6 Manual 层） */
  manualRequested?: boolean;
  /** 活跃子任务 id（子任务隔离策略机用） */
  activeSubtasks?: readonly string[];
  /** 前缀缓存命中率 [0,1]（§2.2 成本模型用） */
  prefixHitRate?: number;
}

export interface CompressContextResult {
  compressed: boolean;
  /** 压缩后消息（未压缩时为原数组） */
  messages: ChatMessage[];
  tokensBefore: number;
  tokensAfter: number;
  /** 未压缩原因（诊断用；压缩成功时为 undefined） */
  reason?: string;
  /** 本次合成结果（层级 / 策略机 / 收益），未压缩时 layer='none' */
  outcome: CompactionOutcome;
}

/** 内容等价：装配素材与共享历史逐条同构（无钩子改写时成立 → 允许跨轮回写） */
export function sameMessageContent(
  a: ChatMessage[],
  b: ChatMessage[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every((m, i) => {
    const other = b[i];
    return !!other && m.role === other.role && m.content === other.content;
  });
}

// ── 主流程 ──────────────────────────────────────────────────────────

/**
 * 尝试压缩上下文（fail-soft，绝不阻断迭代）。
 *
 * 触发 = 水位线 / 难度档水位 / 剩余空间 / 预期增长 / 工具膨胀 / 子任务边界 任一命中；
 * 执行 = 选中层级对应的多台策略机按优先级顺序跑（先免费后 LLM）；
 * 生效 = 收益 ≥ `minSavedRatio` 且未被监管层否决。
 */
/**
 * ★ S2（2026-10-15）：**压缩会话**——把「连续低增益计数」与「压缩计量」
 * 从模块全局移出，改为**每次运行一份**。
 *
 * 为什么必须有：`_lowGain` 是"连续低增益压缩"的计数（达阈值换策略），
 * `_metrics` 是压缩计量累加器。二者都是**运行态**，但原先住在模块全局里 ⇒
 * 嵌套/并发的两层循环会**互相推进对方的计数器、并把计量混在一起**
 * （后者直接违反"计量必须可归因"）。
 *
 * 兼容：不传 `session` 时仍用模块全局（默认会话），既有调用方行为不变。
 * 取证与判定见 Docs/Dev/L1编排设计/26-S1模块级可变状态盘点.md
 */
export interface CompressionSession {
  lowGain: LowGainTracker;
  metrics: CompactionMetrics;
}

/** 新建一个压缩会话（每次循环运行一份；不要跨运行复用）。 */
export function createCompressionSession(): CompressionSession {
  return {
    lowGain: new LowGainTracker(_config.compaction.maxConsecutiveLowGain),
    metrics: emptyMetrics(),
  };
}

export async function maybeCompressContext(
  input: CompressContextInput,
  session?: CompressionSession,
): Promise<CompressContextResult> {
  const startedAt = Date.now();
  // S2：会话优先；缺省回落到模块全局（兼容既有调用方）
  const metrics = session?.metrics ?? _metrics;
  const lowGain = session?.lowGain ?? _lowGain;
  const { messages } = input;
  const tokensBefore = estimateMessageTokens(messages);
  const noneOutcome = (layer: CompactionLayer = "none"): CompactionOutcome => ({
    compressed: false,
    layer,
    appliedStrategies: [],
    tokensBefore,
    tokensAfter: tokensBefore,
    gainRatio: 0,
  });
  const noop = (
    reason: string,
    layer: CompactionLayer = "none",
  ): CompressContextResult => {
    metrics.runs += 1;
    metrics.byLayer[layer] += 1;
    metrics.totalLatencyMs += Date.now() - startedAt;
    return {
      compressed: false,
      messages,
      tokensBefore,
      tokensAfter: tokensBefore,
      reason,
      outcome: { ...noneOutcome(layer), reason },
    };
  };

  if (!_config.enabled) return noop("disabled");
  if (messages.length < _config.minMessagesToCompress)
    return noop("below-min-messages");

  // ── 难度档（旁路：只影响预算/水位，不单独决定触发，§3.1）──
  const hints: ComplexityHints = {
    messageCount: messages.length,
    ...(input.complexityHints ?? {}),
  };
  const complexity: ComplexityClass =
    input.complexity ??
    _deps.complexityProbe?.(input.goal, hints) ??
    classifyRequestComplexity(input.goal, hints);

  const profile = resolveProfile(_config.compaction, complexity);
  const effectiveWindow = resolveEffectiveWindow(input.loopModel);
  const trigger = resolveTriggerTokens(input.loopModel, complexity);

  // 有效窗口可知 → 走完整水位线/成本策略；不可知 → 退化为历史口径（显式阈值命中即 auto 层），
  // 避免 `usageRatio` 只能取 0/1 而被误判进 emergency 层（会触发硬裁剪）。
  const usageRatio =
    effectiveWindow > 0
      ? tokensBefore / effectiveWindow
      : trigger > 0
        ? tokensBefore / trigger
        : 0;
  const remainingTokens =
    effectiveWindow > 0
      ? effectiveWindow - tokensBefore
      : trigger - tokensBefore;

  const signals: CompactionSignals = {
    complexity,
    usageRatio,
    remainingTokens,
    expectedNextGrowthTokens: input.expectedNextGrowthTokens ?? 0,
    toolOutputTokens: input.toolOutputTokens ?? 0,
    subtaskEnded: input.subtaskEnded ?? false,
    manualRequested: input.manualRequested ?? false,
    prefixHitRate: input.prefixHitRate ?? 0,
  };

  let decision: CompactionDecision;
  if (effectiveWindow > 0) {
    decision = decideCompaction(_config.compaction, signals);
    if (!decision.compact) return noop(decision.reason);
  } else if (!_config.compaction.enabled) {
    return noop("disabled");
  } else if (signals.manualRequested) {
    decision = {
      compact: true,
      layer: "manual",
      reason: "manual-request",
      triggerRatio: profile.triggerRatio,
    };
  } else if (tokensBefore >= trigger) {
    decision = {
      compact: true,
      layer: "auto",
      reason: "explicit-trigger",
      triggerRatio: profile.triggerRatio,
    };
  } else {
    return noop("below-threshold");
  }

  // ── §1.3 连续低收益抑制 ──
  if (lowGain.shouldSuppress() && decision.layer === "auto") {
    metrics.skippedLowGain += 1;
    return noop("suppressed-low-gain", decision.layer);
  }

  // ── 预算与保护窗口 ──
  const tailFloor = tailTokensOfLast(messages, _config.keepRecentMessages);
  const tailProtectTokens = Math.max(
    resolveTailProtectTokens(
      profile,
      effectiveWindow,
      _config.compaction.tailProtectFloorTokens,
    ),
    tailFloor,
  );
  const budgetTokens =
    effectiveWindow > 0
      ? Math.max(1, effectiveWindow - tailProtectTokens)
      : Math.max(1, Math.floor(tokensBefore * 0.5));

  // 摘要回调：deps.modelCaller（测试） > 默认模型调用
  const caller = _deps.modelCaller ?? defaultSummaryCaller;
  const summarize = async (historyText: string): Promise<string | null> => {
    const result = await caller(
      input.loopModel,
      buildSummaryMessages(historyText) as ChatMessage[],
      { max_tokens: _config.summaryMaxTokens, temperature: 0 },
    );
    if (!result.ok) return null;
    // 原样回传（含空白摘要）：由策略机区分「调用失败(null)」与「空摘要('')」两种原因
    return result.value.content;
  };

  const strategyCtx: StrategyContext = {
    messages,
    layer: decision.layer,
    complexity,
    effectiveWindow,
    budgetTokens,
    tailProtectTokens,
    toolOutputTokenLimit: _config.compaction.toolOutputTokenLimit,
    goal: input.goal,
    traceId: input.traceId,
    ...(input.loopId !== undefined ? { loopId: input.loopId } : {}),
    activeSubtasks: input.activeSubtasks ?? [],
    signals,
    summarize,
    ...(_deps.memoryFlusher ? { flushMemory: _deps.memoryFlusher } : {}),
  };

  // ── 选择并顺序执行策略机（先免费后 LLM；逐个 fail-soft）──
  const selected = selectStrategies(strategyCtx);
  let current: CompactableMessage[] = [...messages];
  const applied: string[] = [];
  const droppedTypes = new Set<string>();
  /** 最近一次策略机自述的失败原因（用于把「没压成」的真实原因回传给调用方） */
  let lastStrategyFailure: string | undefined;

  for (const strategy of selected) {
    let applies = false;
    try {
      applies = strategy.applies({ ...strategyCtx, messages: current });
    } catch (e) {
      logger.warn("策略机 applies 异常（跳过）", {
        source: "runIteration/⑤LazySupervision",
        strategy: strategy.id,
        error: e instanceof Error ? e.message : String(e),
      });
      continue;
    }
    if (!applies) continue;

    try {
      const result = await strategy.execute({
        ...strategyCtx,
        messages: current,
      });
      applied.push(strategy.id);
      for (const t of result.droppedEntryTypes) droppedTypes.add(t);
      if (result.changed) current = [...result.messages];
      else if (STRATEGY_FAILURE_NOTE_RE.test(result.note))
        lastStrategyFailure = result.note;
    } catch (e) {
      // fail-soft：单台策略机失败不影响其余策略机，更不阻断迭代
      lastStrategyFailure = e instanceof Error ? e.message : String(e);
      logger.warn("策略机执行异常（fail-soft）", {
        source: "runIteration/⑤LazySupervision",
        strategy: strategy.id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // ── 复杂请求：相关度过滤后的高价值旧片段回插（§3.4 / §4）──
  let promoted = 0;
  if (profile.promoteRelevant && effectiveWindow > 0) {
    const promotion = promoteRelevantChunks({
      request: input.goal,
      original: messages,
      current,
      tailProtectTokens,
      budgetTokens,
      complexity,
      activeSubtasks: input.activeSubtasks ?? [],
      maxKeepRatio: _config.relevance.maxKeepRatio,
      minKeepTokens: _config.relevance.minKeepTokens,
      ...(_deps.semanticFn ? { semanticFn: _deps.semanticFn } : {}),
    });
    current = promotion.messages;
    promoted = promotion.promoted;
  }

  // 与 `tokensBefore` 同口径（estimateMessageTokens 的 float 求和），保证收益比可比
  const tokensAfter = estimateMessageTokens(current);

  // ── §1.3 收益门槛 ──
  if (!meetsGainGate(_config.compaction, tokensBefore, tokensAfter)) {
    lowGain.record(tokensBefore, tokensAfter, _config.compaction.minSavedRatio);
    metrics.skippedLowGain += 1;
    return noop(
      lastStrategyFailure ??
        `gain-below-threshold(${compactionGainRatio(tokensBefore, tokensAfter).toFixed(3)})`,
      decision.layer,
    );
  }

  // ── ★ 既有监管层事后关卡（不移除、只接上）──
  const compressCheck = runCompressSupervision(tokensBefore, tokensAfter, [
    ...droppedTypes,
  ]);
  const criticalLost =
    compressCheck.ok && compressCheck.value.criticalEntriesLost;
  if (criticalLost) {
    // 监管否决权：关键条目（SYSTEM_PROMPT / ROLE_DEFINITION / IMMUTABLE_CONSTRAINT）被丢
    // → 回退原上下文（对齐 ADR-0005：目标与不可变约束不得被压缩触及）
    metrics.vetoedBySupervision += 1;
    return noop(
      "compress-supervision-vetoed: critical-entries-lost",
      decision.layer,
    );
  }
  const summaryCheck = runSummarySupervision(tokensBefore, tokensAfter, true);

  // ── 事件 + 指标 ──
  const gainRatio = compactionGainRatio(tokensBefore, tokensAfter);
  const sensitivity = resolveCacheSensitivity(_config.compaction, complexity);
  const deltaCache = estimateCacheInvalidation(
    sensitivity,
    effectiveWindow,
    tailProtectTokens,
  );
  const cost = estimateCompactionCost(_config.compaction, {
    expectedNextGrowthTokens: signals.expectedNextGrowthTokens,
    prefixHitRate: signals.prefixHitRate,
    cacheInvalidatedTokens: deltaCache,
    overflowProbability: decision.layer === "emergency" ? 1 : 0,
  });

  publish(
    createEvent({
      eventType: EventType.CONTEXT_COMPRESSED,
      source: "runIteration/⑤LazySupervision",
      traceId: input.traceId,
      loopId: input.loopId,
      payload: {
        messagesBefore: messages.length,
        messagesAfter: current.length,
        tokensBefore: Math.round(tokensBefore),
        tokensAfter: Math.round(tokensAfter),
        triggerTokens: trigger,
        model: input.loopModel,
        reanchorInjected: true,
        // ── 本次升级新增的可观测字段 ──
        layer: decision.layer,
        decisionReason: decision.reason,
        complexity,
        triggerRatio: decision.triggerRatio,
        usageRatio: Number(usageRatio.toFixed(4)),
        appliedStrategies: applied,
        droppedEntryTypes: [...droppedTypes],
        gainRatio: Number(gainRatio.toFixed(4)),
        promotedChunks: promoted,
        cacheSensitivity: sensitivity,
        deltaCacheTokens: deltaCache,
        costCompact: Math.round(cost.costCompact),
        costNoCompact: Math.round(cost.costNoCompact),
        supervision: {
          compressInterventionNeeded: compressCheck.ok
            ? compressCheck.value.interventionNeeded
            : null,
          summaryQualityOk: summaryCheck.ok
            ? summaryCheck.value.summaryQualityOk
            : null,
          summaryRatio: summaryCheck.ok
            ? Number(summaryCheck.value.summaryRatio.toFixed(4))
            : null,
        },
      },
    }),
  );

  metrics.runs += 1;
  metrics.compressions += 1;
  metrics.byLayer[decision.layer] += 1;
  metrics.tokensSaved += Math.max(0, Math.round(tokensBefore - tokensAfter));
  metrics.totalLatencyMs += Date.now() - startedAt;

  return {
    compressed: true,
    messages: [...current],
    tokensBefore,
    tokensAfter,
    outcome: {
      compressed: true,
      layer: decision.layer,
      appliedStrategies: applied,
      tokensBefore,
      tokensAfter,
      gainRatio,
    },
  };
}

// ── 内部辅助 ────────────────────────────────────────────────────────

/** 最近 N 条消息的 token 数（尾部保护下限） */
function tailTokensOfLast(
  messages: readonly ChatMessage[],
  count: number,
): number {
  if (count <= 0) return 0;
  const start = Math.max(0, messages.length - count);
  return estimateMessageTokens(messages.slice(start) as ChatMessage[]);
}

/** 摘要请求消息构造（与结构化摘要策略机共用同一提示词口径） */
function buildSummaryMessages(
  historyText: string,
): Array<{ role: "system" | "user"; content: string }> {
  return [
    {
      role: "system",
      content: [
        "你是上下文压缩器。将给定对话历史压缩为简洁、忠实的事实摘要，供后续推理使用。",
        "必须覆盖五要素：① 任务目标 ② 当前进度 ③ 约束与已确认结论 ④ 已尝试路径 ⑤ 剩余工作。",
        "保留：关键文件路径与产物、已做出的决定、未完成的步骤。",
        "丢弃：问候与寒暄、重复的尝试过程、冗长原始输出（用一句概括）。",
        "输出纯文本（不超过 400 字），不要使用 Markdown 标题。",
      ].join("\n"),
    },
    { role: "user", content: historyText },
  ];
}

interface PromotionInput {
  request: string;
  original: readonly ChatMessage[];
  current: readonly CompactableMessage[];
  tailProtectTokens: number;
  budgetTokens: number;
  complexity: ComplexityClass;
  activeSubtasks: readonly string[];
  maxKeepRatio: number;
  minKeepTokens: number;
  semanticFn?: (request: string, content: string) => number;
}

/**
 * 复杂请求的相关度回插（§3.4）：
 * 被摘要替换掉的旧片段里，五维得分高的若干条以**原文**插回摘要之后，
 * 使「保留什么」由相关度过滤后的 token 数决定，而不是原始窗口占用。
 * 仅在 `profile.promoteRelevant` 为真（复杂档）且有效窗口可知时启用。
 */
function promoteRelevantChunks(input: PromotionInput): {
  messages: CompactableMessage[];
  promoted: number;
} {
  const split = safeSplitIndex(
    input.original,
    tailStartIndex(input.original, input.tailProtectTokens),
  );
  if (split <= 0) return { messages: [...input.current], promoted: 0 };

  const older = input.original.slice(0, split);
  const chunks: ContextChunk[] = older.map((m, i) => ({
    chunkId: `old-${i}`,
    role: m.role,
    content: m.content,
    tokens: Math.ceil((m.content?.length ?? 0) / 4),
    timestamp: i,
  }));

  const weights =
    input.complexity === "simple"
      ? WEIGHT_PROFILES.simple
      : WEIGHT_PROFILES.complex;
  const partition = partitionByRelevance(input.request, chunks, {
    budgetTokens: input.budgetTokens,
    minKeepTokens: input.minKeepTokens,
    maxKeepRatio: input.maxKeepRatio,
    weights,
    activeSubtasks: input.activeSubtasks,
    ...(input.semanticFn ? { semanticFn: input.semanticFn } : {}),
  });
  if (partition.keepIds.length === 0)
    return { messages: [...input.current], promoted: 0 };

  const keepSet = new Set(partition.keepIds);
  // 按原始顺序回插（保持时间线可读），置于摘要/重锚等前导 system 之后
  const promotedMsgs = older
    .filter((_m, i) => keepSet.has(`old-${i}`))
    .map((m) => ({ ...m })) as CompactableMessage[];
  if (promotedMsgs.length === 0)
    return { messages: [...input.current], promoted: 0 };

  let insertAt = 0;
  while (
    insertAt < input.current.length &&
    input.current[insertAt]?.role === "system"
  ) {
    insertAt += 1;
  }
  const next = [...input.current];
  next.splice(insertAt, 0, ...promotedMsgs);
  return { messages: next, promoted: promotedMsgs.length };
}
