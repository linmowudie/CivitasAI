/**
 * 向量嵌入客户端（Docs/02 §14 ⑫）
 *
 * 职责：
 * - 调用 Embedding API 将文本转为向量
 * - 支持批量嵌入
 * - 维度校验
 *
 * 复用 OpenAI 兼容的 Embeddings API 端点（/v1/embeddings）。
 */

import type { Result } from '../types.js';
import { ok, err } from '../types.js';
import { resolveModel } from '../Llm/Router/modelRouter.js';

// ===== 类型定义 =====

/** Embedding 调用选项 */
export interface EmbeddingOptions {
  /** 模型全限定名（provider/model） */
  readonly model: string;
  /** 输入文本（单条或批量） */
  readonly input: string | string[];
  /** 超时 ms，默认 10_000 */
  readonly timeoutMs?: number;
}

/** Embedding 结果 */
export interface EmbeddingResult {
  /** 向量数组（批量时每行对应一个输入） */
  readonly embeddings: number[][];
  /** 向量维度 */
  readonly dimensions: number;
  /** Token 用量 */
  readonly usage: {
    readonly prompt_tokens: number;
    readonly total_tokens: number;
  };
  readonly model: string;
}

// ===== 默认值 =====

const DEFAULT_EMBEDDING_TIMEOUT_MS = 10_000;

// ===== 公开 API =====

/**
 * 获取文本的向量嵌入
 */
export async function getEmbeddings(options: EmbeddingOptions): Promise<Result<EmbeddingResult>> {
  const resolved = resolveModel(options.model);
  if (!resolved.ok) return err(resolved.error, 'ERROR');

  const { provider, spec } = resolved.value;
  const timeoutMs = options.timeoutMs ?? DEFAULT_EMBEDDING_TIMEOUT_MS;

  // 获取 API Key（通过 Provider 的 base_url 和 api_key_ref）
  const apiKeyRef = provider.config.api_key_ref;
  let apiKey: string;
  if (apiKeyRef.startsWith('env:')) {
    const envVar = apiKeyRef.slice(4);
    const value = process.env[envVar];
    if (!value) return err(`环境变量 ${envVar} 未设置`, 'FATAL');
    apiKey = value;
  } else {
    return err(`不支持的 api_key_ref 格式: ${apiKeyRef}`, 'FATAL');
  }

  const url = `${provider.config.base_url}/embeddings`;
  const inputs = Array.isArray(options.input) ? options.input : [options.input];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: spec.id,
        input: inputs,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      return err(`Embedding API 错误 (${response.status}): ${errorBody}`, 'ERROR');
    }

    const data = await response.json() as EmbeddingApiResponse;

    // 按 index 排序（API 可能乱序返回）
    const sorted = data.data.sort((a, b) => a.index - b.index);
    const embeddings = sorted.map(item => item.embedding);
    const dimensions = embeddings[0]?.length ?? 0;

    return ok({
      embeddings,
      dimensions,
      usage: {
        prompt_tokens: data.usage?.prompt_tokens ?? 0,
        total_tokens: data.usage?.total_tokens ?? 0,
      },
      model: data.model ?? spec.id,
    });
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      return err(`Embedding 调用超时 (${timeoutMs}ms)`, 'ERROR');
    }
    const message = e instanceof Error ? e.message : String(e);
    return err(`Embedding 调用失败: ${message}`, 'ERROR');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 获取单条文本的向量（便捷方法）
 */
export async function getEmbedding(
  model: string,
  text: string,
  timeoutMs?: number,
): Promise<Result<number[]>> {
  const result = await getEmbeddings({ model, input: text, timeoutMs });
  if (!result.ok) return err(result.error, result.severity);
  return ok(result.value.embeddings[0]);
}

// ===== 内部类型 =====

/** OpenAI 兼容 Embedding API 响应 */
interface EmbeddingApiResponse {
  data: Array<{
    object: string;
    index: number;
    embedding: number[];
  }>;
  model?: string;
  usage?: {
    prompt_tokens: number;
    total_tokens: number;
  };
}
