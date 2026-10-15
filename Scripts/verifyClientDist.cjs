/**
 * 构建产物校验（FE-016 / REV-291 / REV-294）
 *
 * 背景：2026-10-01 曾观察到 dist/renderer/index.html 为 1 字节（正常约 1.2KB）。
 * 全仓检索无其它写入方，根因最可能是构建被中断 / 并发构建竞争 emptyOutDir，
 * 留下半写文件且无任何报错——随后 electron 打包会把坏产物静默带入发布包。
 *
 * 本脚本作为 build:client 的收尾门禁：每个检查项即时打印自己的结论（通过才打 ✅），
 * 任一失败即在末尾以非 0 退出，让问题在构建期显式暴露，
 * 而不是以"打包后白屏"的形态出现在用户侧。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const RENDERER_DIR = path.join(ROOT, 'dist', 'renderer');
const INDEX_PATH = path.join(RENDERER_DIR, 'index.html');
/** 正常入口约 1.2KB；低于 100 字节视为半写/异常产物 */
const MIN_BYTES = 100;

/** 递归列出目录下所有以 suffix 结尾的文件（绝对路径） */
function findFiles(dir, suffix, acc = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) findFiles(abs, suffix, acc);
    else if (entry.name.toLowerCase().endsWith(suffix)) acc.push(abs);
  }
  return acc;
}

let failures = 0;

/** 一项检查：pass 打 ✅，fail 打 ❌ + 可操作建议，并累计失败数 */
function assert(name, passFn) {
  const result = passFn();
  if (result.ok) {
    console.log(`✅ ${name}${result.detail ? `（${result.detail}）` : ''}`);
    return true;
  }
  failures++;
  console.error(`❌ ${name} — ${result.reason}`);
  if (result.hint) console.error(`   ↳ 处理建议：${result.hint}`);
  return false;
}

const BUILD_HINT = '请重跑 npm run build:client（若反复出现，检查构建是否被中断或并发竞争 emptyOutDir）。';

let html = '';

assert('renderer 入口存在且非半写', () => {
  let size = 0;
  try {
    size = fs.statSync(INDEX_PATH).size;
  } catch (err) {
    return { ok: false, reason: `缺少 dist/renderer/index.html：${err instanceof Error ? err.message : String(err)}`, hint: BUILD_HINT };
  }
  if (size < MIN_BYTES) {
    return { ok: false, reason: `index.html 仅 ${size} 字节（下限 ${MIN_BYTES}）`, hint: BUILD_HINT };
  }
  try {
    html = fs.readFileSync(INDEX_PATH, 'utf8');
  } catch (err) {
    return { ok: false, reason: `index.html 无法读取：${err instanceof Error ? err.message : String(err)}`, hint: BUILD_HINT };
  }
  return { ok: true, detail: `${size} 字节` };
});

// ── REV-294：入口引用的资源必须逐个存在 ──────────────────────────────
// 只量 index.html 的字节数拦不住"半写产物"：入口正常但 chunk 缺失/为空时，
// 用户侧症状是点开白屏且控制台 404，而门禁照样放行。
assert('入口引用的资源逐个存在且非空', () => {
  const refs = [...html.matchAll(/(?:src|href)=["'](\/?\.?\/assets\/[^"']+?)["']/g)].map((m) => m[1]);
  if (refs.length === 0) {
    return {
      ok: false,
      reason: 'index.html 没有引用任何 ./assets/* 资源——产物形态不符预期或入口被截断',
      hint: BUILD_HINT,
    };
  }
  const missing = [];
  const empty = [];
  for (const ref of refs) {
    const rel = ref.replace(/^\.?\//, '');
    const abs = path.join(RENDERER_DIR, rel);
    let stat = null;
    try {
      stat = fs.statSync(abs);
    } catch {
      stat = null;
    }
    if (!stat || !stat.isFile()) missing.push(rel);
    else if (stat.size === 0) empty.push(rel);
  }
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `引用了 ${refs.length} 个资源，其中 ${missing.length} 个不存在：${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ' …' : ''}`,
      hint: BUILD_HINT,
    };
  }
  if (empty.length > 0) {
    return {
      ok: false,
      reason: `引用了 ${refs.length} 个资源，其中 ${empty.length} 个为 0 字节：${empty.slice(0, 5).join(', ')}${empty.length > 5 ? ' …' : ''}`,
      hint: BUILD_HINT,
    };
  }
  return { ok: true, detail: `${refs.length} 个` };
});

// ── REV-291：生产产物不得夹带源码映射 ────────────────────────────────
// 服务端已拒发 .map，但"运行时拒绝读取"与"产物里根本没有"是两件事：
// 后者才防得住整包外带（dist/renderer 会被直接拷走或托管）。
assert('产物不含 .map 源码映射', () => {
  const maps = findFiles(RENDERER_DIR, '.map');
  if (maps.length > 0) {
    return {
      ok: false,
      reason:
        `夹带 ${maps.length} 个源码映射（.map 内的 sourcesContent 就是原始 TS 全文），例如 ` +
        `${path.relative(ROOT, maps[0])}`,
      hint:
        '确认 Client/vite.config.ts 的 build.sourcemap 只在非 production 为 true，' +
        '再清理 dist/renderer 并重跑 npm run build:client。',
    };
  }
  return { ok: true };
});

if (failures > 0) {
  console.error(`\n❌ renderer 产物校验失败（${failures} 项不通过），已中止。`);
  process.exit(1);
}

console.log('\n✅ renderer 产物校验通过');
