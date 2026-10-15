/**
 * @module Benchmarks/runner/stubProvider
 * @description
 * 脚本化 LlmProvider —— Benchmark 的**确定性模型替身**。
 *
 * 为什么这样设计（而不是 mock `callModel`）：
 *  - `LlmProvider` 是抽象基类、`registerProvider` 可注册任意实现，因此桩 Provider 能
 *    驱动**真实的 `executeLoop`**（十步主循环、中间件、安全门、Token 账本、退出判定全都真跑），
 *    只是模型侧可控；
 *  - 测试系统用 `vi.mock` 替换模块，那是"测函数"的手法；Benchmark 要测的是 **Agent 行为**，
 *    必须让回路本身完整运行，否则观测到的不是 Agent 的行为；
 *  - 桩模式**无需 API Key、可复现**；真实模型只是同一套判据下的可选模式。
 *
 * 用途：把"模型该说什么"变成数据（`ScriptedTurn[]`），从而**注入**任意行为
 * ——正常收敛、反复调同一工具（极限环）、工具参数写错、模型侧 5xx/429……
 */

import { LlmProvider } from "../../Src/Infra/Llm/Provider/providerBase.js";
import type {
  CallOptions,
  CallResult,
  ProviderConfig,
  StreamChunk,
} from "../../Src/Infra/Llm/Provider/providerBase.js";
import type { Result } from "../../Src/Infra/types.js";
import { ok, err } from "../../Src/Infra/types.js";
import type { ScriptedTurn } from "./types.js";

/** 桩模型全限定名（场景的 `loop.model` 用的就是它） */
export const STUB_PROVIDER_NAME = "bench-stub";
export const STUB_MODEL_ID = "scripted";
export const STUB_MODEL = `${STUB_PROVIDER_NAME}/${STUB_MODEL_ID}`;

/** 粗略 token 估算（chars/4，与 Core/Loop 的口径一致） */
function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function promptSize(options: CallOptions): {
  promptTokens: number;
  messageCount: number;
  toolSchemaCount: number;
  hasReanchor: boolean;
} {
  let chars = 0;
  let hasReanchor = false;
  for (const m of options.messages) {
    chars += (m.content?.length ?? 0) + (m.tool_calls ? 60 : 0);
    if (m.content?.includes(REANCHOR_MARKER)) hasReanchor = true;
  }
  return {
    promptTokens: estimateTokens("x".repeat(chars)),
    messageCount: options.messages.length,
    toolSchemaCount: Array.isArray(options.tools) ? options.tools.length : 0,
    hasReanchor,
  };
}

const CONFIG: ProviderConfig = {
  provider: STUB_PROVIDER_NAME,
  base_url: "stub://benchmark",
  api_key_ref: "inline:benchmark-stub",
  display_name: "Benchmark Scripted Provider",
  models: [
    {
      id: STUB_MODEL_ID,
      context_window: 128_000,
      max_output: 4_096,
      supports_vision: false,
      supports_tools: true,
      cost_per_1k_input: 0,
      cost_per_1k_output: 0,
    },
  ],
};

/** 桩 Provider 观察到的调用记录（供轨迹采集与诊断） */
export interface StubCallRecord {
  index: number;
  messageCount: number;
  toolSchemaCount: number;
  promptTokens: number;
  /** 本轮回给模型的请求里是否已含"压缩后重锚"段（约束保持面的判定信号） */
  hasReanchor: boolean;
}

/** 重锚段的特征串（`GoalReanchorControl` 的完整版标题） */
const REANCHOR_MARKER = "【任务原始目标";
/** 上下文压缩器的系统提示特征（用于把"内部摘要调用"与"Agent 回合"分开） */
const INTERNAL_SUMMARY_MARKER = "上下文压缩器";
/** 内部摘要调用的固定返回（确定性；内容无意义，只是让压缩链路能走完） */
const INTERNAL_SUMMARY_TEXT =
  "（压缩摘要）已完成初步读取，路径涉及 src/notes.txt 与 src/config.json；剩余：汇报关键参数。";

export class ScriptedProvider extends LlmProvider {
  private cursor = 0;
  /** 桩自身记录的调用序列（诊断"上下文是否在增长/是否被压缩"用） */
  readonly callRecords: StubCallRecord[] = [];

  constructor(
    private readonly script: ScriptedTurn[],
    /** 脚本耗尽后的兜底回复（保证回路总能终止，不会真的无限转） */
    private readonly defaultReply: string = "（脚本已耗尽）任务完成。",
    /** 上下文窗口（tokens）；小窗口用于确定性触发上下文压缩 */
    contextWindow: number = 128_000,
  ) {
    super({
      ...CONFIG,
      models: [
        {
          ...CONFIG.models[0]!,
          context_window: Math.max(1, Math.floor(contextWindow)),
        },
      ],
    });
  }

  /** 已消费的脚本步数 */
  get consumed(): number {
    return this.cursor;
  }

  private buildResult(
    turn: ScriptedTurn,
    options: CallOptions,
  ): Result<CallResult> {
    const { promptTokens, messageCount, toolSchemaCount, hasReanchor } =
      promptSize(options);
    this.callRecords.push({
      index: this.cursor,
      messageCount,
      toolSchemaCount,
      promptTokens,
      hasReanchor,
    });

    if (turn.kind === "error") {
      // 模型侧失败：由 Core 的 retry/降级链路处理（与真实供应商同一条路径）
      return err(`${turn.category}: ${turn.message}`);
    }

    if (turn.kind === "tool_calls") {
      const content = turn.content ?? "";
      const toolCalls = turn.calls.map((c, i) => ({
        id: `bench-call-${this.cursor}-${i}`,
        type: "function",
        function: {
          name: c.name,
          arguments: JSON.stringify(c.arguments ?? {}),
        },
      }));
      return ok({
        content,
        finish_reason: "tool_calls",
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: estimateTokens(
            content + JSON.stringify(toolCalls),
          ),
          total_tokens:
            promptTokens + estimateTokens(content + JSON.stringify(toolCalls)),
        },
        model: STUB_MODEL_ID,
        tool_calls: toolCalls,
      });
    }

    const content = turn.content;
    const completion = estimateTokens(content);
    return ok({
      content,
      ...(turn.reasoning ? { reasoning_content: turn.reasoning } : {}),
      finish_reason: "stop",
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completion,
        total_tokens: promptTokens + completion,
      },
      model: STUB_MODEL_ID,
    });
  }

  private next(options: CallOptions): Result<CallResult> {
    // 内部调用（上下文压缩摘要）不消费脚本回合：脚本描述的是 **Agent 的回合**，
    // 让压缩摘要吃掉一个回合会让场景语义错位（"第 N 轮说了什么"变得不可预期）。
    if (this.isInternalSummary(options)) {
      return this.buildResult(
        { kind: "text", content: INTERNAL_SUMMARY_TEXT },
        options,
      );
    }
    const turn = this.script[this.cursor];
    this.cursor += 1;
    if (!turn) {
      // 脚本耗尽：给一句最终答复，让回路按 success 正常收尾
      return this.buildResult(
        { kind: "text", content: this.defaultReply },
        options,
      );
    }
    return this.buildResult(turn, options);
  }

  /** 是否为上下文压缩器发起的内部调用（按系统提示特征识别；CallOptions 不透传 purpose） */
  private isInternalSummary(options: CallOptions): boolean {
    const first = options.messages[0];
    return (
      !!first &&
      first.role === "system" &&
      (first.content ?? "").includes(INTERNAL_SUMMARY_MARKER)
    );
  }

  async chat(options: CallOptions): Promise<Result<CallResult>> {
    return this.next(options);
  }

  async chatStream(
    options: CallOptions,
    onChunk: (chunk: StreamChunk) => void,
  ): Promise<Result<CallResult>> {
    const result = this.next(options);
    if (result.ok) {
      // 逐段吐字，模拟真实流式（也顺带走一遍 streamParser 的拼接路径）
      const content = result.value.content;
      if (content) onChunk({ delta: content });
      onChunk({
        delta: "",
        finish_reason: result.value.finish_reason,
        usage: result.value.usage,
      });
    }
    return result;
  }
}
