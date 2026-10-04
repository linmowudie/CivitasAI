/**
 * @vitest-environment jsdom
 * T2: 工具耗时（durationMs）透出到 chatStore。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useChatStore, type ToolCallEntry } from '../../Client/src/stores/chatStore';

describe('T2: 工具耗时 durationMs 透出', () => {
  beforeEach(() => {
    // 重置 store 状态
    useChatStore.setState({
      sessions: [],
      archivedSessions: [],
      messages: {},
      activeSessionId: null,
      conversations: [],
      activeConversationId: null,
      activeAgentSessionId: null,
      loading: false,
      streamingMessageId: null,
      selectedModel: '',
      selectedWorkingMode: 'DIRECT',
      availableModels: [],
    });
  });

  it('applyToolCallResult 写入 durationMs 后，ToolCallEntry.durationMs === 123', () => {
    const sessionId = 'test-session';
    const messageId = 'msg-test-1';

    // 先创建一个会话和消息
    useChatStore.setState(state => ({
      sessions: [{ session_id: sessionId, title: 'test', status: 'active', created_at: 0, updated_at: 0 }],
      messages: {
        [sessionId]: [{
          message_id: messageId,
          session_id: sessionId,
          role: 'assistant',
          content: 'test',
          created_at: 0,
          status: 'complete',
          toolCalls: [{
            id: 'tc-1',
            name: 'file.read',
            arguments: { path: '/test' },
            status: 'pending',
          }],
          segments: [{
            kind: 'tools',
            iteration: 1,
            toolCalls: [{
              id: 'tc-1',
              name: 'file.read',
              arguments: { path: '/test' },
              status: 'pending',
            }],
          }],
        }],
      },
      activeSessionId: sessionId,
    }));

    // 应用工具结果（含 durationMs）
    useChatStore.getState().applyToolCallResult(messageId, {
      toolCallId: 'tc-1',
      status: 'success',
      content: 'file content',
      durationMs: 123,
    });

    // 验证 toolCalls 中的 durationMs
    const msg = useChatStore.getState().messages[sessionId]?.[0];
    expect(msg).toBeDefined();
    const tc = msg?.toolCalls?.[0];
    expect(tc).toBeDefined();
    expect(tc?.durationMs).toBe(123);
    expect(tc?.status).toBe('success');

    // 验证 segments 中的 durationMs
    const seg = msg?.segments?.[0];
    if (seg && seg.kind === 'tools') {
      expect(seg.toolCalls[0]?.durationMs).toBe(123);
    }
  });

  it('未传 durationMs 时，条目不新增该字段', () => {
    const sessionId = 'test-session-2';
    const messageId = 'msg-test-2';

    useChatStore.setState(state => ({
      sessions: [{ session_id: sessionId, title: 'test', status: 'active', created_at: 0, updated_at: 0 }],
      messages: {
        [sessionId]: [{
          message_id: messageId,
          session_id: sessionId,
          role: 'assistant',
          content: 'test',
          created_at: 0,
          status: 'complete',
          toolCalls: [{
            id: 'tc-2',
            name: 'file.read',
            arguments: {},
            status: 'pending',
          }],
          segments: [{
            kind: 'tools',
            iteration: 1,
            toolCalls: [{
              id: 'tc-2',
              name: 'file.read',
              arguments: {},
              status: 'pending',
            }],
          }],
        }],
      },
      activeSessionId: sessionId,
    }));

    // 应用工具结果（不含 durationMs）
    useChatStore.getState().applyToolCallResult(messageId, {
      toolCallId: 'tc-2',
      status: 'success',
      content: 'done',
    });

    const msg = useChatStore.getState().messages[sessionId]?.[0];
    const tc = msg?.toolCalls?.[0];
    expect(tc).toBeDefined();
    // 不应新增 durationMs 字段
    expect(tc?.durationMs).toBeUndefined();
    expect('durationMs' in (tc ?? {})).toBe(false);
  });
});
