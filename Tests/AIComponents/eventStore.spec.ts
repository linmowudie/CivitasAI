/**
 * eventStore 测试——全局事件缓冲 zustand store。
 *
 * 测试范围：
 * - pushEvent()：推入事件 + 容量控制
 * - clearEvents()：清空缓冲
 * - 容量上限：超 1000 条时裁剪到 500 条
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useEventStore } from '../../Client/src/stores/eventStore';

describe('eventStore', () => {
  beforeEach(() => {
    useEventStore.getState().clearEvents();
  });

  describe('pushEvent()', () => {
    it('推入一条事件', () => {
      useEventStore.getState().pushEvent({
        type: 'agent:stream_chunk',
        data: { chunk: 'hello' },
        timestamp: Date.now(),
      });

      expect(useEventStore.getState().events).toHaveLength(1);
      expect(useEventStore.getState().events[0].type).toBe('agent:stream_chunk');
    });

    it('推入多条事件保持顺序', () => {
      useEventStore.getState().pushEvent({ type: 'evt:a', data: {}, timestamp: 1 });
      useEventStore.getState().pushEvent({ type: 'evt:b', data: {}, timestamp: 2 });
      useEventStore.getState().pushEvent({ type: 'evt:c', data: {}, timestamp: 3 });

      const events = useEventStore.getState().events;
      expect(events).toHaveLength(3);
      expect(events[0].type).toBe('evt:a');
      expect(events[2].type).toBe('evt:c');
    });
  });

  describe('clearEvents()', () => {
    it('清空所有事件', () => {
      useEventStore.getState().pushEvent({ type: 'test', data: {}, timestamp: 1 });
      useEventStore.getState().pushEvent({ type: 'test', data: {}, timestamp: 2 });
      expect(useEventStore.getState().events).toHaveLength(2);

      useEventStore.getState().clearEvents();
      expect(useEventStore.getState().events).toHaveLength(0);
    });

    it('空缓冲时清空不报错', () => {
      expect(() => useEventStore.getState().clearEvents()).not.toThrow();
      expect(useEventStore.getState().events).toHaveLength(0);
    });
  });

  describe('容量控制', () => {
    it('超过 1000 条时裁剪到 500 条', () => {
      // 推入 1001 条
      for (let i = 0; i < 1001; i++) {
        useEventStore.getState().pushEvent({
          type: `evt:${i}`,
          data: {},
          timestamp: i,
        });
      }

      const events = useEventStore.getState().events;
      // 裁剪后应保留最新 500 条
      expect(events).toHaveLength(500);
      // 第一条应是第 501 条（i=501）
      expect(events[0].type).toBe('evt:501');
      // 最后一条应是第 1000 条
      expect(events[499].type).toBe('evt:1000');
    });

    it('恰好 1000 条时不裁剪', () => {
      for (let i = 0; i < 1000; i++) {
        useEventStore.getState().pushEvent({
          type: `evt:${i}`,
          data: {},
          timestamp: i,
        });
      }

      expect(useEventStore.getState().events).toHaveLength(1000);
    });
  });
});
