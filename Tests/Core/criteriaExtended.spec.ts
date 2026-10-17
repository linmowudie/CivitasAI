/**
 * 判据执行者覆盖 · 扩展批次测试（补齐 03 §6 中此前无执行者的条目）
 *
 * 覆盖：#2 双入口/死端 · #5 Loop 无终止判据 · #6 P 恒为真 · #8 预算/深度结构写界 ·
 *      #10 新算子须有规则+反例 · #12 plan→execute 须声明 minCompleteness ·
 *      #16 短路钩子不得宣称 success · #18 插件写须走输出集 · #28 grants 只能收缩 ·
 *      #29 L2 输入须父构造 · #32 插件可见面不得越权 · #34 动态插件须登记 ·
 *      #35 共享上下文准入 · #36 跨域写须带版本 · #37 新数据类须四要素
 */
import { describe, it, expect } from "vitest";

import {
  createExtendedCriteria,
  type SpecExtras,
} from "../../Src/Core/Assembly/criteriaExtended.js";
import {
  createAssemblyValidator,
  type AssemblySpec,
  type AssemblyNode,
} from "../../Src/Core/Assembly/assemblyPipeline.js";
import {
  createExecutableRegistry,
  type ExecutableSpec,
} from "../../Src/Core/Assembly/executableRegistry.js";

const SPECS: ExecutableSpec[] = [
  { id: "c1", inputSections: ["ctx:a"], toolSet: ["FileRead"] },
  { id: "c2", inputSections: ["ctx:a"], toolSet: ["FileRead"] },
];

function reg() {
  const r = createExecutableRegistry(SPECS);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

/** 一个**满足全部扩展判据**的组装体 */
function goodSpec(): AssemblySpec {
  return {
    id: "A-OK",
    executables: ["n1"],
    nodes: [
      {
        id: "n1",
        executableRef: "c1",
        operator: "Loop",
        inputSections: ["ctx:a"],
        extras: {
          loopTermination: { kind: "predicate", id: "P1" },
          outputSet: ["outer"],
          l2: false,
          parentConstructsInput: true,
        },
      } as AssemblyNode,
    ],
    entrypoints: ["n1"],
    criteriaVersion: "crit-2026-10-15",
    registryVersion: "reg-1",
    extras: {
      budgetDeclared: true,
      depthDeclared: true,
      operatorsDeclared: [
        { operator: "Loop", ruleId: "R-LOOP", counterexampleId: "X-LOOP" },
      ],
      dynamicPlugins: [{ id: "p-dyn", nodeId: "n1" }],
      registeredDynamicPlugins: ["p-dyn"],
      sharedPublications: [{ key: "shared:1", conflictPrevented: "写写冲突" }],
      crossDomainWrites: [{ key: "shared:2", expectedVersion: 3 }],
      dataClasses: [
        {
          name: "D1",
          direction: "in",
          visibility: "组件",
          persist: true,
          handling: "过滤",
        },
      ],
      grantDeltas: [{ added: [] }],
    } as SpecExtras,
  } as AssemblySpec;
}

/** 仅跑扩展判据（隔离，避免被 S8 判据噪声干扰） */
function extViolations(spec: AssemblySpec): string[] {
  return createExtendedCriteria()
    .flatMap((c) => c.check(spec))
    .map((v) => v.criterion);
}

describe("覆盖扩展 · 正向（满足全部扩展判据）", () => {
  it("合法组装体不产生扩展判据违规", () => {
    expect(extViolations(goodSpec())).toEqual([]);
  });

  it("可插进校验器（与 S8 判据合并使用）", () => {
    const r = reg();
    const v = createAssemblyValidator(r, createExtendedCriteria());
    const ids = v.criteriaIds();
    expect(ids).toContain("C-LINK-1"); // S8 的
    expect(ids).toContain("C-REACH-1"); // 扩展批次的
    // goodSpec 缺 S8 要求的版本匹配 ⇒ 会有 C-VER-1，但不是扩展判据的问题
    const verdict = v.validate(goodSpec(), r.snapshot());
    expect(verdict.violations.every((x) => x.criterion !== "C-REACH-1")).toBe(
      true,
    );
  });
});

describe("覆盖扩展 · 负向（15 条判据逐条触发）", () => {
  it("#2 双入口 / 死端 ⇒ C-REACH-1", () => {
    const twoEntries = {
      ...goodSpec(),
      entrypoints: ["n1", "n1"],
    } as AssemblySpec;
    expect(extViolations(twoEntries)).toContain("C-REACH-1");

    const deadEnd: AssemblySpec = {
      ...goodSpec(),
      executables: ["n1", "orphan"],
      nodes: [
        { id: "n1", executableRef: "c1" } as AssemblyNode,
        { id: "orphan", executableRef: "c2" } as AssemblyNode,
      ],
    };
    expect(extViolations(deadEnd)).toContain("C-REACH-1");
  });

  it("#5 Loop 未挂终止判据 ⇒ C-LOOP-1", () => {
    const s: AssemblySpec = {
      ...goodSpec(),
      nodes: [
        { id: "n1", executableRef: "c1", operator: "Loop" } as AssemblyNode,
      ],
    };
    expect(extViolations(s)).toContain("C-LOOP-1");
  });

  it("#6 P 恒为真 ⇒ C-LOOP-2", () => {
    const s: AssemblySpec = {
      ...goodSpec(),
      nodes: [
        {
          id: "n1",
          executableRef: "c1",
          operator: "Loop",
          extras: { loopTermination: { kind: "always_true", id: "P" } },
        } as AssemblyNode,
      ],
    };
    expect(extViolations(s)).toContain("C-LOOP-2");
  });

  it("#8 预算/深度未在结构上写界 ⇒ C-BOUND-1", () => {
    const s: AssemblySpec = {
      ...goodSpec(),
      extras: { depthDeclared: true } as SpecExtras,
    } as AssemblySpec;
    expect(extViolations(s)).toContain("C-BOUND-1");
  });

  it("#10 新算子缺规则或缺反例 ⇒ C-OP-2", () => {
    const noRule = {
      ...goodSpec(),
      extras: {
        ...(goodSpec() as never as { extras: SpecExtras }).extras,
        operatorsDeclared: [{ operator: "Retry", counterexampleId: "X" }],
      },
    } as AssemblySpec;
    expect(extViolations(noRule)).toContain("C-OP-2");
    const noCounter = {
      ...goodSpec(),
      extras: {
        ...(goodSpec() as never as { extras: SpecExtras }).extras,
        operatorsDeclared: [{ operator: "Retry", ruleId: "R" }],
      },
    } as AssemblySpec;
    expect(extViolations(noCounter)).toContain("C-OP-2");
  });

  it("#12 plan→execute 未声明 minCompleteness ⇒ C-JOIN-2", () => {
    const s: AssemblySpec = {
      ...goodSpec(),
      nodes: [
        {
          id: "n1",
          executableRef: "c1",
          extras: { pairKind: "plan_execute" },
        } as AssemblyNode,
      ],
    };
    expect(extViolations(s)).toContain("C-JOIN-2");
  });

  it("#16 插件可短路宣称 success ⇒ C-PLUGH-1", () => {
    const s: AssemblySpec = {
      ...goodSpec(),
      nodes: [
        {
          id: "n1",
          executableRef: "c1",
          plugins: [
            {
              id: "p",
              hooks: ["beforeModel"],
              conflictDomain: "d",
              extras: { canClaimSuccess: true },
            } as never,
          ],
        } as AssemblyNode,
      ],
    };
    expect(extViolations(s)).toContain("C-PLUGH-1");
  });

  it("#18 插件写出目标不在宿主输出集 ⇒ C-PLUGW-1", () => {
    const s: AssemblySpec = {
      ...goodSpec(),
      nodes: [
        {
          id: "n1",
          executableRef: "c1",
          extras: { outputSet: ["outer"] },
          plugins: [
            {
              id: "p",
              hooks: ["wrapToolCall"],
              conflictDomain: "d",
              extras: { writeTargets: ["secret"] },
            } as never,
          ],
        } as AssemblyNode,
      ],
    };
    expect(extViolations(s)).toContain("C-PLUGW-1");
  });

  it("#28 grants 出现新增项 ⇒ C-GRANT-1", () => {
    const s = {
      ...goodSpec(),
      extras: {
        ...(goodSpec() as never as { extras: SpecExtras }).extras,
        grantDeltas: [{ added: ["FileWrite"] }],
      },
    } as AssemblySpec;
    expect(extViolations(s)).toContain("C-GRANT-1");
  });

  it("#29 L2 输入非父构造 ⇒ C-L2-1", () => {
    const s: AssemblySpec = {
      ...goodSpec(),
      nodes: [
        { id: "n1", executableRef: "c1", extras: { l2: true } } as AssemblyNode,
      ],
    };
    expect(extViolations(s)).toContain("C-L2-1");
  });

  it("#32 插件可见面超出宿主输入集 ⇒ C-PLUGV-1", () => {
    const s: AssemblySpec = {
      ...goodSpec(),
      nodes: [
        {
          id: "n1",
          executableRef: "c1",
          inputSections: ["ctx:a"],
          plugins: [
            {
              id: "p",
              hooks: ["beforeModel"],
              conflictDomain: "d",
              extras: { visibility: ["ctx:secret"] },
            } as never,
          ],
        } as AssemblyNode,
      ],
    };
    expect(extViolations(s)).toContain("C-PLUGV-1");
  });

  it("#34 动态插件未登记 ⇒ C-PLUGM-1", () => {
    const s = {
      ...goodSpec(),
      extras: {
        ...(goodSpec() as never as { extras: SpecExtras }).extras,
        dynamicPlugins: [{ id: "p-unlogged", nodeId: "n1" }],
        registeredDynamicPlugins: [],
      },
    } as AssemblySpec;
    expect(extViolations(s)).toContain("C-PLUGM-1");
  });

  it("#35 投递共享上下文未说明防止了什么冲突 ⇒ C-SHARED-1", () => {
    const s = {
      ...goodSpec(),
      extras: {
        ...(goodSpec() as never as { extras: SpecExtras }).extras,
        sharedPublications: [{ key: "shared:x" }],
      },
    } as AssemblySpec;
    expect(extViolations(s)).toContain("C-SHARED-1");
  });

  it("#36 跨域写未带 expectedVersion ⇒ C-XDOM-1", () => {
    const s = {
      ...goodSpec(),
      extras: {
        ...(goodSpec() as never as { extras: SpecExtras }).extras,
        crossDomainWrites: [{ key: "shared:y" }],
      },
    } as AssemblySpec;
    expect(extViolations(s)).toContain("C-XDOM-1");
  });

  it("#37 新数据类四要素不全 ⇒ C-DATA-1（四个字段各有缺失）", () => {
    const base = (goodSpec() as never as { extras: SpecExtras }).extras;
    const cases: SpecExtras[] = [
      {
        ...base,
        dataClasses: [
          { name: "D", visibility: "组件", persist: true, handling: "h" },
        ],
      },
      {
        ...base,
        dataClasses: [
          { name: "D", direction: "in", persist: true, handling: "h" },
        ],
      },
      {
        ...base,
        dataClasses: [
          { name: "D", direction: "in", visibility: "组件", handling: "h" },
        ],
      },
      {
        ...base,
        dataClasses: [
          { name: "D", direction: "in", visibility: "组件", persist: true },
        ],
      },
    ];
    for (const ex of cases) {
      const s = { ...goodSpec(), extras: ex } as AssemblySpec;
      expect(extViolations(s)).toContain("C-DATA-1");
    }
  });

  it("每条违规都带判据 id 与定位（可追溯）", () => {
    const s: AssemblySpec = { ...goodSpec(), entrypoints: [] };
    const vs = createExtendedCriteria().flatMap((c) => c.check(s));
    expect(vs.length).toBeGreaterThan(0);
    for (const x of vs) {
      expect(x.criterion).toMatch(/^C-/);
      expect(x.where.length).toBeGreaterThan(0);
      expect(x.reason.length).toBeGreaterThan(0);
    }
  });
});
