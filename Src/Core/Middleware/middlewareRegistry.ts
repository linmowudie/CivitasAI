/**
 * @module Middleware/middlewareRegistry
 * @description
 * Middleware registry - Docs/02 4.
 * Manages registration, sorting, and execution of six-hook middleware.
 */

import type { AgentMiddleware, MiddlewareHook, MiddlewareContext } from '../../Infra/Contracts/middlewareTypes.js';
import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';

const middlewares: AgentMiddleware[] = [];

export function registerMiddleware(middleware: AgentMiddleware): Result<void> {
  if (!middleware.name) return err('INVALID_ARGUMENT', 'Middleware name required');
  if (!middleware.hook) return err('INVALID_ARGUMENT', 'Middleware hook type required');
  if (typeof middleware.execute !== 'function') {
    return err('INVALID_ARGUMENT', 'Middleware execute must be a function');
  }

  const existing = middlewares.find(m => m.name === middleware.name);
  if (existing) {
    return err('DUPLICATE_ENTRY', `Middleware "${middleware.name}" already registered`);
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

  for (const mw of hooks) {
    const result = await (mw.execute as (...args: any[]) => Promise<any>)(ctx, ...args);
    if (result && typeof result === 'object' && 'shortCircuit' in result && result.shortCircuit) {
      return { shortCircuited: true, result: result.result };
    }
  }

  return { shortCircuited: false };
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
    const prev = current;
    current = ((inp: TInput) =>
      (mw.execute as (...args: any[]) => Promise<any>)(ctx, inp, prev)
    ) as (input: TInput) => Promise<TOutput>;
  }

  return current(input);
}
