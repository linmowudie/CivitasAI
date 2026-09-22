/**
 * 核心模型调用器（Docs/02 §10）
 *
 * 职责：
 * - 统一的 LLM 调用入口
 * - 超时控制（总超时 60s / 首字节 10s / 包间隔 15s）
 * - 重试 + 降级（按错误分类矩阵）
 * - 唯一"模型可见"的通道
 */

import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';
import { resolveModel, getFallbackProviders, getRoutingConfig } from '../../Infra/Llm/Router/modelRouter.js';
import { LlmProvider, ProviderError } from '../../Infra/Llm/Provider/providerBase.js';
import type { CallOptions, CallResult, StreamChunk, ChatMessage } from '../../Infra/Llm/Provider/providerBase.js';
import { getRetryDecision, delay, classifyNetworkError } from '../../Infra/Llm/Provider/retryPolicy.js';

// ===== 类型导出 =====
export type { CallResult, StreamChunk, ChatMessage };

// ===== 公开 API =====

/**
 * 非流式调用（带重试和降级）
 */
export async function callModel(
  qualifiedModel: string,
  messages: ChatMessage[],
  options?: {
    temperature?: number;
    max_tokens?: number;
    signal?: AbortSignal;
    tools?: unknown[];
  },
): Promise<Result<CallResult>> {
  const resolved = resolveModel(qualifiedModel);
  if (!resolved.ok) return err(resolved.error, 'ERROR');

  const { provider, spec } = resolved.value;
  const routing = getRoutingConfig();

  const callOpts: CallOptions = {
    model: spec.id,
    messages,
    temperature: options?.temperature,
    max_tokens: options?.max_tokens,
    stream: false,
    signal: options?.signal,
    tools: options?.tools,
  };

  // 创建超时 AbortController
  const timeoutMs = routing?.timeoutMs ?? 60_000;
  const timeoutController = new AbortController();
  const timeoutTimer = setTimeout(() => timeoutController.abort(), timeoutMs);

  // 合并外部 signal
  const combinedSignal = options?.signal ?? timeoutController.signal;
  const finalOpts: CallOptions = { ...callOpts, signal: combinedSignal };

  try {
    // 首次尝试
    const result = await callWithRetry(provider, finalOpts);
    if (result.ok) return result;

    // 如果需要降级到备选 Provider
    const error = result.error;
    const category = categorizeError(error);
    const decision = getRetryDecision(category);

    if (decision.fallbackToNext) {
      const fallbacks = getFallbackProviders();
      const currentIdx = fallbacks.findIndex(p => p.name === provider.name);

      for (let i = currentIdx + 1; i < fallbacks.length; i++) {
        const fallbackProvider = fallbacks[i];
        if (!fallbackProvider.supportsModel(fallbackProvider.getModels()[0]?.id)) continue;

        const fallbackSpec = fallbackProvider.getModels()[0];
        const fallbackOpts: CallOptions = {
          ...finalOpts,
          model: fallbackSpec.id,
        };
        const fallbackResult = await callWithRetry(fallbackProvider, fallbackOpts);
        if (fallbackResult.ok) return fallbackResult;
      }
    }

    return result;
  } finally {
    clearTimeout(timeoutTimer);
  }
}

/**
 * 流式调用
 */
export async function callModelStream(
  qualifiedModel: string,
  messages: ChatMessage[],
  onChunk: (chunk: StreamChunk) => void,
  options?: {
    temperature?: number;
    max_tokens?: number;
    signal?: AbortSignal;
    tools?: unknown[];
  },
): Promise<Result<CallResult>> {
  const resolved = resolveModel(qualifiedModel);
  if (!resolved.ok) return err(resolved.error, 'ERROR');

  const { provider, spec } = resolved.value;

  const callOpts: CallOptions = {
    model: spec.id,
    messages,
    temperature: options?.temperature,
    max_tokens: options?.max_tokens,
    stream: true,
    signal: options?.signal,
    tools: options?.tools,
  };

  return provider.chatStream(callOpts, onChunk);
}

// ===== 内部函数 =====

/**
 * 带重试的调用
 */
async function callWithRetry(
  provider: LlmProvider,
  options: CallOptions,
): Promise<Result<CallResult>> {
  let lastError = '';
  let lastCategory: string = 'unknown';

  // 首次尝试
  const result = await provider.chat(options);
  if (result.ok) return result;

  lastError = result.error;
  lastCategory = categorizeError(result.error);
  const decision = getRetryDecision(lastCategory as any);

  if (!decision.shouldRetry) return result;

  // 重试
  for (let i = 0; i < decision.maxRetries; i++) {
    const backoffMs = decision.backoffMs[i] ?? 1000;
    await delay(backoffMs, options.signal);

    const retryResult = await provider.chat(options);
    if (retryResult.ok) return retryResult;

    lastError = retryResult.error;
  }

  return err(lastError, lastCategory === 'auth' ? 'FATAL' : 'ERROR');
}

/**
 * 从错误消息推断分类
 */
function categorizeError(errorMsg: string): string {
  if (errorMsg.includes('认证失败') || errorMsg.includes('401') || errorMsg.includes('403')) return 'auth';
  if (errorMsg.includes('速率限制') || errorMsg.includes('429')) return 'rate_limited';
  if (errorMsg.includes('服务不可用') || errorMsg.includes('503')) return 'unavailable';
  if (errorMsg.includes('服务器错误')) return 'server_error';
  if (errorMsg.includes('网络错误')) return 'network';
  if (errorMsg.includes('超时') || errorMsg.includes('Aborted')) return 'timeout';
  return 'unknown';
}
