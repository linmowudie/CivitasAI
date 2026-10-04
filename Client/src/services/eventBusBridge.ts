/**
 * EventBus 桥接层——替代原 WebSocket 服务层（ws.ts）。
 *
 * Electron 模式：通过 ipcRenderer 接收主进程转发的后端事件，
 *               通过 ipcRenderer.send 发送命令到主进程。
 * 浏览器开发模式：通过 HTTP 轮询获取事件（降级方案）。
 *
 * 视图层禁止直接操作 IPC/HTTP，一律经本模块。
 */

import { useSystemStore } from '@/stores/systemStore';

// ── 类型 ────────────────────────────────────────────────────────────

export type BridgeMessage = {
  type: string;
  data: unknown;
  timestamp: number;
};

type MessageHandler = (msg: BridgeMessage) => void;

// ── 配置 ────────────────────────────────────────────────────────────

const FALLBACK_POLL_MS = 3000; // 浏览器降级轮询间隔

// ── 内部状态 ────────────────────────────────────────────────────────

const handlers: Set<MessageHandler> = new Set();
let connected = false;
let fallbackTimer: ReturnType<typeof setInterval> | null = null;

// ── 环境检测 ────────────────────────────────────────────────────────

function isElectron(): boolean {
  return typeof window !== 'undefined' && !!(window as any).electronAPI?.onBackendEvent;
}

// ── 公开 API ────────────────────────────────────────────────────────

export function connectBridge(_url?: string): void {
  if (connected) return;

  if (isElectron()) {
    // Electron 模式：监听主进程 IPC 转发的事件
    const electronAPI = (window as any).electronAPI;
    electronAPI.onBackendEvent((_event: any, msg: BridgeMessage) => {
      handlers.forEach(h => h(msg));
    });
    connected = true;
    useSystemStore.getState().setOnline(true);
  } else {
    // 浏览器开发模式：降级为 HTTP 轮询
    startFallbackPolling();
    connected = true;
    useSystemStore.getState().setOnline(true);
  }
}

export function disconnectBridge(): void {
  stopFallbackPolling();
  connected = false;
  useSystemStore.getState().setOnline(false);
}

export function subscribe(handler: MessageHandler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

export function send(message: Record<string, unknown>): void {
  if (isElectron()) {
    // Electron 模式：通过 IPC 发送命令到主进程
    const electronAPI = (window as any).electronAPI;
    electronAPI.sendBackendCommand?.(JSON.stringify(message));
  } else {
    // 浏览器开发模式：通过 HTTP POST 发送（需后端支持）
    // Phase 0 降级方案：静默丢弃，后续可接入 REST 命令端点
    console.warn('[eventBusBridge] 浏览器模式下 send 不可用，命令已忽略', { type: message.type });
  }
}

// ── 内部函数 ────────────────────────────────────────────────────────

function startFallbackPolling(): void {
  if (fallbackTimer) return;
  fallbackTimer = setInterval(() => {
    // 浏览器降级模式：定期尝试重连（检测 Electron API 是否可用）
    if (isElectron()) {
      stopFallbackPolling();
      connectBridge();
    }
  }, FALLBACK_POLL_MS);
}

function stopFallbackPolling(): void {
  if (fallbackTimer) { clearInterval(fallbackTimer); fallbackTimer = null; }
}