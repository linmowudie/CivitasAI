/**
 * @vitest-environment jsdom
 *
 * 气泡内容顺序回归（2026-10-01 修复）：
 * 助手的思考 / 工具调用 / 正文必须**按发生顺序追加**在气泡内，
 * 而不是把思考与工具聚合到顶部、正文追加在下方。
 */
import { describe, it, expect, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';

vi.mock('@/components/Chat/MarkdownRenderer', () => ({
  default: ({ content, isStreaming }: { content: string; isStreaming: boolean }) => (
    <div data-testid="markdown" data-streaming={String(isStreaming)}>{content}</div>
  ),
}));

import MessageBubble from '../../Client/src/components/Chat/MessageBubble';
import type { ChatMessage, MessageSegment } from '../../Client/src/stores/chatStore';

function mkMsg(extra: Partial<ChatMessage>): ChatMessage {
  return {
    message_id: 'm-1',
    session_id: 's-1',
    role: 'assistant',
    content: '',
    created_at: Date.now(),
    status: 'complete',
    ...extra,
  } as ChatMessage;
}

const tc = (id: string, name: string) => ({
  id,
  name,
  arguments: { a: 1 },
  status: 'success' as const,
  content: 'ok',
});

describe('MessageBubble 片段顺序渲染', () => {
  /** 按给定标记列表依次在 html 中向右查找，断言严格从左到右 */
  function expectOrder(html: string, marks: string[]) {
    let cursor = 0;
    for (const m of marks) {
      const at = html.indexOf(m, cursor);
      expect(at, `未找到或顺序错误: ${m}`).toBeGreaterThanOrEqual(0);
      cursor = at + m.length;
    }
  }

  it('多轮片段按发生顺序排列：思考→工具→正文→思考→工具→正文', () => {
    const segments: MessageSegment[] = [
      { kind: 'reasoning', text: '第一轮思考内容' },
      { kind: 'tools', iteration: 1, toolCalls: [tc('t1', 'dir.list')] },
      { kind: 'text', text: '第一轮正文' },
      { kind: 'reasoning', text: '第二轮思考内容' },
      { kind: 'tools', iteration: 2, toolCalls: [tc('t2', 'file.read')] },
      { kind: 'text', text: '第二轮正文' },
    ];
    const { container } = render(<MessageBubble msg={mkMsg({ segments })} />);

    // 已完成消息的思考块默认折叠（正文文本不渲染），故用可见标记断言顺序：
    // 折叠标题「思考过程」+ 工具组标题「工具调用」+ 正文文本
    expectOrder(container.innerHTML, [
      '思考过程', '工具调用', '第一轮正文',
      '思考过程', '工具调用', '第二轮正文',
    ]);
    // 正文共两段
    expect(screen.getAllByTestId('markdown')).toHaveLength(2);
  });

  it('工具调用组标注所属轮次', () => {
    const segments: MessageSegment[] = [
      { kind: 'tools', iteration: 3, toolCalls: [tc('t3', 'shell.exec')] },
    ];
    render(<MessageBubble msg={mkMsg({ segments })} />);
    expect(screen.getByText('第 3 轮')).toBeInTheDocument();
  });

  it('流式中仅最后一段表现为"思考中…"', () => {
    const segments: MessageSegment[] = [
      { kind: 'reasoning', text: '已完成的思考' },
      { kind: 'text', text: '正在输出的正文' },
    ];
    render(<MessageBubble msg={mkMsg({ status: 'streaming', segments })} />);

    // 前一段思考已完成 → 显示"思考过程"；最后一段是正文 → markdown 处于流式
    expect(screen.getByText('思考过程')).toBeInTheDocument();
    expect(screen.queryByText('思考中…')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('markdown')[0]).toHaveAttribute('data-streaming', 'true');
  });

  it('无 segments 的历史消息回退为：思考→工具→正文', () => {
    const { container } = render(
      <MessageBubble
        msg={mkMsg({
          reasoning: '历史思考',
          toolCalls: [tc('t9', 'file.grep')],
          content: '历史正文',
        })}
      />,
    );
    expectOrder(container.innerHTML, ['思考过程', 'file.grep', '历史正文']);
  });
});
