/**
 * @vitest-environment jsdom
 *
 * 审批卡挂载链（回归：出现审批事件但对话里没有对应审批实例）
 *
 * 链路：工具开始（onToolCallStart）→ 工具行预创建 → 审批事件（APPROVAL_REQUESTED）
 *       → applyApprovalRequired 按 toolCallId 挂 approvalId → ToolGroup 渲染内嵌审批卡
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';

const h = vi.hoisted(() => ({ approvals: [] as unknown[] }));
vi.mock('@/services/api', () => ({
  apiGet: vi.fn(async (path: string) => {
    if (path === '/api/reviews') return { ok: true, data: [] };
    if (path.startsWith('/api/approvals')) return { ok: true, data: h.approvals };
    return { ok: true, data: [] };
  }),
  apiPost: vi.fn(async () => ({ ok: true, data: {} })),
}));

import { useChatStore } from '../../Client/src/stores/chatStore';
import { useApprovalStore } from '../../Client/src/stores/approvalStore';
import { ToolGroup } from '../../Client/src/ai-components/harness/ToolGroup';

const SID = 'sess-approval-chain';
const MID = 'msg-1';
const CALL_ID = 'call_shell_1';

function seedStreamingMessage() {
  useChatStore.setState({
    activeSessionId: SID,
    messages: {
      [SID]: [
        {
          id: MID,
          message_id: MID,
          role: 'assistant',
          content: '',
          status: 'streaming',
          created_at: Date.now(),
          segments: [{ kind: 'tools', toolCalls: [], iteration: 1 }],
        },
      ],
    },
  } as never);
}

describe('审批卡挂载链', () => {
  beforeEach(() => {
    h.approvals = [];
    seedStreamingMessage();
  });

  it('工具开始 → 审批事件：工具行被挂上 approvalId（内嵌卡的前提）', () => {
    useChatStore.getState().applyToolCallStarted(MID, {
      toolCallId: CALL_ID,
      toolName: 'ShellExec',
      arguments: { command: 'echo hi' },
      iteration: 1,
    });
    useChatStore.getState().applyApprovalRequired({
      toolCallId: CALL_ID,
      approvalId: 'ap-1',
    });

    const msgs = useChatStore.getState().messages[SID]!;
    const seg = msgs[0]!.segments!.find((s) => s.kind === 'tools') as {
      toolCalls: Array<{ id: string; approvalId?: string; approvalStatus?: string }>;
    };
    const tc = seg.toolCalls.find((t) => t.id === CALL_ID);
    expect(tc, '工具行应存在（applyToolCallStarted 未创建）').toBeTruthy();
    expect(tc!.approvalId, '审批事件未挂到工具行 ⇒ 对话里不会出现审批卡').toBe('ap-1');
    expect(tc!.approvalStatus).toBe('pending');
  });

  it('挂上审批后：ToolGroup 渲染内嵌审批卡（含确认执行）', async () => {
    useApprovalStore.setState({
      approvals: [
        {
          approvalId: 'ap-1',
          status: 'PENDING',
          toolName: 'ShellExec',
          toolCallId: CALL_ID,
          sessionId: SID,
          requestedAt: Date.now(),
          timeoutSec: 300,
          deciders: [{ role: 'auditor', agentId: 'a1' }],
          decidedBy: [],
        },
      ],
    } as never);

    const { container } = render(
      <ToolGroup
        toolCalls={[
          {
            id: CALL_ID,
            name: 'ShellExec',
            arguments: { command: 'echo hi' },
            status: 'running',
            approvalId: 'ap-1',
            approvalStatus: 'pending',
          },
        ] as never}
        iteration={1}
      />,
    );

    expect(container.textContent ?? '').toContain('ShellExec');
    expect(screen.getByText(/确认执行/)).toBeInTheDocument();
  });
});
