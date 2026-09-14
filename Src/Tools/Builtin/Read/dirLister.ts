/**
 * 目录列表工具（SAFE）
 *
 * 列出指定目录的内容，支持递归和过滤。
 */

import type { ToolDefinition } from '../../Traits/toolSpec.js';
import { toolSuccess, toolError } from '../../Traits/toolSpec.js';
import { safeListDir, safeExists } from '../../../Infra/Fs/fsSafe.js';
import { contentOutputSchema } from '../_shared.js';
import { statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkPath } from '../../../Infra/Security/pathGuard.js';

export const dirLister: ToolDefinition = {
  spec: {
    name: 'dir.list',
    version: '0.1.0',
    description: '列出指定目录的内容。返回文件名、大小和类型。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目录路径' },
        recursive: { type: 'boolean', description: '是否递归列出，默认 false' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    outputSchema: contentOutputSchema('{ entries: Array<{name, type, size}> }'),
    dangerLevel: 'SAFE',
    idempotency: 'YES',
    idempotencyKeyFields: ['path'],
    reversibility: 'REVERSIBLE',
    sideEffectScope: 'none',
    requiredRoles: ['prime_director', 'arbitrator', 'auditor', 'partner', 'worker', 'assembly_node', 'reviewer'],
    sandboxMode: 'none',
    timeoutMs: 10_000,
  },

  async execute(input, context) {
    const dirPath = input['path'] as string;
    const recursive = input['recursive'] as boolean ?? false;

    if (!dirPath) {
      return toolError(context.operationId, 'INVALID_INPUT', '缺少 path 参数', false);
    }

    const check = checkPath(dirPath, 'list');
    if (!check.allowed) {
      return toolError(context.operationId, 'PATH_DENIED', check.reason, false);
    }

    try {
      const entries = listEntries(check.resolvedPath, recursive, 0);
      return toolSuccess(context.operationId, { entries });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return toolError(context.operationId, 'DIR_LIST_FAILED', message, true);
    }
  },
};

function listEntries(dirPath: string, recursive: boolean, depth: number): Array<{ name: string; type: string; size: number }> {
  const entries: Array<{ name: string; type: string; size: number }> = [];

  const items = readdirSync(dirPath);
  for (const item of items) {
    if (item.startsWith('.')) continue; // 跳过隐藏文件

    const fullPath = join(dirPath, item);
    try {
      const stat = statSync(fullPath);
      const type = stat.isDirectory() ? 'directory' : 'file';
      entries.push({ name: item, type, size: stat.size });

      if (recursive && stat.isDirectory() && depth < 3) {
        const subEntries = listEntries(fullPath, true, depth + 1);
        entries.push(...subEntries.map(e => ({ ...e, name: `${item}/${e.name}` })));
      }
    } catch {
      entries.push({ name: item, type: 'unknown', size: 0 });
    }
  }

  return entries;
}
