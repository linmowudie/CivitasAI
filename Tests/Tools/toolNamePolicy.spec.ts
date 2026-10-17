/**
 * 工具命名策略守卫（防止回归）
 *
 * 背景（真实故障，2026-10-16）：工具名原为点号形式（`FileRead`），
 * 而 DeepSeek 等 OpenAI 兼容端点要求 `tools[].function.name` 匹配 `^[a-zA-Z0-9_-]+$`，
 * 点号会直接 400：`Invalid 'tools[0].function.name': string does not match pattern ...`
 *
 * 处置：工具名**全局统一为大驼峰**（`FileRead`），内部名 == 线上名，
 * 三处模型可见面（`tools` schema / 历史回放 / 提示词工具区）同名。
 *
 * 本测试锁死三件事：
 *   1. 每个已注册工具名必须是 `^[A-Z][A-Za-z0-9]*$`（大驼峰、无点号），且满足 wire 约束；
 *   2. 遗留点号名仍可解析（历史回放/外部调用的兼容层没有被删掉）；
 *   3. 兼容层本身的一致性与边界（未知名原样返回、非法字符兜底不产生点号）。
 */
import { describe, it, expect, beforeEach } from "vitest";

import { registerBuiltinTools } from "../../Src/Tools/builtinLoader.js";
import {
  getAllToolSpecs,
  getTool,
  clearRegistry,
} from "../../Src/Tools/Registry/toolRegistry.js";
import {
  LEGACY_TOOL_ALIASES,
  TOOL_NAME_CANONICAL_PATTERN,
  TOOL_NAME_WIRE_PATTERN,
  isLegacyToolName,
  isWireSafeToolName,
  toCanonicalToolName,
  toWireToolName,
} from "../../Src/Infra/Llm/Provider/toolNameWireCompat.js";

describe("工具命名策略 · 已注册工具名必须为大驼峰且可直接上线", () => {
  beforeEach(() => {
    clearRegistry();
    registerBuiltinTools();
  });

  it("每个已注册工具名匹配大驼峰 `^[A-Z][A-Za-z0-9]*$` 且满足 provider wire 约束", () => {
    const specs = getAllToolSpecs();
    expect(specs.length).toBeGreaterThan(0);
    const bad = specs.filter(
      (s) =>
        !TOOL_NAME_CANONICAL_PATTERN.test(s.name) ||
        !TOOL_NAME_WIRE_PATTERN.test(s.name),
    );
    expect(
      bad.map((s) => s.name),
      "以下工具名不合法（须大驼峰、不含点号）",
    ).toEqual([]);
  });

  it("【负向】没有工具名包含点号（点号会触发 provider 400）", () => {
    const dotted = getAllToolSpecs()
      .filter((s) => s.name.includes("."))
      .map((s) => s.name);
    expect(dotted).toEqual([]);
  });
});

describe("工具命名兼容层 · 遗留点号名仍可解析", () => {
  beforeEach(() => {
    clearRegistry();
    registerBuiltinTools();
  });

  it("旧点号名可查到与当前名**同一个**工具", () => {
    const pairs: Array<[string, string]> = [
      ["FileRead", "FileRead"],
      ["FileWrite", "FileWrite"],
      ["ShellExec", "ShellExec"],
      ["ToolExecute", "ToolExecute"],
    ];
    for (const [legacy, current] of pairs) {
      const a = getTool(legacy);
      const b = getTool(current);
      expect(a, `旧名 ${legacy} 应可解析`).toBeDefined();
      expect(a).toBe(b);
      expect(a?.spec.name).toBe(current);
    }
  });

  it("迁移表本身自洽：键是点号名、值是大驼峰且满足 wire 约束", () => {
    const entries = Object.entries(LEGACY_TOOL_ALIASES);
    expect(entries.length).toBeGreaterThan(0);
    for (const [from, to] of entries) {
      expect(from).toContain(".");
      expect(TOOL_NAME_CANONICAL_PATTERN.test(to), `${to} 应为大驼峰`).toBe(
        true,
      );
      expect(TOOL_NAME_WIRE_PATTERN.test(to), `${to} 应满足 wire 约束`).toBe(
        true,
      );
      expect(isLegacyToolName(from)).toBe(true);
    }
  });

  it("归一化边界：未知名原样返回；非法字符兜底后不含点号", () => {
    expect(toCanonicalToolName("FileRead")).toBe("FileRead");
    expect(toCanonicalToolName("从未见过的名字")).toBe("从未见过的名字");
    expect(toCanonicalToolName("FileRead")).toBe("FileRead");

    // 兜底：任何带点号的输入都不能原样上线
    expect(toWireToolName("weird.name")).toBe("weird_name");
    expect(isWireSafeToolName("weird.name")).toBe(false);
    expect(isWireSafeToolName("FileRead")).toBe(true);
  });
});
