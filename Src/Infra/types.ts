/**
 * Infra 层共享类型定义
 *
 * 全局枚举与基础类型，供所有 Infra 子模块引用。
 * 枚举取值遵循 Docs/15 §4 全集，三处同形。
 */

// ===== 日志级别 =====
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

// ===== 错误分级 =====
export type ErrorSeverity = 'ERROR' | 'FATAL' | 'PANIC';

// ===== 配置可变性级别（Docs/11 §1.3）=====
export enum MutabilityLevel {
  /** 启动锁定，启动后不可更改 */
  L0 = 'L0',
  /** 启动时读取一次，运行期间不变 */
  L1 = 'L1',
  /** 运行时可重载（热更新） */
  L2 = 'L2',
  /** 实时可变（每次使用时重新读取） */
  L3 = 'L3',
}

// ===== 信任级别（Docs/11 §3.2）=====
export type TrustLevel = 'L0' | 'L1' | 'L2';

// ===== 用户角色（Docs/11 §3.2 / Docs/02 §3.2）=====
/**
 * 8 角色单一真相源。
 * L0 治理级: regulator, auditor, arbitrator
 * L1 入口级: prime_director, partner
 * L2 执行子级: worker, reviewer, assembly_node
 */
export type UserRole = 'prime_director' | 'partner' | 'regulator' | 'auditor' | 'arbitrator'
  | 'worker' | 'reviewer' | 'assembly_node';

// ===== 全局 ID 类型 =====

/** session_key: SHA-256 前 16 位 hex */
export type SessionKey = string;

/** trace_id: UUID v4 */
export type TraceId = string;

/** operation_id: {timestamp_ms}-{4位hex} */
export type OperationId = string;

// ===== 基础结果类型 =====
export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

export interface Err {
  readonly ok: false;
  readonly error: string;
  readonly severity: ErrorSeverity;
}

export type Result<T> = Ok<T> | Err;

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err(error: string, severity: ErrorSeverity = 'ERROR'): Err {
  return { ok: false, error, severity };
}
