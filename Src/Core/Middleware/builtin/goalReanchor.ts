/**
 * @module Middleware/builtin/goalReanchor
 * @description
 * GoalReanchor 中间件——Docs/02 §4.4 / §5.4。
 * 上下文压缩后必须在下一轮开头重新锚定目标。
 * 挂载点：beforeModel（priority=10，最先执行）。
 */

import type { AgentMiddleware, MiddlewareContext } from '../../../Infra/Contracts/middlewareTypes.js';

export const goalReanchorMiddleware: AgentMiddleware = {
  name: 'GoalReanchor',
  hook: 'beforeModel',
  priority: 10,
  canShortCircuit: false,

  execute: async (ctx: MiddlewareContext, messages) => {
    // 检查是否需要重锚定（上下文压缩后设置标记）
    const needsReanchor = ctx.data['needsGoalReanchor'] as boolean | undefined;

    if (needsReanchor) {
      // 在消息头部注入目标重锚定提示
      const goal = ctx.data['currentGoal'] as string | undefined;
      if (goal) {
        const reanchorMsg = {
          role: 'system',
          content: `[GoalReanchor] 上下文已压缩。当前目标：${goal}。请继续执行。`,
        };
        return [reanchorMsg, ...messages];
      }
      // 清除标记
      ctx.data['needsGoalReanchor'] = false;
    }

    return messages;
  },
};
