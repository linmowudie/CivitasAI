#!/usr/bin/env node
/*
 * NOT-RUN 汇总（落实九系统检验方案 §2.2 反假绿铁律 1）
 *
 * 问题：本仓 12 个用例在缺 `HUAWEI_MAAS_API_KEY` 时 `console.log('SKIP'); return;`
 * —— 在 vitest 眼里是**通过**。于是"单 Agent 端到端真实调用"从未在 CI 成立，
 * 却一直计入"已覆盖 / 已通过"。这是文档点名的**假绿**。
 *
 * 本脚本：
 *  1. 只跑**受门禁的 7 个 spec 文件**（快），让 `notRun()` 写出标记；
 *  2. 读 vitest 的 JSON reporter 拿到它自己的计数；
 *  3. 产出 `Benchmarks/baselines/notRun.json`：NOT-RUN 清单 + **有效通过数**
 *     （vitest 的 passed 减去未执行被测行为的那些）。
 *
 * 口径（写死在这里，避免各处算法不一）：
 *   effectivePassed = vitest.passed - notRunCount
 *   落地率分母包含 NOT-RUN —— 它们既不是失败，也**绝不是通过**。
 *
 * 用法：node Scripts/credentialNotRun.cjs [--json]
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'Benchmarks', 'baselines', 'notRun.json');
const RAW = path.join(ROOT, 'Benchmarks', 'baselines', 'notRun.raw.jsonl');
const TMP_REPORT = path.join(ROOT, 'Benchmarks', 'baselines', '.vitest-notrun.json');
const CREDENTIAL = 'HUAWEI_MAAS_API_KEY';

/** 受门禁的 spec 文件（含 `notRun()` 调用者）——由扫描得出，不手写清单 */
function gatedFiles() {
  const out = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full);
      else if (/\.(spec|test)\.tsx?$/.test(name) && /notRun\(/.test(fs.readFileSync(full, 'utf8'))) {
        out.push(path.relative(ROOT, full).replace(/\\/g, '/'));
      }
    }
  };
  walk(path.join(ROOT, 'Tests'));
  return out.sort();
}

function vitestEntry() {
  const pkgPath = require.resolve('vitest/package.json', { paths: [ROOT] });
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const binRel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin['vitest'];
  return path.join(path.dirname(pkgPath), binRel);
}

function main() {
  const jsonOnly = process.argv.slice(2).includes('--json');
  const files = gatedFiles();

  if (fs.existsSync(RAW)) fs.rmSync(RAW);
  if (fs.existsSync(TMP_REPORT)) fs.rmSync(TMP_REPORT);

  let vitestCounts = { testFiles: null, tests: null, passed: null, failed: null };
  let runError = null;
  try {
    execFileSync(process.execPath, [
      vitestEntry(), 'run', ...files,
      '--reporter=json', `--outputFile=${TMP_REPORT}`,
    ], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15 * 60_000 });
  } catch (e) {
    runError = `vitest 退出非 0（${e.status ?? '?'}）—— 受门禁用例本身有失败，需先修`;
  }

  if (fs.existsSync(TMP_REPORT)) {
    const rep = JSON.parse(fs.readFileSync(TMP_REPORT, 'utf8'));
    vitestCounts = {
      testFiles: rep.numTotalTestSuites ?? null,
      tests: rep.numTotalTests ?? null,
      passed: rep.numPassedTests ?? null,
      failed: rep.numFailedTests ?? null,
    };
    fs.rmSync(TMP_REPORT);
  }

  const notRun = fs.existsSync(RAW)
    ? fs.readFileSync(RAW, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
    : [];

  const payload = {
    generatedAt: new Date().toISOString(),
    generatedBy: 'Scripts/credentialNotRun.cjs',
    credential: CREDENTIAL,
    credentialPresent: Boolean(process.env[CREDENTIAL] && process.env[CREDENTIAL].trim()),
    gatedFiles: files,
    gatedFileCount: files.length,
    vitest: vitestCounts,
    notRun,
    notRunCount: notRun.length,
    /** **有效通过** = vitest 的 passed 减去未执行被测行为的用例 */
    effectivePassed: vitestCounts.passed === null ? null : Math.max(0, vitestCounts.passed - notRun.length),
    rule: 'effectivePassed = vitest.passed - notRunCount；NOT-RUN 既不是失败，也绝不是通过（§2.2 铁律 1）',
    ...(runError ? { error: runError } : {}),
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  if (fs.existsSync(RAW)) fs.rmSync(RAW);

  if (jsonOnly) {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    return;
  }

  console.log('=== NOT-RUN 汇总（缺凭据未执行被测行为的用例）===');
  console.log(`凭据 ${CREDENTIAL}: ${payload.credentialPresent ? '已设置' : '未设置'}`);
  console.log(`受门禁文件 ${files.length} 个；vitest 报 passed=${vitestCounts.passed} / failed=${vitestCounts.failed}`);
  console.log(`NOT-RUN ${notRun.length} 条 → **有效通过 ${payload.effectivePassed}**`);
  for (const n of notRun) console.log(`  · ${n.test}`);
  if (runError) console.log(`\n注意：${runError}`);
  console.log(`\n写入: Benchmarks/baselines/notRun.json`);
}

main();
