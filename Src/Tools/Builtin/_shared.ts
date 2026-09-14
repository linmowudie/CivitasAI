/**
 * 内置工具共享的输出 Schema 模板
 *
 * 所有工具的 outputSchema 必须包含 status + recoverable（Docs/11 §6.2）。
 */

import type { JsonSchema } from '../Traits/toolSpec.js';

/** 通用成功输出 Schema 基类 */
export const BASE_OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['success', 'error'] },
    recoverable: { type: 'boolean' },
  },
  required: ['status', 'recoverable'],
  additionalProperties: true, // 工具可在此基础上扩展
};

/** 带 content 的输出 Schema */
export function contentOutputSchema(contentDesc: string): JsonSchema {
  return {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['success', 'error'] },
      recoverable: { type: 'boolean' },
      content: { type: 'object', description: contentDesc },
    },
    required: ['status', 'recoverable'],
    additionalProperties: true,
  };
}
