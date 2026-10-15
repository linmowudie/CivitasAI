/**
 * @module Middleware/middlewareRegistry
 * @description
 * Middleware registry - Docs/Agent/02 4.
 * Manages registration, sorting, and execution of six-hook middleware.
 *
 * ## P0-2 修复（2026-10-11 控制论审查）：从"全局按名注册"改为"回路作用域 + 句柄注销"
 *
 * 原实现有三个并发失效形态（审查原文）：
 *  1. Loop B 注册重名失败，返回值被吞且无留痕 → B 静默复用 A 的闭包，
 *     `getLoopId()/getIteration()/getTraceId()` 全部指向 **A 的 LoopState**（审计链污染）；
 *  2. A 先结束 → `finally` 按名删除全局唯一 `ToolSafetyGate` → **仍在运行的 B 失去
 *     FORBIDDEN 硬拒 / 行为法典 / 审批门 / EffectJournal 全套管控**；
 *  3. 反向成立：A 注销的可能正是 B 注册的实例。
 *
 * 现在的契约：
 *  - `registerMiddleware(mw, ownerId?)` 返回**句柄** `{ id, name, ownerId }`；
 *  - `unregisterMiddleware(handle)` **按句柄**注销——A 只能摘掉自己那一个；
 *  - 重名判定放宽为「同名 + 同 ownerId」，不同回路可各自持有同名实例；
 *  - 执行器按 `ctx.loopId` 过滤：只跑「全局（无 ownerId）+ ownerId 等于本 loopId」；
 *    `ctx.loopId` 缺失时**回路作用域中间件一律不跑**（fail-closed，而不是"全都跑"）；
 *  - 注册失败经 `recordControlTrigger('middleware_registered_failed')` 留痕，
 *    调用方（`executeLoop`）据此 **fail-closed 拒绝起 Loop**——与同族的
 *    `toolSafetyGate` 在 `recordIntent` 失败时拒绝执行的取向一致。
 */

import type {
  AgentMiddleware,
  MiddlewareHook,
  MiddlewareContext,
} from "../../Infra/Contracts/middlewareTypes.js";
import type { Result } from "../../Infra/types.js";
import { ok, err } from "../../Infra/types.js";
import { publish, createEvent } from "../../Services/EventBus/eventBus.js";
import { EventType } from "../../Services/EventBus/eventTypes.js";
import { recordControlTrigger } from "../../Infra/Logging/controlTriggers.js";

/** 注册句柄：注销凭据（P0-2 核心） */
export interface MiddlewareHandle {
  /** 注册实例唯一 id */
  readonly id: string;
  /** 中间件名（诊断用） */
  readonly name: string;
  /** 归属者（`undefined` = 全局） */
  readonly ownerId?: string;
}

interface MiddlewareRecord {
  readonly handle: MiddlewareHandle;
  readonly middleware: AgentMiddleware;
}

let middlewares: MiddlewareRecord[] = [];
let seq = 0;

/**
 * 注册中间件。
 *
 * @param middleware 中间件定义
 * @param ownerId 归属者；缺省 = 全局（所有 Loop 都执行）。Loop 级安全组件应传 `loopState.loopId`。
 */
export function registerMiddleware(
  middleware: AgentMiddleware,
  ownerId?: string,
): Result<MiddlewareHandle> {
  if (!middleware.name)
    return fail("INVALID_ARGUMENT: Middleware name required");
  if (!middleware.hook)
    return fail("INVALID_ARGUMENT: Middleware hook type required");
  if (typeof middleware.execute !== "function") {
    return fail("INVALID_ARGUMENT: Middleware execute must be a function");
  }

  // 重名判定放宽为「同名 + 同归属」：不同回路各自持有同名实例是合法的（P0-2）
  const existing = middlewares.find(
    (r) =>
      r.middleware.name === middleware.name && r.handle.ownerId === ownerId,
  );
  if (existing) {
    return fail(
      `DUPLICATE_ENTRY: Middleware "${middleware.name}" already registered${ownerId ? ` for owner "${ownerId}"` : ""}`,
    );
  }

  seq += 1;
  const handle: MiddlewareHandle = {
    id: `mw-${seq}`,
    name: middleware.name,
    ...(ownerId !== undefined ? { ownerId } : {}),
  };
  middlewares.push({
    handle,
    middleware: ownerId !== undefined ? { ...middleware, ownerId } : middleware,
  });
  return ok(handle);
}

function fail(message: string): Result<MiddlewareHandle> {
  recordControlTrigger("middleware_registered_failed");
  return err(message);
}

/** 批量注册（任一失败即整体失败并返回，与 registerMiddlewares 原语义一致） */
export function registerMiddlewares(
  list: AgentMiddleware[],
  ownerId?: string,
): Result<number> {
  let count = 0;
  for (const mw of list) {
    const r = registerMiddleware(mw, ownerId);
    if (!r.ok) return { ok: false, error: r.error, severity: r.severity };
    count++;
  }
  return ok(count);
}

/**
 * 按 `ctx.loopId` 过滤出应执行的中间件。
 * 规则：全局中间件恒执行；回路作用域中间件仅在 `ownerId === loopId` 时执行；
 * `loopId` 缺失 → 回路作用域中间件**不执行**（fail-closed）。
 */
export function getMiddlewaresForHook(
  hook: MiddlewareHook,
  loopId?: string,
): AgentMiddleware[] {
  return middlewares
    .filter((r) => r.middleware.hook === hook)
    .filter(
      (r) =>
        r.handle.ownerId === undefined ||
        (loopId !== undefined && r.handle.ownerId === loopId),
    )
    .map((r) => r.middleware)
    .sort((a, b) => a.priority - b.priority);
}

/** 全部已注册中间件快照（含 ownerId，诊断用） */
export function getAllMiddlewares(): AgentMiddleware[] {
  return middlewares.map((r) => r.middleware);
}

/** 全部已注册句柄快照（诊断用） */
export function getMiddlewareHandles(): MiddlewareHandle[] {
  return middlewares.map((r) => r.handle);
}

/**
 * 按**句柄**注销（P0-2：A 的清理不再摘掉 B 的实例）。
 * @returns 是否确实删掉了一个实例
 */
export function unregisterMiddleware(handle: MiddlewareHandle): boolean {
  const idx = middlewares.findIndex((r) => r.handle.id === handle.id);
  if (idx < 0) return false;
  middlewares.splice(idx, 1);
  return true;
}

/**
 * 按名注销（**显式**的管理操作；仅供测试清理与运维，不用于 Loop 生命周期收尾——
 * 那正是 P0-2 的病根）。返回删除条数。
 */
export function unregisterMiddlewaresByName(
  name: string,
  ownerId?: string,
): number {
  const before = middlewares.length;
  middlewares = middlewares.filter(
    (r) =>
      !(
        r.middleware.name === name &&
        (ownerId === undefined || r.handle.ownerId === ownerId)
      ),
  );
  return before - middlewares.length;
}

export function clearMiddlewares(): void {
  middlewares = [];
}

export function getMiddlewareCount(): number {
  return middlewares.length;
}

export async function executePrePostHooks(
  hook: MiddlewareHook,
  ctx: MiddlewareContext,
  ...args: unknown[]
): Promise<{ shortCircuited: boolean; result?: unknown }> {
  const hooks = getMiddlewaresForHook(hook, ctx.loopId);

  // FE-053：链式载荷——首个钩子收到 args[0]（如 beforeModel 的装配素材），
  // 后续钩子收到前一个钩子的返回值；最终载荷经 `result` 回传给调用方。
  // 修复前每个钩子都收到原始 args 且返回值被整体丢弃——BeforeModelHook 契约
  // （返回改写后的 messages）在生产不可达。
  let carried: unknown = args[0];

  for (const mw of hooks) {
    const result = await (mw.execute as (...args: any[]) => Promise<any>)(
      ctx,
      carried,
      ...args.slice(1),
    );
    if (
      result &&
      typeof result === "object" &&
      "shortCircuit" in result &&
      result.shortCircuit
    ) {
      recordControlTrigger("middleware_short_circuit");
      // 推送 middleware:before_model 事件（Docs/Client/03 §4.1）
      publish(
        createEvent({
          eventType: EventType.MIDDLEWARE_BEFORE_MODEL,
          source: `middleware/${mw.name}`,
          traceId: ctx.traceId,
          payload: {
            middlewareName: mw.name,
            action: "reject",
            reason: (result.result as any)?.content ?? "short-circuited",
            timestamp: Date.now(),
          },
        }),
      );
      return { shortCircuited: true, result: result.result };
    }

    // 推送中间件通过事件
    if (hook === "beforeModel") {
      publish(
        createEvent({
          eventType: EventType.MIDDLEWARE_BEFORE_MODEL,
          source: `middleware/${mw.name}`,
          traceId: ctx.traceId,
          payload: {
            middlewareName: mw.name,
            action: "pass",
            timestamp: Date.now(),
          },
        }),
      );
    }

    // FE-053：仅当钩子显式返回值时更新链式载荷（`undefined` 不覆盖）
    if (result !== undefined) carried = result;
  }

  return { shortCircuited: false, result: carried };
}

export async function executeWrapHooks<TInput, TOutput>(
  hook: MiddlewareHook,
  ctx: MiddlewareContext,
  input: TInput,
  coreFn: (input: TInput) => Promise<TOutput>,
): Promise<TOutput> {
  const hooks = getMiddlewaresForHook(hook, ctx.loopId);

  let current = coreFn;
  for (let i = hooks.length - 1; i >= 0; i--) {
    const mw = hooks[i];
    if (!mw) continue;
    const prev = current;
    current = ((inp: TInput) =>
      (mw.execute as (...args: any[]) => Promise<any>)(ctx, inp, prev)) as (
      input: TInput,
    ) => Promise<TOutput>;
  }

  return current(input);
}
