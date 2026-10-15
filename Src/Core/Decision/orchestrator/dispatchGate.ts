/**
 * @module Decision/Orchestrator/dispatchGate
 * @description
 * 编排**派发闸门**——让 `dependsOn` 与 `maxParallelism` 真正有执行器
 * （《Docs/Agent/17-控制论审查》P1-9 修复）。
 *
 * ## 缺陷形态（修复前）
 *
 * `taskDecomposer` 计算并写入 `maxParallelism`（`calculateMaxParallelism`）与
 * `dependsOn`（`findDependencyIndexes`），但 `orchestrator` 的
 * `executeDelegation` / `executeConsortium` 在 `for (const assignment of taskPlan.assignments)`
 * 里**无条件同步派发全部子任务**，两个字段均不消费；
 * `executeAssemblyLine` 先串好 `curr.dependsOn = [prev.assignmentId]`，随后同样全量派发
 * ——**流水线不是流水线，是扇出**。四种路由模式对真实动力学的唯一差别是创建的 Agent 角色名，
 * 即"控制器输出未连接到被控对象输入"（控制增益 ≈ 0）。
 *
 * ## 现在的语义
 *
 * ```
 *   registerDispatchPlan(taskId, items, maxParallelism)
 *        ↓ 派发「依赖已满足」的前 N 项（N = maxParallelism）
 *   pump()
 *        ↓ 子任务进入终态（TASK_COMPLETED / TASK_FAILED）
 *   释放后继 → 继续 pump()
 * ```
 *
 * 关键取舍：**保持非阻塞**。派发方（`executeDelegation` 等）仍然立刻返回，
 * 只是"何时派发第 k 批"改由终态事件驱动——不改变编排的对外契约，
 * 却把依赖序与并发上限接上了执行器。
 */

import { EventType } from "../../../Services/EventBus/eventTypes.js";
import { subscribe } from "../../../Services/EventBus/eventBus.js";
import type { Subscription } from "../../../Services/EventBus/eventTypes.js";
import { logger } from "../../../Infra/Logging/logger.js";

/** 一个待派发项：`dependsOn` 满足后调用 `dispatch()` 真正派发 */
export interface PendingDispatch {
  assignmentId: string;
  /** 前置子任务 id（空 = 首波） */
  dependsOn: string[];
  /** 真正派发（创建 Agent / assignTask / dispatchSubtask / 发布 TASK_ASSIGNED） */
  dispatch: () => void;
  /**
   * 前置子任务**失败**导致本项永不就绪时的回调（把子任务如实落"失败"终态，
   * 而不是挂在 pending 里等 TTL 看门狗）。缺省则只记日志。
   */
  onBlocked?: (reason: string) => void;
}

interface PlanState {
  taskId: string;
  maxParallelism: number;
  pending: Map<string, PendingDispatch>;
  inFlight: Set<string>;
  terminal: Set<string>;
  /** 进入终态且为**失败**的子任务（用于阻断其后继） */
  failed: Set<string>;
}

const plans = new Map<string, PlanState>();
let subscriptions: Subscription[] = [];

/**
 * 确保闸门订阅在册。
 *
 * 注意：这里**不做一次性初始化标记**——事件总线可被 `resetEventBus()` 整体清空
 * （测试隔离 / 运行期重置），旧订阅句柄随即失效；用"已初始化"标志会留下幽灵订阅，
 * 闸门从此再也收不到终态事件（正是本函数要避免的"恒不触发"形态）。
 * 每次注册计划时重建一次订阅即可：任意时刻恰好两条，代价可忽略。
 */
function ensureSubscribed(): void {
  for (const sub of subscriptions) sub.unsubscribe();
  subscriptions = [
    subscribe(EventType.TASK_COMPLETED, (e) =>
      onTerminal(e.payload.assignmentId as string | undefined, false),
    ),
    subscribe(EventType.TASK_FAILED, (e) =>
      onTerminal(e.payload.assignmentId as string | undefined, true),
    ),
  ];
}

function onTerminal(assignmentId: string | undefined, failed: boolean): void {
  if (!assignmentId) return;
  for (const plan of plans.values()) {
    if (!plan.inFlight.has(assignmentId) && !plan.pending.has(assignmentId))
      continue;
    plan.inFlight.delete(assignmentId);
    plan.pending.delete(assignmentId);
    plan.terminal.add(assignmentId);
    if (failed) plan.failed.add(assignmentId);
    pump(plan);
  }
}

/**
 * 注册一张计划的派发闸门（同 taskId 重复注册以最后一次为准）。
 * @param maxParallelism 并发上限（<=0 视为 1）
 */
export function registerDispatchPlan(
  taskId: string,
  items: PendingDispatch[],
  maxParallelism: number,
): void {
  ensureSubscribed();
  const plan: PlanState = {
    taskId,
    maxParallelism: Math.max(1, Math.floor(maxParallelism) || 1),
    pending: new Map(items.map((i) => [i.assignmentId, i])),
    inFlight: new Set(),
    terminal: new Set(),
    failed: new Set(),
  };
  plans.set(taskId, plan);
  pump(plan);
}

/** 释放就绪项直到并发上限（幂等；可由终态事件或显式调用触发） */
function pump(plan: PlanState): number {
  let dispatched = 0;
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const [assignmentId, item] of [...plan.pending]) {
      // ① 前置**失败** → 本项永不就绪：如实落失败终态并回调（不等 TTL 看门狗）。
      //    必须放在并发上限判断之前——否则上限占满时这些项会被漏处理。
      const blockedBy = item.dependsOn.find((dep) => plan.failed.has(dep));
      if (blockedBy !== undefined) {
        plan.pending.delete(assignmentId);
        plan.terminal.add(assignmentId);
        plan.failed.add(assignmentId);
        logger.warn("派发闸门：前置子任务失败，后继不再派发", {
          source: "Orchestrator/dispatchGate",
          taskId: plan.taskId,
          assignmentId,
          blockedBy,
        });
        try {
          item.onBlocked?.(`前置子任务 ${blockedBy} 失败`);
        } catch {
          /* fail-soft：标记失败本身不得再抛 */
        }
        progressed = true;
        continue;
      }

      // ② 并发上限
      if (plan.inFlight.size >= plan.maxParallelism) break;

      // ③ 依赖序：全部前置必须已进入终态
      if (!item.dependsOn.every((dep) => plan.terminal.has(dep))) continue;

      plan.pending.delete(assignmentId);
      plan.inFlight.add(assignmentId);
      try {
        item.dispatch();
      } catch (e) {
        // fail-soft：单项派发异常不得卡死整张计划——计入终态（视为失败）以释放/阻断后继
        logger.warn("派发闸门：单项派发异常（按失败计入终态以释放后继）", {
          source: "Orchestrator/dispatchGate",
          taskId: plan.taskId,
          assignmentId,
          error: e instanceof Error ? e.message : String(e),
        });
        plan.inFlight.delete(assignmentId);
        plan.terminal.add(assignmentId);
        plan.failed.add(assignmentId);
      }
      dispatched += 1;
      progressed = true;
    }
  }
  return dispatched;
}

/** 显式 pump（测试与异常路径用） */
export function pumpDispatch(taskId: string): number {
  const plan = plans.get(taskId);
  return plan ? pump(plan) : 0;
}

/** 计划闸门状态（诊断 / 测试 / 慢环监视） */
export function getDispatchPlanState(taskId: string):
  | {
      pending: number;
      inFlight: number;
      terminal: number;
      maxParallelism: number;
    }
  | undefined {
  const plan = plans.get(taskId);
  if (!plan) return undefined;
  return {
    pending: plan.pending.size,
    inFlight: plan.inFlight.size,
    terminal: plan.terminal.size,
    maxParallelism: plan.maxParallelism,
  };
}

/** 当前驻留闸门数 */
export function getDispatchPlanCount(): number {
  return plans.size;
}

/** 清理一张计划（聚合收尾后调用） */
export function releaseDispatchPlan(taskId: string): void {
  plans.delete(taskId);
}

/** 重置（测试用） */
export function resetDispatchGate(): void {
  plans.clear();
  for (const sub of subscriptions) sub.unsubscribe();
  subscriptions = [];
}
