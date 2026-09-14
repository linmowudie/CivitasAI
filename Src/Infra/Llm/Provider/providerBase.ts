/**
 * Provider 抽象基类（Docs/02 §10.4 / Docs/11 §6）
 *
 * 所有 LLM Provider 必须实现此接口。
 * context_window 为必填字段，缺失则拒注。
 */

import type { Result } from '../../types.js';

// ===== 类型定义 =====

/** 模型规格（context_window 必填） */
export interface ModelSpec {
  readonly id: string;
  /** 上下文窗口大小（token 数），必填，缺失拒注 */
  readonly context_window: number;
  /** 最大输出 token 数 */
  readonly max_output: number;
  readonly supports_vision: boolean;
  readonly supports_tools: boolean;
  readonly cost_per_1k_input: number;
  readonly cost_per_1k_output: number;
}

/** Provider 配置 */
export interface ProviderConfig {
  readonly provider: string;
  readonly base_url: string;
  readonly api_key_ref: string;
  readonly display_name: string;
  readonly models: ModelSpec[];
}

/** Chat 消息 */
export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;
  readonly name?: string;
  readonly tool_call_id?: string;
}

/** 调用选项 */
export interface CallOptions {
  readonly model: string;
  readonly messages: ChatMessage[];
  readonly temperature?: number;
  readonly max_tokens?: number;
  readonly stream?: boolean;
  readonly tools?: unknown[];
  readonly signal?: AbortSignal;
}

/** 调用结果 */
export interface CallResult {
  readonly content: string;
  readonly reasoning_content?: string;
  readonly finish_reason: string;
  readonly usage: {
    readonly prompt_tokens: number;
    readonly completion_tokens: number;
    readonly total_tokens: number;
  };
  readonly model: string;
}

/** 流式 chunk */
export interface StreamChunk {
  readonly delta: string;
  readonly reasoning_delta?: string;
  readonly finish_reason?: string;
  readonly usage?: CallResult['usage'];
}

/** 错误分类（Docs/02 §10.2） */
export type ErrorCategory =
  | 'auth'           // 401/403 → FATAL，不重试
  | 'rate_limited'   // 429 → 退避 5s 重试 1 次
  | 'server_error'   // 5xx → 重试 2 次
  | 'unavailable'    // 503 → 直接降级
  | 'network'        // 连接错误 → 重试 2 次
  | 'format_error'   // Schema 不匹配 → 重试 1 次
  | 'content_blocked' // 内容安全 → 不重试
  | 'timeout'        // 超时 → 归为网络错误
  | 'unknown';

/** Provider 调用错误 */
export class ProviderError extends Error {
  readonly category: ErrorCategory;
  readonly statusCode?: number;
  readonly retryable: boolean;

  constructor(category: ErrorCategory, message: string, statusCode?: number) {
    super(message);
    this.name = 'ProviderError';
    this.category = category;
    this.statusCode = statusCode;
    this.retryable = category !== 'auth' && category !== 'content_blocked';
  }
}

// ===== Provider 抽象接口 =====

/**
 * LLM Provider 抽象基类
 *
 * 所有 Provider 必须实现 chat() 和 chatStream()。
 */
export abstract class LlmProvider {
  readonly config: ProviderConfig;

  constructor(config: ProviderConfig) {
    // 验证 context_window 必填（Docs/02 §10.4）
    for (const model of config.models) {
      if (!model.context_window || model.context_window <= 0) {
        throw new Error(`模型 ${model.id} 缺少 context_window，拒注`);
      }
    }
    this.config = config;
  }

  get name(): string {
    return this.config.provider;
  }

  get displayName(): string {
    return this.config.display_name;
  }

  /** 获取支持的模型列表 */
  getModels(): ModelSpec[] {
    return this.config.models;
  }

  /** 检查是否支持指定模型 */
  supportsModel(modelId: string): boolean {
    return this.config.models.some(m => m.id === modelId);
  }

  /** 获取模型规格 */
  getModelSpec(modelId: string): ModelSpec | undefined {
    return this.config.models.find(m => m.id === modelId);
  }

  /** 非流式调用 */
  abstract chat(options: CallOptions): Promise<Result<CallResult>>;

  /** 流式调用 */
  abstract chatStream(
    options: CallOptions,
    onChunk: (chunk: StreamChunk) => void,
  ): Promise<Result<CallResult>>;

  /** 解析 API Key 引用（env:XXX 格式） */
  protected resolveApiKey(): string {
    const ref = this.config.api_key_ref;
    if (ref.startsWith('env:')) {
      const envVar = ref.slice(4);
      const value = process.env[envVar];
      if (!value) {
        throw new ProviderError('auth', `环境变量 ${envVar} 未设置`);
      }
      return value;
    }
    throw new ProviderError('auth', `不支持的 api_key_ref 格式: ${ref}`);
  }

  /** 分类 HTTP 错误（Docs/02 §10.2） */
  protected classifyHttpError(statusCode: number, body: string): ProviderError {
    switch (statusCode) {
      case 401:
      case 403:
        return new ProviderError('auth', `认证失败 (${statusCode}): ${body}`, statusCode);
      case 429:
        return new ProviderError('rate_limited', `速率限制 (429): ${body}`, statusCode);
      case 503:
        return new ProviderError('unavailable', `服务不可用 (503): ${body}`, statusCode);
      default:
        if (statusCode >= 500) {
          return new ProviderError('server_error', `服务器错误 (${statusCode}): ${body}`, statusCode);
        }
        return new ProviderError('unknown', `未知错误 (${statusCode}): ${body}`, statusCode);
    }
  }
}
