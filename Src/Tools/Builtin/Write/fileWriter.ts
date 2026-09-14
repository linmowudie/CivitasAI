/**
 * 文件写入工具（CONTROLLED）
 *
 * 写入文件内容。走 EffectJournal（Docs/13 §4）。
 * idempotency='NO' → 必须先写 INTENT。
 */

import type { ToolDefinition } from '../../Traits/toolSpec.js';
import { toolSuccess, toolError } from '../../Traits/toolSpec.js';
import { safeWriteFile } from '../../../Infra/Fs/fsSafe.js';
import { contentOutputSchema } from '../_shared.js';
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { checkPath } from '../../../Infra/Security/pathGuard.js';

export const fileWriter: ToolDefinition = {
  spec: {
    name: 'file.write',
    version: '0.1.0',
    description: '写入内容到指定文件。自动创建父目录。不可幂等，执行前需写 INTENT。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
        content: { type: 'string', description: '写入内容' },
        encoding: { type: 'string', description: '编码，默认 utf-8' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    outputSchema: contentOutputSchema('{ path, size, hash }'),
    dangerLevel: 'CONTROLLED',
    idempotency: 'NO',
    reversibility: 'PARTIAL',
    sideEffectScope: 'workspace',
    requiredRoles: ['prime_director', 'arbitrator', 'partner', 'worker'],
    sandboxMode: 'none',
    timeoutMs: 15_000,
  },

  async execute(input, context) {
    const filePath = input['path'] as string;
    const content = input['content'] as string;

    if (!filePath || content === undefined) {
      return toolError(context.operationId, 'INVALID_INPUT', '缺少 path 或 content 参数', false);
    }

    const result = safeWriteFile(filePath, content);
    if (!result.ok) {
      return toolError(context.operationId, 'FILE_WRITE_FAILED', result.error, true);
    }

    // 计算产物信息
    let size = 0;
    let hash = '';
    try {
      const check = checkPath(filePath, 'read');
      if (check.allowed) {
        const stat = statSync(check.resolvedPath);
        size = stat.size;
        hash = 'sha256:' + createHash('sha256').update(content).digest('hex');
      }
    } catch { /* ignore */ }

    return toolSuccess(context.operationId, { path: filePath, size, hash }, {
      effects: [`file.write:${filePath}`],
      artifacts: [{ path: filePath, hash, size }],
    });
  },
};
