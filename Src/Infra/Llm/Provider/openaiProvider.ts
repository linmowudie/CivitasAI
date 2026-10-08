/**
 * OpenAI 兼容 Provider（Docs/Agent/02 §10）
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
        model: this.resolveRequestModel(options.model),
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
      if (!choice) {
        throw this.classifyHttpError(502, 'empty choices in response');
      }

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
        model: this.resolveRequestModel(options.model),
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
            const json = JSON.parse(trimmed.slice(6)) as OpenAIResponse & {
              error?: { message?: string; code?: string; type?: string };
              code?: string;
              message?: string;
            };

            /*
             * 供应商错误帧（2026-10-07 修复）。
             *
             * 实测现象：会话里出现"空回复"——事件链是
             * `agent:iteration_complete { outputText: "" }` + `agent:stream_end { tokensUsed: 0 }`，
             * 既没有错误事件也没有正文，用户只看到一个空气泡。
             *
             * 根因：部分供应商（DashScope 兼容模式等）在 **HTTP 200 的流内**返回错误帧，例如
             * `data: {"error":{"message":"Incorrect API key provided.","code":"invalid_api_key"}}`。
             * 旧实现直接取 `json.choices[0]`，于是抛 TypeError 被下面 `catch {}` **静默吞掉**，
             * 循环结束返回 `ok({content:''})` → 空回复被当成成功。
             *
             * 现在显式识别并抛出，交由上层归类（鉴权/服务端）并把原话带给用户。
             */
            const errCode = json.error?.code ?? json.error?.type ?? json.code;
            const errMessage = json.error?.message ?? json.message;
            if (errCode || (errMessage && !json.choices)) {
              const detail = `${errMessage ?? ''}${errCode ? `（${errCode}）` : ''}` || JSON.stringify(json).slice(0, 300);
              const looksAuth = /api[_-]?key|unauthor|forbidden|401|403|auth/i.test(`${errCode ?? ''} ${errMessage ?? ''}`);
              throw this.classifyHttpError(looksAuth ? 401 : 502, detail);
            }

            const choice = json.choices[0];

            if (choice?.delta) {
              const delta = choice.delta.content ?? '';
              const reasoningDelta = choice.delta.reasoning_content;
              const rawToolCalls = choice.delta.tool_calls;

              // 工具调用**增量**透传（修复：此前只累积不上报，导致模型生成工具参数期间界面无反馈）
              const toolCallDelta = rawToolCalls?.length
                ? rawToolCalls.map((tc) => {
                    const d: {
                      index: number; id?: string; name?: string; argumentsDelta?: string;
                    } = { index: tc.index };
                    if (tc.id) d.id = tc.id;
                    if (tc.function?.name) d.name = tc.function.name;
                    if (tc.function?.arguments) d.argumentsDelta = tc.function.arguments;
                    return d;
                  })
                : undefined;

              // 纯工具调用增量也要上报（此时 delta/reasoning 均为空）
              if (delta || reasoningDelta || toolCallDelta) {
                fullContent += delta;
                if (reasoningDelta) fullReasoning += reasoningDelta;

                onChunk({
                  delta,
                  reasoning_delta: reasoningDelta,
                  finish_reason: choice.finish_reason ?? undefined,
                  ...(toolCallDelta ? { tool_call_delta: toolCallDelta } : {}),
                });
              }

              // 累积流式工具调用
              if (rawToolCalls) {
                for (const tc of rawToolCalls) {
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
