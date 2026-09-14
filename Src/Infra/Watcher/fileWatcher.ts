/**
 * @module Watcher/fileWatcher
 * @description
 * 文件监听器——Docs/14 §S8。
 * 监听 Data/Workspace 目录变更，用于检测外部文件修改。
 * Phase 0-2 简化实现。
 */

import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';

// ── 类型 ────────────────────────────────────────────────────────────

export type FileChangeHandler = (filePath: string, changeType: 'modified' | 'deleted' | 'added') => void;

export interface FileWatcherConfig {
  watchDirs: string[];
  pollIntervalMs?: number;
  onChange?: FileChangeHandler;
}

// ── 内部状态 ────────────────────────────────────────────────────────

let polling = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;
const changeListeners: FileChangeHandler[] = [];
let onChangeHandler: FileChangeHandler | null = null;

// ── 初始化 ──────────────────────────────────────────────────────────

export function initFileWatcher(config: FileWatcherConfig): void {
  onChangeHandler = config.onChange ?? null;
}

export function onFileChange(handler: FileChangeHandler): void {
  changeListeners.push(handler);
}

// ── 启动/停止 ───────────────────────────────────────────────────────

export function startFileWatching(): Result<void> {
  if (polling) return err('FileWatcher 已在运行');
  polling = true;
  return ok(undefined);
}

export function stopFileWatching(): void {
  polling = false;
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// ── 通知 ────────────────────────────────────────────────────────────

export function notifyFileChange(filePath: string, changeType: 'modified' | 'deleted' | 'added'): void {
  if (onChangeHandler) onChangeHandler(filePath, changeType);
  for (const listener of changeListeners) {
    listener(filePath, changeType);
  }
}

export function isFileWatching(): boolean {
  return polling;
}

// ── 清理 ────────────────────────────────────────────────────────────

export function resetFileWatcher(): void {
  stopFileWatching();
  changeListeners.length = 0;
  onChangeHandler = null;
}
