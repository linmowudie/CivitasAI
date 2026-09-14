/**
 * 中止信号工具（Docs/02 §10.3）
 *
 * 职责：
 * - 提供可组合的 AbortSignal（合并多个来源）
 * - 支持暂停/恢复语义（审批门 / 暂停符）
 * - 流式取消时写 EffectJournal 的桥接
 */

// ===== 类型定义 =====

/** 中止来源分类 */
export type AbortSource =
  | 'user'          // 用户主动取消
  | 'pause'         // 审批门暂停信号
  | 'timeout'       // 超时
  | 'budget'        // 预算耗尽
  | 'error';        // 上游错误

/** 带来源标记的中止控制器 */
export interface ManagedAbortController {
  readonly signal: AbortSignal;
  readonly source: AbortSource;
  abort(reason?: string): void;
}

// ===== 公开 API =====

/**
 * 创建带来源标记的 AbortController
 */
export function createManagedAbortController(source: AbortSource): ManagedAbortController {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    source,
    abort(reason?: string) {
      controller.abort(reason ?? `Aborted by ${source}`);
    },
  };
}

/**
 * 合并多个 AbortSignal 为一个
 *
 * 任一源 signal 被 abort 时，返回的组合 signal 也会被 abort。
 * 用于将外部取消信号与内部超时信号合并。
 */
export function mergeAbortSignals(...signals: (AbortSignal | undefined)[]): AbortController {
  const controller = new AbortController();

  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller;
    }
    signal.addEventListener('abort', () => {
      controller.abort(signal.reason);
    }, { once: true });
  }

  return controller;
}

/**
 * 创建带超时的 AbortController
 *
 * 超时后自动 abort，返回 controller 和清理 timer 的函数。
 */
export function createTimeoutAbortController(timeoutMs: number): {
  controller: AbortController;
  clearTimer: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`Timeout after ${timeoutMs}ms`));
  }, timeoutMs);

  return {
    controller,
    clearTimer: () => clearTimeout(timer),
  };
}

/**
 * 检查 AbortSignal 是否已被中止
 */
export function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

/**
 * 从 AbortSignal 提取中止来源（如果有）
 */
export function getAbortSource(signal?: AbortSignal): AbortSource | undefined {
  if (!signal?.aborted) return undefined;
  const reason = signal.reason;
  if (reason instanceof Error) {
    const msg = reason.message.toLowerCase();
    if (msg.includes('timeout')) return 'timeout';
    if (msg.includes('budget')) return 'budget';
    if (msg.includes('pause')) return 'pause';
  }
  if (typeof reason === 'string') {
    if (reason.includes('pause')) return 'pause';
    if (reason.includes('timeout')) return 'timeout';
    if (reason.includes('budget')) return 'budget';
  }
  return 'user';
}
