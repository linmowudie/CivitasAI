/**
 * @module LoopControl/middleware/goalReanchorControl
 * @description
 * Loop 控制级 GoalReanchor 中间件——Docs/12 §4.3。
 * 与 Core/Middleware/builtin/goalReanchor.ts（S5 桩）互补：
 * - S5 桩：基于 MiddlewareContext.data 标记的简单重锚
 * - 本模块：基于 LoopState 的完整重锚（含失败策略注入）
 *
 * 每 K 轮或上下文压缩后，强制重新锚定目标。
 */

import type { AgentMiddleware, MiddlewareContext } from '../../../Infra/Contracts/middlewareTypes.js';
import type { LoopState } from '../loopState.js';

/** 控制级 GoalReanchor 配置 */
export interface GoalReanchorControlConfig {
  reanchorEveryRounds: number;
  alwaysOnAfterCompression: boolean;
  injectRecentFailedStrategiesCount: number;
}

const DEFAULT_CONFIG: GoalReanchorControlConfig = {
  reanchorEveryRounds: 5,
  alwaysOnAfterCompression: true,
  injectRecentFailedStrategiesCount: 5,
};

/**
 * 创建控制级 GoalReanchor 中间件
 */
export function createGoalReanchorControlMiddleware(
  getLoopState: () => LoopState | undefined,
  config: Partial<GoalReanchorControlConfig> = {},
): AgentMiddleware {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  return {
    name: 'GoalReanchorControl',
    hook: 'beforeModel',
    priority: 5,  // 比 S5 桩（priority=10）先执行
    canShortCircuit: false,

    execute: async (ctx: MiddlewareContext, messages) => {
      const state = getLoopState();
      if (!state) return messages;

      const needsReanchor =
        ctx.iteration % cfg.reanchorEveryRounds === 0 ||
        (cfg.alwaysOnAfterCompression && ctx.data['needsGoalReanchor'] === true);

      if (!needsReanchor) return messages;

      // 构建重锚定提示
      const parts: string[] = [
        '【任务原始目标（不可修改，仅可参考）】',
        state.goal.originalRequirement,
      ];

      if (state.goal.immutableConstraints.length > 0) {
        parts.push('【不可违背约束】');
        parts.push(...state.goal.immutableConstraints.map(c => `- ${c}`));
      }

      const recentFailures = state.failedAttempts.slice(-cfg.injectRecentFailedStrategiesCount);
      if (recentFailures.length > 0) {
        parts.push('【已尝试且失败的策略】');
        parts.push(...recentFailures.map(f =>
          `- 迭代 ${f.iteration}：${f.strategy} → ${f.failureCategory}（避免重复）`,
        ));
      }

      const reanchorMsg = {
        role: 'system',
        content: parts.join('\n'),
      };

      // 清除压缩标记
      ctx.data['needsGoalReanchor'] = false;

      return [reanchorMsg, ...messages];
    },
  };
}
