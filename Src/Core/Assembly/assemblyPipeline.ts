/**
 * @module Core/Assembly/assemblyPipeline
 * @description
 * 组装闭环：**提议 → 校验 → 提交**，外加**版本记录**。
 *
 * 设计出处：Docs/Dev/L1编排设计/21-组装闭环.md · 03-组装检查树.md §6（判据归口）·
 *   24-归属复核-第二批.md §3 问题 1（组装体必须记录依赖版本，否则"悄悄失效"）
 *
 * 本步要成立的关键纪律，每条都有负向测试：
 *   1. **悬空引用**（执行件/节点/join 依赖未注册）⇒ 拒绝。
 *   2. **算子必须在闭集内** ⇒ 否则拒绝。
 *   3. **无环**（body + join.deps 构成的图）。
 *   4. **子件输入集不得等于宿主全集**（嵌套退化）且必须是宿主子集。
 *   5. **同 conflictDomain 不得同时启用两个插件**。
 *   6. **join 必须声明 onMissing**。
 *   7. **版本必须记录且与当前一致**（`criteriaVersion` / `registryVersion`）；不一致 ⇒ **拒绝恢复**。
 *   8. **提交前再校验一次**（防绕过）+ **摘要匹配**（防 TOCTOU：校验后又改候选）。
 *   9. **拒绝必须给出"判据 + 定位"**（否则调用方无法重选）。
 *  10. **落盘与审计缺一不可**（成功落盘但审计缺失 ⇒ 拒绝）。
 */

import type { Result } from "../../Infra/types.js";
import { ok, err } from "../../Infra/types.js";

import type {
  ExecutableRegistry,
  ExecutableRegistrySnapshot,
} from "./executableRegistry.js";

/** 算子闭集（9 个；新增须改本表 + 补反例，见 02-组装器与算子闭集.md §6） */
export const OPERATORS = [
  "Seq",
  "Par",
  "Branch",
  "Loop",
  "Nest",
  "Guard",
  "Fallback",
  "Deadline",
  "Join",
] as const;
export type Operator = (typeof OPERATORS)[number];

export interface PluginDecl {
  readonly id: string;
  readonly hooks: readonly string[];
  readonly conflictDomain: string;
  readonly enabled?: boolean;
}

export interface JoinDecl {
  readonly deps: readonly string[];
  readonly onMissing: "block" | "degrade" | "abandon";
  readonly minCompleteness?: number;
}

export interface AssemblyNode {
  readonly id: string;
  readonly executableRef: string;
  readonly operator?: Operator;
  readonly body?: readonly string[];
  readonly inputSections?: readonly string[];
  readonly plugins?: readonly PluginDecl[];
  readonly join?: JoinDecl;
}

/** 组装体（字段与 S7 `OuterLoop` 的 `Assembly` 兼容：id/executables/criteriaVersion/registryVersion） */
export interface AssemblySpec {
  readonly id: string;
  readonly executables: readonly string[];
  readonly nodes: readonly AssemblyNode[];
  readonly entrypoints: readonly string[];
  readonly criteriaVersion: string;
  readonly registryVersion: string;
}

export interface Violation {
  readonly criterion: string;
  readonly where: string;
  readonly reason: string;
}

export interface Verdict {
  readonly ok: boolean;
  readonly violations: readonly Violation[];
}

export const CRITERIA_VERSION = "crit-2026-10-15";

export interface AssemblyChange {
  readonly op: "add" | "remove" | "replace";
  readonly target?: string;
  readonly added?: AssemblyNode;
}

export interface AssemblerPorts {
  /** 落盘组装体（失败必须传播） */
  persist(spec: AssemblySpec): Promise<Result<void>>;
  /**
   * **撤销落盘**（反例 11 的补偿动作）。
   *
   * 落盘与审计是两个独立端口，无法做成一个事务；本端口把"落盘后审计失败"的
   * 那种状态（磁盘上有一份**无人知道是谁改的**组装体）显式消解掉。
   * 不提供撤销能力的组合根，等于承认自己会留下不可归因的变更。
   */
  retract(assemblyId: string): Promise<Result<void>>;
  /** 审计留痕（失败必须传播） */
  audit(record: {
    assemblyId: string;
    by: string;
    digest: string;
    violations: readonly Violation[];
  }): Promise<Result<void>>;
}

export interface AssemblyValidator {
  validate(
    candidate: AssemblySpec,
    registrySnapshot: ExecutableRegistrySnapshot,
  ): Verdict;
  criteriaIds(): readonly string[];
}

export interface Assembler {
  propose(
    current: AssemblySpec,
    change: AssemblyChange,
  ): Promise<Result<AssemblySpec>>;
  /**
   * 提交：**再校验** + 摘要匹配 + 落盘 + 审计。
   * 快照由装配器自己从目录取（**不从调用方传入**）—— 调用方无法用它来"绕过"目录现状。
   */
  commit(input: {
    candidate: AssemblySpec;
    validatedDigest: string;
    by: string;
  }): Promise<Result<void>>;
  /** 恢复：版本不一致 ⇒ **拒绝**（不得"先跑起来再说"） */
  restore(
    spec: AssemblySpec,
    current: { criteriaVersion: string; registryVersion: string },
  ): Result<void>;
  digestOf(spec: AssemblySpec): string;
  commits(): readonly AssemblySpec[];
}

/** 稳定摘要（用于 TOCTOU 防抖；与内容一一对应） */
function digest(spec: AssemblySpec): string {
  const canonical = JSON.stringify({
    id: spec.id,
    executables: [...spec.executables],
    entrypoints: [...spec.entrypoints],
    criteriaVersion: spec.criteriaVersion,
    registryVersion: spec.registryVersion,
    nodes: spec.nodes
      .map((n) => ({
        id: n.id,
        ref: n.executableRef,
        op: n.operator ?? null,
        body: [...(n.body ?? [])],
        input: [...(n.inputSections ?? [])],
        plugins: (n.plugins ?? []).map((p) => ({
          id: p.id,
          dom: p.conflictDomain,
          en: p.enabled ?? true,
        })),
        join: n.join
          ? { deps: [...n.join.deps], onMissing: n.join.onMissing }
          : null,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  });
  let h = 0;
  for (let i = 0; i < canonical.length; i++)
    h = (h * 31 + canonical.charCodeAt(i)) | 0;
  return "d" + (h >>> 0).toString(16) + "-" + canonical.length.toString(16);
}

/** 判据集：每条有 **id**（便于"这条判据拦下了什么"可追溯） */
export function createCriteriaSet(
  registry: ExecutableRegistry,
): Array<{ id: string; check: (spec: AssemblySpec) => Violation[] }> {
  const nodeById = (spec: AssemblySpec, id: string): AssemblyNode | undefined =>
    spec.nodes.find((n) => n.id === id);

  return [
    {
      id: "C-EXEC-1",
      check: (spec) => {
        const out: Violation[] = [];
        const nodeIds = new Set(spec.nodes.map((n) => n.id));
        for (const e of spec.executables) {
          if (!nodeIds.has(e))
            out.push({
              criterion: "C-EXEC-1",
              where: e,
              reason: "executables 中的 id 没有对应节点",
            });
        }
        for (const n of spec.nodes) {
          if (!spec.executables.includes(n.id))
            out.push({
              criterion: "C-EXEC-1",
              where: n.id,
              reason: "节点未登记进 executables",
            });
        }
        return out;
      },
    },
    {
      id: "C-LINK-1",
      check: (spec) => {
        const out: Violation[] = [];
        for (const n of spec.nodes) {
          if (!registry.resolve(n.executableRef)) {
            out.push({
              criterion: "C-LINK-1",
              where: n.id,
              reason: "执行件未注册（悬空引用）: " + n.executableRef,
            });
          }
          for (const b of n.body ?? []) {
            if (!nodeById(spec, b))
              out.push({
                criterion: "C-LINK-1",
                where: n.id,
                reason: "body 引用不存在的节点: " + b,
              });
          }
          for (const d of n.join?.deps ?? []) {
            if (!nodeById(spec, d))
              out.push({
                criterion: "C-LINK-1",
                where: n.id,
                reason: "join.deps 引用不存在的节点: " + d,
              });
          }
        }
        return out;
      },
    },
    {
      id: "C-OP-1",
      check: (spec) => {
        const out: Violation[] = [];
        for (const n of spec.nodes) {
          if (
            n.operator !== undefined &&
            !(OPERATORS as readonly string[]).includes(n.operator)
          ) {
            out.push({
              criterion: "C-OP-1",
              where: n.id,
              reason: "算子不在闭集内: " + String(n.operator),
            });
          }
        }
        return out;
      },
    },
    {
      id: "C-CYC-1",
      check: (spec) => {
        const out: Violation[] = [];
        const adj = new Map<string, string[]>();
        for (const n of spec.nodes)
          adj.set(n.id, [...(n.body ?? []), ...(n.join?.deps ?? [])]);
        const state = new Map<string, 0 | 1 | 2>();
        const visit = (id: string, path: string[]): void => {
          const st = state.get(id) ?? 0;
          if (st === 1) {
            out.push({
              criterion: "C-CYC-1",
              where: id,
              reason: "存在环: " + [...path, id].join("→"),
            });
            return;
          }
          if (st === 2) return;
          state.set(id, 1);
          for (const nx of adj.get(id) ?? []) visit(nx, [...path, id]);
          state.set(id, 2);
        };
        for (const n of spec.nodes) visit(n.id, []);
        return out;
      },
    },
    {
      id: "C-NEST-1",
      check: (spec) => {
        const out: Violation[] = [];
        for (const n of spec.nodes) {
          if (!n.body || n.body.length === 0) continue;
          const hostSections = [...(n.inputSections ?? [])];
          for (const childId of n.body) {
            const child = nodeById(spec, childId);
            if (!child) continue;
            const childSections = [...(child.inputSections ?? [])];
            const extra = childSections.filter(
              (s) => !hostSections.includes(s),
            );
            if (extra.length > 0) {
              out.push({
                criterion: "C-NEST-1",
                where: childId,
                reason: "子件越权可见（宿主未声明）: " + extra.join(","),
              });
            }
            if (
              hostSections.length > 0 &&
              childSections.length === hostSections.length &&
              childSections.every((s) => hostSections.includes(s))
            ) {
              out.push({
                criterion: "C-NEST-1",
                where: childId,
                reason: "子件输入集等于宿主全集（嵌套退化）",
              });
            }
          }
        }
        return out;
      },
    },
    {
      id: "C-PLUG-1",
      check: (spec) => {
        const out: Violation[] = [];
        for (const n of spec.nodes) {
          const byDomain = new Map<string, string[]>();
          for (const p of n.plugins ?? []) {
            if (p.enabled === false) continue;
            const list = byDomain.get(p.conflictDomain) ?? [];
            list.push(p.id);
            byDomain.set(p.conflictDomain, list);
          }
          for (const [dom, ids] of byDomain) {
            if (ids.length > 1) {
              out.push({
                criterion: "C-PLUG-1",
                where: n.id,
                reason:
                  "同 conflictDomain(" + dom + ") 同时启用: " + ids.join(","),
              });
            }
          }
        }
        return out;
      },
    },
    {
      id: "C-JOIN-1",
      check: (spec) => {
        const out: Violation[] = [];
        for (const n of spec.nodes) {
          if (
            n.join &&
            !["block", "degrade", "abandon"].includes(n.join.onMissing)
          ) {
            out.push({
              criterion: "C-JOIN-1",
              where: n.id,
              reason: "join 必须声明 onMissing",
            });
          }
        }
        return out;
      },
    },
    {
      id: "C-ENTRY-1",
      check: (spec) => {
        const out: Violation[] = [];
        if (spec.entrypoints.length === 0) {
          out.push({
            criterion: "C-ENTRY-1",
            where: spec.id,
            reason: "组装体没有入口点",
          });
        }
        for (const e of spec.entrypoints) {
          if (!nodeById(spec, e))
            out.push({
              criterion: "C-ENTRY-1",
              where: e,
              reason: "入口点不存在",
            });
        }
        return out;
      },
    },
    {
      id: "C-VER-1",
      check: (spec) => {
        const out: Violation[] = [];
        if (spec.criteriaVersion !== CRITERIA_VERSION) {
          out.push({
            criterion: "C-VER-1",
            where: spec.id,
            reason: "criteriaVersion 不匹配，需重验存量组装体",
          });
        }
        if (spec.registryVersion !== registry.snapshot().version) {
          out.push({
            criterion: "C-VER-1",
            where: spec.id,
            reason: "registryVersion 不匹配，需重验存量组装体",
          });
        }
        return out;
      },
    },
  ];
}

export function createAssemblyValidator(
  registry: ExecutableRegistry,
  /** 扩展判据（如 `createExtendedCriteria()` 补齐 03 §6 的其余条目） */
  extraCriteria?: ReadonlyArray<{
    id: string;
    check: (spec: AssemblySpec) => Violation[];
  }>,
): AssemblyValidator {
  const criteria = [...createCriteriaSet(registry), ...(extraCriteria ?? [])];
  return {
    criteriaIds: () => criteria.map((c) => c.id),
    validate: (candidate) => {
      const violations: Violation[] = [];
      for (const c of criteria) violations.push(...c.check(candidate));
      return { ok: violations.length === 0, violations };
    },
  };
}

export function createAssembler(
  registry: ExecutableRegistry,
  validator: AssemblyValidator,
  ports: AssemblerPorts,
): Assembler {
  const committed: AssemblySpec[] = [];

  return {
    digestOf: digest,
    commits: () => [...committed],

    async propose(current, change) {
      const nodes = [...current.nodes];
      let executables = [...current.executables];
      if (change.op === "add") {
        if (!change.added) return err("add 变更缺少 added 节点");
        if (nodes.some((n) => n.id === change.added!.id))
          return err("节点 id 已存在: " + change.added.id);
        nodes.push(change.added);
        executables.push(change.added.id);
      } else {
        if (!change.target) return err(change.op + " 变更缺少 target");
        const idx = nodes.findIndex((n) => n.id === change.target);
        if (idx < 0) return err("目标节点不存在: " + change.target);
        if (change.op === "remove") {
          nodes.splice(idx, 1);
          executables = executables.filter((e) => e !== change.target);
        } else {
          if (!change.added) return err("replace 变更缺少 added 节点");
          nodes[idx] = change.added;
          executables = executables.map((e) =>
            e === change.target ? change.added!.id : e,
          );
        }
      }
      return ok({
        ...current,
        nodes,
        executables,
        criteriaVersion: current.criteriaVersion,
        registryVersion: current.registryVersion,
      });
    },

    async commit(input) {
      // ★ 纪律 8：提交前**再校验一次**（防调用方绕过）
      const verdict = validator.validate(input.candidate, registry.snapshot());
      if (!verdict.ok) {
        return err(
          "组装未通过检查树，不得提交: " +
            verdict.violations
              .map((v) => v.criterion + "@" + v.where)
              .join(" | "),
        );
      }
      // ★ 纪律 8：摘要匹配（防 TOCTOU —— 校验通过后又改了候选）
      const actual = digest(input.candidate);
      if (actual !== input.validatedDigest) {
        return err(
          "候选组装体在校验后被修改（摘要不匹配）: 期望 " +
            input.validatedDigest +
            "，实际 " +
            actual,
        );
      }
      // ★ 纪律 10：落盘与审计缺一不可
      const saved = await ports.persist(input.candidate);
      if (!saved.ok) return err("组装体落盘失败: " + saved.error);
      const audited = await ports.audit({
        assemblyId: input.candidate.id,
        by: input.by,
        digest: actual,
        violations: verdict.violations,
      });
      if (!audited.ok) {
        // ★ 纪律 10 + 反例 11：审计失败 ⇒ 这份落盘**必须撤回**，
        //   否则磁盘上留着一份"没人知道是谁改的"组装体，变更不可归因。
        const retracted = await ports.retract(input.candidate.id);
        if (!retracted.ok) {
          return err(
            "组装变更审计失败（不允许无痕变更）: " +
              audited.error +
              "；且落盘撤回失败（" +
              retracted.error +
              "）⇒ 存储与审计已分叉，需人工介入",
          );
        }
        return err(
          "组装变更审计失败（不允许无痕变更）: " +
            audited.error +
            "；已撤回落盘",
        );
      }
      committed.push(input.candidate);
      return ok(undefined);
    },

    restore(spec, current) {
      if (spec.criteriaVersion !== current.criteriaVersion) {
        return err(
          "拒绝恢复：criteriaVersion 不匹配（" +
            spec.criteriaVersion +
            " vs " +
            current.criteriaVersion +
            "）",
        );
      }
      if (spec.registryVersion !== current.registryVersion) {
        return err(
          "拒绝恢复：registryVersion 不匹配（" +
            spec.registryVersion +
            " vs " +
            current.registryVersion +
            "）",
        );
      }
      return ok(undefined);
    },
  };
}
