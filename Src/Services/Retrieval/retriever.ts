/**
 * @module Retrieval/retriever
 * @description
 * 检索器——Docs/Agent/02 §3 步骤③“检索相关片段”（FE-058 实装）。
 *
 * 历史：原实现为“内存检索器（桩）”——内部 store 外部不可达，检索恒空。
 * 现改为**长时记忆真实检索**：
 *  - 文本打分：`longTermMemory.searchMemories`（确定性，无外部依赖）；
 *  - 可选语义重排：`memoryEmbeddings.semanticRescore`（配置嵌入模型后生效，混合余弦分）；
 *  - 缺失向量的候选由后台补齐（fire-and-forget，不影响本次结果）。
 */

import type { Result } from '../../Infra/types.js';
import { ok } from '../../Infra/types.js';

import { searchMemories } from '../SharedMemory/longTermMemory.js';
import { semanticRescore, embedPendingEntries } from '../SharedMemory/memoryEmbeddings.js';

/** 检索结果 */
export interface RetrievalResult {
  /** 检索到的片段 */
  fragments: RetrievalFragment[];
  /** 检索耗时（ms） */
  durationMs: number;
  /** 来源 */
  source: string;
}

/** 检索片段 */
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
  /** 最小相关性阈值 */
  minScore: number;
  /** 来源过滤 */
  sources?: string[];
}

/** 检索器接口 */
export interface Retriever {
  name: string;
  retrieve(options: RetrievalOptions): Promise<Result<RetrievalResult>>;
}

// ── 长时记忆检索器（FE-058：真实实现）──────────────────────────────

/**
 * 创建长时记忆检索器。
 *
 * 链路：文本打分召回（过度召回 topK×4，上限 50）→ 语义重排（可选）→ 截取 topK。
 * 空检索/无命中返回空数组（诚实结果，不再是“桩恒空”）。
 */
export function createMemoryRetriever(): Retriever {
  return {
    name: 'long-term-memory',
    retrieve: async (options) => {
      const start = Date.now();

      if (!options.query || options.query.trim() === '') {
        return ok({ fragments: [], durationMs: Date.now() - start, source: 'long-term-memory' });
      }

      // 过度召回（为重排留空间）→ 语义重排 → 截取 topK
      const overFetch = Math.min(50, Math.max(options.topK * 4, options.topK));
      const hits = searchMemories(options.query, {
        limit: overFetch,
        minScore: options.minScore,
      });
      const rescored = await semanticRescore(options.query, hits);
      const finalHits = rescored.slice(0, options.topK);

      // 后台补齐缺失向量（fire-and-forget：本次用文本分，下次检索生效）
      embedPendingEntries(finalHits.map(h => ({
        memoryId: h.entry.memoryId,
        title: h.entry.title,
        content: h.entry.content,
      })));

      const fragments: RetrievalFragment[] = finalHits.map(h => ({
        id: h.entry.memoryId,
        content: [h.entry.title, h.entry.content].filter(Boolean).join('\n'),
        score: h.score,
        source: 'long-term-memory',
        metadata: {
          category: h.entry.category,
          status: h.entry.status,
          sourceTraceIds: h.entry.sourceTraceIds,
        },
      }));

      const filtered = options.sources?.length
        ? fragments.filter(f => options.sources!.includes(f.source))
        : fragments;

      return ok({
        fragments: filtered,
        durationMs: Date.now() - start,
        source: 'long-term-memory',
      });
    },
  };
}

// ── 测试辅助（保留自旧接口，供既有测试构造片段数组）────────────────

let fragmentCounter = 0;

/** 测试辅助：向（外部持有的）片段数组追加一条 */
export function addMemoryFragment(store: RetrievalFragment[], fragment: Omit<RetrievalFragment, 'id'>): string {
  const id = `frag-${++fragmentCounter}`;
  store.push({ ...fragment, id });
  return id;
}

/** 执行多源检索（合并各检索器结果，按分数截取 topK） */
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

  // 按分数排序，取 topK
  allFragments.sort((a, b) => b.score - a.score);

  return ok({
    fragments: allFragments.slice(0, options.topK),
    durationMs: 0,
    source: 'multi',
  });
}
