/**
 * @module Watcher/index
 * @description
 * 文件/配置监听器统一导出——Docs/14 §S8。
 */

// ── ConfigWatcher ───────────────────────────────────────────────────
export {
  initConfigWatcher, onConfigChange, startWatching, stopWatching,
  notifyChange, isWatching, resetConfigWatcher,
} from './configWatcher.js';
export type { ConfigChangeHandler, ConfigWatcherConfig } from './configWatcher.js';

// ── FileWatcher ─────────────────────────────────────────────────────
export {
  initFileWatcher, onFileChange, startFileWatching, stopFileWatching,
  notifyFileChange, isFileWatching, resetFileWatcher,
} from './fileWatcher.js';
export type { FileChangeHandler, FileWatcherConfig } from './fileWatcher.js';
