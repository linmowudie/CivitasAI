/**
 * 代码沙箱工具（DANGEROUS）
 *
 * 执行方式（TOOL-SEC-SANDBOX 的真实承载）：**子进程**执行，经
 * `Infra/Sandbox/processSandbox.runSandboxedCommand` 提供环境变量白名单（剔除凭据）、
 * cwd 收敛到工作区、超时、输出上限。用户代码以 `new Function('console', code)` 执行，
 * **不暴露 require/模块闭包**。
 *
 * 诚实边界：这不是内核级安全边界（`new Function` 仍可经构造器触达 globalThis），
 * DANGEROUS 级 + L4 HumanGate + EffectJournal 副作用留痕共同承担风险；
 * 内核级隔离（AppContainer/seccomp/job object）仍是后续专项。
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type { ToolDefinition } from "../../Traits/toolSpec.js";
import { toolSuccess, toolError } from "../../Traits/toolSpec.js";
import { contentOutputSchema } from "../_shared.js";
import { getWorkspaceRoot } from "../../../Infra/Fs/pathResolver.js";
import { runSandboxedCommand } from "../../../Infra/Sandbox/processSandbox.js";

/** 子进程包装脚本：在**无 require 闭包**的作用域里执行用户代码，输出 JSON 结果 */
const WRAPPER_SOURCE = `'use strict';
const fs = require('node:fs');
const payloadPath = process.argv[2];
const payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));
const logs = [];
const sandboxConsole = {
  log: (...a) => logs.push(a.map(String).join(' ')),
  error: (...a) => logs.push('[ERROR] ' + a.map(String).join(' ')),
  warn: (...a) => logs.push('[WARN] ' + a.map(String).join(' ')),
};
try {
  // 先按表达式求值（1+2 → 3，保持与旧 vm 契约一致）；语句块/显式 return 回退到函数体执行。
  // new Function 不捕获模块闭包：用户代码拿不到本进程的 require/module。
  let result;
  try {
    result = new Function('console', '"use strict"; return (' + payload.code + '\\n);')(sandboxConsole);
  } catch (exprError) {
    result = new Function('console', payload.code)(sandboxConsole);
  }
  process.stdout.write(JSON.stringify({ ok: true, result: result === undefined ? null : String(result), logs }));
} catch (e) {
  process.stdout.write(JSON.stringify({ ok: false, error: e && e.message ? e.message : String(e), logs }));
}
`;

export const codeSandbox: ToolDefinition = {
  spec: {
    name: "CodeEval",
    version: "0.2.0",
    description:
      "在受限子进程中执行 JavaScript 代码片段（环境变量白名单 + cwd 收敛 + 超时 + 输出上限；" +
      "无 require 闭包。非内核级安全边界，需审批）。",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "要执行的代码（返回值即结果）" },
        language: {
          type: "string",
          enum: ["javascript"],
          description: "语言（当前仅 javascript）",
        },
        timeoutMs: { type: "number", description: "超时 ms，默认 5000" },
      },
      required: ["code"],
      additionalProperties: false,
    },
    outputSchema: contentOutputSchema("{ result, logs, sandboxed }"),
    dangerLevel: "DANGEROUS",
    idempotency: "CONDITIONAL",
    idempotencyKeyFields: ["code"],
    reversibility: "IRREVERSIBLE",
    humanGateLevel: "L4",
    sideEffectScope: "process",
    requiredRoles: ["prime_director", "arbitrator", "partner", "worker"],
    sandboxMode: "strict",
    timeoutMs: 10_000,
  },

  async execute(input, context) {
    const code = typeof input["code"] === "string" ? input["code"] : "";
    const timeoutMs = (input["timeoutMs"] as number) ?? 5_000;

    if (!code) {
      return toolError(
        context.operationId,
        "INVALID_INPUT",
        "缺少 code 参数",
        false,
      );
    }

    // 在**工作区内**的临时目录落 wrapper + payload（cwd 收敛由沙箱执行器保证）
    const workdir = join(
      getWorkspaceRoot(),
      ".sandbox",
      `eval-${randomUUID()}`,
    );
    let outcome:
      | {
          ok: true;
          value: {
            stdout: string;
            stderr: string;
            exitCode: number;
            timedOut: boolean;
          };
        }
      | { ok: false; reason: string };
    try {
      mkdirSync(workdir, { recursive: true });
      const wrapperPath = join(workdir, "wrapper.cjs");
      const payloadPath = join(workdir, "payload.json");
      writeFileSync(wrapperPath, WRAPPER_SOURCE, "utf8");
      writeFileSync(payloadPath, JSON.stringify({ code }), "utf8");

      outcome = runSandboxedCommand({
        command: `"${process.execPath}" "${wrapperPath}" "${payloadPath}"`,
        cwd: workdir,
        timeoutMs,
        allowedRoot: getWorkspaceRoot(),
      });
    } catch (e) {
      return toolError(
        context.operationId,
        "CODE_EXECUTION_ERROR",
        e instanceof Error ? e.message : String(e),
        true,
      );
    } finally {
      try {
        rmSync(workdir, { recursive: true, force: true });
      } catch {
        /* 清理失败不影响结果 */
      }
    }

    if (!outcome.ok) {
      return toolError(
        context.operationId,
        "SANDBOX_UNAVAILABLE",
        `沙箱承载不可用，拒绝执行代码：${outcome.reason}`,
        true,
      );
    }
    if (outcome.value.timedOut) {
      return toolError(
        context.operationId,
        "COMMAND_TIMEOUT",
        `代码执行超时 (${timeoutMs}ms)`,
        true,
      );
    }

    const stdout = outcome.value.stdout.trim();
    type SandboxProcessResult = {
      ok?: boolean;
      result?: unknown;
      logs?: string[];
      error?: string;
    };
    let parsed: SandboxProcessResult | null = null;
    try {
      const lastLine =
        stdout
          .split(/\r?\n/)
          .filter((l) => l.trim().length > 0)
          .pop() ?? "";
      parsed = JSON.parse(lastLine) as SandboxProcessResult;
    } catch {
      parsed = null;
    }

    if (!parsed) {
      return toolError(
        context.operationId,
        "CODE_EXECUTION_ERROR",
        `子进程未返回可解析结果（exit=${outcome.value.exitCode}）：${stdout.slice(0, 300)}${outcome.value.stderr ? ` | ${outcome.value.stderr.slice(0, 300)}` : ""}`,
        true,
      );
    }
    if (parsed.ok === false) {
      return toolError(
        context.operationId,
        "CODE_EXECUTION_ERROR",
        String(parsed.error ?? "代码执行失败"),
        true,
      );
    }

    return toolSuccess(
      context.operationId,
      {
        result: parsed.result ?? null,
        logs: Array.isArray(parsed.logs) ? parsed.logs : [],
        sandboxed: true,
      },
      { effects: [`CodeEval:${code.slice(0, 50)}`] },
    );
  },
};

/** 供测试/诊断：包装脚本路径占位（实际按次写临时目录） */
export const CODE_SANDBOX_WRAPPER_SOURCE = WRAPPER_SOURCE;
