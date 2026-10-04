/**
 * @module Governance/governanceGuard
 * @description 治理动作的角色守卫（2026-10-04 新增）。
 *
 * 设计原则（产品决策）：
 *  - **治理层只能由 L0 承担**：审批、仲裁、审计、监管、验收等"裁决/否决/执法"动作
 *    必须由 L0 治理角色（Regulator / Auditor / Arbitrator）执行；
 *  - **L1 / L2 只负责"做事"**：编排、执行、评审产出物可以做，但**不得裁决**；
 *  - **人类所有者（user）** 是最终权威，等同于治理层（可裁决）。
 *
 * 词表说明（重要）：
 *  审批域用 `Services/LoopControl/types.ts` 的 `UserRole`
 *  （`user | prime_director | regulatory_authority | auditor`），
 *  与执行域 `Infra/types.ts` 的 `UserRole`（prime_director/partner/worker/regulator/auditor/arbitrator…）
 *  **不是同一套**。本模块同时兼容两套词表：`regulatory_authority` 与 `regulator` 视为同一治理角色，
 *  `arbitrator` 亦纳入（执行域称呼）。
 */

import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';
import { recordGovernanceAction } from './governanceAudit.js';
import { L0_ROLES_APPROVAL, L0_ROLES_CANONICAL, tierOfRole as tierOfRoleCanonical } from '../../Infra/Roles/roleVocabulary.js';

/** 审批域：人类所有者（最终权威） */
export const OWNER_ROLE = 'user';

/** 治理角色（L0）：两套词表的并集 */
export const L0_GOVERNANCE_ROLES: readonly string[] = [
  ...L0_ROLES_APPROVAL,   // 审批域称呼（含 regulatory_authority）
  ...L0_ROLES_CANONICAL,  // 执行域称呼（含 regulator / arbitrator）
];

/** 执行层级角色（明确**不得**执行治理动作） */
export const EXECUTION_ROLES: readonly string[] = [
  'prime_director', 'partner', 'worker', 'reviewer', 'assembly_node',
];

/** 是否具备治理资格（L0 或人类所有者） */
export function isGovernanceRole(role: string | undefined | null): boolean {
  if (!role) return false;
  return role === OWNER_ROLE || L0_GOVERNANCE_ROLES.includes(role);
}

/** 层级：人类所有者 / L0 治理 / L1 入口级 / L2 执行级 */
export type ActorTier = 'owner' | 'L0' | 'L1' | 'L2';

/**
 * 判定角色所属层级（兼容两套词表）。
 *
 * 2026-10-04（G-16）：**委托给权威词表** `Infra/Roles/roleVocabulary.tierOfRole`，
 * 避免此处再维护一份分层规则导致漂移（历史上正因两份词表而三次踩坑）。
 */
export function tierOf(role: string | undefined | null): ActorTier | undefined {
  return tierOfRoleCanonical(role);
}

/**
 * 按**请求方层级**构造不可逆操作的审批人池（2026-10-04 修订，对齐产品规则）。
 *
 * 产品规则：
 *  - **L2 是 L1 的自治域** → L2 的不可逆操作可由 **用户 / L1 / L0 三者中任意两方**决策；
 *  - **L1 自身的事** → L1 不得批自己这一层 → 只能由 **用户 + L0** 决策（仍为两方）；
 *  - **治理动作（L0 域）** → 由 L0 或用户决策（治理动作另有守卫，见 requireGovernanceRole）。
 *
 * 因此：池子里放**可参与的角色**，法定人数固定为 2（`requiredApprovals`），
 * 由 `decideApproval` 用"不同角色需由不同身份满足"的匹配来判定是否达标。
 */
export function buildApprovalDeciders(requesterRole: string | undefined | null): {
  deciders: Array<{ role: string; weight: number }>;
  requiredApprovals: number;
} {
  const tier = tierOf(requesterRole);
  const pool: string[] = [];
  const push = (role: string) => {
    if (role === requesterRole) return; // 请求方自身角色永不入池（防自审）
    if (!pool.includes(role)) pool.push(role);
  };

  // 人类所有者始终在池（最终权威）
  push(OWNER_ROLE);

  if (tier === 'L2') {
    // L2 属 L1 自治域：L1 + L0 均可参与，任意两方即可
    push('prime_director');           // L1
    push('auditor');                  // L0（审批域词表）
    push('regulatory_authority');     // L0（Regulator）
  } else {
    // L1 自身 / L0：只允许"用户 + L0"两方（L1 不得自审）
    push('auditor');
    push('regulatory_authority');
  }

  return {
    deciders: pool.map(role => ({ role, weight: 1 })),
    requiredApprovals: 2,
  };
}

/** 从 `role:identity` 形式的决策者标识中解析角色（无冒号时整体视为角色） */
export function parseDecidedByRole(decidedBy: string): string {
  const sep = decidedBy.indexOf(':');
  return sep > 0 ? decidedBy.slice(0, sep) : decidedBy;
}

/**
 * 治理动作守卫：非治理角色 → 拒绝。
 *
 * ★ 2026-10-04 起**统一留痕**（灵感源《一些思考2》§1.2 全链路可追溯）：
 *   凡经本守卫的治理动作，无论**放行还是拒绝**都会写入统一治理台账
 *   （四类元数据：全局唯一 ID / 时间戳 / 来源 Agent / 任务标识），并发布
 *   `governance:action_recorded` 事件。拒绝同样是有价值的治理事实。
 *
 * @param actorRole 执行该治理动作的角色（`user` / `auditor` / `regulatory_authority` / …）
 * @param action 动作描述（用于错误信息与留痕，如"裁决审批""仲裁裁定"）
 * @param meta 可选的任务标识与目标（有则写入留痕，便于数据血缘）
 */
export function requireGovernanceRole(
  actorRole: string | undefined | null,
  action: string,
  meta: { actorId?: string; traceId?: string; taskId?: string; targetIds?: readonly string[] } = {},
): Result<void> {
  const auditAction = GOVERNANCE_ACTION_BY_LABEL[action] ?? action;
  const base = {
    action: auditAction,
    actorRole: actorRole ?? 'unknown',
    ...(meta.actorId !== undefined ? { actorId: meta.actorId } : {}),
    ...(meta.traceId !== undefined ? { traceId: meta.traceId } : {}),
    ...(meta.taskId !== undefined ? { taskId: meta.taskId } : {}),
    ...(meta.targetIds !== undefined ? { targetIds: meta.targetIds } : {}),
  };

  if (!actorRole) {
    recordGovernanceAction({ ...base, outcome: 'denied', reason: '未提供执行者角色' });
    return err(`${action}被拒绝：未提供执行者角色`);
  }
  if (isGovernanceRole(actorRole)) {
    recordGovernanceAction({ ...base, outcome: 'allowed' });
    return ok(undefined);
  }

  const reason = `${actorRole} 属执行层，治理动作只能由 L0（Regulator/Auditor/Arbitrator）或人类所有者执行`;
  recordGovernanceAction({ ...base, outcome: 'denied', reason });
  return err(`${action}被拒绝：${reason}`);
}

/** 中文动作名 → 规范化动作标识（留痕用） */
const GOVERNANCE_ACTION_BY_LABEL: Record<string, string> = {
  '裁决审批': 'approval.decide',
  '冻结 Agent（审计执法）': 'audit.freeze',
  '解冻 Agent（审计执法）': 'audit.unfreeze',
  '审计调查': 'audit.investigate',
  '审计巡查': 'audit.patrol',
  '仲裁裁决': 'arbitration.verdict',
  '仲裁停职（执法）': 'arbitration.suspension',
  '知识沉淀（史官职责）': 'arbitration.consolidate',
  '紧急干预（监管执法）': 'regulation.intervene',
  '僵局升级（监管执法）': 'regulation.escalate',
  '最终裁决（监管执法）': 'regulation.final_verdict',
  '新增行为规则（监管立法）': 'regulation.rule_add',
  '删除行为规则（监管立法）': 'regulation.rule_remove',
  '更新行为准则版本（监管立法）': 'regulation.version_update',
  '治理广播': 'regulation.broadcast',
  '写入治理记忆键': 'memory.governance_write',
};
