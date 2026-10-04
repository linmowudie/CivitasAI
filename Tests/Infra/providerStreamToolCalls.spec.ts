/**
 * 回归测试：流式工具调用**增量必须透传**（修复"工具块只在完全生成后才出现"）。
 *
 * 背景（真实 bug，2026-10-03）：
 *  provider 内部一直在累积 `delta.tool_calls`，但 `onChunk` 只在有文本/思考增量时回调，
 *  且 `StreamChunk` 里**没有**工具调用字段 → 模型生成一次写文件调用（实测数十秒）期间，
 *  上层与界面完全不知道"正在生成工具调用"，工具块只能等整段响应结束、真正执行时才出现。
 *
 * 本测试直接喂一段 SSE，断言 `tool_call_delta` 被逐段透传。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { OpenAIProvider } from '../../Src/Infra/Llm/Provider/openaiProvider.js';
import type { StreamChunk } from '../../Src/Infra/Llm/Provider/providerBase.js';

/** 构造一个 SSE 响应体（ReadableStream of Uint8Array） */
function sseResponse(lines: string[]): Response {
  const encoder = new TextEncoder();
  const chunks = lines.map((l) => encoder.encode(l));
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[i++]!);
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function sse(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

/** 构造一条"工具调用增量"事件（避免深层嵌套字面量，易读且不易写错括号） */
function toolDelta(tc: Record<string, unknown>): string {
  return sse({ choices: [{ delta: { tool_calls: [tc] } }] });
}

/** 最小可注册的 provider 配置（models 必须带 context_window，否则构造期拒注） */
const TEST_CONFIG = {
  provider: 'openai-compatible-test',
  base_url: 'http://127.0.0.1:1/v1',
  // 密钥引用只支持 env: 形式（literal: 会在取密钥阶段直接失败，fetch 根本不会发生）
  api_key_ref: 'env:TEST_PROVIDER_KEY',
  display_name: '测试',
  models: [{
    id: 'test-model',
    context_window: 32_000,
    max_output: 4096,
    supports_vision: false,
    supports_tools: true,
    cost_per_1k_input: 0,
    cost_per_1k_output: 0,
  }],
} as never;

process.env.TEST_PROVIDER_KEY = 'test-key';

describe('OpenAIProvider 流式工具调用增量（回归）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('★ tool_calls 增量被透传为 chunk.tool_call_delta（此前被丢弃）', async () => {
    const events = [
      // 第一个增量：给出 id + 函数名（无参数）
      toolDelta({ index: 0, id: 'call_abc', type: 'function', function: { name: 'file.write' } }),
      // 后续增量：参数分片
      toolDelta({ index: 0, function: { arguments: '{"path":"d.txt",' } }),
      toolDelta({ index: 0, function: { arguments: '"content":"hi"}' } }),
      // 文本增量（同一响应里也可能先出文本）
      sse({ choices: [{ delta: { content: '正在写入' } }] }),
      'data: [DONE]\n\n',
    ];
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(events)));

    const provider = new OpenAIProvider(TEST_CONFIG);

    const chunks: StreamChunk[] = [];
    const result = await provider.chatStream(
      { model: 'test-model', messages: [{ role: 'user', content: '写文件' }] } as never,
      (c: StreamChunk) => chunks.push(c),
    );

    expect(result.ok).toBe(true);

    // ① 必须有工具调用增量透传（修复前为 0 条）
    const deltas = chunks.filter((c) => c.tool_call_delta?.length);
    expect(deltas.length).toBeGreaterThanOrEqual(3);

    // ② 首个增量要带 id 与函数名 → 前端据此立刻建出"生成中"的工具行
    const first = deltas[0]!.tool_call_delta![0]!;
    expect(first.index).toBe(0);
    expect(first.id).toBe('call_abc');
    expect(first.name).toBe('file.write');

    // ③ 参数分片也要透传（保证前端能显示"准备写入…"而不仅仅是空行）
    const argFragments = deltas
      .flatMap((c) => c.tool_call_delta ?? [])
      .map((d) => d.argumentsDelta ?? '')
      .join('');
    expect(argFragments).toBe('{"path":"d.txt","content":"hi"}');

    // ④ 文本增量不受影响
    expect(chunks.some((c) => c.delta === '正在写入')).toBe(true);

    // ⑤ 最终累积结果仍然完整（不因透传而破坏原有解析）
    if (result.ok) {
      const toolCalls = (result.value as unknown as { tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }).tool_calls;
      expect(toolCalls?.[0]?.id).toBe('call_abc');
      expect(toolCalls?.[0]?.function.name).toBe('file.write');
      expect(toolCalls?.[0]?.function.arguments).toBe('{"path":"d.txt","content":"hi"}');
    }
  });

  it('纯工具调用增量（无文本）也必须触发回调（此前被 if (delta || reasoning) 拦掉）', async () => {
    const events = [
      toolDelta({ index: 0, id: 'call_x', type: 'function', function: { name: 'todo.write' } }),
      'data: [DONE]\n\n',
    ];
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(events)));

    const provider = new OpenAIProvider(TEST_CONFIG);

    const chunks: StreamChunk[] = [];
    await provider.chatStream({ model: 'test-model', messages: [{ role: 'user', content: 'x' }] } as never, (c) => chunks.push(c));

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]!.delta).toBe('');
    expect(chunks[0]!.tool_call_delta?.[0]?.name).toBe('todo.write');
  });
});
