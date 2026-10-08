/**
 * Civitas-AI 构建脚本
 *
 * 使用 esbuild 快速打包后端代码，不依赖 TypeScript 严格类型检查。
 * 前端由 Vite 构建。
 *
 * ## 产物格式（2026-10-06 关键修复）
 * | 入口              | 格式 | 产物                              | 原因 |
 * |-------------------|------|-----------------------------------|------|
 * | `Src/main.ts`     | ESM  | `dist/main/Src/main.js`            | 后端全量打包（ESM） |
 * | `electron/main.ts`| CJS  | `dist/main/electron/main.cjs`      | **Electron 44 / Node 24 下 ESM 无法使用 `electron`**：`import { app } from 'electron'` 直接 SyntaxError，`await import('electron')` 也拿不到真身 → 打包后应用一启动就退出 |
 * | `electron/preload.ts` | CJS | `dist/main/electron/preload.cjs` | preload 必须 CJS（ESM preload 静默加载失败） |
 *
 * 后端与主进程的桥接：主进程（CJS）动态 `import('../Src/main.js')`，再调用后端导出的
 * `setElectronRuntime({ ipcMain, safeStorage })`，把 CJS 侧的 electron 真身注入 ESM 后端。
 */

const esbuild = require('esbuild');
const path = require('node:path');
const fs = require('node:fs');

const outDir = path.join(__dirname, '..', 'dist', 'main');

/** 原生/动态模块保持外部引用（不打包） */
const NODE_EXTERNALS = ['better-sqlite3', 'fsevents', 'electron', 'ws'];

async function build() {
  console.log('🔨 开始构建后端代码...');

  // 清理输出目录
  if (fs.existsSync(outDir)) {
    fs.rmSync(outDir, { recursive: true });
  }

  try {
    // ① 后端（ESM）：全部业务代码打成单文件
    //    必须显式 outbase='.'：只有一个入口时 esbuild 会把公共基准算成 `Src/`，
    //    产出 `dist/main/main.js`（Electron 主进程按 `../Src/main.js` 引用就会找不到）。
    await esbuild.build({
      entryPoints: ['Src/main.ts'],
      outbase: '.',
      bundle: true,
      platform: 'node',
      target: 'node20',
      outdir: outDir,
      format: 'esm',
      sourcemap: true,
      external: NODE_EXTERNALS,
      logLevel: 'warning',
    });

    // ② Electron 主进程（CJS）：必须用 require('electron') 才能真正拿到 app/BrowserWindow/ipcMain
    await esbuild.build({
      entryPoints: ['electron/main.ts'],
      bundle: true,
      platform: 'node',
      target: 'node20',
      outfile: path.join(outDir, 'electron', 'main.cjs'),
      format: 'cjs',
      sourcemap: true,
      external: NODE_EXTERNALS,
      logLevel: 'warning',
    });

    // ③ preload（CJS）：preload 运行在 CJS 上下文，ESM preload 会静默加载失败
    //    → window.electronAPI 不存在 → 前端 isElectron() 判定失败。
    await esbuild.build({
      entryPoints: ['electron/preload.ts'],
      bundle: true,
      platform: 'node',
      target: 'node20',
      outfile: path.join(outDir, 'electron', 'preload.cjs'),
      format: 'cjs',
      sourcemap: true,
      external: ['electron'],
      logLevel: 'warning',
    });

    console.log('✅ 后端构建完成');
    console.log(`   输出目录: ${outDir}`);
    console.log('   - dist/main/Src/main.js          (ESM 后端)');
    console.log('   - dist/main/electron/main.cjs    (CJS 主进程)');
    console.log('   - dist/main/electron/preload.cjs (CJS preload)');
  } catch (err) {
    console.error('❌ 构建失败:', err);
    process.exit(1);
  }
}

build();
