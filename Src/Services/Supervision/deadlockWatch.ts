/**
 * @module Supervision/deadlockWatch
 * @description 互等死锁看门（SUP-ENV-DEADLOCKWIRE，设计 §3.3）。
 *
 * 设计口径：**互等死锁必须有检测方，命中即按风险退出，不得挂起**。
 *
 * 背景（矩阵 cell 复现）：产品侧此前只有仲裁庭的"三种不同裁决 = deadlocked"
 * 这一语义层判定，**没有任何运行期死锁检测入口** —— 两个 Agent 互等资源时
 * 循环会一直等下去（或直到超时），观测面上也看不到"死锁"这一退出原因。
 *
 * 本模块提供：
 * - 等待关系登记表（服务在真正阻塞等待前 `registerAgentWait`，恢复后 `clearAgentWait`）；
 * - `detectDeadlock(pairs)`：有向图环检测（支持 A↔B 与多跳环）；
 * - `checkLoopDeadlock(input)`：运行期入口 —— 检出即留痕（治理台账）+ 发
 *   `arbitration:deadlock` 事件 + 告警，供循环按 `risk` 退出。
 */

import { ok } from "../../Infra/types.js";
import type { Result } from "../../Infra/types.js";
import { publish, createEvent } from "../EventBus/eventBus.js";
import { EventType } from "../EventBus/eventTypes.js";
import { recordGovernanceAction } from "../Governance/governanceAudit.js";
import { logger } from "../../Infra/Logging/logger.js";

/** 一条等待关系：`waiter` 正在等 `waitingFor`（可选资源标识用于留痕） */
export interface WaitPair {
  waiter: string;
  waitingFor: string;
  resource?: string;
}

/** 死锁检测结果 */
export interface DeadlockCheckResult {
  deadlocked: boolean;
  /** 检出的环（首尾同一节点；无死锁为 []） */
  cycle: string[];
}

/**
 * 运行期等待登记表：`waiter\0waitingFor` → 等待关系。
 *
 * 用复合键而非 `waiter` 单键：同一 Agent 可能并发等待多个目标（多个审批/多个对端），
 * 单键会被覆盖，导致"清一个等待把其它边一起抹掉"。
 */
const waits = new Map<string, WaitPair>();

function waitKey(waiter: string, waitingFor: string): string {
  return `${waiter}\u0000${waitingFor}`;
}

/** 登记一条等待关系（真正阻塞等待前调用） */
export function registerAgentWait(
  waiter: string,
  waitingFor: string,
  resource?: string,
): void {
  waits.set(waitKey(waiter, waitingFor), {
    waiter,
    waitingFor,
    ...(resource ? { resource } : {}),
  });
}

/** 清除等待关系（不传 waitingFor 时清除该 Agent 的全部等待边） */
export function clearAgentWait(waiter: string, waitingFor?: string): void {
  if (waitingFor !== undefined) {
    waits.delete(waitKey(waiter, waitingFor));
    return;
  }
  for (const [key, pair] of waits) {
    if (pair.waiter === waiter) waits.delete(key);
  }
}

/** 当前登记的全部等待关系（快照） */
export function collectWaitingPairs(): WaitPair[] {
  return [...waits.values()].map((p) => ({ ...p }));
}

/** 重置（测试用） */
export function resetDeadlockWatch(): void {
  waits.clear();
}

/**
 * 有向图环检测 —— 存在环即判定互等死锁。
 *
 * 返回环路径（首尾同节点）；无环返回 []。
 * 只做纯函数判定，不产生任何副作用（供离线复核与实验直接构造样本）。
 */
export function findDeadlockCycle(pairs: readonly WaitPair[]): string[] {
  const graph = new Map<string, string[]>();
  for (const p of pairs) {
    const edges = graph.get(p.waiter) ?? [];
    edges.push(p.waitingFor);
    graph.set(p.waiter, edges);
  }

  const state = new Map<string, 1 | 2>(); // 1 = 在栈中，2 = 已完成
  const stack: string[] = [];

  const dfs = (node: string): string[] | null => {
    const s = state.get(node);
    if (s === 1) {
      const idx = stack.indexOf(node);
      return [...stack.slice(idx), node];
    }
    if (s === 2) return null;
    state.set(node, 1);
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      const cycle = dfs(next);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(node, 2);
    return null;
  };

  for (const node of graph.keys()) {
    const cycle = dfs(node);
    if (cycle) return cycle;
  }
  return [];
}

/** 是否存在互等死锁（纯判定） */
export function detectDeadlock(pairs: readonly WaitPair[]): boolean {
  return findDeadlockCycle(pairs).length > 0;
}

/**
 * 运行期死锁看门入口（循环每轮调用）。
 *
 * - 无等待关系 / 无环 → `{ deadlocked: false }`；
 * - 检出环 → 留痕 + 事件 + 告警，返回 `{ deadlocked: true, cycle }`，调用方据此按
 *   `risk` 退出（**不得挂起**）。
 *
 * 观测动作全部 fail-soft：留痕/事件失败只记日志，绝不让看门本身抛出——
 * 否则"为观测而死锁检测失败"会变成新的挂起源。
 */
export function checkLoopDeadlock(
  input: { loopId?: string; waitingPairs?: readonly WaitPair[] } = {},
): Result<DeadlockCheckResult> {
  const pairs = input.waitingPairs ?? collectWaitingPairs();
  if (pairs.length === 0) return ok({ deadlocked: false, cycle: [] });

  const cycle = findDeadlockCycle(pairs);
  if (cycle.length === 0) return ok({ deadlocked: false, cycle: [] });

  const detail = `互等死锁检出：${cycle.join(" → ")}`;
  try {
    recordGovernanceAction({
      action: "arbitration.suspension",
      actorRole: "supervision",
      outcome: "allowed",
      reason: detail,
      ...(input.loopId ? { traceId: input.loopId } : {}),
    });
  } catch (e) {
    logger.warn("死锁留痕失败（不影响风险退出）", {
      source: "deadlockWatch/checkLoopDeadlock",
      error: e instanceof Error ? e.message : String(e),
    });
  }
  try {
    publish(
      createEvent({
        eventType: EventType.ARBITRATION_DEADLOCK,
        source: "Supervision/deadlockWatch",
        payload: { cycle, loopId: input.loopId ?? null },
      }),
    );
  } catch (e) {
    logger.warn("死锁事件发布失败（不影响风险退出）", {
      source: "deadlockWatch/checkLoopDeadlock",
      error: e instanceof Error ? e.message : String(e),
    });
  }
  logger.warn("检测到互等死锁，按风险退出（不得挂起）", {
    source: "deadlockWatch/checkLoopDeadlock",
    cycle,
    loopId: input.loopId ?? null,
  });

  return ok({ deadlocked: true, cycle });
}
