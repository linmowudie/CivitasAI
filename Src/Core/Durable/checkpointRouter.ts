/**
 * @module Core/Durable/checkpointRouter
 * @description
 * 快照落盘的**key 空间路由**：一个 key 空间只有一个写者。
 *
 * 设计出处：Docs/Dev/L1编排设计/20-归属复核.md §2 问题 1（快照有两个写者）·
 *   24-归属复核-第二批.md（版本记录）· 16-LifecycleController.md §4（落盘分区）
 *
 * 三条规则（每条都有负向测试）：
 *   1. **一个 key 空间只有一个写者**：第二个不同的 writerId 注册即拒绝。
 *   2. **component 与 conversation 空间永不冲突**：键为 `ckpt:<scope>:<ownerId>`，
 *      即便 ownerId 相同也落在不同空间（各自独立序列）。
 *   3. **失败必须传播**：后端写入失败时 `save` 返回错误 —— 绝不"记一笔假成功"。
 */

import type { Result } from "../../Infra/types.js";
import { ok, err } from "../../Infra/types.js";

/** 快照空间：组件级（C1 写）与对话/会话级（C5 写） */
export type CheckpointScope = "component" | "conversation";

/** 完整键：`ckpt:<scope>:<ownerId>` */
export function checkpointKey(scope: CheckpointScope, ownerId: string): string {
  return "ckpt:" + scope + ":" + ownerId;
}

/** 解析键（用于校验"控制器给的键是否落在它应属的空间"） */
export function parseCheckpointKey(
  key: string,
): { scope: CheckpointScope; ownerId: string } | null {
  const parts = key.split(":");
  if (parts.length < 3 || parts[0] !== "ckpt") return null;
  const scope = parts[1];
  if (scope !== "component" && scope !== "conversation") return null;
  return { scope, ownerId: parts.slice(2).join(":") };
}

/**
 * 持久化后端端口。
 *
 * `append` 返回该空间的**序号**（从 1 开始）；`latest` 返回最近一次快照。
 * 具体后端见 `Src/Infra/DurableExecution/keyedCheckpointBackend.ts`（DB 版）
 * 与本文件的 `createMemoryCheckpointBackend()`（进程内版）。
 */
export interface CheckpointBackend {
  append(loopId: string, snapshot: unknown): Promise<Result<number>>;
  latest(loopId: string): Promise<Result<unknown | null>>;
}

/** 进程内后端：真实可用的存储（非桩件），用于单进程运行与确定性测试 */
export function createMemoryCheckpointBackend(): CheckpointBackend {
  const store = new Map<string, unknown[]>();
  return {
    append: async (loopId, snapshot) => {
      const list = store.get(loopId) ?? [];
      list.push(snapshot);
      store.set(loopId, list);
      return ok(list.length);
    },
    latest: async (loopId) => {
      const list = store.get(loopId);
      return ok(list && list.length > 0 ? list[list.length - 1] : null);
    },
  };
}

export interface CheckpointRouter {
  /** 注册写者（同一空间只能有一个，重复注册同一 writerId 幂等） */
  registerWriter(
    scope: CheckpointScope,
    ownerId: string,
    writerId: string,
  ): Result<void>;
  /** 写入快照；writerId 必须是该空间的**唯一**注册写者 */
  save(
    scope: CheckpointScope,
    ownerId: string,
    writerId: string,
    snapshot: unknown,
  ): Promise<Result<{ key: string; sequence: number }>>;
  /** 读取最近一次快照 */
  load(
    scope: CheckpointScope,
    ownerId: string,
  ): Promise<Result<unknown | null>>;
  /** 该空间的写者（至多一个；空数组 = 未注册） */
  writersOf(scope: CheckpointScope, ownerId: string): readonly string[];
}

export function createCheckpointRouter(
  backend: CheckpointBackend,
): CheckpointRouter {
  /** key 空间 → 唯一写者 */
  const writers = new Map<string, string>();

  function writersOf(
    scope: CheckpointScope,
    ownerId: string,
  ): readonly string[] {
    const w = writers.get(checkpointKey(scope, ownerId));
    return w === undefined ? [] : [w];
  }

  return {
    registerWriter(scope, ownerId, writerId) {
      const key = checkpointKey(scope, ownerId);
      const existing = writers.get(key);
      if (existing === undefined) {
        writers.set(key, writerId);
        return ok(undefined);
      }
      if (existing === writerId) return ok(undefined);
      // ★ 规则 1：一个 key 空间只有一个写者
      return err(
        "key 空间 " +
          key +
          " 已有写者 " +
          existing +
          "，拒绝第二个写者 " +
          writerId,
      );
    },

    async save(scope, ownerId, writerId, snapshot) {
      const key = checkpointKey(scope, ownerId);
      const owner = writers.get(key);
      if (owner === undefined) {
        return err("key 空间 " + key + " 未注册写者，拒绝写入");
      }
      if (owner !== writerId) {
        return err(
          "key 空间 " +
            key +
            " 的写者是 " +
            owner +
            "，拒绝 " +
            writerId +
            " 写入",
        );
      }
      const appended = await backend.append(key, snapshot);
      if (!appended.ok) {
        // ★ 规则 3：失败必须传播
        return err("快照写入失败（" + key + "）: " + appended.error);
      }
      return ok({ key, sequence: appended.value });
    },

    async load(scope, ownerId) {
      return backend.latest(checkpointKey(scope, ownerId));
    },

    writersOf,
  };
}

/**
 * 适配 `LifecycleController` 的落盘端口（S3 的 `ComponentCheckpointPort`）。
 *
 * **做一件额外的事**：校验控制器给出的 key **必须落在自己的空间内** ——
 * 否则组件就可能把快照写进别的空间（跨空间污染）。
 */
export function componentCheckpointPort(
  router: CheckpointRouter,
  componentId: string,
  writerId: string,
): { save(key: string, snapshot: unknown): Promise<Result<void>> } {
  const expected = checkpointKey("component", componentId);
  return {
    save: async (key, snapshot) => {
      if (key !== expected) {
        return err(
          "组件 " +
            componentId +
            " 试图写入非本空间键 " +
            key +
            "（应为 " +
            expected +
            "）",
        );
      }
      const r = await router.save("component", componentId, writerId, snapshot);
      return r.ok ? ok(undefined) : err(r.error);
    },
  };
}

/** 适配 `OuterLoop` 的落盘端口（会话/组装体 + 账本，写在 conversation 空间） */
export function conversationCheckpointPort(
  router: CheckpointRouter,
  dialogueId: string,
  writerId: string,
): { save(key: string, snapshot: unknown): Promise<Result<void>> } {
  const expected = checkpointKey("conversation", dialogueId);
  return {
    save: async (key, snapshot) => {
      if (key !== expected) {
        return err(
          "对话 " +
            dialogueId +
            " 试图写入非本空间键 " +
            key +
            "（应为 " +
            expected +
            "）",
        );
      }
      const r = await router.save(
        "conversation",
        dialogueId,
        writerId,
        snapshot,
      );
      return r.ok ? ok(undefined) : err(r.error);
    },
  };
}
