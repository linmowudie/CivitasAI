/**
 * @module Core/Patterns/patterns
 * @description
 * 三种**模式**：`PlanAndExecute` · `Workflow` · `GoalGuard`。以及 `DIRECT` 预设。
 *
 * 设计出处：Docs/Dev/L1编排设计/22-执行件-三种模式.md · 04-递归组合与P&E.md ·
 *   21-组装闭环.md（算子闭集）· 19-OuterLoop.md（宿主调用 Executable）
 *
 * **立场：模式不是引擎。** 三者都由组合得到，不新增硬编码分支：
 *   - P&E = 两个执行件 + **完备度门**（两个出口都要有）
 *   - Workflow = 节点图 + **节点门禁**；节点体是**任意执行件**（可递归）
 *   - GoalGuard = **约束件**（工具集为空；**只给建议、不改状态**）
 */

import type { Result } from "../../Infra/types.js";
import { ok, err } from "../../Infra/types.js";
import type {
  Executable,
  ReactInput,
  ReactOutput,
  NeedsDecision,
} from "../Orchestration/outerLoop.js";
import {
  createNodeRunner,
  type NodeOutcome,
  type NodeRunner,
} from "../Orchestration/nodeRunner.js";
import type { LoopScope } from "../Loop/reactLoop.js";
import {
  createGoalEvaluator,
  type Gap,
  type GoalDecl,
  type GoalEvaluator,
  type GoalVerdict,
} from "../Goal/goalEvaluator.js";

// ─────────────────────────────────────────────────────────────
// E2 · PlanAndExecute
// ─────────────────────────────────────────────────────────────

/** plan 半的 required 输出（缺任一 ⇒ 拒绝） */
export interface PlanOutput {
  readonly informationState: "complete" | "partial";
  readonly gaps: readonly Gap[];
  /** 仍在跑、且其结果**会改变计划**的子代 */
  readonly pendingChildren?: readonly string[];
  readonly steps?: readonly string[];
}

export interface PlanGateSpec {
  /** 不完备时怎么办；**两个出口都要有** */
  readonly onMissing: "degrade" | "back_to_plan";
}

export interface PlanAndExecuteDeps {
  readonly plan: Executable;
  readonly execute: Executable;
  readonly gate: PlanGateSpec;
}

function isPlanOutput(v: unknown): v is PlanOutput {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (o.informationState !== "complete" && o.informationState !== "partial")
    return false;
  return Array.isArray(o.gaps);
}

/**
 * P&E：plan → 完备度门 → execute。
 *
 * 门的三条硬约束（各有负向测试）：
 *   1. plan **必须**产出 `informationState` 与 `gaps`（required 输出）。
 *   2. plan 退出时若仍有 `pendingChildren`（结果会改计划）⇒ **不得**进 execute。
 *   3. 不完备且 `onMissing=degrade` ⇒ 放行，但 **gaps 必须传给 execute**。
 */
export function createPlanAndExecute(deps: PlanAndExecuteDeps): Executable {
  const id = "plan&execute";
  return {
    id,
    contract: {
      inputSet: deps.plan.contract.inputSet,
      outputSet: [
        ...new Set([
          ...deps.plan.contract.outputSet,
          ...deps.execute.contract.outputSet,
        ]),
      ],
      toolSet: [
        ...new Set([
          ...deps.plan.contract.toolSet,
          ...deps.execute.contract.toolSet,
        ]),
      ],
      ...(deps.plan.contract.plugins
        ? { plugins: deps.plan.contract.plugins }
        : {}),
    },

    async step(input: ReactInput): Promise<Result<ReactOutput>> {
      const planned = await deps.plan.step(input);
      if (!planned.ok) return planned;

      const planOut = planned.value.produced.plan;
      if (!isPlanOutput(planOut)) {
        return err(
          "plan 缺少 required 输出：信息完备度（informationState）与非空 gaps 数组",
        );
      }

      // ★ 约束 2：未收敛且会影响计划的子代 ⇒ 回调查，不得进 execute
      if (planOut.pendingChildren && planOut.pendingChildren.length > 0) {
        return ok({
          produced: {
            gate: "back_to_plan",
            pendingChildren: planOut.pendingChildren,
          },
          events: [
            ...planned.value.events,
            { type: "plan_gate", decision: "back_to_plan" },
          ],
          needsDecision: [
            {
              event: "iteration.exited",
              payload: { reason: "plan_pending_children" },
            } as NeedsDecision,
          ],
          usage: planned.value.usage,
        });
      }

      let gapsForExecute: readonly Gap[] = planOut.gaps;
      if (planOut.informationState === "partial") {
        if (deps.gate.onMissing === "back_to_plan") {
          return ok({
            produced: { gate: "back_to_plan", gaps: planOut.gaps },
            events: [
              ...planned.value.events,
              { type: "plan_gate", decision: "back_to_plan" },
            ],
            needsDecision: [
              { event: "goal.unmet", payload: { reason: "plan_incomplete" } },
            ],
            usage: planned.value.usage,
          });
        }
        // ★ 约束 3：degrade 放行 —— gaps 必须随输入传给 execute
        gapsForExecute = planOut.gaps;
      }

      const executeInput: ReactInput = {
        ...input,
        observation: {
          ...input.observation,
          upstream: {
            ...input.observation.upstream,
            plan: planOut,
            gaps: gapsForExecute,
          },
        },
      };
      const executed = await deps.execute.step(executeInput);
      if (!executed.ok) return executed;

      return ok({
        produced: {
          ...executed.value.produced,
          plan: planOut,
          gaps: gapsForExecute,
        },
        events: [...planned.value.events, ...executed.value.events],
        needsDecision: [
          ...planned.value.needsDecision,
          ...executed.value.needsDecision,
        ],
        usage: {
          tokens: planned.value.usage.tokens + executed.value.usage.tokens,
          iterations:
            planned.value.usage.iterations + executed.value.usage.iterations,
        },
      });
    },
  };
}

// ─────────────────────────────────────────────────────────────
// E3 · Workflow
// ─────────────────────────────────────────────────────────────

export interface WorkflowNodeSpec {
  readonly id: string;
  /** 节点体 = **任意执行件**（可递归内含 Workflow / P&E / 带 GoalGuard 的件） */
  readonly body: Executable;
  readonly predecessors: readonly string[];
  /** 前驱未收敛时的处置（必填） */
  readonly joinMissing: "block" | "degrade" | "abandon";
}

export interface WorkflowDeps {
  readonly nodes: readonly WorkflowNodeSpec[];
  readonly entry: string;
  /** 单节点最大访问次数（**无界环**的防线） */
  readonly maxNodeVisits?: number;
  /** 嵌套深度声明（**未声明嵌套**的防线） */
  readonly depth: number;
  readonly maxDepth: number;
  /**
   * 本 Workflow **自身**的 `loopId` 作用域。
   *
   * 声明后节点推进**一律经 P3 `NodeRunner`**（唯一派生点：`L` → `L/N1`，grants 收紧、事件带自身 scope）。
   * 未声明时**不派生** —— 本件无权臆造 `loopId`（那正是"第二个派生点"），节点体直接收到父输入。
   */
  readonly scope?: LoopScope;
  /** 注入节点运行器（默认真实实现；注入仅用于确定性测试） */
  readonly runner?: NodeRunner;
}

/**
 * Workflow：图的节点门禁 + 节点推进。节点体是任意执行件（**递归**）。
 *
 * 四条硬约束：
 *   1. 节点体必须是执行件（构造期校验）。
 *   2. **前驱未收敛 ⇒ 不放行**（返回 `dependency.blocked`）。
 *   3. **节点推进不得重建上下文**（只改上游产物，不动恒定区）。
 *   4. **环必须有界**、**嵌套必须声明深度**。
 *   5. 声明了自身 `scope` 时，节点推进**经 P3 `NodeRunner`**：派生 `L/N1`、grants 只能收紧、
 *      事件与计量带**节点自身** scope（不再把父 `ReactInput` 原样透传给子件）。
 */
export function createWorkflow(deps: WorkflowDeps): Result<Executable> {
  if (deps.depth > deps.maxDepth) {
    return err(
      "嵌套深度 " +
        deps.depth +
        " 超过声明上限 " +
        deps.maxDepth +
        "（未声明嵌套）",
    );
  }
  const byId = new Map<string, WorkflowNodeSpec>();
  for (const n of deps.nodes) {
    if (typeof (n.body as { step?: unknown }).step !== "function") {
      return err("节点 " + n.id + " 的 body 不是执行件");
    }
    if (byId.has(n.id)) return err("节点 id 重复: " + n.id);
    byId.set(n.id, n);
  }
  if (!byId.has(deps.entry)) return err("入口节点不存在: " + deps.entry);
  for (const n of deps.nodes) {
    for (const p of n.predecessors) {
      if (!byId.has(p)) return err("节点 " + n.id + " 的前驱不存在: " + p);
    }
  }
  // 节点 id 是 loopId 的派生片段：含分隔符则 `L/a/b` 无法判断切分点
  for (const n of deps.nodes) {
    if (n.id.trim().length === 0) return err("节点 id 不能为空");
    if (n.id.includes("/") || /[\s]/.test(n.id)) {
      return err("节点 id 不得包含 / 或空白字符（loopId 由此派生）: " + n.id);
    }
  }

  const runner = deps.runner ?? createNodeRunner();

  const settled = new Set<string>();
  const visits = new Map<string, number>();
  const maxVisits = deps.maxNodeVisits ?? deps.nodes.length * 4 + 4;
  const order = [...deps.nodes];

  return ok({
    id: "workflow(" + deps.entry + ",depth=" + deps.depth + ")",
    contract: {
      inputSet: order[0]!.body.contract.inputSet,
      outputSet: [
        ...new Set(order.flatMap((n) => [...n.body.contract.outputSet])),
      ],
      toolSet: [...new Set(order.flatMap((n) => [...n.body.contract.toolSet]))],
    },

    async step(input: ReactInput): Promise<Result<ReactOutput>> {
      // 找第一个"前驱都已收敛且自身未收敛"的节点
      const current = order.find(
        (n) =>
          !settled.has(n.id) && n.predecessors.every((p) => settled.has(p)),
      );
      if (!current) {
        const blocked = order.find(
          (n) => !settled.has(n.id) && n.predecessors.length > 0,
        );
        if (blocked && blocked.joinMissing === "block") {
          // ★ 约束 2：前驱未收敛 ⇒ 不放行
          return ok({
            produced: { blockedNode: blocked.id },
            events: [{ type: "workflow_gate", decision: "dependency.blocked" }],
            needsDecision: [
              { event: "dependency.blocked", payload: { node: blocked.id } },
            ],
            usage: { tokens: 0, iterations: 0 },
          });
        }
        return ok({
          produced: { workflowDone: true },
          events: [{ type: "workflow_done" }],
          needsDecision: [],
          usage: { tokens: 0, iterations: 0 },
        });
      }

      const v = (visits.get(current.id) ?? 0) + 1;
      visits.set(current.id, v);
      if (v > maxVisits) {
        return err(
          "节点 " +
            current.id +
            " 访问次数超过上限 " +
            maxVisits +
            "（疑似无界环）",
        );
      }

      // 声明了自身 scope ⇒ 节点推进经 P3（唯一派生点）；未声明 ⇒ 本件无权臆造 loopId，直接调用
      const ran: Result<ReactOutput | NodeOutcome> = deps.scope
        ? await runner.runNode(
            { id: current.id, body: current.body },
            deps.scope,
            input,
          )
        : await current.body.step(input);
      if (!ran.ok) return ran;
      const out = ran.value;

      if (out.produced.node_done === true) settled.add(current.id);

      const nodeLoopId = "scope" in out ? out.scope.loopId : undefined;

      return ok({
        // ★ 约束 3：只改上游产物，**不动恒定区**（恒定区由 ContextAssembler 持有）
        produced: {
          ...out.produced,
          currentNode: current.id,
          settled: [...settled],
          ...(nodeLoopId ? { nodeLoopId } : {}),
        },
        events: [
          ...out.events,
          {
            type: "workflow_node",
            node: current.id,
            ...(nodeLoopId ? { loopId: nodeLoopId } : {}),
          },
        ],
        needsDecision: out.needsDecision,
        usage: out.usage,
      });
    },
  });
}

// ─────────────────────────────────────────────────────────────
// E4 · GoalGuard（约束件）
// ─────────────────────────────────────────────────────────────

/**
 * E4 · GoalGuard = **P2 判定原语 + 插入位置**（§P2 定位：「约束件 = GoalEvaluator + 插入位置」）。
 *
 * 约束件自己的两条纪律：工具集**恒为空**（不执行动作）、判定**只委托**原语（不再内联一套口径）。
 */
export interface GoalGuard {
  readonly goal: GoalDecl;
  /** 工具集恒为空（约束件不执行动作） */
  readonly toolSet: readonly string[];
  readonly evaluator: GoalEvaluator;
  /**
   * `immutableZoneDigest` = **当前**不可变区摘要（由外层观测给出）。
   * 与 Goal 声明的摘要不符 ⇒ 不得判为达成（§P2 反例 5）。
   */
  check(
    produced: Record<string, unknown>,
    immutableZoneDigest: string,
  ): Result<GoalVerdict>;
}

export function createGoalGuard(goal: GoalDecl): Result<GoalGuard> {
  const evaluator = createGoalEvaluator(goal);
  if (!evaluator.ok) return evaluator;
  return ok({
    goal,
    toolSet: [], // 恒为空
    evaluator: evaluator.value,
    check: (produced, immutableZoneDigest) =>
      evaluator.value.evaluate(produced, immutableZoneDigest),
  });
}

/**
 * 把约束件挂在**任意执行件**的出口。
 *
 * 硬约束：
 *   1. 出口若声称达成而约束件判定未达成 ⇒ **报错**（不许"未插约束件却宣称达成"等价行为）。
 *   2. 不可变区摘要由**外层给出**（`digestOf`）——约束件不得自造判定基础（13 §16）。
 */
export function withGoalGuard(
  body: Executable,
  guard: GoalGuard,
  digestOf: (input: ReactInput) => string,
): Executable {
  return {
    id: body.id + "+guard",
    contract: { ...body.contract, toolSet: body.contract.toolSet }, // ★ 不引入任何工具
    async step(input: ReactInput): Promise<Result<ReactOutput>> {
      const out = await body.step(input);
      if (!out.ok) return out;
      const verdict = guard.check(out.value.produced, digestOf(input));
      if (!verdict.ok) return verdict;
      if (
        out.value.produced.goalSatisfied === true &&
        !verdict.value.satisfied
      ) {
        return err(
          "出口声称目标达成，但 GoalGuard 判定未达成（" +
            verdict.value.gaps.map((g) => g.what).join("；") +
            "）—— 拒绝该断言",
        );
      }
      return ok({
        ...out.value,
        produced: { ...out.value.produced, goalVerdict: verdict.value },
        events: [
          ...out.value.events,
          { type: "goal_guard", satisfied: verdict.value.satisfied },
        ],
      });
    },
  };
}

// ─────────────────────────────────────────────────────────────
// RoutingMode 预设（**先 DIRECT**）
// ─────────────────────────────────────────────────────────────
// 模式闭集的**单一真源**：`Core/Decision/types.ts` 的 `ROUTING_MODES`（此处不再复制一份）。

/** `DIRECT` 预设：**单节点 Workflow**（最简模式，先跑绿再迁移其余 5 个） */
export function directPreset(body: Executable): Result<Executable> {
  return createWorkflow({
    nodes: [{ id: "direct", body, predecessors: [], joinMissing: "block" }],
    entry: "direct",
    depth: 0,
    maxDepth: 0,
  });
}

/**
 * 六个模式的预设已全部给出（**不是桩件**）：见 `./presets.ts` 的 `presetDescriptors()` / `presetFor()`。
 *
 * **A/B 对齐的诚实前提**：`DIRECT` / `DELEGATION` / `ASSEMBLY_LINE` / `CONSORTIUM` 在现有实现里有对应行为块
 * （`Src/Core/Decision/orchestrator/orchestrator.ts`），可做 A/B；
 * `LITIGATION` / `REGULATION` 在现有实现里**只有类型与注释（标注 S12）**，**A 侧基线不存在**
 * ⇒ 它们是**新设计**而非迁移，不做也无法做 A/B 对齐（见 `MODES_WITHOUT_BASELINE`）。
 */
