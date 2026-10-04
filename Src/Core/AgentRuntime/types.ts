/**
 * @module AgentRuntime/types
 * @description
 * Agent 运行时公共类型——Docs/Agent/02 §6。
 * Agent 生命周期 6 态 + Loop 阶段 6 态 + 退出原因 7 值。
 * 枚举三处同形（agents.status / loops.phase / loops.stopped_reason）。
 */

// ── Agent 生命周期状态（Docs/Agent/02 §6 · 6 值）────────────────────────

export type AgentStatus =
  | 'creating'     // 创建中
  | 'ready'        // 就绪，等待任务
  | 'running'      // 执行中
  | 'suspended'    // 挂起（律师函）
  | 'expelled'     // 开除
  | 'destroyed';   // 已销毁

// ── Loop 阶段（Docs/Agent/02 §6 · 6 值）─────────────────────────────────

export type LoopPhase =
  | 'planning'           // 规划中
  | 'acting'             // 执行中
  | 'verifying'          // 验证中
  | 'awaiting_approval'  // 等待审批
  | 'completed'          // 完成
  | 'failed';            // 失败

// ── Loop 退出原因（Docs/Agent/02 §6 · 7 值）─────────────────────────────

export type StoppedReason =
  | 'success'        // 成功
  | 'limits'         // 达到上限
  | 'budget_soft'    // 软预算
  | 'budget_hard'    // 硬预算
  | 'no_progress'    // 无进展
  | 'risk'           // 风险退出
  | 'human_abort';   // 人工中止

// ── Agent 角色 ──────────────────────────────────────────────────────

/** v2.2：统一引用 Infra 层 UserRole（8 角色单一真相源） */
export type { UserRole } from '../../Infra/types.js';
export type AgentRole = import('../../Infra/types.js').UserRole;

// ── Agent 实例 ──────────────────────────────────────────────────────

export interface AgentInstance {
  agentId: string;
  role: AgentRole;
  status: AgentStatus;
  traceId?: string;
  currentLoopId?: string;
  walletId?: string;

  // 元数据
  model: string;
  createdAt: number;
  updatedAt: number;
  lastTaskId?: string;
  consecutiveFailures: number;
  /** 角色系统提示词（FE-052：创建时从 promptRegistry 按角色装载；落库 agents.system_prompt） */
  systemPrompt?: string;

  // 审批状态（Loop 级，非 Agent 态）
  awaitingApproval: boolean;
}

// ── Agent 创建参数 ──────────────────────────────────────────────────

export interface CreateAgentParams {
  role: AgentRole;
  model: string;
  taskId?: string;
  parentAgentId?: string;
  /** 显式系统提示词（缺省由 agentFactory 从 promptRegistry 按角色装载） */
  systemPrompt?: string;
}

// ── 任务提交结果 ────────────────────────────────────────────────────

export interface SubmitResult {
  taskId: string;
  agentId: string;
  status: 'submitted' | 'accepted' | 'rejected';
  /** 评审记录 ID（FE-050：提交时生成，贯穿提交/审核/工具返回值） */
  reviewId?: string;
  reviewerComment?: string;
  reviewedAt?: number;
}

// ── 状态转换事件 ────────────────────────────────────────────────────

export type AgentEvent =
  | { type: 'INIT_COMPLETE' }
  | { type: 'TASK_ASSIGNED'; taskId: string }
  | { type: 'TASK_COMPLETED' }
  | { type: 'TASK_FAILED'; reason: string }
  | { type: 'SUSPEND'; reason: string }
  | { type: 'RESTORE' }
  | { type: 'EXPEL'; reason: string }
  | { type: 'DESTROY' }
  | { type: 'RECRUIT'; newAgentId: string };
