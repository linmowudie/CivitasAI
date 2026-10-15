/**
 * @module Loop/compactionPolicy
 * @description
 * 压缩策略的**纯决策层**（《一些思考3》§1 水位线 / §2 成本模型 / §3 难度分级）。
 *
 * 职责边界（对齐 §3.1「难度模块不应单独决定触发」）：
 *  - 本模块只做**判定**，不碰上下文、不发事件、不调模型；
 *  - 输入 = 窗口占用 + 剩余空间 + 预期增长 + 缓存成本 + 难度档；
 *  - 输出 = `CompactionDecision`（层级 + 原因 + 生效水位），交由
 *    `Core/Loop/contextCompression.ts` 选策略机执行。
 *
 * ⚠️ 口径校准（源文档自相矛盾，本实现取叙述口径）：
 *  《一些思考3》§3.3 表格给「简单 0.80 / 中等 0.60 / 复杂 0.40」，
 *  但 §3.4 与 §6 两处叙述均为「简单请求阈值**更低**（50%-60% 就动手）、
 *  复杂请求阈值**更高**（75%-85% 才动手）」。表格与叙述方向相反，
 *  本实现按**出现两次的叙述口径**取值（simple 0.55 / medium 0.70 / complex 0.82），
 *  与「简单问答优先压缩、复杂请求优先保留」的语义一致。
 */

import type {
  CacheSensitivity,
  ComplexityClass,
  CompactionDecision,
  CompactionLayer,
  CompactionProfile,
  CompactionSignals,
  CompactionWatermarks,
} from "../../Infra/Contracts/compactionTypes.js";

// ── 配置 ────────────────────────────────────────────────────────────

/** 策略机决策层的可配置项（由 `context.compaction` 配置段注入） */
export interface CompactionPolicyConfig {
  /** 总开关（缺省 true） */
  enabled: boolean;
  /** 四档水位线（§1.1） */
  watermarks: CompactionWatermarks;
  /** 剩余空间下限（tokens）：低于它提前触发（§1.2，建议 16k-20k） */
  minHeadroomTokens: number;
  /** 最小节省比：低于它视为空转，不计入有效压缩（§1.3，缺省 10%） */
  minSavedRatio: number;
  /** 尾部原文保护下限（tokens）；与 profile 比例取大 */
  tailProtectFloorTokens: number;
  /** 单条工具结果裁剪上限（tokens） */
  toolOutputTokenLimit: number;
  /** 缓存感知：只动尾部、前缀不动（§2.3） */
  cacheAware: boolean;
  /** 连续「低收益压缩」多少次后暂停自动压缩（§1.3，缺省 2） */
  maxConsecutiveLowGain: number;
  /** 难度档 → 压缩参数（§3.3 参数维度，取值按 §3.4/§6 叙述） */
  profiles: Record<ComplexityClass, CompactionProfile>;
  /** 成本模型系数（§2） */
  cost: {
    /** re-prefill / cache-read 成本倍率（论文口径约 50×） */
    cachePrefillToLoadRatio: number;
    /** 一次摘要 LLM 调用折算的 token 当量 */
    summaryCallTokens: number;
    /** 一次上下文溢出失败的折算代价 */
    overflowFailureTokens: number;
  };
}

export const DEFAULT_COMPACTION_POLICY: CompactionPolicyConfig = {
  enabled: true,
  watermarks: { light: 0.65, main: 0.8, high: 0.9, overflow: 0.95 },
  minHeadroomTokens: 18_000,
  minSavedRatio: 0.1,
  tailProtectFloorTokens: 0,
  toolOutputTokenLimit: 8_000,
  cacheAware: true,
  maxConsecutiveLowGain: 2,
  profiles: {
    simple: {
      triggerRatio: 0.55,
      tailProtect: 0.15,
      cacheSensitivity: "low",
      promoteRelevant: false,
    },
    medium: {
      triggerRatio: 0.7,
      tailProtect: 0.2,
      cacheSensitivity: "medium",
      promoteRelevant: false,
    },
    complex: {
      triggerRatio: 0.82,
      tailProtect: 0.3,
      cacheSensitivity: "high",
      promoteRelevant: true,
    },
  },
  cost: {
    cachePrefillToLoadRatio: 50,
    summaryCallTokens: 2_000,
    overflowFailureTokens: 20_000,
  },
};

/** 深合并注入的策略配置（只覆盖显式给出的键） */
export function mergeCompactionPolicy(
  base: CompactionPolicyConfig,
  partial: Partial<CompactionPolicyConfig> = {},
): CompactionPolicyConfig {
  return {
    ...base,
    ...partial,
    watermarks: { ...base.watermarks, ...(partial.watermarks ?? {}) },
    profiles: {
      simple: { ...base.profiles.simple, ...(partial.profiles?.simple ?? {}) },
      medium: { ...base.profiles.medium, ...(partial.profiles?.medium ?? {}) },
      complex: {
        ...base.profiles.complex,
        ...(partial.profiles?.complex ?? {}),
      },
    },
    cost: { ...base.cost, ...(partial.cost ?? {}) },
  };
}

// ── 难度档（§3：旁路输入）──────────────────────────────────────────

/** 难度评估的旁路信号（由调用方提供；缺省全 0） */
export interface ComplexityHints {
  messageCount?: number;
  toolCallCount?: number;
  constraintKeywordCount?: number;
  subtaskCount?: number;
}

/** 约束类关键词（出现次数用于难度加分） */
const CONSTRAINT_RE =
  /必须|不得|禁止|约束|要求|只能|仅限于|\bmust\b|\bshall\b|\bconstraint\b/gi;

/**
 * 请求难度启发式分档（确定性、零模型调用）。
 *
 * 定位是**旁路**：结果只影响压缩预算 / 触发水位 / 保护窗口，
 * 不单独决定是否触发（触发仍由 `decideCompaction` 综合判定）。
 */
export function classifyRequestComplexity(
  request: string,
  hints: ComplexityHints = {},
): ComplexityClass {
  let score = 0;

  const len = request.trim().length;
  if (len > 400) score += 2;
  else if (len > 150) score += 1;

  const messageCount = hints.messageCount ?? 0;
  if (messageCount >= 20) score += 2;
  else if (messageCount >= 8) score += 1;

  const toolCallCount = hints.toolCallCount ?? 0;
  if (toolCallCount >= 4) score += 2;
  else if (toolCallCount >= 1) score += 1;

  const constraintCount =
    hints.constraintKeywordCount ?? request.match(CONSTRAINT_RE)?.length ?? 0;
  if (constraintCount >= 2) score += 1;

  const subtaskCount = hints.subtaskCount ?? 0;
  if (subtaskCount >= 3) score += 2;
  else if (subtaskCount >= 1) score += 1;

  if (score >= 4) return "complex";
  if (score >= 2) return "medium";
  return "simple";
}

/** 取难度档对应参数 */
export function resolveProfile(
  config: CompactionPolicyConfig,
  complexity: ComplexityClass,
): CompactionProfile {
  return config.profiles[complexity];
}

/** 解析尾部保护 tokens：`profile.tailProtect × 有效窗口` 与下限取大 */
export function resolveTailProtectTokens(
  profile: CompactionProfile,
  effectiveWindow: number,
  floorTokens: number,
): number {
  const byRatio =
    effectiveWindow > 0 ? Math.floor(effectiveWindow * profile.tailProtect) : 0;
  return Math.max(byRatio, floorTokens, 0);
}

// ── 触发决策（§1.1 / §1.2 / §1.5 / §1.7）──────────────────────────

/**
 * 多级触发判定（纯函数）。
 *
 * 判定顺序刻意如此（越靠前越紧急）：
 *  Manual → Overflow → High 水位 → 难度档水位 → 剩余空间不足 → 预期增长越界
 *  → 工具结果膨胀 → Light 水位（只做免费裁剪）→ 子任务边界（只做免费裁剪）
 */
export function decideCompaction(
  config: CompactionPolicyConfig,
  signals: CompactionSignals,
): CompactionDecision {
  const profile = resolveProfile(config, signals.complexity);
  const triggerRatio = profile.triggerRatio;
  const base = { compact: true, triggerRatio };

  if (!config.enabled) {
    return { compact: false, layer: "none", reason: "disabled", triggerRatio };
  }
  if (signals.manualRequested) {
    return { ...base, layer: "manual", reason: "manual-request" };
  }
  if (signals.usageRatio >= config.watermarks.overflow) {
    return { ...base, layer: "emergency", reason: "overflow-band" };
  }
  if (signals.usageRatio >= config.watermarks.high) {
    return { ...base, layer: "auto", reason: "high-band" };
  }
  if (signals.usageRatio >= triggerRatio) {
    return {
      ...base,
      layer: "auto",
      reason: `profile-threshold(${signals.complexity})`,
    };
  }
  if (signals.remainingTokens < config.minHeadroomTokens) {
    return { ...base, layer: "auto", reason: "low-headroom" };
  }
  if (signals.expectedNextGrowthTokens > signals.remainingTokens) {
    return {
      ...base,
      layer: "auto",
      reason: "expected-growth-exceeds-headroom",
    };
  }
  if (signals.toolOutputTokens > config.toolOutputTokenLimit) {
    return { ...base, layer: "auto", reason: "tool-output-bloat" };
  }
  if (signals.usageRatio >= config.watermarks.light) {
    return { ...base, layer: "micro", reason: "light-band" };
  }
  if (signals.subtaskEnded) {
    return { ...base, layer: "micro", reason: "subtask-boundary" };
  }
  return {
    compact: false,
    layer: "none",
    reason: "below-watermark",
    triggerRatio,
  };
}

// ── 成本模型（§2.4）─────────────────────────────────────────────────

export interface CompactionCostInput {
  /** 下一轮预期增量（tokens） */
  expectedNextGrowthTokens: number;
  /** 前缀缓存命中率 [0,1] */
  prefixHitRate: number;
  /** 本次压缩导致失效的缓存 token 数（只动尾部时接近 0） */
  cacheInvalidatedTokens: number;
  /** 溢出概率 [0,1] */
  overflowProbability: number;
}

export interface CompactionCost {
  /** 压缩成本（prefill-token 当量） */
  costCompact: number;
  /** 不压缩的期望成本（prefill-token 当量） */
  costNoCompact: number;
  /** 是否「现在动手更便宜」 */
  shouldCompact: boolean;
  /** 实际计入的缓存失效代价 */
  deltaCache: number;
}

/**
 * 精确触发判断（§2.4）：
 * ```
 * Cost_compact = Cost_summary + Delta_cache × c_prefill
 * Cost_no_compact = Delta × (p_hit × c_load + (1-p_hit) × c_prefill) + P_overflow × c_failure
 * 触发 ⟺ Cost_compact < Cost_no_compact
 * ```
 * 以 `c_prefill = 1`、`c_load = 1 / cachePrefillToLoadRatio` 归一化。
 */
export function estimateCompactionCost(
  config: CompactionPolicyConfig,
  input: CompactionCostInput,
): CompactionCost {
  const cPrefill = 1;
  const cLoad = 1 / Math.max(1, config.cost.cachePrefillToLoadRatio);
  const pHit = Math.min(1, Math.max(0, input.prefixHitRate));
  const pOverflow = Math.min(1, Math.max(0, input.overflowProbability));

  // 未开缓存感知 → 视为整段前缀失效（代价按 prefill 倍率放大）
  const deltaCache = config.cacheAware
    ? Math.max(0, input.cacheInvalidatedTokens)
    : input.expectedNextGrowthTokens * config.cost.cachePrefillToLoadRatio;

  const costCompact = config.cost.summaryCallTokens + deltaCache * cPrefill;
  const costNoCompact =
    input.expectedNextGrowthTokens * (pHit * cLoad + (1 - pHit) * cPrefill) +
    pOverflow * config.cost.overflowFailureTokens;

  return {
    costCompact,
    costNoCompact,
    shouldCompact: costCompact < costNoCompact,
    deltaCache,
  };
}

// ── 收益门槛（§1.3）────────────────────────────────────────────────

/** 压缩节省比 = 1 - after/before（before <= 0 时视为 0） */
export function compactionGainRatio(
  tokensBefore: number,
  tokensAfter: number,
): number {
  if (tokensBefore <= 0) return 0;
  return 1 - tokensAfter / tokensBefore;
}

/** 收益是否达到门槛（§1.3：低于 10% 视为空转） */
export function meetsGainGate(
  config: CompactionPolicyConfig,
  tokensBefore: number,
  tokensAfter: number,
): boolean {
  return compactionGainRatio(tokensBefore, tokensAfter) >= config.minSavedRatio;
}

/**
 * 连续低收益计数器（§1.3：「连续两次压缩节省不足 10% 就不应继续自动压缩」）。
 * 由编排入口持有实例；本类无外部 IO，便于单测。
 */
export class LowGainTracker {
  private consecutive = 0;

  constructor(private readonly maxConsecutive: number) {}

  /** 记录一次压缩收益 */
  record(
    tokensBefore: number,
    tokensAfter: number,
    minSavedRatio: number,
  ): void {
    const gain = compactionGainRatio(tokensBefore, tokensAfter);
    if (gain < minSavedRatio) this.consecutive += 1;
    else this.consecutive = 0;
  }

  /** 是否应暂停自动压缩 */
  shouldSuppress(): boolean {
    return this.maxConsecutive > 0 && this.consecutive >= this.maxConsecutive;
  }

  /** 连续低收益次数（诊断 / 指标） */
  get count(): number {
    return this.consecutive;
  }

  reset(): void {
    this.consecutive = 0;
  }
}

// ── 缓存敏感度 → 可失效范围（§2.3）────────────────────────────────

/** 难度档的缓存敏感度（供编排入口决定可失效的 token 上限） */
export function resolveCacheSensitivity(
  config: CompactionPolicyConfig,
  complexity: ComplexityClass,
): CacheSensitivity {
  return resolveProfile(config, complexity).cacheSensitivity;
}

/**
 * 本次压缩允许失效的缓存 tokens 上限估算。
 * high 敏感度 → 只允许动尾部，可失效量压到最小（§2.3/§2.6-2）。
 */
export function estimateCacheInvalidation(
  sensitivity: CacheSensitivity,
  effectiveWindow: number,
  tailProtectTokens: number,
): number {
  const movable = Math.max(0, effectiveWindow - tailProtectTokens);
  switch (sensitivity) {
    case "high":
      return Math.floor(movable * 0.1);
    case "medium":
      return Math.floor(movable * 0.35);
    case "low":
      return Math.floor(movable * 0.8);
    default:
      return movable;
  }
}

/** 层级 → 中文标签（事件载荷 / 日志用） */
export const LAYER_LABELS: Record<CompactionLayer, string> = {
  none: "未触发",
  micro: "规则裁剪",
  auto: "自动摘要",
  emergency: "紧急恢复",
  manual: "主动压缩",
};
