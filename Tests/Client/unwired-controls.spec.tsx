/**
 * @vitest-environment jsdom
 *
 * P0-4 验收：界面上每个控件都必须有真实去处 —— 要么实装，要么移除。
 * 锁死本轮收口的四处：
 *   ① 助手气泡「复制」—— 实装（含剪贴板不可用时的兜底与失败可见）；
 *   ② 赞/踩、「重新生成」—— 移除（后端无反馈落库通道，也无删除末条回复的接口）；
 *   ③ Composer「附件 / 图片」—— 移除（三端都没有上传通道）；
 *   ④ Agent 监控的搜索与状态筛选 —— 实装（真的过滤列表）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';

vi.mock('@/components/Chat/MarkdownRenderer', () => ({
  default: ({ content }: { content: string }) => <div data-testid="markdown">{content}</div>,
}));

const AGENTS = [
  { agentId: 'agent-partner-1', traceId: 'trace-aaaa', role: 'partner', status: 'running', trustLevel: 'user', createdAt: 1 },
  { agentId: 'agent-worker-2', traceId: 'trace-bbbb', role: 'worker', status: 'ready', trustLevel: 'user', createdAt: 2 },
  { agentId: 'agent-auditor-3', traceId: 'trace-cccc', role: 'auditor', status: 'destroyed', trustLevel: 'system', createdAt: 3 },
];

vi.mock('@/services/api', () => ({
  apiGet: vi.fn(async () => ({ ok: true, data: AGENTS })),
  apiPost: vi.fn(async () => ({ ok: true, data: null })),
  apiDelete: vi.fn(async () => ({ ok: true, data: null })),
}));

import MessageBubble from '../../Client/src/components/Chat/MessageBubble';
import Composer from '../../Client/src/components/Chat/Composer';
import AgentMonitor from '../../Client/src/views/AgentMonitor';
import type { ChatMessage } from '../../Client/src/stores/chatStore';

function mkMsg(patch: Partial<ChatMessage> = {}): ChatMessage {
  return {
    message_id: 'm-1',
    session_id: 's-1',
    role: 'assistant',
    content: '这是助手的回复正文',
    created_at: Date.now(),
    status: 'complete',
    ...patch,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('① 助手气泡的复制（实装）', () => {
  it('完成态助手消息渲染复制按钮，点击把正文写进剪贴板并回显"已复制"', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    render(<MessageBubble msg={mkMsg()} />);
    const btn = await screen.findByRole('button', { name: '复制回复内容' });
    fireEvent.click(btn);

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('这是助手的回复正文'));
    expect(await screen.findByText('已复制')).toBeInTheDocument();
  });

  it('安全上下文缺失（浏览器经局域网 http 访问）时走 execCommand 兜底', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true });

    render(<MessageBubble msg={mkMsg()} />);
    fireEvent.click(await screen.findByRole('button', { name: '复制回复内容' }));

    await waitFor(() => expect(execCommand).toHaveBeenCalledWith('copy'));
    expect(await screen.findByText('已复制')).toBeInTheDocument();
  });

  it('两条路径都失败时明确报"复制失败"，不静默', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    Object.defineProperty(document, 'execCommand', { value: () => false, configurable: true });

    render(<MessageBubble msg={mkMsg()} />);
    const btn = await screen.findByRole('button', { name: '复制回复内容' });
    fireEvent.click(btn);

    expect(await screen.findByTitle(/复制失败/)).toBeInTheDocument();
  });

  it('生成中的消息不给复制（内容还没写完）', async () => {
    render(<MessageBubble msg={mkMsg({ status: 'streaming' })} />);
    expect(screen.queryByRole('button', { name: '复制回复内容' })).toBeNull();
  });
});

describe('② 赞/踩 与 重新生成（已移除）', () => {
  it('气泡上不再有无处可去的反馈按钮', () => {
    render(<MessageBubble msg={mkMsg()} />);
    for (const label of ['赞同', '反对', '重新生成']) {
      expect(screen.queryByTitle(label), `${label} 应已移除`).toBeNull();
    }
  });

  it('失败提示不再引导点击不存在的按钮', () => {
    render(<MessageBubble msg={mkMsg({ status: 'error', error: undefined })} />);
    const hint = screen.getByText('生成出错，可重新发送该问题');
    expect(hint).toBeInTheDocument();
    expect(screen.queryByText(/点击重新生成/)).toBeNull();
  });
});

describe('③ Composer 附件 / 图片（已移除）', () => {
  it('输入区不再渲染没有 onClick 的附件与图片按钮', () => {
    render(<Composer onSend={vi.fn()} onStop={vi.fn()} isStreaming={false} />);
    expect(screen.queryByTitle('附件')).toBeNull();
    expect(screen.queryByTitle('图片')).toBeNull();
    // 展开/收起与发送仍然在
    expect(screen.getByTitle('展开')).toBeInTheDocument();
  });
});

describe('④ Agent 监控的搜索与筛选（实装）', () => {
  async function open() {
    render(<AgentMonitor />);
    await screen.findAllByTestId('agent-row');
    return {
      search: screen.getByLabelText('搜索 Agent') as HTMLInputElement,
      status: screen.getByLabelText('按状态筛选') as HTMLSelectElement,
      rows: () => screen.queryAllByTestId('agent-row').map(r => r.textContent ?? ''),
    };
  }

  it('初始显示全部 Agent', async () => {
    const { rows } = await open();
    expect(rows()).toHaveLength(3);
    expect(screen.getByText('3/3')).toBeInTheDocument();
  });

  it('搜索框真的过滤（按 agentId / 角色 / traceId）', async () => {
    const { search, rows } = await open();

    fireEvent.change(search, { target: { value: 'worker' } });
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0]).toContain('agent-worker-2');
    expect(screen.getByText('1/3')).toBeInTheDocument();

    fireEvent.change(search, { target: { value: 'trace-cccc' } });
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0]).toContain('agent-auditor-3');
  });

  it('状态下拉真的过滤', async () => {
    const { status, rows } = await open();
    fireEvent.change(status, { target: { value: 'running' } });
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0]).toContain('agent-partner-1');
    expect(screen.getByText('1/3')).toBeInTheDocument();
  });

  it('过滤到空时区分"没有匹配"与"暂无 Agent"，并可一键清除', async () => {
    const { search, status, rows } = await open();
    fireEvent.change(search, { target: { value: 'zzz-not-exist' } });
    await waitFor(() => expect(rows()).toHaveLength(0));
    expect(screen.getByText('没有匹配的 Agent')).toBeInTheDocument();
    expect(screen.queryByText('暂无 Agent')).toBeNull();

    fireEvent.click(screen.getByText('清除搜索与筛选'));
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(status.value).toBe('all');
    expect(search.value).toBe('');
  });

  it('筛选后详情面板跟随可见列表，不展示被过滤掉的 Agent', async () => {
    const { status } = await open();
    fireEvent.change(status, { target: { value: 'destroyed' } });
    await waitFor(() => expect(screen.queryAllByTestId('agent-row')).toHaveLength(1));
    // 详情面板显示完整 traceId（列表里只显示前 8 位）
    expect(screen.getByTestId('agent-detail')).toHaveTextContent('trace-cccc');
    expect(screen.queryByText('trace-aaaa')).toBeNull();
  });
});
