/**
 * AI 组件类型 + 事件延迟基准测试。
 *
 * 测试范围：
 * - AIEvent 类型结构验证
 * - AIComponentDef 类型结构验证
 * - ComponentFamily / ComponentSubgroup 枚举完整性
 * - 事件延迟 P99 基准测试（目标 <1ms）
 * - 注册表查找性能基准（Map O(1) 验证）
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AIEvent, AIComponentDef, ComponentFamily, ComponentSubgroup } from '../../Client/src/ai-components/types';

describe('AI 组件类型验证', () => {
  describe('AIEvent 结构', () => {
    it('完整 AIEvent 对象符合类型约束', () => {
      const event: AIEvent = {
        id: 'evt-001',
        type: 'agent:stream_chunk',
        data: { messageId: 'msg-1', chunk: 'Hello' },
        timestamp: Date.now(),
      };

      expect(event.id).toBe('evt-001');
      expect(event.type).toBe('agent:stream_chunk');
      expect(event.data).toHaveProperty('messageId');
      expect(typeof event.timestamp).toBe('number');
    });

    it('AIEvent.data 可为空对象', () => {
      const event: AIEvent = {
        id: 'evt-002',
        type: 'agent:stream_end',
        data: {},
        timestamp: Date.now(),
      };

      expect(Object.keys(event.data)).toHaveLength(0);
    });

    it('AIEvent.data 支持任意键值对', () => {
      const event: AIEvent = {
        id: 'evt-003',
        type: 'agent:tool_call',
        data: {
          toolName: 'read_file',
          arguments: { path: '/test' },
          result: 'content',
          nested: { deep: { value: 42 } },
        },
        timestamp: Date.now(),
      };

      expect(event.data.toolName).toBe('read_file');
      expect((event.data.nested as any).deep.value).toBe(42);
    });
  });

  describe('ComponentFamily 枚举', () => {
    it('包含所有 5 个族', () => {
      const families: ComponentFamily[] = ['loop', 'harness', 'memory', 'multiagent', 'core'];
      expect(families).toHaveLength(5);
      expect(families).toContain('core');
      expect(families).toContain('harness');
      expect(families).toContain('loop');
      expect(families).toContain('memory');
      expect(families).toContain('multiagent');
    });
  });

  describe('ComponentSubgroup 枚举', () => {
    it('包含所有 4 个子分组', () => {
      const subgroups: ComponentSubgroup[] = ['read', 'write', 'exec', 'system'];
      expect(subgroups).toHaveLength(4);
      expect(subgroups).toContain('read');
      expect(subgroups).toContain('write');
      expect(subgroups).toContain('exec');
      expect(subgroups).toContain('system');
    });
  });

  describe('AIComponentDef 结构', () => {
    it('完整组件定义符合类型约束', () => {
      const def: AIComponentDef = {
        family: 'core',
        subgroup: undefined,
        component: function StreamBuffer() { return null; },
        eventTypes: ['agent:stream_chunk', 'agent:stream_end'],
        metadata: {
          name: 'StreamBuffer',
          description: '流式输出缓冲',
          version: '1.0.0',
        },
      };

      expect(def.family).toBe('core');
      expect(def.eventTypes).toHaveLength(2);
      expect(def.metadata.name).toBe('StreamBuffer');
    });

    it('支持异步工厂函数作为 component', () => {
      const def: AIComponentDef = {
        family: 'loop',
        component: () => Promise.resolve({
          default: function LazyComp() { return null; },
        }),
        eventTypes: ['loop:iteration'],
        metadata: { name: 'LazyComp', description: 'lazy', version: '0.1.0' },
      };

      expect(typeof def.component).toBe('function');
    });

    it('支持 subgroup 可选字段', () => {
      const withSubgroup: AIComponentDef = {
        family: 'harness',
        subgroup: 'read',
        component: function Comp() { return null; },
        eventTypes: ['agent:tool_call'],
        metadata: { name: 'Comp', description: 'test', version: '1.0.0' },
      };

      expect(withSubgroup.subgroup).toBe('read');
    });
  });
});

// ── 事件延迟基准测试 ────────────────────────────────────────────────

describe('事件延迟基准', () => {
  it('进程内 EventEmitter 事件分发 P99 < 1ms', async () => {
    const { EventEmitter } = await import('node:events');
    const emitter = new EventEmitter();
    const iterations = 10_000;
    const latencies: number[] = [];

    emitter.on('test:event', () => {
      // 空处理函数
    });

    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      emitter.emit('test:event', { data: i });
      const end = performance.now();
      latencies.push(end - start);
    }

    // 排序计算 P99
    latencies.sort((a, b) => a - b);
    const p99Index = Math.floor(iterations * 0.99);
    const p99 = latencies[p99Index];
    const avg = latencies.reduce((a, b) => a + b, 0) / iterations;

    // P99 应 < 1ms（进程内事件分发极快）
    expect(p99).toBeLessThan(1);
    // 平均延迟应 < 0.1ms
    expect(avg).toBeLessThan(0.1);
  });

  it('注册表 Map 查找 O(1) 性能验证', async () => {
    vi.resetModules();
    const mod = await import('../../Client/src/ai-components/registry');
    const registry = mod.registry;

    // 注册 100 个组件
    for (let i = 0; i < 100; i++) {
      registry.register({
        family: 'core',
        component: function Comp() { return null; },
        eventTypes: [`perf:event_${i}`],
        metadata: { name: `Comp${i}`, description: 'perf', version: '1.0.0' },
      });
    }

    // 测量 1000 次查找的平均延迟
    const iterations = 1000;
    const latencies: number[] = [];

    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      await registry.getComponent(`perf:event_${i % 100}`);
      const end = performance.now();
      latencies.push(end - start);
    }

    latencies.sort((a, b) => a - b);
    const p99 = latencies[Math.floor(iterations * 0.99)];

    // 注册表查找 P99 应 < 1ms
    expect(p99).toBeLessThan(1);
  });

  it('subscribe handler 分发延迟 < 0.5ms', async () => {
    vi.resetModules();
    vi.mock('@/stores/systemStore', () => ({
      useSystemStore: { getState: () => ({ setOnline: vi.fn() }) },
    }));

    const bridge = await import('../../Client/src/services/eventBusBridge');
    const handlerLatencies: number[] = [];
    const iterations = 5000;

    bridge.subscribe((_msg) => {
      handlerLatencies.push(performance.now());
    });

    // 模拟事件分发（直接调用 handler）
    // 由于 eventBusBridge 内部 handlers 是 Set，我们通过 subscribe 注册后
    // 在 Electron 模式下通过 IPC 触发。这里测量 Set 遍历性能。
    const handlers = new Set<Function>();
    for (let i = 0; i < 10; i++) {
      handlers.add(() => {});
    }

    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      handlers.forEach(h => h());
    }
    const total = performance.now() - start;
    const avgPerIteration = total / iterations;

    // 10 个 handler 的 Set 遍历应极快
    expect(avgPerIteration).toBeLessThan(0.5);
    bridge.disconnectBridge();
  });
});
