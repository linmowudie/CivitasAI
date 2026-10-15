/**
 * REV-341 · 工具消息装配与模型调用失败呈现
 *
 * 真实取证现象（.tmp/p17-review-evidence.out）：多轮工具循环里第二轮起整个请求体被供应商拒绝
 * `Invalid messages at index 2/3. Messages with role 'tool' must be a response to a preceding
 * message with 'tool_calls'`，而该 400 文本又以"模型的回答"的形式返回给用户（exitReason=success）。
 *
 * 本用例锁住三处曾被剥掉的字段与一处被伪装的失败：
 *  ① ⑥ 步构造 ModelCallInput 时不再只映射 {role, content}；
 *  ② executeLoop 跨轮追加历史时助手消息带 tool_calls、工具结果带 tool_call_id，且两者相邻；
 *  ③ OpenAI 兼容 Provider 的**请求体**（流式与非流式）原样携带工具字段；
 *  ④ 非流式模型调用失败必须走诚实短路，不能把错误文本当正文交给用户并判 success。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const h = vi.hoisted(() => ({ callModel: vi.fn(), callModelStream: vi.fn() }));
vi.mock("../../Src/Core/Model/modelCaller.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../Src/Core/Model/modelCaller.js")
    >();
  return {
    ...actual,
    callModel: h.callModel,
    callModelStream: h.callModelStream,
  };
});

import {
  runIteration,
  executeLoop,
  resetSystemPromptCache,
  createLoopControlView,
} from "../../Src/Core/Loop/runIteration.js";
import { createLoopState } from "../../Src/Core/Loop/loopEngine.js";
import { createLoopConfig } from "../../Src/Core/Loop/loopConfig.js";
import { clearMiddlewares } from "../../Src/Core/Middleware/middlewareRegistry.js";
import { resetRolePrompts } from "../../Src/Services/Prompts/promptRegistry.js";
import { resetEventBus } from "../../Src/Services/EventBus/eventBus.js";
import { OpenAIProvider } from "../../Src/Infra/Llm/Provider/openaiProvider.js";
import type { ChatMessage } from "../../Src/Core/Model/modelCaller.js";
import type { IterationContext } from "../../Src/Core/Loop/runIteration.js";

type WireMsg = {
  role: string;
  content: string;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string }>;
};

function textReply(content: string) {
  return {
    ok: true,
    value: {
      content,
      finish_reason: "stop",
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      model: "test-model",
    },
  };
}

function toolCallReply(id: string, name: string, args: string) {
  return {
    ok: true,
    value: {
      content: "",
      finish_reason: "tool_calls",
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      model: "test-model",
      tool_calls: [
        { id, type: "function", function: { name, arguments: args } },
      ],
    },
  };
}

function baseCtx(
  chatMessages: ChatMessage[],
): Omit<IterationContext, "currentIteration" | "totalTokensConsumed"> {
  const configResult = createLoopConfig({ model: "test-model", stream: false });
  if (!configResult.ok) throw new Error("config");
  return {
    userInput: "读一下文件再回答",
    sessionId: "sess-tool-assembly",
    agentId: "agent-worker-1",
    agentRole: "worker",
    config: configResult.value,
    chatMessages,
    recentCallTimestamps: [],
  };
}

function newLoopState() {
  const configResult = createLoopConfig({ model: "test-model", stream: false });
  if (!configResult.ok) throw new Error("config");
  return createLoopState({
    loopId: "loop-tool-assembly",
    agentId: "agent-worker-1",
    traceId: "trace-tool-assembly",
    config: configResult.value,
  });
}

beforeEach(() => {
  resetSystemPromptCache();
  resetEventBus();
  h.callModel.mockReset();
  h.callModelStream.mockReset();
});

afterEach(() => {
  clearMiddlewares();
  resetRolePrompts();
  vi.unstubAllGlobals();
});

describe("REV-341 ① ⑥ 步不再剥掉历史里的工具字段", () => {
  it("assistant.tool_calls 与 tool.tool_call_id 原样进入模型请求", async () => {
    h.callModel.mockResolvedValueOnce(textReply("已读完。"));
    const seeded: ChatMessage[] = [
      { role: "user", content: "读一下文件" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_9",
            type: "function",
            function: { name: "file.read", arguments: '{"p":"a.txt"}' },
          },
        ],
      },
      { role: "tool", content: "file body", tool_call_id: "call_9" },
    ];
    const result = await runIteration(
      newLoopState(),
      { ...baseCtx(seeded), currentIteration: 1, totalTokensConsumed: 0 },
      createLoopControlView(),
    );
    expect(result.ok).toBe(true);

    const sent = h.callModel.mock.calls[0]![1] as WireMsg[];
    const assistant = sent.find(
      (m) => m.role === "assistant" && m.tool_calls?.length,
    );
    const tool = sent.find((m) => m.role === "tool");
    expect(assistant?.tool_calls?.[0]?.id).toBe("call_9");
    expect(tool?.tool_call_id).toBe("call_9");
  });
});

describe("REV-341 ② 跨轮历史把调用与结果成对补齐", () => {
  it("第二轮请求里助手 tool_calls 紧邻其工具结果", async () => {
    h.callModel
      .mockResolvedValueOnce(toolCallReply("call_1", "nonexistent.tool", "{}"))
      .mockResolvedValueOnce(textReply("收尾。"));

    const result = await executeLoop(
      newLoopState(),
      baseCtx([{ role: "user", content: "先调用工具" }]),
    );
    expect(result.ok).toBe(true);
    expect(h.callModel.mock.calls.length).toBeGreaterThanOrEqual(2);

    const second = h.callModel.mock.calls[1]![1] as WireMsg[];
    const idxAssistant = second.findIndex(
      (m) =>
        m.role === "assistant" &&
        m.tool_calls?.some((tc) => tc.id === "call_1"),
    );
    expect(idxAssistant).toBeGreaterThanOrEqual(0);
    const idxTool = second.findIndex(
      (m) => m.role === "tool" && m.tool_call_id === "call_1",
    );
    expect(idxTool).toBeGreaterThan(idxAssistant);
    // 供应商的硬约束是"结果必须紧跟声明过该调用的助手消息"
    expect(idxTool).toBe(idxAssistant + 1);
    // 结果正文不得是 undefined/空壳（失败工具只有 error 没有 content）
    expect(second[idxTool]!.content).toBeTruthy();
    expect(typeof second[idxTool]!.content).toBe("string");
  });
});

describe("REV-341 ③ Provider 请求体携带工具字段", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call_7",
          type: "function",
          function: { name: "a.b", arguments: "{}" },
        },
      ],
    },
    { role: "tool", content: "ok", tool_call_id: "call_7" },
  ];

  function stubFetch() {
    const seen: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        seen.push(JSON.parse(init.body) as Record<string, unknown>);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: "x",
            object: "chat.completion",
            model: "test-model",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "done" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          body: null,
        };
      }),
    );
    return seen;
  }

  function makeProvider() {
    process.env.TEST_WIRE_KEY = "sk-test";
    return new OpenAIProvider({
      base_url: "https://example.invalid/v1",
      api_key_ref: "env:TEST_WIRE_KEY",
      display_name: "wire-test",
      models: [
        {
          id: "test-model",
          context_window: 8000,
          max_output: 512,
          supports_vision: false,
          supports_tools: true,
          cost_per_1k_input: 1,
          cost_per_1k_output: 1,
        },
      ],
    });
  }

  it("chat（非流式）请求体带 tool_calls 与 tool_call_id", async () => {
    const seen = stubFetch();
    const result = await makeProvider().chat({ model: "test-model", messages });
    expect(result.ok).toBe(true);
    const sent = seen[0]!.messages as WireMsg[];
    expect(sent[2]!.tool_calls?.[0]?.id).toBe("call_7");
    expect(sent[3]!.tool_call_id).toBe("call_7");
    // 无工具字段的普通消息不应多出空键
    expect(sent[1]).not.toHaveProperty("tool_calls");
    expect(sent[1]).not.toHaveProperty("tool_call_id");
  });

  it("chatStream（流式）请求体同样携带", async () => {
    stubFetch();
    const result = await makeProvider().chatStream(
      { model: "test-model", messages },
      () => {
        /* noop */
      },
    );
    // 流式响应的 stub 只给 JSON（非 SSE），装配断言在请求体上，与响应解析结果无关
    const sent = vi.mocked(fetch).mock.calls[0]![1] as { body: string };
    const body = JSON.parse(sent.body) as { messages: WireMsg[] };
    expect(body.messages[2]!.tool_calls?.[0]?.id).toBe("call_7");
    expect(body.messages[3]!.tool_call_id).toBe("call_7");
    expect(result.ok === true || result.ok === false).toBe(true);
  });
});

describe("REV-341 ④ 模型调用失败不得伪装成 final answer", () => {
  it("非流式失败 → 诚实短路（exitReason=model_error，正文为空，错误文本不进正文）", async () => {
    h.callModel.mockResolvedValueOnce({
      ok: false,
      error: "ModelArts.81001 Invalid messages at index 2",
    });

    const loopState = newLoopState();
    const result = await executeLoop(
      loopState,
      baseCtx([{ role: "user", content: "调用工具" }]),
    );

    expect(result.ok).toBe(true);
    // P1-4（2026-10-11 控制论审查）：退出类别不再一律坍缩为 'risk'——模型调用失败是独立类别
    expect(result.value.exitReason).toBe("model_error");
    const outputs = result.value.iterations.map((i) => i.outputText);
    expect(outputs.every((o) => !o.includes("ERROR:"))).toBe(true);
    expect(outputs.every((o) => !o.includes("Invalid messages"))).toBe(true);
    const last = result.value.iterations[result.value.iterations.length - 1]!;
    expect(last.decision.exitReason).toBe("model_error");
    expect(last.shortCircuitReason).toContain("Invalid messages");
  });

  it("失败轮不向历史追加假助手消息（下一轮不会学到错误文本）", async () => {
    const chatMessages: ChatMessage[] = [{ role: "user", content: "调用工具" }];
    h.callModel.mockResolvedValueOnce({
      ok: false,
      error: "HTTP 400 bad request",
    });
    await executeLoop(newLoopState(), { ...baseCtx(chatMessages) });
    expect(
      chatMessages.some(
        (m) => m.role === "assistant" && m.content.includes("ERROR"),
      ),
    ).toBe(false);
  });
});
