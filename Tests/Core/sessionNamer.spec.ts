/**
 * 会话/任务命名（模型起名）测试。
 *
 * 需求（2026-10-01）：首次请求时应**请求模型**为本次任务起名；
 * 模型不可用时回退为截断用户消息的既有行为。
 */
import { describe, it, expect, vi } from 'vitest';
import {
  sanitizeSessionName,
  fallbackSessionName,
  generateSessionName,
  MAX_SESSION_NAME_LENGTH,
} from '../../Src/Core/Model/sessionNamer.js';
import type { NamingProvider } from '../../Src/Core/Model/sessionNamer.js';

function stubProvider(content: string | null, ok = true): NamingProvider {
  return {
    chat: vi.fn(async () => (ok ? { ok: true, value: { content: content ?? '' } } : { ok: false, error: 'boom' })),
  };
}

describe('sanitizeSessionName', () => {
  it('去掉引号与句末标点', () => {
    expect(sanitizeSessionName('“读取项目文档。”')).toBe('读取项目文档');
    expect(sanitizeSessionName('"Deploy pipeline"')).toBe('Deploy pipeline');
    expect(sanitizeSessionName('《前端重构》')).toBe('前端重构');
  });

  it('只取第一行', () => {
    expect(sanitizeSessionName('任务名\n多余说明')).toBe('任务名');
  });

  it('超长截断', () => {
    const long = 'x'.repeat(MAX_SESSION_NAME_LENGTH + 10);
    expect(sanitizeSessionName(long)?.length).toBe(MAX_SESSION_NAME_LENGTH);
  });

  it('空/空白返回 null', () => {
    expect(sanitizeSessionName('')).toBeNull();
    expect(sanitizeSessionName('   ')).toBeNull();
    expect(sanitizeSessionName(null)).toBeNull();
    expect(sanitizeSessionName('""')).toBeNull();
  });
});

describe('fallbackSessionName', () => {
  it('截断用户消息', () => {
    expect(fallbackSessionName('读取项目根目录的文件')).toBe('读取项目根目录的文件');
    expect(fallbackSessionName('a'.repeat(100)).length).toBe(41); // 40 + 省略号
  });

  it('空消息回退 New Chat', () => {
    expect(fallbackSessionName('   ')).toBe('New Chat');
  });
});

describe('generateSessionName', () => {
  it('使用模型返回的名称（含清洗）', async () => {
    const provider = stubProvider('“整理前端缺陷清单。”');
    const name = await generateSessionName({ provider, model: 'm', userMessage: '请整理一下前端缺陷' });
    expect(name).toBe('整理前端缺陷清单');
    expect(provider.chat).toHaveBeenCalledOnce();
  });

  it('模型返回空内容 → null（交由调用方回退）', async () => {
    const provider = stubProvider('   ');
    expect(await generateSessionName({ provider, model: 'm', userMessage: 'x' })).toBeNull();
  });

  it('模型调用失败 → null', async () => {
    const provider = stubProvider(null, false);
    expect(await generateSessionName({ provider, model: 'm', userMessage: 'x' })).toBeNull();
  });

  it('超时 → null（不阻塞请求）', async () => {
    const provider: NamingProvider = {
      chat: () => new Promise(() => { /* 永不返回 */ }),
    };
    const name = await generateSessionName({ provider, model: 'm', userMessage: 'x', timeoutMs: 30 });
    expect(name).toBeNull();
  });

  it('provider 抛异常 → null', async () => {
    const provider: NamingProvider = {
      chat: async () => { throw new Error('network down'); },
    };
    expect(await generateSessionName({ provider, model: 'm', userMessage: 'x' })).toBeNull();
  });
});
