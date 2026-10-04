/**
 * @module Infra/Security/workspaceGuard
 * @description
 * 任务工作目录守卫（产品决策 2026-10-01）。
 *
 * 规则：
 * - 每个会话/任务绑定一个工作目录；未指定时使用 `<项目根>/Data/workspaces/<sessionId>/`（空目录）
 * - 所有路径型工具（file.read / file.write / file.edit / dir.list / file.grep）
 *   与 shell.exec 都以该目录为**根**
 * - 解析后的真实路径必须落在根内：拒绝 `../` 逃逸、根外绝对路径、
 *   以及经符号链接逃逸（对最深的已存在祖先做 realpath 后再比较）
 *
 * 与 `pathGuard` 的分工：
 * - `pathGuard`：全局项目级约束（项目根、禁止路径、写入白名单）
 * - `workspaceGuard`：任务级约束（会话工作目录），更细粒度、在工具执行期生效
 */

import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

import type { Result } from '../types.js';
import { ok, err } from '../types.js';
import { getDataDir } from '../Fs/pathResolver.js';
import { getProjectRoot } from './pathGuard.js';

/** 工作目录根名（位于 Data 下，与 workspaceIsolator 的 `Data/Workspace/` 区分） */
const WORKSPACES_DIR_NAME = 'workspaces';

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 工作目录基址。
 *
 * 决策（2026-10-01，用户明确要求）：默认放在**项目根的 `Data/workspaces/`** 下，
 * 与应用的数据库 `Data/` 同处一棵树，便于人直接查看/清理。
 *
 * 注意 `pathResolver.getDataDir()` 在非便携模式下返回 `%APPDATA%/CivitasAI/Data`，
 * 与应用实际使用的数据根（`main.ts` 里的 `resolve('Data')`）并不一致，
 * 因此这里显式以项目根为基准；仅当项目根不可写（如安装模式装在 Program Files）时
 * 才回退到应用数据目录。
 */
export function workspaceBaseDir(): string {
  const projectBase = join(getProjectRoot() || resolve('.'), 'Data', WORKSPACES_DIR_NAME);
  try {
    mkdirSync(projectBase, { recursive: true });
    return projectBase;
  } catch {
    const fallback = join(getDataDir() ?? join(resolve('.'), 'Data'), WORKSPACES_DIR_NAME);
    try {
      mkdirSync(fallback, { recursive: true });
    } catch { /* 交由后续 ensureWorkspaceDir 报错 */ }
    return fallback;
  }
}

/**
 * 计算会话的默认工作目录：`<workspaces 基址>/<sessionId>/`
 * 基址缺省为项目根 `Data/workspaces/`。
 */
export function defaultWorkspaceDir(sessionId: string, baseDir?: string): string {
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
      return err(`工作目录不是目录: ${abs}`, 'ERROR');
    }
    return ok(abs);
  } catch (e) {
    return err(`创建工作目录失败: ${abs} — ${errorMessage(e)}`, 'ERROR');
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
export function isWithinWorkspace(target: string, workspaceRoot: string): boolean {
  const root = realPathOf(workspaceRoot);
  const abs = realPathOf(isAbsolute(target) ? target : resolve(root, target));
  if (abs === root) return true;
  return abs.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * 把工具入参路径解析为工作目录内的绝对路径。
 * 越界一律拒绝（FATAL，不可重试）。
 */
export function resolveWithinWorkspace(target: string, workspaceRoot: string): Result<string> {
  if (!target || target.trim() === '') {
    return err('路径不能为空', 'ERROR');
  }
  const root = resolve(workspaceRoot);
  const abs = isAbsolute(target) ? resolve(target) : resolve(root, target);
  if (!isWithinWorkspace(abs, root)) {
    return err(`路径越界：'${target}' 不在工作目录内（${root}）`, 'FATAL');
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
export function findEscapingPathInCommand(command: string, workspaceRoot: string): string | null {
  const tokens = command.split(/\s+/).filter(Boolean);
  for (const raw of tokens) {
    const token = raw.replace(/^["']|["']$/g, '');

    // 跳过命令行开关（`-x` / `--long`；Windows 下 `dir /s`、`taskkill /f` 这类 `/x`）
    // 注：Windows 下单段 `/x` 会被当作开关跳过——这是为避免误伤正常命令做的取舍；
    // 真实的越界路径通常含更深的层级（`/etc/passwd`、`C:\Windows\...`），仍会被检出。
    if (/^-/.test(token)) continue;
    if (process.platform === 'win32' && /^\/[A-Za-z][\w-]*$/.test(token)) continue;

    const looksAbsolute = /^[A-Za-z]:[\\/]/.test(token) || token.startsWith('/') || token.startsWith('\\\\');
    const looksEscaping = token.includes('..');
    if (!looksAbsolute && !looksEscaping) continue;
    if (!/^[A-Za-z]:[\\/]|^\/|^\\\\|\.\./.test(token)) continue;

    if (!isWithinWorkspace(looksAbsolute ? token : resolve(workspaceRoot, token), workspaceRoot)) {
      return token;
    }
  }
  return null;
}
