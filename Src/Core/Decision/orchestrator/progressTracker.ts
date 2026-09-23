/**
 * @module Decision/Orchestrator/progressTracker
 * @description
 * 进度追踪器——Docs/03 §6。
 * 监控各 Agent 的执行状态，检测超时/停滞/循环/连续失败。
 */

import type { AgentProgress, TaskAssignment } from '../types.js';
import { EventType } from '../../../Services/EventBus/eventTypes.js';
import { subscribe, type Subscription } from '../../../Services/EventBus/eventBus.js';

// ── 内部状态 ────────────────────────────────────────────────────────

const progressMap: Map<string, AgentProgress> = new Map(); // assignmentId → progress
const subscriptions: Subscription[] = [];
let initialized = false;

// ── 异常检测阈值 ────────────────────────────────────────────────────

export const TRACKER_THRESHOLDS = {
  stagnationTimeoutMs: 5 * 60 * 1000,   // 5 分钟无进展 → 停滞
  loopSimilarityThreshold: 0.85,         // 连续 3 次输出相似度 > 此值 → 循环
  loopConsecutiveCount: 3,               // 连续循环次数
  consecutiveFailureLimit: 3,            // 连续失败上限 → 开除
};

// ── 初始化 ──────────────────────────────────────────────────────────

export function initProgressTracker(): void {
  if (initialized) return;

  // 订阅任务事件
  subscriptions.push(
    subscribe(EventType.TASK_STARTED, (event) => {
      const assignmentId = event.payload.assignmentId as string;
      const agentId = event.payload.agentId as string;
      if (assignmentId && agentId) {
        updateProgress(assignmentId, agentId, { status: 'in_progress' });
      }
    }),
    subscribe(EventType.TASK_PROGRESS, (event) => {
      const assignmentId = event.payload.assignmentId as string;
      if (assignmentId) {
        const progress = progressMap.get(assignmentId);
        if (progress) {
          progress.currentIteration++;
          progress.lastProgressAt = Date.now();
          progress.tokensUsed += (event.payload.tokensUsed as number) ?? 0;
        }
      }
    }),
    subscribe(EventType.TASK_COMPLETED, (event) => {
      const assignmentId = event.payload.assignmentId as string;
      if (assignmentId) {
        updateProgress(assignmentId, null, { status: 'completed' });
      }
    }),
    subscribe(EventType.TASK_FAILED, (event) => {
      const assignmentId = event.payload.assignmentId as string;
      if (assignmentId) {
        const progress = progressMap.get(assignmentId);
        if (progress) {
          progress.failures++;
          progress.lastProgressAt = Date.now();
        }
      }
    }),
  );

  initialized = true;
}

// ── 进度管理 ────────────────────────────────────────────────────────

export function registerAssignment(assignment: TaskAssignment): void {
  const progress: AgentProgress = {
    assignmentId: assignment.assignmentId,
    agentId: assignment.assignedAgentId ?? '',
    status: 'pending',
    currentIteration: 0,
    tokensUsed: 0,
    lastProgressAt: Date.now(),
    failures: 0,
  };
  progressMap.set(assignment.assignmentId, progress);
}

export function updateProgress(
  assignmentId: string,
  agentId: string | null,
  updates: Partial<AgentProgress>,
): void {
  const progress = progressMap.get(assignmentId);
  if (progress) {
    Object.assign(progress, updates, {
      lastProgressAt: Date.now(),
    });
    if (agentId) progress.agentId = agentId;
  }
}

export function getProgress(assignmentId: string): AgentProgress | undefined {
  const p = progressMap.get(assignmentId);
  return p ? { ...p } : undefined;
}

export function getAllProgress(): AgentProgress[] {
  return [...progressMap.values()].map(p => ({ ...p }));
}

// ── 异常检测（Docs/03 §6.2）────────────────────────────────────────

export interface AnomalyReport {
  assignmentId: string;
  agentId: string;
  anomalyType: 'timeout' | 'stagnation' | 'loop' | 'consecutive_failures' | 'token_exhausted';
  severity: 'warning' | 'critical';
  detail: string;
}

/**
 * 检测超时 Agent。
 */
export function checkTimeouts(timeLimitMs: number): AnomalyReport[] {
  const now = Date.now();
  const anomalies: AnomalyReport[] = [];

  for (const p of progressMap.values()) {
    if (p.status !== 'in_progress') continue;
    // 简化：用 lastProgressAt 和注册时间差估算
    if (now - p.lastProgressAt > timeLimitMs) {
      anomalies.push({
        assignmentId: p.assignmentId,
        agentId: p.agentId,
        anomalyType: 'timeout',
        severity: 'critical',
        detail: `超过时间限制 ${timeLimitMs}ms`,
      });
    }
  }
  return anomalies;
}

/**
 * 检测停滞 Agent（长时间无进展）。
 */
export function checkStagnation(): AnomalyReport[] {
  const now = Date.now();
  const anomalies: AnomalyReport[] = [];

  for (const p of progressMap.values()) {
    if (p.status !== 'in_progress') continue;
    if (now - p.lastProgressAt > TRACKER_THRESHOLDS.stagnationTimeoutMs) {
      anomalies.push({
        assignmentId: p.assignmentId,
        agentId: p.agentId,
        anomalyType: 'stagnation',
        severity: 'warning',
        detail: `超过 ${TRACKER_THRESHOLDS.stagnationTimeoutMs}ms 无进展`,
      });
    }
  }
  return anomalies;
}

/**
 * 检测连续失败。
 */
export function checkConsecutiveFailures(): AnomalyReport[] {
  const anomalies: AnomalyReport[] = [];

  for (const p of progressMap.values()) {
    if (p.failures >= TRACKER_THRESHOLDS.consecutiveFailureLimit) {
      anomalies.push({
        assignmentId: p.assignmentId,
        agentId: p.agentId,
        anomalyType: 'consecutive_failures',
        severity: 'critical',
        detail: `连续失败 ${p.failures} 次，达到上限 ${TRACKER_THRESHOLDS.consecutiveFailureLimit}`,
      });
    }
  }
  return anomalies;
}

/**
 * 综合异常检测。
 */
export function detectAllAnomalies(timeLimitMs?: number): AnomalyReport[] {
  const anomalies: AnomalyReport[] = [];
  if (timeLimitMs) anomalies.push(...checkTimeouts(timeLimitMs));
  anomalies.push(...checkStagnation());
  anomalies.push(...checkConsecutiveFailures());
  return anomalies;
}

// ── 清理（测试用）──────────────────────────────────────────────────

export function resetProgressTracker(): void {
  progressMap.clear();
  for (const sub of subscriptions) sub.unsubscribe();
  subscriptions.length = 0;
  initialized = false;
}
