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

// ── A2A 同步（P0c）──────────────────────────────────────────────────
// 说明：主进程只做本地读写；**网络与脱敏在 `services/a2aSync`**（渲染进程）。

function getA2ASyncAPI(): any {
  return getElectronAPI()?.a2aSync ?? null;
}

export interface IpcSyncRow {
  messageId: string; taskId: string; traceId: string; kind: string;
  sourceAgentId: string; targetAgentId: string;
  parentMessageId: string | null; correlationId: string | null;
  visibility: string; contentHash: string; prevHash: string | null;
  payload: unknown; summary: string | null; verdict: string;
  priority: string; memoryRefs: { key: string; version: number }[]; createdAt: number;
}

/** 待上行消息（本地 `synced_at IS NULL`） */
export async function ipcA2AListUnsynced(limit = 200): Promise<{ ok: boolean; data?: IpcSyncRow[]; error?: string }> {
  const api = getA2ASyncAPI();
  if (!api) return { ok: false, error: 'Electron API 不可用' };
  return { ok: true, data: (await api.listUnsynced(limit)) as IpcSyncRow[] };
}

/** 标记已上行（幂等重试安全） */
export async function ipcA2AMarkSynced(messageIds: string[]): Promise<{ ok: boolean; data?: { marked: number }; error?: string }> {
  const api = getA2ASyncAPI();
  if (!api) return { ok: false, error: 'Electron API 不可用' };
  return { ok: true, data: (await api.markSynced(messageIds)) as { marked: number } };
}

/** 应用拉回消息（**本机优先**：已有则跳过） */
export async function ipcA2AApplyPulled(items: unknown[]): Promise<{ ok: boolean; data?: { applied: number; skipped: number }; error?: string }> {
  const api = getA2ASyncAPI();
  if (!api) return { ok: false, error: 'Electron API 不可用' };
  return { ok: true, data: (await api.applyPulled(items)) as { applied: number; skipped: number } };
}

/** 未上行计数（诊断） */
export async function ipcA2ASyncStats(): Promise<{ ok: boolean; data?: { unsynced: number }; error?: string }> {
  const api = getA2ASyncAPI();
  if (!api) return { ok: false, error: 'Electron API 不可用' };
  return { ok: true, data: (await api.stats()) as { unsynced: number } };
}

// ── 首次运行引导（onboarding）───────────────────────────────────────

function getOnboardingAPI(): any {
  return getElectronAPI()?.onboarding ?? null;
}

/** 目录契约快照（程序根/数据根/工作空间/可写性/告警） */
export interface AppPathsDto {
  mode: 'development' | 'portable' | 'installed';
  appRoot: string;
  dataRoot: string;
  workspaceRoot: string;
  configDir: string;
  bundledConfigDir: string;
  logDir: string;
  databaseDir: string;
  secretsDir: string;
  backupDir: string;
  stateDir: string;
  promptsDir: string;
  skillsDir: string;
  writable: Record<string, boolean>;
  warnings: string[];
  userConfigPath: string;
  onboardingStatePath: string;
}

export interface OnboardingProviderOption {
  name: string;
  displayName: string;
  baseUrl: string;
  apiKey: string;
  models: Array<{ id: string; context_window: number; max_output: number }>;
  defaultModel?: string;
}

export interface DiscoveredModelDto {
  id: string;
  context_window: number;
  max_output: number;
  supports_vision: boolean;
  supports_tools: boolean;
  cost_per_1k_input: number;
  cost_per_1k_output: number;
}

export interface ProbeResultDto {
  ok: boolean;
  baseUrl: string;
  listOk: boolean;
  chatOk: boolean;
  models: DiscoveredModelDto[];
  suggestedModel?: string;
  latencyMs?: number;
  error?: string;
  errorKind?: 'auth' | 'http' | 'network' | 'timeout' | 'invalid_input' | 'unknown';
  hint?: string;
  /** `/models` 的 HTTP 状态（未请求/网络失败时为空） */
  listStatus?: number;
  listAttempted?: boolean;
  /** 是否真的发起了对话探测（鉴权失败会提前返回 → false） */
  chatAttempted?: boolean;
  /** 端点明确不提供 /models（404/405），与"鉴权失败"区分开 */
  listNotProvided?: boolean;
  /** 供应商返回的原始错误信息（invalid_api_key / 余额不足 等） */
  providerMessage?: string;
  /** Key 被自动清理的内容说明 */
  keySanitized?: string[];
  /** 实际用于对话探测的模型（多候选重试后命中的那个） */
  chatModelUsed?: string;
  /** 本轮对话探测的候选模型顺序 */
  chatCandidates?: string[];
  /** 对话探测实际发起次数（>1 = 自动换过模型重试） */
  chatAttempts?: number;
}

export interface OnboardingStateDto {
  completed: boolean;
  skipped?: boolean;
  completedAt?: number;
  version?: string;
  personalization?: Record<string, unknown>;
  provider?: { name: string; displayName: string; baseUrl: string; defaultModel?: string };
}

export interface OnboardingSnapshotDto {
  state: OnboardingStateDto;
  needsOnboarding: boolean;
  version: string;
  paths: AppPathsDto;
  userConfigPath: string;
  userConfig: Record<string, unknown>;
  providers: Array<{ name: string; displayName: string; modelIds: string[] }>;
  models: string[];
  routing: RoutingConfig | null;
}

/** 引导 API 是否可用（浏览器/开发态为 false → 不拦截应用） */
export function hasOnboardingApi(): boolean {
  return !!getOnboardingAPI();
}

export async function ipcGetAppPaths(): Promise<{ ok: boolean; data?: AppPathsDto; error?: string }> {
  const api = getOnboardingAPI();
  if (!api) return { ok: false, error: 'Electron API 不可用' };
  return api.getPaths();
}

export async function ipcGetOnboarding(): Promise<{ ok: boolean; data?: OnboardingSnapshotDto; error?: string }> {
  const api = getOnboardingAPI();
  if (!api) return { ok: false, error: 'Electron API 不可用' };
  return api.getState();
}

export async function ipcTestProvider(config: {
  base_url: string; api_key: string; model?: string; chatProbe?: boolean;
}): Promise<{ ok: boolean; data?: ProbeResultDto; error?: string }> {
  const api = getOnboardingAPI();
  if (!api) return { ok: false, error: 'Electron API 不可用' };
  return api.testProvider(config);
}

// ── 逐模型可用性校验（模型导入重设计）──────────────────────────────

export type ModelAvailabilityDto = 'available' | 'unavailable' | 'unknown';

export interface ModelVerificationDto {
  id: string;
  status: ModelAvailabilityDto;
  latencyMs?: number;
  errorKind?: string;
  /** 供应商原话（不可用时给用户看原因） */
  providerMessage?: string;
}

export interface VerifyModelsResultDto {
  results: ModelVerificationDto[];
  summary: { total: number; available: number; unavailable: number; unknown: number };
}

/**
 * 校验一批模型的可用性（每个模型发一次最小对话请求）。
 *
 * 渲染层按小批次调用（≈8 个/批）以便展示进度并可中途取消；
 * **只校验不导入** —— 导入哪些模型由用户在列表里勾选后走 `ipcAddProvider`。
 */
export async function ipcVerifyModels(config: {
  base_url: string; api_key: string; models: string[]; concurrency?: number; timeoutMs?: number;
}): Promise<{ ok: boolean; data?: VerifyModelsResultDto; error?: string }> {
  const api = getOnboardingAPI();
  if (!api?.verifyModels) return { ok: false, error: 'Electron API 不可用' };
  return api.verifyModels(config);
}
export async function ipcWriteUserConfig(patch: Record<string, unknown>): Promise<{
  ok: boolean;
  data?: { path: string; applied: string[]; rejected: string[]; invalid: Array<{ path: string; reason: string }> };
  error?: string;
}> {
  const api = getOnboardingAPI();
  if (!api) return { ok: false, error: 'Electron API 不可用' };
  return api.writeUserConfig(patch);
}

export async function ipcPatchOnboarding(patch: Record<string, unknown>): Promise<{ ok: boolean; data?: OnboardingStateDto; error?: string }> {
  const api = getOnboardingAPI();
  if (!api) return { ok: false, error: 'Electron API 不可用' };
  return api.patchState(patch);
}

export async function ipcCompleteOnboarding(payload: {
  personalization?: Record<string, unknown>;
  provider?: { name: string; displayName: string; baseUrl: string; defaultModel?: string };
  configPatch?: Record<string, unknown>;
}): Promise<{ ok: boolean; data?: { state: OnboardingStateDto; config: { path: string; applied: string[]; rejected: string[] } }; error?: string }> {
  const api = getOnboardingAPI();
  if (!api) return { ok: false, error: 'Electron API 不可用' };
  return api.complete(payload);
}

export async function ipcSkipOnboarding(): Promise<{ ok: boolean; data?: OnboardingStateDto; error?: string }> {
  const api = getOnboardingAPI();
  if (!api) return { ok: false, error: 'Electron API 不可用' };
  return api.skip();
}

export async function ipcResetOnboarding(): Promise<{ ok: boolean; data?: { reset: boolean }; error?: string }> {
  const api = getOnboardingAPI();
  if (!api) return { ok: false, error: 'Electron API 不可用' };
  return api.reset();
}

/** 在资源管理器中打开目录（引导"我的数据在哪"用） */
export async function ipcOpenPath(target: string): Promise<{ ok: boolean; error?: string }> {
  const api = getElectronAPI();
  if (!api?.openPath) return { ok: false, error: 'Electron API 不可用' };
  return api.openPath(target);
}
