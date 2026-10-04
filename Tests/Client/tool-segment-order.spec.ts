/**
 * 片段顺序与工具预创建回归（2026-10-01，FE-023 二修）。
 *
 * 真实顺序：模型先思考 → 决定调用工具（**工具开始执行**）→ 工具返回 → 再生成正文。
 * 事件到达顺序必须能在前端还原这个顺序：
 *   思考 chunk → tool_call_started → tool_call_result → 正文 chunk → iteration_complete
 * 其中 iteration_complete 只能**就地更新**工具条目，不得把工具块挪到正文之后或产生重复。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useChatStore } from '../../Client/src/stores/chatStore';
import type { MessageSegment } from '../../Client/src/stores/chatStore';

const SID = 'sess-seg';

function setupStreamingMessage() {
  useChatStore.setState({
    messages: {},
    activeSessionId: SID,
    activeConversationId: SID,
    activeAgentSessionId: SID,
    streamingMessageId: null,
  });
  const messageId = useChatStore.getState().beginStream(SID, 'm');
  return messageId;
}

/** 取出当前片段（含 test-only 的即时视图，绕过 100ms 合批：手动 flush 通过 finalize） */
function segmentsOf(messageId: string): MessageSegment[] {
  const msgs = useChatStore.getState().messages[SID] ?? [];
  return msgs.find(m => m.message_id === messageId)?.segments ?? [];
}

/**
 * 等待片段落库：流式期间片段先写缓冲，由 100ms 合批统一落库，
 * 因此这里轮询等待（与真实 UI 行为一致）。
 */
async function waitForSegments(
  messageId: string,
  predicate: (segs: MessageSegment[]) => boolean,
  timeoutMs = 2000,
): Promise<MessageSegment[]> {
  const start = Date.now();
  for (;;) {
    const segs = segmentsOf(messageId);
    if (predicate(segs)) return segs;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`等待片段落库超时，当前片段: ${JSON.stringify(segs.map(s => s.kind))}`);
    }
    await new Promise(r => setTimeout(r, 50));
  }
}

beforeEach(() => {
  // 清理定时器：beginStream 会起 100ms 合批定时器
  useChatStore.setState({ streamingMessageId: null });
});

describe('工具预创建与片段顺序', () => {
  it('工具片段在正文之前被创建（思考→工具→正文）', () => {
    const messageId = setupStreamingMessage();

    // ① 思考
    useChatStore.getState().appendStreamChunk(messageId, '', '我先想想该怎么列目录');
    // ② 模型决定调用工具 → 立即预创建
    useChatStore.getState().applyToolCallStarted(messageId, {
      toolCallId: 'tc-1', toolName: 'dir.list', arguments: { path: '.' }, iteration: 1,
    });
    // ③ 工具返回
    useChatStore.getState().applyToolCallResult(messageId, {
      toolCallId: 'tc-1', status: 'success', content: '{"entries":[]}',
    });
    // ④ 正文
    useChatStore.getState().appendStreamChunk(messageId, '当前目录为空，共 0 个文件。');

    // 结束流（触发 flush）
    useChatStore.getState().finalizeStream(messageId, 10);

    const segs = segmentsOf(messageId);
    expect(segs.map(s => s.kind)).toEqual(['reasoning', 'tools', 'text']);
    const tools = segs[1];
    expect(tools.kind).toBe('tools');
    if (tools.kind === 'tools') {
      expect(tools.toolCalls).toHaveLength(1);
      expect(tools.toolCalls[0]?.name).toBe('dir.list');
      expect(tools.toolCalls[0]?.status).toBe('success');
      expect(tools.iteration).toBe(1);
    }
  });

  it('工具结果到达前状态为 pending（便于显示进行中）', async () => {
    const messageId = setupStreamingMessage();
    useChatStore.getState().applyToolCallStarted(messageId, {
      toolCallId: 'tc-2', toolName: 'file.read', arguments: { path: 'a.txt' }, iteration: 1,
    });
    const seg = (await waitForSegments(messageId, s => s.length > 0))[0];
    expect(seg?.kind).toBe('tools');
    if (seg?.kind === 'tools') expect(seg.toolCalls[0]?.status).toBe('pending');

    useChatStore.getState().applyToolCallResult(messageId, {
      toolCallId: 'tc-2', status: 'error', content: undefined, error: { code: 'PATH_DENIED', message: '越界' },
    });
    const after = (await waitForSegments(
      messageId,
      s => s[0]?.kind === 'tools' && s[0].toolCalls[0]?.status === 'error',
    ))[0];
    if (after?.kind === 'tools') {
      expect(after.toolCalls[0]?.status).toBe('error');
      expect(after.toolCalls[0]?.error?.code).toBe('PATH_DENIED');
    }
    useChatStore.getState().finalizeStream(messageId, 10);
  });

  it('迟到的 iteration_complete 就地更新，不重复也不挪位', () => {
    const messageId = setupStreamingMessage();
    useChatStore.getState().appendStreamChunk(messageId, '', '思考');
    useChatStore.getState().applyToolCallStarted(messageId, {
      toolCallId: 'tc-3', toolName: 'dir.list', arguments: {}, iteration: 1,
    });
    useChatStore.getState().appendStreamChunk(messageId, '正文');

    // 整轮结束后端才给出的汇总事件
    useChatStore.getState().applyIterationComplete(messageId, {
      iteration: 1,
      totalIterations: 2,
      toolCalls: [{ id: 'tc-3', name: 'dir.list', arguments: {} }],
      toolResults: [{ tool_call_id: 'tc-3', status: 'success', content: 'ok' }],
    });
    useChatStore.getState().finalizeStream(messageId, 10);

    const segs = segmentsOf(messageId);
    // 顺序保持 思考→工具→正文，且工具只有一条（无重复片段）
    expect(segs.map(s => s.kind)).toEqual(['reasoning', 'tools', 'text']);
    const tools = segs.filter(s => s.kind === 'tools');
    expect(tools).toHaveLength(1);
    if (tools[0]?.kind === 'tools') {
      expect(tools[0].toolCalls).toHaveLength(1);
      expect(tools[0].toolCalls[0]?.status).toBe('success');
    }
  });

  it('同一轮多个工具并入同一片段；不同轮次分片', () => {
    const messageId = setupStreamingMessage();
    useChatStore.getState().applyToolCallStarted(messageId, {
      toolCallId: 'a', toolName: 'dir.list', arguments: {}, iteration: 1,
    });
    useChatStore.getState().applyToolCallStarted(messageId, {
      toolCallId: 'b', toolName: 'file.read', arguments: {}, iteration: 1,
    });
    useChatStore.getState().applyToolCallStarted(messageId, {
      toolCallId: 'c', toolName: 'file.write', arguments: {}, iteration: 2,
    });
    useChatStore.getState().finalizeStream(messageId, 10);

    const segs = segmentsOf(messageId);
    expect(segs.map(s => s.kind)).toEqual(['tools', 'tools']);
    if (segs[0]?.kind === 'tools') expect(segs[0].toolCalls.map(t => t.id)).toEqual(['a', 'b']);
    if (segs[1]?.kind === 'tools') expect(segs[1].toolCalls.map(t => t.id)).toEqual(['c']);
  });

  it('审批事件早于片段落库到达时也不丢关联（写入流式缓冲）', () => {
    const messageId = setupStreamingMessage();

    // ① 工具开始（片段只进缓冲，尚未落库）
    useChatStore.getState().applyToolCallStarted(messageId, {
      toolCallId: 'tc-ap', toolName: 'shell.exec', arguments: { command: 'dir' }, iteration: 1,
    });
    // ② 几毫秒后审批请求到达（此时消息上还没有工具条目）
    useChatStore.getState().applyApprovalRequired({ toolCallId: 'tc-ap', approvalId: 'ap-1' });

    // ③ 落库后必须带上审批关联
    useChatStore.getState().finalizeStream(messageId, 10);
    const seg = segmentsOf(messageId)[0];
    expect(seg?.kind).toBe('tools');
    if (seg?.kind === 'tools') {
      expect(seg.toolCalls[0]?.approvalId).toBe('ap-1');
      expect(seg.toolCalls[0]?.approvalStatus).toBe('pending');
    }

    // ④ 决策后同步到工具行（流结束后直接写消息）
    useChatStore.getState().applyApprovalDecided({ toolCallId: 'tc-ap', status: 'approved' });
    const after = segmentsOf(messageId)[0];
    if (after?.kind === 'tools') {
      expect(after.toolCalls[0]?.approvalStatus).toBe('approved');
      expect(after.toolCalls[0]?.approvalId).toBe('ap-1');
    }
  });

  it('中间态（pending）决策事件不得被当作拒绝', () => {
    const messageId = setupStreamingMessage();
    useChatStore.getState().applyToolCallStarted(messageId, {
      toolCallId: 'tc-mid', toolName: 'shell.exec', arguments: {}, iteration: 1,
    });
    useChatStore.getState().applyApprovalRequired({ toolCallId: 'tc-mid', approvalId: 'ap-mid' });
    useChatStore.getState().finalizeStream(messageId, 10);

    // unanimous 多角色：第 1 次批准后后端仍回 PENDING（中间态）
    useChatStore.getState().applyApprovalDecided({ toolCallId: 'tc-mid', status: 'pending' });
    let seg = segmentsOf(messageId)[0];
    if (seg?.kind === 'tools') {
      expect(seg.toolCalls[0]?.approvalStatus).toBe('pending');
    }

    // 集齐角色后才落定
    useChatStore.getState().applyApprovalDecided({ toolCallId: 'tc-mid', status: 'approved' });
    seg = segmentsOf(messageId)[0];
    if (seg?.kind === 'tools') {
      expect(seg.toolCalls[0]?.approvalStatus).toBe('approved');
    }
  });
});
