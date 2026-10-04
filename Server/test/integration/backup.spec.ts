/**
 * 集成测试：备份 / 恢复 —— 核心场景「卸载重装后重建」。
 *
 * 场景：A 设备写入设置（含多次修订）+ 记忆 + 统计 → 导出备份包 →
 *      模拟"软件被卸载、本地数据全丢"（服务端数据清空）→ 用同一账号登录 →
 *      用备份包恢复 → 数据完整回来，且 revision/内容/统计一致。
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { getTestDb, isDbAvailable, truncateAll, closeTestDb } from '../helpers/pg.js';
import { buildTestApp, createClient, dataOf, errorCodeOf, type TestApp, type TestClient, type AuthedUser } from '../helpers/app.js';
import type { Db } from '../../src/db/pool.js';
import { listAllMemories } from '../../src/repositories/memories.js';

const dbAvailable = await isDbAvailable();
const d = dbAvailable ? describe : describe.skip;

interface BackupBundle {
  format: string;
  version: number;
  exportedAt: string;
  account?: { email: string; displayName: string | null };
  settings: { revision: number; data: Record<string, unknown> } | null;
  memories: { id: string; clientMemoryId: string | null; title: string; content: string; category: string }[];
  stats: { events: { kind: string; value: number; occurredAt: string }[] } | null;
  /** 完整性标记（SV-001）：缺省表示完整 */
  truncated?: { stats?: { limit: number; reason: string } };
}

interface RestoreReport {
  mode: string;
  settings: { restored: boolean; revision: number };
  memories: { created: number; updated: number; total: number };
  stats: { accepted: number };
}

d('备份与恢复（集成）', () => {
  let db: Db;
  let t: TestApp;
  let api: TestClient;
  let user: AuthedUser;

  beforeAll(async () => {
    db = await getTestDb();
  });
  beforeEach(async () => {
    await truncateAll(db);
    t = await buildTestApp(db);
    api = createClient(t.app);
    user = await api.register('backup@example.com', 'Passw0rd123', '备份用户');
  });
  afterEach(async () => {
    await t.close();
  });
  afterAll(async () => {
    await closeTestDb();
  });

  const token = () => user.tokens.accessToken;

  /** 写入一批可校验的样例数据；返回期望值 */
  async function seed(): Promise<{ settingsData: Record<string, unknown>; memoryCount: number; statEventCount: number }> {
    const settingsData = { theme: 'dark', language: 'zh-CN', providers: { default: 'GLM-5.1' } };
    await api.put('/v1/settings', { data: settingsData }, token());
    await api.patch('/v1/settings', { patch: { fontScale: 1.15 } }, token()); // revision → 2

    for (let i = 1; i <= 3; i++) {
      await api.post(
        '/v1/memories',
        {
          clientMemoryId: `local-memory-${i}`,
          title: `记忆 ${i}`,
          content: `这是第 ${i} 条记忆内容`,
          category: i === 1 ? 'preference' : 'fact',
          sourceTraceIds: [`trace-${i}`],
        },
        token(),
      );
    }

    await api.post(
      '/v1/stats/events',
      {
        events: [
          { kind: 'chat.turn', value: 100, occurredAt: '2026-03-01T01:00:00.000Z', clientEventId: 's1' },
          { kind: 'chat.turn', value: 200, occurredAt: '2026-03-01T02:00:00.000Z', clientEventId: 's2' },
          { kind: 'tool.call', value: 1, occurredAt: '2026-03-01T03:00:00.000Z', clientEventId: 's3' },
        ],
      },
      token(),
    );

    return { settingsData, memoryCount: 3, statEventCount: 3 };
  }

  it('导出包含账户摘要、设置、记忆与（可选）统计', async () => {
    const expected = await seed();

    const withoutStats = dataOf(await api.get<BackupBundle>('/v1/backup', token()));
    expect(withoutStats.format).toBe('civitas.backup');
    expect(withoutStats.version).toBe(1);
    expect(withoutStats.account?.email).toBe('backup@example.com');
    expect(withoutStats.settings?.data).toEqual({ ...expected.settingsData, fontScale: 1.15 });
    expect(withoutStats.settings?.revision).toBe(2);
    expect(withoutStats.memories).toHaveLength(3);
    expect(withoutStats.stats).toBeNull(); // 默认不含统计

    const withStats = dataOf(await api.get<BackupBundle>('/v1/backup?includeStats=true', token()));
    expect(withStats.stats?.events).toHaveLength(3);
  });

  it('下载端点返回附件头与完整 JSON 内容', async () => {
    await seed();
    // 下载端点直接返回备份 JSON（非 {ok,data} 包装），这里用 inject 取原始响应
    const res = await t.app.inject({
      method: 'GET',
      url: '/v1/backup/download',
      headers: { authorization: `Bearer ${token()}` },
    });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['content-disposition'])).toContain('attachment; filename="civitas-backup-');
    expect(String(res.headers['content-type'])).toContain('application/json');

    const parsed = JSON.parse(res.body) as BackupBundle;
    expect(parsed.format).toBe('civitas.backup');
    expect(parsed.memories).toHaveLength(3);
  });

  it('★ SV-001：记忆导出键集分页取全量，不受单页上限静默截断', async () => {
    // 直接写入 5 条（固定时间戳，保证分页边界可控）
    for (let i = 1; i <= 5; i++) {
      await db.execute(
        `INSERT INTO memories (user_id, title, content, category, assertion, status, created_at, last_accessed_at)
         VALUES ($1, $2, $3, 'general', 'observed', 'active', $4, $4)`,
        [user.user.id, `分页记忆 ${i}`, `内容 ${i}`, new Date(Date.UTC(2026, 2, 1, 0, i))],
      );
    }

    // 仓库层：pageSize=2 仍返回全部 5 条（旧实现这里只返回 2 条，即"静默截断"复现）
    const all = await listAllMemories(db, user.user.id, 2);
    expect(all.map((m) => m.title)).toEqual(['分页记忆 1', '分页记忆 2', '分页记忆 3', '分页记忆 4', '分页记忆 5']);

    // HTTP 层：备份包完整包含 5 条，且无 truncated 标记
    const bundle = dataOf(await api.get<BackupBundle>('/v1/backup', token()));
    expect(bundle.memories).toHaveLength(5);
    expect(bundle.truncated).toBeUndefined();
  });

  it('★ SV-001：统计默认全量导出；显式 statsLimit 超限时包内 truncated 如实标注', async () => {
    await seed(); // 3 条统计事件

    // 默认（不设 statsLimit）：全量导出，无标记
    const full = dataOf(await api.get<BackupBundle>('/v1/backup?includeStats=true', token()));
    expect(full.stats?.events).toHaveLength(3);
    expect(full.truncated).toBeUndefined();

    // ── HTTP 层闭环（修复前 statsLimit 未从路由透传，只能直调服务层验证）──
    // 显式设限（statsLimit=2，3 条事件超限）→ 截断必须显式标注
    const cappedHttp = dataOf(await api.get<BackupBundle>('/v1/backup?includeStats=true&statsLimit=2', token()));
    expect(cappedHttp.stats?.events).toHaveLength(2);
    expect(cappedHttp.truncated?.stats?.limit).toBe(2);
    expect(cappedHttp.truncated?.stats?.reason).toContain('statsLimit');

    // 未超限（statsLimit=10）→ 无标记
    const roomyHttp = dataOf(await api.get<BackupBundle>('/v1/backup?includeStats=true&statsLimit=10', token()));
    expect(roomyHttp.stats?.events).toHaveLength(3);
    expect(roomyHttp.truncated).toBeUndefined();

    // 下载端点同样透传（直接返回备份 JSON，非 {ok,data} 包装 → 用 inject 取原始响应）
    const downloadRes = await t.app.inject({
      method: 'GET',
      url: '/v1/backup/download?includeStats=true&statsLimit=1',
      headers: { authorization: `Bearer ${token()}` },
    });
    expect(downloadRes.statusCode).toBe(200);
    const downloadBundle = JSON.parse(downloadRes.body) as BackupBundle;
    expect(downloadBundle.stats?.events).toHaveLength(1);
    expect(downloadBundle.truncated?.stats?.limit).toBe(1);

    // 非法 statsLimit → 400（校验而非静默忽略）
    const bad = await api.get<BackupBundle>('/v1/backup?includeStats=true&statsLimit=abc', token());
    expect(bad.status).toBe(400);
    expect(errorCodeOf(bad)).toBe('VALIDATION_ERROR');
    const zero = await api.get<BackupBundle>('/v1/backup?includeStats=true&statsLimit=0', token());
    expect(zero.status).toBe(400);

    // 服务层直调（保持既有覆盖）
    const capped = await t.ctx.services.backup.export(user.user.id, { includeStats: true, statsLimit: 2 });
    expect(capped.stats?.events).toHaveLength(2);
    expect(capped.truncated?.stats?.limit).toBe(2);
  });

  it('★ 卸载重装场景：导出 → 数据清空 → 恢复 replace → 数据完整回来', async () => {
    const expected = await seed();
    const bundle = dataOf(await api.get<BackupBundle>('/v1/backup?includeStats=true', token()));

    // 模拟"服务端数据丢失/新设备重建"：清掉该用户的所有数据（保留账号与令牌）
    await db.execute('DELETE FROM user_settings WHERE user_id = $1', [user.user.id]);
    await db.execute('DELETE FROM memories WHERE user_id = $1', [user.user.id]);
    await db.execute('DELETE FROM usage_events WHERE user_id = $1', [user.user.id]);

    const afterWipe = dataOf(await api.get<BackupBundle>('/v1/backup', token()));
    expect(afterWipe.memories).toHaveLength(0);
    expect(afterWipe.settings).toBeNull();

    // 用备份包重建
    const restore = await api.post<RestoreReport>('/v1/restore', { bundle, mode: 'replace' }, token());
    expect(restore.status).toBe(200);
    const report = dataOf(restore);
    expect(report.mode).toBe('replace');
    expect(report.memories).toEqual({ created: expected.memoryCount, updated: 0, total: expected.memoryCount });
    expect(report.stats.accepted).toBe(expected.statEventCount);
    expect(report.settings.restored).toBe(true);

    // 校验设置（内容一致）
    const settings = dataOf(await api.get<{ revision: number; data: Record<string, unknown> }>('/v1/settings', token()));
    expect(settings.data).toEqual({ ...expected.settingsData, fontScale: 1.15 });

    // 校验记忆（clientMemoryId 保留，便于端侧再次对齐）
    const memories = dataOf(await api.get<{ items: { clientMemoryId: string | null; title: string }[] }>('/v1/memories', token()));
    expect(memories.items).toHaveLength(expected.memoryCount);
    const clientIds = memories.items.map((m) => m.clientMemoryId).sort();
    expect(clientIds).toEqual(['local-memory-1', 'local-memory-2', 'local-memory-3']);

    // 校验统计
    const summary = dataOf(
      await api.get<{ totalEvents: number; totalValue: number }>(
        '/v1/stats/summary?from=2026-03-01T00:00:00.000Z&to=2026-03-02T00:00:00.000Z',
        token(),
      ),
    );
    expect(summary.totalEvents).toBe(expected.statEventCount);
    expect(summary.totalValue).toBe(301);

    // 重复恢复（replace）应保持幂等，不产生重复记忆
    const again = await api.post<RestoreReport>('/v1/restore', { bundle, mode: 'replace' }, token());
    expect(dataOf(again).memories.created).toBe(expected.memoryCount);
    const memoriesAfter = dataOf(await api.get<{ items: unknown[] }>('/v1/memories', token()));
    expect(memoriesAfter.items).toHaveLength(expected.memoryCount);
  });

  it('merge 模式：按 clientMemoryId 幂等合并，不删除既有数据', async () => {
    await seed();
    const bundle = dataOf(await api.get<BackupBundle>('/v1/backup', token()));

    // 新增一条"备份包里没有"的本地记忆
    await api.post('/v1/memories', { clientMemoryId: 'local-only', title: '恢复后新增', content: 'x' }, token());

    const merge = await api.post<RestoreReport>('/v1/restore', { bundle, mode: 'merge' }, token());
    const report = dataOf(merge);
    expect(report.mode).toBe('merge');
    expect(report.memories.updated).toBe(3); // 三条同 clientMemoryId 已存在 → 更新
    expect(report.memories.created).toBe(0);

    const list = dataOf(await api.get<{ items: unknown[] }>('/v1/memories', token()));
    expect(list.items).toHaveLength(4); // 新加的那条仍在
  });

  it('非法备份包：格式/版本不符 → 400；缺字段 → 400', async () => {
    const wrongFormat = await api.post(
      '/v1/restore',
      { bundle: { format: 'other.backup', version: 1, exportedAt: new Date().toISOString(), memories: [] } },
      token(),
    );
    expect(wrongFormat.status).toBe(400);

    const missingField = await api.post('/v1/restore', { bundle: { format: 'civitas.backup' } }, token());
    expect(missingField.status).toBe(400);
    expect(errorCodeOf(missingField)).toBe('VALIDATION_ERROR');
  });

  it('恢复只影响当前账号（A 的备份恢复进 B 账号也只在 B 名下）', async () => {
    await seed();
    const bundle = dataOf(await api.get<BackupBundle>('/v1/backup', token()));

    const bob = await api.register('bob-backup@example.com');
    const bobRestore = await api.post<RestoreReport>('/v1/restore', { bundle, mode: 'merge' }, bob.tokens.accessToken);
    expect(bobRestore.status).toBe(200);

    const bobMemories = dataOf(await api.get<{ items: unknown[] }>('/v1/memories', bob.tokens.accessToken));
    expect(bobMemories.items).toHaveLength(3);

    // A 的数据不受影响（仍是 3 条，没有翻倍）
    const aliceMemories = dataOf(await api.get<{ items: unknown[] }>('/v1/memories', token()));
    expect(aliceMemories.items).toHaveLength(3);

    const distinctOwners = await db.one<{ owners: number }>(
      'SELECT COUNT(DISTINCT user_id)::int AS owners FROM memories',
    );
    expect(distinctOwners?.owners).toBe(2);
  });

  it('未鉴权无法导出或恢复', async () => {
    expect((await api.get('/v1/backup')).status).toBe(401);
    expect(
      (
        await api.post('/v1/restore', {
          bundle: { format: 'civitas.backup', version: 1, exportedAt: new Date().toISOString(), memories: [] },
        })
      ).status,
    ).toBe(401);
  });
});
