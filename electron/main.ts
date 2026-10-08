/**
 * Civitas-AI Electron 主进程入口
 *
 * 职责：
 * 1. 启动后端 HTTP 服务器 + IPC 桥接
 * 2. 创建 BrowserWindow 加载前端界面
 * 3. 处理应用生命周期
 *
 * ## 打包格式（2026-10-06 关键修复）
 * 本文件由 `Scripts/build.cjs` 以 **CommonJS** 产出为 `dist/main/electron/main.cjs`。
 * 原因：Electron 44 / Node 24 下，**ESM 无法使用 `electron` 模块**——
 * `import { app } from 'electron'` 直接 `SyntaxError: does not provide an export named 'app'`，
 * `import electron from 'electron'` 与 `await import('electron')` 拿到的都是空壳
 * （实测 `m.app / m.ipcMain / m.safeStorage` 全为 undefined）。
 * 后果是**打包后的应用一启动就退出**（CJS 侧 `require('electron')` 才是可靠路径）。
 * 后端仍然打包为 ESM，由本文件动态 import，并把 ipcMain / safeStorage 注入进去
 * （见 `setElectronRuntime`）——否则打包后 IPC 与加密密钥存储都会静默降级。
 */

import { app, BrowserWindow, Menu, nativeTheme, shell, dialog, ipcMain, safeStorage } from 'electron';
import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

// CommonJS 打包：__dirname 为原生全局变量（由 esbuild 以 cjs 输出保证）。

/**
 * 应用图标可能尚未放入 assets/（ELECTRON.md 要求打包前放入），
 * 缺失时不传该选项，避免启动报错。
 * 路径相对本文件：本文件位于 `<APP_ROOT>/dist/main/electron/`，故上溯三级到 `<APP_ROOT>/assets/`。
 * （历史实现少了一级，指向 `dist/assets/`，图标恒缺失。）
 */
function resolveIcon(): string | undefined {
  const candidates = [
    join(__dirname, '../../../assets/icon.png'),
    join(__dirname, '../../assets/icon.png'),
  ];
  return candidates.find((p) => existsSync(p));
}

/**
 * 动态导入后端模块（避免编译时依赖）。
 *
 * 用**变量说明符**：esbuild 打包时不会把整个后端树内联进主进程产物，
 * 运行时由 Node 在 `dist/main/Src/main.js` 解析（ESM 动态导入在 CJS 中合法）。
 */
async function importBackend(): Promise<typeof import('../Src/main.js')> {
  const specifier = '../Src/main.js';
  return import(specifier) as Promise<typeof import('../Src/main.js')>;
}

async function startServer(): Promise<{ httpPort: number }> {
  const backend = await importBackend();
  // 关键：把 CJS 侧的 electron 真身注入 ESM 后端（ipcMain / safeStorage / 窗口广播）
  //
  // `broadcastToWindows` 是 2026-10-07 补的：历史实现只注入 ipcMain，后端拼出的"假 electron 模块"
  // 里 `BrowserWindow` 恒为 undefined，事件广播处每次调用都抛
  // `TypeError: ... reading 'getAllWindows'`（开发态启动日志可见 UnhandledPromiseRejection），
  // 使 `backend-event` 推送整条失效。改为注入能力函数，后端不再自行拼装 electron 模块。
  backend.setElectronRuntime({
    ipcMain,
    safeStorage,
    broadcastToWindows: (channel: string, payload: unknown): number => {
      let sent = 0;
      for (const win of BrowserWindow.getAllWindows()) {
        try {
          win.webContents.send(channel, payload);
          sent++;
        } catch {
          // 窗口可能正在销毁：忽略
        }
      }
      return sent;
    },
  });
  return backend.startServer();
}

// ── 运行模式与目录契约 ──────────────────────────────────────────────
//
// **打包 ≠ 便携**。历史实现把 `app.isPackaged` 直接当便携，于是安装到
// `C:\Program Files\CivitasAI` 后数据/日志被指向只读的安装目录 → `initDirectories()` 抛 EPERM
// → 应用启动即退出。现在只认显式便携信号（`--portable` 参数或 exe 同级 `.portable` 标记文件）。
//
// 环境变量契约（与 Src/Infra/Fs/pathResolver.ts 一致）：
// | 变量 | 安装态 | 便携态 |
// |------|--------|--------|
// | CIVITAS_APP_ROOT | `<安装目录>\resources\app`（只读资源） | 同左 |
// | CIVITAS_DATA_ROOT | `%APPDATA%\CivitasAI`（库/日志/密钥/配置） | `<程序目录>\Data` |
// | CIVITAS_WORKSPACE_ROOT | `<安装目录>\Workspace`（只读时由 pathResolver 回落） | `<程序目录>\Workspace` |
//
// 开发态（未打包）不注入任何变量：交给 pathResolver 的缺省（仓库 `Data/`、`Logs/`），
// 保持 `npm run dev:electron` 的既有行为不变。
const argPortable = process.argv.includes('--portable');
const markerPortable = (() => {
  try {
    return existsSync(join(dirname(process.execPath), '.portable'));
  } catch {
    return false;
  }
})();
const isPortable = argPortable || markerPortable;

if (app.isPackaged) {
  const appRoot = join(process.resourcesPath, 'app');
  // 安装目录 = exe 所在目录（`resources/` 的上一层）；便携版另由 electron-builder 注入
  // PORTABLE_EXECUTABLE_DIR（单文件便携包运行时解压在临时目录，必须以该变量为准）。
  const installDir = dirname(app.getPath('exe'));
  const portableBase = process.env.PORTABLE_EXECUTABLE_DIR ?? installDir;

  // 应用名与用户数据目录：默认 userData 取 package.json 的 name（`civitas-ai`），
  // 与产品名/文档口径（`%APPDATA%\CivitasAI`）不一致，这里显式对齐。
  // 必须在 app ready 之前调用。
  app.setName('CivitasAI');

  /**
   * userData 可写性探测 + 回落（2026-10-06 打包态实测修复）。
   *
   * 背景：受限会话/企业策略下 `%APPDATA%\CivitasAI` 可能**不能建子目录**（实测：打包进程
   * 能在该目录里写文件，却在创建 `Code Cache\js` / `Network` 时被拒 → Chromium 日志刷
   * `Failed to create directory` / `拒绝访问 (0x5)`，主进程的 `secure-store.json` 也受影响）。
   *
   * 因此探针必须**模拟真实用途**，只测"写文件"是不够的（第一版就栽在这里：探针通过、
   * 缓存目录照样建不出来）：
   *   ① 建目录 → ② 在其下建子目录 → ③ 写文件 → ④ 全部清理。
   * 按"显式指定 → 产品口径 → %LOCALAPPDATA% → 系统临时目录"顺序取第一个全通过的。
   */
  function pickUserDataDir(): { dir: string; reason: string } {
    const primary = join(app.getPath('appData'), 'CivitasAI');
    const explicit = process.env['CIVITAS_USER_DATA_DIR'];
    const candidates: Array<{ dir: string; reason: string }> = [];
    if (explicit) candidates.push({ dir: explicit, reason: '显式 CIVITAS_USER_DATA_DIR' });
    candidates.push({ dir: primary, reason: '产品口径 %APPDATA%\\CivitasAI' });
    // Electron 的 app.getPath 没有 'localAppData'（只有 appData/userData/...），直接取环境变量；
    // 取不到时用 %APPDATA% 的同级 Local 目录兜底。
    const localAppData = process.env['LOCALAPPDATA'] || join(app.getPath('appData'), '..', 'Local');
    candidates.push({ dir: join(localAppData, 'CivitasAI'), reason: '%LOCALAPPDATA%（%APPDATA% 不可写时的回落）' });
    candidates.push({ dir: join(tmpdir(), 'CivitasAI'), reason: '系统临时目录（最后回落，profile 不持久）' });

    for (const candidate of candidates) {
      const probeDir = join(candidate.dir, `.civitas-probe-${process.pid}`);
      try {
        mkdirSync(probeDir, { recursive: true });       // ① 建目录 + ② 子目录
        const probeFile = join(probeDir, 'probe.txt');
        writeFileSync(probeFile, 'ok', { encoding: 'utf8' }); // ③ 写文件
        rmSync(probeDir, { recursive: true, force: true });   // ④ 清理
        return candidate;
      } catch {
        try { rmSync(probeDir, { recursive: true, force: true }); } catch { /* ignore */ }
        // 换下一个候选
      }
    }
    // 极端情况：所有候选都不可写 → 保留产品口径路径，让 Chromium/主进程各自降级并暴露错误
    return { dir: primary, reason: '全部候选不可写（保留默认路径，功能将降级）' };
  }

  const userData = pickUserDataDir();
  app.setPath('userData', userData.dir);
  process.env['CIVITAS_USER_DATA_DIR'] = userData.dir;
  process.env['CIVITAS_USER_DATA_REASON'] = userData.reason;
  if (userData.dir !== join(app.getPath('appData'), 'CivitasAI')) {
    console.warn(`[Electron] userData 已回落到 ${userData.dir}（原因：${userData.reason}）`);
  }

  /**
   * 只填空值：**外部显式的环境变量优先**。
   * 这样企业部署/自动化测试可以用 `CIVITAS_DATA_ROOT` 等把数据重定向到指定位置，
   * 而不是被应用启动时的默认值覆盖。
   */
  const setIfUnset = (key: string, value: string): void => {
    if (!process.env[key]) process.env[key] = value;
  };

  setIfUnset('CIVITAS_APP_ROOT', appRoot);

  // 只注入"两个根 + 模式"：日志/配置/密钥/库目录一律由 pathResolver 从数据根派生，
  // 避免"用户改了 CIVITAS_DATA_ROOT，日志却还写去 userData"这类分叉
  // （日志/配置目录派生规则见 Src/Infra/Fs/pathResolver.ts）。
  if (isPortable) {
    setIfUnset('CIVITAS_PORTABLE', '1');
    setIfUnset('CIVITAS_DATA_ROOT', join(portableBase, 'Data'));
    setIfUnset('CIVITAS_WORKSPACE_ROOT', join(portableBase, 'Workspace'));
  } else {
    setIfUnset('CIVITAS_INSTALLED', '1');
    // 全局数据（库/日志/密钥/配置）落 %APPDATA%\CivitasAI，卸载默认不删
    setIfUnset('CIVITAS_DATA_ROOT', app.getPath('userData'));
    // 产品决策：工作空间（上下文产物、会话工作目录）放安装目录，便于用户就近查看/清理；
    // 安装目录只读时 pathResolver 会回落到 <DATA_ROOT>\Workspace 并在启动日志中告警。
    setIfUnset('CIVITAS_WORKSPACE_ROOT', join(installDir, 'Workspace'));
  }
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

  /**
   * 渲染进程诊断（2026-10-07 修复"跳过引导后全黑"时新增）。
   *
   * 背景：渲染进程抛异常/加载失败时，界面上只会是一片黑，主进程日志里什么都没有——
   * 用户只能看到"卡住"，我们也无从排障。这里把渲染进程的关键事件转发到主进程日志：
   * - console 错误/警告（含未捕获异常，Chromium 以 console error 形式给出）
   * - 页面加载失败（did-fail-load）、渲染进程崩溃（render-process-gone）
   */
  /**
   * 渲染进程日志转发（2026-10-07）。
   *
   * Electron 44 的新签名是 `(event)`，参数挂在 **event 对象**上
   * （`event.level` / `event.message` / `event.lineNumber` / `event.sourceId`）。
   * 早期实现按旧签名 `(event, level, message, line, sourceId)` 声明形参，
   * 启动时会打印 `'console-message' arguments are deprecated` —— 现在统一读 event 对象，
   * 并对老版本（参数式）保留兜底，避免不同 Electron 版本下丢失日志。
   */
  mainWindow.webContents.on('console-message', ((event: unknown, ...legacy: unknown[]) => {
    const e = event as {
      level?: string | number; message?: string; sourceId?: string; lineNumber?: number;
    };
    const hasDetails = typeof e?.level === 'string' || typeof e?.message === 'string';
    const level = hasDetails
      ? String(e.level ?? 'info')
      : (['debug', 'info', 'warning', 'error'][Number(legacy[0])] ?? 'info');
    const text = hasDetails ? String(e.message ?? '') : String(legacy[1] ?? '');
    const sourceId = hasDetails ? e.sourceId : (legacy[3] as string | undefined);
    const line = hasDetails ? e.lineNumber : (legacy[2] as number | undefined);
    if (level !== 'error' && level !== 'warning') return;
    const where = sourceId ? ` (${sourceId}:${line ?? 0})` : '';
    console.error(`${level === 'error' ? '[Renderer:error]' : '[Renderer:warn]'} ${text}${where}`);
  }) as never);
  mainWindow.webContents.on('did-fail-load', (_e, code, description, url) => {
    console.error(`[Renderer] 页面加载失败：${code} ${description} — ${url}`);
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error(`[Renderer] 渲染进程退出：${details?.reason} (exitCode=${details?.exitCode})`);
  });

  /**
   * UI 结构探针（排障用，`CIVITAS_UI_DEBUG=1` 时才启用）。
   *
   * 用途：界面"看起来全黑"但渲染进程又没报错时（实测：跳过初始化引导后的主界面），
   * 只有拿到真实 DOM 才能区分"没渲染 / 尺寸塌成 0 / 渲染了但没数据"。
   * 输出走主进程 stdout，因此打包态也能收集。
   */
  if (process.env['CIVITAS_UI_DEBUG']) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        mainWindow?.webContents.executeJavaScript(`(() => {
          const root = document.getElementById('root');
          const first = root && root.firstElementChild;
          const rect = (el) => el ? { w: el.clientWidth, h: el.clientHeight } : null;
          return JSON.stringify({
            url: location.href,
            title: document.title,
            rootChildren: root ? root.childElementCount : -1,
            body: rect(document.body),
            root: rect(root),
            firstChild: first ? { tag: first.tagName, cls: String(first.className).slice(0, 140), ...rect(first) } : null,
            visibleText: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 300),
            errors: (window.__CIVITAS_UI_ERRORS__ || []).slice(0, 5),
          });
        })()`).then((info: string) => {
          console.log('[Electron][ui-debug]', info);
        }).catch((e: unknown) => {
          console.error('[Electron][ui-debug] 读取页面结构失败', e);
        });
      }, 6000);
    });
  }

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
  console.log(`[Electron] 模式: ${isPortable ? '便携' : app.isPackaged ? '安装' : '开发'}`);
  console.log(`[Electron] 打包: ${app.isPackaged ? '是' : '否'}`);
  if (app.isPackaged) {
    console.log(`[Electron] 程序根: ${process.env.CIVITAS_APP_ROOT}`);
    console.log(`[Electron] 数据根: ${process.env.CIVITAS_DATA_ROOT}`);
    console.log(`[Electron] 工作空间: ${process.env.CIVITAS_WORKSPACE_ROOT}`);
  }

  try {
    // 启动后端服务器
    console.log('[Electron] 正在启动后端服务...');
    serverPorts = await startServer();
    console.log(`[Electron] 后端服务已就绪 — HTTP:${serverPorts.httpPort}`);
  } catch (err) {
    // 非开发者的第一条救命信息：把"为什么起不来 + 怎么办"直接弹到屏幕上，
    // 而不是静默退出（历史行为：console.error 后 app.quit()，用户只看到窗口一闪而过）。
    const message = err instanceof Error ? err.message : String(err);
    console.error('[Electron] 后端服务启动失败:', err);
    dialog.showErrorBox(
      'Civitas AI 启动失败',
      `${message}\n\n`
      + `程序根：${process.env.CIVITAS_APP_ROOT ?? '(未打包)'}\n`
      + `数据根：${process.env.CIVITAS_DATA_ROOT ?? '(未打包)'}\n`
      + `工作空间：${process.env.CIVITAS_WORKSPACE_ROOT ?? '(未打包)'}\n\n`
      + '常见处理方式：\n'
      + '1) 把程序安装到用户目录（默认 %LOCALAPPDATA%\\Programs\\CivitasAI）或 D:\\ 等可写位置；\n'
      + '2) 若数据目录不可写，设置环境变量 CIVITAS_DATA_ROOT 指向可写目录后重启；\n'
      + '3) 若提示端口被占用，关闭已运行的 Civitas AI，或修改数据根下 Configs/local.json 的 server.httpPort。',
    );
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

  /**
   * 在资源管理器中打开目录/文件（首次运行引导："我的数据存在哪"一键直达）。
   *
   * 安全：只允许打开已存在的路径，且必须是目录或文件（不允许 URL，URL 走 `open-external`）。
   */
  ipcMain.handle('open-path', async (_event, target: unknown) => {
    try {
      if (typeof target !== 'string' || target.trim() === '') {
        return { ok: false, error: '路径不能为空' };
      }
      if (!existsSync(target)) {
        return { ok: false, error: `路径不存在：${target}` };
      }
      const error = await shell.openPath(target);
      return error ? { ok: false, error } : { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
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
      // 通过**同一个后端模块实例**关闭（历史写法各自 import 会拿到另一份副本，
      // 等于"停了个空对象"：HTTP 服务实际未优雅关闭，仅靠进程退出兜底）
      const backend = await importBackend();
      await backend.stopServer();
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
