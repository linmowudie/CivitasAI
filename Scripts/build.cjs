/**
 * Civitas-AI 构建脚本
 * 
 * 使用 esbuild 快速打包后端代码，不依赖 TypeScript 严格类型检查。
 * 前端由 Vite 构建。
 */

const esbuild = require('esbuild');
const path = require('node:path');
const fs = require('node:fs');

const outDir = path.join(__dirname, '..', 'dist', 'main');

async function build() {
  console.log('🔨 开始构建后端代码...');
  
  // 清理输出目录
  if (fs.existsSync(outDir)) {
    fs.rmSync(outDir, { recursive: true });
  }

  try {
    // 打包后端入口 + Electron 主进程（ESM）
    await esbuild.build({
      entryPoints: [
        'Src/main.ts',
        'electron/main.ts',
      ],
      bundle: true,
      platform: 'node',
      target: 'node20',
      outdir: outDir,
      format: 'esm',
      sourcemap: true,
      external: [
        // 原生模块保持外部引用
        'better-sqlite3',
        'fsevents',
        // Electron 模块保持外部引用
        'electron',
        // ws 使用动态 require，不能被打包
        'ws',
      ],
      // 允许不严格的类型，只做语法转换
      logLevel: 'warning',
    });

    // preload 必须单独产出为 CommonJS（.cjs）
    // 原因：preload 运行在 CJS 上下文（contextIsolation + 默认 sandbox），
    // ESM preload 会静默加载失败 → window.electronAPI 不存在
    // → 前端 isElectron() 判定失败，send() 退回浏览器降级分支丢弃命令。
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
  } catch (err) {
    console.error('❌ 构建失败:', err);
    process.exit(1);
  }
}

build();
