/**
 * 核心模型调用器（Docs/Agent/02 §10）
 *
 * 职责：
 * - 统一的 LLM 调用入口
 * - 超时控制（**分档墙钟**：交互非流式 60s / 内部一次性长调用 180s / 首字节 10s / 包间隔 15s）
 * - 重试 + 降级（按错误分类矩阵）
 * - 唯一"模型可见"的通道
 *
 * 分档的理由（REV-326）：`timeoutMs` 此前是**唯一**挂着的墙钟，而它只作用于非流式路径，
 * 于是"L3 Judge 写整段评审意见""上下文压缩写整篇摘要"这类必然长跑的一次性调用，
 * 与 Loop 里一次普通回合共用 60s——超时的后果在 Judge 侧是"判不了"、在压缩侧是"静默降级"。
 */

import type { Result } from "../../Infra/types.js";
import { err } from "../../Infra/types.js";
import {
  resolveModel,
  getFallbackProviders,
  getRoutingConfig,
} from "../../Infra/Llm/Router/modelRouter.js";
import { LlmProvider } from "../../Infra/Llm/Provider/providerBase.js";
import type {
  CallOptions,
  CallResult,
  StreamChunk,
  ChatMessage,
  ErrorCategory,
} from "../../Infra/Llm/Provider/providerBase.js";
import {
  getRetryDecision,
  delay,
} from "../../Infra/Llm/Provider/retryPolicy.js";
import {
  lookupCache,
  registerCacheEntry,
  hashPromptPrefix,
} from "../../Services/Cache/promptCache.js";

// ===== 类型导出 =====
export type { CallResult, StreamChunk, ChatMessage };

/**
 * 内部一次性长调用的缺省墙钟（`routing.internalTimeoutMs` 未配置时生效）。
 *
 * 180s 而非 120s：该墙钟覆盖 `callWithRetry` 的**整个**重试序列，60s 档下重试形同虚设
 * （一次超时即耗尽预算），放宽到 180s 才能容纳"一次慢回答 + 一次重试"。
 */
export const INTERNAL_TIMEOUT_MS = 180_000;

/**
 * 非流式调用的用途档（决定读哪一档墙钟）。
 * - `default`：Loop 内一次模型回合（读 `routing.timeoutMs`）；
 * - `internal`：一次性长成果调用（L3 Judge / 上下文压缩 / 摘要，读 `internalTimeoutMs`）。
 */
export type ModelCallPurpose = "default" | "internal";

// ===== 公开 API =====

/**
 * FE-064：登记/查询系统前缀复用（观测口径）。
 *
 * 语义：同一 system 前缀的**第二次调用**判定为前缀复用命中；
 * 首次调用登记前缀 hash 与 prompt_tokens（用于估算可缓存 token 规模）。
 * 全链 fail-soft——观测不影响模型调用主链路。
 */
function trackPromptPrefix(
  messages: ChatMessage[],
  promptTokens: number,
): void {
  try {
    const system = messages.find((m) => m.role === "system");
    if (!system?.content) return;
    const hash = hashPromptPrefix(system.content);
    const hit = lookupCache(hash);
    if (!hit && promptTokens > 0) {
      registerCacheEntry(hash, promptTokens);
    }
  } catch {
    /* 观测失败不阻断 */
  }
}

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
    purpose?: ModelCallPurpose;
  },
): Promise<Result<CallResult>> {
  const resolved = resolveModel(qualifiedModel);
  if (!resolved.ok) return err(resolved.error, "ERROR");

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

  // 创建超时 AbortController（REV-326：按用途分档，内部一次性长调用不再被交互档 60s 掐断）
  const timeoutMs =
    options?.purpose === "internal"
      ? (routing?.internalTimeoutMs ?? INTERNAL_TIMEOUT_MS)
      : (routing?.timeoutMs ?? 60_000);
  const timeoutController = new AbortController();
  const timeoutTimer = setTimeout(() => timeoutController.abort(), timeoutMs);

  // ── P2-15 修复（控制论审查）：外部 signal 与**墙钟同时生效**（任一触发即中止）──
  // 修复前是 `options?.signal ?? timeoutController.signal`：传了外部 signal，
  // 本函数就**完全不再挂墙钟**（注释自认 REV-025 未收口），而交互路径恰好总传
  // `abortController.signal` → 单次模型调用在真实链路上没有任何超时保护。
  const combinedController = new AbortController();
  const forwardAbort = () => combinedController.abort();
  if (options?.signal) {
    if (options.signal.aborted) combinedController.abort();
    else options.signal.addEventListener("abort", forwardAbort, { once: true });
  }
  timeoutController.signal.addEventListener("abort", forwardAbort, {
    once: true,
  });
  const combinedSignal = combinedController.signal;
  const finalOpts: CallOptions = { ...callOpts, signal: combinedSignal };

  try {
    // 首次尝试
    const result = await callWithRetry(provider, finalOpts);
    if (result.ok) {
      trackPromptPrefix(finalOpts.messages, result.value.usage.prompt_tokens);
      return result;
    }

    // 如果需要降级到备选 Provider
    const error = result.error;
    const category = categorizeError(error);
    const decision = getRetryDecision(category);

    if (decision.fallbackToNext) {
      const fallbacks = getFallbackProviders();
      const currentIdx = fallbacks.findIndex((p) => p.name === provider.name);

      for (let i = currentIdx + 1; i < fallbacks.length; i++) {
        const fallbackProvider = fallbacks[i];
        if (!fallbackProvider) continue;

        const fallbackSpec = fallbackProvider.getModels()[0];
        if (!fallbackSpec || !fallbackProvider.supportsModel(fallbackSpec.id))
          continue;

        const fallbackOpts: CallOptions = {
          ...finalOpts,
          model: fallbackSpec.id,
        };
        const fallbackResult = await callWithRetry(
          fallbackProvider,
          fallbackOpts,
        );
        if (fallbackResult.ok) return fallbackResult;
      }
    }

    return result;
  } finally {
    clearTimeout(timeoutTimer);
    // P2-15：及时摘掉转发监听，避免长会话里外部 signal 上堆积监听器
    options?.signal?.removeEventListener("abort", forwardAbort);
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
  if (!resolved.ok) return err(resolved.error, "ERROR");

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

  return provider.chatStream(callOpts, onChunk).then((outcome) => {
    if (outcome.ok) {
      trackPromptPrefix(callOpts.messages, outcome.value.usage.prompt_tokens);
    }
    return outcome;
  });
}

// ===== 内部函数 =====

/**
 * 带重试的调用
 */
async function callWithRetry(
  provider: LlmProvider,
  options: CallOptions,
): Promise<Result<CallResult>> {
  let lastError = "";
  let lastCategory: string = "unknown";

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

  return err(lastError, lastCategory === "auth" ? "FATAL" : "ERROR");
}

/**
 * 从错误消息推断分类
 */
function categorizeError(errorMsg: string): ErrorCategory {
  if (
    errorMsg.includes("认证失败") ||
    errorMsg.includes("401") ||
    errorMsg.includes("403")
  )
    return "auth";
  if (errorMsg.includes("速率限制") || errorMsg.includes("429"))
    return "rate_limited";
  if (errorMsg.includes("服务不可用") || errorMsg.includes("503"))
    return "unavailable";
  if (errorMsg.includes("服务器错误")) return "server_error";
  if (errorMsg.includes("网络错误")) return "network";
  if (errorMsg.includes("超时") || errorMsg.includes("Aborted"))
    return "timeout";
  return "unknown";
}
