/**
 * @module stores/accountStore
 * @description
 * 账号与同步状态（客户端接入服务端，Docs/Client/04）。
 *
 * 职责：
 *  - 服务器地址配置（localStorage）与连通性测试
 *  - 注册/密码登录/**验证码登录**（LoginPage）/登出/刷新资料/设备会话管理
 *  - **令牌安全存储**：Electron 走主进程 safeStorage（IPC），浏览器降级 sessionStorage
 *  - 同步编排的进度与错误状态（真正逻辑在 `services/syncService`）
 *  - 失败重试队列（简单版：网络类失败入队，可手动重试，30s 后自动重试一次）
 *
 * 令牌只保存在**内存 + 安全存储**：不进 localStorage、不进 Redux/zustand 持久化。
 *
 * 本 store 是**账号唯一真源**（FE-031 合并）：验证码登录不再有独立 store，
 * `LoginPage` 直接调用本 store 的 `sendCode` / `loginWithCode`；两条登录路径共用
 * 同一令牌真源、同一登出与失效处理，且成功后都自动拉取云端数据。
 */

import { create } from 'zustand';
import {
  configureServerAuth,
  getServerBaseUrl,
  normalizeServerUrl,
  serverGet,
  serverPost,
  setServerBaseUrl,
  type AuthPayload,
  type ServerDevice,
  type ServerSession,
  type ServerTokens,
  type ServerUser,
} from '@/services/serverApi';
import { getSecureStore, probeSecureStorage, TOKENS_STORAGE_KEY } from '@/services/secureStore';
import { ipcGetDeviceFingerprint } from '@/services/ipcApi';
import { apiPut } from '@/services/api';
import { usePrefsStore } from '@/stores/prefsStore';
import { useChatStore } from '@/stores/chatStore';
import { useApprovalStore } from '@/stores/approvalStore';
import {
  exportBackup as syncExportBackup,
  pullAll,
  pushAll,
  restoreBackup as syncRestoreBackup,
  type PullReport,
  type PushReport,
  type ServerStatsOverview,
} from '@/services/syncService';

// ── 类型 ────────────────────────────────────────────────────────────

export type AccountStatus = 'loading' | 'anonymous' | 'authenticating' | 'authenticated';
export type SyncPhase = 'idle' | 'pulling' | 'pushing' | 'exporting' | 'restoring';
/** 验证码登录流程阶段（LoginPage 步骤机） */
export type LoginPhase = 'idle' | 'sending_code' | 'code_sent' | 'verifying' | 'authenticated';

export interface PendingOperation {
  id: string;
  type: 'pull' | 'push';
  createdAt: number;
  attempts: number;
  lastError: string;
}

export interface ConnectionProbe {
  ok: boolean;
  message: string;
  latencyMs?: number;
}

interface AccountState {
  /** 初始化（读安全存储 + 校验令牌）是否完成 */
  ready: boolean;
  serverUrl: string;
  /** 是否为加密存储（Electron safeStorage） */
  secureStorage: boolean;
  status: AccountStatus;
  user: ServerUser | null;
  sessions: ServerSession[];
  /** 登录设备（user_devices） */
  devices: ServerDevice[];
  lastError: string | null;
  syncPhase: SyncPhase;
  lastPull: PullReport | null;
  lastPush: PushReport | null;
  statsOverview: ServerStatsOverview | null;
  /** 上传冲突（本地/云端 revision 不一致） */
  conflict: { currentRevision: number } | null;
  pending: PendingOperation[];

  // ── 验证码登录（LoginPage；与密码登录共用同一账号/令牌真源）──────
  /** 验证码登录阶段 */
  loginPhase: LoginPhase;
  /** 已发送验证码的邮箱（用于"输入验证码"步骤展示） */
  loginEmail: string;
  /** 验证码有效期（秒） */
  codeExpiresIn: number;
  /** 开发环境服务端回传的验证码（生产为 null） */
  devCode: string | null;

  /** 发送验证码到邮箱 */
  sendCode: (email: string, purpose?: 'register' | 'login' | 'reset_password') => Promise<boolean>;
  /** 使用验证码登录（新用户自动注册）；成功后自动拉取云端数据 */
  loginWithCode: (email: string, code: string, displayName?: string) => Promise<boolean>;
  /** 重置验证码登录流程（"更换邮箱"回到第一步） */
  resetLoginFlow: () => void;

  init: () => Promise<void>;
  setServerUrl: (url: string) => Promise<void>;
  testConnection: () => Promise<ConnectionProbe>;
  register: (input: { email: string; password: string; displayName?: string }) => Promise<boolean>;
  login: (input: { email: string; password: string }) => Promise<boolean>;
  logout: (allDevices?: boolean) => Promise<boolean>;
  refreshProfile: () => Promise<void>;
  loadSessions: () => Promise<void>;
  revokeSession: (sessionId: string) => Promise<boolean>;
  /** 加载登录设备列表 */
  loadDevices: () => Promise<void>;
  /** 移除设备（解绑）：严格设备模式下换机/重装的恢复路径 */
  revokeDevice: (deviceId: string) => Promise<boolean>;
  pull: () => Promise<boolean>;
  push: (force?: boolean) => Promise<boolean>;
  exportBackup: () => Promise<{ ok: boolean; message: string; bundle?: unknown }>;
  restoreBackup: (bundle: unknown, mode: 'merge' | 'replace') => Promise<boolean>;
  retryPending: () => Promise<void>;
  clearError: () => void;
  /** 仅供测试：重置为未登录态 */
  __resetForTest: () => void;
}

// ── 模块级令牌（不进入 zustand 状态树，避免被意外序列化）──────────────

let tokens: ServerTokens | null = null;
const SERVER_URL_KEY = 'civitas.account.serverUrl';
const DEVICE_LABEL = 'Civitas Desktop';

function deviceLabel(): string {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const os = /Windows/i.test(ua) ? 'Windows' : /Mac/i.test(ua) ? 'macOS' : /Linux/i.test(ua) ? 'Linux' : '未知系统';
  return `${DEVICE_LABEL}（${os}）`;
}

// ── 设备凭据（验证码登录随请求发送；安全审计 FE-033 / SV-014）────────

let cachedDeviceId: string | null = null;
let cachedCredential: string | null = null;

/** 设备凭据在安全存储中的键（登录时随请求发送，服务端只存哈希） */
const DEVICE_ID_KEY = 'civitas.device.id';
const DEVICE_CREDENTIAL_KEY = 'civitas.device.credential';

function randomToken(): string {
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    return `dev-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

/**
 * 获取**稳定的安装标识与设备凭据**（安全审计 FE-033 / SV-014 修复）。
 *
 * 为什么不再用硬件指纹：原实现把 `MAC 列表 + 主机名 + 磁盘序列号` 的 SHA-256 当设备身份，
 * 切换 Wi-Fi/有线、插拔 VPN/虚拟网卡、改主机名、换盘、Windows 11 缺 `wmic`……都会改变指纹，
 * 服务端"硬绑定"后合法用户会被永久拒之门外（实测 403 且无解绑入口）。
 *
 * 现在：
 *  - **设备凭据**（随机串）在安装期生成一次并存入 `safeStorage`，长期稳定；
 *  - **安装 ID** 同样持久化，仅用于展示与审计（"我的登录设备"列表）；
 *  - 硬件指纹降级为**展示标签**（`deviceLabel` 的可读提示），不再参与身份判定。
 */
async function getDevice(): Promise<{ deviceId: string; deviceCredential: string; fingerprintLabel: string }> {
  if (cachedDeviceId && cachedCredential) {
    return { deviceId: cachedDeviceId, deviceCredential: cachedCredential, fingerprintLabel: await fingerprintLabel() };
  }
  const store = getSecureStore();
  let deviceId = await store.get(DEVICE_ID_KEY);
  let credential = await store.get(DEVICE_CREDENTIAL_KEY);

  if (!deviceId) {
    deviceId = `install-${randomToken()}`;
    await store.set(DEVICE_ID_KEY, deviceId);
  }
  if (!credential) {
    credential = randomToken();
    await store.set(DEVICE_CREDENTIAL_KEY, credential);
  }

  cachedDeviceId = deviceId;
  cachedCredential = credential;
  return { deviceId, deviceCredential: credential, fingerprintLabel: await fingerprintLabel() };
}

/** 硬件指纹仅作为**可读标签**（不参与身份判定；失败返回空串） */
async function fingerprintLabel(): Promise<string> {
  try {
    const result = await ipcGetDeviceFingerprint();
    if (result.ok && result.data?.fingerprint) return `指纹 ${result.data.fingerprint.slice(0, 8)}`;
  } catch {
    /* 非 Electron 环境 */
  }
  return '浏览器环境';
}

async function persistTokens(next: ServerTokens | null): Promise<void> {
  const store = getSecureStore();
  if (next) await store.set(TOKENS_STORAGE_KEY, JSON.stringify(next));
  else await store.remove(TOKENS_STORAGE_KEY);
}

async function loadTokens(): Promise<ServerTokens | null> {
  const raw = await getSecureStore().get(TOKENS_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ServerTokens;
    return parsed?.accessToken && parsed?.refreshToken ? parsed : null;
  } catch {
    return null;
  }
}

function readStoredServerUrl(): string {
  try {
    const raw = globalThis.localStorage?.getItem(SERVER_URL_KEY);
    return raw ? normalizeServerUrl(raw) : getServerBaseUrl();
  } catch {
    return getServerBaseUrl();
  }
}

/** 是否处于测试环境（决定是否启用自动重试定时器） */
function isTestEnv(): boolean {
  try {
    return typeof process !== 'undefined' && process.env?.['NODE_ENV'] === 'test';
  } catch {
    return false;
  }
}

let retryTimer: ReturnType<typeof setTimeout> | null = null;

// ── Store ───────────────────────────────────────────────────────────

export const useAccountStore = create<AccountState>((set, get) => {
  /** 网络类错误才入队重试（4xx 属用户/数据问题，重试无意义） */
  function enqueueIfTransient(type: 'pull' | 'push', message: string, code?: string): void {
    const transient = code === 'NETWORK' || code === 'TIMEOUT' || code === 'SESSION_EXPIRED';
    if (!transient) return;
    const existing = get().pending.find((p) => p.type === type);
    if (existing) return;
    set({
      pending: [
        ...get().pending,
        { id: `${type}-${Date.now()}`, type, createdAt: Date.now(), attempts: 0, lastError: message },
      ],
    });
    scheduleRetry();
  }

  function scheduleRetry(): void {
    if (isTestEnv() || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void get().retryPending();
    }, 30_000);
  }

  /**
   * 把"当前账号"同步给本地后端与偏好存储（跨账号数据隔离，FE-032）。
   *
   * 本地长时记忆与同步元数据都按账号分区：
   *  - 登录/恢复登录 → 切到该 userId 命名空间（本地后端据此回灌该账号的记忆）；
   *  - 登出/失效    → 切回匿名命名空间 `local`。
   *
   * 失败不影响登录本身（仅记录告警）：本地数据隔离失败不应该阻断用户进入应用，
   * 但会体现在 `lastError` 中提示用户。
   */
  async function adoptAccount(userId: string | null): Promise<void> {
    // ① 本地后端：切换长时记忆属主并回灌
    //    防御性：本地后端不可用/被 mock 时**不能抛出**——命名空间切换属非关键路径，
    //    不应阻断登录或应用启动（失败仅提示）。
    try {
      const res = await apiPut<{ owner: string; changed: boolean }>('/api/account/active-user', { userId });
      if (!res.ok) {
        set({ lastError: `本地数据命名空间切换失败：${res.error.message}` });
      }
    } catch (e) {
      set({ lastError: `本地数据命名空间切换失败：${e instanceof Error ? e.message : String(e)}` });
    }
    // ② 偏好与同步元数据：换账号即丢弃上一个账号的水位
    const switched = usePrefsStore.getState().adoptAccount(userId);
    if (switched) {
      console.info('[accountStore] 账号切换：已重置本地偏好与同步水位', { userId });
    }
    // ③ 内存中的个人数据（会话/消息/审批队列）——后端已按属主隔离，
    //    但前端 store 里仍可能残留上一个账号的数据。**仅在账号真正切换时清空**：
    //    否则"同账号重复 init"会把刚加载好的列表清掉（曾导致审批角标消失）。
    if (switched) {
      try {
        useChatStore.setState({
          sessions: [],
          messages: {},
          activeSessionId: null,
          streamingMessageId: null,
        } as Partial<ReturnType<typeof useChatStore.getState>>);
        useApprovalStore.setState({ approvals: [] } as Partial<ReturnType<typeof useApprovalStore.getState>>);
        // 重新拉取当前属主的会话列表
        void useChatStore.getState().hydrateSessions();
      } catch (e) {
        console.warn('[accountStore] 清空个人内存态失败', e);
      }
    }
  }

  async function applyAuthPayload(payload: AuthPayload): Promise<void> {
    tokens = payload.tokens;
    await persistTokens(tokens);
    set({ user: payload.user, status: 'authenticated', lastError: null });
    await adoptAccount(payload.user.id);
  }

  // 鉴权钩子**在 store 创建时注入一次**（而非只在 init 里）：
  // 否则若调用方先 login 后 init（或跳过 init），authedRequest 会因拿不到令牌而静默失败。
  configureServerAuth({
    getTokens: () => tokens,
    refresh: async () => {
      if (!tokens) return null;
      const res = await serverPost<AuthPayload>('/v1/auth/refresh', { refreshToken: tokens.refreshToken }, null);
      if (!res.ok) {
        tokens = null;
        await persistTokens(null);
        void adoptAccount(null);
        return null;
      }
      tokens = res.data.tokens;
      await persistTokens(tokens);
      set({ user: res.data.user, status: 'authenticated' });
      await adoptAccount(res.data.user.id);
      return tokens;
    },
    onAuthLost: (reason) => {
      tokens = null;
      void persistTokens(null);
      set({
        status: 'anonymous',
        user: null,
        sessions: [],
        devices: [],
        lastError: reason === 'TOKEN_REUSED' ? '登录凭证被重复使用，已全部失效，请重新登录' : null,
      });
      void adoptAccount(null);
    },
  });

  return {
    ready: false,
    serverUrl: getServerBaseUrl(),
    secureStorage: false,
    status: 'loading',
    user: null,
    sessions: [],
    devices: [],
    lastError: null,
    syncPhase: 'idle',
    lastPull: null,
    lastPush: null,
    statsOverview: null,
    conflict: null,
    pending: [],
    loginPhase: 'idle',
    loginEmail: '',
    codeExpiresIn: 0,
    devCode: null,

    async init() {
      // ① 服务器地址 + 安全存储能力（IPC 探测需 await）
      const url = readStoredServerUrl();
      setServerBaseUrl(url);
      const secure = await probeSecureStorage();
      set({ serverUrl: url, secureStorage: secure });

      // ② 尝试恢复登录态
      const restored = await loadTokens();
      if (!restored) {
        set({ ready: true, status: 'anonymous' });
        await adoptAccount(null);
        return;
      }
      tokens = restored;
      const me = await serverGet<ServerUser>('/v1/me');
      if (me.ok) {
        set({ user: me.data, status: 'authenticated', ready: true });
        // 本地数据按账号分区：恢复登录后切到该账号命名空间
        await adoptAccount(me.data.id);
      } else {
        // 刷新失败/过期 → 以匿名态启动（serverApi 会回调 onAuthLost 清理）
        set({ ready: true, status: 'anonymous', user: null });
        await adoptAccount(null);
      }
    },

    async setServerUrl(url) {
      const normalized = setServerBaseUrl(url);
      try {
        globalThis.localStorage?.setItem(SERVER_URL_KEY, normalized);
      } catch {
        /* 忽略 */
      }
      set({ serverUrl: normalized, lastError: null });
    },

    async testConnection() {
      const started = Date.now();
      const res = await serverGet<{ status: string; uptimeSec: number }>('/healthz', undefined, null);
      const latencyMs = Date.now() - started;
      if (!res.ok) return { ok: false, message: res.error.message };
      const ready = await serverGet<{ status: string; db: string }>('/readyz', undefined, null);
      if (!ready.ok) return { ok: false, message: `服务端存活但未就绪：${ready.error.message}`, latencyMs };
      return { ok: true, message: `连接正常（${latencyMs} ms）`, latencyMs };
    },

    async register({ email, password, displayName }) {
      set({ status: 'authenticating', lastError: null });
      const res = await serverPost<AuthPayload>('/v1/auth/register', {
        email,
        password,
        ...(displayName ? { displayName } : {}),
        deviceLabel: deviceLabel(),
      }, null);
      if (!res.ok) {
        set({ status: 'anonymous', lastError: res.error.message });
        return false;
      }
      await applyAuthPayload(res.data);
      void get().pull();
      return true;
    },

    async login({ email, password }) {
      set({ status: 'authenticating', lastError: null });
      const res = await serverPost<AuthPayload>('/v1/auth/login', { email, password, deviceLabel: deviceLabel() }, null);
      if (!res.ok) {
        set({ status: 'anonymous', lastError: res.error.message });
        return false;
      }
      await applyAuthPayload(res.data);
      void get().loadSessions();
      void get().pull(); // 设计约定：登录后自动拉取（服务端权威）
      return true;
    },

    /**
     * 发送邮箱验证码（LoginPage 第一步）。
     * 开发环境下服务端会回传 `devCode` 供页面展示；生产环境为 null。
     */
    async sendCode(email, purpose = 'login') {
      set({ loginPhase: 'sending_code', lastError: null, loginEmail: email });
      const res = await serverPost<{
        success: boolean;
        devCode?: string;
        expiresIn: number;
      }>('/v1/auth/send-code', { email, purpose }, null);

      if (!res.ok) {
        set({ loginPhase: 'idle', lastError: res.error.message });
        return false;
      }

      set({
        loginPhase: 'code_sent',
        codeExpiresIn: res.data.expiresIn,
        devCode: res.data.devCode ?? null,
      });
      return true;
    },

    /**
     * 使用验证码登录（自动注册新用户）。
     *
     * 成功路径与密码登录完全一致：`applyAuthPayload`（令牌落安全存储 + 切换本地
     * 数据命名空间）→ 自动拉取云端数据（FE-031 修复点：此前验证码路径漏做拉取）
     * → 刷新会话列表。设备凭据随请求发送（安装期稳定凭据，FE-033）。
     */
    async loginWithCode(email, code, displayName) {
      set({ loginPhase: 'verifying', lastError: null });
      const device = await getDevice();

      const res = await serverPost<{
        user: ServerUser;
        tokens: ServerTokens;
        isNewUser: boolean;
      }>(
        '/v1/auth/login-with-code',
        {
          email,
          code,
          ...(displayName ? { displayName } : {}),
          deviceLabel: `Civitas Desktop（${device.fingerprintLabel}）`,
          deviceId: device.deviceId,
          deviceCredential: device.deviceCredential,
        },
        null,
      );

      if (!res.ok) {
        // 回到"输入验证码"步骤：允许用户改码重试
        set({ loginPhase: 'code_sent', lastError: res.error.message });
        return false;
      }

      await applyAuthPayload({ user: res.data.user, tokens: res.data.tokens });
      set({ loginPhase: 'authenticated' });
      void get().loadSessions();
      void get().pull(); // 设计约定：登录后自动拉取（服务端权威）
      return true;
    },

    resetLoginFlow() {
      set({ loginPhase: 'idle', loginEmail: '', codeExpiresIn: 0, devCode: null });
    },

    async logout(allDevices = false) {
      const current = tokens;
      if (current) {
        await serverPost('/v1/auth/logout', allDevices ? { allDevices: true } : { refreshToken: current.refreshToken });
      }
      tokens = null;
      await persistTokens(null);
      set({
        status: 'anonymous', user: null, sessions: [], devices: [], statsOverview: null,
        lastPull: null, lastPush: null, conflict: null,
        // 验证码登录流程一并归零（登录页视为全新流程）
        loginPhase: 'idle', loginEmail: '', codeExpiresIn: 0, devCode: null,
      });
      // 切回匿名命名空间：本地长时记忆/偏好不再与刚才的账号关联（FE-032）
      await adoptAccount(null);
      return true;
    },

    async refreshProfile() {
      const res = await serverGet<ServerUser>('/v1/me');
      if (res.ok) set({ user: res.data });
      else set({ lastError: res.error.message });
    },

    async loadSessions() {
      const res = await serverGet<{ sessions: ServerSession[] }>('/v1/me/sessions');
      if (res.ok) set({ sessions: res.data.sessions });
    },

    /**
     * 加载"登录设备"列表（服务端 `user_devices`）。
     *
     * 与"会话"的区别：设备 = 安装期设备凭据（长期）；会话 = 刷新令牌家族（可吊销）。
     * 严格设备模式下，**移除旧设备**是换机/重装后重新登录的官方路径（FE-033）。
     */
    async loadDevices() {
      const res = await serverGet<{ devices: ServerDevice[] }>('/v1/me/devices');
      if (res.ok) set({ devices: res.data.devices });
      else set({ lastError: res.error.message });
    },

    /** 移除设备（解绑）：成功后刷新列表 */
    async revokeDevice(deviceId: string) {
      const res = await serverPost<{ revoked: boolean }>(`/v1/me/devices/${encodeURIComponent(deviceId)}`, {});
      if (!res.ok) {
        set({ lastError: res.error.message });
        return false;
      }
      await get().loadDevices();
      set({ lastError: null });
      return true;
    },

    async revokeSession(sessionId) {
      const res = await serverPost(`/v1/me/sessions/${sessionId}`, {});
      if (!res.ok) {
        set({ lastError: res.error.message });
        return false;
      }
      await get().loadSessions();
      return true;
    },

    async pull() {
      set({ syncPhase: 'pulling', lastError: null });
      const res = await pullAll();
      if (!res.ok) {
        set({ syncPhase: 'idle', lastError: res.error.message });
        enqueueIfTransient('pull', res.error.message, res.error.code);
        return false;
      }
      set({
        syncPhase: 'idle',
        lastPull: res.data,
        statsOverview: res.data.stats ?? get().statsOverview,
        lastError: res.data.warnings.length > 0 ? res.data.warnings.join('；') : null,
      });
      return true;
    },

    async push(force = false) {
      set({ syncPhase: 'pushing', lastError: null, conflict: null });
      const res = await pushAll({ force });
      if (!res.ok) {
        set({ syncPhase: 'idle', lastError: res.error.message });
        if (res.error.code === 'REVISION_MISMATCH') {
          const details = res.error.details as { currentRevision?: number } | undefined;
          set({ conflict: { currentRevision: details?.currentRevision ?? 0 } });
        } else {
          enqueueIfTransient('push', res.error.message, res.error.code);
        }
        return false;
      }
      set({
        syncPhase: 'idle',
        lastPush: res.data,
        lastError: res.data.warnings.length > 0 ? res.data.warnings.join('；') : null,
      });
      // 上传后刷新云端概览（否则概览数字要等下次拉取才更新）
      const overview = await serverGet<ServerStatsOverview>('/v1/stats/overview');
      if (overview.ok) set({ statsOverview: overview.data });
      return true;
    },

    async exportBackup() {
      set({ syncPhase: 'exporting', lastError: null });
      const res = await syncExportBackup(true);
      set({ syncPhase: 'idle' });
      if (!res.ok) {
        set({ lastError: res.error.message });
        return { ok: false, message: res.error.message };
      }
      return { ok: true, message: '已生成备份包', bundle: res.data };
    },

    async restoreBackup(bundle, mode) {
      set({ syncPhase: 'restoring', lastError: null });
      const res = await syncRestoreBackup(bundle, mode);
      set({ syncPhase: 'idle' });
      if (!res.ok) {
        set({ lastError: res.error.message });
        return false;
      }
      // 恢复后服务端数据变化 → 自动拉回本地
      await get().pull();
      return true;
    },

    async retryPending() {
      const queue = get().pending;
      if (queue.length === 0) return;
      const remaining: PendingOperation[] = [];
      for (const op of queue) {
        const ok = op.type === 'pull' ? await get().pull() : await get().push(false);
        if (!ok) remaining.push({ ...op, attempts: op.attempts + 1 });
      }
      set({ pending: remaining });
      if (remaining.length > 0) scheduleRetry();
    },

    clearError() {
      set({ lastError: null, conflict: null });
    },

    __resetForTest() {
      tokens = null;
      cachedDeviceId = null;
      cachedCredential = null;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      // 注意：不解除 serverApi 的鉴权钩子——钩子在 store 创建时注入一次，
      // 解除后 init() 不会再装回，会导致后续所有鉴权请求静默 NOT_LOGGED_IN。
      set({
        ready: false,
        status: 'loading',
        user: null,
        sessions: [],
        devices: [],
        lastError: null,
        syncPhase: 'idle',
        lastPull: null,
        lastPush: null,
        statsOverview: null,
        conflict: null,
        pending: [],
        loginPhase: 'idle',
        loginEmail: '',
        codeExpiresIn: 0,
        devCode: null,
      });
    },
  };
});
