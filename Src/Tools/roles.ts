/**
 * @module Tools/roles
 * @description 工具层角色白名单常量（2026-10-04 新增）。
 *
 * 背景：此前每个工具各自硬编码角色数组，导致**治理角色 `regulatory_authority`（监管）
 * 与 `regulator`（执行域别名）被整体漏掉** —— 监管连 `file.read` 都无法调用，
 * 而监管的职责恰恰是"观察 agent 行为是否正确"，必须有只读观察能力。
 *
 * 分层口径（对齐产品规则"治理层只由 L0 承担，L1/L2 只做事"）：
 *  - `READ_ROLES`：只读/观察类工具（读文件、列目录、检索、搜索）→ 全员 + **全部治理角色**；
 *  - `EXEC_ROLES`：写入/执行类工具（写文件、改文件）→ L1 + L2(worker) + 仲裁者（arbitrator 需取证/修复）；
 *  - `DANGEROUS_ROLES`：危险执行（shell / code.eval）→ **不含 auditor/regulator**
 *    （治理层只审计行为、不亲自执行副作用，避免"既是裁判又是运动员"）；
 *  - `ORCHESTRATOR_ROLES`：编排/评审类工具；
 *  - `GOVERNANCE_TOOL_ROLES`：**治理类工具**（冻结/处罚/裁决/规则）——仅 L0 + 所有者。
 */

/** 治理角色（L0）在**工具层**的称呼（执行域词表） */
// WARN: 工具层属执行域，只接受 Infra/types.ts 的 UserRole（regulator）；
//       不接受审批域的 regulatory_authority（同义不同名，见清单 G-16 词表统一）。
export const TOOL_GOVERNANCE_ROLES = [
  'regulator',   // Regulator（执行域称呼）
  'auditor',
  'arbitrator',
] as const;

/** 执行层角色（L1 + L2） */
export const TOOL_EXECUTION_ROLES = [
  'prime_director', 'partner', 'worker', 'reviewer', 'assembly_node',
] as const;

/** 只读观察类：全员 + 全部治理角色 */
export const READ_ROLES = [
  'prime_director', 'arbitrator', 'auditor', 'regulator',
  'partner', 'worker', 'assembly_node', 'reviewer',
];

/** 写入/修改类（L1 + worker + arbitrator：仲裁需取证与修复） */
export const EXEC_ROLES = [
  'prime_director', 'arbitrator', 'partner', 'worker',
];

/** 危险执行类（shell / code.eval）：**不含 auditor / regulator**（治理层不执行副作用） */
export const DANGEROUS_ROLES = [
  'prime_director', 'arbitrator', 'partner', 'worker',
];

/** 编排/评审提交类（消费者：`specValidator` 注册期校验 `agent.*` 工具角色上限，FE-048） */
export const ORCHESTRATOR_ROLES = [
  'prime_director', 'partner', 'worker', 'reviewer', 'assembly_node',
];

/**
 * 治理类工具（冻结/处罚/裁决/规则/通告）——仅 L0 与所有者
 * （消费者：`GOVERNANCE_TOOL_NAME_PATTERN` 命中时的注册期角色校验，FE-048）
 */
export const GOVERNANCE_TOOL_ROLES = [
  'regulator', 'auditor', 'arbitrator',
];  // 人类所有者不经工具层

/** 工具名是否属于治理动作（用于自动校验：治理工具不得对 L1/L2 开放） */
export const GOVERNANCE_TOOL_NAME_PATTERN =
  /(freeze|unfreeze|ban|penal|suspend|revoke|approve|reject|verdict|rule|sanction|quarantine|governance|audit_action)/i;