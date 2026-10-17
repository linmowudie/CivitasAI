/**
 * @module Core/Assembly/executableRegistry
 * @description
 * 执行件**目录**：名字 → 规格（含所需依赖）。属"**目录类**"——运行中**只读**。
 *
 * 设计出处：Docs/Dev/L1编排设计/21-组装闭环.md §3（`ExecutableRegistry`）·
 *   15-ReActLoop原语.md §7（判据：全局"目录"可共享，运行态一律实例私有）
 *
 * 为什么冻结：组装体提交时记录了 `registryVersion`；若目录运行中还能改，
 * 已提交组装体的引用就可能悄悄失效（见 24 §3 问题 1「版本漂移」）。
 */

import type { Result } from "../../Infra/types.js";
import { ok, err } from "../../Infra/types.js";

export interface ExecutableSpec {
  readonly id: string;
  /** 该执行件声明的输入分区 */
  readonly inputSections: readonly string[];
  /** 该执行件声明的工具集 */
  readonly toolSet: readonly string[];
  /** 角色可见性（可选） */
  readonly roles?: readonly string[];
}

export interface ExecutableRegistrySnapshot {
  readonly version: string;
  readonly specs: readonly ExecutableSpec[];
}

export interface ExecutableRegistry {
  resolve(ref: string): ExecutableSpec | null;
  list(): readonly ExecutableSpec[];
  listForRole(role: string): readonly ExecutableSpec[];
  snapshot(): ExecutableRegistrySnapshot;
  /** 运行中修改目录 ⇒ **拒绝** */
  add(spec: ExecutableSpec): Result<void>;
}

export const REGISTRY_VERSION = "reg-1";

/** 已冻结的目录（**单一真源**：`add` 与 `markFrozen` 读同一份） */
const FROZEN = new WeakSet<ExecutableRegistry>();

export function createExecutableRegistry(
  specs: readonly ExecutableSpec[],
): Result<ExecutableRegistry> {
  const byId = new Map<string, ExecutableSpec>();
  for (const s of specs) {
    if (byId.has(s.id)) return err("目录中存在重复执行件 id: " + s.id);
    byId.set(s.id, s);
  }

  const registry: ExecutableRegistry = {
    resolve: (ref) => byId.get(ref) ?? null,
    list: () => [...byId.values()],
    listForRole: (role) =>
      [...byId.values()].filter((s) => !s.roles || s.roles.includes(role)),
    snapshot: () => ({ version: REGISTRY_VERSION, specs: [...byId.values()] }),
    add(spec) {
      // ★ 目录在冻结后只读
      if (FROZEN.has(registry)) {
        return err("执行件目录为只读（目录类），运行中不得修改：" + spec.id);
      }
      if (byId.has(spec.id)) return err("重复执行件 id: " + spec.id);
      byId.set(spec.id, spec);
      return ok(undefined);
    },
  };
  return ok(registry);
}

/** 冻结目录（组装体提交前调用；之后任何 `add` 都被拒） */
export function markFrozen(registry: ExecutableRegistry): ExecutableRegistry {
  FROZEN.add(registry);
  return registry;
}

export function isFrozen(registry: ExecutableRegistry): boolean {
  return FROZEN.has(registry);
}
