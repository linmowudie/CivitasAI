/**
 * FE-064 回归测试：缓存链路接线（toolResultCache → 派发器 / promptCache → 模型调用层）
 *
 * 覆盖：
 *  - 幂等 SAFE 工具：二次同参调用命中缓存（execute 仅一次）；结果原样返回；
 *  - 有副作用工具（非 SAFE）成功执行后**保守清空**读缓存（防脏读）；
 *  - 属主隔离：切换账号后同参数不命中他人缓存；
 *  - promptCache：同 system 前缀的第二次调用判定为复用命中（modelCaller 接线）。
 *
 * 说明：不依赖网络（fake provider）与数据库。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { dispatchToolCall } from '../../Src/Tools/Registry/toolDispatcher.js';
import { registerTool, clearRegistry } from '../../Src/Tools/Registry/toolRegistry.js';
import { contentOutputSchema } from '../../Src/Tools/Builtin/_shared.js';
import type { ToolDefinition, ToolExecutionContext } from '../../Src/Tools/Traits/toolSpec.js';
import {
  initToolResultCache, clearToolResultCache, getToolResultCacheStats,
  getCachedToolResult, cacheToolResult,
} from '../../Src/Services/Cache/toolResultCache.js';
import {
  configureToolServicePorts, resetToolServicePorts,
} from '../../Src/Tools/Registry/toolServicePorts.js';
import { initPromptCache, getCacheStats, hashPromptPrefix } from '../../Src/Services/Cache/promptCache.js';
import { callModel } from '../../Src/Core/Model/modelCaller.js';
import {
  registerProvider, setRoutingConfig, resetRouter,
} from '../../Src/Infra/Llm/Router/modelRouter.js';
import type { LlmProvider } from '../../Src/Infra/Llm/Provider/providerBase.js';
import { setActiveOwner, LOCAL_OWNER } from '../../Src/Services/AccountScope/activeAccount.js';
import { ok } from '../../Src/Infra/types.js';

// ── 假工具 ──────────────────────────────────────────────────────────

let safeCalls = 0;
let writeCalls = 0;

function makeTool(name: string, dangerLevel: 'SAFE' | 'CONTROLLED', idempotency: 'YES' | 'NO', onExecute: () => void): ToolDefinition {
  const spec: ToolDefinition['spec'] = {
    name,
    version: '0.1.0',
    description: '测试工具',
    inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: [], additionalProperties: false },
    outputSchema: contentOutputSchema('{ r }'),
    dangerLevel,
    idempotency,
    reversibility: 'REVERSIBLE',
    sideEffectScope: dangerLevel === 'SAFE' ? 'none' : 'workspace',
    requiredRoles: ['worker'],
    sandboxMode: 'none',
    timeoutMs: 1000,
  };
  // idempotency != 'NO' 时 idempotencyKeyFields 必填（注册期校验）
  if (idempotency !== 'NO') {
    (spec as { idempotencyKeyFields?: string[] }).idempotencyKeyFields = ['q'];
  }
  return {
    spec,
    async execute() {
      onExecute();
      return { role: 'tool' as const, tool_call_id: 'tc', status: 'success' as const, recoverable: false, content: `${name}-result` };
    },
  };
}

function makeCtx(): ToolExecutionContext {
  return {
    operationId: 'op-cache-1',
    agentId: 'agent-cache-1',
    agentRole: 'worker',
    loopId: 'loop-cache-1',
    traceId: 'trace-cache-1',
  } as ToolExecutionContext;
}

/** 假 Provider：chat 返回固定 usage */
function makeFakeProvider(): LlmProvider {
  const result = ok({
    content: 'hi',
    usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 },
    model: 'm1',
  });
  const model = { id: 'm1', context_window: 8000, max_output: 1024, supports_vision: false, supports_tools: true, cost_per_1k_input: 0, cost_per_1k_output: 0 };
  return {
    name: 'fake-cache',
    getModels: () => [model],
    supportsModel: () => true,
    chat: async () => result,
    chatStream: async () => result,
  } as unknown as LlmProvider;
}

beforeEach(() => {
  clearRegistry();
  clearToolResultCache();
  resetRouter();
  setActiveOwner(LOCAL_OWNER);
  safeCalls = 0;
  writeCalls = 0;
  // 分层修正（2026-10-04）：派发器的缓存能力经端口注入（Tools 不可直连 Services）
  initToolResultCache();
  configureToolServicePorts({
    toolResultCache: { get: getCachedToolResult, put: cacheToolResult, clear: clearToolResultCache },
  });
  registerTool(makeTool('cache.safe.read', 'SAFE', 'YES', () => { safeCalls++; }));
  registerTool(makeTool('cache.write.op', 'CONTROLLED', 'NO', () => { writeCalls++; }));
});

afterEach(() => {
  clearRegistry();
  clearToolResultCache();
  resetRouter();
  setActiveOwner(LOCAL_OWNER);
  resetToolServicePorts();
});

// ═══════════════════════════════════════════════════════════════════
// toolResultCache
// ═══════════════════════════════════════════════════════════════════

describe('FE-064 · toolResultCache（派发器接线）', () => {
  it('幂等 SAFE 工具：二次同参调用命中缓存（execute 只一次，结果一致）', async () => {
    const first = await dispatchToolCall({ toolName: 'cache.safe.read', arguments: { q: 'x' }, context: makeCtx() });
    const second = await dispatchToolCall({ toolName: 'cache.safe.read', arguments: { q: 'x' }, context: makeCtx() });

    expect(safeCalls).toBe(1); // 第二次未执行
    expect(first.text).toBe('cache.safe.read-result');
    expect(second.text).toBe(first.text);
    expect(second.result.status).toBe('success');
    expect(getToolResultCacheStats().size).toBe(1);

    // 不同参数 → 未命中，重新执行
    await dispatchToolCall({ toolName: 'cache.safe.read', arguments: { q: 'y' }, context: makeCtx() });
    expect(safeCalls).toBe(2);
  });

  it('有副作用工具成功执行后：读缓存被保守清空（防脏读）', async () => {
    await dispatchToolCall({ toolName: 'cache.safe.read', arguments: { q: 'x' }, context: makeCtx() });
    expect(getToolResultCacheStats().size).toBe(1);

    await dispatchToolCall({ toolName: 'cache.write.op', arguments: {}, context: makeCtx() });
    expect(writeCalls).toBe(1);
    expect(getToolResultCacheStats().size).toBe(0); // 已清空

    // 再次读 → 缓存未命中 → 重新执行
    await dispatchToolCall({ toolName: 'cache.safe.read', arguments: { q: 'x' }, context: makeCtx() });
    expect(safeCalls).toBe(2);
  });

  it('属主隔离：切换账号后同参数不命中他人缓存', async () => {
    await dispatchToolCall({ toolName: 'cache.safe.read', arguments: { q: 'x' }, context: makeCtx() });
    expect(safeCalls).toBe(1);

    setActiveOwner('bob');
    await dispatchToolCall({ toolName: 'cache.safe.read', arguments: { q: 'x' }, context: makeCtx() });
    expect(safeCalls).toBe(2); // bob 未命中 alice/local 的缓存

    setActiveOwner(LOCAL_OWNER);
    await dispatchToolCall({ toolName: 'cache.safe.read', arguments: { q: 'x' }, context: makeCtx() });
    expect(safeCalls).toBe(2); // 回到原属主仍命中（未被覆盖）
  });
});

// ═══════════════════════════════════════════════════════════════════
// promptCache
// ═══════════════════════════════════════════════════════════════════

describe('FE-064 · promptCache（模型调用层接线）', () => {
  it('同 system 前缀的第二次调用判定为复用命中', async () => {
    initPromptCache();
    registerProvider(makeFakeProvider());
    setRoutingConfig({
      defaultModel: 'fake-cache/m1', directorModel: 'fake-cache/m1', workerModel: 'fake-cache/m1',
      verifierModel: 'fake-cache/m1', arbitrationModels: ['fake-cache/m1', 'fake-cache/m1', 'fake-cache/m1'],
      fallbackOrder: ['fake-cache'], timeoutMs: 5000, firstByteTimeoutMs: 3000, interChunkTimeoutMs: 3000,
    });

    const messages = [
      { role: 'system' as const, content: 'You are Civitas-AI. 固定前缀段。' },
      { role: 'user' as const, content: '你好' },
    ];

    const r1 = await callModel('fake-cache/m1', messages);
    expect(r1.ok).toBe(true);
    const stats1 = getCacheStats();
    expect(stats1.totalLookups).toBe(1);
    expect(stats1.totalHits).toBe(0); // 首次：登记
    expect(stats1.totalCachedTokens).toBe(100);

    const r2 = await callModel('fake-cache/m1', messages);
    expect(r2.ok).toBe(true);
    const stats2 = getCacheStats();
    expect(stats2.totalLookups).toBe(2);
    expect(stats2.totalHits).toBe(1); // 第二次：命中（前缀复用）
    expect(stats2.hitRate).toBeCloseTo(0.5, 5);
  });

  it('hashPromptPrefix：同前缀稳定、异前缀不同', () => {
    const a = hashPromptPrefix('prefix-A-固定内容');
    const b = hashPromptPrefix('prefix-A-固定内容');
    const c = hashPromptPrefix('prefix-B-其它内容');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
