/**
 * @module LoopControl/middleware/fingerprintDetectorControl
 * @description
 * Loop 控制级指纹检测中间件——Docs/12 §5。
 * 与 Core/Middleware/builtin/fingerprintDetector.ts（S5 桩）互补：
 * 本模块基于 LoopState.actionFingerprints 做完整四规则检测。
 *
 * 挂载点：wrapToolCall（工具调用前后拦截）。
 */

import type { AgentMiddleware, MiddlewareContext, ToolCallInput, ToolCallOutput } from '../../../Core/Middleware/types.js';
import type { LoopState, FingerprintRecord } from '../loopState.js';
import { computeFingerprint, detectFingerprintAction, recordFingerprint, type FingerprintConfig, type FingerprintAction } from '../actionFingerprint.js';

/** 创建控制级指纹检测中间件 */
export function createFingerprintDetectorControlMiddleware(
  getLoopState: () => LoopState | undefined,
  config: FingerprintConfig,
  onAction?: (action: FingerprintAction, toolName: string) => void,
): AgentMiddleware {
  return {
    name: 'FingerprintDetectorControl',
    hook: 'wrapToolCall',
    priority: 5,
    canShortCircuit: false,

    execute: async (ctx: MiddlewareContext, input: ToolCallInput, next) => {
      const state = getLoopState();
      if (!state) return next(input);

      // 计算指纹
      const fp = recordFingerprint(input.toolName, input.arguments, ctx.iteration, state.actionFingerprints);

      // 检查是否需要添加到 state
      if (!state.actionFingerprints.find(h => h.fingerprint === fp.fingerprint && h.iteration === fp.iteration)) {
        state.actionFingerprints.push(fp);
      }

      // 检测重复
      const action = detectFingerprintAction(fp.fingerprint, ctx.iteration, state.actionFingerprints, config);

      // 通知回调
      if (action && action.type !== 'none' && onAction) {
        onAction(action, input.toolName);
      }

      // 执行工具调用
      return next(input);
    },
  };
}
