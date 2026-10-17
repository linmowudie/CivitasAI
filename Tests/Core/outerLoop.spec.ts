/**
 * S7 · OuterLoop 负向测试（宿主循环）
 *
 * 用**真实的** S3/S4/S5/S6 组件（LifecycleController / ChildRegistry / DomainLedger / ContextAssembler /
 * 真实 ContextStore），只对"尚未实现的 S8 端口"（装配器/校验器/目录）注入**功能性实现**。
 * 纪律（25 §1）：负向用例必须真实调用。
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
import { createLifecycleController } from "../../Src/Core/Lifecycle/lifecycleController.js";
import {
  createOuterLoop,
  ORCHESTRATION_TOOLS,
  type Assembly,
  type AssemblyChange,
  type Executable,
  type ExecutableContract,
  type ReactInput,
  type ReactOutput,
  type TaskOutcome,
} from "../../Src/Core/Orchestration/outerLoop.js";
import { ok, err, type Result } from "../../Src/Infra/types.js";

const CONTRACT: ExecutableContract = {
  inputSet: { sections: ["ctx:zone:static"], history: { recentTurns: 2 } },
  outputSet: ["outer"],
  toolSet: ["FileRead"],
};

function mkExecutable(
  id: string,
  script: ReactOutput[],
): { exe: Executable; inputs: ReactInput[] } {
  const inputs: ReactInput[] = [];
  let i = 0;
  return {
    inputs,
    exe: {
      id,
      contract: CONTRACT,
      step: async (input: ReactInput): Promise<Result<ReactOutput>> => {
        inputs.push(input);
        const out = script[Math.min(i, script.length - 1)];
        i += 1;
        if (!out) return err("脚本为空");
        return ok(out);
      },
    },
  };
}

function out(partial: Partial<ReactOutput> = {}): ReactOutput {
  return {
    produced: {},
    events: [],
    needsDecision: [],
    usage: { tokens: 1, iterations: 1 },
    ...partial,
  };
}

/** S8 尚未实现：这里给出**功能性**装配器/校验器/目录（测试范围实现，非产品代码） */
function mkStack(
  opts: {
    validateOk?: boolean;
    resolveExecutable?: (id: string) => Executable | null;
  } = {},
) {
  const store = new ContextStore();
  const contexts = createContextAssembler({
    store,
    now: () => 1000,
    pullMinIntervalMs: 30_000,
  });
  // 执行件契约声明的分区必须**已注册**（否则 assemble 会正当拒绝）
  contexts.putSection({
    key: "ctx:zone:static",
    content: "SP",
    changeFreq: 0,
    scope: "session",
  });
  const children = createChildRegistry();
  const domain = createDomainLedger("L1");

  // S4 真实落盘路由（内存后端）：组件挂起必须有地方落，否则 S3 会正确拒绝"挂而不存"
  const router = createCheckpointRouter(createMemoryCheckpointBackend());
  router.registerWriter("component", "c1", "outer");

  const commits: Assembly[] = [];
  const registry = {
    resolve: (ref: string) =>
      opts.resolveExecutable?.(ref) ? { id: ref } : null,
    snapshot: () => ({ version: "r1" }),
  };
  const assembler = {
    propose: async (
      current: Assembly,
      change: AssemblyChange,
    ): Promise<Result<Assembly>> => {
      const next: Assembly = {
        ...current,
        id: current.id + "+" + change.op,
        executables:
          change.op === "add" && change.added
            ? [...current.executables, change.added.id]
            : current.executables,
      };
      return ok(next);
    },
    commit: async (candidate: Assembly): Promise<Result<void>> => {
      commits.push(candidate);
      return ok(undefined);
    },
  };
  const validator = {
    validate: () =>
      opts.validateOk === false
        ? { ok: false, violations: ["悬空引用: ghost"] }
        : { ok: true, violations: [] },
  };
  return {
    store,
    contexts,
    children,
    domain,
    registry,
    assembler,
    validator,
    commits,
    router,
  };
}

function baseDeps(
  stack: ReturnType<typeof mkStack>,
  over: Record<string, unknown> = {},
) {
  const emitted: unknown[] = [];
  const initialAssembly: Assembly = {
    id: "A0",
    executables: ["c1"],
    criteriaVersion: "crit-1",
    registryVersion: "reg-1",
  };
  return {
    emitted,
    deps: {
      registry: stack.registry,
      assembler: stack.assembler,
      validator: stack.validator,
      children: stack.children,
      domain: stack.domain,
      contexts: stack.contexts,
      controllerFor: (id: string) => {
        const r = createLifecycleController({
          askModel: async () => ({ next: "terminate" }),
          // ★ 接上 S4：组件空间的落盘端口（不注入 ⇒ suspend 会正当地失败）
          checkpoint: componentCheckpointPort(stack.router, id, "outer"),
        });
        if (!r.ok) throw new Error("控制器创建失败: " + r.error);
        return r.value;
      },
      resolveExecutable: () => null,
      selectExecutable: () => "c1",
      selfTools: [...ORCHESTRATION_TOOLS],
      initialAssembly,
      goalSatisfied: () => true,
      budget: { remaining: 100 },
      history: () => [],
      dialogueId: "d1",
      goal: "G",
      emit: (e: unknown) => emitted.push(e),
      now: () => 1000,
      ...over,
    },
  };
}

describe("S7 · OuterLoop 构造期纪律", () => {
  it("【负向】外层工具集含业务工具 ⇒ **拒绝创建**", () => {
    const stack = mkStack();
    const { deps } = baseDeps(stack, {
      selfTools: ["OrchestratorCompose", "FileRead"],
    });
    const r = createOuterLoop(deps as never);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("非编排类工具");
  });
});

describe("S7 · 收敛与选件顺序", () => {
  it("【负向】域已完成 + Goal 达成 ⇒ **一次选件都不发生**（收敛判定先于选件）", async () => {
    const stack = mkStack();
    stack.domain.setSelfState("done");
    let selects = 0;
    const { deps } = baseDeps(stack, {
      selectExecutable: () => {
        selects += 1;
        return "c1";
      },
      goalSatisfied: () => true,
    });
    const loop = createOuterLoop(deps as never);
    expect(loop.ok).toBe(true);
    if (!loop.ok) return;
    const res = await loop.value.run();
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.state).toBe("domain_complete");
    expect(selects).toBe(0);
    expect(loop.value.stats().selects).toBe(0);
  });

  it("【负向】兄弟未收敛 ⇒ **绝不**宣布域完成（持续工作到上限并报错）", async () => {
    const stack = mkStack();
    stack.domain.addPeer("peer-1", "domain-a"); // 兄弟一直在跑
    stack.domain.setSelfState("done");
    const { exe } = mkExecutable("c1", [
      out({ needsDecision: [{ event: "iteration.exited" }] }),
    ]);
    const { deps } = baseDeps(stack, {
      resolveExecutable: () => exe,
      selectExecutable: () => "c1",
      maxCycles: 3,
    });
    const loop = createOuterLoop(deps as never);
    if (!loop.ok) return;
    const res = await loop.value.run();
    // 既不完成、也不允许无限空转：到上限即报错
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("超过最大周期");
    expect(loop.value.stats().cycles).toBe(3);
    expect(stack.domain.domainQuiescent()).toBe(false);
  });

  it("【负向】子代未收敛 ⇒ **绝不**宣布完成（持续工作到上限并报错）", async () => {
    const stack = mkStack();
    stack.children.register({ childId: "kid-1", joinedAt: 0 });
    stack.domain.setSelfState("done");
    const { exe } = mkExecutable("c1", [
      out({ needsDecision: [{ event: "iteration.exited" }] }),
    ]);
    const { deps } = baseDeps(stack, {
      resolveExecutable: () => exe,
      selectExecutable: () => "c1",
      maxCycles: 3,
    });
    const loop = createOuterLoop(deps as never);
    if (!loop.ok) return;
    const res = await loop.value.run();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("超过最大周期");
    expect(stack.children.quiescent()).toBe(false);
  });

  it("预算耗尽 ⇒ degrade 收尾并带缺口（不假装完成）", async () => {
    const stack = mkStack();
    const { deps } = baseDeps(stack, {
      budget: { remaining: 0 },
      goalSatisfied: () => false,
    });
    const loop = createOuterLoop(deps as never);
    if (!loop.ok) return;
    const res = await loop.value.run();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.state).toBe("degraded");
      expect(res.value.gaps).toContain("预算耗尽");
    }
  });
});

describe("S7 · needs_decision 不得丢弃", () => {
  it("机械事件 child.spawned ⇒ 登记账本（带 payload.childId）", async () => {
    const stack = mkStack();
    const { exe } = mkExecutable("c1", [
      out({
        needsDecision: [
          { event: "child.spawned", payload: { childId: "kid-1" } },
        ],
      }),
      out({
        needsDecision: [
          {
            event: "child.settled",
            payload: { childId: "kid-1", outcome: "success" },
          },
        ],
      }),
      out({ needsDecision: [{ event: "iteration.exited" }] }),
    ]);
    const { deps } = baseDeps(stack, {
      resolveExecutable: () => exe,
      selectExecutable: () => "c1",
    });
    const loop = createOuterLoop(deps as never);
    if (!loop.ok) return;
    const res = await loop.value.run();
    expect(res.ok).toBe(true);
    expect(loop.value.stats().handledDecisions).toBeGreaterThanOrEqual(3);
    expect(stack.children.get("kid-1")?.outcome).toBe("success");
  });

  it("【负向】child.spawned 缺 payload.childId ⇒ 报错（不静默跳过）", async () => {
    const stack = mkStack();
    const { exe } = mkExecutable("c1", [
      out({ needsDecision: [{ event: "child.spawned" }] }),
    ]);
    const { deps } = baseDeps(stack, { resolveExecutable: () => exe });
    const loop = createOuterLoop(deps as never);
    if (!loop.ok) return;
    const res = await loop.value.run();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("childId");
  });

  it("【负向】待决事项含**闭集之外**的事件 ⇒ 报错", async () => {
    const stack = mkStack();
    const { exe } = mkExecutable("c1", [
      out({ needsDecision: [{ event: "bogus.event" as never }] }),
    ]);
    const { deps } = baseDeps(stack, { resolveExecutable: () => exe });
    const loop = createOuterLoop(deps as never);
    if (!loop.ok) return;
    const res = await loop.value.run();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("未知事件");
  });

  it("需判断事件 iteration.exited ⇒ 交给控制器（组件终止后域成员标记完成）", async () => {
    const stack = mkStack();
    const { exe } = mkExecutable("c1", [
      out({ needsDecision: [{ event: "iteration.exited" }] }),
    ]);
    const { deps } = baseDeps(stack, { resolveExecutable: () => exe });
    const loop = createOuterLoop(deps as never);
    if (!loop.ok) return;
    const res = await loop.value.run();
    expect(res.ok).toBe(true);
    expect(stack.domain.snapshot().selfState).toBe("done");
  });
});

describe("S7 · 组装变更与恒定区", () => {
  it("校验通过 ⇒ 提交且组装体更新（统计 assemblyChanges=1）", async () => {
    const stack = mkStack({ validateOk: true });
    const { exe } = mkExecutable("c1", [
      out({
        requestsAssemblyChange: { op: "add", added: { id: "c2" } },
        needsDecision: [{ event: "iteration.exited" }],
      }),
    ]);
    const { deps } = baseDeps(stack, { resolveExecutable: () => exe });
    const loop = createOuterLoop(deps as never);
    if (!loop.ok) return;
    await loop.value.run();
    expect(stack.commits.length).toBe(1);
    expect(loop.value.stats().assemblyChanges).toBe(1);
  });

  it("【负向】校验不通过 ⇒ **不提交**、留痕、也不改组装体", async () => {
    const stack = mkStack({ validateOk: false });
    const { exe } = mkExecutable("c1", [
      out({ requestsAssemblyChange: { op: "add", added: { id: "ghost" } } }),
      out({ needsDecision: [{ event: "iteration.exited" }] }),
    ]);
    const { deps, emitted } = baseDeps(stack, { resolveExecutable: () => exe });
    const loop = createOuterLoop(deps as never);
    if (!loop.ok) return;
    await loop.value.run();
    expect(stack.commits.length).toBe(0);
    expect(loop.value.stats().assemblyRejections).toBeGreaterThanOrEqual(1);
    expect(
      emitted.some(
        (e) => (e as { type?: string }).type === "assembly_rejected",
      ),
    ).toBe(true);
  });

  it("【负向】外层运行**不改恒定区**（前缀稳定）", async () => {
    const stack = mkStack();
    const first = stack.contexts.applyConstantZone("SP", ["FileRead"]);
    expect(first.ok).toBe(true);
    const hashBefore = stack.contexts.diagnostics().constantHash;
    const { exe } = mkExecutable("c1", [
      out({ needsDecision: [{ event: "iteration.exited" }] }),
    ]);
    const { deps } = baseDeps(stack, { resolveExecutable: () => exe });
    const loop = createOuterLoop(deps as never);
    if (!loop.ok) return;
    await loop.value.run();
    expect(stack.contexts.diagnostics().constantHash).toBe(hashBefore);
  });
});

describe("S7 · ReactInput 由外部构造", () => {
  it("执行件收到的 state/control/observation/grants 全部来自外层", async () => {
    const stack = mkStack();
    const { exe, inputs } = mkExecutable("c1", [
      out({ needsDecision: [{ event: "iteration.exited" }] }),
    ]);
    const { deps } = baseDeps(stack, { resolveExecutable: () => exe });
    const loop = createOuterLoop(deps as never);
    if (!loop.ok) return;
    await loop.value.run();
    expect(inputs.length).toBeGreaterThan(0);
    const i = inputs[0]!;
    expect(i.state).toBe("running");
    expect(i.control.shouldContinue).toBe(true);
    expect(i.control.budgetRemaining).toBe(100);
    expect(i.grants.tools).toEqual(CONTRACT.toolSet);
    // observation 只含**声明**的分区
    expect(
      i.observation.contextSections.every((s) =>
        CONTRACT.inputSet.sections.includes(s.key),
      ),
    ).toBe(true);
  });

  it("【负向】组装体中没有可执行件 ⇒ 报错（不空转）", async () => {
    const stack = mkStack();
    const { deps } = baseDeps(stack, {
      selectExecutable: () => null,
      goalSatisfied: () => false,
    });
    const loop = createOuterLoop(deps as never);
    if (!loop.ok) return;
    const res = await loop.value.run();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("没有可执行的组件");
  });

  it("【负向】执行件 id 无法解析 ⇒ 报错", async () => {
    const stack = mkStack();
    const { deps } = baseDeps(stack, {
      resolveExecutable: () => null,
      selectExecutable: () => "ghost",
    });
    const loop = createOuterLoop(deps as never);
    if (!loop.ok) return;
    const res = await loop.value.run();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("执行件未注册");
  });

  it("【负向】超过最大周期 ⇒ 报错（防死循环）", async () => {
    const stack = mkStack();
    const { exe } = mkExecutable("c1", [out({})]); // 永不收敛
    const { deps } = baseDeps(stack, {
      resolveExecutable: () => exe,
      goalSatisfied: () => false,
      maxCycles: 3,
    });
    const loop = createOuterLoop(deps as never);
    if (!loop.ok) return;
    const res = await loop.value.run();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("超过最大周期");
  });
});
