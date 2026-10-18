/**
 * @module Orchestration/splitMergeComposition
 * @description 分裂/自合并的**生产组合根**（2026-10-17）。
 *
 * 背景：`AgentSplit`/`AgentMerge` 此前在生产里恒返回 `NOT_ENABLED` ——
 * `splitMergeFor(agentId)` 端口由组合根按身份注入，而 `main.ts` **从未登记任何 L1 宿主、
 * 也没提供同级 L1 工厂/监管提交口**。
 *
 * 本模块只做"把真实依赖装配起来"，分裂 Agent 的**本体实现**在
 * `./splitAgent.ts`（创建同级 Agent → 独立域账本 → 启动自身循环 → 同级登记/回收）。
 * 其余真实依赖：
 * - `shared`：域进展写入**共享上下文**（否则自合并永远发现不了相关性）；
 * - `submitToRegulator`：走真实审批队列（HITL 受理号 = approvalId）；
 * - 宿主**懒登记**：L1 角色首次使用分裂能力时建立域账本（rootId = agentId）。
 */

import {
  type L1HostRegistry,
  type SplitMergeRuntimeDeps,
} from "./l1HostRegistry.js";
// P0 融合：账本所有权统一到 LedgerHub（外层/分裂/监管共用同一份 L1 账本）
import {
  getL1HostRegistry,
  ensureL1Host,
  resetL1LedgerHub,
} from "./ledgerHub.js";
import { createSplitMergeToolPort } from "./splitMergeToolPort.js";
import {
  spawnSiblingAgent,
  abandonSiblingAgent,
  type SplitAgentDeps,
} from "./splitAgent.js";
import type { SplitMergePort } from "../../Tools/Registry/toolServicePorts.js";
// 分裂语义层（同层 Core/AgentRuntime）：授权单留痕 + 同级登记 + 形态判定，经端口透出给 Tools
import {
  requestSplitApproval,
  registerPeerSplit,
  mergeKindOf,
} from "../AgentRuntime/splitSemantics.js";
import { write as writeWorkspace } from "../../Services/SharedMemory/globalWorkspace.js";
import { createApproval } from "../../Services/LoopControl/approvalGate.js";
import { ok, err } from "../../Infra/types.js";
import { logger } from "../../Infra/Logging/logger.js";

let registry: L1HostRegistry | null = null;
let portFactory: ((agentId: string) => SplitMergePort | undefined) | null =
  null;

function ensureInitialized(): void {
  if (registry && portFactory) return;

  const hostRegistry = getL1HostRegistry();

  // 分裂 Agent 本体的宿主依赖（组合根提供）：域账本登记/关闭 + 循环启动
  const splitDeps: SplitAgentDeps = {
    openHost(agentId) {
      const opened = hostRegistry.open({ agentId });
      return opened.ok ? ok(undefined) : err(opened.error);
    },
    closeHost(agentId) {
      const closed = hostRegistry.close(agentId);
      return closed.ok ? ok(undefined) : err(closed.error);
    },
    async startLoop(agentId, instruction) {
      // 动态导入避免 Core 内部静态环（splitAgent ← composition → agentExecutor）
      const { executeAssignedTask } =
        await import("../AgentRuntime/agentExecutor.js");
      return executeAssignedTask({ agentId, instruction });
    },
  };

  /** 每个 L1 身份一份运行时依赖（openSiblingPeer 需要知道发起方是谁） */
  const runtimeFor = (parentAgentId: string): SplitMergeRuntimeDeps => ({
    async openSiblingPeer(input) {
      const spawned = await spawnSiblingAgent(
        {
          parentAgentId,
          task: input.task,
          conflictDomain: input.conflictDomain,
        },
        splitDeps,
      );
      if (!spawned.ok) return err(spawned.error);
      return ok({ peerId: spawned.value.peerId });
    },

    async abandonPeer(peerId) {
      return abandonSiblingAgent(peerId, splitDeps);
    },

    shared: {
      async publish(payload) {
        const written = writeWorkspace({
          key: `domain:${payload.rootId}`,
          content: JSON.stringify({
            rootId: payload.rootId,
            selfState: payload.selfState,
            peers: payload.peers,
          }),
          contentType: "status",
          assertion: "observed",
          traceId: payload.rootId,
          agentId: payload.rootId,
        });
        return written.ok ? ok(undefined) : err(written.error);
      },
    },

    async submitToRegulator(req) {
      const created = createApproval(
        {
          loopId: req.raisedById,
          traceId: `merge:${req.id}`,
          iteration: 0,
          requestedBy: req.raisedById,
          kind: "tool_execute",
          payload: req,
          riskLevel: "HIGH",
          timeoutSec: 300,
          defaultOnTimeout: "reject",
          deciders: [{ role: "user", weight: 1 }],
          decisionPolicy: "majority",
        },
        300,
      );
      if (!created.ok) return err(`合并请求提交监管失败：${created.error}`);
      return ok({ caseId: created.value.approvalId });
    },

    now: () => Date.now(),

    hostAgentId: parentAgentId,
    requestSplitApproval,
    registerPeerSplit,
    mergeKind: mergeKindOf,
  });

  registry = hostRegistry;
  portFactory = (agentId: string) => {
    const host = hostRegistry.resolve(agentId);
    if (!host) return undefined;
    return createSplitMergeToolPort({
      domain: host.domain,
      ...runtimeFor(agentId),
    });
  };
}

/**
 * 按身份取分裂/合并端口（生产注入入口）。
 *
 * 宿主**懒登记**：L1 角色首次使用分裂能力时建立域账本；同身份不得挂两本账
 * （重复调用复用已登记宿主）。
 */
export function splitMergePortFor(agentId: string): SplitMergePort | undefined {
  ensureInitialized();
  const trimmed = agentId.trim();
  if (!registry || !portFactory || trimmed === "") return undefined;
  if (!registry.resolve(trimmed)) {
    const opened = ensureL1Host(trimmed);
    if (!opened.ok) {
      logger.warn("L1 宿主懒登记失败（分裂能力对该 Agent 不可用）", {
        source: "Orchestration/splitMergeComposition",
        agentId: trimmed,
        error: opened.error,
      });
      return undefined;
    }
  }
  return portFactory(trimmed);
}

/** 已登记的 L1 宿主（诊断/观测用） */
export function listSplitMergeHosts(): string[] {
  return registry?.hostIds() ?? [];
}

/** 重置（测试隔离用；同时清空 LedgerHub，保证测试间账本不串） */
export function resetSplitMergeComposition(): void {
  registry = null;
  portFactory = null;
  resetL1LedgerHub();
}
