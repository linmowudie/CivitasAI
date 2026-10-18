/**
 * @module Orchestration/l1Entry
 * @description **L1 执行入口（P2 融合）**：以 L1 编排内核为所有者跑一次 L1 对话。
 *
 * 融合形态（[29-融合方案](../Docs/Dev/L1编排设计/29-融合方案-内核优先.md) §2）：
 *   外层 `OuterLoop`（选件/收敛/组装）→ 内核内层组件 `ReActCore`
 *   → `ReActLoop`（默认实现 = **legacy `runIteration` 十步**）。
 *
 * 本入口只做装配，不复制任何判定：
 * - 账本来自 LedgerHub（同一份 L1 域/下级账本）；
 * - 组装目录/校验/提交来自 `orchestrationRuntime`（P1 的同一套 registry/validator/assembler）；
 * - 上下文来自 `Core/Context` 的 ContextAssembler；
 * - 生命周期控制器来自 `Core/Lifecycle`（每组件一份）；
 * - 持久化走 `Core/Durable` checkpointRouter（P3 再接 DB 后端）。
 *
 * flag：`isOrchestrationKernelEnabled()`（环境变量 `CIVITAS_ORCHESTRATION_KERNEL=1`，默认关闭）。
 * 关闭时生产路径保持 legacy；开启后才把 L1 角色任务路由到本入口。
 */

import { createContextAssembler } from "../Context/contextAssembler.js";
import {
  createCheckpointRouter,
  createMemoryCheckpointBackend,
  componentCheckpointPort,
} from "../Durable/checkpointRouter.js";
import { createDbCheckpointBackend } from "../Durable/dbCheckpointBackend.js";
import {
  createComponentSnapshot,
  createSupervisionChannel,
  type ComponentSupervisionSnapshot,
  type SupervisionChannel,
} from "../Supervision/componentSnapshot.js";
import { evaluateGoal, type GoalDecl } from "../Goal/goalEvaluator.js";
import type { RoutingMode } from "../Decision/types.js";
import type { ContextSelector } from "../Context/contextAssembler.js";
import {
  createLifecycleController,
  type LifecycleController,
} from "../Lifecycle/lifecycleController.js";
import { createLoopConfig, type LoopConfig } from "../Loop/loopConfig.js";
import {
  createReActLoop,
  type LoopScope,
  type ReActLoop,
} from "../Loop/reactLoop.js";
import { createWorkflow } from "../Patterns/patterns.js";
import { createReActCore } from "./reactCore.js";
import {
  createOuterLoop,
  ORCHESTRATION_TOOLS,
  type Executable,
  type ExecutableContract,
  type OuterLoopDeps,
  type TaskOutcome,
} from "./outerLoop.js";
import {
  getAssemblyPorts,
  currentAssemblySpec,
} from "./orchestrationRuntime.js";
import { ensureL1Host } from "./ledgerHub.js";
import { ContextStore } from "../../Services/Context/contextStore.js";
import { getRoutingConfig } from "../../Infra/Llm/Router/modelRouter.js";
import { ok, err } from "../../Infra/types.js";
import type { Result } from "../../Infra/types.js";
import { logger } from "../../Infra/Logging/logger.js";

/** 静态分区键（与十步循环静态区口径一致） */
const STATIC_SECTION = "ctx:zone:static";

// ── flag（P2：默认关闭，关闭时生产行为不变）────────────────────────────
let kernelEnabled = process.env["CIVITAS_ORCHESTRATION_KERNEL"] === "1";

/** 编排内核路由是否开启（L1 角色任务是否走外层循环） */
export function isOrchestrationKernelEnabled(): boolean {
  return kernelEnabled;
}

/** 设置 flag（测试/运维用；生产默认由环境变量决定） */
export function setOrchestrationKernelEnabled(enabled: boolean): void {
  kernelEnabled = enabled;
}

/**
 * 选件策略（P3 最小生产策略）：
 * - DIRECT / REGULATION：固定取组装体首件（单组件语义，直到域收敛）；
 * - 其余模式：按周期轮转组装体（DELEGATION/CONSORTIUM/ASSEMBLY_LINE/LITIGATION）。
 * 说明：六模式预设（Core/Patterns/presets）尚未接入，这里是可替换的显式缝。
 */
export function selectExecutableForMode(
  assembly: { executables: readonly string[] },
  state: { cycle: number },
  mode: RoutingMode,
): string | null {
  if (assembly.executables.length === 0) return null;
  if (mode === "DIRECT" || mode === "REGULATION")
    return assembly.executables[0] ?? null;
  return (
    assembly.executables[state.cycle % assembly.executables.length] ?? null
  );
}

/** 一次 L1 对话的运行参数 */
export interface RunL1DialogueParams {
  agentId: string;
  task: string;
  /** 目标声明（收敛判定的输入；缺省视为"未声明目标"） */
  goal?: string;
  traceId?: string;
  dialogueId?: string;
  /** 固定根 loopId（测试用；缺省按 agent+时间生成） */
  loopId?: string;
  maxCycles?: number;
  /** 收敛判据（缺省 = 未达成，运行到 maxCycles 后如实 degraded） */
  goalSatisfied?: () => boolean;
  /** 测试注入：内层 ReActLoop（缺省 = 真实 runIteration） */
  innerLoop?: ReActLoop;
  /** 测试注入：解析执行件（缺省由内核内层组件构造真实执行件） */
  executableFor?: (id: string) => Executable | null;
  emit?: (event: unknown) => void;
  /** 监管指令通道（外部可 place 指令；缺省自建一个空通道） */
  supervision?: SupervisionChannel;
  /** 选件模式（缺省 DIRECT；决定 selectExecutable 的轮转策略） */
  mode?: RoutingMode;
  /** 目标声明：提供后由 Core/Goal 的 GoalEvaluator 判定收敛（需同时给 digest） */
  goalDecl?: GoalDecl;
  /** 当前不可变区摘要（GoalEvaluator 的判定基础；缺失则无法判定） */
  immutableZoneDigest?: () => string;
}

/** L1 对话结果（TaskOutcome + 归属信息） */
export interface RunL1DialogueOutcome extends TaskOutcome {
  loopId: string;
  agentId: string;
  /** 内层真实消耗（由 ReActLoop meter 上报，不是估算） */
  tokensConsumed: number;
  /** 检查点后端（db = Core/Durable DB 后端；memory = 降级） */
  checkpointBackend: "db" | "memory";
  /** 生命周期控制器数量（每组件一份） */
  controllers: number;
  /** 监管读侧：每组件一份快照（P3 读缝） */
  snapshots: ComponentSupervisionSnapshot[];
  /** 本次实际使用的选件模式 */
  mode: RoutingMode;
}

/**
 * 跑一次 L1 对话（外层循环编排；内层仍是 legacy `runIteration`）。
 */
export async function runL1Dialogue(
  params: RunL1DialogueParams,
): Promise<Result<RunL1DialogueOutcome>> {
  const assemblyPorts = getAssemblyPorts();
  const assembly = currentAssemblySpec();
  if (!assemblyPorts || !assembly) {
    return err(
      "编排运行时未初始化：请先在组合根初始化 orchestrationRuntime（P1）",
    );
  }

  const agentId = params.agentId.trim();
  if (!agentId) return err("L1 执行入口缺少 agentId");
  const task = params.task.trim();
  if (!task) return err("L1 执行入口缺少 task");

  // ① 账本：来自 LedgerHub（与分裂/监管共用同一份）
  const hostResult = ensureL1Host(agentId);
  if (!hostResult.ok) return err(`L1 账本不可用：${hostResult.error}`);
  const host = hostResult.value;

  const traceId =
    params.traceId ?? `trace-l1-${agentId}-${Date.now().toString(36)}`;
  const rootLoopId =
    params.loopId ?? `l1-${agentId}-${Date.now().toString(36)}`;
  const rootScope: LoopScope = { loopId: rootLoopId, agentId, traceId };
  const dialogueId = params.dialogueId ?? `dlg-${rootLoopId}`;

  // ② 上下文装配（内核 C4）
  const store = new ContextStore();
  const contexts = createContextAssembler({ store, now: () => Date.now() });
  const GOAL_SECTION = "ctx:zone:goal";
  // 执行件契约声明的静态区必须先在装配器登记（否则外层报"未注册的分区"）
  contexts.putSection({
    key: STATIC_SECTION,
    content: "",
    changeFreq: 0,
    scope: "session",
  });
  contexts.putSection({
    key: GOAL_SECTION,
    content: params.goal ?? "",
    changeFreq: 0.2,
    scope: "dialogue",
  });

  // ③ 持久化（P3：优先 Core/Durable 的 DB 后端；初始化异常才降级 memory，并如实返回）
  let checkpointBackend: "db" | "memory" = "db";
  let router: ReturnType<typeof createCheckpointRouter>;
  try {
    router = createCheckpointRouter(createDbCheckpointBackend());
  } catch (e) {
    checkpointBackend = "memory";
    logger.warn("DB 检查点后端不可用，降级为内存后端", {
      source: "Orchestration/l1Entry",
      error: e instanceof Error ? e.message : String(e),
    });
    router = createCheckpointRouter(createMemoryCheckpointBackend());
  }

  // ③.5 监管通道（P3：控制器在创建时必须接上 supervision hook，否则 intervene 报错）
  const supervision = params.supervision ?? createSupervisionChannel();

  // ④ 生命周期控制器：每组件一份（askModel 为唯一外部智能入口；P2 保守终止）
  const controllers = new Map<string, LifecycleController>();
  const controllerFor = (componentId: string): LifecycleController => {
    const cached = controllers.get(componentId);
    if (cached) return cached;
    const created = createLifecycleController({
      askModel: async () => ({ next: "terminate" }),
      checkpoint: componentCheckpointPort(router, componentId, "outer"),
      supervision: supervision.hook,
    });
    if (!created.ok) {
      throw new Error(
        `生命周期控制器创建失败（${componentId}）：${created.error}`,
      );
    }
    controllers.set(componentId, created.value);
    return created.value;
  };

  // ⑤ 执行件解析：内核内层组件（ReActCore）→ 内层 ReActLoop（默认 legacy runIteration）
  const cfgResult = createLoopConfig({
    model:
      getRoutingConfig()?.workerModel ||
      getRoutingConfig()?.defaultModel ||
      "worker-model",
    stream: false,
  });
  if (!cfgResult.ok) return err(`Loop 配置不可用：${cfgResult.error}`);
  const config: LoopConfig = cfgResult.value;

  const contract: ExecutableContract = {
    inputSet: { sections: [STATIC_SECTION], history: { recentTurns: 2 } },
    outputSet: ["outer"],
    toolSet: [],
  };

  // 真实计量：内层 ReActLoop 只上报本实例用量（R5），这里汇总到对话级
  const usage = { tokens: 0, iterations: 0 };

  // 目标判定输入：执行件产出的聚合（只读记录，不改执行行为）
  const produced: Array<Record<string, unknown>> = [];

  const built = new Map<string, Executable>();
  const buildExecutable = (id: string): Result<Executable> => {
    // 节点体 scope 必须与 NodeRunner（P3）的唯一派生点一致：父 loopId + "/N1"。
    // 自造 `/<executableId>` 会被判"第二个派生者"并拒绝（实测）。
    const nodeScope: LoopScope = {
      loopId: `${rootLoopId}/N1`,
      parentLoopId: rootLoopId,
      agentId,
      traceId,
    };
    // 生产路径：真实 ReActLoop（默认 legacy runIteration）+ meter 上报；测试路径：注入的 loop 原样使用
    let loop: ReActLoop | undefined = params.innerLoop;
    if (!loop) {
      const created = createReActLoop(nodeScope, {
        meter: (_loopId, used) => {
          usage.tokens += used.tokens;
          usage.iterations += used.iterations;
        },
      });
      if (!created.ok) return created;
      loop = created.value;
    }
    const coreResult = createReActCore({
      id,
      contract,
      scope: nodeScope,
      config,
      sessionId: dialogueId,
      agentRole: "partner",
      loop,
      contextStore: store,
      taskOf: () => task,
    });
    if (!coreResult.ok) return coreResult;
    return createWorkflow({
      nodes: [
        {
          id: "N1",
          body: coreResult.value,
          predecessors: [],
          joinMissing: "block",
        },
      ],
      entry: "N1",
      depth: 0,
      maxDepth: 0,
      scope: rootScope,
    });
  };

  const wrapWithProducedRecorder = (exe: Executable): Executable => ({
    id: exe.id,
    contract: exe.contract,
    async step(input) {
      const out = await exe.step(input);
      if (out.ok) produced.push(out.value.produced as Record<string, unknown>);
      return out;
    },
  });

  const resolveExecutable = (id: string): Executable | null => {
    if (params.executableFor) {
      const injected = params.executableFor(id);
      return injected ? wrapWithProducedRecorder(injected) : null;
    }
    const cached = built.get(id);
    if (cached) return cached;
    const created = buildExecutable(id);
    if (!created.ok) {
      logger.warn("L1 执行件构造失败", {
        source: "Orchestration/l1Entry",
        id,
        error: created.error,
      });
      return null;
    }
    const wrapped = wrapWithProducedRecorder(created.value);
    built.set(id, wrapped);
    return wrapped;
  };

  const mode: RoutingMode = params.mode ?? "DIRECT";

  // 收敛判据优先级：调用方给定 > Core/Goal 判定（需 goalDecl+digest） > 无 goal 时的域收敛
  const goalSatisfied = (): boolean => {
    if (params.goalSatisfied) return params.goalSatisfied();
    if (params.goalDecl && params.immutableZoneDigest) {
      const aggregate: Record<string, unknown> = Object.assign({}, ...produced);
      const verdict = evaluateGoal({
        goal: params.goalDecl,
        produced: aggregate,
        immutableZoneDigest: params.immutableZoneDigest(),
      });
      return verdict.ok && verdict.value.satisfied;
    }
    return params.goal === undefined;
  };

  // ⑥ 外层依赖：全部来自真实模块（账本/上下文/控制器/端口）
  const deps: OuterLoopDeps = {
    registry: assemblyPorts.registry,
    assembler: assemblyPorts.assembler,
    validator: assemblyPorts.validator,
    children: host.children,
    domain: host.domain,
    contexts,
    controllerFor,
    resolveExecutable,
    // 选件策略（P2 最小）：直接取组装体第一个执行件；后续由模式预设替换
    selectExecutable: (current, state) =>
      selectExecutableForMode(current, state, mode),
    selfTools: [...ORCHESTRATION_TOOLS],
    initialAssembly: assembly,
    // 收敛判据：调用方给定优先；未声明目标时以"域收敛（所有成员完成）"为达成
    // （goal 缺省 = 不构成收敛门；一旦声明 goal 却没有判据，则如实保持未达成）。
    goalSatisfied,
    budget: { remaining: 1_000_000 },
    history: () => [{ role: "user", content: task }],
    dialogueId,
    goal: params.goal ?? task,
    emit: params.emit ?? (() => {}),
    now: () => Date.now(),
    ...(params.maxCycles !== undefined ? { maxCycles: params.maxCycles } : {}),
  };

  const loopResult = createOuterLoop(deps);
  if (!loopResult.ok) return err(`外层循环创建失败：${loopResult.error}`);

  const ran = await loopResult.value.run();
  if (!ran.ok) return err(`外层循环执行失败：${ran.error}`);

  // 监管读侧（P3）：每组件一份快照（可见面是宿主可见面的真子集）
  const HOST_SELECTOR: ContextSelector = {
    sections: [STATIC_SECTION, GOAL_SECTION],
    history: { recentTurns: 2 },
  };
  const VISIBLE_SELECTOR: ContextSelector = {
    sections: [STATIC_SECTION],
    history: { recentTurns: 1 },
  };
  const snapshots: ComponentSupervisionSnapshot[] = [];
  for (const componentId of controllers.keys()) {
    const snapshotter = createComponentSnapshot({
      contexts,
      children: host.children,
      domain: host.domain,
      controller: controllerFor(componentId),
      channel: supervision,
      history: () => [{ role: "user", content: task }],
      diagnostics: () => ({
        agentId,
        loopId: rootLoopId,
        assemblyId: assembly.id,
      }),
    });
    const snap = snapshotter.snapshot({
      componentId,
      visible: VISIBLE_SELECTOR,
      host: HOST_SELECTOR,
    });
    if (snap.ok) snapshots.push(snap.value);
    else {
      logger.warn("监管快照生成失败（读缝）", {
        source: "Orchestration/l1Entry",
        componentId,
        error: snap.error,
      });
    }
  }

  logger.info("L1 对话完成（编排内核）", {
    source: "Orchestration/l1Entry",
    agentId,
    loopId: rootLoopId,
    state: ran.value.state,
    cycles: ran.value.cycles,
    assemblyId: ran.value.assemblyId,
  });

  return ok({
    ...ran.value,
    loopId: rootLoopId,
    agentId,
    tokensConsumed: usage.tokens,
    checkpointBackend,
    controllers: controllers.size,
    snapshots,
    mode,
  });
}
