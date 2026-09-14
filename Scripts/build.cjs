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
    // 打包后端入口
    await esbuild.build({
      entryPoints: [
        'Src/main.ts',
        'electron/main.ts',
        'electron/preload.ts',
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
      ],
      // 允许不严格的类型，只做语法转换
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
