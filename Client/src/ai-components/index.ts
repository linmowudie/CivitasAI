/**
 * AI 组件族根入口——Docs/Client/03-AI组件族架构。
 *
 * 组织方式：按 Agent 运行时语义分组
 * - core：基础 UI 组件（StreamBuffer / CoTFolder / MessageShell）
 * - harness：工具调用/中间件展示（ToolGroup）
 * - loop：迭代/预算/验证器（待实现）
 * - memory：记忆展示/版本对比（待实现）
 * - multiagent：委派/联盟/仲裁（待实现）
 *
 * 核心导出：
 * - registry：组件注册表单例
 * - AIEventBus：声明式事件订阅容器
 * - Subscribe：事件订阅组件
 * - types：类型定义
 */

// ── 注册表 ──────────────────────────────────────────────────────────
export { registry } from './registry';

// ── 事件订阅 ────────────────────────────────────────────────────────
export { AIEventBus, useEventBusContext } from './AIEventBus';
export { Subscribe, matchEventType } from './Subscribe';

// ── 错误边界 ────────────────────────────────────────────────────────
export { FamilyErrorBoundary } from './FamilyErrorBoundary';
export { FallbackUI } from './FallbackUI';

// ── 类型 ────────────────────────────────────────────────────────────
export type {
  AIComponentDef, ComponentFamily, ComponentSubgroup,
  AIEvent, FamilyLoader, ComponentRegistryAPI,
} from './types';

// ── Core 族（高频，启动时注册）──────────────────────────────────────
export { StreamBuffer } from './core/StreamBuffer';
export { CoTFolder } from './core/CoTFolder';
export { MessageShell } from './core/MessageShell';

// ── Harness 族 ──────────────────────────────────────────────────────
export { ToolGroup } from './harness/ToolGroup';

// ── 族懒加载注册 ────────────────────────────────────────────────────

import { registry } from './registry';

// Core 族：高频，直接注册（非懒加载）
import { registerAll as registerCore } from './core';
registerCore(registry);

// Harness 族：高频，直接注册
import { registerAll as registerHarness } from './harness';
registerHarness(registry);

// 低频族：懒加载（首次匹配事件时触发 dynamic import）
registry.registerFamily('loop', () => import('./loop'));
registry.registerFamily('memory', () => import('./memory'));
registry.registerFamily('multiagent', () => import('./multiagent'));
