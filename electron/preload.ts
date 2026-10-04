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
