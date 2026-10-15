/**
 * @vitest-environment jsdom
 *
 * P1-7b · 任务卡结果行呈现（配合"派发 ≠ 完成"的新口径）
 *
 * 后端 `result` 在派发态是一段内部 JSON（`{"status":"dispatched",…}`），
 * 直接把字面量摊在任务卡上有两种坏结果：用户读不懂，或把 `dispatched` 当成"已完成"。
 * 这里锁住两件事：内部形态要翻译成人话，且**原始 JSON 字面量不得出现在界面上**；
 * 非内部形态（失败原因、聚合结果）必须原样透出，不做乐观美化。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';

const h = vi.hoisted(() => ({ tasks: [] as unknown[] }));

vi.mock('@/services/api', () => ({
  apiGet: vi.fn(async (path: string) => (
    path === '/api/tasks' ? { ok: true, data: h.tasks } : { ok: true, data: [] }
  )),
  apiPost: vi.fn(async () => ({ ok: false, error: { type: 'network', message: 'n/a' } })),
  apiDelete: vi.fn(async () => ({ ok: false, error: { type: 'network', message: 'n/a' } })),
}));

import TaskPanel from '../../Client/src/views/TaskPanel';
import { useTaskStore } from '../../Client/src/stores/taskStore';

const record = (over: Record<string, unknown>) => ({
  taskId: 'task-x1', traceId: 'trace-x1', description: '开发独立的后端和前端模块',
  status: 'running', createdAt: Date.now(), routingMode: 'DELEGATION', ...over,
});

beforeEach(() => {
  h.tasks = [];
  useTaskStore.setState({ tasks: [], loading: false });
  vi.clearAllMocks();
});

describe('任务卡结果行（P1-7b）', () => {
  it('派发态：显示"已派发 N 个子任务"，不出现内部 JSON 字面量', async () => {
    h.tasks = [record({
      result: JSON.stringify({ status: 'dispatched', routingMode: 'DELEGATION', assignmentCount: 2 }),
    })];
    render(<TaskPanel />);

    await waitFor(() => expect(screen.getByText(/已派发 2 个子任务，等待编排收尾/)).toBeInTheDocument());
    expect(screen.getAllByText('执行中').length).toBeGreaterThan(0);
    expect(screen.queryByText(/"dispatched"/)).toBeNull();
    expect(screen.queryByText(/assignmentCount/)).toBeNull();
  });

  it('用户取消：翻译成中文说明，不显示 cancelled_by_user', async () => {
    h.tasks = [record({ status: 'cancelled', result: 'cancelled_by_user' })];
    render(<TaskPanel />);

    await waitFor(() => expect(screen.getByText(/已由用户取消/)).toBeInTheDocument());
    expect(screen.getAllByText('已取消').length).toBeGreaterThan(0);
    expect(screen.queryByText(/cancelled_by_user/)).toBeNull();
  });

  it('失败原因原样透出（不做乐观美化）', async () => {
    h.tasks = [record({ status: 'failed', result: '路由模式 LITIGATION 尚未实现（S12）' })];
    render(<TaskPanel />);

    await waitFor(() => expect(screen.getByText(/路由模式 LITIGATION 尚未实现/)).toBeInTheDocument());
    expect(screen.getAllByText('已失败').length).toBeGreaterThan(0);
  });
});
