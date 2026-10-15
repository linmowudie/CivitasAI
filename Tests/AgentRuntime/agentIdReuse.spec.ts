/**
 * Agent ID 跨进程不复用（P0-4 取证时发现的存量缺陷）。
 *
 * 取证实况：真实后端里 `POST /api/tasks` 提交的**每一条**任务都失败，回执是
 * `Agent agent-prime_director-1 已注册`。根因：`agentFactory` 的 ID 计数器是进程内存量，
 * 重启即归零，而 `hydrateAgents()` 会把库里未销毁的 Agent 回灌进内存 —— 首次 createAgent
 * 就撞上回灌实例，`registerAgent` 直接失败。已销毁的行更隐蔽：内存里没有，
 * 于是写透 upsert 按 `agent_id` 覆盖历史行，**审计痕迹被抹掉**。
 *
 * 本文件用真实数据库模拟"重启"，锁住两件事：
 *  1. 新分配的序号必须高于库里出现过的最大序号（含已销毁行）；
 *  2. 历史行（含已销毁行）不被新 Agent 覆盖。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve, join } from "node:path";
import { existsSync, rmSync, mkdirSync } from "node:fs";

import {
  initDatabase,
  closeDatabase,
  getMainDb,
} from "../../Src/Infra/Db/database.js";
import {
  initMigrations,
  clearMigrations,
  migrateUp,
} from "../../Src/Infra/Db/migrations.js";
import {
  setActiveOwner,
  LOCAL_OWNER,
} from "../../Src/Services/AccountScope/activeAccount.js";
import {
  createAgent,
  resetAgentFactory,
} from "../../Src/Core/AgentRuntime/agentFactory.js";
import {
  resetAgentRegistry,
  hydrateAgents,
} from "../../Src/Core/AgentRuntime/agentRegistry.js";

const TEST_DB_DIR = resolve(
  import.meta.dirname,
  "../../.tmp/test-db-agent-id-reuse",
);

function initTestDb(): void {
  closeDatabase();
  clearMigrations();
  if (existsSync(TEST_DB_DIR))
    rmSync(TEST_DB_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DB_DIR, { recursive: true });
  const result = initDatabase({
    mainPath: join(TEST_DB_DIR, "test_main.db"),
    eventsPath: join(TEST_DB_DIR, "test_events.db"),
    memoryPath: join(TEST_DB_DIR, "test_memory.db"),
    walMode: true,
    busyTimeoutMs: 5000,
  });
  expect(result.ok).toBe(true);
  initMigrations();
  migrateUp();
  setActiveOwner(LOCAL_OWNER);
}

/** 直接写历史行（模拟"上个进程留下的数据"），可控地制造高序号与已销毁行 */
function insertHistoricalAgent(
  agentId: string,
  opts: { destroyedAt?: number | null } = {},
): void {
  getMainDb()
    .prepare(
      `INSERT INTO agents (agent_id, trace_id, role, system_prompt, trust_level, status, created_at, destroyed_at, owner_user_id)
     VALUES (?, 'trace-old', ?, '', 'L1', 'ready', 1790000000000, ?, ?)`,
    )
    .run(
      agentId,
      agentId.replace(/^agent-/, "").replace(/-\d+$/, ""),
      opts.destroyedAt ?? null,
      LOCAL_OWNER,
    );
}

function rowOf(agentId: string): Record<string, unknown> {
  return getMainDb()
    .prepare("SELECT * FROM agents WHERE agent_id = ?")
    .get(agentId) as Record<string, unknown>;
}

describe("Agent ID 跨进程不复用", () => {
  beforeEach(() => {
    initTestDb();
    resetAgentRegistry();
    resetAgentFactory();
  });

  afterEach(() => {
    closeDatabase();
    clearMigrations();
    if (existsSync(TEST_DB_DIR))
      rmSync(TEST_DB_DIR, { recursive: true, force: true });
  });

  it("重启后首次分配避开回灌实例（此前必然撞名并失败）", () => {
    // 上个进程留下的、**未销毁**的实例：本次启动会被 hydrateAgents 回灌进内存
    insertHistoricalAgent("agent-prime_director-4");
    // 已销毁的历史行：不在内存，但 ID 同样不能复用（否则覆盖审计行）
    insertHistoricalAgent("agent-worker-9", { destroyedAt: 1790000009999 });
    resetAgentFactory();
    resetAgentRegistry();
    const restored = hydrateAgents();
    expect(restored).toBe(1);

    const director = createAgent(
      { role: "prime_director", model: "test-model" },
      "trace-new",
    );
    expect(director.ok).toBe(true);
    if (!director.ok) return;
    // 9 是库里最大序号 ⇒ 新 ID 必须落在 10 之后，既不是回灌的 -4，也不是历史的 -9
    const seq = Number(/-(\d+)$/.exec(director.value.agentId)?.[1] ?? 0);
    expect(seq).toBeGreaterThan(9);

    const worker = createAgent(
      { role: "worker", model: "test-model" },
      "trace-new",
    );
    expect(worker.ok).toBe(true);
  });

  it("历史行（含已销毁行）不被新 Agent 覆盖", () => {
    insertHistoricalAgent("agent-prime_director-4");
    insertHistoricalAgent("agent-worker-9", { destroyedAt: 1790000009999 });
    resetAgentFactory();
    resetAgentRegistry();
    hydrateAgents();

    const created = createAgent(
      { role: "worker", model: "test-model" },
      "trace-new",
    );
    expect(created.ok).toBe(true);

    const oldDestroyed = rowOf("agent-worker-9");
    expect(oldDestroyed["created_at"]).toBe(1790000000000);
    expect(oldDestroyed["destroyed_at"]).toBe(1790000009999);
    expect(oldDestroyed["trace_id"]).toBe("trace-old");
  });

  it("同进程内连续创建不复用 ID（回灌后仍能提交多个任务）", () => {
    insertHistoricalAgent("agent-prime_director-4");
    resetAgentFactory();
    resetAgentRegistry();
    hydrateAgents();

    const ids = [
      createAgent({ role: "worker", model: "m" }, "t1"),
      createAgent({ role: "worker", model: "m" }, "t1"),
      createAgent({ role: "worker", model: "m" }, "t1"),
    ];
    for (const r of ids) expect(r.ok).toBe(true);
    const values = ids.map((r) => (r.ok ? r.value.agentId : ""));
    expect(new Set(values).size).toBe(3);
  });
});
