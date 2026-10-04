/**
 * AI 组件注册表——Docs/Client/03-AI组件族架构 §5.1。
 *
 * 单例模式，支持：
 * - register()：注册单个组件定义（泛型约束 payload 类型）
 * - registerFamily()：注册整个族（懒加载，首次匹配事件时触发）
 * - getComponent()：查询组件（触发懒加载）
 * - matchEvent()：根据事件类型查找已注册的组件
 *
 * 设计要点：
 * - Map 查找 O(1)，避免数组遍历
 * - 懒加载族首次匹配时触发 dynamic import
 * - 通配符匹配支持（如 'agent:tool_*'）
 */

import type { ComponentType } from 'react';
import type { AIComponentDef, ComponentFamily, FamilyLoader, AIEvent, ComponentRegistryAPI } from './types';

// ── 注册表实现 ──────────────────────────────────────────────────────

class ComponentRegistry implements ComponentRegistryAPI {
  /** 事件类型 → 组件定义映射 */
  private registry = new Map<string, AIComponentDef>();

  /** 族懒加载器（首次匹配时触发） */
  private lazyLoaders = new Map<ComponentFamily, FamilyLoader>();

  /** 已触发加载的族（避免重复加载） */
  private loadedFamilies = new Set<ComponentFamily>();

  /** 正在加载中的族（避免并发加载） */
  private loadingFamilies = new Set<ComponentFamily>();

  // ── 注册 ──────────────────────────────────────────────────────────

  /** 注册单个组件（泛型约束 payload 类型） */
  register<T = any>(def: AIComponentDef<T>): void {
    for (const eventType of def.eventTypes) {
      this.registry.set(eventType, def as AIComponentDef);
    }
  }

  /** 注册整个族（懒加载，首次匹配事件时触发） */
  registerFamily(family: ComponentFamily, loader: FamilyLoader): void {
    this.lazyLoaders.set(family, loader);
    // 标记为已注册但未加载
  }

  /** 预加载族（启动时注册高频族，如 Core/Harness） */
  async preloadFamily(family: ComponentFamily): Promise<void> {
    await this.ensureFamilyLoaded(family);
  }

  // ── 查询 ──────────────────────────────────────────────────────────

  /** 根据事件类型获取组件（触发懒加载） */
  async getComponent<T = any>(
    eventType: string,
  ): Promise<ComponentType<{ payload: T; event?: AIEvent }> | null> {
    // 1. 精确匹配
    let def = this.registry.get(eventType);

    // 2. 通配符匹配
    if (!def) {
      def = this.matchByWildcard(eventType) ?? undefined;
    }

    // 3. 触发懒加载
    if (!def) {
      const family = this.inferFamilyFromEventType(eventType);
      if (family) {
        await this.ensureFamilyLoaded(family);
        // 加载后重新查找
        def = this.registry.get(eventType) ?? (this.matchByWildcard(eventType) ?? undefined);
      }
    }

    if (!def) return null;

    // 如果是异步工厂函数，执行加载
    if (typeof def.component === 'function' && !this.isReactComponent(def.component)) {
      const module = await (def.component as Function)();
      return (module as any).default ?? module;
    }

    return def.component as ComponentType<{ payload: T; event?: AIEvent }>;
  }

  /** 检查事件类型是否已注册组件 */
  hasComponent(eventType: string): boolean {
    return this.registry.has(eventType) || this.matchByWildcard(eventType) !== null;
  }

  /** 获取所有已注册的事件类型 */
  getRegisteredEventTypes(): string[] {
    return [...this.registry.keys()];
  }

  /** 获取注册表大小 */
  get size(): number {
    return this.registry.size;
  }

  // ── 内部方法 ──────────────────────────────────────────────────────

  /** 通配符匹配 */
  private matchByWildcard(eventType: string): AIComponentDef | null {
    for (const [pattern, def] of this.registry.entries()) {
      if (pattern.includes('*')) {
        const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
        if (regex.test(eventType)) return def;
      }
    }
    return null;
  }

  /** 根据事件类型前缀推断所属族 */
  private inferFamilyFromEventType(eventType: string): ComponentFamily | null {
    if (eventType.startsWith('loop:') || eventType.startsWith('task:')) return 'loop';
    if (eventType.startsWith('agent:tool_') || eventType.startsWith('middleware:')) return 'harness';
    if (eventType.startsWith('memory:')) return 'memory';
    if (eventType.startsWith('delegation:') || eventType.startsWith('arbitration:')) return 'multiagent';
    if (eventType.startsWith('agent:stream_') || eventType.startsWith('agent:message_') || eventType.startsWith('agent:iteration_')) return 'core';
    return null;
  }

  /** 确保族已加载（懒加载触发） */
  private async ensureFamilyLoaded(family: ComponentFamily): Promise<void> {
    if (this.loadedFamilies.has(family) || this.loadingFamilies.has(family)) return;

    const loader = this.lazyLoaders.get(family);
    if (!loader) return;

    this.loadingFamilies.add(family);
    try {
      const module = await loader();
      module.registerAll(this);
      this.loadedFamilies.add(family);
    } finally {
      this.loadingFamilies.delete(family);
    }
  }

  /** 判断是否为 React 组件（区分工厂函数和组件函数） */
  private isReactComponent(fn: Function): boolean {
    // React 组件首字母大写，或标记了 $$typeof
    const name = fn.name ?? '';
    return /^[A-Z]/.test(name) || (fn as any).$$typeof !== undefined;
  }
}

// ── 单例导出 ────────────────────────────────────────────────────────

export const registry = new ComponentRegistry();
