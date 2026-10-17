/**
 * @module Core/Lifecycle/lifecycleController
 * @description
 * 外部控制器：**状态取值、合法集、决策、落盘**的唯一持有者。
 *
 * 设计出处：Docs/Dev/L1编排设计/16-LifecycleController.md · 13 §16（铁律）· 03 §6（判据）
 *
 * 五条实现纪律（每条都有对应负向测试）：
 *   1. 合法集**两层**：框架定默认硬边界，外部只能收紧为子集；放宽 ⇒ **拒绝创建**。
 *   2. **机械事件不问 LLM**（child.spawned / child.settled 按规则），否则成本失控。
 *   3. 需判断事件问 LLM 时，**只给合法集内的选项**；返回非法 ⇒ 记违规 + 重决；
 *      连续非法 ⇒ 按失败处理（有未收敛子代 → suspend，否则 abandon），**绝不静默兜底**。
 *   4. **监管指令优先**，但**不得绕过合法集**：越界指令被拒绝并记违规。
 *   5. `suspend` 必须**落盘成功**才算成立；落盘失败 ⇒ 返回错误（不许假装已挂起）。
 */

import type { Result } from "../../Infra/types.js";
import { ok, err } from "../../Infra/types.js";

import {
  DEFAULT_LEGALITY,
  MECHANICAL_EVENTS,
  assertTightenedIsSubset,
  decisionFingerprint,
} from "./lifecycleTypes.js";
import type {
  Decision,
  LegalityTable,
  LifecycleCtx,
  LifecycleEvent,
  LifecycleState,
} from "./lifecycleTypes.js";

/** 违规记录（非法决策必须留痕，不得静默） */
export interface LifecycleViolation {
  kind: "illegal_decision" | "supervision_out_of_legal_set";
  event: LifecycleEvent;
  state: LifecycleState;
  proposed: LifecycleState;
  legal: LifecycleState[];
  at: number;
}

/**
 * 决策历史的一条（**监管可见**：S2 快照的工作状态取此项以回答"为何选了那个状态"）。
 * `via` 标明这条决策的来源通道 —— 没有它就无法区分"模型给的"与"机械规则给的"。
 */
export interface DecisionRecord {
  readonly event: LifecycleEvent;
  readonly from: LifecycleState;
  readonly to: LifecycleState;
  readonly via: "supervision" | "mechanical" | "model" | "cache" | "fallback";
  readonly at: number;
}

/** 询问模型时的载荷：**只含合法集内的选项** */
export interface DecisionPrompt {
  event: LifecycleEvent;
  state: LifecycleState;
  legal: LifecycleState[];
  ctx: LifecycleCtx;
  /** 渲染后的状态说明（给模型看的是自然语言，不是状态机枚举） */
  rendered: string;
}

/** 挂起快照端口（写入 `ckpt:component:<componentId>` 命名空间；分区规则见 S4） */
export interface ComponentCheckpointPort {
  save(key: string, snapshot: unknown): Promise<Result<void>>;
}

export interface LifecycleControllerDeps {
  /** 询问模型（唯一的外部智能入口）；返回 null 表示模型未给出可用决策 */
  askModel: (prompt: DecisionPrompt) => Promise<Decision | null>;
  /** 挂起落盘端口（缺失时 suspend 直接失败，不允许"挂而不存"） */
  checkpoint?: ComponentCheckpointPort;
  /** 监管指令（优先，但不得越出合法集） */
  supervision?: (event: LifecycleEvent, ctx: LifecycleCtx) => Decision | null;
  /** 外部收紧的合法表（**只能是默认表的子集**） */
  tightened?: LegalityTable;
  /** 重决上限（默认 2） */
  maxRetry?: number;
}

export interface LifecycleController {
  /** 处理一个事件 → 决策（含状态推进） */
  onEvent(event: LifecycleEvent, ctx: LifecycleCtx): Promise<Result<Decision>>;
  /** 当前状态取值（**由本控制器持有**） */
  getState(): LifecycleState;
  /** 给定事件下的合法集（供检查树/审计读取；须传真实上下文） */
  legalFor(event: LifecycleEvent, ctx: LifecycleCtx): Set<LifecycleState>;
  violations(): readonly LifecycleViolation[];
  /** 决策历史（含被拒前的成功转移；**只读**，供 S2 监管快照投影） */
  decisions(): readonly DecisionRecord[];
  cacheSize(): number;
  /** 决策缓存指标（用于证明"机械事件不问 LLM"与"缓存生效"） */
  modelCallCount(): number;
}

const SUSPEND_KEY_PREFIX = "ckpt:component:";

/** 渲染给模型的状态说明（模型读自然语言，不读状态机枚举） */
function renderPrompt(
  event: LifecycleEvent,
  state: LifecycleState,
  legal: LifecycleState[],
  ctx: LifecycleCtx,
): string {
  const options = legal.join(" / ");
  const children =
    ctx.outstanding.length > 0
      ? "仍有 " + ctx.outstanding.length + " 个子代理未收敛"
      : "无未收敛子代理";
  return [
    "事件=" + event,
    "当前状态=" + state,
    children,
    "依赖满足=" + String(ctx.dependencySatisfied),
    "预算剩余=" + String(ctx.budgetRemaining),
    "可选动作=" + options,
  ].join("；");
}

export function createLifecycleController(
  deps: LifecycleControllerDeps,
): Result<LifecycleController> {
  // ── 纪律 1：收紧只能是子集，放宽直接拒绝创建（拒绝启动，不是警告）──
  if (deps.tightened) {
    const check = assertTightenedIsSubset(deps.tightened);
    if (!check.ok) {
      return err(
        "合法集只能收紧不能放宽，检测到越界: " +
          check.widening.slice(0, 5).join(" | "),
      );
    }
  }
  const tightened = deps.tightened;
  const maxRetry = deps.maxRetry ?? 2;

  let state: LifecycleState = "running";
  const violations: LifecycleViolation[] = [];
  const records: DecisionRecord[] = [];
  const cache = new Map<string, Decision>();
  let modelCalls = 0;

  /** 合法集：默认表 ∩ 收紧表 */
  function legalFor(
    event: LifecycleEvent,
    ctx: LifecycleCtx,
  ): Set<LifecycleState> {
    const base = DEFAULT_LEGALITY(event, state, ctx);
    if (!tightened) return base;
    const narrowed = tightened(event, state, ctx);
    const out = new Set<LifecycleState>();
    for (const s of base) if (narrowed.has(s)) out.add(s);
    return out;
  }

  function recordViolation(
    kind: LifecycleViolation["kind"],
    event: LifecycleEvent,
    proposed: LifecycleState,
    legal: Set<LifecycleState>,
    ctx: LifecycleCtx,
  ): void {
    violations.push({
      kind,
      event,
      state,
      proposed,
      legal: [...legal],
      at: ctx.now,
    });
  }

  /** 连续非法后的失败处理（**不静默兜底**） */
  function failureFallback(ctx: LifecycleCtx): Decision {
    return ctx.outstanding.length > 0
      ? { next: "suspend", until: "child", refs: [...ctx.outstanding] }
      : { next: "abandon", reason: "生命周期决策连续非法" };
  }

  async function commit(
    event: LifecycleEvent,
    decision: Decision,
    ctx: LifecycleCtx,
    via: DecisionRecord["via"],
  ): Promise<Result<Decision>> {
    // ── 纪律 5：suspend 必须落盘成功 ──
    if (decision.next === "suspend") {
      if (!deps.checkpoint) {
        return err(
          "suspend 需要落盘端口，但未注入 checkpoint（不允许挂而不存）",
        );
      }
      const saved = await deps.checkpoint.save(
        SUSPEND_KEY_PREFIX + ctx.componentId,
        {
          state: "suspend",
          decision,
          ctx,
        },
      );
      if (!saved.ok) {
        return err("suspend 落盘失败: " + saved.error);
      }
    }
    const from = state;
    state = decision.next;
    // 决策历史**只记真正落地的转移**（落盘失败的那次不留痕，否则监管会读到假转移）
    records.push({ event, from, to: decision.next, via, at: ctx.now });
    return ok(decision);
  }

  async function onEvent(
    event: LifecycleEvent,
    ctx: LifecycleCtx,
  ): Promise<Result<Decision>> {
    const legal = legalFor(event, ctx);

    // ── 纪律 4：监管指令优先，但不得越出合法集 ──
    const supervised = deps.supervision?.(event, ctx) ?? null;
    if (supervised) {
      if (legal.has(supervised.next)) {
        return commit(event, supervised, ctx, "supervision");
      }
      recordViolation(
        "supervision_out_of_legal_set",
        event,
        supervised.next,
        legal,
        ctx,
      );
      // 越界指令被拒后**继续走正常判定**（而不是静默接受）
    }

    // ── 纪律 2：机械事件按规则，**不问 LLM** ──
    if (MECHANICAL_EVENTS.has(event)) {
      const mechanical: Decision = { next: "running" };
      if (!legal.has("running"))
        return commit(event, failureFallback(ctx), ctx, "fallback");
      return commit(event, mechanical, ctx, "mechanical");
    }

    // ── 纪律 3：需判断事件 —— 缓存 → 问 LLM（只给合法集）──
    const key = decisionFingerprint(event, state, ctx);
    const cached = cache.get(key);
    if (cached && legal.has(cached.next)) {
      return commit(event, cached, ctx, "cache");
    }

    const legalList = [...legal];
    for (let attempt = 0; attempt <= maxRetry; attempt++) {
      modelCalls += 1;
      const proposed = await deps.askModel({
        event,
        state,
        legal: legalList,
        ctx,
        rendered: renderPrompt(event, state, legalList, ctx),
      });
      if (proposed && legal.has(proposed.next)) {
        cache.set(key, proposed);
        return commit(event, proposed, ctx, "model");
      }
      recordViolation(
        "illegal_decision",
        event,
        proposed?.next ?? "running",
        legal,
        ctx,
      );
    }

    return commit(event, failureFallback(ctx), ctx, "fallback");
  }

  return ok({
    onEvent,
    getState: () => state,
    legalFor: (event: LifecycleEvent, ctx: LifecycleCtx) =>
      legalFor(event, ctx),
    violations: () => violations,
    decisions: () => records,
    cacheSize: () => cache.size,
    modelCallCount: () => modelCalls,
  });
}
