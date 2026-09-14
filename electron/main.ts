/**
 * Civitas-AI Electron 主进程入口
 * 
 * 职责：
 * 1. 启动后端 HTTP/WS 服务器
 * 2. 创建 BrowserWindow 加载前端界面
 * 3. 处理应用生命周期
 */

import { app, BrowserWindow, shell } from 'electron';
import { join } from 'node:path';

// 动态导入后端模块（避免编译时依赖）
async function startServer(): Promise<{ httpPort: number; wsPort: number }> {
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
let serverPorts: { httpPort: number; wsPort: number } | null = null;

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 768,
    title: 'Civitas-AI — 智体城邦',
    icon: join(__dirname, '../assets/icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: join(__dirname, 'preload.js'),
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
    // 生产模式：加载构建后的静态文件
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
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
    console.log(`[Electron] 后端服务已就绪 — HTTP:${serverPorts.httpPort} WS:${serverPorts.wsPort}`);
  } catch (err) {
    console.error('[Electron] 后端服务启动失败:', err);
    app.quit();
    return;
  }

  // 创建主窗口
  await createWindow();

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
      const { stopWsGateway } = await import('../Src/Interface/WebSocket/wsGateway.js');
      await stopHttpServer();
      await stopWsGateway();
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
export function getServerPorts(): { httpPort: number; wsPort: number } | null {
  return serverPorts;
}
