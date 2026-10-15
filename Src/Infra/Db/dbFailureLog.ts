/**
 * @module Infra/Db/dbFailureLog
 * @description 落库失败的统一信号分级（REV-337，2026-10-09 新增）。
 *
 * 背景：各 Repository 的 `catch` 此前写法并存——逐条 `logger.error`、`logger.warn` 降级、
 * 完全静默返回默认值三种。真实后果不是功能错，是**信号被淹没**：`Logs/business.log` 里
 * "真的落库故障"（磁盘满、迁移未跑、约束冲突）与"这个进程根本没有库"
 * （`realAgent` harness 等纯内存运行形态）长得一模一样，一次全量测试即刷 165 行 ERROR，
 * 而用例 4/4 通过。
 *
 * 口径：
 *  - `isDatabaseInitialized() === false` ⇒ 属于**可预期运行态**，按来源降为一条 `warn`
 *    （warn-once，避免逐行刷屏），并说明兜底动作；
 *  - 库已初始化却读写失败 ⇒ 真故障，逐条 `error` 并带原始错误消息。
 *
 * 两种分级都必须写 `fallback`：读侧拿到空列表 / 0 / null 时，日志要能区分"库里真的没有"
 * 与"读库失败所以按默认值返回"，否则空结果本身就是误导性证据。
 */

import { logger } from "../Logging/logger.js";

import { isDatabaseInitialized } from "./database.js";

/** 已提示过"库未初始化"的来源，用于 warn-once 去重（每种来源只提示一次） */
const warnedUninitialized = new Set<string>();

/** 清空 warn-once 记账（供测试隔离用例间的状态） */
export function resetDbFailureWarnings(): void {
  warnedUninitialized.clear();
}

/**
 * 记录一次落库失败，按"库是否存在"分级。
 *
 * @param message 事实描述（不含兜底动作，如"Agent 落库失败"）
 * @param source  稳定来源标识，形如 `agentRepository/upsertAgent`，同时是 warn-once 的去重键
 * @param context 定位上下文（agentId / taskId / subtaskId 等，按 §16.5 需足以还原现场）
 * @param error   捕获到的原始错误
 * @param fallback 调用方随后采取的降级动作（如"按 0 处理，ID 可能复用"）
 */
export function logDbFailure(
  message: string,
  source: string,
  context: Record<string, unknown>,
  error: unknown,
  fallback: string,
): void {
  if (!isDatabaseInitialized()) {
    if (warnedUninitialized.has(source)) return;
    warnedUninitialized.add(source);
    logger.warn(`${message}（数据库未初始化，按纯内存运行）`, {
      source,
      fallback,
      ...context,
    });
    return;
  }
  logger.error(message, {
    source,
    fallback,
    error: error instanceof Error ? error.message : String(error),
    ...context,
  });
}
