/**
 * @module Loop/contextCompression
 * @description
 * ⑤ 步懒监听——上下文压缩（FE-055 实装，替代“仅记录上下文规模，不主动干预”空壳）。
 *
 * 职责：
 * - 估算装配素材规模（chars/4 口径，与此前 ⑤ 步记录口径一致）；
 * - 超阈值（模型 context_window × ratio，缺省 0.5）时把历史**旧段**压缩为 LLM 摘要：
 *   保留尾部 `keepRecentMessages` 条原文，旧段替换为一条摘要 system 消息；
 * - 摘要后紧随一条 GoalReanchor 重锚消息（“压缩后必须重锚目标”，Docs/Agent/02 §4.4），
 *   并发布 `CONTEXT_COMPRESSED` 事件（此前该事件仅枚举定义、0 发布方）；
 * - fail-soft：未达阈值 / 摘要调用失败 / 空摘要一律保留原上下文（绝不阻断迭代）。
 *
 * 红线（ADR-0005）：本模块只处理对话历史，不触碰 goal 与 immutableConstraints。
 */

import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';

import { EventType } from '../../Services/EventBus/eventTypes.js';
import { createEvent, publish } from '../../Services/EventBus/eventBus.js';
import { resolveModel } from '../../Infra/Llm/Router/modelRouter.js';
import { callModel, type ChatMessage } from '../Model/modelCaller.js';

// ── 配置 ────────────────────────────────────────────────────────────

export interface ContextCompressionConfig {
  /** 总开关（缺省 true） */
  enabled: boolean;
  /** 显式触发阈值（tokens 估算）；未配置时按 contextWindowRatio × 有效窗口推导 */
  triggerTokens?: number;
  /** 触发比例（对有效窗口 = context_window - outputReserveTokens；对齐 loopConfig.json context.summaryTriggerUsageRatio，缺省 0.8） */
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
}

const DEFAULTS: ContextCompressionConfig = {
  enabled: true,
  contextWindowRatio: 0.8,
  outputReserveTokens: 4096,
  fallbackTriggerTokens: 32_000,
  keepRecentMessages: 6,
  minMessagesToCompress: 8,
  summaryMaxTokens: 800,
};

let _config: ContextCompressionConfig = { ...DEFAULTS };

// ── 摘要调用（可注入，缺省走统一模型调用入口）──────────────────────

export type ContextSummaryCaller = (
  model: string,
  messages: ChatMessage[],
  opts: { max_tokens: number; temperature: number },
) => Promise<Result<{ content: string }>>;

export interface ContextCompressionDeps {
  /** 摘要调用函数（测试注入；缺省走 Core/Model.callModel） */
  modelCaller?: ContextSummaryCaller;
}

let _deps: ContextCompressionDeps = {};

async function defaultSummaryCaller(
  model: string,
  messages: ChatMessage[],
  opts: { max_tokens: number; temperature: number },
): Promise<Result<{ content: string }>> {
  const result = await callModel(model, messages, opts);
  if (!result.ok) return err(result.error, result.severity);
  return ok({ content: result.value.content });
}

/** 注入压缩配置 / 依赖（main.ts 启动时从配置注入；缺省值即生产默认） */
export function configureContextCompression(
  partial: Partial<ContextCompressionConfig> = {},
  deps?: ContextCompressionDeps,
): void {
  _config = { ..._config, ...partial };
  if (deps) _deps = { ..._deps, ...deps };
}

/** 测试/诊断用：恢复默认配置 */
export function resetContextCompression(): void {
  _config = { ...DEFAULTS };
  _deps = {};
}

/** 当前配置快照（诊断用） */
export function getContextCompressionConfig(): ContextCompressionConfig {
  return { ..._config };
}

// ── 规模估算 ────────────────────────────────────────────────────────

/** 估算消息数组的 token 规模（chars/4 口径，与此前 ⑤ 步记录一致） */
export function estimateMessageTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + (m.content?.length ?? 0) / 4, 0);
}

/** 解析触发阈值：显式配置 > 有效窗口（context_window - 输出预留）× ratio > 兜底值 */
export function resolveTriggerTokens(loopModel: string): number {
  if (_config.triggerTokens !== undefined && _config.triggerTokens > 0) {
    return _config.triggerTokens;
  }
  const resolved = resolveModel(loopModel);
  if (resolved.ok && resolved.value.spec.context_window > 0) {
    const effectiveWindow = Math.max(
      resolved.value.spec.context_window - _config.outputReserveTokens,
      1,
    );
    return Math.floor(effectiveWindow * _config.contextWindowRatio);
  }
  return _config.fallbackTriggerTokens;
}

// ── 压缩执行 ────────────────────────────────────────────────────────

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
}

export interface CompressContextResult {
  compressed: boolean;
  /** 压缩后消息（未压缩时为原数组） */
  messages: ChatMessage[];
  tokensBefore: number;
  tokensAfter: number;
  /** 未压缩原因（诊断用；压缩成功时为 undefined） */
  reason?: string;
}

/** 摘要系统提示（保留目标相关事实与产物指针，丢弃过程噪声） */
const SUMMARY_SYSTEM_PROMPT = [
  '你是上下文压缩器。将给定对话历史压缩为简洁、忠实的事实摘要，供后续推理使用。',
  '保留：与任务目标相关的事实、已做出的决定、关键文件路径与产物、未完成的步骤与约束。',
  '丢弃：问候与寒暄、重复的尝试过程、冗长原始输出（用一句概括）。',
  '输出纯文本（不超过 400 字），不要使用 Markdown 标题。',
].join('\n');

/** 拼接历史的最大字符数（超出时保留最近部分，更早内容被头部截去） */
const MAX_HISTORY_CHARS = 12_000;

function formatForSummary(m: ChatMessage): string {
  return `[${m.role}] ${m.content}`;
}

/** 内容等价：装配素材与共享历史逐条同构（无钩子改写时成立 → 允许跨轮回写） */
export function sameMessageContent(a: ChatMessage[], b: ChatMessage[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((m, i) => {
    const other = b[i];
    return !!other && m.role === other.role && m.content === other.content;
  });
}

/**
 * 尝试压缩上下文（fail-soft）。
 *
 * 触发条件：enabled ∧ 消息数 ≥ minMessagesToCompress ∧ tokensBefore ≥ 触发阈值。
 * 压缩方式：旧段（全部 - 最近 keepRecentMessages 条）→ LLM 摘要；
 * 结果结构：[摘要 system, GoalReanchor system, ...保留段]。
 */
export async function maybeCompressContext(
  input: CompressContextInput,
): Promise<CompressContextResult> {
  const { messages } = input;
  const tokensBefore = estimateMessageTokens(messages);
  const noop = (reason: string): CompressContextResult => ({
    compressed: false,
    messages,
    tokensBefore,
    tokensAfter: tokensBefore,
    reason,
  });

  if (!_config.enabled) return noop('disabled');
  if (messages.length < _config.minMessagesToCompress) return noop('below-min-messages');

  const trigger = resolveTriggerTokens(input.loopModel);
  if (tokensBefore < trigger) return noop('below-threshold');

  const keep = Math.max(1, _config.keepRecentMessages);
  const older = messages.slice(0, messages.length - keep);
  const recent = messages.slice(messages.length - keep);
  if (older.length === 0) return noop('nothing-to-compress');

  // ── LLM 摘要（fail-soft：失败/空输出一律保留原上下文）──
  let summary: string;
  try {
    const historyText = older.map(formatForSummary).join('\n').slice(-MAX_HISTORY_CHARS);
    const caller = _deps.modelCaller ?? defaultSummaryCaller;
    const result = await caller(input.loopModel, [
      { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
      { role: 'user', content: historyText },
    ], { max_tokens: _config.summaryMaxTokens, temperature: 0 });
    if (!result.ok) return noop(`summarize-failed: ${result.error}`);
    summary = result.value.content.trim();
    if (!summary) return noop('empty-summary');
  } catch (e) {
    return noop(`summarize-error: ${e instanceof Error ? e.message : String(e)}`);
  }

  const summaryMsg: ChatMessage = {
    role: 'system',
    content: `[上下文压缩摘要]\n${summary}`,
  };
  // “压缩后必须重锚目标”（Docs/Agent/02 §4.4）——重锚消息紧随摘要之后
  const reanchorMsg: ChatMessage = {
    role: 'system',
    content: `[GoalReanchor] 上下文已压缩。当前目标：${input.goal}。请继续执行。`,
  };
  const compressedMessages = [summaryMsg, reanchorMsg, ...recent];
  const tokensAfter = estimateMessageTokens(compressedMessages);

  publish(createEvent({
    eventType: EventType.CONTEXT_COMPRESSED,
    source: 'runIteration/⑤LazySupervision',
    traceId: input.traceId,
    loopId: input.loopId,
    payload: {
      messagesBefore: messages.length,
      messagesAfter: compressedMessages.length,
      tokensBefore: Math.round(tokensBefore),
      tokensAfter: Math.round(tokensAfter),
      triggerTokens: trigger,
      model: input.loopModel,
      reanchorInjected: true,
    },
  }));

  return {
    compressed: true,
    messages: compressedMessages,
    tokensBefore,
    tokensAfter,
  };
}
