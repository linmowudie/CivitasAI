/**
 * @module Core/Lifecycle/lifecycleTypes
 * @description
 * 生命周期类型与**框架默认合法表**（硬边界）。
 *
 * 设计出处：Docs/Dev/L1编排设计/13-ReAct跨切面约束.md §16（状态与控制由外部输入）
 *   · 16-LifecycleController.md（两层合法集 · 机械/需判断分流 · 决策缓存 · 落盘分区）
 *   · 03-组装检查树.md §6（判据与反例集）
 *
 * 两条不可协商的硬边界：
 *   1. **不存在 `success` 状态** —— 成功只由外层从"全部收敛"推导，组件无权宣称。
 *   2. **有未收敛子代时不得 `terminate`** —— 否则就是假成功。
 */

/** 生命周期状态闭集（6 个；**不含 success**） */
export type LifecycleState =
  "running" | "suspend" | "terminate" | "handoff" | "degrade" | "abandon";

/** 生命周期事件闭集（9 个）。`needs_decision ≡ 本集合 − {component.entered}`（引用式闭集） */
export type LifecycleEvent =
  | "component.entered"
  | "iteration.exited"
  | "child.spawned"
  | "child.settled"
  | "dependency.blocked"
  | "budget.exhausted"
  | "deadline.reached"
  | "goal.satisfied"
  | "goal.unmet";

/** 输出缺口（degrade 时必须带出，且**单调累积**） */
export interface Gap {
  what: string;
  owner?: string;
  deadlineAt?: number;
}

/** 决策（判别联合） */
export type Decision =
  | { next: "running" }
  | { next: "suspend"; until: "child" | "event"; refs: string[] }
  | { next: "terminate" }
  | { next: "handoff"; to: "parent" | "peer"; refs: string[] }
  | { next: "degrade"; reason: string; gaps: Gap[] }
  | { next: "abandon"; reason: string };

/** 判定上下文（**判断依据**；由外部持有，本层只读） */
export interface LifecycleCtx {
  componentId: string;
  /** 未收敛的**下级**子代理（recruit）。兄弟（split）不进此列，见 17-账本 §0 */
  outstanding: string[];
  /** 已产出的输出内容键（参与决策缓存指纹） */
  produced: string[];
  dependencySatisfied: boolean;
  budgetRemaining: number;
  deadlineAt?: number;
  /** 当前时刻（注入，便于测试确定化） */
  now: number;
}

/** 合法表：给定事件与当前状态，返回**允许转移到的状态集合** */
export type LegalityTable = (
  event: LifecycleEvent,
  state: LifecycleState,
  ctx: LifecycleCtx,
) => Set<LifecycleState>;

/** 机械事件：按规则处理，**不问 LLM**（问 LLM 会让成本失控） */
export const MECHANICAL_EVENTS: ReadonlySet<LifecycleEvent> =
  new Set<LifecycleEvent>(["child.spawned", "child.settled"]);

/** 需判断事件 = 事件闭集 − 机械事件 − 纯通知 */
export const JUDGEMENT_EVENTS: ReadonlySet<LifecycleEvent> =
  new Set<LifecycleEvent>([
    "iteration.exited",
    "dependency.blocked",
    "budget.exhausted",
    "deadline.reached",
    "goal.satisfied",
    "goal.unmet",
  ]);

export const ALL_STATES: readonly LifecycleState[] = [
  "running",
  "suspend",
  "terminate",
  "handoff",
  "degrade",
  "abandon",
];

export const ALL_EVENTS: readonly LifecycleEvent[] = [
  "component.entered",
  "iteration.exited",
  "child.spawned",
  "child.settled",
  "dependency.blocked",
  "budget.exhausted",
  "deadline.reached",
  "goal.satisfied",
  "goal.unmet",
];

/**
 * 框架默认合法表（**硬边界，不可放宽**）。
 *
 * 外部控制器只能在此之上**收紧**为子集；放宽由 `assertTightenedIsSubset` 拒绝。
 */
export const DEFAULT_LEGALITY: LegalityTable = (event, state, ctx) => {
  // ★ 终态吸收：terminate / abandon 一旦达成即幂等，不得再转移到别处
  //   （否则"已终止"的组件还能被一个事件拉回 running —— 状态机形同虚设）
  if (state === "terminate" || state === "abandon") {
    return new Set<LifecycleState>([state]);
  }
  switch (event) {
    case "component.entered":
      return new Set<LifecycleState>(["running"]);
    case "child.spawned":
      // 机械事件：登记账本，组件继续跑
      return new Set<LifecycleState>(["running"]);
    case "child.settled":
      return new Set<LifecycleState>(["running", "terminate", "degrade"]);
    case "iteration.exited":
      // ★ 硬边界：有未收敛子代 ⇒ 不得 terminate（假成功防线）
      return ctx.outstanding.length > 0
        ? new Set<LifecycleState>(["suspend", "handoff", "abandon"])
        : new Set<LifecycleState>(["terminate"]);
    case "dependency.blocked":
      return new Set<LifecycleState>(["suspend", "degrade", "abandon"]);
    case "deadline.reached":
      return new Set<LifecycleState>(["degrade", "abandon"]);
    case "budget.exhausted":
      return new Set<LifecycleState>(["suspend", "abandon"]);
    case "goal.unmet":
      return new Set<LifecycleState>(["running", "suspend", "degrade"]);
    case "goal.satisfied":
      return new Set<LifecycleState>(["running", "terminate"]);
    default: {
      const never: never = event;
      throw new Error("未覆盖的生命周期事件: " + String(never));
    }
  }
};

/**
 * 校验收紧表是否为默认表的**子集**（逐 事件×状态 组合穷举）。
 *
 * 放宽 = 拒绝启动，不是警告：一旦允许放宽，"有未收敛子代不得 terminate" 这类硬边界即可被绕过。
 */
export function assertTightenedIsSubset(
  tightened: LegalityTable,
  defaultTable: LegalityTable = DEFAULT_LEGALITY,
): { ok: true } | { ok: false; widening: string[] } {
  const probeCtx: LifecycleCtx = {
    componentId: "probe",
    outstanding: ["probe-child"],
    produced: [],
    dependencySatisfied: false,
    budgetRemaining: 0,
    now: 0,
  };
  const widening: string[] = [];
  for (const ev of ALL_EVENTS) {
    for (const st of ALL_STATES) {
      const allowed = defaultTable(ev, st, probeCtx);
      const actual = tightened(ev, st, probeCtx);
      for (const s of actual) {
        if (!allowed.has(s)) widening.push(ev + " @ " + st + " → " + s);
      }
    }
  }
  return widening.length === 0 ? { ok: true } : { ok: false, widening };
}

/** 决策缓存指纹：同一事件+状态+上下文 ⇒ 同一决策（可复用） */
export function decisionFingerprint(
  event: LifecycleEvent,
  state: LifecycleState,
  ctx: LifecycleCtx,
): string {
  return JSON.stringify({
    e: event,
    s: state,
    o: [...ctx.outstanding].sort(),
    p: [...ctx.produced].sort(),
    d: ctx.dependencySatisfied,
    b: ctx.budgetRemaining,
    t: ctx.deadlineAt ?? null,
  });
}
