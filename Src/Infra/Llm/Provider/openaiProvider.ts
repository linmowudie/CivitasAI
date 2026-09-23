/**
 * OpenAI 兼容 Provider（Docs/02 §10）
 *
 * 支持所有 OpenAI Chat Completions 兼容的 API：
 * - OpenAI (api.openai.com)
 * - 华为云 MaaS Token Plan (api.modelarts-maas.com/plan/v2)
 * - 阿里云百炼 (dashscope.aliyuncs.com)
 * - 其他兼容实现
 */

import type { Result } from '../../types.js';
import { ok, err } from '../../types.js';

import { LlmProvider, ProviderError } from './providerBase.js';
import type {
  ProviderConfig, CallOptions, CallResult, StreamChunk,
} from './providerBase.js';

// ===== 类型定义 =====

/** OpenAI API 请求体 */
interface OpenAIRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  tools?: unknown[];
}

/** OpenAI API 响应体 */
interface OpenAIResponse {
  id: string;
  object: string;
  model: string;
  choices: Array<{
    index: number;
    message?: {
      role: string;
      content: string | null;
      reasoning_content?: string;
      tool_calls?: Array<{
        id: string;
        type: string;
        function: {
          name: string;
          arguments: string;
        };
      }>;
    };
    delta?: {
      content?: string;
      reasoning_content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// ===== OpenAI 兼容 Provider =====

export class OpenAIProvider extends LlmProvider {
  constructor(config: ProviderConfig) {
    super(config);
  }

  /**
   * 非流式调用
   */
  async chat(options: CallOptions): Promise<Result<CallResult>> {
    try {
      const apiKey = this.resolveApiKey();
      const url = `${this.config.base_url}/chat/completions`;

      const body: OpenAIRequest = {
        model: options.model,
        messages: options.messages.map(m => ({ role: m.role, content: m.content })),
        temperature: options.temperature,
        max_tokens: options.max_tokens,
        stream: false,
        tools: options.tools,
      };

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: options.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw this.classifyHttpError(response.status, errorBody);
      }

      const data = await response.json() as OpenAIResponse;
      const choice = data.choices[0];

      return ok({
        content: choice.message?.content ?? '',
        reasoning_content: choice.message?.reasoning_content,
        finish_reason: choice.finish_reason ?? 'stop',
        usage: data.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        model: data.model,
        tool_calls: choice.message?.tool_calls,
      });
    } catch (e) {
      if (e instanceof ProviderError) {
        return err(e.message, e.category === 'auth' ? 'FATAL' : 'ERROR');
      }
      if (e instanceof Error && e.name === 'AbortError') {
        return err('请求已取消', 'ERROR');
      }
      const message = e instanceof Error ? e.message : String(e);
      // 网络错误分类
      if (message.includes('ECONNRESET') || message.includes('ETIMEDOUT') ||
          message.includes('fetch failed') || message.includes('ENOTFOUND')) {
        return err(`网络错误: ${message}`, 'ERROR');
      }
      return err(`调用失败: ${message}`, 'ERROR');
    }
  }

  /**
   * 流式调用
   */
  async chatStream(
    options: CallOptions,
    onChunk: (chunk: StreamChunk) => void,
  ): Promise<Result<CallResult>> {
    try {
      const apiKey = this.resolveApiKey();
      const url = `${this.config.base_url}/chat/completions`;

      const body: OpenAIRequest = {
        model: options.model,
        messages: options.messages.map(m => ({ role: m.role, content: m.content })),
        temperature: options.temperature,
        max_tokens: options.max_tokens,
        stream: true,
        tools: options.tools,
      };

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: options.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw this.classifyHttpError(response.status, errorBody);
      }

      if (!response.body) {
        return err('响应体为空', 'ERROR');
      }

      // 解析 SSE 流
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let fullContent = '';
      let fullReasoning = '';
      let finishReason = 'stop';
      let usage: CallResult['usage'] = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
      let buffer = '';
      // 流式工具调用累积
      const toolCallMap = new Map<number, { id: string; type: string; name: string; arguments: string }>();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? ''; // 保留未完成的行

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === 'data: [DONE]') continue;
          if (!trimmed.startsWith('data: ')) continue;

          try {
            const json = JSON.parse(trimmed.slice(6)) as OpenAIResponse;
            const choice = json.choices[0];

            if (choice?.delta) {
              const delta = choice.delta.content ?? '';
              const reasoningDelta = choice.delta.reasoning_content;

              if (delta || reasoningDelta) {
                fullContent += delta;
                if (reasoningDelta) fullReasoning += reasoningDelta;

                onChunk({
                  delta,
                  reasoning_delta: reasoningDelta,
                  finish_reason: choice.finish_reason ?? undefined,
                });
              }

              // 累积流式工具调用
              if (choice.delta.tool_calls) {
                for (const tc of choice.delta.tool_calls) {
                  const idx = tc.index;
                  const existing = toolCallMap.get(idx);
                  if (existing) {
                    // 追加片段
                    if (tc.function?.name) existing.name += tc.function.name;
                    if (tc.function?.arguments) existing.arguments += tc.function.arguments;
                  } else {
                    // 新工具调用
                    toolCallMap.set(idx, {
                      id: tc.id ?? '',
                      type: tc.type ?? 'function',
                      name: tc.function?.name ?? '',
                      arguments: tc.function?.arguments ?? '',
                    });
                  }
                }
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

      // 构造 tool_calls
      const toolCalls = Array.from(toolCallMap.values()).map(tc => ({
        id: tc.id,
        type: tc.type,
        function: {
          name: tc.name,
          arguments: tc.arguments,
        },
      }));

      return ok({
        content: fullContent,
        reasoning_content: fullReasoning || undefined,
        finish_reason: finishReason,
        usage,
        model: options.model,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      });
    } catch (e) {
      if (e instanceof ProviderError) {
        return err(e.message, e.category === 'auth' ? 'FATAL' : 'ERROR');
      }
      if (e instanceof Error && e.name === 'AbortError') {
        return err('请求已取消', 'ERROR');
      }
      const message = e instanceof Error ? e.message : String(e);
      if (message.includes('ECONNRESET') || message.includes('ETIMEDOUT') ||
          message.includes('fetch failed') || message.includes('ENOTFOUND')) {
        return err(`网络错误: ${message}`, 'ERROR');
      }
      return err(`流式调用失败: ${message}`, 'ERROR');
    }
  }
}

/**
 * 创建 OpenAI 兼容 Provider 的工厂函数
 */
export function createOpenAIProvider(config: ProviderConfig): OpenAIProvider {
  return new OpenAIProvider(config);
}
