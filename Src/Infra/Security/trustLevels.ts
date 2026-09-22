/**
 * 信任分级管理（Docs/11 §3.2 / Docs/03 §信任隔离）
 *
 * 职责：
 * - 定义三级信任模型：L0（系统级）/ L1（用户级）/ L2（外部级）
 * - 角色→信任级别映射（基于 security.json 配置）
 * - 提供信任级别查询与权限判定
 *
 * 信任级别：
 * - L0 治理级：Regulator, Auditor, Arbitrator — 监管、审计、仲裁，最高权限
 * - L1 入口级：Prime Director, Partner — 接收用户输入、递归派发子 Agent、协作
 * - L2 执行子级：Worker, Reviewer, Assembly Node — 仅执行上级派发任务
 *
 * 枚举三处同形（Docs/11 §1.2.1）：TS / DB / 配置文件不做大小写转换。
 */

import type { TrustLevel } from '../types.js';

// ===== 类型定义 =====

/** 信任级别描述 */
export interface TrustLevelInfo {
  readonly level: TrustLevel;
  readonly name: string;
  readonly description: string;
  /** 是否可修改系统配置 */
  readonly canModifyConfig: boolean;
  /** 是否可管理其他 Agent */
  readonly canManageAgents: boolean;
  /** 是否全局读写 */
  readonly canGlobalReadWrite: boolean;
}

/** 工具危险分级（Docs/11 §3.3 · 豁免 X3：SCREAMING_SNAKE_CASE） */
export type DangerLevel = 'SAFE' | 'CONTROLLED' | 'DANGEROUS' | 'FORBIDDEN';

/** 工具危险级别描述 */
export interface DangerLevelInfo {
  readonly level: DangerLevel;
  readonly name: string;
  readonly description: string;
  /** 是否需要沙箱 */
  readonly requiresSandbox: boolean;
  /** 是否需要显式确认 */
  readonly requiresApproval: boolean;
}

// ===== 信任级别常量 =====

const TRUST_LEVEL_INFO: Record<TrustLevel, TrustLevelInfo> = {
  L0: {
    level: 'L0',
    name: '治理级',
    description: '全局读写、规则修改、Agent 管理、冲突裁决',
    canModifyConfig: true,
    canManageAgents: true,
    canGlobalReadWrite: true,
  },
  L1: {
    level: 'L1',
    name: '入口级',
    description: '接收用户输入、递归派发子 Agent、搭建工作流',
    canModifyConfig: false,
    canManageAgents: false,
    canGlobalReadWrite: false,
  },
  L2: {
    level: 'L2',
    name: '执行子级',
    description: '仅执行上级派发任务，不可接收外部输入',
    canModifyConfig: false,
    canManageAgents: false,
    canGlobalReadWrite: false,
  },
};

/** 工具危险分级常量（豁免 X3：SCREAMING_SNAKE_CASE） */
const DANGER_LEVEL_INFO: Record<DangerLevel, DangerLevelInfo> = {
  SAFE: {
    level: 'SAFE',
    name: '安全',
    description: '直接执行',
    requiresSandbox: false,
    requiresApproval: false,
  },
  CONTROLLED: {
    level: 'CONTROLLED',
    name: '受控',
    description: '记录操作历史，可回溯',
    requiresSandbox: false,
    requiresApproval: false,
  },
  DANGEROUS: {
    level: 'DANGEROUS',
    name: '危险',
    description: '沙箱内执行 + 显式确认',
    requiresSandbox: true,
    requiresApproval: true,
  },
  FORBIDDEN: {
    level: 'FORBIDDEN',
    name: '禁止',
    description: '永不注册',
    requiresSandbox: false,
    requiresApproval: false,
  },
};

// ===== 内部状态 =====

/** 角色→信任级别映射 */
const roleTrustMap = new Map<string, TrustLevel>();

/** 已初始化标记 */
let initialized = false;

// ===== 公开 API =====

/**
 * 初始化信任级别映射
 *
 * 从 security.json 配置加载角色→信任级别映射。
 * 必须在启动 ④ 步调用。
 */
export function initTrustLevels(config: {
  systemRoles?: string[];
  userRoles?: string[];
  externalRoles?: string[];
}): void {
  roleTrustMap.clear();

  // L0 治理级角色
  for (const role of config.systemRoles ?? ['regulator', 'auditor', 'arbitrator']) {
    roleTrustMap.set(role, 'L0');
  }

  // L1 入口级角色
  for (const role of config.userRoles ?? ['prime_director', 'partner']) {
    roleTrustMap.set(role, 'L1');
  }

  // L2 执行子级角色
  for (const role of config.externalRoles ?? ['worker', 'reviewer', 'assembly_node']) {
    roleTrustMap.set(role, 'L2');
  }

  initialized = true;
}

/**
 * 获取角色的信任级别
 *
 * 未知角色默认返回 L2（外部级，最小权限）。
 */
export function getTrustLevel(role: string): TrustLevel {
  return roleTrustMap.get(role) ?? 'L2';
}

/**
 * 获取信任级别的详细信息
 */
export function getTrustLevelInfo(level: TrustLevel): TrustLevelInfo {
  return TRUST_LEVEL_INFO[level];
}

/**
 * 判断角色是否拥有指定信任级别（或更高）
 *
 * L0 > L1 > L2（L0 最高）。
 */
export function hasTrustLevel(role: string, requiredLevel: TrustLevel): boolean {
  const roleLevel = getTrustLevel(role);
  const hierarchy: TrustLevel[] = ['L0', 'L1', 'L2'];
  return hierarchy.indexOf(roleLevel) <= hierarchy.indexOf(requiredLevel);
}

/**
 * 获取工具危险级别的详细信息
 */
export function getDangerLevelInfo(level: DangerLevel): DangerLevelInfo {
  return DANGER_LEVEL_INFO[level];
}

/**
 * 验证危险级别字符串是否合法
 */
export function isValidDangerLevel(level: string): level is DangerLevel {
  return level in DANGER_LEVEL_INFO;
}

/**
 * 判断工具是否被允许在指定信任级别下使用
 *
 * 规则：
 * - L0 可使用所有工具（除 FORBIDDEN）
 * - L1 可使用 SAFE 和 CONTROLLED
 * - L2 仅可使用 SAFE
 */
export function isToolAllowed(toolDangerLevel: DangerLevel, userTrustLevel: TrustLevel): boolean {
  if (toolDangerLevel === 'FORBIDDEN') return false;

  switch (userTrustLevel) {
    case 'L0': return true;
    case 'L1': return toolDangerLevel === 'SAFE' || toolDangerLevel === 'CONTROLLED';
    case 'L2': return toolDangerLevel === 'SAFE';
  }
}

/**
 * 获取所有已注册的角色及其信任级别
 */
export function getAllRoleTrustLevels(): ReadonlyMap<string, TrustLevel> {
  return roleTrustMap;
}

/**
 * 是否已初始化
 */
export function isTrustLevelsInitialized(): boolean {
  return initialized;
}
