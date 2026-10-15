/**
 * @module Infra/Logging/controlTriggers
 * @description
 * 控制回路**触发计数表**（《Docs/Agent/17-控制论审查》§3「元监控」建议 13）。
 *
 * 要解决的问题：
 * P0-1 / P1-5 / P1-6 / P1-10 四个缺陷有**同一形态**——代码存在、契约正确、单测通过、
 * 运行期零触发。现有测试体系无法区分「这条断言恒假」与「这条断言从未被调用」。
 *
 * 判定规则（写进启动自检与 `getLoopSummary()`）：
 *   **任一计数器长期为 0 ⇒ 该回路断线**（而不是"恰好好久没触发"）。
 *
 * 为什么放在 `Infra/`：这张表要被 Core（Loop / Middleware / Decision）、Services
 * （LoopControl 的审批门）、以及组合根 `main.ts` **同时**写入，而五层红线不允许
 * Services → Core。放在最底层的基础设施里，全部上层都能**向下**依赖（与 ADR-0006 同思路）。
 */

/** 受监控的控制回路触发点 */
export type ControlTriggerName =
  /** 每轮评估一次 StopRules（P0-1：修复前恒 0） */
  | "stopRules_evaluated"
  /** 审批门被真正调用（P0-2 / 快环） */
  | "approval_gate_invoked"
  /** 工具调用限流检查发生（P1-6 / P2-12：修复前恒 0） */
  | "rate_limit_checked"
  /** 输出指纹命中（P1-5：修复前结构上不可能命中） */
  | "fingerprint_hit"
  /** 编排慢环巡检（P1-10：修复前无任何轮询方） */
  | "anomaly_poll_invoked"
  /** `registerMiddleware` 失败（P0-2：修复前返回值被静默丢弃） */
  | "middleware_registered_failed"
  /** 目标重锚消息实际注入（P1-7：修复前闩锁导致恒不注入或每轮重复） */
  | "goal_reanchor_injected"
  /** 暂停通道被观察到（P1-8：修复前 `loopState.phase` 零读取） */
  | "pause_observed"
  /** 验证器管线被调用（P1-4：真正成功判据） */
  | "verifier_pipeline_invoked"
  /** 终止类中间件走短路通道（P1-4） */
  | "middleware_short_circuit"
  /** Token 账本四源对账失败（P0-3 收尾自检；**0 才是健康态**） */
  | "ledger_mismatch"
  /** 前置监管命中提示注入（P2-14：含工具返回值 / 模型产出侧） */
  | "injection_detected";

const ALL_TRIGGERS: readonly ControlTriggerName[] = [
  "stopRules_evaluated",
  "approval_gate_invoked",
  "rate_limit_checked",
  "fingerprint_hit",
  "anomaly_poll_invoked",
  "middleware_registered_failed",
  "goal_reanchor_injected",
  "pause_observed",
  "verifier_pipeline_invoked",
  "middleware_short_circuit",
  "ledger_mismatch",
  "injection_detected",
];

/**
 * 「存活信号」计数器：这些是**每轮/每次必然发生**的控制动作，
 * 长期为 0 即等价于该回路断线（审查建议 13 的判定规则）。
 *
 * 其余计数器不进此表——它们要么 0 是健康态（`ledger_mismatch`、`middleware_registered_failed`），
 * 要么只在特定条件下才发生（`goal_reanchor_injected` 需先发生压缩、
 * `verifier_pipeline_invoked` 属**已知未接线**、`middleware_short_circuit` 需真的短路）。
 */
const LIVENESS_COUNTERS: readonly ControlTriggerName[] = [
  "stopRules_evaluated",
  "approval_gate_invoked",
  "rate_limit_checked",
  "fingerprint_hit",
  "anomaly_poll_invoked",
  "pause_observed",
];

let counts: Record<ControlTriggerName, number> = emptyCounts();

function emptyCounts(): Record<ControlTriggerName, number> {
  const c = {} as Record<ControlTriggerName, number>;
  for (const name of ALL_TRIGGERS) c[name] = 0;
  return c;
}

/** 记一次触发（`delta` 缺省 1；计数器单调递增，不因读取清零） */
export function recordControlTrigger(
  name: ControlTriggerName,
  delta = 1,
): void {
  counts[name] += delta;
}

/** 当前计数快照 */
export function getControlTriggerCounts(): Record<ControlTriggerName, number> {
  return { ...counts };
}

/** 清零（测试 / 断言前重置用） */
export function resetControlTriggerCounts(): void {
  counts = emptyCounts();
}

/**
 * 断线清单：**存活信号**计数器里仍为 0 的那些。
 * 非空即意味着有回路没接上——这是本模块存在的全部理由。
 */
export function getDanglingCircuits(): ControlTriggerName[] {
  return LIVENESS_COUNTERS.filter((name) => counts[name] === 0);
}

/** 存活信号计数器快照（断线判定只看这些） */
export function getLivenessCounts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const name of LIVENESS_COUNTERS) out[name] = counts[name];
  return out;
}

/** 人类可读的一行报告（启动自检 / `getLoopSummary` / 日志用） */
export function formatControlTriggerReport(): string {
  const parts = ALL_TRIGGERS.map((n) => `${n}=${counts[n]}`);
  const dangling = getDanglingCircuits();
  const tail =
    dangling.length === 0
      ? "全部闭环"
      : `⚠️ 疑似断线（恒 0）：${dangling.join(", ")}`;
  return `[控制回路触发计数] ${parts.join(" ")} | ${tail}`;
}
