/**
 * @module Services/A2A/cardSync
 * @description 注册表 ↔ Agent Card **同步桥**（P0a 后端内核）。
 *
 * 落实设计 §18 #2（注册表为唯一写入点 → 卡片派生签发、运行态事件驱动同步）与 #3（`father` 正式字段）。
 *
 * 三条同步规则：
 *  1. **注册即签发**：`onRegistered` → 派生卡片（`father/lineage` 取自注册表正式字段，缺失时回退旁挂 Map）；
 *  2. **状态同步不重签**：`onStatusChanged` → 只更新 `status/health/updateTime`（指纹不变，§18 #22）；
 *  3. **注销即标记销毁**：`onUnregistered` → 卡片置 `destroyed`（**不删行**，保留审计）。
 */

import {
  getAllAgents, getAgent, getAgentParent, setAgentLifecycleHooks,
} from '../../Core/AgentRuntime/agentRegistry.js';
import { issueCardForAgent } from './a2aBroker.js';
import { listCards, loadCard, persistCard } from './a2aStore.js';
import { syncRuntimeState } from './agentCard.js';
import type { AgentInstance } from '../../Core/AgentRuntime/types.js';
import type { AgentCard, FatherRef } from './types.js';

/** 解析父引用：优先用 `AgentInstance.father`（正式字段），回退旁挂 Map（只读兼容） */
export function resolveFather(agent: AgentInstance): FatherRef | null {
  if (agent.father) return agent.father;
  const parentId = getAgentParent(agent.agentId);
  if (!parentId) return null;
  const parent = getAgent(parentId);
  return { agentId: parentId, role: parent?.role ?? agent.role };
}

/** 由注册表快照派生并签发（或幂等重签）卡片 */
export function syncCardForAgent(agent: AgentInstance): AgentCard {
  const previous = loadCard(agent.agentId);
  const father = resolveFather(agent) ?? previous?.father ?? null;
  const lineage = father
    ? (previous?.lineage?.includes(father.agentId) ? previous.lineage : [father.agentId])
    : (previous?.lineage ?? []);
  return issueCardForAgent(agent, { father, lineage });
}

/** 运行态同步：`status/health` 变化 **只更新运行态**（不重签、不改指纹） */
export function syncCardStatus(agent: AgentInstance): AgentCard | null {
  const existing = loadCard(agent.agentId);
  if (!existing) return syncCardForAgent(agent);          // 卡片缺失（如回灌场景）→ 补签
  const updated = syncRuntimeState(existing, agent);
  persistCard(updated);
  return updated;
}

/** 注销 → 卡片标记 `destroyed`（保留历史版本，审计需要） */
export function markCardDestroyed(agentId: string, now = Date.now()): AgentCard | null {
  const existing = loadCard(agentId);
  if (!existing) return null;
  const updated: AgentCard = { ...existing, status: 'destroyed', updateTime: now };
  persistCard(updated);
  return updated;
}

/** 装配到注册表生命周期钩子（幂等；钩子内部已 fail-safe） */
export function attachAgentCardSync(): void {
  setAgentLifecycleHooks({
    onRegistered: (agent) => { syncCardForAgent(agent); },
    onStatusChanged: (agent) => { syncCardStatus(agent); },
    onUnregistered: (agentId) => { markCardDestroyed(agentId); },
    onParentChanged: (agent) => { syncCardForAgent(agent); },
  });
}

/** 卸载钩子（测试与热重载用） */
export function detachAgentCardSync(): void {
  setAgentLifecycleHooks(null);
}

/**
 * 回灌对账：进程启动/历史数据回灌后，为"有实例但无卡片"或"卡片与实例不一致"的 agent 补签/同步。
 * @returns `{ issued, synced, destroyed }` 统计（可测）
 */
export function reconcileAgentCards(now = Date.now()): { issued: number; synced: number; destroyed: number } {
  let issued = 0; let synced = 0; let destroyed = 0;
  const live = new Set<string>();
  for (const agent of getAllAgents()) {
    live.add(agent.agentId);
    const card = loadCard(agent.agentId);
    if (!card) { syncCardForAgent(agent); issued++; continue; }
    if (card.status !== agent.status) {
      persistCard(syncRuntimeState(card, agent, now));
      synced++;
    }
  }
  // 卡片仍在"可用"状态但实例已消失 → 标记销毁（避免幽灵 agent 仍能通信）
  for (const card of listCards({ limit: 1000 })) {
    if (live.has(card.agentId)) continue;
    if (card.status === 'destroyed') continue;
    persistCard({ ...card, status: 'destroyed', updateTime: now });
    destroyed++;
  }
  return { issued, synced, destroyed };
}
