/**
 * @module Arbitration/dynamicScaling
 * @description
 * 动态仲裁者扩缩器——Docs/05 §5.2。
 * 按冲突频率动态调整辅助仲裁者数量：f = k·n^m。
 * 每 monitoringInterval 采集指标，连续 3 个窗口超阈值 → 扩容；
 * 连续 3 个窗口低于阈值一半 → 缩容。
 */

import { EventType } from '../EventBus/eventTypes.js';
import { createEvent, publish } from '../EventBus/eventBus.js';
import type { Result } from '../../Infra/types.js';
import { ok } from '../../Infra/types.js';

import { resizeAuxiliaryPool, getPoolStats } from './arbitratorPool.js';

// ── 配置 ────────────────────────────────────────────────────────────

export interface ScalingConfig {
  scalingFactor: number;         // k
  scalingExponent: number;       // m
  frequencyThreshold: number;    // 单窗口冲突频率阈值
  consecutiveHighCount: number;  // 连续高负载窗口数
  consecutiveLowCount: number;   // 连续低负载窗口数
  monitoringIntervalMs: number;  // 监测间隔
  cooldownMs: number;            // 扩缩冷却期
  maxArbitrators: number;        // 辅助层上限
  minArbitrators: number;        // 辅助层下限
}

const DEFAULT_CONFIG: ScalingConfig = {
  scalingFactor: 1.5,
  scalingExponent: 0.5,
  frequencyThreshold: 5,
  consecutiveHighCount: 3,
  consecutiveLowCount: 3,
  monitoringIntervalMs: 60_000,
  cooldownMs: 120_000,
  maxArbitrators: 15,
  minArbitrators: 0,
};

// ── 内部状态 ────────────────────────────────────────────────────────

let config: ScalingConfig = { ...DEFAULT_CONFIG };
let consecutiveHigh = 0;
let consecutiveLow = 0;
let lastScaleTime = 0;
let conflictWindow: number[] = []; // 每个窗口的冲突数
let timerHandle: ReturnType<typeof setInterval> | null = null;

// ── 初始化 ──────────────────────────────────────────────────────────

export function initDynamicScaling(cfg: Partial<ScalingConfig> = {}): void {
  config = { ...DEFAULT_CONFIG, ...cfg };
  consecutiveHigh = 0;
  consecutiveLow = 0;
  lastScaleTime = 0;
  conflictWindow = [];
}

// ── 记录冲突 ────────────────────────────────────────────────────────

export function recordConflict(timestamp?: number): void {
  conflictWindow.push(timestamp ?? Date.now());
}

// ── 评估与扩缩 ──────────────────────────────────────────────────────

/**
 * 执行一次扩缩评估（由定时器或手动触发）。
 */
export function evaluateScaling(): Result<{ action: 'scale_up' | 'scale_down' | 'none'; targetCount: number }> {
  const now = Date.now();

  // 冷却期检查
  if (now - lastScaleTime < config.cooldownMs) {
    return ok({ action: 'none', targetCount: getPoolStats().auxiliary });
  }

  // 清理过期数据（5 分钟窗口）
  const windowStart = now - 300_000;
  conflictWindow = conflictWindow.filter(t => t >= windowStart);

  const frequency = conflictWindow.length;
  const stats = getPoolStats();
  const currentAux = stats.auxiliary;

  // 高负载判定
  if (frequency > config.frequencyThreshold) {
    consecutiveHigh++;
    consecutiveLow = 0;

    if (consecutiveHigh >= config.consecutiveHighCount) {
      // 扩容：f = k · n^m
      const targetRaw = config.scalingFactor * Math.pow(frequency, config.scalingExponent);
      const targetCount = Math.min(Math.ceil(targetRaw), config.maxArbitrators);

      if (targetCount > currentAux) {
        const result = resizeAuxiliaryPool(targetCount);
        if (result.ok) {
          lastScaleTime = now;
          consecutiveHigh = 0;

          publish(createEvent({
            eventType: EventType.ARBITRATOR_POOL_RESIZED,
            source: 'Arbitration/dynamicScaling',
            payload: { action: 'scale_up', targetCount, added: result.value.added },
          }));

          return ok({ action: 'scale_up', targetCount });
        }
      }
    }
  }
  // 低负载判定
  else if (frequency < config.frequencyThreshold * 0.5) {
    consecutiveLow++;
    consecutiveHigh = 0;

    if (consecutiveLow >= config.consecutiveLowCount) {
      const targetCount = Math.max(config.minArbitrators, Math.floor(currentAux * 0.5));

      if (targetCount < currentAux) {
        const result = resizeAuxiliaryPool(targetCount);
        if (result.ok) {
          lastScaleTime = now;
          consecutiveLow = 0;

          publish(createEvent({
            eventType: EventType.ARBITRATOR_POOL_RESIZED,
            source: 'Arbitration/dynamicScaling',
            payload: { action: 'scale_down', targetCount, removed: result.value.removed },
          }));

          return ok({ action: 'scale_down', targetCount });
        }
      }
    }
  } else {
    // 正常范围，重置计数
    consecutiveHigh = 0;
    consecutiveLow = 0;
  }

  return ok({ action: 'none', targetCount: currentAux });
}

// ── 自动监测 ────────────────────────────────────────────────────────

export function startAutoScaling(): void {
  stopAutoScaling();
  timerHandle = setInterval(() => {
    evaluateScaling();
  }, config.monitoringIntervalMs);
}

export function stopAutoScaling(): void {
  if (timerHandle) {
    clearInterval(timerHandle);
    timerHandle = null;
  }
}

// ── 查询 ────────────────────────────────────────────────────────────

export function getScalingConfig(): ScalingConfig {
  return { ...config };
}

export function getScalingStats(): {
  consecutiveHigh: number;
  consecutiveLow: number;
  recentConflictCount: number;
} {
  const now = Date.now();
  const windowStart = now - 300_000;
  return {
    consecutiveHigh,
    consecutiveLow,
    recentConflictCount: conflictWindow.filter(t => t >= windowStart).length,
  };
}

// ── 重置（测试用）──────────────────────────────────────────────────

export function resetDynamicScaling(): void {
  stopAutoScaling();
  config = { ...DEFAULT_CONFIG };
  consecutiveHigh = 0;
  consecutiveLow = 0;
  lastScaleTime = 0;
  conflictWindow = [];
}
