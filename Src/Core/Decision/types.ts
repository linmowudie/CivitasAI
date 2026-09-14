/**
 * @module Decision/types
 * @description
 * 多 Agent 编排引擎公共类型——Docs/03 + Docs/14 §S10。
 * 复杂度评估、路由决策、任务拆解、编排器共享的数据结构。
 */

import type { AgentRole } from '../AgentRuntime/types.js';

// ── 路由模式（Docs/03 §3.3 · 6 种）──────────────────────────────────

export type RoutingMode =
  | 'DIRECT'          // Director 直接执行
  | 'DELEGATION'      // 并行委派
  | 'CONSORTIUM'      // 高难攻坚
  | 'ASSEMBLY_LINE'   // 流水线
  | 'LITIGATION'      // 司法仲裁（S12）
  | 'REGULATION';     // 行政协调（S12）

// ── 复杂度评估报告（Docs/03 §3.2）───────────────────────────────────

export interface ComplexityReport {
  // 基础评估
  estimatedTokens: number;           // 预估总 Token 消耗
  requiredDomains: string[];         // 所需专业域（如 ["backend", "frontend"]）
  couplingScore: number;             // 任务耦合度（0.0-1.0，越低越适合并行）

  // 结构分析
  subtaskCount: number;              // 建议子任务数
  hasSopMatch: boolean;              // 是否匹配 SOP 模板
  matchedSopId?: string;             // 匹配的 SOP ID

  // 风险评估
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  potentialConflicts: string[];      // 潜在冲突点

  // 元数据
  assessedAt: number;                // epoch ms
  assessorModel: string;             // 评估模型
  confidenceScore: number;           // 置信度（0.0-1.0）
}

// ── 路由规则配置（Docs/03 §3.3 · routingRules.json）─────────────────

export interface RoutingRulesConfig {
  consortiumTokenThreshold: number;    // 默认 50000
  consortiumDomainThreshold: number;   // 默认 2
  delegationMaxCouplingScore: number;  // 默认 0.3
  delegationMinSubtaskCount: number;   // 默认 2
  assemblyLineSopRequired: boolean;    // 默认 true
  directExecMaxTokens: number;         // 默认 10000
}

// ── 路由决策结果 ────────────────────────────────────────────────────

export interface RouteDecisionResult {
  mode: RoutingMode;
  params: Record<string, unknown>;
  decidedAt: number;
  reason: string;
}

// ── 任务分配书（Docs/03 §4.2）───────────────────────────────────────

export interface TaskAssignment {
  assignmentId: string;
  taskId: string;
  traceId: string;
  parentAgentId: string;
  subtaskIndex: number;

  // 任务定义
  description: string;
  inputContext: Record<string, unknown>;
  outputSchema: Record<string, unknown>;

  // 约束
  maxIterations: number;
  timeLimitMs: number;
  tokenBudget: number;

  // 依赖
  dependsOn: string[];               // 依赖的 assignmentId 列表
  requiredTools: string[];           // 允许使用的工具（最小权限）

  // 状态
  status: AssignmentStatus;
  assignedAgentId?: string;
}

export type AssignmentStatus =
  | 'pending'        // 待分配
  | 'assigned'       // 已分配
  | 'in_progress'    // 执行中
  | 'completed'      // 完成
  | 'failed'         // 失败
  | 'cancelled';     // 取消

// ── 任务计划（TaskDecomposer 输出）──────────────────────────────────

export interface TaskPlan {
  planId: string;
  taskId: string;
  traceId: string;
  directorAgentId: string;

  // 子任务列表
  assignments: TaskAssignment[];

  // 全局约束
  totalTokenBudget: number;
  globalTimeLimitMs: number;
  maxParallelism: number;

  // 元数据
  createdAt: number;
  status: 'draft' | 'active' | 'completed' | 'failed';
}

// ── 进度追踪（ProgressTracker）──────────────────────────────────────

export interface AgentProgress {
  assignmentId: string;
  agentId: string;
  status: AssignmentStatus;
  currentIteration: number;
  tokensUsed: number;
  lastProgressAt: number;
  failures: number;
  lastOutput?: string;
}

// ── 结果聚合（ResultAggregator）─────────────────────────────────────

export interface SubtaskResult {
  assignmentId: string;
  agentId: string;
  status: 'success' | 'failed' | 'partial';
  output: Record<string, unknown>;
  tokensUsed: number;
  qualityScore?: number;
  completedAt: number;
}

export interface AggregatedResult {
  taskId: string;
  traceId: string;
  status: 'success' | 'partial_success' | 'failed';
  subtaskResults: SubtaskResult[];
  finalOutput: Record<string, unknown>;
  totalTokensUsed: number;
  aggregatedAt: number;
}

// ── Agent 招募配置（Docs/03 §5.2）───────────────────────────────────

export interface RecruitmentRequest {
  role: AgentRole;
  domain: string;
  requiredTools: string[];
  tokenBudget: number;
  maxIterations: number;
  timeLimitMs: number;
  traceId: string;
  parentAgentId: string;
}

// ── 开除终止理由（Docs/03 §7.6）────────────────────────────────────

export interface TerminationRationale {
  agentId: string;
  taskId: string;
  traceId: string;
  reason: TerminationReason;
  evidence: string[];
  consecutiveFailures: number;
  lastFingerprint?: string;
  decidedBy: string;                 // director agent_id
  decidedAt: number;
}

export type TerminationReason =
  | 'capability'       // 能力不足（L1/L2 失败 + 不同 defectCategory）
  | 'laziness'         // 不努力（同 fingerprint 重复）
  | 'goal_unreasonable' // 目标不合理（不同策略均失败 ≥5 次）
  | 'external_error';  // 外部异常（不计入 Worker 失败）

// ── 编排器总入口返回 ────────────────────────────────────────────────

export interface OrchestrationResult {
  taskId: string;
  traceId: string;
  routingMode: RoutingMode;
  taskPlan?: TaskPlan;
  aggregatedResult?: AggregatedResult;
  startedAt: number;
  completedAt: number;
  status: 'success' | 'failed' | 'partial';
}
