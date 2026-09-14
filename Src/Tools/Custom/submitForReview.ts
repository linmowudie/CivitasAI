/**
 * 提交审核工具（桩实现）
 *
 * Worker 完成任务后提交给 Reviewer 审核。
 * S9 才接线。本阶段仅定义 Spec + 桩 execute。
 */

import type { ToolDefinition } from '../Traits/toolSpec.js';
import { toolSuccess, toolError } from '../Traits/toolSpec.js';
import { contentOutputSchema } from '../Builtin/_shared.js';

export const submitForReview: ToolDefinition = {
  spec: {
    name: 'agent.submit_review',
    version: '0.1.0',
    description: 'Worker 提交任务成果给 Reviewer 审核。Worker 不得自行宣告完成。',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: '任务 ID' },
        summary: { type: 'string', description: '成果摘要' },
        artifacts: {
          type: 'array',
          items: { type: 'string' },
          description: '产物路径列表',
        },
      },
      required: ['taskId', 'summary'],
      additionalProperties: false,
    },
    outputSchema: contentOutputSchema('{ reviewId, status }'),
    dangerLevel: 'CONTROLLED',
    idempotency: 'CONDITIONAL',
    idempotencyKeyFields: ['taskId'],
    reversibility: 'REVERSIBLE',
    sideEffectScope: 'workspace',
    requiredRoles: ['worker'],
    sandboxMode: 'none',
    timeoutMs: 15_000,
  },

  async execute(_input, context) {
    // 桩实现：S9 接线
    return toolError(context.operationId, 'NOT_IMPLEMENTED', 'agent.submit_review 待 S9 实现', false);
  },
};
