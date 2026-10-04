/**
 * 工具工厂（Docs/Agent/13 §S4）
 *
 * 职责：
 * - 按 Agent 角色裁剪可见工具集
 * - 提供工具集获取接口
 *
 * ★ FE-051（2026-10-04）工具可见性双轨收敛：
 *   Docs/Agent/10 §3.3.1（v2.2）裁定"可见性唯一真相源 = `ToolSpec.requiredRoles`"，
 *   `dangerLevel × trustLevel` 单轴裁剪为废弃模型（与 worker/reviewer 职能矛盾）。
 *   本模块三个可见性函数已统一到 `isSpecVisibleForRole`，与生产链路
 *   （`toolHeader.buildToolHeader` / `toolRegistry.executeTool`）口径逐字一致。
 */

import type { ToolSpec } from '../Traits/toolSpec.js';
import type { UserRole } from '../../Infra/types.js';
import { getAllToolSpecs } from '../Registry/toolRegistry.js';

// ===== 类型定义 =====

/** 角色工具配置 */
export interface RoleToolConfig {
  /** 角色 */
  readonly role: UserRole;
  /** 额外允许的工具名（显式覆盖角色白名单，属配置级放行） */
  readonly additionalTools?: string[];
  /** 显式禁止的工具名 */
  readonly excludedTools?: string[];
}

// ===== 公开 API =====

/**
 * 工具可见性的**唯一判定谓词**（FE-051 收敛点）。
 *
 * 规则：`requiredRoles` 显式白名单命中即可见。
 * 与 `toolHeader.ts`（上下文装配）与 `toolRegistry.executeTool`（执行期硬校验）
 * 保持同一口径；危险工具的执行管控由 `toolSafetyGate` 审批承担，不在此处裁剪。
 */
export function isSpecVisibleForRole(spec: ToolSpec, role: UserRole): boolean {
  return spec.requiredRoles.includes(role);
}

/**
 * 获取指定角色可见的工具列表
 *
 * 规则：
 * - `requiredRoles` 命中 → 可见（与生产链路同一口径）
 * - `excludedTools` 强制排除
 * - `additionalTools` 配置级放行（显式覆盖白名单，非信任级别推导）
 */
export function getVisibleTools(config: RoleToolConfig): ToolSpec[] {
  const allTools = getAllToolSpecs();
  const additional = new Set(config.additionalTools ?? []);
  const excluded = new Set(config.excludedTools ?? []);

  return allTools.filter(tool => {
    // 显式排除
    if (excluded.has(tool.name)) return false;

    // 角色白名单（唯一真相源）
    if (isSpecVisibleForRole(tool, config.role)) return true;

    // 配置级放行
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
 * 按 `requiredRoles` 获取指定角色可见的工具列表。
 *
 * 与 `toolHeader.buildToolHeader` 口径逐字一致（不再有 L0 兜底第二轨，FE-051）。
 */
export function getVisibleToolsForRole(role: UserRole): ToolSpec[] {
  return getAllToolSpecs().filter(tool => isSpecVisibleForRole(tool, role));
}

/**
 * 检查工具对指定角色是否可见（与执行期硬校验同一谓词，消除"可见但被拒"漂移）
 */
export function isToolVisible(toolName: string, role: UserRole): boolean {
  const allTools = getAllToolSpecs();
  const tool = allTools.find(t => t.name === toolName);
  if (!tool) return false;
  return isSpecVisibleForRole(tool, role);
}
