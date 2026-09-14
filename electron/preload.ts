/**
 * Electron 预加载脚本
 * 
 * 在渲染进程中安全地暴露有限的 Node.js API。
 * 使用 contextBridge 确保隔离性。
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
});

// 类型声明（供前端使用）
declare global {
  interface Window {
    electronAPI: {
      getServerPorts: () => Promise<{ httpPort: number; wsPort: number }>;
      getAppVersion: () => Promise<string>;
      openExternal: (url: string) => void;
    };
  }
}
