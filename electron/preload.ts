/**
 * Electron 预加载脚本
 * 
 * 在渲染进程中安全地暴露有限的 Node.js API。
 * 使用 contextBridge 确保隔离性。
 * Phase 0：新增 IPC 事件桥接 API（替代 WebSocket）。
 */

import { contextBridge, ipcRenderer } from 'electron';

// 暴露安全的 API 到渲染进程
contextBridge.exposeInMainWorld('electronAPI', {
  // 获取后端服务端口信息
  getServerPorts: () => ipcRenderer.invoke('get-server-ports'),
  
  // 应用信息
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  
  // 打开外部链接
  openExternal: (url: string) => ipcRenderer.send('open-external', url),

  // 选择任务工作目录（原生对话框；取消返回 null）
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke('pick-directory'),

  /** 在资源管理器中打开目录/文件（首次运行引导用） */
  openPath: (target: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('open-path', target),

  // ── 首次运行引导（onboarding）──
  onboarding: {
    /** 目录透明化：程序根/数据根/工作空间/可写性/告警 */
    getPaths: (): Promise<any> => ipcRenderer.invoke('ipc-get-app-paths'),
    /** 引导现状：状态 + 已有供应商/模型/路由 + 用户配置 */
    getState: (): Promise<any> => ipcRenderer.invoke('ipc-get-onboarding'),
    /** 连通性校验：GET /models + 最小 chat 探测（返回可归因的错误类型） */
    testProvider: (config: any): Promise<any> => ipcRenderer.invoke('ipc-test-provider', config),
    /**
     * 逐模型可用性校验（模型导入重设计）：渲染层按小批次调用以便展示进度；
     * 只校验不导入，导入哪些由用户在列表里勾选。
     */
    verifyModels: (config: any): Promise<any> => ipcRenderer.invoke('ipc-verify-models', config),
    /** 白名单写用户配置（写 <数据根>/Configs/local.json，并同步内存路由） */
    writeUserConfig: (patch: Record<string, unknown>): Promise<any> => ipcRenderer.invoke('ipc-write-user-config', patch),
    /** 仅更新引导状态（个性化项随步写入） */
    patchState: (patch: Record<string, unknown>): Promise<any> => ipcRenderer.invoke('ipc-patch-onboarding', patch),
    /** 完成引导（写配置 + 路由 + 状态标记） */
    complete: (payload: any): Promise<any> => ipcRenderer.invoke('ipc-complete-onboarding', payload),
    /** 跳过引导（稍后可从设置重跑） */
    skip: (): Promise<any> => ipcRenderer.invoke('ipc-skip-onboarding'),
    /** 重置引导（重新运行初始化引导） */
    reset: (): Promise<any> => ipcRenderer.invoke('ipc-reset-onboarding'),
  },

  // ── 服务端请求转发（主进程执行，规避渲染进程 CORS；打包后 file:// 亦可用）──
  serverFetch: (req: { method: string; url: string; headers?: Record<string, string>; body?: string }) =>
    ipcRenderer.invoke('server-fetch', req),

  // ── 账号令牌安全存储（主进程 safeStorage 加密）──
  secureStore: {
    isAvailable: (): Promise<boolean> => ipcRenderer.invoke('secure-store-available'),
    get: (key: string): Promise<string | null> => ipcRenderer.invoke('secure-store-get', key),
    set: (key: string, value: string): Promise<boolean> => ipcRenderer.invoke('secure-store-set', key, value),
    remove: (key: string): Promise<void> => ipcRenderer.invoke('secure-store-remove', key),
  },

  // ── 模型供应商管理（invoke/handle 请求-响应）──
  modelProviders: {
    getProviders: (): Promise<any[]> => ipcRenderer.invoke('ipc-get-providers'),
    addProvider: (config: any): Promise<any> => ipcRenderer.invoke('ipc-add-provider', config),
    removeProvider: (name: string): Promise<any> => ipcRenderer.invoke('ipc-remove-provider', name),
    fetchModels: (config: any): Promise<any> => ipcRenderer.invoke('ipc-fetch-models', config),
    getRouting: (): Promise<any> => ipcRenderer.invoke('ipc-get-routing'),
    updateRouting: (config: any): Promise<any> => ipcRenderer.invoke('ipc-update-routing', config),
    // ── A2A 同步（P0c）：本地待上行 / 标记已上行 / 应用拉回（本机优先）──
    a2aSync: {
      listUnsynced: (limit?: number) => ipcRenderer.invoke('a2a:sync-list', limit ?? 200),
      markSynced: (messageIds: string[]) => ipcRenderer.invoke('a2a:sync-mark', messageIds),
      applyPulled: (items: unknown[]) => ipcRenderer.invoke('a2a:sync-apply', items),
      stats: () => ipcRenderer.invoke('a2a:sync-stats'),
    },
    getModels: (): Promise<string[]> => ipcRenderer.invoke('ipc-get-models'),
  },

  // ── 会话/消息管理 ──
  sessions: {
    /** 列出任务（`archived`：默认仅未归档；true=仅已归档；'all'=全部）——参数必须转发 */
    list: (params?: { archived?: boolean | 'all' }): Promise<any> => ipcRenderer.invoke('ipc-list-sessions', params),
    create: (params: { title?: string; workDir?: string }): Promise<any> => ipcRenderer.invoke('ipc-create-session', params),
    update: (params: { sessionId: string; title?: string; workDir?: string | null }): Promise<any> => ipcRenderer.invoke('ipc-update-session', params),
    /** 归档/取消归档（软状态，不删除消息） */
    archive: (params: { sessionId: string; archived: boolean }): Promise<any> => ipcRenderer.invoke('ipc-archive-session', params),
    listMessages: (params: { sessionId: string; limit?: number }): Promise<any> => ipcRenderer.invoke('ipc-list-messages', params),
    addMessage: (params: { sessionId: string; role: 'user' | 'assistant' | 'system'; content: string; model?: string; tokens_used?: number }): Promise<any> => ipcRenderer.invoke('ipc-add-message', params),
  },

  // ── Agent 计划清单（TODO，按来源 agent 分组）──
  todos: {
    list: (params?: { sessionId?: string; all?: boolean }): Promise<any> => ipcRenderer.invoke('ipc-get-todos', params),
    clear: (params: { sessionId: string; agentId?: string }): Promise<any> => ipcRenderer.invoke('ipc-clear-todos', params),
  },

  // ── 配置管理 ──
  configs: {
    get: (name: string): Promise<any> => ipcRenderer.invoke('ipc-get-config', name),
  },

  // ── 记忆/技能/工具数据 ──
  data: {
    getMemoryEntries: (query?: { namespace?: string; limit?: number; offset?: number }): Promise<any> => ipcRenderer.invoke('ipc-get-memory-entries', query),
    getLongTermMemory: (query?: { category?: string; status?: string; limit?: number }): Promise<any> => ipcRenderer.invoke('ipc-get-long-term-memory', query),
    bulkLongTermMemory: (params: { items: unknown[] }): Promise<any> => ipcRenderer.invoke('ipc-bulk-long-term-memory', params),
    getStatsEvents: (query?: { since?: number; limit?: number }): Promise<any> => ipcRenderer.invoke('ipc-get-stats-events', query),
    getSkills: (): Promise<any> => ipcRenderer.invoke('ipc-get-skills'),
    getCustomTools: (): Promise<any> => ipcRenderer.invoke('ipc-get-custom-tools'),
  },

  // ── 设备指纹 & 密钥存储 ──
  device: {
    getFingerprint: (): Promise<any> => ipcRenderer.invoke('ipc-get-device-fingerprint'),
  },
  secrets: {
    saveProviders: (secrets: any): Promise<any> => ipcRenderer.invoke('ipc-save-secrets', secrets),
    loadProviders: (): Promise<any> => ipcRenderer.invoke('ipc-load-secrets'),
  },

  // ── IPC 事件桥接（替代 WebSocket）──
  // 监听后端事件（主进程 EventBus 转发）
  onBackendEvent: (callback: (event: any, msg: any) => void) => {
    ipcRenderer.on('backend-event', callback);
  },
  // 发送命令到后端
  sendBackendCommand: (command: string) => {
    ipcRenderer.send('backend-command', command);
  },
  // 移除事件监听（清理用）
  removeBackendEventListeners: () => {
    ipcRenderer.removeAllListeners('backend-event');
  },
});

// 类型声明（供前端使用）
declare global {
  interface Window {
    electronAPI: {
      getServerPorts: () => Promise<{ httpPort: number }>;
      getAppVersion: () => Promise<string>;
      openExternal: (url: string) => void;
      onBackendEvent: (callback: (event: any, msg: any) => void) => void;
      sendBackendCommand: (command: string) => void;
      removeBackendEventListeners: () => void;
      /** 选择任务工作目录（取消返回 null） */
      pickDirectory: () => Promise<string | null>;
      /** 在资源管理器中打开目录/文件（首次运行引导用） */
      openPath: (target: string) => Promise<{ ok: boolean; error?: string }>;
      /** 首次运行引导（onboarding） */
      onboarding: {
        getPaths: () => Promise<any>;
        getState: () => Promise<any>;
        testProvider: (config: any) => Promise<any>;
        /** 逐模型可用性校验（按小批次调用） */
        verifyModels: (config: any) => Promise<any>;
        writeUserConfig: (patch: Record<string, unknown>) => Promise<any>;
        patchState: (patch: Record<string, unknown>) => Promise<any>;
        complete: (payload: any) => Promise<any>;
        skip: () => Promise<any>;
        reset: () => Promise<any>;
      };
      /** 服务端请求转发（主进程 fetch；避免渲染进程 CORS 限制） */
      serverFetch: (req: { method: string; url: string; headers?: Record<string, string>; body?: string }) => Promise<
        { ok: true; status: number; body: string } | { ok: false; status: 0; error: string }
      >;
      /** 账号令牌安全存储（加密落盘；isAvailable=false 时调用方应降级） */
      secureStore: {
        isAvailable: () => Promise<boolean>;
        get: (key: string) => Promise<string | null>;
        set: (key: string, value: string) => Promise<boolean>;
        remove: (key: string) => Promise<void>;
      };
      /** 模型供应商管理（invoke/handle 请求-响应） */
    /** A2A 同步（P0c）：本地待上行 / 标记已上行 / 应用拉回 */
    a2aSync: {
      listUnsynced: (limit?: number) => Promise<unknown[]>;
      markSynced: (messageIds: string[]) => Promise<{ marked: number }>;
      applyPulled: (items: unknown[]) => Promise<{ applied: number; skipped: number }>;
      stats: () => Promise<{ unsynced: number }>;
    };
    modelProviders: {
        getProviders: () => Promise<any[]>;
        addProvider: (config: any) => Promise<any>;
        removeProvider: (name: string) => Promise<any>;
        fetchModels: (config: any) => Promise<any>;
        getRouting: () => Promise<any>;
        updateRouting: (config: any) => Promise<any>;
        getModels: () => Promise<string[]>;
      };
      /** 会话/消息管理 */
      sessions: {
        list: () => Promise<any>;
        create: (params: { title?: string; workDir?: string }) => Promise<any>;
        update: (params: { sessionId: string; title?: string; workDir?: string | null }) => Promise<any>;
        listMessages: (params: { sessionId: string; limit?: number }) => Promise<any>;
        addMessage: (params: { sessionId: string; role: 'user' | 'assistant' | 'system'; content: string; model?: string; tokens_used?: number }) => Promise<any>;
      };
      /** 配置管理 */
      configs: {
        get: (name: string) => Promise<any>;
      };
      /** 记忆/技能/工具数据 */
      data: {
        getMemoryEntries: (query?: { namespace?: string; limit?: number; offset?: number }) => Promise<any>;
        getLongTermMemory: (query?: { category?: string; status?: string; limit?: number }) => Promise<any>;
        bulkLongTermMemory: (params: { items: unknown[] }) => Promise<any>;
        getStatsEvents: (query?: { since?: number; limit?: number }) => Promise<any>;
        getSkills: () => Promise<any>;
        getCustomTools: () => Promise<any>;
      };
      /** 设备指纹 */
      device: {
        getFingerprint: () => Promise<{ ok: boolean; data?: { fingerprint: string }; error?: string }>;
      };
      /** 密钥加密存储 */
      secrets: {
        saveProviders: (secrets: any) => Promise<{ ok: boolean; error?: string }>;
        loadProviders: () => Promise<{ ok: boolean; data?: any; error?: string }>;
      };
    };
  }
}