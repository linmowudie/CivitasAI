/**
 * @module Sandbox/processSandbox
 * @description **进程级沙箱执行器**（TOOL-SEC-SANDBOX 的真实承载，2026-10-17）。
 *
 * 背景：此前 `sandboxMode: 'strict'` 只有声明、没有执行方；`createDefaultSandboxGate()`
 * 硬编码 `isAvailable: () => true`（荣誉制）。本模块提供可探测、可执行的真实承载：
 *
 * - **能力探测**（`probeSandboxCapability`）：真实检查工作区可写、子进程可启动、平台支持，
 *   而不是"默认恒 true"；
 * - **受控执行**（`runSandboxedCommand`）：子进程执行 + **环境变量白名单**（剔除
 *   KEY/SECRET/TOKEN/PASSWORD/CREDENTIAL 等敏感变量，防止把模型凭据泄给子进程）+
 *   **cwd 强制收敛到工作区** + 超时 + 输出上限。
 *
 * 边界（如实声明）：这是**进程级**承载（env 收敛 / cwd 收敛 / 超时 / 输出上限），
 * 不是内核级安全边界。`sandboxGate` 据此判定 `strict/standard` 是否可用；
 * 内核级隔离（AppContainer/seccomp/job object）仍是后续专项。
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

import { getWorkspaceRoot } from "../Fs/pathResolver.js";
import { logger } from "../Logging/logger.js";

/** 沙箱承载能力（可探测） */
export interface SandboxCapability {
  available: boolean;
  /** 承载形态（当前恒为 process 级） */
  level: "process";
  reason?: string;
  capabilities: {
    envSanitized: boolean;
    cwdConfined: boolean;
    timeoutEnforced: boolean;
    outputCapped: boolean;
  };
}

/** 环境变量保留清单（其余一律剔除；含凭据特征的变量即使命中清单也剔除） */
const ENV_ALLOWLIST = [
  "PATH",
  "Path",
  "SystemRoot",
  "SystemDrive",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "TEMP",
  "TMP",
  "HOME",
  "USERPROFILE",
  "LANG",
  "LC_ALL",
  "SHELL",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "OS",
];

/** 命中任一模式即视为凭据变量，绝不透传给子进程 */
const SECRET_ENV_PATTERN =
  /(KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION)/i;

function buildSanitizedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ENV_ALLOWLIST) {
    const value = process.env[name];
    if (value !== undefined && !SECRET_ENV_PATTERN.test(name))
      env[name] = value;
  }
  return env;
}

let cachedCapability: SandboxCapability | null = null;

/**
 * 探测沙箱承载能力（结果缓存；真实检查而非硬编码）。
 *
 * 检查项：工作区根可创建/可写、当前运行时能启动子进程、平台受支持。
 */
export function probeSandboxCapability(): SandboxCapability {
  if (cachedCapability) return cachedCapability;

  const capability: SandboxCapability = {
    available: false,
    level: "process",
    capabilities: {
      envSanitized: true,
      cwdConfined: true,
      timeoutEnforced: true,
      outputCapped: true,
    },
  };

  const supportedPlatforms = new Set(["win32", "linux", "darwin"]);
  if (!supportedPlatforms.has(process.platform)) {
    capability.reason = `平台 ${process.platform} 无进程沙箱承载`;
    cachedCapability = capability;
    return capability;
  }

  // 工作区可写性：沙箱执行必须有可收敛的 cwd
  let workspaceRoot = "";
  try {
    workspaceRoot = getWorkspaceRoot();
    mkdirSync(workspaceRoot, { recursive: true });
    if (!statSync(workspaceRoot).isDirectory()) {
      capability.reason = `工作区根不是目录: ${workspaceRoot}`;
      cachedCapability = capability;
      return capability;
    }
  } catch (e) {
    capability.reason = `工作区根不可写: ${e instanceof Error ? e.message : String(e)}`;
    cachedCapability = capability;
    return capability;
  }

  // 子进程可启动性：用当前 Node 解释器做一次最小自检
  try {
    const probe = spawnSync(process.execPath, ["-e", "process.exit(0)"], {
      env: buildSanitizedEnv(),
      cwd: workspaceRoot,
      timeout: 5_000,
      windowsHide: true,
      stdio: "ignore",
    });
    if (probe.status !== 0) {
      capability.reason = `子进程自检失败（status=${String(probe.status)}）`;
      cachedCapability = capability;
      return capability;
    }
  } catch (e) {
    capability.reason = `无法启动子进程: ${e instanceof Error ? e.message : String(e)}`;
    cachedCapability = capability;
    return capability;
  }

  capability.available = true;
  cachedCapability = capability;
  logger.info("沙箱承载能力探测完成", {
    source: "Sandbox/processSandbox",
    level: capability.level,
    workspaceRoot,
  });
  return capability;
}

/** 清空能力缓存（测试/配置变更用） */
export function resetSandboxCapabilityCache(): void {
  cachedCapability = null;
}

/** 受控执行选项 */
export interface SandboxedCommandInput {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** 允许的 cwd 根（缺省=工作区根；任务绑定工作目录时传该目录） */
  allowedRoot?: string;
}

/** 受控执行结果 */
export interface SandboxedCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  sandboxed: true;
  isolation: {
    envSanitized: true;
    cwdConfined: boolean;
    timeoutMs: number;
  };
}

/**
 * 在进程沙箱内执行一条命令（环境白名单 + cwd 收敛 + 超时 + 输出上限）。
 *
 * 能力不可用时**拒绝执行**（fail-closed）：调用方（执行器）据此返回 SANDBOX_* 错误。
 */
export function runSandboxedCommand(
  input: SandboxedCommandInput,
): { ok: true; value: SandboxedCommandResult } | { ok: false; reason: string } {
  const capability = probeSandboxCapability();
  if (!capability.available) {
    return { ok: false, reason: capability.reason ?? "沙箱承载不可用" };
  }

  const confined = confineToRoot(
    input.cwd,
    input.allowedRoot ?? getWorkspaceRoot(),
  );
  if (!confined.ok) return { ok: false, reason: confined.reason };

  const timeoutMs = input.timeoutMs ?? 30_000;
  const maxOutputBytes = input.maxOutputBytes ?? 1024 * 1024;

  const result = spawnSync(input.command, {
    cwd: confined.cwd,
    env: buildSanitizedEnv(),
    timeout: timeoutMs,
    shell: true,
    windowsHide: true,
    maxBuffer: maxOutputBytes,
    encoding: "utf8",
  });

  const timedOut =
    result.error !== undefined &&
    (result.error as NodeJS.ErrnoException & { code?: string }).code ===
      "ETIMEDOUT";

  return {
    ok: true,
    value: {
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      stderr:
        typeof result.stderr === "string"
          ? result.stderr
          : result.error instanceof Error
            ? result.error.message
            : "",
      exitCode:
        typeof result.status === "number" ? result.status : timedOut ? 124 : 1,
      timedOut,
      sandboxed: true,
      isolation: {
        envSanitized: true,
        cwdConfined: true,
        timeoutMs,
      },
    },
  };
}

/** 把 cwd 收敛到给定根之内（含根本身） */
function confineToRoot(
  cwd: string | undefined,
  root: string,
): { ok: true; cwd: string } | { ok: false; reason: string } {
  const resolvedRoot = resolve(root);
  const target = resolve(cwd ?? resolvedRoot);
  const rootPrefix = resolvedRoot.endsWith(sep)
    ? resolvedRoot
    : `${resolvedRoot}${sep}`;
  if (target !== resolvedRoot && !target.startsWith(rootPrefix)) {
    return {
      ok: false,
      reason: `cwd 越出允许根: ${target} 不在 ${resolvedRoot} 内`,
    };
  }
  if (!existsSync(target))
    return { ok: false, reason: `cwd 不存在: ${target}` };
  if (!isAbsolute(target))
    return { ok: false, reason: `cwd 非绝对路径: ${target}` };
  return { ok: true, cwd: target };
}
