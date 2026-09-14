/**
 * useWebSocket hook——组件侧唯一 WS 入口。
 * 连接 WS + 分发事件到各 store。
 * F2.9：流式 chunk/end 在此全局分发（原先挂在 ChatView 内，切页即丢）。
 */
import { useEffect } from 'react';
import { connectWebSocket, subscribeWs } from '@/services/ws';
import { useAgentStore } from '@/stores/agentStore';
import { useTaskStore } from '@/stores/taskStore';
import { useApprovalStore } from '@/stores/approvalStore';
import { useTokenStore } from '@/stores/tokenStore';
import { useChatStore } from '@/stores/chatStore';
import { useSystemStore } from '@/stores/systemStore';
import { EventType } from '@/shared/eventTypes';

export function useWebSocket() {
  useEffect(() => {
    connectWebSocket();

    const unsub = subscribeWs((msg) => {
      // 分发到各 store
      useAgentStore.getState().applyEvent(msg.type, msg.data);
      useTaskStore.getState().applyEvent(msg.type, msg.data);
      useApprovalStore.getState().applyEvent(msg.type);
      useTokenStore.getState().applyEvent(msg.type);

      // 流式事件 → chatStore（全局生命周期，页面切换不中断）
      if (msg.type === EventType.AGENT_STREAM_CHUNK) {
        const data = msg.data as { messageId?: string; chunk?: string; reasoning?: string };
        if (data.messageId && (data.chunk || data.reasoning)) {
          useChatStore.getState().appendStreamChunk(data.messageId, data.chunk ?? '', data.reasoning);
        }
      } else if (msg.type === EventType.AGENT_STREAM_END) {
        const data = msg.data as { messageId?: string; tokensUsed?: number; error?: string };
        if (data.messageId) {
          if (data.error) {
            useChatStore.getState().setStreamError(data.messageId, data.error);
          } else {
            useChatStore.getState().finalizeStream(data.messageId, data.tokensUsed);
          }
        }
      }

      // 大屏数据随事件刷新
      if (msg.type.startsWith('loop:') || msg.type.startsWith('token:')) {
        useSystemStore.getState().hydrate();
      }
    });

    return () => { unsub(); };
  }, []);
}
