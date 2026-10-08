/**
 * Loop 级端到端：会话工作目录注入模型请求（BUG-2026-10-08-2 的收口回归）
 *
 * 修复前：`workDir` 只进 `toolCtx`，模型请求里**没有任何**工作目录信息，
 * 模型只能猜 `.` / `/` → PATH_DENIED → 空转或一次失败即退。
 * 本用例在 Loop 级（mock 模型）断言：绑定了工作目录的会话，其模型请求里
 * 必须出现 `[ctx:workspace] <绝对路径>`；未绑定会话则不得注入。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const h = vi.hoisted(() => ({ callModel: vi.fn(), callModelStream: vi.fn() }));
vi.mock('../../Src/Core/Model/modelCaller.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../Src/Core/Model/modelCaller.js')>();
  return { ...actual, callModel: h.callModel, callModelStream: h.callModelStream };
});

import { runIteration, resetSystemPromptCache } from '../../Src/Core/Loop/runIteration.js';
import { createLoopState } from '../../Src/Core/Loop/loopEngine.js';
import { createLoopConfig } from '../../Src/Core/Loop/loopConfig.js';
import { clearMiddlewares } from '../../Src/Core/Middleware/middlewareRegistry.js';
import { resetRolePrompts } from '../../Src/Services/Prompts/promptRegistry.js';
import { resetEventBus } from '../../Src/Services/EventBus/eventBus.js';
import { ContextStore } from '../../Src/Services/Context/contextStore.js';
import type { ChatMessage } from '../../Src/Core/Model/modelCaller.js';

const WORK_DIR = 'F:\\ProjectCode\\CivitasAI\\Data\\workspaces\\sess-loop-1';

beforeEach(() => {
  resetSystemPromptCache();
  resetEventBus();
  h.callModel.mockReset();
  h.callModelStream.mockReset();
});

afterEach(() => {
  clearMiddlewares();
  resetRolePrompts();
});

/** 跑一轮 runIteration（mock 模型返回纯文本 → 无工具调用） */
async function runOnce(opts: { workDir?: string; contextStore?: ContextStore }): Promise<void> {
  const configResult = createLoopConfig({ model: 'test-model', stream: false });
  if (!configResult.ok) throw new Error('config');
  const config = configResult.value;

  h.callModel.mockResolvedValueOnce({
    ok: true,
    value: {
      content: '任务完成。',
      finish_reason: 'stop',
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      model: 'test-model',
    },
  });

  const loopState = createLoopState({
    loopId: 'loop-workspace-test',
    agentId: 'agent-worker-1',
    traceId: 'trace-workspace-test',
    config,
  });

  const chatMessages: ChatMessage[] = [{ role: 'user', content: '看看工作目录里有什么' }];
  const result = await runIteration(loopState, {
    userInput: '看看工作目录里有什么',
    sessionId: 'sess-loop-1',
    agentId: 'agent-worker-1',
    agentRole: 'worker',
    config,
    currentIteration: 1,
    totalTokensConsumed: 0,
    chatMessages,
    recentCallTimestamps: [],
    ...(opts.workDir !== undefined ? { workDir: opts.workDir } : {}),
    ...(opts.contextStore !== undefined ? { contextStore: opts.contextStore } : {}),
  });
  expect(result.ok).toBe(true);
}

describe('runIteration · 工作目录进入模型可见上下文', () => {
  it('绑定工作目录时，模型请求里出现 [ctx:workspace] 与绝对路径', async () => {
    const store = new ContextStore();
    await runOnce({ workDir: WORK_DIR, contextStore: store });

    expect(h.callModel).toHaveBeenCalledTimes(1);
    const messages = h.callModel.mock.calls[0]![1] as Array<{ role: string; content: string }>;
    const wsMessage = messages.find(m => String(m.content).includes('[ctx:workspace]'));

    expect(wsMessage).toBeDefined();
    expect(String(wsMessage?.content)).toContain(WORK_DIR);
    expect(String(wsMessage?.content)).toContain('以该目录为根');
    // 追加区在历史之后（系统提示仍是第一条，前缀缓存不被破坏）
    expect(messages[0]?.role).toBe('system');
    expect(String(messages[0]?.content)).not.toContain('[ctx:workspace]');
  });

  it('未绑定工作目录时不注入（默认会话行为不变）', async () => {
    await runOnce({ contextStore: new ContextStore() });
    const messages = h.callModel.mock.calls[0]![1] as Array<{ role: string; content: string }>;
    expect(messages.some(m => String(m.content).includes('[ctx:workspace]'))).toBe(false);
  });

  it('无 contextStore 时不报错（子 Agent / 无会话上下文场景）', async () => {
    await runOnce({ workDir: WORK_DIR });
    expect(h.callModel).toHaveBeenCalledTimes(1);
  });

  it('同一会话多轮不产生重复的工作目录消息（put 幂等）', async () => {
    const store = new ContextStore();
    await runOnce({ workDir: WORK_DIR, contextStore: store });
    await runOnce({ workDir: WORK_DIR, contextStore: store });

    const secondMessages = h.callModel.mock.calls[1]![1] as Array<{ role: string; content: string }>;
    const wsMessages = secondMessages.filter(m => String(m.content).includes('[ctx:workspace]'));
    expect(wsMessages).toHaveLength(1);
  });
});
