#!/usr/bin/env node
/*
 * 对照表完整性审计（Conformance audit）
 *
 * 为什么需要它：`Benchmarks/CONFORMANCE.md` 里写了一批 "✅" —— 但**文档会过时，记忆也会过时**
 * （第 13 轮刚刚证明：文档 §6 批 1 点名的 6 条"过度声称"，有 3 条判断已经不准）。
 * 所以这里把那些 "✅" 变成**可当场重算的断言**：只读产物、不读文档叙述，
 * 每一项都重新取证。任何一项失败即非 0 退出。
 *
 * 用法：node Scripts/benchConformanceCheck.cjs [--json]
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const R = (rel) => path.join(ROOT, rel);
const read = (rel) => (fs.existsSync(R(rel)) ? fs.readFileSync(R(rel), 'utf8') : null);
const readJson = (rel) => { const t = read(rel); return t === null ? null : JSON.parse(t); };
const exists = (rel) => fs.existsSync(R(rel));

function runJson(script, args = []) {
  try {
    return JSON.parse(execFileSync(process.execPath, [R(script), '--json', ...args], { encoding: 'utf8' }));
  } catch {
    return null;
  }
}

const results = [];
const check = (name, fn) => {
  try {
    const r = fn();
    results.push({ name, passed: r.passed, detail: r.detail });
  } catch (e) {
    results.push({ name, passed: false, detail: `审计抛异常：${e instanceof Error ? e.message : String(e)}` });
  }
};

// ═══ ① §2.1 L0 静态对账 ═══
check('L0：staticRecon 可运行且 lock 全绿、检查数 ≥ 30', () => {
  const r = runJson('Scripts/staticRecon.cjs');
  if (!r) return { passed: false, detail: '无法获取 staticRecon --json' };
  return {
    passed: r.total >= 30 && r.lockFailed.length === 0,
    detail: `${r.total} 条检查 / lock 失败 ${r.lockFailed.length} / gap 成立 ${r.gapOpen.length}`,
  };
});

check('L0：守门确实调用 staticRecon（不是只在文档里说）', () => {
  const t = read('Scripts/experimentMatrix.cjs') ?? '';
  const ok = /staticRecon\.cjs/.test(t) && /loadStaticResults/.test(t) && /static 锚无法解析/.test(t);
  return { passed: ok, detail: ok ? '守门内联调用并交叉校验' : '守门未真正调用 staticRecon' };
});

// ═══ ② §2.2 铁律 1：NOT-RUN ═══
check('NOT-RUN：清单存在，条数与凭据状态自洽且与 vitest passed 的关系可复算', () => {
  const nr = readJson('Benchmarks/baselines/notRun.json');
  if (!nr) return { passed: false, detail: 'notRun.json 缺失（先跑 npm run bench:notrun）' };
  const recomputed = Math.max(0, (nr.vitest?.passed ?? 0) - nr.notRunCount);
  // 铁律是条件式的：采集时**缺**凭据 ⇒ 受门禁用例必须记 NOT-RUN（≥1）；
  // 采集时**有**凭据 ⇒ 用例真实执行过，NOT-RUN 为 0 才是诚实的。
  const countConsistent = nr.credentialPresent ? nr.notRunCount === 0 : nr.notRunCount >= 1;
  const ok = countConsistent && nr.effectivePassed === recomputed && nr.rule.includes('NOT-RUN');
  return {
    passed: ok,
    detail: `credentialPresent=${nr.credentialPresent} / notRun=${nr.notRunCount} / vitest.passed=${nr.vitest?.passed} / effectivePassed=${nr.effectivePassed}（复算 ${recomputed}）`,
  };
});

check('NOT-RUN：13 处"缺 key 即 return"已全部改判（无残留 SKIP-pass）', () => {
  const files = [
    'Tests/AgentRuntime/realAgent.spec.ts', 'Tests/Infra/llm.spec.ts',
    'Tests/E2E/litigationMode.spec.ts', 'Tests/E2E/directExecution.spec.ts',
    'Tests/E2E/delegationMode.spec.ts', 'Tests/E2E/consortiumMode.spec.ts',
    'Tests/E2E/assemblyLineMode.spec.ts',
  ];
  const leftovers = [];
  for (const f of files) {
    const t = read(f) ?? '';
    // 残留形态：缺 key → console.log('SKIP...') 且紧跟 return
    if (/if \(!hasRealLlmKey\(\)\) \{\s*\n\s*notRun\(\)/.test(t)) continue;
    if (/console\.log\([^\n]*SKIP[^\n]*\)/.test(t)) leftovers.push(f);
  }
  return {
    passed: leftovers.length === 0,
    detail: leftovers.length === 0 ? '7 个文件均为 notRun() 形态' : `仍有 SKIP-pass 残留：${leftovers.join(', ')}`,
  };
});

// ═══ ③ §2.3 前置阻断 ═══
check('REV-429：secretsStore.spec 不再触碰真实凭据（无 copyFileSync / 硬编码 Data 路径）', () => {
  const raw = read('Tests/Infra/secretsStore.spec.ts') ?? '';
  // 只审**代码**，不审注释：本文件顶部有一段说明"原实现有多危险"的注释里就写着 copyFileSync，
  // 直接全文匹配会把"解释旧危险"误判成"仍在犯"（审计首跑的真实假阳性）。
  const code = raw.split('\n').map(l => l.replace(/^\s*(\/\/|\*|\/\*).*$/, '')).join('\n');
  const bad = /copyFileSync|SECRETS_FILE\s*=\s*join|providers\.json\.enc\.testbak/.test(code);
  const good = /mkdtempSync/.test(code) && /CIVITAS_DATA_ROOT/.test(code) && /resetPathCache/.test(code) && /沙箱内/.test(code);
  return {
    passed: !bad && good,
    detail: bad ? '仍存在真实凭据 copy→rm 写法' : (good ? '沙箱化 + 安全断言齐备' : '沙箱化不完整（缺 mkdtemp/env/resetPathCache/安全断言）'),
  };
});

check('评测卫生：searchMemories 写副作用被 L0 锁住', () => {
  const r = runJson('Scripts/staticRecon.cjs');
  const c = r?.checks?.find(x => x.id === 'SC-LOCK-SEARCH-WRITE-SIDE-EFFECT');
  return { passed: !!c && c.passed, detail: c ? c.detail : '未找到该检查' };
});

// ═══ ④ §5 资产 ═══
check('§5 资产：golden set 形状正确且查询数在 30~50', () => {
  const g = readJson('Benchmarks/datasets/retrievalGoldenSet.json');
  if (!g) return { passed: false, detail: 'retrievalGoldenSet.json 缺失' };
  const corpus = new Set(g.corpus.map(c => c.memoryId));
  const dangling = g.queries.flatMap(q => q.expected).filter(e => !corpus.has(e));
  const langs = new Set(g.queries.map(q => q.lang));
  const ok = g.queries.length >= 30 && g.queries.length <= 50 && dangling.length === 0 && langs.size >= 3;
  return {
    passed: ok,
    detail: `语料 ${g.corpus.length} / 查询 ${g.queries.length} / 语言 ${[...langs].join(',')} / 越界期望 ${dangling.length}`,
  };
});

check('§5 资产：memoryPoison 覆盖六家族', () => {
  const p = readJson('Benchmarks/datasets/memoryPoison.json');
  if (!p) return { passed: false, detail: 'memoryPoison.json 缺失' };
  const fams = new Set(p.seeds.map(s => s.family));
  const declared = Object.keys(p.families);
  const missing = declared.filter(f => !fams.has(f));
  return { passed: missing.length === 0, detail: missing.length ? `缺家族：${missing.join(',')}` : `六家族全覆盖（${p.seeds.length} 种子）` };
});

check('§5 资产：真实凭据注入机制已接入 vitest', () => {
  const cfg = read('vitest.config.ts') ?? '';
  const setup = read('Tests/setup/credentials.ts') ?? '';
  const ok = /Tests\/setup\/credentials\.ts/.test(cfg) && /setupFiles/.test(cfg)
    && /hasRealLlmKey|MANAGED_CREDENTIALS/.test(setup) && /\.env\.local/.test(setup);
  return { passed: ok, detail: ok ? 'setupFiles + .env/.env.local 注入' : '凭据注入未完整接入' };
});

check('§5 资产：双层 trace / 事件回放 的声明与证据一致（缺口必须如实登记，闭合必须有实测证据）', () => {
  const m = readJson('Benchmarks/experimentMatrix.json');
  const cells = ['MM-GAP-TRACE', 'MM-GAP-EVENTSTABLE']
    .map(id => ({ id, cell: m?.cells?.find(c => c.id === id) }))
    .filter(x => !!x.cell);
  const problems = [];
  for (const { id, cell } of cells) {
    if (cell.status === 'gap' || cell.status === 'declared-only') {
      // 未闭合：允许，但必须有缺口证明实验（anchor 非 none + executed）
      if (cell.anchor?.kind === 'none' || cell.attestation === 'none') {
        problems.push(`${id} 仍为缺口却没有可运行实验（不许无证据地登记缺口）`);
      }
    } else {
      // 已闭合：必须给出实测证据（场景/断言锚点 + executed），否则就是假装完成
      const anchored = cell.anchor?.kind === 'scenario' || cell.anchor?.kind === 'assertProbe';
      if (!anchored || cell.attestation !== 'executed') {
        problems.push(`${id} 声明已闭合但缺实测证据（anchor=${cell.anchor?.kind ?? 'none'} attestation=${cell.attestation}）`);
      }
    }
  }
  return {
    passed: problems.length === 0,
    detail: problems.length
      ? problems.join('；')
      : '两处声明均有对应证据（缺口→有实验；闭合→executed 实测）',
  };
});

// ═══ ⑤ 规模与一致性 ═══
check('双轴：cell 数 = 能力轴 + 系统轴；面数 = 15', () => {
  const rep = runJson('Scripts/experimentMatrix.cjs');
  if (!rep) return { passed: false, detail: '无法获取守门 --json' };
  const ok = rep.axes.capability + rep.axes.system === rep.cells && rep.surfaces === 15;
  return { passed: ok, detail: `能力 ${rep.axes.capability} + 系统 ${rep.axes.system} = ${rep.cells}；面 ${rep.surfaces}` };
});

check('代码债登记册：条数与矩阵一致', () => {
  const reg = runJson('Scripts/benchGapReport.cjs');
  const rep = runJson('Scripts/experimentMatrix.cjs');
  if (!reg || !rep) return { passed: false, detail: '无法获取登记册或守门报告' };
  const matrixRed = (rep.byStatus.gap ?? 0) + (rep.byStatus['declared-only'] ?? 0);
  return {
    passed: reg.counts.total === matrixRed,
    detail: `登记册 ${reg.counts.total} 条 vs 矩阵红灯 ${matrixRed} 条（gap ${rep.byStatus.gap} + declared-only ${rep.byStatus['declared-only']}）`,
  };
});

check('实验台自测：可运行且全绿', () => {
  try {
    const out = execFileSync(process.execPath, [R('node_modules/tsx/dist/cli.mjs'), 'Benchmarks/runner/selftest.ts'], { encoding: 'utf8', cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    const m = out.match(/通过 (\d+) 项/);
    return { passed: !!m && Number(m[1]) >= 40, detail: m ? `通过 ${m[1]} 项` : '未能解析通过数' };
  } catch (e) {
    return { passed: false, detail: `自测非 0 退出：${e.status ?? '?'}` };
  }
});

check('CI：含自测 / NOT-RUN / L0 / 矩阵守门 / 基线 / 运行器类型检查 / 端到端 / 审计', () => {
  const ci = read('.github/workflows/ci.yml') ?? '';
  const needed = ['bench:selftest', 'bench:notrun', 'bench:static', 'bench:matrix', 'bench:metrics:check', 'bench:typecheck', 'bench:run', 'bench:conformance'];
  // 必须匹配**独立的 run 行**，不能用子串包含 ——
  // 实测踩过：把 `bench:static` 改成 `bench:static-DISABLED` 后，`includes('bench:static')` 仍为真，
  // 审计照样 16/16。守卫自己必须对"名字被改坏"敏感，否则它只是装饰。
  const missing = needed.filter(n => !new RegExp(`^\\s*run:\\s*npm run ${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm').test(ci));
  return { passed: missing.length === 0, detail: missing.length ? `CI 缺（或名字被改坏）：${missing.join(', ')}` : `${needed.length} 个 bench 步骤齐备（逐行精确匹配）` };
});

check('守门负向自测存在（守门必须"会拦"，不只是"能过"）', () => {
  const t = read('Benchmarks/runner/selftest.ts') ?? '';
  const negatives = ['场景不存在', '未声明承载', '缺对抗 cell', 'family 非标准', 'static 锁不成立', '债已还', 'static 锚无法解析', 'axis 非法或缺失', '孤儿声明'];
  const missing = negatives.filter(n => !t.includes(n));
  return { passed: missing.length === 0, detail: missing.length ? `缺负向断言：${missing.join(', ')}` : `${negatives.length} 条守门负向断言齐备` };
});

// ═══ ⑦ 文档声明与实际口径一致 ═══
check('CONFORMANCE.md 存在且已声明三处偏离与待裁定项', () => {
  const t = read('Benchmarks/CONFORMANCE.md');
  if (t === null) return { passed: false, detail: 'CONFORMANCE.md 缺失' };
  const has = ['设计偏离', '双层 trace', '需你裁定'].every(k => t.includes(k));
  return { passed: has, detail: has ? '含偏离说明与待裁定项' : '缺关键声明（设计偏离/双层 trace/待裁定）' };
});

// ═══ 输出 ═══
const jsonOnly = process.argv.slice(2).includes('--json');
const failed = results.filter(r => !r.passed);

if (jsonOnly) {
  process.stdout.write(JSON.stringify({ total: results.length, failed: failed.map(f => f.name), results }, null, 2) + '\n');
} else {
  console.log('=== 对照表完整性审计（只读产物，当场重算）===');
  for (const r of results) console.log(`  ${r.passed ? '✓' : '✗'} ${r.name}\n      ${r.detail}`);
  console.log(`\n通过 ${results.length - failed.length}/${results.length}`);
}
if (failed.length > 0) process.exit(1);
