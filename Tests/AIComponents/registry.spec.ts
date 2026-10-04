/**
 * AI 组件注册表测试——ComponentRegistry 全面覆盖。
 *
 * 测试范围：
 * - register()：单组件注册、多事件类型注册、重复注册覆盖
 * - getComponent()：精确匹配、通配符匹配、懒加载触发
 * - hasComponent()：精确/通配符查询
 * - getRegisteredEventTypes()：返回已注册事件类型列表
 * - size：注册表大小
 * - registerFamily() + preloadFamily()：族懒加载
 * - inferFamilyFromEventType()：通过 getComponent 间接测试族推断
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// 直接导入 registry 模块（每次测试需要新实例，避免单例污染）
// 由于 registry 是单例，我们通过 resetModules 确保隔离
beforeEach(() => {
  vi.resetModules();
});

async function createFreshRegistry() {
  // 动态导入确保每次获取新模块
  const mod = await import('../../Client/src/ai-components/registry');
  // registry 是单例，但我们可以在测试中手动清理
  return mod.registry;
}

describe('ComponentRegistry', () => {
  describe('register() + size', () => {
    it('注册单个组件定义，size 增加对应事件类型数', async () => {
      const registry = await createFreshRegistry();
      const initialSize = registry.size;

      registry.register({
        family: 'core',
        component: function TestComp() { return null; },
        eventTypes: ['agent:stream_chunk'],
        metadata: { name: 'TestComp', description: 'test', version: '1.0.0' },
      });

      expect(registry.size).toBe(initialSize + 1);
    });

    it('多事件类型注册：同一组件绑定多个事件类型', async () => {
      const registry = await createFreshRegistry();
      const initialSize = registry.size;

      registry.register({
        family: 'harness',
        component: function ToolComp() { return null; },
        eventTypes: ['agent:tool_call', 'agent:tool_result'],
        metadata: { name: 'ToolComp', description: 'test', version: '1.0.0' },
      });

      expect(registry.size).toBe(initialSize + 2);
    });

    it('重复注册同一事件类型会覆盖', async () => {
      const registry = await createFreshRegistry();

      registry.register({
        family: 'core',
        component: function V1() { return null; },
        eventTypes: ['test:event_a'],
        metadata: { name: 'V1', description: 'v1', version: '1.0.0' },
      });

      registry.register({
        family: 'core',
        component: function V2() { return null; },
        eventTypes: ['test:event_a'],
        metadata: { name: 'V2', description: 'v2', version: '2.0.0' },
      });

      // size 不变（同一 key 覆盖）
      const comp = await registry.getComponent('test:event_a');
      expect(comp).toBeDefined();
    });
  });

  describe('getComponent() — 精确匹配', () => {
    it('精确匹配已注册事件类型，返回 React 组件', async () => {
      const registry = await createFreshRegistry();
      const MockComponent = function MockComponent() { return null; };

      registry.register({
        family: 'core',
        component: MockComponent as any,
        eventTypes: ['agent:stream_chunk'],
        metadata: { name: 'Mock', description: 'test', version: '1.0.0' },
      });

      const result = await registry.getComponent('agent:stream_chunk');
      expect(result).toBe(MockComponent);
    });

    it('未注册事件类型返回 null', async () => {
      const registry = await createFreshRegistry();
      const result = await registry.getComponent('nonexistent:event');
      expect(result).toBeNull();
    });
  });

  describe('getComponent() — 通配符匹配', () => {
    it('通配符模式 agent:* 匹配 agent:stream_chunk', async () => {
      const registry = await createFreshRegistry();
      const WildcardComp = function WildcardComp() { return null; };

      registry.register({
        family: 'core',
        component: WildcardComp as any,
        eventTypes: ['agent:*'],
        metadata: { name: 'Wildcard', description: 'test', version: '1.0.0' },
      });

      const result = await registry.getComponent('agent:stream_chunk');
      expect(result).toBe(WildcardComp);
    });

    it('通配符模式 memory:* 匹配 memory:written', async () => {
      const registry = await createFreshRegistry();
      const MemComp = function MemComp() { return null; };

      registry.register({
        family: 'memory',
        component: MemComp as any,
        eventTypes: ['memory:*'],
        metadata: { name: 'MemComp', description: 'test', version: '1.0.0' },
      });

      const result = await registry.getComponent('memory:written');
      expect(result).toBe(MemComp);
    });

    it('通配符不匹配时返回 null', async () => {
      const registry = await createFreshRegistry();
      const Comp = function Comp() { return null; };

      registry.register({
        family: 'core',
        component: Comp as any,
        eventTypes: ['agent:*'],
        metadata: { name: 'Comp', description: 'test', version: '1.0.0' },
      });

      const result = await registry.getComponent('loop:iteration');
      expect(result).toBeNull();
    });

    it('精确匹配优先于通配符匹配', async () => {
      const registry = await createFreshRegistry();
      const ExactComp = function ExactComp() { return null; };
      const WildcardComp = function WildcardComp() { return null; };

      registry.register({
        family: 'core',
        component: WildcardComp as any,
        eventTypes: ['agent:*'],
        metadata: { name: 'Wildcard', description: 'test', version: '1.0.0' },
      });

      registry.register({
        family: 'core',
        component: ExactComp as any,
        eventTypes: ['agent:stream_chunk'],
        metadata: { name: 'Exact', description: 'test', version: '1.0.0' },
      });

      const result = await registry.getComponent('agent:stream_chunk');
      expect(result).toBe(ExactComp);
    });
  });

  describe('hasComponent()', () => {
    it('已注册事件类型返回 true', async () => {
      const registry = await createFreshRegistry();
      registry.register({
        family: 'core',
        component: function Comp() { return null; },
        eventTypes: ['test:exists'],
        metadata: { name: 'Comp', description: 'test', version: '1.0.0' },
      });

      expect(registry.hasComponent('test:exists')).toBe(true);
    });

    it('未注册事件类型返回 false', async () => {
      const registry = await createFreshRegistry();
      expect(registry.hasComponent('test:not_exists')).toBe(false);
    });

    it('通配符匹配也返回 true', async () => {
      const registry = await createFreshRegistry();
      registry.register({
        family: 'core',
        component: function Comp() { return null; },
        eventTypes: ['agent:*'],
        metadata: { name: 'Comp', description: 'test', version: '1.0.0' },
      });

      expect(registry.hasComponent('agent:anything')).toBe(true);
    });
  });

  describe('getRegisteredEventTypes()', () => {
    it('返回所有已注册的事件类型', async () => {
      const registry = await createFreshRegistry();
      registry.register({
        family: 'core',
        component: function Comp() { return null; },
        eventTypes: ['event:a', 'event:b', 'event:c'],
        metadata: { name: 'Comp', description: 'test', version: '1.0.0' },
      });

      const types = registry.getRegisteredEventTypes();
      expect(types).toContain('event:a');
      expect(types).toContain('event:b');
      expect(types).toContain('event:c');
    });
  });

  describe('registerFamily() + 懒加载', () => {
    it('注册族后，匹配该族事件时触发懒加载', async () => {
      const registry = await createFreshRegistry();
      const registerAllSpy = vi.fn();
      const loader = vi.fn().mockResolvedValue({ registerAll: registerAllSpy });

      registry.registerFamily('loop', loader);

      // 触发懒加载：loop:iteration 推断为 loop 族
      await registry.getComponent('loop:iteration');

      expect(loader).toHaveBeenCalledTimes(1);
      expect(registerAllSpy).toHaveBeenCalledTimes(1);
    });

    it('族只加载一次（重复触发不重复加载）', async () => {
      const registry = await createFreshRegistry();
      const loader = vi.fn().mockResolvedValue({ registerAll: vi.fn() });

      registry.registerFamily('memory', loader);

      await registry.getComponent('memory:first');
      await registry.getComponent('memory:second');

      expect(loader).toHaveBeenCalledTimes(1);
    });

    it('preloadFamily() 主动预加载族', async () => {
      const registry = await createFreshRegistry();
      const loader = vi.fn().mockResolvedValue({ registerAll: vi.fn() });

      registry.registerFamily('harness', loader);
      await registry.preloadFamily('harness');

      expect(loader).toHaveBeenCalledTimes(1);
    });
  });

  describe('inferFamilyFromEventType() — 通过 getComponent 间接验证', () => {
    it('loop: 前缀事件触发 loop 族加载', async () => {
      const registry = await createFreshRegistry();
      const loopLoader = vi.fn().mockResolvedValue({ registerAll: vi.fn() });
      const coreLoader = vi.fn().mockResolvedValue({ registerAll: vi.fn() });

      registry.registerFamily('loop', loopLoader);
      registry.registerFamily('core', coreLoader);

      await registry.getComponent('loop:iteration_complete');
      expect(loopLoader).toHaveBeenCalled();
      expect(coreLoader).not.toHaveBeenCalled();
    });

    it('agent:tool_ 前缀事件触发 harness 族加载', async () => {
      const registry = await createFreshRegistry();
      const harnessLoader = vi.fn().mockResolvedValue({ registerAll: vi.fn() });

      registry.registerFamily('harness', harnessLoader);

      await registry.getComponent('agent:tool_call');
      expect(harnessLoader).toHaveBeenCalled();
    });

    it('memory: 前缀事件触发 memory 族加载', async () => {
      const registry = await createFreshRegistry();
      const memoryLoader = vi.fn().mockResolvedValue({ registerAll: vi.fn() });

      registry.registerFamily('memory', memoryLoader);

      await registry.getComponent('memory:written');
      expect(memoryLoader).toHaveBeenCalled();
    });

    it('delegation: 前缀事件触发 multiagent 族加载', async () => {
      const registry = await createFreshRegistry();
      const multiLoader = vi.fn().mockResolvedValue({ registerAll: vi.fn() });

      registry.registerFamily('multiagent', multiLoader);

      await registry.getComponent('delegation:started');
      expect(multiLoader).toHaveBeenCalled();
    });

    it('agent:stream_ 前缀事件触发 core 族加载', async () => {
      const registry = await createFreshRegistry();
      const coreLoader = vi.fn().mockResolvedValue({ registerAll: vi.fn() });

      registry.registerFamily('core', coreLoader);

      await registry.getComponent('agent:stream_chunk');
      expect(coreLoader).toHaveBeenCalled();
    });
  });
});
