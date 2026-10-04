/**
 * @module Interface/IpcBridge/ipcBridge
 * @description
 * Electron IPC 桥接——替代原 WebSocket 网关（wsGateway/wsServer/wsHandler）。
 *
 * 职责：
 * 1. 将后端 EventBus 事件转发到渲染进程（替代 wsServer.connectClient + pushToClient）
 * 2. 处理渲染进程发来的命令（替代 wsHandler.handleClientMessage）
 * 3. 管理活跃流式生成（替代 wsHandler.activeStreams）
 *
 * 架构简化收益：代码量减少 ~70%，事件延迟从 5-10ms 降至 <1ms。
 */

import { subscribeMany } from '../../Services/EventBus/eventBus.js';
import { publish, createEvent } from '../../Services/EventBus/eventBus.js';
import { EventType } from '../../Services/EventBus/eventTypes.js';
import type { Subscription, DomainEvent } from '../../Services/EventBus/eventTypes.js';
import { getDashboardOverview } from '../RestApi/loopApi.js';
import { listPendingApprovals } from '../RestApi/approvalApi.js';
import { listMessages, addMessage, getSession, updateSessionTitle, ensureSessionWorkDir, listSessions, createSession, updateSessionWorkDir, archiveSession } from '../RestApi/chatApi.js';
import { listTodosBySession, listAllTodos, clearTodos } from '../../Services/Planning/todoStore.js';
import { getConfig } from '../RestApi/configApi.js';
import { deriveStatsEvents } from '../RestApi/syncApi.js';
import { executeLoop, type IterationContext } from '../../Core/Loop/runIteration.js';
import { buildContextHistory } from '../../Core/Model/contextHistory.js';
import { generateSessionName, fallbackSessionName } from '../../Core/Model/sessionNamer.js';
import { ContextStore } from '../../Services/Context/contextStore.js';
import { createLoopState } from '../../Core/Loop/loopEngine.js';
import { createLoopConfig } from '../../Core/Loop/loopConfig.js';
import { getRoutingConfig, resolveModel, getProviders, getRegisteredModels, registerProvider, unregisterProvider, setRoutingConfig, uniqueProviderName } from '../../Infra/Llm/Router/modelRouter.js';
import { OpenAIProvider } from '../../Infra/Llm/Provider/openaiProvider.js';
import type { RoutingConfig } from '../../Infra/Llm/Router/modelRouter.js';
import { createAgent } from '../../Core/AgentRuntime/agentFactory.js';
import { logger } from '../../Infra/Logging/logger.js';
import { inferSubgroup, assessRiskLevel } from '../../Core/Middleware/toolCallClassifier.js';
import { getDatabases } from '../../Infra/Db/database.js';
import { listAllMemories, importMemories, getActiveOwner, type LongTermMemoryEntry, type MemoryCategory, type MemoryStatus } from '../../Services/SharedMemory/longTermMemory.js';
import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { getDeviceFingerprint } from '../../Infra/Security/deviceFingerprint.js';
import {
  saveProviderSecrets,
  loadProviderSecrets,
  removeProviderSecret,
  upsertProviderSecret,
  hasUsableSecret,
  type ProvidersSecrets,
} from '../../Infra/Security/secretsStore.js';

// ── Electron 动态导入（非 Electron 环境下优雅降级）────────────────

type ElectronModule = typeof import('electron');
let electronModule: ElectronModule | null = null;

async function loadElectron(): Promise<ElectronModule | null> {
  if (electronModule) return electronModule;
  try {
    const mod = await import('electron');
    // 在非 Electron 主进程中，ipcMain 为 undefined
    if (!mod.ipcMain) {
      logger.warn('Electron ipcMain 不可用（非 Electron 主进程），IPC 桥接降级为空操作', { source: 'ipcBridge' });
      return null;
    }
    electronModule = mod;
    return electronModule;
  } catch {
    logger.warn('Electron 模块不可用，IPC 桥接将以空操作模式运行', { source: 'ipcBridge' });
    return null;
  }
}

// ── 类型 ────────────────────────────────────────────────────────────

interface IpcMessage {
  type: string;
  data: unknown;
  timestamp: number;
}

// ── 活跃流追踪 ──────────────────────────────────────────────────────

interface ActiveStream {
  messageId: string;
  sessionId: string;
  abortController: AbortController;
}

const activeStreams = new Map<string, ActiveStream>();

/**
 * 中断全部活跃流（FE-069：优雅关闭②——全局中断收口，此前为空壳）。
 * 中止 signal → 在途主循环于下一检查点退出；被中断回复由 ipcBridge 的
 * finally 兵底落库（部分回复不丢）。
 * @returns 被中断的流数
 */
export function abortAllActiveStreams(): number {
  let count = 0;
  for (const [messageId, stream] of activeStreams) {
    try {
      stream.abortController.abort();
    } catch {
      /* 已中止忽略 */
    }
    activeStreams.delete(messageId);
    count++;
  }
  return count;
}

// ── 入口 Agent 单例 ─────────────────────────────────────────────────

let entryAgentId: string | null = null;

function getOrCreateEntryAgent(model: string, traceId: string): string {
  if (entryAgentId) return entryAgentId;
  const result = createAgent({ role: 'prime_director', model }, traceId);
  if (result.ok) {
    entryAgentId = result.value.agentId;
    logger.info('入口 Agent 已创建', { source: 'ipcBridge', agentId: entryAgentId });
  } else {
    entryAgentId = 'agent-prime_director-fallback';
    logger.error('入口 Agent 创建失败，降级运行', { source: 'ipcBridge', error: result.error });
  }
  return entryAgentId;
}

// ── 启动 / 停止 ────────────────────────────────────────────────────

let eventSubscription: Subscription | null = null;

export async function startIpcBridge(): Promise<void> {
  const electron = await loadElectron();
  if (!electron) {
    // 非 Electron 环境：仅启动 HTTP 模式，IPC 桥接空操作
    logger.info('IPC 桥接以空操作模式运行（非 Electron 环境）', { source: 'ipcBridge' });
    return;
  }

  const { ipcMain, BrowserWindow } = electron;

  // ① 订阅 EventBus 全部事件 → 转发到渲染进程（替代 wsServer.connectClient）
  eventSubscription = subscribeMany(Object.values(EventType), (event: DomainEvent) => {
    const msg: IpcMessage = {
      type: event.eventType,
      data: event.payload,
      timestamp: event.timestamp,
    };
    // 广播到所有渲染进程窗口
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        win.webContents.send('backend-event', msg);
      } catch {
        // 窗口可能已关闭，静默忽略
      }
    }
  });

  // ② 监听渲染进程命令（替代 wsGateway 的 socket.on('message')）
  ipcMain.on('backend-command', (event: any, raw: string) => {
    try {
      const msg = JSON.parse(raw) as { type: string; payload?: Record<string, unknown> };
      handleCommand(event, msg);
    } catch {
      // 非法帧静默忽略
    }
  });

  // ③ 注册 invoke/handle 请求-响应通道（模型管理、会话数据等）
  registerIpcHandlers(ipcMain);

  logger.info('IPC 桥接已启动', { source: 'ipcBridge' });
}

export function stopIpcBridge(): void {
  eventSubscription?.unsubscribe();
  eventSubscription = null;
  abortAllActiveStreams();
  activeStreams.clear();
  try {
    const { ipcMain } = electronModule ?? {};
    ipcMain?.removeAllListeners('backend-command');
    // 模型管理
    ipcMain?.removeHandler('ipc-get-providers');
    ipcMain?.removeHandler('ipc-add-provider');
    ipcMain?.removeHandler('ipc-remove-provider');
    ipcMain?.removeHandler('ipc-fetch-models');
    ipcMain?.removeHandler('ipc-get-routing');
    ipcMain?.removeHandler('ipc-update-routing');
    ipcMain?.removeHandler('ipc-get-models');
    // 会话/消息
    ipcMain?.removeHandler('ipc-list-sessions');
    ipcMain?.removeHandler('ipc-create-session');
    ipcMain?.removeHandler('ipc-update-session');
  ipcMain?.removeHandler('ipc-archive-session');
  ipcMain?.removeHandler('ipc-get-todos');
  ipcMain?.removeHandler('ipc-clear-todos');
    ipcMain?.removeHandler('ipc-list-messages');
    ipcMain?.removeHandler('ipc-add-message');
    // 配置
    ipcMain?.removeHandler('ipc-get-config');
    // 记忆/技能/工具
    ipcMain?.removeHandler('ipc-get-memory-entries');
    ipcMain?.removeHandler('ipc-get-long-term-memory');
    ipcMain?.removeHandler('ipc-bulk-long-term-memory');
    ipcMain?.removeHandler('ipc-get-stats-events');
    ipcMain?.removeHandler('ipc-get-skills');
    ipcMain?.removeHandler('ipc-get-custom-tools');
    // 设备指纹 & 密钥存储
    ipcMain?.removeHandler('ipc-get-device-fingerprint');
    ipcMain?.removeHandler('ipc-save-secrets');
    ipcMain?.removeHandler('ipc-load-secrets');
  } catch {
    // 非 Electron 环境，静默忽略
  }
  logger.info('IPC 桥接已停止', { source: 'ipcBridge' });
}

// ── IPC invoke/handle 处理器（请求-响应模式）───────────────────────

function registerIpcHandlers(ipcMain: any): void {
  // 获取已注册供应商列表（含模型规格）
  ipcMain.handle('ipc-get-providers', () => {
    const providers = getProviders();
    return providers.map(p => ({
      name: p.name,
      displayName: p.displayName,
      models: p.getModels(),
    }));
  });

  // ── 供应商密钥持久化（修复"重启后 API_KEY 被刷掉"）──────────────────
  // 原先：`api_key_ref = inline:<key>` 只存在内存（providerBase 注释亦写明"重启后失效"），
  // 且客户端保存密钥时会把**已有供应商的 apiKey/baseUrl 写成空串** → 再加一个模型就刷掉上一个。
  // 现在：**后端为真源**——添加/移除供应商时就地 upsert 加密存储，启动时按凭据恢复注册。
  // 合并语义实现在 secretsStore（可单测）：upsertProviderSecret / removeProviderSecret。

  /**
   * 启动时按加密凭据恢复供应商注册——"重启后 API_KEY 仍在"的关键。
   * （仅靠 IPC 内存注册，重启即丢。）
   */
  async function restoreProvidersFromSecrets(): Promise<void> {
    try {
      const stored = await loadProviderSecrets();
      if (!stored || stored.providers.length === 0) return;
      let restored = 0;
      let skipped = 0;
      for (const secret of stored.providers) {
        // 跳过历史脏数据（曾被子串覆盖写空）
        if (!hasUsableSecret(secret)) {
          skipped++;
          continue;
        }
        // 注册名唯一化（FE-036）：同类型多实例（如两条 openai-compatible 凭据）
        // 若都以类型名注册会互相覆盖，故按当前已注册集合生成唯一名。
        const regName = uniqueProviderName(secret.provider?.trim() || secret.name);
        const result = registerProvider(new OpenAIProvider({
          provider: regName,
          base_url: secret.baseUrl,
          api_key_ref: `inline:${secret.apiKey}`,
          display_name: secret.displayName,
          models: secret.models ?? [],
        }));
        if (result.ok !== false) restored++;
      }
      logger.info('已按加密凭据恢复供应商', {
        source: 'ipcBridge', restored, skipped, total: stored.providers.length,
      });
    } catch (e) {
      logger.warn('恢复供应商凭据失败', { source: 'ipcBridge', error: e instanceof Error ? e.message : String(e) });
    }
  }

  // 添加/注册新供应商
  ipcMain.handle('ipc-add-provider', (_event: any, config: any) => {
    try {
      // 注册名唯一化（FE-036）：同类型的第二个实例（如再加一个 OpenAI 兼容端点）
      // 不再覆盖已有实例；同注册名且 base_url 相同视为**更新**（如仅换 API_KEY）。
      const baseName = String(config.provider ?? config.display_name ?? 'provider');
      const sameTarget = getProviders().some(
        (p) => p.name === baseName && p.config.base_url === config.base_url,
      );
      const regName = sameTarget ? baseName : uniqueProviderName(baseName);

      const provider = new OpenAIProvider({
        provider: regName,
        base_url: config.base_url,
        api_key_ref: `inline:${config.api_key}`,
        display_name: config.display_name,
        models: config.models ?? [],
      });
      const result = registerProvider(provider);
      if (result.ok !== false) {
        // 就地持久化这一条（只 upsert，不触碰其他供应商）；
        // name/provider 均存**注册名**，与移除、启动恢复使用同一键。
        void upsertProviderSecret({
          name: regName,
          provider: regName,
          baseUrl: config.base_url,
          apiKey: config.api_key,
          displayName: config.display_name ?? regName,
          models: config.models ?? [],
        }).catch((e: unknown) => {
          logger.warn('供应商密钥持久化失败（重启后需重新填写）', {
            source: 'ipcBridge', error: e instanceof Error ? e.message : String(e),
          });
        });
      }
      return result;
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // 注销供应商
  ipcMain.handle('ipc-remove-provider', (_event: any, name: string) => {
    try {
      unregisterProvider(name);
      void removeProviderSecret(name).catch(() => { /* 忽略：凭据删除失败不影响注销 */ });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // 启动即恢复（fire-and-forget；失败只告警，不影响应用可用）
  void restoreProvidersFromSecrets();

  // 用 API_KEY 调用 /models 端点拉取模型列表
  ipcMain.handle('ipc-fetch-models', async (_event: any, config: any) => {
    try {
      const url = `${config.base_url}/models`;
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (config.api_key) {
        headers['Authorization'] = `Bearer ${config.api_key}`;
      }
      const res = await fetch(url, { method: 'GET', headers });
      if (!res.ok) {
        const text = await res.text();
        return { ok: false, error: `HTTP ${res.status}: ${text}` };
      }
      const data = await res.json() as { data?: Array<{ id: string; [k: string]: unknown }> };
      const models = (data.data ?? []).map(m => ({
        id: m.id,
        context_window: 128000, // 默认值，拉取后由用户确认
        max_output: 8192,
        supports_vision: false,
        supports_tools: true,
        cost_per_1k_input: 0,
        cost_per_1k_output: 0,
      }));
      return { ok: true, data: models };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // 获取当前路由配置
  ipcMain.handle('ipc-get-routing', () => {
    return getRoutingConfig();
  });

  // 更新路由配置
  ipcMain.handle('ipc-update-routing', (_event: any, config: any) => {
    try {
      const current = getRoutingConfig();
      const updated: RoutingConfig = {
        defaultModel: config.defaultModel ?? current?.defaultModel ?? '',
        directorModel: config.directorModel ?? current?.directorModel ?? '',
        workerModel: config.workerModel ?? current?.workerModel ?? '',
        verifierModel: config.verifierModel ?? current?.verifierModel ?? '',
        arbitrationModels: config.arbitrationModels ?? current?.arbitrationModels ?? [],
        fallbackOrder: config.fallbackOrder ?? current?.fallbackOrder ?? [],
        timeoutMs: config.timeoutMs ?? current?.timeoutMs ?? 60000,
        firstByteTimeoutMs: config.firstByteTimeoutMs ?? current?.firstByteTimeoutMs ?? 10000,
        interChunkTimeoutMs: config.interChunkTimeoutMs ?? current?.interChunkTimeoutMs ?? 15000,
      };
      setRoutingConfig(updated);
      return { ok: true, data: updated };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // 获取所有已注册模型（qualified name 列表）
  ipcMain.handle('ipc-get-models', () => {
    return getRegisteredModels();
  });

  // ── 会话/消息管理 ──────────────────────────────────────────────────

  // 获取会话列表（?archived 语义：默认仅未归档；true=仅已归档；'all'=全部）
  ipcMain.handle('ipc-list-sessions', (_event: any, params?: { archived?: boolean | 'all' }) => {
    try {
      return { ok: true, data: listSessions({ archived: params?.archived ?? false }) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // Agent 计划清单（TODO）——按来源 agent 分组：多 agent 平级，各自一张计划表
  ipcMain.handle('ipc-get-todos', (_event: any, params?: { sessionId?: string; all?: boolean }) => {
    try {
      if (params?.all) {
        const items = listAllTodos();
        return { ok: true, data: { items, total: items.length } };
      }
      if (!params?.sessionId) return { ok: false, error: 'sessionId is required' };
      const groups = listTodosBySession(params.sessionId);
      return { ok: true, data: { sessionId: params.sessionId, groups, total: groups.reduce((n, g) => n + g.todos.length, 0) } };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  ipcMain.handle('ipc-clear-todos', (_event: any, params: { sessionId: string; agentId?: string }) => {
    try {
      const result = clearTodos(params.sessionId, params.agentId);
      if (!result.ok) return { ok: false, error: result.error };
      return { ok: true, data: { removed: result.value } };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // 归档 / 取消归档会话（软状态：不删除消息，可随时恢复）
  ipcMain.handle('ipc-archive-session', (_event: any, params: { sessionId: string; archived: boolean }) => {
    try {
      const result = archiveSession(params.sessionId, params.archived);
      if (!result.ok) return { ok: false, error: result.error };
      return { ok: true, data: result.value };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // 创建会话
  ipcMain.handle('ipc-create-session', (_event: any, params: { title?: string; workDir?: string }) => {
    try {
      const session = createSession(params?.title, params?.workDir);
      return { ok: true, data: session };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // 更新会话（标题/工作目录）
  ipcMain.handle('ipc-update-session', (_event: any, params: { sessionId: string; title?: string; workDir?: string | null }) => {
    try {
      const { sessionId, title, workDir } = params;
      if (title !== undefined) {
        updateSessionTitle(sessionId, title);
      }
      if (workDir !== undefined) {
        const result = updateSessionWorkDir(sessionId, workDir);
        if (!result.ok) return { ok: false, error: result.error };
        return { ok: true, data: result.value };
      }
      return { ok: true, data: getSession(sessionId) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // 获取消息列表
  ipcMain.handle('ipc-list-messages', (_event: any, params: { sessionId: string; limit?: number }) => {
    try {
      const session = getSession(params.sessionId);
      if (!session) return { ok: false, error: 'Session not found' };
      return { ok: true, data: listMessages(params.sessionId, params.limit ?? 50) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // 添加消息
  ipcMain.handle('ipc-add-message', (_event: any, params: { sessionId: string; role: 'user' | 'assistant' | 'system'; content: string; model?: string; tokens_used?: number }) => {
    try {
      const session = getSession(params.sessionId);
      if (!session) return { ok: false, error: 'Session not found' };
      const msg = addMessage(params.sessionId, params.role, params.content, {
        model: params.model,
        tokens_used: params.tokens_used,
      });
      return { ok: true, data: msg };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // ── 配置管理 ──────────────────────────────────────────────────────

  // 获取配置文件
  ipcMain.handle('ipc-get-config', (_event: any, name: string) => {
    try {
      const config = getConfig(name);
      if (config === undefined) return { ok: false, error: 'Config not found' };
      return { ok: true, data: config };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // ── 记忆/技能/工具 ────────────────────────────────────────────────

  // 获取记忆条目（memory_entries，长时记忆镜像投影；按属主隔离 FE-032/FE-034）
  ipcMain.handle('ipc-get-memory-entries', (_event: any, query: { namespace?: string; limit?: number; offset?: number }) => {
    try {
      const db = getDatabases();
      const memoryDb = db.memory;
      if (!memoryDb) return { ok: true, data: { items: [], total: 0 } };

      const limit = Math.min(query?.limit ?? 50, 200);
      const offset = query?.offset ?? 0;

      // 属主条件恒有；namespace 仅显式指定时过滤
      let sql = `SELECT key, value, version, namespace, updated_at, created_at
         FROM memory_entries WHERE owner_user_id = ?`;
      const params: Array<string | number> = [getActiveOwner()];
      if (query?.namespace) {
        sql += ' AND namespace = ?';
        params.push(query.namespace);
      }
      sql += ' ORDER BY updated_at DESC LIMIT ? OFFSET ?';
      params.push(limit, offset);

      const rows = memoryDb.prepare(sql).all(...params) as Array<{
        key: string; value: string; version: number; namespace: string;
        updated_at: number; created_at: number;
      }>;

      const items = rows.map(row => ({
        key: row.key,
        value: safeJsonParse(row.value),
        version: row.version,
        namespace: row.namespace,
        updatedAt: row.updated_at,
        createdAt: row.created_at,
      }));
      return { ok: true, data: { items, total: items.length } };
    } catch {
      return { ok: true, data: { items: [], total: 0 } };
    }
  });

  // 获取长时记忆
  ipcMain.handle('ipc-get-long-term-memory', (_event: any, query: { category?: string; status?: string; limit?: number }) => {
    try {
      const category = query?.category as MemoryCategory | undefined;
      const status = query?.status as MemoryStatus | undefined;
      const limit = Math.min(query?.limit ?? 1000, 5000);

      let items = listAllMemories();
      if (category) items = items.filter(m => m.category === category);
      if (status) items = items.filter(m => m.status === status);
      items = items.slice(0, limit);

      return { ok: true, data: { items, total: items.length } };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // 批量导入长时记忆
  ipcMain.handle('ipc-bulk-long-term-memory', (_event: any, params: { items: unknown[] }) => {
    try {
      if (!Array.isArray(params.items)) return { ok: false, error: 'items 必须是数组' };
      if (params.items.length > 5000) return { ok: false, error: '单次最多导入 5000 条' };

      const entries: LongTermMemoryEntry[] = [];
      for (const raw of params.items) {
        const parsed = parseLongTermMemoryEntry(raw);
        if (!parsed.ok) return { ok: false, error: `条目非法: ${parsed.reason}` };
        entries.push(parsed.entry);
      }
      const result = importMemories(entries);
      if (!result.ok) return { ok: false, error: result.error };
      return { ok: true, data: { ...result.value, total: entries.length } };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // 获取统计事件
  ipcMain.handle('ipc-get-stats-events', (_event: any, query: { since?: number; limit?: number }) => {
    try {
      const since = query?.since ?? 0;
      const limit = Math.min(query?.limit ?? 500, 2000);
      const result = deriveStatsEvents(since, limit);
      return { ok: true, data: result };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // 获取技能列表
  ipcMain.handle('ipc-get-skills', () => {
    try {
      const skills = listSkills();
      return { ok: true, data: { items: skills, total: skills.length } };
    } catch {
      return { ok: true, data: { items: [], total: 0 } };
    }
  });

  // 获取自定义工具列表
  ipcMain.handle('ipc-get-custom-tools', () => {
    try {
      // 当前所有注册工具均视为 builtin，custom 返回空列表
      return { ok: true, data: { items: [], total: 0 } };
    } catch {
      return { ok: true, data: { items: [], total: 0 } };
    }
  });

  // ── 设备指纹 & 密钥存储 ──────────────────────────────────────────

  // 获取设备唯一指纹
  ipcMain.handle('ipc-get-device-fingerprint', () => {
    try {
      const fingerprint = getDeviceFingerprint();
      return { ok: true, data: { fingerprint } };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // 加密保存供应商 API_KEY（兼容旧通道：客户端整包写入）
  //
  // ⚠️ 该通道会**整体覆盖**凭据文件，且历史客户端会把已有供应商的 apiKey 写空
  //（"再加一个模型就刷掉上一个"）。供应商增删的持久化已改走后端就地 upsert，
  // 这里保留仅为兼容，并在写入前拒绝"把已有 key 覆盖为空"的整包数据。
  ipcMain.handle('ipc-save-secrets', async (_event: any, secrets: ProvidersSecrets) => {
    try {
      const current = await loadProviderSecrets();
      const incoming = secrets?.providers ?? [];
      const blanks = incoming.filter((p) => !hasUsableSecret(p)).map((p) => p.name);
      if (blanks.length > 0 && current?.providers?.length) {
        return {
          ok: false,
          error: `拒绝写入不完整凭据（缺少 apiKey/baseUrl）：${blanks.join(', ')}。请通过「添加供应商」重新填写。`,
        };
      }
      await saveProviderSecrets(secrets);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // 解密读取供应商 API_KEY
  ipcMain.handle('ipc-load-secrets', async () => {
    try {
      const secrets = await loadProviderSecrets();
      return { ok: true, data: secrets };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
}

// ── 命令处理（替代 wsHandler.handleClientMessage）──────────────────

function handleCommand(event: any, message: { type: string; payload?: Record<string, unknown> }): void {
  const reply = (msg: IpcMessage) => {
    try { event.reply('backend-event', msg); } catch { /* 窗口已关闭 */ }
  };

  switch (message.type) {
    case 'subscribe':
    case 'unsubscribe': {
      // IPC 模式下订阅由 eventBus 统一管理，客户端无需单独订阅
      reply({
        type: message.type === 'subscribe' ? 'subscribed' : 'unsubscribed',
        data: { message: 'IPC 模式下订阅由事件总线统一管理' },
        timestamp: Date.now(),
      });
      break;
    }

    case 'get_dashboard': {
      const dashboard = getDashboardOverview();
      reply({ type: 'dashboard', data: dashboard, timestamp: Date.now() });
      break;
    }

    case 'get_approvals': {
      const approvals = listPendingApprovals();
      reply({ type: 'approvals', data: approvals, timestamp: Date.now() });
      break;
    }

    case 'generate_reply': {
      const p = (message.payload ?? message) as Record<string, unknown>;
      const sessionId = p.sessionId as string;
      const userMessage = p.userMessage as string;
      const streamMessageId = p.messageId as string;
      const model = p.model as string | undefined;
      const workingMode = p.workingMode as string | undefined;

      if (!sessionId || !userMessage || !streamMessageId) {
        reply({
          type: 'error',
          data: { message: 'generate_reply requires sessionId, userMessage, messageId' },
          timestamp: Date.now(),
        });
        return;
      }

      // 异步启动流式生成（不阻塞 IPC 帧处理）
      queueMicrotask(() => startStreamGeneration(sessionId, userMessage, streamMessageId, model, workingMode));

      reply({
        type: 'generation_started',
        data: { messageId: streamMessageId, sessionId },
        timestamp: Date.now(),
      });
      break;
    }

    case 'stop_generation': {
      const p = (message.payload ?? message) as Record<string, unknown>;
      const messageId = p.messageId as string;
      if (!messageId) return;

      const stream = activeStreams.get(messageId);
      if (stream) {
        stream.abortController.abort();
        activeStreams.delete(messageId);
        publish(createEvent({
          eventType: EventType.AGENT_STREAM_END,
          source: 'ipcBridge/stop_generation',
          payload: { messageId, reason: 'user_stopped' },
        }));
      }

      reply({ type: 'generation_stopped', data: { messageId }, timestamp: Date.now() });
      break;
    }

    case 'ping': {
      reply({ type: 'pong', data: { timestamp: Date.now() }, timestamp: Date.now() });
      break;
    }

    default:
      logger.warn('未知 IPC 命令', { source: 'ipcBridge', type: message.type });
  }
}

// ── 流式生成核心逻辑（从 wsHandler 迁移）────────────────────────────

async function startStreamGeneration(
  sessionId: string,
  userMessage: string,
  streamMessageId: string,
  requestedModel?: string,
  _workingMode?: string,
): Promise<void> {
  const abortController = new AbortController();
  let fullContent = '';
  /** 本次生成是否已把助手消息落库（成功分支或中断分支） */
  let persisted = false;

  activeStreams.set(streamMessageId, {
    messageId: streamMessageId,
    sessionId,
    abortController,
  });

  try {
    // 1. 收集对话历史
    //    经 buildContextHistory 装配：空白 assistant（未产出内容就暂停）与
    //    悬空 user（发了消息却始终没得到回复）不进入上下文，最后一条除外。
    const history = listMessages(sessionId, 50);
    const chatMessages = buildContextHistory(history.map(m => ({
      role: m.role as 'user' | 'assistant' | 'system',
      content: m.content,
    })));

    // 2. 解析模型路由
    let model = requestedModel ?? getRoutingConfig()?.defaultModel ?? '';
    if (!model) {
      publish(createEvent({
        eventType: EventType.AGENT_STREAM_END,
        source: 'ipcBridge/streamGeneration',
        payload: { messageId: streamMessageId, error: '未配置默认模型（routing.defaultModel）' },
      }));
      return;
    }
    const resolved = resolveModel(model);
    if (!resolved.ok) {
      logger.warn('请求模型未注册，回退到默认模型', { source: 'ipcBridge', requested: model, error: resolved.error });
      model = getRoutingConfig()?.defaultModel ?? '';
      if (!model) {
        publish(createEvent({
          eventType: EventType.AGENT_STREAM_END,
          source: 'ipcBridge/streamGeneration',
          payload: { messageId: streamMessageId, error: '无可用模型' },
        }));
        return;
      }
    }

    // 3. 创建 Loop 状态与配置
    const loopConfigResult = createLoopConfig({ model, stream: true });
    if (!loopConfigResult.ok) {
      publish(createEvent({
        eventType: EventType.AGENT_STREAM_END,
        source: 'ipcBridge/streamGeneration',
        payload: { messageId: streamMessageId, error: loopConfigResult.error },
      }));
      return;
    }

    const loopId = `loop-${sessionId}-${Date.now()}`;
    const traceId = `trace-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
    const agentId = getOrCreateEntryAgent(model, traceId);
    const loopState = createLoopState({
      loopId,
      agentId,
      traceId,
      config: loopConfigResult.value,
    });

    // 4. 经主循环执行器（十步完整链路）
    // FE-054：会话级追加式上下文——写侧由 ⑧ 步工具结果填充（文件工作集），
    //   runIteration 装配时把追加段排在历史之后（位置稳定，前缀不受影响）
    const contextStore = new ContextStore();
    const iterCtx: Omit<IterationContext, 'currentIteration' | 'totalTokensConsumed'> = {
      userInput: userMessage,
      sessionId,
      agentId,
      agentRole: 'prime_director',
      config: loopConfigResult.value,
      chatMessages,
      contextStore,
      // 任务工作目录：迁移前创建的会话会在此补齐默认目录（Data/workspaces/<sessionId>/）
      workDir: ensureSessionWorkDir(sessionId) ?? undefined,
      recentCallTimestamps: [],
      signal: abortController.signal,
      onStreamChunk: (chunk) => {
        fullContent += chunk.delta;
        const payload: Record<string, unknown> = { messageId: streamMessageId };
        if (chunk.reasoning_delta) payload.reasoning = chunk.reasoning_delta;
        if (chunk.delta) payload.chunk = chunk.delta;
        publish(createEvent({
          eventType: EventType.AGENT_STREAM_CHUNK,
          source: 'ipcBridge/streamGeneration',
          payload,
        }));
      },
      // 工具开始/结束：即时推送，保证前端工具块与流式正文的先后顺序
      onToolCallStart: (info) => {
        publish(createEvent({
          eventType: EventType.AGENT_TOOL_CALL_STARTED,
          source: 'ipcBridge/streamGeneration',
          payload: {
            messageId: streamMessageId,
            toolCallId: info.toolCallId,
            toolName: info.toolName,
            arguments: info.arguments,
            iteration: info.iteration,
          },
        }));
      },
      // 模型**正在生成**工具调用（参数还没生成完、尚未执行）：
      // 立刻告知前端预创建工具块并显示"生成中/写入中"，避免长参数生成期间界面无反馈。
      onToolCallPending: (info) => {
        publish(createEvent({
          eventType: EventType.AGENT_TOOL_CALL_PENDING,
          source: 'ipcBridge/streamGeneration',
          payload: {
            messageId: streamMessageId,
            toolCallId: info.toolCallId,
            index: info.index,
            toolName: info.toolName ?? '',
            iteration: info.iteration,
          },
        }));
      },
      // 每轮迭代**即时**上报（此前是在 executeLoop 返回后批量发布 → 内容堆到运行结束才出现）
      onIterationComplete: (info) => {
        publish(createEvent({
          eventType: EventType.AGENT_ITERATION_COMPLETE,
          source: 'ipcBridge/streamGeneration',
          loopId: loopState.loopId,
          payload: {
            messageId: streamMessageId,
            iteration: info.iteration,
            totalIterations: info.totalIterations,
            outputText: info.outputText,
            toolCalls: info.toolCalls.map(tc => ({
              id: tc.id,
              name: tc.name,
              arguments: tc.arguments,
              subgroup: inferSubgroup(tc.name),
              riskLevel: assessRiskLevel(tc.name, tc.arguments),
            })),
            toolResults: info.toolResults.map(tr => ({
              tool_call_id: tr.tool_call_id,
              status: tr.status,
              content: tr.content,
              error: tr.error ? { code: tr.error.code, message: tr.error.message } : undefined,
            })),
            tokensConsumed: info.tokensConsumed,
            decision: info.decision,
          },
        }));
      },
      onToolCallResult: (info) => {
        publish(createEvent({
          eventType: EventType.AGENT_TOOL_CALL_RESULT,
          source: 'ipcBridge/streamGeneration',
          payload: {
            messageId: streamMessageId,
            toolCallId: info.toolCallId,
            toolName: info.toolName,
            status: info.status,
            content: typeof info.content === 'string' ? info.content : JSON.stringify(info.content ?? null),
            recoverable: info.recoverable,
            iteration: info.iteration,
            durationMs: info.durationMs ?? null,
          },
        }));
      },
    };

    const loopResult = await executeLoop(loopState, iterCtx);

    // 5. 流结束
    activeStreams.delete(streamMessageId);

    if (loopResult.ok) {
      const result = loopResult.value;
      const lastIter = result.iterations[result.iterations.length - 1];
      const outputText = lastIter?.outputText ?? fullContent;

      logger.info('主循环执行完成', {
        source: 'ipcBridge/streamGeneration',
        model,
        iterations: result.iterations.length,
        totalTokens: result.totalTokensConsumed,
        totalToolCalls: result.totalToolCalls,
        totalMs: result.totalMs,
        exitReason: result.exitReason,
      });

      // 每次迭代的工具调用/结果已在 onIterationComplete 中**即时**发布
      // （2026-10-03 修复：此处原先在 executeLoop 返回后循环批量发布，
      //   导致前几轮的工具块与轮次统计全部堆到运行结束才出现）。

      // 落库助手消息
      if (outputText) {
        addMessage(sessionId, 'assistant', outputText, {
          model,
          tokens_used: result.totalTokensConsumed,
        });
        persisted = true;
      }

      // 发布 stream_end（先让用户看到回复，再做命名）
      publish(createEvent({
        eventType: EventType.AGENT_STREAM_END,
        source: 'ipcBridge/streamGeneration',
        payload: { messageId: streamMessageId, tokensUsed: result.totalTokensConsumed },
      }));

      // 首次请求：让模型为本次任务起名（失败回退为截断用户消息）
      await tryAutoNameSession(sessionId, userMessage, model);
    } else {
      publish(createEvent({
        eventType: EventType.AGENT_STREAM_END,
        source: 'ipcBridge/streamGeneration',
        payload: { messageId: streamMessageId, error: loopResult.error },
      }));
    }
  } catch (e) {
    activeStreams.delete(streamMessageId);
    const errorMsg = e instanceof Error ? e.message : String(e);
    if (!abortController.signal.aborted) {
      publish(createEvent({
        eventType: EventType.AGENT_STREAM_END,
        source: 'ipcBridge/streamGeneration',
        payload: { messageId: streamMessageId, error: errorMsg },
      }));
    }
  } finally {
    // 手动暂停（停止生成）的兜底落库。
    //
    // 关键：`runLoop` 被中断时常常是**正常返回**（而非抛异常），此时 `outputText` 为空，
    // 若只依赖成功分支落库，已经流出的部分回复就不会入库 ——
    // 表现为"暂停后切换会话/重载，回复内容被清空"。
    if (abortController.signal.aborted && !persisted && fullContent) {
      try {
        addMessage(sessionId, 'assistant', fullContent, { model: 'default' });
        persisted = true;
        logger.info('手动暂停：已落库部分回复', {
          source: 'ipcBridge', sessionId, chars: fullContent.length,
        });
      } catch (persistErr) {
        logger.warn('手动暂停：部分回复落库失败', {
          source: 'ipcBridge',
          error: persistErr instanceof Error ? persistErr.message : String(persistErr),
        });
      }
    }
    activeStreams.delete(streamMessageId);
  }
}

// ── 自动命名 ─────────────────────────────────────────────────────────

/**
 * 首次请求时为会话/任务命名。
 *
 * 规则（2026-10-01 需求）：标题仍是默认值时，**请求模型**给出简短名称；
 * 模型不可用（无 Key/超时/空输出）时回退为截断用户消息的既有行为。
 * 命名成功后广播 `chat:session_renamed`，前端据此刷新任务列表。
 */
async function tryAutoNameSession(
  sessionId: string,
  firstUserMessage: string,
  model: string,
): Promise<void> {
  try {
    const session = getSession(sessionId);
    if (!session || session.title !== 'New Chat') return;

    let name: string | null = null;
    // 命名用经济模型（workerModel → defaultModel → 本次模型）。
    // 强推理模型会把 token 预算耗在思考上（实测 GLM-5.1：842 tok 中 831 字是思考），
    // 单次命名可能超过超时阈值而回退为截断消息。
    const routing = getRoutingConfig();
    const namingModel = routing?.workerModel || routing?.defaultModel || model;
    const resolved = resolveModel(namingModel);
    if (resolved.ok) {
      name = await generateSessionName({
        provider: resolved.value.provider,
        model: resolved.value.spec.id,
        userMessage: firstUserMessage,
        timeoutMs: 30_000,
      });
      if (!name) {
        logger.debug('模型命名未产出可用名称，回退为截断消息', { source: 'ipcBridge', namingModel });
      }
    } else {
      logger.debug('命名模型不可解析，回退为截断消息', { source: 'ipcBridge', namingModel });
    }

    const finalName = name ?? fallbackSessionName(firstUserMessage);
    updateSessionTitle(sessionId, finalName);
    logger.info('会话自动命名', { source: 'ipcBridge', sessionId, title: finalName, byModel: !!name });

    publish(createEvent({
      eventType: EventType.CHAT_SESSION_RENAMED,
      source: 'ipcBridge/streamGeneration',
      payload: { sessionId, title: finalName, byModel: !!name },
    }));
  } catch (e) {
    logger.debug('自动命名失败（非关键）', { source: 'ipcBridge', error: e instanceof Error ? e.message : String(e) });
  }
}

// ── 辅助函数 ─────────────────────────────────────────────────────────

function safeJsonParse(str: string): unknown {
  try { return JSON.parse(str); } catch { return str; }
}

function parseLongTermMemoryEntry(raw: unknown): { ok: true; entry: LongTermMemoryEntry } | { ok: false; reason: string } {
  if (typeof raw !== 'object' || raw === null) return { ok: false, reason: '条目必须是对象' };
  const r = raw as Record<string, unknown>;
  const memoryId = typeof r['memoryId'] === 'string' ? r['memoryId'] : '';
  const title = typeof r['title'] === 'string' ? r['title'] : '';
  const content = typeof r['content'] === 'string' ? r['content'] : '';
  if (!memoryId || !title || !content) return { ok: false, reason: 'memoryId/title/content 必填' };

  const categories: MemoryCategory[] = ['rule', 'fact', 'decision', 'pattern'];
  const statuses: MemoryStatus[] = ['active', 'deprecated', 'contradicted'];
  const category = (typeof r['category'] === 'string' && categories.includes(r['category'] as MemoryCategory)
    ? r['category']
    : 'fact') as MemoryCategory;
  const status = (typeof r['status'] === 'string' && statuses.includes(r['status'] as MemoryStatus)
    ? r['status']
    : 'active') as MemoryStatus;

  const entry: LongTermMemoryEntry = {
    memoryId,
    title,
    content,
    category,
    sourceTraceIds: Array.isArray(r['sourceTraceIds']) ? r['sourceTraceIds'].map(String) : [],
    assertion: (typeof r['assertion'] === 'string' ? r['assertion'] : 'observed') as LongTermMemoryEntry['assertion'],
    createdAt: typeof r['createdAt'] === 'number' ? r['createdAt'] : Date.now(),
    lastAccessedAt: typeof r['lastAccessedAt'] === 'number' ? r['lastAccessedAt'] : Date.now(),
    accessCount: typeof r['accessCount'] === 'number' ? r['accessCount'] : 0,
    status,
  };
  if (Array.isArray(r['sourceArbitrationIds'])) entry.sourceArbitrationIds = r['sourceArbitrationIds'].map(String);
  if (typeof r['contradictedBy'] === 'string') entry.contradictedBy = r['contradictedBy'];
  return { ok: true, entry };
}

const SKILLS_DIR = join(process.cwd(), 'Skills');

interface SkillEntry {
  id: string;
  category: 'playbooks' | 'rubrics' | 'rules' | 'strategies';
  name: string;
  path: string;
  size: number;
  summary: string;
}

function listSkills(): SkillEntry[] {
  const entries: SkillEntry[] = [];
  const categories = ['playbooks', 'rubrics', 'rules', 'strategies'] as const;

  for (const cat of categories) {
    const catDir = join(SKILLS_DIR, cat);
    if (!existsSync(catDir)) continue;

    try {
      const files = readdirSync(catDir).filter(f => f.endsWith('.md'));
      for (const file of files) {
        const filePath = join(catDir, file);
        const stat = statSync(filePath);
        const content = readFileSync(filePath, 'utf-8');
        const firstLine = content.split('\n').find(l => l.trim().length > 0) ?? '';

        entries.push({
          id: `${cat}/${file.replace('.md', '')}`,
          category: cat,
          name: file.replace('.md', ''),
          path: `Skills/${cat}/${file}`,
          size: stat.size,
          summary: firstLine.replace(/^#+\s*/, '').slice(0, 100),
        });
      }
    } catch {
      // 目录读取失败，跳过
    }
  }

  return entries;
}
