/**
 * S4 · DB 支撑的落盘通道（真实数据库往返）
 *
 * 目的：证明"key 空间分区"不只是内存里的语义 —— 落到既有持久化件（loop_checkpoints 表）
 * 之后仍然**两个空间互不覆盖**、**单写者**、**可读回**。
 *
 * 同时集成验证 S3：`LifecycleController` 的 `suspend` 走**真实路由**落盘。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

import { initDatabase, closeDatabase } from "../../Src/Infra/Db/database.js";
import { initMigrations, migrateUp } from "../../Src/Infra/Db/migrations.js";
import {
  createCheckpointRouter,
  componentCheckpointPort,
  conversationCheckpointPort,
  checkpointKey,
} from "../../Src/Core/Durable/checkpointRouter.js";
import { createDbCheckpointBackend } from "../../Src/Core/Durable/dbCheckpointBackend.js";
import { createLifecycleController } from "../../Src/Core/Lifecycle/lifecycleController.js";
import type { LifecycleCtx } from "../../Src/Core/Lifecycle/lifecycleTypes.js";

const TEST_DB_DIR = resolve(import.meta.dirname, "..", "..", ".tmp", "s4-db");

function cleanup(): void {
  if (existsSync(TEST_DB_DIR))
    rmSync(TEST_DB_DIR, { recursive: true, force: true });
}

function initTestDb(): void {
  cleanup();
  mkdirSync(TEST_DB_DIR, { recursive: true });
  initDatabase({
    mainPath: join(TEST_DB_DIR, "test_main.db"),
    eventsPath: join(TEST_DB_DIR, "test_events.db"),
    memoryPath: join(TEST_DB_DIR, "test_memory.db"),
    walMode: true,
    busyTimeoutMs: 5000,
  });
  initMigrations();
  migrateUp();
}

describe("S4 · DB 支撑的落盘通道", () => {
  beforeEach(() => {
    initTestDb();
  });
  afterEach(() => {
    closeDatabase();
    cleanup();
  });

  it("两个空间各自往返，互不覆盖（同一 ownerId）", async () => {
    const router = createCheckpointRouter(createDbCheckpointBackend());
    router.registerWriter("component", "same", "w-comp");
    router.registerWriter("conversation", "same", "w-conv");

    const a = await router.save("component", "same", "w-comp", {
      from: "component",
      n: 1,
    });
    const b = await router.save("conversation", "same", "w-conv", {
      from: "conversation",
      n: 2,
    });
    expect(a.ok ? "ok" : a.error).toBe("ok");
    expect(b.ok ? "ok" : b.error).toBe("ok");

    const comp = await router.load("component", "same");
    const conv = await router.load("conversation", "same");
    expect(comp.ok && comp.value).toEqual({ from: "component", n: 1 });
    expect(conv.ok && conv.value).toEqual({ from: "conversation", n: 2 });
  });

  it("序列跨进程语义：连续写入序号递增，load 取最新", async () => {
    const router = createCheckpointRouter(createDbCheckpointBackend());
    router.registerWriter("component", "c-seq", "w1");
    const s1 = await router.save("component", "c-seq", "w1", { step: 1 });
    const s2 = await router.save("component", "c-seq", "w1", { step: 2 });
    const s3 = await router.save("component", "c-seq", "w1", { step: 3 });
    expect(s1.ok && s1.value.sequence).toBe(1);
    expect(s2.ok && s2.value.sequence).toBe(2);
    expect(s3.ok && s3.value.sequence).toBe(3);
    const loaded = await router.load("component", "c-seq");
    expect(loaded.ok && loaded.value).toEqual({ step: 3 });
  });

  it("【负向】DB 后端下，非注册写者写入仍被拒（规则不因后端而变）", async () => {
    const router = createCheckpointRouter(createDbCheckpointBackend());
    router.registerWriter("conversation", "d-x", "outer");
    const bad = await router.save("conversation", "d-x", "intruder", { a: 1 });
    expect(bad.ok).toBe(false);
  });

  it("【集成】LifecycleController 的 suspend 经真实路由落盘，且落在 component 空间", async () => {
    const router = createCheckpointRouter(createDbCheckpointBackend());
    router.registerWriter("component", "comp-int", "c1-writer");
    const port = componentCheckpointPort(router, "comp-int", "c1-writer");

    const controller = createLifecycleController({
      askModel: async () => ({
        next: "suspend",
        until: "child",
        refs: ["kid-1"],
      }),
      checkpoint: port,
    });
    expect(controller.ok).toBe(true);
    if (!controller.ok) return;

    const ctx: LifecycleCtx = {
      componentId: "comp-int",
      outstanding: ["kid-1"],
      produced: [],
      dependencySatisfied: true,
      budgetRemaining: 10,
      now: 1,
    };
    const out = await controller.value.onEvent("iteration.exited", ctx);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.value.next).toBe("suspend");
    expect(controller.value.getState()).toBe("suspend");

    // 快照确实落到了 component 空间，且含决策内容
    const saved = await router.load("component", "comp-int");
    expect(saved.ok).toBe(true);
    if (saved.ok) {
      const snap = saved.value as {
        state?: string;
        decision?: { next?: string };
      } | null;
      expect(snap?.state).toBe("suspend");
      expect(snap?.decision?.next).toBe("suspend");
    }
  });

  it("【负向·集成】控制器若把键给错空间 ⇒ 落盘被拒，且状态**不得**推进为 suspend", async () => {
    const router = createCheckpointRouter(createDbCheckpointBackend());
    router.registerWriter("component", "comp-bad", "w1");
    const wrongPort = {
      save: async (_key: string, _snapshot: unknown) => {
        // 模拟"控制器把键写成了别的空间"
        const r = await router.save(
          "conversation",
          "comp-bad",
          "w1",
          _snapshot,
        );
        return r.ok
          ? { ok: true as const, value: undefined }
          : { ok: false as const, error: r.error };
      },
    };

    const controller = createLifecycleController({
      askModel: async () => ({
        next: "suspend",
        until: "child",
        refs: ["kid-1"],
      }),
      checkpoint: wrongPort,
    });
    if (!controller.ok) return;
    const ctx: LifecycleCtx = {
      componentId: "comp-bad",
      outstanding: ["kid-1"],
      produced: [],
      dependencySatisfied: true,
      budgetRemaining: 10,
      now: 1,
    };
    const out = await controller.value.onEvent("iteration.exited", ctx);
    expect(out.ok).toBe(false);
    expect(controller.value.getState()).toBe("running");
    // 且 conversation 空间确实没被写进去（未注册写者 ⇒ 拒绝）
    const conv = await router.load("conversation", "comp-bad");
    expect(conv.ok && conv.value).toBeNull();
    expect(checkpointKey("conversation", "comp-bad")).toBe(
      "ckpt:conversation:comp-bad",
    );
  });
});
