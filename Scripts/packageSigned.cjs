#!/usr/bin/env node
/**
 * 自签打包：读取本机自签证书配置 → 用 electron-builder 签名打包 → 校验签名。
 *
 * 用法：
 *   npm run package:signed                 # 默认打 NSIS 安装包（含应用/卸载器/安装包全链签名）
 *   npm run package:signed -- --all        # NSIS + 便携版
 *   npm run package:signed -- --skip-build --no-verify-sign
 *
 * 前置：先跑一次 `npm run sign:setup` 生成本机自签证书（产物在 .tmp\signing\）。
 *
 * 背景（为什么这样设计）：
 * - electron-builder 通过环境变量 `CSC_LINK` / `CSC_KEY_PASSWORD`（Windows 上也可用
 *   `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD`）读取签名证书；**签名配置不写进 package.json**，
 *   这样仓库里不会出现任何证书路径/密码，开发机不签名也能正常 `npm run package`。
 * - 一旦提供了证书，electron-builder 会**自动**签完这一整条链：
 *   应用本体 `CivitasAI.exe`、`resources/elevate.exe`、卸载器、以及 NSIS 安装包
 *   （实测日志里能看到对 `CivitasAI-Setup-*.exe` 与 `*.__uninstaller.exe` 的签名步骤），
 *   不需要我们手工分阶段处理——这是本地证书相对远程签名服务（SignPath）的最大优势。
 * - 子进程一律 `stdio: 'inherit'`：受限沙箱下用管道捕获子进程输出会 EPERM（见 package.cjs 注释）。
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.tmp', 'signing', 'signing.env.json');
const PASSTHROUGH = new Set(['--nsis', '--portable', '--dir', '--all', '--skip-build', '--no-verify', '--no-mirror']);

function fail(message, hint) {
  console.error(`\n❌ ${message}`);
  if (hint) console.error(`   ${hint}`);
  process.exit(1);
}

function readSigningEnv() {
  if (!fs.existsSync(ENV_PATH)) {
    fail(
      `未找到本机签名配置：${ENV_PATH}`,
      '先执行 npm run sign:setup 生成本机自签证书（产物在 .tmp\\signing\\，已被 .gitignore 忽略）。',
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(ENV_PATH, 'utf8'));
  } catch (e) {
    fail(`签名配置解析失败：${ENV_PATH}（${e.message}）`, '删除该文件后重跑 npm run sign:setup。');
  }
  if (!parsed.pfxPath || !fs.existsSync(parsed.pfxPath)) {
    fail(`证书文件不存在：${parsed.pfxPath || '(未配置)'}`, '重跑 npm run sign:setup（可加 -Force 重新生成）。');
  }
  if (!parsed.pfxPassword) {
    fail('签名配置里没有 pfxPassword。', '重跑 npm run sign:setup -PfxPassword <你的密码>。');
  }
  return parsed;
}

function run(command, args, env) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', env: env ?? process.env });
  return result.status ?? 1;
}

function main() {
  const argv = process.argv.slice(2);
  const forwarded = [];
  let verifySign = true;

  for (const arg of argv) {
    if (arg === '--no-verify-sign') {
      verifySign = false;
      continue;
    }
    if (!PASSTHROUGH.has(arg)) {
      fail(`无法识别的参数：${arg}`, '可用：--nsis --portable --dir --all --skip-build --no-verify --no-mirror --no-verify-sign');
    }
    forwarded.push(arg);
  }

  const signing = readSigningEnv();
  const env = {
    ...process.env,
    CSC_LINK: signing.pfxPath,
    CSC_KEY_PASSWORD: signing.pfxPassword,
    WIN_CSC_LINK: signing.pfxPath,
    WIN_CSC_KEY_PASSWORD: signing.pfxPassword,
  };

  // 本次打包目标 → 校验脚本的目标过滤（避免把上次遗留的旧产物算进来）
  const targets = forwarded.includes('--all') ? 'all'
    : forwarded.includes('--portable') ? 'portable'
    : forwarded.includes('--dir') ? 'dir'
    : 'nsis';

  console.log('=== Civitas AI · 自签打包 ===');
  console.log(`  证书    : ${signing.pfxPath}`);
  console.log(`  主体    : ${signing.subject}`);
  console.log(`  指纹    : ${signing.thumbprint}`);
  console.log(`  有效期至: ${signing.notAfter}`);
  console.log(`  信任状态: ${signing.trustedRoot ? '根证书已安装（本机可信）' : '根证书未安装（本机显示"未知发布者"）'}`);
  console.log('');

  // ① 走既有一键打包（构建 → 校验 → electron-builder；签名由环境变量驱动）
  const pkgArgs = ['Scripts/package.cjs', ...forwarded];
  const pkgStatus = run(process.execPath, pkgArgs, env);
  if (pkgStatus !== 0) {
    fail(`打包失败（退出码 ${pkgStatus}）`, '看上面的 electron-builder 输出；若报签名相关错误，检查证书与密码。');
  }

  // ② 校验签名（默认门禁：本次目标里存在未签名产物即失败）
  if (!verifySign) {
    console.log('\n⏭  已按 --no-verify-sign 跳过签名校验');
    return;
  }

  const verifyArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'Scripts', 'verifySign.ps1'), '-Require', '-Targets', targets];
  const status = runPowerShell(verifyArgs, env);
  if (status !== 0) {
    fail('签名校验未通过（见上方明细）', '若只是"链不受信任"，属自签预期；可用 npm run sign:verify 单独查看，或安装根证书（见 sign:setup）。');
  }

  console.log('\n✅ 自签打包完成：产物已签名（应用 / 卸载器 / 安装包全链）。');
  console.log('   安装后若本机仍提示"未知发布者"，把 .tmp\\signing\\CivitasAI-selfsigned.cer 导入受信任根即可。');
}

/**
 * 运行 PowerShell 校验脚本。
 *
 * 注意：**只有找不到可执行文件（ENOENT）才回退** —— 早期实现把"校验未通过（非零退出）"
 * 也当成"没找到 pwsh"，于是又用 Windows PowerShell 5.1 跑了一遍 UTF-8 无 BOM 的脚本，
 * 触发中文乱码 + 语法错误，把真实结论淹没了。
 */
function runPowerShell(args, env) {
  const candidates = [process.env.PWSH_PATH || 'pwsh', 'powershell'];
  for (const bin of candidates) {
    const result = spawnSync(bin, args, { cwd: ROOT, stdio: 'inherit', env });
    if (result.error && result.error.code === 'ENOENT') {
      console.log(`(未找到 ${bin}，尝试下一个 PowerShell)`);
      continue;
    }
    return result.status ?? 1;
  }
  fail('找不到 PowerShell（pwsh / powershell）。', '本流程依赖 PowerShell 做签名校验；Windows 10/11 自带 powershell.exe。');
  return 1;
}

main();
