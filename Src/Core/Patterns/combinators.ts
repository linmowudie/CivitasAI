/**
 * @module Core/Patterns/combinators
 * @description
 * 组装算子（**闭集条目**）的组合器实现：`Seq` · `Par` · `Branch` · `Fallback`。
 *
 * 设计出处：Docs/Dev/L1编排设计/02-组装器与算子闭集.md（算子闭集 9 个）·
 *   22-执行件-三种模式.md（模式 = 组合）· 06-父子等待与join.md（join 语义）
 *
 * **每个组合器都是真实执行件**（满足 S7 `OuterLoop` 的 `Executable` 接口），
 * 因此可以直接被组装器放进组装体的节点里。
 */

import type { Result } from "../../Infra/types.js";
import { ok, err } from "../../Infra/types.js";

import type {
  Executable,
  NeedsDecision,
  ReactInput,
  ReactOutput,
} from "../Orchestration/outerLoop.js";

/** 组合器公共：把子件的用量与事件合并上报 */
function mergeOutputs(parts: readonly ReactOutput[]): ReactOutput {
  const produced: Record<string, unknown> = {};
  const events: unknown[] = [];
  let tokens = 0;
  let iterations = 0;
  const needsDecision: NeedsDecision[] = [];
  parts.forEach((p, i) => {
    produced["part" + i] = p.produced;
    events.push(...p.events);
    needsDecision.push(...p.needsDecision);
    tokens += p.usage.tokens;
    iterations += p.usage.iterations;
  });
  return { produced, events, needsDecision, usage: { tokens, iterations } };
}

function contractOf(parts: readonly Executable[]) {
  return {
    inputSet: parts[0]?.contract.inputSet ?? {
      sections: [],
      history: { recentTurns: 1 } as const,
    },
    outputSet: [...new Set(parts.flatMap((p) => [...p.contract.outputSet]))],
    toolSet: [...new Set(parts.flatMap((p) => [...p.contract.toolSet]))],
  };
}

/** `Seq`：顺序执行；前一个失败即中止（并原样返回失败） */
export function seq(
  id: string,
  parts: readonly Executable[],
): Result<Executable> {
  if (parts.length === 0) return err("Seq 至少需要一个子件");
  return ok({
    id: "seq(" + id + ")",
    contract: contractOf(parts),
    async step(input: ReactInput): Promise<Result<ReactOutput>> {
      const outs: ReactOutput[] = [];
      let upstream = { ...input.observation.upstream };
      for (const p of parts) {
        const stepped = await p.step({
          ...input,
          observation: { ...input.observation, upstream },
        });
        if (!stepped.ok) return stepped;
        outs.push(stepped.value);
        upstream = {
          ...upstream,
          ["part" + (outs.length - 1)]: stepped.value.produced,
        };
      }
      return ok(mergeOutputs(outs));
    },
  });
}

/**
 * `Par`：并行执行。
 *
 * **join 语义必填**（对应 03 §6 #11「召唤了子代却未声明 join」）：
 *   - `all`   ：全部必须成功，任一失败 ⇒ 失败
 *   - `any`   ：首个成功即成功，全部失败 ⇒ 失败
 *   - `settled`：全部结算（成败都收集），永不因单个失败而失败
 */
export type ParJoin = "all" | "any" | "settled";

export function par(
  id: string,
  parts: readonly Executable[],
  join: ParJoin,
): Result<Executable> {
  if (parts.length === 0) return err("Par 至少需要一个子件");
  if (join !== "all" && join !== "any" && join !== "settled") {
    return err("Par 必须声明 join 语义（all/any/settled）");
  }
  return ok({
    id: "par(" + id + "," + join + ")",
    contract: contractOf(parts),
    async step(input: ReactInput): Promise<Result<ReactOutput>> {
      const settled = await Promise.all(parts.map((p) => p.step(input)));
      const oks = settled.filter((r) => r.ok);
      const firstErr = settled.find((r) => !r.ok);

      if (join === "all" && oks.length !== parts.length) {
        return firstErr ?? err("Par(all) 有子件失败");
      }
      if (join === "any" && oks.length === 0) {
        return firstErr ?? err("Par(any) 全部子件失败");
      }
      return ok(mergeOutputs(oks.map((r) => r.value)));
    },
  });
}

/** `Branch`：按判定选择一个分支；**无匹配分支 ⇒ 拒绝**（不得静默走 default） */
export function branch(
  id: string,
  arms: readonly { readonly when: string; readonly executable: Executable }[],
  choose: (
    produced: Record<string, unknown>,
    input: ReactInput,
  ) => string | null,
): Result<Executable> {
  if (arms.length === 0) return err("Branch 至少需要一个分支");
  return ok({
    id: "branch(" + id + ")",
    contract: contractOf(arms.map((a) => a.executable)),
    async step(input: ReactInput): Promise<Result<ReactOutput>> {
      const key = choose({}, input);
      if (key === null)
        return err("Branch 未命中任何分支（拒绝静默走默认分支）");
      const arm = arms.find((a) => a.when === key);
      if (!arm) return err("Branch 选择的键没有对应分支: " + key);
      return arm.executable.step(input);
    },
  });
}

/** `Fallback`：依次尝试，首个成功即返回；全部失败 ⇒ 返回最后一个失败 */
export function fallback(
  id: string,
  parts: readonly Executable[],
): Result<Executable> {
  if (parts.length === 0) return err("Fallback 至少需要一个子件");
  return ok({
    id: "fallback(" + id + ")",
    contract: contractOf(parts),
    async step(input: ReactInput): Promise<Result<ReactOutput>> {
      let last: Result<ReactOutput> = err("Fallback 无子件");
      for (const p of parts) {
        const attempted = await p.step(input);
        if (attempted.ok) return attempted;
        last = attempted;
      }
      return last;
    },
  });
}
