/**
 * S7 ↔ S8 · 端口适配层与组装闭环串接（真实实现，非功能性替身）
 *
 * 设计出处：Docs/Dev/L1编排设计/21-组装闭环.md（提议→校验→提交）· 19-OuterLoop.md ·
 *   23-原语补齐与监管快照.md §P3（节点推进经 P3）· 25-实现顺序与最小落地切分.md
 *
 * 与 `outerLoop.spec.ts` 的分工：那份用**功能性 S8 替身**测外层自身的六条纪律；
 * 本份把 S8 换成**真实**的 `ExecutableRegistry` / `AssemblyValidator` / `Assembler`，
 * 经 `createAssemblyPorts` 接入，并让执行件是**真实**的 E3(Workflow) → P3(NodeRunner) → E1(ReActCore) → P1。
 */
import { describe, it, expect } from "vitest";

import { ContextStore } from "../../Src/Services/Context/contextStore.js";
import { createContextAssembler } from "../../Src/Core/Context/contextAssembler.js";
import {
  createCheckpointRouter,
  createMemoryCheckpointBackend,
  componentCheckpointPort,
} from "../../Src/Core/Durable/checkpointRouter.js";
import {
  createChildRegistry,
  createDomainLedger,
} from "../../Src/Core/Ledger/ledgers.js";
import {
  createLifecycleController,
  type LifecycleController,
} from "../../Src/Core/Lifecycle/lifecycleController.js";
import {
  createExecutableRegistry,
  markFrozen,
  REGISTRY_VERSION,
  type ExecutableRegistry,
  type ExecutableSpec,
} from "../../Src/Core/Assembly/executableRegistry.js";
import {
  createAssembler,
  createAssemblyValidator,
  CRITERIA_VERSION,
  type AssemblySpec,
  type Violation,
} from "../../Src/Core/Assembly/assemblyPipeline.js";
import {
  createAssemblyPorts,
  asAssemblySpec,
  initialAssemblySpec,
} from "../../Src/Core/Orchestration/assemblyPorts.js";
import {
  createOuterLoop,
  ORCHESTRATION_TOOLS,
  type Assembly,
  type Executable,
  type OuterLoopDeps,
} from "../../Src/Core/Orchestration/outerLoop.js";
import { createWorkflow } from "../../Src/Core/Patterns/patterns.js";
import { createReActCore } from "../../Src/Core/Orchestration/reactCore.js";
import {
  createReActLoop,
  type LoopScope,
} from "../../Src/Core/Loop/reactLoop.js";
import { createLoopConfig } from "../../Src/Core/Loop/loopConfig.js";
import { ok, type Result } from "../../Src/Infra/types.js";

const SECTION = "ctx:zone:static";
const ROOT_SCOPE: LoopScope = { loopId: "L", agentId: "a1", traceId: "t1" };
const SPECS: ExecutableSpec[] = [
  { id: "c1", inputSections: [SECTION], toolSet: ["FileRead"] },
  { id: "c2", inputSections: [SECTION], toolSet: ["FileRead"] },
];

/** 真实 E3(Workflow) → P3(NodeRunner) → E1(ReActCore)：节点体只把模型迭代换成确定性桩 */
function realExecutable(id: string): Result<Executable> {
  const cfg = createLoopConfig({ model: "test-model", stream: false });
  if (!cfg.ok) return cfg;
  const nodeScope: LoopScope = {
    loopId: ROOT_SCOPE.loopId + "/N1",
    parentLoopId: ROOT_SCOPE.loopId,
    agentId: "a1",
    traceId: "t1",
  };
  const loop = createReActLoop(nodeScope, {
    runIteration: async () =>
      ok({
        outputText: "done",
        toolCalls: [],
        toolResults: [],
        tokensConsumed: 9,
        decision: { shouldContinue: false, exitReason: "success" as const },
        steps: [],
        events: [],
        shortCircuited: false,
      }),
  });
  if (!loop.ok) return loop;
  const core = createReActCore({
    id,
    scope: nodeScope,
    config: cfg.value,
    contract: {
      inputSet: { sections: [SECTION], history: { recentTurns: 2 } },
      outputSet: ["outer"],
      toolSet: ["FileRead"],
    },
    loop: loop.value,
  });
  if (!core.ok) return core;
  return createWorkflow({
    nodes: [
      { id: "N1", body: core.value, predecessors: [], joinMissing: "block" },
    ],
    entry: "N1",
    depth: 0,
    maxDepth: 0,
    scope: ROOT_SCOPE,
  });
}

function mkStack(
  opts: {
    specs?: ExecutableSpec[];
    extraCriterion?: { id: string; check: (spec: AssemblySpec) => Violation[] };
  } = {},
) {
  const registry = createExecutableRegistry(opts.specs ?? SPECS);
  if (!registry.ok) throw new Error("目录应可创建: " + registry.error);
  markFrozen(registry.value);

  const validator = createAssemblyValidator(
    registry.value,
    opts.extraCriterion ? [opts.extraCriterion] : [],
  );
  const persisted: AssemblySpec[] = [];
  const audited: Array<{ assemblyId: string; by: string; digest: string }> = [];
  const assembler = createAssembler(registry.value, validator, {
    persist: async (spec) => {
      persisted.push(spec);
      return ok(undefined);
    },
    retract: async (id) => {
      const idx = persisted.findIndex((s) => s.id === id);
      if (idx >= 0) persisted.splice(idx, 1);
      return ok(undefined);
    },
    audit: async (rec) => {
      audited.push({
        assemblyId: rec.assemblyId,
        by: rec.by,
        digest: rec.digest,
      });
      return ok(undefined);
    },
  });

  const ports = createAssemblyPorts({
    registry: registry.value,
    validator,
    assembler,
  });

  const store = new ContextStore();
  const contexts = createContextAssembler({
    store,
    now: () => 1000,
    pullMinIntervalMs: 30_000,
  });
  contexts.putSection({
    key: SECTION,
    content: "SP",
    changeFreq: 0,
    scope: "session",
  });
  const children = createChildRegistry();
  const domain = createDomainLedger("L1");
  const router = createCheckpointRouter(createMemoryCheckpointBackend());

  const exeR = realExecutable("c1");
  if (!exeR.ok) throw new Error("真实执行件应可创建: " + exeR.error);
  const exe2R = realExecutable("c2");
  if (!exe2R.ok) throw new Error("真实执行件应可创建: " + exe2R.error);
  const byId = new Map<string, Executable>([
    ["c1", exeR.value],
    ["c2", exe2R.value],
  ]);

  const initial = initialAssemblySpec({
    id: "A0",
    nodes: ["c1"],
    entrypoints: ["c1"],
    registry: registry.value,
  });
  if (!initial.ok) throw new Error("初始组装体应可创建: " + initial.error);

  return {
    ports,
    registry: registry.value,
    assembler,
    validator,
    persisted,
    audited,
    contexts,
    children,
    domain,
    router,
    byId,
    initial: initial.value,
  };
}

function mkDeps(
  stack: ReturnType<typeof mkStack>,
  over: Partial<Record<string, unknown>> = {},
): {
  deps: OuterLoopDeps;
  emitted: unknown[];
  controllers: LifecycleController[];
} {
  const emitted: unknown[] = [];
  const controllers: LifecycleController[] = [];
  const deps: OuterLoopDeps = {
    registry: stack.ports.registry,
    assembler: stack.ports.assembler,
    validator: stack.ports.validator,
    children: stack.children,
    domain: stack.domain,
    contexts: stack.contexts,
    controllerFor: (componentId: string) => {
      const r = createLifecycleController({
        askModel: async () => ({ next: "terminate" }),
        checkpoint: componentCheckpointPort(stack.router, componentId, "outer"),
      });
      if (!r.ok) throw new Error("控制器创建失败: " + r.error);
      controllers.push(r.value);
      return r.value;
    },
    resolveExecutable: (id: string) => stack.byId.get(id) ?? null,
    selectExecutable: () => "c1",
    selfTools: [...ORCHESTRATION_TOOLS],
    initialAssembly: stack.initial,
    goalSatisfied: () => true,
    budget: { remaining: 1000 },
    history: () => [{ role: "user", content: "把编排层跑通" }],
    dialogueId: "d1",
    goal: "G",
    emit: (e: unknown) => emitted.push(e),
    now: () => 1000,
    ...over,
  } as unknown as OuterLoopDeps;
  return { deps, emitted, controllers };
}

// ─────────────────────────────────────────────────────────────
describe("S7↔S8 · 适配层形状与版本口径", () => {
  it("初始组装体的版本一律取自**框架真源**（不由调用方填写）", () => {
    const stack = mkStack();
    expect(stack.initial.criteriaVersion).toBe(CRITERIA_VERSION);
    expect(stack.initial.registryVersion).toBe(REGISTRY_VERSION);
  });

  it("【负向】外层自造的**薄** Assembly 流经适配层 ⇒ 拒绝（缺 nodes/entrypoints 不补全）", () => {
    const thin: Assembly = {
      id: "A9",
      executables: ["c1"],
      criteriaVersion: "c",
      registryVersion: "r",
    };
    const r = asAssemblySpec(thin);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("缺少节点结构");
  });

  it("【负向】未注册的执行件加入组装体 ⇒ 提议即拒（悬空引用不落进候选）", async () => {
    const stack = mkStack();
    const r = await stack.ports.assembler.propose(stack.initial, {
      op: "add",
      added: { id: "ghost" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("执行件未注册");
  });

  it("【负向】版本漂移的组装体 ⇒ 真实判据 C-VER-1 拦下，且违规被翻成可读字符串", () => {
    const stack = mkStack();
    const drifted = {
      ...stack.initial,
      registryVersion: "reg-0",
    } as AssemblySpec;
    const v = stack.ports.validator.validate(
      drifted,
      stack.ports.registry.snapshot(),
    );
    expect(v.ok).toBe(false);
    expect(v.violations.join("|")).toContain("C-VER-1");
  });

  it("【负向】校验未通过 ⇒ 适配层不得提交", async () => {
    const stack = mkStack();
    const r = await stack.ports.assembler.commit(
      stack.initial,
      { ok: false, violations: ["C-FAKE@c1：自定义拦下"] },
      "c1",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("不得提交");
    expect(stack.persisted).toEqual([]);
  });

  it("目录端口只暴露 id（外层拿不到规格细节，也改不动只读目录）", () => {
    const stack = mkStack();
    expect(stack.ports.registry.resolve("c1")).toEqual({ id: "c1" });
    expect(stack.ports.registry.resolve("ghost")).toBeNull();
    expect(stack.ports.registry.snapshot()).toEqual({
      version: REGISTRY_VERSION,
      specs: SPECS,
    });
    expect(
      stack.registry.add({ id: "c3", inputSections: [], toolSet: [] }).ok,
    ).toBe(false); // 冻结
  });
});

// ─────────────────────────────────────────────────────────────
describe("S7↔S8 · 外层跑通真实组装闭环", () => {
  it("真实链路：外层 → 真实 E3 → P3 派生 → 真实 E1 → 提交组装变更（落盘+审计都发生）", async () => {
    const stack = mkStack();
    let first = true;
    // 用真实执行件，但让**第一周期**请求把 c2 加进组装体
    const real = stack.byId.get("c1")!;
    stack.byId.set("c1", {
      id: "c1",
      contract: real.contract,
      async step(input) {
        const out = await real.step(input);
        if (out.ok && first) {
          first = false;
          return ok({
            ...out.value,
            requestsAssemblyChange: { op: "add", added: { id: "c2" } },
          });
        }
        return out;
      },
    });

    const { deps, emitted } = mkDeps(stack, {
      // 域未收敛时继续跑；提交后收敛
      goalSatisfied: () => stack.assembler.commits().length > 0,
    });
    const loop = createOuterLoop(deps);
    if (!loop.ok) throw new Error("外层应可创建: " + loop.error);

    const r = await loop.value.run();
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("外层应跑通: " + r.error);

    expect(r.value.state).toBe("domain_complete");
    expect(loop.value.stats().assemblyChanges).toBe(1);
    // 真实提交器留痕：落盘一次、审计一次，且候选里确实有 c2
    expect(stack.persisted).toHaveLength(1);
    expect(stack.persisted[0]!.executables).toEqual(["c1", "c2"]);
    expect(stack.audited).toHaveLength(1);
    expect(stack.audited[0]!.by).toBe("c1");
    expect(emitted).toContainEqual({
      type: "assembly_committed",
      by: "c1",
      assemblyId: "A0",
    });
  });

  it("校验不通过 ⇒ **不提交**，只留痕 rejection（组装体保持原样）", async () => {
    const stack = mkStack({
      extraCriterion: {
        id: "C-FAKE-1",
        check: (spec) =>
          spec.executables.includes("c2")
            ? [
                {
                  criterion: "C-FAKE-1",
                  where: "c2",
                  reason: "测试判据：不许加 c2",
                },
              ]
            : [],
      },
    });
    const real = stack.byId.get("c1")!;
    stack.byId.set("c1", {
      id: "c1",
      contract: real.contract,
      async step(input) {
        const out = await real.step(input);
        return out.ok
          ? ok({
              ...out.value,
              requestsAssemblyChange: { op: "add", added: { id: "c2" } },
            })
          : out;
      },
    });

    const { deps, emitted } = mkDeps(stack);
    const loop = createOuterLoop(deps);
    if (!loop.ok) throw new Error("外层应可创建: " + loop.error);
    const r = await loop.value.run();
    expect(r.ok).toBe(true);
    expect(loop.value.stats().assemblyRejections).toBe(1);
    expect(loop.value.stats().assemblyChanges).toBe(0);
    expect(stack.assembler.commits()).toEqual([]);
    expect(
      emitted.some(
        (e) => (e as { type?: string }).type === "assembly_rejected",
      ),
    ).toBe(true);
  });

  it("真实执行件在链路里确实**收紧了工具集**并按 P3 派生出节点 loopId", async () => {
    const stack = mkStack();
    const seen: Array<{ tools: readonly string[]; produced?: unknown }> = [];
    const real = stack.byId.get("c1")!;
    stack.byId.set("c1", {
      id: "c1",
      contract: real.contract,
      async step(input) {
        seen.push({ tools: input.grants.tools });
        const out = await real.step(input);
        if (out.ok)
          seen.push({ tools: [], produced: out.value.produced.nodeLoopId });
        return out;
      },
    });

    const { deps } = mkDeps(stack);
    const loop = createOuterLoop(deps);
    if (!loop.ok) throw new Error("外层应可创建: " + loop.error);
    const r = await loop.value.run();
    expect(r.ok).toBe(true);
    // 外层按契约授予 ⇒ 节点拿到的仍是契约内集合；节点 loopId 由 P3 派生
    expect(seen[0]!.tools).toEqual(["FileRead"]);
    expect(seen[1]!.produced).toBe("L/N1");
  });

  it("【负向】组装体里的 id 解析不到执行件 ⇒ 外层报错而不是静默跳过", async () => {
    const stack = mkStack();
    const { deps } = mkDeps(stack, { resolveExecutable: () => null });
    const loop = createOuterLoop(deps);
    if (!loop.ok) throw new Error("外层应可创建: " + loop.error);
    const r = await loop.value.run();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("执行件未注册");
  });

  it("【负向】预算耗尽 ⇒ degrade 收尾并带出 gaps（不假装完成）", async () => {
    const stack = mkStack();
    const { deps } = mkDeps(stack, {
      goalSatisfied: () => false,
      budget: { remaining: 0 },
    });
    const loop = createOuterLoop(deps);
    if (!loop.ok) throw new Error("外层应可创建: " + loop.error);
    const r = await loop.value.run();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.state).toBe("degraded");
    expect(r.value.gaps.join("|")).toContain("预算耗尽");
  });

  it("真实提交后的组装体可被**恢复校验**接住；版本漂移的则被拒", () => {
    const stack = mkStack();
    const restored = stack.assembler.restore(stack.initial, {
      criteriaVersion: CRITERIA_VERSION,
      registryVersion: REGISTRY_VERSION,
    });
    expect(restored.ok).toBe(true);

    const drifted = stack.assembler.restore(
      { ...stack.initial, criteriaVersion: "old" } as AssemblySpec,
      { criteriaVersion: CRITERIA_VERSION, registryVersion: REGISTRY_VERSION },
    );
    expect(drifted.ok).toBe(false);
    if (!drifted.ok) expect(drifted.error).toContain("criteriaVersion");
  });
});
