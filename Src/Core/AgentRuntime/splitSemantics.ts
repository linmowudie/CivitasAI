/**
 * @module AgentRuntime/splitSemantics
 * @description Agent 分裂/合并的**语义层**（用户裁定 2026-10-14 口述语义的代码化）。
 *
 * 分裂面底层件（agentSplit/agentMerge 工具、splitMergeToolPort、DomainLedger、
 * l1HostRegistry）已在位，但 13 条语义验收点此前无实现落点。本模块按设计声明的语义
 * 给出可运行实现：血缘 / 继承策略 / 深度上限 / 授权 / 可见性 / 自分裂 / 自合并 /
 * 相似度 / 闭环校验 / 冲突域 / 同级判定 / 每步一个 / 合并形态。
 *
 * 口径：
 * - 签名与语义按设计文档 + benchmark 契约实现，两者不一致时以设计为准并同步修 benchmark；
 * - 深度/冲突域等约束是**真判定**（违反即 `err`），不是恒真桩；
 * - 副作用（建 Agent / 留痕 / 事件）走既有公共 API，失败不伪造成功。
 */

import {
  getAgent,
  getAgentParent,
  hasAgent,
  setAgentParent,
} from "./agentRegistry.js";
import { ok, err } from "../../Infra/types.js";
import type { Result } from "../../Infra/types.js";
import { recordGovernanceAction } from "../../Services/Governance/governanceAudit.js";
import { publish, createEvent } from "../../Services/EventBus/eventBus.js";
import { EventType } from "../../Services/EventBus/eventTypes.js";
import { logger } from "../../Infra/Logging/logger.js";

/** 分裂深度上限（自根算起；根 = 0） */
export const SPLIT_DEPTH_LIMIT = 2;

export interface SplitLineageEntry {
  agentId: string;
  parentAgentId: string | null;
  depth: number;
  rootId: string;
}

export interface SplitInheritancePolicy {
  inheritGoal: boolean;
  inheritTools: boolean;
  inheritBudget: boolean;
  inheritVisibility: boolean;
  /** 子代是否重置预算（同额复制会让总预算随分裂数线性膨胀） */
  resetBudget: boolean;
}

export interface SplitPart {
  id: string;
  task?: string;
  files?: string[];
  writePaths?: string[];
}

export interface SplitApproval {
  approvalId: string;
  status: "pending";
  agentId: string;
  domain: string;
}

export interface VisibilityScope {
  visible: string[];
  hidden: string[];
}

export interface ClosureReport {
  closed: boolean;
  missing: string[];
}

export type MergeKind = "self_merge" | "peer_merge" | "absorb" | "none";

/** 同级（peer）关系登记：key = 排序后的 "a|b" */
const peerPairs = new Set<string>();
const mergeRequests = new Map<
  string,
  {
    requestId: string;
    agentId: string;
    peerId: string;
    kind: MergeKind;
    requestedAt: number;
  }
>();
let mergeCounter = 0;

function pairKey(a: string, b: string): string {
  return [a, b].sort().join("|");
}

/** 重置（测试用） */
export function resetSplitSemantics(): void {
  peerPairs.clear();
  mergeRequests.clear();
  mergeCounter = 0;
}

/** 查询分裂血缘：返回**根 → 本节点**的链（含每节点深度与 rootId）。 */
export function querySplitLineage(agentId: string): SplitLineageEntry[] {
  const chain: string[] = [];
  const guard = new Set<string>();
  let cur: string | undefined = agentId;
  while (cur && !guard.has(cur)) {
    guard.add(cur);
    chain.unshift(cur);
    cur = getAgentParent(cur);
  }
  const rootId = chain[0] ?? agentId;
  return chain.map((id, i) => ({
    agentId: id,
    parentAgentId: i === 0 ? null : (chain[i - 1] ?? null),
    depth: i,
    rootId,
  }));
}

/** 派生继承策略：目标/工具继承，预算**重置**（否则分裂即放大总预算）。 */
export function splitInheritancePolicy(
  parentAgentId: string,
): SplitInheritancePolicy {
  const parent = getAgent(parentAgentId);
  const isExecutionRole = parent
    ? parent.role === "worker" ||
      parent.role === "partner" ||
      parent.role === "assembly_node"
    : true;
  return {
    inheritGoal: true,
    inheritTools: isExecutionRole,
    inheritBudget: false,
    inheritVisibility: true,
    resetBudget: true,
  };
}

/** 分裂深度上限（设计 §3.7：防自相似无限分裂） */
export function splitDepthLimit(): number {
  return SPLIT_DEPTH_LIMIT;
}

/** 该 Agent 当前深度（根 = 0） */
export function splitDepthOf(agentId: string): number {
  return querySplitLineage(agentId).length - 1;
}

/**
 * 申请分裂授权（治理动作）：分裂改变 Agent 拓扑，必须留痕并由治理侧批准。
 * 返回待审批单；本函数不伪造"已批准"。
 */
export function requestSplitApproval(input: {
  agentId: string;
  domain: string;
  parts: readonly SplitPart[];
}): Result<SplitApproval> {
  if (input.parts.length === 0) return err("分裂至少需要一个分片");
  const approvalId = `split-approval-${Date.now().toString(36)}-${++mergeCounter}`;
  try {
    recordGovernanceAction({
      action: "delegation.assigned",
      actorRole: "orchestrator",
      actorId: input.agentId,
      outcome: "allowed",
      reason: `申请分裂授权：domain=${input.domain}，分片=${input.parts.map((p) => p.id).join(",")}`,
      targetIds: input.parts.map((p) => p.id),
    });
  } catch (e) {
    logger.warn("分裂授权留痕失败（不阻断申请）", {
      source: "splitSemantics/requestSplitApproval",
      error: e instanceof Error ? e.message : String(e),
    });
  }
  return ok({
    approvalId,
    status: "pending",
    agentId: input.agentId,
    domain: input.domain,
  });
}

/**
 * 分裂后的可见性范围：每个分片 Agent 只看得到**自己分片**的文件，其它分片进入 hidden
 * （冲突域拆分必须配可见性收窄，否则读写仍会互踩）。
 */
export function splitVisibilityScope(input: {
  agentId: string;
  parts: readonly SplitPart[];
}): VisibilityScope {
  const own = input.parts.find((p) => p.id === input.agentId);
  const ownFiles = new Set(own?.files ?? []);
  const visible = [...ownFiles];
  const hidden: string[] = [];
  const seen = new Set<string>(ownFiles);
  for (const part of input.parts) {
    if (part.id === input.agentId) continue;
    for (const f of part.files ?? []) {
      if (seen.has(f)) continue;
      seen.add(f);
      hidden.push(f);
    }
  }
  return { visible, hidden };
}

/**
 * Agent 自分裂：按分片创建同级 Agent（parent = 本 Agent），登记同级关系。
 * 约束（违反即拒绝）：深度不超上限；分片间无可写冲突；每步一次由调用方校验。
 */
export async function agentSelfSplit(input: {
  agentId: string;
  task: string;
  parts: readonly SplitPart[];
  traceId?: string;
}): Promise<Result<{ siblings: string[]; lineage: SplitLineageEntry[] }>> {
  if (input.parts.length === 0) return err("自分裂至少需要一个分片");
  const depth = splitDepthOf(input.agentId);
  if (depth + 1 > SPLIT_DEPTH_LIMIT) {
    return err(`分裂深度超限：当前深度 ${depth}，上限 ${SPLIT_DEPTH_LIMIT}`);
  }
  const conflicts = detectConflictDomain(input.parts);
  if (conflicts.length > 0) {
    return err(`分片存在可写冲突（冲突域：${conflicts.join(", ")}），禁止分裂`);
  }

  const parent = getAgent(input.agentId);
  const model = parent?.model ?? "unknown/model";
  const traceId =
    input.traceId ?? parent?.traceId ?? `split-${Date.now().toString(36)}`;
  const { createAgent } = await import("./agentFactory.js");
  const siblings: string[] = [];
  for (const part of input.parts) {
    const created = createAgent(
      { role: "partner", model, taskId: part.id },
      traceId,
      { allowGovernance: false },
    );
    if (!created.ok) {
      return err(`创建分片 Agent 失败（${part.id}）：${created.error}`);
    }
    siblings.push(created.value.agentId);
    setAgentParent(created.value.agentId, input.agentId);
  }
  for (let i = 0; i < siblings.length; i++) {
    for (let j = i + 1; j < siblings.length; j++) {
      peerPairs.add(pairKey(siblings[i] as string, siblings[j] as string));
    }
  }

  try {
    publish(
      createEvent({
        eventType: EventType.DELEGATION_ASSIGNED,
        source: "AgentRuntime/splitSemantics",
        payload: {
          parentAgentId: input.agentId,
          siblings,
          domain: input.parts.map((p) => p.id),
          task: input.task,
        },
      }),
    );
  } catch {
    /* 事件失败不阻断分裂结果（已建出的 Agent 不回滚） */
  }

  return ok({ siblings, lineage: querySplitLineage(input.agentId) });
}

/**
 * Agent 申请自合并：只有同级关系（同父）或同根可申请；形态由 `mergeKindOf` 判定，
 * 最终裁决属治理侧（本函数只登记申请）。
 */
export function agentRequestMerge(input: {
  agentId: string;
  peerId: string;
  reason?: string;
}): Result<{ requestId: string; kind: MergeKind }> {
  if (!hasAgent(input.agentId)) return err(`Agent ${input.agentId} 未注册`);
  if (!hasAgent(input.peerId)) return err(`Agent ${input.peerId} 未注册`);
  const kind = mergeKindOf(input.agentId, input.peerId);
  if (kind === "none") {
    return err(
      `Agent ${input.agentId} 与 ${input.peerId} 不存在可合并关系（非同级/非同根）`,
    );
  }
  const requestId = `merge-req-${Date.now().toString(36)}-${++mergeCounter}`;
  mergeRequests.set(requestId, {
    requestId,
    agentId: input.agentId,
    peerId: input.peerId,
    kind,
    requestedAt: Date.now(),
  });
  try {
    recordGovernanceAction({
      action: "arbitration.consolidate",
      actorRole: "orchestrator",
      actorId: input.agentId,
      outcome: "allowed",
      reason: input.reason ?? `申请合并（形态 ${kind}）`,
      targetIds: [input.peerId],
    });
    publish(
      createEvent({
        eventType: EventType.ARBITRATION_REQUEST,
        source: "AgentRuntime/splitSemantics",
        payload: {
          requestId,
          agentId: input.agentId,
          peerId: input.peerId,
          kind,
        },
      }),
    );
  } catch (e) {
    logger.warn("合并申请留痕/事件失败（申请仍登记）", {
      source: "splitSemantics/agentRequestMerge",
      error: e instanceof Error ? e.message : String(e),
    });
  }
  return ok({ requestId, kind });
}

/** 查询已登记的合并申请（测试/观测用） */
export function listMergeRequests(): Array<{
  requestId: string;
  agentId: string;
  peerId: string;
  kind: MergeKind;
}> {
  return [...mergeRequests.values()].map((r) => ({
    requestId: r.requestId,
    agentId: r.agentId,
    peerId: r.peerId,
    kind: r.kind,
  }));
}

/** 工作相似度（token Jaccard，0–1）：用于判定"是否值得分裂/合并" */
export function measureWorkSimilarity(a: string, b: string): number {
  const tokens = (text: string): Set<string> =>
    new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9\u4e00-\u9fff]+/i)
        .map((t) => t.trim())
        .filter((t) => t.length >= 2),
    );
  const setA = tokens(a);
  const setB = tokens(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter++;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * 分裂闭环：分片集合必须覆盖原任务的全部要件（否则分裂制造"没人负责的缺口"）。
 * `missing` 列出未被任何分片覆盖的任务 token（最多 10 条）。
 */
export function validateSplitClosure(input: {
  task: string;
  parts: readonly SplitPart[];
}): ClosureReport {
  if (input.parts.length === 0)
    return { closed: false, missing: ["（无分片）"] };
  const norm = (s: string): Set<string> =>
    new Set(
      s
        .toLowerCase()
        .split(/[^a-z0-9\u4e00-\u9fff]+/i)
        .map((t) => t.trim())
        .filter((t) => t.length >= 2),
    );
  const partTokens = norm(
    input.parts
      .map((p) => `${p.task ?? ""} ${(p.files ?? []).join(" ")}`)
      .join(" "),
  );
  const taskTokens = norm(input.task);
  const missing: string[] = [];
  for (const t of taskTokens) {
    if (!partTokens.has(t)) missing.push(t);
    if (missing.length >= 10) break;
  }
  return { closed: missing.length === 0, missing };
}

/**
 * 冲突域检测：同一可写路径出现在多个分片 ⇒ 分裂不安全（会产生写冲突）。
 * 返回被多个分片共享的可写路径（去重、排序）。
 */
export function detectConflictDomain(parts: readonly SplitPart[]): string[] {
  const owners = new Map<string, Set<string>>();
  for (const part of parts) {
    for (const path of part.writePaths ?? []) {
      const set = owners.get(path) ?? new Set<string>();
      set.add(part.id);
      owners.set(path, set);
    }
  }
  const conflicts: string[] = [];
  for (const [path, ids] of owners) {
    if (ids.size > 1) conflicts.push(path);
  }
  return conflicts.sort();
}

/** 登记一对同级关系（分裂成功后由工具层写入，供 isPeerSplit/mergeKindOf 判定） */
export function registerPeerSplit(a: string, b: string): void {
  const left = a.trim();
  const right = b.trim();
  if (!left || !right || left === right) return;
  peerPairs.add(pairKey(left, right));
}

/** 是否同级分裂（同父且父存在） */
export function isPeerSplit(a: string, b: string): boolean {
  if (a === b) return false;
  const parentA = getAgentParent(a);
  const parentB = getAgentParent(b);
  if (parentA && parentA === parentB) return true;
  return peerPairs.has(pairKey(a, b));
}

/**
 * 防爆量：同一 step 内至多一次分裂（多次会让 Agent 数指数增长）。
 * 入参是各分裂动作所属 step，返回该 step 内是否合法（≤1 次）。
 */
export function splitOnePerStep(input: {
  stepIndex: number;
  splits: ReadonlyArray<{ stepIndex: number }>;
}): boolean {
  return (
    input.splits.filter((s) => s.stepIndex === input.stepIndex).length <= 1
  );
}

/** 合并形态判定：自合并 / 同级合并 / 吸收（祖先-后代） / 不可合并 */
export function mergeKindOf(a: string, b: string): MergeKind {
  if (a === b) return "self_merge";
  const lineageA = querySplitLineage(a).map((e) => e.agentId);
  const lineageB = querySplitLineage(b).map((e) => e.agentId);
  if (lineageA.includes(b) || lineageB.includes(a)) return "absorb";
  if (isPeerSplit(a, b)) return "peer_merge";
  return "none";
}
