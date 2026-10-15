/**
 * @module Supervision/strategyRegistry
 * @description
 * 管理策略机注册表 + 选择器（《一些思考3》§5.1 压缩策略选择器）。
 *
 * 设计意图（本次落地的核心）：把「何时压 / 怎么压」从**写死的单条链路**改为
 * **可插拔的多台管理策略机**：
 *  - 注册表 = 插件点：内置 5 台策略机（规则裁剪 / 子任务隔离 / 结构化摘要 /
 *    记忆落盘 / 紧急截断），组合根与第三方可继续 `registerStrategy` 追加；
 *  - 选择器 = 纯函数：按「命中层级 + 难度档」过滤，再按 `priority` 升序
 *    （**先免费、后 LLM**，对齐 §1.6「从免费的 Snip/Micro 开始，最后才用 LLM 摘要」）。
 *
 * 与既有监管层的关系（**不移除、不替换**）：
 *  - 本模块与 `preSupervision` / `postSupervision` / `compressSupervision` /
 *    `summarySupervision` / `loopSupervision` / `reasoningSupervision` 同址共层；
 *  - 策略机只负责「动手改上下文」，改完仍由既有 `runCompressSupervision` /
 *    `runSummarySupervision` 做**事后监管**（见 Core/Loop/contextCompression.ts）；
 *  - 既有监管函数一个都不删、一个都不改名。
 *
 * 分层：本文件可 import `Infra/Contracts`（纯类型）与 `Infra/types`，
 * 不得 import `Core/*`（Services 层红线）。
 */

import type { Result } from "../../Infra/types.js";
import { ok, err } from "../../Infra/types.js";
import type {
  CompactionStrategy,
  StrategyContext,
} from "../../Infra/Contracts/compactionTypes.js";

import { BUILTIN_STRATEGIES } from "./compactionStrategies.js";

const strategies: CompactionStrategy[] = [...BUILTIN_STRATEGIES];

/** 注册一台策略机（id 唯一；重复注册返回 DUPLICATE_ENTRY） */
export function registerStrategy(strategy: CompactionStrategy): Result<void> {
  if (!strategy.id) return err("INVALID_ARGUMENT: 策略机 id 必填");
  if (strategy.layers.length === 0)
    return err("INVALID_ARGUMENT: 策略机必须声明至少一个适用层级");
  if (
    typeof strategy.applies !== "function" ||
    typeof strategy.execute !== "function"
  ) {
    return err("INVALID_ARGUMENT: 策略机必须实现 applies/execute");
  }
  if (strategies.some((s) => s.id === strategy.id)) {
    return err(`DUPLICATE_ENTRY: 策略机 "${strategy.id}" 已注册`);
  }
  strategies.push(strategy);
  return ok(undefined);
}

/** 批量注册（返回成功条数；任一条失败即整体失败，与 registerMiddlewares 同口径） */
export function registerStrategies(
  list: readonly CompactionStrategy[],
): Result<number> {
  let count = 0;
  for (const s of list) {
    const r = registerStrategy(s);
    if (!r.ok) return r;
    count++;
  }
  return ok(count);
}

/** 注销一台策略机（不存在则忽略） */
export function unregisterStrategy(id: string): void {
  const idx = strategies.findIndex((s) => s.id === id);
  if (idx >= 0) strategies.splice(idx, 1);
}

/** 当前已注册策略机快照 */
export function getStrategies(): CompactionStrategy[] {
  return [...strategies];
}

/** 已注册策略机数量（诊断 / 环境自检用） */
export function getStrategyCount(): number {
  return strategies.length;
}

/** 清空全部策略机（测试 / 「禁用压缩」场景：没策略机就没得压） */
export function clearStrategies(): void {
  strategies.length = 0;
}

/** 恢复内置策略机集合（测试 / 出厂重置） */
export function resetStrategies(): void {
  strategies.length = 0;
  strategies.push(...BUILTIN_STRATEGIES);
}

/**
 * 选择器（纯函数）：按命中层级 → 难度档 → priority 排序挑出本次要跑的策略机。
 *
 * 排序即「成本阶梯」：`rule`(10) < `isolation`(20) < `flush`(30) < `llm`(50) < `fallback`(90)。
 */
export function selectStrategies(ctx: StrategyContext): CompactionStrategy[] {
  return strategies
    .filter((s) => s.layers.includes(ctx.layer))
    .filter((s) => !s.complexities || s.complexities.includes(ctx.complexity))
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
}
