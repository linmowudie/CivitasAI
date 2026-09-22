/**
 * @module Middleware/builtin/failureInjector
 * @description
 * 故障注入中间件——Docs/12 循环控制（测试/调试用）。
 * 可按配置注入特定步骤的故障。
 * 挂载点：wrapToolCall（priority=100）。
 */

import type { AgentMiddleware, MiddlewareContext, ToolCallInput, ToolCallOutput } from '../../../Infra/Contracts/middlewareTypes.js';

export interface FailureInjectionConfig {
  /** 是否启用 */
  enabled: boolean;
  /** 目标工具名（为空则对所有工具注入） */
  targetTool?: string;
  /** 注入的故障类型 */
  faultType: 'error' | 'timeout' | 'slow';
  /** 延迟 ms（仅 slow 类型） */
  delayMs?: number;
}

export const failureInjectorMiddleware: AgentMiddleware = {
  name: 'FailureInjector',
  hook: 'wrapToolCall',
  priority: 100,
  canShortCircuit: true,

  execute: async (ctx, input, next) => {
    const config = ctx.data['failureInjection'] as FailureInjectionConfig | undefined;

    if (!config?.enabled) return next(input);
    if (config.targetTool && config.targetTool !== input.toolName) return next(input);

    switch (config.faultType) {
      case 'error':
        return { status: 'error', content: 'Injected fault', recoverable: false };
      case 'timeout':
        await new Promise(r => setTimeout(r, 60_000)); // 模拟超时
        return { status: 'error', content: 'Injected timeout', recoverable: false };
      case 'slow':
        await new Promise(r => setTimeout(r, config.delayMs ?? 5000));
        return next(input);
      default:
        return next(input);
    }
  },
};
