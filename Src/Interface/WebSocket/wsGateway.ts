/**
 * @module Interface/WebSocket/wsGateway
 * @description
 * WebSocket 网关——Docs/16 F0.2。
 * 基于 `ws` 包，绑定 `server.wsPort`(3001)。
 * 将真实 WS 连接桥接到 wsServer（内存桥仍保留供单测）。
 */

import { WebSocketServer, type WebSocket } from 'ws';

import { EventType } from '../../Services/EventBus/eventTypes.js';

import {
  connectClient, disconnectClient, attachSocket, detachSocket,
  initWsServer, pushToClient, type WsServerConfig,
} from './wsServer.js';
import { handleClientMessage, type ClientMessage } from './wsHandler.js';

// ── 配置 ────────────────────────────────────────────────────────────

export interface WsGatewayConfig extends WsServerConfig {
  host: string;
  port: number;
}

// ── 内部状态 ────────────────────────────────────────────────────────

let wss: WebSocketServer | null = null;
/** WS → clientId 映射 */
const socketClientMap = new Map<WebSocket, string>();

// ── 启动 / 停止 ────────────────────────────────────────────────────

export function startWsGateway(config: WsGatewayConfig): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    // 初始化内存桥（供 wsHandler 使用）
    initWsServer({ maxBufferSize: config.maxBufferSize });

    wss = new WebSocketServer({ host: config.host, port: config.port });

    wss.on('connection', (socket: WebSocket) => {
      // 注册内存桥客户端（订阅全部事件类型，流式 chunk / 审批 / 大屏刷新均依赖此推送）
      const client = connectClient(Object.values(EventType));
      attachSocket(client.clientId, socket);
      socketClientMap.set(socket, client.clientId);

      socket.on('message', (raw: Buffer) => {
        try {
          const msg: ClientMessage = JSON.parse(raw.toString('utf-8'));
          const result = handleClientMessage(client.clientId, msg);
          if (!result.ok) {
            // 处理失败必须回推错误帧，否则客户端会永远等待
            pushToClient(client.clientId, {
              type: 'error',
              data: { message: result.error },
              timestamp: Date.now(),
            });
          }
        } catch {
          // 非法帧静默忽略
        }
      });

      socket.on('close', () => {
        const clientId = socketClientMap.get(socket);
        if (clientId) {
          detachSocket(clientId);
          disconnectClient(clientId);
          socketClientMap.delete(socket);
        }
      });

      socket.on('error', () => {
        // 错误后 ws 会自动 close，无需额外处理
      });
    });

    wss.on('error', (e) => {
      reject(e);
    });

    resolvePromise();
  });
}

export function stopWsGateway(): Promise<void> {
  return new Promise((resolve) => {
    if (!wss) { resolve(); return; }
    wss.close(() => {
      wss = null;
      socketClientMap.clear();
      resolve();
    });
  });
}
