/**
 * @module LoopControl/approvalGate
 * @description
 * 审批门——Docs/12 §6。
 * 审批门 = 停止符的合法来源之一（ADR-0001）。
 * Phase 0：仅落 DB 队列，S12 才接 UI。
 * 超时默认拒绝（禁止默认通过）。
 */

import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';

import type { PendingApproval, ApprovalDecider } from './loopState.js';
import type { ApprovalKind, RiskLevel, DecisionPolicy } from './types.js';

// ── 创建审批请求 ────────────────────────────────────────────────────

export interface CreateApprovalInput {
  loopId: string;
  traceId: string;
  iteration: number;
  requestedBy: string;
  kind: ApprovalKind;
  payload: unknown;
  riskLevel: RiskLevel;
  timeoutSec?: number;
  defaultOnTimeout?: 'reject' | 'abort_loop';
  deciders: ApprovalDecider[];
  decisionPolicy?: DecisionPolicy;
}

/**
 * 创建审批请求
 *
 * 规则：
 * - CRITICAL 级强制 unanimous 策略
 * - 超时默认拒绝（禁止默认通过）
 * - timeoutSec 保存生效时长快照（防配置热更新突变存量审批）
 */
export function createApproval(
  input: CreateApprovalInput,
  defaultTimeoutSec: number = 60,
): Result<PendingApproval> {
  if (input.deciders.length === 0) {
    return err('审批请求至少需要一个审批人');
  }

  // CRITICAL 级强制 unanimous
  const policy: DecisionPolicy = input.riskLevel === 'CRITICAL'
    ? 'unanimous'
    : (input.decisionPolicy ?? 'majority');

  // CRITICAL 级至少需要 2 个不同角色
  if (input.riskLevel === 'CRITICAL') {
    const roles = new Set(input.deciders.map(d => d.role));
    if (roles.size < 2) {
      return err('CRITICAL 级审批至少需要 2 个不同角色的审批人');
    }
  }

  const timeoutSec = input.timeoutSec ?? defaultTimeoutSec;
  const now = Date.now();

  const approval: PendingApproval = {
    approvalId: `${now}-${Math.random().toString(16).slice(2, 6)}`,
    loopId: input.loopId,
    iteration: input.iteration,
    requestedAt: now,
    requestedBy: input.requestedBy,
    kind: input.kind,
    payload: input.payload,
    riskLevel: input.riskLevel,
    timeoutSec,
    defaultOnTimeout: input.defaultOnTimeout ?? 'reject',
    deciders: input.deciders,
    decisionPolicy: policy,
    status: 'PENDING',
  };

  return ok(approval);
}

// ── 审批判定 ────────────────────────────────────────────────────────

export interface DecideInput {
  approvalId: string;
  decidedBy: string;
  approve: boolean;
  reason?: string;
}

/**
 * 审批队列（内存存储，Phase 0）
 */
const approvalQueue: Map<string, PendingApproval> = new Map();

/**
 * 注册审批请求到队列
 */
export function registerApproval(approval: PendingApproval): void {
  approvalQueue.set(approval.approvalId, approval);
}

/**
 * 处理审批决定
 */
export function decideApproval(input: DecideInput): Result<PendingApproval> {
  const approval = approvalQueue.get(input.approvalId);
  if (!approval) return err(`审批 ${input.approvalId} 不存在`);
  if (approval.status !== 'PENDING') {
    return err(`审批 ${input.approvalId} 已决 (${approval.status})`);
  }

  // 记录决定
  if (!approval.decidedBy) approval.decidedBy = [];
  approval.decidedBy.push(input.decidedBy);
  approval.decidedAt = Date.now();
  approval.decisionReason = input.reason;

  // 根据策略判定结果
  if (approval.decisionPolicy === 'unanimous') {
    if (!input.approve) {
      approval.status = 'REJECTED';
    } else if (approval.decidedBy.length >= approval.deciders.length) {
      approval.status = 'APPROVED';
    }
  } else {
    // majority: 简单多数
    approval.status = input.approve ? 'APPROVED' : 'REJECTED';
  }

  return ok({ ...approval });
}

/**
 * 检查超时审批——扫描 PENDING 状态的审批
 */
export function checkTimeoutApprovals(now: number = Date.now()): PendingApproval[] {
  const timedOut: PendingApproval[] = [];

  for (const [, approval] of approvalQueue) {
    if (approval.status !== 'PENDING') continue;
    const expiresAt = approval.requestedAt + approval.timeoutSec * 1000;
    if (now >= expiresAt) {
      // 超时 → 默认拒绝（禁止默认通过）
      approval.status = 'TIMEOUT';
      approval.decidedAt = now;
      approval.decisionReason = `超时 (${approval.timeoutSec}s)`;
      timedOut.push(approval);
    }
  }

  return timedOut;
}

/**
 * 获取审批请求
 */
export function getApproval(approvalId: string): PendingApproval | undefined {
  return approvalQueue.get(approvalId);
}

/**
 * 获取 Loop 的所有审批请求
 */
export function getApprovalsByLoop(loopId: string): PendingApproval[] {
  return [...approvalQueue.values()].filter(a => a.loopId === loopId);
}

/**
 * 获取所有待审批
 */
export function getPendingApprovals(): PendingApproval[] {
  return [...approvalQueue.values()].filter(a => a.status === 'PENDING');
}

/**
 * 清空队列（测试用）
 */
export function clearApprovalQueue(): void {
  approvalQueue.clear();
}
