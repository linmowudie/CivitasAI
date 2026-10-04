/**
 * 向量/记忆搜索工具（SAFE）——FE-058 实装（替代原“桩实现，待 S8 接入”）。
 *
 * 真相：检索对象为**长时记忆知识库**（long_term_memory）：
 *  - 文本相关性打分（确定性，无外部依赖）；
 *  - 配置嵌入模型（`routing.embeddingModel`）后自动叠加语义重排（余弦混合分）；
 *  - 缺失向量的条目由检索器后台逐步补齐（不影响本次结果）。
 */

import type { ToolDefinition } from '../../Traits/toolSpec.js';
import { toolSuccess, toolError } from '../../Traits/toolSpec.js';
import { contentOutputSchema } from '../_shared.js';
import { getToolServicePorts } from '../../Registry/toolServicePorts.js';

export const vectorSearch: ToolDefinition = {
  spec: {
    name: 'vector.search',
    version: '0.2.0',
    description: '检索长时记忆知识库（相关性/语义搜索）。返回最相关的记忆条目（含分数）。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索查询' },
        topK: { type: 'number', description: '返回结果数，默认 5（1-20）' },
        collection: { type: 'string', description: '（保留字段）当前仅单知识库，忽略' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    outputSchema: contentOutputSchema('{ query, count, results: Array<{content, score, source, category}> }'),
    dangerLevel: 'SAFE',
    idempotency: 'YES',
    idempotencyKeyFields: ['query', 'topK'],
    reversibility: 'REVERSIBLE',
    sideEffectScope: 'none',
    requiredRoles: ['prime_director', 'arbitrator', 'auditor', 'partner', 'worker', 'assembly_node', 'reviewer', 'regulator'],
    sandboxMode: 'none',
    timeoutMs: 15_000,
  },

  async execute(input, context) {
    const query = String(input['query'] ?? '');
    if (!query.trim()) {
      return toolError(context.operationId, 'INVALID_INPUT', '缺少 query 参数', false);
    }

    const rawTopK = input['topK'];
    const topK = typeof rawTopK === 'number' && Number.isFinite(rawTopK)
      ? Math.min(Math.max(Math.trunc(rawTopK), 1), 20)
      : 5;

    const factory = getToolServicePorts().memoryRetrieverFactory;
    if (!factory) {
      return toolError(context.operationId, 'NOT_ENABLED',
        '记忆检索未装配（由组合根注入检索器）；本次未返回任何结果', false);
    }

    const retriever = factory();
    const retrieved = await retriever.retrieve({ query, topK, minScore: 0.05 });
    if (!retrieved.ok) {
      return toolError(context.operationId, 'SEARCH_FAILED', `检索失败：${retrieved.error}`, true);
    }

    const results = retrieved.value.fragments.map(f => ({
      content: f.content.slice(0, 800),
      score: Number(f.score.toFixed(4)),
      source: f.id,
      category: f.metadata['category'],
    }));

    return toolSuccess(context.operationId, JSON.stringify({
      query,
      count: results.length,
      results,
      hint: results.length === 0
        ? '知识库中暂无匹配条目（记忆随任务沉淀逐步积累）'
        : undefined,
    }, null, 2));
  },
};
