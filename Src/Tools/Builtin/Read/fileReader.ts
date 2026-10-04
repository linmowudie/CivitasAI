/**
 * 文件读取工具（SAFE）
 *
 * 读取指定路径的文件内容。
 * 通过 Infra/Fs 的安全文件操作执行。
 */

import { statSync } from 'node:fs';

import type { ToolDefinition } from '../../Traits/toolSpec.js';
import { toolSuccess, toolError } from '../../Traits/toolSpec.js';
import { safeReadFile } from '../../../Infra/Fs/fsSafe.js';
import { contentOutputSchema } from '../_shared.js';
import { checkPath } from '../../../Infra/Security/pathGuard.js';
import { resolveWithinWorkspace } from '../../../Infra/Security/workspaceGuard.js';

export const fileReader: ToolDefinition = {
  spec: {
    name: 'file.read',
    version: '0.1.0',
    description: '读取指定路径的文件内容。支持指定编码和行范围。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
        encoding: { type: 'string', description: '文件编码，默认 utf-8' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    outputSchema: contentOutputSchema('{ content: string, size: number }'),
    dangerLevel: 'SAFE',
    idempotency: 'YES',
    idempotencyKeyFields: ['path'],
    reversibility: 'REVERSIBLE',
    sideEffectScope: 'none',
    requiredRoles: ['prime_director', 'arbitrator', 'auditor', 'partner', 'worker', 'assembly_node', 'reviewer', 'regulator'],
    sandboxMode: 'none',
    timeoutMs: 10_000,
  },

  async execute(input, context) {
    const rawPath = input['path'] as string;
    const encoding = (input['encoding'] as BufferEncoding) ?? 'utf-8';

    if (!rawPath) {
      return toolError(context.operationId, 'INVALID_INPUT', '缺少 path 参数', false);
    }

    // 任务工作目录约束：路径必须落在会话工作目录内（未绑定会话时退化为全局 pathGuard）
    let filePath = rawPath;
    if (context.workDir) {
      const within = resolveWithinWorkspace(rawPath, context.workDir);
      if (!within.ok) {
        return toolError(context.operationId, 'PATH_DENIED', within.error, false);
      }
      filePath = within.value;
    }

    const result = safeReadFile(filePath, { encoding });
    if (!result.ok) {
      return toolError(context.operationId, 'FILE_READ_FAILED', result.error, true);
    }

    const content = result.value;
    let size = 0;
    try {
      const check = checkPath(filePath, 'read');
      if (check.allowed) {
        size = statSync(check.resolvedPath).size;
      }
    } catch { /* ignore */ }

    return toolSuccess(context.operationId, { content, size });
  },
};
