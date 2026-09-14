/**
 * @module Interface/WebSocket/wsServer
 * @description
 * WebSocket 服务端——Docs/09 §3.1。
 * Phase 0-2：内存事件桥（不依赖真实 WS 库）；Phase 3 接 ws 库。
 * 将 EventBus 事件桥接到 WS 客户端。
 */

import { subscribeMany } from '../../Services/EventBus/eventBus.js';
import { EventType } from '../../Services/EventBus/eventTypes.js';
import type { Subscription } from '../../Services/EventBus/eventTypes.js';
import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';

// ── 客户端描述 ──────────────────────────────────────────────────────

export interface WsClient {
  clientId: string;
  connectedAt: number;
  subscriptions: EventType[];
  sendQueue: WsMessage[];
  /** 真实 WS socket（F0.2 引入 ws 后由 wsGateway 设置；单测场景保持 undefined） */
  socket?: unknown;  // ws.WebSocket，避免此处 import ws 类型
}

export interface WsMessage {
  type: string;
  data: unknown;
  timestamp: number;
}

// ── 内部状态 ────────────────────────────────────────────────────────

const clients: Map<string, WsClient> = new Map();
const eventSubscriptions: Map<string, Subscription> = new Map();
let clientCounter = 0;
let maxBufferSize = 1000;

// ── 配置 ────────────────────────────────────────────────────────────

export interface WsServerConfig {
  maxBufferSize?: number;
}

export function initWsServer(config: WsServerConfig = {}): void {
  maxBufferSize = config.maxBufferSize ?? 1000;
}

// ── 客户端管理 ──────────────────────────────────────────────────────

export function connectClient(subscriptions?: EventType[]): WsClient {
  const clientId = `ws-client-${++clientCounter}`;
  const client: WsClient = {
    clientId,
    connectedAt: Date.now(),
    subscriptions: subscriptions ?? [],
    sendQueue: [],
  };
  clients.set(clientId, client);

  // 订阅 EventBus 事件 → 推送到客户端（F0.5b 修复：订阅全部事件，而非仅 subscriptions[0]）
  if (client.subscriptions.length > 0) {
    const sub = subscribeMany(client.subscriptions, (event) => {
      pushToClient(clientId, {
        type: event.eventType,
        data: event.payload,
        timestamp: event.timestamp,
      });
    });
    eventSubscriptions.set(clientId, sub);
  }

  return { ...client };
}

export function disconnectClient(clientId: string): Result<void> {
  const client = clients.get(clientId);
  if (!client) return err(`客户端 ${clientId} 不存在`);

  const sub = eventSubscriptions.get(clientId);
  if (sub) {
    sub.unsubscribe();
    eventSubscriptions.delete(clientId);
  }

  clients.delete(clientId);
  return ok(undefined);
}

// ── 推送消息 ────────────────────────────────────────────────────────

export function pushToClient(clientId: string, message: WsMessage): Result<void> {
  const client = clients.get(clientId);
  if (!client) return err(`客户端 ${clientId} 不存在`);

  // F0.2：若已挂载真实 socket，直接发送（不缓冲）
  if (client.socket) {
    try {
      (client.socket as { send: (data: string) => void }).send(JSON.stringify(message));
    } catch {
      // socket 关闭等异常，静默忽略
    }
    return ok(undefined);
  }

  // 内存桥模式（单测 / wsGateway 未启动）
  client.sendQueue.push(message);

  // 缓冲区超限丢弃最旧
  if (client.sendQueue.length > maxBufferSize) {
    client.sendQueue.shift();
  }

  return ok(undefined);
}

export function broadcastToAll(message: WsMessage): void {
  for (const clientId of clients.keys()) {
    pushToClient(clientId, message);
  }
}

// ── 消费消息（模拟 WS 接收）────────────────────────────────────────

export function consumeMessages(clientId: string): WsMessage[] {
  const client = clients.get(clientId);
  if (!client) return [];
  const messages = [...client.sendQueue];
  client.sendQueue.length = 0;
  return messages;
}

// ── 查询 ────────────────────────────────────────────────────────────

export function getConnectedClients(): WsClient[] {
  return [...clients.values()].map(c => ({
    clientId: c.clientId,
    connectedAt: c.connectedAt,
    subscriptions: [...c.subscriptions],
    sendQueue: [...c.sendQueue],
  }));
}

export function getClientCount(): number {
  return clients.size;
}

// ── 挂载真实 socket（F0.2 wsGateway 调用）────────────────────────

export function attachSocket(clientId: string, socket: unknown): Result<void> {
  const client = clients.get(clientId);
  if (!client) return err(`客户端 ${clientId} 不存在`);
  client.socket = socket;
  return ok(undefined);
}

export function detachSocket(clientId: string): Result<void> {
  const client = clients.get(clientId);
  if (!client) return err(`客户端 ${clientId} 不存在`);
  client.socket = undefined;
  return ok(undefined);
}

// ── 重置（测试用）──────────────────────────────────────────────────

export function resetWsServer(): void {
  for (const sub of eventSubscriptions.values()) {
    sub.unsubscribe();
  }
  clients.clear();
  eventSubscriptions.clear();
  clientCounter = 0;
}
