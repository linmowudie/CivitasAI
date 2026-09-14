/**
 * @module Retrieval/retriever
 * @description
 * 检索器——Docs/02 §3 步骤�?相关�?
 * 从共享记忆和外部源检索相关上下文片段�?
 */

import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';

/** 检索结�?*/
export interface RetrievalResult {
  /** 检索到的片�?*/
  fragments: RetrievalFragment[];
  /** 检索耗时（ms�?*/
  durationMs: number;
  /** 来源 */
  source: string;
}

/** 检索片�?*/
export interface RetrievalFragment {
  id: string;
  content: string;
  score: number;
  source: string;
  metadata: Record<string, unknown>;
}

/** 检索选项 */
export interface RetrievalOptions {
  query: string;
  topK: number;
  /** 最小相关性阈�?*/
  minScore: number;
  /** 来源过滤 */
  sources?: string[];
}

/** 检索器接口 */
export interface Retriever {
  name: string;
  retrieve(options: RetrievalOptions): Promise<Result<RetrievalResult>>;
}

// ── 内存检索器（桩实现）──────────────────────────────

let fragmentCounter = 0;

/** 创建内存检索器（桩�?*/
export function createMemoryRetriever(): Retriever {
  const memoryStore: RetrievalFragment[] = [];

  return {
    name: 'memory',
    retrieve: async (options) => {
      const start = Date.now();
      // 桩：返回空结�?
      const fragments = memoryStore
        .filter(f => f.score >= options.minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, options.topK);

      return ok({
        fragments,
        durationMs: Date.now() - start,
        source: 'memory',
      });
    },
  };
}

/** 添加记忆片段到内存存储（测试用） */
export function addMemoryFragment(store: RetrievalFragment[], fragment: Omit<RetrievalFragment, 'id'>): string {
  const id = `frag-${++fragmentCounter}`;
  store.push({ ...fragment, id });
  return id;
}

/** 执行多源检�?*/
export async function retrieveFromMultiple(
  retrievers: Retriever[],
  options: RetrievalOptions,
): Promise<Result<RetrievalResult>> {
  const results = await Promise.allSettled(
    retrievers.map(r => r.retrieve(options)),
  );

  const allFragments: RetrievalFragment[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value.ok) {
      allFragments.push(...result.value.value.fragments);
    }
  }

  // 按分数排序，�?topK
  allFragments.sort((a, b) => b.score - a.score);

  return ok({
    fragments: allFragments.slice(0, options.topK),
    durationMs: 0,
    source: 'multi',
  });
}
