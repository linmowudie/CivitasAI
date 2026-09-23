/**
 * @module Watcher/configWatcher
 * @description
 * 配置文件监听器——Docs/14 §S8。
 * 监听 Configs/ 目录变更，触发热重载。
 * Phase 0-2 使用轮询模拟，Phase 3 升级 fs.watch。
 */

import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';

// ── 类型 ────────────────────────────────────────────────────────────

export type ConfigChangeHandler = (filePath: string, changeType: 'modified' | 'deleted' | 'added') => void;

export interface ConfigWatcherConfig {
  watchDir: string;
  pollIntervalMs?: number;
  onChange?: ConfigChangeHandler;
}

// ── 内部状态 ────────────────────────────────────────────────────────

let pollIntervalMs = 5000;
let onChangeHandler: ConfigChangeHandler | null = null;
let polling = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;
const fileSnapshots: Map<string, number> = new Map(); // path → mtime
const changeListeners: ConfigChangeHandler[] = [];

// ── 初始化 ──────────────────────────────────────────────────────────

export function initConfigWatcher(config: ConfigWatcherConfig): void {
  pollIntervalMs = config.pollIntervalMs ?? 5000;
  onChangeHandler = config.onChange ?? null;
}

export function onConfigChange(handler: ConfigChangeHandler): void {
  changeListeners.push(handler);
}

// ── 启动/停止 ───────────────────────────────────────────────────────

export function startWatching(): Result<void> {
  if (polling) return err('ConfigWatcher 已在运行');
  polling = true;
  // Phase 0-2: 轮询模式
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

// ── 变更检测 ────────────────────────────────────────────────────────

function detectChanges(): void {
  // Phase 0-2 简化实现：仅记录快照，不实际扫描文件系统
  // 真实文件扫描在 S13 Interface 层完成
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
}
