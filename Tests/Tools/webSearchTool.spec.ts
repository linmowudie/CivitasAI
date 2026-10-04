/**
 * FE-067 回归测试：web.search 真实实现 / 诚实失败（替代“恒空成功”桩）
 *
 * 覆盖：
 *  - 未配置搜索服务 → NOT_ENABLED（fail-closed，绝不伪造成功）；
 *  - 配置后 → 真实调用（断言请求参数）并映射 organic[] 结果；
 *  - 服务错误 / 超时 → SEARCH_FAILED / SEARCH_TIMEOUT；
 *  - 空 query → INVALID_INPUT。
 *
 * 说明：网络层经 vi.stubGlobal('fetch') 拦截（不发起真实请求）。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { webSearch } from '../../Src/Tools/Builtin/Search/webSearch.js';
import type { ToolExecutionContext } from '../../Src/Tools/Traits/toolSpec.js';

const ctx = {
  operationId: 'op-web-1',
  agentId: 'agent-web-1',
  agentRole: 'worker',
  loopId: 'loop-web-1',
  traceId: 'trace-web-1',
} as ToolExecutionContext;

const ENV_KEYS = ['CIVITAS_WEB_SEARCH_API_KEY', 'SERPER_API_KEY', 'CIVITAS_WEB_SEARCH_ENDPOINT'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('FE-067 · web.search 工具', () => {
  it('未配置搜索服务 → NOT_ENABLED（不伪造“成功空结果”）', async () => {
    const result = await webSearch.execute({ query: 'Civitas-AI' }, ctx);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('NOT_ENABLED');
    expect(result.recoverable).toBe(false);
  });

  it('空 query → INVALID_INPUT（先于配置检查）', async () => {
    const result = await webSearch.execute({ query: '   ' }, ctx);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('INVALID_INPUT');
  });

  it('配置 API Key → 真实调用（断言请求参数）并映射结果', async () => {
    process.env['CIVITAS_WEB_SEARCH_API_KEY'] = 'test-key-123';
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        organic: [
          { title: 'Civitas-AI 简介', link: 'https://example.com/a', snippet: '多智能体系统' },
          { title: '第二条', link: 'https://example.com/b', snippet: '…' },
          { title: '第三条', link: 'https://example.com/c', snippet: '…' },
        ],
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await webSearch.execute({ query: 'Civitas-AI 多智能体', maxResults: 2 }, ctx);
    expect(result.status).toBe('success');

    // 请求参数
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { method: string; headers: Record<string, string>; body: string }];
    expect(url).toBe('https://google.serper.dev/search');
    expect(init.method).toBe('POST');
    expect(init.headers['X-API-KEY']).toBe('test-key-123');
    expect(JSON.parse(init.body)).toEqual({ q: 'Civitas-AI 多智能体', num: 2 });

    // 结果映射（截取 maxResults）
    const payload = JSON.parse(String(result.content)) as { count: number; results: Array<{ title: string; url: string }> };
    expect(payload.count).toBe(2);
    expect(payload.results[0]!.title).toBe('Civitas-AI 简介');
    expect(payload.results[0]!.url).toBe('https://example.com/a');
  });

  it('搜索服务 5xx → SEARCH_FAILED（可重试）', async () => {
    process.env['CIVITAS_WEB_SEARCH_API_KEY'] = 'test-key';
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })));

    const result = await webSearch.execute({ query: 'x' }, ctx);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('SEARCH_FAILED');
    expect(result.recoverable).toBe(true);
  });

  it('超时（AbortError）→ SEARCH_TIMEOUT', async () => {
    process.env['CIVITAS_WEB_SEARCH_API_KEY'] = 'test-key';
    vi.stubGlobal('fetch', vi.fn(async () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    }));

    const result = await webSearch.execute({ query: 'x' }, ctx);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('SEARCH_TIMEOUT');
  });

  it('自定义端点（CIVITAS_WEB_SEARCH_ENDPOINT）生效', async () => {
    process.env['CIVITAS_WEB_SEARCH_API_KEY'] = 'test-key';
    process.env['CIVITAS_WEB_SEARCH_ENDPOINT'] = 'https://search.internal:8443/';
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ organic: [] }) }));
    vi.stubGlobal('fetch', fetchMock);

    await webSearch.execute({ query: 'x' }, ctx);
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe('https://search.internal:8443/search'); // 尾部斜杠归一化
  });
});
