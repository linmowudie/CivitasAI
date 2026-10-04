/**
 * @module Governance/approvalIdentity
 * @description 审批决策者的**身份绑定**（2026-10-04 新增，落地清单 G-09）。
 *
 * 问题：`POST /api/approvals/:id/decide` 此前接受调用方自报的 `decidedBy`（形如 `role:identity`），
 *   身份**完全不可验证**。而身份正是**法定人数去重的依据**（"不同角色须由不同身份满足"），
 *   因此伪造身份即可让一个人同时顶替两个角色 —— 审批红线被绕过。
 *
 * 绑定规则（本地单机即可落地、不破坏既有 UI 流程）：
 *  - `user`（人类所有者）→ 身份**绑定当前活动账号**（`getActiveOwner()`），请求里的自报身份一律作废；
 *  - 治理/执行角色（`prime_director` / `auditor` / `regulatory_authority` / `arbitrator`）
 *    → 身份必须是**已注册 Agent 的 ID**，且该 Agent 的真实角色与所报角色一致（按两套词表等价判定）；
 *  - 校验失败 → 拒绝（fail-closed），并写入治理留痕（越权尝试是有价值的治理事实）。
 *
 * 为何不能"一律绑定账号"：本地单账号模式下，人类与 L1/L0 **Agent 是不同行为主体**
 *   （`user:local` 与 `auditor:agent-xxx`），绑定账号会让 CRITICAL 审批永远无法满足。
 *   因此对 Agent 角色改用"必须是真实注册 Agent 且角色匹配"这一**可验证**的绑定。
 */

import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';
import { getActiveOwner } from '../AccountScope/activeAccount.js';
import { getAgent } from '../../Core/AgentRuntime/agentRegistry.js';
import { parseDecidedByRole } from './governanceGuard.js';
import { toApprovalRole, toCanonicalRole } from '../../Infra/Roles/roleVocabulary.js';
import { recordGovernanceAction } from './governanceAudit.js';

export interface BoundApprovalIdentity {
  /** 绑定后的 `role:identity`，应以此调用 `decideApproval` */
  readonly decidedBy: string;
  readonly role: string;
  readonly identity: string;
  /** 请求自报的身份（仅用于留痕对照，不参与授权） */
  readonly claimedIdentity: string | null;
  /** 是否发生了身份替换（自报 ≠ 绑定） */
  readonly rewritten: boolean;
  /** 身份来源：服务端令牌 / 活动账号 / 已注册 Agent / 人类代理 */
  readonly source: 'server_token' | 'active_account' | 'registered_agent' | 'human_proxy';
  /** 人类代理治理角色时为 true（客户端"单操作者模式"：一次点击补齐多个角色） */
  readonly proxiedByHuman?: boolean;
}

/** 从 `role:identity` 取身份部分（无冒号则为空） */
function identityPart(decidedBy: string): string | null {
  const sep = decidedBy.indexOf(':');
  return sep > 0 ? decidedBy.slice(sep + 1) : null;
}

/** 身份是否形如受管 Agent ID（`agent-<role>-<n>`） */
function looksLikeAgentId(identity: string): boolean {
  return /^agent-[a-z_]+-\d+$/i.test(identity);
}

/**
 * 解析并绑定审批决策者身份。
 *
 * 绑定优先级（2026-10-04，方案 A + 方案 B）：
 *  1. **服务端令牌已验证身份**（`verifiedUserId`，方案 B）→ 最高优先，覆盖自报与本地账号；
 *  2. `user` 角色 → 绑定**当前活动账号**（方案 A）；
 *  3. Agent 角色：
 *     - 身份形如 `agent-xxx` → 必须是**真实注册 Agent** 且角色匹配；
 *     - 否则视为**人类代理**（客户端单操作者模式），接受但在留痕中标明 `proxiedByHuman`
 *       ——不静默：代理事实必须可审计，便于日后收紧为"必须真实 Agent"（见清单 G-09 备注）。
 *
 * @param decidedBy 请求自报的 `role:identity`（或纯角色/纯身份）
 * @param deps 依赖注入（便于测试）：取活动账号、按 ID 取 Agent、服务端已验身份
 */
export function bindApprovalIdentity(
  decidedBy: string,
  deps: {
    getOwner?: () => string;
    getAgentById?: (agentId: string) => { agentId: string; role: string } | undefined;
    /** 服务端令牌校验后的用户 ID（方案 B，可选） */
    verifiedUserId?: string;
  } = {},
): Result<BoundApprovalIdentity> {
  const ownerOf = deps.getOwner ?? (() => getActiveOwner());
  const agentOf = deps.getAgentById ?? ((id: string) => {
    const a = getAgent(id);
    return a ? { agentId: a.agentId, role: String(a.role) } : undefined;
  });

  if (!decidedBy || typeof decidedBy !== 'string') {
    return err('缺少决策者标识（decidedBy）');
  }

  const role = parseDecidedByRole(decidedBy);
  const claimedIdentity = identityPart(decidedBy);

  // ① 人类所有者：优先用**服务端已验身份**（方案 B），否则绑定活动账号（方案 A）
  if (role === 'user') {
    if (deps.verifiedUserId) {
      const rewritten = claimedIdentity !== null && claimedIdentity !== deps.verifiedUserId;
      if (rewritten) {
        recordGovernanceAction({
          action: 'approval.identity_mismatch',
          actorRole: role,
          actorId: deps.verifiedUserId,
          outcome: 'denied',
          reason: `自报身份 "${claimedIdentity}" 与服务端令牌身份 "${deps.verifiedUserId}" 不一致，已按令牌身份绑定`,
        });
      }
      return ok({
        decidedBy: `${role}:${deps.verifiedUserId}`, role, identity: deps.verifiedUserId,
        claimedIdentity, rewritten, source: 'server_token',
      });
    }
    const owner = ownerOf();
    const rewritten = claimedIdentity !== null && claimedIdentity !== owner;
    if (rewritten) {
      recordGovernanceAction({
        action: 'approval.identity_mismatch',
        actorRole: role,
        actorId: owner,
        outcome: 'denied',
        reason: `自报身份 "${claimedIdentity}" 与活动账号 "${owner}" 不一致，已按活动账号绑定`,
      });
    }
    return ok({
      decidedBy: `${role}:${owner}`, role, identity: owner,
      claimedIdentity, rewritten, source: 'active_account',
    });
  }

  // ② 治理/执行 Agent 角色
  if (!claimedIdentity) {
    return err(`角色 ${role} 的决策者必须提供身份（形如 ${role}:agent-xxx 或 ${role}:操作者）`);
  }

  // ② a 形如 Agent ID → 必须真实注册且角色匹配（严格校验）
  if (looksLikeAgentId(claimedIdentity)) {
    const agent = agentOf(claimedIdentity);
    if (!agent) {
      recordGovernanceAction({
        action: 'approval.decide',
        actorRole: role,
        actorId: claimedIdentity,
        outcome: 'denied',
        reason: `身份校验失败：${claimedIdentity} 不是已注册 Agent`,
      });
      return err(`身份校验失败：${claimedIdentity} 不是已注册 Agent`);
    }
    const actualApprovalRole = toApprovalRole(toCanonicalRole(String(agent.role)));
    if (actualApprovalRole !== role) {
      recordGovernanceAction({
        action: 'approval.decide',
        actorRole: role,
        actorId: agent.agentId,
        outcome: 'denied',
        reason: `身份校验失败：Agent ${agent.agentId} 的真实角色为 ${agent.role}，与所报 ${role} 不符`,
      });
      return err(`身份校验失败：Agent ${agent.agentId} 的真实角色为 ${agent.role}，与所报 ${role} 不符`);
    }
    return ok({
      decidedBy: `${role}:${agent.agentId}`, role, identity: agent.agentId,
      claimedIdentity, rewritten: false, source: 'registered_agent',
    });
  }

  // ② b 非 Agent ID → 人类代理治理角色（客户端单操作者模式）
  //      接受但**显式留痕**（不静默），并绑定到活动账号/服务端身份以便追溯
  const proxyIdentity = deps.verifiedUserId ?? ownerOf();
  recordGovernanceAction({
    action: 'approval.human_proxy',
    actorRole: role,
    actorId: proxyIdentity,
    outcome: 'allowed',
    reason: `人类代理 ${role} 角色裁决（自报身份 "${claimedIdentity}"），已绑定代理身份 "${proxyIdentity}"`,
  });
  return ok({
    decidedBy: `${role}:${proxyIdentity}`, role, identity: proxyIdentity,
    claimedIdentity, rewritten: claimedIdentity !== proxyIdentity, source: 'human_proxy', proxiedByHuman: true,
  });
}
