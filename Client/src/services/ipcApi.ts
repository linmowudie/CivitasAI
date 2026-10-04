/**
 * @module services/ipcApi
 * @description
 * 统一 IPC 调用层——封装 window.electronAPI 的所有 invoke 调用。
 * Electron 模式下通过主进程直接调用后端模块函数，零 HTTP 开销。
 * 非 Electron 环境（浏览器开发模式）下降级为 HTTP 或空操作。
 */

// ── 类型 ───────────────────────────────────────────────────────────

interface ModelProviderConfig {
  provider: string;
  base_url: string;
  api_key: string;
  display_name: string;
  models?: any[];
}

interface RoutingConfig {
  defaultModel: string;
  directorModel: string;
  workerModel: string;
  verifierModel: string;
  arbitrationModels: string[];
  fallbackOrder: string[];
  timeoutMs: number;
  firstByteTimeoutMs: number;
  interChunkTimeoutMs: number;
}

interface ProviderInfo {
  name: string;
  displayName: string;
  models: any[];
}

// ── 环境检测 ────────────────────────────────────────────────────────

function getElectronAPI(): any {
  return (globalThis as any).electronAPI ?? null;
}

function getModelProvidersAPI(): any {
  return getElectronAPI()?.modelProviders ?? null;
}

function getSessionsAPI(): any {
  return getElectronAPI()?.sessions ?? null;
}

function getConfigsAPI(): any {
  return getElectronAPI()?.configs ?? null;
}

function getDataAPI(): any {
  return getElectronAPI()?.data ?? null;
}

function getDeviceAPI(): any {
  return getElectronAPI()?.device ?? null;
}

function getSecretsAPI(): any {
  return getElectronAPI()?.secrets ?? null;
}

function isElectron(): boolean {
  return !!getElectronAPI();
}

// ── 模型供应商管理 ─────────────────────────────────────────────────

/** 获取已注册供应商列表（含模型规格） */
export async function ipcGetProviders(): Promise<ProviderInfo[]> {
  const api = getModelProvidersAPI();
  if (!api) return [];
  return api.getProviders();
}

/** 添加/注册新供应商 */
export async function ipcAddProvider(config: ModelProviderConfig): Promise<{ ok: boolean; error?: string }> {
  const api = getModelProvidersAPI();
  if (!api) return { ok: false, error: 'Electron API 不可用' };
  return api.addProvider(config);
}

/** 注销供应商 */
export async function ipcRemoveProvider(name: string): Promise<{ ok: boolean; error?: string }> {
  const api = getModelProvidersAPI();
  if (!api) return { ok: false, error: 'Electron API 不可用' };
  return api.removeProvider(name);
}

/** 用 API_KEY 调用 /models 端点拉取模型列表 */
export async function ipcFetchProviderModels(config: { base_url: string; api_key: string }): Promise<{ ok: boolean; data?: any[]; error?: string }> {
  const api = getModelProvidersAPI();
  if (!api) return { ok: false, error: 'Electron API 不可用' };
  return api.fetchModels(config);
}

/** 获取当前路由配置 */
export async function ipcGetRouting(): Promise<RoutingConfig | null> {
  const api = getModelProvidersAPI();
  if (!api) return null;
  return api.getRouting();
}

/** 更新路由配置 */
export async function ipcUpdateRouting(config: Partial<RoutingConfig>): Promise<{ ok: boolean; data?: RoutingConfig; error?: string }> {
  const api = getModelProvidersAPI();
  if (!api) return { ok: false, error: 'Electron API 不可用' };
  return api.updateRouting(config);
}

/** 获取所有已注册模型（qualified name 列表） */
export async function ipcGetModels(): Promise<string[]> {
  const api = getModelProvidersAPI();
  if (!api) return [];
  return api.getModels();
}

// ── 会话/消息管理 ─────────────────────────────────────────────────

export interface ChatSession {
  session_id: string;
  title: string;
  status: 'active' | 'archived' | 'closed';
  created_at: number;
  updated_at: number;
  work_dir?: string | null;
}

export interface ChatMessage {
  message_id: string;
  session_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  model?: string;
  tokens_used?: number;
  trace_id?: string;
  created_at: number;
}

/** 获取会话列表（`archived`：默认仅未归档；true=仅已归档；'all'=全部） */
export async function ipcListSessions(options?: { archived?: boolean | 'all' }): Promise<{ ok: boolean; data?: ChatSession[]; error?: string }> {
  const api = getSessionsAPI();
  if (!api) return { ok: false, error: 'Electron API 不可用' };
  return api.list(options);
}

/** 归档 / 取消归档任务（软状态：不删除消息，可随时恢复） */
export async function ipcArchiveSession(params: { sessionId: string; archived: boolean }): Promise<{ ok: boolean; data?: ChatSession; error?: string }> {
  const api = getSessionsAPI();
  if (!api) return { ok: false, error: 'Electron API 不可用' };
  return api.archive(params);
}

/** 创建会话 */
export async function ipcCreateSession(params?: { title?: string; workDir?: string }): Promise<{ ok: boolean; data?: ChatSession; error?: string }> {
  const api = getSessionsAPI();
  if (!api) return { ok: false, error: 'Electron API 不可用' };
  return api.create(params ?? {});
}

/** 更新会话（标题/工作目录） */
export async function ipcUpdateSession(params: { sessionId: string; title?: string; workDir?: string | null }): Promise<{ ok: boolean; data?: ChatSession; error?: string }> {
  const api = getSessionsAPI();
  if (!api) return { ok: false, error: 'Electron API 不可用' };
  return api.update(params);
}

/** 获取消息列表 */
export async function ipcListMessages(sessionId: string, limit = 50): Promise<{ ok: boolean; data?: ChatMessage[]; error?: string }> {
  const api = getSessionsAPI();
  if (!api) return { ok: false, error: 'Electron API 不可用' };
  return api.listMessages({ sessionId, limit });
}

/** 添加消息 */
export async function ipcAddMessage(params: { sessionId: string; role: 'user' | 'assistant' | 'system'; content: string; model?: string; tokens_used?: number }): Promise<{ ok: boolean; data?: ChatMessage; error?: string }> {
  const api = getSessionsAPI();
  if (!api) return { ok: false, error: 'Electron API 不可用' };
  return api.addMessage(params);
}

// ── 配置管理 ──────────────────────────────────────────────────────

/** 获取配置文件 */
export async function ipcGetConfig(name: string): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const api = getConfigsAPI();
  if (!api) return { ok: false, error: 'Electron API 不可用' };
  return api.get(name);
}

// ── 记忆/技能/工具数据 ────────────────────────────────────────────

export interface MemoryEntry {
  key: string;
  value: unknown;
  version: number;
  namespace: string;
  updatedAt: number;
  createdAt: number;
}

export interface LongTermMemoryDto {
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

export interface SkillEntry {
  id: string;
  category: 'playbooks' | 'rubrics' | 'rules' | 'strategies';
  name: string;
  path: string;
  size: number;
  summary: string;
}

export interface ToolInfo {
  name: string;
  description: string;
  dangerLevel: string;
  idempotent: boolean;
  reversible: boolean;
  isBuiltin: boolean;
  requiredRoles: string[];
}

/** 获取记忆条目 */
export async function ipcGetMemoryEntries(query?: { namespace?: string; limit?: number; offset?: number }): Promise<{ ok: boolean; data?: { items: MemoryEntry[]; total: number } }> {
  const api = getDataAPI();
  if (!api) return { ok: false };
  return api.getMemoryEntries(query);
}

/** 获取长时记忆 */
export async function ipcGetLongTermMemory(query?: { category?: string; status?: string; limit?: number }): Promise<{ ok: boolean; data?: { items: LongTermMemoryDto[]; total: number } }> {
  const api = getDataAPI();
  if (!api) return { ok: false };
  return api.getLongTermMemory(query);
}

/** 批量导入长时记忆 */
export async function ipdBulkLongTermMemory(items: unknown[]): Promise<{ ok: boolean; data?: { imported: number; updated: number; total: number }; error?: string }> {
  const api = getDataAPI();
  if (!api) return { ok: false, error: 'Electron API 不可用' };
  return api.bulkLongTermMemory({ items });
}

export interface DerivedStatsResult {
  events: Array<{ kind: string; value: number; occurredAt: number; clientEventId: string; meta?: Record<string, unknown> }>;
  counts: { chatTurn: number; tokenConsumed: number; toolCall: number };
  since: number;
  nextSince: number;
  truncated: boolean;
}

/** 获取统计事件 */
export async function ipcGetStatsEvents(query?: { since?: number; limit?: number }): Promise<{ ok: boolean; data?: DerivedStatsResult }> {
  const api = getDataAPI();
  if (!api) return { ok: false };
  return api.getStatsEvents(query);
}

/** 获取技能列表 */
export async function ipcGetSkills(): Promise<{ ok: boolean; data?: { items: SkillEntry[]; total: number } }> {
  const api = getDataAPI();
  if (!api) return { ok: false };
  return api.getSkills();
}

/** 获取自定义工具列表 */
export async function ipcGetCustomTools(): Promise<{ ok: boolean; data?: { items: ToolInfo[]; total: number } }> {
  const api = getDataAPI();
  if (!api) return { ok: false };
  return api.getCustomTools();
}

// ── 设备指纹 ─────────────────────────────────────────────────────────

/** 获取设备唯一指纹 */
export async function ipcGetDeviceFingerprint(): Promise<{ ok: boolean; data?: { fingerprint: string }; error?: string }> {
  const api = getDeviceAPI();
  if (!api) return { ok: false, error: 'Electron API 不可用' };
  return api.getFingerprint();
}

// ── 密钥加密存储 ───────────────────────────────────────────────────

export interface ProviderSecretData {
  providers: Array<{
    name: string;
    apiKey: string;
    baseUrl: string;
    provider: string;
    displayName: string;
    models?: any[];
  }>;
  updatedAt: number;
}

/** 加密保存供应商 API_KEY */
export async function ipcSaveProviderSecrets(secrets: ProviderSecretData): Promise<{ ok: boolean; error?: string }> {
  const api = getSecretsAPI();
  if (!api) return { ok: false, error: 'Electron API 不可用' };
  return api.saveProviders(secrets);
}

/** 解密读取供应商 API_KEY */
export async function ipcLoadProviderSecrets(): Promise<{ ok: boolean; data?: ProviderSecretData | null; error?: string }> {
  const api = getSecretsAPI();
  if (!api) return { ok: false, error: 'Electron API 不可用' };
  return api.loadProviders();
}
