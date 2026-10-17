/**
 * @module Core/Orchestration/outerLoop
 * @description
 * L1 **外层循环（宿主）**：持有组装体与对话级状态，驱动执行件，收拢待决事项，判域收敛，驱动组装变更。
 *
 * 设计出处：Docs/Dev/L1编排设计/19-OuterLoop.md · 13 §16（铁律）· 03 §6（判据）· 10-组件的三集合.md
 *
 * 本步（S7）要成立的关键纪律，每条都有负向测试：
 *   1. **收敛判定先于选件**（否则会多跑一轮、产生无谓副作用）。
 *   2. **工具集仅编排类**：外层不得持有 read/write/execute 等业务工具（构造时即拒绝）。
 *   3. **ReactInput 全部由外部构造**：state/control/observation/grants 都来自本层。
 *   4. **needs_decision 不得丢弃**：机械事件→账本；需判断→控制器；**未知事件 ⇒ 报错**。
 *   5. **组装变更必须过校验**：校验不通过 ⇒ 不提交（回选件），且留痕。
 *   6. **不得改恒定区**；**不得每周期重建组装体**。
 *   7. 预算/截止耗尽 ⇒ **degrade 收尾**（带 gaps），不是假装完成。
 */

import type { Result } from "../../Infra/types.js";
import { ok, err } from "../../Infra/types.js";

import {
  ALL_EVENTS,
  MECHANICAL_EVENTS,
  type LifecycleCtx,
  type LifecycleEvent,
  type LifecycleState,
} from "../Lifecycle/lifecycleTypes.js";
import type { LifecycleController } from "../Lifecycle/lifecycleController.js";
import type {
  ChildOutcome,
  ChildRegistry,
  DomainLedger,
} from "../Ledger/ledgers.js";
import type {
  ContextAssembler,
  ContextSelector,
  Observation,
} from "../Context/contextAssembler.js";

/** 编排类工具**闭集**（外层只允许看见这些；新增须改本表 + 补反例） */
export const ORCHESTRATION_TOOLS: readonly string[] = [
  "OrchestratorCompose",
  "OrchestratorSelect",
];

/** 待决事项：事件名 + 负载（负载是数据，事件名取自**事件闭集**） */
export interface NeedsDecision {
  event: LifecycleEvent;
  payload?: Record<string, unknown>;
}

/** 执行件的对外契约（三集合的声明部分） */
export interface ExecutableContract {
  readonly inputSet: ContextSelector;
  readonly outputSet: readonly string[];
  readonly toolSet: readonly string[];
  readonly plugins?: readonly string[];
}

export interface Executable {
  readonly id: string;
  readonly contract: ExecutableContract;
  step(input: ReactInput): Promise<Result<ReactOutput>>;
}

/** 外部**构造**给执行件的输入（执行件不得自造） */
export interface ReactInput {
  readonly state: LifecycleState;
  readonly control: {
    readonly shouldContinue: boolean;
    readonly budgetRemaining: number;
    readonly deadlineAt?: number;
    readonly cycle: number;
  };
  readonly observation: Observation;
  readonly grants: {
    readonly tools: readonly string[];
    readonly plugins: readonly string[];
    readonly visible: ContextSelector;
  };
}

export interface ReactOutput {
  readonly produced: Record<string, unknown>;
  readonly events: unknown[];
  readonly needsDecision: readonly NeedsDecision[];
  readonly requestsAssemblyChange?: AssemblyChange;
  readonly usage: { readonly tokens: number; readonly iterations: number };
}

export interface AssemblyChange {
  readonly op: "add" | "remove" | "replace";
  readonly target?: string;
  readonly added?: { readonly id: string };
}

export interface Assembly {
  readonly id: string;
  readonly executables: readonly string[];
  readonly criteriaVersion: string;
  readonly registryVersion: string;
}

export interface Verdict {
  readonly ok: boolean;
  readonly violations: readonly string[];
}

export interface RegistryPort {
  resolve(ref: string): { id: string } | null;
  snapshot(): unknown;
}

export interface AssemblerPort {
  propose(current: Assembly, change: AssemblyChange): Promise<Result<Assembly>>;
  commit(
    candidate: Assembly,
    verdict: Verdict,
    by: string,
  ): Promise<Result<void>>;
}

export interface ValidatorPort {
  validate(candidate: Assembly, registrySnapshot: unknown): Verdict;
}

export interface OuterLoopDeps {
  registry: RegistryPort;
  assembler: AssemblerPort;
  validator: ValidatorPort;
  children: ChildRegistry;
  domain: DomainLedger;
  contexts: ContextAssembler;
  /** 每个组件一个控制器实例（由外层持有） */
  controllerFor: (componentId: string) => LifecycleController;
  /** 解析执行件（组装体里是 id 列表） */
  resolveExecutable: (id: string) => Executable | null;
  /** 选下一个执行件（**外部决定**；本函数是选件策略） */
  selectExecutable: (
    assembly: Assembly,
    state: { cycle: number },
  ) => string | null;
  /** 本层自己的工具集（须 ⊆ ORCHESTRATION_TOOLS） */
  selfTools: readonly string[];
  initialAssembly: Assembly;
  goalSatisfied: () => boolean;
  budget: { remaining: number; deadlineAt?: number };
  history: () => Array<{ role: string; content: string }>;
  dialogueId: string;
  goal: string;
  /** 是否新对话（默认 true） */
  newDialogue?: boolean;
  emit?: (event: unknown) => void;
  meter?: (usage: { tokens: number; iterations: number }) => void;
  now?: () => number;
  maxCycles?: number;
}

export interface TaskOutcome {
  readonly state: "domain_complete" | "degraded";
  readonly cycles: number;
  readonly gaps: readonly string[];
  readonly assemblyId: string;
  readonly handledDecisions: number;
}

export interface OuterLoop {
  run(): Promise<Result<TaskOutcome>>;
  stats(): {
    cycles: number;
    assemblyChanges: number;
    assemblyRejections: number;
    handledDecisions: number;
    selects: number;
  };
}

export function createOuterLoop(deps: OuterLoopDeps): Result<OuterLoop> {
  // ★ 纪律 2：外层不得持有业务工具（构造时即拒绝，不是运行期警告）
  const illegal = deps.selfTools.filter(
    (t) => !ORCHESTRATION_TOOLS.includes(t),
  );
  if (illegal.length > 0) {
    return err(
      "外层工具集含非编排类工具: " +
        illegal.join(",") +
        "（仅允许 " +
        ORCHESTRATION_TOOLS.join(",") +
        "）",
    );
  }

  const now = deps.now ?? (() => Date.now());
  const emit = deps.emit ?? (() => {});
  const maxCycles = deps.maxCycles ?? 32;

  const stats = {
    cycles: 0,
    assemblyChanges: 0,
    assemblyRejections: 0,
    handledDecisions: 0,
    selects: 0,
  };

  return ok({
    stats: () => ({ ...stats }),

    async run(): Promise<Result<TaskOutcome>> {
      let assembly = deps.initialAssembly;

      // 对话级初始化：**只写边界键**（不清空 store、不拼接旧消息）
      if (deps.newDialogue !== false) {
        const opened = deps.contexts.openDialogue({
          dialogueId: deps.dialogueId,
          goal: deps.goal,
        });
        if (!opened.ok) return opened;
      }

      const gaps: string[] = [];

      while (true) {
        // ① 收敛判定（**先于选件**）
        if (
          deps.domain.domainQuiescent() &&
          deps.goalSatisfied() &&
          deps.children.quiescent()
        ) {
          return ok({
            state: "domain_complete",
            cycles: stats.cycles,
            gaps,
            assemblyId: assembly.id,
            handledDecisions: stats.handledDecisions,
          });
        }

        // 预算 / 截止 ⇒ degrade 收尾（带 gaps），不假装完成
        const deadlineHit =
          deps.budget.deadlineAt !== undefined &&
          now() >= deps.budget.deadlineAt;
        if (deps.budget.remaining <= 0 || deadlineHit) {
          gaps.push(deps.budget.remaining <= 0 ? "预算耗尽" : "超过截止时间");
          return ok({
            state: "degraded",
            cycles: stats.cycles,
            gaps,
            assemblyId: assembly.id,
            handledDecisions: stats.handledDecisions,
          });
        }

        if (stats.cycles >= maxCycles) {
          return err("外层循环超过最大周期 " + maxCycles + "（疑死循环）");
        }

        // ② 选件（外部决定）
        stats.selects += 1;
        const exeId = deps.selectExecutable(assembly, { cycle: stats.cycles });
        if (exeId === null) {
          return err("组装体 " + assembly.id + " 中没有可执行的组件");
        }
        const exe = deps.resolveExecutable(exeId);
        if (!exe) return err("执行件未注册: " + exeId);

        // ③ 构造 ReactInput（state/control/observation/grants 全部由外部给）
        const controller = deps.controllerFor(exe.id);
        const ctx = lifecycleCtx(exe.id, deps, now());
        const obs = deps.contexts.assemble(exe.contract.inputSet, {
          history: deps.history(),
          upstream: {},
          events: [],
        });
        if (!obs.ok) return obs;
        const input: ReactInput = {
          state: controller.getState(),
          control: {
            shouldContinue: true,
            budgetRemaining: deps.budget.remaining,
            ...(deps.budget.deadlineAt !== undefined
              ? { deadlineAt: deps.budget.deadlineAt }
              : {}),
            cycle: stats.cycles,
          },
          observation: obs.value,
          grants: {
            tools: exe.contract.toolSet,
            plugins: exe.contract.plugins ?? [],
            visible: exe.contract.inputSet,
          },
        };

        // ④ 驱动一次组件步进
        const out = await exe.step(input);
        if (!out.ok) return out;

        // ⑤ 待决事项：**不得丢弃**
        const handled = await handleDecisions(
          out.value.needsDecision,
          controller,
          deps,
          ctx,
        );
        if (!handled.ok) return handled;
        stats.handledDecisions += handled.value;

        // ⑥ 组装变更：必须过校验；拒绝则**不提交**并留痕
        if (out.value.requestsAssemblyChange) {
          const candidate = await deps.assembler.propose(
            assembly,
            out.value.requestsAssemblyChange,
          );
          if (!candidate.ok) return candidate;
          const verdict = deps.validator.validate(
            candidate.value,
            deps.registry.snapshot(),
          );
          if (!verdict.ok) {
            stats.assemblyRejections += 1;
            emit({
              type: "assembly_rejected",
              by: exe.id,
              violations: verdict.violations,
            });
          } else {
            const committed = await deps.assembler.commit(
              candidate.value,
              verdict,
              exe.id,
            );
            if (!committed.ok) return committed;
            assembly = candidate.value;
            stats.assemblyChanges += 1;
            emit({
              type: "assembly_committed",
              by: exe.id,
              assemblyId: assembly.id,
            });
          }
        }

        // ⑦ 事件与计量
        deps.meter?.(out.value.usage);
        for (const e of out.value.events) emit(e);
        emit({ type: "outer_cycle", cycle: stats.cycles, componentId: exe.id });
        stats.cycles += 1;
      }
    },
  });
}

/** 账本 → 判定上下文（**下级**进 outstanding；兄弟不进） */
function lifecycleCtx(
  componentId: string,
  deps: OuterLoopDeps,
  t: number,
): LifecycleCtx {
  return {
    componentId,
    outstanding: deps.children.outstanding(),
    produced: [],
    dependencySatisfied: true,
    budgetRemaining: deps.budget.remaining,
    ...(deps.budget.deadlineAt !== undefined
      ? { deadlineAt: deps.budget.deadlineAt }
      : {}),
    now: t,
  };
}

/**
 * 处理待决事项。
 *
 * - 机械事件（child.spawned / child.settled）→ **账本**（校验负载，缺关键字段即报错）
 * - 其余需判断事件 → **控制器**
 * - **未知事件 ⇒ 报错**（绝不静默丢弃）
 */
async function handleDecisions(
  items: readonly NeedsDecision[],
  controller: LifecycleController,
  deps: OuterLoopDeps,
  ctx: LifecycleCtx,
): Promise<Result<number>> {
  let handled = 0;
  for (const item of items) {
    if (!ALL_EVENTS.includes(item.event)) {
      return err("待决事项含未知事件（引用式闭集之外）: " + String(item.event));
    }
    if (MECHANICAL_EVENTS.has(item.event)) {
      if (item.event === "child.spawned") {
        const childId = item.payload?.childId;
        if (typeof childId !== "string" || childId.length === 0) {
          return err("child.spawned 缺少 payload.childId（无法登记账本）");
        }
        const deadlineAt = item.payload?.deadlineAt;
        const reg = deps.children.register({
          childId,
          joinedAt: ctx.now,
          ...(typeof deadlineAt === "number" ? { deadlineAt } : {}),
        });
        if (!reg.ok) return reg;
      } else {
        const childId = item.payload?.childId;
        if (typeof childId !== "string" || childId.length === 0) {
          return err("child.settled 缺少 payload.childId");
        }
        const outcome = (item.payload?.outcome ?? "success") as ChildOutcome;
        const st = deps.children.settle(childId, outcome, ctx.now);
        if (!st.ok) return st;
      }
      handled += 1;
      continue;
    }
    // 需判断事件 → 控制器（含合法集、决策缓存、违规留痕）
    const d = await controller.onEvent(item.event, {
      ...ctx,
      outstanding: deps.children.outstanding(),
    });
    if (!d.ok) return d;
    if (d.value.next === "terminate") {
      // 组件终止：把自己从域成员里标记完成（域的完成仍由 DomainLedger 判定）
      deps.domain.setSelfState("done");
    }
    handled += 1;
  }
  return ok(handled);
}
