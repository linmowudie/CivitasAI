/**
 * @module Orchestration/splitAgent
 * @description **分裂 Agent 本体**（2026-10-17）——把"分裂出一个同级 L1"从组合根里抽出来，
 * 成为一个可单独审查/测试的实现单元。
 *
 * 一次分裂 = 四个真实产物（缺一即回收，不留"半分裂"个体）：
 *   ① 同级 Agent 实例（注册表可见，role=partner）
 *   ② 独立的域账本宿主（由组合根按身份登记，rootId = peerId）
 *   ③ 该 Agent **自己的循环**（异步启动；失败留痕，不阻塞分裂登记）
 *   ④ 同级关系登记（`registerPeerSplit`，供 AgentMerge 的 isPeerSplit/mergeKindOf 使用）
 *
 * 依赖倒置：宿主登记/循环启动由 `SplitAgentDeps` 注入（组合根实现），
 * 本模块不依赖具体 Registry/Executor —— 既能被生产组合根复用，也能被单测替换。
 */

import { createAgent } from "../AgentRuntime/agentFactory.js";
import { unregisterAgent } from "../AgentRuntime/agentRegistry.js";
import { registerPeerSplit } from "../AgentRuntime/splitSemantics.js";
import { getRoutingConfig } from "../../Infra/Llm/Router/modelRouter.js";
import { ok, err } from "../../Infra/types.js";
import type { Result } from "../../Infra/types.js";
import { logger } from "../../Infra/Logging/logger.js";

/** 分裂 Agent 的宿主依赖（组合根注入） */
export interface SplitAgentDeps {
  /** 登记该 Agent 的域账本宿主（rootId 必须等于 agentId） */
  openHost(agentId: string): Result<void>;
  /** 关闭域账本宿主（回收路径） */
  closeHost(agentId: string): Result<void>;
  /** 启动该 Agent 自己的循环（若宿主不提供，则只建 Agent 不跑循环） */
  startLoop?(agentId: string, instruction: string): Promise<Result<unknown>>;
}

/** 分裂请求 */
export interface SpawnSiblingAgentInput {
  /** 发起分裂的 L1 */
  parentAgentId: string;
  /** 交给同级 L1 的那一份任务 */
  task: string;
  /** 冲突域（与兄弟隔离的边界） */
  conflictDomain: string;
  /** 归属 trace（缺省按分裂时刻生成） */
  traceId?: string;
  /** 显式模型（缺省按 routing worker/default 解析） */
  model?: string;
  /** 是否启动循环（默认 true；false 用于单测/干跑） */
  startLoop?: boolean;
}

/** 分裂结果 */
export interface SpawnSiblingAgentResult {
  peerId: string;
  /** 循环是否已发起（异步；不代表已完成） */
  loopStarted: boolean;
}

/**
 * 分裂出一个同级 Agent（真实创建 + 独立域账本 + 启动自身循环 + 同级关系登记）。
 *
 * 失败语义：创建后任何一步失败都会**回收 Agent**（不留下无宿主/无归属的个体）。
 */
export async function spawnSiblingAgent(
  input: SpawnSiblingAgentInput,
  deps: SplitAgentDeps,
): Promise<Result<SpawnSiblingAgentResult>> {
  const parentAgentId = input.parentAgentId.trim();
  const task = input.task.trim();
  const conflictDomain = input.conflictDomain.trim();
  if (!parentAgentId) return err("分裂缺少发起方 agentId");
  if (!task) return err("分裂缺少 task（交给同级 L1 的任务）");
  if (!conflictDomain) return err("分裂缺少 conflictDomain（否则无从隔离）");

  const routing = getRoutingConfig();
  const model =
    input.model ||
    routing?.workerModel ||
    routing?.defaultModel ||
    "worker-model";
  const traceId = input.traceId ?? `split-${Date.now().toString(36)}`;

  // ① 同级 Agent 实例（role=partner；与发起方同级，不设父子关系）
  const created = createAgent(
    { role: "partner", model, taskId: `split:${conflictDomain}` },
    traceId,
  );
  if (!created.ok) return err(`同级 L1 创建失败：${created.error}`);
  const peerId = created.value.agentId;

  // ② 独立域账本宿主（rootId = agentId；登记失败即回收 ①）
  const opened = deps.openHost(peerId);
  if (!opened.ok) {
    unregisterAgent(peerId);
    return err(`同级 L1 宿主登记失败：${opened.error}`);
  }

  // ③ 该 Agent 自己的循环（异步启动；失败留痕，不把"已登记但没跑"伪装成成功）
  const shouldStartLoop =
    input.startLoop !== false && typeof deps.startLoop === "function";
  if (shouldStartLoop) {
    const run = deps.startLoop!(
      peerId,
      `[同级 L1 · 冲突域 ${conflictDomain}] ${task}`,
    );
    void run
      .then((r) => {
        if (!r.ok) {
          logger.warn("同级 L1 循环执行失败（已登记但未完成）", {
            source: "Orchestration/splitAgent",
            peerId,
            error: r.error,
          });
        }
      })
      .catch((e: unknown) => {
        logger.warn("同级 L1 循环异常（已隔离）", {
          source: "Orchestration/splitAgent",
          peerId,
          error: e instanceof Error ? e.message : String(e),
        });
      });
  }

  // ④ 同级关系登记（AgentMerge 的判定依赖它）
  registerPeerSplit(parentAgentId, peerId);

  logger.info("已分裂出同级 L1", {
    source: "Orchestration/splitAgent",
    parentAgentId,
    peerId,
    conflictDomain,
    loopStarted: shouldStartLoop,
  });

  return ok({ peerId, loopStarted: shouldStartLoop });
}

/**
 * 回收一个刚分裂出的同级 Agent（分裂失败补偿 / 开除路径复用）。
 * 幂等：Agent 已不在注册表也不算错误（回收的目标是"最终不存在"）。
 */
export async function abandonSiblingAgent(
  peerId: string,
  deps: SplitAgentDeps,
): Promise<Result<void>> {
  const closed = deps.closeHost(peerId);
  unregisterAgent(peerId);
  if (!closed.ok) {
    logger.warn("同级 L1 宿主关闭失败（Agent 已注销）", {
      source: "Orchestration/splitAgent",
      peerId,
      error: closed.error,
    });
  }
  return ok(undefined);
}
