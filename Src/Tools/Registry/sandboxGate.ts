/**
 * @module Tools/Registry/sandboxGate
 * @description 沙箱承载门（TOOL-SEC-SANDBOX，设计 §3.1）。
 *
 * 设计口径：`sandboxMode` 是**安全边界**，不是装饰字段 ——
 * 声明 `strict|standard` 的工具，执行链必须确认"该等级的沙箱承载可用"才允许执行，
 * 不可用则 **fail-closed** 拒绝（`SANDBOX_UNAVAILABLE`），绝不降级为普通执行。
 *
 * 为什么放在派发器：所有工具调用都经 `dispatchToolCall` 单一收口，
 * 把边界放在这里才能保证"没有调用方能绕过"。
 */

import type { SandboxMode } from "../Traits/toolSpec.js";
import {
  probeSandboxCapability,
  type SandboxCapability,
} from "../../Infra/Sandbox/processSandbox.js";

/** 需要承载的沙箱等级（none 不需要） */
export type RequiredSandboxMode = Exclude<SandboxMode, "none">;

/**
 * 宿主沙箱承载能力声明（由组合根注入）。
 *
 * - `isAvailable(mode)`：该等级的执行承载是否可用；
 * - `run(fn)`（可选）：在沙箱边界内执行（宿主提供时，派发器用它包裹执行体）。
 */
export interface SandboxGatePort {
  isAvailable(mode: RequiredSandboxMode): boolean;
  run?<T>(fn: () => Promise<T>): Promise<T>;
}

/**
 * 默认承载声明：**基于真实能力探测**（`Infra/Sandbox/processSandbox`）。
 *
 * 修复前这里是硬编码 `isAvailable: () => true`（荣誉制）——`sandboxMode` 实际上从未
 * 检查过承载。现在探测工作区可写性、子进程可启动性、平台支持，并据此判定
 * `standard/strict` 是否可用；探测失败即 fail-closed。
 */
export function createDefaultSandboxGate(): SandboxGatePort {
  return createSandboxGateFromCapability(probeSandboxCapability());
}

/**
 * 由探测结果构造沙箱门（真实承载，不再"默认恒 true"）。
 *
 * - `standard`：进程沙箱可用即可；
 * - `strict`：除可用外，还要求 env 白名单 / cwd 收敛 / 超时 / 输出上限四项能力齐备
 *   （strict 工具（ShellExec/CodeEval）必须在这样的承载里执行）。
 */
export function createSandboxGateFromCapability(
  capability: SandboxCapability = probeSandboxCapability(),
): SandboxGatePort {
  return {
    isAvailable(mode: RequiredSandboxMode): boolean {
      if (!capability.available) return false;
      if (mode === "standard") return true;
      return (
        capability.capabilities.envSanitized &&
        capability.capabilities.cwdConfined &&
        capability.capabilities.timeoutEnforced &&
        capability.capabilities.outputCapped
      );
    },
  };
}
