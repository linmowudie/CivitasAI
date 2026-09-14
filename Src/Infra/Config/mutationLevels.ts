/**
 * 配置可变性分级（Docs/11 §1.3）
 *
 * L0 启动锁定 — 启动后不可更改，修改需重启（安全策略、数据库路径）
 * L1 启动时读取 — 启动时读取一次，运行期间不变（本地覆盖配置）
 * L2 运行时可重载 — 通过文件监听或 API 热更新（路由规则、税率、模型路由）
 * L3 实时可变 — 每次使用时重新读取（当前不使用）
 */

import { MutabilityLevel } from '../types.js';

/** 每个配置键的可变性标注 */
export interface MutabilityEntry {
  readonly level: MutabilityLevel;
  readonly description: string;
}

/**
 * 配置文件可变性注册表
 *
 * 键为配置文件的顶层段名，值为可变性级别。
 * 未注册的段默认为 L2（运行时可重载）。
 */
const MUTABILITY_REGISTRY: Record<string, MutabilityEntry> = {
  // L0 — 启动锁定
  'security': { level: MutabilityLevel.L0, description: '安全策略（启动锁定）' },
  'database': { level: MutabilityLevel.L0, description: '数据库路径（启动锁定）' },

  // L1 — 启动时读取
  'system': { level: MutabilityLevel.L1, description: '系统基础信息（启动时读取）' },
  'server': { level: MutabilityLevel.L1, description: '服务端口（启动时读取）' },

  // L2 — 运行时可重载
  'routing': { level: MutabilityLevel.L2, description: '路由规则（热更新）' },
  'economy': { level: MutabilityLevel.L2, description: '经济规则（热更新）' },
  'arbitration': { level: MutabilityLevel.L2, description: '仲裁参数（热更新）' },
  'audit': { level: MutabilityLevel.L2, description: '审计参数（热更新）' },
  'supervision': { level: MutabilityLevel.L2, description: '监管参数（热更新）' },
  'memory': { level: MutabilityLevel.L2, description: '共享记忆参数（热更新）' },
  'eventBus': { level: MutabilityLevel.L2, description: '事件总线参数（热更新）' },
  'ui': { level: MutabilityLevel.L2, description: 'UI 参数（热更新）' },
};

/**
 * 获取配置段的 mutable 级别
 * @param section 配置段名（如 'security'、'routing'）
 * @returns 可变性级别，未注册段默认 L2
 */
export function getMutabilityLevel(section: string): MutabilityLevel {
  const entry = MUTABILITY_REGISTRY[section];
  return entry?.level ?? MutabilityLevel.L2;
}

/**
 * 检查配置段是否允许热更新
 */
export function isHotReloadable(section: string): boolean {
  const level = getMutabilityLevel(section);
  return level === MutabilityLevel.L2 || level === MutabilityLevel.L3;
}

/**
 * 检查配置段是否为启动锁定
 */
export function isStartupLocked(section: string): boolean {
  return getMutabilityLevel(section) === MutabilityLevel.L0;
}

/**
 * 获取所有 L0 启动锁定的配置段名
 */
export function getStartupLockedSections(): string[] {
  return Object.entries(MUTABILITY_REGISTRY)
    .filter(([, entry]) => entry.level === MutabilityLevel.L0)
    .map(([name]) => name);
}
