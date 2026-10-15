/**
 * 《一些思考3》落实测试 —— 管理策略机族（§1.6 多级流水线 / §5.1 策略选择器）
 *
 * 覆盖：5 台内置策略机的行为、注册表可插拔性与选择器排序/过滤。
 * 全部零模型调用（LLM 类策略机注入假摘要回调）。
 */
import { describe, it, expect, beforeEach } from "vitest";

import {
  BUILTIN_STRATEGIES,
  countMessageTokens,
  emergencyTruncateStrategy,
  memoryFlushStrategy,
  microPruneStrategy,
  safeSplitIndex,
  structuredSummaryStrategy,
  subtaskIsolationStrategy,
  tailStartIndex,
} from "../../Src/Services/Supervision/compactionStrategies.js";
import {
  clearStrategies,
  getStrategies,
  getStrategyCount,
  registerStrategies,
  registerStrategy,
  resetStrategies,
  selectStrategies,
  unregisterStrategy,
} from "../../Src/Services/Supervision/strategyRegistry.js";
import type {
  CompactableMessage,
  CompactionStrategy,
  StrategyContext,
} from "../../Src/Infra/Contracts/compactionTypes.js";

// ── 辅助 ────────────────────────────────────────────────────────────

function msg(
  role: CompactableMessage["role"],
  content: string,
): CompactableMessage {
  return { role, content };
}

function ctx(over: Partial<StrategyContext> = {}): StrategyContext {
  return {
    messages: [],
    layer: "auto",
    complexity: "medium",
    effectiveWindow: 100_000,
    budgetTokens: 40_000,
    tailProtectTokens: 0,
    toolOutputTokenLimit: 500,
    goal: "实现登录接口",
    traceId: "trace-1",
    activeSubtasks: [],
    signals: {
      complexity: "medium",
      usageRatio: 0.9,
      remainingTokens: 1_000,
      expectedNextGrowthTokens: 0,
      toolOutputTokens: 0,
      subtaskEnded: false,
      manualRequested: false,
      prefixHitRate: 0,
    },
    ...over,
  };
}

beforeEach(() => {
  resetStrategies();
});

// ── ① 规则裁剪 ──────────────────────────────────────────────────────

describe("管理策略机 · rule-micro-prune", () => {
  it("清除 Base64 大块", async () => {
    const blob = `data:image/png;base64,${"A".repeat(400)}`;
    const result = await microPruneStrategy.execute(
      ctx({ messages: [msg("user", `看这个 ${blob}`)] }),
    );
    expect(result.changed).toBe(true);
    expect(result.messages[0]!.content).toContain("[base64 已省略");
    expect(result.droppedEntryTypes).toContain("BASE64_BLOB");
  });

  it("裁剪超限的旧工具结果，保留首尾", async () => {
    const big = "z".repeat(3_000);
    const result = await microPruneStrategy.execute(
      ctx({ messages: [msg("tool", big)] }),
    );
    expect(result.changed).toBe(true);
    expect(result.droppedEntryTypes).toContain("TOOL_OUTPUT");
    const content = result.messages[0]!.content;
    expect(content).toContain("[工具结果已裁剪");
    expect(content.length).toBeLessThan(big.length);
  });

  it("未超限的工具结果不动", async () => {
    const small = "z".repeat(100);
    const result = await microPruneStrategy.execute(
      ctx({ messages: [msg("tool", small)] }),
    );
    expect(result.changed).toBe(false);
    expect(result.messages[0]!.content).toBe(small);
  });

  it("重复文件读取只保留最后一次", async () => {
    const messages = [
      msg("tool", "读取 src/foo.ts 得到 1"),
      msg("tool", "读取 src/foo.ts 得到 2"),
      msg("user", "继续"),
    ];
    const result = await microPruneStrategy.execute(ctx({ messages }));
    expect(result.changed).toBe(true);
    expect(result.droppedEntryTypes).toContain("DUPLICATE_FILE_READ");
    expect(result.messages[0]!.content).toContain("重复读取已省略");
    expect(result.messages[1]!.content).toContain("得到 2");
  });

  it("尾部保护段不被裁剪", async () => {
    const big = "z".repeat(3_000);
    const messages = [msg("tool", big), msg("user", "ok")];
    // 保护最后 1 条（约 2 tokens）——但下方用大 tail 覆盖整段
    const result = await microPruneStrategy.execute(
      ctx({
        messages,
        tailProtectTokens: 10_000,
      }),
    );
    expect(result.changed).toBe(false);
    expect(result.messages[0]!.content).toBe(big);
  });
});

// ── ② 子任务隔离 ────────────────────────────────────────────────────

describe("管理策略机 · subtask-isolation", () => {
  const messages = [
    msg("assistant", "[subtask:sub-1] 已完成的子任务产物"),
    msg("assistant", "[subtask:sub-2] 正在进行的子任务产物"),
    msg("user", "继续"),
  ];

  it("已关闭子任务片段被折叠，活跃子任务保留", async () => {
    const c = ctx({ messages, activeSubtasks: ["sub-2"] });
    expect(subtaskIsolationStrategy.applies(c)).toBe(true);
    const result = await subtaskIsolationStrategy.execute(c);
    expect(result.changed).toBe(true);
    expect(result.messages[0]!.content).toContain("已关闭，片段内容已折叠");
    expect(result.messages[1]!.content).toContain("正在进行的子任务产物");
    expect(result.droppedEntryTypes).toContain("CLOSED_SUBTASK_CONTENT");
  });

  it("没有子任务标记时策略机不适用", () => {
    const c = ctx({
      messages: [msg("user", "普通消息")],
      activeSubtasks: ["sub-2"],
    });
    expect(subtaskIsolationStrategy.applies(c)).toBe(false);
  });

  it("全部子任务都活跃时不适用", () => {
    const c = ctx({ messages, activeSubtasks: ["sub-1", "sub-2"] });
    expect(subtaskIsolationStrategy.applies(c)).toBe(false);
  });
});

// ── ③ 记忆落盘 ──────────────────────────────────────────────────────

describe("管理策略机 · memory-flush", () => {
  it("未注入落盘回调 → 不适用", () => {
    expect(
      memoryFlushStrategy.applies(ctx({ messages: [msg("user", "x")] })),
    ).toBe(false);
  });

  it("注入回调 → 提取关键句并落盘（不改动上下文）", async () => {
    const flushed: string[] = [];
    const c = ctx({
      messages: [
        msg("assistant", "决定：使用现有 src/auth/login.ts，不新建模块"),
        msg("user", "好的"),
        msg("assistant", "结论：必须保持接口兼容"),
      ],
      flushMemory: async (keyPoints, meta) => {
        flushed.push(`${meta.traceId}|${keyPoints}`);
        return true;
      },
    });
    expect(memoryFlushStrategy.applies(c)).toBe(true);
    const result = await memoryFlushStrategy.execute(c);
    expect(result.changed).toBe(false); // 纯副作用策略机
    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toContain("trace-1");
    expect(flushed[0]).toContain("src/auth/login.ts");
    expect(result.note).toContain("已写入持久记忆");
  });

  it("落盘回调抛异常 → fail-soft，不抛出", async () => {
    const c = ctx({
      messages: [msg("assistant", "决定：采用方案 A")],
      flushMemory: async () => {
        throw new Error("磁盘满");
      },
    });
    const result = await memoryFlushStrategy.execute(c);
    expect(result.changed).toBe(false);
    expect(result.note).toContain("fail-soft");
    expect(result.note).toContain("磁盘满");
  });
});

// ── ④ 结构化摘要 ────────────────────────────────────────────────────

describe("管理策略机 · structured-summary", () => {
  it("旧段 → [摘要, GoalReanchor, ...尾部原文]", async () => {
    const messages: CompactableMessage[] = [
      msg("user", "a".repeat(400)),
      msg("assistant", "b".repeat(400)),
      msg("user", "最近的用户消息"),
    ];
    const c = ctx({
      messages,
      tailProtectTokens: countMessageTokens(messages[2]!),
      summarize: async () => "历史摘要：完成了 A。",
    });
    const result = await structuredSummaryStrategy.execute(c);
    expect(result.changed).toBe(true);
    expect(result.messages).toHaveLength(3); // 摘要 + 重锚 + 1 条尾部
    expect(result.messages[0]!.content).toContain("[上下文压缩摘要]");
    expect(result.messages[0]!.content).toContain("历史摘要：完成了 A。");
    expect(result.messages[1]!.content).toContain("[GoalReanchor]");
    expect(result.messages[1]!.content).toContain("实现登录接口");
    expect(result.messages[2]).toEqual(messages[2]);
    expect(result.droppedEntryTypes).toContain("CONVERSATION_HISTORY");
  });

  it("切点不落在工具调用配对中间（保留 assistant.tool_calls 与其结果）", async () => {
    const messages: CompactableMessage[] = [
      msg("user", "x".repeat(400)),
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "read", arguments: "{}" },
          },
        ],
      },
      { role: "tool", content: "结果内容", tool_call_id: "c1" },
      msg("user", "最近一条"),
    ];
    // 尾部保护只覆盖最后两条 → 朴素切点落在 index 2（tool 结果）
    const tail =
      countMessageTokens(messages[2]!) + countMessageTokens(messages[3]!);
    const split = safeSplitIndex(messages, tailStartIndex(messages, tail));
    expect(split).toBe(1); // 回退到 assistant 之前，配对不断

    const result = await structuredSummaryStrategy.execute(
      ctx({
        messages,
        tailProtectTokens: tail,
        summarize: async () => "摘要",
      }),
    );
    // 结果 = [摘要, GoalReanchor, assistant(tool_calls), tool(结果), 最近一条]
    expect(result.messages[0]!.content).toContain("[上下文压缩摘要]");
    expect(result.messages[1]!.content).toContain("[GoalReanchor]");
    expect(result.messages[2]!.role).toBe("assistant");
    expect(result.messages[2]!.tool_calls).toBeTruthy();
    expect(result.messages[3]!.role).toBe("tool");
    expect(result.messages[3]!.tool_call_id).toBe("c1");
  });

  it("摘要回调返回 null（调用失败）→ 不改动，note = summarize-failed", async () => {
    const messages = [msg("user", "x".repeat(400)), msg("user", "tail")];
    const result = await structuredSummaryStrategy.execute(
      ctx({
        messages,
        tailProtectTokens: 1,
        summarize: async () => null,
      }),
    );
    expect(result.changed).toBe(false);
    expect(result.note).toBe("summarize-failed");
  });

  it("空摘要 → note = empty-summary", async () => {
    const messages = [msg("user", "x".repeat(400)), msg("user", "tail")];
    const result = await structuredSummaryStrategy.execute(
      ctx({
        messages,
        tailProtectTokens: 1,
        summarize: async () => "   ",
      }),
    );
    expect(result.changed).toBe(false);
    expect(result.note).toBe("empty-summary");
  });

  it("摘要抛异常 → fail-soft，note = summarize-error", async () => {
    const messages = [msg("user", "x".repeat(400)), msg("user", "tail")];
    const result = await structuredSummaryStrategy.execute(
      ctx({
        messages,
        tailProtectTokens: 1,
        summarize: async () => {
          throw new Error("网络中断");
        },
      }),
    );
    expect(result.changed).toBe(false);
    expect(result.note).toContain("summarize-error");
    expect(result.note).toContain("网络中断");
  });

  it("无旧段可压 → 不改动", async () => {
    const messages = [msg("user", "只有一条")];
    const result = await structuredSummaryStrategy.execute(
      ctx({
        messages,
        summarize: async () => "摘要",
      }),
    );
    expect(result.changed).toBe(false);
    expect(result.note).toContain("无旧段可压");
  });
});

// ── ⑤ 紧急截断 ──────────────────────────────────────────────────────

describe("管理策略机 · emergency-truncate", () => {
  it("超预算时丢弃最旧消息并插入压力标记", async () => {
    const messages: CompactableMessage[] = [
      msg("user", "a".repeat(2_000)),
      msg("assistant", "b".repeat(2_000)),
      msg("user", "c".repeat(2_000)),
      msg("assistant", "d".repeat(2_000)),
    ];
    const result = await emergencyTruncateStrategy.execute(
      ctx({
        messages,
        budgetTokens: 1_000,
      }),
    );
    expect(result.changed).toBe(true);
    expect(result.messages[0]!.content).toContain("[上下文压力]");
    expect(result.droppedEntryTypes).toContain("OLDEST_MESSAGES");
  });

  it("不留下孤儿子结果（首条不是 role:tool）", async () => {
    const messages: CompactableMessage[] = [
      msg("user", "a".repeat(2_000)),
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "read", arguments: "{}" },
          },
        ],
      },
      { role: "tool", content: "r".repeat(2_000), tool_call_id: "c1" },
      msg("user", "tail"),
    ];
    const result = await emergencyTruncateStrategy.execute(
      ctx({ messages, budgetTokens: 1 }),
    );
    expect(result.messages[0]!.role).toBe("system"); // 压力标记
    expect(result.messages.slice(1).every((m) => m.role !== "tool")).toBe(true);
  });

  it("未超预算 → 不适用", () => {
    expect(
      emergencyTruncateStrategy.applies(
        ctx({
          messages: [msg("user", "short")],
          budgetTokens: 1_000,
        }),
      ),
    ).toBe(false);
  });
});

// ── 注册表与选择器 ──────────────────────────────────────────────────

describe("管理策略机 · 注册表与选择器", () => {
  it("出厂内置 5 台策略机", () => {
    expect(getStrategyCount()).toBe(BUILTIN_STRATEGIES.length);
    expect(BUILTIN_STRATEGIES.map((s) => s.id).sort()).toEqual([
      "emergency-truncate",
      "memory-flush",
      "rule-micro-prune",
      "structured-summary",
      "subtask-isolation",
    ]);
  });

  it("可注册自定义策略机（多策略机扩展点）", () => {
    const custom: CompactionStrategy = {
      id: "custom-dedup",
      kind: "rule",
      layers: ["auto"],
      priority: 5,
      usesLlm: false,
      applies: () => true,
      execute: async (c) => ({
        changed: false,
        messages: c.messages,
        droppedEntryTypes: [],
        note: "noop",
      }),
    };
    expect(registerStrategy(custom).ok).toBe(true);
    expect(getStrategyCount()).toBe(BUILTIN_STRATEGIES.length + 1);
    expect(getStrategies().some((s) => s.id === "custom-dedup")).toBe(true);
  });

  it("重复 id 注册被拒绝", () => {
    const dup = registerStrategy(microPruneStrategy);
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.error).toContain("DUPLICATE_ENTRY");
  });

  it("缺少适用层级的策略机被拒绝", () => {
    const bad = {
      ...microPruneStrategy,
      id: "bad",
      layers: [],
    } as unknown as CompactionStrategy;
    expect(registerStrategy(bad).ok).toBe(false);
  });

  it("批量注册返回条数", () => {
    const list = ["a", "b"].map((id) => ({
      id,
      kind: "rule" as const,
      layers: ["auto"] as const,
      priority: 1,
      usesLlm: false,
      applies: () => false,
      execute: async (c: StrategyContext) => ({
        changed: false,
        messages: c.messages,
        droppedEntryTypes: [],
        note: "",
      }),
    })) as unknown as CompactionStrategy[];
    const r = registerStrategies(list);
    expect(r.ok && r.value).toBe(2);
  });

  it("注销后不再出现在注册表", () => {
    unregisterStrategy("subtask-isolation");
    expect(getStrategies().some((s) => s.id === "subtask-isolation")).toBe(
      false,
    );
    resetStrategies();
    expect(getStrategies().some((s) => s.id === "subtask-isolation")).toBe(
      true,
    );
  });

  it("清空策略机 → 选择结果为空（「没有策略机就压不动」）", () => {
    clearStrategies();
    expect(
      selectStrategies(ctx({ messages: [msg("user", "x")] })),
    ).toHaveLength(0);
  });

  it("选择器按层级过滤、按 priority 升序（先免费后 LLM）", () => {
    const selected = selectStrategies(ctx({ layer: "auto" }));
    const ids = selected.map((s) => s.id);
    expect(ids).toContain("rule-micro-prune");
    expect(ids).toContain("structured-summary");
    expect(ids).not.toContain("emergency-truncate"); // 仅 emergency 层
    // priority 升序 ⇒ 规则类必然排在 LLM 类之前
    const firstLlm = selected.findIndex((s) => s.usesLlm);
    const lastRule = selected.map((s) => s.usesLlm).lastIndexOf(false);
    expect(lastRule).toBeLessThan(firstLlm);
  });

  it("紧急层同时包含规则裁剪、记忆落盘、摘要与硬截断", () => {
    const ids = selectStrategies(ctx({ layer: "emergency" })).map((s) => s.id);
    expect(ids).toEqual([
      "rule-micro-prune",
      "memory-flush",
      "structured-summary",
      "emergency-truncate",
    ]);
  });

  it("选择器可按难度档过滤（complexities 缺省 = 全档适用）", () => {
    const simple = selectStrategies(
      ctx({ layer: "auto", complexity: "simple" }),
    ).map((s) => s.id);
    expect(simple).toContain("rule-micro-prune");
  });
});

// ── 公共工具 ────────────────────────────────────────────────────────

describe("管理策略机 · 公共工具", () => {
  it("tailStartIndex 从末尾向前累计到保护额度", () => {
    const messages = [
      msg("user", "a".repeat(40)),
      msg("user", "b".repeat(40)),
      msg("user", "c".repeat(40)),
    ];
    const oneMsg = countMessageTokens(messages[2]!);
    expect(tailStartIndex(messages, oneMsg)).toBe(2);
    expect(tailStartIndex(messages, 0)).toBe(messages.length);
    expect(tailStartIndex(messages, 10_000)).toBe(0);
  });

  it("safeSplitIndex 跳过前导 tool 结果", () => {
    const messages: CompactableMessage[] = [
      msg("user", "x"),
      { role: "tool", content: "r", tool_call_id: "c1" },
      msg("user", "y"),
    ];
    expect(safeSplitIndex(messages, 1)).toBe(0);
    expect(safeSplitIndex(messages, 2)).toBe(2);
  });
});
