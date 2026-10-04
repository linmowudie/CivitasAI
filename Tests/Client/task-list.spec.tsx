/**
 * @vitest-environment jsdom
 *
 * 任务列表回归（FE-018 连带修复）：
 * - 列表必须展示**会话任务**（「+ 新任务」创建的对象），而不是只读后台 tasks
 * - 单击会话任务 → 该会话成为当前会话并切到对话视图
 * - 默认标题 New Chat 显示为「新任务（未命名）」
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import React from 'react';

const h = vi.hoisted(() => ({
  sessions: [] as unknown[],
  tasks: [] as unknown[],
}));

vi.mock('@/services/api', () => ({
  apiGet: vi.fn(async (path: string) => {
    if (path === '/api/sessions') return { ok: true, data: h.sessions };
    if (path === '/api/tasks') return { ok: true, data: h.tasks };
    return { ok: true, data: [] };
  }),
  apiPost: vi.fn(async () => ({ ok: false, error: { type: 'network', message: 'n/a' } })),
  apiPut: vi.fn(async () => ({ ok: false, error: { type: 'network', message: 'n/a' } })),
  apiDelete: vi.fn(async () => ({ ok: false, error: { type: 'network', message: 'n/a' } })),
  apiPatch: vi.fn(async () => ({ ok: false, error: { type: 'network', message: 'n/a' } })),
}));

import TaskList from '../../Client/src/components/Layout/LeftPanel/TaskList';
import { useChatStore } from '../../Client/src/stores/chatStore';
import { useUIStore } from '../../Client/src/stores/uiStore';

const session = (id: string, title: string, updatedAt = Date.now()) => ({
  session_id: id,
  title,
  status: 'active' as const,
  created_at: updatedAt,
  updated_at: updatedAt,
  work_dir: `F:\\ws\\${id}`,
});

beforeEach(() => {
  h.sessions = [session('sess-a', '整理前端缺陷清单'), session('sess-b', 'New Chat')];
  h.tasks = [];
  useChatStore.setState({
    sessions: [],
    messages: {},
    activeSessionId: null,
    activeConversationId: null,
    activeAgentSessionId: null,
  });
  useUIStore.setState({ mainView: { type: 'feature', id: 'memory' } });
  vi.clearAllMocks();
});

describe('TaskList（会话任务）', () => {
  it('展示会话任务，New Chat 显示为「新任务（未命名）」', async () => {
    render(<TaskList />);
    await waitFor(() => expect(screen.getByText('整理前端缺陷清单')).toBeInTheDocument());
    expect(screen.getByText('新任务（未命名）')).toBeInTheDocument();
  });

  it('点击会话任务 → 设为当前会话并切到对话视图', async () => {
    render(<TaskList />);
    const item = await screen.findByText('整理前端缺陷清单');

    fireEvent.click(item);

    expect(useChatStore.getState().activeAgentSessionId).toBe('sess-a');
    expect(useChatStore.getState().activeConversationId).toBe('sess-a');
    expect(useUIStore.getState().mainView).toEqual({ type: 'conversation' });
  });

  it('后台 tasks 存在时单独成组，不与会话混淆', async () => {
    h.tasks = [{
      taskId: 'task-1',
      traceId: 'trace-1',
      description: '后台批处理任务',
      status: 'running',
      createdAt: Date.now(),
    }];
    render(<TaskList />);

    await waitFor(() => expect(screen.getByText('后台任务')).toBeInTheDocument());
    expect(screen.getByText('后台批处理任务')).toBeInTheDocument();
    expect(screen.getByText('运行中')).toBeInTheDocument();
  });
});
