/**
 * 安全文件操作（Docs/02 §7.1 ⑤）
 *
 * 职责：
 * - 提供安全的文件读写操作（整合 pathGuard 路径检查）
 * - 目录存在性/可写验证
 * - 防止目录遍历攻击
 * - 统一的错误处理
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync, unlinkSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';

import type { Result } from '../types.js';
import { ok, err } from '../types.js';
import { checkPath } from '../Security/pathGuard.js';

// ===== 类型定义 =====

/** 文件读取选项 */
export interface SafeReadOptions {
  /** 编码（默认 'utf-8'） */
  encoding?: BufferEncoding;
  /** 操作类型（用于路径守卫） */
  action?: 'read' | 'list';
}

/** 文件写入选项 */
export interface SafeWriteOptions {
  /** 编码（默认 'utf-8'） */
  encoding?: BufferEncoding;
  /** 不存在则创建目录 */
  createDirs?: boolean;
}

/** 目录验证结果 */
export interface DirValidation {
  readonly exists: boolean;
  readonly writable: boolean;
  readonly path: string;
}

// ===== 公开 API =====

/**
 * 安全读取文件
 *
 * 先通过 pathGuard 检查路径合法性，再执行读取。
 */
export function safeReadFile(filePath: string, options: SafeReadOptions = {}): Result<string> {
  const encoding = options.encoding ?? 'utf-8';
  const action = options.action ?? 'read';

  // 路径安全检查
  const check = checkPath(filePath, action);
  if (!check.allowed) {
    return err(`路径访问被拒绝: ${check.reason}`, 'FATAL');
  }

  try {
    if (!existsSync(check.resolvedPath)) {
      return err(`文件不存在: ${check.resolvedPath}`, 'ERROR');
    }
    const content = readFileSync(check.resolvedPath, { encoding });
    return ok(content.toString());
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return err(`文件读取失败: ${message}`, 'ERROR');
  }
}

/**
 * 安全写入文件
 *
 * 先通过 pathGuard 检查路径合法性，再执行写入。
 * 可选自动创建父目录。
 */
export function safeWriteFile(filePath: string, content: string, options: SafeWriteOptions = {}): Result<void> {
  const encoding = options.encoding ?? 'utf-8';
  const createDirs = options.createDirs ?? true;

  // 路径安全检查
  const check = checkPath(filePath, 'write');
  if (!check.allowed) {
    return err(`路径访问被拒绝: ${check.reason}`, 'FATAL');
  }

  try {
    // 自动创建父目录
    if (createDirs) {
      const dir = dirname(check.resolvedPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }

    writeFileSync(check.resolvedPath, content, { encoding });
    return ok(undefined);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return err(`文件写入失败: ${message}`, 'ERROR');
  }
}

/**
 * 安全读取 JSON 文件
 */
export function safeReadJson<T = Record<string, unknown>>(filePath: string): Result<T> {
  const readResult = safeReadFile(filePath);
  if (!readResult.ok) return readResult as unknown as Result<T>;

  try {
    const parsed = JSON.parse(readResult.value) as T;
    return ok(parsed);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return err(`JSON 解析失败: ${message}`, 'ERROR');
  }
}

/**
 * 安全写入 JSON 文件
 */
export function safeWriteJson(filePath: string, data: unknown, indent = 2): Result<void> {
  try {
    const content = JSON.stringify(data, null, indent);
    return safeWriteFile(filePath, content);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return err(`JSON 序列化失败: ${message}`, 'ERROR');
  }
}

/**
 * 验证目录存在且可写
 *
 * 启动 ⑤ 步用于验证 Data/、Logs/、Skills/ 等目录。
 */
export function validateDirectory(dirPath: string, options: { create?: boolean } = {}): Result<DirValidation> {
  const resolved = resolve(dirPath);
  const create = options.create ?? false;

  try {
    if (!existsSync(resolved)) {
      if (create) {
        mkdirSync(resolved, { recursive: true });
      } else {
        return err(`目录不存在: ${resolved}`, 'FATAL');
      }
    }

    const stat = statSync(resolved);
    if (!stat.isDirectory()) {
      return err(`路径不是目录: ${resolved}`, 'FATAL');
    }

    // 验证可写：尝试写入测试文件
    const testFile = join(resolved, `.write_test_${Date.now()}`);
    try {
      writeFileSync(testFile, 'test');
      unlinkSync(testFile);
    } catch {
      return ok({ exists: true, writable: false, path: resolved });
    }

    return ok({ exists: true, writable: true, path: resolved });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return err(`目录验证失败: ${message}`, 'FATAL');
  }
}

/**
 * 确保目录存在（不存在则创建）
 */
export function ensureDir(dirPath: string): Result<string> {
  const resolved = resolve(dirPath);
  try {
    if (!existsSync(resolved)) {
      mkdirSync(resolved, { recursive: true });
    }
    return ok(resolved);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return err(`目录创建失败: ${message}`, 'FATAL');
  }
}

/**
 * 检查文件是否存在
 */
export function safeExists(path: string): boolean {
  const check = checkPath(path, 'read');
  if (!check.allowed) return false;
  return existsSync(check.resolvedPath);
}

/**
 * 列出目录内容
 */
export function safeListDir(dirPath: string): Result<string[]> {
  const check = checkPath(dirPath, 'list');
  if (!check.allowed) {
    return err(`路径访问被拒绝: ${check.reason}`, 'FATAL');
  }

  try {
    if (!existsSync(check.resolvedPath)) {
      return err(`目录不存在: ${check.resolvedPath}`, 'ERROR');
    }
    const entries = readdirSync(check.resolvedPath);
    return ok(entries);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return err(`目录列表失败: ${message}`, 'ERROR');
  }
}
