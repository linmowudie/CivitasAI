/**
 * 代码沙箱工具（DANGEROUS）
 *
 * 在受限环境中执行代码片段。**诚实边界（FE-070）**：
 * 本实现为 Node.js `node:vm` 的封装（超时限制 + 无 require/process 透传），
 * `vm` **不是安全边界**（可被逃逸）——真实隔离执行（子进程 + 白名单）属后续专项；
 * 风险由此工具的 DANGEROUS 级 + 审批门控 + EffectJournal 副作用留痕承担。
 */

import { runInNewContext } from 'node:vm';

import type { ToolDefinition } from '../../Traits/toolSpec.js';
import { toolSuccess, toolError } from '../../Traits/toolSpec.js';
import { contentOutputSchema } from '../_shared.js';

export const codeSandbox: ToolDefinition = {
  spec: {
    name: 'code.eval',
    version: '0.1.0',
    description: '在受限环境执行 JavaScript/TypeScript 代码片段（node:vm 隔离——非安全边界，需审批）。',
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
    requiredRoles: ['prime_director', 'arbitrator', 'partner', 'worker'],
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
