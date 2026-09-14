/**
 * Recovery Executor — 恢复执行（Docs/13 §6.3）
 *
 * 职责：
 * - 根据 RecoveryPlan 执行恢复
 * - AUTO_RESUME：从 checkpoint 恢复状态继续执行
 * - 验证产出文件完整性
 * - 恢复时不重放历史消息（只装载 LoopState）
 */

import type { Result } from '../types.js';
import { ok, err } from '../types.js';
import { loadCheckpoint } from './checkpointStore.js';
import type { RecoveryPlan } from './schemas/RecoveryPlan.js';
import { RecoveryError } from './schemas/RecoveryPlan.js';

// ===== 类型定义 =====

/** 恢复结果 */
export interface ResumeResult {
  readonly loopId: string;
  readonly checkpointId: string;
  readonly iteration: number;
  readonly stateSnapshot: Record<string, unknown>;
}

// ===== 公开 API =====

/**
 * 根据恢复计划执行恢复（Docs/13 §6.3）
 *
 * 仅支持 AUTO_RESUME 策略；其他策略返回错误需人工处理。
 */
export function executeRecovery(plan: RecoveryPlan): Result<ResumeResult> {
  if (plan.strategy !== 'AUTO_RESUME') {
    return err(
      `恢复策略 ${plan.strategy} 不支持自动执行: ${plan.reason}`,
      'ERROR',
    );
  }

  if (!plan.lastCheckpointId) {
    return err('AUTO_RESUME 需要 checkpoint ID', 'ERROR');
  }

  return resume(plan.loopId, plan.lastCheckpointId);
}

/**
 * 从指定 Checkpoint 恢复（Docs/13 §6.3）
 *
 * 步骤：
 * ① 加载 Checkpoint
 * ② 验证产出文件完整性
 * ③ 装载 State（不装载消息历史）
 * ④ 返回恢复上下文
 */
export function resume(loopId: string, checkpointId: string): Result<ResumeResult> {
  try {
    // ① 加载 Checkpoint
    const ckptResult = loadCheckpoint(checkpointId);
    if (!ckptResult.ok) {
      return err(`加载 Checkpoint 失败: ${ckptResult.error}`, 'ERROR');
    }
    const ckpt = ckptResult.value;
    if (!ckpt) {
      throw new RecoveryError('CHECKPOINT_NOT_FOUND', `Checkpoint ${checkpointId} 不存在`);
    }

    // ② 验证产出文件完整性
    // 注：S2 阶段仅做结构验证，实际文件校验待 S4 工具层完善
    for (const art of ckpt.artifactManifest) {
      if (!art.path || !art.hash || art.sizeBytes < 0) {
        throw new RecoveryError('ARTIFACT_CORRUPTED', '产出文件指纹不完整', art);
      }
    }

    // ③ 装载 State
    const state = ckpt.stateSnapshot;

    // ④ 返回恢复上下文
    return ok({
      loopId,
      checkpointId,
      iteration: state.iteration as number + 1, // 从下一轮继续
      stateSnapshot: state as Record<string, unknown>,
    });
  } catch (e) {
    if (e instanceof RecoveryError) {
      return err(`恢复失败 [${e.code}]: ${e.message}`, 'FATAL');
    }
    const message = e instanceof Error ? e.message : String(e);
    return err(`恢复执行失败: ${message}`, 'FATAL');
  }
}

/**
 * 验证恢复计划的可行性
 */
export function validateRecoveryPlan(plan: RecoveryPlan): Result<boolean> {
  switch (plan.strategy) {
    case 'AUTO_RESUME':
      if (!plan.lastCheckpointId) {
        return err('AUTO_RESUME 缺少 checkpoint ID', 'ERROR');
      }
      if (plan.unknownEffects.length > 0) {
        return err(`存在 ${plan.unknownEffects.length} 个 UNKNOWN 副作用`, 'ERROR');
      }
      return ok(true);

    case 'REQUIRE_HUMAN':
      return ok(false); // 需人工处理，不自动执行

    case 'RESTART_FROM_SCRATCH':
      return ok(false); // 需人工确认

    case 'REBUILD_FROM_JOURNAL':
      return ok(false); // 需要完整 journal 重建逻辑（Phase 1 实现）

    default:
      return err(`未知恢复策略: ${plan.strategy}`, 'ERROR');
  }
}
