/**
 * @module Retrieval/reranker
 * @description
 * 重排器——对检索结果进行二次排序�?
 * 使用交叉编码器或简单启发式重排�?
 */

import type { RetrievalFragment } from './retriever.js';
import type { Result } from '../../Infra/types.js';
import { ok } from '../../Infra/types.js';

/** 重排选项 */
export interface RerankerOptions {
  query: string;
  fragments: RetrievalFragment[];
  /** 重排后保留数�?*/
  topK: number;
}

/** 重排结果 */
export interface RerankerResult {
  fragments: RetrievalFragment[];
  reranked: boolean;
}

/** 重排器接�?*/
export interface Reranker {
  name: string;
  rerank(options: RerankerOptions): Promise<Result<RerankerResult>>;
}

/** 创建简单关键词重排器（桩实现） */
export function createKeywordReranker(): Reranker {
  return {
    name: 'keyword',
    rerank: async (options) => {
      const { query, fragments, topK } = options;
      const queryTerms = query.toLowerCase().split(/\s+/);

      const scored = fragments.map(f => {
        const content = f.content.toLowerCase();
        let boost = 0;
        for (const term of queryTerms) {
          if (content.includes(term)) boost += 0.1;
        }
        return {
          ...f,
          score: f.score + boost,
        };
      });

      scored.sort((a, b) => b.score - a.score);

      return ok({
        fragments: scored.slice(0, topK),
        reranked: true,
      });
    },
  };
}
