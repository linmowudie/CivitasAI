/**
 * 白名单管理（Docs/11 §3.5 / Docs/03 §工具隔离）
 *
 * 职责：
 * - 工具白名单（最小权限原则）：Worker 只能使用 TaskAssignment.requiredTools 中列出的工具
 * - 网络白名单：允许访问的外部域名列表
 * - 命令白名单：允许执行的 shell 命令模式
 * - 禁止 Worker 自行扩权
 */

import type { DangerLevel } from './trustLevels.js';

// ===== 类型定义 =====

/** 工具注册信息 */
export interface ToolRegistration {
  /** 工具名称（全局唯一） */
  readonly name: string;
  /** 危险级别（豁免 X3：SCREAMING_SNAKE_CASE） */
  readonly dangerLevel: DangerLevel;
  /** 是否幂等 */
  readonly idempotent: boolean;
  /** 是否可逆 */
  readonly reversible: boolean;
  /** 描述 */
  readonly description?: string;
}

/** 白名单配置 */
export interface WhitelistConfig {
  /** 禁止访问的路径 */
  forbiddenPaths?: string[];
  /** 禁止执行的命令模式 */
  forbiddenCommands?: string[];
  /** 允许访问的网络域名（空数组 = 全部禁止） */
  networkWhitelist?: string[];
}

// ===== 内部状态 =====

/** 已注册的工具 */
const toolRegistry = new Map<string, ToolRegistration>();

/** 网络白名单 */
let networkAllowed: Set<string> = new Set();

/** 禁止路径列表 */
let forbiddenPaths: string[] = [];

/** 禁止命令模式列表 */
let forbiddenCommands: string[] = [];

// ===== 公开 API =====

/**
 * 初始化白名单
 *
 * 从 security.json 配置加载禁止列表。
 */
export function initWhitelist(config: WhitelistConfig): void {
  forbiddenPaths = config.forbiddenPaths ?? ['Data/Auth/'];
  forbiddenCommands = config.forbiddenCommands ?? [];
  networkAllowed = new Set(config.networkWhitelist ?? []);
}

/**
 * 注册工具
 *
 * FORBIDDEN 级别的工具永不注册。
 */
export function registerTool(tool: ToolRegistration): boolean {
  if (tool.dangerLevel === 'FORBIDDEN') {
    return false; // FORBIDDEN 工具永不注册
  }
  toolRegistry.set(tool.name, tool);
  return true;
}

/**
 * 检查工具是否已注册
 */
export function isToolRegistered(name: string): boolean {
  return toolRegistry.has(name);
}

/**
 * 获取已注册工具的信息
 */
export function getToolRegistration(name: string): ToolRegistration | undefined {
  return toolRegistry.get(name);
}

/**
 * 检查角色是否被允许使用指定工具
 *
 * 需要配合 trustLevels 模块使用。
 * 此函数只检查工具是否在角色的允许列表中。
 *
 * @param toolName 工具名
 * @param allowedTools 角色被允许使用的工具列表
 */
export function isToolAllowedForRole(toolName: string, allowedTools: string[]): boolean {
  // 最小权限原则：只允许列表中列出的工具
  return allowedTools.includes(toolName);
}

/**
 * 检查路径是否在禁止列表中
 */
export function isPathForbidden(path: string): boolean {
  const normalized = path.replace(/\\/g, '/');
  return forbiddenPaths.some(fp => {
    const normalizedFp = fp.replace(/\\/g, '/');
    return normalized.includes(normalizedFp) || normalized.startsWith(normalizedFp);
  });
}

/**
 * 检查命令是否在禁止列表中
 */
export function isCommandForbidden(command: string): boolean {
  return forbiddenCommands.some(fc => command.includes(fc));
}

/**
 * 检查网络域名是否被允许
 *
 * 空白名单 = 全部禁止。
 */
export function isNetworkAllowed(hostname: string): boolean {
  if (networkAllowed.size === 0) return false;
  return networkAllowed.has(hostname);
}

/**
 * 获取所有已注册的工具名
 */
export function getRegisteredToolNames(): string[] {
  return Array.from(toolRegistry.keys());
}

/**
 * 获取指定危险级别的所有工具
 */
export function getToolsByDangerLevel(level: DangerLevel): ToolRegistration[] {
  return Array.from(toolRegistry.values()).filter(t => t.dangerLevel === level);
}

/**
 * 清除所有注册（用于测试）
 */
export function clearWhitelist(): void {
  toolRegistry.clear();
  networkAllowed.clear();
  forbiddenPaths = [];
  forbiddenCommands = [];
}
