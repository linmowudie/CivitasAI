/**
 * @module Supervision/compactionStrategies
 * @description
 * 内置管理策略机集合（《一些思考3》§1.6 多级触发流水线 / §5.1 压缩策略选择器）。
 *
 * 五台策略机，按成本阶梯排列（`priority` 升序执行，先免费后 LLM）：
 *
 * | id                     | 类别      | 层级                    | 调 LLM | 职责 |
 * |------------------------|-----------|-------------------------|--------|------|
 * | `rule-micro-prune`     | rule      | micro/auto/manual/emergency | 否 | 裁剪旧工具结果、去重文件读取、清除 Base64 |
 * | `subtask-isolation`    | isolation | micro/auto/manual       | 否  | 已关闭子任务的片段整体折叠（§4.7-5） |
 * | `memory-flush`         | flush     | auto/manual/emergency   | 否  | 动手前把关键信息落盘持久记忆（§2.6-4） |
 * | `structured-summary`   | llm       | auto/manual/emergency   | **是** | 旧段 → 目标/进度/约束/剩余工作结构化摘要（§1.6 Auto 层） |
 * | `emergency-truncate`   | fallback  | emergency               | 否  | API 溢出后的强制硬裁剪（§1.6 Emergency 层） |
 *
 * 分层：本文件仅依赖 `Infra/Contracts`（纯类型），零 `Core` import（Services 层红线）。
 * 摘要与落盘的**副作用回调由编排入口注入**（见 Core/Loop/contextCompression.ts）。
 */

import type {
  CompactableMessage,
  CompactionStrategy,
  StrategyContext,
  StrategyResult,
} from "../../Infra/Contracts/compactionTypes.js";

// ── 公共工具（导出供编排入口与测试复用，避免 token 口径漂移）──────────────

/** 单条消息 token 估算（chars/4，与 Core/Loop.contextCompression 同口径） */
export function countMessageTokens(message: CompactableMessage): number {
  return Math.ceil((message.content?.length ?? 0) / 4);
}

/** 消息数组 token 估算 */
export function countMessagesTokens(
  messages: readonly CompactableMessage[],
): number {
  return messages.reduce((sum, m) => sum + countMessageTokens(m), 0);
}

/**
 * 尾部保护起点：从末尾向前累计 token，直到覆盖 `tailProtectTokens`。
 * 返回应被保护的起始下标（`[start, end)` 为保护段）。
 */
export function tailStartIndex(
  messages: readonly CompactableMessage[],
  tailProtectTokens: number,
): number {
  let acc = 0;
  let i = messages.length;
  while (i > 0 && acc < tailProtectTokens) {
    i -= 1;
    const msg = messages[i];
    if (msg) acc += countMessageTokens(msg);
  }
  return i;
}

/**
 * 切点配对保护（REV-341）：保留段若以 `role:'tool'` 开头，说明它所属的
 * 助手消息（带 tool_calls）已被切进旧段，请求里只剩孤儿子结果 → 供应商判非法。
 * 遇到该边界就把切点前移到工具结果之前。
 */
export function safeSplitIndex(
  messages: readonly CompactableMessage[],
  from: number,
): number {
  let i = from;
  while (i > 0 && messages[i]?.role === "tool") {
    i -= 1;
  }
  return i;
}

// ── 正则 ────────────────────────────────────────────────────────────

/** Base64 大块（≥200 字符载荷） */
const BASE64_BLOB_RE =
  /data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\r\n]{200,}/gi;

/** 文件路径（用于重复读取去重与关键信息提取） */
const FILE_PATH_RE =
  /(?:[A-Za-z]:[\\/]|\/|\.{1,2}[\\/])?[\w.@-]+(?:[\\/][\w.@-]+)+\.\w{1,8}/g;
/** 同上，非全局版（`RegExp.test` 配 `g` 会带 lastIndex 状态，必须分开） */
const FILE_PATH_TEST_RE =
  /(?:[A-Za-z]:[\\/]|\/|\.{1,2}[\\/])?[\w.@-]+(?:[\\/][\w.@-]+)+\.\w{1,8}/;

/** 子任务标记（约定：消息内容含 `[subtask:<id>]` 即归属该子任务） */
const SUBTASK_TAG_RE = /\[subtask:([\w.-]+)\]/g;

/** 结论 / 约束类关键句（memory-flush 提取用） */
const KEY_POINT_RE =
  /决定|结论|约定|约束|必须|禁止|已确认|decided|conclusion|constraint|must not/i;

function extractFilePaths(text: string): string[] {
  const matched = text.match(FILE_PATH_RE);
  if (!matched) return [];
  return [...new Set(matched.map((s) => s.trim()))];
}

function extractSubtaskIds(text: string): string[] {
  const ids: string[] = [];
  for (const m of text.matchAll(SUBTASK_TAG_RE)) {
    const id = m[1];
    if (id) ids.push(id);
  }
  return [...new Set(ids)];
}

/** 工具结果裁剪：保留首尾，中间折叠 */
function trimToolOutput(content: string, limitTokens: number): string | null {
  if (countMessageTokens({ role: "tool", content }) <= limitTokens) return null;
  const head = content.slice(0, 800);
  const tail = content.slice(-400);
  const omitted = Math.max(0, content.length - head.length - tail.length);
  return `${head}\n...[工具结果已裁剪 ${omitted} 字符]...\n${tail}`;
}

// ── ① 规则裁剪（免费，§1.6 Micro 层）─────────────────────────────────

export const microPruneStrategy: CompactionStrategy = {
  id: "rule-micro-prune",
  kind: "rule",
  layers: ["micro", "auto", "manual", "emergency"],
  priority: 10,
  usesLlm: false,

  applies(): boolean {
    // 纯内容改写、O(n)，恒适用；实际是否改动由 execute 判定
    return true;
  },

  async execute(ctx: StrategyContext): Promise<StrategyResult> {
    const limitTokens = Math.max(500, ctx.toolOutputTokenLimit || 2000);
    const protectFrom = tailStartIndex(ctx.messages, ctx.tailProtectTokens);
    const next: CompactableMessage[] = [...ctx.messages];
    const dropped = new Set<string>();
    let changed = false;

    // 最后一次读取位置（重复文件读取只保留最后一份）
    const lastReadAt = new Map<string, number>();
    for (let i = 0; i < protectFrom; i++) {
      const msg = next[i];
      if (!msg) continue;
      for (const p of extractFilePaths(msg.content)) lastReadAt.set(p, i);
    }

    for (let i = 0; i < protectFrom; i++) {
      const msg = next[i];
      if (!msg) continue;
      let content = msg.content;

      // Base64 大块清除
      const stripped = content.replace(
        BASE64_BLOB_RE,
        (blob) => `[base64 已省略 ${blob.length} 字符]`,
      );
      if (stripped !== content) {
        content = stripped;
        dropped.add("BASE64_BLOB");
      }

      // 旧工具结果裁剪
      if (msg.role === "tool") {
        const trimmed = trimToolOutput(content, limitTokens);
        if (trimmed !== null) {
          content = trimmed;
          dropped.add("TOOL_OUTPUT");
        }
      }

      // 重复文件读取去重（仅当该文件在后面还有更晚的读取）
      const paths = extractFilePaths(content);
      if (
        paths.length > 0 &&
        paths.every((p) => (lastReadAt.get(p) ?? -1) > i)
      ) {
        content = `[重复读取已省略：${paths.join(", ")}（保留最后一次）]`;
        dropped.add("DUPLICATE_FILE_READ");
      }

      if (content !== msg.content) {
        next[i] = { ...msg, content };
        changed = true;
      }
    }

    return {
      changed,
      messages: next,
      droppedEntryTypes: [...dropped],
      note: changed
        ? `规则裁剪：${[...dropped].join("/") || "无"}`
        : "规则裁剪：无可裁剪内容",
    };
  },
};

// ── ② 子任务隔离（§4.7-5 / §5.1）───────────────────────────────────

export const subtaskIsolationStrategy: CompactionStrategy = {
  id: "subtask-isolation",
  kind: "isolation",
  layers: ["micro", "auto", "manual"],
  priority: 20,
  usesLlm: false,

  applies(ctx: StrategyContext): boolean {
    const protectFrom = tailStartIndex(ctx.messages, ctx.tailProtectTokens);
    const active = new Set(ctx.activeSubtasks);
    for (let i = 0; i < protectFrom; i++) {
      const msg = ctx.messages[i];
      if (!msg) continue;
      const ids = extractSubtaskIds(msg.content);
      if (ids.length > 0 && ids.every((id) => !active.has(id))) return true;
    }
    return false;
  },

  async execute(ctx: StrategyContext): Promise<StrategyResult> {
    const protectFrom = tailStartIndex(ctx.messages, ctx.tailProtectTokens);
    const active = new Set(ctx.activeSubtasks);
    const next: CompactableMessage[] = [...ctx.messages];
    const dropped = new Set<string>();
    let changed = false;

    for (let i = 0; i < protectFrom; i++) {
      const msg = next[i];
      if (!msg) continue;
      const ids = extractSubtaskIds(msg.content);
      if (ids.length === 0) continue;
      if (!ids.every((id) => !active.has(id))) continue;
      next[i] = {
        ...msg,
        content: `[子任务 ${ids.join("/")} 已关闭，片段内容已折叠]`,
      };
      dropped.add("CLOSED_SUBTASK_CONTENT");
      changed = true;
    }

    return {
      changed,
      messages: next,
      droppedEntryTypes: [...dropped],
      note: changed
        ? "子任务隔离：已折叠关闭子任务片段"
        : "子任务隔离：无可折叠片段",
    };
  },
};

// ── ③ 记忆落盘（§2.6-4：压缩前 memory flush 降低 Cost_quality-loss）──

/** 从旧段提取关键句（确定性、不调模型） */
function extractKeyPoints(
  messages: readonly CompactableMessage[],
  maxChars = 2000,
): string {
  const lines: string[] = [];
  let total = 0;
  for (const m of messages) {
    for (const raw of m.content.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      const interesting =
        FILE_PATH_TEST_RE.test(line) || KEY_POINT_RE.test(line);
      if (!interesting) continue;
      const entry = `[${m.role}] ${line.slice(0, 200)}`;
      lines.push(entry);
      total += entry.length;
      if (total >= maxChars) break;
    }
    if (total >= maxChars) break;
  }
  return lines.join("\n");
}

export const memoryFlushStrategy: CompactionStrategy = {
  id: "memory-flush",
  kind: "flush",
  layers: ["auto", "manual", "emergency"],
  priority: 30,
  usesLlm: false,

  applies(ctx: StrategyContext): boolean {
    return typeof ctx.flushMemory === "function";
  },

  async execute(ctx: StrategyContext): Promise<StrategyResult> {
    const flush = ctx.flushMemory;
    const noop = (note: string): StrategyResult => ({
      changed: false,
      messages: ctx.messages,
      droppedEntryTypes: [],
      note,
    });
    if (!flush) return noop("记忆落盘：未注入落盘回调");

    const protectFrom = safeSplitIndex(
      ctx.messages,
      tailStartIndex(ctx.messages, ctx.tailProtectTokens),
    );
    const keyPoints = extractKeyPoints(ctx.messages.slice(0, protectFrom));
    if (!keyPoints) return noop("记忆落盘：旧段无可提取要点");

    try {
      const meta =
        ctx.loopId !== undefined
          ? { traceId: ctx.traceId, loopId: ctx.loopId }
          : { traceId: ctx.traceId };
      const flushed = await flush(keyPoints, meta);
      // 本策略机只产生副作用（不改动上下文），故 changed 恒 false
      return noop(
        flushed
          ? "记忆落盘：关键信息已写入持久记忆"
          : "记忆落盘失败（fail-soft，不阻断压缩）",
      );
    } catch (e) {
      return noop(
        `记忆落盘异常（fail-soft）：${e instanceof Error ? e.message : String(e)}`,
      );
    }
  },
};

// ── ④ 结构化摘要（§1.6 Auto 层）─────────────────────────────────────

/** 摘要系统提示（保留目标相关事实与产物指针，丢弃过程噪声） */
const SUMMARY_SYSTEM_PROMPT = [
  "你是上下文压缩器。将给定对话历史压缩为简洁、忠实的事实摘要，供后续推理使用。",
  "必须覆盖五要素：① 任务目标 ② 当前进度 ③ 约束与已确认结论 ④ 已尝试路径 ⑤ 剩余工作。",
  "保留：关键文件路径与产物、已做出的决定、未完成的步骤。",
  "丢弃：问候与寒暄、重复的尝试过程、冗长原始输出（用一句概括）。",
  "输出纯文本（不超过 400 字），不要使用 Markdown 标题。",
].join("\n");

/** 拼进摘要请求的历史最大字符数 */
const MAX_HISTORY_CHARS = 12_000;

function formatForSummary(m: CompactableMessage): string {
  return `[${m.role}] ${m.content}`;
}

/** 构造函数（导出供组合根自定义摘要策略机时复用同一提示词口径） */
export function buildSummaryMessages(
  historyText: string,
): Array<{ role: "system" | "user"; content: string }> {
  return [
    { role: "system", content: SUMMARY_SYSTEM_PROMPT },
    { role: "user", content: historyText },
  ];
}

export const structuredSummaryStrategy: CompactionStrategy = {
  id: "structured-summary",
  kind: "llm",
  layers: ["auto", "manual", "emergency"],
  priority: 50,
  usesLlm: true,

  applies(ctx: StrategyContext): boolean {
    return typeof ctx.summarize === "function" && ctx.messages.length > 1;
  },

  async execute(ctx: StrategyContext): Promise<StrategyResult> {
    const summarize = ctx.summarize;
    const noop = (note: string): StrategyResult => ({
      changed: false,
      messages: ctx.messages,
      droppedEntryTypes: [],
      note,
    });
    if (!summarize) return noop("结构化摘要：未注入摘要回调");

    // 切点 = 尾部保护起点，再做配对保护。
    // 两侧都要求非空：切点在最前（无旧段）或最后（无尾部可留）时都不压缩——
    // 否则会把整段历史（含当前回合）替换成一条摘要，丢失上下文。
    const split = safeSplitIndex(
      ctx.messages,
      tailStartIndex(ctx.messages, ctx.tailProtectTokens),
    );
    if (split <= 0 || split >= ctx.messages.length)
      return noop("结构化摘要：无旧段可压");

    const older = ctx.messages.slice(0, split);
    const tail = ctx.messages.slice(split);
    const historyText = older
      .map(formatForSummary)
      .join("\n")
      .slice(-MAX_HISTORY_CHARS);

    let summary: string | null;
    try {
      summary = await summarize(historyText);
    } catch (e) {
      return noop(
        `summarize-error: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (summary === null) return noop("summarize-failed");
    const trimmed = summary.trim();
    if (!trimmed) return noop("empty-summary");

    const summaryMsg: CompactableMessage = {
      role: "system",
      content: `[上下文压缩摘要]\n${trimmed}`,
    };
    // “压缩后必须重锚目标”（Docs/Agent/02 §4.4）——重锚消息紧随摘要之后
    const reanchorMsg: CompactableMessage = {
      role: "system",
      content: `[GoalReanchor] 上下文已压缩。当前目标：${ctx.goal}。请继续执行。`,
    };

    return {
      changed: true,
      messages: [summaryMsg, reanchorMsg, ...tail],
      droppedEntryTypes: ["CONVERSATION_HISTORY"],
      note: `结构化摘要：${older.length} 条旧段 → 1 条摘要（保留尾部 ${tail.length} 条）`,
    };
  },
};

// ── ⑤ 紧急截断（§1.6 Emergency 层）─────────────────────────────────

export const emergencyTruncateStrategy: CompactionStrategy = {
  id: "emergency-truncate",
  kind: "fallback",
  layers: ["emergency"],
  priority: 90,
  usesLlm: false,

  applies(ctx: StrategyContext): boolean {
    return (
      countMessagesTokens(ctx.messages) >
      Math.max(1, Math.floor(ctx.budgetTokens))
    );
  },

  async execute(ctx: StrategyContext): Promise<StrategyResult> {
    const target = Math.max(1, Math.floor(ctx.budgetTokens));
    const messages = ctx.messages;
    const noop = (note: string): StrategyResult => ({
      changed: false,
      messages,
      droppedEntryTypes: [],
      note,
    });
    if (messages.length === 0) return noop("紧急截断：无消息");

    let start = 0;
    let total = countMessagesTokens(messages);
    while (start < messages.length - 1 && total > target) {
      total -= countMessageTokens(messages[start] as CompactableMessage);
      start += 1;
    }
    // 配对保护：不能以孤儿子结果开头（其所属助手消息已被裁掉）
    while (start < messages.length - 1 && messages[start]?.role === "tool") {
      total -= countMessageTokens(messages[start] as CompactableMessage);
      start += 1;
    }
    if (start === 0) return noop("紧急截断：无需裁剪");

    const kept = messages.slice(start);
    const marker: CompactableMessage = {
      role: "system",
      content: `[上下文压力] 已紧急裁剪 ${start} 条最旧消息以腾出空间；请优先依据后续内容继续。`,
    };

    return {
      changed: true,
      messages: [marker, ...kept],
      droppedEntryTypes: ["OLDEST_MESSAGES"],
      note: `紧急截断：丢弃最旧 ${start} 条（${total} tokens 保留）`,
    };
  },
};

// ── 内置集合（注册表出厂默认）──────────────────────────────────────

/** 内置策略机（顺序无关；执行顺序由 `priority` 决定） */
export const BUILTIN_STRATEGIES: readonly CompactionStrategy[] = [
  microPruneStrategy,
  subtaskIsolationStrategy,
  memoryFlushStrategy,
  structuredSummaryStrategy,
  emergencyTruncateStrategy,
];
