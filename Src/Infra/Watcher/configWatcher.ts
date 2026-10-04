/**
 * @module Watcher/configWatcher
 * @description
 * 配置文件监听器——Docs/Agent/13 §S8。
 * 轮询监控目录（mtime 快照对比），变更 → 回调（FE-069 实装：此前 detectChanges 为空壳）。
 * 支持多目录（`watchDirs`，如 Configs/ + Prompts/ 提示词热加载）。
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { join, resolve, sep } from 'node:path';

import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';

// ── 类型 ────────────────────────────────────────────────────────────

export type ConfigChangeHandler = (filePath: string, changeType: 'modified' | 'deleted' | 'added') => void;

export interface ConfigWatcherConfig {
  watchDir: string;
  /** 额外监控目录（FE-069：Prompts/ 提示词热加载） */
  watchDirs?: string[];
  pollIntervalMs?: number;
  onChange?: ConfigChangeHandler;
}

// ── 内部状态 ────────────────────────────────────────────────────────

let pollIntervalMs = 5000;
let onChangeHandler: ConfigChangeHandler | null = null;
let polling = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let watchDirs: string[] = [];
let firstScanDone = false;
const fileSnapshots: Map<string, number> = new Map(); // path → mtime
const changeListeners: ConfigChangeHandler[] = [];

// ── 初始化 ──────────────────────────────────────────────────────────

export function initConfigWatcher(config: ConfigWatcherConfig): void {
  pollIntervalMs = config.pollIntervalMs ?? 5000;
  onChangeHandler = config.onChange ?? null;
  watchDirs = [config.watchDir, ...(config.watchDirs ?? [])].filter(Boolean);
  fileSnapshots.clear();
  firstScanDone = false;
}

export function onConfigChange(handler: ConfigChangeHandler): void {
  changeListeners.push(handler);
}

// ── 启动/停止 ───────────────────────────────────────────────────────

export function startWatching(): Result<void> {
  if (polling) return err('ConfigWatcher 已在运行');
  polling = true;
  // 首次扫描建立基线（不产生变更通知）
  scanAll();
  firstScanDone = true;
  pollTimer = setInterval(() => {
    detectChanges();
  }, pollIntervalMs);
  return ok(undefined);
}

export function stopWatching(): void {
  polling = false;
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// ── 变更检测（FE-069 实装：真实文件系统扫描）────────────────────────

function detectChanges(): void {
  scanAll();
}

/** 扫描全部监控目录：mtime 快照对比 → added/modified/deleted 通知 */
function scanAll(): void {
  const seen = new Set<string>();
  for (const dir of watchDirs) {
    walkDir(dir, (file, mtimeMs) => {
      seen.add(file);
      const prev = fileSnapshots.get(file);
      if (prev === undefined) {
        if (firstScanDone) notifyChange(file, 'added');
      } else if (mtimeMs > prev) {
        notifyChange(file, 'modified');
      }
      fileSnapshots.set(file, mtimeMs);
    });
  }
  // 删除检测（快照中存在、本次扫描未见的文件）
  const resolvedDirs = watchDirs.map((d) => resolve(d));
  for (const file of [...fileSnapshots.keys()]) {
    const resolvedFile = resolve(file);
    const inWatchScope = resolvedDirs.some((d) => resolvedFile.startsWith(d + sep));
    if (inWatchScope && !seen.has(file)) {
      notifyChange(file, 'deleted');
      fileSnapshots.delete(file);
    }
  }
}

/** 递归遍历目录（仅 .json / .md 文件） */
function walkDir(dir: string, visit: (file: string, mtimeMs: number) => void): void {
  if (!existsSync(dir)) return;
  let entries: Dirent<string>[];
  try {
    entries = readdirSync(dir, { withFileTypes: true }) as unknown as Dirent<string>[];
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(full, visit);
    } else if (entry.isFile() && (entry.name.endsWith('.json') || entry.name.endsWith('.md'))) {
      try {
        visit(full, statSync(full).mtimeMs);
      } catch {
        /* 单个文件读取失败跳过 */
      }
    }
  }
}

export function notifyChange(filePath: string, changeType: 'modified' | 'deleted' | 'added'): void {
  if (onChangeHandler) onChangeHandler(filePath, changeType);
  for (const listener of changeListeners) {
    listener(filePath, changeType);
  }
}

export function isWatching(): boolean {
  return polling;
}

// ── 清理 ────────────────────────────────────────────────────────────

export function resetConfigWatcher(): void {
  stopWatching();
  fileSnapshots.clear();
  changeListeners.length = 0;
  onChangeHandler = null;
  watchDirs = [];
  firstScanDone = false;
}
