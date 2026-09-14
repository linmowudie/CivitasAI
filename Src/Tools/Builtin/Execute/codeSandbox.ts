/**
 * 代码沙箱工具（DANGEROUS）
 *
 * 在受限环境中执行代码片段。
 * 当前实现为 Node.js vm 模块的简化封装。
 */

import type { ToolDefinition } from '../../Traits/toolSpec.js';
import { toolSuccess, toolError } from '../../Traits/toolSpec.js';
import { contentOutputSchema } from '../_shared.js';
import { runInNewContext } from 'node:vm';

export const codeSandbox: ToolDefinition = {
  spec: {
    name: 'code.eval',
    version: '0.1.0',
    description: '在沙箱环境中执行 JavaScript/TypeScript 代码片段。',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: '要执行的代码' },
        language: { type: 'string', enum: ['javascript', 'typescript'], description: '语言，默认 javascript' },
        timeoutMs: { type: 'number', description: '超时 ms，默认 5000' },
      },
      required: ['code'],
      additionalProperties: false,
    },
    outputSchema: contentOutputSchema('{ result, logs }'),
    dangerLevel: 'DANGEROUS',
    idempotency: 'CONDITIONAL',
    idempotencyKeyFields: ['code'],
    reversibility: 'IRREVERSIBLE',
    sideEffectScope: 'process',
    requiredRoles: ['prime_director', 'arbitrator', 'worker'],
    sandboxMode: 'strict',
    timeoutMs: 10_000,
  },

  async execute(input, context) {
    const code = input['code'] as string;
    const timeoutMs = (input['timeoutMs'] as number) ?? 5000;

    if (!code) {
      return toolError(context.operationId, 'INVALID_INPUT', '缺少 code 参数', false);
    }

    const logs: string[] = [];
    const sandbox = {
      console: {
        log: (...args: unknown[]) => logs.push(args.map(String).join(' ')),
        error: (...args: unknown[]) => logs.push('[ERROR] ' + args.map(String).join(' ')),
        warn: (...args: unknown[]) => logs.push('[WARN] ' + args.map(String).join(' ')),
      },
    };

    try {
      const result = runInNewContext(code, sandbox, { timeout: timeoutMs });
      return toolSuccess(context.operationId, {
        result: result !== undefined ? String(result) : null,
        logs,
      }, {
        effects: [`code.eval:${code.slice(0, 50)}`],
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return toolError(context.operationId, 'CODE_EXECUTION_ERROR', message, true);
    }
  },
};
