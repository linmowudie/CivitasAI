/**
 * @module Infra/Security/workspaceGuard
 * @description
 * 任务工作目录守卫（产品决策 2026-10-01）。
 *
 * 规则：
 * - 每个会话/任务绑定一个工作目录；未指定时使用 `<项目根>/Data/workspaces/<sessionId>/`（空目录）
 * - 所有路径型工具（FileRead / FileWrite / FileEdit / DirList / FileGrep）
 *   与 ShellExec 都以该目录为**根**
 * - 解析后的真实路径必须落在根内：拒绝 `../` 逃逸、根外绝对路径、
 *   以及经符号链接逃逸（对最深的已存在祖先做 realpath 后再比较）
 *
 * 与 `pathGuard` 的分工：
 * - `pathGuard`：全局项目级约束（项目根、禁止路径、写入白名单）
 * - `workspaceGuard`：任务级约束（会话工作目录），更细粒度、在工具执行期生效
 */

import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

import type { Result } from "../types.js";
import { ok, err } from "../types.js";
import { getWorkspaceRoot, ensureDirSafe } from "../Fs/pathResolver.js";

/** 工作目录根名（位于工作空间根下，与 workspaceIsolator 的 `Workspace/` 区分） */
const WORKSPACES_DIR_NAME = "workspaces";

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 工作目录基址。
 *
 * 决策（2026-10-06 用户明确要求）：**工作空间数据放安装目录**（体积大户，便于用户就近查看/清理），
 * 由 `pathResolver.getWorkspaceRoot()` 统一决定：
 * - 开发态：`<仓库>/Data/workspaces/`（保持历史布局）
 * - 便携态：`<程序目录>/Workspace/workspaces/`
 * - 安装态：`<安装目录>/Workspace/workspaces/`；安装目录只读（如 Program Files）时自动回落
 *   `<数据根>/Workspace/workspaces/`，并已在 `pathResolver` 侧登记告警。
 */
export function workspaceBaseDir(): string {
  const base = join(getWorkspaceRoot(), WORKSPACES_DIR_NAME);
  ensureDirSafe(base);
  return base;
}

/**
 * 计算会话的默认工作目录：`<workspaces 基址>/<sessionId>/`
 * 基址缺省为项目根 `Data/workspaces/`。
 */
export function defaultWorkspaceDir(
  sessionId: string,
  baseDir?: string,
): string {
  return resolve(baseDir ?? workspaceBaseDir(), sessionId);
}

/**
 * 确保工作目录存在（幂等）。
 * 返回规范化后的绝对路径。
 */
export function ensureWorkspaceDir(dir: string): Result<string> {
  const abs = resolve(dir);
  try {
    if (!existsSync(abs)) {
      mkdirSync(abs, { recursive: true });
    } else if (!statSync(abs).isDirectory()) {
      return err(`工作目录不是目录: ${abs}`, "ERROR");
    }
    return ok(abs);
  } catch (e) {
    return err(`创建工作目录失败: ${abs} — ${errorMessage(e)}`, "ERROR");
  }
}

/**
 * 取路径的"真实路径"：对最深的已存在祖先做 realpath，再拼接尚不存在的尾部。
 * 这样即使目标文件不存在（写入场景），也能识别父级符号链接的逃逸。
 */
function realPathOf(target: string): string {
  let current = resolve(target);
  const missing: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    missing.unshift(basename(current));
    current = parent;
  }
  const realBase = existsSync(current) ? realpathSync(current) : current;
  return missing.length > 0 ? join(realBase, ...missing) : realBase;
}

/** 目标路径（真实化后）是否落在工作目录内 */
export function isWithinWorkspace(
  target: string,
  workspaceRoot: string,
): boolean {
  const root = realPathOf(workspaceRoot);
  const abs = realPathOf(isAbsolute(target) ? target : resolve(root, target));
  if (abs === root) return true;
  return abs.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * 归一化"把工作目录尾部当相对路径写"的入参。
 *
 * 场景：`runIteration` 会把会话工作目录注入模型上下文（追加区 `[ctx:workspace]`），
 * 模型写相对路径时可能把该目录的一部分也带上，例如：
 *   `Data/workspaces/<sess>/src/a.ts` 或 `<sess>/src/a.ts`
 * 若直接 `resolve(root, target)`，会拼成 `<root>/Data/workspaces/<sess>/src/a.ts`
 * —— **落在根内（守卫放行）却指向不存在的子目录**，表现为"文件不存在 / 列目录为空"，
 * 比越界拒绝更难归因（用户反馈的"重复路径导致失败"即此）。
 *
 * 规则（只有 target 为相对路径时生效）：
 * - 找 root 的**后缀**与 target 的**前缀**最长的逐段匹配（Windows 大小写不敏感）；
 * - 匹配 n>=2 段：直接剥离（真实目录里几乎不可能存在与根尾部同形的相对子路径）；
 * - 匹配 n==1 段：仅当根内**不存在**同名子目录时才剥离（避免把真实存在的同名目录误判为重复）。
 *
 * 安全性：被剥离的正是 root 自身的尾部，剥离后仍在 root 内 —— **不放松任何越界约束**。
 */
function stripDuplicatedRootPrefix(root: string, target: string): string {
  const rootSegs = root.split(/[\\/]+/).filter(Boolean);
  const head = target.split(/[\\/]+/).filter((s) => s !== "" && s !== ".");
  if (head.length === 0) return target;

  const max = Math.min(rootSegs.length, head.length);
  for (let n = max; n >= 1; n--) {
    const suffix = rootSegs
      .slice(rootSegs.length - n)
      .join("/")
      .toLowerCase();
    const prefix = head.slice(0, n).join("/").toLowerCase();
    if (suffix !== prefix) continue;
    // n==1：根内存在同名子目录 → 视为真实相对路径，不剥离
    if (n === 1 && existsSync(join(root, head[0]!))) return target;
    const rest = head.slice(n);
    return rest.length > 0 ? rest.join(sep) : ".";
  }
  return target;
}

/**
 * 把工具入参路径解析为工作目录内的绝对路径。
 * 越界一律拒绝（FATAL，不可重试）。
 */
export function resolveWithinWorkspace(
  target: string,
  workspaceRoot: string,
): Result<string> {
  if (!target || target.trim() === "") {
    return err("路径不能为空", "ERROR");
  }
  const root = resolve(workspaceRoot);
  const trimmed = target.trim();
  // 相对路径先做"重复根"归一化（模型可能把工作目录尾部也写进相对路径）
  const effective = isAbsolute(trimmed)
    ? trimmed
    : stripDuplicatedRootPrefix(root, trimmed);
  const abs = isAbsolute(effective)
    ? resolve(effective)
    : resolve(root, effective);
  if (!isWithinWorkspace(abs, root)) {
    return err(`路径越界：'${target}' 不在工作目录内（${root}）`, "FATAL");
  }
  return ok(abs);
}

/**
 * 在 shell 命令中查找"逃出工作目录"的路径片段（尽力而为的静态检查）。
 *
 * 覆盖：绝对路径（Windows 盘符 / POSIX `/`）与含 `..` 的相对路径。
 * 说明：这不是完备的 shell 沙箱——完整隔离需 OS 级机制（Job Object/容器），
 * 当前实现用于阻断模型直接指定越界路径的常见情况。
 *
 * @returns 首个越界片段；未发现返回 null
 */
export function findEscapingPathInCommand(
  command: string,
  workspaceRoot: string,
): string | null {
  const tokens = command.split(/\s+/).filter(Boolean);
  for (const raw of tokens) {
    const token = raw.replace(/^["']|["']$/g, "");

    // 跳过命令行开关（`-x` / `--long`；Windows 下 `dir /s`、`taskkill /f` 这类 `/x`）
    // 注：Windows 下单段 `/x` 会被当作开关跳过——这是为避免误伤正常命令做的取舍；
    // 真实的越界路径通常含更深的层级（`/etc/passwd`、`C:\Windows\...`），仍会被检出。
    if (/^-/.test(token)) continue;
    if (process.platform === "win32" && /^\/[A-Za-z][\w-]*$/.test(token))
      continue;

    const looksAbsolute =
      /^[A-Za-z]:[\\/]/.test(token) ||
      token.startsWith("/") ||
      token.startsWith("\\\\");
    const looksEscaping = token.includes("..");
    if (!looksAbsolute && !looksEscaping) continue;
    if (!/^[A-Za-z]:[\\/]|^\/|^\\\\|\.\./.test(token)) continue;

    if (
      !isWithinWorkspace(
        looksAbsolute ? token : resolve(workspaceRoot, token),
        workspaceRoot,
      )
    ) {
      return token;
    }
  }
  return null;
}
