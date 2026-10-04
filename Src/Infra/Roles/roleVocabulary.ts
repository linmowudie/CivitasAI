/**
 * @module Infra/Roles/roleVocabulary
 * @description **角色词表唯一权威**（2026-10-04 新增，落地清单 G-16）。
 *
 * 问题背景：项目里存在**两套同义不同名的角色词表**，本会话已因此踩坑三次：
 *
 * | 域 | 定义位置 | 词表 | Regulator 的写法 |
 * |----|---------|------|-----------------|
 * | **执行域**（编排/工具/安全） | `Infra/types.ts` | `prime_director \| partner \| regulator \| auditor \| arbitrator \| worker \| reviewer \| assembly_node` | `regulator` |
 * | **审批域**（审批/监管服务） | `Services/LoopControl/types.ts` | `user \| prime_director \| regulatory_authority \| auditor` | `regulatory_authority` |
 *
 * 本模块不强行合并两套已落库的词表（改动面过大且会破坏既有持久化数据），而是提供：
 *  1. **权威集合**：`CANONICAL_ROLES`（执行域）为唯一事实源；
 *  2. **双向别名**：`toCanonicalRole` / `toApprovalRole`（`regulator` ↔ `regulatory_authority`）；
 *  3. **跨域判定**：`isL0Role` 等按**语义**判定，与写哪套词表无关；
 *  4. 一致性测试 `Tests/Governance/roleVocabulary.spec.ts` 锁死"新增角色必须登记"。
 *
 * 约定：`user`（人类所有者）**不是** `UserRole`，而是跨域唯一的所有者标识，等同于治理层。
 */

/** 人类所有者（跨域唯一，非 UserRole） */
export const OWNER_ROLE = 'user';

/** 权威词表（执行域）：`Infra/types.ts` 的 `UserRole` 必须与此一致 */
export const CANONICAL_ROLES = [
  'prime_director', 'partner', 'regulator', 'auditor', 'arbitrator',
  'worker', 'reviewer', 'assembly_node',
] as const;
export type CanonicalRole = (typeof CANONICAL_ROLES)[number];

/** 审批域词表：`Services/LoopControl/types.ts` 的 `UserRole` 必须与此一致 */
export const APPROVAL_ROLES = [
  'user', 'prime_director', 'regulatory_authority', 'auditor',
] as const;
export type ApprovalRole = (typeof APPROVAL_ROLES)[number];

/** L0 治理角色（执行域称呼） */
export const L0_ROLES_CANONICAL = ['regulator', 'auditor', 'arbitrator'] as const;

/** L0 治理角色（审批域称呼） */
export const L0_ROLES_APPROVAL = ['regulatory_authority', 'auditor'] as const;

/** 执行层角色（L1 + L2） */
export const EXECUTION_ROLES = [
  'prime_director', 'partner', 'worker', 'reviewer', 'assembly_node',
] as const;

/** L1 入口级 */
export const L1_ROLES = ['prime_director', 'partner'] as const;

/** L2 执行级（L1 自治域） */
export const L2_ROLES = ['worker', 'reviewer', 'assembly_node'] as const;

// ── 双向别名（同义不同名）────────────────────────────────────────────

/** 审批域 → 执行域 */
const APPROVAL_TO_CANONICAL: Readonly<Record<string, string>> = {
  regulatory_authority: 'regulator',
};

/** 执行域 → 审批域 */
const CANONICAL_TO_APPROVAL: Readonly<Record<string, string>> = {
  regulator: 'regulatory_authority',
};

/** 任意域角色 → 执行域称呼（`user` 原样返回：它是跨域标识） */
export function toCanonicalRole(role: string): string {
  return APPROVAL_TO_CANONICAL[role] ?? role;
}

/** 任意域角色 → 审批域称呼（无对应审批域名称者原样返回） */
export function toApprovalRole(role: string): string {
  return CANONICAL_TO_APPROVAL[role] ?? role;
}

// ── 判定函数（按语义，与写法无关）───────────────────────────────────

export function isCanonicalRole(role: string | undefined | null): boolean {
  return !!role && (CANONICAL_ROLES as readonly string[]).includes(role);
}

export function isApprovalRole(role: string | undefined | null): boolean {
  return !!role && (APPROVAL_ROLES as readonly string[]).includes(role);
}

/** 是否人类所有者 */
export function isOwnerRole(role: string | undefined | null): boolean {
  return role === OWNER_ROLE;
}

/**
 * 是否 L0 治理角色（**兼容两套词表**：`regulator` 与 `regulatory_authority` 等价）。
 */
export function isL0Role(role: string | undefined | null): boolean {
  if (!role) return false;
  const canonical = toCanonicalRole(role);
  return (L0_ROLES_CANONICAL as readonly string[]).includes(canonical);
}

/** 是否具备治理资格（L0 或人类所有者） */
export function isGovernanceActor(role: string | undefined | null): boolean {
  return isOwnerRole(role) || isL0Role(role);
}

/** 层级归属（统一判定） */
export function tierOfRole(role: string | undefined | null): 'owner' | 'L0' | 'L1' | 'L2' | undefined {
  if (!role) return undefined;
  if (isOwnerRole(role)) return 'owner';
  const canonical = toCanonicalRole(role);
  if ((L0_ROLES_CANONICAL as readonly string[]).includes(canonical)) return 'L0';
  if ((L1_ROLES as readonly string[]).includes(canonical)) return 'L1';
  if ((L2_ROLES as readonly string[]).includes(canonical)) return 'L2';
  return undefined;
}

/** 全部已知角色（含所有者与两套词表，供一致性校验/界面枚举） */
export function allKnownRoles(): string[] {
  return [...new Set<string>([OWNER_ROLE, ...CANONICAL_ROLES, ...APPROVAL_ROLES])];
}

// ── 角色**赋权**守卫（2026-10-04，G-11）────────────────────────────────
//
// 问题：招募工具（`agent.recruit`）已禁止治理三权，但 `agentFactory.createAgent()` 与
//   `agentRegistry.registerAgent()` **不做任何角色校验** ⇒ 任何调用方都能伪造一个 L0 Agent
//   （拿到治理层身份）。本守卫把"治理角色不可被赋权"变成**中央不变量**，
//   任何创建/注册路径都必须经过它。

/**
 * 判定某角色是否**可被赋权**给 Agent 实例。
 *
 * - 人类所有者（`user`）与 L0 治理角色（`regulator`/`regulatory_authority`/`auditor`/`arbitrator`）
 *   **不可**通过招募/工厂/注册表赋权（它们是系统/治理身份，不能由执行层产生）；
 * - L1/L2 可赋权。
 *
 * @param allowGovernance 显式系统开关（仅用于**受控的系统播种/回灌**路径，须在调用处写明理由）
 */
export function isAssignableAgentRole(role: string | undefined | null, allowGovernance = false): boolean {
  if (!role) return false;
  if (!allowGovernance && isGovernanceActor(role)) return false;
  return isCanonicalRole(toCanonicalRole(role));
}

/**
 * 赋权守卫：不可赋权时返回拒绝原因（供 `Result` 风格调用方使用）。
 *
 * @returns `null` 表示允许；否则为拒绝原因
 */
export function denyReasonForAgentRole(
  role: string | undefined | null,
  allowGovernance = false,
): string | null {
  if (!role) return '未提供 Agent 角色';
  if (!allowGovernance && isGovernanceActor(role)) {
    return `治理角色 ${role} 不可被赋权给 Agent（治理层身份只能由系统/人类所有者持有，不得由招募或执行层产生）`;
  }
  if (!isCanonicalRole(toCanonicalRole(role))) {
    return `未知角色 ${role}（不在执行域词表中）`;
  }
  return null;
}
