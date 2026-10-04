/**
 * AI 组件族类型定义——Docs/Client/03-AI组件族架构 §2.2。
 *
 * 核心类型：
 * - ComponentFamily：组件族枚举（loop/harness/memory/multiagent/core）
 * - ComponentSubgroup：子分组（read/write/exec/system）
 * - AIComponentDef：组件注册定义（泛型支持 payload 类型约束）
 */

import type { ComponentType } from 'react';

// ── 组件族枚举 ──────────────────────────────────────────────────────

export type ComponentFamily = 'loop' | 'harness' | 'memory' | 'multiagent' | 'core';

// ── 子分组（用于 Harness 族工具分类）────────────────────────────────

export type ComponentSubgroup = 'read' | 'write' | 'exec' | 'system';

// ── AI 组件定义（泛型约束 payload 类型）──────────────────────────────

export interface AIComponentDef<TPayload = any> {
  /** 所属族（用于分包懒加载） */
  family: ComponentFamily;

  /** 子分组（可选，用于 UI 归类） */
  subgroup?: ComponentSubgroup;

  /** 实际 React 组件（懒加载时可为异步工厂函数） */
  component: ComponentType<{ payload: TPayload; event?: AIEvent }>
    | (() => Promise<{ default: ComponentType<{ payload: TPayload; event?: AIEvent }> }>);

  /** 响应的后端事件类型（支持通配符，如 'agent:tool_*'） */
  eventTypes: string[];

  /** 元数据（用于调试和文档生成） */
  metadata: {
    name: string;
    description: string;
    version: string;
  };
}

// ── AI 事件（从 eventBusBridge 传入的标准化事件）────────────────────

export interface AIEvent {
  id: string;
  type: string;
  data: Record<string, unknown>;
  timestamp: number;
}

// ── 族加载器（懒加载用）─────────────────────────────────────────────

export type FamilyLoader = () => Promise<{
  registerAll: (registry: ComponentRegistryAPI) => void;
}>;

// ── 注册表 API（供族模块回调注册）───────────────────────────────────

export interface ComponentRegistryAPI {
  register<T = any>(def: AIComponentDef<T>): void;
}
