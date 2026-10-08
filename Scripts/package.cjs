#!/usr/bin/env node
/**
 * Civitas-AI 一键打包编排脚本
 *
 * 目标：把"构建 → 校验 → 打包 → 产物核验（路径/体积/SHA256）"串成一条命令，
 * 让任何人在干净的工作区里执行 `npm run package` 就能拿到可分发的 Windows 安装包。
 *
 * 用法：
 *   node Scripts/package.cjs [--nsis|--portable|--dir|--all] [--skip-build] [--no-verify] [--check]
 *
 *   --nsis        只打 NSIS 安装包（默认）→ release/CivitasAI-Setup-<version>.exe
 *   --portable    只打便携版单文件     → release/CivitasAI-Portable.exe
 *   --dir         只展开免安装目录     → release/win-unpacked/（调试用，不出 exe 安装包）
 *   --all         同时打 NSIS + 便携版
 *   --skip-build  跳过 ②③ 构建步骤（假定 dist/ 已是最新）
 *   --no-verify   跳过 ④ 产物校验器（不推荐；仅在你已单独跑过校验时使用）
 *   --check       只做打包前预检（① + ④），不构建、不打包
 *   --no-mirror   不注入国内镜像，完全按 electron-builder / @electron/get 默认源下载
 *   -h, --help    显示帮助
 *
 * 关于镜像：electron-builder 首次打包要从 GitHub Releases 下载 Electron 运行时 zip 与
 * NSIS 资源（约 100MB+）。部分网络环境下 github.com 的 release 下载会 connect ETIMEDOUT，
 * 而 npmmirror 的同一份二进制可正常访问。因此脚本默认注入下面两个镜像环境变量
 * （**仅在该变量尚未被外部设置时**），可用 --no-mirror 关闭，或用环境变量自行覆盖：
 *   ELECTRON_MIRROR                     = https://npmmirror.com/mirrors/electron/
 *   ELECTRON_BUILDER_BINARIES_MIRROR    = https://npmmirror.com/mirrors/electron-builder-binaries/
 *
 * 注意（Windows/PowerShell 沙箱）：子进程一律用 spawnSync(..., { stdio: 'inherit' })，
 * 不通过管道捕获子进程输出——管道在受限沙箱下会 EPERM。electron-builder 直接以
 * node + node_modules/electron-builder/cli.js 方式拉起（等价于 npx electron-builder），
 * 避免 Windows 上 .cmd 包装脚本无法直接 spawn 的问题。
 *
 * 退出码：全部成功 = 0；任一步失败 = 1（并打印可操作的修复建议）。
 */

const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const RELEASE_DIR = path.join(ROOT, 'release');
/** 安装包体积下限：Electron 运行时自带 Chromium，正常产物远大于 50MB，低于此值基本可以断定是坏包 */
const MIN_ARTIFACT_BYTES = 50 * 1024 * 1024;
const HASH_CHUNK = 1024 * 1024;

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version;

/**
 * 默认注入的下载镜像（仅在外部未设置同名环境变量时生效）。
 * 背景：electron-builder 首次打包需要从 GitHub Releases 拉 Electron 运行时 zip 与 NSIS 资源，
 * 在部分网络下会 connect ETIMEDOUT；npmmirror 托管了同样的二进制，可显著提升成功率。
 */
const DEFAULT_MIRRORS = {
  ELECTRON_MIRROR: 'https://npmmirror.com/mirrors/electron/',
  ELECTRON_BUILDER_BINARIES_MIRROR: 'https://npmmirror.com/mirrors/electron-builder-binaries/',
};

// ===== 目标定义：CLI 目标名 → electron-builder 目标 + 期望产物 =====
const TARGETS = {
  nsis: {
    label: 'NSIS 安装包',
    builderTargets: ['nsis'],
    artifacts: [{ rel: `CivitasAI-Setup-${VERSION}.exe`, kind: 'file' }],
  },
  portable: {
    label: '便携版单文件',
    builderTargets: ['portable'],
    artifacts: [{ rel: 'CivitasAI-Portable.exe', kind: 'file' }],
  },
  dir: {
    label: '免安装目录（win-unpacked）',
    builderTargets: ['dir'],
    artifacts: [{ rel: 'win-unpacked', kind: 'dir' }],
  },
};

// ===== 小工具 =====
const log = (msg = '') => console.log(msg);
const ok = (msg) => console.log(`  ✅ ${msg}`);
const warn = (msg) => console.log(`  ⚠️  ${msg}`);
const bad = (msg) => console.log(`  ❌ ${msg}`);
const step = (n, msg) => {
  log('');
  log('─'.repeat(64));
  log(`【${n}】${msg}`);
  log('─'.repeat(64));
};

function formatMB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}

/** 分块计算 SHA256，避免把上百 MB 的安装包整体读进内存 */
function sha256File(absPath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(absPath, 'r');
  try {
    const buf = Buffer.allocUnsafe(HASH_CHUNK);
    let read = 0;
    while ((read = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function dirSize(absDir) {
  let total = 0;
  const stack = [absDir];
  while (stack.length > 0) {
    const cur = stack.pop();
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      const abs = path.join(cur, entry.name);
      if (entry.isDirectory()) stack.push(abs);
      else if (entry.isFile()) total += fs.statSync(abs).size;
    }
  }
  return total;
}

/**
 * 运行子进程并继承 stdio。
 * Windows 下 npm 是 npm.cmd，Node 20+ 不允许直接 spawn .cmd（EINVAL），
 * 因此 win32 走 shell:true（命令与参数拼成一行，参数都是本脚本内的常量，无注入面）。
 */
function run(command, args, label) {
  log(`\n$ ${[command, ...args].join(' ')}`);
  const isWin = process.platform === 'win32';
  const result = spawnSync(
    isWin ? [command, ...args].join(' ') : command,
    isWin ? [] : args,
    { stdio: 'inherit', cwd: ROOT, shell: isWin, env: process.env },
  );
  if (result.error) {
    bad(`${label}启动失败：${result.error.message}`);
    return false;
  }
  if (result.status !== 0) {
    bad(`${label}失败（退出码 ${result.status}）`);
    return false;
  }
  ok(`${label}完成`);
  return true;
}

function resolveElectronBuilderCli() {
  const cli = path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js');
  return fs.existsSync(cli) ? cli : null;
}

// ===== CLI 解析 =====
function parseArgs(argv) {
  const opts = { targets: [], skipBuild: false, noVerify: false, check: false, noMirror: false, help: false };
  const unknown = [];
  for (const arg of argv) {
    switch (arg) {
      case '--nsis':
        opts.targets.push('nsis');
        break;
      case '--portable':
        opts.targets.push('portable');
        break;
      case '--dir':
        opts.targets.push('dir');
        break;
      case '--all':
        opts.targets.push('nsis', 'portable');
        break;
      case '--skip-build':
        opts.skipBuild = true;
        break;
      case '--no-verify':
        opts.noVerify = true;
        break;
      case '--check':
        opts.check = true;
        break;
      case '--no-mirror':
        opts.noMirror = true;
        break;
      case '-h':
      case '--help':
        opts.help = true;
        break;
      default:
        unknown.push(arg);
    }
  }
  opts.targets = [...new Set(opts.targets)];
  if (opts.targets.length === 0) opts.targets = ['nsis']; // 默认打 NSIS 安装包
  return { opts, unknown };
}

function printHelp() {
  log(`
Civitas-AI 一键打包脚本

用法：
  node Scripts/package.cjs [--nsis|--portable|--dir|--all] [--skip-build] [--no-verify] [--check]

选项：
  --nsis        只打 NSIS 安装包（默认）→ release/CivitasAI-Setup-${VERSION}.exe
  --portable    只打便携版单文件        → release/CivitasAI-Portable.exe
  --dir         只展开免安装目录        → release/win-unpacked/
  --all         同时打 NSIS + 便携版
  --skip-build  跳过构建（假定 dist/ 已是最新）
  --no-verify   跳过产物校验器 Scripts/verifyPackage.cjs
  --check       只做预检（① + ④），不构建不打包
  --no-mirror   不注入 npmmirror 镜像，按默认源（GitHub Releases）下载

等价 npm 脚本：
  npm run package             # 默认 NSIS
  npm run package:nsis
  npm run package:portable
  npm run package:dir
  npm run package:check
`);
}

// ===== ① 预检 =====
/**
 * 注入下载镜像：只填外部未设置的变量，外部显式设置（CI/代理/自建镜像）优先。
 * 返回已生效的镜像列表，供预检打印。
 */
function applyMirrors(disabled) {
  if (disabled) return [];
  const applied = [];
  for (const [key, value] of Object.entries(DEFAULT_MIRRORS)) {
    if (!process.env[key]) {
      process.env[key] = value;
      applied.push(`${key}=${value}`);
    }
  }
  return applied;
}

function precheck(targetNames, noMirror) {
  log('   打包配置：');
  log(`     productName : ${pkg.build.productName}    version: ${VERSION}`);
  log(`     输出目录    : ${RELEASE_DIR}`);
  log(`     目标        : ${targetNames.map((t) => TARGETS[t].label).join(' + ')}`);
  log(`     产物        : ${targetNames
    .flatMap((t) => TARGETS[t].artifacts.map((a) => a.rel))
    .join(', ')}\n`);

  const problems = [];

  // 0) 下载镜像（GitHub Release 不可达时的默认兜底）
  const mirrors = applyMirrors(noMirror);
  if (noMirror) {
    warn('已按 --no-mirror 关闭镜像注入，将由 electron-builder 自行从官方源下载（GitHub 不可达时会超时）');
  } else if (mirrors.length > 0) {
    ok(`已注入下载镜像 ${mirrors.length} 个（可用 --no-mirror 关闭）：${mirrors.join(' , ')}`);
  } else {
    ok('检测到外部已设置下载镜像环境变量，沿用外部配置');
  }

  // 1) Node 版本
  const major = Number(process.versions.node.split('.')[0]);
  const engineRange = (pkg.engines && pkg.engines.node) || '>=20';
  // 形如 ">=20.0.0" / "^20.11.0"：只取第一段数字作为主版本下限
  const requiredMajor = Number((engineRange.match(/\d+/) || ['20'])[0]);
  if (major >= requiredMajor) {
    ok(`Node 版本 ${process.versions.node}（要求 >= ${requiredMajor}）`);
  } else {
    bad(`Node 版本过低：${process.versions.node}（要求 >= ${requiredMajor}）`);
    problems.push('升级 Node.js 到 20 或更高版本后重试');
  }

  // 2) 图标资产
  for (const icon of ['assets/icon.ico', 'assets/icon.png']) {
    const abs = path.join(ROOT, icon);
    try {
      const size = fs.statSync(abs).size;
      if (size > 0) ok(`图标就绪：${icon}（${size} 字节）`);
      else throw new Error('空文件');
    } catch {
      bad(`缺少图标：${icon}`);
      problems.push(`运行 python Scripts/genIcons.py 生成图标（${icon} 缺失或为空）`);
    }
  }

  // 3) electron-builder 可解析
  const ebPkgPath = path.join(ROOT, 'node_modules', 'electron-builder', 'package.json');
  const ebCli = resolveElectronBuilderCli();
  if (fs.existsSync(ebPkgPath) && ebCli) {
    const ebVersion = JSON.parse(fs.readFileSync(ebPkgPath, 'utf8')).version;
    ok(`electron-builder 可解析：v${ebVersion}`);
  } else {
    bad('electron-builder 不可解析（node_modules/electron-builder/cli.js 不存在）');
    problems.push('运行 npm install 安装依赖后重试');
  }

  // 4) 必需文件/目录
  const required = [
    ['package.json', 'file'],
    ['Scripts/build.cjs', 'file'],
    ['Scripts/verifyPackage.cjs', 'file'],
    ['Src/main.ts', 'file'],
    ['electron/main.ts', 'file'],
    ['electron/preload.ts', 'file'],
    ['Client/vite.config.ts', 'file'],
    ['Configs', 'dir'],
    ['Prompts', 'dir'],
    ['Skills', 'dir'],
  ];
  const missing = [];
  for (const [rel, kind] of required) {
    const abs = path.join(ROOT, rel);
    const exists = fs.existsSync(abs) && (kind === 'file' ? fs.statSync(abs).isFile() : true);
    if (!exists) missing.push(rel);
  }
  if (missing.length === 0) {
    ok(`必需文件齐全（${required.length} 项）`);
  } else {
    bad(`缺少必需文件/目录：${missing.join('、')}`);
    problems.push('这些是打包输入，缺失说明工作区不完整（检查 git 状态或重新 clone）');
  }

  // 5) Electron 二进制（缺失不阻塞：electron-builder 会自动下载，但首次很慢）
  const electronExe = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  if (fs.existsSync(electronExe)) {
    ok(`Electron 运行时已就绪（${formatMB(fs.statSync(electronExe).size)}）`);
  } else {
    warn('node_modules/electron/dist/electron.exe 不存在，electron-builder 首次会自动下载（约 100MB+，可能较慢）');
  }

  return problems;
}

// ===== ⑥⑦ 产物核验 =====
function reportArtifacts(targetNames, startedAt) {
  const rows = [];
  const problems = [];

  for (const name of targetNames) {
    for (const artifact of TARGETS[name].artifacts) {
      const abs = path.join(RELEASE_DIR, artifact.rel);
      if (!fs.existsSync(abs)) {
        bad(`未找到期望产物：${artifact.rel}`);
        problems.push(`electron-builder 未产出 ${artifact.rel}，请检查上方日志中的报错`);
        continue;
      }

      const stat = fs.statSync(abs);
      const bytes = artifact.kind === 'dir' ? dirSize(abs) : stat.size;
      const isFresh = stat.mtimeMs >= startedAt - 5000;

      // 体积与 SHA256 必须来自同一份文件：中间若被改写（杀软/签名工具/并发打包），
      // 这里会显式告警，而不是打印一组自相矛盾的数字。
      let hash = null;
      let mutated = false;
      if (artifact.kind === 'file') {
        hash = sha256File(abs);
        const after = fs.statSync(abs);
        mutated = after.size !== stat.size || after.mtimeMs !== stat.mtimeMs;
      }

      log('');
      log(`  📦 ${TARGETS[name].label}${artifact.kind === 'dir' ? '（目录）' : ''}`);
      log(`     路径  : ${abs}`);
      log(`     体积  : ${bytes} 字节（${formatMB(bytes)}）`);
      if (hash) log(`     SHA256: ${hash}`);
      if (!isFresh) warn(`产物修改时间早于本次打包开始时间，可能是上一次的旧产物（请确认上方 electron-builder 是否真的重建）`);
      if (mutated) {
        warn('产物在核验期间被改写（体积/时间戳发生变化），上面打印的 SHA256 可能已失效，请重新核验');
        problems.push(`${artifact.rel} 在核验期间被外部进程改写，请确认杀毒/签名工具后重新打包`);
      }

      if (bytes < MIN_ARTIFACT_BYTES) {
        bad(`体积异常：${formatMB(bytes)} < 下限 ${formatMB(MIN_ARTIFACT_BYTES)}，产物很可能是坏包`);
        problems.push(`${artifact.rel} 体积不足，删除 release/ 后重跑打包`);
      } else {
        ok(`体积合理（>= ${formatMB(MIN_ARTIFACT_BYTES)}）`);
      }
      rows.push({ abs, bytes });
    }
  }

  return { rows, problems };
}

// ===== 主流程 =====
function main() {
  const startedAt = Date.now();
  const { opts, unknown } = parseArgs(process.argv.slice(2));

  if (opts.help) {
    printHelp();
    return 0;
  }
  if (unknown.length > 0) {
    bad(`无法识别的参数：${unknown.join(' ')}（用 --help 查看用法）`);
    return 1;
  }

  log('');
  log('╔══════════════════════════════════════════════════════════════╗');
  log('║        Civitas-AI 一键打包（构建 → 校验 → 打包 → 核验）      ║');
  log('╚══════════════════════════════════════════════════════════════╝');

  // ── ① 预检 ──
  step('1/7', `打包前预检（Node / 图标 / electron-builder / 必需文件）`);
  const precheckProblems = precheck(opts.targets, opts.noMirror);
  if (precheckProblems.length > 0) {
    log('');
    bad('预检未通过，已中止打包。修复建议：');
    for (const p of precheckProblems) log(`     · ${p}`);
    log('');
    return 1;
  }

  // ── --check：只做预检 + 现有产物校验，不构建不打包 ──
  if (opts.check) {
    if (!opts.noVerify) {
      step('2/7', '产物校验器（Scripts/verifyPackage.cjs，仅检查现有 dist/）');
      if (!run(process.execPath, [path.join(ROOT, 'Scripts', 'verifyPackage.cjs')], '产物校验')) {
        log('   提示：请先执行 npm run build:all 生成 dist/ 产物。');
        return 1;
      }
    }
    log('');
    log('✅ 仅预检模式（--check）：预检与产物校验均已通过，未执行构建与打包。');
    log(`   下一步：npm run package（默认 NSIS 安装包）\n`);
    return 0;
  }

  // ── ②③ 构建 ──
  if (opts.skipBuild) {
    step('2/7', '构建：已按 --skip-build 跳过（复用现有 dist/）');
  } else {
    step('2/7', '构建后端（npm run build:server）');
    if (!run('npm', ['run', 'build:server'], '后端构建')) return 1;

    step('3/7', '构建前端（npm run build:client）');
    if (!run('npm', ['run', 'build:client'], '前端构建')) return 1;
  }

  // ── ④ 产物校验（构建之后、打包之前；--no-verify 时跳过）──
  if (!opts.noVerify) {
    step('4/7', '产物校验器（Scripts/verifyPackage.cjs，打包前）');
    if (!run(process.execPath, [path.join(ROOT, 'Scripts', 'verifyPackage.cjs')], '产物校验')) {
      log('   提示：缺少打包输入意味着 electron-builder 会打出一个不可用的包，已中止。');
      return 1;
    }
  } else {
    warn('已按 --no-verify 跳过产物校验器（构建结果未被校验）');
  }

  // ── ⑤ electron-builder ──
  const builderTargets = [...new Set(opts.targets.flatMap((t) => TARGETS[t].builderTargets))];
  step('5/7', `electron-builder 打包（--win ${builderTargets.join(' ')}）`);
  const ebCli = resolveElectronBuilderCli();
  if (!ebCli) {
    bad('找不到 node_modules/electron-builder/cli.js，请先 npm install');
    return 1;
  }
  if (!run(process.execPath, [ebCli, '--win', ...builderTargets], 'electron-builder 打包')) {
    log('   常见原因与处理：');
    log('     · 网络不可达（connect ETIMEDOUT）→ 脚本已默认注入 npmmirror 镜像；若仍失败，');
    log('       请检查代理后重试，或用环境变量 ELECTRON_MIRROR / ELECTRON_BUILDER_BINARIES_MIRROR 指定可用镜像');
    log('     · 图标格式不合法 → 运行 python Scripts/genIcons.py 重新生成 assets/icon.ico');
    log('     · 原生模块（better-sqlite3）与 Electron ABI 不匹配 → npx @electron/rebuild');
    return 1;
  }

  // ── ⑥⑦ 产物核验 ──
  step('6/7', '产物核验（存在性 / 体积 / SHA256）');
  const { problems } = reportArtifacts(opts.targets, startedAt);

  if (!opts.noVerify) {
    step('7/7', '产物校验器（Scripts/verifyPackage.cjs，打包后复核）');
    if (!run(process.execPath, [path.join(ROOT, 'Scripts', 'verifyPackage.cjs'), '--stage=post'], '产物复核')) {
      return 1;
    }
  }

  log('');
  log('═'.repeat(64));
  if (problems.length > 0) {
    bad(`打包完成但核验未通过（${problems.length} 项）：`);
    for (const p of problems) log(`     · ${p}`);
    log('═'.repeat(64));
    return 1;
  }

  log(`✅ 打包成功（耗时 ${formatDuration(Date.now() - startedAt)}）`);
  log('═'.repeat(64));

  const setupArtifact = path.join(RELEASE_DIR, `CivitasAI-Setup-${VERSION}.exe`);
  if (opts.targets.includes('nsis') && fs.existsSync(setupArtifact)) {
    log('');
    log(`👉 下一步：把 CivitasAI-Setup-${VERSION}.exe 发给用户，双击安装即可（可通过安装向导自选安装目录）。`);
  } else {
    log('');
    log('👉 下一步：把 release/ 下的产物发给用户即可。');
  }
  log('');
  return 0;
}

process.exit(main());
