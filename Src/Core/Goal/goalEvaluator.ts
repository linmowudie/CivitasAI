/**
 * @module Core/Goal/goalEvaluator
 * @description
 * P2 · `GoalEvaluator` —— **纯判定原语**：目标是否达成 / 压缩后是否必须重锚。
 *
 * 设计出处：Docs/Dev/L1编排设计/23-原语补齐与监管快照.md §P2（接口与两条硬约束逐条对应）
 *   · [14-核心层组件总表](../../../../Docs/Dev/L1编排设计/14-核心层组件总表.md) §1 的 P2 项
 *   · 抽取自 `Patterns/patterns.ts` 的 GoalGuard 判定体（§P2「不改行为，先同形化」）
 *
 * 两条硬约束：
 *   1. **不持有状态**：无实例状态 ⇒ 同一 Goal + 同一 produced + 同一摘要必得同一结论（可复算）
 *   2. **不改状态**：`suggestion` 只是建议，状态转移归 C1 `LifecycleController`（13 §16）
 */

import type { Result } from "../../Infra/types.js";
import { ok, err } from "../../Infra/types.js";

/** 缺口：未达成时差什么（§P2 `GoalVerdict.gaps`） */
export interface Gap {
  readonly what: string;
  readonly owner?: string;
}

/**
 * Goal 声明。判定口径与不可变区摘要**都是必填**：
 * 缺口径 ⇒ 无法判定达成（03 §6 闭包判据）；缺摘要 ⇒ 无法校验不可变区是否被改（ADR-0005）。
 */
export interface GoalDecl {
  readonly id: string;
  readonly statement: string;
  readonly criteria: string;
  readonly immutableZoneDigest: string;
}

/** §P2 的 `suggestion` 取值闭集（不含 success —— success 只由外层从"全部收敛"推出） */
export type GoalSuggestion = "running" | "terminate" | "degrade";

export interface GoalVerdict {
  readonly satisfied: boolean;
  readonly gaps: readonly Gap[];
  readonly suggestion: GoalSuggestion;
  /** 如实转记既有信号 `needsGoalReanchor`（⑤ 步压缩成功后置位） */
  readonly needsReanchor: boolean;
}

export interface GoalEvaluator {
  readonly goal: GoalDecl;
  evaluate(
    produced: Record<string, unknown>,
    immutableZoneDigest: string,
  ): Result<GoalVerdict>;
}

/**
 * 创建判定原语。
 *
 * `ports` 一律拒绝（§P2 反例 1：原语**不执行动作**来"验证"目标）——
 * 保留该形参只是为了让"塞进执行端口"这件事在构造期就被抓住，而不是悄悄忽略。
 */
export function createGoalEvaluator(
  goal: GoalDecl,
  ports?: Record<string, unknown>,
): Result<GoalEvaluator> {
  if (!goal.criteria || goal.criteria.trim().length === 0) {
    return err("Goal 未声明判定口径（无法判定是否达成）");
  }
  if (
    !goal.immutableZoneDigest ||
    goal.immutableZoneDigest.trim().length === 0
  ) {
    return err("Goal 未声明不可变区摘要（无法校验不可变区是否被改）");
  }
  if (ports && Object.keys(ports).length > 0) {
    return err(
      "GoalEvaluator 是纯判定原语，不接受执行/副作用端口：" +
        Object.keys(ports).join(", "),
    );
  }
  return ok({
    goal,
    evaluate: (produced, immutableZoneDigest) =>
      evaluateGoal({ goal, produced, immutableZoneDigest }),
  });
}

/**
 * 判定本体（纯函数：入参全为数据，出参为结论）。
 *
 * §P2 反例对应：
 *   #3 未声明口径 ⇒ 构造期已拒（见 `createGoalEvaluator`）
 *   #4 不可复算 ⇒ 本函数不读任何外部态（测试用两次调用比对）
 *   #5 忽略不可变区摘要 ⇒ 摘要漂移时**不得**判为达成
 */
export function evaluateGoal(input: {
  readonly goal: GoalDecl;
  readonly produced: Record<string, unknown>;
  readonly immutableZoneDigest: string;
}): Result<GoalVerdict> {
  const { goal, produced } = input;
  const digest = input.immutableZoneDigest;
  if (typeof digest !== "string" || digest.trim().length === 0) {
    return err("必须传入当前不可变区摘要（缺摘要不得判定为达成）");
  }
  const needsReanchor = produced["needsGoalReanchor"] === true;

  if (digest !== goal.immutableZoneDigest) {
    return ok({
      satisfied: false,
      gaps: [
        {
          what:
            "不可变区摘要与声明不符（声明 " +
            goal.immutableZoneDigest +
            "，实测 " +
            digest +
            "）",
          owner: goal.id,
        },
      ],
      // 设计未规定漂移时的建议取值；此处取 `degrade`：判定基础已被污染，
      // 既不能继续当没事（running），更不能收口（terminate）。
      suggestion: "degrade",
      needsReanchor,
    });
  }

  const claimed = produced["goalSatisfied"] === true;
  const evidence =
    typeof produced["evidence"] === "string" && produced["evidence"].length > 0;
  const satisfied = claimed && evidence;

  const gaps: Gap[] = [];
  if (claimed && !evidence) {
    gaps.push({ what: "声称达成但缺少证据（evidence）", owner: goal.id });
  } else if (!satisfied) {
    gaps.push({ what: "缺少达成证据（evidence）或未声明达成", owner: goal.id });
  }

  return ok({
    satisfied,
    gaps,
    suggestion: satisfied ? "terminate" : "running",
    needsReanchor,
  });
}
