/**
 * @module services/syncService
 * @description
 * 客户端 ↔ 服务端的数据同步编排（服务端权威语义，见 Docs/Server/01 §6）。
 *
 * 上行（push）：本地偏好 → 服务端设置（带 `expectedRevision` 乐观并发）
 *              本地长时记忆 → 服务端 memories（按 `clientMemoryId` 幂等）
 *              本地派生统计 → 服务端 usage_events（按 `clientEventId` 幂等）
 * 下行（pull）：服务端设置 → 本地偏好；服务端 memories → 本地长时记忆（批量导入）
 * 备份/恢复：直接透传服务端 `/v1/backup`、`/v1/restore`（含 merge/replace）
 *
 * 依赖方向：本模块只依赖 stores 与 api 层，**不依赖 accountStore**（避免循环依赖），
 * 由 accountStore 负责进度与错误状态的展示。
 */

import { apiGet, apiPost } from './api';
import { serverGet, serverPost, serverPut, type ServerResult } from './serverApi';
import { useChatStore, type WorkingMode } from '@/stores/chatStore';
import { usePrefsStore, type AppPreferences } from '@/stores/prefsStore';
import { useConfigStore } from '@/stores/configStore';
import type { FieldValue } from '@/components/Settings/fields';
import { ipcGetLongTermMemory, ipdBulkLongTermMemory, ipcGetStatsEvents, ipcListSessions, ipcArchiveSession } from './ipcApi';

// ── 服务端 DTO（仅声明用到的字段）────────────────────────────────────

export interface ServerSettings {
  revision: number;
  data: Record<string, unknown>;
  updatedAt: string;
}

export interface ServerMemory {
  id: string;
  clientMemoryId: string | null;
  title: string;
  content: string;
  category: string;
  assertion: string;
  status: string;
  contradictedBy: string | null;
  sourceTraceIds: unknown[];
  sourceArbitrationIds: unknown[] | null;
  accessCount: number;
  createdAt: string;
  lastAccessedAt: string;
  updatedAt: string;
}

export interface ServerStatsOverview {
  lifetime: { events: number; value: number; activeDays: number; firstAt: string | null; lastAt: string | null };
  memories: { total: number };
  settings: { revision: number };
  sessions: { active: number };
  account: { createdAt: string | null; lastLoginAt: string | null };
}

export interface LocalLongTermMemory {
  memoryId: string;
  title: string;
  content: string;
  category: string;
  assertion: string;
  sourceTraceIds: string[];
  sourceArbitrationIds?: string[];
  status: string;
  contradictedBy?: string;
  accessCount: number;
  createdAt: number;
  lastAccessedAt: number;
}

export interface DerivedStatEvent {
  kind: string;
  value: number;
  occurredAt: number;
  clientEventId: string;
  meta?: Record<string, unknown>;
}

export interface PullReport {
  settings: { applied: boolean; revision: number };
  memories: { fetched: number; imported: number; updated: number };
  /** 任务元数据拉取：总数与本次对齐的归档变更数 */
  tasks?: { fetched: number; archivedApplied: number };
  stats: ServerStatsOverview | null;
  warnings: string[];
}

export interface PushReport {
  settings: { pushed: boolean; revision: number };
  memories: { submitted: number; created: number; updated: number };
  /** 任务元数据上行条数 */
  tasks?: { submitted: number };
  stats: { submitted: number; accepted: number; since: number };
  warnings: string[];
}

export interface SyncConflict {
  currentRevision: number;
}

export type PullResult = ServerResult<PullReport>;
export type PushResult = ServerResult<PushReport>;

// ── 字段映射（本地 ↔ 服务端）────────────────────────────────────────

/** 本地记忆状态 → 服务端枚举（服务端仅 active/archived/deleted，映射有损，故归档处理） */
export function mapMemoryStatus(local: string): 'active' | 'archived' | 'deleted' {
  if (local === 'active') return 'active';
  if (local === 'deleted') return 'deleted';
  return 'archived'; // deprecated / contradicted → archived（语义最接近）
}

/** 服务端记忆状态 → 本地枚举 */
export function mapStatusToLocal(server: string, contradictedBy?: string | null): string {
  if (server === 'active') return 'active';
  if (server === 'deleted') return 'deprecated';
  return contradictedBy ? 'contradicted' : 'deprecated';
}

/** 本地记忆 → 服务端 memories/bulk 的 item */
export function toServerMemoryItem(m: LocalLongTermMemory): Record<string, unknown> {
  return {
    clientMemoryId: m.memoryId,
    title: m.title,
    content: m.content,
    category: m.category,
    assertion: ['observed', 'inferred', 'verified', 'disputed'].includes(m.assertion) ? m.assertion : 'observed',
    sourceTraceIds: m.sourceTraceIds ?? [],
    sourceArbitrationIds: m.sourceArbitrationIds ?? null,
    status: mapMemoryStatus(m.status),
    contradictedBy: m.contradictedBy ?? null,
    accessCount: m.accessCount ?? 0,
    createdAt: new Date(m.createdAt).toISOString(),
    lastAccessedAt: new Date(m.lastAccessedAt).toISOString(),
  };
}

/** 服务端记忆 → 本地导入项（memoryId 用 clientMemoryId，无则退回服务端 id） */
export function toLocalMemoryEntry(m: ServerMemory): LocalLongTermMemory {
  const entry: LocalLongTermMemory = {
    memoryId: m.clientMemoryId ?? m.id,
    title: m.title,
    content: m.content,
    category: m.category,
    assertion: m.assertion,
    sourceTraceIds: Array.isArray(m.sourceTraceIds) ? m.sourceTraceIds.map(String) : [],
    status: mapStatusToLocal(m.status, m.contradictedBy),
    accessCount: m.accessCount,
    createdAt: new Date(m.createdAt).getTime(),
    lastAccessedAt: new Date(m.lastAccessedAt).getTime(),
  };
  if (Array.isArray(m.sourceArbitrationIds)) entry.sourceArbitrationIds = m.sourceArbitrationIds.map(String);
  if (m.contradictedBy) entry.contradictedBy = m.contradictedBy;
  return entry;
}

/** 从服务端 settings.data 中取出 app 偏好 */
export function extractPrefs(data: Record<string, unknown> | undefined): Partial<AppPreferences> | undefined {
  const app = data?.['app'];
  if (!app || typeof app !== 'object') return undefined;
  const rec = app as Record<string, unknown>;
  const out: Partial<AppPreferences> = {};
  if (typeof rec['selectedModel'] === 'string') out.selectedModel = rec['selectedModel'];
  if (typeof rec['selectedWorkingMode'] === 'string') out.selectedWorkingMode = rec['selectedWorkingMode'];
  if (typeof rec['theme'] === 'string') out.theme = rec['theme'];
  if (typeof rec['lastActiveFeature'] === 'string') out.lastActiveFeature = rec['lastActiveFeature'];
  return out;
}

// ── 本地数据读取（经本地 REST）──────────────────────────────────────

/** 服务端 user_tasks 的 item（标题 + 归档状态；正文不上行） */
export interface ServerTaskItem {
  clientSessionId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

/** 读取本地全部任务（含已归档）→ 服务端可接受的元数据格式 */
async function fetchLocalSessionsForSync(): Promise<ServerTaskItem[]> {
  let sessions: Array<{ session_id: string; title: string; created_at: number; updated_at: number; archived_at?: number | null }> = [];
  try {
    const ipcRes = await ipcListSessions({ archived: 'all' });
    if (ipcRes.ok && ipcRes.data) sessions = ipcRes.data;
  } catch { /* 降级到 HTTP */ }
  if (sessions.length === 0) {
    const res = await apiGet<typeof sessions>('/api/sessions?archived=all');
    if (res.ok) sessions = res.data;
  }
  return sessions.map((s) => ({
    clientSessionId: s.session_id,
    title: s.title ?? '',
    createdAt: s.created_at,
    updatedAt: s.updated_at,
    archivedAt: s.archived_at ?? null,
  }));
}

/**
 * 下行归档状态：把服务端的任务归档状态对齐到本地**已存在的**任务。
 *
 * 说明：会话正文只存本机，因此服务端有、本机没有的任务**不会**创建空会话
 * （避免出现打不开的"幽灵任务"）；仅对齐两边都有的任务的归档状态。
 */
async function applyServerTaskStates(items: ServerTaskItem[]): Promise<number> {
  if (items.length === 0) return 0;
  const local = await fetchLocalSessionsForSync();
  const localByKey = new Map(local.map((s) => [s.clientSessionId, s]));
  let changed = 0;
  for (const remote of items) {
    const mine = localByKey.get(remote.clientSessionId);
    if (!mine) continue;                       // 本机无正文 → 跳过（不建空会话）
    const remoteArchived = remote.archivedAt !== null;
    const localArchived = (mine.archivedAt ?? null) !== null;
    if (remoteArchived === localArchived) continue; // 已一致
    // 以服务端为准（服务端是"归档状态"的权威副本）；IPC 不可用时降级本地 REST
    try {
      const ipcRes = await ipcArchiveSession({ sessionId: remote.clientSessionId, archived: remoteArchived });
      if (ipcRes.ok) {
        changed++;
        continue;
      }
    } catch { /* 降级到 HTTP */ }
    const res = await apiPost(`/api/sessions/${remote.clientSessionId}/archive`, { archived: remoteArchived });
    if (res.ok) changed++;
  }
  return changed;
}

async function fetchLocalMemories(): Promise<LocalLongTermMemory[]> {
  // 优先 IPC 直连
  try {
    const ipcRes = await ipcGetLongTermMemory({ limit: 5000 });
    if (ipcRes.ok && ipcRes.data) {
      return ipcRes.data.items as LocalLongTermMemory[];
    }
  } catch { /* 降级到 HTTP */ }
  const res = await apiGet<{ items: LocalLongTermMemory[]; total: number }>('/api/memory/long-term?limit=5000');
  return res.ok ? (res.data.items ?? []) : [];
}

async function importLocalMemories(items: LocalLongTermMemory[]): Promise<{ imported: number; updated: number }> {
  if (items.length === 0) return { imported: 0, updated: 0 };
  // 优先 IPC 直连
  try {
    const ipcRes = await ipdBulkLongTermMemory(items);
    if (ipcRes.ok && ipcRes.data) {
      return { imported: ipcRes.data.imported ?? 0, updated: ipcRes.data.updated ?? 0 };
    }
  } catch { /* 降级到 HTTP */ }
  const res = await apiPost<{ imported: number; updated: number }>('/api/memory/long-term/bulk', { items });
  if (!res.ok) throw new Error(res.error.message);
  return { imported: res.data.imported ?? 0, updated: res.data.updated ?? 0 };
}

async function fetchDerivedStats(since: number): Promise<{ events: DerivedStatEvent[]; nextSince: number; truncated: boolean }> {
  // 优先 IPC 直连
  try {
    const ipcRes = await ipcGetStatsEvents({ since, limit: 500 });
    if (ipcRes.ok && ipcRes.data) {
      return {
        events: ipcRes.data.events ?? [],
        nextSince: ipcRes.data.nextSince ?? since,
        truncated: ipcRes.data.truncated ?? false,
      };
    }
  } catch { /* 降级到 HTTP */ }
  const res = await apiGet<{ events: DerivedStatEvent[]; nextSince: number; truncated: boolean }>(
    `/api/sync/stats-events?since=${since}&limit=500`,
  );
  if (!res.ok) return { events: [], nextSince: since, truncated: false };
  return { events: res.data.events ?? [], nextSince: res.data.nextSince ?? since, truncated: !!res.data.truncated };
}

// ── 偏好桥接（chatStore ↔ prefsStore）───────────────────────────────

/** push 前：把运行时选中项并入偏好快照 */
export function gatherLocalPrefs(): AppPreferences {
  const chat = useChatStore.getState();
  const prefs = usePrefsStore.getState().prefs;
  return {
    ...prefs,
    selectedModel: chat.selectedModel || prefs.selectedModel,
    selectedWorkingMode: chat.selectedWorkingMode || prefs.selectedWorkingMode,
  };
}

/** pull 后：把偏好写回运行时 store */
export function applyPrefsToRuntime(prefs: Partial<AppPreferences>): void {
  const patch: { selectedModel?: string; selectedWorkingMode?: WorkingMode } = {};
  if (typeof prefs.selectedModel === 'string' && prefs.selectedModel) patch.selectedModel = prefs.selectedModel;
  if (typeof prefs.selectedWorkingMode === 'string' && prefs.selectedWorkingMode) {
    patch.selectedWorkingMode = prefs.selectedWorkingMode as WorkingMode;
  }
  if (Object.keys(patch).length > 0) useChatStore.setState(patch);
}

// ── 拉取 ────────────────────────────────────────────────────────────

/** 分页拉取服务端全部记忆 */
export async function fetchAllServerMemories(pageSize = 200, maxPages = 50): Promise<ServerMemory[]> {
  const all: ServerMemory[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const res = await serverGet<{ items: ServerMemory[]; nextCursor: string | null }>('/v1/memories', {
      limit: pageSize,
      ...(cursor ? { cursor } : {}),
    });
    if (!res.ok) throw new Error(res.error.message);
    all.push(...res.data.items);
    if (!res.data.nextCursor) break;
    cursor = res.data.nextCursor;
  }
  return all;
}

/**
 * 全量拉取：设置 → 偏好 + 配置；记忆 → 本地导入；统计概览 → 返回给 UI。
 */
export async function pullAll(): Promise<PullResult> {
  const warnings: string[] = [];

  // ① 设置
  const settingsRes = await serverGet<ServerSettings>('/v1/settings');
  if (!settingsRes.ok) return { ok: false, error: settingsRes.error };
  const prefs = extractPrefs(settingsRes.data.data);
  usePrefsStore.getState().applyFromServer(prefs, settingsRes.data.revision);
  applyPrefsToRuntime(prefs ?? {});

  // ① b 配置同步：云端 overrides 覆盖本地（服务端权威）
  const cloudConfig = settingsRes.data.data?.['config'] as Record<string, FieldValue> | undefined;
  if (cloudConfig && typeof cloudConfig === 'object') {
    useConfigStore.getState().applyFromCloud(cloudConfig);
  }

  // ② 记忆（服务端权威 → 导入本地）
  let fetched = 0;
  let imported = 0;
  let updated = 0;
  try {
    const serverMemories = await fetchAllServerMemories();
    fetched = serverMemories.length;
    if (fetched > 0) {
      const result = await importLocalMemories(serverMemories.map(toLocalMemoryEntry));
      imported = result.imported;
      updated = result.updated;
    }
  } catch (e) {
    warnings.push(`记忆拉取失败：${e instanceof Error ? e.message : String(e)}`);
  }

  // ③ 任务（会话）元数据：对齐归档状态（2026-10-03 新增）
  //    服务端保存"哪些任务已归档"，这里把它对齐到本机已存在的任务；
  //    本机没有正文的云端任务不创建空会话（避免幽灵任务）。
  let tasksFetched = 0;
  let tasksArchivedApplied = 0;
  try {
    const res = await serverGet<{ items: ServerTaskItem[] }>('/v1/tasks', { archived: 'all', limit: 2000 });
    if (res.ok) {
      tasksFetched = res.data.items?.length ?? 0;
      tasksArchivedApplied = await applyServerTaskStates(res.data.items ?? []);
    } else {
      warnings.push(`任务元数据拉取失败：${res.error.message}`);
    }
  } catch (e) {
    warnings.push(`任务元数据拉取失败：${e instanceof Error ? e.message : String(e)}`);
  }

  // ④ 统计概览（展示用，失败不影响拉取成功）
  let stats: ServerStatsOverview | null = null;
  const statsRes = await serverGet<ServerStatsOverview>('/v1/stats/overview');
  if (statsRes.ok) stats = statsRes.data;
  else warnings.push(`统计概览获取失败：${statsRes.error.message}`);

  return {
    ok: true,
    data: {
      settings: { applied: !!settingsRes.data, revision: settingsRes.data.revision },
      memories: { fetched, imported, updated },
      tasks: { fetched: tasksFetched, archivedApplied: tasksArchivedApplied },
      stats,
      warnings,
    },
  };
}

// ── 上行 ────────────────────────────────────────────────────────────

/**
 * 全量上行：偏好 + 配置 → 设置；长时记忆 → memories/bulk；派生统计 → stats/events（分批）。
 *
 * @param options.force 忽略 `expectedRevision`（冲突时用户选择"以本机为准"）
 */
export async function pushAll(options: { force?: boolean } = {}): Promise<PushResult> {
  const warnings: string[] = [];
  const prefsStore = usePrefsStore.getState();
  const prefs = gatherLocalPrefs();
  const configOverrides = useConfigStore.getState().getOverridesForSync();

  // ① 设置（乐观并发）
  const payload: Record<string, unknown> = {
    data: {
      app: prefs,                              // 偏好
      config: configOverrides,                 // 配置 overrides（新增）
      clientVersion: '0.1.0',
      pushedAt: new Date().toISOString(),
    },
  };
  if (!options.force && prefsStore.meta.serverRevision > 0) {
    payload['expectedRevision'] = prefsStore.meta.serverRevision;
  }
  const settingsRes = await serverPut<ServerSettings>('/v1/settings', payload);
  if (!settingsRes.ok) return { ok: false, error: settingsRes.error };
  prefsStore.markPushed(settingsRes.data.revision);
  useConfigStore.getState().markSynced(); // 配置同步完成，清除 dirty

  // ② 长时记忆（按 clientMemoryId 幂等）
  let submitted = 0;
  let created = 0;
  let updated = 0;
  try {
    const localMemories = await fetchLocalMemories();
    submitted = localMemories.length;
    if (submitted > 0) {
      // 服务端单次上限 1000（MAX_MEMORIES_PER_BULK），分批提交
      for (let i = 0; i < localMemories.length; i += 500) {
        const batch = localMemories.slice(i, i + 500).map(toServerMemoryItem);
        const res = await serverPost<{ created: number; updated: number }>('/v1/memories/bulk', { items: batch });
        if (!res.ok) throw new Error(res.error.message);
        created += res.data.created ?? 0;
        updated += res.data.updated ?? 0;
      }
    }
  } catch (e) {
    warnings.push(`记忆上传失败：${e instanceof Error ? e.message : String(e)}`);
  }

  // ③ 统计（从本地派生，分批上报；幂等键保证重复上报安全）
  let statsSubmitted = 0;
  let statsAccepted = 0;
  let since = prefsStore.meta.statsSyncSince;
  try {
    for (let round = 0; round < 10; round++) {
      const derived = await fetchDerivedStats(since);
      if (derived.events.length === 0) break;
      const res = await serverPost<{ accepted: number; submitted: number }>('/v1/stats/events', {
        events: derived.events.map((e) => ({
          kind: e.kind,
          value: e.value,
          occurredAt: new Date(e.occurredAt).toISOString(),
          clientEventId: e.clientEventId,
          meta: e.meta ?? null,
        })),
      });
      if (!res.ok) throw new Error(res.error.message);
      statsSubmitted += res.data.submitted ?? derived.events.length;
      statsAccepted += res.data.accepted ?? 0;
      since = derived.nextSince;
      prefsStore.setStatsSyncSince(since);
      if (!derived.truncated) break;
    }
  } catch (e) {
    warnings.push(`统计上传失败：${e instanceof Error ? e.message : String(e)}`);
  }

  // ④ 任务（会话）元数据：标题 + 归档状态（2026-10-03 新增）
  //    正文只存本机，上行的是"有哪些任务、叫什么、是否已归档"，供重装/备份后恢复。
  let tasksSubmitted = 0;
  try {
    const local = await fetchLocalSessionsForSync();
    tasksSubmitted = local.length;
    for (let i = 0; i < local.length; i += 500) {
      const res = await serverPost<{ created: number; updated: number }>('/v1/tasks/bulk', {
        items: local.slice(i, i + 500),
      });
      if (!res.ok) throw new Error(res.error.message);
    }
  } catch (e) {
    warnings.push(`任务元数据上传失败：${e instanceof Error ? e.message : String(e)}`);
  }

  return {
    ok: true,
    data: {
      settings: { pushed: true, revision: settingsRes.data.revision },
      memories: { submitted, created, updated },
      tasks: { submitted: tasksSubmitted },
      stats: { submitted: statsSubmitted, accepted: statsAccepted, since },
      warnings,
    },
  };
}

// ── 备份 / 恢复（服务端能力直通）────────────────────────────────────

export interface BackupBundleShape {
  format: string;
  version: number;
  exportedAt: string;
  settings: unknown;
  memories: unknown[];
  stats: unknown;
  /** 完整性标记（SV-001）：缺省表示备份完整；出现时告知哪部分被截断 */
  truncated?: { stats?: { limit: number; reason: string } };
}

export function exportBackup(includeStats = true): Promise<ServerResult<BackupBundleShape>> {
  return serverGet<BackupBundleShape>('/v1/backup', { includeStats: includeStats ? 'true' : 'false' });
}

export function restoreBackup(
  bundle: unknown,
  mode: 'merge' | 'replace',
): Promise<ServerResult<{ memories: { created: number; updated: number }; stats: { accepted: number } }>> {
  return serverPost('/v1/restore', { bundle, mode });
}
