/**
 * @module Orchestration/orchestrationRuntime
 * @description **编排内核生产组合根（P1）**：把 `Core/Assembly` 的目录/校验/组装闭环接成真实运行时，
 * 并对外提供 `OrchestrationPort`，让 `OrchestratorCompose` / `OrchestratorSelect` 从
 * `NOT_ENABLED` 变为真实可用（[29-融合方案](../Docs/Dev/L1编排设计/29-融合方案-内核优先.md) §3 P1）。
 *
 * 真实依赖（全部不是替身）：
 * - 执行件目录：六个固定模式（`ROUTING_MODES`）作为可组装执行件（S1）；
 * - 校验器：`createAssemblyValidator`（框架判据 + 扩展判据入口）；
 * - 提交器：`createAssembler` + **落盘/撤销/审计** 三端口：
 *   - 落盘 = 原子写 `Data/Orchestration/assemblies.json`（可恢复）；
 *   - 审计 = 治理台账 `recordGovernanceAction`（哈希链 + 落库）；
 * - 端口适配：`createAssemblyPorts` → `createOrchestrationToolPort`。
 *
 * 边界（如实）：P1 只接"组装子系统"（结构变更可审计、可恢复）；外层循环执行
 * （`OuterLoop` → `runL1Dialogue`）是 P2，本模块先把 C5 组装体持有者与工具端口备好。
 */

import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { ROUTING_MODES } from "../Decision/types.js";
import {
  createExecutableRegistry,
  markFrozen,
  type ExecutableRegistry,
  type ExecutableSpec,
} from "../Assembly/executableRegistry.js";
import {
  createAssembler,
  createAssemblyValidator,
  CRITERIA_VERSION,
  type AssemblyChange,
  type AssemblySpec,
  type Assembler,
} from "../Assembly/assemblyPipeline.js";
import { createAssemblyPorts, initialAssemblySpec } from "./assemblyPorts.js";
import { createOrchestrationToolPort } from "./orchestrationToolPort.js";
import type { OrchestrationPort } from "../../Tools/Registry/toolServicePorts.js";
import { recordGovernanceAction } from "../../Services/Governance/governanceAudit.js";
import { getWorkspaceRoot } from "../../Infra/Fs/pathResolver.js";
import { ok, err } from "../../Infra/types.js";
import type { Result } from "../../Infra/types.js";
import { logger } from "../../Infra/Logging/logger.js";

/** 执行件声明的静态分区（与十步循环的静态区口径一致） */
const STATIC_SECTION = "ctx:zone:static";

/** 执行件目录：六个固定模式（A 侧）作为可组装执行件 */
function buildExecutableSpecs(): ExecutableSpec[] {
  return ROUTING_MODES.map((mode) => ({
    id: mode,
    inputSections: [STATIC_SECTION],
    toolSet: [],
  }));
}

/** 落盘状态（P1 文件后端；P3 切到 Core/Durable checkpointRouter） */
interface PersistedState {
  currentId: string;
  assemblies: Record<string, AssemblySpec>;
}

interface RuntimeState {
  registry: ExecutableRegistry;
  validator: ReturnType<typeof createAssemblyValidator>;
  assembler: Assembler;
  port: OrchestrationPort;
  current: AssemblySpec;
  persistPath: string;
  /** S7 适配层端口：外层循环（OuterLoop）直接消费这一组端口 */
  ports: ReturnType<typeof createAssemblyPorts>;
}

let state: RuntimeState | null = null;

function resolvePersistPath(dataDir?: string): string {
  const root = dataDir ?? join(getWorkspaceRoot(), "Orchestration");
  return join(root, "assemblies.json");
}

function loadPersisted(path: string): PersistedState | null {
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as PersistedState;
    if (!parsed || typeof parsed.currentId !== "string" || !parsed.assemblies)
      return null;
    return parsed;
  } catch {
    return null;
  }
}

function savePersisted(path: string, next: PersistedState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(next, null, 2), "utf8");
  renameSync(tmp, path); // 原子替换，避免半写文件
}

/**
 * 初始化编排运行时（幂等；重复调用返回已初始化状态）。
 */
export function initOrchestrationRuntime(
  options: { dataDir?: string } = {},
): Result<void> {
  if (state) return ok(undefined);

  const persistPath = resolvePersistPath(options.dataDir);

  // ① 执行件目录（冻结：运行期不可注册新执行件）
  const registryResult = createExecutableRegistry(buildExecutableSpecs());
  if (!registryResult.ok)
    return err(`执行件目录创建失败：${registryResult.error}`);
  const registry = registryResult.value;
  markFrozen(registry);

  // ② 校验器（真实判据；扩展判据入口留给后续）
  const validator = createAssemblyValidator(registry);

  // ③ 提交器 + 真实落盘/撤销/审计端口
  const assemblies = new Map<string, AssemblySpec>();
  const persisted = loadPersisted(persistPath);
  if (persisted) {
    for (const [id, spec] of Object.entries(persisted.assemblies))
      assemblies.set(id, spec);
  }

  const assembler = createAssembler(registry, validator, {
    async persist(spec) {
      const prev = assemblies.get(spec.id);
      assemblies.set(spec.id, spec);
      try {
        savePersisted(persistPath, {
          currentId: state?.current?.id ?? persisted?.currentId ?? spec.id,
          assemblies: Object.fromEntries(assemblies),
        });
        return ok(undefined);
      } catch (e) {
        // 落盘失败必须传播，并回滚内存，避免"内存改了磁盘没有"
        if (prev) assemblies.set(spec.id, prev);
        else assemblies.delete(spec.id);
        return err(
          `组装体落盘失败：${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
    async retract(assemblyId) {
      const prev = assemblies.get(assemblyId);
      if (prev) assemblies.delete(assemblyId);
      try {
        savePersisted(persistPath, {
          currentId: state?.current?.id ?? assemblyId,
          assemblies: Object.fromEntries(assemblies),
        });
        return ok(undefined);
      } catch (e) {
        if (prev) assemblies.set(assemblyId, prev);
        return err(
          `组装体撤销落盘失败：${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
    async audit(record) {
      try {
        recordGovernanceAction({
          action: "orchestration.assembly_commit",
          actorRole: "prime_director",
          actorId: record.by,
          reason:
            `assembly=${record.assemblyId} digest=${record.digest}` +
            (record.violations.length > 0
              ? ` violations=${record.violations.map((v) => v.criterion).join(",")}`
              : ""),
          targetIds: [record.assemblyId],
          outcome: "allowed",
        });
        return ok(undefined);
      } catch (e) {
        return err(
          `组装审计失败：${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
  });

  // ④ 组装体持有者（C5）：优先恢复上次落盘的当前组装体，否则用 DIRECT 初始组装体
  const initial = initialAssemblySpec({
    id: "A-DIRECT",
    nodes: ["DIRECT"],
    entrypoints: ["DIRECT"],
    registry,
  });
  if (!initial.ok) return err(`初始组装体创建失败：${initial.error}`);

  const restoredCandidate = persisted
    ? persisted.assemblies[persisted.currentId]
    : undefined;
  const restored = restoredCandidate ?? initial.value;

  // 工具端口用的是"变更只带 { id }"的口径：节点结构必须由目录补全后再交给提交器。
  // 直接传 raw assembler 会得到 executableRef=undefined 的节点 ⇒ C-LINK-1 悬空引用（实测）。
  const fillNode = <
    T extends {
      id: string;
      executableRef?: string;
      inputSections?: readonly string[];
    },
  >(
    node: T,
  ): T => {
    if (node.executableRef) return node;
    const spec = registry.resolve(node.id);
    if (!spec) return node;
    return {
      ...node,
      executableRef: spec.id,
      inputSections: [...spec.inputSections],
    };
  };
  const catalogAwareAssembler: Assembler = {
    ...assembler,
    async propose(current, change) {
      // 结构变更一定带 added（add/replace）；remove 原样透传
      if (!change.added) return assembler.propose(current, change);
      const filled: AssemblyChange = {
        ...change,
        added: fillNode(change.added),
      };
      return assembler.propose(current, filled);
    },
  };

  const ports = createAssemblyPorts({
    registry,
    validator,
    assembler: catalogAwareAssembler,
  });

  // ⑤ 工具端口：current/adopt 由本运行时持有（C5 唯一采用动作）
  let current = restored;
  const port = createOrchestrationToolPort({
    registry,
    validator,
    assembler: catalogAwareAssembler,
    current: () => current,
    adopt: (spec) => {
      const verdict = validator.validate(spec, registry.snapshot());
      if (!verdict.ok)
        return err(`组装体校验未通过：${verdict.violations.join("；")}`);
      current = spec;
      try {
        savePersisted(persistPath, {
          currentId: spec.id,
          assemblies: Object.fromEntries(assemblies),
        });
        return ok(undefined);
      } catch (e) {
        return err(
          `组装体采用落盘失败：${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
  });

  state = { registry, validator, assembler, port, current, persistPath, ports };
  logger.info("编排运行时已初始化（组装子系统）", {
    source: "Orchestration/orchestrationRuntime",
    catalog: buildExecutableSpecs().map((s) => s.id),
    currentAssembly: current.id,
    criteriaVersion: CRITERIA_VERSION,
    persistPath,
    ports: Object.keys(ports).length,
  });
  return ok(undefined);
}

/** 取编排工具端口（未初始化 ⇒ undefined，工具如实 NOT_ENABLED）。 */
export function getOrchestrationPort(): OrchestrationPort | undefined {
  return state?.port;
}

/** 取 S7 适配层端口（外层循环用；未初始化 ⇒ undefined） */
export function getAssemblyPorts():
  ReturnType<typeof createAssemblyPorts> | undefined {
  return state?.ports;
}

/** 当前组装体（诊断/观测用） */
export function currentAssemblySpec(): AssemblySpec | null {
  return state?.current ?? null;
}

/** 重置（测试隔离用；不影响已落盘文件） */
export function resetOrchestrationRuntime(): void {
  state = null;
}
