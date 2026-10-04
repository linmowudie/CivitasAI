/**
 * @module services/secureStore
 * @description
 * 账号令牌的持久化存储。
 *
 * - **Electron**：走主进程 `safeStorage`（Windows DPAPI / macOS Keychain / Linux libsecret 加密），
 *   密文落在 `userData/secure-store.json`；渲染进程只通过 IPC 读写，明文不入 localStorage。
 * - **浏览器（开发模式）**：降级为 `sessionStorage`（仅本会话，关闭标签即失效），
 *   并通过 `isSecureStorage()` 让 UI 明确提示"令牌未加密存储"。
 *
 * 约定：`get` 返回 null 表示无值或解密失败（损坏的密文不应让应用崩溃）。
 */

export interface SecureStoreApi {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<boolean>;
  remove(key: string): Promise<void>;
  /** 是否为加密存储（Electron + safeStorage 可用） */
  isSecure(): boolean;
}

interface ElectronSecureBridge {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<boolean>;
  remove(key: string): Promise<void>;
  /** 主进程 safeStorage 是否可用（IPC 异步） */
  isAvailable(): Promise<boolean>;
}

function electronBridge(): ElectronSecureBridge | null {
  const api = (globalThis as { electronAPI?: { secureStore?: ElectronSecureBridge } }).electronAPI;
  return api?.secureStore ?? null;
}

/** 最近一次探测结果（未探测时为 null） */
let probedSecure: boolean | null = null;

/**
 * 探测加密存储是否可用（IPC 是异步的，必须在启动期 await 一次）。
 * 结果缓存供 `isSecureStorage()` 同步读取。
 */
export async function probeSecureStorage(): Promise<boolean> {
  const bridge = electronBridge();
  if (!bridge) {
    probedSecure = false;
    return false;
  }
  try {
    probedSecure = await bridge.isAvailable();
  } catch {
    probedSecure = false;
  }
  return probedSecure;
}

const SESSION_PREFIX = 'civitas.secure.';

const fallbackStore: SecureStoreApi = {
  async get(key) {
    try {
      return globalThis.sessionStorage?.getItem(SESSION_PREFIX + key) ?? null;
    } catch {
      return null;
    }
  },
  async set(key, value) {
    try {
      globalThis.sessionStorage?.setItem(SESSION_PREFIX + key, value);
      return true;
    } catch {
      return false;
    }
  },
  async remove(key) {
    try {
      globalThis.sessionStorage?.removeItem(SESSION_PREFIX + key);
    } catch {
      /* 忽略：无 sessionStorage 环境 */
    }
  },
  isSecure() {
    return false;
  },
};

/** 取当前可用的安全存储实现（Electron 走 IPC；否则降级 sessionStorage） */
export function getSecureStore(): SecureStoreApi {
  const bridge = electronBridge();
  if (!bridge) return fallbackStore;
  return {
    get: (key) => bridge.get(key),
    set: (key, value) => bridge.set(key, value),
    remove: (key) => bridge.remove(key),
    isSecure: () => probedSecure === true,
  };
}

/** 是否使用加密存储（需先 `await probeSecureStorage()`） */
export function isSecureStorage(): boolean {
  return probedSecure === true;
}

/** 令牌存储键（单键存整个令牌对象，便于原子替换） */
export const TOKENS_STORAGE_KEY = 'civitas.account.tokens';
