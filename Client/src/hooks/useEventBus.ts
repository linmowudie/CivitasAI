/**
 * useEventBus hook——组件侧唯一事件入口。
 * 连接 EventBus + 分发事件到各 store。
 * 替代原 useWebSocket hook（Phase 0 架构简化：WebSocket → EventEmitter/IPC）。
 */
import { useEffect } from 'react';
import { connectBridge, subscribe } from '@/services/eventBusBridge';
import { useAgentStore } from '@/stores/agentStore';
import { useTaskStore } from '@/stores/taskStore';
import { useApprovalStore } from '@/stores/approvalStore';
import { useTokenStore } from '@/stores/tokenStore';
import { useChatStore } from '@/stores/chatStore';
import { useSystemStore } from '@/stores/systemStore';
import { useEventStore } from '@/stores/eventStore';
import { useHotReloadStore } from '@/stores/hotReloadStore';
import { EventType } from '@/shared/eventTypes';

// ── 大屏/概要刷新节流（FE-012）──────────────────────────────────────

/**
 * 生成期间 `loop:*` / `token:*` / `MEMORY_*` / 中间件等事件每轮触发，
 * 若每次直连 hydrate（1 次 HTTP）会在数秒内打出数十个请求 → 打满 API 限流（429）。
 * 尾随节流：3s 窗口内多次触发合并为一次，且保证窗口结束时补执行最后一次。
 */
const SYSTEM_REFRESH_THROTTLE_MS = 3_000;

function createTrailingThrottle(fn: () => void, waitMs: number): { call: () => void; cancel: () => void } {
  let lastRun = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    call: () => {
      const elapsed = Date.now() - lastRun;
      if (elapsed >= waitMs) {
        lastRun = Date.now();
        fn();
        return;
      }
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        lastRun = Date.now();
        fn();
      }, waitMs - elapsed);
    },
    cancel: () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

export function useEventBus() {
  useEffect(() => {
    connectBridge();

    // 事件风暴合并：loop:*/token:*/记忆/中间件 → 单个节流刷新器（FE-012）
    const requestSystemRefresh = createTrailingThrottle(() => {
      void useSystemStore.getState().hydrate();
    }, SYSTEM_REFRESH_THROTTLE_MS);
    const requestTokenRefresh = createTrailingThrottle(() => {
      void useTokenStore.getState().hydrate();
    }, SYSTEM_REFRESH_THROTTLE_MS);

    const unsub = subscribe((msg) => {
      // 推入全局事件缓冲（供 AIEventBus / Subscribe 组件消费）
      useEventStore.getState().pushEvent(msg);

      // 分发到各 store
      useAgentStore.getState().applyEvent(msg.type, msg.data);
      useTaskStore.getState().applyEvent(msg.type, msg.data);
      useApprovalStore.getState().applyEvent(msg.type);
      // token: 事件（每次计费触发）→ 节流刷新，避免打满限流（FE-012）
      if (msg.type.startsWith('token:')) requestTokenRefresh.call();

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
          // Agent 回复结束（无论成功/失败/停止）→ 触发 afterReply 级热重载
          useHotReloadStore.getState().flushAfterReply();
        }
      } else if (msg.type === EventType.AGENT_TOOL_CALL_PENDING) {
        // 模型**正在生成**工具调用（参数未出完、尚未执行）→ 立刻建出工具块，显示"生成中/写入中"
        const data = msg.data as {
          messageId?: string; toolCallId?: string; index?: number; toolName?: string; iteration?: number;
        };
        if (data.messageId) {
          useChatStore.getState().applyToolCallPending(data.messageId, {
            toolCallId: data.toolCallId ?? '',
            index: data.index ?? 0,
            ...(data.toolName ? { toolName: data.toolName } : {}),
            iteration: data.iteration ?? 1,
          });
        }
      } else if (msg.type === EventType.AGENT_TOOL_CALL_STARTED) {
        // 工具开始执行：**立即**预创建工具片段，使其位于随后流出的正文之前
        const data = msg.data as {
          messageId?: string; toolCallId: string; toolName: string;
          arguments: Record<string, unknown>; iteration: number;
        };
        if (data.messageId) {
          useChatStore.getState().applyToolCallStarted(data.messageId, data);
        }
      } else if (msg.type === EventType.AGENT_TOOL_CALL_RESULT) {
        const data = msg.data as {
          messageId?: string; toolCallId: string; status: 'success' | 'error';
          content?: string; error?: { code: string; message: string };
          durationMs?: number | null;
        };
        if (data.messageId) {
          useChatStore.getState().applyToolCallResult(data.messageId, {
            toolCallId: data.toolCallId,
            status: data.status,
            content: data.content,
            error: data.error,
            durationMs: data.durationMs ?? undefined,
          });
        }
      } else if (msg.type === EventType.AGENT_ITERATION_COMPLETE) {
        const data = msg.data as {
          messageId?: string;
          iteration: number;
          totalIterations: number;
          toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
          toolResults: Array<{ tool_call_id: string; status: string; content?: string; error?: { code: string; message: string } }>;
        };
        if (data.messageId && data.toolCalls?.length) {
          useChatStore.getState().applyIterationComplete(data.messageId, {
            iteration: data.iteration,
            totalIterations: data.totalIterations,
            toolCalls: data.toolCalls,
            toolResults: data.toolResults,
          });
        }
      }

      // 审批：阻塞期间在对话中的工具行内嵌审批卡（与审批栏共享同一份数据）
      if (msg.type === EventType.APPROVAL_REQUESTED) {
        const data = msg.data as { toolCallId?: string; approvalId?: string };
        if (data.toolCallId && data.approvalId) {
          useChatStore.getState().applyApprovalRequired({
            toolCallId: data.toolCallId,
            approvalId: data.approvalId,
          });
        }
        // 立即刷新审批列表：内嵌卡据此拿到决策角色/倒计时（否则点击时取不到所需角色）
        void useApprovalStore.getState().hydrate();
      } else if (msg.type === EventType.APPROVAL_DECIDED) {
        const data = msg.data as { toolCallId?: string; status?: string; auto?: boolean };
        const normalized = data.status?.toUpperCase();
        // 多角色 unanimous 审批会有**中间态**决策事件（仍为 PENDING）；
        // 若把它当作拒绝，会出现"点击确认后卡片显示已拒绝、而后端仍在阻塞"的错误观感
        if (data.toolCallId && normalized && normalized !== 'PENDING') {
          useChatStore.getState().applyApprovalDecided({
            toolCallId: data.toolCallId,
            status: normalized === 'APPROVED' ? 'approved'
              : normalized === 'TIMEOUT' ? 'timeout'
              : 'rejected',
            auto: data.auto,
          });
        }
        void useApprovalStore.getState().hydrate();
      }

      // 会话/任务改名（含首次请求时模型自动命名）→ 刷新任务列表
      if (msg.type === EventType.CHAT_SESSION_RENAMED) {
        useChatStore.getState().hydrateSessions();
      }

      // 大屏数据随事件刷新（FE-012：节流合并，3s 尾随一次）
      if (msg.type.startsWith('loop:') || msg.type.startsWith('token:')) {
        requestSystemRefresh.call();
      }

      // 记忆事件 → 刷新系统状态（记忆视图数据变更）
      if (msg.type === EventType.MEMORY_VERSION_CONFLICT || msg.type === EventType.MEMORY_SELF_REINFORCING) {
        requestSystemRefresh.call();
      }

      // 中间件/Hook 事件 → 大屏刷新
      if (msg.type === EventType.MIDDLEWARE_BEFORE_MODEL || msg.type === EventType.HOOK_TRIGGERED) {
        requestSystemRefresh.call();
      }
    });

    return () => {
      unsub();
      requestSystemRefresh.cancel();
      requestTokenRefresh.cancel();
    };
  }, []);
}
