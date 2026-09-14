/**
 * RecoveryPlan 类型定义（Docs/13 §6.1）
 *
 * 恢复扫描的输出结果，决定崩溃后如何处置未完成的 Loop。
 */

import type { EffectRecord } from './EffectRecord.js';

// ===== 恢复策略（全集，Docs/13 §6.1） =====

/** 恢复策略四值全集（与 §6.2 矩阵一一对应） */
export type RecoveryStrategy =
  /** 无 UNKNOWN + 有可用 checkpoint + 预算未超阈 */
  | 'AUTO_RESUME'
  /** 有不可自动裁决的 UNKNOWN，或命中降级阈值 */
  | 'REQUIRE_HUMAN'
  /** 无任何 checkpoint（首轮崩溃），只能从 goal 重建 */
  | 'RESTART_FROM_SCRATCH'
  /** checkpoint 损坏，从 effect_journal + events 流重建 */
  | 'REBUILD_FROM_JOURNAL';

// ===== 核心类型 =====

/** 恢复计划（Docs/13 §6.1） */
export interface RecoveryPlan {
  readonly loopId: string;
  readonly strategy: RecoveryStrategy;
  readonly lastCheckpointId?: string;
  readonly unknownEffects: EffectRecord[];
  readonly estimatedWastedTokens: number;
  /** 升级人工时必须可读 */
  readonly reason: string;
}

/** 恢复错误 */
export class RecoveryError extends Error {
  readonly code: string;
  readonly detail?: unknown;

  constructor(code: string, message: string, detail?: unknown) {
    super(message);
    this.name = 'RecoveryError';
    this.code = code;
    this.detail = detail;
  }
}
