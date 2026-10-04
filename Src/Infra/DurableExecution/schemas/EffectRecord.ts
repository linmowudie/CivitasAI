/**
 * EffectRecord 类型定义（Docs/Agent/12 §4.1 / Docs/Agent/09 §8.2 #6）
 *
 * 副作用意图日志的数据模型。
 * 每条记录代表一次副作用的完整生命周期。
 */

// ===== 副作用类型 =====

/** 副作用种类（与 effect_journal.kind 注释同集合） */
export type EffectKind =
  | 'tool_execute'
  | 'file_write'
  | 'http_call'
  | 'db_write'
  | 'agent_message_send'
  | 'token_debit'
  | 'external_api';

/** 副作用状态 */
export type EffectStatus =
  | 'INTENT'       // 意图已记录，尚未执行
  | 'EXECUTING'    // 正在执行
  | 'SUCCEEDED'    // 执行成功
  | 'FAILED'       // 执行失败
  | 'UNKNOWN';     // 崩溃后无法判定

/** 错误分类 */
export type ErrorClass = 'retryable' | 'non_retryable' | 'unknown';

// ===== 核心类型 =====

/** 副作用记录（Docs/Agent/12 §4.1） */
export interface EffectRecord {
  /** = operation_id，全局唯一 */
  readonly effectId: string;
  readonly loopId: string;
  readonly iteration: number;
  readonly kind: EffectKind;
  /** 由调用方提供或本层生成（Docs/Agent/12 §7.2） */
  readonly idempotencyKey: string;
  /** SHA-256(payload) */
  readonly payloadHash: string;
  status: EffectStatus;
  result?: unknown;
  /** epoch ms */
  readonly startedAt: number;
  /** 生效超时快照；默认 durable.effect.defaultTimeoutMs(30000) */
  readonly timeoutMs: number;
  /** epoch ms */
  completedAt?: number;
  errorClass?: ErrorClass;
  /**
   * 触发该副作用的工具调用 ID（`ToolCallInput.toolCallId`）。
   *
   * 用途（FE-027）：统计派生需要把"副作用日志"与"工具调用事件"**精确配对**，
   * 既覆盖全部工具调用、又不重复计数（同一调用只产生一个幂等键）。
   */
  readonly toolCallId?: string;
}

/** 创建 EffectRecord 的输入参数 */
export interface CreateEffectInput {
  readonly effectId: string;
  readonly loopId: string;
  readonly iteration: number;
  readonly kind: EffectKind;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly timeoutMs?: number;
  /** 关联的工具调用 ID（可选，用于统计配对） */
  readonly toolCallId?: string;
}

/** 更新 EffectRecord 的输入参数 */
export interface UpdateEffectInput {
  readonly effectId: string;
  readonly status: EffectStatus;
  readonly result?: unknown;
  readonly completedAt?: number;
  readonly errorClass?: ErrorClass;
}
