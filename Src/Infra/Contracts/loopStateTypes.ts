/**
 * @module Infra/Contracts/loopStateTypes
 * @description
 * `LoopState` 的**跨层共享控制面契约**（纯类型、零运行时、零 import，ADR-0006）。
 *
 * ## P2-11 修复（《Docs/Agent/17-控制论审查》）
 *
 * 项目里长期并存**两套不同构的 `LoopState`**：
 *  - `Core/Loop/loopEngine.ts` 的精简版（只够驱动十步循环）；
 *  - `Services/LoopControl/loopState.ts` 的完整版（含 `goal` / `failedAttempts`）。
 *
 * 后果：需要"目标与失败历史"的控制器（`goalReanchorControl`、`failureFeedback`）
 * 在真实运行态**没有可依赖的状态对象**——控制器的内部模型与被控状态模型不一致，
 * 于是完整版重锚器只能被测试引用、无法注册进生产（P1-7）。
 *
 * 本契约给出**双方都能满足**的最小控制面：控制器依赖它而不是依赖任一具体类型。
 *  - `goal` / `failedAttempts` 为必填（双方都有）；
 *  - 循环记忆字段为可选（`Core/Loop` 提供，Services 侧可不提供）——
 *    "有字段的对象"可结构化赋值给"可选字段的契约"，约束方向正确。
 *
 * 约束：本文件不得 import 任何模块，不得含任何运行时代码。
 */

/** 目标不可变区（ADR-0005：任何压缩/摘要机制不得修改） */
export interface LoopGoalContract {
  /** 用户原始需求 */
  originalRequirement: string;
  /** 不可违背的约束（禁止压缩触及） */
  immutableConstraints: readonly string[];
}

/** 失败尝试记录（供控制器回灌"避免重复"策略） */
export interface LoopFailedAttemptContract {
  /** 发生在第几轮 */
  iteration: number;
  /** 采用的策略 */
  strategy: string;
  /** 失败类别 */
  failureCategory: string;
}

/** 控制器可依赖的 LoopState 控制面 */
export interface ControlLoopStateView {
  readonly loopId: string;
  readonly traceId: string;
  /** 不可变区 */
  goal: LoopGoalContract;
  /** 失败历史 */
  failedAttempts: ReadonlyArray<LoopFailedAttemptContract>;

  // ── 以下为「回路记忆」字段（P1-5 / P1-7）：由 Core/Loop 的 LoopState 提供 ──

  /** 压缩后置位的重锚请求（P1-7：置位方 = ⑤ 步压缩成功处） */
  needsGoalReanchor?: boolean;
  /** 跨轮累积的风险信号（如 `repetitive_output`），进 StopRules 的 riskTriggers */
  riskSignals?: string[];
  /** 跨轮输出指纹历史（P1-5：修复前写在每轮重建的 ctx.data 上，长度恒 ≤1） */
  fingerprintHistory?: string[];
}
