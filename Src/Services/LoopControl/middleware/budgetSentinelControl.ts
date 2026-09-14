/**
 * @module LoopControl/middleware/budgetSentinelControl
 * @description
 * Loop 控制级预算哨兵——Docs/12 §2.3。
 * 与 Core/Middleware/builtin/budgetSentinel.ts（S5 桩）互补：
 * 本模块基于 StopRuleSet 做四阶段预算检测（warm/soft/expand/hard）。
 *
 * 挂载点：afterModel（模型调用后检查预算消耗）。
 */

import type { AgentMiddleware, MiddlewareContext, ModelCallOutput } from '../../../Core/Middleware/types.js';
import type { LoopState } from '../loopState.js';
import type { StopRuleSet } from '../stopRules.js';
import { detectBudgetPhase } from '../stopRules.js';

/** 预算事件回调 */
export interface BudgetEventCallbacks {
  onWarm?: (tokensUsed: number, threshold: number) => void;
  onSoft?: (tokensUsed: number, threshold: number) => void;
  onExpandRequest?: (tokensUsed: number, threshold: number) => void;
  onHard?: (tokensUsed: number, threshold: number) => void;
}

/** 创建控制级预算哨兵中间件 */
export function createBudgetSentinelControlMiddleware(
  getLoopState: () => LoopState | undefined,
  getStopRules: () => StopRuleSet | undefined,
  callbacks: BudgetEventCallbacks = {},
): AgentMiddleware {
  let lastBudgetPhase: 'warm' | 'soft' | 'expand_request' | 'hard' | 'normal' = 'normal';

  return {
    name: 'BudgetSentinelControl',
    hook: 'afterModel',
    priority: 5,
    canShortCircuit: false,

    execute: async (ctx: MiddlewareContext, output: ModelCallOutput) => {
      const state = getLoopState();
      const rules = getStopRules();
      if (!state || !rules) return output;

      // 更新预算使用量
      if (output.usage) {
        state.budgetUsed.tokens += output.usage.inputTokens + output.usage.outputTokens;
      }

      // 检测预算阶段
      const phase = detectBudgetPhase(rules, state.budgetUsed.tokens);

      // 阶段变化时触发回调
      if (phase !== lastBudgetPhase && phase !== 'normal') {
        switch (phase) {
          case 'warm':
            callbacks.onWarm?.(state.budgetUsed.tokens, rules.budget.warmTokens);
            break;
          case 'soft':
            callbacks.onSoft?.(state.budgetUsed.tokens, rules.budget.softTokens);
            // 标记需要降级
            ctx.data['budgetSoftReached'] = true;
            break;
          case 'expand_request':
            callbacks.onExpandRequest?.(state.budgetUsed.tokens, rules.budget.expandRequestTokens);
            ctx.data['budgetExpandRequested'] = true;
            break;
          case 'hard':
            callbacks.onHard?.(state.budgetUsed.tokens, rules.budget.hardTokens);
            ctx.data['budgetHardReached'] = true;
            break;
        }
        lastBudgetPhase = phase;
      }

      return output;
    },
  };
}
