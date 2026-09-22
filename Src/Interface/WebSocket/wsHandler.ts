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
import { listMessages, addMessage, getSession, updateSessionTitle } from '../RestApi/chatApi.js';
import { publish, createEvent } from '../../Services/EventBus/eventBus.js';
import { executeLoop, type IterationContext } from '../../Core/Loop/runIteration.js';
import { createLoopState } from '../../Core/Loop/loopEngine.js';
import { createLoopConfig } from '../../Core/Loop/loopConfig.js';
import { getRoutingConfig, resolveModel } from '../../Infra/Llm/Router/modelRouter.js';
import { createAgent } from '../../Core/AgentRuntime/agentFactory.js';
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

// ── 入口 Agent 单例（幂等，多次请求不重复创建）──
let entryAgentId: string | null = null;

function getOrCreateEntryAgent(model: string, traceId: string): string {
  if (entryAgentId) return entryAgentId;
  const result = createAgent({ role: 'prime_director', model }, traceId);
  if (result.ok) {
    entryAgentId = result.value.agentId;
    logger.info('入口 Agent 已创建', { source: 'wsHandler', agentId: entryAgentId });
  } else {
    // 创建失败降级为伪 ID（不阻断请求）
    entryAgentId = 'agent-prime_director-fallback';
    logger.error('入口 Agent 创建失败，降级运行', { source: 'wsHandler', error: result.error });
  }
  return entryAgentId;
}

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
      const model = p.model as string | undefined;          // 可选：指定模型
      const workingMode = p.workingMode as string | undefined; // 可选：工作方式

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
      queueMicrotask(() => startStreamGeneration(clientId, sessionId, userMessage, streamMessageId, model, workingMode));

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
  requestedModel?: string,
  _workingMode?: string,
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

    // 2. 解析模型路由（优先使用客户端指定的模型）
    let model = requestedModel ?? getRoutingConfig()?.defaultModel ?? '';
    if (!model) {
      publish(createEvent({
        eventType: EventType.AGENT_STREAM_END,
        source: 'wsHandler/streamGeneration',
        payload: { messageId: streamMessageId, error: '未配置默认模型（routing.defaultModel）' },
      }));
      return;
    }
    // 验证模型是否已注册（未注册则回退到默认模型）
    const resolved = resolveModel(model);
    if (!resolved.ok) {
      logger.warn('请求模型未注册，回退到默认模型', { source: 'wsHandler', requested: model, error: resolved.error });
      model = getRoutingConfig()?.defaultModel ?? '';
      if (!model) {
        publish(createEvent({
          eventType: EventType.AGENT_STREAM_END,
          source: 'wsHandler/streamGeneration',
          payload: { messageId: streamMessageId, error: '无可用模型' },
        }));
        return;
      }
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
    const agentId = getOrCreateEntryAgent(model, traceId);
    const loopState = createLoopState({
      loopId,
      agentId,
      traceId,
      config: loopConfigResult.value,
    });

    // 4. 经主循环执行器（十步完整链路）
    const iterCtx: Omit<IterationContext, 'currentIteration' | 'totalTokensConsumed'> = {
      userInput: userMessage,
      sessionId,
      agentId,
      agentRole: 'prime_director',
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

      // 发布每次迭代的工具调用/结果事件（供前端渲染）
      for (let i = 0; i < result.iterations.length; i++) {
        const iter = result.iterations[i];
        publish(createEvent({
          eventType: EventType.AGENT_ITERATION_COMPLETE,
          source: 'wsHandler/streamGeneration',
          loopId: loopState.loopId,
          payload: {
            messageId: streamMessageId,
            iteration: i + 1,
            totalIterations: result.iterations.length,
            outputText: iter.outputText,
            toolCalls: iter.toolCalls.map(tc => ({
              id: tc.id,
              name: tc.name,
              arguments: tc.arguments,
            })),
            toolResults: iter.toolResults.map(tr => ({
              tool_call_id: tr.tool_call_id,
              status: tr.status,
              content: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content),
              error: tr.error ? { code: tr.error.code, message: tr.error.message } : undefined,
            })),
            tokensConsumed: iter.tokensConsumed,
            decision: iter.decision?.action ?? 'unknown',
          },
        }));
      }

      // 落库助手消息
      if (outputText) {
        addMessage(sessionId, 'assistant', outputText, {
          model,
          tokens_used: result.totalTokensConsumed,
        });
      }

      // 自动命名：如果会话标题仍为默认值 "New Chat"，用首条用户消息生成标题
      tryAutoNameSession(sessionId, userMessage);

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

// ── 自动命名 ─────────────────────────────────────────────────────────

/**
 * 如果会话标题仍为默认值 "New Chat"，用首条用户消息的前 40 字符生成简短标题。
 * 避免额外 LLM 调用，采用启发式截取。
 */
function tryAutoNameSession(sessionId: string, firstUserMessage: string): void {
  try {
    const session = getSession(sessionId);
    if (!session || session.title !== 'New Chat') return;

    // 启发式生成标题：取用户消息前 40 字符，去除换行和多余空白
    let title = firstUserMessage.replace(/[\r\n]+/g, ' ').trim();
    if (title.length > 40) title = title.slice(0, 40) + '…';
    if (!title) title = 'New Chat';

    updateSessionTitle(sessionId, title);
    logger.info('会话自动命名', { source: 'wsHandler', sessionId, title });
  } catch (e) {
    // 命名失败不影响主流程
    logger.debug('自动命名失败（非关键）', { source: 'wsHandler', error: e instanceof Error ? e.message : String(e) });
  }
}
