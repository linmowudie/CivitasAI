#!/usr/bin/env node
/*
 * 实验矩阵覆盖率校验（Benchmarks/experimentMatrix.json 的守门脚本）
 *
 * 用法：
 *   node Scripts/experimentMatrix.cjs             # 常规校验（报告锚点强度，但有弱锚只警告）
 *   node Scripts/experimentMatrix.cjs --strict    # 弱锚（仅文件存在）也判违规 → CI 用
 *   node Scripts/experimentMatrix.cjs --json      # 机读输出（供 Scripts/benchMetrics.cjs 消费）
 *
 * 强制规则，违反任一 → 退出码非 0：
 *  1. 每个系统面至少 1 个 BEN（非对抗）且至少 1 个对抗（ENV/SEC）；gap / declared-only 不计入
 *     "落地"（`--strict` 下同）；`gap` 属**缺口证明实验**，oracle 今天必红，**不进 CI 阻断**。
 *  2. 每个对抗家族（injection/integrity/availability/privilege-escalation/
 *     governance-manipulation/data-poisoning）非空；
 *  3. 每个 cell 必须有 oracle；且 anchor **断言级**可解析：
 *       - existing-covered → anchor.kind=spec，文件存在，**且能在该文件内找到与 oracle 相称的
 *         断言**（`@matrix:<ID>` 标签 / `it()` 标题含 cell id / 标题与 oracle 的显著词重叠 ≥2）。
 *         这一条是本脚本从"查文件存在"升级到"查断言存在"的核心（qoder 文 §1.1「弱锚」）。
 *       - new-scaffold     → anchor.kind=tag 且标签出现在 Tests/Experiments/**；
 *       - gap              → 同上二选一，但**不参与 CI 阻断**（只统计与列出）；
 *       - declared-only    → anchor.kind=none（登记缺口，不产可运行断言）。
 *  4. 汇总对抗覆盖 / 缺口，输出锚点强度分布、实现缺口与陈旧检测所需数据。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
// 层规登记表（裁定①）需要直接读文件
const { join } = require('node:path');
const { readFileSync, existsSync } = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
/**
 * 矩阵文件路径可用 `--matrix=<path>` 覆盖。
 *
 * 为什么需要这个开关：守门脚本**必须有负向自测**。一个只会返回 0 的守门脚本
 * 与"守门通过"在输出上无法区分——这正是本项目反复出现的"假绿"。
 * 有了开关，`Benchmarks/runner/selftest.ts` 就能拿**故意写坏的矩阵**喂它，
 * 断言它真的报错（而不是静默放行）。
 */
const matrixArg = process.argv.slice(2).find(a => a.startsWith('--matrix='));
const MATRIX_PATH = matrixArg
  ? path.resolve(ROOT, matrixArg.split('=').slice(1).join('='))
  : path.join(ROOT, 'Benchmarks', 'experimentMatrix.json');
const EXPERIMENTS_DIR = path.join(ROOT, 'Tests', 'Experiments');
/**
 * Benchmark 场景目录 —— **实验矩阵 cell 的首选锚点来源**。
 *
 * 定位分界（用户口径）：Tests 测传统 bug 与业务（对象是函数/模块），
 * Benchmarks 测 Agent 能力（对象是"一个 Agent 跑一个任务"）。
 * 因此 Agent 能力 cell 的 anchor 指向**场景**；平台就绪检查（`prerequisites`）才锚 Tests/**。
 */
const scenarioArg = process.argv.slice(2).find(a => a.startsWith('--scenarios='));
const SCENARIO_DIR = scenarioArg
  ? path.resolve(ROOT, scenarioArg.split('=').slice(1).join('='))
  : path.join(ROOT, 'Benchmarks', 'scenarios');
const STATIC_RECON = path.join(ROOT, 'Scripts', 'staticRecon.cjs');

/**
 * 运行 L0 静态对账，拿到 {checkId → passed}。
 *
 * 为什么守门要读它：系统轴（九系统）里大量 cell 的判定点是**静态事实**
 * （"sandboxMode 无消费方"、"freezeWallet 零调用者"），场景压不到，只能靠 L0。
 * 双向一致性由此成立：
 *   · cell.status='existing-covered' → 对应 static 检查必须**通过**（锁成立）；
 *   · cell.status='gap'              → 对应 static 检查必须**失败**（缺口成立）；
 *     若检查通过了，说明产品把债还了而矩阵没转正 —— 那是**矩阵失真**，必须报错。
 */
function loadStaticResults() {
  try {
    const out = execFileSync(process.execPath, [STATIC_RECON, '--json'], { encoding: 'utf8' });
    const parsed = JSON.parse(out);
    const map = new Map();
    for (const c of parsed.checks || []) map.set(c.id, c);
    return map;
  } catch {
    // staticRecon 因 lock 漂移而非 0 退出时仍会输出 JSON，但这里保守返回空表，
    // 由 validateAnchor 把"静态锚无法解析"报成违规（而不是静默放行）。
    return new Map();
  }
}

const ARGS = process.argv.slice(2);
const STRICT = ARGS.includes('--strict');
const JSON_OUT = ARGS.includes('--json');

const REQUIRED_FIELDS = ['id', 'surface', 'cls', 'objective', 'method', 'oracle', 'module', 'gate', 'status', 'dim', 'anchor'];
const VALID_CLS = ['BEN', 'ENV', 'SEC'];
const VALID_STATUS = ['existing-covered', 'new-scaffold', 'declared-only', 'gap'];
const VALID_ATTESTATION = ['executed', 'static', 'tests', 'none'];
/** attestation 与 anchor.kind 的硬绑定（不可自由填） */
const ATTESTATION_OF_KIND = { scenario: 'executed', static: 'static', spec: 'tests', tag: 'tests', none: 'none' };
/** 落地（计入落地率）= existing-covered 且实测 */
const isLanded = (c) => c.status === 'existing-covered' && c.attestation === 'executed';
/** 仅静态对账通过：单列，不计入落地率 */
const isStaticAttested = (c) => c.status === 'existing-covered' && c.attestation === 'static';

/** gap / declared-only 不产生"跑得绿的断言"，不计入落地率分子 */
const NON_LANDED_STATUS = new Set(['gap', 'declared-only']);

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

/**
 * 收集 Benchmark 场景承载的 cell（`scenario.matrixCells`）。
 * 返回 Map<scenarioId, Set<cellId>>。
 */
function collectScenarioCells(dir) {
  const map = new Map();
  if (!fs.existsSync(dir)) return map;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const scenario = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (scenario && typeof scenario.id === 'string') {
        map.set(scenario.id, new Set(Array.isArray(scenario.matrixCells) ? scenario.matrixCells : []));
      }
    } catch { /* 场景文件损坏由运行器报错，这里不重复报 */ }
  }
  return map;
}

/**
 * 显著词元（与 Src/Services/Retrieval/textScore.ts 同口径）：
 * 拉丁/数字词元（≥3 字符）+ CJK bigram。用于"标题与 oracle 是否相称"的判定，
 * 避免中文没有空格导致的分词失效。
 */
function significantTokens(text) {
  const out = new Set();
  const lower = String(text || '').toLowerCase();
  for (const m of lower.matchAll(/[a-z0-9_]{3,}/g)) out.add(m[0]);
  for (const run of lower.match(/[\u4e00-\u9fff\u3400-\u4dbf]+/g) || []) {
    if (run.length === 1) { out.add(run); continue; }
    for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2));
  }
  return out;
}

/** 抽取 spec 文件里的用例标题 */
function extractCaseTitles(text) {
  const titles = [];
  const re = /\b(?:it|test)\s*(?:\.\w+)?\s*\(\s*(['"`])([\s\S]*?)\1/g;
  for (const m of text.matchAll(re)) titles.push(m[2]);
  return titles;
}

/**
 * 锚点强度评估。
 * @returns {{strength:'assertion'|'file-only'|'missing', evidence:string}}
 */
function evaluateSpecAnchor(cell, refPath, tags) {
  if (!fs.existsSync(refPath)) return { strength: 'missing', evidence: `文件不存在: ${cell.anchor.ref}` };
  if (tags.has(cell.id)) return { strength: 'assertion', evidence: `@matrix:${cell.id}` };

  const text = fs.readFileSync(refPath, 'utf8');
  const titles = extractCaseTitles(text);

  const idHit = titles.find(t => t.toLowerCase().includes(cell.id.toLowerCase()));
  if (idHit) return { strength: 'assertion', evidence: `it("${idHit.slice(0, 60)}") 标题含 cell id` };

  const oracleTokens = significantTokens(cell.oracle);
  for (const t of titles) {
    const titleTokens = significantTokens(t);
    const overlap = [...oracleTokens].filter(x => titleTokens.has(x));
    if (overlap.length >= 2) {
      return {
        strength: 'assertion',
        evidence: `it("${t.slice(0, 48)}") ∩ oracle{${overlap.slice(0, 4).join(',')}}`,
      };
    }
  }
  return {
    strength: 'file-only',
    evidence: `仅文件存在（${titles.length} 条用例标题均与 oracle 不相称）→ 弱锚`,
  };
}

/**
 * 校验一个 cell / prerequisite 的锚点可解析性。
 * @param kindOfSurface 用于报错措辞（'cell' | 'prerequisite'）
 */
function validateAnchor(entity, label, ctx, violations, warnings, anchorStrength) {
  const a = entity.anchor || {};
  const kind = entity.status;

  if (kind === 'existing-covered') {
    if (a.kind === 'static') {
      // ★ 九系统轴：L0 静态对账锚。锁必须成立。
      const chk = ctx.staticResults.get(a.ref);
      if (!chk) fail(violations, `${entity.id} static 锚无法解析: ${a.ref}（Scripts/staticRecon.cjs 无此检查）`);
      else if (chk.evidence === 'symbol') {
        // 证据强度铁律：只证明「符号/文件还在」的检查，不足以支撑行为性 oracle 的覆盖声明。
        // 修法二选一：把检查写强（去看真行为），或把 cell 如实降级为 gap。
        fail(violations, `${entity.id} 的 static 锚是 symbol 级证据（${chk.title}）—— 只证明符号存在，不足以支撑 existing-covered`);
      }
      else if (!chk.passed) {
        fail(violations, `${entity.id} 标 existing-covered 但静态检查未通过 → ${chk.title}：${chk.detail}`);
      } else anchorStrength.assertion += 1;
      return;
    }
    if (a.kind === 'scenario') {
      // ★ 新定位：Agent 能力 cell 锚定 Benchmark 场景（场景用 matrixCells 声明承载关系）
      const cells = ctx.scenarioCells.get(a.ref);
      if (!cells) {
        fail(violations, `${entity.id} anchor 场景不存在: ${a.ref}（Benchmarks/scenarios/）`);
      } else if (!cells.has(entity.id)) {
        fail(violations, `${entity.id} 场景 ${a.ref} 未声明承载该 ${label}（scenario.matrixCells 缺 ${entity.id}）`);
      } else {
        anchorStrength.assertion += 1;
      }
    } else if (a.kind === 'spec') {
      const ev = evaluateSpecAnchor(entity, path.join(ROOT, a.ref), ctx.tags);
      if (ev.strength === 'missing') fail(violations, `${entity.id} ${ev.evidence}`);
      else if (ev.strength === 'file-only') {
        anchorStrength['file-only'] += 1;
        ctx.weakAnchors.push(`${entity.id} → ${a.ref}（${ev.evidence}）`);
        if (STRICT) fail(violations, `${entity.id} 弱锚（--strict）：${ev.evidence}`);
      } else anchorStrength.assertion += 1;
    } else if (a.kind === 'tag') {
      if (!ctx.tags.has(entity.id)) fail(violations, `${entity.id} 标签未在 Tests/Experiments 出现: @matrix:${entity.id}`);
      else anchorStrength.assertion += 1;
    } else {
      fail(violations, `${entity.id} existing-covered 的 anchor.kind 应为 scenario / spec / tag，实际 ${a.kind}`);
    }
    return;
  }

  if (kind === 'new-scaffold') {
    // 三态语义：new-scaffold = 由**新写**的实验骨架承载（与 existing-covered 的「既有覆盖」相对）。
    // 新面一律用 `// @matrix:<ID>` 标签锚，禁用纯文件锚。
    if (a.kind !== 'tag') fail(violations, `${entity.id} new-scaffold 的 anchor.kind 应为 tag`);
    else if (!ctx.tags.has(entity.id)) fail(violations, `${entity.id} new-scaffold 标签未在 Tests/Experiments 出现: @matrix:${entity.id}`);
    else anchorStrength.assertion += 1;
    return;
  }

  if (kind === 'gap') {
    // 缺口证明实验：必须有可运行锚（否则无从证明缺口），但**不进 CI 阻断**
    if (a.kind === 'static') {
      const chk = ctx.staticResults.get(a.ref);
      if (!chk) fail(violations, `${entity.id} static 锚无法解析: ${a.ref}`);
      else if (chk.passed) {
        // 双向一致性：债已还却仍标 gap = 矩阵失真（会让人以为能力缺失）
        fail(violations, `${entity.id} 标 gap 但静态检查已通过 → 债已还，矩阵须转正为 existing-covered（${chk.title}）`);
      } else anchorStrength.assertion += 1;
      return;
    }
    if (a.kind === 'scenario') {
      const cells = ctx.scenarioCells.get(a.ref);
      if (!cells) warnings.push(`${entity.id}（gap）锚定场景不存在: ${a.ref}`);
      else if (!cells.has(entity.id)) warnings.push(`${entity.id}（gap）场景 ${a.ref} 尚未声明承载（缺口待补）`);
      else anchorStrength.assertion += 1;
    } else if (a.kind === 'tag') {
      if (!ctx.tags.has(entity.id)) warnings.push(`${entity.id}（gap）标签未落地 @matrix:${entity.id} —— 缺口尚未被实验承载`);
      else anchorStrength.assertion += 1;
    } else if (a.kind === 'spec') {
      const ev = evaluateSpecAnchor(entity, path.join(ROOT, a.ref), ctx.tags);
      if (ev.strength === 'missing') warnings.push(`${entity.id}（gap）锚定文件不存在: ${a.ref}`);
      else anchorStrength[ev.strength === 'assertion' ? 'assertion' : 'file-only'] += 1;
    } else {
      // kind='none'：缺口登记，尚无任何承载物（合法，计入 declared-only 口径）
      anchorStrength.none += 1;
    }
    return;
  }

  // declared-only
  if (a.kind !== 'none') fail(violations, `${entity.id} declared-only 的 anchor.kind 应为 none`);
  anchorStrength.none += 1;
}

function main() {
  const violations = [];
  const warnings = [];

  if (!fs.existsSync(MATRIX_PATH)) {
    console.error(`[experimentMatrix] 矩阵文件缺失: ${MATRIX_PATH}`);
    process.exit(1);
  }

  const matrix = JSON.parse(fs.readFileSync(MATRIX_PATH, 'utf8'));
  const cells = matrix.cells || [];
  const prerequisites = matrix.prerequisites || [];
  const surfaces = matrix.surfaces || [];
  const families = matrix.adversarialFamilies || [];
  const dims = matrix.dimensions || [];
  const tags = collectTags(EXPERIMENTS_DIR);
  const scenarioCells = collectScenarioCells(SCENARIO_DIR);
  const staticResults = loadStaticResults();

  // ── 规则 0：逐 cell 结构校验 + 锚点强度 ───────────
  const ids = new Set();
  const anchorStrength = { assertion: 0, 'file-only': 0, none: 0 };
  const weakAnchors = [];
  const ctx = { tags, scenarioCells, staticResults, weakAnchors };
  const prerequisiteIds = new Set();

  for (const cell of cells) {
    for (const f of REQUIRED_FIELDS) {
      if (cell[f] === undefined) fail(violations, `${cell.id || '?'} 缺字段 ${f}`);
    }
    if (ids.has(cell.id)) fail(violations, `重复 cell id: ${cell.id}`);
    ids.add(cell.id);
    if (!VALID_CLS.includes(cell.cls)) fail(violations, `${cell.id} cls 非法: ${cell.cls}`);
    // 双轴标签必填：漏标会让该 cell 在分轴统计里"消失"（合计对得上但某一轴偏少），
    // 实测漏标过两次 —— 靠自觉不成立，必须由守门强制。
    if (cell.axis !== 'capability' && cell.axis !== 'system') {
      fail(violations, `${cell.id} axis 非法或缺失: ${cell.axis ?? '(缺失)'}（应为 capability | system）`);
    }
    if (!VALID_STATUS.includes(cell.status)) fail(violations, `${cell.id} status 非法: ${cell.status}`);
    // 裁定⑤：系统轴 cell 必须声明它在 Agent 数据流转链路的哪一环
    if (cell.axis === 'system') {
      const STAGES = ['input', 'decide', 'act', 'remember', 'emit', 'output', 'none'];
      if (!STAGES.includes(cell.flowStage)) {
        fail(violations, `${cell.id} flowStage 非法或缺失: ${cell.flowStage ?? '(缺失)'}（应为 ${STAGES.join('|')}）`);
      } else if (cell.flowStage === 'none' && cell.status === 'existing-covered' && !/待实现/.test(cell.module ?? '')) {
        fail(violations, `${cell.id} 已落地却未声明链路阶段（flowStage=none，module=${String(cell.module).slice(0, 40)}）—— 必须说明它测链条哪一环`);
      }
    }
    // 静态与实测必须裁开 → attestation 必填，且与锚点类型硬绑定（不许自由填）
    if (!VALID_ATTESTATION.includes(cell.attestation)) {
      fail(violations, `${cell.id} attestation 非法或缺失: ${cell.attestation ?? '(缺失)'}（应为 executed|static|tests|none）`);
    } else {
      const expected = ATTESTATION_OF_KIND[(cell.anchor || {}).kind];
      if (expected && cell.attestation !== expected) {
        fail(violations, `${cell.id} attestation=${cell.attestation} 与其锚点类型 (anchor.kind=${(cell.anchor || {}).kind}) 不符 —— 应为 ${expected}`);
      }
    }
    // new-scaffold = 「我能做但还没做」：不得已有可运行锚（有锚就该是真跑或静态）
    if (cell.status === 'new-scaffold' && (cell.anchor || {}).kind !== 'none') {
      fail(violations, `${cell.id} new-scaffold 不应带可运行锚（anchor.kind=${(cell.anchor || {}).kind}）`);
    }
    if (!surfaces.includes(cell.surface)) fail(violations, `${cell.id} surface 未在 surfaces 声明: ${cell.surface}`);
    if (cell.dim && !dims.includes(cell.dim)) fail(violations, `${cell.id} dim 不在六维内: ${cell.dim}`);
    if (cell.cls !== 'BEN' && !cell.family) fail(violations, `${cell.id} 对抗 cell 缺 adversarialFamily`);
    if (cell.family && !families.includes(cell.family)) fail(violations, `${cell.id} family 非标准: ${cell.family}`);

    validateAnchor(cell, 'cell', ctx, violations, warnings, anchorStrength);
  }

  // ── 规则 0b：平台前置检查（对象是模块/接口，锚 Tests/**；与本层 Agent 能力 cell 分开）──
  for (const pre of prerequisites) {
    if (!pre.id) { fail(violations, 'prerequisite 缺 id'); continue; }
    if (prerequisiteIds.has(pre.id)) fail(violations, `重复 prerequisite id: ${pre.id}`);
    prerequisiteIds.add(pre.id);
    if (!VALID_STATUS.includes(pre.status)) fail(violations, `${pre.id} status 非法: ${pre.status}`);
    if (!VALID_ATTESTATION.includes(pre.attestation)) {
      fail(violations, `${pre.id} attestation 非法或缺失: ${pre.attestation ?? '(缺失)'}`);
    }
    validateAnchor(pre, 'prerequisite', ctx, violations, warnings, anchorStrength);
  }

  // ── 规则 0：实验设施的调用层规（裁定①）──
  // 层规：只能调用**被测层之上**的接口驱动实验；层下探针只用于监控、不用于驱动。
  // 这里强制的是"不许静默违规"：每条设施都要声明 driverEntry / layerUnderTest / compliant，
  // 非合规项必须带 reason 与 blockerSide（登记为可追踪的债）—— 否则违规会以"没人记得"的方式长期存在。
  const LR_PATH = join(__dirname, '..', 'Benchmarks', 'layerRules.json');
  if (!existsSync(LR_PATH)) {
    fail(violations, 'Benchmarks/layerRules.json 缺失 —— 实验设施的层规登记表是裁定①的落地载体');
  } else {
    try {
      const lr = JSON.parse(readFileSync(LR_PATH, 'utf8'));
      if (!Array.isArray(lr.facilities) || lr.facilities.length === 0) {
        fail(violations, 'layerRules.json 未登记任何实验设施');
      } else {
        for (const f of lr.facilities) {
          if (!f.id || !f.facility) fail(violations, 'layerRules: 设施缺 id/facility');
          if (!f.layerUnderTest) fail(violations, `layerRules ${f.id}: 缺 layerUnderTest（必须说明被测哪一层）`);
          if (!f.driverEntry) fail(violations, `layerRules ${f.id}: 缺 driverEntry（必须说明驱动入口在哪一层）`);
          if (typeof f.compliant !== 'boolean') fail(violations, `layerRules ${f.id}: 缺 compliant 布尔标记`);
          if (f.compliant === false) {
            if (!f.reason) fail(violations, `layerRules ${f.id}: 非合规项缺 reason`);
            if (!f.blockerSide) fail(violations, `layerRules ${f.id}: 非合规项缺 blockerSide（product|benchmark）`);
            if (!f.migration) fail(violations, `layerRules ${f.id}: 非合规项缺 migration（迁移方案）`);
          }
        }
      }
    } catch (e) {
      fail(violations, 'layerRules.json 解析失败: ' + (e instanceof Error ? e.message : String(e)));
    }
  }

  // ── 规则 1：每面 BEN + 对抗齐备（gap / declared-only 不计入落地）───
  for (const s of surfaces) {
    const inSurface = cells.filter(c => c.surface === s);
    // 面齐备以**实测落地**为准：仅静态对账通过不算（那是 Tests 领域的完备性核对）
    const landed = inSurface.filter(isLanded);
    const hasBen = landed.some(c => c.cls === 'BEN') || inSurface.some(c => c.cls === 'BEN');
    const hasAdv = landed.some(c => c.cls === 'ENV' || c.cls === 'SEC') || inSurface.some(c => c.cls === 'ENV' || c.cls === 'SEC');
    if (!hasBen) fail(violations, `面「${s}」缺非对抗(BEN) cell`);
    if (!hasAdv) fail(violations, `面「${s}」缺对抗(ENV/SEC) cell`);
  }

  // ── 规则 2：对抗家族全覆盖 ──────────────────────────
  for (const fam of families) {
    if (!cells.some(c => c.family === fam)) fail(violations, `对抗家族未被任何 cell 覆盖: ${fam}`);
  }

  // ── 规则 2b：场景声明的 matrixCells 必须真的存在 ────────
  // 反向一致性：此前只校验「cell → 场景」，所以场景写了不存在的 cell id 时无人发现
  // （实测踩到：cell 落地脚本被引号写坏 → 场景成了"孤儿声明"，守门照样通过）。
  for (const [scenarioId, declared] of scenarioCells) {
    for (const cellId of declared) {
      if (!ids.has(cellId)) {
        fail(violations, `场景 ${scenarioId} 声明承载 cell "${cellId}"，但矩阵中无此 cell（孤儿声明）`);
      }
    }
  }

  // ── 报告 ────────────────────────────────────────────
  const byCls = { BEN: 0, ENV: 0, SEC: 0 };
  const byStatus = { 'new-scaffold': 0, 'existing-covered': 0, 'declared-only': 0, gap: 0 };
  const gaps = [];
  const gapCells = [];
  for (const c of cells) {
    byCls[c.cls] = (byCls[c.cls] || 0) + 1;
    byStatus[c.status] = (byStatus[c.status] || 0) + 1;
    if (c.status === 'declared-only') gaps.push(`${c.id} (${c.module}) — ${c.oracle}`);
    if (c.status === 'gap') gapCells.push(`${c.id} (${c.module}) — ${c.oracle}`);
  }
  const adversarial = byCls.ENV + byCls.SEC;
  const coveredAdv = cells.filter(c => (c.cls === 'ENV' || c.cls === 'SEC') && isLanded(c)).length;
  const landedCells = cells.filter(isLanded).length;
  const staticAttested = cells.filter(isStaticAttested).length;
  /**
   * 状态 × 证据形态**交叉**统计。
   * 为什么不能只报 attestation：gap cell 的锚点是「为红的静态检查」，其 attestation 同样是 static，
   * 单看会把 20 条"缺口"读成"静态对账通过"（实际通过的是 existing-covered∩static 那 9 条）。
   */
  /** 调用层规合规概览（裁定①） */
  let layerCompliance = { total: 0, compliant: 0, violating: 0, violatingIds: [] };
  try {
    const lr = JSON.parse(readFileSync(join(__dirname, '..', 'Benchmarks', 'layerRules.json'), 'utf8'));
    const fs2 = lr.facilities || [];
    layerCompliance = {
      total: fs2.length,
      compliant: fs2.filter(f => f.compliant === true).length,
      violating: fs2.filter(f => f.compliant === false).length,
      violatingIds: fs2.filter(f => f.compliant === false).map(f => f.id),
    };
  } catch { /* 缺失时由规则 0 报违规 */ }

  const byStatusAttestation = {};
  for (const c of [...cells, ...prerequisites]) {
    const k = `${c.status}/${c.attestation ?? '(缺失)'}`;
    byStatusAttestation[k] = (byStatusAttestation[k] ?? 0) + 1;
  }

  const report = {
    version: matrix.version,
    layer: matrix.layer ?? 'layer-1-admission',
    cells: cells.length,
    /** 双轴拆分（供基线与人读报告区分"能力"与"系统"两类覆盖） */
    axes: {
      capability: cells.filter(c => c.axis === 'capability').length,
      system: cells.filter(c => c.axis === 'system').length,
    },
    prerequisites: prerequisites.length,
    surfaces: surfaces.length,
    families: families.length,
    byCls,
    byStatus,
    landedCells,
    staticAttested,
    byStatusAttestation,
    layerCompliance,
    landingRate: cells.length ? Number((landedCells / cells.length).toFixed(4)) : 0,
    adversarialCells: adversarial,
    adversarialLanded: coveredAdv,
    anchorStrength,
    weakAnchors,
    gaps,
    gapCells,
    warnings,
    violations,
    strict: STRICT,
  };

  if (JSON_OUT) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    console.log('=== Civitas-AI 实验矩阵（双轴 · Agent 能力 + 九系统）覆盖报告 ===');
    const cap = cells.filter(c => c.axis === 'capability').length;
    const sys = cells.filter(c => c.axis === 'system').length;
    console.log(`cell: ${cells.length}（能力轴 ${cap} + 系统轴 ${sys}）  |  面: ${surfaces.length}  |  对抗家族: ${families.length}`);
    console.log(`落地（实测 executed）: ${landedCells}（${(report.landingRate * 100).toFixed(1)}%）  |  仅静态对账 static-attested: ${staticAttested}（单列，不计入落地率）`);
    console.log(`平台前置检查: ${prerequisites.length} 条（锚 Tests/**，与两轴分开）`);
    console.log(`按类别: BEN=${byCls.BEN}  ENV=${byCls.ENV}  SEC=${byCls.SEC}`);
    console.log(`按状态: existing-covered=${byStatus['existing-covered']}  new-scaffold=${byStatus['new-scaffold']}  gap=${byStatus.gap}  declared-only=${byStatus['declared-only']}`);
    console.log(`锚点强度: 断言级=${anchorStrength.assertion}  仅文件存在=${anchorStrength['file-only']}  无锚=${anchorStrength.none}`);
    console.log(`对抗面落地率: ${coveredAdv}/${adversarial}（gap / declared-only 不计入落地）`);

    if (weakAnchors.length) {
      console.log(`\n-- 弱锚（仅文件存在，${STRICT ? '已判违规' : '警告；--strict 下判违规'}）--`);
      for (const w of weakAnchors) console.log(`  · ${w}`);
    }
    if (gapCells.length) {
      console.log('\n-- gap（缺口证明实验：oracle 今天必红，不进 CI 阻断）--');
      for (const g of gapCells) console.log(`  · ${g}`);
    }
    if (gaps.length) {
      console.log('\n-- declared-only 缺口（后续排期）--');
      for (const g of gaps) console.log(`  · ${g}`);
    }
    if (warnings.length) {
      console.log('\n-- 警告（不阻断）--');
      for (const w of warnings) console.log(`  · ${w}`);
    }
  }

  if (violations.length) {
    console.error(`\n✗ 覆盖校验失败，共 ${violations.length} 项${STRICT ? '（--strict）' : ''}：`);
    for (const v of violations) console.error(`  - ${v}`);
    process.exit(1);
  }

  if (!JSON_OUT) {
    console.log(`\n✓ 实验矩阵覆盖校验通过：每面 BEN+对抗齐备、六类对抗家族全覆盖、anchor 可解析${STRICT ? '（断言级）' : ''}。`);
  }
}

main();
