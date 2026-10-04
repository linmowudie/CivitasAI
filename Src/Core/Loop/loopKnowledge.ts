/**
 * @module Loop/loopKnowledge
 * @description
 * Loop 出口知识沉淀（FE-059 实装——“Loop 成功退出 → SharedMemory.consolidateFromTrace
 * 接线尚未落地”的落地）。
 *
 * 链路（成功退出时）：
 *   ① 任务完成观察写入 GlobalWorkspace（`assertion='observed'`——仅 observed 可进入长期记忆，§8.4；
 *      同时解决“GlobalWorkspace 运行期无写方”问题）；
 *   ② `consolidateFromTrace` 把该 trace 的 observed 条目提炼进长期记忆。
 *
 * 边界：
 *   - 仅 `exitReason === 'success'` 且输出具备实质内容（≥ MIN_SUMMARY_CHARS）才沉淀；
 *   - 全链 fail-soft——沉淀失败仅告警，绝不阻断/影响循环结果返回；
 *   - 红线（ADR-0005）：不触碰 goal 与 immutableConstraints。
 */

import { logger } from '../../Infra/Logging/logger.js';
import { write as writeWorkspace } from '../../Services/SharedMemory/globalWorkspace.js';
import { consolidateFromTrace } from '../../Services/SharedMemory/memoryConsolidator.js';

/** 沉淀门槛：输出短于该长度视为无实质内容，不沉淀（避免噪声记忆） */
const MIN_SUMMARY_CHARS = 50;
/** 观察条目内容上限 */
const MAX_SUMMARY_CHARS = 500;

export interface ConsolidateLoopInput {
  loopId: string;
  traceId: string;
  agentId: string;
  exitReason?: string;
  outputText?: string;
}

/**
 * Loop 退出时执行知识沉淀（fail-soft）。
 * @returns 沉淀统计；未满足门槛/失败时返回 null
 */
export function consolidateLoopKnowledge(
  input: ConsolidateLoopInput,
): { consolidated: number; skipped: number } | null {
  try {
    if (input.exitReason !== 'success') return null;

    const summary = (input.outputText ?? '').trim();
    if (summary.length < MIN_SUMMARY_CHARS) return null;

    // ① 任务观察写入共享工作区（observed）
    const wsResult = writeWorkspace({
      key: `loop-completion:${input.loopId}`,
      content: summary.slice(0, MAX_SUMMARY_CHARS),
      contentType: 'status',
      assertion: 'observed',
      traceId: input.traceId,
      agentId: input.agentId,
    });
    if (!wsResult.ok) {
      logger.warn('任务观察写入共享工作区失败（跳过沉淀）', {
        source: 'Loop/loopKnowledge',
        loopId: input.loopId,
        error: wsResult.error,
      });
      return null;
    }

    // ② 提炼进长期记忆
    const consolidated = consolidateFromTrace({ traceId: input.traceId });
    if (!consolidated.ok) {
      logger.warn('知识沉淀失败', {
        source: 'Loop/loopKnowledge',
        loopId: input.loopId,
        error: consolidated.error,
      });
      return null;
    }

    if (consolidated.value.consolidated > 0) {
      logger.info('Loop 出口知识沉淀完成', {
        source: 'Loop/loopKnowledge',
        loopId: input.loopId,
        consolidated: consolidated.value.consolidated,
        skipped: consolidated.value.skipped,
      });
    }
    return consolidated.value;
  } catch (e) {
    logger.warn('知识沉淀异常（已忽略）', {
      source: 'Loop/loopKnowledge',
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}
