/**
 * FE-055 回归测试：上下文压缩链路（⑤ 步懒监听实装）
 *
 * 覆盖：
 *  - maybeCompressContext 的触发条件（消息数下限 / 阈值 / 开关）与 fail-soft 路径
 *    （摘要失败 / 异常 / 空摘要 → 保留原上下文）；
 *  - 压缩结构（[摘要, GoalReanchor, ...保留段]）、事件发布、tokens 缩减；
 *  - runIteration ⑤ 步端到端接线：达阈值时压缩、重建 messages、回写共享历史。
 *
 * 说明：模型调用经 vi.mock 拦截（不发起真实 LLM 请求）；依赖注入路径
 * （deps.modelCaller）与默认路径（Core/Model.callModel）分层覆盖。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── mock 模型调用（runIteration ⑥ 步与压缩摘要的默认出口）──
const h = vi.hoisted(() => ({ callModel: vi.fn(), callModelStream: vi.fn() }));
vi.mock('../../Src/Core/Model/modelCaller.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../Src/Core/Model/modelCaller.js')>();
  return {
    ...actual,
    callModel: h.callModel,
    callModelStream: h.callModelStream,
  };
});

import {
  maybeCompressContext, configureContextCompression, resetContextCompression,
  estimateMessageTokens, resolveTriggerTokens, sameMessageContent,
  getContextCompressionConfig,
} from '../../Src/Core/Loop/contextCompression.js';
import { runIteration, resetSystemPromptCache } from '../../Src/Core/Loop/runIteration.js';
import { createLoopState } from '../../Src/Core/Loop/loopEngine.js';
import { createLoopConfig } from '../../Src/Core/Loop/loopConfig.js';
import { clearMiddlewares } from '../../Src/Core/Middleware/middlewareRegistry.js';
import { resetRolePrompts } from '../../Src/Services/Prompts/promptRegistry.js';
import { resetEventBus, getEventLog } from '../../Src/Services/EventBus/eventBus.js';
import { EventType } from '../../Src/Services/EventBus/eventTypes.js';
import type { ChatMessage } from '../../Src/Core/Model/modelCaller.js';

// ── 工具 ────────────────────────────────────────────────────────────

/** 造 N 条长消息（每条约 400 字符 → 100 tokens 估算） */
function longHistory(n: number): ChatMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as ChatMessage['role'],
    content: `第 ${i + 1} 轮对话：${'x'.repeat(400)}`,
  }));
}

const OK_SUMMARY = { ok: true as const, value: { content: '历史摘要：完成了 A 与 B，路径 src/a.ts。' } };

beforeEach(() => {
  resetContextCompression();
  resetEventBus();
  resetSystemPromptCache();
  h.callModel.mockReset();
  h.callModelStream.mockReset();
});

// ═══════════════════════════════════════════════════════════════════
// 1. 单元：触发条件与 fail-soft
// ═══════════════════════════════════════════════════════════════════

describe('FE-055 · maybeCompressContext 单元', () => {
  it('消息数低于下限 → 不压缩（below-min-messages）', async () => {
    configureContextCompression({ triggerTokens: 1, minMessagesToCompress: 8 });
    const messages = longHistory(3);
    const result = await maybeCompressContext({
      messages, loopModel: 'm', goal: 'G', traceId: 't',
    });
    expect(result.compressed).toBe(false);
    expect(result.reason).toBe('below-min-messages');
    expect(result.messages).toBe(messages);
  });

  it('未达阈值 → 不压缩（below-threshold）', async () => {
    configureContextCompression({ triggerTokens: 100_000 });
    const result = await maybeCompressContext({
      messages: longHistory(10), loopModel: 'm', goal: 'G', traceId: 't',
    });
    expect(result.compressed).toBe(false);
    expect(result.reason).toBe('below-threshold');
  });

  it('开关关闭 → 不压缩（disabled）', async () => {
    configureContextCompression({ enabled: false, triggerTokens: 1 });
    const result = await maybeCompressContext({
      messages: longHistory(10), loopModel: 'm', goal: 'G', traceId: 't',
    });
    expect(result.compressed).toBe(false);
    expect(result.reason).toBe('disabled');
  });

  it('达阈值触发压缩：结构 = [摘要, GoalReanchor, ...保留段]，tokens 缩减，事件发布', async () => {
    configureContextCompression(
      { triggerTokens: 100, keepRecentMessages: 4 },
      { modelCaller: async () => OK_SUMMARY },
    );
    const messages = longHistory(12);
    const tokensBefore = estimateMessageTokens(messages);

    const result = await maybeCompressContext({
      messages,
      loopModel: 'm',
      goal: '实现登录接口',
      traceId: 'trace-compress-1',
      loopId: 'loop-1',
    });

    expect(result.compressed).toBe(true);
    expect(result.tokensAfter).toBeLessThan(result.tokensBefore);

    // 结构：[摘要 system, 重锚 system, ...最近 4 条原文]
    expect(result.messages).toHaveLength(2 + 4);
    expect(result.messages[0]!.role).toBe('system');
    expect(result.messages[0]!.content).toContain('[上下文压缩摘要]');
    expect(result.messages[0]!.content).toContain('src/a.ts');
    expect(result.messages[1]!.content).toContain('[GoalReanchor]');
    expect(result.messages[1]!.content).toContain('实现登录接口');
    // 保留段与原始尾部逐条一致
    expect(result.messages.slice(2)).toEqual(messages.slice(-4));

    const events = getEventLog({ eventType: EventType.CONTEXT_COMPRESSED });
    expect(events).toHaveLength(1);
    expect(events[0]!.traceId).toBe('trace-compress-1');
    expect(events[0]!.payload['reanchorInjected']).toBe(true);
    expect(events[0]!.payload['tokensBefore']).toBe(Math.round(tokensBefore));
  });

  it('摘要失败（返回 err）→ fail-soft 保留原上下文', async () => {
    configureContextCompression(
      { triggerTokens: 100 },
      { modelCaller: async () => ({ ok: false as const, error: 'LLM 超时', severity: 'ERROR' as const }) },
    );
    const messages = longHistory(10);
    const result = await maybeCompressContext({
      messages, loopModel: 'm', goal: 'G', traceId: 't',
    });
    expect(result.compressed).toBe(false);
    expect(result.reason).toContain('summarize-failed');
    expect(result.messages).toBe(messages);
    expect(getEventLog({ eventType: EventType.CONTEXT_COMPRESSED })).toHaveLength(0);
  });

  it('摘要抛异常 → fail-soft 保留原上下文', async () => {
    configureContextCompression(
      { triggerTokens: 100 },
      { modelCaller: async () => { throw new Error('网络中断'); } },
    );
    const result = await maybeCompressContext({
      messages: longHistory(10), loopModel: 'm', goal: 'G', traceId: 't',
    });
    expect(result.compressed).toBe(false);
    expect(result.reason).toContain('summarize-error');
    expect(result.reason).toContain('网络中断');
  });

  it('空摘要 → fail-soft 保留原上下文', async () => {
    configureContextCompression(
      { triggerTokens: 100 },
      { modelCaller: async () => ({ ok: true as const, value: { content: '   ' } }) },
    );
    const result = await maybeCompressContext({
      messages: longHistory(10), loopModel: 'm', goal: 'G', traceId: 't',
    });
    expect(result.compressed).toBe(false);
    expect(result.reason).toBe('empty-summary');
  });

  it('resolveTriggerTokens：显式配置优先；未注册模型回退兜底值', () => {
    configureContextCompression({ triggerTokens: 12345 });
    expect(resolveTriggerTokens('any-model')).toBe(12345);

    configureContextCompression({ triggerTokens: undefined });
    expect(resolveTriggerTokens('unregistered-model')).toBe(
      getContextCompressionConfig().fallbackTriggerTokens,
    );
  });

  it('sameMessageContent：逐条同构判定', () => {
    const a: ChatMessage[] = [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '收到' },
    ];
    expect(sameMessageContent(a, [{ role: 'user', content: '你好' }, { role: 'assistant', content: '收到' }])).toBe(true);
    expect(sameMessageContent(a, [{ role: 'user', content: '你好' }])).toBe(false);
    expect(sameMessageContent(a, [{ role: 'user', content: '你好' }, { role: 'assistant', content: '好的' }])).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. 集成：runIteration ⑤ 步接线（mock 模型）
// ═══════════════════════════════════════════════════════════════════

describe('FE-055 · runIteration ⑤ 步端到端（mock 模型）', () => {
  afterEach(() => {
    clearMiddlewares();
    resetRolePrompts();
    resetContextCompression();
  });

  async function runOnceWithHistory(history: ChatMessage[], chatMessages: ChatMessage[]) {
    const configResult = createLoopConfig({ model: 'test-model', stream: false });
    expect(configResult.ok).toBe(true);
    if (!configResult.ok) throw new Error('config');
    const config = configResult.value;

    const loopState = createLoopState({
      loopId: 'loop-compress-test',
      agentId: 'agent-worker-1',
      traceId: 'trace-compress-e2e',
      config,
    });

    return runIteration(loopState, {
      userInput: '继续完成剩余工作',
      sessionId: 'sess-compress-test',
      agentId: 'agent-worker-1',
      agentRole: 'worker',
      config,
      currentIteration: 1,
      totalTokensConsumed: 0,
      chatMessages,
      recentCallTimestamps: [],
    });
  }

  it('达阈值：压缩生效于本轮请求（含摘要+重锚）、事件发布、共享历史原位替换', async () => {
    // 摘要（⑤ 步）与模型调用（⑥ 步）各一次 → 排队两个 mock 返回
    h.callModel
      .mockResolvedValueOnce({ ok: true, value: { content: '压缩后的历史摘要', usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 }, model: 'test-model' } })
      .mockResolvedValueOnce({ ok: true, value: { content: '任务完成。', finish_reason: 'stop', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, model: 'test-model' } });

    configureContextCompression({ triggerTokens: 50, keepRecentMessages: 2, minMessagesToCompress: 4 });

    const history = longHistory(8); // 独立数组：避免断言间共享引用
    const chatMessages: ChatMessage[] = history.map(m => ({ ...m }));

    const result = await runOnceWithHistory(history, chatMessages);
    expect(result.ok).toBe(true);

    // 模型调用共 2 次：第 1 次为摘要（⑤），第 2 次为主调用（⑥）
    expect(h.callModel).toHaveBeenCalledTimes(2);
    const modelCallMessages = h.callModel.mock.calls[1]![1] as Array<{ role: string; content: string }>;

    // ⑥ 步请求：系统提示 + 摘要 + 重锚 + 最近 2 条（原 8 条历史被压缩）
    expect(modelCallMessages[0]!.role).toBe('system');
    expect(modelCallMessages.some(m => String(m.content).includes('[上下文压缩摘要]'))).toBe(true);
    expect(modelCallMessages.some(m => String(m.content).includes('[GoalReanchor]'))).toBe(true);
    expect(modelCallMessages.some(m => String(m.content).includes('第 1 轮对话'))).toBe(false);
    expect(modelCallMessages.some(m => String(m.content).includes('第 8 轮对话'))).toBe(true);

    // 事件发布
    const events = getEventLog({ eventType: EventType.CONTEXT_COMPRESSED });
    expect(events).toHaveLength(1);
    expect(events[0]!.payload['reanchorInjected']).toBe(true);

    // 共享历史原位替换（跨轮生效）：2 摘要/重锚 + 2 保留 = 4 条
    expect(chatMessages).toHaveLength(4);
    expect(chatMessages[0]!.content).toContain('[上下文压缩摘要]');
    expect(chatMessages[3]!.content).toContain('第 8 轮对话');
  });

  it('未达阈值：不压缩、不调用摘要、历史原样', async () => {
    h.callModel.mockResolvedValue({
      ok: true,
      value: { content: '任务完成。', finish_reason: 'stop', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, model: 'test-model' },
    });
    configureContextCompression({ triggerTokens: 999_999, minMessagesToCompress: 4 });

    const history = longHistory(8);
    const chatMessages: ChatMessage[] = history.map(m => ({ ...m }));

    const result = await runOnceWithHistory(history, chatMessages);
    expect(result.ok).toBe(true);

    // 仅主调用一次（无摘要调用）
    expect(h.callModel).toHaveBeenCalledTimes(1);
    expect(chatMessages).toHaveLength(8);
    expect(getEventLog({ eventType: EventType.CONTEXT_COMPRESSED })).toHaveLength(0);
  });
});
