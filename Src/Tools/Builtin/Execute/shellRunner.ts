/**
 * Shell 命令执行工具（DANGEROUS）
 *
 * 在沙箱内执行 shell 命令。需要命令白名单检查。
 * DANGEROUS + IRREVERSIBLE → 需要 L4 HumanGate（S6 补全）。
 */

import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

import type { ToolDefinition } from '../../Traits/toolSpec.js';
import { toolSuccess, toolError } from '../../Traits/toolSpec.js';
import { contentOutputSchema } from '../_shared.js';
import { isCommandForbidden } from '../../../Infra/Security/whitelist.js';
import {
  resolveWithinWorkspace,
  findEscapingPathInCommand,
} from '../../../Infra/Security/workspaceGuard.js';
import { getSessionWorkspaceDir, getWorkspaceRoot } from '../../../Infra/Fs/pathResolver.js';

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
    requiredRoles: ['prime_director', 'arbitrator', 'partner', 'worker'],
    sandboxMode: 'strict',
    timeoutMs: 30_000,
  },

  async execute(input, context) {
    const command = input['command'] as string;
    const requestedCwd = input['cwd'] as string | undefined;
    const timeoutMs = (input['timeoutMs'] as number) ?? 30_000;

    if (!command) {
      return toolError(context.operationId, 'INVALID_INPUT', '缺少 command 参数', false);
    }

    // 禁止命令检查
    if (isCommandForbidden(command)) {
      return toolError(context.operationId, 'COMMAND_FORBIDDEN', `命令被安全策略禁止`, false);
    }

    // ── 任务工作目录约束 ──
    // cwd 强制收敛到工作目录；命令中不得出现越界的绝对路径或 `..` 逃逸片段。
    // 说明：这是尽力而为的静态检查，完整隔离需 OS 级沙箱。
    let cwd = requestedCwd;
    if (context.workDir) {
      if (requestedCwd) {
        const within = resolveWithinWorkspace(requestedCwd, context.workDir);
        if (!within.ok) {
          return toolError(context.operationId, 'PATH_DENIED', within.error, false);
        }
        cwd = within.value;
      } else {
        cwd = context.workDir;
      }

      const escaping = findEscapingPathInCommand(command, context.workDir);
      if (escaping) {
        return toolError(
          context.operationId,
          'PATH_DENIED',
          `命令引用了工作目录之外的路径: ${escaping}`,
          false,
        );
      }
    } else if (!requestedCwd) {
      /*
       * 无 workDir 时的兜底（2026-10-06 打包态修复）。
       *
       * 历史实现是 `cwd ?? process.cwd()`：开发态看着没问题，**打包态则是错的** ——
       * 安装版进程的 cwd 由快捷方式"起始位置"或启动方式决定（常见是 `C:\Windows\System32`、
       * 用户主目录、甚至临时目录），命令会在一个与任务无关、且可能权限敏感的位置执行，
       * 同时越界检查因 `context.workDir` 为空而完全失效。
       *
       * 现在一律收敛到该会话的工作目录（拿不到 sessionId 就退到工作空间根），
       * 并且**绝不**回落到 `process.cwd()`。
       */
      const fallback = context.sessionId
        ? getSessionWorkspaceDir(context.sessionId)
        : getWorkspaceRoot();
      try {
        mkdirSync(fallback, { recursive: true });
      } catch {
        return toolError(
          context.operationId,
          'PATH_DENIED',
          `无法准备工作目录: ${fallback}（拒绝在进程当前目录执行命令）`,
          false,
        );
      }
      cwd = fallback;
    }

    try {
      const stdout = execSync(command, {
        cwd,
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
