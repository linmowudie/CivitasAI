/**
 * Recovery Scanner — 启动崩溃恢复扫描（Docs/13 §6.1 / §6.2）
 *
 * 职责：
 * - 扫描未完成的 Loop（phase NOT IN ('completed','failed')）
 * - 解析超时 EXECUTING 副作用 → UNKNOWN
 * - 生成 RecoveryPlan[]（四分支裁决）
 */

import { getMainDb } from '../Db/database.js';
import type { Result } from '../types.js';
import { ok, err } from '../types.js';

import { resolveTimedOutEffects, getUnknownEffects } from './effectJournal.js';
import { loadLatestCheckpoint } from './checkpointStore.js';
import type { RecoveryPlan, RecoveryStrategy } from './schemas/RecoveryPlan.js';
import type { EffectRecord } from './schemas/EffectRecord.js';

// ===== 类型导出 =====
export type { RecoveryPlan, RecoveryStrategy };

// ===== 类型定义 =====

/** 恢复扫描配置 */
export interface RecoveryConfig {
  autoResumeMaxUnknownEffects: number;
  autoResumeMaxBudgetUsedRatio: number;
  requireHumanOnArtifactDrift: boolean;
}

/** Loop 行（简化版，仅扫描需要的字段） */
interface LoopRow {
  loop_id: string;
  phase: string;
  budget_used_tokens: number;
}

// ===== 内部状态 =====

let recoveryConfig: RecoveryConfig = {
  autoResumeMaxUnknownEffects: 0,
  autoResumeMaxBudgetUsedRatio: 0.8,
  requireHumanOnArtifactDrift: true,
};

// ===== 公开 API =====

/**
 * 初始化恢复扫描配置
 */
export function initRecoveryScanner(config: Partial<RecoveryConfig>): void {
  recoveryConfig = { ...recoveryConfig, ...config };
}

/**
 * 执行启动恢复扫描（Docs/13 §6.1）
 *
 * 步骤：
 * 1. 解析超时的 EXECUTING → UNKNOWN
 * 2. 扫描未完成 Loop
 * 3. 为每个 Loop 生成 RecoveryPlan
 */
export function scanAndProposeRecovery(): Result<RecoveryPlan[]> {
  try {
    // Step 1: 解析超时副作用
    resolveTimedOutEffects();

    // Step 2: 查找未完成 Loop
    const db = getMainDb();
    const unfinishedLoops = db.prepare(`
      SELECT loop_id, phase, budget_used_tokens FROM loops
      WHERE phase NOT IN ('completed', 'failed')
    `).all() as LoopRow[];

    if (unfinishedLoops.length === 0) {
      return ok([]);
    }

    // Step 3: 为每个 Loop 生成恢复计划
    const plans: RecoveryPlan[] = [];
    for (const loop of unfinishedLoops) {
      const plan = classifyLoop(loop);
      plans.push(plan);
    }

    return ok(plans);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return err(`恢复扫描失败: ${message}`, 'FATAL');
  }
}

/**
 * 获取需要人工干预的恢复计划
 */
export function getHumanRequiredPlans(plans: RecoveryPlan[]): RecoveryPlan[] {
  return plans.filter(p => p.strategy === 'REQUIRE_HUMAN');
}

/**
 * 获取可自动恢复的恢复计划
 */
export function getAutoResumePlans(plans: RecoveryPlan[]): RecoveryPlan[] {
  return plans.filter(p => p.strategy === 'AUTO_RESUME');
}

// ===== 内部函数 =====

/**
 * 为单个 Loop 分类恢复策略（Docs/13 §6.2 矩阵）
 */
function classifyLoop(loop: LoopRow): RecoveryPlan {
  const loopId = loop.loop_id;

  // 加载最新 Checkpoint
  const ckptResult = loadLatestCheckpoint(loopId);
  const lastCkpt = ckptResult.ok ? ckptResult.value : null;

  // 获取 UNKNOWN 副作用
  const unknownResult = getUnknownEffects(loopId);
  const unknownEffects: EffectRecord[] = unknownResult.ok ? unknownResult.value : [];

  // 四分支裁决（Docs/13 §6.2）
  const strategy = classify(loop, lastCkpt, unknownEffects);
  const reason = buildReason(loop, lastCkpt, unknownEffects, strategy);

  return {
    loopId,
    strategy,
    lastCheckpointId: lastCkpt?.checkpointId,
    unknownEffects,
    estimatedWastedTokens: estimateWaste(loop),
    reason,
  };
}

/**
 * 恢复策略分类（Docs/13 §6.2 矩阵）
 */
function classify(
  loop: LoopRow,
  lastCkpt: { checkpointId: string } | null,
  unknownEffects: EffectRecord[],
): RecoveryStrategy {
  // 有不可自动裁决的 UNKNOWN → REQUIRE_HUMAN
  if (unknownEffects.length > recoveryConfig.autoResumeMaxUnknownEffects) {
    return 'REQUIRE_HUMAN';
  }

  // 无 checkpoint（首轮崩溃）→ RESTART_FROM_SCRATCH
  if (!lastCkpt) {
    return 'RESTART_FROM_SCRATCH';
  }

  // 预算已用 ≥ 80% → REQUIRE_HUMAN
  // 简化：使用 budget_used_tokens 与一个假设的总预算比较
  // 实际应由外部传入总预算，此处暂用固定阈值
  const budgetUsedRatio = estimateBudgetUsedRatio(loop);
  if (budgetUsedRatio >= recoveryConfig.autoResumeMaxBudgetUsedRatio) {
    return 'REQUIRE_HUMAN';
  }

  // 无 UNKNOWN + 有 checkpoint + 预算未超阈 → AUTO_RESUME
  return 'AUTO_RESUME';
}

/**
 * 估算预算使用比例（简化版）
 */
function estimateBudgetUsedRatio(_loop: LoopRow): number {
  // 简化：当前阶段无法精确估算，返回 0
  // 后续阶段由 Loop 运行时传入实际预算信息
  return 0;
}

/**
 * 估算浪费的 Token
 */
function estimateWaste(_loop: LoopRow): number {
  // 简化：返回 0，后续阶段完善
  return 0;
}

/**
 * 构建恢复原因描述
 */
function buildReason(
  _loop: LoopRow,
  lastCkpt: { checkpointId: string } | null,
  unknownEffects: EffectRecord[],
  strategy: RecoveryStrategy,
): string {
  switch (strategy) {
    case 'AUTO_RESUME':
      return `无 UNKNOWN 副作用，有可用 checkpoint (${lastCkpt?.checkpointId})，预算未超阈值`;
    case 'REQUIRE_HUMAN':
      if (unknownEffects.length > 0) {
        return `存在 ${unknownEffects.length} 个 UNKNOWN 副作用，需人工裁决`;
      }
      return `预算使用已接近上限，需人工确认是否继续`;
    case 'RESTART_FROM_SCRATCH':
      return `无 checkpoint（首轮崩溃），需从目标重建`;
    case 'REBUILD_FROM_JOURNAL':
      return `checkpoint 数据可能损坏，需从 effect_journal 重建`;
  }
}
