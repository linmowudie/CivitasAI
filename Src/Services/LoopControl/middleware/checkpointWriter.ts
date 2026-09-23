/**
 * @module LoopControl/middleware/checkpointWriter
 * @description
 * Checkpoint 写入中间件——Docs/13 §5.1。
 * 每轮 iteration 末尾无论成功或失败均写 checkpoint。
 * 对应 Docs/12 §4.1：每轮 checkpoint 是持久执行的基础。
 *
 * 挂载点：afterAgent（在 StopRuleEvaluator 之后）。
 */

import type { AgentMiddleware, MiddlewareContext } from '../../../Infra/Contracts/middlewareTypes.js';
import type { LoopState } from '../loopState.js';
import { hashGoal } from '../loopState.js';

/** Checkpoint 记录 */
export interface CheckpointRecord {
  checkpointId: string;
  loopId: string;
  iteration: number;
  stateSnapshot: string;
  artifactManifest: Array<{ path: string; hash: string; sizeBytes: number }>;
  pendingEffects: string[];
  nextStepHint?: string;
  createdAt: number;
}

/** Checkpoint 存储回调 */
export interface CheckpointCallbacks {
  onSave?: (checkpoint: CheckpointRecord) => void;
  onLoad?: (loopId: string) => CheckpointRecord | undefined;
}

/** 内存 checkpoint 存储（Phase 0） */
const checkpointStore: Map<string, CheckpointRecord[]> = new Map();

/** 创建 Checkpoint 写入中间件 */
export function createCheckpointWriterMiddleware(
  getLoopState: () => LoopState | undefined,
  callbacks: CheckpointCallbacks = {},
): AgentMiddleware {
  return {
    name: 'CheckpointWriter',
    hook: 'afterAgent',
    priority: 50,  // 在 StopRuleEvaluator 之后
    canShortCircuit: false,

    execute: async (ctx: MiddlewareContext, _result: unknown) => {
      const state = getLoopState();
      if (!state) return;

      // 验证 goal 完整性（ADR-0005）
      const goalHash = hashGoal(state.goal);
      ctx.data['goalHash'] = goalHash;

      // 创建 checkpoint
      const checkpoint: CheckpointRecord = {
        checkpointId: `${state.loopId}-iter${state.iteration}-${Date.now()}`,
        loopId: state.loopId,
        iteration: state.iteration,
        stateSnapshot: JSON.stringify(state),
        artifactManifest: state.artifactPaths.map(p => ({
          path: p,
          hash: '',  // Phase 0 不计算文件 hash
          sizeBytes: 0,
        })),
        pendingEffects: [],
        createdAt: Date.now(),
      };

      // 存储 checkpoint
      if (!checkpointStore.has(state.loopId)) {
        checkpointStore.set(state.loopId, []);
      }
      checkpointStore.get(state.loopId)!.push(checkpoint);

      // 更新 state 的 lastCheckpointId
      state.lastCheckpointId = checkpoint.checkpointId;

      callbacks.onSave?.(checkpoint);
    },
  };
}

/** 获取 Loop 的 checkpoint 历史 */
export function getCheckpoints(loopId: string): CheckpointRecord[] {
  return checkpointStore.get(loopId) ?? [];
}

/** 获取最新 checkpoint */
export function getLatestCheckpoint(loopId: string): CheckpointRecord | undefined {
  const cps = checkpointStore.get(loopId);
  return cps?.[cps.length - 1];
}

/** 清空 checkpoint 存储（测试用） */
export function clearCheckpointStore(loopId?: string): void {
  if (loopId) checkpointStore.delete(loopId);
  else checkpointStore.clear();
}
