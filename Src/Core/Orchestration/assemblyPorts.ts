/**
 * @module Core/Orchestration/assemblyPorts
 * @description
 * **S7 ↔ S8 端口适配层**：把组装闭环的真实实现（`Core/Assembly`）接到外层循环
 * （`Core/Orchestration/outerLoop`）所声明的**窄端口**上。
 *
 * 设计出处：Docs/Dev/L1编排设计/21-组装闭环.md（`Assembler`/`AssemblyValidator`/`ExecutableRegistry`）·
 *   19-OuterLoop.md（外层只经端口看组装，不持有实现）
 *
 * 为什么需要这一层（而不是"插上去就行"）：两侧的 `Assembly` **粒度不同**。
 *   - S7 侧：`{ id, executables, criteriaVersion, registryVersion }`（外层只需知道"当前用哪份组装"）
 *   - S8 侧：`AssemblySpec`（多 `nodes` / `entrypoints`，校验与摘要都依赖它）
 * `AssemblySpec` 在结构上**是** S7 的 `Assembly`（字段是超集），因此适配层让它在 S7 的端口里
 * **原样流过**；回流时按形状**校验后取回**，缺结构 ⇒ 直接报错，不做"猜测补全"。
 */

import type { Result } from "../../Infra/types.js";
import { ok, err } from "../../Infra/types.js";
import {
  CRITERIA_VERSION,
  type Assembler,
  type AssemblyChange as SpecChange,
  type AssemblyNode,
  type AssemblySpec,
  type AssemblyValidator,
  type Verdict as SpecVerdict,
} from "../Assembly/assemblyPipeline.js";
import {
  REGISTRY_VERSION,
  type ExecutableRegistry,
  type ExecutableRegistrySnapshot,
} from "../Assembly/executableRegistry.js";

import type {
  AssemblerPort,
  Assembly,
  RegistryPort,
  ValidatorPort,
} from "./outerLoop.js";

export interface AssemblyPorts {
  registry: RegistryPort;
  assembler: AssemblerPort;
  validator: ValidatorPort;
}

/**
 * 取回 S8 侧的完整结构（S7 只透传，不裁剪）。
 * 缺 `nodes`/`entrypoints` ⇒ 说明流经外层的对象**不是**本适配层产出的组装体，拒绝而不是补全。
 */
export function asAssemblySpec(a: Assembly): Result<AssemblySpec> {
  const cand = a as unknown as Partial<AssemblySpec>;
  if (!Array.isArray(cand.nodes) || !Array.isArray(cand.entrypoints)) {
    return err(
      "组装体缺少节点结构（nodes/entrypoints）：只能使用本适配层产出的组装体，不得由外层自造",
    );
  }
  if (typeof cand.id !== "string" || cand.id.trim().length === 0)
    return err("组装体缺少 id");
  if (
    typeof cand.criteriaVersion !== "string" ||
    typeof cand.registryVersion !== "string"
  ) {
    return err("组装体缺少版本声明（criteriaVersion/registryVersion）");
  }
  return ok(cand as AssemblySpec);
}

function violationsOf(v: SpecVerdict): readonly string[] {
  return v.violations.map((x) => x.criterion + "@" + x.where + "：" + x.reason);
}

/**
 * 由目录规格造出一个节点（S7 的变更只带 `{ id }`，节点结构必须由**目录**补全 ——
 * 外层拿不到、也不该拿到节点细节）。
 */
function nodeFromRegistry(
  registry: ExecutableRegistry,
  id: string,
): Result<AssemblyNode> {
  const spec = registry.resolve(id);
  if (!spec) return err("执行件未注册，不能加入组装体: " + id);
  return ok({
    id,
    executableRef: spec.id,
    inputSections: [...spec.inputSections],
  });
}

export function createAssemblyPorts(deps: {
  registry: ExecutableRegistry;
  validator: AssemblyValidator;
  assembler: Assembler;
}): AssemblyPorts {
  const { registry, validator, assembler } = deps;

  const registryPort: RegistryPort = {
    resolve: (ref) => {
      const s = registry.resolve(ref);
      return s ? { id: s.id } : null;
    },
    snapshot: () => registry.snapshot(),
  };

  const validatorPort: ValidatorPort = {
    validate: (candidate, registrySnapshot) => {
      const spec = asAssemblySpec(candidate);
      if (!spec.ok) {
        return { ok: false, violations: [spec.error] };
      }
      const v = validator.validate(
        spec.value,
        registrySnapshot as ExecutableRegistrySnapshot,
      );
      return { ok: v.ok, violations: violationsOf(v) };
    },
  };

  const assemblerPort: AssemblerPort = {
    async propose(current, change) {
      const spec = asAssemblySpec(current);
      if (!spec.ok) return spec;

      let toSpec: SpecChange;
      if (change.op === "add") {
        if (!change.added) return err("add 变更缺少 added 节点");
        const node = nodeFromRegistry(registry, change.added.id);
        if (!node.ok) return node;
        toSpec = { op: "add", added: node.value };
      } else if (change.op === "remove") {
        if (!change.target) return err("remove 变更缺少 target");
        toSpec = { op: "remove", target: change.target };
      } else {
        if (!change.target || !change.added)
          return err("replace 变更缺少 target/added");
        const node = nodeFromRegistry(registry, change.added.id);
        if (!node.ok) return node;
        toSpec = { op: "replace", target: change.target, added: node.value };
      }

      const proposed = await assembler.propose(spec.value, toSpec);
      if (!proposed.ok) return proposed;
      return ok(proposed.value);
    },

    async commit(candidate, verdict, by) {
      // 外层只在 verdict.ok 时提交；但"未通过校验不得提交"是本层的独立纪律
      if (!verdict.ok) {
        return err(
          "校验未通过的组装体不得提交: " + verdict.violations.join(" | "),
        );
      }
      const spec = asAssemblySpec(candidate);
      if (!spec.ok) return spec;
      // 摘要取自**刚被校验的同一份候选**；真提交器内部还会再校验一次（防绕过 + 防 TOCTOU）
      return assembler.commit({
        candidate: spec.value,
        validatedDigest: assembler.digestOf(spec.value),
        by,
      });
    },
  };

  return {
    registry: registryPort,
    assembler: assemblerPort,
    validator: validatorPort,
  };
}

/**
 * 初始组装体（版本一律取**框架真源**，不由调用方填写 —— 24 §3 问题 1「版本漂移」的防线）。
 *
 * 每个节点必须已在目录里注册（悬空引用在首次校验即暴露）。
 */
export function initialAssemblySpec(input: {
  id: string;
  nodes: readonly string[];
  entrypoints: readonly string[];
  registry: ExecutableRegistry;
}): Result<AssemblySpec> {
  if (input.nodes.length === 0) return err("初始组装体至少要有一个节点");
  const nodes: AssemblyNode[] = [];
  for (const id of input.nodes) {
    const n = nodeFromRegistry(input.registry, id);
    if (!n.ok) return n;
    nodes.push(n.value);
  }
  for (const e of input.entrypoints) {
    if (!input.nodes.includes(e)) return err("入口节点不在节点集里: " + e);
  }
  return ok({
    id: input.id,
    executables: [...input.nodes],
    nodes,
    entrypoints: [...input.entrypoints],
    criteriaVersion: CRITERIA_VERSION,
    registryVersion: REGISTRY_VERSION,
  });
}
