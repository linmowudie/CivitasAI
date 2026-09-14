/**
 * WebSocket 服务层——Docs/16 F1.3。
 * 单例连接 + 心跳 + 指数退避 + 降级轮询。
 * 视图层禁止直接 new WebSocket，一律经本模块。
 */

import { useSystemStore } from '@/stores/systemStore';

// ── 类型 ────────────────────────────────────────────────────────────

export type WsMessage = {
  type: string;
  data: unknown;
  timestamp: number;
};

type MessageHandler = (msg: WsMessage) => void;

// ── 配置（取自 Configs/default.json ui.*）──────────────────────────

const BACKOFF_BASE_MS = 1000;   // wsReconnectBackoffMs
const MAX_RECONNECT = 5;         // wsReconnectMaxAttempts
const PING_INTERVAL_MS = 30_000;
const FALLBACK_POLL_MS = 5000;   // dashboardPollIntervalSec

// ── 内部状态 ────────────────────────────────────────────────────────

let ws: WebSocket | null = null;
let reconnectAttempt = 0;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let fallbackTimer: ReturnType<typeof setInterval> | null = null;
const handlers: Set<MessageHandler> = new Set();

// WebSocket URL 动态推导：
// - Electron 打包模式：从 electronAPI 获取端口，或默认 3001
// - 浏览器开发模式：使用当前 hostname + 3001
// - 自定义：通过参数传入
function getDefaultWsUrl(): string {
  // Electron 环境：尝试从主进程获取端口
  if (typeof window !== 'undefined' && (window as any).electronAPI?.getServerPorts) {
    // 异步获取会在 connectWebSocket 调用前完成，这里先用默认值
    // 实际使用时通过 connectWebSocket(url) 传入
  }
  // 浏览器模式：使用当前 hostname
  const hostname = typeof window !== 'undefined' ? window.location.hostname : 'localhost';
  return `ws://${hostname}:3001`;
}

let wsUrl = getDefaultWsUrl();

// ── 公开 API ────────────────────────────────────────────────────────

export function connectWebSocket(url?: string): void {
  if (url) wsUrl = url;
  // 已有连接在途（OPEN 或 CONNECTING）则复用，防止 StrictMode 双挂载产生两条连接、事件双份
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  // 清理残留的半开连接（onclose 置空避免触发重连）
  if (ws) {
    ws.onclose = null;
    ws.onerror = null;
    try { ws.close(); } catch { /* 已关闭 */ }
    ws = null;
  }

  try {
    ws = new WebSocket(wsUrl);
  } catch {
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    reconnectAttempt = 0;
    useSystemStore.getState().setOnline(true);
    stopFallbackPolling();
    startPing();
  };

  ws.onmessage = (e) => {
    try {
      const msg: WsMessage = JSON.parse(e.data);
      handlers.forEach(h => h(msg));
    } catch { /* 非法帧静默 */ }
  };

  ws.onclose = () => {
    stopPing();
    useSystemStore.getState().setOnline(false);
    scheduleReconnect();
  };

  ws.onerror = () => {
    // onclose 会紧随触发
  };
}

export function disconnectWebSocket(): void {
  stopPing();
  stopFallbackPolling();
  ws?.close();
  ws = null;
  reconnectAttempt = MAX_RECONNECT; // 阻止自动重连
}

export function subscribeWs(handler: MessageHandler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

export function sendWs(message: Record<string, unknown>): void {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

// ── 内部函数 ────────────────────────────────────────────────────────

function scheduleReconnect(): void {
  if (reconnectAttempt >= MAX_RECONNECT) {
    // 耗尽重连次数 → 降级为轮询
    startFallbackPolling();
    return;
  }

  const delay = BACKOFF_BASE_MS * Math.pow(2, reconnectAttempt);
  reconnectAttempt++;
  setTimeout(() => connectWebSocket(), delay);
}

function startPing(): void {
  stopPing();
  pingTimer = setInterval(() => {
    sendWs({ type: 'ping' });
  }, PING_INTERVAL_MS);
}

function stopPing(): void {
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
}

function startFallbackPolling(): void {
  if (fallbackTimer) return;
  fallbackTimer = setInterval(() => {
    // 尝试重新连接 WS
    reconnectAttempt = 0;
    connectWebSocket();
  }, FALLBACK_POLL_MS);
}

function stopFallbackPolling(): void {
  if (fallbackTimer) { clearInterval(fallbackTimer); fallbackTimer = null; }
}
