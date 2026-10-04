/**
 * @module DurableExecution/iterationCheckpoint
 * @description 迭代边界快照写入（2026-10-04 新增，修复"运行期无 checkpoint"）。
 *
 * 背景（QoderCN Desktop 差别清单 Agent-12 查出）：
 *  `checkpointStore.createCheckpoint()` 早已实现且建了表 `loop_checkpoints`，
 *  但**全仓没有任何运行期调用方** —— 只有中间件 `checkpointWriter.ts` 在内存 Map 里记录，
 *  意味着崩溃后 `recoveryScanner.loadLatestCheckpoint()` 永远读不到东西，恢复链路形同虚设。
 *
 * 职责：在每轮迭代末尾原子写入一份快照（含未完成副作用与下一步提示），
 * 并定期裁剪旧快照，避免长任务把表写爆。
 *
 * 边界：仅"写快照"，不负责恢复决策（恢复由 `recoveryScanner` / `recoveryExecutor` 负责）。
 */

import { createCheckpoint, pruneCheckpoints } from './checkpointStore.js';
import { ensureLoopRow, touchLoop } from '../Db/Repositories/loopRepository.js';
import type { EffectRecord } from './schemas/EffectRecord.js';
import { logger } from '../Logging/logger.js';

/** 保留最近多少份快照（长任务防膨胀） */
export const CHECKPOINT_KEEP_LAST = 20;
/** 每多少轮裁剪一次 */
const PRUNE_EVERY = 10;

export interface IterationCheckpointInput {
  loopId: string;
  /** 已完成轮次（从 1 开始） */
  iteration: number;
  /** 本轮决策（继续/终止原因），供恢复时判断走向 */
  decision: string;
  /** 已完成的步数（LoopState.completedSteps 的近似值） */
  completedSteps: number;
  /** 累计失败尝试次数 */
  failedAttempts: number;
  /** 本轮工具调用名列表（作为 stateSnapshot 的一部分，便于恢复时理解进度） */
  toolNames?: string[];
  /** 尚未完成/结果未知的副作用（来自 EffectJournal，恢复时需要续跑或裁决） */
  pendingEffects?: Array<Pick<EffectRecord, 'effectId'>>;
  /** 下一步提示（如"继续执行第 N 轮"） */
  nextStepHint?: string;
}

/**
 * 写入一次迭代快照。
 *
 * @returns 是否写入成功（失败不抛错：恢复能力降级不应打断正常执行，但必须有日志留痕）
 */
export function writeIterationCheckpoint(input: IterationCheckpointInput): boolean {
  try {
    // ★ 先补齐 loops 行（2026-10-04）：`loop_checkpoints.loop_id` 有外键指向 `loops`，
    //   而 `loops` 此前从无 INSERT → 快照写入必然 FK 失败。这里幂等补齐，保证父行存在。
    ensureLoopRow({ loopId: input.loopId, phase: 'running' });

    const result = createCheckpoint({
      loopId: input.loopId,
      iteration: input.iteration,
      stateSnapshot: {
        iteration: input.iteration,
        phase: 'iteration_complete',
        completedSteps: input.completedSteps,
        failedAttempts: input.failedAttempts,
        decision: input.decision,
        toolNames: input.toolNames ?? [],
      },
      // 产物清单与文件指纹需要扫描工作目录，成本高；恢复主要依赖状态与副作用列表，此处留空
      artifactManifest: [],
      pendingEffects: (input.pendingEffects ?? []).map((e) => e.effectId),
      ...(input.nextStepHint ? { nextStepHint: input.nextStepHint } : {}),
    });

    if (!result.ok) {
      logger.error('迭代快照写入失败（崩溃恢复能力降级）', {
        source: 'iterationCheckpoint/writeIterationCheckpoint',
        loopId: input.loopId,
        iteration: input.iteration,
        error: result.error,
      });
      return false;
    }

    // 同步 loops 进度（恢复扫描据此判断"跑到第几轮、最近快照是谁"）
    touchLoop(input.loopId, {
      iteration: input.iteration,
      phase: 'running',
      lastCheckpointId: result.value.checkpointId,
    });

    // 定期裁剪（保留最近 N 份）
    if (input.iteration % PRUNE_EVERY === 0) {
      const pruned = pruneCheckpoints(input.loopId, CHECKPOINT_KEEP_LAST);
      if (pruned.ok && pruned.value > 0) {
        logger.info('迭代快照已裁剪旧记录', {
          source: 'iterationCheckpoint/writeIterationCheckpoint',
          loopId: input.loopId,
          removed: pruned.value,
        });
      }
    }
    return true;
  } catch (e) {
    logger.error('迭代快照写入异常（崩溃恢复能力降级）', {
      source: 'iterationCheckpoint/writeIterationCheckpoint',
      loopId: input.loopId,
      iteration: input.iteration,
      error: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}
