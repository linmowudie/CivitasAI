/**
 * 流式 SSE 解析器（Docs/02 §10.1 / §10.3）
 *
 * 职责：
 * - 从 ReadableStream 解析 SSE data: 行
 * - 首字节超时控制（默认 10s）
 * - 相邻包间隔超时控制（默认 15s）
 * - 支持中途 Abort
 *
 * 从 openaiProvider.ts 的流式逻辑抽象而来，供 modelCaller 层统一管控超时。
 */

import type { StreamChunk, CallResult } from '../../Infra/Llm/Provider/providerBase.js';

// ===== 类型定义 =====

/** 流式解析器配置 */
export interface StreamParserConfig {
  /** 首字节超时（ms），默认 10_000 */
  readonly firstByteTimeoutMs: number;
  /** 相邻包间隔超时（ms），默认 15_000 */
  readonly interChunkTimeoutMs: number;
  /** 外部中止信号 */
  readonly signal?: AbortSignal;
}

/** 解析结果 */
export interface StreamParseResult {
  readonly content: string;
  readonly reasoning_content?: string;
  readonly finish_reason: string;
  readonly usage: CallResult['usage'];
}

/** SSE 行解析回调 */
export type ChunkHandler = (chunk: StreamChunk) => void;

// ===== 默认值 =====

const DEFAULT_FIRST_BYTE_TIMEOUT = 10_000;
const DEFAULT_INTER_CHUNK_TIMEOUT = 15_000;

// ===== 公开 API =====

/**
 * 从 ReadableStream 解析 SSE 流，带超时控制
 *
 * 超时策略（Docs/02 §10.1）：
 * - 首字节：从开始读取到第一个有效 data 行，超过 firstByteTimeoutMs 则中止
 * - 包间隔：两个相邻 data 行之间，超过 interChunkTimeoutMs 则中止
 */
export async function parseSseStream(
  body: ReadableStream<Uint8Array>,
  onChunk: ChunkHandler,
  config: StreamParserConfig,
): Promise<StreamParseResult> {
  const firstByteTimeout = config.firstByteTimeoutMs ?? DEFAULT_FIRST_BYTE_TIMEOUT;
  const interChunkTimeout = config.interChunkTimeoutMs ?? DEFAULT_INTER_CHUNK_TIMEOUT;

  const reader = body.getReader();
  const decoder = new TextDecoder();

  let fullContent = '';
  let fullReasoning = '';
  let finishReason = 'stop';
  let usage: CallResult['usage'] = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let buffer = '';
  let receivedFirstByte = false;

  // 超时控制器
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let timeoutRejected = false;

  const clearCurrentTimeout = () => {
    if (timeoutHandle !== null) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
  };

  const startTimeout = (ms: number, _label: string) => {
    clearCurrentTimeout();
    timeoutHandle = setTimeout(() => {
      timeoutRejected = true;
      reader.cancel().catch(() => {});
    }, ms);
  };

  // 外部中止监听
  const abortHandler = () => {
    timeoutRejected = true;
    reader.cancel().catch(() => {});
  };
  if (config.signal?.aborted) {
    // 已经中止，立即生效
    timeoutRejected = true;
    reader.cancel().catch(() => {});
  } else {
    config.signal?.addEventListener('abort', abortHandler, { once: true });
  }

  // 首字节超时
  startTimeout(firstByteTimeout, 'firstByte');

  // 前置检查：如果已中止，直接抛出
  if (timeoutRejected) {
    clearCurrentTimeout();
    config.signal?.removeEventListener('abort', abortHandler);
    throw new StreamTimeoutError(config.signal?.aborted ? '请求已中止' : `流式首字节超时 (${firstByteTimeout}ms)`);
  }

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (timeoutRejected) {
        if (config.signal?.aborted) {
          throw new StreamTimeoutError('请求已中止');
        }
        if (!receivedFirstByte) {
          throw new StreamTimeoutError(`流式首字节超时 (${firstByteTimeout}ms)`);
        }
        throw new StreamTimeoutError(`流式相邻包间隔超时 (${interChunkTimeout}ms)`);
      }

      if (done) break;

      // 标记首字节到达
      if (!receivedFirstByte) {
        receivedFirstByte = true;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]') continue;
        if (!trimmed.startsWith('data: ')) continue;

        // 收到有效数据，重置为包间隔超时
        startTimeout(interChunkTimeout, 'interChunk');

        try {
          const json = JSON.parse(trimmed.slice(6)) as SseResponseData;
          const choice = json.choices?.[0];

          if (choice?.delta) {
            const delta = choice.delta.content ?? '';
            const reasoningDelta = choice.delta.reasoning_content;

            if (delta || reasoningDelta) {
              fullContent += delta;
              if (reasoningDelta) fullReasoning += reasoningDelta;

              const chunk: StreamChunk = {
                delta,
                reasoning_delta: reasoningDelta,
                finish_reason: choice.finish_reason ?? undefined,
              };
              onChunk(chunk);
            }
          }

          if (choice?.finish_reason) {
            finishReason = choice.finish_reason;
          }
          if (json.usage) {
            usage = json.usage;
          }
        } catch {
          // 跳过解析失败的行
        }
      }
    }
  } finally {
    clearCurrentTimeout();
    config.signal?.removeEventListener('abort', abortHandler);
  }

  return {
    content: fullContent,
    reasoning_content: fullReasoning || undefined,
    finish_reason: finishReason,
    usage,
  };
}

// ===== 内部类型 =====

/** SSE 响应数据（OpenAI 兼容格式） */
interface SseResponseData {
  choices?: Array<{
    delta?: {
      content?: string;
      reasoning_content?: string;
    };
    finish_reason?: string | null;
  }>;
  usage?: CallResult['usage'];
}

// ===== 错误类型 =====

export class StreamTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StreamTimeoutError';
  }
}
