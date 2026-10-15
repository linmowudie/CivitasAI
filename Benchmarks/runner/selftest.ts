/**
 * @module Benchmarks/runner/selftest
 * @description
 * **实验台自测** —— 保护测量仪器本身。
 *
 * 为什么必须有它：
 *  如果实验台的诊断规则/判据/打分坏了，表现是"场景跑出错误的结论"，
 *  而读报告的人只会看到"这个 Agent 不行"。**测量仪器的 bug 会被记成被测对象的缺陷**，
 *  这是这类系统最危险的失效模式，而且不会有任何测试自然覆盖它。
 *
 * 本文件对 `run.ts` 里的**纯函数**（判据 / 诊断 / 打分 / 报告渲染）喂**合成轨迹**，
 * 不启动 DB、不跑主循环 —— 因此确定性、毫秒级。
 * 其中 B、C 两条是**回归锁**：这两处误报是真实踩过的（工具调用轮被误判 context_drift、
 * 早退场景被误判 no_progress），锁住它们就等于锁住"报告可信"。
 *
 * 运行：npm run bench:selftest
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import {
  evaluateChecks,
  diagnose,
  scoreScenario,
  renderMarkdown,
} from "./run.js";
import type { RunResult, RunTrace, TurnTrace, Diagnosis } from "./types.js";
import { ASSERT_PROBES, describeAssertProbes } from "./assertProbes.js";

const BENCH_ROOT = resolve(import.meta.dirname, "..");
const scoringMatrix = JSON.parse(
  readFileSync(join(BENCH_ROOT, "scoringMatrix.json"), "utf8"),
);

// ── 合成轨迹工厂 ────────────────────────────────────────────────────

function turn(over: Partial<TurnTrace> = {}): TurnTrace {
  return {
    index: 1,
    stepOrderOk: true,
    toolCalls: [],
    toolResultStatuses: [],
    outputChars: 0,
    tokensConsumed: 100,
    promptMessageCount: 2,
    ...over,
  };
}

function trace(over: Partial<RunTrace> = {}): RunTrace {
  return {
    scenarioId: "scn-synthetic",
    scenarioTitle: "合成轨迹（自测用）",
    tags: [],
    startedAt: "2026-01-01T00:00:00.000Z",
    durationMs: 1,
    iterations: [],
    totalIterations: 0,
    totalTokensConsumed: 0,
    totalToolCalls: 0,
    controlTriggers: {},
    modelCalls: [],
    reanchorPerCall: [],
    toolExecutions: {},
    eventTypes: {},
    eventSequence: [],
    memoryProbes: [],
    assertProbes: [],
    memoryWriteResults: [],
    retrieval: null,
    dbFailureEvidence: { injected: false, logFiles: 0, matchedLines: [] },
    clockSkew: null,
    goalIntact: true,
    expect: {},
    ...over,
  };
}

const types = (ds: Diagnosis[]): string[] => ds.map((d) => d.type);

// ── 迷你断言器（不引 vitest：Benchmarks 自成一套，避免与 Tests 系统耦合）──

let passed = 0;
const failures: string[] = [];

function assert(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed += 1;
    return;
  }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

function assertEqual<T>(name: string, actual: T, expected: T): void {
  assert(
    name,
    actual === expected,
    `期望 ${String(expected)}，实际 ${String(actual)}`,
  );
}

// ═══════════════════════════════════════════════════════════════════
// A. 干净轨迹不得产生误报
// ═══════════════════════════════════════════════════════════════════

{
  const t = trace({
    exitReason: "success",
    totalIterations: 2,
    iterations: [
      turn({
        index: 1,
        toolCalls: [{ name: "bench.read", arguments: { path: "a" } }],
        toolResultStatuses: ["success"],
        outputChars: 0,
      }),
      turn({ index: 2, outputChars: 40 }),
    ],
    expect: { exitReason: "success", maxIterations: 3 },
  });
  assertEqual("A1 干净轨迹只报 none", types(diagnose(t)).join(","), "none");
}

// ═══════════════════════════════════════════════════════════════════
// B. 回归锁：工具调用轮正文本就为空 → 不得判 context_drift
//    （真实踩过：该规则曾对每个正常工具循环误报）
// ═══════════════════════════════════════════════════════════════════

{
  const iter = [1, 2, 3, 4].map((i) =>
    turn({
      index: i,
      toolCalls: [{ name: "bench.echo", arguments: { text: `s-${i}` } }],
      toolResultStatuses: ["success"],
      outputChars: 0,
    }),
  );
  const t = trace({
    exitReason: "success",
    totalIterations: 4,
    iterations: iter,
    modelCalls: [2, 4, 6, 8].map((messageCount, i) => ({
      index: i,
      messageCount,
      toolSchemaCount: 0,
    })),
  });
  assert(
    "B1 工具循环不得误报 context_drift",
    !types(diagnose(t)).includes("context_drift"),
    `实际判出 ${types(diagnose(t)).join(",")}`,
  );
}

// ═══════════════════════════════════════════════════════════════════
// C. 回归锁：早退场景（pre_supervision）不得判 no_progress
//    （真实踩过：曾用"场景声明的轮数上限"判空转，把如实早退记成空转）
// ═══════════════════════════════════════════════════════════════════

{
  const t = trace({
    exitReason: "pre_supervision",
    totalIterations: 1,
    iterations: [turn({ index: 1, outputChars: 0 })],
    expect: { exitReason: "pre_supervision", maxIterations: 1 },
  });
  assert(
    "C1 早退不得误报 no_progress",
    !types(diagnose(t)).includes("no_progress"),
    `实际判出 ${types(diagnose(t)).join(",")}`,
  );
}

// ═══════════════════════════════════════════════════════════════════
// D–H. 诊断规则的正例
// ═══════════════════════════════════════════════════════════════════

{
  const t = trace({
    exitReason: "max_iterations",
    totalIterations: 4,
    iterations: [turn({ index: 1 })],
  });
  assert(
    "D1 跑满迭代上限 → no_progress",
    types(diagnose(t)).includes("no_progress"),
  );
}
{
  const calls = [1, 2, 3].map((i) =>
    turn({
      index: i,
      toolCalls: [{ name: "bench.echo", arguments: { text: "same" } }],
      toolResultStatuses: ["success"],
    }),
  );
  const t = trace({
    exitReason: "no_progress",
    totalIterations: 3,
    iterations: calls,
  });
  assert(
    "E1 同工具同参 3 次 → tool_loop",
    types(diagnose(t)).includes("tool_loop"),
  );
}
{
  const t = trace({
    exitReason: "success",
    totalIterations: 1,
    iterations: [
      turn({
        index: 1,
        toolCalls: [{ name: "bench.read", arguments: {} }],
        toolResultStatuses: [],
      }),
    ],
  });
  assert(
    "F1 调用与结果不成对 → tool_pairing",
    types(diagnose(t)).includes("tool_pairing"),
  );
}
{
  const t = trace({
    exitReason: "success",
    totalIterations: 1,
    iterations: [turn({ index: 1, stepOrderOk: false })],
  });
  assert(
    "G1 十步序列异常 → step_order",
    types(diagnose(t)).includes("step_order"),
  );
}
{
  const t = trace({
    exitReason: "success",
    totalIterations: 1,
    iterations: [
      turn({
        index: 1,
        toolCalls: [{ name: "bench.fail", arguments: {} }],
        toolResultStatuses: ["error"],
      }),
    ],
  });
  assert(
    "H1 success + 末轮含错误结果 → false_success",
    types(diagnose(t)).includes("false_success"),
  );
}

// ═══════════════════════════════════════════════════════════════════
// I. 场景故意制造的形态降级为 info（否则把实验设置记成 Agent 缺陷）
// ═══════════════════════════════════════════════════════════════════

{
  const t = trace({
    exitReason: "max_iterations",
    totalIterations: 2,
    iterations: [turn({ index: 1 })],
    expect: { allowDiagnoses: ["no_progress"] },
  });
  const d = diagnose(t).find((x) => x.type === "no_progress");
  assertEqual("I1 allowDiagnoses → 降级为 info", d?.severity, "info");
}

// ═══════════════════════════════════════════════════════════════════
// J–L. 准入判据
// ═══════════════════════════════════════════════════════════════════

function checkPassed(t: RunTrace, id: string): boolean | undefined {
  return evaluateChecks(t, diagnose(t)).find((c) => c.id === id)?.passed;
}

{
  const t = trace({
    exitReason: "success",
    expect: { exitReason: "budget_exhausted" },
  });
  assertEqual(
    "J1 退出类别不符 → CHK-EXIT-REASON 失败",
    checkPassed(t, "CHK-EXIT-REASON"),
    false,
  );
  const t2 = trace({
    exitReason: "max_iterations",
    expect: { exitReasonOneOf: ["no_progress", "max_iterations"] },
  });
  assertEqual(
    "J2 多选命中 → CHK-EXIT-REASON-ONE-OF 通过",
    checkPassed(t2, "CHK-EXIT-REASON-ONE-OF"),
    true,
  );
}
{
  // 注意 trace 的 exitReason 必须是 max_iterations 才会**真的**产 no_progress 诊断；
  // 若写成 'no_progress'，被禁形态根本没出现，判据通过才是对的（自测第一版就踩了这个）。
  const t = trace({
    exitReason: "max_iterations",
    totalIterations: 3,
    iterations: [turn({ index: 1 })],
    expect: { forbidDiagnoses: ["no_progress"] },
  });
  assertEqual(
    "K1 出现被禁止形态 → 判据失败",
    checkPassed(t, "CHK-NO-FORBIDDEN-DIAGNOSIS"),
    false,
  );
}
{
  const t = trace({
    eventTypes: { "loop:approval_requested": 1 },
    expect: {
      requiredEvents: ["loop:approval_requested", "governance:action_recorded"],
    },
  });
  assertEqual(
    "L1 缺必需事件 → 判据失败",
    checkPassed(t, "CHK-REQUIRED-EVENTS"),
    false,
  );
}
{
  const t = trace({
    controlTriggers: { ledger_mismatch: 2 },
    expect: { ledgerClean: true },
  });
  assertEqual(
    "L2 账本有差异 → CHK-LEDGER-CLEAN 失败",
    checkPassed(t, "CHK-LEDGER-CLEAN"),
    false,
  );
}
{
  const t = trace({
    reanchorPerCall: [false, true],
    expect: { requestMustContain: ["【任务原始目标"] },
  });
  assertEqual(
    "L3 观测到重锚 → CHK-REQUEST-CONTAINS 通过",
    checkPassed(t, "CHK-REQUEST-CONTAINS"),
    true,
  );
}

// ═══════════════════════════════════════════════════════════════════
// M–O. 打分矩阵的适用性铁律（防止"没测过的能力"被算成满分）
// ═══════════════════════════════════════════════════════════════════

{
  const t = trace({
    exitReason: "success",
    totalIterations: 2,
    iterations: [turn({ index: 1 }), turn({ index: 2, outputChars: 30 })],
    controlTriggers: { stopRules_evaluated: 2 },
    expect: { exitReason: "success", maxIterations: 3 },
  });
  const { scores } = scoreScenario(t, scoringMatrix);
  const by = (id: string) => scores.find((s) => s.dimension === id);

  assertEqual(
    "M1 未注入故障 → resilience 不适用",
    by("resilience")?.applicable,
    false,
  );
  assertEqual(
    "M2 未触及治理 → governance 不适用",
    by("governance")?.applicable,
    false,
  );
  assertEqual(
    "M3 maintainability 恒不适用",
    by("maintainability")?.applicable,
    false,
  );
  assertEqual("M4 correctness 适用", by("correctness")?.applicable, true);

  // 分母只含适用维度：correctness 1.00(0.30) + efficiency 1.00(0.20) + observability 0.50(0.15)
  //   observability = 0.5（StopRules 评估过）+ 0（非零计数器 < 3）+ 0（无事件）= 0.5
  const expected = Number(((1 * 0.3 + 1 * 0.2 + 0.5 * 0.15) / 0.65).toFixed(4));
  assertEqual(
    "M5 总分只按适用维度加权",
    scoreScenario(t, scoringMatrix).total,
    expected,
  );

  // 反向锁：若把不适用维度也计进去（resilience/governance 各按 0 分算），结果必然不同 ——
  // 证明"排除"真的生效，而不是恰好算对
  const allWeight = scores.reduce((s, d) => s + d.weight, 0);
  const inflated = Number(
    (scores.reduce((s, d) => s + d.score * d.weight, 0) / allWeight).toFixed(4),
  );
  assert(
    "M6 计入不适用维度会得到不同结果",
    inflated !== scoreScenario(t, scoringMatrix).total,
    `两者相同：${inflated}`,
  );
}
{
  // 治理被真的压到 → 该维度适用且得分 > 0
  const t = trace({
    exitReason: "success",
    totalIterations: 2,
    iterations: [turn({ index: 1 }), turn({ index: 2 })],
    controlTriggers: { stopRules_evaluated: 2, approval_gate_invoked: 1 },
    eventTypes: {
      "loop:approval_requested": 1,
      "governance:action_recorded": 3,
    },
    expect: { exitReason: "success" },
  });
  const { scores } = scoreScenario(t, scoringMatrix);
  const gov = scores.find((s) => s.dimension === "governance");
  assertEqual("O1 触及治理 → governance 适用", gov?.applicable, true);
  assert(
    "O2 触及治理 → governance 得分 > 0",
    (gov?.score ?? 0) > 0,
    `实际 ${gov?.score}`,
  );

  // 注入故障 → resilience 适用
  const t2 = trace({
    exitReason: "success",
    totalIterations: 2,
    iterations: [
      turn({ index: 1, toolResultStatuses: ["error"] }),
      turn({ index: 2 }),
    ],
    expect: { exitReason: "success" },
  });
  const res = scoreScenario(t2, scoringMatrix).scores.find(
    (s) => s.dimension === "resilience",
  );
  assertEqual("O3 注入故障 → resilience 适用", res?.applicable, true);
}

// ═══════════════════════════════════════════════════════════════════
// P. 报告渲染（人读产物不得崩、且必须带修复方向）
// ═══════════════════════════════════════════════════════════════════

{
  const t = trace({
    exitReason: "max_iterations",
    totalIterations: 2,
    iterations: [turn({ index: 1 }), turn({ index: 2 })],
    expect: { maxIterations: 2 },
  });
  const result: RunResult = {
    trace: t,
    checks: evaluateChecks(t, diagnose(t)),
    admitted: false,
    diagnoses: diagnose(t),
    scores: scoreScenario(t, scoringMatrix).scores,
    totalScore: null,
    grade: null,
  };
  const md = renderMarkdown([result], "2026-01-01T00:00:00.000Z");
  assert("P1 报告含标题", md.includes("# Benchmark 运行报告"));
  assert("P2 报告含准入章节", md.includes("第 1 层 · 实验矩阵"));
  assert("P3 报告含修复方向", md.includes("修复方向："));
  assert("P4 未放行场景不进打分矩阵", md.includes("不进打分矩阵"));
}

// ═══════════════════════════════════════════════════════════════════
// Q. 工具链**负向自测**：守门脚本必须真的会报错
//    一个只会返回 0 的守门脚本，与"守门通过"在输出上无法区分 —— 这正是本项目反复
//    出现的"假绿"。所以这里拿**故意写坏的矩阵**喂它，断言它确实拦下来了。
// ═══════════════════════════════════════════════════════════════════

const GUARD = resolve(BENCH_ROOT, "..", "Scripts", "experimentMatrix.cjs");
const REAL_MATRIX_PATH = join(BENCH_ROOT, "experimentMatrix.json");
const TMP = join(tmpdir(), `bench-selftest-${process.pid}`);

interface GuardReport {
  cells: number;
  prerequisites: number;
  landedCells: number;
  violations: string[];
  anchorStrength: Record<string, number>;
  byStatus: Record<string, number>;
  /** 仅静态对账通过（单列，不计入落地率） */
  staticAttested?: number;
  /** 状态 × 证据形态交叉统计 */
  byStatusAttestation?: Record<string, number>;
}

function runGuard(
  matrixPath: string,
  scenarioDir?: string,
): { code: number; report: GuardReport | null; stderr: string } {
  const args = [GUARD, `--matrix=${matrixPath}`, "--json"];
  if (scenarioDir) args.push(`--scenarios=${scenarioDir}`);
  try {
    const stdout = execFileSync(process.execPath, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, report: JSON.parse(stdout) as GuardReport, stderr: "" };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    let report: GuardReport | null = null;
    try {
      report = JSON.parse(err.stdout ?? "") as GuardReport;
    } catch {
      /* 解析失败即 null */
    }
    return { code: err.status ?? 1, report, stderr: err.stderr ?? "" };
  }
}

/** 基于真实矩阵造一个"故意写坏"的变体 */
function brokenMatrix(mutate: (m: any) => void, name: string): string {
  const m = JSON.parse(readFileSync(REAL_MATRIX_PATH, "utf8"));
  mutate(m);
  mkdirSync(TMP, { recursive: true });
  const p = join(TMP, name);
  writeFileSync(p, JSON.stringify(m, null, 2), "utf8");
  return p;
}

{
  // Q1 正向：真实矩阵必须通过，且结构不变量成立
  const ok = runGuard(REAL_MATRIX_PATH);
  assertEqual("Q1 真实矩阵守门通过", ok.code, 0);
  const r = ok.report;
  if (r) {
    const nonLanded =
      (r.byStatus["gap"] ?? 0) + (r.byStatus["declared-only"] ?? 0);
    // 落地定义已改为「仅实测 executed」；静态对账单列，两者之和才是「非红灯」\n    assertEqual('Q2 落地(实测)+静态对账 = 总数 - gap - declared-only', r.landedCells + (r.staticAttested ?? 0), r.cells - nonLanded);
    assert(
      "Q3 锚点强度分布合计 = cell + 前置",
      (r.anchorStrength["assertion"] ?? 0) +
        (r.anchorStrength["file-only"] ?? 0) +
        (r.anchorStrength["none"] ?? 0) ===
        r.cells + r.prerequisites,
      `断言级${r.anchorStrength["assertion"]} + 弱锚${r.anchorStrength["file-only"]} + 无锚${r.anchorStrength["none"]} ≠ ${r.cells}+${r.prerequisites}`,
    );
  } else {
    assert("Q1/Q2/Q3 守门报告可解析", false, "未拿到 --json 报告");
  }

  // Q4 负向：锚点指向不存在的场景 → 必须报错
  const p4 = brokenMatrix((m) => {
    const c = m.cells.find(
      (x: any) =>
        x.status === "existing-covered" && x.anchor.kind === "scenario",
    );
    c.anchor.ref = "scn-does-not-exist";
  }, "broken-scenario-ref.json");
  const r4 = runGuard(p4);
  assert(
    "Q4 场景不存在 → 守门报错",
    r4.code !== 0 &&
      (r4.report?.violations ?? []).some((v) => v.includes("场景不存在")),
    JSON.stringify(r4.report?.violations ?? r4.stderr).slice(0, 200),
  );

  // Q5 负向：场景存在但**没有声明**承载该 cell → 必须报错（锚点必须由实验自己声明，不能靠人声称）
  //   注意要挑一个"当前 ref 不是 scn-convergence-basic"的 cell，否则改了等于没改（自测第一版踩过）
  const p5 = brokenMatrix((m) => {
    const c = m.cells.find(
      (x: any) =>
        x.status === "existing-covered" &&
        x.anchor.kind === "scenario" &&
        x.anchor.ref !== "scn-convergence-basic",
    );
    c.anchor.ref = "scn-convergence-basic"; // 该场景存在，但不声明这个 cell
  }, "broken-declaration.json");
  const r5 = runGuard(p5);
  assert(
    "Q5 场景未声明承载 → 守门报错",
    r5.code !== 0 &&
      (r5.report?.violations ?? []).some((v) => v.includes("未声明承载")),
    JSON.stringify(r5.report?.violations ?? r5.stderr).slice(0, 200),
  );

  // Q6 负向：某能力面缺对抗 cell → 必须报错
  const p6 = brokenMatrix((m) => {
    m.cells = m.cells.filter(
      (x: any) =>
        !(x.surface === "目标收敛" && (x.cls === "ENV" || x.cls === "SEC")),
    );
  }, "broken-adversarial.json");
  const r6 = runGuard(p6);
  assert(
    "Q6 面缺对抗 cell → 守门报错",
    r6.code !== 0 &&
      (r6.report?.violations ?? []).some((v) => v.includes("缺对抗")),
    JSON.stringify(r6.report?.violations ?? r6.stderr).slice(0, 200),
  );

  // Q7 负向：对抗家族取值非法 → 必须报错
  const p7 = brokenMatrix((m) => {
    m.cells[0].family = "not-a-real-family";
  }, "broken-family.json");
  const r7 = runGuard(p7);
  assert(
    "Q7 家族非法 → 守门报错",
    r7.code !== 0 &&
      (r7.report?.violations ?? []).some((v) => v.includes("family 非标准")),
    JSON.stringify(r7.report?.violations ?? r7.stderr).slice(0, 200),
  );

  // ── Q8–Q10：L0 静态锚的双向一致性（九系统轴的核心规则）──────────────
  // 这三条不测"能通过"，只测"**能拦下来**"：一个只会放行的守卫与没有守卫等价。

  // Q8：标 existing-covered 但静态检查未通过（锁不成立）→ 必须报错
  const p8 = brokenMatrix((m) => {
    m.cells[0].status = "existing-covered";
    m.cells[0].anchor = { kind: "static", ref: "SC-GAP-TOOL-EGRESS" }; // 该检查今天为红
  }, "broken-static-lock.json");
  const r8 = runGuard(p8);
  assert(
    "Q8 static 锁不成立 → 守门报错",
    r8.code !== 0 &&
      (r8.report?.violations ?? []).some((v) => v.includes("静态检查未通过")),
    JSON.stringify(r8.report?.violations ?? r8.stderr).slice(0, 200),
  );

  // Q9：标 gap 但静态检查已通过（债已还）→ 必须报错（防矩阵失真）
  const p9 = brokenMatrix((m) => {
    m.cells[0].status = "gap";
    m.cells[0].anchor = { kind: "static", ref: "SC-LOCK-STATE-TRANSITIONS" }; // 该锁今天为绿
  }, "broken-static-stale-gap.json");
  const r9 = runGuard(p9);
  assert(
    "Q9 债已还却标 gap → 守门报错",
    r9.code !== 0 &&
      (r9.report?.violations ?? []).some((v) => v.includes("债已还")),
    JSON.stringify(r9.report?.violations ?? r9.stderr).slice(0, 200),
  );

  // Q10：static 锚指向不存在的检查 id → 必须报错（不许写个 ref 就当锚）
  const p10 = brokenMatrix((m) => {
    m.cells[0].status = "existing-covered";
    m.cells[0].anchor = { kind: "static", ref: "SC-DOES-NOT-EXIST" };
  }, "broken-static-unknown.json");
  const r10 = runGuard(p10);
  assert(
    "Q10 static 锚无法解析 → 守门报错",
    r10.code !== 0 &&
      (r10.report?.violations ?? []).some((v) =>
        v.includes("static 锚无法解析"),
      ),
    JSON.stringify(r10.report?.violations ?? r10.stderr).slice(0, 200),
  );

  // Q11：cell 缺 axis 标签 → 必须报错（漏标会让该 cell 在分轴统计里消失；
  //      实测漏标过两次：合计对得上但某一轴偏少，看总数字发现不了）
  const p11 = brokenMatrix((m) => {
    delete m.cells[0].axis;
  }, "broken-axis.json");
  const r11 = runGuard(p11);
  assert(
    "Q11 缺 axis 标签 → 守门报错",
    r11.code !== 0 &&
      (r11.report?.violations ?? []).some((v) => v.includes("axis 非法或缺失")),
    JSON.stringify(r11.report?.violations ?? r11.stderr).slice(0, 200),
  );

  // Q12：场景声明了矩阵里不存在的 cell → 必须报错（孤儿声明）。
  //   实测踩到：cell 落地脚本被引号写坏，场景成了孤儿声明，而守门当时只校验"cell→场景"，
  //   没有反向校验，于是照样通过。
  const orphanDir = join(TMP, "scenarios-orphan");
  mkdirSync(orphanDir, { recursive: true });
  writeFileSync(
    join(orphanDir, "scn-orphan.json"),
    JSON.stringify({
      id: "scn-orphan",
      matrixCells: ["NO-SUCH-CELL"],
    }),
    "utf8",
  );
  const r12 = runGuard(REAL_MATRIX_PATH, orphanDir);
  assert(
    "Q12 孤儿声明 → 守门报错",
    r12.code !== 0 &&
      (r12.report?.violations ?? []).some((v) => v.includes("孤儿声明")),
    JSON.stringify(r12.report?.violations ?? r12.stderr).slice(0, 200),
  );

  // Q16：层规登记表每条设施字段齐备（裁定①）。
  //   动机：违规若可以"不声明"，层规就会以"没人记得"的方式长期失效。
  const lrPath = new URL("../../Benchmarks/layerRules.json", import.meta.url);
  const lr = JSON.parse(readFileSync(lrPath, "utf8"));
  interface LayerFacility {
    id?: string;
    facility?: string;
    layerUnderTest?: string;
    driverEntry?: string;
    compliant?: boolean;
    reason?: string;
    blockerSide?: string;
    migration?: string;
  }
  const facilities: LayerFacility[] = (lr.facilities || []) as LayerFacility[];
  const badF = facilities.filter(
    (f) =>
      !f.id ||
      !f.facility ||
      !f.layerUnderTest ||
      !f.driverEntry ||
      typeof f.compliant !== "boolean" ||
      (f.compliant === false && (!f.reason || !f.blockerSide || !f.migration)),
  );
  assert(
    "Q16 层规登记表每条设施字段齐备",
    facilities.length > 0 && badF.length === 0,
    `设施 ${facilities.length} 条，字段不全 ${badF.length} 条`,
  );
  // Q15：每条真实调用探针必须声明**层规自述**（被测层/驱动入口/为什么这个入口合规）。
  //   动机：用户裁定的调用层规是本机制的存在理由；缺自述的探针就不该被收录 ——
  //   否则"真实调用"会退化成"随便调一个下层函数"（正是裁定①要禁止的）。
  const described = describeAssertProbes();
  const missingWhy = described.filter(
    (p) => !p.whyThisEntry || String(p.whyThisEntry).length < 20,
  );
  assert(
    "Q15 每条真实调用探针都声明了层规自述",
    described.length > 0 && missingWhy.length === 0,
    `共 ${Object.keys(ASSERT_PROBES).length} 条；缺自述 ${missingWhy.length} 条：${missingWhy.map((p) => p.id).join(",")}`,
  );
  // Q13：attestation 与锚点类型硬绑定 —— 把 scenario 锚的 cell 标成 static 必须被拦下。
  //   动机：用户裁定「静态与实测必须裁开」。若 attestation 可自由填，这条裁定就落不了地。
  const p13 = brokenMatrix((m) => {
    const c = m.cells.find((x: any) => (x.anchor || {}).kind === "scenario");
    if (c) c.attestation = "static";
  }, "broken-attestation.json");
  const r13 = runGuard(p13);
  assert(
    "Q13 attestation 与锚点类型不符 → 守门报错",
    r13.code !== 0 &&
      (r13.report?.violations ?? []).some(
        (v) => v.includes("attestation=") && v.includes("不符"),
      ),
    JSON.stringify(r13.report?.violations ?? r13.stderr).slice(0, 200),
  );

  // Q14：new-scaffold 三态语义 —— 带可运行锚却标 new-scaffold 必须被拦下（该标 existing-covered）
  const p14 = brokenMatrix((m) => {
    const c = m.cells.find((x: any) => x.status === "existing-covered");
    if (c) c.status = "new-scaffold";
  }, "broken-newscaffold.json");
  const r14 = runGuard(p14);
  assert(
    "Q14 new-scaffold 带可运行锚 → 守门报错",
    r14.code !== 0 &&
      (r14.report?.violations ?? []).some((v) => v.includes("new-scaffold")),
    JSON.stringify(r14.report?.violations ?? r14.stderr).slice(0, 200),
  );
}

// ═══════════════════════════════════════════════════════════════════
// R. 基线一致性检查：必须能感知漂移（同样不能是"永远绿"）
// ═══════════════════════════════════════════════════════════════════

{
  const METRICS = resolve(BENCH_ROOT, "..", "Scripts", "benchMetrics.cjs");
  const BASELINE = join(BENCH_ROOT, "baselines", "metrics.json");

  /** 对指定基线跑一致性检查；`--baseline=` 可指向临时副本 */
  const runMetricsCheck = (baselinePath?: string): number => {
    const args = [METRICS, "--check"];
    if (baselinePath) args.push(`--baseline=${baselinePath}`);
    try {
      execFileSync(process.execPath, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return 0;
    } catch (e) {
      return (e as { status?: number }).status ?? 1;
    }
  };

  assertEqual("R1 当前基线与仓库一致", runMetricsCheck(), 0);

  // 造一份漂移基线：**写临时副本**，绝不改真实基线。
  // 早先的写法是"改真实基线 + finally 还原"——与 REV-429 同一类反模式：
  // 一次异常/强杀就会留下 `matrix.cells = 999` 的坏基线（实测踩到，且当时误判成"基线过期"）。
  const tmpBaseline = join(TMP, "drifted-baseline.json");
  mkdirSync(TMP, { recursive: true });
  const mutated = JSON.parse(readFileSync(BASELINE, "utf8"));
  mutated.metrics.matrix.cells = 999;
  writeFileSync(tmpBaseline, JSON.stringify(mutated, null, 2), "utf8");

  assertEqual("R2 基线漂移 → --check 报错", runMetricsCheck(tmpBaseline), 1);
  assertEqual("R3 真实基线未被负向用例污染", runMetricsCheck(), 0);
}

// 清理临时产物
if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });

// ═══════════════════════════════════════════════════════════════════
// 结果
// ═══════════════════════════════════════════════════════════════════

console.log("=== 实验台自测 ===");
console.log(`通过 ${passed} 项`);
if (failures.length > 0) {
  console.error(`\n✗ 失败 ${failures.length} 项：`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("✓ 判据 / 诊断 / 打分 / 报告渲染全部符合预期（含 2 条误报回归锁）");
