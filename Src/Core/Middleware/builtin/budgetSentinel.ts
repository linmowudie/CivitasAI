/**
 * @module Middleware/builtin/budgetSentinel
 * @description
 * 预算哨兵中间件——Docs/12 循环控制。
 * 监控 Token 消耗，接近预算时发出警告。
 * 挂载点：wrapModelCall（priority=50，最外层包裹）。
 */

import type { AgentMiddleware, MiddlewareContext, ModelCallInput, ModelCallOutput } from '../types.js';

export const BUDGET_WARNING_THRESHOLD = 0.8;
export const BUDGET_CRITICAL_THRESHOLD = 0.95;

export const budgetSentinelMiddleware: AgentMiddleware = {
  name: 'BudgetSentinel',
  hook: 'wrapModelCall',
  priority: 50,
  canShortCircuit: true,

  execute: async (ctx, input, next) => {
    const budget = ctx.data['tokenBudget'] as number | undefined;
    const consumed = ctx.data['tokensConsumed'] as number | undefined;

    if (budget && consumed !== undefined) {
      const ratio = consumed / budget;

      if (ratio >= BUDGET_CRITICAL_THRESHOLD) {
        ctx.data['budgetStatus'] = 'critical';
        // 关键：拒绝调用，返回空结果
        return {
          content: '[BudgetSentinel] Token 预算即将耗尽，终止调用。',
          toolCalls: undefined,
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      }

      if (ratio >= BUDGET_WARNING_THRESHOLD) {
        ctx.data['budgetStatus'] = 'warning';
      }
    }

    return next(input);
  },
};
