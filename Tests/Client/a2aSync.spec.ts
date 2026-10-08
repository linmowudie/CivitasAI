/**
 * Tests/Client/a2aSync.spec.ts
 *
 * P0c · A2A 客户端同步编排（设计 §15.3/§15.4）
 * 不变量：
 *  1. **客户端脱敏**：密钥模式与敏感键名在**上传前**被替换，并记录字段路径
 *  2. **分批 ≤500**，逐批上行；**每批成功后**才标记已同步（失败不标记 ⇒ 可重试）
 *  3. 上行失败即停并上报错误（不抛出）
 *  4. 拉回按游标分页；`applyPulled` 的 **skipped** 计入（本机优先，不覆盖本机）
 *  5. `enabled=false` → 直接跳过（同步开关）
 *  6. 全流程**永不抛出**（同步失败不得打断主流程）
 */

import { describe, it, expect, vi } from 'vitest';
import {
  MAX_BATCH_SIZE, pullA2A, pushA2A, redactForUpload, syncA2A, toServerItem,
  type A2ASyncDeps, type ServerA2AMessage,
} from '../../Client/src/services/a2aSync';
import type { IpcSyncRow } from '../../Client/src/services/ipcApi';

function row(over: Partial<IpcSyncRow> = {}): IpcSyncRow {
  return {
    messageId: 'm-1', taskId: 't1', traceId: 't1', kind: 'answer',
    sourceAgentId: 'agent-worker-1', targetAgentId: 'agent-prime_director-1',
    parentMessageId: null, correlationId: null, visibility: 'domain',
    contentHash: 'hash-1', prevHash: null, payload: { text: '普通内容' },
    summary: null, verdict: 'allow', priority: 'normal', memoryRefs: [], createdAt: 1_800_000_000_000,
    ...over,
  };
}

function serverMsg(over: Partial<ServerA2AMessage> = {}): ServerA2AMessage {
  return {
    messageId: 'm-1', taskId: 't1', traceId: 't1', kind: 'answer',
    sourceAgentId: 'a', targetAgentId: 'b', visibility: 'domain', contentHash: 'hash-1',
    prevHash: null, payload: { text: 'x' }, summary: null, verdict: 'allow',
    redactedFields: [], truncated: false, createdAt: 1,
    ...over,
  };
}

function mkDeps(over: Partial<A2ASyncDeps> = {}): A2ASyncDeps {
  return {
    listUnsynced: vi.fn(async () => ({ ok: true, data: [] as IpcSyncRow[] })),
    markSynced: vi.fn(async () => ({ ok: true, data: { marked: 0 } })),
    applyPulled: vi.fn(async () => ({ ok: true, data: { applied: 0, skipped: 0 } })),
    postServer: vi.fn(async () => ({ ok: true, data: {} }) as never),
    getServer: vi.fn(async () => ({ ok: true, data: { items: [], nextCursor: null } }) as never),
    ...over,
  };
}

describe('P0c · 客户端脱敏（上传前）', () => {
  it('密钥模式 → 占位符并记录路径', () => {
    const r = redactForUpload({ note: 'sk-abcdefghijklmnopqrstuvwxyz123456', nested: { t: 'Bearer abcdefghijklmnopqrstuvwxyz' } });
    expect(JSON.stringify(r.payload)).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456');
    expect(JSON.stringify(r.payload)).toContain('«redacted:secret»');
    expect(r.redactedFields).toContain('$.note');
    expect(r.redactedFields.some(f => f.includes('nested.t'))).toBe(true);
  });

  it('敏感键名 → 直接替换；数组元素路径带下标', () => {
    const r = redactForUpload({ apiKey: 'plain', list: [{ token: 'abc' }] });
    expect((r.payload as Record<string, unknown>)['apiKey']).toBe('«redacted:secret»');
    expect(((r.payload as Record<string, unknown>)['list'] as Array<Record<string, unknown>>)[0]!['token']).toBe('«redacted:secret»');
    expect(r.redactedFields).toContain('$.apiKey');
    expect(r.redactedFields).toContain('$.list[0].token');
  });

  it('普通内容不被改动（无误伤）', () => {
    const r = redactForUpload({ text: '解析层已完成，下一步补测试', count: 3 });
    expect(r.redactedFields).toEqual([]);
    expect(r.payload).toEqual({ text: '解析层已完成，下一步补测试', count: 3 });
  });

  it('toServerItem：带上 redactedFields 且只传契约字段', () => {
    const { item, redactedFields } = toServerItem(row({ payload: { token: 'x' } }));
    expect(redactedFields.length).toBe(1);
    expect(item['redactedFields']).toEqual(redactedFields);
    expect(item['messageId']).toBe('m-1');
    expect(item['verdict']).toBe('allow');
    expect(item['parentMessageId']).toBeUndefined();   // 空值不传（契约可选）
  });
});

describe('P0c · 上行（分批 + 成功后标记）', () => {
  it('空列表 → 不发请求、不标记', async () => {
    const deps = mkDeps();
    const r = await pushA2A(deps);
    expect(r).toEqual({ pushed: 0, batches: 0, redacted: 0, errors: [] });
    expect(deps.postServer).not.toHaveBeenCalled();
  });

  it('★ 分批 ≤500，逐批上行，每批成功后标记', async () => {
    const rows = [1, 2, 3, 4, 5].map(i => row({ messageId: `m-${i}` }));
    const marked: string[][] = [];
    const batches: number[] = [];
    const deps = mkDeps({
      listUnsynced: vi.fn(async () => ({ ok: true, data: rows })),
      postServer: vi.fn(async (_p: string, body: unknown) => {
        batches.push((body as { items: unknown[] }).items.length);
        return { ok: true, data: { created: 0, updated: 0, total: 0 } } as never;
      }),
      markSynced: vi.fn(async (ids: string[]) => { marked.push(ids); return { ok: true, data: { marked: ids.length } }; }),
    });
    const r = await pushA2A(deps, { batchSize: 2 });
    expect(batches).toEqual([2, 2, 1]);
    expect(r.pushed).toBe(5);
    expect(r.batches).toBe(3);
    expect(marked.flat().length).toBe(5);
  });

  it('★ 上传的是**已脱敏**载荷', async () => {
    let sent = '';
    const deps = mkDeps({
      listUnsynced: vi.fn(async () => ({ ok: true, data: [row({ payload: { token: 'super-secret-value' } })] })),
      postServer: vi.fn(async (_p: string, body: unknown) => { sent = JSON.stringify(body); return { ok: true, data: {} } as never; }),
    });
    await pushA2A(deps);
    expect(sent).not.toContain('super-secret-value');
    expect(sent).toContain('«redacted:secret»');
  });

  it('★ 上行失败：不标记、记录错误、不抛出', async () => {
    const deps = mkDeps({
      listUnsynced: vi.fn(async () => ({ ok: true, data: [row()] })),
      postServer: vi.fn(async () => ({ ok: false, error: { message: '网络不可用' } }) as never),
    });
    const r = await pushA2A(deps);
    expect(r.pushed).toBe(0);
    expect(r.errors[0]).toContain('网络不可用');
    expect(deps.markSynced).not.toHaveBeenCalled();
  });

  it('batchSize 上限受契约约束（不会超过 500）', async () => {
    const deps = mkDeps({
      listUnsynced: vi.fn(async () => ({ ok: true, data: Array.from({ length: 3 }, (_, i) => row({ messageId: `m-${i}` })) })),
      postServer: vi.fn(async () => ({ ok: true, data: {} }) as never),
    });
    await pushA2A(deps, { batchSize: 9999 });
    const call = (deps.postServer as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    expect(((call[1] as { items: unknown[] }).items).length).toBeLessThanOrEqual(MAX_BATCH_SIZE);
  });
});

describe('P0c · 拉回（游标分页 + 本机优先）', () => {
  it('★ 两页拉全：cursor 传递、skipped 计入', async () => {
    const queries: Array<Record<string, unknown>> = [];
    const deps = mkDeps({
      getServer: vi.fn(async (_p: string, q?: Record<string, unknown>) => {
        queries.push(q ?? {});
        if ((q ?? {})['cursor'] === 'c1') return { ok: true, data: { items: [serverMsg({ messageId: 'm-2' })], nextCursor: null } } as never;
        return { ok: true, data: { items: [serverMsg({ messageId: 'm-1' })], nextCursor: 'c1' } } as never;
      }),
      applyPulled: vi.fn(async (items: unknown[]) => ({ ok: true, data: { applied: items.length === 1 && (items[0] as ServerA2AMessage).messageId === 'm-2' ? 0 : 1, skipped: items.length === 1 && (items[0] as ServerA2AMessage).messageId === 'm-2' ? 1 : 0 } })),
    });
    const r = await pullA2A(deps);
    expect(r.pages).toBe(2);
    expect(r.received).toBe(2);
    expect(r.applied).toBe(1);
    expect(r.skipped).toBe(1);       // 本机已有 → 跳过，不覆盖
    expect(queries[1]!['cursor']).toBe('c1');
  });

  it('maxPages 生效（防长时间占用）', async () => {
    const deps = mkDeps({
      getServer: vi.fn(async () => ({ ok: true, data: { items: [serverMsg()], nextCursor: 'c1' } }) as never),
    });
    const r = await pullA2A(deps, { maxPages: 3 });
    expect(r.pages).toBe(3);
  });

  it('服务端错误 → 记录错误并停止（不抛出）', async () => {
    const deps = mkDeps({ getServer: vi.fn(async () => ({ ok: false, error: { message: '未登录' } }) as never) });
    const r = await pullA2A(deps);
    expect(r.pages).toBe(0);
    expect(r.errors[0]).toContain('未登录');
  });
});

describe('P0c · 编排与开关', () => {
  it('enabled=false → 完全跳过（不发任何请求）', async () => {
    const deps = mkDeps();
    const r = await syncA2A({ deps, enabled: false });
    expect(r.ok).toBe(true);
    expect(r.skipped).toBe('disabled');
    expect(deps.listUnsynced).not.toHaveBeenCalled();
    expect(deps.getServer).not.toHaveBeenCalled();
  });

  it('★ 完整同步：上行 + 拉回，错误汇总；永不抛出', async () => {
    const deps = mkDeps({
      listUnsynced: vi.fn(async () => ({ ok: true, data: [row()] })),
      postServer: vi.fn(async () => ({ ok: true, data: { created: 1, updated: 0, total: 1 } }) as never),
      markSynced: vi.fn(async () => ({ ok: true, data: { marked: 1 } })),
      getServer: vi.fn(async () => ({ ok: true, data: { items: [serverMsg()], nextCursor: null } }) as never),
      applyPulled: vi.fn(async () => ({ ok: true, data: { applied: 1, skipped: 0 } })),
    });
    const r = await syncA2A({ deps });
    expect(r.ok).toBe(true);
    expect(r.push.pushed).toBe(1);
    expect(r.pull.applied).toBe(1);
    expect(r.errors).toEqual([]);
  });

  it('部分失败：ok=false 但结果完整返回（调用方可提示，不崩）', async () => {
    const deps = mkDeps({
      listUnsynced: vi.fn(async () => ({ ok: true, data: [row()] })),
      postServer: vi.fn(async () => ({ ok: false, error: { message: 'boom' } }) as never),
    });
    const r = await syncA2A({ deps });
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.pull).toBeDefined();
  });
});
