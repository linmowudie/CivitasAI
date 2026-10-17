/**
 * S8 · 组装闭环负向测试（ExecutableRegistry + AssemblyValidator + Assembler + 版本记录）
 *
 * 覆盖 21-组装闭环.md §5 的 12 条反例 · 24 §3 问题 1（版本记录）。
 * 纪律（25 §1）：负向用例必须真实调用。
 */
import { describe, it, expect, beforeEach } from "vitest";

import {
  createExecutableRegistry,
  markFrozen,
  isFrozen,
  REGISTRY_VERSION,
  type ExecutableSpec,
} from "../../Src/Core/Assembly/executableRegistry.js";
import {
  createAssemblyValidator,
  createAssembler,
  CRITERIA_VERSION,
  OPERATORS,
  type AssemblySpec,
  type AssemblyNode,
  type Violation,
} from "../../Src/Core/Assembly/assemblyPipeline.js";
import { ok, err, type Result } from "../../Src/Infra/types.js";

const SPECS: ExecutableSpec[] = [
  { id: "c1", inputSections: ["ctx:a", "ctx:b"], toolSet: ["FileRead"] },
  { id: "c2", inputSections: ["ctx:a"], toolSet: ["FileRead"] },
  { id: "c3", inputSections: ["ctx:c"], toolSet: ["FileRead"] },
];

function mkRegistry() {
  const r = createExecutableRegistry(SPECS);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

function node(
  over: Partial<AssemblyNode> & { id: string; executableRef: string },
): AssemblyNode {
  return { ...over };
}

function validSpec(): AssemblySpec {
  return {
    id: "A1",
    executables: ["n1", "n2"],
    nodes: [
      node({
        id: "n1",
        executableRef: "c1",
        operator: "Seq",
        body: ["n2"],
        inputSections: ["ctx:a", "ctx:b"],
      }),
      node({ id: "n2", executableRef: "c2", inputSections: ["ctx:a"] }),
    ],
    entrypoints: ["n1"],
    criteriaVersion: CRITERIA_VERSION,
    registryVersion: REGISTRY_VERSION,
  };
}

function mkPorts(
  over: Partial<{
    persistFails: boolean;
    auditFails: boolean;
    retractFails: boolean;
  }> = {},
) {
  /** 落盘现状（persist 写入、retract 撤销）——断言"净状态"而非"调用序列" */
  const disk = new Map<string, AssemblySpec>();
  const persisted: string[] = [];
  const retracted: string[] = [];
  const audited: string[] = [];
  return {
    disk,
    persisted,
    retracted,
    audited,
    ports: {
      persist: async (s: AssemblySpec): Promise<Result<void>> => {
        if (over.persistFails) return err("磁盘满");
        disk.set(s.id, s);
        persisted.push(s.id);
        return ok(undefined);
      },
      retract: async (id: string): Promise<Result<void>> => {
        if (over.retractFails) return err("快照空间不可写");
        disk.delete(id);
        retracted.push(id);
        return ok(undefined);
      },
      audit: async (rec: { assemblyId: string }): Promise<Result<void>> => {
        if (over.auditFails) return err("审计服务不可用");
        audited.push(rec.assemblyId);
        return ok(undefined);
      },
    },
  };
}

function ids(vs: readonly Violation[]): string[] {
  return vs.map((v) => v.criterion);
}

describe("S8 · 执行件目录（目录类：运行中只读）", () => {
  it("【负向】目录冻结后修改 ⇒ 拒绝（否则已提交组装体的引用会悄悄失效）", () => {
    const reg = mkRegistry();
    expect(reg.add({ id: "c9", inputSections: [], toolSet: [] }).ok).toBe(true); // 冻结前可加
    markFrozen(reg);
    expect(isFrozen(reg)).toBe(true);
    const after = reg.add({ id: "c10", inputSections: [], toolSet: [] });
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.error).toContain("只读");
    expect(reg.resolve("c10")).toBeNull();
  });

  it("【负向】重复 id ⇒ 拒绝创建", () => {
    const dup = createExecutableRegistry([SPECS[0]!, SPECS[0]!]);
    expect(dup.ok).toBe(false);
  });
});

describe("S8 · 校验器（判据必带 id + 定位）", () => {
  let reg: ReturnType<typeof mkRegistry>;
  beforeEach(() => {
    reg = mkRegistry();
  });

  it("合法组装体 ⇒ 通过；判据集 id 完整", () => {
    const v = createAssemblyValidator(reg);
    const verdict = v.validate(validSpec(), reg.snapshot());
    expect(verdict.ok).toBe(true);
    expect(v.criteriaIds().length).toBeGreaterThanOrEqual(9);
  });

  it("【负向】悬空引用（执行件未注册 / body / join.deps）⇒ 拒绝且给出判据+定位", () => {
    const v = createAssemblyValidator(reg);
    const spec: AssemblySpec = {
      ...validSpec(),
      nodes: [
        node({
          id: "n1",
          executableRef: "ghost",
          operator: "Seq",
          body: ["nope"],
        }),
        node({
          id: "n2",
          executableRef: "c2",
          join: { deps: ["missing"], onMissing: "block" },
        }),
      ],
    };
    const verdict = v.validate(spec, reg.snapshot());
    expect(verdict.ok).toBe(false);
    expect(ids(verdict.violations)).toContain("C-LINK-1");
    const first = verdict.violations[0]!;
    expect(first.criterion).toBeTruthy();
    expect(first.where).toBeTruthy();
    expect(first.reason).toBeTruthy();
  });

  it("【负向】算子不在闭集 ⇒ 拒绝", () => {
    const v = createAssemblyValidator(reg);
    const spec: AssemblySpec = {
      ...validSpec(),
      nodes: [
        node({
          id: "n1",
          executableRef: "c1",
          operator: "Retry" as never,
          body: ["n2"],
        }),
        validSpec().nodes[1]!,
      ],
    };
    const verdict = v.validate(spec, reg.snapshot());
    expect(verdict.ok).toBe(false);
    expect(ids(verdict.violations)).toContain("C-OP-1");
    expect(OPERATORS).not.toContain("Retry" as never);
  });

  it("【负向】存在环 ⇒ 拒绝", () => {
    const v = createAssemblyValidator(reg);
    const spec: AssemblySpec = {
      ...validSpec(),
      nodes: [
        node({
          id: "n1",
          executableRef: "c1",
          body: ["n2"],
          inputSections: ["ctx:a", "ctx:b"],
        }),
        node({
          id: "n2",
          executableRef: "c2",
          body: ["n1"],
          inputSections: ["ctx:a"],
        }),
      ],
    };
    const verdict = v.validate(spec, reg.snapshot());
    expect(verdict.ok).toBe(false);
    expect(ids(verdict.violations)).toContain("C-CYC-1");
  });

  it("【负向】子件输入集**等于宿主全集** ⇒ 拒绝；越权 ⇒ 拒绝", () => {
    const v = createAssemblyValidator(reg);
    const equal: AssemblySpec = {
      ...validSpec(),
      nodes: [
        node({
          id: "n1",
          executableRef: "c1",
          body: ["n2"],
          inputSections: ["ctx:a", "ctx:b"],
        }),
        node({
          id: "n2",
          executableRef: "c2",
          inputSections: ["ctx:b", "ctx:a"],
        }),
      ],
    };
    expect(v.validate(equal, reg.snapshot()).ok).toBe(false);
    expect(ids(v.validate(equal, reg.snapshot()).violations)).toContain(
      "C-NEST-1",
    );

    const overreach: AssemblySpec = {
      ...validSpec(),
      nodes: [
        node({
          id: "n1",
          executableRef: "c1",
          body: ["n2"],
          inputSections: ["ctx:a"],
        }),
        node({ id: "n2", executableRef: "c2", inputSections: ["ctx:b"] }),
      ],
    };
    expect(v.validate(overreach, reg.snapshot()).ok).toBe(false);
  });

  it("【负向】同 conflictDomain 同时启用两个插件 ⇒ 拒绝", () => {
    const v = createAssemblyValidator(reg);
    const spec: AssemblySpec = {
      ...validSpec(),
      nodes: [
        node({
          id: "n1",
          executableRef: "c1",
          body: ["n2"],
          inputSections: ["ctx:a", "ctx:b"],
          plugins: [
            { id: "p1", hooks: ["beforeModel"], conflictDomain: "planning" },
            { id: "p2", hooks: ["afterModel"], conflictDomain: "planning" },
          ],
        }),
        validSpec().nodes[1]!,
      ],
    };
    const verdict = v.validate(spec, reg.snapshot());
    expect(verdict.ok).toBe(false);
    expect(ids(verdict.violations)).toContain("C-PLUG-1");
  });

  it("【负向】join.onMissing 非法 ⇒ 拒绝；入口点缺失 ⇒ 拒绝", () => {
    const v = createAssemblyValidator(reg);
    const badJoin: AssemblySpec = {
      ...validSpec(),
      nodes: [
        node({
          id: "n1",
          executableRef: "c1",
          join: { deps: ["n2"], onMissing: "whatever" as never },
        }),
        validSpec().nodes[1]!,
      ],
    };
    expect(ids(v.validate(badJoin, reg.snapshot()).violations)).toContain(
      "C-JOIN-1",
    );

    const noEntry: AssemblySpec = { ...validSpec(), entrypoints: [] };
    expect(ids(v.validate(noEntry, reg.snapshot()).violations)).toContain(
      "C-ENTRY-1",
    );
  });

  it("【负向】版本不匹配（criteriaVersion 或 registryVersion）⇒ 拒绝", () => {
    const v = createAssemblyValidator(reg);
    const badCrit: AssemblySpec = {
      ...validSpec(),
      criteriaVersion: "crit-old",
    };
    expect(ids(v.validate(badCrit, reg.snapshot()).violations)).toContain(
      "C-VER-1",
    );
    const badReg: AssemblySpec = { ...validSpec(), registryVersion: "reg-old" };
    expect(ids(v.validate(badReg, reg.snapshot()).violations)).toContain(
      "C-VER-1",
    );
  });
});

describe("S8 · 装配器（提议 / 提交 / 版本 / TOCTOU）", () => {
  it("legit：propose → 校验通过 → 提交成功（落盘 + 审计都发生）", async () => {
    const reg = mkRegistry();
    const v = createAssemblyValidator(reg);
    const p = mkPorts();
    const asm = createAssembler(reg, v, p.ports);
    const current = validSpec();

    const candidate = await asm.propose(current, {
      op: "add",
      added: node({ id: "n3", executableRef: "c3", inputSections: ["ctx:c"] }),
    });
    expect(candidate.ok).toBe(true);
    if (!candidate.ok) return;
    // 新节点未登记入口/父节点，仍应通过其余判据（entrypoints 不变）
    const verdict = v.validate(candidate.value, reg.snapshot());
    expect(verdict.ok).toBe(true);

    const committed = await asm.commit({
      candidate: candidate.value,
      validatedDigest: asm.digestOf(candidate.value),
      by: "outer",
    });
    expect(committed.ok).toBe(true);
    expect(p.persisted).toContain(candidate.value.id);
    expect(p.audited).toContain(candidate.value.id);
    expect(asm.commits().length).toBe(1);
  });

  it("【负向】跳过校验直接提交非法候选 ⇒ 提交内**再校验**拦下", async () => {
    const reg = mkRegistry();
    const v = createAssemblyValidator(reg);
    const p = mkPorts();
    const asm = createAssembler(reg, v, p.ports);
    const bad: AssemblySpec = {
      ...validSpec(),
      nodes: [node({ id: "n1", executableRef: "ghost" })],
    };

    const out = await asm.commit({
      candidate: bad,
      validatedDigest: asm.digestOf(bad),
      by: "outer",
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("不得提交");
    expect(p.persisted.length).toBe(0);
  });

  it("【负向】TOCTOU：校验通过后又改候选 ⇒ 摘要不匹配被拒", async () => {
    const reg = mkRegistry();
    const v = createAssemblyValidator(reg);
    const p = mkPorts();
    const asm = createAssembler(reg, v, p.ports);
    const candidate = validSpec();
    const digestOfValidated = asm.digestOf(candidate);

    // 校验之后偷偷改一个节点（模拟 TOCTOU）
    const tampered: AssemblySpec = {
      ...candidate,
      nodes: [
        candidate.nodes[0]!,
        node({ id: "n2", executableRef: "c3", inputSections: ["ctx:a"] }),
      ],
    };
    const out = await asm.commit({
      candidate: tampered,
      validatedDigest: digestOfValidated,
      by: "outer",
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("摘要不匹配");
    expect(p.persisted.length).toBe(0);
  });

  it("【负向】落盘失败 ⇒ 提交失败且不审计", async () => {
    const reg = mkRegistry();
    const v = createAssemblyValidator(reg);
    const p = mkPorts({ persistFails: true });
    const asm = createAssembler(reg, v, p.ports);
    const s = validSpec();
    const out = await asm.commit({
      candidate: s,
      validatedDigest: asm.digestOf(s),
      by: "outer",
      registrySnapshot: reg.snapshot(),
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("落盘失败");
    expect(p.audited.length).toBe(0);
  });

  it("【负向 · 反例 11】审计失败 ⇒ 提交失败**且落盘被撤回**（不得留下不可归因的组装体）", async () => {
    const reg = mkRegistry();
    const v = createAssemblyValidator(reg);
    const p = mkPorts({ auditFails: true });
    const asm = createAssembler(reg, v, p.ports);
    const s = validSpec();
    const out = await asm.commit({
      candidate: s,
      validatedDigest: asm.digestOf(s),
      by: "outer",
      registrySnapshot: reg.snapshot(),
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("审计失败");
    expect(asm.commits().length).toBe(0);
    // ★ 净状态：落盘发生过，但已被撤销 —— 磁盘上没有"没人改过"的组装体
    expect(p.persisted).toEqual(["A1"]);
    expect(p.retracted).toEqual(["A1"]);
    expect(p.disk.size).toBe(0);
  });

  it("【负向】审计失败且撤回也失败 ⇒ 如实上报存储/审计分叉（不谎称无事发生）", async () => {
    const reg = mkRegistry();
    const v = createAssemblyValidator(reg);
    const p = mkPorts({ auditFails: true, retractFails: true });
    const asm = createAssembler(reg, v, p.ports);
    const s = validSpec();
    const out = await asm.commit({
      candidate: s,
      validatedDigest: asm.digestOf(s),
      by: "outer",
      registrySnapshot: reg.snapshot(),
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error).toContain("审计失败");
      expect(out.error).toContain("分叉");
    }
    expect(asm.commits().length).toBe(0);
    expect(p.disk.size).toBe(1); // 承认这里确实还留着脏数据
  });

  it("【负向】版本不匹配 ⇒ **拒绝恢复**（不得先跑起来再说）", () => {
    const reg = mkRegistry();
    const v = createAssemblyValidator(reg);
    const asm = createAssembler(reg, v, mkPorts().ports);
    const s = validSpec();
    expect(
      asm.restore(s, {
        criteriaVersion: CRITERIA_VERSION,
        registryVersion: REGISTRY_VERSION,
      }).ok,
    ).toBe(true);
    const badCrit = asm.restore(s, {
      criteriaVersion: "crit-new",
      registryVersion: REGISTRY_VERSION,
    });
    expect(badCrit.ok).toBe(false);
    if (!badCrit.ok) expect(badCrit.error).toContain("criteriaVersion 不匹配");
    const badReg = asm.restore(s, {
      criteriaVersion: CRITERIA_VERSION,
      registryVersion: "reg-new",
    });
    expect(badReg.ok).toBe(false);
    if (!badReg.ok) expect(badReg.error).toContain("registryVersion 不匹配");
  });

  it("propose：add/replace/remove 都是纯结构变换（不改版本字段）", async () => {
    const reg = mkRegistry();
    const v = createAssemblyValidator(reg);
    const asm = createAssembler(reg, v, mkPorts().ports);
    const s = validSpec();

    const added = await asm.propose(s, {
      op: "add",
      added: node({ id: "n9", executableRef: "c3" }),
    });
    expect(added.ok && added.value.executables).toContain("n9");
    if (added.ok) expect(added.value.criteriaVersion).toBe(CRITERIA_VERSION);

    const replaced = await asm.propose(s, {
      op: "replace",
      target: "n2",
      added: node({ id: "n2b", executableRef: "c3" }),
    });
    expect(replaced.ok).toBe(true);
    if (replaced.ok) {
      expect(replaced.value.executables).toContain("n2b");
      expect(replaced.value.executables).not.toContain("n2");
    }

    const removed = await asm.propose(s, { op: "remove", target: "n2" });
    expect(removed.ok).toBe(true);
    if (removed.ok) expect(removed.value.executables).toEqual(["n1"]);

    const bad = await asm.propose(s, { op: "remove", target: "ghost" });
    expect(bad.ok).toBe(false);
  });

  it("摘要对节点顺序不敏感（同一结构 ⇒ 同一摘要）", async () => {
    const reg = mkRegistry();
    const v = createAssemblyValidator(reg);
    const asm = createAssembler(reg, v, mkPorts().ports);
    const a = validSpec();
    const reversed: AssemblySpec = { ...a, nodes: [...a.nodes].reverse() };
    expect(asm.digestOf(a)).toBe(asm.digestOf(reversed));
  });
});
