/**
 * 编排运行时 P1 验证（融合落地）：
 *
 * 验证"组装闭环真的落盘 + 审计 + 可被工具的端口使用"，而不是只测函数存在：
 * - 目录 = 六个固定模式（A 侧），且冻结（运行期不可注册）；
 * - 初始组装体 = DIRECT，工具端口拿到真实 current/catalog；
 * - compose 合法变更 ⇒ 组装体提交 + 落盘文件出现 + 治理台账留痕；
 * - compose 悬空引用 ⇒ 拒绝（不落盘）；
 * - select 非组装体成员 ⇒ 拒绝。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initDatabase, closeDatabase } from "../../Src/Infra/Db/database.js";
import { initMigrations, migrateUp } from "../../Src/Infra/Db/migrations.js";
import {
  setActiveOwner,
  LOCAL_OWNER,
} from "../../Src/Services/AccountScope/activeAccount.js";
import { ROUTING_MODES } from "../../Src/Core/Decision/types.js";
import {
  initOrchestrationRuntime,
  getOrchestrationPort,
  currentAssemblySpec,
  resetOrchestrationRuntime,
} from "../../Src/Core/Orchestration/orchestrationRuntime.js";
import { listGovernanceRecords } from "../../Src/Services/Governance/governanceAudit.js";

let dir = "";

describe("编排运行时（P1：组装子系统生产组合根）", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "civitas-orch-runtime-"));
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
    setActiveOwner(LOCAL_OWNER);
    resetOrchestrationRuntime();
  });

  afterEach(() => {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });

  it("初始化后：目录为六个固定模式、当前组装体为 DIRECT、端口可用", () => {
    const init = initOrchestrationRuntime({
      dataDir: join(dir, "orchestration"),
    });
    expect(init.ok).toBe(true);

    const port = getOrchestrationPort();
    expect(port).toBeDefined();
    expect(
      port
        ?.catalog()
        .map((c) => c.id)
        .sort(),
    ).toEqual([...ROUTING_MODES].sort());
    expect(port?.currentAssembly().id).toBe("A-DIRECT");
    expect(port?.currentAssembly().executables).toEqual(["DIRECT"]);
    expect(currentAssemblySpec()?.id).toBe("A-DIRECT");
  });

  it("compose 合法变更 ⇒ 提交成功 + 落盘 + 治理审计留痕", async () => {
    const init = initOrchestrationRuntime({
      dataDir: join(dir, "orchestration"),
    });
    expect(init.ok).toBe(true);
    const port = getOrchestrationPort()!;

    const out = await port.compose({
      by: "agent-l1-compose",
      change: { op: "add", added: { id: "DELEGATION" } },
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.value.committed).toBe(true);

    const assembly = port.currentAssembly();
    expect(assembly.executables).toEqual(["DIRECT", "DELEGATION"]);

    const persistedPath = join(dir, "orchestration", "assemblies.json");
    expect(existsSync(persistedPath)).toBe(true);
    const persisted = JSON.parse(readFileSync(persistedPath, "utf8")) as {
      currentId: string;
      assemblies: Record<string, { executables: string[] }>;
    };
    expect(persisted.assemblies["A-DIRECT"]?.executables).toEqual([
      "DIRECT",
      "DELEGATION",
    ]);

    // 治理台账：哈希链留痕（真实落库路径）
    const records = listGovernanceRecords();
    expect(
      records.some((r) => r.action === "orchestration.assembly_commit"),
    ).toBe(true);
  });

  it("compose 悬空引用 ⇒ 校验拒绝（committed=false）且不落盘", async () => {
    const init = initOrchestrationRuntime({
      dataDir: join(dir, "orchestration"),
    });
    expect(init.ok).toBe(true);
    const port = getOrchestrationPort()!;

    const out = await port.compose({
      by: "agent-l1-compose",
      change: { op: "add", added: { id: "GHOST-MODE" } },
    });
    // 校验不通过是**闭环判定**（带判据/定位），不是端口错误
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value.committed).toBe(false);
      expect(out.value.violations.length).toBeGreaterThan(0);
    }
    expect(port.currentAssembly().executables).toEqual(["DIRECT"]);
    expect(existsSync(join(dir, "orchestration", "assemblies.json"))).toBe(
      false,
    );
  });

  it("select 非组装体成员 ⇒ 拒绝；成员 ⇒ 选中", () => {
    const init = initOrchestrationRuntime({
      dataDir: join(dir, "orchestration"),
    });
    expect(init.ok).toBe(true);
    const port = getOrchestrationPort()!;

    expect(port.select("DELEGATION").ok).toBe(false);
    const okSel = port.select("DIRECT");
    expect(okSel.ok).toBe(true);
    if (okSel.ok) expect(okSel.value.selected).toBe("DIRECT");
  });
});
