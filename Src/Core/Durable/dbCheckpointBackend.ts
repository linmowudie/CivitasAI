/**
 * @module Core/Durable/dbCheckpointBackend
 * @description
 * 基于既有持久化件（`Src/Infra/DurableExecution/checkpointStore.ts`）的**真实**后端：
 * 把"key 空间"映射为既有存储的 `loopId`，快照序号映射为 `iteration`。
 *
 * 为什么放在 Core 而不是 Infra：分层是 `Interface → Core → Services → Tools → Infra`（箭头=依赖），
 * Core 可以依赖 Infra，**反向不行**。后端要复用 `checkpointStore`，故必须落在 Core 这一侧。
 */

import {
  createCheckpoint,
  listCheckpoints,
  loadLatestCheckpoint,
} from "../../Infra/DurableExecution/checkpointStore.js";
import { ensureLoopRow } from "../../Infra/Db/Repositories/loopRepository.js";
import type { LoopStateSnapshot } from "../../Infra/DurableExecution/schemas/Checkpoint.js";
import type { Result } from "../../Infra/types.js";
import { ok, err } from "../../Infra/types.js";

import type { CheckpointBackend } from "./checkpointRouter.js";

/**
 * 把**任意 JSON 负载**包封为既有 store 要求的 `LoopStateSnapshot`。
 *
 * 路由层不掌握组件的状态机，故 `phase` 用中性的 `"checkpoint"`；
 * 真正的负载原样放在 `payload` 字段里，读取时再解封 —— 不丢信息。
 */
function toSnapshot(payload: unknown, iteration: number): LoopStateSnapshot {
  return {
    iteration,
    phase: "checkpoint",
    completedSteps: 0,
    failedAttempts: 0,
    payload: payload === undefined ? null : payload,
  };
}

/** 解封：本路由写入的快照一律带 `payload`；若遇到外部写入的快照则**原样返回**（不丢数据） */
function fromSnapshot(snapshot: LoopStateSnapshot): unknown {
  return Object.prototype.hasOwnProperty.call(snapshot, "payload")
    ? snapshot.payload
    : snapshot;
}

/** DB 支撑的后端：原子写入由既有 store 的事务保证 */
export function createDbCheckpointBackend(): CheckpointBackend {
  return {
    append: async (
      loopId: string,
      snapshot: unknown,
    ): Promise<Result<number>> => {
      // ★ 既有持久化件对 loops 有外键约束：快照必须挂在**已存在**的 loop 行上。
      //   幂等补齐（已存在则只刷新 updated_at）；失败必须传播，不能"写不进去也当成功"。
      const loopReady = ensureLoopRow({ loopId });
      if (!loopReady)
        return err("补齐 loop 行失败（" + loopId + "），拒绝写入快照");

      const listed = listCheckpoints(loopId, 1);
      if (!listed.ok) return err("读取快照序列失败: " + listed.error);
      const latest = listed.value[0];
      const nextIteration = latest ? latest.iteration + 1 : 1;

      const created = createCheckpoint({
        loopId,
        iteration: nextIteration,
        stateSnapshot: toSnapshot(snapshot, nextIteration),
        artifactManifest: [],
        pendingEffects: [],
      });
      if (!created.ok) return err("创建快照失败: " + created.error);
      return ok(nextIteration);
    },

    latest: async (loopId: string): Promise<Result<unknown | null>> => {
      const loaded = loadLatestCheckpoint(loopId);
      if (!loaded.ok) return err("加载快照失败: " + loaded.error);
      return ok(loaded.value ? fromSnapshot(loaded.value.stateSnapshot) : null);
    },
  };
}
