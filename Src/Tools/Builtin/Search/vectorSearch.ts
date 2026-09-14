/**
 * 向量搜索工具（SAFE）
 *
 * 通过向量相似度搜索。当前为桩实现。
 * S8+ 接入 Embedding + 向量存储。
 */

import type { ToolDefinition } from '../../Traits/toolSpec.js';
import { toolSuccess, toolError } from '../../Traits/toolSpec.js';
import { contentOutputSchema } from '../_shared.js';

export const vectorSearch: ToolDefinition = {
  spec: {
    name: 'vector.search',
    version: '0.1.0',
    description: '通过向量相似度搜索知识库。返回最相关的文档片段。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索查询' },
        topK: { type: 'number', description: '返回结果数，默认 5' },
        collection: { type: 'string', description: '搜索集合名称' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    outputSchema: contentOutputSchema('{ results: Array<{content, score, source}> }'),
    dangerLevel: 'SAFE',
    idempotency: 'YES',
    idempotencyKeyFields: ['query'],
    reversibility: 'REVERSIBLE',
    sideEffectScope: 'none',
    requiredRoles: ['prime_director', 'arbitrator', 'partner', 'worker'],
    sandboxMode: 'none',
    timeoutMs: 15_000,
  },

  async execute(input, context) {
    const query = input['query'] as string;
    if (!query) {
      return toolError(context.operationId, 'INVALID_INPUT', '缺少 query 参数', false);
    }

    // 桩实现：S8+ 接入 Embedding + 向量存储
    return toolSuccess(context.operationId, {
      results: [],
      message: 'vector.search 桩实现，待 S8 接入向量存储',
    });
  },
};
