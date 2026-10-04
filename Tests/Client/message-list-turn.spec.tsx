/**
 * @vitest-environment jsdom
 *
 * MessageList · Turn-based 对话渲染回归测试。
 * 对照 Canvas 原型 `.qoder-cn/canvases/resizable-layout.canvas.tsx` L356-397。
 *
 * 覆盖点：
 * 1. 用户气泡使用紫色半透明背景 rgba(139, 92, 246, 0.13)
 * 2. Agent 回复容器 header 显示 "Agent" + 子容器数量
 * 3. 子容器 ≤ 50 时全部渲染（不折叠）
 * 4. 子容器 > 50 时**自动折叠**：前置批次渲染为虚线占位框，仅最后一批可见
 * 5. 点击虚线占位框 / header 折叠按钮可展开全部
 * 6. Agent 准备态：占位消息（无正文/思维链/工具调用）不渲染对话容器，改显示准备态
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';

vi.mock('@/components/Chat/MarkdownRenderer', () => ({
  default: ({ content, isStreaming }: { content: string; isStreaming: boolean }) => (
    <div data-testid="markdown" data-streaming={isStreaming}>{content}</div>
  ),
}));

import MessageList from '../../Client/src/components/Chat/MessageList';
import type { ChatMessage } from '../../Client/src/stores/chatStore';

beforeAll(() => {
  // jsdom 未实现 Element.scrollTo，而 MessageList 的智能滚动会调用它
  Element.prototype.scrollTo = vi.fn() as unknown as typeof Element.prototype.scrollTo;
});

let seq = 0;
function mkMessage(
  role: ChatMessage['role'],
  content: string,
  id?: string,
  extra?: Partial<ChatMessage>,
): ChatMessage {
  seq += 1;
  return {
    message_id: id ?? `m-${role}-${seq}`,
    session_id: 'session-1',
    role,
    content,
    created_at: 1_700_000_000_000 + seq,
    status: 'complete',
    ...extra,
  } as ChatMessage;
}

/** 构造一个 turn：1 条用户消息 + replyCount 条 Agent 子容器 */
function buildTurn(replyCount: number): ChatMessage[] {
  const user = mkMessage('user', '请详细分析每个 Agent 的运行参数并生成报告', 'user-1');
  const replies = Array.from({ length: replyCount }, (_, i) =>
    mkMessage('assistant', `子容器 ${i + 1} 的执行内容与运行数据摘要`, `reply-${i + 1}`),
  );
  return [user, ...replies];
}

function renderMessages(messages: ChatMessage[]) {
  return render(
    <MessageList messages={messages} streamingMessageId={null} sessionId="session-1" />,
  );
}

function renderTurn(replyCount: number) {
  return renderMessages(buildTurn(replyCount));
}

/** 模拟"发出消息后、模型尚未产出任何内容"的占位消息 */
function pendingPlaceholder(id = 'pending-1', extra?: Partial<ChatMessage>): ChatMessage {
  return mkMessage('assistant', '', id, { status: 'streaming', ...extra });
}

describe('MessageList · Turn-based 渲染', () => {
  it('用户气泡使用紫色半透明背景', () => {
    renderTurn(1);
    const bubble = screen.getByText('请详细分析每个 Agent 的运行参数并生成报告');
    expect(bubble).toHaveStyle({ background: 'rgba(139, 92, 246, 0.13)' });
  });

  it('Agent 回复容器 header 显示 "Agent" + 子容器数量', () => {
    renderTurn(2);
    expect(screen.getByText('Agent')).toBeInTheDocument();
    expect(screen.getByText(/2\s*个子容器/)).toBeInTheDocument();
  });

  it('子容器 ≤ 50 时全部渲染，不出现折叠占位', () => {
    renderTurn(50);
    expect(screen.getByText(/50\s*个子容器/)).toBeInTheDocument();
    expect(screen.getAllByTestId('markdown')).toHaveLength(50);
    expect(screen.queryByTitle('展开全部子容器')).not.toBeInTheDocument();
  });

  it('子容器 > 50 时自动折叠：前置批次为虚线框，仅最后一批可见', () => {
    renderTurn(55);
    expect(screen.getByText(/55\s*个子容器/)).toBeInTheDocument();
    // 55 = 50 + 5 → 第 1 批折叠为虚线占位框
    expect(screen.getByText('50 个容器（#1–#50）')).toBeInTheDocument();
    // 仅最后一批（5 个）直接渲染
    expect(screen.getAllByTestId('markdown')).toHaveLength(5);
  });

  it('子容器跨越多个批次时逐批生成虚线框', () => {
    renderTurn(120);
    expect(screen.getByText('50 个容器（#1–#50）')).toBeInTheDocument();
    expect(screen.getByText('50 个容器（#51–#100）')).toBeInTheDocument();
    expect(screen.getAllByTestId('markdown')).toHaveLength(20); // 最后一批
  });

  it('点击虚线框可展开全部子容器', () => {
    renderTurn(55);
    fireEvent.click(screen.getByText('50 个容器（#1–#50）'));
    expect(screen.getAllByTestId('markdown')).toHaveLength(55);
    expect(screen.queryByText('50 个容器（#1–#50）')).not.toBeInTheDocument();
  });

  it('header 折叠按钮可收起/展开全部子容器', () => {
    renderTurn(4);
    expect(screen.getAllByTestId('markdown')).toHaveLength(4);
    fireEvent.click(screen.getByRole('button', { name: /收起/ }));
    expect(screen.queryAllByTestId('markdown')).toHaveLength(0);
    expect(screen.getByText('4 个容器（#1–#4）')).toBeInTheDocument();
    fireEvent.click(screen.getByText('4 个容器（#1–#4）'));
    expect(screen.getAllByTestId('markdown')).toHaveLength(4);
  });
});

describe('MessageList · Agent 准备态', () => {
  const USER_TEXT = '请详细分析每个 Agent 的运行参数并生成报告';

  it('仅有准备中占位时不渲染对话容器，显示准备态', () => {
    renderMessages([mkMessage('user', USER_TEXT, 'user-1'), pendingPlaceholder()]);

    // 准备态可见
    expect(screen.getByTestId('agent-preparing')).toBeInTheDocument();
    expect(screen.getByText(/正在准备/)).toBeInTheDocument();
    // 不应出现空的 Agent 对话容器与子容器计数
    expect(screen.queryByText('Agent')).not.toBeInTheDocument();
    expect(screen.queryByText(/个子容器/)).not.toBeInTheDocument();
    // 也不应渲染空消息气泡
    expect(screen.queryAllByTestId('markdown')).toHaveLength(0);
    // 用户气泡仍在
    expect(screen.getByText(USER_TEXT)).toBeInTheDocument();
  });

  it('queued 状态的空占位同样视为准备态', () => {
    renderMessages([
      mkMessage('user', USER_TEXT, 'user-1'),
      mkMessage('assistant', '', 'pending-q', { status: 'queued' }),
    ]);
    expect(screen.getByTestId('agent-preparing')).toBeInTheDocument();
    expect(screen.queryByText(/个子容器/)).not.toBeInTheDocument();
  });

  it('准备中占位不计入子容器数量，且容器内追加准备态行', () => {
    renderMessages([
      mkMessage('user', USER_TEXT, 'user-1'),
      mkMessage('assistant', '第一个子容器的内容', 'reply-1'),
      mkMessage('assistant', '第二个子容器的内容', 'reply-2'),
      pendingPlaceholder(),
    ]);

    // 容器出现，但计数只统计已产出内容的 2 个
    expect(screen.getByText(/2\s*个子容器/)).toBeInTheDocument();
    expect(screen.getByTestId('agent-preparing')).toBeInTheDocument();
    expect(screen.getAllByTestId('markdown')).toHaveLength(2);
  });

  it('首个内容块到达后容器出现、准备态消失', () => {
    const user = mkMessage('user', USER_TEXT, 'user-1');
    const { rerender } = renderMessages([user, pendingPlaceholder()]);
    expect(screen.getByTestId('agent-preparing')).toBeInTheDocument();

    // 模拟流式首块到达：同一 message_id 出现正文
    rerender(
      <MessageList
        messages={[user, mkMessage('assistant', '您好！我可以帮您…', 'pending-1', { status: 'streaming' })]}
        streamingMessageId="pending-1"
        sessionId="session-1"
      />,
    );

    expect(screen.queryByTestId('agent-preparing')).not.toBeInTheDocument();
    expect(screen.getByText(/1\s*个子容器/)).toBeInTheDocument();
    expect(screen.getByText('您好！我可以帮您…')).toBeInTheDocument();
  });

  it('已有思维链但正文为空的占位不算准备态（思维链可见即可）', () => {
    renderMessages([
      mkMessage('user', USER_TEXT, 'user-1'),
      mkMessage('assistant', '', 'pending-r', { status: 'streaming', reasoning: '先拆解需求…' }),
    ]);

    expect(screen.queryByTestId('agent-preparing')).not.toBeInTheDocument();
    expect(screen.getByText(/1\s*个子容器/)).toBeInTheDocument();
  });

  it('生成出错（空正文 + error）不显示准备态，保留错误提示', () => {
    renderMessages([
      mkMessage('user', USER_TEXT, 'user-1'),
      mkMessage('assistant', '', 'err-1', { status: 'error' }),
    ]);

    expect(screen.queryByTestId('agent-preparing')).not.toBeInTheDocument();
    expect(screen.getByText('生成失败')).toBeInTheDocument();
  });
});
