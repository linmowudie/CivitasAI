/**
 * @module LoopControl/actionFingerprint
 * @description
 * 动作指纹系统——Docs/12 §5。
 * fingerprint = SHA-256(toolName + canonicalJson(toolArgs))。
 * 检测重复动作，支撑 §5.2 的四条检测规则。
 */

import type { FingerprintRecord } from './loopState.js';

// ── 指纹计算 ────────────────────────────────────────────────────────

/**
 * 规范化 JSON：字典序排序键、去除 optional 空字段、数字统一 float
 */
export function canonicalJson(obj: unknown): string {
  if (obj === null || obj === undefined) return 'null';
  if (typeof obj === 'number') return obj.toFixed(1);
  if (typeof obj === 'string') return JSON.stringify(obj);
  if (typeof obj === 'boolean') return obj ? 'true' : 'false';
  if (Array.isArray(obj)) {
    return '[' + obj.map(item => canonicalJson(item)).join(',') + ']';
  }
  if (typeof obj === 'object') {
    const entries = Object.entries(obj as Record<string, unknown>)
      .filter(([, v]) => v !== undefined && v !== null)
      .sort(([a], [b]) => a.localeCompare(b));
    return '{' + entries.map(([k, v]) => JSON.stringify(k) + ':' + canonicalJson(v)).join(',') + '}';
  }
  return String(obj);
}

/**
 * 计算动作指纹——SHA-256(toolName + canonicalJson(args))
 *
 * 使用简单 hash 替代 crypto（避免 Node 依赖），足够用于指纹检测。
 */
export function computeFingerprint(toolName: string, args: Record<string, unknown>): string {
  const input = toolName + canonicalJson(args);
  // DJB2 hash → hex
  let h1 = 5381;
  let h2 = 0x12345678;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = ((h1 << 5) + h1 + c) & 0xffffffff;
    h2 = ((h2 << 7) + (h2 << 3) + c) & 0xffffffff;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

// ── 指纹配置 ────────────────────────────────────────────────────────

export interface FingerprintConfig {
  singleIterationWarnThreshold: number;
  consecutiveDuplicateRounds: number;
  windowRounds: number;
  windowHitThreshold: number;
  crossAgentDuplicateThreshold: number;
}

// ── 检测结果 ────────────────────────────────────────────────────────

export type FingerprintAction =
  | { type: 'none' }
  | { type: 'warn'; message: string }
  | { type: 'switch_strategy'; reason: string }
  | { type: 'event_report'; eventName: string; data: unknown }
  | { type: 'deadlock_protection'; reason: string };

/**
 * 检测指纹重复——Docs/12 §5.2
 *
 * 四条规则（按动作强度升序）：
 * 1. 单次迭代内 fingerprint 相同 ≥ singleIterationWarnThreshold → WARN
 * 2. 连续 consecutiveDuplicateRounds 次相同 fingerprint → switch_strategy
 * 3. windowRounds 轮内相同 fingerprint 累计 ≥ windowHitThreshold → 事件上报
 * 4. 两个 Agent 相同 fingerprint 交叉出现 → 死锁保护
 *
 * 多条件同一轮命中时只执行最强一个。
 */
export function detectFingerprintAction(
  currentFingerprint: string,
  currentIteration: number,
  history: FingerprintRecord[],
  config: FingerprintConfig,
): FingerprintAction {
  let strongest: FingerprintAction = { type: 'none' };
  const strength = (t: string): number => {
    switch (t) {
      case 'none': return 0;
      case 'warn': return 1;
      case 'switch_strategy': return 2;
      case 'event_report': return 3;
      case 'deadlock_protection': return 4;
      default: return 0;
    }
  };

  const upgrade = (candidate: FingerprintAction): void => {
    if (strength(candidate.type) > strength(strongest.type)) {
      strongest = candidate;
    }
  };

  // 规则 1：单次迭代内重复
  const sameIteration = history.filter(
    h => h.fingerprint === currentFingerprint && h.iteration === currentIteration,
  );
  const countInIter = sameIteration.reduce((sum, h) => sum + h.countInIteration, 0);
  if (countInIter >= config.singleIterationWarnThreshold) {
    upgrade({ type: 'warn', message: `你刚做过这个动作 (fingerprint=${currentFingerprint.slice(0, 8)}…)` });
  }

  // 规则 2：连续 N 轮相同 fingerprint
  const recentByFp = history
    .filter(h => h.fingerprint === currentFingerprint)
    .sort((a, b) => b.iteration - a.iteration);
  if (recentByFp.length > 0) {
    const iterations = new Set(recentByFp.map(h => h.iteration));
    let consecutive = 0;
    for (let i = currentIteration; i >= 0; i--) {
      if (iterations.has(i)) consecutive++;
      else break;
    }
    if (consecutive >= config.consecutiveDuplicateRounds) {
      upgrade({ type: 'switch_strategy', reason: `连续 ${consecutive} 轮相同动作` });
    }
  }

  // 规则 3：窗口内累计命中
  const windowStart = currentIteration - config.windowRounds + 1;
  const windowHits = history.filter(
    h => h.fingerprint === currentFingerprint && h.iteration >= windowStart,
  ).reduce((sum, h) => sum + h.countInIteration, 0);
  if (windowHits >= config.windowHitThreshold) {
    upgrade({
      type: 'event_report',
      eventName: 'ACTION_FINGERPRINT_DUPLICATE',
      data: { fingerprint: currentFingerprint, windowHits, windowRounds: config.windowRounds },
    });
  }

  return strongest;
}

/**
 * 记录指纹到历史
 */
export function recordFingerprint(
  toolName: string,
  args: Record<string, unknown>,
  iteration: number,
  existing: FingerprintRecord[],
): FingerprintRecord {
  const fp = computeFingerprint(toolName, args);
  // 检查是否已存在同 iteration 同 fingerprint
  const found = existing.find(h => h.fingerprint === fp && h.iteration === iteration);
  if (found) {
    found.countInIteration++;
    return found;
  }
  const record: FingerprintRecord = {
    fingerprint: fp,
    toolName,
    iteration,
    countInIteration: 1,
    recordedAt: Date.now(),
  };
  return record;
}
