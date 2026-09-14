/**
 * 磁盘配额管理
 *
 * 职责：
 * - 追踪目录/会话级别的磁盘使用量
 * - 设置配额上限并在超限时拒绝写入
 * - 定期扫描实际使用量（可选）
 */

import { statSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Result } from '../types.js';
import { ok, err } from '../types.js';

// ===== 类型定义 =====

/** 配额配置 */
export interface QuotaConfig {
  /** 最大字节数（0 = 无限制） */
  maxBytes: number;
  /** 告警阈值比例（0.0-1.0，达到后发出警告） */
  warnRatio?: number;
}

/** 配额使用状态 */
export interface QuotaUsage {
  /** 已使用字节数 */
  readonly usedBytes: number;
  /** 配额上限字节数 */
  readonly maxBytes: number;
  /** 使用比例（0.0-1.0） */
  readonly usageRatio: number;
  /** 是否已超限 */
  readonly exceeded: boolean;
  /** 是否已达到告警阈值 */
  readonly warning: boolean;
}

// ===== 内部状态 =====

/** 配额注册表 */
const quotas = new Map<string, QuotaConfig>();

/** 使用量追踪表 */
const usage = new Map<string, number>();

// ===== 公开 API =====

/**
 * 设置目录配额
 */
export function setQuota(path: string, config: QuotaConfig): void {
  const resolved = resolve(path);
  quotas.set(resolved, config);
  if (!usage.has(resolved)) {
    usage.set(resolved, 0);
  }
}

/**
 * 检查是否可以写入指定大小
 *
 * @param path 目标路径
 * @param bytes 预计写入字节数
 * @returns 是否允许写入
 */
export function canWrite(path: string, bytes: number): boolean {
  const resolved = resolve(path);

  // 查找匹配的配额（向上查找父目录）
  const quota = findMatchingQuota(resolved);
  if (!quota || quota.maxBytes === 0) return true; // 无配额或无限制

  const currentUsage = usage.get(findQuotaKey(resolved)) ?? 0;
  return (currentUsage + bytes) <= quota.maxBytes;
}

/**
 * 记录写入量
 */
export function recordUsage(path: string, bytes: number): void {
  const key = findQuotaKey(resolve(path));
  if (key) {
    usage.set(key, (usage.get(key) ?? 0) + bytes);
  }
}

/**
 * 获取配额使用状态
 */
export function getUsage(path: string): QuotaUsage | null {
  const resolved = resolve(path);
  const quota = findMatchingQuota(resolved);
  if (!quota) return null;

  const key = findQuotaKey(resolved);
  const usedBytes = usage.get(key) ?? 0;
  const usageRatio = quota.maxBytes > 0 ? usedBytes / quota.maxBytes : 0;
  const warnRatio = quota.warnRatio ?? 0.8;

  return {
    usedBytes,
    maxBytes: quota.maxBytes,
    usageRatio: Math.min(usageRatio, 1),
    exceeded: usageRatio > 1,
    warning: usageRatio >= warnRatio,
  };
}

/**
 * 扫描目录实际磁盘使用量
 */
export function scanDirectorySize(dirPath: string): number {
  const resolved = resolve(dirPath);
  if (!existsSync(resolved)) return 0;

  let total = 0;
  try {
    const entries = readdirSync(resolved, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(resolved, entry.name);
      try {
        if (entry.isFile()) {
          total += statSync(fullPath).size;
        } else if (entry.isDirectory()) {
          total += scanDirectorySize(fullPath);
        }
      } catch { /* ignore inaccessible entries */ }
    }
  } catch { /* ignore */ }
  return total;
}

/**
 * 同步实际使用量（扫描目录）
 */
export function syncUsage(path: string): QuotaUsage | null {
  const resolved = resolve(path);
  const key = findQuotaKey(resolved);
  if (!key) return null;

  const actualSize = scanDirectorySize(key);
  usage.set(key, actualSize);
  return getUsage(key);
}

/**
 * 清除所有配额和使用量（用于测试）
 */
export function clearQuotas(): void {
  quotas.clear();
  usage.clear();
}

// ===== 内部函数 =====

function findQuotaKey(path: string): string | null {
  if (quotas.has(path)) return path;
  // 向上查找
  let current = path;
  while (true) {
    const parent = resolve(current, '..');
    if (parent === current) break;
    if (quotas.has(parent)) return parent;
    current = parent;
  }
  return null;
}

function findMatchingQuota(path: string): QuotaConfig | null {
  const key = findQuotaKey(path);
  return key ? quotas.get(key) ?? null : null;
}
