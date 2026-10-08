/**
 * @vitest-environment jsdom
 *
 * 新任务空态 + 工作目录锁定（2026-10-08 业务规则）。
 *
 * 覆盖：
 *  - 新任务（无消息）：操作区位于"中偏下"（上下留白 1 : 0.75），并给出
 *    ① 工作目录 ② 模型 ③ 工作模式 三个入口；底栏不再重复模型/模式选择器；
 *  - 已有对话：空态消失，回到常规对话布局；
 *  - 目录锁定：TitleBar 的 WorkDirBar 转为只读（无"更改"/重置），并提示"已锁定"；
 *  - 后端拒绝（409）时把真实原因透出，而不是统一显示"更新失败"。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';

const h = vi.hoisted(() => ({
  patchResult: null as unknown,
  patches: [] as Array<{ path: string; body: unknown }>,
  pickResult: null as string | null,
  picked: 0,
}));

vi.mock('@/services/api', () => ({
  apiGet: vi.fn(async () => ({ ok: true, data: [] })),
  apiPost: vi.fn(async () => ({ ok: false, error: { type: 'network', message: 'n/a' } })),
  apiPut: vi.fn(async () => ({ ok: false, error: { type: 'network', message: 'n/a' } })),
  apiPatch: vi.fn(async (path: string, body: unknown) => {
    h.patches.push({ path, body });
    return h.patchResult ?? { ok: false, error: { type: 'network', message: 'no mock' } };
  }),
}));

// 目录选择：Electron 原生对话框在 jsdom 下不存在，统一桩掉
vi.mock('@/services/directoryPicker', () => ({
  pickDirectory: vi.fn(async () => {
    h.picked += 1;
    return h.pickResult;
  }),
}));

// AIEventBus 依赖运行时通道，测试里降级为透传
vi.mock('@/ai-components/AIEventBus', () => ({
  AIEventBus: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import ChatView from '../../Client/src/views/ChatView';
import WorkDirBar from '../../Client/src/components/Layout/MainContainer/WorkDirBar';
import NewTaskSetup from '../../Client/src/components/Chat/NewTaskSetup';
import { useChatStore } from '../../Client/src/stores/chatStore';

const SESSION_ID = 'sess-lock-1';
const WORK_DIR = 'F:\\ProjectCode\\CivitasAI\\Data\\workspaces\\sess-lock-1';

const SESSION = {
  session_id: SESSION_ID,
  title: 'New Chat',
  status: 'active' as const,
  created_at: 1,
  updated_at: 1,
  work_dir: WORK_DIR,
};

function resetStore(overrides: Record<string, unknown> = {}) {
  useChatStore.setState({
    sessions: [SESSION],
    messages: {},
    activeSessionId: SESSION_ID,
    activeConversationId: SESSION_ID,
    activeAgentSessionId: SESSION_ID,
    availableModels: ['huawei-maas/GLM-5.1', 'openai/gpt-4o'],
    selectedModel: '',
    selectedWorkingMode: 'DIRECT',
    ...overrides,
  });
}

beforeEach(() => {
  // jsdom 未实现 Element.scrollTo，而 MessageList 在有消息时会自动滚到底部
  if (!Element.prototype.scrollTo) {
    Element.prototype.scrollTo = () => { /* jsdom shim */ };
  }
  h.patches.length = 0;
  h.picked = 0;
  h.patchResult = { ok: true, data: { ...SESSION, work_dir: 'F:\\other\\dir' } };
  h.pickResult = 'F:\\other\\dir';
  resetStore();
});

describe('新任务空态布局', () => {
  it('无消息 → 显示空态，且操作区位于中偏下（上留白 > 下留白）', () => {
    resetStore({ messages: { [SESSION_ID]: [] } });
    render(<ChatView />);

    expect(screen.getByTestId('new-task-empty-state')).toBeInTheDocument();
    const top = screen.getByTestId('new-task-spacer-top');
    const bottom = screen.getByTestId('new-task-spacer-bottom');
    expect(top.className).toContain('flex-[1]');
    expect(bottom.className).toContain('flex-[0.75]');
  });

  it('无消息 → 给出工作目录 / 模型 / 工作模式三个入口', () => {
    resetStore({ messages: { [SESSION_ID]: [] } });
    render(<ChatView />);

    expect(screen.getByTestId('new-task-setup')).toBeInTheDocument();
    expect(screen.getByText('工作目录')).toBeInTheDocument();
    expect(screen.getByLabelText('选择模型')).toBeInTheDocument();
    expect(screen.getByLabelText('选择工作模式')).toBeInTheDocument();
    expect(screen.getByText('选择目录')).toBeInTheDocument();
  });

  it('已有对话 → 空态消失（回到常规对话布局）', () => {
    resetStore({
      messages: {
        [SESSION_ID]: [{ message_id: 'm1', session_id: SESSION_ID, role: 'user', content: '你好', created_at: 1 }],
      },
    });
    render(<ChatView />);

    expect(screen.queryByTestId('new-task-empty-state')).not.toBeInTheDocument();
    expect(screen.queryByTestId('new-task-setup')).not.toBeInTheDocument();
  });
});

describe('NewTaskSetup · 三个入口可用', () => {
  it('选择目录 → 提交 PATCH（空对话时后端允许）', async () => {
    render(<NewTaskSetup sessionId={SESSION_ID} />);
    fireEvent.click(screen.getByText('选择目录'));

    await waitFor(() => expect(h.picked).toBe(1));
    await waitFor(() => expect(h.patches.length).toBe(1));
    expect(h.patches[0]?.path).toBe(`/api/sessions/${SESSION_ID}`);
    expect(h.patches[0]?.body).toEqual({ workDir: 'F:\\other\\dir' });
  });

  it('切换模型 / 工作模式写入 store', () => {
    render(<NewTaskSetup sessionId={SESSION_ID} />);
    fireEvent.change(screen.getByLabelText('选择模型'), { target: { value: 'openai/gpt-4o' } });
    fireEvent.change(screen.getByLabelText('选择工作模式'), { target: { value: 'LITIGATION' } });

    expect(useChatStore.getState().selectedModel).toBe('openai/gpt-4o');
    expect(useChatStore.getState().selectedWorkingMode).toBe('LITIGATION');
  });

  it('后端拒绝时显示真实原因（不再统一显示"更新失败"）', async () => {
    h.patchResult = { ok: false, error: { type: '4xx', message: '该任务已有对话，工作目录不可更改；如需更换请新建任务' } };
    render(<NewTaskSetup sessionId={SESSION_ID} />);
    fireEvent.click(screen.getByText('选择目录'));

    expect(await screen.findByText('该任务已有对话，工作目录不可更改；如需更换请新建任务')).toBeInTheDocument();
  });
});

describe('WorkDirBar · 目录锁定', () => {
  it('未锁定 → 显示"更改"与重置按钮', () => {
    render(<WorkDirBar sessionId={SESSION_ID} locked={false} />);
    expect(screen.getByTitle('更改工作目录')).toBeInTheDocument();
    expect(screen.getByTitle('重置为默认工作目录')).toBeInTheDocument();
    expect(screen.queryByText('已锁定')).not.toBeInTheDocument();
  });

  it('已锁定 → 只读：没有更改/重置按钮，并提示已锁定', () => {
    render(<WorkDirBar sessionId={SESSION_ID} locked />);
    expect(screen.queryByTitle('更改工作目录')).not.toBeInTheDocument();
    expect(screen.queryByTitle('重置为默认工作目录')).not.toBeInTheDocument();
    expect(screen.getByText('已锁定')).toBeInTheDocument();
  });
});
