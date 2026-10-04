/**
 * @vitest-environment jsdom
 *
 * 同步编排（syncService）
 *
 * 覆盖：字段映射（本地 ↔ 服务端）、偏好抽取、pull 应用偏好 + 导入记忆、
 * push 的幂等键（clientMemoryId / clientEventId）、分批、统计水位推进。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  serverGet: vi.fn(),
  serverPost: vi.fn(),
  serverPut: vi.fn(),
}));

vi.mock('@/services/api', () => ({ apiGet: h.apiGet, apiPost: h.apiPost }));
vi.mock('@/services/serverApi', () => ({
  serverGet: h.serverGet,
  serverPost: h.serverPost,
  serverPut: h.serverPut,
}));

import {
  extractPrefs,
  mapMemoryStatus,
  mapStatusToLocal,
  pullAll,
  pushAll,
  toLocalMemoryEntry,
  toServerMemoryItem,
  type LocalLongTermMemory,
  type ServerMemory,
} from '../../Client/src/services/syncService';
import { usePrefsStore, DEFAULT_PREFS } from '../../Client/src/stores/prefsStore';
import { useChatStore } from '../../Client/src/stores/chatStore';

const localMemory: LocalLongTermMemory = {
  memoryId: 'ltm-1',
  title: '构建规范',
  content: 'TS strict',
  category: 'rule',
  assertion: 'observed',
  sourceTraceIds: ['t1'],
  status: 'active',
  accessCount: 3,
  createdAt: 1_790_000_000_000,
  lastAccessedAt: 1_790_000_100_000,
};

const serverMemory: ServerMemory = {
  id: 'srv-1',
  clientMemoryId: 'ltm-9',
  title: '云端记忆',
  content: 'cloud content',
  category: 'fact',
  assertion: 'observed',
  status: 'archived',
  contradictedBy: null,
  sourceTraceIds: ['t9'],
  sourceArbitrationIds: null,
  accessCount: 1,
  createdAt: '2026-10-01T00:00:00.000Z',
  lastAccessedAt: '2026-10-01T01:00:00.000Z',
  updatedAt: '2026-10-01T01:00:00.000Z',
};

beforeEach(() => {
  h.apiGet.mockReset();
  h.apiPost.mockReset();
  h.serverGet.mockReset();
  h.serverPost.mockReset();
  h.serverPut.mockReset();
  window.localStorage.clear();
  usePrefsStore.setState({
    prefs: { ...DEFAULT_PREFS },
    meta: { serverRevision: 0, statsSyncSince: 0, lastPullAt: null, lastPushAt: null },
    dirty: false,
    loaded: true,
  });
  useChatStore.setState({ selectedModel: '', selectedWorkingMode: 'DIRECT' });
});

describe('字段映射', () => {
  it('本地状态 → 服务端枚举（有损映射需稳定）', () => {
    expect(mapMemoryStatus('active')).toBe('active');
    expect(mapMemoryStatus('deprecated')).toBe('archived');
    expect(mapMemoryStatus('contradicted')).toBe('archived');
    expect(mapMemoryStatus('deleted')).toBe('deleted');
  });

  it('服务端状态 → 本地枚举', () => {
    expect(mapStatusToLocal('active')).toBe('active');
    expect(mapStatusToLocal('archived')).toBe('deprecated');
    expect(mapStatusToLocal('archived', 'other-memory')).toBe('contradicted');
    expect(mapStatusToLocal('deleted')).toBe('deprecated');
  });

  it('本地记忆 → 服务端 item：clientMemoryId 用 memoryId（幂等对齐）', () => {
    const item = toServerMemoryItem(localMemory);
    expect(item['clientMemoryId']).toBe('ltm-1');
    expect(item['title']).toBe('构建规范');
    expect(item['status']).toBe('active');
    expect(item['createdAt']).toBe(new Date(1_790_000_000_000).toISOString());
  });

  it('服务端记忆 → 本地 entry：优先用 clientMemoryId', () => {
    const entry = toLocalMemoryEntry(serverMemory);
    expect(entry.memoryId).toBe('ltm-9');
    expect(entry.status).toBe('deprecated');
    expect(entry.createdAt).toBe(new Date('2026-10-01T00:00:00.000Z').getTime());
  });

  it('偏好抽取：只接受已知字段，非法类型忽略', () => {
    expect(extractPrefs(undefined)).toBeUndefined();
    expect(extractPrefs({})).toBeUndefined();
    expect(extractPrefs({ app: { selectedModel: 'm1', selectedWorkingMode: 'DIRECT', bogus: 1 } }))
      .toEqual({ selectedModel: 'm1', selectedWorkingMode: 'DIRECT' });
    expect(extractPrefs({ app: { selectedModel: 123 } })).toEqual({});
  });
});

describe('pullAll', () => {
  it('应用服务端偏好到本地 store，并导入服务端记忆', async () => {
    h.serverGet.mockImplementation(async (path: string) => {
      if (path === '/v1/settings') {
        return {
          ok: true,
          data: {
            revision: 5,
            data: { app: { selectedModel: 'cloud-model', selectedWorkingMode: 'DIRECT', theme: 'light', lastActiveFeature: 'memory' } },
            updatedAt: '2026-10-02T00:00:00.000Z',
          },
        };
      }
      if (path === '/v1/memories') return { ok: true, data: { items: [serverMemory], nextCursor: null } };
      if (path === '/v1/stats/overview') {
        return { ok: true, data: { lifetime: { events: 10, value: 100, activeDays: 2, firstAt: null, lastAt: null }, memories: { total: 1 }, settings: { revision: 5 }, sessions: { active: 1 }, account: { createdAt: null, lastLoginAt: null } } };
      }
      return { ok: false, error: { code: 'NOT_FOUND', message: 'x' } };
    });
    h.apiPost.mockResolvedValue({ ok: true, data: { imported: 1, updated: 0 } });

    const res = await pullAll();

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.settings.revision).toBe(5);
      expect(res.data.memories).toEqual({ fetched: 1, imported: 1, updated: 0 });
      expect(res.data.stats?.lifetime.events).toBe(10);
    }
    // 偏好写入本地 + 运行时不落空
    expect(usePrefsStore.getState().prefs.selectedModel).toBe('cloud-model');
    expect(usePrefsStore.getState().prefs.theme).toBe('light');
    expect(usePrefsStore.getState().meta.serverRevision).toBe(5);
    expect(useChatStore.getState().selectedModel).toBe('cloud-model');
    // 记忆导入本地（走本地 REST）
    expect(h.apiPost).toHaveBeenCalledWith(
      '/api/memory/long-term/bulk',
      expect.objectContaining({ items: [expect.objectContaining({ memoryId: 'ltm-9' })] }),
    );
  });

  it('★ 任务归档状态下行：只对齐本机已存在的任务，不为云端孤儿创建空会话', async () => {
    // 本机有两个任务：一个未归档、一个已归档
    h.apiGet.mockImplementation(async (path: string) => {
      if (path === '/api/sessions?archived=all') {
        return {
          ok: true,
          data: [
            { session_id: 'sess-local-1', title: '本地任务 1', created_at: 1, updated_at: 2, archived_at: null },
            { session_id: 'sess-local-2', title: '本地任务 2', created_at: 1, updated_at: 2, archived_at: 99 },
          ],
        };
      }
      return { ok: false, error: { code: 'NOT_FOUND', message: 'x' } };
    });
    h.serverGet.mockImplementation(async (path: string) => {
      if (path === '/v1/settings') return { ok: true, data: { revision: 1, data: {}, updatedAt: '' } };
      if (path === '/v1/memories') return { ok: true, data: { items: [], nextCursor: null } };
      if (path === '/v1/tasks') {
        return {
          ok: true,
          data: {
            items: [
              // 服务端说：1 已归档（需下行为归档）
              { clientSessionId: 'sess-local-1', title: '本地任务 1', createdAt: 1, updatedAt: 2, archivedAt: 123 },
              // 服务端说：2 未归档（需下行为取消归档）
              { clientSessionId: 'sess-local-2', title: '本地任务 2', createdAt: 1, updatedAt: 2, archivedAt: null },
              // 云端孤儿（本机无正文）→ 必须跳过，不创建空会话
              { clientSessionId: 'sess-cloud-only', title: '云端任务', createdAt: 1, updatedAt: 2, archivedAt: 5 },
            ],
          },
        };
      }
      if (path === '/v1/stats/overview') {
        return { ok: true, data: { lifetime: { events: 0, value: 0, activeDays: 0, firstAt: null, lastAt: null }, memories: { total: 0 }, settings: { revision: 1 }, sessions: { active: 0 }, account: { createdAt: null, lastLoginAt: null } } };
      }
      return { ok: false, error: { code: 'NOT_FOUND', message: 'x' } };
    });
    h.apiPost.mockResolvedValue({ ok: true, data: { imported: 0, updated: 0 } });

    const res = await pullAll();
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.tasks).toEqual({ fetched: 3, archivedApplied: 2 });

    // 两次对齐：sess-local-1 → 归档；sess-local-2 → 取消归档；云端孤儿不处理
    expect(h.apiPost).toHaveBeenCalledWith('/api/sessions/sess-local-1/archive', { archived: true });
    expect(h.apiPost).toHaveBeenCalledWith('/api/sessions/sess-local-2/archive', { archived: false });
    const archiveCalls = h.apiPost.mock.calls.filter((c) => String(c[0]).includes('/archive'));
    expect(archiveCalls).toHaveLength(2);
    expect(String(archiveCalls[0]![0])).not.toContain('sess-cloud-only');
  });

  it('记忆拉取失败不影响设置生效（降级为警告）', async () => {
    h.serverGet.mockImplementation(async (path: string) => {
      if (path === '/v1/settings') return { ok: true, data: { revision: 1, data: {}, updatedAt: '' } };
      if (path === '/v1/memories') return { ok: false, error: { code: 'INTERNAL', message: '记忆服务异常' } };
      return { ok: false, error: { code: 'INTERNAL', message: '概览异常' } };
    });

    const res = await pullAll();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.memories.fetched).toBe(0);
      expect(res.data.warnings.some((w) => w.includes('记忆拉取失败'))).toBe(true);
    }
  });

  it('设置请求失败 → 整体失败（不静默）', async () => {
    h.serverGet.mockResolvedValue({ ok: false, error: { code: 'NETWORK', message: '连不上' } });
    const res = await pullAll();
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error.code).toBe('NETWORK');
  });
});

describe('pushAll', () => {
  it('上传偏好（带 expectedRevision）、记忆（clientMemoryId 幂等）与统计（clientEventId 幂等）', async () => {
    usePrefsStore.setState({
      prefs: { ...DEFAULT_PREFS, selectedModel: 'local-model' },
      meta: { serverRevision: 4, statsSyncSince: 0, lastPullAt: null, lastPushAt: null },
      dirty: true,
      loaded: true,
    });
    h.serverPut.mockResolvedValue({ ok: true, data: { revision: 5, data: {}, updatedAt: '' } });
    h.apiGet.mockImplementation(async (path: string) => {
      if (path.startsWith('/api/memory/long-term')) return { ok: true, data: { items: [localMemory], total: 1 } };
      if (path.startsWith('/api/sync/stats-events')) {
        return {
          ok: true,
          data: {
            events: [
              { kind: 'chat.turn', value: 1, occurredAt: 1_790_000_000_000, clientEventId: 'msg:m1' },
              { kind: 'token.consumed', value: 120, occurredAt: 1_790_000_001_000, clientEventId: 'tx:t1' },
            ],
            nextSince: 1_790_000_001_000,
            truncated: false,
          },
        };
      }
      return { ok: false, error: { type: '4xx', message: 'unexpected' } };
    });
    h.serverPost.mockImplementation(async (path: string) => {
      if (path === '/v1/memories/bulk') return { ok: true, data: { created: 1, updated: 0 } };
      if (path === '/v1/stats/events') return { ok: true, data: { accepted: 2, submitted: 2 } };
      return { ok: false, error: { code: 'NOT_FOUND', message: path } };
    });

    const res = await pushAll();

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.settings.revision).toBe(5);
      expect(res.data.memories).toEqual({ submitted: 1, created: 1, updated: 0 });
      expect(res.data.stats.accepted).toBe(2);
    }

    // 设置：带 expectedRevision 且包含 app 偏好
    const putBody = h.serverPut.mock.calls[0]?.[1] as { expectedRevision?: number; data: { app: { selectedModel: string } } };
    expect(putBody.expectedRevision).toBe(4);
    expect(putBody.data.app.selectedModel).toBe('local-model');

    // 记忆：clientMemoryId = 本地 memoryId
    const bulkBody = h.serverPost.mock.calls.find((c) => c[0] === '/v1/memories/bulk')?.[1] as { items: Array<Record<string, unknown>> };
    expect(bulkBody.items[0]?.['clientMemoryId']).toBe('ltm-1');

    // 统计：幂等键原样上行
    const statsBody = h.serverPost.mock.calls.find((c) => c[0] === '/v1/stats/events')?.[1] as { events: Array<{ clientEventId: string }> };
    expect(statsBody.events.map((e) => e.clientEventId)).toEqual(['msg:m1', 'tx:t1']);

    // 水位推进 + 脏标记清除
    expect(usePrefsStore.getState().meta.statsSyncSince).toBe(1_790_000_001_000);
    expect(usePrefsStore.getState().dirty).toBe(false);
  });

  it('force=true 时不带 expectedRevision（用户选择以本机为准）', async () => {
    usePrefsStore.setState({
      prefs: { ...DEFAULT_PREFS }, meta: { serverRevision: 7, statsSyncSince: 0, lastPullAt: null, lastPushAt: null }, dirty: false, loaded: true,
    });
    h.serverPut.mockResolvedValue({ ok: true, data: { revision: 8, data: {}, updatedAt: '' } });
    h.apiGet.mockResolvedValue({ ok: true, data: { items: [], total: 0, events: [], nextSince: 0, truncated: false } });

    await pushAll({ force: true });
    const putBody = h.serverPut.mock.calls[0]?.[1] as { expectedRevision?: number };
    expect(putBody.expectedRevision).toBeUndefined();
  });

  it('设置写入冲突 → 返回 REVISION_MISMATCH（不上传其余数据）', async () => {
    h.serverPut.mockResolvedValue({
      ok: false,
      error: { code: 'REVISION_MISMATCH', message: '冲突', details: { currentRevision: 9 } },
    });

    const res = await pushAll();
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error.code).toBe('REVISION_MISMATCH');
    expect(h.apiGet).not.toHaveBeenCalled();
  });

  it('记忆上传失败 → 警告但不阻断统计上传', async () => {
    usePrefsStore.setState({
      prefs: { ...DEFAULT_PREFS }, meta: { serverRevision: 0, statsSyncSince: 0, lastPullAt: null, lastPushAt: null }, dirty: false, loaded: true,
    });
    h.serverPut.mockResolvedValue({ ok: true, data: { revision: 1, data: {}, updatedAt: '' } });
    h.apiGet.mockImplementation(async (path: string) => {
      if (path.startsWith('/api/memory/long-term')) return { ok: true, data: { items: [localMemory], total: 1 } };
      if (path.startsWith('/api/sync/stats-events')) {
        return { ok: true, data: { events: [{ kind: 'chat.turn', value: 1, occurredAt: 1, clientEventId: 'msg:x' }], nextSince: 1, truncated: false } };
      }
      return { ok: false, error: { type: '4xx', message: 'x' } };
    });
    h.serverPost.mockImplementation(async (path: string) => {
      if (path === '/v1/memories/bulk') return { ok: false, error: { code: 'PAYLOAD_TOO_LARGE', message: '太多' } };
      if (path === '/v1/stats/events') return { ok: true, data: { accepted: 1, submitted: 1 } };
      return { ok: false, error: { code: 'NOT_FOUND', message: path } };
    });

    const res = await pushAll();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.warnings.some((w) => w.includes('记忆上传失败'))).toBe(true);
      expect(res.data.stats.accepted).toBe(1);
    }
  });
});
