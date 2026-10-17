/**
 * @module Core/Loop/reactLoop
 * @description
 * `ReActLoop`：十步循环的**可实例化 / 可嵌套 / 可重入**外壳。
 *
 * 设计出处：Docs/Dev/L1编排设计/15-ReActLoop原语.md（六条契约 R1–R6）·
 *   26-S1模块级可变状态盘点.md（盘点结论：`runIteration` 的模块级可变状态 = 0）
 *
 * **它不重写十步循环** —— 默认直接调用真实 `runIteration`，只在其外加一层**作用域与生命周期**。
 *
 * 六条契约的落地方式：
 *   R1 零模块级可变状态 → 全部运行态在实例里（计数、disposed、disposables）
 *   R2 可嵌套           → 内层实例可在外层 `runOnce` 的调用栈内运行（互不共享实例状态）
 *   R3 `loopId` 派生    → **派生权不在本原语**；本原语**校验**嵌套 scope 的前缀合法性
 *   R4 事件带自身 scope → 事件一律附加 `{loopId, scope}`，杜绝跨层串味
 *   R5 计量隔离可汇总   → 本实例只上报**自己的**用量；汇总由外部做
 *   R6 并发安全         → 实例间无可变共享；`dispose` 后拒绝再运行
 */

import type { Result } from "../../Infra/types.js";
import { ok, err } from "../../Infra/types.js";

import {
  runIteration as realRunIteration,
  createLoopControlView,
  type IterationContext,
  type IterationResult,
  type LoopControlView,
} from "./runIteration.js";
import type { LoopState } from "./loopEngine.js";

/** 循环作用域（由**上层**派生：外层 `L`，其组件 `L/C1`） */
export interface LoopScope {
  readonly loopId: string;
  readonly parentLoopId?: string;
  readonly agentId: string;
  readonly traceId: string;
}

export interface ReActLoopMetrics {
  readonly iterations: number;
  readonly tokens: number;
  readonly disposed: boolean;
}

export interface ReActLoopDeps {
  /** 十步循环（**默认真实** `runIteration`；注入仅用于确定性测试） */
  runIteration?: (
    state: LoopState,
    ctx: IterationContext,
    control: LoopControlView,
  ) => Promise<Result<IterationResult>>;
  makeControl?: () => LoopControlView;
  /** 事件出口（一律带本实例 scope） */
  emit?: (event: {
    loopId: string;
    scope: LoopScope;
    payload: unknown;
  }) => void;
  /** 计量出口（只报本实例用量） */
  meter?: (
    loopId: string,
    usage: { tokens: number; iterations: number },
  ) => void;
  clock?: () => number;
}

export interface ReActLoop {
  readonly scope: LoopScope;
  /** 跑**一次**完整十步（不决定"要不要下一轮"——那是 ReActCore/外部的事） */
  runOnce(
    state: LoopState,
    ctx: IterationContext,
    control?: LoopControlView,
  ): Promise<Result<IterationResult>>;
  /** 注册释放回调（LIFO 执行）；返回取消注册函数 */
  registerDisposable(fn: () => void): () => void;
  dispose(): void;
  metrics(): ReActLoopMetrics;
}

/**
 * 校验嵌套 scope 的**前缀合法性**（R3：派生权在上层，本原语只校验）。
 *
 * 合法：`parentLoopId = "L"` ⇒ `loopId` 必须是 `"L/…"`；根循环不得带 `parentLoopId` 前缀不匹配。
 */
export function assertScopeShape(scope: LoopScope): Result<void> {
  if (!scope.loopId || scope.loopId.trim().length === 0) {
    return err("loopId 不能为空");
  }
  if (scope.parentLoopId !== undefined) {
    if (scope.parentLoopId.trim().length === 0) {
      return err("parentLoopId 不能为空字符串");
    }
    if (!scope.loopId.startsWith(scope.parentLoopId + "/")) {
      return err(
        '嵌套 loopId 必须由父派生出前缀：期望以 "' +
          scope.parentLoopId +
          '/" 开头，实际 "' +
          scope.loopId +
          '"',
      );
    }
  }
  return ok(undefined);
}

export function createReActLoop(
  scope: LoopScope,
  deps: ReActLoopDeps = {},
): Result<ReActLoop> {
  const shape = assertScopeShape(scope);
  if (!shape.ok) return shape;

  const runIteration = deps.runIteration ?? realRunIteration;
  const makeControl = deps.makeControl ?? (() => createLoopControlView());

  // ── 实例私有状态（R1/R6：无任何模块级可变状态） ──
  let iterations = 0;
  let tokens = 0;
  let disposed = false;
  const disposables: Array<() => void> = [];

  return ok({
    scope,

    async runOnce(
      state: LoopState,
      ctx: IterationContext,
      control?: LoopControlView,
    ): Promise<Result<IterationResult>> {
      // R6：释放后拒绝再运行（防止"dispose 了还在跑"的泄漏式调用）
      if (disposed) {
        return err("ReActLoop(" + scope.loopId + ") 已释放，拒绝执行 runOnce");
      }
      // ⑩ 的判据基础：调用方**给定**优先（E1 持有跨轮视图），否则用注入的构造器
      const view = control ?? makeControl();
      const out = await runIteration(state, ctx, view);

      iterations += 1;
      const used = out.ok ? out.value.tokensConsumed : 0;
      tokens += used;

      // R4：事件一律带本实例 scope（杜绝跨层串味）
      deps.emit?.({
        loopId: scope.loopId,
        scope,
        payload: {
          type: "iteration",
          iteration: state.iteration.current,
          ok: out.ok,
        },
      });
      // R5：只上报本实例用量
      deps.meter?.(scope.loopId, { tokens: used, iterations: 1 });

      return out;
    },

    registerDisposable(fn: () => void): () => void {
      if (disposed) return () => {};
      disposables.push(fn);
      return () => {
        const i = disposables.indexOf(fn);
        if (i >= 0) disposables.splice(i, 1);
      };
    },

    dispose(): void {
      if (disposed) return; // 幂等
      disposed = true;
      // LIFO 释放（后注册的先释放），逐个隔离异常，保证其余仍被释放
      while (disposables.length > 0) {
        const fn = disposables.pop()!;
        try {
          fn();
        } catch {
          // 理由（best-effort 清理）：单个释放失败**不应影响**其他释放、不阻断 dispose 主链路；
          // 释放方自身负责记录失败，故此处忽略该异常。
          // 政策依据：Tests/Infra/noSilentErrorSwallow.policy.spec.ts（空 catch 必须写明理由）
        }
      }
    },

    metrics: () => ({ iterations, tokens, disposed }),
  });
}
