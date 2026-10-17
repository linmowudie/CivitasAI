/**
 * C6 的工具身份 —— `OrchestratorCompose` / `OrchestratorSelect` 接线测试
 *
 * 覆盖：`Docs/Dev/L1编排设计/21-组装闭环.md` §0（闭环）· §5 反例 1/2/3/10 ·
 *   02-组装器与算子闭集.md §1（外层用组装工具改结构 / 选择下一组件）·
 *   28-设计实现覆盖清点.md G2（Tools 层工具实现）
 *
 * 纪律（25 §1）：**负向用例必须真实调用**。本文件不 mock 校验器/装配器/目录 ——
 * 全部走 `Core/Assembly` 的真实实现，只把"落盘/审计/采用"三个端口换成可记录的内存端口
 * （它们本来就是外部副作用，落盘端口由组合根提供）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  createExecutableRegistry,
  markFrozen,
  REGISTRY_VERSION,
  type ExecutableSpec,
  type ExecutableRegistry,
} from "../../Src/Core/Assembly/executableRegistry.js";
import {
  createAssemblyValidator,
  createAssembler,
  CRITERIA_VERSION,
  type AssemblyNode,
  type AssemblySpec,
} from "../../Src/Core/Assembly/assemblyPipeline.js";
import {
  createOrchestrationToolPort,
  type OrchestrationToolPort,
} from "../../Src/Core/Orchestration/orchestrationToolPort.js";
import { ok, err, type Result } from "../../Src/Infra/types.js";

import { orchestratorCompose } from "../../Src/Tools/Custom/orchestratorCompose.js";
import { orchestratorSelect } from "../../Src/Tools/Custom/orchestratorSelect.js";
import {
  configureToolServicePorts,
  resetToolServicePorts,
  type AssemblyChangePort,
} from "../../Src/Tools/Registry/toolServicePorts.js";
import { registerBuiltinTools } from "../../Src/Tools/builtinLoader.js";
import { getTool } from "../../Src/Tools/Registry/toolRegistry.js";
import { dispatchToolCall } from "../../Src/Tools/Registry/toolDispatcher.js";
import type { ToolResult } from "../../Src/Tools/Traits/toolSpec.js";

const SPECS: ExecutableSpec[] = [
  { id: "c1", inputSections: ["ctx:a", "ctx:b"], toolSet: ["FileRead"] },
  { id: "c2", inputSections: ["ctx:a"], toolSet: ["FileRead"] },
  { id: "c3", inputSections: ["ctx:c"], toolSet: ["DirList"] },
];

/** 合法基线组装体（与 assembly.spec.ts 同形，确保"起点本身合规"） */
function validSpec(): AssemblySpec {
  return {
    id: "A1",
    executables: ["n1", "n2"],
    nodes: [
      {
        id: "n1",
        executableRef: "c1",
        operator: "Seq",
        body: ["n2"],
        inputSections: ["ctx:a", "ctx:b"],
      },
      { id: "n2", executableRef: "c2", inputSections: ["ctx:a"] },
    ],
    entrypoints: ["n1"],
    criteriaVersion: CRITERIA_VERSION,
    registryVersion: REGISTRY_VERSION,
  };
}

interface Fixture {
  port: OrchestrationToolPort;
  registry: ExecutableRegistry;
  /** 落盘**净状态**（persist 写入 / retract 撤销） */
  disk: Map<string, AssemblySpec>;
  /** 真实落盘端口收到的写入序列 */
  persisted: string[];
  retracted: string[];
  /** 审计端口收到的记录 */
  audited: Array<{ assemblyId: string; by: string; digest: string }>;
  /** 持有者（C5）实际采用的组装体 */
  adopted: AssemblySpec[];
  currentSpec(): AssemblySpec;
}

function mkFixture(
  opts: {
    persistFails?: boolean;
    auditFails?: boolean;
    retractFails?: boolean;
    adoptFails?: boolean;
  } = {},
): Fixture {
  const registry = (() => {
    const r = createExecutableRegistry(SPECS);
    if (!r.ok) throw new Error(r.error);
    return markFrozen(r.value);
  })();
  const validator = createAssemblyValidator(registry);

  let holder = validSpec();
  const disk = new Map<string, AssemblySpec>();
  const persisted: string[] = [];
  const retracted: string[] = [];
  const audited: Fixture["audited"] = [];
  const adopted: AssemblySpec[] = [];

  const assembler = createAssembler(registry, validator, {
    persist: async (spec): Promise<Result<void>> => {
      if (opts.persistFails) return err("磁盘满");
      disk.set(spec.id, spec);
      persisted.push(spec.id);
      return ok(undefined);
    },
    retract: async (id): Promise<Result<void>> => {
      if (opts.retractFails) return err("快照空间不可写");
      disk.delete(id);
      retracted.push(id);
      return ok(undefined);
    },
    audit: async (rec): Promise<Result<void>> => {
      if (opts.auditFails) return err("审计服务不可用");
      audited.push({
        assemblyId: rec.assemblyId,
        by: rec.by,
        digest: rec.digest,
      });
      return ok(undefined);
    },
  });

  const port = createOrchestrationToolPort({
    registry,
    validator,
    assembler,
    current: () => holder,
    adopt: (spec) => {
      if (opts.adoptFails) return err("持有者正忙（当前运行未让出组装体）");
      holder = spec;
      adopted.push(spec);
      return ok(undefined);
    },
  });

  return {
    port,
    registry,
    disk,
    persisted,
    retracted,
    audited,
    adopted,
    currentSpec: () => holder,
  };
}

/** 工具执行上下文（compose/select 只依赖 agentId / agentRole / operationId） */
function toolCtx(overrides: Record<string, unknown> = {}): never {
  return {
    operationId: "op-1",
    agentId: "agent-prime-1",
    agentRole: "prime_director",
    traceId: "trace-1",
    ...overrides,
  } as never;
}

function codeOf(res: ToolResult): string {
  return res.error?.code ?? "";
}
function msgOf(res: ToolResult): string {
  return res.error?.message ?? "";
}
function payloadOf(res: ToolResult): Record<string, unknown> {
  return JSON.parse(String(res.content)) as Record<string, unknown>;
}
function criteria(res: ToolResult): string[] {
  const list = (
    res.error?.details as
      { violations?: Array<{ criterion: string }> } | undefined
  )?.violations;
  return (list ?? []).map((v) => v.criterion);
}

let fx: Fixture;

beforeEach(() => {
  resetToolServicePorts();
  fx = mkFixture();
  configureToolServicePorts({ orchestration: fx.port });
});

afterEach(() => {
  resetToolServicePorts();
});

describe("OrchestratorCompose / select —— 端口未装配时诚实降级", () => {
  it("【负向】未注入 orchestration 端口 ⇒ NOT_ENABLED，且组装体一分毫未动", async () => {
    resetToolServicePorts();
    const before = fx.currentSpec();

    const res = await orchestratorCompose.execute(
      {
        op: "add",
        reason: "接入新执行件",
        added: { id: "n3", executableRef: "c3" },
      },
      toolCtx(),
    );
    expect(res.status).toBe("error");
    expect(codeOf(res)).toBe("NOT_ENABLED");
    expect(msgOf(res)).toContain("未改动任何组装体");
    expect(fx.persisted).toHaveLength(0);
    expect(fx.audited).toHaveLength(0);
    expect(fx.adopted).toHaveLength(0);
    expect(fx.currentSpec()).toBe(before);
  });

  it("【负向】select 未注入端口 ⇒ NOT_ENABLED，且不产生任何提名", async () => {
    resetToolServicePorts();
    const res = await orchestratorSelect.execute(
      { candidate: "n1" },
      toolCtx(),
    );
    expect(codeOf(res)).toBe("NOT_ENABLED");
    expect(fx.port.takeNomination()).toBeNull();
  });
});

describe("OrchestratorCompose —— 入参形状校验（不触端口）", () => {
  const legal = { id: "n3", executableRef: "c3", inputSections: ["ctx:c"] };

  it("【负向】op 不在闭集 ⇒ INVALID_INPUT", async () => {
    const res = await orchestratorCompose.execute(
      { op: "rewire_join", reason: "r", added: legal },
      toolCtx(),
    );
    expect(codeOf(res)).toBe("INVALID_INPUT");
    expect(msgOf(res)).toContain("add / remove / replace");
    expect(fx.persisted).toHaveLength(0);
  });

  it("【负向】缺 reason ⇒ 拒绝（变更必须可归因）", async () => {
    const res = await orchestratorCompose.execute(
      { op: "add", added: legal },
      toolCtx(),
    );
    expect(codeOf(res)).toBe("INVALID_INPUT");
    expect(msgOf(res)).toContain("reason");
  });

  it("【负向】reason 超长 ⇒ 拒绝", async () => {
    const res = await orchestratorCompose.execute(
      { op: "add", reason: "x".repeat(501), added: legal },
      toolCtx(),
    );
    expect(codeOf(res)).toBe("INVALID_INPUT");
    expect(msgOf(res)).toContain("500");
  });

  it("【负向】remove / replace 缺 target ⇒ 拒绝", async () => {
    for (const op of ["remove", "replace"]) {
      const args =
        op === "replace"
          ? { op, reason: "r", added: legal }
          : { op, reason: "r" };
      const res = await orchestratorCompose.execute(args, toolCtx());
      expect(codeOf(res)).toBe("INVALID_INPUT");
      expect(msgOf(res)).toContain("target");
    }
  });

  it("【负向】add 缺 added / added 缺 id 或 executableRef ⇒ 拒绝", async () => {
    const cases: Array<Record<string, unknown>> = [
      { op: "add", reason: "r" },
      { op: "add", reason: "r", added: { id: "n3" } },
      { op: "add", reason: "r", added: { executableRef: "c3" } },
      { op: "add", reason: "r", added: "n3" },
    ];
    for (const args of cases) {
      const res = await orchestratorCompose.execute(args, toolCtx());
      expect(codeOf(res)).toBe("INVALID_INPUT");
    }
    expect(fx.persisted).toHaveLength(0);
  });

  it("★ added 里的未知字段被白名单挡在门外（不得整体透传进组装体）", async () => {
    const res = await orchestratorCompose.execute(
      {
        op: "add",
        reason: "接入 c3",
        added: {
          ...legal,
          ownerSecret: "sk-live-abcdef",
          extra: { nested: 1 },
        },
      },
      toolCtx(),
    );
    expect(res.status).toBe("success");
    const node = fx.adopted[0]!.nodes.find(
      (n) => n.id === "n3",
    ) as AssemblyNode & Record<string, unknown>;
    expect(Object.keys(node).sort()).toEqual([
      "executableRef",
      "id",
      "inputSections",
    ]);
    expect(JSON.stringify(fx.adopted[0])).not.toContain("sk-live-abcdef");
    expect(JSON.stringify(fx.adopted[0])).not.toContain("nested");
  });
});

describe("OrchestratorCompose —— 真实闭环：检查树拦下的每一条（21 §5）", () => {
  async function tryCompose(
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    return orchestratorCompose.execute(args, toolCtx());
  }

  it("★【独立于工具层】直连端口时未知字段同样进不了组装体（端口自己也得把住）", async () => {
    // 工具层已经筛过一次；这条用例**绕过工具**直接喂端口，证明白名单不是只有一处生效
    const dirty = {
      op: "add",
      added: {
        id: "n3",
        executableRef: "c3",
        inputSections: ["ctx:c"],
        smuggled: { role: "regulator" },
      },
    } as unknown as AssemblyChangePort;

    const out = await fx.port.compose({ by: "agent-prime-1", change: dirty });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.committed).toBe(true);
    const node = fx.adopted[0]!.nodes.find((n) => n.id === "n3")!;
    expect(Object.keys(node).sort()).toEqual([
      "executableRef",
      "id",
      "inputSections",
    ]);
    expect(JSON.stringify(fx.adopted[0])).not.toContain("regulator");
  });

  it("【反例 1】引用未注册执行件 ⇒ 拒绝（C-LINK-1），且落盘/审计/采用全部为空", async () => {
    const res = await tryCompose({
      op: "add",
      reason: "接入幽灵件",
      added: { id: "n3", executableRef: "ghost" },
    });
    expect(res.status).toBe("error");
    expect(codeOf(res)).toBe("INVALID_INPUT");
    expect(res.recoverable).toBe(true);
    expect(criteria(res)).toContain("C-LINK-1");
    // 判据必须带**定位**，否则外层无从重选（反例 10）
    const details = res.error?.details as {
      violations: Array<{ criterion: string; where: string; reason: string }>;
    };
    expect(details.violations[0]!.where).toBe("n3");
    expect(details.violations[0]!.reason).toContain("ghost");
    expect(msgOf(res)).toContain("C-LINK-1@n3");
    expect(fx.persisted).toHaveLength(0);
    expect(fx.audited).toHaveLength(0);
    expect(fx.adopted).toHaveLength(0);
    expect(fx.currentSpec().executables).toEqual(["n1", "n2"]);
  });

  it("【反例 2】算子不在闭集（Retry）⇒ C-OP-1 拦下（证明工具/端口都没复制闭集）", async () => {
    const res = await tryCompose({
      op: "add",
      reason: "加重试",
      added: { id: "n3", executableRef: "c3", operator: "Retry" },
    });
    expect(criteria(res)).toContain("C-OP-1");
    expect(msgOf(res)).toContain("不在闭集内");
    expect(fx.adopted).toHaveLength(0);
  });

  it("【反例 5】join 未声明 onMissing ⇒ C-JOIN-1", async () => {
    const res = await tryCompose({
      op: "add",
      reason: "加汇合",
      added: {
        id: "n3",
        executableRef: "c3",
        join: { deps: ["n1"], onMissing: "" },
      },
    });
    expect(criteria(res)).toContain("C-JOIN-1");
    expect(fx.persisted).toHaveLength(0);
  });

  it("【反例 6】子件输入集 = 宿主全集 ⇒ C-NEST-1（嵌套退化）", async () => {
    const res = await tryCompose({
      op: "replace",
      target: "n2",
      reason: "换子件",
      added: {
        id: "n2",
        executableRef: "c2",
        inputSections: ["ctx:a", "ctx:b"],
      },
    });
    expect(criteria(res)).toContain("C-NEST-1");
    expect(msgOf(res)).toContain("等于宿主全集");
  });

  it("【反例 6 之延伸】子件越权可见（宿主未声明的分区）⇒ C-NEST-1", async () => {
    const res = await tryCompose({
      op: "replace",
      target: "n2",
      reason: "扩子件可见面",
      added: {
        id: "n2",
        executableRef: "c2",
        inputSections: ["ctx:a", "ctx:secret"],
      },
    });
    expect(criteria(res)).toContain("C-NEST-1");
    expect(msgOf(res)).toContain("ctx:secret");
  });

  it("【反例 7】同 conflictDomain 两插件同时启用 ⇒ C-PLUG-1", async () => {
    const res = await tryCompose({
      op: "add",
      reason: "挂两个渲染插件",
      added: {
        id: "n3",
        executableRef: "c3",
        plugins: [
          { id: "p1", hooks: ["pre"], conflictDomain: "render" },
          { id: "p2", hooks: ["pre"], conflictDomain: "render" },
        ],
      },
    });
    expect(criteria(res)).toContain("C-PLUG-1");
  });

  it("【反例 8】组装体含环 ⇒ C-CYC-1", async () => {
    const res = await tryCompose({
      op: "replace",
      target: "n2",
      reason: "让子件反指宿主",
      added: {
        id: "n2",
        executableRef: "c2",
        body: ["n1"],
        inputSections: ["ctx:a"],
      },
    });
    expect(criteria(res)).toContain("C-CYC-1");
    expect(fx.adopted).toHaveLength(0);
  });

  it("【反例 3】跳过校验的路径不存在：节点 id 重复由 propose 拒绝", async () => {
    const res = await tryCompose({
      op: "add",
      reason: "重名节点",
      added: { id: "n1", executableRef: "c3" },
    });
    expect(res.status).toBe("error");
    // propose 的结构错误走端口 err ⇒ 工具如实报 INTERNAL（可重试），不伪造提交
    expect(codeOf(res)).toBe("INTERNAL");
    expect(msgOf(res)).toContain("已存在");
    expect(fx.persisted).toHaveLength(0);
  });

  it("【反例 11】落盘成功但审计不可用 ⇒ 不提交、不采用", async () => {
    const f = mkFixture({ auditFails: true });
    configureToolServicePorts({ orchestration: f.port });
    const res = await orchestratorCompose.execute(
      {
        op: "add",
        reason: "接入 c3",
        added: { id: "n3", executableRef: "c3", inputSections: ["ctx:c"] },
      },
      toolCtx(),
    );
    expect(codeOf(res)).toBe("INTERNAL");
    expect(msgOf(res)).toContain("审计失败");
    expect(f.persisted).toEqual(["A1"]);
    expect(f.retracted).toEqual(["A1"]);
    expect(f.disk.size).toBe(0); // 反例 11：不留"没人知道是谁改的"组装体
    expect(f.audited).toHaveLength(0);
    expect(f.adopted).toHaveLength(0);
  });

  it("【负向】审计失败且撤回也失败 ⇒ 如实报分叉，绝不谎称无事发生", async () => {
    const f = mkFixture({ auditFails: true, retractFails: true });
    configureToolServicePorts({ orchestration: f.port });
    const res = await orchestratorCompose.execute(
      {
        op: "add",
        reason: "接入 c3",
        added: { id: "n3", executableRef: "c3", inputSections: ["ctx:c"] },
      },
      toolCtx(),
    );
    expect(codeOf(res)).toBe("INTERNAL");
    expect(msgOf(res)).toContain("分叉");
    expect(msgOf(res)).toContain("需人工介入");
    expect(f.adopted).toHaveLength(0);
  });

  it("落盘失败 ⇒ 同样不采用（失败必须传播，不得静默）", async () => {
    const f = mkFixture({ persistFails: true });
    configureToolServicePorts({ orchestration: f.port });
    const res = await orchestratorCompose.execute(
      {
        op: "add",
        reason: "接入 c3",
        added: { id: "n3", executableRef: "c3", inputSections: ["ctx:c"] },
      },
      toolCtx(),
    );
    expect(codeOf(res)).toBe("INTERNAL");
    expect(msgOf(res)).toContain("落盘失败");
    expect(f.adopted).toHaveLength(0);
    expect(f.currentSpec().executables).toEqual(["n1", "n2"]);
  });

  it("★【分叉如实上报】落盘+审计都成功但持有者未能采用 ⇒ 报错而非静默", async () => {
    const f = mkFixture({ adoptFails: true });
    configureToolServicePorts({ orchestration: f.port });
    const res = await orchestratorCompose.execute(
      {
        op: "add",
        reason: "接入 c3",
        added: { id: "n3", executableRef: "c3", inputSections: ["ctx:c"] },
      },
      toolCtx(),
    );
    expect(codeOf(res)).toBe("INTERNAL");
    expect(res.recoverable).toBe(true);
    expect(msgOf(res)).toContain("已落盘");
    expect(msgOf(res)).toContain("分叉");
    expect(f.persisted).toHaveLength(1);
    expect(f.audited).toHaveLength(1);
    expect(f.adopted).toHaveLength(0);
  });

  it("正向：合法 add ⇒ 提交（落盘 + 审计 + 持有者采用），返回 digest 与新 executables", async () => {
    const res = await orchestratorCompose.execute(
      {
        op: "add",
        reason: "接入 c3 做目录枚举",
        added: { id: "n3", executableRef: "c3", inputSections: ["ctx:c"] },
      },
      toolCtx(),
    );
    expect(res.status).toBe("success");
    const payload = payloadOf(res);
    expect(payload.assemblyId).toBe("A1");
    expect(String(payload.digest)).toMatch(/^d[0-9a-f]+-[0-9a-f]+$/);
    expect(payload.by).toBe("agent-prime-1");
    expect(payload.executables).toEqual(["n1", "n2", "n3"]);
    expect(fx.persisted).toHaveLength(1);
    expect(fx.disk.size).toBe(1);
    expect(fx.audited).toHaveLength(1);
    expect(fx.audited[0]!.by).toBe("agent-prime-1");
    expect(fx.audited[0]!.digest).toBe(payload.digest);
    expect(fx.adopted).toHaveLength(1);
    expect(fx.currentSpec().executables).toContain("n3");
  });

  it("正向：remove 后组装体不再含该节点（可继续选件）", async () => {
    const res = await orchestratorCompose.execute(
      { op: "remove", target: "n2", reason: "c2 不再需要" },
      toolCtx(),
    );
    // n1.body 仍引用 n2 ⇒ 悬空；本用例证明"删了但引用没清"会被判据拦住
    expect(criteria(res)).toContain("C-LINK-1");
    expect(fx.adopted).toHaveLength(0);
  });
});

describe("OrchestratorSelect —— 提名不等于生效", () => {
  it("正向：提名 ∈ 组装体 ⇒ 登记为一次性提名", async () => {
    const res = await orchestratorSelect.execute(
      { candidate: "n2" },
      toolCtx(),
    );
    expect(res.status).toBe("success");
    expect(payloadOf(res).selected).toBe("n2");
    expect(fx.port.takeNomination()).toBe("n2");
    // 一次性：取走后不得残留
    expect(fx.port.takeNomination()).toBeNull();
  });

  it("【负向】提名在目录但不在组装体 ⇒ 拒绝并指向 compose", async () => {
    const res = await orchestratorSelect.execute(
      { candidate: "c3" },
      toolCtx(),
    );
    expect(codeOf(res)).toBe("INVALID_INPUT");
    expect(msgOf(res)).toContain("不在当前组装体");
    expect(msgOf(res)).toContain("OrchestratorCompose");
    expect(fx.port.takeNomination()).toBeNull();
    expect(fx.port.rejectedNominations()).toBe(1);
  });

  it("【负向】提名未注册 ⇒ 悬空引用（与'在目录未组装'区分开）", async () => {
    const res = await orchestratorSelect.execute(
      { candidate: "ghost" },
      toolCtx(),
    );
    expect(msgOf(res)).toContain("未在目录注册");
    expect(msgOf(res)).not.toContain("OrchestratorCompose");
  });

  it("【负向】空提名不得被当成'查看清单'的副作用路径", async () => {
    const res = await orchestratorSelect.execute(
      { candidate: "  ", list: true },
      toolCtx(),
    );
    expect(codeOf(res)).toBe("INVALID_INPUT");
    expect(msgOf(res)).toContain("candidate");
    expect(fx.port.takeNomination()).toBeNull();
  });

  it("list=true ⇒ 同时返回目录与组装体现状", async () => {
    const res = await orchestratorSelect.execute(
      { candidate: "n1", list: true },
      toolCtx(),
    );
    expect(res.status).toBe("success");
    const payload = payloadOf(res);
    expect(payload.executables).toEqual(["n1", "n2"]);
    const catalog = payload.catalog as Array<{ id: string; toolSet: string[] }>;
    expect(catalog.map((c) => c.id).sort()).toEqual(["c1", "c2", "c3"]);
    expect(catalog.find((c) => c.id === "c3")!.toolSet).toEqual(["DirList"]);
  });

  it("变更结构后选件即按新组装体收束（compose → select 串起来）", async () => {
    const rejected = await orchestratorSelect.execute(
      { candidate: "n3" },
      toolCtx(),
    );
    expect(rejected.status).toBe("error");

    const composed = await orchestratorCompose.execute(
      {
        op: "add",
        reason: "接入 c3",
        added: { id: "n3", executableRef: "c3", inputSections: ["ctx:c"] },
      },
      toolCtx(),
    );
    expect(composed.status).toBe("success");

    const now = await orchestratorSelect.execute(
      { candidate: "n3" },
      toolCtx(),
    );
    expect(now.status).toBe("success");
    expect(payloadOf(now).selected).toBe("n3");
  });
});

describe("编排工具的角色可见性与派发", () => {
  beforeEach(() => {
    registerBuiltinTools();
  });

  it("两个工具都注册可查（C6 的工具身份成立）", () => {
    expect(getTool("OrchestratorCompose")).toBeTruthy();
    expect(getTool("OrchestratorSelect")).toBeTruthy();
  });

  it("【负向】非外层角色经派发器调用 ⇒ ROLE_FORBIDDEN（组装体归 C5 持有）", async () => {
    for (const name of ["OrchestratorCompose", "OrchestratorSelect"]) {
      const out = await dispatchToolCall({
        toolName: name,
        arguments: name.endsWith("compose")
          ? { op: "remove", target: "n2", reason: "worker 想改结构" }
          : { candidate: "n1" },
        context: toolCtx({ agentRole: "worker" }),
      });
      expect(codeOf(out.result)).toBe("ROLE_FORBIDDEN");
      expect(out.errorClass).toBe("DISPATCH_REJECTED");
    }
    expect(fx.adopted).toHaveLength(0);
    expect(fx.port.takeNomination()).toBeNull();
  });

  it("★ 外层经**统一派发入口**按名调用 compose ⇒ 真实走完闭环", async () => {
    const out = await dispatchToolCall({
      toolName: "OrchestratorCompose",
      arguments: {
        op: "add",
        reason: "接入 c3",
        added: { id: "n3", executableRef: "c3", inputSections: ["ctx:c"] },
      },
      context: toolCtx(),
      iteration: 3,
    });
    expect(out.result.status).toBe("success");
    expect(out.text).toContain("A1");
    expect(fx.persisted).toHaveLength(1);
    expect(fx.audited).toHaveLength(1);
    expect(fx.adopted[0]!.executables).toContain("n3");
  });
});
