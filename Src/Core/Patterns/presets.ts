/**
 * @module Core/Patterns/presets
 * @description
 * `RoutingMode` 六种模式的**预设**：把每个模式表达为**组合**（组合子 + Workflow + P&E + GoalGuard）。
 *
 * 设计出处：Docs/Dev/L1编排设计/22-执行件-三种模式.md §7（迁移策略）·
 *   02-组装器与算子闭集.md（算子闭集）
 *
 * **A/B 对齐的诚实前提**（取证方式见下表 `baseline`）：
 *   - `DIRECT` / `DELEGATION` / `ASSEMBLY_LINE` / `CONSORTIUM` 在现有实现里**有对应行为块**
 *     （`Src/Core/Decision/orchestrator/orchestrator.ts`），因此可做 A/B 对齐；
 *   - `LITIGATION` / `REGULATION` 在现有实现里**只有类型与注释（标注 S12）**，
 *     **A 侧基线不存在** ⇒ 它们是**新设计**，不是迁移，**不做也无法做 A/B 对齐**。
 */

import type { Result } from "../../Infra/types.js";
import { err } from "../../Infra/types.js";
import type { Executable, ReactInput } from "../Orchestration/outerLoop.js";
import type { RoutingMode } from "../Decision/types.js";

import { branch, fallback, par, seq, type ParJoin } from "./combinators.js";
import {
  createGoalGuard,
  createWorkflow,
  directPreset,
  withGoalGuard,
} from "./patterns.js";

/** A 侧基线：现有实现里的对应行为块；`absent` 表示现有实现中无此行为 */
export type BaselineRef =
  | { readonly kind: "implemented"; readonly at: string; readonly note: string }
  | { readonly kind: "absent"; readonly note: string };

export interface PresetParts {
  /** DIRECT / REGULATION 的主体 */
  readonly body?: Executable;
  /** DELEGATION 的并行委派件（worker） */
  readonly workers?: readonly Executable[];
  /** ASSEMBLY_LINE 的流水线阶段 */
  readonly stages?: readonly Executable[];
  /** CONSORTIUM 的合伙件（partner） */
  readonly partners?: readonly Executable[];
  /** LITIGATION 的两造（主张 / 抗辩）与仲裁者 */
  readonly claim?: Executable;
  readonly defense?: Executable;
  readonly arbiter?: Executable;
  /** Branch 的选择函数（按输入/上游裁决选分支键） */
  readonly chooseLitigation?: () => string | null;
  /** REGULATION 的审批门（约束件）；`immutableZoneDigest` = 审批依据的不可变区**应有**摘要 */
  readonly approval?: {
    readonly id: string;
    readonly statement: string;
    readonly criteria: string;
    readonly immutableZoneDigest: string;
  };
  /** 不可变区摘要的**观测**通道（由外层给；审批门不得自造判定基础） */
  readonly zoneDigestOf?: (input: ReactInput) => string;
  /** 各模式并行时的 join 语义（默认见下） */
  readonly join?: ParJoin;
}

export interface PresetDescriptor {
  readonly mode: RoutingMode;
  /** 由什么组合得到（结构说明，供 A/B 对照） */
  readonly composition: string;
  readonly baseline: BaselineRef;
  readonly build: () => Result<Executable>;
}

/** 有 A 侧基线（可 A/B 对齐）的四个模式 */
export const MODES_WITH_BASELINE: readonly RoutingMode[] = [
  "DIRECT",
  "DELEGATION",
  "ASSEMBLY_LINE",
  "CONSORTIUM",
];

/** 现有实现中**无** A 侧基线的两个模式（类型里标注 S12） */
export const MODES_WITHOUT_BASELINE: readonly RoutingMode[] = [
  "LITIGATION",
  "REGULATION",
];

export function presetDescriptors(
  parts: PresetParts,
): readonly PresetDescriptor[] {
  return [
    {
      mode: "DIRECT",
      composition: "Workflow 单节点（directPreset）",
      baseline: {
        kind: "implemented",
        at: "Src/Core/Decision/orchestrator/orchestrator.ts:707",
        note: "DIRECT：maxParallelism=1，直接指派",
      },
      build: () => {
        if (!parts.body) return err("DIRECT 需要 body");
        return directPreset(parts.body);
      },
    },
    {
      mode: "DELEGATION",
      composition: "Par(workers, all) —— 并行委派",
      baseline: {
        kind: "implemented",
        at: "Src/Core/Decision/orchestrator/orchestrator.ts:778",
        note: "DELEGATION：派生子 Agent（role=worker）并行执行",
      },
      build: () => {
        const workers = parts.workers ?? [];
        if (workers.length === 0) return err("DELEGATION 需要至少一个 worker");
        return par("delegation", workers, parts.join ?? "all");
      },
    },
    {
      mode: "ASSEMBLY_LINE",
      composition: "Seq(stages) —— 流水线",
      baseline: {
        kind: "implemented",
        at: "Src/Core/Decision/orchestrator/orchestrator.ts:844",
        note: "ASSEMBLY_LINE：阶段顺序推进",
      },
      build: () => {
        const stages = parts.stages ?? [];
        if (stages.length === 0) return err("ASSEMBLY_LINE 需要至少一个阶段");
        return seq("assembly-line", stages);
      },
    },
    {
      mode: "CONSORTIUM",
      composition: "Par(partners, settled) + Fallback(择优)",
      baseline: {
        kind: "implemented",
        at: "Src/Core/Decision/orchestrator/orchestrator.ts:902",
        note: "CONSORTIUM：派生子 Agent（role=partner）高难攻坚",
      },
      build: () => {
        const partners = parts.partners ?? [];
        if (partners.length === 0)
          return err("CONSORTIUM 需要至少一个 partner");
        const gathered = par("consortium", partners, parts.join ?? "settled");
        if (!gathered.ok) return gathered;
        // 择优：以汇聚结果为输入再走一次仲裁件；无仲裁件则直接返回汇聚结果
        if (!parts.arbiter) return gathered;
        return fallback("consortium-arbitrate", [
          parts.arbiter,
          gathered.value,
        ]);
      },
    },
    {
      mode: "LITIGATION",
      composition: "Branch(主张 / 抗辩) + Fallback(仲裁)",
      baseline: {
        kind: "absent",
        note: "现有实现只有类型与注释（标注 S12），A 侧基线不存在 ⇒ 新设计，不做 A/B 对齐",
      },
      build: () => {
        if (!parts.claim || !parts.defense)
          return err("LITIGATION 需要主张与抗辩两造");
        const chosen = branch(
          "litigation",
          [
            { when: "claim", executable: parts.claim },
            { when: "defense", executable: parts.defense },
          ],
          () => (parts.chooseLitigation ? parts.chooseLitigation() : "claim"),
        );
        if (!chosen.ok) return chosen;
        if (!parts.arbiter) return chosen;
        return fallback("litigation-arbitrate", [parts.arbiter, chosen.value]);
      },
    },
    {
      mode: "REGULATION",
      composition: "Workflow 单节点 + GoalGuard（审批门）",
      baseline: {
        kind: "absent",
        note: "现有实现只有类型与注释（标注 S12），A 侧基线不存在 ⇒ 新设计，不做 A/B 对齐",
      },
      build: () => {
        if (!parts.body) return err("REGULATION 需要 body");
        if (!parts.approval) return err("REGULATION 需要审批门（approval）");
        if (!parts.zoneDigestOf)
          return err("REGULATION 需要不可变区摘要观测通道（zoneDigestOf）");
        const guard = createGoalGuard({
          id: parts.approval.id,
          statement: parts.approval.statement,
          criteria: parts.approval.criteria,
          immutableZoneDigest: parts.approval.immutableZoneDigest,
        });
        if (!guard.ok) return guard;
        const guarded = withGoalGuard(
          parts.body,
          guard.value,
          parts.zoneDigestOf,
        );
        return createWorkflow({
          nodes: [
            {
              id: "regulated",
              body: guarded,
              predecessors: [],
              joinMissing: "block",
            },
          ],
          entry: "regulated",
          depth: 0,
          maxDepth: 0,
        });
      },
    },
  ];
}

/** 按模式构建预设执行件 */
export function presetFor(
  mode: RoutingMode,
  parts: PresetParts,
): Result<Executable> {
  const d = presetDescriptors(parts).find((x) => x.mode === mode);
  if (!d) return err("未知模式: " + String(mode));
  return d.build();
}
