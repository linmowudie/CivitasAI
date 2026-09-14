/**
 * @module EventBus/eventTypes
 * @description
 * 事件类型注册表——Docs/07 §4.3。
 * 全系统事件名的唯一定义处，禁止自由字符串。
 * 命名格式：<域>:<小写 snake_case 动作>。
 */

// ── EventType 枚举（40+ 成员）──────────────────────────────────────

export enum EventType {
  // 任务生命周期
  TASK_RECEIVED = 'task:received',
  TASK_DECOMPOSED = 'task:decomposed',
  TASK_ASSIGNED = 'task:assigned',
  TASK_STARTED = 'task:started',
  TASK_PROGRESS = 'task:progress',
  TASK_COMPLETED = 'task:completed',
  TASK_FAILED = 'task:failed',

  // Agent 生命周期
  AGENT_RECRUITED = 'agent:recruited',
  AGENT_READY = 'agent:ready',
  AGENT_EXPELLED = 'agent:expelled',
  AGENT_DESTROYED = 'agent:destroyed',

  // Agent 流式输出与会话消息（Docs/16 F0.6，agent: 域，不新增域前缀）
  AGENT_STREAM_CHUNK = 'agent:stream_chunk',   // LLM 增量输出片；按 ui.streamFlushIntervalMs 合批
  AGENT_STREAM_END = 'agent:stream_end',       // 一轮流式结束
  AGENT_CHAT_MESSAGE = 'agent:chat_message',   // 会话消息落库完成

  // Token 经济
  TOKEN_CONSUMED = 'token:consumed',
  TOKEN_EARNED = 'token:earned',
  TOKEN_DISTRIBUTED = 'token:distributed',
  TAX_PAID = 'token:tax_paid',
  TAX_RATE_UPDATED = 'token:tax_rate_updated',
  WALLET_FROZEN = 'token:wallet_frozen',
  WALLET_UNFROZEN = 'token:wallet_unfrozen',
  TOKEN_CONFISCATED = 'token:confiscated',
  INSUFFICIENT_BALANCE = 'token:insufficient_balance',
  LEDGER_MISMATCH = 'token:ledger_mismatch',

  // 仲裁
  CONFLICT_DETECTED = 'arbitration:conflict_detected',
  ARBITRATION_FILED = 'arbitration:filed',
  SUSPEND_AND_NOTIFY = 'arbitration:suspend_and_notify',
  ARBITRATION_VERDICT = 'arbitration:verdict',
  RESTORATION_ACK = 'arbitration:restoration_ack',
  KNOWLEDGE_CONSOLIDATION = 'arbitration:knowledge_consolidation',
  ARBITRATION_DEADLOCK = 'arbitration:deadlock',
  ARBITRATOR_POOL_RESIZED = 'arbitration:pool_resized',

  // 监管
  RULE_UPDATED = 'regulation:rule_updated',
  BROADCAST_MESSAGE = 'regulation:broadcast',
  EMERGENCY_INTERVENTION = 'regulation:emergency',

  // 审计
  ANOMALY_DETECTED = 'audit:anomaly_detected',
  AUDIT_COMPLETED = 'audit:completed',
  PATROL_REPORT = 'audit:patrol_report',

  // 共享记忆
  MEMORY_WRITTEN = 'memory:written',
  MEMORY_SUPERSEDED = 'memory:superseded',
  MEMORY_VERSION_CONFLICT = 'memory:version_conflict',
  MEMORY_SELF_REINFORCING = 'memory:self_reinforcing',

  // Loop 控制
  LOOP_STARTED = 'loop:started',
  LOOP_COMPLETED = 'loop:completed',
  LOOP_ABORTED = 'loop:aborted',
  BUDGET_WARMING = 'loop:budget_warming',
  BUDGET_SOFT_REACHED = 'loop:budget_soft_reached',
  BUDGET_HARD_REACHED = 'loop:budget_hard_reached',
  NO_PROGRESS_STAGNATED = 'loop:no_progress_stagnated',
  ACTION_FINGERPRINT_DUPLICATE = 'loop:action_fingerprint_duplicate',
  APPROVAL_REQUESTED = 'loop:approval_requested',
  APPROVAL_DECIDED = 'loop:approval_decided',
  APPROVAL_TIMEOUT_REJECTED = 'loop:approval_timeout_rejected',
  VERIFIER_FAILED = 'loop:verifier_failed',
  CONTEXT_COMPRESSED = 'loop:context_compressed',

  // 持久执行
  EFFECT_UNKNOWN = 'durable:effect_unknown',
  LOOP_SUSPENDED = 'durable:loop_suspended',
  LOOP_RESUMED = 'durable:loop_resumed',
  RECOVERY_HUMAN_REQUIRED = 'durable:recovery_human_required',
  ARTIFACT_DRIFT_DETECTED = 'durable:artifact_drift_detected',

  // 系统级
  SHUTDOWN_FLUSH_TIMEOUT = 'system:shutdown_flush_timeout',
  CONFIG_RELOAD_FAILED = 'system:config_reload_failed',
}

// ── DomainEvent（Docs/07 §4.2）─────────────────────────────────────

export type EventPriority = 'low' | 'normal' | 'high' | 'critical';

export interface DomainEvent {
  eventId: string;
  eventType: EventType;
  traceId?: string;
  loopId?: string;
  timestamp: number;
  priority: EventPriority;
  payload: Record<string, unknown>;
  source: string;
}

// ── EventHandler / Subscription ─────────────────────────────────────

export type EventHandler = (event: DomainEvent) => void | Promise<void>;

export interface Subscription {
  unsubscribe(): void;
}

// ── AgentMessage（Docs/08 §2）──────────────────────────────────────

export type MessageType =
  | 'TASK_ASSIGN' | 'TASK_START' | 'TASK_PROGRESS' | 'TASK_COMPLETE'
  | 'TASK_FAILED' | 'TASK_CANCEL'
  | 'RECRUIT_REQUEST' | 'RECRUIT_ACK' | 'EXPEL_NOTICE'
  | 'CONFLICT_REPORT' | 'SUSPEND_NOTICE' | 'VERDICT_NOTICE'
  | 'RESTORATION_ORDER' | 'RESTORATION_CONFIRM'
  | 'RULE_UPDATE' | 'BROADCAST' | 'EMERGENCY_ORDER'
  | 'FREEZE_NOTICE' | 'UNFREEZE_NOTICE' | 'AUDIT_REQUEST'
  | 'ACK';

export type MessagePriority = 'low' | 'normal' | 'high' | 'critical';

export interface AgentMessage {
  messageId: string;
  traceId: string;
  sourceAgentId: string;
  targetAgentId: string;
  parentMessageId?: string;
  type: MessageType;
  payload: Record<string, unknown>;
  priority: MessagePriority;
  timestamp: number;
  ttl?: number;
  requiresAck: boolean;
  correlationId?: string;
}

// ── AssertionLevel（Docs/07 §8.4）──────────────────────────────────

export type AssertionLevel = 'observed' | 'inferred' | 'assumed';
