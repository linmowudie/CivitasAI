/**
 * @module Infra/Llm/Provider/toolNameWireCompat
 * @description
 * 工具名**线上兼容层**（唯一事实源）。
 *
 * 背景：工具名原先带点号（`FileRead`），而部分 provider（如 DeepSeek）要求
 * `tools[].function.name` 匹配 `^[a-zA-Z0-9_-]+$` —— 点号会直接 400：
 *   `Invalid 'tools[0].function.name': string does not match pattern ...`
 *
 * 现工具名已**全局统一为大驼峰**（`FileRead`），内部名 == 线上名，三处模型可见面
 * （`tools` schema / 历史回放 / 提示词工具区）同名。
 *
 * 本模块解决**遗留数据**：改名之前落库的会话历史里仍是点号名，
 * 直接回放会再次触发同样的 400 ⇒ 出站时统一归一化为当前名；入站（解析模型输出）也兜底归一化。
 *
 * 分层：本文件位于 Infra，**可被 Tools/Core 引用**（依赖方向 Interface→Core→Services→Tools→Infra）。
 */

/** 旧点号名 → 当前大驼峰名（改名迁移表；键必须保持点号形式，勿被改名脚本改写） */
export const LEGACY_TOOL_ALIASES: Readonly<Record<string, string>> =
  Object.freeze({
    ["agent.merge"]: "AgentMerge",
    ["agent.recruit"]: "AgentRecruit",
    ["agent.split"]: "AgentSplit",
    ["agent.submit_review"]: "AgentSubmitReview",
    ["code.eval"]: "CodeEval",
    ["dir.list"]: "DirList",
    ["file.edit"]: "FileEdit",
    ["file.grep"]: "FileGrep",
    ["file.read"]: "FileRead",
    ["file.write"]: "FileWrite",
    ["memory.write"]: "MemoryWrite",
    ["orchestrator.compose"]: "OrchestratorCompose",
    ["orchestrator.select"]: "OrchestratorSelect",
    ["shell.exec"]: "ShellExec",
    ["todo.write"]: "TodoWrite",
    ["tool.execute"]: "ToolExecute",
    ["tool.search"]: "ToolSearch",
    ["vector.search"]: "VectorSearch",
    ["web.search"]: "WebSearch",
  });

/** provider 允许的函数名形状（DeepSeek 等 OpenAI 兼容端点） */
export const TOOL_NAME_WIRE_PATTERN = /^[a-zA-Z0-9_-]+$/;

/** 本项目统一命名形状：大驼峰，无分隔符 */
export const TOOL_NAME_CANONICAL_PATTERN = /^[A-Z][A-Za-z0-9]*$/;

/** 旧名 → 当前名；非旧名原样返回 */
export function toCanonicalToolName(name: string): string {
  return Object.prototype.hasOwnProperty.call(LEGACY_TOOL_ALIASES, name)
    ? LEGACY_TOOL_ALIASES[name]!
    : name;
}

/** 是否是需要迁移的旧点号名 */
export function isLegacyToolName(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(LEGACY_TOOL_ALIASES, name);
}

/**
 * 出站名字归一化：发给 provider 的名字必须是 wire-safe 且为当前名。
 * 旧点号名 ⇒ 当前大驼峰；其余非法字符 ⇒ 下划线（保底，不产生点号）。
 */
export function toWireToolName(name: string): string {
  const canonical = toCanonicalToolName(name);
  if (TOOL_NAME_WIRE_PATTERN.test(canonical)) return canonical;
  return canonical.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** 名字是否可直接上线（无需转换） */
export function isWireSafeToolName(name: string): boolean {
  return TOOL_NAME_WIRE_PATTERN.test(name);
}

/**
 * 旧**命名空间** → 当前大驼峰命名空间前缀。
 *
 * 用于已落库的规则/通配（如 `tool.forbid(shell.*)`）：这些规则改名后前缀不再命中，
 * 会**静默失效**（治理动作查不出来 ⇒ 安全门放行）。此处把 `shell` 映射回 `Shell`。
 *
 * @returns 当前命名空间前缀；无法映射时返回 null（调用方按原语义处理）
 */
export function toCanonicalToolPrefix(legacyNamespace: string): string | null {
  const withDot = legacyNamespace + ".";
  for (const [from, to] of Object.entries(LEGACY_TOOL_ALIASES)) {
    if (from.startsWith(withDot)) {
      const m = /^([A-Z][a-z0-9]*)/.exec(to);
      if (m?.[1]) return m[1];
    }
  }
  return null;
}
