/**
 * 发布包内容校验（REV-278 / REV-279 / REV-282 / REV-283 / REV-291）
 *
 * 为什么需要它：既有门禁只看 `dist/`（构建中间产物）和 `release/*.exe` 的字节数。
 * 而"打出来的包能不能跑、里面装了什么"是另一件事：
 *   - 233KB 的 NSIS 安装包（2026-10-08 实测 `release/CivitasAI-Setup-0.1.0.exe`）体积不足会被拦，
 *     但"体积足够的坏包"（入口没进 asar、原生 binding 没解包）照样能过；
 *   - 最高优先级配置覆盖层 `Configs/local.json`（可能含供应商凭据）、`.env`、私钥文件
 *     会被 `files`/`extraResources` 整目录拷进发布包，属于凭据外带；
 *   - 仓库没有发布通道，electron-builder 却会从 git remote 推断出 publish 配置，
 *     把个人仓库与个人证书主体写成更新元数据（`app-update.yml`）。
 * 本脚本对这些做**内容级**断言，缺一项即非 0 退出。
 *
 * 用法：
 *   node Scripts/verifyRelease.cjs
 *   node Scripts/verifyRelease.cjs --unpacked=release/win-unpacked
 *
 * 退出码：全部通过 = 0；任一失败 = 1。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

const unpackedArg = process.argv.find((a) => a.startsWith('--unpacked='));
const UNPACKED = path.join(ROOT, unpackedArg ? unpackedArg.split('=').slice(1).join('=') : path.join('release', 'win-unpacked'));

/** Electron 主程序 exe 体积下限：Chromium 运行时本身就有 100MB+ */
const MIN_EXE_BYTES = 50 * 1024 * 1024;

/** asar 内必须存在的主进程/后端入口（缺任一 → 点开没反应） */
const REQUIRED_ENTRIES = [
  'dist/main/electron/main.cjs',
  'dist/main/electron/preload.cjs',
  'dist/main/Src/main.js',
  'dist/renderer/index.html',
];

/** 不得进入发布包的泄漏面（相对 asar 根 / extraResources 根） */
const LEAK_PATTERNS = [
  { re: /(^|[\\/])local\.json$/i, why: 'Configs/local.json 是最高优先级覆盖层，可能含供应商凭据' },
  { re: /(^|[\\/])\.env(\.|$)/i, why: '.env 属本机环境变量文件' },
  { re: /\.(pfx|p12)$/i, why: '私钥容器' },
  { re: /\.pem$/i, why: '私钥/证书' },
  { re: /(^|[\\/])\.secrets([\\/]|$)/i, why: '运行时密钥目录' },
];

let failures = 0;

function assert(name, fn) {
  const result = fn();
  if (result.ok) {
    console.log(`  ✅ ${name}${result.detail ? `（${result.detail}）` : ''}`);
    return true;
  }
  failures++;
  console.error(`  ❌ ${name} — ${result.reason}`);
  if (result.hint) console.error(`     ↳ 处理建议：${result.hint}`);
  return false;
}

/** asar 条目路径归一：'\dist\main\Src\main.js' → 'dist/main/Src/main.js' */
function normEntry(entry) {
  return entry.replace(/^[\\/]+/, '').replace(/\\/g, '/');
}

function loadAsar() {
  try {
    return require('@electron/asar');
  } catch {
    return null;
  }
}

console.log(`\n🔎 发布包内容校验`);
console.log(`   校验目录: ${UNPACKED}`);
console.log(`   校验时间: ${new Date().toLocaleString('zh-CN')}\n`);

if (!fs.existsSync(UNPACKED) || !fs.statSync(UNPACKED).isDirectory()) {
  console.error(`  ❌ 免安装目录不存在：${UNPACKED}`);
  console.error('     ↳ 处理建议：先执行 npm run package:dir（或 npm run package）产出 win-unpacked。');
  console.error('\n❌ 发布包内容校验失败（1 项不通过），已中止。\n');
  process.exit(1);
}

const productName = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).build.productName;
const appExe = path.join(UNPACKED, `${productName}.exe`);

assert('主程序 exe 存在且体积合理', () => {
  let size = 0;
  try {
    size = fs.statSync(appExe).size;
  } catch {
    return { ok: false, reason: `${path.relative(ROOT, appExe)} 不存在`, hint: '重跑打包；若 electron-builder 报错请看其日志而不是取用旧产物' };
  }
  if (size < MIN_EXE_BYTES) {
    return { ok: false, reason: `仅 ${(size / 1024 / 1024).toFixed(1)} MB（下限 ${(MIN_EXE_BYTES / 1024 / 1024).toFixed(0)} MB）`, hint: 'Electron 运行时未被正确放入，重跑打包' };
  }
  return { ok: true, detail: `${(size / 1024 / 1024).toFixed(1)} MB` };
});

const asarPath = path.join(UNPACKED, 'resources', 'app.asar');
const asar = loadAsar();

assert('asar 可读', () => {
  if (!fs.existsSync(asarPath)) {
    return { ok: false, reason: 'resources/app.asar 不存在', hint: '重跑打包（build.asar=true 时应产出该文件）' };
  }
  if (!asar) {
    return { ok: false, reason: '无法解析 @electron/asar，无法读取包内容', hint: 'npm install 后重试；不要跳过本项校验' };
  }
  return { ok: true, detail: `${(fs.statSync(asarPath).size / 1024 / 1024).toFixed(1)} MB` };
});

/** asar 条目清单（读不到时返回 null，后续检查各自 fail-closed） */
let entries = null;
if (asar && fs.existsSync(asarPath)) {
  entries = asar.listPackage(asarPath).map(normEntry);
}

assert('asar 内含主进程/后端入口', () => {
  if (!entries) return { ok: false, reason: 'asar 条目未取到，无法判定', hint: '先让上面的「asar 可读」通过' };
  const missing = REQUIRED_ENTRIES.filter((rel) => !entries.includes(rel));
  if (missing.length > 0) {
    return { ok: false, reason: `缺少 ${missing.length} 个入口：${missing.join('、')}`, hint: 'electron-builder 不会因为入口缺失而报错，必须在 dist/ 侧修：npm run build:all' };
  }
  return { ok: true, detail: `${REQUIRED_ENTRIES.length} 个入口齐全` };
});

assert('asar 内入口引用的 renderer 资源齐全', () => {
  if (!entries) return { ok: false, reason: 'asar 条目未取到，无法判定', hint: '先让上面的「asar 可读」通过' };
  if (!entries.includes('dist/renderer/index.html')) {
    return { ok: false, reason: 'dist/renderer/index.html 不在包内', hint: 'npm run build:client 后重打' };
  }
  let html = '';
  try {
    // @electron/asar 按 path.sep 拆分路径，Windows 上必须用反斜杠形式
    html = asar.extractFile(asarPath, path.join('dist', 'renderer', 'index.html')).toString('utf8');
  } catch (err) {
    return { ok: false, reason: `无法读取包内 index.html：${err instanceof Error ? err.message : String(err)}`, hint: 'asar 结构异常，重打' };
  }
  const refs = [...html.matchAll(/(?:src|href)=["'](\/?\.?\/assets\/[^"']+?)["']/g)]
    .map((m) => m[1].replace(/^\.?\//, ''))
    .map((rel) => `dist/renderer/${rel}`);
  if (refs.length === 0) {
    return { ok: false, reason: '包内 index.html 没有引用任何 ./assets/* 资源（入口被截断或产物形态不符）', hint: 'npm run build:client 后重打' };
  }
  const missing = refs.filter((rel) => !entries.includes(rel));
  if (missing.length > 0) {
    return { ok: false, reason: `引用的 ${refs.length} 个资源有 ${missing.length} 个不在包内：${missing.slice(0, 5).join('、')}`, hint: 'renderer 产物与 index.html 不一致，删除 dist/renderer 后重跑 npm run build:client 再重打' };
  }
  return { ok: true, detail: `${refs.length} 个资源` };
});

assert('asar 内不含 .map 源码映射', () => {
  if (!entries) return { ok: false, reason: 'asar 条目未取到，无法判定', hint: '先让上面的「asar 可读」通过' };
  const maps = entries.filter((e) => e.toLowerCase().endsWith('.map'));
  if (maps.length > 0) {
    return { ok: false, reason: `夹带 ${maps.length} 个源码映射（sourcesContent 即原始 TS 全文），例如 ${maps[0]}`, hint: '确认 Client/vite.config.ts 的 build.sourcemap 只在非 production 为 true，且 package.json files 保留 !**/*.map' };
  }
  return { ok: true };
});

assert('包内不含凭据/私钥泄漏面', () => {
  if (!entries) return { ok: false, reason: 'asar 条目未取到，无法判定', hint: '先让上面的「asar 可读」通过' };
  const hits = [];
  for (const entry of entries) {
    const rule = LEAK_PATTERNS.find((r) => r.re.test(entry));
    if (rule) hits.push(`${entry} [${rule.why}]`);
  }
  // extraResources 是明文目录（resources/app/**），不在 asar 里，需单独扫
  const plainRoot = path.join(UNPACKED, 'resources', 'app');
  if (fs.existsSync(plainRoot)) {
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) walk(abs);
        else {
          const rel = path.relative(plainRoot, abs).replace(/\\/g, '/');
          const rule = LEAK_PATTERNS.find((r) => r.re.test(rel));
          if (rule) hits.push(`resources/app/${rel} [${rule.why}]`);
        }
      }
    };
    walk(plainRoot);
  }
  if (hits.length > 0) {
    return { ok: false, reason: `发现 ${hits.length} 处泄漏面：${hits.slice(0, 5).join('、')}`, hint: '在 package.json 的 build.files 与 extraResources.filter 里排除（!Configs/local.json、!.env*、!**/*.pfx 等），或删掉本机文件后重打' };
  }
  return { ok: true, detail: 'asar + resources/app 全扫描' };
});

assert('原生模块已解包（app.asar.unpacked 内含 .node binding）', () => {
  const unpackedDir = path.join(UNPACKED, 'resources', 'app.asar.unpacked');
  if (!fs.existsSync(unpackedDir)) {
    return { ok: false, reason: 'resources/app.asar.unpacked 不存在', hint: 'better-sqlite3 等原生模块无法从 asar 内加载，检查 build.asarUnpack 配置' };
  }
  const stack = [unpackedDir];
  const nodes = [];
  while (stack.length > 0) {
    const cur = stack.pop();
    for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
      const abs = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(abs);
      else if (e.name.endsWith('.node')) nodes.push(abs);
    }
  }
  if (nodes.length === 0) {
    return { ok: false, reason: '解包目录里没有任何 .node 二进制绑定', hint: '检查 build.asarUnpack 是否仍包含 **/*.node 与 better-sqlite3' };
  }
  const hasSqlite = nodes.some((p) => /better-sqlite3/i.test(p));
  if (!hasSqlite) {
    return { ok: false, reason: `解包目录有 ${nodes.length} 个 .node，但没有 better-sqlite3 的绑定`, hint: 'npx @electron/rebuild 后重打（ABI 不匹配时 electron-builder 会跳过该模块）' };
  }
  return { ok: true, detail: `${nodes.length} 个 .node，含 better-sqlite3` };
});

assert('不产出未经配置的更新元数据', () => {
  const updateYml = path.join(UNPACKED, 'resources', 'app-update.yml');
  if (!fs.existsSync(updateYml)) return { ok: true };
  let text = '';
  try {
    text = fs.readFileSync(updateYml, 'utf8');
  } catch {
    /* 存在即失败，读不到内容也照样判失败 */
  }
  return {
    ok: false,
    reason: `resources/app-update.yml 存在，内容为：\n${text.trim().replace(/^/gm, '        ')}`,
    hint:
      '仓库没有发布通道，但 electron-builder 会从 git remote 推断 publish 配置，把个人仓库/个人证书主体写成更新元数据。\n' +
      '     请在 package.json 的 build 段设置 "publish": null（项目未使用 electron-updater），然后重打。',
  };
});

console.log('');
if (failures > 0) {
  console.error(`❌ 发布包内容校验失败（${failures} 项不通过），已中止。\n`);
  process.exit(1);
}
console.log('✅ 发布包内容校验通过\n');
