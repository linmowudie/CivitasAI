/**
 * 文件写入工具（CONTROLLED）
 *
 * 写入文件内容。走 EffectJournal（Docs/Agent/12 §4）。
 * idempotency='NO' → 必须先写 INTENT。
 */

import { createHash } from 'node:crypto';
import { statSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type { ToolDefinition } from '../../Traits/toolSpec.js';
import { toolSuccess, toolError } from '../../Traits/toolSpec.js';
import { atomicWrite } from '../../../Infra/Fs/atomicWrite.js';
import { canWrite, recordUsage } from '../../../Infra/Fs/quotaManager.js';
import { contentOutputSchema } from '../_shared.js';
import { checkPath } from '../../../Infra/Security/pathGuard.js';
import { resolveWithinWorkspace } from '../../../Infra/Security/workspaceGuard.js';

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
    const rawPath = input['path'] as string;
    const content = input['content'] as string;

    if (!rawPath || content === undefined) {
      return toolError(context.operationId, 'INVALID_INPUT', '缺少 path 或 content 参数', false);
    }

    // 任务工作目录约束（未绑定会话时退化为全局 pathGuard）
    let filePath = rawPath;
    if (context.workDir) {
      const within = resolveWithinWorkspace(rawPath, context.workDir);
      if (!within.ok) {
        return toolError(context.operationId, 'PATH_DENIED', within.error, false);
      }
      filePath = within.value;
    }

    // FE-066：磁盘配额检查（未配置配额时恒通过——quotaManager 的安全默认）
    const contentBytes = Buffer.byteLength(content, 'utf-8');
    if (!canWrite(filePath, contentBytes)) {
      return toolError(context.operationId, 'QUOTA_EXCEEDED', `磁盘配额不足，拒绝写入：${filePath}`, false);
    }

    // FE-066：父目录自动创建（保留原 safeWriteFile 语义）
    try {
      const dir = dirname(filePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    } catch { /* 目录创建失败由原子写入统一报错 */ }

    // FE-066：原子写入（临时文件 + fsync + rename）——写入失败不影响原文件
    const result = atomicWrite(filePath, content);
    if (!result.ok) {
      return toolError(context.operationId, 'FILE_WRITE_FAILED', result.error, true);
    }
    recordUsage(filePath, contentBytes);

    // 计算产物信息
    let size = 0;
    let hash = '';
    try {
      const check = checkPath(filePath, 'write');
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
