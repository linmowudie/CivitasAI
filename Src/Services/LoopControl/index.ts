/**
 * @module LoopControl/index
 * @description
 * Loop 控制系统统一导出——Docs/12。
 * L1.5 → L2 分水岭。
 */

// ── 类型 ────────────────────────────────────────────────────────────
export type {
  FailureCategory, NextAction, RiskLevel, LoopPhase,
  StoppedReason, ApprovalKind, DecisionPolicy, ApprovalStatus,
  VerifierLevel, DefectCategory, EvidenceKind, UserRole,
} from './types.js';

// ── LoopState ───────────────────────────────────────────────────────
export {
  createInitialLoopState, setGoalImmutable, verifyGoalIntegrity,
  hashGoal, cloneImmutableZone,
} from './loopState.js';
export type {
  LoopState, VerifierSpec, VerifierResult, FailedAttempt,
  FingerprintRecord, PendingApproval, ApprovalDecider,
  SuspensionRecord, CreateLoopStateInput,
} from './loopState.js';

// ── StopRules ───────────────────────────────────────────────────────
export {
  evaluateStopRules, detectBudgetPhase, buildStopRuleSet, getEvaluationOrder,
} from './stopRules.js';
export type {
  StopRuleSet, StopLimits, StopBudget, StopNoProgress,
  RiskTrigger, StopDecision, LoopRuntimeSnapshot, BudgetPhase,
} from './stopRules.js';

// ── Verifier ────────────────────────────────────────────────────────
export {
  runVerifierPipeline,
  runHardVerification, runRuleVerification, runLlmJudge, runHumanGate,
  validateAntiGaming, checkAntiGaming,
} from './verifier/index.js';
export type {
  VerifierContext, HardVerifyContext, RuleVerifyContext,
  LlmJudgeContext, HumanGateContext,
  VerifierSpecWithAntiGaming, AntiGamingConfig,
} from './verifier/index.js';

// ── ActionFingerprint ───────────────────────────────────────────────
export {
  computeFingerprint, canonicalJson, detectFingerprintAction, recordFingerprint,
} from './actionFingerprint.js';
export type { FingerprintConfig, FingerprintAction } from './actionFingerprint.js';

// ── StrategyLedger ──────────────────────────────────────────────────
export {
  validateTurnStrategy, recordStrategy, backfillStrategyResult,
  getStrategies, getFailedStrategies, selectNextStrategy, clearLedger,
} from './strategyLedger.js';
export type { TurnStrategy } from './strategyLedger.js';

// ── FailureFeedback ─────────────────────────────────────────────────
export {
  buildFailureFeedback, feedbackToToolResult,
} from './failureFeedback.js';
export type { FailureFeedback, FailureFeedbackConfig, BuildFeedbackInput } from './failureFeedback.js';

// ── ApprovalGate ────────────────────────────────────────────────────
export {
  createApproval, registerApproval, decideApproval,
  checkTimeoutApprovals, getApproval, getApprovalsByLoop,
  getPendingApprovals, clearApprovalQueue,
} from './approvalGate.js';
export type { CreateApprovalInput, DecideInput } from './approvalGate.js';

// ── Middleware ───────────────────────────────────────────────────────
export {
  createGoalReanchorControlMiddleware,
  createFingerprintDetectorControlMiddleware,
  createBudgetSentinelControlMiddleware,
  createStopRuleEvaluatorMiddleware,
  createCheckpointWriterMiddleware,
  createToolSafetyGateMiddleware,
  getCheckpoints, getLatestCheckpoint, clearCheckpointStore,
} from './middleware/index.js';
export type {
  GoalReanchorControlConfig, BudgetEventCallbacks,
  StopRuleCallbacks, CheckpointRecord, CheckpointCallbacks,
  ToolSafetyGateConfig,
} from './middleware/index.js';
