/**
 * @module Middleware/builtin/goalReanchor
 * @description
 * GoalReanchor 中间件——Docs/Agent/02 §4.4 / §5.4。
 * 上下文压缩后必须在下一轮开头重新锚定目标。
 * 挂载点：beforeModel（priority=10，最先执行）。
 */

import type {
  AgentMiddleware,
  MiddlewareContext,
  ModelCallInput,
} from "../../../Infra/Contracts/middlewareTypes.js";
import { recordControlTrigger } from "../../../Infra/Logging/controlTriggers.js";

export const goalReanchorMiddleware: AgentMiddleware = {
  name: "GoalReanchor",
  hook: "beforeModel",
  priority: 10,
  canShortCircuit: false,

  execute: async (
    ctx: MiddlewareContext,
    messages: ModelCallInput["messages"],
  ) => {
    // 检查是否需要重锚定（上下文压缩后设置标记）
    const needsReanchor = ctx.data["needsGoalReanchor"] === true;
    if (!needsReanchor) return messages;

    // P1-7：闩锁**无条件清零**。
    // 修复前清零语句写在 `if (goal)` 分支之后且只在 `!goal` 时可达——
    // 于是一旦置位就每轮重复注入同一条重锚消息（标记永不被消费）。
    ctx.data["needsGoalReanchor"] = false;

    const goal = ctx.data["currentGoal"] as string | undefined;
    if (!goal) return messages;

    recordControlTrigger("goal_reanchor_injected");
    return [
      {
        role: "system",
        content: `[GoalReanchor] 上下文已压缩。当前目标：${goal}。请继续执行。`,
      },
      ...messages,
    ];
  },
};
