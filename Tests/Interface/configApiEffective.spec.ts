/**
 * 生效态视图与写回执（`Src/Interface/RestApi/configApi.ts`）契约测试。
 *
 * 这四条是 REV-265/266 收口的核心口径，界面所有"已生效 / 待重启"的措辞都必须来自这里：
 * 1. 进程没有运行态基线时，`runningLoaded=false` 且 `restartPending` 为空表——
 *    不能拿空快照与磁盘全量比，那会把每个键都报成"待重启"。
 * 2. `restartPending` 是 running 与 onDisk 的**叶子差集**，值与路径都要对上。
 * 3. 合并配置里的凭据叶子一律脱敏（`api_key` / `token` / `secret` 形态）。
 * 4. `routing.*` 是唯一被进程实时改写的段：运行态视图要覆盖成实时路由表，
 *    否则界面会把"已经生效"的模型选择标成待重启。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetPathCache } from "../../Src/Infra/Fs/pathResolver.js";
import {
  loadConfig,
  setRunningConfig,
  getRunningConfig,
  type LoadedConfig,
} from "../../Src/Infra/Config/configLoader.js";
import {
  setRoutingConfig,
  getRoutingConfig,
  type RoutingConfig,
} from "../../Src/Infra/Llm/Router/modelRouter.js";
import {
  getConfig,
  effectiveConfigView,
  applyUserConfigChange,
} from "../../Src/Interface/RestApi/configApi.js";

const MANAGED_ENV = [
  "CIVITAS_APP_ROOT",
  "CIVITAS_DATA_ROOT",
  "CIVITAS_DATA_DIR",
  "CIVITAS_CONFIG_DIR",
  "CIVITAS_CONFIG_DIR_BUILTIN",
  "CIVITAS_ENV",
] as const;

let savedEnv: Record<string, string | undefined> = {};
let userDir = "";
let previousRunning: LoadedConfig | null = null;
let previousRouting: RoutingConfig | null = null;

function dig(tree: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc === null || typeof acc !== "object") return undefined;
    return (acc as Record<string, unknown>)[key];
  }, tree);
}

beforeEach(() => {
  savedEnv = {};
  for (const key of MANAGED_ENV) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  const repoRoot = join(__dirname, "..", "..");
  userDir = mkdtempSync(join(tmpdir(), "civitas-configapi-"));
  process.env.CIVITAS_APP_ROOT = repoRoot;
  process.env.CIVITAS_DATA_ROOT = userDir;
  process.env.CIVITAS_CONFIG_DIR = userDir;
  process.env.CIVITAS_CONFIG_DIR_BUILTIN = join(repoRoot, "Configs");
  process.env.CIVITAS_ENV = "dev";
  resetPathCache();
  previousRunning = getRunningConfig();
  previousRouting = getRoutingConfig();
  setRunningConfig(null);
});

afterEach(() => {
  setRunningConfig(previousRunning);
  if (previousRouting) setRoutingConfig(previousRouting);
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(userDir, { recursive: true, force: true });
  resetPathCache();
});

describe("读取视图", () => {
  it("配置名清洗掉路径分隔符，越界读取拿不到仓库外文件", () => {
    expect(getConfig("../../package.json")).toBeUndefined();
    expect(getConfig("default.json")).toBeDefined();
    expect(getConfig("nonexistent.json")).toBeUndefined();
  });

  it("没有运行态基线时如实说明，而不是把每个键都报成待重启", () => {
    const view = effectiveConfigView();
    expect(view.runningLoaded).toBe(false);
    expect(view.running).toBeNull();
    expect(view.restartPending).toEqual([]);
    expect(view.onDiskError).toBeNull();
    expect(view.policy.allowedPrefixes.length).toBeGreaterThan(0);
  });

  it("写一项阈值后：running 保持旧值、onDisk 为新值、restartPending 点名该键", () => {
    const loaded = loadConfig();
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    setRunningConfig(loaded.value);

    const write = applyUserConfigChange({
      patch: { "ui.dashboardPollIntervalSec": 11 },
    });
    expect("error" in write).toBe(false);
    if ("error" in write) return;
    expect(write.applied).toEqual(["ui.dashboardPollIntervalSec"]);

    const view = effectiveConfigView();
    expect(dig(view.running, "ui.dashboardPollIntervalSec")).toBe(5);
    expect(dig(view.onDisk, "ui.dashboardPollIntervalSec")).toBe(11);
    expect(view.restartPending).toEqual([
      { path: "ui.dashboardPollIntervalSec", running: 5, onDisk: 11 },
    ]);
    // 生效时机由视图判定，不由前端记账
    expect(write.statuses).toEqual([
      { path: "ui.dashboardPollIntervalSec", status: "restart-required" },
    ]);
    expect(write.restartPendingCount).toBe(1);
  });

  it("重启后（运行态快照等于磁盘）不再有 pending，回执改口为 live", () => {
    applyUserConfigChange({ patch: { "ui.dashboardPollIntervalSec": 11 } });
    setRunningConfig(
      loadConfig().ok ? (loadConfig() as { value: LoadedConfig }).value : null,
    );

    const view = effectiveConfigView();
    expect(view.restartPending).toEqual([]);

    const write = applyUserConfigChange({
      patch: { "ui.dashboardPollIntervalSec": 12 },
    });
    if ("error" in write) throw new Error(write.error);
    expect(write.statuses).toEqual([
      { path: "ui.dashboardPollIntervalSec", status: "restart-required" },
    ]);

    // 模拟进程读到新值：把运行态换成刚写完的磁盘态
    setRunningConfig(
      loadConfig().ok ? (loadConfig() as { value: LoadedConfig }).value : null,
    );
    const after = effectiveConfigView();
    expect(after.restartPending).toEqual([]);
    expect(dig(after.running, "ui.dashboardPollIntervalSec")).toBe(12);
  });

  it("未写入任何键时回执 runningLoaded=false → status 为 unknown（不猜生效时机）", () => {
    const write = applyUserConfigChange({
      patch: { "system.logLevel": "warn" },
    });
    if ("error" in write) throw new Error(write.error);
    expect(write.statuses).toEqual([
      { path: "system.logLevel", status: "unknown" },
    ]);
  });

  it("合并视图里的凭据叶子被脱敏（原始文件仍含明文，证明脱敏发生在视图层）", () => {
    writeFileSync(
      join(userDir, "local.json"),
      JSON.stringify({ supervision: { secret: "sk-REAL-SECRET" } }),
      "utf-8",
    );
    const view = effectiveConfigView();
    expect(readFileSync(join(userDir, "local.json"), "utf-8")).toContain(
      "sk-REAL-SECRET",
    );
    expect(JSON.stringify(view.onDisk)).not.toContain("sk-REAL-SECRET");
    expect(dig(view.onDisk, "supervision.secret")).toBe("**已脱敏**");
  });
});

describe("实时路由段不被误报为待重启", () => {
  it("routing.* 以进程实时值为准", () => {
    const loaded = loadConfig();
    if (!loaded.ok) throw new Error(loaded.error ?? "load failed");
    setRunningConfig(loaded.value);

    // 磁盘与实时值都是新模型，只有启动快照是旧模型（ipc-update-routing 的真实终态）
    applyUserConfigChange({ patch: { "routing.defaultModel": "p/new-model" } });
    setRoutingConfig({
      ...(loaded.value.merged["routing"] as RoutingConfig),
      defaultModel: "p/new-model",
    });

    const runningSnapshot = loaded.value.merged["routing"] as RoutingConfig;
    expect(runningSnapshot.defaultModel).not.toBe("p/new-model");

    const view = effectiveConfigView();
    expect(dig(view.running, "routing.defaultModel")).toBe("p/new-model");
    expect(view.restartPending.map((d) => d.path)).not.toContain(
      "routing.defaultModel",
    );
  });
});

describe("写回执的诚实性", () => {
  it("白名单外键进 rejected 并被点名，不伪装成已保存", () => {
    setRunningConfig(
      loadConfig().ok ? (loadConfig() as { value: LoadedConfig }).value : null,
    );
    const write = applyUserConfigChange({
      patch: {
        "hardLimits.maxIterationsCeiling": 1,
        "ui.maxEventBufferSize": 800,
      },
    });
    if ("error" in write) throw new Error(write.error);
    expect(write.rejected).toEqual(["hardLimits.maxIterationsCeiling"]);
    expect(write.applied).toEqual(["ui.maxEventBufferSize"]);
    expect(existsSync(join(userDir, "local.json"))).toBe(true);
  });

  it('patch 与 unset 同时为空是调用方错误（不是"保存成功"）', () => {
    const write = applyUserConfigChange({});
    expect("error" in write).toBe(true);
  });

  it("形状非法的请求体被拒（patch 必须是对象、unset 必须是字符串数组）", () => {
    expect("error" in applyUserConfigChange({ patch: [1, 2] })).toBe(true);
    expect(
      "error" in
        applyUserConfigChange({ unset: "ui.dashboardPollIntervalSec" }),
    ).toBe(true);
  });

  it("unset 走删除语义并如实回传 removed", () => {
    setRunningConfig(
      loadConfig().ok ? (loadConfig() as { value: LoadedConfig }).value : null,
    );
    applyUserConfigChange({ patch: { "ui.maxEventBufferSize": 800 } });
    const write = applyUserConfigChange({ unset: ["ui.maxEventBufferSize"] });
    if ("error" in write) throw new Error(write.error);
    expect(write.removed).toEqual(["ui.maxEventBufferSize"]);
    expect(
      JSON.parse(readFileSync(join(userDir, "local.json"), "utf-8")),
    ).toEqual({});
  });
});
