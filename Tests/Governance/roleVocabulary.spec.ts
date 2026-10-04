/**
 * G-16 验收：角色词表统一与一致性（2026-10-04）
 *
 * 背景：项目存在两套同义不同名的角色词表（执行域 `Infra/types.ts` / 审批域 `Services/LoopControl/types.ts`），
 * 本会话已因此踩坑三次。本测试把"两套词表 + 别名映射 + 各分层判定"锁死为可验证不变量：
 *  1. 权威集合与两套真实类型定义**逐一对应**（新增角色必须同步登记，否则测试失败）；
 *  2. 别名双向映射自洽（`regulator` ↔ `regulatory_authority`）；
 *  3. L0/层级判定在所有模块**口径一致**（治理守卫、工具层、词表模块）；
 *  4. 工具层角色必须属于执行域词表；审批域角色必须属于审批域词表。
 */
import { describe, it, expect } from 'vitest';

import {
  CANONICAL_ROLES, APPROVAL_ROLES, OWNER_ROLE,
  L0_ROLES_CANONICAL, L0_ROLES_APPROVAL, EXECUTION_ROLES, L1_ROLES, L2_ROLES,
  toCanonicalRole, toApprovalRole, isCanonicalRole, isApprovalRole,
  isL0Role, isGovernanceActor, tierOfRole, allKnownRoles,
} from '../../Src/Infra/Roles/roleVocabulary.js';
import { tierOf, isGovernanceRole, L0_GOVERNANCE_ROLES } from '../../Src/Services/Governance/governanceGuard.js';
import { READ_ROLES, TOOL_GOVERNANCE_ROLES, TOOL_EXECUTION_ROLES } from '../../Src/Tools/roles.js';

/** 执行域真值（与 `Src/Infra/types.ts` 的 UserRole 手工对齐，改类型必须改这里 → 强制同步） */
const EXECUTION_DOMAIN_TRUTH = [
  'prime_director', 'partner', 'regulator', 'auditor', 'arbitrator',
  'worker', 'reviewer', 'assembly_node',
];
/** 审批域真值（与 `Src/Services/LoopControl/types.ts` 的 UserRole 手工对齐） */
const APPROVAL_DOMAIN_TRUTH = ['user', 'prime_director', 'regulatory_authority', 'auditor'];

describe('G-16 角色词表统一', () => {
  it('★ 权威集合与真实类型定义一致（新增角色必须登记）', () => {
    expect([...CANONICAL_ROLES].sort()).toEqual([...EXECUTION_DOMAIN_TRUTH].sort());
    expect([...APPROVAL_ROLES].sort()).toEqual([...APPROVAL_DOMAIN_TRUTH].sort());
  });

  it('★ 别名双向映射自洽（regulator ↔ regulatory_authority）', () => {
    expect(toCanonicalRole('regulatory_authority')).toBe('regulator');
    expect(toApprovalRole('regulator')).toBe('regulatory_authority');
    // 往返一致
    expect(toCanonicalRole(toApprovalRole('regulator'))).toBe('regulator');
    // 无别名者原样返回（含所有者：跨域标识）
    expect(toCanonicalRole('auditor')).toBe('auditor');
    expect(toCanonicalRole(OWNER_ROLE)).toBe(OWNER_ROLE);
    expect(toApprovalRole('arbitrator')).toBe('arbitrator'); // 审批域无仲裁者称呼，原样
  });

  it('★ L0 判定跨模块口径一致（两套词表同义等价）', () => {
    for (const role of ['regulator', 'regulatory_authority', 'auditor', 'arbitrator']) {
      expect(isL0Role(role), `${role} 应为 L0`).toBe(true);
      expect(L0_GOVERNANCE_ROLES as readonly string[]).toContain(role);
      expect(isGovernanceRole(role)).toBe(true);
      expect(TOOL_GOVERNANCE_ROLES as readonly string[]).toContain(toCanonicalRole(role));
    }
    for (const role of ['prime_director', 'partner', 'worker', 'reviewer', 'assembly_node']) {
      expect(isL0Role(role), `${role} 不应为 L0`).toBe(false);
      expect(isGovernanceRole(role)).toBe(false);
    }
    // 所有者等同治理层
    expect(isGovernanceActor(OWNER_ROLE)).toBe(true);
    expect(tierOfRole(OWNER_ROLE)).toBe('owner');
    expect(isGovernanceRole(OWNER_ROLE)).toBe(true);
  });

  it('★ 层级判定委派一致：governanceGuard.tierOf 与权威实现逐角色相同', () => {
    for (const role of allKnownRoles()) {
      expect(tierOf(role), `${role} 层级判定不一致`).toBe(tierOfRole(role));
    }
    expect(tierOf('regulator')).toBe('L0');
    expect(tierOf('regulatory_authority')).toBe('L0');
    expect(tierOf('partner')).toBe('L1');
    expect(tierOf('assembly_node')).toBe('L2');
    expect(tierOf('不存在的角色')).toBeUndefined();
  });

  it('★ 域归属校验：工具层角色必须属执行域；L0/执行集合必须完备', () => {
    for (const role of [...TOOL_GOVERNANCE_ROLES, ...TOOL_EXECUTION_ROLES, ...READ_ROLES]) {
      expect(isCanonicalRole(role), `工具层角色 ${role} 不在执行域词表中`).toBe(true);
    }
    // 审批域角色（含 regulatory_authority）不得混进执行域判定
    expect(isCanonicalRole('regulatory_authority')).toBe(false);
    expect(isApprovalRole('regulatory_authority')).toBe(true);
    expect(isApprovalRole(OWNER_ROLE)).toBe(true);

    // 分层集合互斥且并集覆盖 L0+L1+L2
    const tiers = [...L0_ROLES_CANONICAL, ...L1_ROLES, ...L2_ROLES];
    expect(new Set(tiers).size).toBe(tiers.length);
    expect([...tiers].sort()).toEqual([...CANONICAL_ROLES].sort());
    expect([...EXECUTION_ROLES].sort()).toEqual([...L1_ROLES, ...L2_ROLES].sort());
    expect(L0_ROLES_APPROVAL).toContain('regulatory_authority');
  });

  it('allKnownRoles 含两套词表与所有者（界面/校验可枚举）', () => {
    const all = allKnownRoles();
    for (const r of [...EXECUTION_DOMAIN_TRUTH, ...APPROVAL_DOMAIN_TRUTH]) {
      expect(all).toContain(r);
    }
    expect(new Set(all).size).toBe(all.length); // 无重复
  });
});
