/**
 * @module Recruitment/terminationRationale
 * @description
 * 终止理由记录——Docs/03 §7.6。
 * 开除 Agent 前必须写 TerminationRationale，否则审计局会回滚开除决定。
 */

import type { TerminationRationale, TerminationReason } from '../Decision/types.js';
import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';

// ── 内部存储 ────────────────────────────────────────────────────────

const rationales: Map<string, TerminationRationale> = new Map(); // agentId → rationale

// ── 创建终止理由 ────────────────────────────────────────────────────

/**
 * 记录开除决定。
 * 开除前 Director 必须提供证据，否则审计局会回滚。
 */
export function recordTermination(params: {
  agentId: string;
  taskId: string;
  traceId: string;
  reason: TerminationReason;
  evidence: string[];
  consecutiveFailures: number;
  lastFingerprint?: string;
  decidedBy: string;
}): Result<TerminationRationale> {
  if (!params.agentId) return err('agentId 不能为空');
  if (!params.taskId) return err('taskId 不能为空');
  if (params.evidence.length === 0) return err('必须提供至少一条证据');
  if (!params.decidedBy) return err('必须指定决定者（Director）');

  // 验证 reason 合法性
  const validReasons: TerminationReason[] = ['capability', 'laziness', 'goal_unreasonable', 'external_error'];
  if (!validReasons.includes(params.reason)) {
    return err(`无效的终止原因: ${params.reason}`);
  }

  // external_error 不计入 Worker 失败（Docs/03 §7.6 表格）
  if (params.reason === 'external_error' && params.consecutiveFailures > 0) {
    return err('外部异常不应计入 Worker 失败次数');
  }

  const rationale: TerminationRationale = {
    agentId: params.agentId,
    taskId: params.taskId,
    traceId: params.traceId,
    reason: params.reason,
    evidence: [...params.evidence],
    consecutiveFailures: params.consecutiveFailures,
    lastFingerprint: params.lastFingerprint,
    decidedBy: params.decidedBy,
    decidedAt: Date.now(),
  };

  rationales.set(params.agentId, rationale);
  return ok(rationale);
}

// ── 查询 ────────────────────────────────────────────────────────────

export function getTerminationRationale(agentId: string): TerminationRationale | undefined {
  const r = rationales.get(agentId);
  return r ? { ...r } : undefined;
}

export function getAllTerminations(): TerminationRationale[] {
  return [...rationales.values()].map(r => ({ ...r }));
}

export function hasTerminationRecord(agentId: string): boolean {
  return rationales.has(agentId);
}

// ── 验证开除合法性 ──────────────────────────────────────────────────

/**
 * 审计局调用：验证开除是否有合法理由。
 * 无记录 → 开除非法，应回滚。
 */
export function validateTermination(agentId: string): Result<boolean> {
  const rationale = rationales.get(agentId);
  if (!rationale) {
    return err(`Agent ${agentId} 无终止记录，开除非法`);
  }
  if (rationale.evidence.length === 0) {
    return err(`Agent ${agentId} 终止记录无证据，开除非法`);
  }
  return ok(true);
}

// ── 清理（测试用）──────────────────────────────────────────────────

export function resetTerminations(): void {
  rationales.clear();
}
