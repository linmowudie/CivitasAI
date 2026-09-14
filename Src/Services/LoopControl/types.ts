/**
 * @module LoopControl/types
 * @description
 * Loop 控制系统公共类型——Docs/12 §4.2 / §7.2。
 * FailureCategory 全集（8 成员）由本模块唯一定义，
 * FailedAttempt / FailureFeedback / failure_feedbacks.category 均引用此处。
 */

// ── FailureCategory（Docs/12 §7.2 · 8 成员，唯一定义处）──────────────

export type FailureCategory =
  | 'schema'
  | 'logic'
  | 'external'
  | 'timeout'
  | 'risk'
  | 'no_progress'
  | 'budget_soft'
  | 'budget_hard';

// ── NextAction（动作全集 · Docs/12 §7.2）────────────────────────────

/** 推荐下一步动作（5 值） */
export type NextAction =
  | 'switch_strategy'
  | 'request_approval'
  | 'abort'
  | 'escalate_human'
  | 'rollback_and_abort';

// ── RiskLevel ──────────────────────────────────────────────────────

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

// ── LoopPhase ──────────────────────────────────────────────────────

export type LoopPhase =
  | 'planning'
  | 'acting'
  | 'verifying'
  | 'awaiting_approval'
  | 'completed'
  | 'failed';

// ── StoppedReason（loops.stopped_reason 枚举 · 唯一源）─────────────

export type StoppedReason =
  | 'success'
  | 'limits'
  | 'budget_soft'
  | 'budget_hard'
  | 'no_progress'
  | 'risk'
  | 'human_abort';

// ── ApprovalKind ───────────────────────────────────────────────────

export type ApprovalKind =
  | 'tool_execute'
  | 'budget_expand'
  | 'irreversible_action'
  | 'judge_override';

// ── DecisionPolicy ─────────────────────────────────────────────────

export type DecisionPolicy = 'majority' | 'unanimous';

// ── ApprovalStatus ─────────────────────────────────────────────────

export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'TIMEOUT';

// ── VerifierLevel ──────────────────────────────────────────────────

export type VerifierLevel = 'L1' | 'L2' | 'L3' | 'L4';

// ── DefectCategory ─────────────────────────────────────────────────

export type DefectCategory =
  | 'spec_missing'
  | 'logic_error'
  | 'quality_low'
  | 'risk_violation';

// ── EvidenceKind ───────────────────────────────────────────────────

export type EvidenceKind =
  | 'test_output'
  | 'error_stack'
  | 'diff_from_expected'
  | 'tool_error'
  | 'rule_violation'
  | 'judge_rubric';

// ── UserRole（简化）─────────────────────────────────────────────────

export type UserRole = 'user' | 'prime_director' | 'regulatory_authority' | 'auditor';
