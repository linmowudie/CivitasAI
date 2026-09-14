/**
 * 原子写入（Docs/13 §4 / Gate G1）
 *
 * 职责：
 * - 写入临时文件 → fsync → rename 到目标路径（原子操作）
 * - 写入失败不影响原文件
 * - 支持 fsync 确保数据落盘
 * - 配合 EffectJournal 实现"先写意图再执行"
 *
 * 策略：write-to-temp → fsync → rename（POSIX 下 rename 是原子的）
 */

import { writeFileSync, readFileSync, renameSync, closeSync, openSync, fsyncSync, unlinkSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Result } from '../types.js';
import { ok, err } from '../types.js';
import { checkPath } from '../Security/pathGuard.js';

// ===== 类型定义 =====

/** 原子写入选项 */
export interface AtomicWriteOptions {
  /** 是否执行 fsync（默认 true） */
  fsync?: boolean;
  /** 临时文件目录（默认与目标文件同目录） */
  tmpDir?: string;
  /** 文件编码（默认 'utf-8'） */
  encoding?: BufferEncoding;
}

// ===== 公开 API =====

/**
 * 原子写入文件
 *
 * 流程：
 * 1. 写入临时文件（同目录，确保同一文件系统）
 * 2. fsync 临时文件（确保数据落盘）
 * 3. rename 临时文件 → 目标文件（原子操作）
 *
 * 写入失败时原文件不受影响。
 *
 * @param filePath 目标文件路径
 * @param content 写入内容
 * @param options 写入选项
 */
export function atomicWrite(filePath: string, content: string, options: AtomicWriteOptions = {}): Result<string> {
  const doFsync = options.fsync ?? true;
  const encoding = options.encoding ?? 'utf-8';

  // 路径安全检查
  const check = checkPath(filePath, 'write');
  if (!check.allowed) {
    return err(`路径访问被拒绝: ${check.reason}`, 'FATAL');
  }

  const targetPath = check.resolvedPath;
  const tmpDir = options.tmpDir ? resolve(options.tmpDir) : dirname(targetPath);
  const tmpPath = join(tmpDir, `.atomic_${randomUUID()}.tmp`);

  try {
    // 1. 写入临时文件
    writeFileSync(tmpPath, content, { encoding });

    // 2. fsync（确保数据落盘，失败时静默跳过）
    if (doFsync) {
      try {
        const fd = openSync(tmpPath, 'r');
        try {
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      } catch {
        // fsync 失败不阻断（Windows 沙箱环境可能无权限）
      }
    }

    // 3. rename（原子操作）
    renameSync(tmpPath, targetPath);

    return ok(targetPath);
  } catch (e) {
    // 清理临时文件
    try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch { /* ignore */ }

    const message = e instanceof Error ? e.message : String(e);
    return err(`原子写入失败: ${message}`, 'ERROR');
  }
}

/**
 * 原子写入 Buffer
 */
export function atomicWriteBuffer(filePath: string, data: Buffer, options: AtomicWriteOptions = {}): Result<string> {
  const doFsync = options.fsync ?? true;

  const check = checkPath(filePath, 'write');
  if (!check.allowed) {
    return err(`路径访问被拒绝: ${check.reason}`, 'FATAL');
  }

  const targetPath = check.resolvedPath;
  const tmpDir = options.tmpDir ? resolve(options.tmpDir) : dirname(targetPath);
  const tmpPath = join(tmpDir, `.atomic_${randomUUID()}.tmp`);

  try {
    writeFileSync(tmpPath, data);

    if (doFsync) {
      try {
        const fd = openSync(tmpPath, 'r');
        try { fsyncSync(fd); } finally { closeSync(fd); }
      } catch { /* fsync 失败静默跳过 */ }
    }

    renameSync(tmpPath, targetPath);
    return ok(targetPath);
  } catch (e) {
    try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch { /* ignore */ }
    const message = e instanceof Error ? e.message : String(e);
    return err(`原子写入失败: ${message}`, 'ERROR');
  }
}

/**
 * 原子追加（读取 → 拼接 → 原子写入）
 *
 * 注意：这不是真正的原子追加（有读-写竞态），但保证写入本身是原子的。
 * 适用于单写者场景（如日志文件）。
 */
export function atomicAppend(filePath: string, content: string, options: AtomicWriteOptions = {}): Result<string> {
  const check = checkPath(filePath, 'write');
  if (!check.allowed) {
    return err(`路径访问被拒绝: ${check.reason}`, 'FATAL');
  }

  // 读取现有内容（如果存在）
  let existing = '';
  if (existsSync(check.resolvedPath)) {
    try {
      existing = readFileSync(check.resolvedPath, 'utf-8');
    } catch {
      // 读取失败 → 从空开始
    }
  }

  return atomicWrite(filePath, existing + content, options);
}
