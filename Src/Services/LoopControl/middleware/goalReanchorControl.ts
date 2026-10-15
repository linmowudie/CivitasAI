/**
 * @module LoopControl/middleware/goalReanchorControl
 * @description
 * Loop 控制级 GoalReanchor 中间件——Docs/Agent/11 §4.3。
 * 与 Core/Middleware/builtin/goalReanchor.ts（S5 桩）互补：
 * - S5 桩：基于 MiddlewareContext.data 标记的简单重锚
 * - 本模块：基于 LoopState 的完整重锚（含失败策略注入）
 *
 * 每 K 轮或上下文压缩后，强制重新锚定目标。
 */

import type {
  AgentMiddleware,
  MiddlewareContext,
  ModelCallInput,
} from "../../../Infra/Contracts/middlewareTypes.js";
import type { ControlLoopStateView } from "../../../Infra/Contracts/loopStateTypes.js";
import { recordControlTrigger } from "../../../Infra/Logging/controlTriggers.js";

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
 * 创建控制级 GoalReanchor 中间件。
 *
 * @param getLoopState 状态访问器（测试用）。生产不传——此时从 `ctx.data['loopState']`
 *   读取（`runIteration` 每轮注入本 Loop 的 LoopState）。
 *
 * P2-11：状态类型从 `Services/LoopControl/loopState` 的 `LoopState` 改为跨层契约
 * `ControlLoopStateView`，因此 `Core/Loop/loopEngine` 的运行态**可以直接被本控制器消费**——
 * 修复前完整版重锚器只能拿到测试里构造的那套状态对象，故无法注册进生产。
 */
export function createGoalReanchorControlMiddleware(
  getLoopState?: () => ControlLoopStateView | undefined,
  config: Partial<GoalReanchorControlConfig> = {},
): AgentMiddleware {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  return {
    name: "GoalReanchorControl",
    hook: "beforeModel",
    priority: 5, // 比 S5 桩（priority=10）先执行：先处理压缩置位的重锚，桩便不会重复注入
    canShortCircuit: false,

    execute: async (
      ctx: MiddlewareContext,
      messages: ModelCallInput["messages"],
    ) => {
      const state =
        getLoopState?.() ??
        (ctx.data["loopState"] as ControlLoopStateView | undefined);
      if (!state) return messages;

      const compressionFlag =
        ctx.data["needsGoalReanchor"] === true ||
        state.needsGoalReanchor === true;
      const byRound =
        cfg.reanchorEveryRounds > 0 &&
        ctx.iteration % cfg.reanchorEveryRounds === 0;
      const needsReanchor =
        byRound || (cfg.alwaysOnAfterCompression && compressionFlag);

      // P1-7：闩锁**无条件清零**。修复前清零语句位于 `goal` 缺失分支之后，
      // 一旦置位就每轮重复注入（且不注入时标记永不清），两条路都是错的。
      if (compressionFlag) {
        ctx.data["needsGoalReanchor"] = false;
        state.needsGoalReanchor = false;
      }

      if (!needsReanchor) return messages;

      // 构建重锚定提示
      const parts: string[] = [
        "【任务原始目标（不可修改，仅可参考）】",
        state.goal.originalRequirement,
      ];

      if (state.goal.immutableConstraints.length > 0) {
        parts.push("【不可违背约束】");
        parts.push(...state.goal.immutableConstraints.map((c) => `- ${c}`));
      }

      const recentFailures = state.failedAttempts.slice(
        -cfg.injectRecentFailedStrategiesCount,
      );
      if (recentFailures.length > 0) {
        parts.push("【已尝试且失败的策略】");
        parts.push(
          ...recentFailures.map(
            (f) =>
              `- 迭代 ${f.iteration}：${f.strategy} → ${f.failureCategory}（避免重复）`,
          ),
        );
      }

      const reanchorMsg = {
        role: "system",
        content: parts.join("\n"),
      };

      recordControlTrigger("goal_reanchor_injected");
      return [reanchorMsg, ...messages];
    },
  };
}
