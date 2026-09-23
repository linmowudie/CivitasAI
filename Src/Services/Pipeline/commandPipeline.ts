/**
 * @module Pipeline/commandPipeline
 * @description
 * 命令管道——处理用户命令的标准化管道�?
 * 支持命令解析、验证、执行�?
 */

import type { Result } from '../../Infra/types.js';
import { err } from '../../Infra/types.js';

/** 系统命令 */
export type SystemCommand =
  | 'pause'
  | 'resume'
  | 'stop'
  | 'status'
  | 'inspect'
  | 'archive';

/** 命令请求 */
export interface CommandRequest {
  command: SystemCommand;
  targetId?: string;
  args: Record<string, unknown>;
  issuedBy: string;
  timestamp: number;
}

/** 命令结果 */
export interface CommandResult {
  command: SystemCommand;
  success: boolean;
  message: string;
  data?: Record<string, unknown>;
}

/** 命令处理�?*/
export type CommandHandler = (request: CommandRequest) => Promise<Result<CommandResult>>;

const commandHandlers = new Map<SystemCommand, CommandHandler>();

/** 注册命令处理�?*/
export function registerCommandHandler(command: SystemCommand, handler: CommandHandler): void {
  commandHandlers.set(command, handler);
}

/** 执行命令 */
export async function executeCommand(request: CommandRequest): Promise<Result<CommandResult>> {
  const handler = commandHandlers.get(request.command);
  if (!handler) {
    return err('COMMAND_NOT_FOUND', `未知命令: ${request.command}`);
  }

  try {
    return await handler(request);
  } catch (e) {
    return err('COMMAND_FAILED', `命令执行失败: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 获取已注册命令列�?*/
export function getRegisteredCommands(): SystemCommand[] {
  return Array.from(commandHandlers.keys());
}

/** 清空命令处理�?*/
export function clearCommandHandlers(): void {
  commandHandlers.clear();
}
