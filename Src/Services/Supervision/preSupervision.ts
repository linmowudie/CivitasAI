/**
 * @module Supervision/preSupervision
 * @description
 * 前置监管——Docs/Agent/02 §3 步骤②。
 * 安全注入检测、权限验证、频率限制。
 *
 * 频率限制参数读取 `Configs/supervision.json → supervision.rateLimit`（FE-040：与 HTTP API
 * 限流的 supervision.apiRateLimit 解耦），启动时经 `initPreSupervisionRateLimit()` 注入。
 */

import type { Result } from "../../Infra/types.js";
import { ok } from "../../Infra/types.js";
import type { RateLimitConfig } from "../../Infra/Contracts/rateLimitTypes.js";
import { DEFAULT_RATE_LIMIT_CONFIG } from "../../Infra/Contracts/rateLimitTypes.js";
import { getAgent } from "../../Core/AgentRuntime/agentRegistry.js";
import { isFrozen } from "../Audit/freezeManager.js";
import { recordControlTrigger } from "../../Infra/Logging/controlTriggers.js";

// ── 限流配置注入（FE-040：与 HTTP API 限流解耦，由 main 启动时注入）────

let currentRateLimitConfig: RateLimitConfig = { ...DEFAULT_RATE_LIMIT_CONFIG };

/** 初始化/更新监管限流配置（supervision.rateLimit 段） */
export function initPreSupervisionRateLimit(
  config: Partial<RateLimitConfig> = {},
): void {
  currentRateLimitConfig = { ...DEFAULT_RATE_LIMIT_CONFIG, ...config };
}

/** 前置监管输入 */
export interface PreSupervisionInput {
  userInput: string;
  agentId: string;
  sessionId: string;
  /** 最近 N 次调用的时间戳（用于频率限制） */
  recentCallTimestamps: number[];
  /**
   * 本轮新到达的**不可信内容段**（P2-14 修复）。
   *
   * 修复背景：前置监管每轮检测的 `userInput` 与 Hook 入参同源，**永远是同一条原始输入**，
   * 从不检查模型新产出与工具返回值——于是"工具返回值里的间接注入"这条真实攻击面
   * 完全没有覆盖。调用方（`runIteration` ② 步）应把"最后一条 user 消息之后新出现的
   * 工具结果 / 模型产出"作为不可信段传入。
   */
  untrustedSegments?: ReadonlyArray<{ source: string; content: string }>;
}

/** 前置监管结果 */
export interface PreSupervisionResult {
  passed: boolean;
  /** 注入检测命中 */
  injectionDetected: boolean;
  /** 权限是否通过 */
  permissionOk: boolean;
  /** 频率是否被限制 */
  rateLimited: boolean;
  /** 拒绝原因 */
  rejectReason?: string;
  /** 命中注入的**来源段**（`user-input` / `tool-result` / `model-output` …；诊断用，不含原文） */
  injectionSource?: string;
  /** 命中的模式 id（诊断用，**不记录被检内容**以免把注入原文写进日志） */
  injectionPatternId?: string;
}

/** 将统一限流配置转换为前置监管所需的窗口参数 */
function toWindowParams(config: RateLimitConfig): {
  maxCallsPerWindow: number;
  windowMs: number;
} {
  return {
    maxCallsPerWindow: config.maxRequestsPerMinute,
    windowMs: 60_000,
  };
}

// ── 注入检测（P2-14：从 5 条关键词扩为分类模式表）────────────────────

/**
 * 注入检测模式表。
 *
 * 设计取向：**宁可窄而准**——前置监管命中即 fail-closed 终止本轮 Loop，
 * 误报的代价是把正常任务打断。因此每条都要求较完整的指令性短语，
 * 不做"出现 system 二字即拒绝"这类宽匹配。`id` 用于回传诊断（不记录原文）。
 */
export interface InjectionPatternDef {
  id: string;
  re: RegExp;
}

export const INJECTION_PATTERNS: readonly InjectionPatternDef[] = [
  // ── 对话模板注入标记（**放最前**：最具体的证据优先用于诊断定位）──
  { id: "chatml-marker", re: /<\|im_(start|end)\|>/i },
  { id: "inst-marker", re: /\[\/?INST\]|<<\/?SYS>>/i },
  // 行首 `system: you are (now|a|an|the)…` —— 要求后接角色式断言，避免命中日志里
  // `system: you are here` 这类普通输出（前置监管命中即 fail-closed 终止，误报代价高）
  {
    id: "system-role-marker",
    re: /(^|\n)\s*#{0,4}\s*system\s*:\s*you\s+are\s+(now|a|an|the)\b/i,
  },
  // ── 指令覆盖（英文）──
  {
    id: "ignore-previous-en",
    re: /ignore\s+(all\s+)?(the\s+)?(previous|above|prior)\s+(instructions?|prompts?|rules?)/i,
  },
  {
    id: "disregard-previous-en",
    re: /disregard\s+(all\s+)?(the\s+)?(previous|above|prior)\s+(instructions?|prompts?|rules?)/i,
  },
  {
    id: "forget-instructions-en",
    re: /forget\s+(all\s+)?(your\s+)?(previous\s+)?(instructions?|rules?|prompts?)/i,
  },
  {
    id: "new-instructions-en",
    re: /(^|\n)\s*(new|updated)\s+instructions?\s*[:：]/i,
  },
  // ── 指令覆盖（中文）──
  {
    id: "ignore-previous-zh",
    re: /忽略\s*(以上|之前|前面|先前)\s*(的)?\s*(所有)?\s*(指令|指示|要求|规则)/,
  },
  {
    id: "disregard-previous-zh",
    re: /(无视|不要理会|不必遵守)\s*(以上|之前|前面|先前)\s*(的)?\s*(所有)?\s*(指令|指示|要求|规则)/,
  },
  { id: "forget-role-zh", re: /忘记\s*(你的)?\s*(角色|身份|设定|指令|规则)/ },
  // ── 角色劫持 ──
  { id: "you-are-now-en", re: /you\s+are\s+now\s+(a|an|the)\b/i },
  { id: "now-you-are-zh", re: /你\s*(现在|从现在起)\s*(是|扮演|就是)/ },
  // ── 系统提示词窃取（要求出现 system/initial/hidden 等限定词，避免误伤"打印这份 prompt 模板"之类正常请求）──
  {
    id: "reveal-system-prompt-en",
    re: /(reveal|print|show|repeat|leak|dump)\s+(me\s+)?(your\s+|the\s+)?(system|initial|hidden|original|full)\s+(prompt|instructions?)/i,
  },
  // 中英双语都覆盖两种语序：`输出系统提示词` 与 `把系统提示词输出给我` 都必须命中
  {
    id: "reveal-system-prompt-zh",
    re: /(输出|打印|复述|显示|泄露|告诉我|发给我)\s*(你的)?\s*系统\s*(提示词|提示语|指令|预设)|系统\s*(提示词|提示语|指令|预设)\s*(输出|打印|复述|显示|泄露|发给我|给我)/,
  },
  // ── 越狱 / 绕过安全 ──
  {
    id: "override-safety-en",
    re: /override\s+(the\s+)?(safety|security|guardrails?|restrictions?)/i,
  },
  // `developer mode` 必须与"启用"类动词同现：单独出现时是编辑器/框架的正常术语
  {
    id: "jailbreak-en",
    re: /\bjailbreak\b|\bDAN\s+mode\b|(enable|enter|activate|switch\s+to|turn\s+on)\s+(the\s+)?developer\s+mode/i,
  },
  {
    id: "bypass-safety-zh",
    re: /(绕过|跳过|关闭|解除)\s*(安全|权限|限制|审查|审批)/,
  },
];

/** 单段文本的注入检测：命中返回模式 id，否则 null */
export function scanForInjection(text: string): string | null {
  if (!text) return null;
  for (const p of INJECTION_PATTERNS) {
    if (p.re.test(text)) return p.id;
  }
  return null;
}

/** 单个不可信段的扫描上限（字符）——避免把整套工具输出全文做多轮正则回溯 */
const SEGMENT_SCAN_LIMIT = 20_000;
/** 每轮最多扫描的段数（取最近的 N 段） */
const MAX_SEGMENTS_PER_ROUND = 20;

/**
 * 从消息历史中提取「本轮的不可信新内容」。
 *
 * 口径：**最后一条 `role:'user'` 消息之后**的所有消息——即上一轮/本轮由工具与模型
 * 新产生的工具结果与助手产出。这正是间接注入的入口（工具返回值里夹带指令）。
 */
export function collectUntrustedSegments(
  messages: ReadonlyArray<{ role: string; content: string }>,
): Array<{ source: string; content: string }> {
  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      lastUserIndex = i;
      break;
    }
  }
  const tail = messages.slice(lastUserIndex + 1);
  const recent = tail.slice(-MAX_SEGMENTS_PER_ROUND);
  return recent.map((m) => ({
    source:
      m.role === "tool"
        ? "tool-result"
        : m.role === "user"
          ? "user-input-tail"
          : "model-output",
    content:
      m.content.length > SEGMENT_SCAN_LIMIT
        ? m.content.slice(0, SEGMENT_SCAN_LIMIT)
        : m.content,
  }));
}

/** 执行前置监管 */
export function runPreSupervision(
  input: PreSupervisionInput,
  rateLimitConfig: RateLimitConfig = currentRateLimitConfig,
): Result<PreSupervisionResult> {
  // 安全注入检测（P2-14：先查用户原始输入，再查本轮新到达的不可信内容段）
  const userPatternId = scanForInjection(input.userInput);
  if (userPatternId) {
    recordControlTrigger("injection_detected");
    return ok({
      passed: false,
      injectionDetected: true,
      permissionOk: true,
      rateLimited: false,
      rejectReason: "PROMPT_INJECTION_DETECTED",
      injectionSource: "user-input",
      injectionPatternId: userPatternId,
    });
  }

  // 间接注入：工具返回值 / 模型产出里夹带的指令（修复前这条面完全无覆盖）
  for (const segment of input.untrustedSegments ?? []) {
    const patternId = scanForInjection(segment.content);
    if (!patternId) continue;
    recordControlTrigger("injection_detected");
    return ok({
      passed: false,
      injectionDetected: true,
      permissionOk: true,
      rateLimited: false,
      rejectReason: `PROMPT_INJECTION_DETECTED: ${segment.source}`,
      injectionSource: segment.source,
      injectionPatternId: patternId,
    });
  }

  // 频率限制——使用统一配置转换窗口参数
  const windowParams = toWindowParams(rateLimitConfig);
  const now = Date.now();
  const windowStart = now - windowParams.windowMs;
  const recentCalls = input.recentCallTimestamps.filter(
    (t) => t >= windowStart,
  );
  const rateLimited = recentCalls.length >= windowParams.maxCallsPerWindow;
  if (rateLimited) {
    return ok({
      passed: false,
      injectionDetected: false,
      permissionOk: true,
      rateLimited: true,
      rejectReason: "RATE_LIMIT_EXCEEDED",
    });
  }

  // 权限验证（FE-068 实装：Agent 身份有效性——已驱逐/销毁/挂起一律拒绝；
  //   未注册的调用方（轻量/无注册表场景）保持放行，不引入额外门槛）
  const agent = getAgent(input.agentId);
  if (
    agent &&
    (agent.status === "expelled" ||
      agent.status === "destroyed" ||
      agent.status === "suspended")
  ) {
    return ok({
      passed: false,
      injectionDetected: false,
      permissionOk: false,
      rateLimited: false,
      rejectReason: `AGENT_NOT_PERMITTED: ${input.agentId} 当前状态 ${agent.status}（不可继续执行）`,
    });
  }

  // 审计冻结检查（FE-061 联动：冻结 = 审计执法限制——冻结期 Agent 不可继续执行；
  //   到期自动解冻或经治理端点解冻后恢复）
  if (isFrozen(input.agentId)) {
    return ok({
      passed: false,
      injectionDetected: false,
      permissionOk: false,
      rateLimited: false,
      rejectReason: `AGENT_FROZEN: ${input.agentId} 处于审计冻结期（到期自动解冻或经治理解冻）`,
    });
  }

  return ok({
    passed: true,
    injectionDetected: false,
    permissionOk: true,
    rateLimited: false,
  });
}
