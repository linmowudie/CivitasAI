/**
 * @module LoopControl/loopState
 * @description
 * LoopState——Docs/12 §4.2。
 * 不可变区（goal / immutableConstraints）与可变区分离。
 * 核心红线：任何压缩/摘要机制不得修改 goal 与 immutableConstraints（ADR-0005）。
 *
 * 持久化真源唯一为 SQLite（loops.goal_json / loops.state_json）。
 */

import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';
import type {
  LoopPhase, FailureCategory, VerifierLevel, DefectCategory,
  RiskLevel, ApprovalKind, DecisionPolicy, ApprovalStatus,
  NextAction, EvidenceKind, UserRole,
} from './types.js';

// ── VerifierSpec（Docs/12 §3.2）────────────────────────────────────

export type VerifierSpec =
  | { level: 'L1'; kind: 'test'; payload: { command: string; expectExit: 0 } }
  | { level: 'L1'; kind: 'schema'; payload: { jsonSchema: object } }
  | { level: 'L1'; kind: 'numeric'; payload: { metric: string; op: '<=' | '>=' | '=='; threshold: number } }
  | { level: 'L1'; kind: 'http'; payload: { url: string; expectStatus: number } }
  | { level: 'L1'; kind: 'file_exists'; payload: { pathGlob: string; minSize?: number } }
  | { level: 'L2'; kind: 'rule'; payload: { expression: string } }
  | { level: 'L2'; kind: 'golden'; payload: { referenceArtifactId: string; tolerance: number } }
  | { level: 'L3'; kind: 'llm_judge'; payload: {
      model: string; rubric: unknown[]; minScore: number; requireEvidence: true;
    } }
  | { level: 'L4'; kind: 'human_gate'; payload: {
      reason: string; reviewerRoles: UserRole[]; timeoutSec: number;
    } };

// ── VerifierResult（Docs/12 §3.2）──────────────────────────────────

export interface VerifierResult {
  pass: boolean;
  level: VerifierLevel;
  kind: string;
  evidence: Array<{ kind: string; data: unknown }>;
  defectCategory?: DefectCategory;
  costTokens: number;
  durationMs: number;
}

// ── FailedAttempt（Docs/12 §4.2）───────────────────────────────────

export interface FailedAttempt {
  attemptId: string;
  iteration: number;
  strategy: string;
  failureCategory: FailureCategory;
  evidence: unknown;
  costTokens: number;
}

// ── FingerprintRecord（Docs/12 §4.2）───────────────────────────────

export interface FingerprintRecord {
  fingerprint: string;
  toolName: string;
  iteration: number;
  countInIteration: number;
  recordedAt: number;
}

// ── PendingApproval（Docs/12 §6.2）─────────────────────────────────

export interface ApprovalDecider {
  role: UserRole;
  weight: number;
}

export interface PendingApproval {
  approvalId: string;
  loopId: string;
  iteration: number;
  requestedAt: number;
  requestedBy: string;
  kind: ApprovalKind;
  payload: unknown;
  riskLevel: RiskLevel;
  timeoutSec: number;
  defaultOnTimeout: 'reject' | 'abort_loop';
  deciders: ApprovalDecider[];
  decisionPolicy: DecisionPolicy;
  status: ApprovalStatus;
  decidedBy?: string[];
  decidedAt?: number;
  decisionReason?: string;
}

// ── SuspensionRecord（Docs/05 定义 · Docs/12 §4.2 引用）────────────

export interface SuspensionRecord {
  reason: string;
  suspendedAt: number;
  suspendedBy: string;
  conflictId?: string;
}

// ── LoopState（Docs/12 §4.2）───────────────────────────────────────

export interface LoopState {
  schemaVersion: 1;
  loopId: string;
  traceId: string;
  parentAgentId?: string;

  // ─── 不可变区（禁止任何自动机制修改 · ADR-0005）───
  goal: {
    originalRequirement: string;
    successCriteria: VerifierSpec[];
    immutableConstraints: string[];
  };
  createdAt: number;

  // ─── 可变区 ───
  phase: LoopPhase;
  iteration: number;
  completedSteps: Array<{ stepId: string; artifact?: string; verifiedAt: number }>;
  failedAttempts: FailedAttempt[];
  actionFingerprints: FingerprintRecord[];
  latestVerification?: VerifierResult;
  artifactPaths: string[];
  budgetUsed: { tokens: number; usd: number };
  lastCheckpointId: string;

  // ─── 挂起区 ───
  pendingApprovals: PendingApproval[];
  suspension?: SuspensionRecord;
}

// ── 不可变区保护 ────────────────────────────────────────────────────

/** 深拷贝不可变区 */
export function cloneImmutableZone(state: LoopState): LoopState['goal'] {
  return JSON.parse(JSON.stringify(state.goal)) as LoopState['goal'];
}

/**
 * 安全设置不可变区——仅允许初始化时调用一次。
 * 后续任何修改尝试均被拒绝（ADR-0005）。
 */
export function setGoalImmutable(
  state: LoopState,
  goal: LoopState['goal'],
): Result<LoopState> {
  if (state.goal.originalRequirement !== '') {
    return err('LoopState.goal 已初始化，禁止二次修改（ADR-0005）');
  }
  return ok({ ...state, goal: JSON.parse(JSON.stringify(goal)) });
}

/**
 * 验证不可变区 hash 未变——压缩/摘要后调用。
 * 返回 true 表示 goal 未被篡改。
 */
export function verifyGoalIntegrity(
  state: LoopState,
  originalHash: string,
): boolean {
  const hash = hashGoal(state.goal);
  return hash === originalHash;
}

/** 计算 goal 的简单 hash（用于完整性校验） */
export function hashGoal(goal: LoopState['goal']): string {
  const canonical = JSON.stringify({
    originalRequirement: goal.originalRequirement,
    constraints: [...goal.immutableConstraints].sort(),
  });
  // 简单 hash：DJB2
  let h = 5381;
  for (let i = 0; i < canonical.length; i++) {
    h = ((h << 5) + h + canonical.charCodeAt(i)) & 0xffffffff;
  }
  return h.toString(16);
}

// ── 创建初始 LoopState ──────────────────────────────────────────────

export interface CreateLoopStateInput {
  loopId: string;
  traceId: string;
  parentAgentId?: string;
  goal: {
    originalRequirement: string;
    successCriteria: VerifierSpec[];
    immutableConstraints: string[];
  };
}

export function createInitialLoopState(input: CreateLoopStateInput): LoopState {
  return {
    schemaVersion: 1,
    loopId: input.loopId,
    traceId: input.traceId,
    parentAgentId: input.parentAgentId,
    goal: JSON.parse(JSON.stringify(input.goal)),
    createdAt: Date.now(),
    phase: 'planning',
    iteration: 0,
    completedSteps: [],
    failedAttempts: [],
    actionFingerprints: [],
    artifactPaths: [],
    budgetUsed: { tokens: 0, usd: 0 },
    lastCheckpointId: '',
    pendingApprovals: [],
  };
}
