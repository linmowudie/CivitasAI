/**
 * @vitest-environment jsdom
 *
 * FE-018 / FE-019 前端回归：
 * - 「+ 新任务」必须**真正创建会话**（POST /api/sessions）并切换为当前会话，
 *   而不是只把主容器切到对话视图（原实现导致新任务的消息进入旧会话）
 * - 工作目录栏展示会话的 work_dir，并可通过 PATCH 更改 / 重置
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import React from 'react';

const h = vi.hoisted(() => ({
  postResult: null as unknown,
  patchResult: null as unknown,
  posts: [] as Array<{ path: string; body: unknown }>,
  patches: [] as Array<{ path: string; body: unknown }>,
}));

vi.mock('@/services/api', () => ({
  apiGet: vi.fn(async () => ({ ok: true, data: [] })),
  apiPost: vi.fn(async (path: string, body: unknown) => {
  apiPut: vi.fn(async () => ({ ok: false, error: { type: 'network', message: 'n/a' } })),
    h.posts.push({ path, body });
    return h.postResult ?? { ok: false, error: { type: 'network', message: 'no mock' } };
  }),
  apiPatch: vi.fn(async (path: string, body: unknown) => {
    h.patches.push({ path, body });
    return h.patchResult ?? { ok: false, error: { type: 'network', message: 'no mock' } };
  }),
}));

import NewTaskButton from '../../Client/src/components/Layout/LeftPanel/NewTaskButton';
import WorkDirBar from '../../Client/src/components/Layout/MainContainer/WorkDirBar';
import { useChatStore } from '../../Client/src/stores/chatStore';
import { useUIStore } from '../../Client/src/stores/uiStore';

const NEW_SESSION = {
  session_id: 'sess-new01',
  title: 'New Chat',
  status: 'active' as const,
  created_at: 1,
  updated_at: 1,
  work_dir: 'F:\\ProjectCode\\CivitasAI\\Data\\workspaces\\sess-new01',
};

beforeEach(() => {
  h.posts.length = 0;
  h.patches.length = 0;
  h.postResult = { ok: true, data: NEW_SESSION };
  h.patchResult = { ok: true, data: { ...NEW_SESSION, work_dir: 'F:\\other\\dir' } };
  useChatStore.setState({
    sessions: [],
    messages: {},
    activeSessionId: 'sess-old',
    activeConversationId: 'sess-old',
    activeAgentSessionId: 'sess-old',
  });
  useUIStore.setState({ mainView: { type: 'feature', id: 'memory' } });
  vi.clearAllMocks();
});

describe('NewTaskButton（FE-018）', () => {
  it('点击后创建会话、设为当前会话并切到对话视图', async () => {
    render(<NewTaskButton />);

    fireEvent.click(screen.getByRole('button', { name: /新任务/ }));

    await waitFor(() => {
      expect(h.posts.some((p) => p.path === '/api/sessions')).toBe(true);
    });

    // 新会话成为当前会话（原实现不动 activeAgentSessionId → 消息仍进旧会话）
    await waitFor(() => {
      expect(useChatStore.getState().activeAgentSessionId).toBe('sess-new01');
    });
    expect(useChatStore.getState().activeConversationId).toBe('sess-new01');
    expect(useChatStore.getState().sessions[0]?.session_id).toBe('sess-new01');
    expect(useChatStore.getState().messages['sess-new01']).toEqual([]);
    expect(useUIStore.getState().mainView).toEqual({ type: 'conversation' });
  });

  it('创建失败时给出提示且不切换视图', async () => {
    h.postResult = { ok: false, error: { type: '5xx', message: 'boom' } };
    render(<NewTaskButton />);

    fireEvent.click(screen.getByRole('button', { name: /新任务/ }));

    await waitFor(() => {
      expect(screen.getByText(/创建任务失败/)).toBeInTheDocument();
    });
    expect(useUIStore.getState().mainView).toEqual({ type: 'feature', id: 'memory' });
    expect(useChatStore.getState().activeAgentSessionId).toBe('sess-old');
  });
});

describe('WorkDirBar（FE-019）', () => {
  it('展示当前会话工作目录', () => {
    useChatStore.setState({ sessions: [NEW_SESSION] });
    render(<WorkDirBar sessionId="sess-new01" />);
    expect(screen.getByText(/Data\\workspaces\\sess-new01/)).toBeInTheDocument();
  });

  it('重置按钮通过 PATCH 把工作目录置空（后端回落默认目录）', async () => {
    useChatStore.setState({ sessions: [NEW_SESSION] });
    render(<WorkDirBar sessionId="sess-new01" />);

    fireEvent.click(screen.getByTitle('重置为默认工作目录'));

    await waitFor(() => {
      expect(h.patches.some((p) => p.path === '/api/sessions/sess-new01')).toBe(true);
    });
    expect(h.patches[0]?.body).toEqual({ workDir: null });
    // 后端返回的新路径写回 store
    await waitFor(() => {
      expect(useChatStore.getState().sessions[0]?.work_dir).toBe('F:\\other\\dir');
    });
  });
});
