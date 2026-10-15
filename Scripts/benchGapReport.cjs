#!/usr/bin/env node
/*
 * 代码债登记册生成器
 *
 * 为什么需要它：实验矩阵里 30+ 条 `gap` / `declared-only` 是**红灯清单**，
 * 但它们散在 20KB JSON 里 —— 没有人会去读，也就不会有人去修。
 * 这份登记册把红灯按**系统面**归组、按**阻塞类型**分类，并附上每条 cell 已写好的
 * 实测依据（method），使它真正可用作治理依据。
 *
 * 阻塞类型由 `status` + `anchor.kind` **推导**（不手写，避免与矩阵不同步）：
 *   design-only     —— declared-only：产品零实现，只登记语义与验收契约
 *   product-missing —— gap + static 锚：L0 已证明该性质在产品中不存在
 *   behavior-gap    —— gap + scenario 锚：场景可复现该缺陷（有红灯实证）
 *   unreachable     —— gap + 无锚：需产品先接线才谈得上测量
 *
 * 用法：
 *   node Scripts/benchGapReport.cjs            # 写 Benchmarks/GAP-REGISTER.md
 *   node Scripts/benchGapReport.cjs --json     # 机读（供 benchMetrics 做陈旧检测）
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MATRIX = path.join(ROOT, 'Benchmarks', 'experimentMatrix.json');
const OUT = path.join(ROOT, 'Benchmarks', 'GAP-REGISTER.md');

const BLOCKER_INFO = {
  'design-only': { label: '设计态', desc: '产品 0 实现；登记的是语义定义与实现验收契约，不是缺陷' },
  'product-missing': { label: '产品缺失', desc: '阻塞在**产品侧**：改产品才能转绿（有代码位置或实测证据）' },
  'bench-unbuilt': { label: '实验未建', desc: '阻塞在**Benchmark 侧**：补场景 / 装配实验台即可转绿' },
  'behavior-gap': { label: '行为缺陷', desc: '场景可复现该缺陷（有红灯实证）' },
};

/**
 * 分类**优先读 cell.blockerSide**（矩阵里显式登记的阻塞方）；
 * 缺失时才退回"从 anchor.kind 猜" —— 猜出来的分类会把"实验未建"误记成"产品缺失"。
 */
function classify(cell) {
  if (cell.status === 'declared-only') return 'design-only';
  if (cell.status !== 'gap') return null;
  if (cell.blockerSide === 'product') return 'product-missing';
  if (cell.blockerSide === 'benchmark') return 'bench-unbuilt';
  const kind = cell.anchor && cell.anchor.kind;
  if (kind === 'static') return 'product-missing';
  if (kind === 'scenario') return 'behavior-gap';
  return 'bench-unbuilt';
}

function main() {
  const jsonOnly = process.argv.slice(2).includes('--json');
  const m = JSON.parse(fs.readFileSync(MATRIX, 'utf8'));

  const entries = [];
  for (const c of m.cells) {
    const blocker = classify(c);
    if (!blocker) continue;
    entries.push({
      id: c.id,
      axis: c.axis,
      surface: c.surface,
      cls: c.cls,
      family: c.family ?? null,
      status: c.status,
      blocker,
      objective: c.objective,
      oracle: c.oracle,
      module: c.module,
      gate: c.gate,
      anchorKind: c.anchor ? c.anchor.kind : 'none',
      evidence: c.method,
    });
  }

  const byBlocker = {};
  for (const e of entries) byBlocker[e.blocker] = (byBlocker[e.blocker] ?? 0) + 1;

  const all = [...m.cells, ...(m.prerequisites || [])];
  const counts = {
    executed: all.filter(c => c.status === 'existing-covered' && c.attestation === 'executed').length,
    staticAttested: all.filter(c => c.status === 'existing-covered' && c.attestation === 'static').length,
    total: entries.length,
    gap: entries.filter(e => e.status === 'gap').length,
    declaredOnly: entries.filter(e => e.status === 'declared-only').length,
    byBlocker,
    cells: entries.map(e => e.id).sort(),
  };

  if (jsonOnly) {
    process.stdout.write(JSON.stringify({ generatedAt: new Date().toISOString(), counts }, null, 2) + '\n');
    return;
  }

  // ── 人读登记册 ──
  const surfaces = [...new Set(entries.map(e => e.surface))];
  const lines = [];
  lines.push('# 代码债登记册（Code-Debt Register）');
  lines.push('');
  lines.push(`> **由实验矩阵自动生成** —— 生成时间 ${new Date().toISOString()}`);
  lines.push('> 来源：`Benchmarks/experimentMatrix.json`（`status` ∈ {gap, declared-only} 的 cell）');
  lines.push('> 生成器：`Scripts/benchGapReport.cjs`（`npm run bench:gaps`）。**不要手改本文件**，改矩阵后重新生成。');
  lines.push('');
  lines.push('## 汇总');
  lines.push('');
  lines.push(`落地状态：**实测 executed ${counts.executed}** 条 ｜ 仅静态对账 static-attested ${counts.staticAttested} 条（单列，不计入落地率）`);
  lines.push(`红灯 cell 共 **${counts.total}** 条（gap ${counts.gap} + declared-only ${counts.declaredOnly}）`
    + `，占全部 ${m.cells.length} 条 cell 的 ${((counts.total / m.cells.length) * 100).toFixed(1)}%。`);
  lines.push('');
  lines.push('| 阻塞类型 | 条数 | 含义 |');
  lines.push('|---|---:|---|');
  for (const [k, info] of Object.entries(BLOCKER_INFO)) {
    if (!byBlocker[k]) continue;
    lines.push(`| ${info.label}（\`${k}\`） | ${byBlocker[k]} | ${info.desc} |`);
  }
  lines.push('');
  lines.push('分类由 `status` + `anchor.kind` **推导**（不手写），因此不会与矩阵不同步。');
  lines.push('');

  for (const surface of surfaces) {
    const group = entries.filter(e => e.surface === surface);
    lines.push(`## ${surface}（${group.length} 条）`);
    lines.push('');
    for (const e of group) {
      const tag = BLOCKER_INFO[e.blocker].label;
      lines.push(`### \`${e.id}\` — ${tag}`);
      lines.push('');
      lines.push(`- **目标/判据**：${e.oracle}`);
      lines.push(`- **锚定模块**：\`${e.module}\`　Gate：${e.gate}　类别：${e.cls}${e.family ? ` / ${e.family}` : ''}　锚点：\`${e.anchorKind}\``);
      lines.push(`- **实测依据**：${e.evidence}`);
      lines.push('');
    }
  }

  lines.push('---');
  lines.push('');
  lines.push('## 使用方式');
  lines.push('');
  lines.push('1. **修一条** → 在矩阵里把该 cell 从 `gap` 改成 `existing-covered` 并换上可解析的锚点；');
  lines.push('   守门的**双向一致性规则**会在"债已还但矩阵未转正"时报违规，反之亦然。');
  lines.push('2. **确认无法修** → 在 cell 的 `method` 里补上更硬的实测依据（日期 + 代码位置），而不是留"待补"。');
  lines.push('3. **本册不是 CI 阻断项**：`gap` 按设计不进 CI 阻断（缺口证明实验），');
  lines.push('   但登记册的**条数与矩阵必须一致** —— `npm run bench:metrics` 会校验，不一致即视为陈旧。');
  lines.push('');

  fs.writeFileSync(OUT, lines.join('\n'), 'utf8');
  console.log('=== 代码债登记册 ===');
  console.log(`红灯 ${counts.total} 条（gap ${counts.gap} + declared-only ${counts.declaredOnly}）／全部 ${m.cells.length} cell`);
  for (const [k, n] of Object.entries(byBlocker)) console.log(`  ${BLOCKER_INFO[k].label.padEnd(5)} ${n} 条`);
  console.log(`写入: ${path.relative(ROOT, OUT)}`);
}

main();
