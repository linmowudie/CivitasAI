/**
 * @module Repositories/loopRepository
 * @description Loop 主表落库（2026-10-04 新增）。
 *
 * 背景（QoderCN Desktop 差别清单 Agent-09 查出"5 表零 INSERT"）：
 *  `loops` 表自早期迁移就存在，但全仓**无任何 INSERT** —— 它同时是
 *  `loop_checkpoints.loop_id` 的外键父表，导致每轮迭代写快照必然命中
 *  `FOREIGN KEY constraint failed`，崩溃恢复链路因此**从未真正工作过**。
 *
 * 职责：
 *  - `ensureLoopRow`：在任何需要外键父行的场景（快照/副作用等）**幂等**补齐 loops 行；
 *  - `touchLoop`：更新迭代号、阶段、最后快照 ID —— 供恢复扫描读取"最新进度"。
 *
 * 说明：未知字段用安全默认值占位，缺失信息不会阻断运行（可观测性优先于完整性）。
 *
 * 日志分级（REV-337）：落库失败统一走 `Db/dbFailureLog.ts` 的 `logDbFailure()`——
 * 数据库未初始化是一种运行形态（纯内存运行），按来源降为一条 `warn`；
 * 库已就绪却写失败是真故障，逐条 `error`。本模块的写点在**每轮迭代**都会触发，
 * 若不分级，一次真实 Loop 就能把日志刷成噪声墙。
 */

import { getMainDb } from "../index.js";
import { getActiveOwner } from "../../AccountScope/activeAccount.js";
import { logDbFailure } from "../dbFailureLog.js";

export interface EnsureLoopInput {
  loopId: string;
  traceId?: string;
  /** 会话键：默认取 traceId（会话与运行一一对应） */
  sessionKey?: string;
  agentId?: string;
  parentAgentId?: string;
  taskId?: string;
  phase?: string;
}

/**
 * 幂等补齐 loops 行（存在则只刷新 updated_at）。
 *
 * @returns 是否可用（false 表示写入失败，调用方应据此外理而非崩溃）
 */
export function ensureLoopRow(input: EnsureLoopInput): boolean {
  const now = Date.now();
  try {
    getMainDb()
      .prepare(
        `INSERT INTO loops (
         loop_id, trace_id, session_key, agent_id, task_id, parent_agent_id,
         goal_json, state_json, iteration, phase, budget_used_tokens, budget_used_usd,
         created_at, updated_at, owner_user_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, 0, ?, ?, ?)
       ON CONFLICT(loop_id) DO UPDATE SET updated_at = excluded.updated_at`,
      )
      .run(
        input.loopId,
        input.traceId ?? input.loopId,
        input.sessionKey ?? input.traceId ?? input.loopId,
        input.agentId ?? "unknown",
        input.taskId ?? input.loopId,
        input.parentAgentId ?? null,
        // goal_json / state_json 在 LoopState 里未集中保存；占位为空对象，恢复时以 checkpoint 内容为准
        JSON.stringify({}),
        JSON.stringify({ loopId: input.loopId }),
        input.phase ?? "running",
        now,
        now,
        getActiveOwner(),
      );
    return true;
  } catch (e) {
    logDbFailure(
      "loops 行补齐失败（快照外键将不满足）",
      "loopRepository/ensureLoopRow",
      {
        loopId: input.loopId,
      },
      e,
      "返回 false（本轮无 checkpoints 父行，崩溃恢复不可用）",
    );
    return false;
  }
}

/** 更新 Loop 进度（迭代号 / 阶段 / 最后快照 ID） */
export function touchLoop(
  loopId: string,
  updates: {
    iteration?: number;
    phase?: string;
    lastCheckpointId?: string;
    stoppedReason?: string;
  },
): void {
  const sets: string[] = ["updated_at = ?"];
  const params: unknown[] = [Date.now()];
  if (updates.iteration !== undefined) {
    sets.push("iteration = ?");
    params.push(updates.iteration);
  }
  if (updates.phase !== undefined) {
    sets.push("phase = ?");
    params.push(updates.phase);
  }
  if (updates.lastCheckpointId !== undefined) {
    sets.push("last_checkpoint_id = ?");
    params.push(updates.lastCheckpointId);
  }
  if (updates.stoppedReason !== undefined) {
    sets.push("stopped_reason = ?");
    params.push(updates.stoppedReason);
  }
  params.push(loopId);
  try {
    getMainDb()
      .prepare(`UPDATE loops SET ${sets.join(", ")} WHERE loop_id = ?`)
      .run(...params);
  } catch (e) {
    logDbFailure(
      "loops 进度更新失败",
      "loopRepository/touchLoop",
      {
        loopId,
      },
      e,
      "库里进度陈旧（恢复扫描读到旧的迭代号/阶段）",
    );
  }
}

/** 读取 Loop 行（恢复/诊断用） */
export function getLoopRow(
  loopId: string,
): Record<string, unknown> | undefined {
  try {
    return getMainDb()
      .prepare("SELECT * FROM loops WHERE loop_id = ?")
      .get(loopId) as Record<string, unknown> | undefined;
  } catch (e) {
    logDbFailure(
      "loops 行读取失败",
      "loopRepository/getLoopRow",
      {
        loopId,
      },
      e,
      "返回 undefined（恢复流程认为该 loop 不存在）",
    );
    return undefined;
  }
}

/** 统计（诊断"是否有 loop 落库"） */
export function countLoops(): number {
  try {
    const row = getMainDb().prepare("SELECT COUNT(*) AS n FROM loops").get() as
      { n: number } | undefined;
    return row?.n ?? 0;
  } catch (e) {
    logDbFailure(
      "loops 行数读取失败",
      "loopRepository/countLoops",
      {},
      e,
      '按 0 处理（诊断会误读成"无 loop 落库"）',
    );
    return 0;
  }
}
