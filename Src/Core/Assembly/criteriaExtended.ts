/**
 * @module Core/Assembly/criteriaExtended
 * @description
 * 检查树判据的**扩展批次**：补齐 03 §6 中尚未有执行者的条目。
 *
 * 判据清单与缺口见 Docs/Dev/L1编排设计/27-判据执行者覆盖.md。
 * 本批覆盖（原编号为 03 §6 的序号）：
 *   #2 双入口/死端 · #5 Loop 无终止判据 · #6 P 恒为真 · #8 预算/深度结构写界 ·
 *   #10 新增算子必须有规则+反例 · #12 plan→execute 必须声明 minCompleteness ·
 *   #16 短路钩子不得宣称 success · #18 插件写必须走输出集 · #28 grants 只能收缩 ·
 *   #29 L2 输入必须父构造 · #32 插件可见面不得超出宿主 · #34 动态插件必须登记 ·
 *   #35 共享上下文准入 · #36 跨域写必须带版本 · #37 新增数据类必须声明四要素
 *
 * 每条判据都带 **id** 与**定位**（`where`），失败即可追溯到具体节点/字段。
 */

import type {
  AssemblySpec,
  AssemblyNode,
  Violation,
} from "./assemblyPipeline.js";

/** 节点扩展声明（缺省即"未声明"，由判据决定是否必需） */
export interface NodeExtras {
  readonly loopTermination?: {
    readonly kind: "predicate" | "always_true";
    readonly id: string;
  };
  readonly pairKind?: "plan_execute";
  readonly minCompleteness?: number;
  readonly l2?: boolean;
  readonly parentConstructsInput?: boolean;
  readonly outputSet?: readonly string[];
}

/** 插件扩展声明 */
export interface PluginExtras {
  readonly canClaimSuccess?: boolean;
  readonly writeTargets?: readonly string[];
  readonly visibility?: readonly string[];
}

export interface DataClassDecl {
  readonly name: string;
  readonly direction?: string;
  readonly visibility?: string;
  readonly persist?: boolean;
  readonly handling?: string;
}

export interface SpecExtras {
  readonly budgetDeclared?: boolean;
  readonly depthDeclared?: boolean;
  readonly operatorsDeclared?: readonly {
    readonly operator: string;
    readonly ruleId?: string;
    readonly counterexampleId?: string;
  }[];
  readonly dynamicPlugins?: readonly {
    readonly id: string;
    readonly nodeId: string;
  }[];
  readonly registeredDynamicPlugins?: readonly string[];
  readonly sharedPublications?: readonly {
    readonly key: string;
    readonly conflictPrevented?: string;
  }[];
  readonly crossDomainWrites?: readonly {
    readonly key: string;
    readonly expectedVersion?: number;
  }[];
  readonly dataClasses?: readonly DataClassDecl[];
  readonly grantDeltas?: readonly { readonly added?: readonly string[] }[];
}

/** 从组装体取扩展（约定放在 `extras` 字段；类型上做宽松读取） */
export function extrasOf(spec: AssemblySpec): SpecExtras {
  return ((spec as unknown as { extras?: SpecExtras }).extras ??
    {}) as SpecExtras;
}
export function nodeExtrasOf(node: AssemblyNode): NodeExtras {
  return ((node as unknown as { extras?: NodeExtras }).extras ??
    {}) as NodeExtras;
}
export function pluginExtrasOf(p: unknown): PluginExtras {
  return ((p as { extras?: PluginExtras }).extras ?? {}) as PluginExtras;
}

/** 扩展判据集（id 前缀沿用 C-，便于与 S8 的判据一起追溯） */
export function createExtendedCriteria(): Array<{
  id: string;
  check: (spec: AssemblySpec) => Violation[];
}> {
  const v = (criterion: string, where: string, reason: string): Violation => ({
    criterion,
    where,
    reason,
  });

  return [
    {
      // #2 良构：恰好一个入口 + 所有节点从入口可达（死端 = 不在任何从入口出发的路径上）
      id: "C-REACH-1",
      check: (spec) => {
        const out: Violation[] = [];
        if (spec.entrypoints.length !== 1) {
          out.push(
            v(
              "C-REACH-1",
              spec.id,
              "必须恰好一个入口，实际 " + spec.entrypoints.length + " 个",
            ),
          );
          return out;
        }
        const adj = new Map<string, string[]>();
        for (const n of spec.nodes)
          adj.set(n.id, [...(n.body ?? []), ...(n.join?.deps ?? [])]);
        const seen = new Set<string>();
        const stack = [spec.entrypoints[0]!];
        while (stack.length > 0) {
          const cur = stack.pop()!;
          if (seen.has(cur)) continue;
          seen.add(cur);
          for (const nx of adj.get(cur) ?? []) stack.push(nx);
        }
        for (const n of spec.nodes) {
          if (!seen.has(n.id))
            out.push(v("C-REACH-1", n.id, "节点从入口不可达（死端）"));
        }
        return out;
      },
    },
    {
      // #5 闭包：Loop 节点必须挂终止判据 P
      id: "C-LOOP-1",
      check: (spec) => {
        const out: Violation[] = [];
        for (const n of spec.nodes) {
          if (n.operator !== "Loop") continue;
          const ex = nodeExtrasOf(n);
          if (!ex.loopTermination || !ex.loopTermination.id) {
            out.push(v("C-LOOP-1", n.id, "Loop 节点未挂终止判据 P"));
          }
        }
        return out;
      },
    },
    {
      // #6 闭包：P 不得恒为真（结构闭环、行为死循环）
      id: "C-LOOP-2",
      check: (spec) => {
        const out: Violation[] = [];
        for (const n of spec.nodes) {
          if (n.operator !== "Loop") continue;
          const term = nodeExtrasOf(n).loopTermination;
          if (term && term.kind === "always_true") {
            out.push(
              v("C-LOOP-2", n.id, "终止判据恒为真（结构闭环、行为死循环）"),
            );
          }
        }
        return out;
      },
    },
    {
      // #8 闭包：预算/深度必须在结构上写界，不能只靠运行时兜底
      id: "C-BOUND-1",
      check: (spec) => {
        const out: Violation[] = [];
        const ex = extrasOf(spec);
        if (ex.budgetDeclared !== true)
          out.push(v("C-BOUND-1", spec.id, "未在结构上声明预算界"));
        if (ex.depthDeclared !== true)
          out.push(v("C-BOUND-1", spec.id, "未在结构上声明深度界"));
        return out;
      },
    },
    {
      // #10 算子：新增算子必须同时给出规则 id 与反例 id
      id: "C-OP-2",
      check: (spec) => {
        const out: Violation[] = [];
        for (const d of extrasOf(spec).operatorsDeclared ?? []) {
          if (!d.ruleId)
            out.push(v("C-OP-2", d.operator, "新增算子缺少检查树规则"));
          if (!d.counterexampleId)
            out.push(v("C-OP-2", d.operator, "新增算子缺少反例"));
        }
        return out;
      },
    },
    {
      // #12 Join：plan→execute 必须声明 minCompleteness
      id: "C-JOIN-2",
      check: (spec) => {
        const out: Violation[] = [];
        for (const n of spec.nodes) {
          const ex = nodeExtrasOf(n);
          if (
            ex.pairKind === "plan_execute" &&
            (ex.minCompleteness === undefined || ex.minCompleteness <= 0)
          ) {
            out.push(
              v("C-JOIN-2", n.id, "plan→execute 未声明 minCompleteness"),
            );
          }
        }
        return out;
      },
    },
    {
      // #16 插件：不得有能宣称 success 的短路钩子
      id: "C-PLUGH-1",
      check: (spec) => {
        const out: Violation[] = [];
        for (const n of spec.nodes) {
          for (const p of n.plugins ?? []) {
            if (pluginExtrasOf(p).canClaimSuccess === true) {
              out.push(
                v(
                  "C-PLUGH-1",
                  n.id + "/" + p.id,
                  "插件可短路宣称 success（成功只能由外层推导）",
                ),
              );
            }
          }
        }
        return out;
      },
    },
    {
      // #18 插件：写出的数据必须落在宿主的输出集内
      id: "C-PLUGW-1",
      check: (spec) => {
        const out: Violation[] = [];
        for (const n of spec.nodes) {
          const hostOut = new Set(nodeExtrasOf(n).outputSet ?? []);
          for (const p of n.plugins ?? []) {
            for (const w of pluginExtrasOf(p).writeTargets ?? []) {
              if (!hostOut.has(w)) {
                out.push(
                  v(
                    "C-PLUGW-1",
                    n.id + "/" + p.id,
                    "插件写出目标不在宿主输出集: " + w,
                  ),
                );
              }
            }
          }
        }
        return out;
      },
    },
    {
      // #28 外部控制：grants 只能收缩，不得在运行中新增
      id: "C-GRANT-1",
      check: (spec) => {
        const out: Violation[] = [];
        for (const d of extrasOf(spec).grantDeltas ?? []) {
          if ((d.added ?? []).length > 0) {
            out.push(
              v(
                "C-GRANT-1",
                spec.id,
                "grants 出现新增项: " + (d.added ?? []).join(","),
              ),
            );
          }
        }
        return out;
      },
    },
    {
      // #29 外部控制：L2 的 ReactInput 必须由父构造
      id: "C-L2-1",
      check: (spec) => {
        const out: Violation[] = [];
        for (const n of spec.nodes) {
          const ex = nodeExtrasOf(n);
          if (ex.l2 === true && ex.parentConstructsInput !== true) {
            out.push(v("C-L2-1", n.id, "L2 的 ReactInput 不是由父构造"));
          }
        }
        return out;
      },
    },
    {
      // #32 双向插入：插件可见面不得超出宿主输入集（借宿主提权）
      id: "C-PLUGV-1",
      check: (spec) => {
        const out: Violation[] = [];
        for (const n of spec.nodes) {
          const hostIn = new Set(n.inputSections ?? []);
          for (const p of n.plugins ?? []) {
            for (const s of pluginExtrasOf(p).visibility ?? []) {
              if (!hostIn.has(s)) {
                out.push(
                  v(
                    "C-PLUGV-1",
                    n.id + "/" + p.id,
                    "插件可见面超出宿主输入集: " + s,
                  ),
                );
              }
            }
          }
        }
        return out;
      },
    },
    {
      // #34 双向插入：动态挂载的插件必须登记在组装体里（可归因）
      id: "C-PLUGM-1",
      check: (spec) => {
        const out: Violation[] = [];
        const ex = extrasOf(spec);
        const registered = new Set(ex.registeredDynamicPlugins ?? []);
        for (const d of ex.dynamicPlugins ?? []) {
          if (!registered.has(d.id)) {
            out.push(
              v(
                "C-PLUGM-1",
                d.nodeId + "/" + d.id,
                "动态挂载插件未记入组装体（无法归因）",
              ),
            );
          }
        }
        return out;
      },
    },
    {
      // #35 共享上下文：投递必须能说出"防止了什么冲突"
      id: "C-SHARED-1",
      check: (spec) => {
        const out: Violation[] = [];
        for (const pub of extrasOf(spec).sharedPublications ?? []) {
          if (
            !pub.conflictPrevented ||
            pub.conflictPrevented.trim().length === 0
          ) {
            out.push(
              v("C-SHARED-1", pub.key, "投递共享上下文未说明防止了什么冲突"),
            );
          }
        }
        return out;
      },
    },
    {
      // #36 共享上下文：跨域写必须带 expectedVersion
      id: "C-XDOM-1",
      check: (spec) => {
        const out: Violation[] = [];
        for (const w of extrasOf(spec).crossDomainWrites ?? []) {
          if (w.expectedVersion === undefined) {
            out.push(v("C-XDOM-1", w.key, "跨域写入未带 expectedVersion"));
          }
        }
        return out;
      },
    },
    {
      // #37 数据总表：新增数据类必须声明方向/可见级/落盘/处理规则
      id: "C-DATA-1",
      check: (spec) => {
        const out: Violation[] = [];
        for (const d of extrasOf(spec).dataClasses ?? []) {
          if (!d.direction) out.push(v("C-DATA-1", d.name, "未声明方向"));
          if (!d.visibility) out.push(v("C-DATA-1", d.name, "未声明可见级"));
          if (d.persist === undefined)
            out.push(v("C-DATA-1", d.name, "未声明是否落盘"));
          if (!d.handling) out.push(v("C-DATA-1", d.name, "未声明处理规则"));
        }
        return out;
      },
    },
  ];
}
