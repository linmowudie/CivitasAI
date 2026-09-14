/**
 * 文件编辑工具（CONTROLLED）
 *
 * 通过查找替换编辑文件。走 EffectJournal。
 */

import type { ToolDefinition } from '../../Traits/toolSpec.js';
import { toolSuccess, toolError } from '../../Traits/toolSpec.js';
import { safeReadFile, safeWriteFile } from '../../../Infra/Fs/fsSafe.js';
import { contentOutputSchema } from '../_shared.js';
import { createHash } from 'node:crypto';
import { checkPath } from '../../../Infra/Security/pathGuard.js';

export const fileEditor: ToolDefinition = {
  spec: {
    name: 'file.edit',
    version: '0.1.0',
    description: '通过查找替换编辑文件内容。支持全文替换和正则替换。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
        search: { type: 'string', description: '查找内容' },
        replace: { type: 'string', description: '替换内容' },
        useRegex: { type: 'boolean', description: '是否使用正则，默认 false' },
      },
      required: ['path', 'search', 'replace'],
      additionalProperties: false,
    },
    outputSchema: contentOutputSchema('{ path, replacements, hash }'),
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
    const search = input['search'] as string;
    const replace = input['replace'] as string;
    const useRegex = input['useRegex'] as boolean ?? false;

    if (!filePath || !search) {
      return toolError(context.operationId, 'INVALID_INPUT', '缺少 path 或 search 参数', false);
    }

    // 读取原文件
    const readResult = safeReadFile(filePath);
    if (!readResult.ok) {
      return toolError(context.operationId, 'FILE_READ_FAILED', readResult.error, true);
    }

    const original = readResult.value;
    let modified: string;
    let replacements = 0;

    if (useRegex) {
      try {
        const regex = new RegExp(search, 'g');
        const matches = original.match(regex);
        replacements = matches?.length ?? 0;
        modified = original.replace(regex, replace);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return toolError(context.operationId, 'INVALID_REGEX', message, false);
      }
    } else {
      // 全文替换
      replacements = 0;
      let idx = 0;
      modified = '';
      let remaining = original;
      while (true) {
        const pos = remaining.indexOf(search);
        if (pos === -1) {
          modified += remaining;
          break;
        }
        replacements++;
        modified += remaining.slice(0, pos) + replace;
        remaining = remaining.slice(pos + search.length);
      }
    }

    if (replacements === 0) {
      return toolError(context.operationId, 'NO_MATCH', `未找到匹配: ${search}`, true);
    }

    // 写入修改后的内容
    const writeResult = safeWriteFile(filePath, modified);
    if (!writeResult.ok) {
      return toolError(context.operationId, 'FILE_WRITE_FAILED', writeResult.error, true);
    }

    const hash = 'sha256:' + createHash('sha256').update(modified).digest('hex');

    return toolSuccess(context.operationId, { path: filePath, replacements, hash }, {
      effects: [`file.edit:${filePath}`],
      artifacts: [{ path: filePath, hash, size: Buffer.byteLength(modified) }],
    });
  },
};
