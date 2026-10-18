/**
 * @module Orchestration/ledgerHub
 * @description **L1 账本枢纽**（融合 P0，2026-10-17）。
 *
 * 融合纪律（[29-融合方案](../Docs/Dev/L1编排设计/29-融合方案-内核优先.md) §2）：
 * 进程内 **只有一个** `L1HostRegistry`。外层循环（OuterLoop）、分裂/合并
 * （AgentSplit/AgentMerge）、监管快照（componentSnapshot）必须从同一个 hub 取账本——
 * 否则同一个 L1 会有两本"域账本"，收敛判定与合并请求各读各的，
 * 表现为"分裂成功但外层永远不收敛"或"合并请求目标不在域内"。
 *
 * 为什么集中：`createL1HostRegistry()` 的每个实例各自持有一份 `hosts` Map；
 * 之前 `splitMergeComposition` 在模块内自建实例，而未来外层循环还需要另一份——
 * 这正是"新代码自建账本"的违规形态，这里先从源头收口。
 */

import {
  createL1HostRegistry,
  type L1Host,
  type L1HostRegistry,
} from "./l1HostRegistry.js";
import { ok, err } from "../../Infra/types.js";
import type { Result } from "../../Infra/types.js";

let registry: L1HostRegistry | null = null;

/** 取进程内唯一的 L1 宿主注册表（懒初始化） */
export function getL1HostRegistry(): L1HostRegistry {
  if (!registry) registry = createL1HostRegistry();
  return registry;
}

/**
 * 懒登记一个 L1 宿主（幂等）。
 *
 * 已登记则直接返回；未登记才 `open({agentId})`（rootId = agentId）。
 * 这是"L1 角色首次使用编排能力时建立域账本"的唯一入口。
 */
export function ensureL1Host(agentId: string): Result<L1Host> {
  const hostRegistry = getL1HostRegistry();
  const trimmed = agentId.trim();
  if (trimmed === "") return err("L1 宿主 agentId 不可为空");
  const existing = hostRegistry.resolve(trimmed);
  if (existing) return ok(existing);
  return hostRegistry.open({ agentId: trimmed });
}

/** 已登记的 L1 宿主 id（诊断/观测用） */
export function listL1Hosts(): string[] {
  return getL1HostRegistry().hostIds();
}

/**
 * 重置账本枢纽（测试隔离/热重载用）。
 *
 * 生产代码不应调用：账本 Reset 会让在跑的域丢失归属。
 */
export function resetL1LedgerHub(): void {
  registry = null;
}
