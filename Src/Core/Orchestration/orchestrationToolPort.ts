/**
 * @module Core/Orchestration/orchestrationToolPort
 * @description
 * **C6 的工具身份**：把组装闭环（S1 目录 / C7 校验器 / C6 装配器）接到 Tools 层的
 * `OrchestrationPort` 上，供 `OrchestratorCompose` / `OrchestratorSelect` 调用。
 *
 * 设计出处：Docs/Dev/L1编排设计/21-组装闭环.md §0/§2/§3（提议→校验→提交，中间必须夹 validate）·
 *   02-组装器与算子闭集.md §1 · 19-OuterLoop.md（外层工具集仅编排类）
 *
 * 三条纪律（每条都有负向测试）：
 *  1. **组装体归 C5 持有**：本适配层不另存一份组装体，只经 `current()` 读、经 `adopt()` 交回。
 *     （若在此缓存一份，就成了第二个写者 —— 落盘与运行态必然分叉。）
 *  2. **不跳过校验**：`compose` 内部固定走 propose → validate → commit，
 *     而 commit 还会**再校验一次**（防绕过 + 防 TOCTOU，见 21 §3）。
 *  3. **判定不复制**：算子名、`join.onMissing` 等一律**原样带入**候选，由判据
 *     （`C-OP-1` / `C-JOIN-1`）裁决。这里若抄一份闭集，闭集漂移时就无人发现。
 *
 * 分层：Tools 不得 import Core（门禁红线），故由组合根把本实现注入
 * `configureToolServicePorts({ orchestration })`；Core → Tools 的 import 是合法的
 * （同 `Core/Ledger/ledgers.ts` 的先例）。
 */

import type { Result } from "../../Infra/types.js";
import { ok, err } from "../../Infra/types.js";
import type {
  Assembler,
  AssemblyChange,
  AssemblyNode,
  AssemblySpec,
  AssemblyValidator,
} from "../Assembly/assemblyPipeline.js";
import type { ExecutableRegistry } from "../Assembly/executableRegistry.js";
import type {
  AssemblyChangePort,
  AssemblyNodeDeclPort,
  ComposeOutcomePort,
  ExecutableCatalogEntryPort,
  OrchestrationPort,
} from "../../Tools/Registry/toolServicePorts.js";

export interface OrchestrationToolPortDeps {
  registry: ExecutableRegistry;
  validator: AssemblyValidator;
  assembler: Assembler;
  /** 组装体持有者（C5）的**读**句柄 */
  current(): AssemblySpec;
  /** 组装体持有者（C5）的**唯一采用**动作；失败必须如实上报 */
  adopt(spec: AssemblySpec): Result<void>;
}

/** 工具端口对外形状（比 Tools 侧接口多一个 `takeNomination`，供持有者取一次性提名） */
export interface OrchestrationToolPort extends OrchestrationPort {
  /** 取走并清空提名（一次性；未提名 ⇒ null） */
  takeNomination(): string | null;
  /** 被拒的选件提名次数（监管可查） */
  rejectedNominations(): number;
}

/**
 * 端口节点声明 → 组装节点。
 *
 * `operator` / `join.onMissing` 在端口侧是**裸字符串**：这里只做类型上的宽松传递，
 * 不做闭集过滤 —— 过滤等于把判据搬到适配层，`C-OP-1`/`C-JOIN-1` 就再也拦不到东西。
 */
function toAssemblyNode(decl: AssemblyNodeDeclPort): AssemblyNode {
  const joinDecl = decl.join;
  return {
    id: decl.id,
    executableRef: decl.executableRef,
    ...(decl.operator === undefined
      ? {}
      : { operator: decl.operator as AssemblyNode["operator"] }),
    ...(decl.body === undefined ? {} : { body: [...decl.body] }),
    ...(decl.inputSections === undefined
      ? {}
      : { inputSections: [...decl.inputSections] }),
    ...(joinDecl === undefined
      ? {}
      : {
          join: {
            deps: [...joinDecl.deps],
            onMissing: joinDecl.onMissing as NonNullable<
              AssemblyNode["join"]
            >["onMissing"],
          },
        }),
    ...(decl.plugins === undefined
      ? {}
      : {
          plugins: decl.plugins.map((p) => ({
            id: p.id,
            hooks: [...(p.hooks ?? [])],
            conflictDomain: p.conflictDomain,
            ...(p.enabled === undefined ? {} : { enabled: p.enabled }),
          })),
        }),
  };
}

function toSpecChange(change: AssemblyChangePort): Result<AssemblyChange> {
  if (change.op === "remove") {
    if (!change.target) return err("remove 变更缺少 target 节点 id");
    return ok({ op: "remove", target: change.target });
  }
  if (!change.added) return err(`${change.op} 变更缺少 added 节点声明`);
  const added = toAssemblyNode(change.added);
  if (change.op === "add") return ok({ op: "add", added });
  if (!change.target) return err("replace 变更缺少 target 节点 id");
  return ok({ op: "replace", target: change.target, added });
}

export function createOrchestrationToolPort(
  deps: OrchestrationToolPortDeps,
): OrchestrationToolPort {
  /** 一次性提名（工具只能提名，生效由持有者取走） */
  let nomination: string | null = null;
  let rejected = 0;

  const catalogEntry = (
    id: string,
    inputSections: readonly string[],
    toolSet: readonly string[],
  ): ExecutableCatalogEntryPort => ({
    id,
    inputSections: [...inputSections],
    toolSet: [...toolSet],
  });

  return {
    currentAssembly(): { id: string; executables: string[] } {
      const spec = deps.current();
      return { id: spec.id, executables: [...spec.executables] };
    },

    catalog(): ExecutableCatalogEntryPort[] {
      return deps.registry
        .list()
        .map((s) => catalogEntry(s.id, s.inputSections, s.toolSet));
    },

    async compose(input): Promise<Result<ComposeOutcomePort>> {
      const change = toSpecChange(input.change);
      if (!change.ok) return change;

      const proposed = await deps.assembler.propose(
        deps.current(),
        change.value,
      );
      if (!proposed.ok) return proposed;

      const candidate = proposed.value;
      // ★ 纪律 2：校验是闭环的必经环节，本端口不提供"跳过校验"的路径
      const verdict = deps.validator.validate(
        candidate,
        deps.registry.snapshot(),
      );
      if (!verdict.ok) {
        // ★ 拒绝必须带"判据 + 定位"，否则外层无从重选（21 §5 反例 10）
        return ok({
          committed: false,
          assemblyId: candidate.id,
          violations: verdict.violations.map((v) => ({
            criterion: v.criterion,
            where: v.where,
            reason: v.reason,
          })),
          reason:
            "未通过检查树（" +
            verdict.violations.length +
            " 条违规），组装体未改动",
        });
      }

      const digest = deps.assembler.digestOf(candidate);
      const committed = await deps.assembler.commit({
        candidate,
        validatedDigest: digest,
        by: input.by,
      });
      if (!committed.ok) {
        return ok({
          committed: false,
          assemblyId: candidate.id,
          violations: [],
          reason: committed.error,
        });
      }

      // 已落盘 + 已审计；采用失败 ⇒ 分叉，必须报错而不是静默
      const adopted = deps.adopt(candidate);
      if (!adopted.ok) {
        return err(
          "组装体已落盘并通过审计，但持有者未能采用（" +
            adopted.error +
            "）：" +
            "存储与运行态已分叉，需人工介入修复后再变更",
        );
      }

      return ok({
        committed: true,
        assemblyId: candidate.id,
        digest,
        violations: [],
      });
    },

    select(candidate: string): Result<{ selected: string; reason: string }> {
      const spec = deps.current();
      if (spec.executables.includes(candidate)) {
        nomination = candidate;
        return ok({
          selected: candidate,
          reason: "提名已登记（一次性）：该节点在当前组装体 " + spec.id + " 内",
        });
      }
      rejected += 1;
      // 区分两种"不在组装体内"：能重选还是必须先变更结构
      if (deps.registry.resolve(candidate)) {
        return err(
          "执行件 " +
            candidate +
            " 已在目录但**不在当前组装体**：" +
            "需先用 OrchestratorCompose 把它加入组装体",
        );
      }
      return err("执行件 " + candidate + " 未在目录注册（悬空引用）：无法选件");
    },

    takeNomination(): string | null {
      const taken = nomination;
      nomination = null;
      return taken;
    },

    rejectedNominations(): number {
      return rejected;
    },
  };
}
