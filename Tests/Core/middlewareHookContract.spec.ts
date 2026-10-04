/**
 * FE-053：pre/post 钩子“消息改写”契约测试。
 *
 * 覆盖：链式载荷（前一钩子返回值传给后一钩子）、最终 result 回传、
 *       undefined 不覆盖、shortCircuit 保持（后续钩子不执行）、
 *       GoalReanchor 真实契约落地（seed 钩子设标志 → 重锚消息注入链首）。
 */
import { describe, it, expect, beforeEach } from 'vitest';

import {
  registerMiddleware, clearMiddlewares, executePrePostHooks,
} from '../../Src/Core/Middleware/middlewareRegistry.js';
import { goalReanchorMiddleware } from '../../Src/Core/Middleware/builtin/goalReanchor.js';
import type { AgentMiddleware, MiddlewareContext } from '../../Src/Infra/Contracts/middlewareTypes.js';

function ctx(data: Record<string, unknown> = {}): MiddlewareContext {
  return { agentId: 'a', agentRole: 'worker', sessionId: 's', iteration: 1, traceId: 't', data };
}

const MSGS = [
  { role: 'user', content: '第一条' },
  { role: 'assistant', content: '第二条' },
];

describe('FE-053 · pre/post 钩子消息改写契约', () => {
  beforeEach(() => clearMiddlewares());

  it('链式：后一钩子收到前一钩子的返回值；result 回传最终载荷', async () => {
    const seen: unknown[] = [];
    const mw1: AgentMiddleware = {
      name: 'A', hook: 'beforeModel', priority: 1, canShortCircuit: false,
      execute: async (_c, messages: unknown) => {
        seen.push(messages);
        return [{ role: 'system', content: 'A 注入' }, ...(messages as typeof MSGS)];
      },
    };
    const mw2: AgentMiddleware = {
      name: 'B', hook: 'beforeModel', priority: 2, canShortCircuit: false,
      execute: async (_c, messages: unknown) => {
        seen.push(messages);
        return [...(messages as typeof MSGS), { role: 'system', content: 'B 追加' }];
      },
    };
    registerMiddleware(mw1);
    registerMiddleware(mw2);

    const r = await executePrePostHooks('beforeModel', ctx(), MSGS);
    expect(r.shortCircuited).toBe(false);
    expect(seen[0]).toBe(MSGS); // 第一个钩子收到原始载荷
    expect((seen[1] as unknown[]).length).toBe(3); // 第二个钩子收到 A 改写后的（3 条）
    const final = r.result as Array<{ content: string }>;
    expect(final).toHaveLength(4);
    expect(final[0]!.content).toBe('A 注入');
    expect(final[3]!.content).toBe('B 追加');
  });

  it('钩子返回 undefined 时不覆盖链式载荷（beforeAgent 型）', async () => {
    const mw: AgentMiddleware = {
      name: 'Noop', hook: 'beforeAgent', priority: 1, canShortCircuit: false,
      execute: async () => { /* 无返回 */ },
    };
    registerMiddleware(mw);
    const payload = { hello: 1 };
    const r = await executePrePostHooks('beforeAgent', ctx(), payload);
    expect(r.result).toBe(payload);
  });

  it('无钩子：result 原样回传传入载荷', async () => {
    const r = await executePrePostHooks('beforeModel', ctx(), MSGS);
    expect(r.result).toBe(MSGS);
  });

  it('shortCircuit 保持：返回发起者 result，后续钩子不执行', async () => {
    let secondRan = false;
    const blocker: AgentMiddleware = {
      name: 'Blocker', hook: 'beforeModel', priority: 1, canShortCircuit: true,
      execute: async () => ({ shortCircuit: true as const, result: { content: '被拦截' } }),
    };
    const second: AgentMiddleware = {
      name: 'Second', hook: 'beforeModel', priority: 2, canShortCircuit: false,
      execute: async (_c, m: unknown) => { secondRan = true; return m; },
    };
    registerMiddleware(blocker);
    registerMiddleware(second);

    const r = await executePrePostHooks('beforeModel', ctx(), MSGS);
    expect(r.shortCircuited).toBe(true);
    expect((r.result as { content: string }).content).toBe('被拦截');
    expect(secondRan).toBe(false);
  });

  it('GoalReanchor 契约落地：seed 钩子设置 data → 重锚消息注入链首', async () => {
    const seed: AgentMiddleware = {
      name: 'Seed', hook: 'beforeModel', priority: 1, canShortCircuit: false,
      execute: async (c, m: unknown) => {
        c.data['needsGoalReanchor'] = true;
        c.data['currentGoal'] = '完成测试目标';
        return m;
      },
    };
    registerMiddleware(seed);
    registerMiddleware(goalReanchorMiddleware);

    const r = await executePrePostHooks('beforeModel', ctx(), MSGS);
    const final = r.result as Array<{ role: string; content: string }>;
    expect(final).toHaveLength(3);
    expect(final[0]!.content).toContain('[GoalReanchor]');
    expect(final[0]!.content).toContain('完成测试目标');
  });
});
