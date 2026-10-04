/**
 * 暂停后重新加载不得清空部分回复（2026-10-01 FE-025）。
 *
 * 场景：生成中手动暂停 → 切走再切回（触发 hydrateMessages）→ 内容必须保留。
 * 根因有两处：
 *   ① 后端在"中断但主循环正常返回"时没有落库部分回复（库里只有 user 行）
 *   ② 前端 hydrate 用库内消息整体覆盖，把本地已流出的部分回复丢掉
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ dbMessages: [] as unknown[] }));

vi.mock('@/services/api', () => ({
  apiGet: vi.fn(async () => ({ ok: true, data: h.dbMessages })),
  apiPost: vi.fn(async () => ({ ok: false, error: { type: 'network', message: 'n/a' } })),
  apiPut: vi.fn(async () => ({ ok: false, error: { type: 'network', message: 'n/a' } })),
  apiPatch: vi.fn(async () => ({ ok: false, error: { type: 'network', message: 'n/a' } })),
  apiDelete: vi.fn(async () => ({ ok: false, error: { type: 'network', message: 'n/a' } })),
}));

import { useChatStore, type ChatMessage } from '../../Client/src/stores/chatStore';

const SID = 'sess-pause';
const T0 = 1_790_000_000_000;

function userMsg(content = '请写一段短文'): ChatMessage {
  return {
    message_id: 'm-user', session_id: SID, role: 'user', content,
    created_at: T0, status: 'complete',
  } as ChatMessage;
}

/** 本地流式消息：被手动暂停后状态为 stopped，正文已流出、思考已流出 */
function pausedLocalMessage(): ChatMessage {
  return {
    message_id: 'msg-stream-1', session_id: SID, role: 'assistant',
    content: '最后一个守望者，陈远站在观测站的穹顶下……',
    reasoning: '需要写一段科幻短文',
    created_at: T0 + 1, status: 'stopped',
    segments: [{ kind: 'text', text: '最后一个守望者，陈远站在观测站的穹顶下……' }],
  } as ChatMessage;
}

beforeEach(() => {
  h.dbMessages = [];
  useChatStore.setState({
    messages: {}, sessions: [], activeSessionId: SID,
    activeConversationId: SID, activeAgentSessionId: SID,
    streamingMessageId: null, loading: false,
  });
  vi.clearAllMocks();
});

describe('暂停后的部分回复保留', () => {
  it('库中尚无助手行（后端未落库）时，切回保留本地部分回复', async () => {
    h.dbMessages = [userMsg()];
    useChatStore.setState({ messages: { [SID]: [userMsg(), pausedLocalMessage()] } });

    await useChatStore.getState().hydrateMessages(SID);

    const msgs = useChatStore.getState().messages[SID]!;
    expect(msgs).toHaveLength(2);
    expect(msgs[1]?.role).toBe('assistant');
    expect(msgs[1]?.content).toContain('最后一个守望者');
    // 思考内容同样保留（库里没有该字段）
    expect(msgs[1]?.reasoning).toBe('需要写一段科幻短文');
  });

  it('库中已有同一段助手内容时不重复（以库记录为准）', async () => {
    const content = '最后一个守望者，陈远站在观测站的穹顶下……';
    h.dbMessages = [
      userMsg(),
      { message_id: 'm-assistant', session_id: SID, role: 'assistant', content, created_at: T0 + 2, status: 'complete' },
    ];
    useChatStore.setState({ messages: { [SID]: [userMsg(), pausedLocalMessage()] } });

    await useChatStore.getState().hydrateMessages(SID);

    const msgs = useChatStore.getState().messages[SID]!;
    expect(msgs).toHaveLength(2);
    expect(msgs.filter(m => m.role === 'assistant')).toHaveLength(1);
    expect(msgs[1]?.message_id).toBe('m-assistant');
    expect(msgs[1]?.status).toBe('complete');
  });

  it('正常历史（无本地消息）时完全以库为准', async () => {
    h.dbMessages = [
      userMsg(),
      { message_id: 'm-old', session_id: SID, role: 'assistant', content: '历史回复', created_at: T0 + 2, status: 'complete' },
    ];

    await useChatStore.getState().hydrateMessages(SID);

    const msgs = useChatStore.getState().messages[SID]!;
    expect(msgs.map(m => m.message_id)).toEqual(['m-user', 'm-old']);
  });

  it('进行中的流式占位消息在切回后仍在（原有行为不回退）', async () => {
    h.dbMessages = [userMsg()];
    const streaming = { ...pausedLocalMessage(), status: 'streaming' as const, message_id: 'msg-stream-2' };
    useChatStore.setState({
      messages: { [SID]: [userMsg(), streaming] },
      streamingMessageId: 'msg-stream-2',
    });

    await useChatStore.getState().hydrateMessages(SID);

    const msgs = useChatStore.getState().messages[SID]!;
    expect(msgs.some(m => m.message_id === 'msg-stream-2')).toBe(true);
  });
});
