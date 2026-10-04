/**
 * @module Governance/governanceProvisioning
 * @description 治理角色的**按需创建与按需扩容**（2026-10-04 新增）。
 *
 * 设计依据（用户 2026-10-04 裁定）：
 *  > L0 级不是常驻的，而是**按需求创建**，同时会**按需求扩容**。
 *
 * 现状问题：
 *  - `Services/Arbitration/arbitratorPool.ts` 只维护**内存池位**（idle/busy/assignedCaseId），
 *    `dynamicScaling.ts` 只扩容**池位**并发 `ARBITRATOR_POOL_RESIZED` —— **都不产生真实 Agent**，
 *    且两者**均无生产调用者**（孤岛）；
 *  - 于是"需要一个 L0 角色来裁决"时，系统里**并不存在**该角色的 Agent 实例，
 *    导致审批只能由人类代理（见 G-09 备注）。
 *
 * 本模块补齐：按需把"角色需求"变成**真实注册 Agent**（经 `createAgent(..., { allowGovernance: true })`
 * 这一受控播种通道），并内置**扩容上限**与**幂等复用**，避免治理身份泛滥。
 *
 * 边界：
 *  - 只负责"确保存在某角色的 Agent"，不负责裁决本身；
 *  - 上限按 (role) 计（默认 2）：达到上限后不再创建，返回已有实例（**扩容有度**）。
 */

import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';
import { createAgent } from '../../Core/AgentRuntime/agentFactory.js';
import { getAgentsByRole, unregisterAgent } from '../../Core/AgentRuntime/agentRegistry.js';
import { logger } from '../../Infra/Logging/logger.js';
import { isGovernanceActor, toCanonicalRole, isCanonicalRole } from '../../Infra/Roles/roleVocabulary.js';
import { recordGovernanceAction } from './governanceAudit.js';

/** 每个角色的默认上限（按需扩容但有度） */
export const DEFAULT_MAX_AGENTS_PER_ROLE = 2;

/** 提供结果 */
export interface ProvisionResult {
  readonly agentId: string;
  readonly role: string;
  /** true = 本次新建；false = 复用了已有实例 */
  readonly created: boolean;
}

/** 角色 → 上限覆盖（可由配置注入；当前给治理角色更小的上限） */
const roleLimits = new Map<string, number>();

/** 设置某角色的扩容上限（0 或负数表示不限） */
export function setRoleAgentLimit(role: string, limit: number): void {
  roleLimits.set(toCanonicalRole(role), limit);
}

function limitOf(role: string): number {
  return roleLimits.get(toCanonicalRole(role)) ?? DEFAULT_MAX_AGENTS_PER_ROLE;
}

/** 找出该角色下**可用**（非 destroyed）的 Agent */
function usableAgents(role: string): Array<{ agentId: string; status: string }> {
  const canonical = toCanonicalRole(role) as Parameters<typeof getAgentsByRole>[0];
  return getAgentsByRole(canonical)
    .filter(a => a.status !== 'destroyed')
    .map(a => ({ agentId: a.agentId, status: String(a.status) }));
}

/**
 * 确保存在一个指定角色的 Agent（**按需创建 / 按需扩容**）。
 *
 * 语义：
 *  1. 已有可用实例 → **复用**（幂等，不重复创建）；
 *  2. 无实例且未达上限 → **创建**一个（治理角色走 `allowGovernance` 受控播种通道）；
 *  3. 已达上限 → 复用第一个（不无限扩容）；
 *  4. 角色非法 → 拒绝。
 *
 * @param role 需要的角色（两套词表均可，内部归一化为执行域称呼）
 * @param options.model 新建时使用的模型（默认 `'governance-model'` 占位，可由调用方指定）
 * @param options.traceId 归属 trace
 */
export function ensureAgentForRole(
  role: string,
  options: { model?: string; traceId?: string; reason?: string } = {},
): Result<ProvisionResult> {
  if (!role) return err('缺少角色');
  if (!isCanonicalRole(toCanonicalRole(role))) return err(`未知角色 ${role}`);

  const existing = usableAgents(role);
  const limit = limitOf(role);

  if (existing.length > 0 && (limit <= 0 || existing.length >= limit)) {
    // 已达上限（或本就存在）→ 复用，不再扩容
    return ok({ agentId: existing[0]!.agentId, role: toCanonicalRole(role), created: false });
  }
  if (existing.length > 0) {
    // 未达上限：仍优先复用空闲实例（避免为同一角色无谓扩容）
    return ok({ agentId: existing[0]!.agentId, role: toCanonicalRole(role), created: false });
  }

  // 需要创建：治理角色必须走受控播种通道（G-11 的逃生舱）
  const governance = isGovernanceActor(role);
  const created = createAgent(
    { role: toCanonicalRole(role) as never, model: options.model ?? 'governance-model' },
    options.traceId ?? 'governance-provisioning',
    { allowGovernance: true },
  );
  if (!created.ok) {
    logger.warn('治理角色按需创建失败', {
      source: 'governanceProvisioning/ensureAgentForRole', role, error: created.error,
    });
    return err(`按需创建 ${role} 失败：${created.error}`);
  }

  recordGovernanceAction({
    action: governance ? 'governance.agent_provisioned' : 'execution.agent_provisioned',
    actorRole: 'system',
    actorId: created.value.agentId,
    outcome: 'allowed',
    ...(options.traceId !== undefined ? { traceId: options.traceId } : {}),
    reason: `${options.reason ?? '系统请求'} → 按需创建 ${toCanonicalRole(role)} 角色 Agent（角色上限 ${limit}）`,
    targetIds: [created.value.agentId],
  });

  logger.info('已按需创建角色 Agent', {
    source: 'governanceProvisioning/ensureAgentForRole',
    role: toCanonicalRole(role),
    agentId: created.value.agentId,
    governance,
  });
  return ok({ agentId: created.value.agentId, role: toCanonicalRole(role), created: true });
}

/**
 * 批量确保多个角色存在（审批决策池用）。
 *
 * @returns 角色 → Agent ID 映射（失败的角色的键缺失）
 */
export function ensureAgentsForRoles(
  roles: readonly string[],
  options: { model?: string; traceId?: string; reason?: string } = {},
): Map<string, string> {
  const out = new Map<string, string>();
  for (const role of roles) {
    const r = ensureAgentForRole(role, options);
    if (r.ok) out.set(toCanonicalRole(role), r.value.agentId);
  }
  return out;
}

/**
 * 确保存在**至少 `count` 个互不相同**的角色 Agent（池化场景用，2026-10-04）。
 *
 * 与 `ensureAgentForRole` 的区别：后者"够用即复用"（审批只需一个身份即可代表角色）；
 * 而**仲裁者池**需要每个池位一个**独立** Agent（各自独立裁决、负载均衡），
 * 因此这里按需**扩容到指定规模**，并以调用方声明的规模驱动角色上限（"按需扩容"）。
 *
 * @returns 可用的 Agent ID 列表（长度 ≤ count；提供失败时可能少于 count）
 */
export function ensureDistinctAgentsForRole(
  role: string,
  count: number,
  options: { model?: string; traceId?: string; reason?: string } = {},
): Result<string[]> {
  if (!role) return err('缺少角色');
  if (!isCanonicalRole(toCanonicalRole(role))) return err(`未知角色 ${role}`);
  if (!Number.isFinite(count) || count <= 0) return err('count 必须为正数');

  const canonical = toCanonicalRole(role);
  const existing = usableAgents(role).map(a => a.agentId);
  const out = [...existing];

  // 调用方声明的规模驱动上限（扩容有度：上限 = max(既有上限, 需求)）
  const limit = Math.max(limitOf(role) <= 0 ? count : limitOf(role), count);
  setRoleAgentLimit(canonical, limit);

  while (out.length < count && out.length < limit) {
    const created = createAgent(
      { role: canonical as never, model: options.model ?? 'governance-model' },
      options.traceId ?? 'governance-provisioning',
      { allowGovernance: true },
    );
    if (!created.ok) {
      logger.warn('池化扩容创建 Agent 失败（返回已可用部分）', {
        source: 'governanceProvisioning/ensureDistinctAgentsForRole',
        role: canonical, error: created.error,
      });
      break;
    }
    out.push(created.value.agentId);
    recordGovernanceAction({
      action: isGovernanceActor(role) ? 'governance.agent_provisioned' : 'execution.agent_provisioned',
      actorRole: 'system',
      actorId: created.value.agentId,
      outcome: 'allowed',
      ...(options.traceId !== undefined ? { traceId: options.traceId } : {}),
      reason: `${options.reason ?? '池化需求'} → 按需扩容 ${canonical}（目标 ${count}，角色上限 ${limit}）`,
      targetIds: [created.value.agentId],
    });
  }

  return ok(out.slice(0, count));
}

/** 清空角色上限设置（测试用） */
export function resetRoleAgentLimits(): void {
  roleLimits.clear();
}

/**
 * **按需回收**：把某角色的治理 Agent 回收到 `keepCount` 个以内（2026-10-04）。
 *
 * 与"按需创建/扩容"对称：需求下降时应**释放**多余身份，避免 L0 Agent 无限增长。
 * 回收采用**软销毁**（`unregisterAgent` → `destroyed_at`），保留审计痕迹（不物理删除）。
 *
 * @param role 角色（两套词表均可）
 * @param keepCount 保留数量（默认 1：至少保留一个可用身份）
 * @param options.excludeAgentIds 不回收的 Agent（例如池中正忙的仲裁者）
 * @returns 实际回收的 Agent ID 列表
 */
export function recycleAgentsForRole(
  role: string,
  keepCount = 1,
  options: { excludeAgentIds?: readonly string[]; reason?: string } = {},
): Result<string[]> {
  if (!role) return err('缺少角色');
  if (!isCanonicalRole(toCanonicalRole(role))) return err(`未知角色 ${role}`);
  if (!Number.isFinite(keepCount) || keepCount < 0) return err('keepCount 必须为非负数');

  const canonical = toCanonicalRole(role);
  const excluded = new Set(options.excludeAgentIds ?? []);
  const candidates = usableAgents(role).filter(a => !excluded.has(a.agentId));

  // 保留 keepCount 个；额外回收（从后往前，优先回收"最后创建"的）
  const toRecycle = candidates.slice(keepCount).map(a => a.agentId);
  const recycled: string[] = [];

  for (const agentId of toRecycle) {
    const r = unregisterAgent(agentId);  // 软销毁（destroyed_at 留痕）
    if (!r.ok) {
      logger.warn('回收治理 Agent 失败', {
        source: 'governanceProvisioning/recycleAgentsForRole', agentId, error: r.error,
      });
      continue;
    }
    recycled.push(agentId);
    recordGovernanceAction({
      action: isGovernanceActor(role) ? 'governance.agent_recycled' : 'execution.agent_recycled',
      actorRole: 'system',
      actorId: agentId,
      outcome: 'allowed',
      reason: `${options.reason ?? '需求下降'} → 按需回收 ${canonical}（保留 ${keepCount}）`,
      targetIds: [agentId],
    });
  }

  if (recycled.length > 0) {
    logger.info('已按需回收角色 Agent', {
      source: 'governanceProvisioning/recycleAgentsForRole',
      role: canonical, recycled: recycled.length, keepCount,
    });
  }
  return ok(recycled);
}
