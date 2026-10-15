/**
 * @module Middleware/builtin/budgetSentinel
 * @description
 * 预算哨兵中间件——Docs/Agent/11 循环控制。
 * 监控 Token 消耗，接近预算时**经短路通道终止本轮模型调用**。
 *
 * ## P0-3 + P1-4 修复（2026-10-11 控制论审查）
 *
 * **P0-3（传感器一步滞后）**：原实现只读 `ctx.data['tokensConsumed']`，而该值是
 * `runIteration` ③ 步写入的"**本轮开始前**"累计量 → 反馈信号恒滞后一整轮。
 * 单轮可消耗数十万 token（`agentExecutor` 注释自陈实测 20.8 万），对高增益对象
 * 一步滞后等于无保护：哨兵在 0.95 处读到的仍是 0.95 之前的旧值，下一轮直接穿越硬预算。
 * 现在改读 `上轮累计 + 本轮将发出的 prompt 规模估算`（`estimatedPromptTokens`），
 * 把滞后从一整轮缩到半轮以内。
 *
 * **P1-4（伪成功停机）**：原实现挂在 `wrapModelCall` 上返回
 * `{ content: '[BudgetSentinel] Token 预算即将耗尽，终止调用。' }`——这是一次
 * **看起来完全成功**的模型回答；随后 ⑦ 解析无 `tool_calls`、⑩ 命中
 * `hasOutput && !hadToolCall` → `exitReason: 'success'`，即"预算耗尽"被记为
 * "Agent 给出最终答复，圆满完成"。
 * 现在挂到 `beforeModel`（该钩子**原生支持短路契约**）并返回
 * `{ shortCircuit: true, result: { exitReason: 'budget_exhausted' } }`，
 * 由主循环据此产出显式退出类别。
 */

import type {
  AgentMiddleware,
  MiddlewareContext,
  ModelCallInput,
  ModelCallOutput,
} from "../../../Infra/Contracts/middlewareTypes.js";

export const BUDGET_WARNING_THRESHOLD = 0.8;
export const BUDGET_CRITICAL_THRESHOLD = 0.95;

export const budgetSentinelMiddleware: AgentMiddleware = {
  name: "BudgetSentinel",
  hook: "beforeModel",
  priority: 50,
  canShortCircuit: true,

  execute: async (
    ctx: MiddlewareContext,
    messages: ModelCallInput["messages"],
  ): Promise<
    ModelCallInput["messages"] | { shortCircuit: true; result: ModelCallOutput }
  > => {
    const budget = ctx.data["tokenBudget"] as number | undefined;
    const consumed = ctx.data["tokensConsumed"] as number | undefined;
    const estimatedPrompt = ctx.data["estimatedPromptTokens"] as
      number | undefined;

    // 投影消耗 = 已累计 + 本轮 prompt 规模估算（半轮以内，见模块头 P0-3）
    const projected = (consumed ?? 0) + (estimatedPrompt ?? 0);

    if (budget && budget > 0) {
      const ratio = projected / budget;

      if (ratio >= BUDGET_CRITICAL_THRESHOLD) {
        ctx.data["budgetStatus"] = "critical";
        // 不再返回伪正文：走短路通道 + 显式退出类别（P1-4）
        return {
          shortCircuit: true,
          result: {
            content:
              "[BudgetSentinel] Token 预算即将耗尽，已终止本轮模型调用。",
            usage: { inputTokens: 0, outputTokens: 0 },
            exitReason: "budget_exhausted",
            reason: `budget_critical(${Math.round(projected)}/${budget})`,
          },
        };
      }

      if (ratio >= BUDGET_WARNING_THRESHOLD) {
        ctx.data["budgetStatus"] = "warning";
      }
    }

    return messages;
  },
};
