/**
 * S1-③ Infra/Time 模块测试
 *
 * 覆盖：timeService — Time.now() / 回拨检测 / 单调时钟 / measure
 * Gate G1 要求：时钟回拨检测生效
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Time } from '../../Src/Infra/Time/timeService.js';
import type { ClockDriftEvent } from '../../Src/Infra/Time/timeService.js';

describe('S1-③ Time 模块', () => {
  describe('Time.now()', () => {
    it('返回 epoch 毫秒时间戳', () => {
      const now = Time.now();
      expect(typeof now).toBe('number');
      expect(now).toBeGreaterThan(1700000000000); // 2023+ 的 epoch ms
    });

    it('连续调用单调递增', () => {
      const t1 = Time.now();
      const t2 = Time.now();
      const t3 = Time.now();
      expect(t2).toBeGreaterThanOrEqual(t1);
      expect(t3).toBeGreaterThanOrEqual(t2);
    });

    it('与 Date.now() 接近（误差 < 100ms）', () => {
      const timeNow = Time.now();
      const dateNow = Date.now();
      expect(Math.abs(timeNow - dateNow)).toBeLessThan(100);
    });
  });

  describe('时钟回拨检测（Gate G1）', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('检测时钟回拨并补偿（Gate G1）', () => {
      // 先正常获取一次时间
      const t1 = Time.now();

      // 模拟时钟回拨：让 Date.now() 返回更早的值
      const originalDateNow = Date.now;
      vi.spyOn(Date, 'now').mockReturnValue(t1 - 5000); // 回拨 5 秒

      const t2 = Time.now();

      // 回拨时应该返回 lastKnownTime + 1（保证单调递增）
      expect(t2).toBeGreaterThan(t1);
      expect(t2).toBe(t1 + 1);

      // 状态应该记录了回拨事件
      const state = Time.getState();
      expect(state.driftCount).toBeGreaterThan(0);
      expect(state.maxDriftMs).toBeGreaterThanOrEqual(5000);
      expect(state.compensating).toBe(true);

      vi.restoreAllMocks();
    });

    it('回拨回调被触发', () => {
      const events: ClockDriftEvent[] = [];
      Time.onDrift((event) => events.push(event));

      const t1 = Time.now();

      // 模拟回拨
      vi.spyOn(Date, 'now').mockReturnValue(t1 - 1000);
      Time.now();

      expect(events.length).toBeGreaterThan(0);
      const lastEvent = events[events.length - 1];
      expect(lastEvent.driftMs).toBeGreaterThanOrEqual(1000);

      vi.restoreAllMocks();
      // 清除回调
      Time.onDrift(() => {});
    });

    it('时钟恢复正常后继续正确工作', () => {
      const t1 = Time.now();

      // 模拟回拨
      vi.spyOn(Date, 'now').mockReturnValue(t1 - 1000);
      Time.now();

      // 恢复正常
      vi.restoreAllMocks();
      const t3 = Time.now();

      // 恢复后应该接近真实时间
      expect(t3).toBeGreaterThanOrEqual(t1);

      vi.restoreAllMocks();
    });
  });

  describe('Time.isoNow()', () => {
    it('返回 ISO-8601 格式字符串', () => {
      const iso = Time.isoNow();
      expect(typeof iso).toBe('string');
      // ISO-8601 格式验证
      expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });
  });

  describe('Time.since()', () => {
    it('计算经过时间', async () => {
      const start = Time.now();
      // 等待一小段时间
      await new Promise(resolve => setTimeout(resolve, 10));
      const elapsed = Time.since(start);
      expect(elapsed).toBeGreaterThanOrEqual(5); // 至少 5ms（考虑计时器精度）
    });
  });

  describe('Time.monotonicMs()', () => {
    it('返回单调递增的时间戳', () => {
      const m1 = Time.monotonicMs();
      const m2 = Time.monotonicMs();
      expect(m2).toBeGreaterThanOrEqual(m1);
    });

    it('不受 Date.now() 回拨影响', () => {
      const m1 = Time.monotonicMs();

      // 即使 Date.now() 被 mock，monotonicMs 不受影响
      vi.spyOn(Date, 'now').mockReturnValue(0);
      const m2 = Time.monotonicMs();

      expect(m2).toBeGreaterThanOrEqual(m1);
      vi.restoreAllMocks();
    });
  });

  describe('Time.measure()', () => {
    it('测量同步函数耗时', () => {
      const [result, elapsed] = Time.measure(() => {
        let sum = 0;
        for (let i = 0; i < 1000000; i++) sum += i;
        return sum;
      });
      expect(typeof result).toBe('number');
      expect(elapsed).toBeGreaterThanOrEqual(0);
    });

    it('测量异步函数耗时', async () => {
      const [result, elapsed] = await Time.measure(async () => {
        await new Promise(resolve => setTimeout(resolve, 20));
        return 'done';
      });
      expect(result).toBe('done');
      expect(elapsed).toBeGreaterThanOrEqual(10); // 至少 10ms
    });
  });

  describe('Time.format()', () => {
    it('格式化 epoch ms 为 ISO 字符串', () => {
      const formatted = Time.format(0);
      expect(formatted).toBe('1970-01-01T00:00:00.000Z');
    });
  });

  describe('Time.nowSec()', () => {
    it('返回秒级时间戳', () => {
      const sec = Time.nowSec();
      const ms = Time.now();
      expect(sec).toBe(Math.floor(ms / 1000));
      expect(sec).toBeGreaterThan(1700000000); // 2023+
    });
  });

  describe('Time.getState()', () => {
    it('返回服务状态', () => {
      const state = Time.getState();
      expect(state).toHaveProperty('driftCount');
      expect(state).toHaveProperty('maxDriftMs');
      expect(state).toHaveProperty('startedAt');
      expect(state).toHaveProperty('compensating');
      expect(state.startedAt).toBeGreaterThan(0);
    });
  });
});
