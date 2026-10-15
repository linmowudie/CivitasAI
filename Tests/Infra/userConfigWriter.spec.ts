/**
 * 用户配置写路径（`Src/Infra/Config/userConfigWriter.ts`）契约测试。
 *
 * 锁死 P0-4 收口时真机取证到的四条不变式（取证记录见 Bug 登记 §16.10）：
 * 1. 白名单/红线：`hardLimits.` `security.` `database.` 与 `NEVER_WRITABLE` 一律 `rejected`，
 *    且**一个都没被接受时不写文件**（否则"全拒绝"也会创建/改动用户覆盖层）。
 * 2. 写前试跑启动校验器：跨字段违规（预算档位次序）整批 `err` 返回，
 *    同批里合法的键也不落盘——不允许"界面保存成功、下次启动失败"。
 * 3. 深度合并不吃掉兄弟键（只写 `stopRules.limits.maxIterations` 不能清掉 `maxWallClockMs`）。
 * 4. 重置 = 删除覆盖并剪空父对象，删除后文件必须与内置默认重新一致。
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

import {
  resetPathCache,
  getConfigDir,
  getBundledConfigDir,
} from "../../Src/Infra/Fs/pathResolver.js";
import {
  writeUserConfig,
  removeUserConfig,
  readUserConfig,
  getUserConfigPath,
  getUserConfigPolicy,
  isAllowedConfigPath,
} from "../../Src/Infra/Config/userConfigWriter.js";

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

/** 仓库内置 Configs 作为基线（只读使用），用户层写进临时目录 */
function sandbox(): void {
  savedEnv = {};
  for (const key of MANAGED_ENV) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  const repoRoot = join(__dirname, "..", "..");
  userDir = mkdtempSync(join(tmpdir(), "civitas-usercfg-"));
  process.env.CIVITAS_APP_ROOT = repoRoot;
  process.env.CIVITAS_DATA_ROOT = userDir;
  process.env.CIVITAS_CONFIG_DIR = userDir;
  process.env.CIVITAS_CONFIG_DIR_BUILTIN = join(repoRoot, "Configs");
  process.env.CIVITAS_ENV = "dev";
  resetPathCache();
}

function fileContent(): Record<string, unknown> {
  return JSON.parse(readFileSync(getUserConfigPath(), "utf-8")) as Record<
    string,
    unknown
  >;
}

beforeEach(sandbox);

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(userDir, { recursive: true, force: true });
  resetPathCache();
});

describe("白名单与红线", () => {
  it('策略视图与白名单一致（UI 依据它标注"后端不接受"）', () => {
    const policy = getUserConfigPolicy();
    expect(policy.allowedPrefixes).toContain("ui.");
    expect(policy.allowedPrefixes).toContain("routing.");
    expect(policy.neverWritable).toContain("server.apiToken");
    expect(isAllowedConfigPath("loopDefaults.max_iterations")).toBe(true);
    expect(isAllowedConfigPath("hardLimits.maxIterationsCeiling")).toBe(false);
    expect(isAllowedConfigPath("security.sandboxDefaultMode")).toBe(false);
    expect(isAllowedConfigPath("database.mainPath")).toBe(false);
  });

  it("段内红线键即使在白名单段里也拒绝（eventBus.store / retention 永久留存）", () => {
    expect(isAllowedConfigPath("eventBus.store")).toBe(false);
    expect(isAllowedConfigPath("retention.longTermMemoryPermanent")).toBe(
      false,
    );
    expect(isAllowedConfigPath("supervision.approvalDefaultOnTimeout")).toBe(
      false,
    );
    expect(isAllowedConfigPath("supervision.qualityThreshold")).toBe(true);
  });

  it("全部被拒绝时不创建用户配置文件", () => {
    const res = writeUserConfig({
      "server.apiToken": "x".repeat(32),
      "hardLimits.maxIterationsCeiling": 1,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.applied).toEqual([]);
    expect(res.value.rejected).toEqual([
      "server.apiToken",
      "hardLimits.maxIterationsCeiling",
    ]);
    expect(existsSync(getUserConfigPath())).toBe(false);
  });

  it("合法键写入、非法取值进 invalid 且不落盘", () => {
    const res = writeUserConfig({
      "ui.dashboardPollIntervalSec": 11,
      "server.httpPort": 70000,
      "system.logLevel": "trace",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.applied).toEqual(["ui.dashboardPollIntervalSec"]);
    expect(res.value.invalid.map((i) => i.path).sort()).toEqual([
      "server.httpPort",
      "system.logLevel",
    ]);
    expect(fileContent()).toEqual({ ui: { dashboardPollIntervalSec: 11 } });
  });

  it('标量/数组覆写"对象段"→ 逐项 invalid，同批合法键照常落盘', () => {
    // REV-331：`validateShape` 现在与基线同路径比对形态。修复前这些键会被 `applied` 接受，
    // 只有 `stopRules.budget` 恰好被启动校验器（比例递增）抓住，`supervision.rateLimit`/`economy.tax`
    // 则整段消失却"写成功"。
    const res = writeUserConfig({
      "supervision.rateLimit": 1,
      "economy.tax": ["a", "b"],
      "stopRules.budget": 1,
      "ui.streamFlushIntervalMs": null,
      "ui.dashboardPollIntervalSec": 11,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.applied).toEqual(["ui.dashboardPollIntervalSec"]);
    expect(res.value.invalid.map((i) => i.path).sort()).toEqual([
      "economy.tax",
      "stopRules.budget",
      "supervision.rateLimit",
      "ui.streamFlushIntervalMs",
    ]);
    expect(
      res.value.invalid.find((i) => i.path === "supervision.rateLimit")?.reason,
    ).toContain("配置段");
    expect(fileContent()).toEqual({ ui: { dashboardPollIntervalSec: 11 } });
  });

  it("逐子键写对象段仍然放行（配对规则不是禁止写段）", () => {
    const res = writeUserConfig({
      "supervision.rateLimit.maxRequestsPerMinute": 60,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.applied).toEqual([
      "supervision.rateLimit.maxRequestsPerMinute",
    ]);
    expect(fileContent()).toEqual({
      supervision: { rateLimit: { maxRequestsPerMinute: 60 } },
    });
  });
});

describe("远程访问配对（REV-330）", () => {
  it("host 非回环 + allowRemoteAccess=true 且无凭据 → 两键都 invalid 且不落盘", () => {
    const res = writeUserConfig({
      "server.host": "0.0.0.0",
      "server.allowRemoteAccess": true,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.applied).toEqual([]);
    expect(res.value.invalid.map((i) => i.path).sort()).toEqual([
      "server.allowRemoteAccess",
      "server.host",
    ]);
    expect(res.value.invalid[0]?.reason).toContain("server.apiToken");
    expect(existsSync(getUserConfigPath())).toBe(false);
  });

  it("基线里已有可用 server.apiToken（配置文件层）时放行", () => {
    writeFileSync(
      getUserConfigPath(),
      JSON.stringify({ server: { apiToken: "x".repeat(32) } }),
      "utf-8",
    );
    const res = writeUserConfig({
      "server.host": "192.168.1.20",
      "server.allowRemoteAccess": true,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.applied.sort()).toEqual([
      "server.allowRemoteAccess",
      "server.host",
    ]);
  });

  it("只开 allowRemoteAccess 而 host 仍是回环 → 不构成锁门，放行", () => {
    const res = writeUserConfig({ "server.allowRemoteAccess": true });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.applied).toEqual(["server.allowRemoteAccess"]);
  });

  it("host 改非回环但未授权远程 → 放行（bindPolicy 会回退 127.0.0.1）", () => {
    const res = writeUserConfig({ "server.host": "192.168.1.20" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.applied).toEqual(["server.host"]);
  });
});

describe("写前试跑启动校验器（REV-265 的硬约束）", () => {
  it("跨字段违规整批拒绝，同批合法键也不落盘", () => {
    const before = existsSync(getUserConfigPath())
      ? readFileSync(getUserConfigPath(), "utf-8")
      : null;
    const res = writeUserConfig({
      "stopRules.budget.softRatio": 0.3,
      "loopDefaults.max_iterations": 99,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("未通过配置校验");
    expect(res.error).toContain("比例必须递增");
    // 关键：既没写坏值，也没写那个"看起来合法"的键
    expect(
      existsSync(getUserConfigPath())
        ? readFileSync(getUserConfigPath(), "utf-8")
        : null,
    ).toBe(before);
  });

  it('基线本身自洽时，合法调整可以通过（证明不是"一律拒绝"）', () => {
    const res = writeUserConfig({ "stopRules.limits.maxIterations": 47 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.applied).toEqual(["stopRules.limits.maxIterations"]);
    expect(fileContent()).toEqual({
      stopRules: { limits: { maxIterations: 47 } },
    });
  });

  it("现有用户层已不可启动时拒绝继续覆盖（不越写越坏）", () => {
    writeFileSync(
      getUserConfigPath(),
      JSON.stringify({
        stopRules: {
          budget: {
            warmRatio: 0.9,
            softRatio: 0.3,
            expandRequestRatio: 0.8,
            hardRatio: 1,
          },
        },
      }),
      "utf-8",
    );
    const res = writeUserConfig({ "ui.maxEventBufferSize": 800 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/现有配置|未通过配置校验/);
    // 拒绝时不能把坏层"顺手改写"：原文件保持不动
    expect(fileContent()).toEqual({
      stopRules: {
        budget: {
          warmRatio: 0.9,
          softRatio: 0.3,
          expandRequestRatio: 0.8,
          hardRatio: 1,
        },
      },
    });
  });
});

describe("合并语义与重置", () => {
  it("只写一个子键不会清掉同段兄弟键", () => {
    writeFileSync(
      getUserConfigPath(),
      JSON.stringify({
        stopRules: { limits: { maxIterations: 30, maxWallClockMs: 900000 } },
      }),
      "utf-8",
    );
    const res = writeUserConfig({ "stopRules.limits.maxIterations": 42 });
    expect(res.ok).toBe(true);
    expect(fileContent()).toEqual({
      stopRules: { limits: { maxIterations: 42, maxWallClockMs: 900000 } },
    });
  });

  it("removeUserConfig 删除路径并剪掉空父对象", () => {
    writeUserConfig({
      "stopRules.limits.maxIterations": 42,
      "ui.dashboardPollIntervalSec": 11,
    });
    const res = removeUserConfig(["stopRules.limits.maxIterations"]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.removed).toEqual(["stopRules.limits.maxIterations"]);
    expect(fileContent()).toEqual({ ui: { dashboardPollIntervalSec: 11 } });
  });

  it("未写过的路径报 absent，白名单外报 rejected", () => {
    const res = removeUserConfig([
      "routing.defaultModel",
      "security.forbidden",
    ]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.rejected).toEqual(["security.forbidden"]);
    expect(res.value.removed).toEqual([]);
  });

  it("readUserConfig 与写后内容一致（effective 视图的 onDisk 半边同源）", () => {
    writeUserConfig({
      "system.logLevel": "warn",
      "ui.maxEventBufferSize": 800,
    });
    expect(readUserConfig()).toEqual({
      system: { logLevel: "warn" },
      ui: { maxEventBufferSize: 800 },
    });
    expect(getConfigDir()).toBe(userDir);
    expect(getBundledConfigDir()).not.toBe(userDir);
  });
});
