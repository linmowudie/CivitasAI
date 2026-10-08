/**
 * Civitas-AI 打包产物校验器（打包前 / 打包后都可跑）
 *
 * 为什么需要它：electron-builder 不会因为"dist 里少了主进程入口"就报错——
 * 它只会把一个缺文件的包正常打出来，问题在用户侧才以"点开没反应 / 白屏"暴露。
 * 所以把校验前置成一道显式门禁：缺什么、该跑哪条命令修，都在这里说清楚。
 *
 * 校验项：
 *   - 后端/主进程产物：dist/main/electron/main.cjs、dist/main/electron/preload.cjs、dist/main/Src/main.js
 *     （主进程必须是 **CJS**：Electron 44 / Node 24 下 ESM 无法使用 electron 模块）
 *   - 前端入口：dist/renderer/index.html（≥100 字节，防止半写产物）
 *   - 图标资产：assets/icon.ico、assets/icon.png（存在且非空）
 *
 * 用法：
 *   node Scripts/verifyPackage.cjs             # 默认，标题写"打包前"
 *   node Scripts/verifyPackage.cjs --stage=post
 *
 * 退出码：全部通过 = 0；任一失败 = 1。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

const stageArg = process.argv.find((a) => a.startsWith('--stage='));
const STAGE = stageArg ? stageArg.split('=')[1] : 'pre';
const STAGE_LABEL = STAGE === 'post' ? '打包后' : '打包前';

/** 每项校验：相对路径、最小字节数（0 表示只要求非空）、失败时的可操作建议 */
const CHECKS = [
  {
    file: 'dist/main/electron/main.cjs',
    minBytes: 1024,
    hint: 'Electron 主进程入口缺失/过小 → 重跑 npm run build:server（主进程必须产出 .cjs，ESM 无法加载 electron 模块）',
  },
  {
    file: 'dist/main/electron/preload.cjs',
    minBytes: 256,
    hint: 'preload 缺失/过小 → 重跑 npm run build:server（preload 必须是 CJS）',
  },
  {
    file: 'dist/main/Src/main.js',
    minBytes: 1024,
    hint: '后端入口缺失/过小 → 重跑 npm run build:server',
  },
  {
    file: 'dist/renderer/index.html',
    minBytes: 100,
    hint: '前端入口缺失/半写 → 重跑 npm run build:client',
  },
  {
    file: 'assets/icon.ico',
    minBytes: 1024,
    hint: 'Windows 图标缺失 → 运行 python Scripts/genIcons.py 生成',
  },
  {
    file: 'assets/icon.png',
    minBytes: 1024,
    hint: '通用图标缺失 → 运行 python Scripts/genIcons.py 生成',
  },
];

function checkOne(item) {
  const abs = path.join(ROOT, item.file);
  let size = 0;
  try {
    const stat = fs.statSync(abs);
    if (!stat.isFile()) {
      return { ok: false, size: 0, reason: '不是普通文件' };
    }
    size = stat.size;
  } catch {
    return { ok: false, size: 0, reason: '文件不存在' };
  }
  if (size < item.minBytes) {
    return { ok: false, size, reason: `仅 ${size} 字节（下限 ${item.minBytes}）` };
  }
  return { ok: true, size, reason: '' };
}

function main() {
  console.log(`\n🔎 打包产物校验（${STAGE_LABEL}）`);
  console.log(`   仓库根目录: ${ROOT}`);
  console.log(`   校验时间: ${new Date().toLocaleString('zh-CN')}\n`);

  const failures = [];
  for (const item of CHECKS) {
    const result = checkOne(item);
    if (result.ok) {
      console.log(`  ✅ ${item.file}  (${result.size} 字节)`);
    } else {
      console.log(`  ❌ ${item.file}  — ${result.reason}`);
      console.log(`     ↳ 处理建议：${item.hint}`);
      failures.push(item);
    }
  }

  console.log('');
  if (failures.length > 0) {
    console.error(
      `❌ 校验失败（${STAGE_LABEL}）：${failures.length}/${CHECKS.length} 项不通过，已中止。\n` +
        '   提示：可执行 npm run build:all 重建前后端产物，再重跑本脚本。\n',
    );
    return 1;
  }

  console.log(`✅ 校验通过（${STAGE_LABEL}）：${CHECKS.length}/${CHECKS.length} 项全部就绪。\n`);
  return 0;
}

process.exit(main());
