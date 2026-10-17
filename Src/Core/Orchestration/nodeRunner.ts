/**
 * @module Core/Orchestration/nodeRunner
 * @description
 * P3 · **`NodeRunner`（节点运行器）**：运行**一个节点体**（= 任意执行件），只做四件事，**不做状态决策**：
 *   ① 派生 `loopId`（外层 `L` → 节点 `L/N1`，**唯一派生点**）
 *   ② 注入 grants（**只能收紧**，不得放宽）
 *   ③ 调 `body.step(input)` 收集结果
 *   ④ 上报事件与计量（**带节点自身 scope**）
 *
 * 设计出处：Docs/Dev/L1编排设计/23-原语补齐与监管快照.md §P3 ·
 *   15-ReActLoop原语.md R3/R4/R5/R6 · 24-归属复核-第二批.md 问题 2（双派生点处置）
 *
 * 五条反例的落地位置：
 *   #1 内联专用逻辑（非执行件） ⇒ `runNode` 入口校验 body 形状
 *   #2 节点派生**第二个** loopId ⇒ 运行前比对节点体自带的 `scope`
 *   #3 grants 被放宽 ⇒ `narrowGrants` 结构上取交集 + 可见面真实裁剪观察
 *   #4 节点自己决定状态 ⇒ 本件只转发 `state`/`control` 与 `needsDecision`，不迁入任何状态
 *   #5 节点结束不解绑 ⇒ `attach` 返回的解绑函数在 `finally` 里必然执行
 */

import type { Result } from "../../Infra/types.js";
import { ok, err } from "../../Infra/types.js";
import { assertScopeShape, type LoopScope } from "../Loop/reactLoop.js";
import type {
  ContextSelector,
  Observation,
} from "../Context/contextAssembler.js";
import type { LifecycleState } from "../Lifecycle/lifecycleTypes.js";

import type {
  Executable,
  ExecutableContract,
  ReactInput,
  ReactOutput,
} from "./outerLoop.js";

/** 授予集（与 `ReactInput.grants` 同源，避免两处定义漂移） */
export type Grants = ReactInput["grants"];

/** 节点定义（结构上等价于 `WorkflowNodeSpec` 的运行所需部分） */
export interface NodeDefinition {
  readonly id: string;
  readonly body: Executable;
}

/** 节点运行结果：执行件的输出 + 本次运行**实际**生效的 scope 与 grants */
export interface NodeOutcome extends ReactOutput {
  readonly scope: LoopScope;
  readonly grants: Grants;
}

export interface NodeRunnerDeps {
  /** 节点的 `state` 由 **C1** 提供；未提供则**原样转发**父输入（本件不自决状态） */
  stateOf?: (nodeId: string, parent: ReactInput) => LifecycleState;
  /** 节点的控制面切片；未提供则原样转发父输入 */
  controlOf?: (nodeId: string, parent: ReactInput) => ReactInput["control"];
  /** 上下文装配（C4）：按收紧后的可见面装配；未提供则以父观察**裁剪**得到 */
  assemble?: (
    visible: ContextSelector,
    scope: LoopScope,
  ) => Observation | Promise<Observation>;
  /** 事件出口（一律带**节点自身** scope —— R4） */
  emit?: (event: {
    loopId: string;
    scope: LoopScope;
    payload: unknown;
  }) => void;
  /** 计量出口（只报本节点用量，外层不再重复计 —— R5） */
  meter?: (
    loopId: string,
    usage: { tokens: number; iterations: number },
  ) => void;
  /** 为本次节点运行挂上订阅/定时器，返回**解绑**函数（反例 5） */
  attach?: (scope: LoopScope) => (() => void) | undefined;
}

export interface NodeRunner {
  runNode(
    node: NodeDefinition,
    parentScope: LoopScope,
    input: ReactInput,
  ): Promise<Result<NodeOutcome>>;
}

/**
 * **唯一派生点**（R3：`ReActLoop` 只接收 `LoopScope`，不派生）。
 *
 * 节点 id 必须能安全地拼进 `loopId`：含 `/` 会让 `L/a/b` 无法判断切分点，
 * 嵌套归属过滤（P0-2 防跨 Loop 污染）随即失效。
 */
export function deriveScope(
  parent: LoopScope,
  nodeId: string,
): Result<LoopScope> {
  const shape = assertScopeShape(parent);
  if (!shape.ok) return shape;
  if (nodeId.trim().length === 0) return err("节点 id 不能为空");
  if (nodeId.includes("/"))
    return err("节点 id 不得包含 /（会破坏 loopId 的派生前缀）: " + nodeId);
  if (/[\s]/.test(nodeId)) return err("节点 id 不得包含空白字符: " + nodeId);

  const derived: LoopScope = {
    loopId: parent.loopId + "/" + nodeId,
    parentLoopId: parent.loopId,
    agentId: parent.agentId,
    traceId: parent.traceId,
  };
  // 派生结果仍须自洽（防止父 scope 本身是畸形前缀的漏网）
  const check = assertScopeShape(derived);
  if (!check.ok) return check;
  return ok(derived);
}

/** 集合收紧：取交集，**结构上不可能超出父集** */
function tighten(
  declared: readonly string[],
  granted: readonly string[],
): string[] {
  const allowed = new Set(granted);
  return [...new Set(declared)].filter((n) => allowed.has(n));
}

/**
 * 可见面收紧（反例 3）：分区取交集，历史轮数取**较小值**（`"all"` 视为最大）。
 * 声明里没写的分区，节点就**看不见**。
 */
function tightenVisible(
  declared: ContextSelector,
  granted: ContextSelector,
): ContextSelector {
  const turns = (h: ContextSelector["history"]): number =>
    h === "all" ? Number.MAX_SAFE_INTEGER : h.recentTurns;
  const min = Math.min(turns(declared.history), turns(granted.history));
  return {
    sections: [...new Set(declared.sections)].filter((s) =>
      granted.sections.includes(s),
    ),
    history:
      declared.history === "all" && granted.history === "all"
        ? "all"
        : { recentTurns: min === Number.MAX_SAFE_INTEGER ? 0 : min },
    ...(granted.shared ? { shared: granted.shared } : {}),
  };
}

/**
 * grants 只能收紧（反例 3）：工具/插件/可见面都以**节点声明 ∩ 父授予**为准。
 *
 * 未声明 `plugins` 视为"不额外要求"⇒ 沿用父集（未变宽，故允许）。
 */
export function narrowGrants(
  parent: Grants,
  declared: ExecutableContract,
): Grants {
  return {
    tools: tighten(declared.toolSet, parent.tools),
    plugins:
      declared.plugins === undefined
        ? [...parent.plugins]
        : tighten(declared.plugins, parent.plugins),
    visible: tightenVisible(declared.inputSet, parent.visible),
  };
}

/** 观察按收紧后的可见面**真实裁剪**（不只是把口径写进 grants 里） */
function restrictObservation(
  obs: Observation,
  visible: ContextSelector,
): Observation {
  const history =
    visible.history === "all"
      ? obs.history
      : obs.history.slice(
          Math.max(
            0,
            obs.history.length - Math.max(0, visible.history.recentTurns),
          ),
        );
  return {
    ...obs,
    contextSections: obs.contextSections.filter((s) =>
      visible.sections.includes(s.key),
    ),
    history,
  };
}

export function createNodeRunner(deps: NodeRunnerDeps = {}): NodeRunner {
  return {
    async runNode(
      node: NodeDefinition,
      parentScope: LoopScope,
      input: ReactInput,
    ): Promise<Result<NodeOutcome>> {
      // 反例 1：节点体必须是执行件（内联专用逻辑破坏递归性）
      if (!node || typeof node.id !== "string" || node.id.trim().length === 0) {
        return err("节点定义缺少 id");
      }
      const body = node.body as
        (Executable & { scope?: LoopScope }) | undefined;
      if (!body || typeof body.step !== "function" || !body.contract) {
        return err(
          "节点 " +
            node.id +
            " 的 body 不是执行件（缺少 step/contract —— 不得内联专用逻辑）",
        );
      }

      const scope = deriveScope(parentScope, node.id);
      if (!scope.ok) return scope;

      // 反例 2：派生权只在本件。节点体若自带 loopId 且与派生结果不同源 ⇒ 存在第二个派生点。
      if (body.scope && body.scope.loopId !== scope.value.loopId) {
        return err(
          "节点体自带 loopId（" +
            body.scope.loopId +
            "）与唯一派生点不一致（" +
            scope.value.loopId +
            "）—— 拒绝第二个派生者",
        );
      }

      const grants = narrowGrants(input.grants, body.contract);

      const base = deps.assemble
        ? await deps.assemble(grants.visible, scope.value)
        : input.observation;
      const observation = restrictObservation(base, grants.visible);

      const nodeInput: ReactInput = {
        // 反例 4：状态与控制**由外部（C1）给出或原样转发**，本件不迁状态、节点体也无从自迁
        state: deps.stateOf ? deps.stateOf(node.id, input) : input.state,
        control: deps.controlOf
          ? deps.controlOf(node.id, input)
          : input.control,
        observation,
        grants,
      };

      const unbind = deps.attach?.(scope.value);
      try {
        const out = await body.step(nodeInput);

        // R4：事件一律带**节点自身** scope
        deps.emit?.({
          loopId: scope.value.loopId,
          scope: scope.value,
          payload: { type: "node", node: node.id, ok: out.ok },
        });
        // 失败路径没有可信的 usage 数据，不臆造计数（漏报优于错报）
        if (out.ok) {
          deps.meter?.(scope.value.loopId, {
            tokens: out.value.usage.tokens,
            iterations: out.value.usage.iterations,
          });
          return ok({ ...out.value, scope: scope.value, grants });
        }
        return out;
      } finally {
        // 反例 5：无论成败/抛错，本次运行的订阅与定时器都必须解绑
        unbind?.();
      }
    },
  };
}
