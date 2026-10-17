/**
 * @vitest-environment jsdom
 *
 * 思考内容必须留在折叠区里（回归：用户反馈"思考内容会从思考区跑出来"）
 *
 * 判定标准（可证伪）：
 *  - 已完成的消息：推理文本**默认不可见**（折叠态），且**不出现在正文容器**里
 *  - 点击「思考过程」后：推理文本才可见
 */
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import MessageBubble from '../../Client/src/components/Chat/MessageBubble';
import type { ChatMessage } from '../../Client/src/stores/chatStore';

const COT = 'REASONING-MARKER-就在思考区里';
const BODY = '正文-MARKER';

function msg(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm1',
    role: 'assistant',
    content: BODY,
    status: 'complete',
    created_at: Date.now(),
    reasoning: COT,
    ...overrides,
  } as ChatMessage;
}

describe('思考过程折叠区', () => {
  it('已完成消息：推理默认折叠（不可见），正文可见', () => {
    render(<MessageBubble msg={msg()} />);
    expect(screen.getByText(BODY)).toBeTruthy();
    // 折叠态：推理文本不应出现
    expect(screen.queryByText(COT)).toBeNull();
  });

  it('点击「思考过程」后才展示推理', () => {
    render(<MessageBubble msg={msg()} />);
    fireEvent.click(screen.getByText(/思考过程/));
    expect(screen.getByText(COT)).toBeTruthy();
  });

  it('【负向】推理不得被当成正文渲染（正文容器里不得含推理标记）', () => {
    const { container } = render(<MessageBubble msg={msg()} />);
    const text = container.textContent ?? '';
    expect(text).toContain(BODY);
    expect(text).not.toContain(COT);
  });
});
