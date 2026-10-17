/**
 * @module Core/Supervision/componentSnapshot
 * @description
 * S2 · **组件级监管快照** = C1/C2/C3/C4 已有账的**只读投影**，**不是第三个写者**。
 *
 * 设计出处：Docs/Dev/L1编排设计/23-原语补齐与监管快照.md §S2（内容严格两项 + 权限边界 + 反例 1–6）·
 *   13-ReAct跨切面约束.md §12.1（监管要能复现判断，不需要窥探草稿）/ §12.2（三类动作的权限边界）·
 *   20-归属复核.md §2 问题 1（快照双写者的处置）· 16-LifecycleController.md §0（监管指令进 C1，违规留痕）
 *
 * 五条落地纪律（每条都有负向测试，见 Tests/Core/componentSnapshot.spec.ts）：
 *   1. 内容**只有两项**：上下文快照（按组件**当前可见范围**，不是全量）+ 工作状态（C1 决策历史 · C2/C3 账本 · 诊断信号）。
 *   2. **不含私有推理**（S-01 草稿）：诊断信号按**排除闭集**过滤（含嵌套与数组元素）后才进快照。
 *   3. **不落盘**：本件没有任何写端口 —— 依赖面只有读（`assemble`/`snapshot`/`getState`/`violations`/`decisions`）。
 *   4. **越权可见 ⇒ 拒**：快照范围必须是宿主可见面的**真子集**（不得扩分区、不得扩历史轮数、不得导出宿主全集）。
 *   5. **干预只能留痕 + 要求组件重决**：本件不提供任何置状态入口；监管指令一律经 C1 的合法集收束（反例 6）。
 *      通道是**可校验的**：控制器创建时必须接 `channel.hook`，否则指令未被消费 ⇒ 本件**报错**而非静默放行。
 */

import type { Result } from "../../Infra/types.js";
import { ok, err } from "../../Infra/types.js";
import type {
  ContextAssembler,
  ContextSelector,
  ChatMessagePort,
} from "../Context/contextAssembler.js";
import type {
  DecisionRecord,
  LifecycleController,
  LifecycleViolation,
} from "../Lifecycle/lifecycleController.js";
import type {
  Decision,
  LifecycleCtx,
  LifecycleEvent,
  LifecycleState,
} from "../Lifecycle/lifecycleTypes.js";
import type { ChildRegistry, DomainLedger } from "../Ledger/ledgers.js";

/**
 * 私有推理（S-01 草稿）/ 治理内部状态的**排除闭集**（键名归一化后**包含**即剔除）。
 * 新增条目必须同时补一条反例测试 —— 这个闭集是监管可见性的边界本身。
 */
export const EXCLUDED_DIAGNOSTIC_KEYS: readonly string[] = [
  // ── 私有推理（13 §12.1：监管不复现草稿）──
  "draft",
  "reasoning",
  "scratchpad",
  "chainofthought",
  "cot",
  "private",
  "s01",
  // ── 治理内部状态（反例 5：层级隔离）──
  // 注：这两条按**子串**匹配，宁可错杀 benign 键（fail-closed），也不放过合法表/收紧表/决策缓存。
  "governance",
  "legal",
  "tightened",
  "cache",
  "internalgovernance",
];

/** 上下文快照（**按可见范围**，不是全量） */
export interface SnapshotContext {
  readonly visible: ContextSelector;
  readonly sections: ReadonlyArray<{ key: string; content: string }>;
  /** 组件**实际看到**的历史（已按可见面裁剪；监管据此复现判断） */
  readonly history: readonly ChatMessagePort[];
  readonly historyTurns: number;
}

/** 工作状态（C1 决策历史 + C2/C3 账本 + 过滤后的诊断信号；**不含**草稿） */
export interface SnapshotWork {
  readonly state: LifecycleState;
  readonly decisions: readonly DecisionRecord[];
  readonly violations: readonly LifecycleViolation[];
  readonly outstandingChildren: readonly string[];
  readonly childrenQuiescent: boolean;
  readonly domainSelf: string;
  readonly domainPeers: ReadonlyArray<{
    peerId: string;
    state: string;
    conflictDomain: string;
  }>;
  readonly domainQuiescent: boolean;
  readonly modelCallCount: number;
  readonly diagnostics: Readonly<Record<string, unknown>>;
}

export interface ComponentSupervisionSnapshot {
  readonly componentId: string;
  readonly takenAt: number;
  readonly context: SnapshotContext;
  readonly work: SnapshotWork;
}

export interface ComponentSnapshotDeps {
  /** C4：只读装配（本件用它取可见子范围，**不写**任何分区） */
  contexts: ContextAssembler;
  /** C3 下级账本 */
  children: ChildRegistry;
  /** C2 域账本 */
  domain: DomainLedger;
  /** C1 控制器（该组件的那一份） */
  controller: LifecycleController;
  /** 监管指令通道：控制器创建时必须以 `supervision: channel.hook` 接上；未接则 `intervene` 报错 */
  channel: SupervisionChannel;
  history: () => ChatMessagePort[];
  /** 诊断信号来源（如 `agentRegistry` 的诊断快照）；进快照前按排除闭集过滤 */
  diagnostics?: () => Record<string, unknown>;
  now?: () => number;
}

export interface InterveneInput {
  componentId: string;
  event: LifecycleEvent;
  ctx: LifecycleCtx;
  /**
   * 监管**意图**（拦截 / 降级 / 冻结）。类型是 `Decision` 而非 `LifecycleState`：
   * 降级/放弃必须自带 `reason`，挂起必须自带 `until` —— 缺依据的指令本来就不合法。
   */
  directive: Decision;
}

export interface ComponentSnapshot {
  /**
   * 生成一个组件的监管快照。
   *
   * `visible` = 监管**申请**的可见面（必须是 `host` 的真子集）；`host` = 该组件所在宿主的可见面。
   */
  snapshot(input: {
    componentId: string;
    visible: ContextSelector;
    host: ContextSelector;
  }): Result<ComponentSupervisionSnapshot>;
  /**
   * 监管干预：**登记意图并交给 C1 按合法集收束**。
   * 本件**不**直接置状态、**不**改组件内部数据 —— 越出合法集的指令由 C1 拒绝并留痕。
   */
  intervene(input: InterveneInput): Promise<Result<Decision>>;
}

/**
 * 监管指令 ↔ C1 合法集之间的**唯一**通道。
 *
 * 接线（composition root）：
 *   `const channel = createSupervisionChannel();`
 *   `createLifecycleController({ ..., supervision: channel.hook })`
 *   `createComponentSnapshot({ channel, controller, ... })`
 *
 * 指令**一次性**消费（取走即删）—— 残留未消费的指令意味着控制器没接通道，
 * 那等价于"绕过合法集"，必须由 `intervene` 报错而非静默通过。
 */
export interface SupervisionChannel {
  hook(event: LifecycleEvent, ctx: LifecycleCtx): Decision | null;
  place(componentId: string, event: LifecycleEvent, directive: Decision): void;
  hasPending(componentId: string, event: LifecycleEvent): boolean;
  drop(componentId: string, event: LifecycleEvent): void;
}

export function createSupervisionChannel(): SupervisionChannel {
  const pending = new Map<string, Decision>();
  const keyOf = (componentId: string, event: LifecycleEvent): string =>
    componentId + ":" + event;
  return {
    hook(event, ctx): Decision | null {
      const key = keyOf(ctx.componentId, event);
      const directive = pending.get(key);
      if (!directive) return null;
      pending.delete(key);
      return directive;
    },
    place(componentId, event, directive): void {
      pending.set(keyOf(componentId, event), directive);
    },
    hasPending: (componentId, event): boolean =>
      pending.has(keyOf(componentId, event)),
    drop(componentId, event): void {
      pending.delete(keyOf(componentId, event));
    },
  };
}

/** 键名归一化：小写 + 去掉 `_`/`-`（闭集按"包含"匹配，变体写法一并拦下） */
function normKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, "");
}

function isExcluded(key: string): boolean {
  const norm = normKey(key);
  return EXCLUDED_DIAGNOSTIC_KEYS.some((bad) => norm.includes(bad));
}

/**
 * 按排除闭集过滤诊断信号。
 * 数组元素**同样过滤**（否则 `{ signals: [{ draft: … }] }` 会整串漏过 —— 反例 2 的真实形态）。
 */
function redact(value: unknown, depth = 0): Record<string, unknown> {
  if (depth > 4 || typeof value !== "object" || value === null) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (isExcluded(k)) continue;
    if (Array.isArray(v)) {
      out[k] = v.map((item) =>
        item && typeof item === "object" && !Array.isArray(item)
          ? redact(item, depth + 1)
          : item,
      );
      continue;
    }
    if (v && typeof v === "object") {
      out[k] = redact(v, depth + 1);
      continue;
    }
    out[k] = v;
  }
  return out;
}

function turnsOf(sel: ContextSelector): number {
  return sel.history === "all"
    ? Number.MAX_SAFE_INTEGER
    : sel.history.recentTurns;
}

export function createComponentSnapshot(
  deps: ComponentSnapshotDeps,
): ComponentSnapshot {
  const now = deps.now ?? ((): number => Date.now());

  return {
    snapshot({
      componentId,
      visible,
      host,
    }: {
      componentId: string;
      visible: ContextSelector;
      host: ContextSelector;
    }): Result<ComponentSupervisionSnapshot> {
      if (componentId.trim().length === 0) return err("快照必须指明组件 id");

      // 纪律 4：越权可见 ⇒ 拒。**分区子集**这条规则的唯一持有者是 C4（此处不复制判定）
      const subset = deps.contexts.assertSubsetOfHost(visible, host);
      if (!subset.ok) return subset;
      // 历史轮数不在 C4 的判定范围内，由本件把住（同样只能收紧）
      if (turnsOf(visible) > turnsOf(host)) {
        return err("快照历史轮数不得超出宿主可见范围（只能收紧）");
      }

      // 纪律 1 + 3：只经 C4 的**读**路径取可见子范围（不写任何分区）
      const history = deps.history();
      const obs = deps.contexts.assemble(visible, {
        history,
        upstream: {},
        events: [],
      });
      if (!obs.ok) return obs;

      const work: SnapshotWork = {
        state: deps.controller.getState(),
        // 纪律 1：C1 决策历史（回答"为何选了那个状态"）
        decisions: deps.controller.decisions(),
        violations: deps.controller.violations(),
        outstandingChildren: deps.children.outstanding(),
        childrenQuiescent: deps.children.quiescent(),
        domainSelf: deps.domain.snapshot().selfState,
        domainPeers: deps.domain.peers(),
        domainQuiescent: deps.domain.domainQuiescent(),
        modelCallCount: deps.controller.modelCallCount(),
        // 纪律 2：草稿/私有推理**进不了**快照
        diagnostics: redact(deps.diagnostics?.() ?? {}),
      };

      return ok({
        componentId,
        takenAt: now(),
        context: {
          visible,
          sections: obs.value.contextSections.map((s) => ({
            key: s.key,
            content: s.content,
          })),
          history: obs.value.history,
          historyTurns:
            visible.history === "all"
              ? history.length
              : Math.min(visible.history.recentTurns, history.length),
        },
        work,
      });
    },

    async intervene({
      componentId,
      event,
      ctx,
      directive,
    }: InterveneInput): Promise<Result<Decision>> {
      if (componentId.trim().length === 0) return err("干预必须指明组件 id");
      // 指令不得打到"别的"组件：目标 id 与判定上下文 id 必须一致
      if (ctx.componentId !== componentId) {
        return err(
          "监管指令目标（" +
            componentId +
            "）与判定上下文组件（" +
            ctx.componentId +
            "）不一致",
        );
      }
      deps.channel.place(componentId, event, directive);

      // 纪律 5：唯一的置状态通道 = C1（两层合法集 + 违规留痕 + suspend 强制落盘）
      const decision = await deps.controller.onEvent(event, ctx);
      if (deps.channel.hasPending(componentId, event)) {
        deps.channel.drop(componentId, event);
        return err(
          "监管指令未经 C1 收束（控制器创建时未接 supervision 通道，等价于绕过合法集）",
        );
      }
      return decision;
    },
  };
}
