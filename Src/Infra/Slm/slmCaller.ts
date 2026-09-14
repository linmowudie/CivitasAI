/**
 * 轻量 SLM 调用器（Docs/02 §14 ⑫）
 *
 * 职责：
 * - 轻量任务调用：分类 / 抽取 / 去噪
 * - 非流式、短超时、低成本
 * - 复用 LLM Provider 通道，但独立超时配置
 *
 * SLM（Small Language Model）用于对延迟敏感但质量要求不高的内部控制任务。
 */

import type { Result } from '../types.js';
import { ok, err } from '../types.js';
import { resolveModel } from '../Llm/Router/modelRouter.js';
import type { ChatMessage, CallResult } from '../Llm/Provider/providerBase.js';

// ===== 类型定义 =====

/** SLM 调用选项 */
export interface SlmCallOptions {
  /** 模型全限定名（provider/model） */
  readonly model: string;
  /** 消息列表 */
  readonly messages: ChatMessage[];
  /** 温度，默认 0（分类/抽取需确定性） */
  readonly temperature?: number;
  /** 最大输出 token，默认 256 */
  readonly max_tokens?: number;
  /** 超时 ms，默认 15_000 */
  readonly timeoutMs?: number;
}

/** SLM 调用结果 */
export interface SlmCallResult {
  readonly content: string;
  readonly usage: CallResult['usage'];
  readonly model: string;
}

// ===== 默认值 =====

const DEFAULT_SLM_TEMPERATURE = 0;
const DEFAULT_SLM_MAX_TOKENS = 256;
const DEFAULT_SLM_TIMEOUT_MS = 15_000;

// ===== 公开 API =====

/**
 * 轻量 SLM 调用
 *
 * 与 callModel 的区别：
 * - 无重试（轻量任务失败直接返回）
 * - 无降级（不消耗备选 Provider 额度）
 * - 短超时（15s 默认）
 * - 非流式
 */
export async function callSlm(options: SlmCallOptions): Promise<Result<SlmCallResult>> {
  const resolved = resolveModel(options.model);
  if (!resolved.ok) return err(resolved.error, 'ERROR');

  const { provider, spec } = resolved.value;
  const timeoutMs = options.timeoutMs ?? DEFAULT_SLM_TIMEOUT_MS;

  // 创建超时控制
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const result = await provider.chat({
      model: spec.id,
      messages: options.messages,
      temperature: options.temperature ?? DEFAULT_SLM_TEMPERATURE,
      max_tokens: options.max_tokens ?? DEFAULT_SLM_MAX_TOKENS,
      stream: false,
      signal: controller.signal,
    });

    if (!result.ok) return err(result.error, result.severity);

    return ok({
      content: result.value.content,
      usage: result.value.usage,
      model: result.value.model,
    });
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      return err(`SLM 调用超时 (${timeoutMs}ms)`, 'ERROR');
    }
    const message = e instanceof Error ? e.message : String(e);
    return err(`SLM 调用失败: ${message}`, 'ERROR');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 批量 SLM 调用（串行，避免并发限流）
 */
export async function callSlmBatch(
  calls: SlmCallOptions[],
): Promise<Array<Result<SlmCallResult>>> {
  const results: Array<Result<SlmCallResult>> = [];
  for (const call of calls) {
    results.push(await callSlm(call));
  }
  return results;
}
