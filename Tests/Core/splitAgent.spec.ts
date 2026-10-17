/**
 * 分裂 Agent 本体验证（`Orchestration/splitAgent`）——⑦ 的"本体"单测。
 *
 * 验证真实产物与失败语义，而不是只测函数存在：
 * - 分裂真的创建了同级 Agent（注册表可见），不是只返回一个 id；
 * - 域账本宿主登记失败时**回收 Agent**（不留半分裂个体）；
 * - 循环启动可按需开关；同级关系确实登记（AgentMerge 的判定输入）；
 * - 回收路径把 Agent 从注册表移除。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initDatabase, closeDatabase } from "../../Src/Infra/Db/database.js";
import { initMigrations, migrateUp } from "../../Src/Infra/Db/migrations.js";
import {
  getAgent,
  resetAgentRegistry,
} from "../../Src/Core/AgentRuntime/agentRegistry.js";
import { resetAgentFactory } from "../../Src/Core/AgentRuntime/agentFactory.js";
import {
  spawnSiblingAgent,
  abandonSiblingAgent,
  type SplitAgentDeps,
} from "../../Src/Core/Orchestration/splitAgent.js";
import {
  isPeerSplit,
  resetSplitSemantics,
} from "../../Src/Core/AgentRuntime/splitSemantics.js";
import { ok, err } from "../../Src/Infra/types.js";

let dir = "";

function makeDeps(overrides: Partial<SplitAgentDeps> = {}): {
  deps: SplitAgentDeps;
  openHost: ReturnType<typeof vi.fn>;
  closeHost: ReturnType<typeof vi.fn>;
  startLoop: ReturnType<typeof vi.fn>;
} {
  const openHost = vi.fn(() => ok(undefined));
  const closeHost = vi.fn(() => ok(undefined));
  const startLoop = vi.fn(async () => ok(undefined));
  const deps: SplitAgentDeps = {
    openHost: openHost as never,
    closeHost: closeHost as never,
    startLoop: startLoop as never,
    ...overrides,
  };
  return { deps, openHost, closeHost, startLoop };
}

describe("分裂 Agent 本体（Orchestration/splitAgent）", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "civitas-split-agent-"));
    mkdirSync(dir, { recursive: true });
    initDatabase({
      mainPath: join(dir, "main.db"),
      eventsPath: join(dir, "events.db"),
      memoryPath: join(dir, "memory.db"),
      walMode: true,
      busyTimeoutMs: 5_000,
    });
    initMigrations();
    migrateUp();
    resetAgentRegistry();
    resetAgentFactory();
    resetSplitSemantics();
  });

  afterEach(() => {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });

  it("真实创建同级 Agent + 登记域账本 + 启动循环 + 登记同级关系", async () => {
    const { deps, openHost, startLoop } = makeDeps();
    const spawned = await spawnSiblingAgent(
      {
        parentAgentId: "agent-l1-parent",
        task: "完成迁移脚本",
        conflictDomain: "db-migration",
      },
      deps,
    );
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) return;

    const peer = getAgent(spawned.value.peerId);
    expect(peer).toBeDefined();
    expect(peer?.role).toBe("partner");
    expect(openHost).toHaveBeenCalledWith(spawned.value.peerId);
    expect(startLoop).toHaveBeenCalledTimes(1);
    expect(spawned.value.loopStarted).toBe(true);
    expect(isPeerSplit("agent-l1-parent", spawned.value.peerId)).toBe(true);
  });

  it("宿主登记失败 ⇒ 回收 Agent（不留半分裂个体）", async () => {
    const { deps } = makeDeps({
      openHost: vi.fn(() => err("rootId 不一致")) as never,
    });
    const spawned = await spawnSiblingAgent(
      {
        parentAgentId: "agent-l1-parent",
        task: "任务",
        conflictDomain: "domain-x",
      },
      deps,
    );
    expect(spawned.ok).toBe(false);
    // 无法从返回值拿 peerId，但注册表里不应留下任何 partner 级 Agent
    const agents = ["agent-partner-1", "agent-partner-2", "agent-partner-3"]
      .map((id) => getAgent(id))
      .filter(Boolean);
    expect(agents).toHaveLength(0);
  });

  it("startLoop=false ⇒ 只建 Agent 不跑循环（干跑语义）", async () => {
    const { deps, startLoop } = makeDeps();
    const spawned = await spawnSiblingAgent(
      {
        parentAgentId: "agent-l1-parent",
        task: "任务",
        conflictDomain: "domain-y",
        startLoop: false,
      },
      deps,
    );
    expect(spawned.ok).toBe(true);
    expect(spawned.ok && spawned.value.loopStarted).toBe(false);
    expect(startLoop).not.toHaveBeenCalled();
  });

  it("回收：Agent 从注册表移除并关闭宿主", async () => {
    const { deps, closeHost } = makeDeps();
    const spawned = await spawnSiblingAgent(
      {
        parentAgentId: "agent-l1-parent",
        task: "任务",
        conflictDomain: "domain-z",
      },
      deps,
    );
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) return;
    const peerId = spawned.value.peerId;
    expect(getAgent(peerId)).toBeDefined();

    await abandonSiblingAgent(peerId, deps);
    expect(getAgent(peerId)).toBeUndefined();
    expect(closeHost).toHaveBeenCalledWith(peerId);
  });
});
