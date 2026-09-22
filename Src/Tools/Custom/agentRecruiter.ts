/**
 * Agent 招募工具（桩实现）
 *
 * S9/S10 才接线。本阶段仅定义 Spec + 桩 execute。
 */

import type { ToolDefinition } from '../Traits/toolSpec.js';
import { toolSuccess, toolError } from '../Traits/toolSpec.js';
import { contentOutputSchema } from '../Builtin/_shared.js';

export const agentRecruiter: ToolDefinition = {
  spec: {
    name: 'agent.recruit',
    version: '0.1.0',
    description: '招募一个新的 Agent 来执行特定任务。',
    inputSchema: {
      type: 'object',
      properties: {
        role: { type: 'string', description: 'Agent 角色' },
        task: { type: 'string', description: '任务描述' },
      },
      required: ['role', 'task'],
      additionalProperties: false,
    },
    outputSchema: contentOutputSchema('{ agentId, status }'),
    dangerLevel: 'DANGEROUS',
    idempotency: 'NO',
    reversibility: 'IRREVERSIBLE',
    sideEffectScope: 'external',
    requiredRoles: ['prime_director', 'partner'],
    sandboxMode: 'none',
    timeoutMs: 30_000,
  },

  async execute(_input, context) {
    // 桩实现：S10 接线
    return toolError(context.operationId, 'NOT_IMPLEMENTED', 'agent.recruit 待 S10 实现', false);
  },
};
