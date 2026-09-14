/**
 * @module AgentRuntime/index
 * @description
 * Agent 运行时统一导出——Docs/02 §6 / Docs/14 §S9。
 */

// ── 类型 ────────────────────────────────────────────────────────────
export type {
  AgentStatus, LoopPhase, StoppedReason, AgentRole,
  AgentInstance, CreateAgentParams, SubmitResult, AgentEvent,
} from './types.js';

// ── StateMachine ────────────────────────────────────────────────────
export {
  transition, canTransition, getAvailableEvents, getNextStates,
} from './stateMachine.js';

// ── AgentRegistry ───────────────────────────────────────────────────
export {
  registerAgent, getAgent, getAllAgents, getAgentsByStatus,
  getAgentsByRole, getReadyWorkers, updateAgentStatus, updateAgent,
  unregisterAgent, getAgentCount, getStatusSummary, resetAgentRegistry,
} from './agentRegistry.js';

// ── AgentFactory ────────────────────────────────────────────────────
export {
  createAgent, createAgentBatch, resetAgentFactory,
} from './agentFactory.js';

// ── AgentRuntime ────────────────────────────────────────────────────
export {
  submitForReview, reviewSubmission, isTaskApproved,
  getPendingReview, getPendingReviewCount,
  handleAgentEvent, assignTask, resetAgentRuntime,
} from './agentRuntime.js';
