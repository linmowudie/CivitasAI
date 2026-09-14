/**
 * Shell 命令执行工具（DANGEROUS）
 *
 * 在沙箱内执行 shell 命令。需要命令白名单检查。
 * DANGEROUS + IRREVERSIBLE → 需要 L4 HumanGate（S6 补全）。
 */

import type { ToolDefinition } from '../../Traits/toolSpec.js';
import { toolSuccess, toolError } from '../../Traits/toolSpec.js';
import { contentOutputSchema } from '../_shared.js';
import { execSync } from 'node:child_process';
import { isCommandForbidden } from '../../../Infra/Security/whitelist.js';

export const shellRunner: ToolDefinition = {
  spec: {
    name: 'shell.exec',
    version: '0.1.0',
    description: '在沙箱内执行 shell 命令。命令需在白名单内。',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令' },
        cwd: { type: 'string', description: '工作目录' },
        timeoutMs: { type: 'number', description: '超时 ms，默认 30000' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    outputSchema: contentOutputSchema('{ stdout, stderr, exitCode }'),
    dangerLevel: 'DANGEROUS',
    idempotency: 'NO',
    reversibility: 'IRREVERSIBLE',
    sideEffectScope: 'process',
    requiredRoles: ['prime_director', 'arbitrator', 'worker'],
    sandboxMode: 'strict',
    timeoutMs: 30_000,
  },

  async execute(input, context) {
    const command = input['command'] as string;
    const cwd = input['cwd'] as string | undefined;
    const timeoutMs = (input['timeoutMs'] as number) ?? 30_000;

    if (!command) {
      return toolError(context.operationId, 'INVALID_INPUT', '缺少 command 参数', false);
    }

    // 禁止命令检查
    if (isCommandForbidden(command)) {
      return toolError(context.operationId, 'COMMAND_FORBIDDEN', `命令被安全策略禁止`, false);
    }

    try {
      const stdout = execSync(command, {
        cwd: cwd ?? process.cwd(),
        timeout: timeoutMs,
        encoding: 'utf-8',
        maxBuffer: 1024 * 1024, // 1MB
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      return toolSuccess(context.operationId, {
        stdout: stdout ?? '',
        stderr: '',
        exitCode: 0,
      }, {
        effects: [`shell.exec:${command.slice(0, 100)}`],
      });
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; status?: number; message: string };
      if (err.status === null || err.message.includes('ETIMEDOUT')) {
        return toolError(context.operationId, 'COMMAND_TIMEOUT', `命令执行超时 (${timeoutMs}ms)`, true);
      }
      return toolSuccess(context.operationId, {
        stdout: err.stdout ?? '',
        stderr: err.stderr ?? err.message,
        exitCode: err.status ?? 1,
      }, {
        effects: [`shell.exec:${command.slice(0, 100)}`],
      });
    }
  },
};
