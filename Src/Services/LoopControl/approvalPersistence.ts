/**
 * @module LoopControl/approvalPersistence
 * @description
 * 审批队列的 SQLite 落库（write-through）——FE-004。
 *
 * 背景：审批队列此前仅存进程内 Map —— 后端重启即丢失，且"已决"记录无法回溯。
 * 本模块把审批生命周期（创建 / 决策 / 超时）写穿到主库 `pending_approvals`：
 *
 * - 功能真源仍是内存队列（工具安全门的阻塞等待依赖它），落库是附加值：
 *   重启后历史可回放（FE-005 的「已决」栏）、审计可追溯；
 * - fail-safe：库未初始化 / 写入失败只告警，不中断审批流程与工具执行
 *   （与 longTermMemoryStore 的持久化策略一致）；
 * - 重启后残留的 PENDING 记录在启动期一律标为 TIMEOUT（默认拒绝，禁止默认通过）。
 */

import { isDatabaseInitialized, getMainDb } from '../../Infra/Db/database.js';
import { logger } from '../../Infra/Logging/logger.js';

import type { ApprovalDecider, PendingApproval } from './loopState.js';
import type { ApprovalKind, ApprovalStatus, DecisionPolicy, RiskLevel } from './types.js';

// ── 行映射 ──────────────────────────────────────────────────────────

interface ApprovalRow {
  approval_id: string;
  loop_id: string;
  trace_id: string;
  iteration: number;
  requested_by: string;
  kind: string;
  payload_json: string;
  risk_level: string;
  requested_at: number;
  timeout_sec: number;
  status: string;
  deciders_json: string;
  decision_policy: string;
  decided_by_json: string | null;
  decided_at: number | null;
  decision_reason: string | null;
  default_on_timeout: string;
  owner_user_id: string | null;
  tool_call_id: string | null;
  tool_name: string | null;
  session_id: string | null;
  auto_approved: number;
}

function rowToApproval(row: ApprovalRow): PendingApproval {
  let payload: unknown = null;
  try { payload = JSON.parse(row.payload_json); } catch { /* 保留 null */ }

  let deciders: ApprovalDecider[] = [];
  try { deciders = JSON.parse(row.deciders_json) as ApprovalDecider[]; } catch { /* 保留空 */ }

  let decidedBy: string[] | undefined;
  if (row.decided_by_json) {
    try { decidedBy = JSON.parse(row.decided_by_json) as string[]; } catch { /* 保留 undefined */ }
  }

  return {
    approvalId: row.approval_id,
    loopId: row.loop_id,
    iteration: row.iteration,
    requestedAt: row.requested_at,
    requestedBy: row.requested_by,
    kind: row.kind as ApprovalKind,
    payload,
    riskLevel: row.risk_level as RiskLevel,
    timeoutSec: row.timeout_sec,
    defaultOnTimeout: row.default_on_timeout === 'abort_loop' ? 'abort_loop' : 'reject',
    deciders,
    decisionPolicy: row.decision_policy as DecisionPolicy,
    status: row.status as ApprovalStatus,
    decidedBy,
    decidedAt: row.decided_at ?? undefined,
    decisionReason: row.decision_reason ?? undefined,
    toolCallId: row.tool_call_id ?? undefined,
    toolName: row.tool_name ?? undefined,
    sessionId: row.session_id ?? undefined,
    owner: row.owner_user_id ?? 'local',
    autoApproved: row.auto_approved === 1 ? true : undefined,
  };
}

// ── 写入（fail-safe）─────────────────────────────────────────────────

/** 创建审批 → INSERT（幂等：同 approvalId 覆盖） */
export function persistApprovalCreated(approval: PendingApproval): void {
  if (!isDatabaseInitialized()) return;
  try {
    getMainDb().prepare(`
      INSERT OR REPLACE INTO pending_approvals (
        approval_id, loop_id, trace_id, iteration, requested_by, kind,
        payload_json, risk_level, requested_at, timeout_sec, expires_at,
        status, deciders_json, decision_policy, decided_by_json, decided_at,
        decision_reason, default_on_timeout, owner_user_id,
        tool_call_id, tool_name, session_id, auto_approved
      ) VALUES (
        @approval_id, @loop_id, @trace_id, @iteration, @requested_by, @kind,
        @payload_json, @risk_level, @requested_at, @timeout_sec, @expires_at,
        @status, @deciders_json, @decision_policy, @decided_by_json, @decided_at,
        @decision_reason, @default_on_timeout, @owner_user_id,
        @tool_call_id, @tool_name, @session_id, @auto_approved
      )
    `).run({
      approval_id: approval.approvalId,
      loop_id: approval.loopId,
      trace_id: approval.traceId ?? '',
      iteration: approval.iteration,
      requested_by: approval.requestedBy,
      kind: approval.kind,
      payload_json: JSON.stringify(approval.payload ?? null),
      risk_level: approval.riskLevel,
      requested_at: approval.requestedAt,
      timeout_sec: approval.timeoutSec,
      expires_at: approval.requestedAt + approval.timeoutSec * 1000,
      status: approval.status,
      deciders_json: JSON.stringify(approval.deciders),
      decision_policy: approval.decisionPolicy,
      decided_by_json: approval.decidedBy ? JSON.stringify(approval.decidedBy) : null,
      decided_at: approval.decidedAt ?? null,
      decision_reason: approval.decisionReason ?? null,
      default_on_timeout: approval.defaultOnTimeout,
      owner_user_id: approval.owner ?? 'local',
      tool_call_id: approval.toolCallId ?? null,
      tool_name: approval.toolName ?? null,
      session_id: approval.sessionId ?? null,
      auto_approved: approval.autoApproved ? 1 : 0,
    });
  } catch (e) {
    logger.warn('审批落库失败（创建）——不影响内存队列', {
      source: 'approvalPersistence',
      approvalId: approval.approvalId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/** 状态落定 → UPDATE（决策 / 超时 / 自动审批） */
export function persistApprovalUpdated(approval: PendingApproval): void {
  if (!isDatabaseInitialized()) return;
  try {
    getMainDb().prepare(`
      UPDATE pending_approvals SET
        status = @status,
        decided_by_json = @decided_by_json,
        decided_at = @decided_at,
        decision_reason = @decision_reason,
        auto_approved = @auto_approved
      WHERE approval_id = @approval_id
    `).run({
      approval_id: approval.approvalId,
      status: approval.status,
      decided_by_json: approval.decidedBy ? JSON.stringify(approval.decidedBy) : null,
      decided_at: approval.decidedAt ?? null,
      decision_reason: approval.decisionReason ?? null,
      auto_approved: approval.autoApproved ? 1 : 0,
    });
  } catch (e) {
    logger.warn('审批落库失败（更新）——不影响内存队列', {
      source: 'approvalPersistence',
      approvalId: approval.approvalId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

// ── 启动期清理 ────────────────────────────────────────────────────

/**
 * 启动期把残留 PENDING 标为 TIMEOUT。
 *
 * 语义依据：审批超时默认拒绝（禁止默认通过）。进程重启后原阻塞的工具执行
 * 已随进程消失，这些审批不可能再被放行——留在库里会形成"看起来可点"的僵尸条目，
 * 故一律以"服务重启，默认拒绝"落定，保留在历史（FE-005「已决」栏）中供回溯。
 */
export function expireStaleApprovals(reason = '服务重启，默认拒绝'): number {
  if (!isDatabaseInitialized()) return 0;
  try {
    const result = getMainDb().prepare(`
      UPDATE pending_approvals
      SET status = 'TIMEOUT', decided_at = @now, decision_reason = @reason
      WHERE status = 'PENDING'
    `).run({ now: Date.now(), reason });
    if (result.changes > 0) {
      logger.warn('重启清理：残留待审批已标记为超时拒绝', {
        source: 'approvalPersistence',
        count: result.changes,
      });
    }
    return result.changes;
  } catch (e) {
    logger.warn('重启清理审批失败（忽略）', {
      source: 'approvalPersistence',
      error: e instanceof Error ? e.message : String(e),
    });
    return 0;
  }
}

// ── 读取 ────────────────────────────────────────────────────────────

/** 读取某属主最近的审批历史（含已决），按请求时间倒序 */
export function listPersistedApprovals(owner: string, limit = 100): PendingApproval[] {
  if (!isDatabaseInitialized()) return [];
  try {
    const rows = getMainDb().prepare(`
      SELECT * FROM pending_approvals
      WHERE owner_user_id = ?
      ORDER BY requested_at DESC
      LIMIT ?
    `).all(owner, limit) as ApprovalRow[];
    return rows.map(rowToApproval);
  } catch (e) {
    logger.warn('审批历史读取失败（返回空）', {
      source: 'approvalPersistence',
      error: e instanceof Error ? e.message : String(e),
    });
    return [];
  }
}
