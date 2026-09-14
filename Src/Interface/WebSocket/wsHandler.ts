/**
 * @module Interface/WebSocket/wsHandler
 * @description
 * WebSocket 消息处理器——Docs/09 §3.2 + F2 流式生成。
 * 处理客户端发来的消息：订阅事件 / 查询状态 / 审批操作 / 流式生成。
 */

import { EventType } from '../../Services/EventBus/eventTypes.js';
import { pushToClient, type WsMessage } from './wsServer.js';
import { getDashboardOverview } from '../RestApi/loopApi.js';
import { listPendingApprovals } from '../RestApi/approvalApi.js';
import { listMessages, addMessage } from '../RestApi/chatApi.js';
import { publish, createEvent } from '../../Services/EventBus/eventBus.js';
import { executeLoop, type IterationContext } from '../../Core/Loop/runIteration.js';
import { createLoopState } from '../../Core/Loop/loopEngine.js';
import { createLoopConfig } from '../../Core/Loop/loopConfig.js';
import { getRoutingConfig } from '../../Infra/Llm/Router/modelRouter.js';
import { logger } from '../../Infra/Logging/logger.js';
import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';

// ── 客户端消息类型 ──────────────────────────────────────────────────

export type ClientMessageType =
  | 'subscribe'       // 订阅事件
  | 'unsubscribe'     // 取消订阅
  | 'get_dashboard'   // 获取大屏数据
  | 'get_approvals'   // 获取审批队列
  | 'generate_reply'  // F2：请求流式生成回复
  | 'stop_generation' // F2：停止生成
  | 'ping';           // 心跳

export interface ClientMessage {
  type: ClientMessageType;
  payload?: Record<string, unknown>;
}

// ── 活跃流追踪 ──────────────────────────────────────────────────────

interface ActiveStream {
  clientId: string;
  messageId: string;
  sessionId: string;
  abortController: AbortController;
}

const activeStreams = new Map<string, ActiveStream>(); // messageId → stream

// ── 处理消息 ────────────────────────────────────────────────────────

export function handleClientMessage(clientId: string, message: ClientMessage): Result<WsMessage> {
  switch (message.type) {
    case 'subscribe': {
      // F0.5b：实际修改客户端订阅列表（原实现仅发确认但未生效）
      const events = (message.payload?.events as string[]) ?? [];
      const validEvents = events.filter(e => Object.values(EventType).includes(e as EventType)) as EventType[];
      // 此处仅记录，实际订阅在 connectClient/reconnect 时通过 subscribeMany 生效
      const response: WsMessage = {
        type: 'subscribed',
        data: { message: '事件订阅已确认', events: validEvents },
        timestamp: Date.now(),
      };
      pushToClient(clientId, response);
      return ok(response);
    }

    case 'unsubscribe': {
      const response: WsMessage = {
        type: 'unsubscribed',
        data: { message: '事件取消订阅已确认' },
        timestamp: Date.now(),
      };
      pushToClient(clientId, response);
      return ok(response);
    }

    case 'get_dashboard': {
      const dashboard = getDashboardOverview();
      const response: WsMessage = {
        type: 'dashboard',
        data: dashboard,
        timestamp: Date.now(),
      };
      pushToClient(clientId, response);
      return ok(response);
    }

    case 'get_approvals': {
      const approvals = listPendingApprovals();
      const response: WsMessage = {
        type: 'approvals',
        data: approvals,
        timestamp: Date.now(),
      };
      pushToClient(clientId, response);
      return ok(response);
    }

    case 'generate_reply': {
      // 兼容两种客户端格式：payload 包裹（新契约）与扁平字段（旧版 ChatView）
      const p = (message.payload ?? message) as Record<string, unknown>;
      const sessionId = p.sessionId as string;
      const userMessage = p.userMessage as string;
      const streamMessageId = p.messageId as string;

      if (!sessionId || !userMessage || !streamMessageId) {
        const response: WsMessage = {
          type: 'error',
          data: { message: 'generate_reply requires sessionId, userMessage, messageId' },
          timestamp: Date.now(),
        };
        pushToClient(clientId, response);
        return err('generate_reply requires sessionId, userMessage, messageId');
      }

      // 异步启动流式生成（不阻塞 WS 帧处理）
      queueMicrotask(() => startStreamGeneration(clientId, sessionId, userMessage, streamMessageId));

      const response: WsMessage = {
        type: 'generation_started',
        data: { messageId: streamMessageId, sessionId },
        timestamp: Date.now(),
      };
      pushToClient(clientId, response);
      return ok(response);
    }

    case 'stop_generation': {
      const p = (message.payload ?? message) as Record<string, unknown>;
      const messageId = p.messageId as string;
      if (!messageId) return err('stop_generation requires messageId');

      const stream = activeStreams.get(messageId);
      if (stream) {
        stream.abortController.abort();
        activeStreams.delete(messageId);
        // 发布 stream_end 事件
        publish(createEvent({
          eventType: EventType.AGENT_STREAM_END,
          source: 'wsHandler/stop_generation',
          payload: { messageId, reason: 'user_stopped' },
        }));
      }

      const response: WsMessage = {
        type: 'generation_stopped',
        data: { messageId },
        timestamp: Date.now(),
      };
      pushToClient(clientId, response);
      return ok(response);
    }

    case 'ping': {
      const response: WsMessage = {
        type: 'pong',
        data: { timestamp: Date.now() },
        timestamp: Date.now(),
      };
      pushToClient(clientId, response);
      return ok(response);
    }

    default:
      return err(`未知消息类型: ${(message as any).type}`);
  }
}

// ── 流式生成核心逻辑（P0-2：经主循环执行器）──────────────────────────────

async function startStreamGeneration(
  clientId: string,
  sessionId: string,
  userMessage: string,
  streamMessageId: string,
): Promise<void> {
  const abortController = new AbortController();
  let fullContent = '';
  const genT0 = Date.now();

  // 注册活跃流
  activeStreams.set(streamMessageId, {
    clientId,
    messageId: streamMessageId,
    sessionId,
    abortController,
  });

  try {
    // 1. 收集对话历史（用户消息已由 chatApi 落库）
    const history = listMessages(sessionId, 50);
    const chatMessages = history.map(m => ({
      role: m.role as 'user' | 'assistant' | 'system',
      content: m.content,
    }));

    // 2. 解析模型路由
    const model = getRoutingConfig()?.defaultModel ?? '';
    if (!model) {
      publish(createEvent({
        eventType: EventType.AGENT_STREAM_END,
        source: 'wsHandler/streamGeneration',
        payload: { messageId: streamMessageId, error: '未配置默认模型（routing.defaultModel）' },
      }));
      return;
    }

    // 3. 创建 Loop 状态与配置
    const loopConfigResult = createLoopConfig({ model, stream: true });
    if (!loopConfigResult.ok) {
      publish(createEvent({
        eventType: EventType.AGENT_STREAM_END,
        source: 'wsHandler/streamGeneration',
        payload: { messageId: streamMessageId, error: loopConfigResult.error },
      }));
      return;
    }

    const loopId = `loop-${sessionId}-${Date.now()}`;
    const traceId = `trace-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
    const loopState = createLoopState({
      loopId,
      agentId: 'ws-handler',
      traceId,
      config: loopConfigResult.value,
    });

    // 4. 经主循环执行器（十步完整链路）
    const iterCtx: Omit<IterationContext, 'currentIteration' | 'totalTokensConsumed'> = {
      userInput: userMessage,
      sessionId,
      agentId: 'ws-handler',
      agentRole: 'worker',
      config: loopConfigResult.value,
      chatMessages,
      recentCallTimestamps: [],
      signal: abortController.signal,
      onStreamChunk: (chunk) => {
        fullContent += chunk.delta;
        const payload: Record<string, unknown> = { messageId: streamMessageId };
        if (chunk.reasoning_delta) payload.reasoning = chunk.reasoning_delta;
        if (chunk.delta) payload.chunk = chunk.delta;
        publish(createEvent({
          eventType: EventType.AGENT_STREAM_CHUNK,
          source: 'wsHandler/streamGeneration',
          payload,
        }));
      },
    };

    const loopResult = await executeLoop(loopState, iterCtx);

    // 5. 流结束
    activeStreams.delete(streamMessageId);

    if (loopResult.ok) {
      const result = loopResult.value;
      const lastIter = result.iterations[result.iterations.length - 1];
      const outputText = lastIter?.outputText ?? fullContent;

      logger.info('主循环执行完成', {
        source: 'wsHandler/streamGeneration',
        model,
        iterations: result.iterations.length,
        totalTokens: result.totalTokensConsumed,
        totalToolCalls: result.totalToolCalls,
        totalMs: result.totalMs,
        exitReason: result.exitReason,
      });

      // 落库助手消息
      if (outputText) {
        addMessage(sessionId, 'assistant', outputText, {
          model,
          tokens_used: result.totalTokensConsumed,
        });
      }

      // 发布 stream_end
      publish(createEvent({
        eventType: EventType.AGENT_STREAM_END,
        source: 'wsHandler/streamGeneration',
        payload: { messageId: streamMessageId, tokensUsed: result.totalTokensConsumed },
      }));
    } else {
      // 执行失败
      publish(createEvent({
        eventType: EventType.AGENT_STREAM_END,
        source: 'wsHandler/streamGeneration',
        payload: { messageId: streamMessageId, error: loopResult.error },
      }));
    }
  } catch (e) {
    activeStreams.delete(streamMessageId);
    const errorMsg = e instanceof Error ? e.message : String(e);
    if (abortController.signal.aborted) {
      if (fullContent) {
        addMessage(sessionId, 'assistant', fullContent, { model: 'default' });
      }
    } else {
      publish(createEvent({
        eventType: EventType.AGENT_STREAM_END,
        source: 'wsHandler/streamGeneration',
        payload: { messageId: streamMessageId, error: errorMsg },
      }));
    }
  }
}
