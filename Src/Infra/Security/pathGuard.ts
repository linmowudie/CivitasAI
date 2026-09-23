/**
 * 路径安全守卫（Docs/11 §3.5 / Gate G1）
 *
 * 职责：
 * - 硬禁路径检测：阻止访问 Data/Auth/、~/.ssh/ 等敏感目录
 * - 路径规范化：统一处理 Windows/Unix 路径差异
 * - 目录遍历攻击防护：阻止 ../ 逃逸
 * - 路径访问审计日志
 *
 * 安全约束：
 * - 路径检查在任何文件操作之前执行
 * - 禁止路径访问触发 CRITICAL 安全事件
 * - 路径规范化后比对，防止编码绕过
 */

import { resolve, isAbsolute, relative } from 'node:path';

import type { Result } from '../types.js';
import { ok, err } from '../types.js';

// ===== 类型定义 =====

/** 路径守卫配置 */
export interface PathGuardConfig {
  /** 项目根目录 */
  projectRoot: string;
  /** 禁止访问的路径前缀列表 */
  forbiddenPaths: string[];
  /** 允许写入的目录白名单（空 = 全部允许，除 forbidden） */
  writablePaths?: string[];
}

/** 路径检查结果 */
export interface PathCheckResult {
  /** 规范化后的绝对路径 */
  readonly resolvedPath: string;
  /** 是否通过检查 */
  readonly allowed: boolean;
  /** 拒绝原因（如果 allowed=false） */
  readonly reason?: string;
}

/** 路径访问事件（用于审计日志） */
export interface PathAccessEvent {
  readonly timestamp: number;
  readonly path: string;
  readonly resolvedPath: string;
  readonly action: 'read' | 'write' | 'delete' | 'list';
  readonly allowed: boolean;
  readonly reason?: string;
  readonly source?: string;
}

// ===== 内部状态 =====

let projectRoot = '';
let forbiddenPrefixes: string[] = [];
let writablePrefixes: string[] = [];
let initialized = false;

/** 路径访问事件回调（供审计系统使用） */
let accessCallback: ((event: PathAccessEvent) => void) | null = null;

// ===== 公开 API =====

/**
 * 初始化路径守卫
 *
 * 必须在启动 ④ 步调用。
 */
export function initPathGuard(config: PathGuardConfig): void {
  projectRoot = resolve(config.projectRoot);
  forbiddenPrefixes = config.forbiddenPaths.map(p => resolve(projectRoot, p));
  writablePrefixes = (config.writablePaths ?? []).map(p => resolve(projectRoot, p));
  initialized = true;
}

/**
 * 检查路径是否允许访问
 *
 * 检查项：
 * 1. 路径规范化（阻止 ../ 遍历）
 * 2. 禁止路径检测
 * 3. 写入白名单检查（如果配置了）
 *
 * @param path 要检查的路径
 * @param action 操作类型
 * @returns 检查结果
 */
export function checkPath(path: string, action: 'read' | 'write' | 'delete' | 'list' = 'read'): PathCheckResult {
  if (!initialized) {
    return { resolvedPath: path, allowed: true };
  }

  // 1. 规范化路径
  const resolved = resolve(projectRoot, path);

  // 2. 检查目录遍历（确保路径在项目根目录内，对于相对路径输入）
  if (!isAbsolute(path)) {
    const rel = relative(projectRoot, resolved);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      const result: PathCheckResult = {
        resolvedPath: resolved,
        allowed: false,
        reason: `目录遍历攻击检测：路径 '${path}' 逃逸出项目根目录`,
      };
      reportAccess(path, resolved, action, result);
      return result;
    }
  }

  // 3. 检查禁止路径
  for (const forbidden of forbiddenPrefixes) {
    if (resolved === forbidden || resolved.startsWith(forbidden + '/') || resolved.startsWith(forbidden + '\\')) {
      const result: PathCheckResult = {
        resolvedPath: resolved,
        allowed: false,
        reason: `禁止路径访问：'${path}' 匹配禁止前缀`,
      };
      reportAccess(path, resolved, action, result);
      return result;
    }
  }

  // 4. 写入白名单检查（仅写操作）
  if (action === 'write' || action === 'delete') {
    if (writablePrefixes.length > 0) {
      const isWritable = writablePrefixes.some(wp =>
        resolved === wp || resolved.startsWith(wp + '/') || resolved.startsWith(wp + '\\'),
      );
      if (!isWritable) {
        const result: PathCheckResult = {
          resolvedPath: resolved,
          allowed: false,
          reason: `写入路径不在白名单内：'${path}'`,
        };
        reportAccess(path, resolved, action, result);
        return result;
      }
    }
  }

  const result: PathCheckResult = { resolvedPath: resolved, allowed: true };
  reportAccess(path, resolved, action, result);
  return result;
}

/**
 * 安全地解析路径（通过检查后返回绝对路径）
 *
 * @param path 输入路径
 * @param action 操作类型
 * @returns 规范化后的绝对路径或错误
 */
export function safeResolve(path: string, action: 'read' | 'write' | 'delete' | 'list' = 'read'): Result<string> {
  const check = checkPath(path, action);
  if (!check.allowed) {
    return err(check.reason ?? '路径访问被拒绝', 'FATAL');
  }
  return ok(check.resolvedPath);
}

/**
 * 注册路径访问事件回调
 *
 * 通常由审计系统注册，用于记录路径访问日志。
 */
export function onPathAccess(callback: (event: PathAccessEvent) => void): void {
  accessCallback = callback;
}

/**
 * 获取项目根目录
 */
export function getProjectRoot(): string {
  return projectRoot;
}

/**
 * 是否已初始化
 */
export function isPathGuardInitialized(): boolean {
  return initialized;
}

/**
 * 添加运行时禁止路径（如安全事件触发的动态封锁）
 */
export function addForbiddenPath(path: string): void {
  const resolved = resolve(projectRoot, path);
  if (!forbiddenPrefixes.includes(resolved)) {
    forbiddenPrefixes.push(resolved);
  }
}

/**
 * 重置（用于测试）
 */
export function resetPathGuard(): void {
  projectRoot = '';
  forbiddenPrefixes = [];
  writablePrefixes = [];
  initialized = false;
  accessCallback = null;
}

// ===== 内部函数 =====

/**
 * 报告路径访问事件
 */
function reportAccess(
  originalPath: string,
  resolvedPath: string,
  action: 'read' | 'write' | 'delete' | 'list',
  result: PathCheckResult,
): void {
  if (accessCallback) {
    accessCallback({
      timestamp: Date.now(),
      path: originalPath,
      resolvedPath,
      action,
      allowed: result.allowed,
      reason: result.reason,
    });
  }
}
