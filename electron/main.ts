/**
 * Civitas-AI Electron 主进程入口
 * 
 * 职责：
 * 1. 启动后端 HTTP 服务器 + IPC 桥接
 * 2. 创建 BrowserWindow 加载前端界面
 * 3. 处理应用生命周期
 */

import { app, BrowserWindow, Menu, nativeTheme, shell, dialog, ipcMain, safeStorage } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

// Scripts/build.cjs 以 format:'esm' 打包，ESM 下不存在 __dirname，
// 必须由 import.meta.url 还原，否则 createWindow() 直接抛 ReferenceError。
const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * 应用图标可能尚未放入 assets/（ELECTRON.md 要求打包前放入），
 * 缺失时不传该选项，避免启动报错。
 * 路径相对本文件：开发态为 <repo>/assets，打包态为 resources/app/assets。
 */
function resolveIcon(): string | undefined {
  const iconPath = join(__dirname, '../../assets/icon.png');
  return existsSync(iconPath) ? iconPath : undefined;
}

// 动态导入后端模块（避免编译时依赖）
async function startServer(): Promise<{ httpPort: number }> {
  const { startServer: start } = await import('../Src/main.js');
  return start();
}

// ── 环境变量 ────────────────────────────────────────────────────────
// 便携模式：数据目录存储在程序目录下的 Data/ 和 Logs/
const isPortable = process.argv.includes('--portable') || app.isPackaged;
if (isPortable) {
  const appPath = app.isPackaged ? join(process.resourcesPath, 'app') : app.getAppPath();
  process.env.CIVITAS_DATA_DIR = join(appPath, 'Data');
  process.env.CIVITAS_LOG_DIR = join(appPath, 'Logs');
  process.env.CIVITAS_CONFIG_DIR = join(appPath, 'Configs');
  process.env.CIVITAS_PROMPTS_DIR = join(appPath, 'Prompts');
  process.env.CIVITAS_SKILLS_DIR = join(appPath, 'Skills');
}

// ── 窗口管理 ────────────────────────────────────────────────────────
let mainWindow: BrowserWindow | null = null;
let serverPorts: { httpPort: number } | null = null;

async function createWindow(): Promise<void> {
  // 去掉默认菜单栏（File/Edit/View/Window）——保留 Windows 原生最小化/最大化/关闭按钮。
  // 说明：菜单栏在窗口顶部另占一行，与"通铺黑色"的界面风格冲突；应用内已有自己的操作入口。
  Menu.setApplicationMenu(null);

  // 让系统按深色主题绘制窗口装饰（标题栏按钮符号、滚动条、原生菜单等）：
  // 否则 Windows 会用浅色主题的**深色图标**画在纯黑标题栏上 → 三键看不见。
  nativeTheme.themeSource = 'dark';

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 768,
    title: 'Civitas-AI — 智体城邦',
    icon: resolveIcon(),
    // 通铺黑色：窗口背景与标题栏区域都为纯黑，避免启动白闪与顶部灰条
    backgroundColor: '#000000',
    // 隐藏系统标题栏，改用 Electron 的 Window Controls Overlay 绘制纯黑标题区；
    // Windows 的最小化/最大化/关闭按钮由系统绘制在右上角（WCO 需要 frame: false 才会启用，
    // 配合 nativeTheme=dark 使按钮符号为浅色，在纯黑底上可见）。
    // 高度需与渲染层 CSS 变量 --titlebar-height 保持一致（见 Client/src/index.css）。
    frame: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#000000',
      symbolColor: '#d4d4d4',
      height: 34,
    },
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // preload 必须为 CommonJS（构建产出 preload.cjs），ESM preload 不会被加载
      preload: join(__dirname, 'preload.cjs'),
    },
    show: false,
  });

  // 窗口就绪后显示，避免白屏闪烁
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  // 外部链接用默认浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // 加载前端
  if (app.isPackaged) {
    // 生产模式：加载构建后的静态文件。
    // 打包布局：resources/app/dist/main/electron/main.js（本文件）
    //        与 resources/app/dist/renderer/index.html（Vite outDir），
    // 故从 __dirname 出发需上溯两级到 dist/ 再到 renderer/（FE-007）。
    mainWindow.loadFile(join(__dirname, '../../renderer/index.html'));
  } else {
    // 开发模式：加载 Vite dev server
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ── 应用启动 ────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  console.log('═══════════════════════════════════════════');
  console.log('  Civitas-AI Desktop — 智体城邦');
  console.log('═══════════════════════════════════════════');
  console.log(`[Electron] 模式: ${isPortable ? '便携' : '安装'}`);
  console.log(`[Electron] 打包: ${app.isPackaged ? '是' : '否'}`);

  try {
    // 启动后端服务器
    console.log('[Electron] 正在启动后端服务...');
    serverPorts = await startServer();
    console.log(`[Electron] 后端服务已就绪 — HTTP:${serverPorts.httpPort}`);
  } catch (err) {
    console.error('[Electron] 后端服务启动失败:', err);
    app.quit();
    return;
  }

  // 创建主窗口
  await createWindow();

  // ── 服务端请求转发（规避渲染进程的 CORS 限制）────────────────────
  // 渲染进程是浏览器上下文：直接 fetch http://127.0.0.1:8787 属跨源请求，
  // 需要服务端配置 CORS；打包后页面来源为 file://（Origin: null）更麻烦。
  // 因此桌面端统一把服务端 HTTP 请求经主进程转发（Node fetch 无 CORS 约束）。
  ipcMain.handle('server-fetch', async (_event, req: unknown) => {
    try {
      const r = (req ?? {}) as { method?: string; url?: string; headers?: Record<string, string>; body?: string };
      if (!r.url || !/^https?:\/\//i.test(r.url)) {
        return { ok: false, status: 0, error: '非法请求地址' };
      }
      const res = await fetch(r.url, {
        method: r.method ?? 'GET',
        headers: r.headers ?? {},
        ...(r.body !== undefined ? { body: r.body } : {}),
      });
      const text = await res.text();
      return { ok: true, status: res.status, body: text };
    } catch (e) {
      return { ok: false, status: 0, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // 任务工作目录选择（原生对话框）——供渲染进程的 WorkDirBar 调用
  ipcMain.handle('pick-directory', async () => {
    try {
      const result = await dialog.showOpenDialog(mainWindow ?? undefined as unknown as BrowserWindow, {
        title: '选择任务工作目录',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      return result.filePaths[0] ?? null;
    } catch {
      return null;
    }
  });

  // ── preload 基础接口（FE-010：此前无 handler，invoke 会永久 pending）──
  // 返回后端实际监听端口（浏览器模式无此接口；前端不依赖，保留供诊断）
  ipcMain.handle('get-server-ports', () => serverPorts);
  ipcMain.handle('get-app-version', () => app.getVersion());
  ipcMain.on('open-external', (_event, url: unknown) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      void shell.openExternal(url);
    }
  });

  // ── 账号令牌安全存储（safeStorage）────────────────────────────────
  // 渲染进程不接触明文磁盘：值经 safeStorage 加密后写入 userData/secure-store.json。
  // 浏览器模式（无 preload）会降级为 sessionStorage，见 Client/src/services/secureStore.ts
  const secureStorePath = join(app.getPath('userData'), 'secure-store.json');

  const readSecureFile = (): Record<string, string> => {
    try {
      if (!existsSync(secureStorePath)) return {};
      const raw = readFileSync(secureStorePath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
    } catch {
      return {};
    }
  };

  const writeSecureFile = (data: Record<string, string>): void => {
    try {
      writeFileSync(secureStorePath, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
    } catch {
      /* 写失败时静默：登录态无法持久化，但不影响本次会话 */
    }
  };

  ipcMain.handle('secure-store-available', () => {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  });

  ipcMain.handle('secure-store-get', (_event, key: unknown) => {
    try {
      if (typeof key !== 'string' || !key) return null;
      const stored = readSecureFile()[key];
      if (!stored) return null;
      if (!safeStorage.isEncryptionAvailable()) return null;
      return safeStorage.decryptString(Buffer.from(stored, 'base64'));
    } catch {
      return null; // 密文损坏 / 换机器导致密钥变化 → 视为无值
    }
  });

  ipcMain.handle('secure-store-set', (_event, key: unknown, value: unknown) => {
    try {
      if (typeof key !== 'string' || !key || typeof value !== 'string') return false;
      if (!safeStorage.isEncryptionAvailable()) return false;
      const data = readSecureFile();
      data[key] = safeStorage.encryptString(value).toString('base64');
      writeSecureFile(data);
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle('secure-store-remove', (_event, key: unknown) => {
    try {
      if (typeof key !== 'string' || !key) return;
      const data = readSecureFile();
      if (key in data) {
        delete data[key];
        writeSecureFile(data);
      }
    } catch {
      /* 忽略 */
    }
  });

  // macOS 点击 dock 图标时重新创建窗口
  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
  });
});

// ── 应用退出 ────────────────────────────────────────────────────────
app.on('window-all-closed', async () => {
  // 优雅关闭后端服务
  if (process.platform !== 'darwin') {
    console.log('[Electron] 正在关闭后端服务...');
    try {
      const { stopHttpServer } = await import('../Src/Interface/WebServer/httpServer.js');
      const { stopIpcBridge } = await import('../Src/Interface/IpcBridge/ipcBridge.js');
      await stopHttpServer();
      stopIpcBridge();
    } catch {
      // 静默处理
    }
    app.quit();
  }
});

// ── 安全策略 ────────────────────────────────────────────────────────
app.on('web-contents-created', (_event, contents) => {
  // 禁止导航到外部页面
  contents.on('will-navigate', (event, _url) => {
    event.preventDefault();
  });
});

// ── 导出供外部使用 ──────────────────────────────────────────────────
export function getServerPorts(): { httpPort: number } | null {
  return serverPorts;
}
