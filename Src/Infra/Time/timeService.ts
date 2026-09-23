/**
 * 统一时间服务（Docs/02 §7.1 ③ / Gate G1）
 *
 * 职责：
 * - 提供统一时间入口 `Time.now()`，禁止代码中散用 `Date.now()`
 * - 时钟回拨检测：当系统时钟回退时发出警告并补偿
 * - 单调时钟：基于 performance.now() 提供稳定的时间间隔测量
 * - ISO 格式化便捷方法
 *
 * 设计约束：
 * - 所有时间戳统一使用 epoch 毫秒（Docs/11 §1.2.1）
 * - 时间戳后缀 `_at`（Docs/11 §1.2.1）
 * - DB 列一律 INTEGER（Docs/11 §1.2.1）
 * - 禁止 ISO-8601 字符串与 epoch 整数在同一库内混用
 *
 * 使用方式：
 * ```ts
 * import { Time } from '@Infra/Time/timeService.js';
 *
 * const now = Time.now();          // epoch ms
 * const iso = Time.isoNow();       // ISO-8601
 * const elapsed = Time.since(start); // ms elapsed
 * ```
 */

import { performance } from 'node:perf_hooks';

// ===== 类型定义 =====

/** 时钟回拨事件 */
export interface ClockDriftEvent {
  /** 检测到回拨的时间（epoch ms） */
  readonly detectedAt: number;
  /** 回拨幅度（ms，正值表示回拨了多少） */
  readonly driftMs: number;
  /** 上次记录的时间 */
  readonly lastTime: number;
  /** 当前 Date.now() 返回值 */
  readonly currentTime: number;
}

/** 时间服务状态 */
export interface TimeServiceState {
  /** 累计检测到的回拨次数 */
  readonly driftCount: number;
  /** 最大单次回拨幅度（ms） */
  readonly maxDriftMs: number;
  /** 服务启动时间（epoch ms） */
  readonly startedAt: number;
  /** 是否处于补偿状态 */
  readonly compensating: boolean;
}

// ===== 内部状态 =====

/** 上次 Date.now() 返回值（用于回拨检测） */
let lastKnownTime = 0;

/** 累计回拨次数 */
let driftCount = 0;

/** 最大单次回拨幅度 */
let maxDriftMs = 0;

/** 补偿偏移量（ms）— 回拨检测后累加 */
let compensationOffset = 0;

/** 回拨事件回调（可选，供日志系统使用） */
let driftCallback: ((event: ClockDriftEvent) => void) | null = null;

/** 服务启动时间 */
const startedAt = Date.now();

// ===== Time 门面对象 =====

export const Time = {
  /**
   * 获取当前时间（epoch 毫秒）
   *
   * 这是系统获取时间的唯一推荐入口。
   * 包含时钟回拨检测与补偿逻辑。
   *
   * 回拨策略：
   * - 如果 Date.now() < lastKnownTime，判定为时钟回拨
   * - 回拨时不更新 lastKnownTime，而是累加补偿偏移
   * - 返回 lastKnownTime + 1（确保单调递增）
   * - 触发 driftCallback（如果注册了的话）
   */
  now(): number {
    const raw = Date.now();

    if (raw < lastKnownTime) {
      // 时钟回拨检测
      const drift = lastKnownTime - raw;
      driftCount++;
      if (drift > maxDriftMs) {
        maxDriftMs = drift;
      }
      compensationOffset += drift;

      // 触发回调
      if (driftCallback) {
        driftCallback({
          detectedAt: raw,
          driftMs: drift,
          lastTime: lastKnownTime,
          currentTime: raw,
        });
      }

      // 返回补偿后的时间（确保单调递增）
      const compensated = lastKnownTime + 1;
      lastKnownTime = compensated;
      return compensated;
    }

    lastKnownTime = raw;
    return raw;
  },

  /**
   * 获取当前时间的 ISO-8601 字符串
   *
   * 仅用于日志输出和调试，不用于持久化存储。
   * 持久化一律使用 epoch 毫秒（Time.now()）。
   */
  isoNow(): string {
    return new Date(Time.now()).toISOString();
  },

  /**
   * 计算从给定时间到现在的经过时间（ms）
   *
   * @param startMs 起始时间（epoch ms），通常来自 Time.now()
   * @returns 经过的毫秒数
   */
  since(startMs: number): number {
    return Time.now() - startMs;
  },

  /**
   * 获取单调时间戳（高精度，仅用于测量间隔）
   *
   * 基于 performance.now()，不受系统时钟回拨影响。
   * 适用于精确的性能测量和超时计算。
   *
   * 注意：此值不是 epoch 时间，仅用于计算时间差。
   */
  monotonicMs(): number {
    return performance.now();
  },

  /**
   * 测量一段代码的执行时间
   *
   * @param fn 要测量的函数（同步或异步）
   * @returns [结果, 耗时ms]
   */
  measure<T>(fn: () => T | Promise<T>): [T, number] | Promise<[T, number]> {
    const start = performance.now();
    const result = fn();

    if (result instanceof Promise) {
      return result.then((r) => [r, performance.now() - start] as [T, number]);
    }
    return [result, performance.now() - start];
  },

  /**
   * 获取时间服务的运行状态
   */
  getState(): TimeServiceState {
    return {
      driftCount,
      maxDriftMs,
      startedAt,
      compensating: compensationOffset > 0,
    };
  },

  /**
   * 注册时钟回拨事件回调
   *
   * 通常由日志系统注册，用于记录回拨警告。
   */
  onDrift(callback: (event: ClockDriftEvent) => void): void {
    driftCallback = callback;
  },

  /**
   * 格式化 epoch ms 为可读字符串（仅用于调试/日志）
   *
   * @param epochMs epoch 毫秒时间戳
   * @returns ISO-8601 格式字符串
   */
  format(epochMs: number): string {
    return new Date(epochMs).toISOString();
  },

  /**
   * 获取当前时间的秒级时间戳
   *
   * 适用于不需要毫秒精度的场景（如 TTL、过期时间）。
   */
  nowSec(): number {
    return Math.floor(Time.now() / 1000);
  },
};
