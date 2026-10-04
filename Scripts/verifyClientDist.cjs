/**
 * 构建产物校验（FE-016）
 *
 * 背景：2026-10-01 曾观察到 dist/renderer/index.html 为 1 字节（正常约 1.2KB）。
 * 全仓检索无其它写入方，根因最可能是构建被中断 / 并发构建竞争 emptyOutDir，
 * 留下半写文件且无任何报错——随后 electron 打包会把坏产物静默带入发布包。
 *
 * 本脚本作为 build:client 的收尾门禁：入口文件缺失或尺寸异常即以非 0 退出，
 * 让问题在构建期显式暴露，而不是以"打包后白屏"的形态出现在用户侧。
 */

const fs = require('node:fs');
const path = require('node:path');

const INDEX_PATH = path.join(__dirname, '..', 'dist', 'renderer', 'index.html');
/** 正常入口约 1.2KB；低于 100 字节视为半写/异常产物 */
const MIN_BYTES = 100;

try {
  const size = fs.statSync(INDEX_PATH).size;
  if (size < MIN_BYTES) {
    console.error(
      `❌ renderer 入口异常：dist/renderer/index.html 仅 ${size} 字节（预期 > ${MIN_BYTES}）。\n` +
      '   构建可能被中断或并发竞争，请重跑 npm run build:client。',
    );
    process.exit(1);
  }
  console.log(`✅ renderer 入口校验通过（index.html ${size} 字节）`);
} catch (err) {
  console.error(
    `❌ 缺少 dist/renderer/index.html：${err instanceof Error ? err.message : String(err)}\n` +
    '   请先执行 npm run build:client。',
  );
  process.exit(1);
}
