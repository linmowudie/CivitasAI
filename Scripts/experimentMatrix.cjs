#!/usr/bin/env node
/*
 * 实验矩阵覆盖率校验（Benchmarks/experimentMatrix.json 的守门脚本）
 *
 * 强制四条覆盖规则，违反任一 → 退出码非 0：
 *  1. 每个系统面至少 1 个 BEN（非对抗）且至少 1 个对抗（ENV/SEC）；
 *  2. 每个对抗家族（injection/integrity/availability/privilege-escalation/governance-manipulation/data-poisoning）非空；
 *  3. 每个 cell 必须有 oracle；且 anchor 可解析：
 *       - existing-covered → anchor.kind=spec 且 ref 文件存在；
 *       - new-scaffold     → anchor.kind=tag 且标签出现在 Tests/Experiments/**；
 *       - declared-only    → anchor.kind=none（登记缺口，不产可运行断言）。
 *  4. 汇总对抗覆盖 / declared-only 缺口，并映射到 DUR / G。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MATRIX_PATH = path.join(ROOT, 'Benchmarks', 'experimentMatrix.json');
const EXPERIMENTS_DIR = path.join(ROOT, 'Tests', 'Experiments');

const REQUIRED_FIELDS = ['id', 'surface', 'cls', 'objective', 'method', 'oracle', 'module', 'gate', 'status', 'dim', 'anchor'];
const VALID_CLS = ['BEN', 'ENV', 'SEC'];
const VALID_STATUS = ['existing-covered', 'new-scaffold', 'declared-only'];

function fail(list, msg) { list.push(msg); }

/** 递归收集 Tests/Experiments 下所有 spec 文本中的 @matrix: 标签 */
function collectTags(dir) {
  const tags = new Set();
  if (!fs.existsSync(dir)) return tags;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) {
      for (const t of collectTags(full)) tags.add(t);
    } else if (/\.(spec|test)\.ts$/.test(name)) {
      const text = fs.readFileSync(full, 'utf8');
      for (const m of text.matchAll(/@matrix:([A-Z0-9-]+)/g)) tags.add(m[1]);
    }
  }
  return tags;
}

function main() {
  const violations = [];

  if (!fs.existsSync(MATRIX_PATH)) {
    console.error(`[experimentMatrix] 矩阵文件缺失: ${MATRIX_PATH}`);
    process.exit(1);
  }

  const matrix = JSON.parse(fs.readFileSync(MATRIX_PATH, 'utf8'));
  const cells = matrix.cells || [];
  const surfaces = matrix.surfaces || [];
  const families = matrix.adversarialFamilies || [];
  const dims = matrix.dimensions || [];
  const tags = collectTags(EXPERIMENTS_DIR);

  // ── 规则 0：逐 cell 结构校验 ───────────────────────
  const ids = new Set();
  for (const cell of cells) {
    for (const f of REQUIRED_FIELDS) {
      if (cell[f] === undefined) fail(violations, `${cell.id || '?'} 缺字段 ${f}`);
    }
    if (ids.has(cell.id)) fail(violations, `重复 cell id: ${cell.id}`);
    ids.add(cell.id);
    if (!VALID_CLS.includes(cell.cls)) fail(violations, `${cell.id} cls 非法: ${cell.cls}`);
    if (!VALID_STATUS.includes(cell.status)) fail(violations, `${cell.id} status 非法: ${cell.status}`);
    if (!surfaces.includes(cell.surface)) fail(violations, `${cell.id} surface 未在 surfaces 声明: ${cell.surface}`);
    if (cell.dim && !dims.includes(cell.dim)) fail(violations, `${cell.id} dim 不在六维内: ${cell.dim}`);
    if (cell.cls !== 'BEN' && !cell.family) fail(violations, `${cell.id} 对抗 cell 缺 adversarialFamily`);
    if (cell.family && !families.includes(cell.family)) fail(violations, `${cell.id} family 非标准: ${cell.family}`);

    // anchor 可解析性
    const a = cell.anchor || {};
    if (cell.status === 'existing-covered') {
      if (a.kind !== 'spec') fail(violations, `${cell.id} existing-covered 的 anchor.kind 应为 spec`);
      else if (!fs.existsSync(path.join(ROOT, a.ref))) fail(violations, `${cell.id} 既有测试不存在: ${a.ref}`);
    } else if (cell.status === 'new-scaffold') {
      if (a.kind !== 'tag') fail(violations, `${cell.id} new-scaffold 的 anchor.kind 应为 tag`);
      else if (!tags.has(cell.id)) fail(violations, `${cell.id} new-scaffold 标签未在 Tests/Experiments 出现: @matrix:${cell.id}`);
    } else if (cell.status === 'declared-only') {
      if (a.kind !== 'none') fail(violations, `${cell.id} declared-only 的 anchor.kind 应为 none`);
    }
  }

  // ── 规则 1：每面 BEN + 对抗齐备 ────────────────────
  for (const s of surfaces) {
    const inSurface = cells.filter(c => c.surface === s);
    const hasBen = inSurface.some(c => c.cls === 'BEN');
    const hasAdv = inSurface.some(c => c.cls === 'ENV' || c.cls === 'SEC');
    if (!hasBen) fail(violations, `面「${s}」缺非对抗(BEN) cell`);
    if (!hasAdv) fail(violations, `面「${s}」缺对抗(ENV/SEC) cell`);
  }

  // ── 规则 2：对抗家族全覆盖 ──────────────────────────
  for (const fam of families) {
    if (!cells.some(c => c.family === fam)) fail(violations, `对抗家族未被任何 cell 覆盖: ${fam}`);
  }

  // ── 报告 ────────────────────────────────────────────
  const byCls = { BEN: 0, ENV: 0, SEC: 0 };
  const byStatus = { 'new-scaffold': 0, 'existing-covered': 0, 'declared-only': 0 };
  const gaps = [];
  for (const c of cells) {
    byCls[c.cls] = (byCls[c.cls] || 0) + 1;
    byStatus[c.status] = (byStatus[c.status] || 0) + 1;
    if (c.status === 'declared-only') gaps.push(`${c.id} (${c.module}) — ${c.oracle}`);
  }

  console.log('=== Civitas-AI 实验矩阵覆盖报告 ===');
  console.log(`cells 总数: ${cells.length}  |  面: ${surfaces.length}  |  对抗家族: ${families.length}`);
  console.log(`按类别: BEN=${byCls.BEN}  ENV=${byCls.ENV}  SEC=${byCls.SEC}`);
  console.log(`按状态: new-scaffold=${byStatus['new-scaffold']}  existing-covered=${byStatus['existing-covered']}  declared-only=${byStatus['declared-only']}`);
  const adversarial = byCls.ENV + byCls.SEC;
  const coveredAdv = cells.filter(c => (c.cls === 'ENV' || c.cls === 'SEC') && c.status !== 'declared-only').length;
  console.log(`对抗面落地率: ${coveredAdv}/${adversarial}（其余为 declared-only 缺口）`);

  if (gaps.length) {
    console.log('\n-- declared-only 缺口（后续排期）--');
    for (const g of gaps) console.log(`  · ${g}`);
  }

  if (violations.length) {
    console.error(`\n✗ 覆盖校验失败，共 ${violations.length} 项：`);
    for (const v of violations) console.error(`  - ${v}`);
    process.exit(1);
  }

  console.log('\n✓ 实验矩阵覆盖校验通过：每面 BEN+对抗齐备、六类对抗家族全覆盖、anchor 可解析。');
}

main();
