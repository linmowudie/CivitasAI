/**
 * Provider 抽象基类（Docs/Agent/02 §10.4 / Docs/Agent/10 §6）
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
  /**
   * 注册名——内存注册表的唯一键，也是模型全限定名前缀（`${provider}/${modelId}`）。
   * 同类型多实例必须使用不同的注册名（如 `openai-compatible`、`openai-compatible-2`），
   * 否则后注册实例会覆盖先注册的（FE-036）；可用 `uniqueProviderName()` 生成。
   */
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
  /** 模型返回的工具调用（OpenAI 兼容格式） */
  readonly tool_calls?: Array<{
    readonly id: string;
    readonly type: string;
    readonly function: {
      readonly name: string;
      readonly arguments: string;
    };
  }>;
}

/** 流式 chunk */
export interface StreamChunk {
  readonly delta: string;
  readonly reasoning_delta?: string;
  readonly finish_reason?: string;
  readonly usage?: CallResult['usage'];
  /**
   * 工具调用**增量**（2026-10-03 新增，修复"工具块只在完全生成后才出现"）。
   *
   * 背景：模型生成一次工具调用可能要几十秒（尤其写文件这类长参数），
   * 而工具只会在**整段响应结束**后才由 Loop 执行 —— 若增量不透传到上层，
   * 这段时间界面完全空白，用户感觉"卡住了/等全部生成才出现"。
   * 透传后上层可在**模型刚开始生成工具调用时**就预创建工具块并显示"生成中/准备写入"。
   */
  readonly tool_call_delta?: ReadonlyArray<{
    /** 同一响应内的工具调用序号（用于区分并行调用） */
    readonly index: number;
    /** 工具调用 ID（通常首个增量即给出） */
    readonly id?: string;
    /** 函数名（可能分片到达，需累积） */
    readonly name?: string;
    /** 参数 JSON 片段 */
    readonly argumentsDelta?: string;
  }>;
}

/** 错误分类（Docs/Agent/02 §10.2） */
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
    // 验证 context_window 必填（Docs/Agent/02 §10.4）
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

  /** 解析 API Key 引用（env:XXX 或 inline:XXX 格式） */
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
    if (ref.startsWith('inline:')) {
      // 运行时直接传入的 API Key（不持久化，应用重启后失效）
      return ref.slice(7);
    }
    throw new ProviderError('auth', `不支持的 api_key_ref 格式: ${ref}`);
  }

  /**
   * 归一化模型名：调用方可能传入限定名（provider/model），
   * 而各家 API 只接受裸模型 id。统一在此剥离 provider 前缀，
   * 避免把 "huawei-maas/DeepSeek-V4-Flash" 这类字符串发给上游，
   * 得到 "model does not support the token plan subscription" 这类误导性 404。
   */
  protected resolveRequestModel(requested: string): string {
    const slash = requested.indexOf('/');
    return slash >= 0 ? requested.slice(slash + 1) : requested;
  }

  /** 分类 HTTP 错误（Docs/Agent/02 §10.2） */
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
