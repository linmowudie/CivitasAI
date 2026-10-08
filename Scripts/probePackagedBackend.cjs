#!/usr/bin/env node
/**
 * 打包态后端探针：以"安装模式 + 干净数据根"启动打包产物，逐个打真实 API，
 * 收集每个端点的 HTTP 状态与响应摘要，最后打印后端日志里的 ERROR/WARN。
 *
 * 目的：把"打包后才暴露"的后端问题（asar 内读不到资源、原生模块 ABI、写只读目录、
 * cwd 相关路径、迁移/种子失败）用真实运行证据抓出来，而不是靠读代码猜。
 *
 * 用法：node .tmp/probe-packaged-backend.cjs [端口]
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.argv[2] ?? 39301);
const SANDBOX = path.join(ROOT, '.tmp', 'probe-run');
const DATA = path.join(SANDBOX, 'data');
const WS = path.join(SANDBOX, 'Workspace');
const EXE = path.join(ROOT, 'release', 'win-unpacked', 'CivitasAI.exe');

const GETS = [
  '/api/configs',
  '/api/models',
  '/api/sessions',
  '/api/tasks',
  '/api/todos',
  '/api/skills',
  '/api/memory/entries',
  '/api/memory/long-term',
  '/api/tokens/overview',
  '/api/tokens/transactions',
  '/api/loops/dashboard',
  '/api/audit/status',
  '/api/audit/reports',
  '/api/governance/records',
  '/api/governance/summary',
  '/api/regulation/behavior-code',
  '/api/regulation/emergencies',
  '/api/agents',
  '/api/approvals',
  '/api/arbitration/interventions',
  '/api/a2a/inbox',
  '/api/a2a/messages',
  '/api/mcp/connections',
  '/api/data-hub',
  '/api/sync/stats-events',
  '/api/account/active-user',
];

const SUMMARIZE = (text) => {
  try {
    const body = JSON.parse(text);
    const data = body && typeof body === 'object' && 'data' in body ? body.data : body;
    if (Array.isArray(data)) return `array(${data.length})`;
    if (data && typeof data === 'object') {
      const keys = Object.keys(data);
      return `object{${keys.slice(0, 6).join(',')}${keys.length > 6 ? ',…' : ''}}`;
    }
    return typeof data;
  } catch {
    return `text(${text.slice(0, 60).replace(/\s+/g, ' ')})`;
  }
};

function cleanup() {
  if (fs.existsSync(SANDBOX)) {
    // 只删自己创建的沙箱目录
    if (SANDBOX.startsWith(path.join(ROOT, '.tmp'))) fs.rmSync(SANDBOX, { recursive: true, force: true });
  }
}

async function main() {
  cleanup();
  fs.mkdirSync(path.join(DATA, 'Configs'), { recursive: true });
  fs.mkdirSync(WS, { recursive: true });
  fs.writeFileSync(path.join(DATA, 'Configs', 'local.json'), JSON.stringify({ server: { httpPort: PORT, host: '127.0.0.1' } }), 'utf8');
  // 把引导状态置为"已跳过"：让应用直接进入主界面——这正是用户报"全黑"时所在的状态
  // （引导向导本身是全屏浮层，不经过内层路由，因此掩盖了路由兜底缺失的问题）。
  fs.mkdirSync(path.join(DATA, '.state'), { recursive: true });
  fs.writeFileSync(
    path.join(DATA, '.state', 'onboarding.json'),
    JSON.stringify({ completed: false, skipped: true, version: '1' }),
    'utf8',
  );

  if (!fs.existsSync(EXE)) {
    console.error(`❌ 找不到打包产物：${EXE}（先跑 npm run package:dir）`);
    process.exit(1);
  }

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;   // 否则 Electron 退化为纯 Node，主进程不启动
  env.CIVITAS_INSTALLED = '1';
  env.CIVITAS_DATA_ROOT = DATA;
  env.CIVITAS_WORKSPACE_ROOT = WS;
  // 让主进程在渲染完成后 dump 页面 DOM 结构（见 electron/main.ts 的 CIVITAS_UI_DEBUG 分支）
  env.CIVITAS_UI_DEBUG = '1';

  const child = spawn(EXE, ['--no-sandbox'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });

  // 等后端起来
  const deadline = Date.now() + 90_000;
  let up = false;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/configs`);
      if (res.ok) { up = true; break; }
    } catch { /* 还没起来 */ }
  }

  if (!up) {
    console.log('❌ 后端未在 90s 内就绪');
    console.log(out.split('\n').slice(-40).join('\n'));
    child.kill();
    process.exit(1);
  }
  console.log(`✅ 后端已就绪（HTTP:${PORT}，安装模式，数据根=${DATA}）\n`);

  console.log('=== 端点探测 ===');
  const failures = [];
  for (const p of GETS) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}${p}`);
      const text = await res.text();
      const flag = res.status >= 500 ? '❌' : res.status >= 400 ? '⚠️ ' : '✅';
      console.log(`${flag} ${String(res.status).padEnd(4)} ${p.padEnd(34)} ${SUMMARIZE(text)}`);
      if (res.status >= 500) failures.push(`${p} → ${res.status} ${text.slice(0, 200)}`);
    } catch (e) {
      console.log(`❌ ---- ${p.padEnd(34)} 请求异常：${e.message}`);
      failures.push(`${p} → ${e.message}`);
    }
  }

  // 写操作：创建一个会话，验证 DB 可写 + 迁移正常
  console.log('\n=== 写路径探测（DB 可写性 / 迁移）===');
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '打包态探针会话' }),
    });
    const text = await res.text();
    console.log(`${res.status < 300 ? '✅' : '❌'} POST /api/sessions → ${res.status} ${SUMMARIZE(text)}`);
    if (res.status >= 400) failures.push(`POST /api/sessions → ${res.status} ${text.slice(0, 200)}`);
  } catch (e) {
    console.log(`❌ POST /api/sessions 异常：${e.message}`);
    failures.push(`POST /api/sessions → ${e.message}`);
  }

  // 落盘证据
  console.log('\n=== 数据根落盘 ===');
  const walk = (dir, depth = 0, acc = []) => {
    if (depth > 1) return acc;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      acc.push(`${' '.repeat(depth * 2)}${entry.isDirectory() ? '[D]' : '[F]'} ${entry.name}`);
      if (entry.isDirectory()) walk(path.join(dir, entry.name), depth + 1, acc);
    }
    return acc;
  };
  console.log(walk(DATA).join('\n'));

  const dbCandidates = [];
  const findDb = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) findDb(full);
      else if (entry.name.endsWith('.db') || entry.name.endsWith('.sqlite') || entry.name.endsWith('.sqlite3')) {
        dbCandidates.push(`${path.relative(DATA, full)} (${fs.statSync(full).size} B)`);
      }
    }
  };
  findDb(DATA);
  console.log(`\n数据库文件：${dbCandidates.length ? dbCandidates.join('、') : '❌ 未创建'}`);

  console.log('\n=== 后端日志中的 ERROR / WARN ===');
  const noisy = out.split('\n').filter((l) => /ERROR|WARN|Error:|error:|失败|异常|ENOENT|EPERM/.test(l));
  console.log(noisy.length ? noisy.slice(0, 40).join('\n') : '（无）');

  // ── 打包态 UI 冒烟（白屏守卫）────────────────────────────────────
  // 背景（2026-10-07）：`file://…/index.html` 入口下内层路由缺通配兜底，主界面渲染为空白，
  // 而**后端完全正常、渲染进程也不报错**——只有读 DOM 才能发现。这里把它变成硬断言。
  console.log('\n=== 打包态 UI 结构（读渲染进程 DOM）===');
  // 主进程在 did-finish-load 后 6s dump，这里最多等 30s（避免误判为"没触发"）
  const uiDeadline = Date.now() + 30_000;
  while (Date.now() < uiDeadline && !out.includes('[Electron][ui-debug]')) {
    await new Promise((r) => setTimeout(r, 500));
  }
  const uiLine = out.split('\n').find((l) => l.includes('[Electron][ui-debug]'));
  if (!uiLine) {
    failures.push('UI 冒烟：未拿到 [Electron][ui-debug] 输出（主进程 UI 探针未触发）');
    console.log('❌ 未拿到 UI 结构输出');
  } else {
    let ui = null;
    try {
      ui = JSON.parse(uiLine.slice(uiLine.indexOf('{')));
    } catch (e) {
      failures.push(`UI 冒烟：解析 DOM 输出失败（${e.message}）`);
    }
    if (ui) {
      const text = String(ui.visibleText ?? '');
      console.log(`  root 子节点数: ${ui.rootChildren}   root 尺寸: ${ui.root?.w}x${ui.root?.h}   body: ${ui.body?.w}x${ui.body?.h}`);
      console.log(`  可见文字(${text.length} 字): ${text.slice(0, 120)}${text.length > 120 ? '…' : ''}`);
      if (ui.errors?.length) console.log(`  渲染进程记录的错误: ${JSON.stringify(ui.errors).slice(0, 200)}`);

      // 断言 1：已跳过引导 → 必须是"标题栏 + 主界面"两棵子树
      if (!(ui.rootChildren >= 2)) {
        failures.push(`UI 冒烟：root 只有 ${ui.rootChildren} 个子节点（标题栏在、主界面没渲染 → 白屏回归）`);
      }
      // 断言 2：必须有成规模的可见文字（白屏/空卡片时只有标题栏那几个字）
      if (text.length < 40) {
        failures.push(`UI 冒烟：可见文字仅 ${text.length} 字，主界面疑似白屏：「${text}」`);
      }
      // 断言 3：必须能看到主界面标志性文案（左栏导航 + 主容器内容）
      if (!/新任务|功能|人工审批/.test(text)) {
        failures.push(`UI 冒烟：未见主界面标志性文案（可能落到了空路由）：「${text.slice(0, 80)}」`);
      }
      // 断言 4：不能是渲染异常兜底页
      if (/界面渲染出错了/.test(text)) {
        failures.push('UI 冒烟：命中了 ErrorBoundary 兜底页（前端渲染异常）');
      }
    }
  }

  console.log('\n=== 结论 ===');
  if (failures.length === 0 && dbCandidates.length > 0) {
    console.log('✅ 打包态：所有探测端点正常，数据库已创建并写入，UI 结构正常（非白屏）');
  } else {
    console.log(`❌ 发现 ${failures.length} 处问题：`);
    for (const f of failures) console.log(`   - ${f}`);
  }

  child.kill();
  await new Promise((r) => setTimeout(r, 1500));
  process.exit(failures.length === 0 ? 0 : 2);
}

main().catch((e) => {
  console.error('探针自身异常：', e);
  process.exit(3);
});
