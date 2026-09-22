/**
 * @module Middleware/builtin/fingerprintDetector
 * @description
 * 指纹检测中间件——Docs/12 循环控制。
 * 检测模型输出指纹，用于发现重复/死循环。
 * 挂载点：afterModel（priority=10）。
 */

import type { AgentMiddleware, MiddlewareContext, ModelCallOutput } from '../../../Infra/Contracts/middlewareTypes.js';

export function computeOutputFingerprint(output: string): string {
  // 去除空白后取 hash
  const normalized = output.replace(/\s+/g, ' ').trim();
  let hash = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i++) {
    hash ^= normalized.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export const fingerprintDetectorMiddleware: AgentMiddleware = {
  name: 'FingerprintDetector',
  hook: 'afterModel',
  priority: 10,
  canShortCircuit: false,

  execute: async (ctx: MiddlewareContext, output: ModelCallOutput) => {
    const fp = computeOutputFingerprint(output.content);
    ctx.data['lastOutputFingerprint'] = fp;

    // 记录指纹历史
    const history = (ctx.data['fingerprintHistory'] as string[]) || [];
    history.push(fp);
    if (history.length > 10) history.shift();
    ctx.data['fingerprintHistory'] = history;

    return output;
  },
};
