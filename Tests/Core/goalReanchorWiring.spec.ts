/**
 * FE-052 / FE-053：主循环装配接线端到端测试（mock 模型调用，不发起真实 LLM 请求）。
 *
 * 断言端到端行为：
 *  - 角色段（promptRegistry 装载的 Prompts/roles/{role}.md）进入 system 消息最前（FE-052）；
 *  - beforeModel 钩子改写回接装配：seed 钩子设置标志 → GoalReanchor 注入消息
 *    出现在最终模型请求中（FE-053 契约 + 入参 + 回接三层同时验证）；
 *  - 未装载角色词表时系统提示退化为通用段（向后兼容）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolve, join } from 'node:path';
import { existsSync, rmSync, mkdirSync } from 'node:fs';

// ── mock 模型调用（runIteration 的 ⑥ 步出口）──
const h = vi.hoisted(() => ({ callModel: vi.fn(), callModelStream: vi.fn() }));
vi.mock('../../Src/Core/Model/modelCaller.js', () => ({
  callModel: h.callModel,
  callModelStream: h.callModelStream,
}));

import { initDatabase, closeDatabase } from '../../Src/Infra/Db/database.js';
import { initMigrations, clearMigrations, migrateUp } from '../../Src/Infra/Db/migrations.js';
import { setActiveOwner, LOCAL_OWNER } from '../../Src/Services/AccountScope/activeAccount.js';
import { runIteration, resetSystemPromptCache } from '../../Src/Core/Loop/runIteration.js';
import { createLoopState } from '../../Src/Core/Loop/loopEngine.js';
import { createLoopConfig } from '../../Src/Core/Loop/loopConfig.js';
import { registerMiddleware, clearMiddlewares } from '../../Src/Core/Middleware/middlewareRegistry.js';
import { goalReanchorMiddleware } from '../../Src/Core/Middleware/builtin/goalReanchor.js';
import { loadRolePrompts, resetRolePrompts, getRolePrompt } from '../../Src/Services/Prompts/promptRegistry.js';
import type { AgentMiddleware } from '../../Src/Infra/Contracts/middlewareTypes.js';

const TEST_DB_DIR = resolve(import.meta.dirname, '../../.tmp/test-db-goal-reanchor');

function initTestDb(): void {
  closeDatabase();
  clearMigrations();
  if (existsSync(TEST_DB_DIR)) rmSync(TEST_DB_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DB_DIR, { recursive: true });
  const result = initDatabase({
    mainPath: join(TEST_DB_DIR, 'test_main.db'),
    eventsPath: join(TEST_DB_DIR, 'test_events.db'),
    memoryPath: join(TEST_DB_DIR, 'test_memory.db'),
    walMode: true,
    busyTimeoutMs: 5000,
  });
  expect(result.ok).toBe(true);
  initMigrations();
  migrateUp();
  setActiveOwner(LOCAL_OWNER);
}

/** 运行一轮主循环（单迭代；mock 模型返回"完成"文本，无工具调用） */
async function runOnce(agentRole: string) {
  const configResult = createLoopConfig({ model: 'test-model', stream: false });
  expect(configResult.ok).toBe(true);
  if (!configResult.ok) throw new Error('config');
  const config = configResult.value;

  const loopState = createLoopState({
    loopId: 'loop-wiring-test',
    agentId: `agent-${agentRole}-1`,
    traceId: 'trace-wiring-test',
    config,
  });

  const result = await runIteration(loopState, {
    userInput: '你好，请回复完成',
    sessionId: 'sess-wiring-test',
    agentId: `agent-${agentRole}-1`,
    agentRole,
    config,
    currentIteration: 1,
    totalTokensConsumed: 0,
    chatMessages: [{ role: 'user', content: '你好，请回复完成' }],
    recentCallTimestamps: [],
  });
  return result;
}

describe('FE-052 / FE-053 · 主循环装配接线（端到端，mock 模型）', () => {
  beforeEach(() => {
    initTestDb();
    clearMiddlewares();
    resetSystemPromptCache();
    resetRolePrompts();
    h.callModel.mockReset();
    h.callModel.mockResolvedValue({
      ok: true,
      value: {
        content: '任务完成。',
        finish_reason: 'stop',
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        model: 'test-model',
      },
    });
  });

  afterEach(() => {
    closeDatabase();
    clearMigrations();
    if (existsSync(TEST_DB_DIR)) rmSync(TEST_DB_DIR, { recursive: true, force: true });
    clearMiddlewares();
    resetRolePrompts();
  });

  it('角色段进入 system 消息最前 + GoalReanchor 注入回接装配（FE-052 + FE-053 端到端）', async () => {
    loadRolePrompts();
    const roleText = getRolePrompt('prime_director');
    expect(roleText).toBeTruthy();

    // seed 钩子模拟压缩/截断侧标志（truncation 源头为既有独立事项，不在本用例范围）
    const seed: AgentMiddleware = {
      name: 'TestSeedReanchor', hook: 'beforeModel', priority: 1, canShortCircuit: false,
      execute: async (c, m: unknown) => {
        c.data['needsGoalReanchor'] = true;
        c.data['currentGoal'] = '完成接线测试目标';
        return m;
      },
    };
    registerMiddleware(seed);
    registerMiddleware(goalReanchorMiddleware);

    const result = await runOnce('prime_director');
    expect(result.ok).toBe(true);

    expect(h.callModel).toHaveBeenCalledTimes(1);
    const callArgs = h.callModel.mock.calls[0] as unknown[];
    const messages = callArgs[1] as Array<{ role: string; content: string }>;

    // ① system 消息：角色段在最前 + 通用静态段仍在其后（前缀稳定三段式）
    expect(messages[0]!.role).toBe('system');
    expect(messages[0]!.content.startsWith(roleText!.slice(0, 30))).toBe(true);
    expect(messages[0]!.content).toContain('You are Civitas-AI');

    // ② GoalReanchor 注入消息出现在请求中（契约 + 入参 + 回接均生效）
    const reanchor = messages.find(m => String(m.content).includes('[GoalReanchor]'));
    expect(reanchor).toBeTruthy();
    expect(String(reanchor!.content)).toContain('完成接线测试目标');
  });

  it('未装载注册表：系统提示退化为通用段（向后兼容，不破坏既有调用方）', async () => {
    // 不注册任何 beforeModel 钩子、不装载角色词表
    const result = await runOnce('worker');
    expect(result.ok).toBe(true);

    const messages = h.callModel.mock.calls[0]![1] as Array<{ role: string; content: string }>;
    expect(messages[0]!.role).toBe('system');
    expect(messages[0]!.content.startsWith('You are Civitas-AI')).toBe(true);
    expect(messages.some(m => String(m.content).includes('[GoalReanchor]'))).toBe(false);
  });
});
