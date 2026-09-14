export {
  type HookEvent, type HookEventConfig, type HookHandler, type HookPayload,
  type HookHandlerResult, type HookDispatchResult, HOOK_EVENTS,
  registerHookHandler, registerHookHandlers, dispatchHook,
  getAllHookHandlers, clearHookHandlers, getHookHandlerCount,
} from './hookRegistry.js';
