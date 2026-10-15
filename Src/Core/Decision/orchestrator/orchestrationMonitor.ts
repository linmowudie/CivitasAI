/**
 * @module Decision/Orchestrator/orchestrationMonitor
 * @description
 * 编排**慢环监视器**（《Docs/Agent/17-控制论审查》P1-10 修复）。
 *
 * ## 缺陷形态（修复前）
 *
 * - `progressTracker.detectAllAnomalies` / `checkTimeouts` / `checkStagnation` /
 *   `checkConsecutiveFailures` 全仓**只被测试引用**：没有任何定时器或订阅者调用，
 *   其输出也从未接入 `stopRules` 的 `riskSignals` 或 `SUSPEND`/`EXPEL` 处置；
 * - `EventType.TASK_PROGRESS` **只有订阅方没有发布方** → `currentIteration`/`tokensUsed`
 *   恒为 0，停滞判定唯一可用的"进展"信号也进不来；
 * - 结果：`orchestrator.activePlans` 在某子任务永不终态时永久驻留，
 *   `tasks` 行停在 `running`，**无看门狗、无告警**。
 *
 * ## 现在的闭环
 *
 * ```
 *   周期轮询（stagnationTimeoutMs / 4）
 *        ↓
 *   detectAllAnomalies()        ← 超时 / 停滞 / 连续失败
 *        ↓
 *   发布 TASK_FAILED(assignmentId)  → 既有终态链路落终态 → 触发聚合
 *        ↓
 *   reapStalePlans()            ← activePlans TTL 看门狗
 *        ↓
 *   recordControlTrigger('anomaly_poll_invoked')  ← 元监控：恒 0 即意味着慢环没接上
 * ```
 *
 * 诚实边界：本监视器通过**事件**驱动终态，不直接改写对端进程内 `LoopState.riskSignals`
 * ——LoopState 是进程内对象，跨回路写回需要状态注册表，属独立改造；这里用事件把
 * "异常 → 终态 → 聚合"这条链先闭合。
 */

import {
  detectAllAnomalies,
  TRACKER_THRESHOLDS,
  type AnomalyReport,
} from "./progressTracker.js";
import { reapStalePlans, getActivePlanCount } from "./orchestrator.js";
import { EventType } from "../../../Services/EventBus/eventTypes.js";
import { createEvent, publish } from "../../../Services/EventBus/eventBus.js";
import { recordControlTrigger } from "../../../Infra/Logging/controlTriggers.js";
import { logger } from "../../../Infra/Logging/logger.js";

/** 默认轮询周期 = 停滞阈值 / 4（保证在阈值内至少巡检 4 次） */
export const DEFAULT_MONITOR_INTERVAL_MS = Math.max(
  1_000,
  Math.floor(TRACKER_THRESHOLDS.stagnationTimeoutMs / 4),
);

let timer: ReturnType<typeof setInterval> | null = null;
let intervalMs = DEFAULT_MONITOR_INTERVAL_MS;
let pollCount = 0;
let lastAnomalies: AnomalyReport[] = [];

/**
 * 执行一次巡检（同步、可单测）。
 * @returns 本次检出的异常
 */
export function pollOrchestrationAnomalies(): AnomalyReport[] {
  recordControlTrigger("anomaly_poll_invoked");
  pollCount += 1;

  const anomalies = detectAllAnomalies();
  lastAnomalies = anomalies;

  for (const a of anomalies) {
    publish(
      createEvent({
        eventType: EventType.TASK_FAILED,
        source: "Orchestrator/monitor",
        traceId: "",
        payload: {
          assignmentId: a.assignmentId,
          agentId: a.agentId,
          anomalyType: a.anomalyType,
          severity: a.severity,
          reason: `[慢环监视] ${a.anomalyType}: ${a.detail}`,
        },
      }),
    );
  }

  const reaped = reapStalePlans();

  if (anomalies.length > 0 || reaped > 0) {
    logger.warn("编排慢环巡检发现异常", {
      source: "Orchestrator/monitor",
      anomalies: anomalies.length,
      reapedPlans: reaped,
      activePlans: getActivePlanCount(),
      detail: anomalies.map((a) => `${a.assignmentId}:${a.anomalyType}`),
    });
  }

  return anomalies;
}

/** 启动周期巡检（幂等）；`immediate` 为真时立刻先巡检一次 */
export function startOrchestrationMonitor(
  customIntervalMs: number = DEFAULT_MONITOR_INTERVAL_MS,
  opts: { immediate?: boolean } = {},
): void {
  if (timer) return;
  intervalMs = Math.max(200, customIntervalMs);
  timer = setInterval(() => {
    try {
      pollOrchestrationAnomalies();
    } catch (e) {
      // fail-soft：巡检异常不得掀翻进程
      logger.warn("编排慢环巡检异常（fail-soft）", {
        source: "Orchestrator/monitor",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }, intervalMs);
  // 不阻止进程退出（与后端其余常驻定时器一致）
  if (typeof timer === "object" && timer !== null && "unref" in timer) {
    (timer as { unref: () => void }).unref();
  }
  logger.info("编排慢环监视器已启动", {
    source: "Orchestrator/monitor",
    intervalMs,
  });
  if (opts.immediate) pollOrchestrationAnomalies();
}

/** 停止巡检 */
export function stopOrchestrationMonitor(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

export function isOrchestrationMonitorRunning(): boolean {
  return timer !== null;
}

/** 监视器状态（诊断 / 测试 / 元监控） */
export function getOrchestrationMonitorStats(): {
  running: boolean;
  intervalMs: number;
  pollCount: number;
  lastAnomalies: AnomalyReport[];
  activePlans: number;
} {
  return {
    running: timer !== null,
    intervalMs,
    pollCount,
    lastAnomalies: lastAnomalies.map((a) => ({ ...a })),
    activePlans: getActivePlanCount(),
  };
}

/** 重置（测试用） */
export function resetOrchestrationMonitor(): void {
  stopOrchestrationMonitor();
  pollCount = 0;
  lastAnomalies = [];
  intervalMs = DEFAULT_MONITOR_INTERVAL_MS;
}
