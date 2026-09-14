/**
 * @module Audit/anomalyDetector
 * @description
 * 异常检测器——Docs/06 §2.3。
 * 三条规则：滚动窗口超限 / 偏离均值 / 循环检测。
 * 同 Agent 30s 冷却期（Docs/06 §5.1 防风暴）。
 */

import { EventType } from '../EventBus/eventTypes.js';
import { createEvent, publish } from '../EventBus/eventBus.js';
import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';

// ── 告警级别 ────────────────────────────────────────────────────────

export type AlertLevel = 'warning' | 'critical';
export type AnomalyType = 'rolling_window_exceeded' | 'deviation_from_mean' | 'loop_detected';

export interface AnomalyAlert {
  alertId: string;
  agentId: string;
  type: AnomalyType;
  level: AlertLevel;
  detail: string;
  currentValue: number;
  threshold: number;
  timestamp: number;
}

// ── 配置 ────────────────────────────────────────────────────────────

export interface DetectorConfig {
  rollingWindowMs: number;
  rollingBudgetTokens: number;
  deviationWarnMultiplier: number;
  deviationCriticalMultiplier: number;
  loopSimilarityThreshold: number;
  loopConsecutiveRounds: number;
  cooldownMs: number;
}

const DEFAULT_CONFIG: DetectorConfig = {
  rollingWindowMs: 5 * 60 * 1000,  // 5 分钟
  rollingBudgetTokens: 10000,
  deviationWarnMultiplier: 3,
  deviationCriticalMultiplier: 5,
  loopSimilarityThreshold: 0.85,
  loopConsecutiveRounds: 5,
  cooldownMs: 30_000, // 30s
};

// ── 内部状态 ────────────────────────────────────────────────────────

let config: DetectorConfig = { ...DEFAULT_CONFIG };
const alerts: Map<string, AnomalyAlert> = new Map();
let alertCounter = 0;

// 每个 Agent 的消耗记录
const consumptionRecords: Map<string, { tokens: number; timestamp: number }[]> = new Map();
// 每个 Agent 的输出指纹（循环检测）
const outputFingerprints: Map<string, string[]> = new Map();
// 冷却期追踪
const lastAlertTime: Map<string, number> = new Map(); // `${agentId}:${type}` → timestamp

// ── 初始化 ──────────────────────────────────────────────────────────

export function initAnomalyDetector(cfg: Partial<DetectorConfig> = {}): void {
  config = { ...DEFAULT_CONFIG, ...cfg };
}

// ── 规则 1：滚动窗口超限 ────────────────────────────────────────────

export function checkRollingWindow(agentId: string): Result<AnomalyAlert | null> {
  const now = Date.now();
  const records = consumptionRecords.get(agentId) ?? [];
  const windowStart = now - config.rollingWindowMs;
  const windowConsumption = records
    .filter(r => r.timestamp >= windowStart)
    .reduce((sum, r) => sum + r.tokens, 0);

  const budget = config.rollingBudgetTokens;

  if (windowConsumption > budget) {
    return ok(createAlert(agentId, 'rolling_window_exceeded', 'critical',
      `滚动窗口消耗 ${windowConsumption} 超预算 ${budget}`,
      windowConsumption, budget));
  }

  if (windowConsumption > budget * 0.8) {
    return ok(createAlert(agentId, 'rolling_window_exceeded', 'warning',
      `滚动窗口消耗 ${windowConsumption} 达预算 80%`,
      windowConsumption, budget * 0.8));
  }

  return ok(null);
}

// ── 规则 2：偏离均值 ────────────────────────────────────────────────

export function checkDeviation(agentId: string, currentConsumption: number): Result<AnomalyAlert | null> {
  const records = consumptionRecords.get(agentId) ?? [];
  const recent = records.slice(-10);

  if (recent.length < 3) {
    // 数据不足，跳过
    return ok(null);
  }

  const avg = recent.reduce((sum, r) => sum + r.tokens, 0) / recent.length;

  if (avg === 0) return ok(null);

  if (currentConsumption > avg * config.deviationCriticalMultiplier) {
    return ok(createAlert(agentId, 'deviation_from_mean', 'critical',
      `当前消耗 ${currentConsumption} 超均值 ${avg.toFixed(0)} × ${config.deviationCriticalMultiplier}`,
      currentConsumption, avg * config.deviationCriticalMultiplier));
  }

  if (currentConsumption > avg * config.deviationWarnMultiplier) {
    return ok(createAlert(agentId, 'deviation_from_mean', 'warning',
      `当前消耗 ${currentConsumption} 超均值 ${avg.toFixed(0)} × ${config.deviationWarnMultiplier}`,
      currentConsumption, avg * config.deviationWarnMultiplier));
  }

  return ok(null);
}

// ── 规则 3：循环检测 ────────────────────────────────────────────────

export function checkLoop(agentId: string, outputFingerprint: string): Result<AnomalyAlert | null> {
  const fingerprints = outputFingerprints.get(agentId) ?? [];
  fingerprints.push(outputFingerprint);

  // 保留最近 N 个
  if (fingerprints.length > config.loopConsecutiveRounds + 2) {
    fingerprints.splice(0, fingerprints.length - config.loopConsecutiveRounds - 2);
  }

  outputFingerprints.set(agentId, fingerprints);

  // 检查最近 N 轮是否重复
  if (fingerprints.length >= config.loopConsecutiveRounds) {
    const recent = fingerprints.slice(-config.loopConsecutiveRounds);
    const unique = new Set(recent);

    // 如果唯一指纹比例很低 → 疑似循环
    if (unique.size <= 2) {
      return ok(createAlert(agentId, 'loop_detected', 'critical',
        `最近 ${config.loopConsecutiveRounds} 轮输出高度重复（${unique.size} 种指纹）`,
        unique.size, config.loopSimilarityThreshold));
    }
  }

  return ok(null);
}

// ── 记录消耗 ────────────────────────────────────────────────────────

export function recordConsumption(agentId: string, tokens: number): void {
  const records = consumptionRecords.get(agentId) ?? [];
  records.push({ tokens, timestamp: Date.now() });
  consumptionRecords.set(agentId, records);
}

// ── 创建告警（带冷却期）─────────────────────────────────────────────

function createAlert(
  agentId: string,
  type: AnomalyType,
  level: AlertLevel,
  detail: string,
  currentValue: number,
  threshold: number,
): AnomalyAlert | null {
  const now = Date.now();
  const cooldownKey = `${agentId}:${type}`;
  const lastTime = lastAlertTime.get(cooldownKey);

  if (lastTime && now - lastTime < config.cooldownMs) {
    return null; // 冷却期内，不重复告警
  }

  const alert: AnomalyAlert = {
    alertId: `alert-${++alertCounter}`,
    agentId,
    type,
    level,
    detail,
    currentValue,
    threshold,
    timestamp: now,
  };

  alerts.set(alert.alertId, alert);
  lastAlertTime.set(cooldownKey, now);

  // 发布事件
  publish(createEvent({
    eventType: EventType.ANOMALY_DETECTED,
    source: 'Audit/anomalyDetector',
    payload: {
      alertId: alert.alertId,
      agentId,
      type,
      level,
      detail,
    },
  }));

  return alert;
}

// ── 查询 ────────────────────────────────────────────────────────────

export function getAlerts(agentId?: string): AnomalyAlert[] {
  const all = [...alerts.values()];
  if (agentId) return all.filter(a => a.agentId === agentId);
  return all;
}

export function getCriticalAlerts(): AnomalyAlert[] {
  return [...alerts.values()].filter(a => a.level === 'critical');
}

// ── 重置（测试用）──────────────────────────────────────────────────

export function resetAnomalyDetector(): void {
  alerts.clear();
  alertCounter = 0;
  consumptionRecords.clear();
  outputFingerprints.clear();
  lastAlertTime.clear();
  config = { ...DEFAULT_CONFIG };
}
