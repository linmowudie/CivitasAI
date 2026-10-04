/**
 * Qoder 进度监控（每 30 分钟一次）
 *
 * 逻辑：
 *  - 对关注目录做"路径|大小|mtime"快照 → sha256 指纹；
 *  - 与上次快照比较，把**新增/修改/删除的文件清单**写入日志（便于后续实证复核）；
 *  - **连续两次快照完全相同**（即 30 分钟内无任何变更）→ 判定 Qoder 已改完，正常退出；
 *  - 到达 MAX_ROUNDS 仍未稳定 → 超时退出（仍需人工确认）。
 *
 * 输出：`.verify/qoder-watch.log`（追加式，含每轮时间戳与变更清单）
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = 'F:/ProjectCode/CivitasAI';
const WATCH = [
  'Src',
  'Client/src',
  'Server/src',
  'Server/test',
  'Server/migrations',
  'electron',
  'Tests',
  'Configs',
  'Docs/Agent',
  'Docs/Dev',
];
const LOG = process.env['QW_LOG'] ? path.join(ROOT, process.env['QW_LOG']) : path.join(ROOT, '.verify/qoder-watch.log');
const INTERVAL_MS = Number(process.env['QW_INTERVAL_MS'] ?? 30 * 60 * 1000);
const MAX_ROUNDS = Number(process.env['QW_MAX_ROUNDS'] ?? 24); // 默认最多 12 小时

/** 递归收集文件（跳过噪声目录） */
function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (['node_modules', '.git', 'dist', '.verify', '__pycache__', '.tmp'].includes(e.name)) continue;
      walk(full, out);
    } else if (e.isFile()) {
      out.push(full);
    }
  }
  return out;
}

/** 快照：返回指纹 + "路径 → 大小/mtime" 映射 */
function snapshot() {
  const files = [];
  for (const w of WATCH) walk(path.join(ROOT, w), files);
  files.sort();
  const map = new Map();
  const lines = [];
  for (const f of files) {
    let st;
    try {
      st = fs.statSync(f);
    } catch {
      continue;
    }
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    map.set(rel, `${st.size}|${Math.round(st.mtimeMs)}`);
    lines.push(`${rel}|${st.size}|${Math.round(st.mtimeMs)}`);
  }
  const hash = createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16);
  return { hash, map, count: files.length };
}

/** 计算两次快照的差异（新增/修改/删除） */
function diff(prev, cur) {
  const added = [];
  const modified = [];
  const removed = [];
  for (const [k, v] of cur.map) {
    if (!prev.map.has(k)) added.push(k);
    else if (prev.map.get(k) !== v) modified.push(k);
  }
  for (const k of prev.map.keys()) if (!cur.map.has(k)) removed.push(k);
  return { added, modified, removed };
}

function log(line) {
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.appendFileSync(LOG, `${line}\n`, 'utf8');
}

const started = new Date().toISOString();
log(`\n=== Qoder 监控启动 ${started}（关注目录 ${WATCH.length} 个，轮询间隔 ${Math.round(INTERVAL_MS / 60000)} 分钟）===`);

let prev = snapshot();
log(`[基线] ${new Date().toISOString()} 指纹=${prev.hash} 文件数=${prev.count}`);
console.log(`[基线] 指纹=${prev.hash} 文件数=${prev.count}`);

let idleRounds = 0;
for (let round = 1; round <= MAX_ROUNDS; round++) {
  await new Promise((r) => setTimeout(r, INTERVAL_MS));
  const cur = snapshot();
  const d = diff(prev, cur);
  const changed = d.added.length + d.modified.length + d.removed.length;
  const ts = new Date().toISOString();

  if (changed === 0) {
    idleRounds++;
    log(`[第${round}轮] ${ts} 指纹=${cur.hash} **无变更**（连续 ${idleRounds} 次）`);
    console.log(`[第${round}轮] 无变更（连续 ${idleRounds} 次）`);
    if (idleRounds >= 1) {
      log(`[完成判定] ${ts} 连续 ${Math.round(INTERVAL_MS / 60000)} 分钟无变更 → 判定 Qoder 修改完成，监控退出。`);
      console.log('判定完成：30 分钟无变更');
      break;
    }
  } else {
    idleRounds = 0;
    log(`[第${round}轮] ${ts} 指纹=${cur.hash} 变更 ${changed} 个文件`);
    for (const f of d.added.slice(0, 60)) log(`    + ${f}`);
    for (const f of d.modified.slice(0, 60)) log(`    ~ ${f}`);
    for (const f of d.removed.slice(0, 60)) log(`    - ${f}`);
    if (d.added.length > 60 || d.modified.length > 60 || d.removed.length > 60) {
      log(`    （清单已截断，仅列前 60 项）`);
    }
    console.log(`[第${round}轮] 变更 ${changed} 个文件（+${d.added.length} ~${d.modified.length} -${d.removed.length}）`);
  }
  prev = cur;
}

log(`=== 监控结束 ${new Date().toISOString()} ===`);
