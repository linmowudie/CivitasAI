/**
 * @module Hook/hookRegistry
 * @description
 * Hook registration and dispatch - Docs/02 11.
 */

import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';

export type HookEvent =
  | 'UserInputReceived' | 'SessionStart' | 'PreToolExecute'
  | 'PostToolExecute' | 'ModelCallStart' | 'ModelCallEnd'
  | 'VerifierExecuted' | 'ApprovalRequested' | 'SessionEnd';

export interface HookEventConfig {
  event: HookEvent;
  interceptable: boolean;
  defaultFailBehavior: 'fail-open' | 'fail-closed';
}

export const HOOK_EVENTS: Record<HookEvent, HookEventConfig> = {
  UserInputReceived:   { event: 'UserInputReceived',   interceptable: true,  defaultFailBehavior: 'fail-open' },
  SessionStart:        { event: 'SessionStart',        interceptable: true,  defaultFailBehavior: 'fail-closed' },
  PreToolExecute:      { event: 'PreToolExecute',      interceptable: true,  defaultFailBehavior: 'fail-closed' },
  PostToolExecute:     { event: 'PostToolExecute',     interceptable: false, defaultFailBehavior: 'fail-open' },
  ModelCallStart:      { event: 'ModelCallStart',      interceptable: false, defaultFailBehavior: 'fail-open' },
  ModelCallEnd:        { event: 'ModelCallEnd',        interceptable: false, defaultFailBehavior: 'fail-open' },
  VerifierExecuted:    { event: 'VerifierExecuted',    interceptable: false, defaultFailBehavior: 'fail-open' },
  ApprovalRequested:   { event: 'ApprovalRequested',   interceptable: false, defaultFailBehavior: 'fail-open' },
  SessionEnd:          { event: 'SessionEnd',          interceptable: false, defaultFailBehavior: 'fail-open' },
};

export interface HookHandler {
  name: string;
  event: HookEvent;
  priority: number;
  timeoutMs: number;
  handle: (payload: HookPayload) => Promise<HookHandlerResult>;
}

export interface HookPayload {
  event: HookEvent;
  data: Record<string, unknown>;
  timestamp: number;
}

export interface HookHandlerResult {
  intercepted?: boolean;
  interceptReason?: string;
  data?: Record<string, unknown>;
}

export interface HookDispatchResult {
  intercepted: boolean;
  interceptReason?: string;
  handlersExecuted: number;
  errors: Array<{ handler: string; error: string }>;
}

const handlers: HookHandler[] = [];

export function registerHookHandler(handler: HookHandler): Result<void> {
  if (!handler.name) return err('INVALID_ARGUMENT', 'Handler name required');
  if (!handler.event) return err('INVALID_ARGUMENT', 'Handler event required');
  if (!HOOK_EVENTS[handler.event]) return err('INVALID_ARGUMENT', `Unknown Hook event: ${handler.event}`);
  if (typeof handler.handle !== 'function') return err('INVALID_ARGUMENT', 'handle must be a function');

  const existing = handlers.find(h => h.name === handler.name && h.event === handler.event);
  if (existing) return err('DUPLICATE_ENTRY', `Handler "${handler.name}" already on "${handler.event}"`);

  handlers.push({ ...handler, timeoutMs: handler.timeoutMs ?? 5000 });
  return ok(undefined);
}

export function registerHookHandlers(list: HookHandler[]): Result<number> {
  let count = 0;
  for (const h of list) {
    const result = registerHookHandler(h);
    if (!result.ok) return result;
    count++;
  }
  return ok(count);
}

export async function dispatchHook(
  event: HookEvent,
  data: Record<string, unknown>,
): Promise<HookDispatchResult> {
  const eventConfig = HOOK_EVENTS[event];
  if (!eventConfig) {
    return { intercepted: false, handlersExecuted: 0, errors: [{ handler: '__system__', error: `Unknown event: ${event}` }] };
  }

  const eventHandlers = handlers
    .filter(h => h.event === event)
    .sort((a, b) => a.priority - b.priority);

  const payload: HookPayload = { event, data, timestamp: Date.now() };
  const errors: Array<{ handler: string; error: string }> = [];
  let handlersExecuted = 0;

  for (const handler of eventHandlers) {
    try {
      handlersExecuted++;
      const result = await Promise.race([
        handler.handle(payload),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Hook handler timeout')), handler.timeoutMs),
        ),
      ]);

      if (result.intercepted && eventConfig.interceptable) {
        return { intercepted: true, interceptReason: result.interceptReason, handlersExecuted, errors };
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      errors.push({ handler: handler.name, error: errMsg });

      if (eventConfig.defaultFailBehavior === 'fail-closed') {
        return { intercepted: true, interceptReason: `Handler "${handler.name}" failed (fail-closed)`, handlersExecuted, errors };
      }
    }
  }

  return { intercepted: false, handlersExecuted, errors };
}

export function getAllHookHandlers(): HookHandler[] { return [...handlers]; }
export function clearHookHandlers(): void { handlers.length = 0; }
export function getHookHandlerCount(): number { return handlers.length; }
