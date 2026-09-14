/**
 * @module LoopControl/middleware/stopRuleEvaluator
 * @description
 * 退出规则评估中间件——Docs/12 §2.2。
 * 每轮迭代末尾评估五类退出条件。
 *
 * 挂载点：afterAgent（Agent 一轮执行结束后）。
 */

import type { AgentMiddleware, MiddlewareContext } from '../../../Core/Middleware/types.js';
import type { LoopState } from '../loopState.js';
import type { StopRuleSet, LoopRuntimeSnapshot, StopDecision } from '../stopRules.js';
import { evaluateStopRules } from '../stopRules.js';

/** 退出事件回调 */
export interface StopRuleCallbacks {
  onStop?: (decision: StopDecision) => void;
}

/** 创建退出规则评估中间件 */
export function createStopRuleEvaluatorMiddleware(
  getLoopState: () => LoopState | undefined,
  getStopRules: () => StopRuleSet | undefined,
  getSnapshot: () => LoopRuntimeSnapshot | undefined,
  callbacks: StopRuleCallbacks = {},
): AgentMiddleware {
  return {
    name: 'StopRuleEvaluator',
    hook: 'afterAgent',
    priority: 1,  // 最先执行
    canShortCircuit: false,

    execute: async (ctx: MiddlewareContext, result: unknown) => {
      const state = getLoopState();
      const rules = getStopRules();
      const snapshot = getSnapshot();
      if (!state || !rules || !snapshot) return;

      const decision = evaluateStopRules(rules, state, snapshot);

      if (decision.shouldStop) {
        // 记录退出原因到 state
        state.phase = decision.reason === 'success' ? 'completed' : 'failed';
        ctx.data['loopStopped'] = true;
        ctx.data['loopStopReason'] = decision.reason;
        ctx.data['loopStopDetail'] = decision.detail;

        callbacks.onStop?.(decision);
      }
    },
  };
}
