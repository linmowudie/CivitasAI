/**
 * @module Hook/hookExecutor
 * @description
 * Hook 执行引擎（Infra 层）——Docs/02 §11.2。
 * 统一派发 + 超时 + 重试，面向底层执行。
 */

// ── 类型 ──────────────────────────────────────────────

/** 执行器配置 */
export interface HookExecutorConfig {
  /** 全局超时（ms），默认 10000 */
  globalTimeoutMs: number;
  /** 最大重试次数，默认 1 */
  maxRetries: number;
  /** 重试间隔（ms），默认 100 */
  retryDelayMs: number;
}

/** 执行结果 */
export interface HookExecutionResult {
  success: boolean;
  durationMs: number;
  retriesUsed: number;
  error?: string;
}

const DEFAULT_CONFIG: HookExecutorConfig = {
  globalTimeoutMs: 10_000,
  maxRetries: 1,
  retryDelayMs: 100,
};

let config: HookExecutorConfig = { ...DEFAULT_CONFIG };

/** 初始化 Hook 执行器 */
export function initHookExecutor(userConfig?: Partial<HookExecutorConfig>): void {
  if (userConfig) {
    config = { ...DEFAULT_CONFIG, ...userConfig };
  }
}

/** 执行单个 Hook（带超时和重试） */
export async function executeHookWithRetry(
  hookName: string,
  fn: () => Promise<void>,
): Promise<HookExecutionResult> {
  const start = Date.now();
  let retriesUsed = 0;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      await Promise.race([
        fn(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Hook "${hookName}" timed out (${config.globalTimeoutMs}ms)`)), config.globalTimeoutMs),
        ),
      ]);

      return {
        success: true,
        durationMs: Date.now() - start,
        retriesUsed,
      };
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);

      if (attempt < config.maxRetries) {
        retriesUsed++;
        await new Promise(r => setTimeout(r, config.retryDelayMs));
        continue;
      }

      return {
        success: false,
        durationMs: Date.now() - start,
        retriesUsed,
        error: errMsg,
      };
    }
  }

  return { success: false, durationMs: Date.now() - start, retriesUsed, error: 'Unexpected' };
}

/** 获取执行器配置 */
export function getHookExecutorConfig(): HookExecutorConfig {
  return { ...config };
}
