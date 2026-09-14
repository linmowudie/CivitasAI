/**
 * @module Arbitration/types
 * @description
 * 仲裁系统公共类型——Docs/05。
 * 仲裁案件、上下文胶囊、裁决结果、恢复计划。
 */

// ── 仲裁案件状态 ────────────────────────────────────────────────────

export type CaseStatus =
  | 'filed'            // 已立案
  | 'assembling'       // 胶囊组装中
  | 'reasoning'        // 裁决推理中
  | 'verdict_ready'    // 裁决已出
  | 'suspended'        // 涉事 Agent 已挂起
  | 'restoring'        // 现场恢复中
  | 'completed'        // 完成
  | 'deadlocked'       // 死锁（升级监管局）
  | 'timeout';         // 超时

// ── 裁决类型 ────────────────────────────────────────────────────────

export type VerdictType =
  | 'new_wins'         // 新记忆胜
  | 'old_wins'         // 旧记忆胜
  | 'both_invalid'     // 双方均无效
  | 'need_more_evidence'; // 需更多证据

// ── 冲突类型 ────────────────────────────────────────────────────────

export type ConflictType =
  | 'semantic_opposition'  // 语义相反
  | 'contradiction'        // 逻辑矛盾
  | 'duplication';         // 重复

// ── 上下文胶囊（Docs/05 §3.2）──────────────────────────────────────

export interface ContextCapsule {
  capsuleId: string;
  conflictId: string;
  evidence: {
    newMemory: { content: string; metadata: Record<string, unknown>; agentId: string };
    oldMemory: { content: string; metadata: Record<string, unknown>; agentId: string };
  };
  taskContext: {
    parentTaskDescription: string;
    constraints: string[];
  };
  agentHistory: {
    plaintiffOps: OperationRecord[];
    defendantOps: OperationRecord[];
  };
  tokenBudget: number;
  createdAt: number;
}

// ── 操作记录 ────────────────────────────────────────────────────────

export interface OperationRecord {
  operationId: string;
  agentId: string;
  action: string;
  timestamp: number;
  traceId?: string;
}

// ── 单个仲裁者裁决 ────────────────────────────────────────────────

export interface ArbitratorVerdict {
  arbitratorId: string;
  verdict: VerdictType;
  winnerId: string | null;
  loserId: string | null;
  reasoning: string;
  confidence: number;
  penalty?: {
    type: 'token_deduction' | 'warning' | 'none';
    amount?: number;
  };
  deliveredAt: number;
}

// ── 最终裁决（多数决汇总）──────────────────────────────────────────

export interface FinalVerdict {
  caseId: string;
  conflictId: string;
  verdict: VerdictType;
  winnerId: string | null;
  loserId: string | null;
  majorityReasoning: string;
  individualVerdicts: ArbitratorVerdict[];
  isUnanimous: boolean;
  isDeadlocked: boolean;
  issuedAt: number;
}

// ── 仲裁案件 ────────────────────────────────────────────────────────

export interface ArbitrationCase {
  caseId: string;
  conflictId: string;
  traceId: string;
  status: CaseStatus;
  conflictType: ConflictType;

  // 涉事方
  plaintiffAgentId: string;   // 新记忆方
  defendantAgentId: string;   // 旧记忆方

  // 胶囊
  capsule?: ContextCapsule;

  // 裁决
  finalVerdict?: FinalVerdict;

  // 时间线
  filedAt: number;
  verdictAt?: number;
  restoredAt?: number;
  completedAt?: number;

  // 挂起控制（5 分钟内同 conflictId 只挂一次）
  suspendIssued: boolean;
  lastSuspendAt?: number;
}

// ── 恢复计划 ────────────────────────────────────────────────────────

export interface RestorationPlan {
  planId: string;
  caseId: string;
  conflictId: string;
  restorerAgentId: string;
  strategy: 'self_healing' | 'global_takeover';
  compensatingActions: CompensatingAction[];
  status: 'pending' | 'executing' | 'completed' | 'failed';
  createdAt: number;
  completedAt?: number;
}

export interface CompensatingAction {
  actionId: string;
  type: 'rollback_file' | 'revert_request' | 'clear_state' | 'apply_verdict';
  target: string;
  description: string;
  executed: boolean;
}

// ── 动态扩缩配置 ────────────────────────────────────────────────────

export interface ScalerConfig {
  baseArbitratorCount: number;     // 基础仲裁者数量（默认 3）
  scalingFactor: number;           //  scaling factor k
  scalingExponent: number;         //  scaling exponent m
  cooldownMs: number;              // 冷却期
  maxArbitratorCount: number;      // 上限
}
