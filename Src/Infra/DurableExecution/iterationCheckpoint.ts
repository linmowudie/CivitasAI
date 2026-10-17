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
 *
 * 日志分级（REV-337）：本模块的写点在**每轮迭代**触发，失败信号统一走
 * `Db/dbFailureLog.ts` 的 `logDbFailure()`——数据库未初始化（纯内存运行形态）按来源
 * 降为一条 `warn`，库已就绪却写失败仍为逐条 `error`。
 */

import { ensureLoopRow, touchLoop } from "../Db/Repositories/loopRepository.js";
import { logger } from "../Logging/logger.js";
import { logDbFailure } from "../Db/dbFailureLog.js";

import type { EffectRecord } from "./schemas/EffectRecord.js";
import { createCheckpoint, pruneCheckpoints } from "./checkpointStore.js";

/** 保留最近多少份快照（长任务防膨胀） */
export const CHECKPOINT_KEEP_LAST = 20;
/** 快照中保留的对话消息上限（尾部窗口；恢复只需要"接着说"所需的上下文） */
export const MESSAGE_SNAPSHOT_LIMIT = 40;
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
  /** 归属 Agent / trace（恢复续跑必须知道"替谁继续跑"） */
  agentId?: string;
  traceId?: string;
  /** 原始目标（恢复续跑的 userInput 来源；不可变区目标不随压缩丢失） */
  goal?: string;
  /** 本轮用户输入（恢复时作为任务说明的一部分） */
  userInput?: string;
  /**
   * 本轮对话历史快照（MEM1-GAP-RESTORE，设计 §3.4）。
   * 修复前恢复链只存轮次/阶段、**不含对话内容** → 恢复后无法继续对话。
   * 只保留尾部安全窗口（见 `MESSAGE_SNAPSHOT_LIMIT`，避免快照无界增长）。
   */
  messages?: ReadonlyArray<{
    role: string;
    content?: unknown;
    tool_call_id?: string;
    tool_calls?: unknown;
  }>;
  /** 尚未完成/结果未知的副作用（来自 EffectJournal，恢复时需要续跑或裁决） */
  pendingEffects?: Array<Pick<EffectRecord, "effectId">>;
  /** 下一步提示（如"继续执行第 N 轮"） */
  nextStepHint?: string;
}

/**
 * 写入一次迭代快照。
 *
 * @returns 是否写入成功（失败不抛错：恢复能力降级不应打断正常执行，但必须有日志留痕）
 */
export function writeIterationCheckpoint(
  input: IterationCheckpointInput,
): boolean {
  try {
    // ★ 先补齐 loops 行（2026-10-04）：`loop_checkpoints.loop_id` 有外键指向 `loops`，
    //   而 `loops` 此前从无 INSERT → 快照写入必然 FK 失败。这里幂等补齐，保证父行存在。
    ensureLoopRow({ loopId: input.loopId, phase: "running" });

    const result = createCheckpoint({
      loopId: input.loopId,
      iteration: input.iteration,
      stateSnapshot: {
        iteration: input.iteration,
        phase: "iteration_complete",
        completedSteps: input.completedSteps,
        failedAttempts: input.failedAttempts,
        decision: input.decision,
        toolNames: input.toolNames ?? [],
        // 恢复续跑所需的归属与目标（此前快照只有轮次/阶段 → 恢复后不知道替谁跑、跑什么）
        ...(input.agentId ? { agentId: input.agentId } : {}),
        ...(input.traceId ? { traceId: input.traceId } : {}),
        ...(input.goal ? { goal: input.goal } : {}),
        ...(input.userInput ? { userInput: input.userInput } : {}),
        // 对话内容随快照落盘：恢复后可继续说，而非只剩轮次计数
        messages: (input.messages ?? []).slice(-MESSAGE_SNAPSHOT_LIMIT),
      },
      // 产物清单与文件指纹需要扫描工作目录，成本高；恢复主要依赖状态与副作用列表，此处留空
      artifactManifest: [],
      pendingEffects: (input.pendingEffects ?? []).map((e) => e.effectId),
      ...(input.nextStepHint ? { nextStepHint: input.nextStepHint } : {}),
    });

    if (!result.ok) {
      logDbFailure(
        "迭代快照写入失败（崩溃恢复能力降级）",
        "iterationCheckpoint/writeIterationCheckpoint",
        {
          loopId: input.loopId,
          iteration: input.iteration,
        },
        result.error,
        "本轮无快照（恢复回退到上一轮）",
      );
      return false;
    }

    // 同步 loops 进度（恢复扫描据此判断"跑到第几轮、最近快照是谁"）
    touchLoop(input.loopId, {
      iteration: input.iteration,
      phase: "running",
      lastCheckpointId: result.value.checkpointId,
    });

    // 定期裁剪（保留最近 N 份）
    if (input.iteration % PRUNE_EVERY === 0) {
      const pruned = pruneCheckpoints(input.loopId, CHECKPOINT_KEEP_LAST);
      if (pruned.ok && pruned.value > 0) {
        logger.info("迭代快照已裁剪旧记录", {
          source: "iterationCheckpoint/writeIterationCheckpoint",
          loopId: input.loopId,
          removed: pruned.value,
        });
      }
    }
    return true;
  } catch (e) {
    logDbFailure(
      "迭代快照写入异常（崩溃恢复能力降级）",
      "iterationCheckpoint/writeIterationCheckpoint#exception",
      {
        loopId: input.loopId,
        iteration: input.iteration,
      },
      e,
      "本轮无快照（恢复回退到上一轮）",
    );
    return false;
  }
}
