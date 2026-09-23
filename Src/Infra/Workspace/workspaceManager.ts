/**
 * 工作区管理器（Docs/02 §2 / Gate G1）
 *
 * 职责：
 * - 为每个 session_key 创建隔离的工作目录
 * - 管理 Data/Workspace/{session_key}/、Data/Sessions/{session_key}/、Data/Loops/{session_key}/
 * - 整合安全模块（pathGuard）和文件系统（fsSafe）
 */

import { join, resolve } from 'node:path';
import { mkdirSync, existsSync, rmSync } from 'node:fs';

import { safeWriteJson, safeReadJson, ensureDir } from '../Fs/fsSafe.js';
import { checkPath } from '../Security/pathGuard.js';
import type { Result } from '../types.js';
import { ok, err } from '../types.js';

// ===== 类型定义 =====

/** 工作区配置 */
export interface WorkspaceConfig {
  /** 数据根目录，默认 'Data' */
  dataRoot: string;
}

/** 会话工作区路径集合 */
export interface SessionWorkspace {
  /** 会话根目录 Data/Sessions/{session_key} */
  sessionDir: string;
  /** 工作区目录 Data/Workspace/{session_key} */
  workspaceDir: string;
  /** Loop 状态目录 Data/Loops/{session_key} */
  loopsDir: string;
}

/** 会话元数据 */
export interface SessionMeta {
  sessionKey: string;
  createdAt: number;
  status: 'active' | 'archived';
}

// ===== 内部状态 =====

let workspaceConfig: WorkspaceConfig | null = null;

// ===== 公开 API =====

/**
 * 初始化工作区管理器
 */
export function initWorkspace(config: WorkspaceConfig): Result<void> {
  try {
    const dataRoot = resolve(config.dataRoot);

    // 检查路径安全性
    const pathCheck = checkPath(dataRoot, 'read');
    if (!pathCheck.allowed) {
      return err(`工作区路径不安全: ${pathCheck.reason ?? '未知原因'}`, 'ERROR');
    }

    // 确保根目录存在
    ensureDir(dataRoot);

    workspaceConfig = { dataRoot };
    return ok(undefined);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return err(`工作区初始化失败: ${message}`, 'ERROR');
  }
}

/**
 * 获取工作区配置
 */
export function getWorkspaceConfig(): WorkspaceConfig | null {
  return workspaceConfig;
}

/**
 * 获取会话工作区路径集合
 */
export function getSessionPaths(sessionKey: string): Result<SessionWorkspace> {
  if (!workspaceConfig) {
    return err('工作区未初始化', 'ERROR');
  }

  const dataRoot = workspaceConfig.dataRoot;

  return ok({
    sessionDir: join(dataRoot, 'Sessions', sessionKey),
    workspaceDir: join(dataRoot, 'Workspace', sessionKey),
    loopsDir: join(dataRoot, 'Loops', sessionKey),
  });
}

/**
 * 为会话创建完整的工作区目录结构
 *
 * Gate G1: session_key 碰撞时自动加后缀再试（由 sessionKeyGenerator 处理）
 */
export function createSessionWorkspace(sessionKey: string): Result<SessionWorkspace> {
  if (!workspaceConfig) {
    return err('工作区未初始化', 'ERROR');
  }

  const pathsResult = getSessionPaths(sessionKey);
  if (!pathsResult.ok) {
    return err(pathsResult.error, 'ERROR');
  }
  const paths = pathsResult.value;

  try {
    // 验证所有路径安全性
    for (const dir of [paths.sessionDir, paths.workspaceDir, paths.loopsDir]) {
      const check = checkPath(dir, 'write');
      if (!check.allowed) {
        return err(`会话目录路径不安全: ${check.reason ?? '未知原因'}`, 'ERROR');
      }
    }

    // 创建目录
    mkdirSync(paths.sessionDir, { recursive: true });
    mkdirSync(paths.workspaceDir, { recursive: true });
    mkdirSync(paths.loopsDir, { recursive: true });

    // 写入会话元数据
    const meta: SessionMeta = {
      sessionKey,
      createdAt: Date.now(),
      status: 'active',
    };
    const metaPath = join(paths.sessionDir, 'meta.json');
    safeWriteJson(metaPath, meta);

    return ok(paths);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return err(`创建会话工作区失败: ${message}`, 'ERROR');
  }
}

/**
 * 归档会话工作区（标记为 archived，不删除文件）
 */
export function archiveSessionWorkspace(sessionKey: string): Result<void> {
  if (!workspaceConfig) {
    return err('工作区未初始化', 'ERROR');
  }

  const pathsResult = getSessionPaths(sessionKey);
  if (!pathsResult.ok) {
    return err(pathsResult.error, 'ERROR');
  }

  const metaPath = join(pathsResult.value.sessionDir, 'meta.json');

  try {
    const readResult = safeReadJson<SessionMeta>(metaPath);
    if (readResult.ok && readResult.value) {
      const meta = readResult.value;
      meta.status = 'archived';
      safeWriteJson(metaPath, meta);
    }
    return ok(undefined);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return err(`归档会话工作区失败: ${message}`, 'ERROR');
  }
}

/**
 * 删除会话工作区（谨慎使用）
 */
export function removeSessionWorkspace(sessionKey: string): Result<void> {
  if (!workspaceConfig) {
    return err('工作区未初始化', 'ERROR');
  }

  const pathsResult = getSessionPaths(sessionKey);
  if (!pathsResult.ok) {
    return err(pathsResult.error, 'ERROR');
  }
  const paths = pathsResult.value;

  try {
    // 验证路径在预期范围内（防止目录遍历）
    for (const dir of [paths.sessionDir, paths.workspaceDir, paths.loopsDir]) {
      if (!dir.includes(sessionKey)) {
        return err(`路径安全检查失败: 目录不包含 session_key`, 'ERROR');
      }
    }

    if (existsSync(paths.sessionDir)) rmSync(paths.sessionDir, { recursive: true, force: true });
    if (existsSync(paths.workspaceDir)) rmSync(paths.workspaceDir, { recursive: true, force: true });
    if (existsSync(paths.loopsDir)) rmSync(paths.loopsDir, { recursive: true, force: true });

    return ok(undefined);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return err(`删除会话工作区失败: ${message}`, 'ERROR');
  }
}

/**
 * 检查工作区是否存在
 */
export function sessionWorkspaceExists(sessionKey: string): boolean {
  if (!workspaceConfig) return false;

  const pathsResult = getSessionPaths(sessionKey);
  if (!pathsResult.ok) return false;

  return existsSync(pathsResult.value.sessionDir);
}

/**
 * 重置工作区配置（测试用）
 */
export function resetWorkspace(): void {
  workspaceConfig = null;
}
