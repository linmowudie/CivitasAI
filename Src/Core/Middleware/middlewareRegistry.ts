/**
 * @module Middleware/middlewareRegistry
 * @description
 * Middleware registry - Docs/Agent/02 4.
 * Manages registration, sorting, and execution of six-hook middleware.
 */

import type { AgentMiddleware, MiddlewareHook, MiddlewareContext } from '../../Infra/Contracts/middlewareTypes.js';
import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';
import { publish, createEvent } from '../../Services/EventBus/eventBus.js';
import { EventType } from '../../Services/EventBus/eventTypes.js';

const middlewares: AgentMiddleware[] = [];

export function registerMiddleware(middleware: AgentMiddleware): Result<void> {
  if (!middleware.name) return err('INVALID_ARGUMENT: Middleware name required');
  if (!middleware.hook) return err('INVALID_ARGUMENT: Middleware hook type required');
  if (typeof middleware.execute !== 'function') {
    return err('INVALID_ARGUMENT: Middleware execute must be a function');
  }

  const existing = middlewares.find(m => m.name === middleware.name);
  if (existing) {
    return err(`DUPLICATE_ENTRY: Middleware "${middleware.name}" already registered`);
  }

  middlewares.push(middleware);
  return ok(undefined);
}

export function registerMiddlewares(list: AgentMiddleware[]): Result<number> {
  let count = 0;
  for (const mw of list) {
    const result = registerMiddleware(mw);
    if (!result.ok) return result;
    count++;
  }
  return ok(count);
}

export function getMiddlewaresForHook(hook: MiddlewareHook): AgentMiddleware[] {
  return middlewares
    .filter(m => m.hook === hook)
    .sort((a, b) => a.priority - b.priority);
}

export function getAllMiddlewares(): AgentMiddleware[] {
  return [...middlewares];
}

export function clearMiddlewares(): void {
  middlewares.length = 0;
}

/**
 * 注销指定名称的中间件
 */
export function unregisterMiddleware(name: string): void {
  const idx = middlewares.findIndex(m => m.name === name);
  if (idx >= 0) middlewares.splice(idx, 1);
}

export function getMiddlewareCount(): number {
  return middlewares.length;
}

export async function executePrePostHooks(
  hook: MiddlewareHook,
  ctx: MiddlewareContext,
  ...args: unknown[]
): Promise<{ shortCircuited: boolean; result?: unknown }> {
  const hooks = getMiddlewaresForHook(hook);

  // FE-053：链式载荷——首个钩子收到 args[0]（如 beforeModel 的装配素材），
  // 后续钩子收到前一个钩子的返回值；最终载荷经 `result` 回传给调用方。
  // 修复前每个钩子都收到原始 args 且返回值被整体丢弃——BeforeModelHook 契约
  // （返回改写后的 messages）在生产不可达。
  let carried: unknown = args[0];

  for (const mw of hooks) {
    const result = await (mw.execute as (...args: any[]) => Promise<any>)(ctx, carried, ...args.slice(1));
    if (result && typeof result === 'object' && 'shortCircuit' in result && result.shortCircuit) {
      // 推送 middleware:before_model 事件（Docs/Client/03 §4.1）
      publish(createEvent({
        eventType: EventType.MIDDLEWARE_BEFORE_MODEL,
        source: `middleware/${mw.name}`,
        traceId: ctx.traceId,
        payload: {
          middlewareName: mw.name,
          action: 'reject',
          reason: (result.result as any)?.content ?? 'short-circuited',
          timestamp: Date.now(),
        },
      }));
      return { shortCircuited: true, result: result.result };
    }

    // 推送中间件通过事件
    if (hook === 'beforeModel') {
      publish(createEvent({
        eventType: EventType.MIDDLEWARE_BEFORE_MODEL,
        source: `middleware/${mw.name}`,
        traceId: ctx.traceId,
        payload: {
          middlewareName: mw.name,
          action: 'pass',
          timestamp: Date.now(),
        },
      }));
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
  const hooks = getMiddlewaresForHook(hook);

  let current = coreFn;
  for (let i = hooks.length - 1; i >= 0; i--) {
    const mw = hooks[i];
    if (!mw) continue;
    const prev = current;
    current = ((inp: TInput) =>
      (mw.execute as (...args: any[]) => Promise<any>)(ctx, inp, prev)
    ) as (input: TInput) => Promise<TOutput>;
  }

  return current(input);
}
