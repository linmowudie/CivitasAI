/**
 * 工具工厂（Docs/14 §S4）
 *
 * 职责：
 * - 按 Agent 角色裁剪可见工具集
 * - 提供工具集获取接口
 *
 * 工具可见性由角色信任级别 + 工具 dangerLevel 决定。
 */

import type { ToolSpec, UserRole } from '../Traits/toolSpec.js';
import { getAllToolSpecs } from '../Registry/toolRegistry.js';
import { isToolAllowed } from '../../Infra/Security/trustLevels.js';
import { getTrustLevel } from '../../Infra/Security/trustLevels.js';

// ===== 类型定义 =====

/** 角色工具配置 */
export interface RoleToolConfig {
  /** 角色 */
  readonly role: UserRole;
  /** 额外允许的工具名（覆盖默认信任级别限制） */
  readonly additionalTools?: string[];
  /** 显式禁止的工具名 */
  readonly excludedTools?: string[];
}

// ===== 公开 API =====

/**
 * 获取指定角色可见的工具列表
 *
 * 规则：
 * - L0 角色可使用所有工具（除 FORBIDDEN）
 * - L1 角色可使用 SAFE + CONTROLLED
 * - L2 角色仅可使用 SAFE
 * - additionalTools 可覆盖限制
 * - excludedTools 强制排除
 */
export function getVisibleTools(config: RoleToolConfig): ToolSpec[] {
  const allTools = getAllToolSpecs();
  const trustLevel = getTrustLevel(config.role);
  const additional = new Set(config.additionalTools ?? []);
  const excluded = new Set(config.excludedTools ?? []);

  return allTools.filter(tool => {
    // 显式排除
    if (excluded.has(tool.name)) return false;

    // 信任级别检查
    if (isToolAllowed(tool.dangerLevel, trustLevel)) return true;

    // 额外允许
    if (additional.has(tool.name)) return true;

    return false;
  });
}

/**
 * 获取指定角色可见的工具名列表
 */
export function getVisibleToolNames(config: RoleToolConfig): string[] {
  return getVisibleTools(config).map(t => t.name);
}

/**
 * 检查工具对指定角色是否可见
 */
export function isToolVisible(toolName: string, role: UserRole): boolean {
  const allTools = getAllToolSpecs();
  const tool = allTools.find(t => t.name === toolName);
  if (!tool) return false;

  const trustLevel = getTrustLevel(role);
  return isToolAllowed(tool.dangerLevel, trustLevel);
}
