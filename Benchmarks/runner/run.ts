/**
 * @module Benchmarks/runner/run
 * @description
 * Benchmark 运行器 CLI —— 两层流程：
 *
 * ```
 *   场景 ──▶【1 实验矩阵】逐条准入判据（checks）+ 诊断未过原因
 *                │ 未过 → 只出诊断，不打分
 *                ▼ 过了
 *          【2 打分矩阵】按 scoringMatrix.json 的维度权重给分 → 等级
 * ```
 *
 * 用法：
 *   npx tsx Benchmarks/runner/run.ts                      # 跑全部场景
 *   npx tsx Benchmarks/runner/run.ts --scenario=<id>      # 只跑一个
 *   npx tsx Benchmarks/runner/run.ts --json               # 只输出机读结果
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { runScenario } from "./harness.js";
import type {
  CheckResult,
  Diagnosis,
  DimensionScore,
  RunResult,
  RunTrace,
  Scenario,
} from "./types.js";

const BENCH_ROOT = resolve(import.meta.dirname, "..");
const SCENARIO_DIR = join(BENCH_ROOT, "scenarios");
const REPORT_DIR = join(BENCH_ROOT, "reports");
const SCORING_PATH = join(BENCH_ROOT, "scoringMatrix.json");

interface ScoringMatrix {
  dimensions: Array<{
    id: string;
    weight: number;
    description: string;
    signals: string[];
  }>;
  gradeThresholds: Array<{ grade: string; min: number }>;
}

// ═══════════════════════════════════════════════════════════════════
// 第一层：实验矩阵（准入判据）
// ═══════════════════════════════════════════════════════════════════

/** 从一次轨迹推出准入判据集合（每条对应实验矩阵里一个 cell 的 oracle） */
export function evaluateChecks(
  trace: RunTrace,
  diagnoses: Diagnosis[] = [],
): CheckResult[] {
  const checks: CheckResult[] = [];
  const e = trace.expect;

  checks.push({
    id: "CHK-NO-FATAL",
    passed: !trace.fatalError,
    detail: trace.fatalError
      ? `运行期异常：${trace.fatalError}`
      : "无运行期异常",
  });

  /*
   * 真实调用探针：`assertProbesMustPass` 声明的探针必须全部通过。
   *
   * 为什么单独成判据（2026-10-17 修正）：
   * - 探针失败此前被 harness 记成 `fatalError` → 场景被判"实验无效"，
   *   于是"产品缺了这个设计接口"被误报成"实验台故障"。缺口证明实验永远显示为无效，
   *   检测不出产品缺口。
   * - 现在：探针失败 = **判据失败**（场景红、但有效）；`fatalError` 只保留给
   *   真正的实验台/环境故障。
   * - 未执行（声明了却没出现在结果里）同样判失败 —— 不许静默跳过。
   */
  if (e.assertProbesMustPass?.length) {
    const byId = new Map((trace.assertProbes ?? []).map((p) => [p.id, p]));
    const missing = e.assertProbesMustPass.filter((id) => !byId.has(id));
    const failed = e.assertProbesMustPass.filter(
      (id) => byId.get(id)?.passed === false,
    );
    const failedDetail = failed
      .map((id) => `${id}: ${byId.get(id)?.detail ?? ""}`)
      .join("；");
    checks.push({
      id: "CHK-ASSERT-PROBES",
      passed: missing.length === 0 && failed.length === 0,
      detail:
        missing.length > 0
          ? `未执行的探针：${missing.join(", ")}`
          : failed.length > 0
            ? `探针未通过（${failed.length}/${e.assertProbesMustPass.length}）：${failedDetail}`
            : `真实调用探针全部通过（${e.assertProbesMustPass.length}）`,
    });
  }

  if (e.exitReason !== undefined) {
    checks.push({
      id: "CHK-EXIT-REASON",
      passed: trace.exitReason === e.exitReason,
      detail: `期望 exitReason=${e.exitReason}，实际 ${trace.exitReason ?? "(未退出)"}`,
      observed: trace.exitReason ?? "none",
    });
  }

  if (e.exitReasonOneOf?.length) {
    checks.push({
      id: "CHK-EXIT-REASON-ONE-OF",
      passed:
        trace.exitReason !== undefined &&
        e.exitReasonOneOf.includes(trace.exitReason),
      detail: `期望 exitReason ∈ {${e.exitReasonOneOf.join(", ")}}，实际 ${trace.exitReason ?? "(未退出)"}`,
      observed: trace.exitReason ?? "none",
    });
  }

  if (e.maxIterations !== undefined) {
    checks.push({
      id: "CHK-CONVERGENCE",
      passed: trace.totalIterations <= e.maxIterations,
      detail: `轮数 ${trace.totalIterations} ≤ 上限 ${e.maxIterations}`,
      observed: trace.totalIterations,
    });
  }

  if (e.mustCallTools?.length) {
    const called = new Set(
      trace.iterations.flatMap((t) => t.toolCalls.map((c) => c.name)),
    );
    const missing = e.mustCallTools.filter((n) => !called.has(n));
    checks.push({
      id: "CHK-REQUIRED-TOOLS",
      passed: missing.length === 0,
      detail: missing.length
        ? `未调用：${missing.join(", ")}`
        : `已调用：${e.mustCallTools.join(", ")}`,
      observed: [...called].join(",") || "none",
    });
  }

  if (e.forbiddenTools?.length) {
    const called = new Set(
      trace.iterations.flatMap((t) => t.toolCalls.map((c) => c.name)),
    );
    const hit = e.forbiddenTools.filter((n) => called.has(n));
    checks.push({
      id: "CHK-FORBIDDEN-TOOLS",
      passed: hit.length === 0,
      detail: hit.length
        ? `不该调用却调用了：${hit.join(", ")}`
        : "未触碰禁止工具",
    });
  }

  if (e.minToolResults !== undefined) {
    const total = trace.iterations.reduce(
      (s, t) => s + t.toolResultStatuses.length,
      0,
    );
    checks.push({
      id: "CHK-TOOL-RESULTS",
      passed: total >= e.minToolResults,
      detail: `工具结果 ${total} ≥ ${e.minToolResults}`,
      observed: total,
    });
  }

  // 必须出现指定工具错误码（如 TOOL_TIMEOUT / TOOL_RATE_LIMITED）。
  // 只断"有 error"不够：角色受限、参数非法、执行异常都会给 error 状态，
  // 会让"超时判据"被无关错误冒充 → 必须落到**错误码**这一层。
  if (e.toolErrorCodes?.length) {
    const seenCodes = new Set<string>();
    for (const t of trace.iterations)
      for (const c of t.toolResultCodes ?? []) seenCodes.add(c);
    const missing = e.toolErrorCodes.filter((c) => !seenCodes.has(c));
    checks.push({
      id: "CHK-TOOL-ERROR-CODES",
      passed: missing.length === 0,
      detail: missing.length
        ? `未出现期望的工具错误码（缺失：${missing.join(", ")}；实际：${[...seenCodes].join(", ") || "无"}）`
        : `已出现期望的工具错误码（${e.toolErrorCodes.join(", ")}）`,
    });
  }

  // 工具调用与结果必须成对（REV-341 同类：孤儿结果会让供应商判非法请求）
  const unpaired = trace.iterations.filter(
    (t) => t.toolCalls.length !== t.toolResultStatuses.length,
  );
  checks.push({
    id: "CHK-TOOL-PAIRING",
    passed: unpaired.length === 0,
    detail: unpaired.length
      ? `第 ${unpaired.map((t) => t.index).join("/")} 轮调用与结果数量不一致`
      : "每轮工具调用与结果成对",
  });

  const orderBroken = trace.iterations.filter((t) => !t.stepOrderOk);
  checks.push({
    id: "CHK-STEP-ORDER",
    passed: orderBroken.length === 0,
    detail: orderBroken.length
      ? `第 ${orderBroken.map((t) => t.index).join("/")} 轮十步序列异常`
      : "十步序列未被破坏",
  });

  /*
   * MM-GAP-TRACE（生产验收，而非库能力）：
   * 只要真实运行里发生过模型调用/工具执行，产品就必须从**执行路径**留下 span 产物，
   * 且能按 traceId 取回。读取面是产品的 `getTraceSpans`（不是基准自造观测）。
   * 若模型/工具调用点没埋 span，这条会直接红——不允许"有 span API 就算接线"。
   */
  {
    const modelCalls = trace.modelCalls.length;
    const toolCalls = trace.totalToolCalls;
    const spans = trace.spans;
    const needLlm = modelCalls > 0;
    const needTool = toolCalls > 0;
    const ok =
      !!spans &&
      (!needLlm || spans.llm >= 1) &&
      (!needTool || spans.tool >= 1) &&
      (modelCalls === 0 || spans.traceIds.length >= 1);
    checks.push({
      id: "CHK-SPAN-WIRING",
      passed: ok,
      detail: ok
        ? `真实运行留下 span（llm=${spans?.llm ?? 0} / tool=${spans?.tool ?? 0} / trace=${(spans?.traceIds ?? []).length}）`
        : `真实运行未留下足够 span 产物（模型调用 ${modelCalls} 次 → llm span ${spans?.llm ?? 0}；工具调用 ${toolCalls} 次 → tool span ${spans?.tool ?? 0}）—— 执行路径缺埋点`,
    });
  }

  // 场景可声明"不允许出现的诊断结论"：准入不仅看期望值**命中**，
  // 也看**没有出现**已知问题形态（否则"跑出正确退出类别但内部在打转"会被放行去打分）。
  if (e.forbidDiagnoses?.length) {
    const forbidden = diagnoses
      .map((d) => d.type)
      .filter((t) => e.forbidDiagnoses!.includes(t));
    checks.push({
      id: "CHK-NO-FORBIDDEN-DIAGNOSIS",
      passed: forbidden.length === 0,
      detail: forbidden.length
        ? `出现被禁止的问题形态：${forbidden.join(", ")}`
        : `未出现被禁止的问题形态（${e.forbidDiagnoses.join(", ")}）`,
    });
  }

  // 场景可声明"必须诊断出的问题形态"（cell oracle 的**正面**要求）。
  //
  // 为什么不能只靠上面那条反向断言：`AG-ENV-TOOLLOOP` 的 oracle 是
  // "诊断出 tool_loop 且退出类别不是 success"。若只写 `forbidDiagnoses`，
  // 系统哪怕根本没识别出极限环、只是耗尽迭代上限退出，也会被判通过 ——
  // 那就成了"用反向断言冒充正向证据"。本判据要求该形态**真的出现在诊断里**
  // （匹配 `type`，不看 severity：`allowDiagnoses` 会把它降级成 info，但类型仍在）。
  if (e.requiredDiagnoses?.length) {
    const seen = new Set<string>(diagnoses.map((d) => d.type));
    const missing = e.requiredDiagnoses.filter((t) => !seen.has(t));
    checks.push({
      id: "CHK-REQUIRED-DIAGNOSIS",
      passed: missing.length === 0,
      detail: missing.length
        ? `未诊断出期望的问题形态（缺失：${missing.join(", ")}；实际诊断：` +
          `${[...seen].filter((t) => t !== "none").join(", ") || "无"}）`
        : `已诊断出期望的问题形态（${e.requiredDiagnoses.join(", ")}）`,
    });
  }

  // 约束保持面：至少一轮发给模型的请求里出现指定片段（如"压缩后重锚"）
  if (e.requestMustContain?.length) {
    const missing = e.requestMustContain.filter(
      () => !trace.reanchorPerCall.some(Boolean),
    );
    checks.push({
      id: "CHK-REQUEST-CONTAINS",
      passed: missing.length === 0,
      detail: missing.length
        ? `没有任何一轮请求包含：${e.requestMustContain.join(" / ")}（共 ${trace.reanchorPerCall.length} 轮请求）`
        : `已观测到重锚段（第 ${trace.reanchorPerCall
            .map((v, i) => (v ? i + 1 : null))
            .filter(Boolean)
            .join(",")} 轮）`,
    });
  }

  // ADR-0005：压缩/摘要不得改动不可变区
  if (e.goalMustBeIntact) {
    checks.push({
      id: "CHK-GOAL-INTACT",
      passed: trace.goalIntact,
      detail: trace.goalIntact
        ? "goal / immutableConstraints 未被改动（ADR-0005）"
        : "不可变区在运行期被改动（违反 ADR-0005）",
    });
  }

  // 成本口径可信度：Token 四源账本对账无差异（P0-3）。账本不一致时"花了多少"已不可信，
  // 后续所有成本类判据都会失真，所以它是成本面的地基判据。
  if (e.ledgerClean) {
    const mismatch = trace.controlTriggers["ledger_mismatch"] ?? 0;
    checks.push({
      id: "CHK-LEDGER-CLEAN",
      passed: mismatch === 0,
      detail:
        mismatch === 0 ? "四源账本对账无差异" : `账本对账差异 ${mismatch} 次`,
      observed: mismatch,
    });
  }

  // 治理面：必须有危险工具真的落在审批门上（不是"日志里看到过"）
  if (e.approvalGateRequired) {
    const invoked = trace.controlTriggers["approval_gate_invoked"] ?? 0;
    checks.push({
      id: "CHK-APPROVAL-GATE",
      passed: invoked > 0,
      detail:
        invoked > 0
          ? `审批门被触发 ${invoked} 次（危险工具确实走了阻塞审批）`
          : "审批门计数为 0 —— 危险工具没有落在审批门的阻塞路径上",
      observed: invoked,
    });
  }

  // 可观测面：指定事件类型必须真的产出（治理链路"按序产出且计数非零"的硬证据）
  if (e.requiredEvents?.length) {
    const missing = e.requiredEvents.filter(
      (t) => (trace.eventTypes[t] ?? 0) < 1,
    );
    checks.push({
      id: "CHK-REQUIRED-EVENTS",
      passed: missing.length === 0,
      detail: missing.length
        ? `未产出事件：${missing.join(", ")}（实际产出：${Object.keys(trace.eventTypes).join(", ") || "无"}）`
        : `已产出事件：${e.requiredEvents.map((t) => `${t}×${trace.eventTypes[t]}`).join(", ")}`,
      observed: trace.eventSequence.length,
    });
  }

  // L5 幂等重放：同参重复调用必须被幂等缓存挡住（看**执行体**次数，不看调用次数）
  if (e.idempotentReplay) {
    const { tool, maxExecutions } = e.idempotentReplay;
    const executed = trace.toolExecutions[tool] ?? 0;
    checks.push({
      id: "CHK-IDEMPOTENT-REPLAY",
      passed: executed <= maxExecutions,
      detail:
        executed <= maxExecutions
          ? `${tool} 执行体仅被调用 ${executed} 次（≤ ${maxExecutions}）—— 重复副作用被挡住`
          : `${tool} 执行体被调用 ${executed} 次（> ${maxExecutions}）—— 幂等缓存未生效，重复副作用已产生`,
      observed: executed,
    });
  }

  // 系统轴 · 记忆面：写侧红线 / 乐观锁 / 冲突裁决的逐条判定
  if (e.memoryExpect?.length) {
    for (const exp of e.memoryExpect) {
      const probe = trace.memoryProbes.find((p) => p.id === exp.id);
      if (!probe) {
        checks.push({
          id: `CHK-MEM-${exp.id}`,
          passed: false,
          detail: `探针 ${exp.id} 未执行（场景未声明或执行前抛错）`,
        });
        continue;
      }
      if (exp.mustReject) {
        checks.push({
          id: `CHK-MEM-${exp.id}`,
          passed: probe.rejected,
          detail: probe.rejected
            ? `已拒绝：${probe.error ?? ""}`
            : "未被拒绝 —— 红线/乐观锁未生效",
        });
      } else if (exp.mustStore) {
        checks.push({
          id: `CHK-MEM-${exp.id}`,
          passed: probe.stored,
          detail: probe.stored
            ? "已落库（对照组）"
            : `应落库却被拒：${probe.error ?? ""}`,
        });
      }
    }
  }

  // 系统轴 · 检索系统：Recall@K / MRR 阈值判定（阈值来自基线首跑，见 scenario.retrieval）
  if (e.retrieval && trace.retrieval) {
    const r = trace.retrieval;
    if (e.retrieval.minRecallAtK !== undefined) {
      checks.push({
        id: "CHK-RETRIEVAL-RECALL",
        passed: (r.meanRecallAtK ?? 0) >= e.retrieval.minRecallAtK,
        detail: `Recall@${r.k} = ${r.meanRecallAtK}（阈值 ${e.retrieval.minRecallAtK}，${r.scoredQueries}/${r.queryCount} 条计分查询）`,
        observed: r.meanRecallAtK ?? 0,
      });
    }
    if (e.retrieval.minMrr !== undefined) {
      checks.push({
        id: "CHK-RETRIEVAL-MRR",
        passed: (r.mrr ?? 0) >= e.retrieval.minMrr,
        detail: `MRR = ${r.mrr}（阈值 ${e.retrieval.minMrr}；语料 ${r.seeded}/${r.corpusSize} 条已 seeded）`,
        observed: r.mrr ?? 0,
      });
    }
  }

  // L5 混沌：DB 不可用期间的持久化失败必须**留痕**（"不静默丢弃"的可判定形态）
  if (e.dbFailureMustBeLogged) {
    const ev = trace.dbFailureEvidence;
    const logged = ev.matchedLines.length > 0;
    checks.push({
      id: "CHK-DB-FAILURE-LOGGED",
      passed: ev.injected && logged,
      detail: !ev.injected
        ? "未注入 DB 关闭（场景未声明 closeDbAfterIteration）—— 判据无从成立"
        : logged
          ? `已留痕 ${ev.matchedLines.length} 行（日志文件 ${ev.logFiles} 个）：${ev.matchedLines[0]?.slice(0, 120) ?? ""}`
          : `DB 关闭后${ev.logFiles} 个日志文件中未找到任何失败留痕 —— 持久化失败被静默丢弃`,
      observed: ev.matchedLines.length,
    });
  }

  // L5 时钟回拨：必须被检出，且单调时钟不得倒退
  if (e.clockSkewDetected) {
    const cs = trace.clockSkew;
    checks.push({
      id: "CHK-CLOCK-SKEW",
      passed: cs !== null && cs.detected && !cs.monotonicWentBackward,
      detail:
        cs === null
          ? "未注入时钟回拨（场景未声明 clockSkewProbe）—— 判据无从成立"
          : !cs.detected
            ? `回拨 ${cs.rewindMs}ms 未被检出 —— 时钟回拨检测失效`
            : cs.monotonicWentBackward
              ? `回拨已检出（drift ${cs.driftMs}ms），但**单调时钟也倒退了** —— 基于 performance.now 的 monotonicMs 不应受影响`
              : `回拨 ${cs.rewindMs}ms 已检出（drift ${cs.driftMs}ms），单调时钟未倒退`,
      observed: cs?.detected ? 1 : 0,
    });
  }

  return checks;
}

// ═══════════════════════════════════════════════════════════════════
// 诊断：从轨迹定位 Agent 问题
// ═══════════════════════════════════════════════════════════════════

export function diagnose(trace: RunTrace): Diagnosis[] {
  const out: Diagnosis[] = [];

  if (trace.fatalError) {
    out.push({
      type: "none",
      severity: "critical",
      detail: `实验无效（运行期异常）：${trace.fatalError}`,
    });
  }

  const broken = trace.iterations.filter((t) => !t.stepOrderOk);
  if (broken.length) {
    out.push({
      type: "step_order",
      severity: "critical",
      detail: "十步主循环序列被破坏",
      evidence: `轮次 ${broken.map((t) => t.index).join(", ")}`,
    });
  }

  const unpaired = trace.iterations.filter(
    (t) => t.toolCalls.length !== t.toolResultStatuses.length,
  );
  if (unpaired.length) {
    out.push({
      type: "tool_pairing",
      severity: "critical",
      detail: "工具调用与其结果不成对（会产生孤儿子结果）",
      evidence: `轮次 ${unpaired.map((t) => t.index).join(", ")}`,
    });
  }

  // 极限环：同一「工具名 + 参数」签名重复 ≥3 次
  const sigCount = new Map<string, number>();
  for (const t of trace.iterations) {
    for (const c of t.toolCalls) {
      const sig = `${c.name}:${JSON.stringify(c.arguments)}`;
      sigCount.set(sig, (sigCount.get(sig) ?? 0) + 1);
    }
  }
  for (const [sig, n] of sigCount) {
    if (n >= 3) {
      out.push({
        type: "tool_loop",
        severity: "warning",
        detail: `同一工具调用重复 ${n} 次（极限环特征）`,
        evidence: sig.slice(0, 120),
      });
    }
  }

  // 空转：**跑到回路自己的迭代上限**才终止（说明把轮次额度烧完了还没收敛）。
  // 不能用"场景声明的轮数上限"来判——那是**实验期望**，不是回路行为：
  // 冻结拒绝(pre_supervision)/模型失败(model_error)都只跑 1 轮就正常终止，
  // 用期望上限判会把这两种**如实终止**误报成空转（实测踩到过，2 个误报）。
  if (trace.exitReason === "max_iterations") {
    out.push({
      type: "no_progress",
      severity: "warning",
      detail: "跑满主循环迭代上限仍未收敛",
      evidence: `${trace.totalIterations} 轮后以 max_iterations 终止`,
    });
  }

  // 工具误用：某轮工具结果全错
  const allErrorTurns = trace.iterations.filter(
    (t) =>
      t.toolResultStatuses.length > 0 &&
      t.toolResultStatuses.every((s) => s === "error"),
  );
  if (allErrorTurns.length >= 2) {
    out.push({
      type: "tool_misuse",
      severity: "warning",
      detail: "连续多轮工具调用全部失败（选型或参数有问题）",
      evidence: `轮次 ${allErrorTurns.map((t) => t.index).join(", ")}`,
    });
  }

  // 成本泄漏（P0-3 的账本对账是硬信号：账本不一致时"花了多少"已不可信）
  if ((trace.controlTriggers["ledger_mismatch"] ?? 0) > 0) {
    out.push({
      type: "budget_leak",
      severity: "critical",
      detail: "Token 账本四源对账失败（成本口径已不可信）",
      evidence: `ledger_mismatch=${trace.controlTriggers["ledger_mismatch"]}`,
    });
  }

  // 上下文漂移：历史持续膨胀，而**近轮既没有新工具调用、正文又极短**（失去焦点的形态）。
  // 注意必须排除"带工具调用的轮次" —— 那些轮次正文本来就是空的（工具调用型回复），
  // 否则规则会对每个正常的工具循环误报（诊断规则喊狼来了比不诊断更糟）。
  const msgCounts = trace.modelCalls.map((m) => m.messageCount);
  const tailTurns = trace.iterations.slice(-2);
  const tailTextOnly =
    tailTurns.length === 2 &&
    tailTurns.every((t) => t.toolCalls.length === 0 && t.outputChars < 32);
  const firstMsg = msgCounts[0];
  const lastMsg = msgCounts[msgCounts.length - 1];
  if (
    msgCounts.length >= 3 &&
    firstMsg !== undefined &&
    lastMsg !== undefined &&
    lastMsg > firstMsg * 2 &&
    tailTextOnly
  ) {
    out.push({
      type: "context_drift",
      severity: "warning",
      detail: "上下文持续增长但近轮产出极短（疑似漂移/失去焦点）",
      evidence: `消息数 ${msgCounts.join("→")}`,
    });
  }

  // 恢复缺失：场景注入了模型侧故障，但回路没能在后续轮次恢复
  const injectedFault =
    trace.expect.forbidDiagnoses?.includes("recovery_missing") === false;
  if (
    injectedFault &&
    trace.exitReason === "model_error" &&
    trace.totalIterations <= 1
  ) {
    out.push({
      type: "recovery_missing",
      severity: "warning",
      detail: "注入模型故障后未能在后续轮次恢复",
      evidence: `exitReason=${trace.exitReason}`,
    });
  }

  // 伪成功：以 success 退出，但末轮还有工具失败结果（说明"完成"是假的）
  if (trace.exitReason === "success") {
    const lastTurn = trace.iterations[trace.iterations.length - 1];
    if (lastTurn && lastTurn.toolResultStatuses.includes("error")) {
      out.push({
        type: "false_success",
        severity: "critical",
        detail: "以 success 退出，但末轮工具结果含错误（疑似伪成功）",
        evidence: `末轮第 ${lastTurn.index} 轮`,
      });
    }
  }

  if (out.length === 0) {
    out.push({
      type: "none",
      severity: "info",
      detail: "未发现 Agent 层面的问题",
    });
  }

  // 场景故意制造的问题形态降级为 info：它是场景的**输入**，不是 Agent 的**结论**。
  // 若不降级，故障恢复场景会因为"注入了两次工具失败"被判 tool_misuse —— 那是把实验设置记成缺陷。
  const allowed = new Set(trace.expect.allowDiagnoses ?? []);
  return out.map((d) =>
    allowed.has(d.type)
      ? { ...d, severity: "info" as const, detail: `（场景预期内）${d.detail}` }
      : d,
  );
}

// ═══════════════════════════════════════════════════════════════════
// 诊断的修复方向（诊断的价值在于"可执行"，不只是"报出问题"）
// ═══════════════════════════════════════════════════════════════════

const PRESCRIPTIONS: Record<Diagnosis["type"], string> = {
  no_progress:
    "核对目标是否可满足、是否需要拆解；检查 StopRules 的无进展阈值与 action（switch_strategy）是否真的改变了策略",
  tool_loop:
    "检查工具返回值是否提供了新信息（空返回会让模型原地重试）；考虑对重复指纹短路或强制换路",
  tool_misuse:
    "检查工具选择的提示词与工具描述；核对参数 schema 与错误信息是否可读可纠",
  tool_pairing:
    "检查工具结果回填链路：每个 tool_call 必须有对应 tool 结果（孤儿结果会让供应商判非法请求）",
  context_drift: "检查压缩后是否重锚目标；核对不可变区（ADR-0005）是否被改动",
  budget_leak:
    "核对 Token 四源账本口径；账本不一致时所有成本类判据都失真，须先修账本",
  false_success:
    "检查退出判定链：末轮含错误结果时不得判 success；核对 Verifier 阶段是否被试装/接线",
  step_order:
    "检查十步主循环是否被短路或跳过；对照 assertStepOrder 的期望序列定位缺口",
  recovery_missing:
    "检查重试/降级配置与故障分类：模型侧失败应重试、降级或如实作废",
  none: "无需处理",
};

// ═══════════════════════════════════════════════════════════════════
// 人可读报告（JSON 是给机器与基线的，Markdown 是给人看的）
// ═══════════════════════════════════════════════════════════════════

export function renderMarkdown(
  results: RunResult[],
  generatedAt: string,
): string {
  const admitted = results.filter((r) => r.admitted);
  const scored = admitted.filter((r) => r.totalScore !== null);
  const mean = scored.length
    ? scored.reduce((s, r) => s + (r.totalScore ?? 0), 0) / scored.length
    : null;

  const lines: string[] = [];
  lines.push("# Benchmark 运行报告");
  lines.push("");
  lines.push(`生成时间：${generatedAt}`);
  lines.push("");
  lines.push(
    "两层流程：**第 1 层【实验矩阵】准入 → 第 2 层【打分矩阵】评分**（未放行者只出诊断，不进评分）。",
  );
  lines.push("");
  lines.push("## 汇总");
  lines.push("");
  lines.push(
    `- 场景：${results.length} 个（放行 ${admitted.length} / 未过 ${results.length - admitted.length}）`,
  );
  lines.push(`- 放行场景平均分：${mean === null ? "—" : mean.toFixed(4)}`);
  if (scored.length) {
    lines.push(
      `- 等级分布：${scored.map((r) => `${r.trace.scenarioId}=${r.grade}`).join("，")}`,
    );
  }
  const problems = results.flatMap((r) =>
    r.diagnoses.filter((d) => d.type !== "none" && d.severity !== "info"),
  );
  if (problems.length) {
    const byType = new Map<string, number>();
    for (const p of problems) byType.set(p.type, (byType.get(p.type) ?? 0) + 1);
    lines.push(
      `- 检出问题：${[...byType].map(([t, n]) => `${t}×${n}`).join("，")}`,
    );
  }
  lines.push("");

  for (const r of results) {
    const t = r.trace;
    lines.push(`## ${r.admitted ? "✅ 放行" : "❌ 未过"} ${t.scenarioId}`);
    lines.push("");
    lines.push(`> ${t.scenarioTitle}`);
    lines.push("");
    lines.push(
      `- 退出类别：\`${t.exitReason ?? "(未退出)"}\`　轮数：${t.totalIterations}　Token：${t.totalTokensConsumed}　工具调用：${t.totalToolCalls}　用时：${t.durationMs}ms`,
    );
    if (t.fatalError) lines.push(`- ⚠️ **实验无效**：${t.fatalError}`);
    lines.push("");

    const failed = r.checks.filter((c) => !c.passed);
    lines.push(
      `### 第 1 层 · 实验矩阵（${failed.length === 0 ? "全部通过" : `${failed.length} 条未过`}）`,
    );
    lines.push("");
    for (const c of r.checks) {
      lines.push(`- ${c.passed ? "✓" : "✗"} \`${c.id}\` ${c.detail}`);
    }
    lines.push("");

    const real = r.diagnoses.filter(
      (d) => d.severity !== "info" || d.type === "none",
    );
    lines.push("### 诊断");
    lines.push("");
    for (const d of r.diagnoses) {
      const sev =
        d.severity === "critical"
          ? "**严重**"
          : d.severity === "warning"
            ? "警告"
            : "信息";
      lines.push(
        `- [${sev}] \`${d.type}\` — ${d.detail}${d.evidence ? `（${d.evidence}）` : ""}`,
      );
      lines.push(`  - → 修复方向：${PRESCRIPTIONS[d.type]}`);
    }
    if (real.length === 0) lines.push("- （无）");
    lines.push("");

    if (r.admitted) {
      lines.push("### 第 2 层 · 打分矩阵");
      lines.push("");
      lines.push("| 维度 | 得分 | 权重 | 说明 |");
      lines.push("|---|---:|---:|---|");
      for (const s of r.scores) {
        lines.push(
          `| ${s.dimension} | ${s.applicable ? s.score.toFixed(2) : "N/A"} | ${s.weight.toFixed(2)} | ${s.reason} |`,
        );
      }
      lines.push("");
      lines.push(`**总分 ${r.totalScore}（仅计适用维度）　等级 ${r.grade}**`);
    } else {
      lines.push(
        '> 未过实验矩阵 → 不进打分矩阵（避免"没通过准入却出现在能力分布里"）',
      );
    }
    lines.push("");
  }

  return lines.join("\n") + "\n";
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

// ═══════════════════════════════════════════════════════════════════
// 第二层：打分矩阵
// ═══════════════════════════════════════════════════════════════════

export function scoreScenario(
  trace: RunTrace,
  matrix: ScoringMatrix,
): { scores: DimensionScore[]; total: number | null } {
  const has = (id: string) => trace.controlTriggers[id] ?? 0;

  const stepOk = trace.iterations.every((t) => t.stepOrderOk) ? 1 : 0;
  const paired = trace.iterations.every(
    (t) => t.toolCalls.length === t.toolResultStatuses.length,
  )
    ? 1
    : 0;
  const exitOk = trace.expect.exitReason
    ? trace.exitReason === trace.expect.exitReason
      ? 1
      : 0
    : 1;

  const maxIter = Number(
    trace.expect.maxIterations ?? Math.max(1, trace.totalIterations),
  );
  const iterationScore = clamp01(
    1 - Math.max(0, trace.totalIterations - maxIter) / Math.max(1, maxIter),
  );

  // 场景是否**真的**压到了该维度。打分的铁律：压不到就不打分（applicable=false），
  // 而不是白送一个满分 —— 否则"没测过的能力"会被算成"满分的能力"，
  // 那和旧基线里手写的 0.85~1.0 是同一类伪分数（权重加权后还会互相掩盖）。
  const governanceTouched =
    has("approval_gate_invoked") > 0 ||
    Object.keys(trace.eventTypes).some(
      (t) => t.startsWith("governance:") || t.startsWith("loop:approval"),
    );
  const faultInjected =
    (trace.expect.allowDiagnoses?.length ?? 0) > 0 ||
    trace.iterations.some((t) => t.toolResultStatuses.includes("error")) ||
    (trace.controlTriggers["middleware_short_circuit"] ?? 0) > 0;
  const noFatal = trace.fatalError ? 0 : 1;

  const observability = clamp01(
    (has("stopRules_evaluated") > 0 ? 0.5 : 0) +
      (Object.values(trace.controlTriggers).filter((v) => v > 0).length >= 3
        ? 0.25
        : 0) +
      (Object.keys(trace.eventTypes).length > 0 ? 0.25 : 0),
  );

  const perDimension: Record<
    string,
    { score: number; reason: string; applicable: boolean }
  > = {
    correctness: {
      score: exitOk * 0.5 + stepOk * 0.3 + paired * 0.2,
      reason: `退出类别${exitOk ? "一致" : "不一致"}、十步${stepOk ? "正常" : "异常"}、调用配对${paired ? "完整" : "断裂"}`,
      applicable: true,
    },
    resilience: {
      score: noFatal,
      reason: faultInjected
        ? `注入了故障（工具失败/短路/场景声明）且${noFatal ? "未产生运行期异常" : "产生了运行期异常"}`
        : "本场景未注入任何故障 → 恢复力未被压到，不参与评分",
      applicable: faultInjected,
    },
    efficiency: {
      score: iterationScore,
      reason: `${trace.totalIterations} 轮（上限 ${maxIter}），Token ${trace.totalTokensConsumed}`,
      applicable: true,
    },
    observability: {
      score: observability,
      reason: `StopRules 评估 ${has("stopRules_evaluated")} 次；非零计数器 ${Object.values(trace.controlTriggers).filter((v) => v > 0).length} 个；事件类型 ${Object.keys(trace.eventTypes).length} 种`,
      applicable: true,
    },
    governance: {
      score: governanceTouched
        ? clamp01(
            (has("approval_gate_invoked") > 0 ? 0.6 : 0) +
              (Object.keys(trace.eventTypes).some((t) =>
                t.startsWith("governance:"),
              )
                ? 0.4
                : 0),
          )
        : 0,
      reason: governanceTouched
        ? `审批门触发 ${has("approval_gate_invoked")} 次；治理事件 ${
            Object.entries(trace.eventTypes)
              .filter(
                ([k]) =>
                  k.startsWith("governance:") || k.startsWith("loop:approval"),
              )
              .map(([k, v]) => `${k}×${v}`)
              .join(", ") || "无"
          }`
        : "本场景未触及治理链路（无危险工具/审批）→ 不参与评分",
      applicable: governanceTouched,
    },
    maintainability: {
      score: 0,
      reason: "无自动化测量手段（权重 0，不参与分母）",
      applicable: false,
    },
  };

  const scores: DimensionScore[] = matrix.dimensions.map((d) => ({
    dimension: d.id,
    score: perDimension[d.id]?.score ?? 0,
    weight: d.weight,
    reason: perDimension[d.id]?.reason ?? "未定义信号",
    applicable: perDimension[d.id]?.applicable ?? false,
  }));

  // 分母只算"真正被压到"的维度：不可测的维度既不给分也不占权重
  const scored = scores.filter((d) => d.applicable && d.weight > 0);
  const effectiveWeight = scored.reduce((s, d) => s + d.weight, 0);
  const total =
    effectiveWeight > 0
      ? scored.reduce((s, d) => s + d.score * d.weight, 0) / effectiveWeight
      : null;

  return { scores, total: total === null ? null : Number(total.toFixed(4)) };
}

function gradeOf(total: number | null, matrix: ScoringMatrix): string | null {
  if (total === null) return null;
  for (const t of matrix.gradeThresholds) {
    if (total >= t.min) return t.grade;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════
// CLI
// ═══════════════════════════════════════════════════════════════════

function loadScenarios(only?: string): Scenario[] {
  if (!existsSync(SCENARIO_DIR)) return [];
  return readdirSync(SCENARIO_DIR)
    .filter((f) => f.endsWith(".json"))
    .map(
      (f) =>
        JSON.parse(readFileSync(join(SCENARIO_DIR, f), "utf8")) as Scenario,
    )
    .filter((s) => !only || s.id === only)
    .sort((a, b) => a.id.localeCompare(b.id));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const only = args.find((a) => a.startsWith("--scenario="))?.split("=")[1];
  const jsonOnly = args.includes("--json");

  const matrix: ScoringMatrix = JSON.parse(readFileSync(SCORING_PATH, "utf8"));
  const scenarios = loadScenarios(only);
  if (scenarios.length === 0) {
    console.error(
      only ? `未找到场景: ${only}` : "未找到任何场景（Benchmarks/scenarios/）",
    );
    process.exit(1);
  }

  const results: RunResult[] = [];
  for (const s of scenarios) {
    const trace = await runScenario(s);
    // 顺序：先诊断（从轨迹识别问题形态），再判定准入（准入要"没出现被禁止的问题形态"）
    const diagnoses = diagnose(trace);
    const checks = evaluateChecks(trace, diagnoses);
    // 实验矩阵准入：**全部判据通过**才放行到打分矩阵
    const admitted = checks.every((c) => c.passed) && !trace.fatalError;
    const { scores, total } = scoreScenario(trace, matrix);

    results.push({
      trace,
      checks,
      admitted,
      diagnoses,
      scores,
      totalScore: admitted ? total : null,
      grade: admitted ? gradeOf(total, matrix) : null,
    });
  }

  mkdirSync(REPORT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const payloadGeneratedAt = new Date().toISOString();
  const payload =
    JSON.stringify(
      {
        generatedAt: payloadGeneratedAt,
        layer1: "实验矩阵（准入）",
        layer2: "打分矩阵（评分）",
        scoringMatrix: "Benchmarks/scoringMatrix.json",
        results,
      },
      null,
      2,
    ) + "\n";

  const reportPath = join(REPORT_DIR, `${only ?? "all"}-${stamp}.json`);
  writeFileSync(reportPath, payload, "utf8");

  // 稳定指针 latest.* = **最近一次全量运行**。
  // 单场景运行（--scenario=）只写时间戳文件：否则一次 `--scenario=X` 就会把指针改成单场景结果，
  // 基线（benchMetrics 读它）随之失真 —— 实测踩过：跑过单场景后 `npm run bench` 的
  // 基线一致性检查会红，而真正的原因是"指针被单场景覆盖"而不是基线过期。
  if (!only) {
    writeFileSync(join(REPORT_DIR, "latest.json"), payload, "utf8");
  }

  // 人可读报告：JSON 给机器与基线，Markdown 给人看（诊断要能直接读、直接照做）
  const markdown = renderMarkdown(results, payloadGeneratedAt);
  const mdPath = join(REPORT_DIR, `${only ?? "all"}-${stamp}.md`);
  writeFileSync(mdPath, markdown, "utf8");
  if (!only) {
    writeFileSync(join(REPORT_DIR, "latest.md"), markdown, "utf8");
  }

  if (jsonOnly) {
    process.stdout.write(JSON.stringify({ results }, null, 2) + "\n");
    return;
  }

  console.log("=== Benchmark · 第 1 层：实验矩阵（准入） ===");
  for (const r of results) {
    const failed = r.checks.filter((c) => !c.passed);
    console.log(
      `\n[${r.admitted ? "放行" : "未过"}] ${r.trace.scenarioId} — ${r.trace.scenarioTitle}`,
    );
    console.log(
      `  退出: ${r.trace.exitReason ?? "(未退出)"}  轮数: ${r.trace.totalIterations}  Token: ${r.trace.totalTokensConsumed}  工具调用: ${r.trace.totalToolCalls}  用时: ${r.trace.durationMs}ms`,
    );
    for (const c of r.checks)
      console.log(`  ${c.passed ? "✓" : "✗"} ${c.id}: ${c.detail}`);
    if (failed.length)
      console.log(`  → 未过判据 ${failed.length} 条，诊断如下`);

    console.log("  诊断:");
    for (const d of r.diagnoses)
      console.log(
        `    · [${d.severity}] ${d.type}: ${d.detail}${d.evidence ? `（${d.evidence}）` : ""}`,
      );

    if (r.admitted) {
      console.log("=== 第 2 层：打分矩阵 ===");
      for (const s of r.scores) {
        const mark = s.applicable ? " " : "·";
        console.log(
          `  ${mark} ${s.dimension.padEnd(16)} ${s.applicable ? s.score.toFixed(2) : "N/A "} × ${s.weight.toFixed(2)}  ${s.reason}`,
        );
      }
      console.log(`  总分 ${r.totalScore}（仅计适用维度）  等级 ${r.grade}`);
    } else {
      console.log("  （未过实验矩阵 → 不进打分矩阵）");
    }
  }

  const admitted = results.filter((r) => r.admitted).length;
  const avg = results.filter((r) => r.totalScore !== null);
  console.log(`\n=== 汇总 ===`);
  console.log(
    `场景 ${results.length} 个：放行 ${admitted} / 未过 ${results.length - admitted}`,
  );
  if (avg.length) {
    const mean = avg.reduce((s, r) => s + (r.totalScore ?? 0), 0) / avg.length;
    console.log(
      `放行场景平均分 ${mean.toFixed(4)}（${avg.map((r) => `${r.trace.scenarioId}=${r.grade}`).join(", ")}）`,
    );
  }
  console.log(`报告: ${reportPath}`);
  console.log(`人可读报告: ${mdPath}`);
}

// 仅在**直接执行**时跑 CLI：被 `selftest.ts` import 时不得触发整套场景
// （否则"给实验台写自测"这件事本身跑不起来——这是 ESM 版的 require.main === module）
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((e) => {
    console.error("Benchmark 运行失败:", e);
    process.exit(1);
  });
}
