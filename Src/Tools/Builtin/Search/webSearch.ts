/**
 * 网络搜索工具（SAFE）
 *
 * 通过搜索引擎查询信息。当前为桩实现。
 * S9+ 接入真实搜索引擎。
 */

import type { ToolDefinition } from '../../Traits/toolSpec.js';
import { toolSuccess, toolError } from '../../Traits/toolSpec.js';
import { contentOutputSchema } from '../_shared.js';

export const webSearch: ToolDefinition = {
  spec: {
    name: 'web.search',
    version: '0.1.0',
    description: '通过搜索引擎查询互联网信息。返回摘要和链接。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索查询' },
        maxResults: { type: 'number', description: '最大结果数，默认 5' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    outputSchema: contentOutputSchema('{ results: Array<{title, url, snippet}> }'),
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

    // 桩实现：S9+ 接入真实搜索 API
    return toolSuccess(context.operationId, {
      results: [],
      message: 'web.search 桩实现，待 S9 接入真实搜索引擎',
    });
  },
};
