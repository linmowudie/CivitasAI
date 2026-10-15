#!/usr/bin/env node
/*
 * 实验基线指标采集（Benchmarks/baselines/metrics.json 的生成器 / 校验器）
 *
 * 用法：
 *   node Scripts/benchMetrics.cjs           # 重新采集并写入 Benchmarks/baselines/metrics.json
 *   node Scripts/benchMetrics.cjs --check   # 只校验：与磁盘基线比对，漂移或过期 → 退出码非 0（CI 用）
 *   node Scripts/benchMetrics.cjs --print   # 只打印，不写盘
 *
 * 为什么需要它（qoder 文 §1.1 第 3 类失真「不可达锚与陈旧基线」）：
 * `Benchmarks/baselines/metrics.json` 长期是 **2026-09-14 手写快照**，
 * 写着 `testCount: 582 / testFilesCount: 24`（而实际早已是三位数文件、四位数用例），
 * 且**全仓无任何代码读写它** —— 一个没人读、也没人会去纠正的数字，比没有更糟。
 *
 * 本脚本把它改成**可再生产物**：
 *  - `testFilesCount` / `testCaseCount` 直接从 `Tests/**` 统计，不再手写；
 *  - 矩阵覆盖 / 锚点强度从 `Scripts/experimentMatrix.cjs --json` 取（单一事实源）；
 *  - `--check` 断言"磁盘上的基线与当前仓库一致且未过期"，纳入 CI，
 *    使"改了测试忘了更新基线"当场变红。
 *
 * 诚实边界：`sixDimensions` 六维评分**没有可复现测量手段**，一律记 `unmeasured`
 * 并写明原因，不再保留手写分数（那正是本文件要消灭的东西）。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const BASELINE_PATH = path.join(ROOT, 'Benchmarks', 'baselines', 'metrics.json');
/**
 * 基线路径可用 --baseline=<path> 覆盖。
 *
 * 为什么需要：自测的**负向用例**要"把基线改坏再验证 --check 报错"。
 * 若直接改真实基线、靠 `finally` 还原，就成了 REV-429 那类反模式
 * （改真实数据 + 靠收尾还原；一旦进程被杀/抛错就留下坏数据）。
 * 有了开关，负向用例只改临时副本，真实基线永远不被触碰。
 */
const baselineArg = process.argv.slice(2).find(a => a.startsWith('--baseline='));
const BASELINE = baselineArg
  ? path.resolve(ROOT, baselineArg.split('=').slice(1).join('='))
  : BASELINE_PATH;
const MATRIX_SCRIPT = path.join(__dirname, 'experimentMatrix.cjs');
const TESTS_DIR = path.join(ROOT, 'Tests');

/** 基线最长允许的存活时间（天）——超过即视为陈旧，`--check` 判失败 */
const MAX_BASELINE_AGE_DAYS = 30;

const ARGS = process.argv.slice(2);
const CHECK = ARGS.includes('--check');
const PRINT_ONLY = ARGS.includes('--print');
/** `--strict`：把"基线过期"也升级为失败（CI 用 `--check`，避免基线满 30 天就红） */
const STRICT = ARGS.includes('--strict');

// ── 真实测试规模统计 ────────────────────────────────────────────────

function collectSpecFiles(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) collectSpecFiles(full, acc);
    else if (/\.(spec|test)\.tsx?$/.test(name)) acc.push(full);
  }
  return acc;
}

/** 用例计数口径（固定下来，避免每次口径漂移导致基线永远"不一致"） */
const CASE_RE = /\b(?:it|test)(?:\.\w+)?\s*\(/g;

function collectTestMetrics() {
  const files = collectSpecFiles(TESTS_DIR);
  let cases = 0;
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    cases += (text.match(CASE_RE) || []).length;
  }
  return {
    testFilesCount: files.length,
    testCaseCount: cases,
  };
}

// ── 矩阵覆盖（调用守门脚本，取单一事实源）──────────────────────────

function collectMatrixMetrics() {
  const out = execFileSync(process.execPath, [MATRIX_SCRIPT, '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return JSON.parse(out);
}

// ── Agent 能力指标（Benchmark 的主角；来自最近一次 benchmark 运行报告）────

const REPORT_DIR = path.join(ROOT, 'Benchmarks', 'reports');

/**
 * 汇总最近一次 Benchmark 运行（`Benchmarks/reports/*.json`）。
 *
 * 为什么基线的主角是它而不是 `testFilesCount`：
 * Benchmark 与 Tests 是两套系统 —— Tests 量的是代码规模与回归，Benchmark 量的是
 * **Agent 能力**（放行率 / 评分 / 问题分布）。把测试文件数当 Benchmark 基线，
 * 就是把配套系统当成了被测量对象。
 */
function collectAgentMetrics() {
  if (!fs.existsSync(REPORT_DIR)) return null;
  // 优先读运行器写出的稳定指针 `latest.json`；缺失时按**修改时间**取最新
  // （按文件名排序会踩坑：`all-*.json` 与 `scn-*.json` 的字典序与时间序不一致）。
  const stable = path.join(REPORT_DIR, 'latest.json');
  let target = null;
  if (fs.existsSync(stable)) {
    target = stable;
  } else {
    const files = fs.readdirSync(REPORT_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => ({ f, mtime: fs.statSync(path.join(REPORT_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (files.length === 0) return null;
    target = path.join(REPORT_DIR, files[0].f);
  }
  const report = JSON.parse(fs.readFileSync(target, 'utf8'));
  const results = report.results || [];

  const admitted = results.filter(r => r.admitted);
  const scored = admitted.filter(r => r.totalScore !== null);
  const gradeDist = {};
  const diagnosisDist = {};
  for (const r of results) {
    if (r.grade) gradeDist[r.grade] = (gradeDist[r.grade] || 0) + 1;
    for (const d of r.diagnoses || []) {
      // 只统计**真问题**：type!=none 且 severity 非 info
      // （info 包含"场景故意制造"的形态与"未发现问题"的占位，计入会让问题分布失真）
      if (d.type === 'none' || d.severity === 'info') continue;
      diagnosisDist[d.type] = (diagnosisDist[d.type] || 0) + 1;
    }
  }

  return {
    reportFile: path.basename(target),
    generatedAt: report.generatedAt ?? null,
    scenarios: results.length,
    admitted: admitted.length,
    admissionRate: results.length ? Number((admitted.length / results.length).toFixed(4)) : 0,
    avgScore: scored.length
      ? Number((scored.reduce((s, r) => s + r.totalScore, 0) / scored.length).toFixed(4))
      : null,
    gradeDistribution: gradeDist,
    /** 检索质量（系统轴 · 检索系统）：来自同一份报告的 trace.retrieval */
    retrievalQuality: (() => {
      const row = results.find(r => r.trace && r.trace.retrieval);
      const q = row && row.trace.retrieval;
      return q ? { goldenSet: q.goldenSet, goldenVersion: q.goldenVersion, corpusSize: q.corpusSize, seeded: q.seeded, queryCount: q.queryCount, scoredQueries: q.scoredQueries, k: q.k, meanRecallAtK: q.meanRecallAtK, mrr: q.mrr } : null;
    })(),
    /** 检出最多的 Agent 问题类型（诊断层的产出） */
    diagnosisDistribution: diagnosisDist,
    /** 有问题的场景明细（问题类型 → 场景） */
    problems: results
      .filter(r => (r.diagnoses || []).some(d => d.type !== 'none'))
      .map(r => ({ scenario: r.trace.scenarioId, types: (r.diagnoses || []).filter(d => d.type !== 'none').map(d => d.type) })),
  };
}

/** NOT-RUN 清单（§2.2 铁律 1）：缺凭据未执行被测行为的用例 */
const NOTRUN_PATH = path.join(ROOT, 'Benchmarks', 'baselines', 'notRun.json');

function collectNotRun() {
  if (!fs.existsSync(NOTRUN_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(NOTRUN_PATH, 'utf8'));
  } catch {
    return null;
  }
}

// ── 代码债登记册（红灯具读汇总；用于陈旧检测）─────────────────────────

const GAP_REPORT = path.join(__dirname, 'benchGapReport.cjs');

/**
 * 生成并读取代码债登记册的计数。
 * 为什么由基线采集顺带触发：登记册若与矩阵不同步就成了"没人读的过期文档"，
 * 正是本项目反复出现的失效模式。放在这里 → 重采基线即刷新，--check 能发现陈旧。
 */
function collectGapRegister() {
  try {
    const out = execFileSync(process.execPath, [GAP_REPORT, '--json'], { encoding: 'utf8' });
    return JSON.parse(out).counts;
  } catch {
    return null;
  }
}

// ── 组装 / 比对 ────────────────────────────────────────────────────

function buildMetrics() {
  const tests = collectTestMetrics();
  const matrix = collectMatrixMetrics();
  const agent = collectAgentMetrics();
  const notRun = collectNotRun();
  const gapRegister = collectGapRegister();
  return {
    version: matrix.version,
    schemaVersion: 4,
    recordedAt: new Date().toISOString(),
    generator: 'Scripts/benchMetrics.cjs',
    notes: [
      '**agentMetrics 是本基线的主角**：Benchmark 量的是 Agent 能力（准入率 / 评分 / 问题分布），'
        + '来自最近一次 `npx tsx Benchmarks/runner/run.ts` 的产物 `Benchmarks/reports/*.json`。',
      '`matrix` 段是第 1 层【实验矩阵】的覆盖事实（双轴：能力轴 + 九系统轴 / 平台前置 / 锚点强度）。',
      '`testSuite` 段是 **Tests 系统**（传统 bug 与业务）的规模，仅作仓库整体参考，不是 Benchmark 指标。',
      '**`notRun` 段落实九系统检验方案 §2.2 铁律 1**：缺真实凭据时不记 SKIP-pass。'
        + 'vitest 报的 passed 里含未执行被测行为的用例，`effectivePassed` 才是诚实口径。',
      'testCaseCount 为源码级 `it(`/`test(` 出现次数（口径固定，见脚本 CASE_RE），与 `vitest run` 输出不同。',
    ],
    metrics: {
      agentMetrics: agent,
      matrix: {
        version: matrix.version,
        cells: matrix.cells,
        axes: matrix.axes ?? null,
        prerequisites: matrix.prerequisites ?? null,
        surfaces: matrix.surfaces,
        families: matrix.families,
        landedCells: matrix.landedCells,
        /** 仅静态对账通过：单列，不计入落地率（静态与实测必须裁开） */
        staticAttested: matrix.staticAttested ?? null,
        byStatusAttestation: matrix.byStatusAttestation ?? null,
        landingRate: matrix.landingRate,
        byCls: matrix.byCls,
        byStatus: matrix.byStatus,
        anchorStrength: matrix.anchorStrength,
      },
      testSuite: {
        ...tests,
        note: 'Tests 系统规模（参考值，非 Benchmark 指标）',
      },
      notRun: notRun === null ? {
        status: 'missing',
        note: '未采集；运行 node Scripts/credentialNotRun.cjs 生成（缺凭据的用例必须记 NOT-RUN，不得记通过）',
      } : {
        credential: notRun.credential,
        credentialPresent: notRun.credentialPresent,
        gatedFileCount: notRun.gatedFileCount,
        notRunCount: notRun.notRunCount,
        vitestPassed: notRun.vitest?.passed ?? null,
        effectivePassed: notRun.effectivePassed,
        tests: (notRun.notRun ?? []).map(n => n.test),
        rule: notRun.rule,
      },
      gapRegister: gapRegister ?? { status: 'missing' },
      gaps: {
        declaredOnly: matrix.gaps.map(g => g.split(' ')[0]),
        gap: matrix.gapCells.map(g => g.split(' ')[0]),
        weakAnchors: matrix.weakAnchors.map(w => w.split(' ')[0]),
      },
      sixDimensions: {
        status: 'measured-by-benchmark',
        note: '六维评分由 Benchmarks/scoringMatrix.json + Benchmarks/runner 产出（见 agentMetrics.avgScore 与 gradeDistribution）；'
          + '本文件不再手写任何维度分数。',
      },
    },
  };
}

/** 结构性字段的比对（`recordedAt` 每次都变，不参与比对） */
function compareMetrics(disk, fresh) {
  const diffs = [];
  const dm = disk.metrics || {};
  const fm = fresh.metrics || {};

  // ① Agent 能力指标（主角）：准入率与场景数变化即视为基线过期
  const da = dm.agentMetrics;
  const fa = fm.agentMetrics;
  if (!da && fa) diffs.push('agentMetrics 缺失（基线早于 Benchmark 运行器接入）→ 需重新采集');
  else if (da && fa) {
    for (const key of ['scenarios', 'admitted']) {
      if (da[key] !== fa[key]) diffs.push(`agentMetrics.${key}: 基线 ${da[key]} ≠ 实际 ${fa[key]}`);
    }
  }

  // ② 代码债登记册：条数/分类与矩阵必须一致（否则登记册就是"没人读的过期文档"）
  const dGr = dm.gapRegister;
  const fGr = fm.gapRegister;
  if (dGr && fGr && dGr.status !== 'missing' && fGr.status !== 'missing') {
    if (dGr.total !== fGr.total) {
      diffs.push('gapRegister.total: 基线 ' + dGr.total + ' ≠ 实际 ' + fGr.total + '（矩阵变了但登记册未重生成）');
    }
    const dB = JSON.stringify(dGr.byBlocker ?? {});
    const fB = JSON.stringify(fGr.byBlocker ?? {});
    if (dB !== fB) diffs.push('gapRegister.byBlocker: 基线 ' + dB + ' ≠ 实际 ' + fB);
  }

  // ③ 矩阵覆盖事实
  const dMatrix = dm.matrix || {};
  const fMatrix = fm.matrix || {};
  for (const key of ['cells', 'prerequisites', 'surfaces', 'families', 'landedCells']) {
    if (dMatrix[key] !== fMatrix[key]) diffs.push(`matrix.${key}: 基线 ${dMatrix[key]} ≠ 实际 ${fMatrix[key]}`);
  }
  for (const key of ['assertion', 'file-only', 'none']) {
    const a = (dMatrix.anchorStrength || {})[key];
    const b = (fMatrix.anchorStrength || {})[key];
    if (a !== b) diffs.push(`anchorStrength.${key}: 基线 ${a} ≠ 实际 ${b}`);
  }
  return diffs;
}

function checkFreshness(disk) {
  const recorded = Date.parse(disk.recordedAt || '');
  if (Number.isNaN(recorded)) return ['基线缺 recordedAt 或格式非法'];
  const ageDays = (Date.now() - recorded) / 86_400_000;
  if (ageDays > MAX_BASELINE_AGE_DAYS) {
    return [`基线已过期：recordedAt=${disk.recordedAt}（${ageDays.toFixed(1)} 天 > ${MAX_BASELINE_AGE_DAYS} 天上限）`];
  }
  return [];
}

// ── 主流程 ─────────────────────────────────────────────────────────

function main() {
  const fresh = buildMetrics();

  if (PRINT_ONLY) {
    console.log(JSON.stringify(fresh, null, 2));
    return;
  }

  if (CHECK) {
    if (!fs.existsSync(BASELINE)) {
      console.error(`[benchMetrics] 基线缺失: ${BASELINE}（先跑 node Scripts/benchMetrics.cjs）`);
      process.exit(1);
    }
    const disk = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
    // 一致性（改测试忘更新基线）恒判失败；过期（满 30 天没重新采集）默认只警告，
    // `--strict` 下才升级为失败——否则仓库静置一个月 CI 就会无故变红。
    const problems = compareMetrics(disk, fresh);
    const staleWarnings = checkFreshness(disk);
    if (STRICT) problems.push(...staleWarnings);

    console.log('=== 实验基线一致性检查 ===');
    const da = disk.metrics?.agentMetrics;
    const fa = fresh.metrics.agentMetrics;
    console.log(`Agent 能力: 基线 ${da ? `${da.admitted}/${da.scenarios} 放行，均分 ${da.avgScore}` : '(无)'}`
      + `  |  实际 ${fa ? `${fa.admitted}/${fa.scenarios} 放行，均分 ${fa.avgScore}` : '(尚未跑过 Benchmark)'}`);
    console.log(`矩阵: 基线 ${disk.metrics?.matrix?.cells} 能力 cell / ${disk.metrics?.matrix?.prerequisites} 前置`
      + `  |  实际 ${fresh.metrics.matrix.cells} / ${fresh.metrics.matrix.prerequisites}`);
    console.log(`记录时间: ${disk.recordedAt}`);

    for (const w of staleWarnings) {
      console.log(`${STRICT ? '✗' : '⚠'} ${w}${STRICT ? '' : '（--strict 下判失败）'}`);
    }

    if (problems.length) {
      console.error(`\n✗ 基线不一致，共 ${problems.length} 项：`);
      for (const p of problems) console.error(`  - ${p}`);
      console.error('\n修复：node Scripts/benchMetrics.cjs  （重新采集并写盘）');
      process.exit(1);
    }
    console.log('\n✓ 基线与当前仓库一致。');
    return;
  }

  fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
  fs.writeFileSync(BASELINE, JSON.stringify(fresh, null, 2) + '\n', 'utf8');
  console.log('=== 实验基线已采集 ===');
  console.log(`写入: ${path.relative(ROOT, BASELINE)}`);
  const a = fresh.metrics.agentMetrics;
  if (a) {
    console.log(`Agent 能力: ${a.scenarios} 场景，放行 ${a.admitted}（${(a.admissionRate * 100).toFixed(1)}%）`
      + `，均分 ${a.avgScore}，等级 ${JSON.stringify(a.gradeDistribution)}`);
    const problems = Object.entries(a.diagnosisDistribution);
    console.log(`问题分布: ${problems.length ? problems.map(([k, v]) => `${k}×${v}`).join(', ') : '无'}`);
  } else {
    console.log('Agent 能力: (尚未跑过 Benchmark —— 先执行 npx tsx Benchmarks/runner/run.ts)');
  }
  console.log(`矩阵: ${fresh.metrics.matrix.cells} cell（能力轴 ${fresh.metrics.matrix.axes?.capability ?? '?'} + 系统轴 ${fresh.metrics.matrix.axes?.system ?? '?'}）/ ${fresh.metrics.matrix.prerequisites} 平台前置 / `
    + `落地 ${(fresh.metrics.matrix.landingRate * 100).toFixed(1)}%`);
  console.log(`锚点: 断言级=${fresh.metrics.matrix.anchorStrength.assertion} `
    + `弱锚=${fresh.metrics.matrix.anchorStrength['file-only']} 无锚=${fresh.metrics.matrix.anchorStrength.none}`);
  console.log(`Tests 系统规模（参考）: ${fresh.metrics.testSuite.testFilesCount} 文件 / ${fresh.metrics.testSuite.testCaseCount} 用例`);
  const nr = fresh.metrics.notRun;
  if (nr.status === 'missing') {
    console.log(`NOT-RUN: 未采集（运行 node Scripts/credentialNotRun.cjs）`);
  } else {
    console.log(`NOT-RUN: ${nr.notRunCount} 条（缺 ${nr.credential}）→ vitest passed ${nr.vitestPassed} 中**有效通过 ${nr.effectivePassed}**`);
  }
}

main();
