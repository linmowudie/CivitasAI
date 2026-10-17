/**
 * @module Benchmarks/runner/harness
 * @description
 * Benchmark 实验台：**桩 Provider 驱动真实主循环**，采集 Agent 行为轨迹。
 *
 * 与测试系统的分界（再次强调）：
 *  这里不做 `vi.mock`、不直接调被测函数 —— 它启动的是**真实的组合根子集**
 *  （三库 + 迁移 + 事件总线 + 路由 + 工具注册表 + Token 经济 + Loop 控制规则），
 *  然后跑 `executeLoop`。观测对象是"这个 Agent 在这一轮任务里干了什么"。
 *
 * 每个场景独立初始化、独立清理，因此：
 *  - 无跨场景状态泄漏（事件总线 / 路由 / 工具表 / 控制计数器全部复位）；
 *  - 数据落在 `Data/_bench_<scenarioId>/`，不碰开发机真实数据。
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";

import { initDatabase, closeDatabase } from "../../Src/Infra/Db/database.js";
import {
  initMigrations,
  clearMigrations,
  migrateUp,
} from "../../Src/Infra/Db/migrations.js";
import { setActiveOwner } from "../../Src/Services/AccountScope/activeAccount.js";
import {
  registerProvider,
  setRoutingConfig,
  resetRouter,
} from "../../Src/Infra/Llm/Router/modelRouter.js";
import { clearRegistry } from "../../Src/Tools/Registry/toolRegistry.js";
import { registerBuiltinTools } from "../../Src/Tools/builtinLoader.js";
import { getTraceSpans } from "../../Src/Infra/Logging/traceContext.js";
import {
  resetEventBus,
  initEventBus,
  getEventLog,
} from "../../Src/Services/EventBus/eventBus.js";
import {
  getControlTriggerCounts,
  resetControlTriggerCounts,
} from "../../Src/Infra/Logging/controlTriggers.js";
import {
  executeLoop,
  resetSystemPromptCache,
} from "../../Src/Core/Loop/runIteration.js";
import {
  createLoopState,
  assertStepOrder,
} from "../../Src/Core/Loop/loopEngine.js";
import { createLoopConfig } from "../../Src/Core/Loop/loopConfig.js";
import {
  setActiveStopRuleSet,
  clearActiveStopRuleSet,
  buildStopRuleSet,
} from "../../Src/Services/LoopControl/stopRules.js";
import { initWalletManager } from "../../Src/Services/TokenEconomy/walletManager.js";
import { initDualBudget } from "../../Src/Services/TokenEconomy/dualBudget.js";
import {
  configureContextCompression,
  resetContextCompression,
} from "../../Src/Core/Loop/contextCompression.js";
import {
  registerMiddleware,
  clearMiddlewares,
} from "../../Src/Core/Middleware/middlewareRegistry.js";
import { goalReanchorMiddleware } from "../../Src/Core/Middleware/builtin/goalReanchor.js";
import { createGoalReanchorControlMiddleware } from "../../Src/Services/LoopControl/middleware/goalReanchorControl.js";
import {
  freezeAgent,
  resetFreezeManager,
} from "../../Src/Services/Audit/freezeManager.js";
import {
  getPendingApprovals,
  forceApprove,
  clearApprovalQueue,
} from "../../Src/Services/LoopControl/approvalGate.js";
import { configureToolServicePorts } from "../../Src/Tools/Registry/toolServicePorts.js";
import { writeMemory as svcWriteMemory } from "../../Src/Services/SharedMemory/longTermMemory.js";
import {
  initLogger,
  shutdownLogger,
  logger,
} from "../../Src/Infra/Logging/logger.js";
import { Time } from "../../Src/Infra/Time/timeService.js";
import {
  initToolResultCache,
  getCachedToolResult,
  cacheToolResult,
  clearToolResultCache,
} from "../../Src/Services/Cache/toolResultCache.js";
import { writeMemory } from "../../Src/Services/SharedMemory/longTermMemory.js";
import { runRetrievalSuite } from "./retrieval.js";
import { runAssertProbes } from "./assertProbes.js";
import {
  write as workspaceWrite,
  resetGlobalWorkspace,
} from "../../Src/Services/SharedMemory/globalWorkspace.js";

import { ScriptedProvider, STUB_MODEL } from "./stubProvider.js";
import { registerProbeTools, registerMemoryWriteProbe } from "./probeTools.js";
import type { RunTrace, Scenario, TurnTrace } from "./types.js";

const BENCH_DATA_ROOT = resolve(import.meta.dirname, "../../Data");

/** 场景 fixture（`BenchRead` 的数据源）；首版内置一份，后续可由场景声明 */
const DEFAULT_FIXTURES: Record<string, string> = {
  "src/notes.txt": "构建步骤：1) 安装依赖 2) 跑测试 3) 打包",
  "src/config.json": '{"retries": 3, "timeoutSec": 30}',
};

function initBenchDb(scenarioId: string): { dir: string } {
  const dir = join(BENCH_DATA_ROOT, `_bench_${scenarioId}`);
  closeDatabase();
  clearMigrations();
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  initDatabase({
    mainPath: join(dir, "main.db"),
    eventsPath: join(dir, "events.db"),
    memoryPath: join(dir, "memory.db"),
    walMode: true,
    busyTimeoutMs: 5_000,
  });
  initMigrations();
  const up = migrateUp();
  if (!up.ok) throw new Error(`迁移失败: ${up.error}`);
  return { dir };
}

/**
 * 运行一个场景，返回完整轨迹。
 * 本函数**不抛异常**用于控制流：运行期异常进 `trace.fatalError`，
 * 由上层判定为"实验无效"而不是"Agent 失败"（两者归因完全不同）。
 */
export async function runScenario(scenario: Scenario): Promise<RunTrace> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  // ── 1. 环境复位（组合根子集）──
  resetEventBus();
  initEventBus();
  resetRouter();
  resetSystemPromptCache();
  resetControlTriggerCounts();
  clearActiveStopRuleSet();
  clearRegistry();
  // 真实装配：注册内置工具（与 `main.ts` ⑫ 步同构）。
  // 基准的"某工具已在注册表 / 工具契约"类断言必须看**产品装配结果**；
  // 若基准自己不跑装配，就会把"产品已实现但基准没注册"误报成"工具未实现"。
  const builtinReg = registerBuiltinTools();
  clearMiddlewares();
  resetFreezeManager();
  resetContextCompression();
  clearApprovalQueue();
  initWalletManager({ initialSupply: 1_000_000, defaultWalletBalance: 10_000 });

  // 组合根子集：注册目标重锚中间件（与 `main.ts` ⑫.5 同构）。
  // 为什么必须在这里注册：`GoalReanchorControl` 是**生产装配**的一部分，
  // 若基准不注册它，"压缩后是否重锚"这条能力根本无法被观测（而它正是 P1-7 的修复对象）。
  // `reanchorEveryRounds: 0` 关闭周期性重锚，只保留"压缩后置位"这条触发路径，避免噪声。
  registerMiddleware(goalReanchorMiddleware);
  registerMiddleware(
    createGoalReanchorControlMiddleware(undefined, { reanchorEveryRounds: 0 }),
  );

  let dir = "";
  /** 供 `finally` 做不可变区完整性比对（ADR-0005）：快照 + 活对象引用 */
  let goalSnapshot: { requirement: string; constraints: number } | null = null;
  let liveGoal: {
    originalRequirement: string;
    immutableConstraints: string[];
  } | null = null;
  /** 审批人轮询定时器（供 `finally` 清理） */
  let approverTimer: ReturnType<typeof setInterval> | null = null;
  const provider = new ScriptedProvider(
    scenario.model.script,
    scenario.model.defaultReply,
    scenario.model.contextWindow,
  );

  const trace: RunTrace = {
    scenarioId: scenario.id,
    scenarioTitle: scenario.title,
    tags: scenario.tags,
    startedAt,
    durationMs: 0,
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
    expect: scenario.expect,
  };

  try {
    dir = initBenchDb(scenario.id).dir;
    // 日志落盘到本次运行的临时目录：L5 的"失败留痕"判据要读它（与既有单测同法，不改产品代码）
    try {
      shutdownLogger();
      initLogger({ logDir: join(dir, "logs"), level: "info" });
    } catch {
      /* 日志初始化失败不应影响实验 */
    }
    setActiveOwner("bench");

    // ── 2. 桩 Provider + 路由（模型全限定名 = bench-stub/scripted）──
    const reg = registerProvider(provider);
    if (!reg.ok) throw new Error(`注册桩 Provider 失败: ${reg.error}`);
    setRoutingConfig({
      defaultModel: STUB_MODEL,
      directorModel: STUB_MODEL,
      workerModel: STUB_MODEL,
      verifierModel: STUB_MODEL,
      arbitrationModels: [STUB_MODEL, STUB_MODEL, STUB_MODEL],
      fallbackOrder: ["bench-stub"],
      timeoutMs: 30_000,
      firstByteTimeoutMs: 10_000,
      interChunkTimeoutMs: 15_000,
    });

    // ── 3. 探针工具（场景 fixture 覆盖默认值：安全面靠它把注入载荷放进工具返回值）──
    //    同时注入**工具结果缓存端口**（与 main.ts ⑫.6 同构）。
    //    漏了这一步，"幂等重放"实验测到的其实是"实验台没装配端口"而不是产品行为 ——
    //    toolDispatcher 对未注入端口是**静默跳过**（不伪造命中），所以失败会伪装成产品缺陷。
    initToolResultCache();
    configureToolServicePorts({
      // 记忆写入的上层入口（裁定 (a)）：工具 BenchMemWrite → MemoryWrite → 本端口 → Services 写实现
      memoryWrite: (params) => {
        const r = svcWriteMemory({
          title: params.title,
          content: params.content,
          category: params.category as Parameters<
            typeof svcWriteMemory
          >[0]["category"],
          sourceTraceIds: params.sourceTraceIds,
          ...(params.assertion
            ? {
                assertion: params.assertion as NonNullable<
                  Parameters<typeof svcWriteMemory>[0]["assertion"]
                >,
              }
            : {}),
        });
        return r.ok
          ? { ok: true as const, value: { memoryId: r.value.memoryId } }
          : r;
      },
      toolResultCache: {
        get: getCachedToolResult,
        put: cacheToolResult,
        clear: clearToolResultCache,
      },
    });

    //    onExecute 计数：只有"执行体被调用次数"能证明幂等缓存是否挡住了第二次副作用
    const toolExecutions: Record<string, number> = {};
    if (!builtinReg.ok) {
      trace.fatalError =
        trace.fatalError ??
        `内置工具注册失败（装配不完整）：${builtinReg.error}`;
    }
    registerProbeTools(
      scenario.tools ?? [],
      { ...DEFAULT_FIXTURES, ...(scenario.fixtures ?? {}) },
      (name) => {
        toolExecutions[name] = (toolExecutions[name] ?? 0) + 1;
      },
    );
    trace.toolExecutions = toolExecutions;

    // 记忆写入实验：注册包装探针，把每次结果记进 trace（含被拒原因）
    const memwriteReg = registerMemoryWriteProbe((r) => {
      trace.memoryWriteResults.push(r);
    });
    if (!memwriteReg.ok)
      trace.fatalError =
        trace.fatalError ??
        "BenchMemWrite 注册失败: " + (memwriteReg.error ?? "");

    // ── 4. Loop 准入规则（让 limits / budget 判据真实生效）──
    const maxIterations = scenario.loop?.maxIterations ?? 6;
    const tokenBudget = scenario.loop?.tokenBudget ?? 100_000;
    const timeoutMs = scenario.loop?.timeoutMs ?? 60_000;
    initDualBudget({
      tokenBudget,
      warmRatio: 0.36,
      softRatio: 0.6,
      expandRequestRatio: 0.8,
      hardRatio: 1.0,
    });
    setActiveStopRuleSet(
      buildStopRuleSet({
        tokenBudget,
        warmRatio: 0.36,
        softRatio: 0.6,
        expandRequestRatio: 0.8,
        hardRatio: 1.0,
        limits: {
          maxIterations,
          maxWallClockMs: timeoutMs,
          maxToolCalls: 50,
          maxConsecutiveErrors: 3,
        },
        noProgress: {
          metric: "custom",
          stagnationWindow: 3,
          minDelta: 0.05,
          action: "switch_strategy",
        },
      }),
    );

    const configResult = createLoopConfig({
      model: STUB_MODEL,
      stream: scenario.loop?.stream ?? false,
      max_iterations: maxIterations,
      token_budget: tokenBudget,
      timeout_ms: timeoutMs,
    });
    if (!configResult.ok)
      throw new Error(`Loop 配置失败: ${configResult.error}`);

    const agentRole = scenario.agentRole ?? "worker";

    // ── 记忆治理探针（系统轴 · 记忆面）──
    //  写侧红线/乐观锁/冲突裁决只能直接调写 API 才压得到（检索结果当前不进 prompt）。
    //  必须在 runIteration 之前跑：写入的结果会影响后续的治理可观测（事件、版本号）。
    resetGlobalWorkspace();
    for (const probe of scenario.memoryProbes ?? []) {
      const result =
        probe.via === "long-term-memory"
          ? writeMemory({
              title: probe.title ?? probe.id,
              content: probe.content,
              category: (probe.category ?? "general") as never,
              sourceTraceIds: [`bench-${scenario.id}`],
              ...(probe.assertion
                ? { assertion: probe.assertion as never }
                : {}),
            })
          : workspaceWrite({
              key: probe.key ?? probe.id,
              content: probe.content,
              contentType: "fact",
              assertion: (probe.assertion ?? "observed") as never,
              traceId: `bench-trace-${scenario.id}`,
              agentId: "bench-agent",
              ...(probe.expectedVersion !== undefined
                ? { expectedVersion: probe.expectedVersion }
                : {}),
              ...(probe.actorRole ? { actorRole: probe.actorRole } : {}),
            });
      trace.memoryProbes.push({
        id: probe.id,
        rejected: !result.ok,
        stored: result.ok,
        ...(result.ok ? {} : { error: String(result.error) }),
      });
    }

    // 约束保持面：按场景打开上下文压缩（阈值给小，保证在有限轮内真的触发一次）
    if (scenario.loop?.compress) {
      configureContextCompression({
        triggerTokens: scenario.loop.compressTriggerTokens ?? 50,
        minMessagesToCompress: 2,
        keepRecentMessages: 1,
      });
    }

    // 治理面：运行前冻结本 Agent → 前置监管应在 ② 步拒绝
    if (scenario.freezeBeforeRun) {
      freezeAgent("bench-agent", "benchmark scenario: 治理面注入", "auditor");
    }

    // 治理面：实验台扮演**审批人**。危险且不可逆的工具会被 `toolSafetyGate` 阻塞在
    // `waitForApprovalDecision` 上（默认 60s 超时）；真实系统里由人/前端点同意，
    // 实验台必须把这个角色补上，否则场景只会卡到超时——那不是"审批门生效"的证据。
    if (scenario.approveDangerousTools) {
      approverTimer = setInterval(() => {
        for (const approval of getPendingApprovals()) {
          if (approval.status !== "PENDING") continue;
          forceApprove(
            approval.approvalId,
            "auditor",
            "benchmark: 实验台扮演审批人，自动批准",
          );
        }
      }, 20);
    }

    // ── L5 时钟回拨探针 ──
    //  与 main.ts ③ 同构：先注册 onDrift 回调（组合根职责），再回拨系统时钟。
    //  Time.now() 内部用 Date.now() 判回拨；monotonicMs() 基于 performance.now 应不受影响。
    if (scenario.clockSkewProbe) {
      const drifts: Array<{ driftMs: number }> = [];
      Time.onDrift((event) => {
        drifts.push({ driftMs: event.driftMs });
        logger.warn("时钟回拨检测", {
          source: "timeService",
          driftMs: event.driftMs,
        });
      });
      const monotonicBefore = Time.monotonicMs();
      Time.now(); // 先确立 lastKnownTime
      const originalNow = Date.now;
      const rewindMs = scenario.clockSkewProbe.rewindMs;
      Date.now = () => originalNow() - rewindMs;
      try {
        Time.now(); // 应触发回拨检测
        trace.clockSkew = {
          rewound: true,
          rewindMs,
          detected: drifts.length > 0,
          driftMs: drifts.length > 0 ? (drifts[0]?.driftMs ?? null) : null,
          monotonicWentBackward: Time.monotonicMs() < monotonicBefore,
        };
      } finally {
        Date.now = originalNow;
      }
    }
    // ── 检索质量套件（系统轴 · 检索系统）──
    //  必须在 runIteration 之前：seeding 决定可召回集合。
    //  评测卫生：全程跑在实验台临时数据根，不污染开发机记忆（§2.3）。
    if (scenario.retrievalSuite) {
      trace.retrieval = await runRetrievalSuite(
        scenario.retrievalSuite.goldenSet,
        `bench-trace-${scenario.id}`,
      );
    }

    // ── 真实调用探针（裁定②：关键检查改为真实调用，不用「代码里还有这段形态」充当证据）──
    // 探针在 loop 之前跑：它们是装配期属性与纯函数级判定点，不依赖本次循环状态。
    //
    // 2026-10-17 修正：探针失败**不再**记 `fatalError`。
    // `fatalError` 的语义是"**实验无效**（实验台/环境缺陷）"；而探针失败（尤其"设计接口缺失"）
    // 是**被测产品未实现该设计点**的红证据 —— 两者混用会把产品缺口误记成实验故障，
    // 让"缺口证明实验"永远显示为"实验无效"。判据由 `CHK-ASSERT-PROBES` 在第二层生成。
    if (scenario.assertProbes && scenario.assertProbes.length > 0) {
      trace.assertProbes = await runAssertProbes(scenario.assertProbes);
    }

    const loopState = createLoopState({
      loopId: `bench-${scenario.id}`,
      agentId: "bench-agent",
      traceId: `bench-trace-${scenario.id}`,
      config: configResult.value,
    });
    goalSnapshot = {
      requirement: loopState.goal.originalRequirement,
      constraints: loopState.goal.immutableConstraints.length,
    };
    liveGoal = loopState.goal;

    // ── 5. 跑真实主循环 ──
    const result = await executeLoop(loopState, {
      userInput: scenario.task.goal ?? scenario.task.description,
      sessionId: `bench-session-${scenario.id}`,
      agentId: "bench-agent",
      agentRole,
      config: configResult.value,
      chatMessages: [{ role: "user", content: scenario.task.description }],
      recentCallTimestamps: [],
      // 约束保持面：在第 N 轮结束时直接置位重锚标志（把"重锚链路"与"压缩是否触发"解耦）。
      // 这里能直接改 loopState —— hook 定义在 createLoopState 的作用域内。
      onIterationComplete: (info) => {
        if (scenario.injectReanchorAfterIteration === info.iteration) {
          loopState.needsGoalReanchor = true;
        }
        // L5 混沌注入：在第 N 轮结束时关闭数据库，模拟"库不可用/满盘"。
        // 之后所有持久化（迭代 checkpoint、记忆沉淀、事件落库）都会失败 ——
        // 要观测的是"失败是否留痕"，而不是"是否还能跑"（DB 失败按设计非致命）。
        if (scenario.closeDbAfterIteration === info.iteration) {
          trace.dbFailureEvidence.injected = true;
          try {
            closeDatabase();
          } catch {
            /* 已关闭 */
          }
        }
      },
    });

    if (!result.ok) {
      trace.fatalError = `executeLoop 返回错误: ${result.error}`;
    } else {
      const exec = result.value;
      trace.exitReason = exec.exitReason;
      trace.exitMessage = exec.exitMessage;
      trace.totalTokensConsumed = exec.totalTokensConsumed;
      trace.totalToolCalls = exec.totalToolCalls;

      exec.iterations.forEach((it, i) => {
        const call = provider.callRecords[i];
        const turn: TurnTrace = {
          index: i + 1,
          stepOrderOk: assertStepOrder(it.steps),
          toolCalls: it.toolCalls.map((tc) => ({
            name: tc.name,
            arguments: tc.arguments,
          })),
          toolResultStatuses: it.toolResults.map((tr) => tr.status),
          // 错误码单独采集：oracle 常判"具体错误码"，只记 status 会让任意 error 冒充目标码
          toolResultCodes: it.toolResults
            .map((tr) => tr.error?.code)
            .filter((c): c is NonNullable<typeof c> => typeof c === "string"),
          outputChars: it.outputText.length,
          tokensConsumed: it.tokensConsumed,
          ...(it.decision.exitReason
            ? { exitReason: it.decision.exitReason }
            : {}),
          promptMessageCount: call?.messageCount ?? 0,
        };
        trace.iterations.push(turn);
      });
      trace.totalIterations = exec.iterations.length;

      // MM-GAP-TRACE（生产验收）：真实运行必须**产出 span 产物**，否则"可归因到 span"
      // 只是库能力。这里从产品的 span 检索面读取真实运行留下的 span。
      const spans = getTraceSpans(`bench-trace-${scenario.id}`);
      trace.spans = {
        total: spans.length,
        llm: spans.filter((s) => s.type === "llm_call").length,
        tool: spans.filter((s) => s.type === "tool_exec").length,
        traceIds: [...new Set(spans.map((s) => s.traceId))],
      };
    }
  } catch (e) {
    trace.fatalError = e instanceof Error ? e.message : String(e);
  } finally {
    trace.controlTriggers = getControlTriggerCounts();
    trace.modelCalls = provider.callRecords.map((r) => ({
      index: r.index,
      messageCount: r.messageCount,
      toolSchemaCount: r.toolSchemaCount,
    }));
    trace.reanchorPerCall = provider.callRecords.map((r) => r.hasReanchor);
    // 可观测面：事件总线在本次运行里真实产出的事件（治理/安全链路的硬证据）
    {
      const events = getEventLog();
      const counts: Record<string, number> = {};
      for (const e of events)
        counts[e.eventType] = (counts[e.eventType] ?? 0) + 1;
      trace.eventTypes = counts;
      trace.eventSequence = events.slice(0, 200).map((e) => e.eventType);
    }
    // 不可变区完整性：ADR-0005 要求 goal / immutableConstraints 不被任何压缩/摘要机制改动。
    // 判据 = 运行结束后 不可变区里**仍是场景声明的原始目标**（而不是被压缩改写过的版本）。
    // 注意不能在 executeLoop 之前取快照——那时 goal 还是空串，由 executeLoop 用 userInput 初始化，
    // 用"前后快照相等"会把这次正常初始化误判成被改动。
    const expectedGoal = scenario.task.goal ?? scenario.task.description;
    trace.goalIntact =
      liveGoal !== null && liveGoal.originalRequirement === expectedGoal;
    trace.durationMs = Date.now() - t0;
    // L5：DB 被注入关闭后，持久化失败必须留痕（读本次运行写在临时目录里的日志）
    if (trace.dbFailureEvidence.injected && dir) {
      try {
        shutdownLogger();
        const logDir = join(dir, "logs");
        if (existsSync(logDir)) {
          const files = readdirSync(logDir);
          trace.dbFailureEvidence.logFiles = files.length;
          for (const f of files) {
            const text = readFileSync(join(logDir, f), "utf8");
            for (const line of text.split(/\r?\n/)) {
              // 失败留痕的标记：dbFailureLog 的文案（"落库失败"/"数据库未初始化"）与 ERROR 级别
              if (/落库失败|数据库未初始化|ERROR/.test(line)) {
                trace.dbFailureEvidence.matchedLines.push(line.slice(0, 300));
                if (trace.dbFailureEvidence.matchedLines.length >= 20) break;
              }
            }
          }
        }
      } catch {
        /* 读日志失败不致命，matchedLines 为空即视为"未留痕" */
      }
    }
    if (approverTimer) clearInterval(approverTimer);
    try {
      closeDatabase();
    } catch {
      /* 收尾不抛 */
    }
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* 清理失败不致命 */
      }
    }
  }

  return trace;
}
