/**
 * @module Benchmarks/runner/types
 * @description
 * Benchmark 运行器的场景 / 轨迹契约。
 *
 * 定位（与 `Tests/` 严格分工）：
 *  - `Tests/**` 测传统 bug 与业务正确性（对象 = 函数/模块）；
 *  - `Benchmarks/**` 测 **Agent 能力**（对象 = 一个 Agent 跑一个任务），
 *    观测的是**行为**：是否收敛、工具用得对不对、约束有没有丢、崩了能不能续、成本纪律。
 *
 * 两层结构（用户口径：过了实验矩阵才到打分矩阵）：
 *   场景 ──▶【实验矩阵】逐 cell 判定通过与否 + 观测值 ──▶ 未过则诊断归因，不进评分
 *                                                        └─ 过了 ──▶【打分矩阵】加权评分
 */

// ── 桩模型脚本 ──────────────────────────────────────────────────────

/** 脚本化的模型回合（桩 Provider 按顺序消费） */
export type ScriptedTurn =
  /** 纯文本回复（无工具调用 → 按 final answer 判 success） */
  | { kind: "text"; content: string; reasoning?: string }
  /** 发起工具调用（可附带正文） */
  | {
      kind: "tool_calls";
      calls: Array<{ name: string; arguments?: Record<string, unknown> }>;
      content?: string;
    }
  /** 模型侧失败（用于故障注入：网络/5xx/限流/鉴权） */
  | { kind: "error"; category: string; message: string };

// ── 场景定义 ────────────────────────────────────────────────────────

/** 探针工具声明（Benchmark 自带，避免依赖真实文件系统/网络） */
export interface ScenarioToolSpec {
  /** 工具名（脚本里的 `calls[].name` 引用它） */
  name: string;
  /** 行为：ok=正常返回；fail=返回错误结果；slow=延迟后返回 */
  behavior?: "ok" | "fail" | "slow";
  /** slow 行为的延迟毫秒 */
  delayMs?: number;
  /**
   * 声明为 DANGEROUS + IRREVERSIBLE —— 用于验证"危险且不可逆的工具必经审批门"。
   * 这类工具在真实系统里会走 `toolSafetyGate` 的**阻塞式**审批。
   */
  dangerous?: boolean;
}

/** 实验矩阵的准入判据（每一条都对应一个 cell 的 oracle） */
export interface ScenarioExpect {
  /** 声明的真实调用探针必须全部通过（缺一条即判据失败，不许静默跳过） */
  assertProbesMustPass?: string[];
  /** 期望的退出类别（`ExitReason` 取值） */
  exitReason?: string;
  /**
   * 期望退出类别之一（任一命中即通过）。
   * 用于"如实终止即可"的缺口/收敛类 cell：例如无进展盘旋，可能被
   * 迭代控制的 no_progress 检出，也可能先撞上迭代上限 —— 两者**都算如实退出**，
   * 真正要禁止的是"挂起不动"和"伪装成 success"。
   */
  exitReasonOneOf?: string[];
  /** 迭代轮数上限（收敛性：超了即为失败） */
  maxIterations?: number;
  /** 必须出现过的工具名 */
  mustCallTools?: string[];
  /** 禁止出现的工具名 */
  forbiddenTools?: string[];
  /** 期望的工具结果条数（工具调用与结果必须成对） */
  minToolResults?: number;
  /** 诊断结论里**不允许**出现的问题类型（如无故障场景里不该出现 tool_loop） */
  forbidDiagnoses?: string[];
  /**
   * 场景**故意制造**的问题形态（不算缺陷，降级为 info）。
   * 例：故障恢复场景会故意让工具连失败两次，`tool_misuse` 是它的输入而不是它的结论。
   */
  allowDiagnoses?: string[];
  /** 至少有一轮发给模型的请求里必须出现这些片段（约束保持面：压缩后是否重锚） */
  requestMustContain?: string[];
  /** 整轮跑完后不可变区（goal / immutableConstraints）必须与初始一致（ADR-0005） */
  goalMustBeIntact?: boolean;
  /** Token 四源账本对账必须无差异（`ledger_mismatch === 0`，P0-3 自检） */
  ledgerClean?: boolean;
  /** 必须有危险工具经审批门（`approval_gate_invoked > 0`）—— 治理面被测路径的硬证据 */
  approvalGateRequired?: boolean;
  /** 这些事件类型必须至少产出 1 条（可观测面：治理/安全链路真的在产事件） */
  requiredEvents?: string[];
  /**
   * 记忆治理探针的期望（按探针 id 逐条判定）。
   * `mustReject` = 写侧必须拒绝；`mustStore` = 必须落库（用于对照，证明拒绝不是"什么都拒"）。
   */
  memoryExpect?: Array<{
    id: string;
    mustReject?: boolean;
    mustStore?: boolean;
    note?: string;
  }>;
  /**
   * 检索质量阈值。**阈值必须来自基线首跑**（文档 §5 明确要求），因此这里是可选字段：
   * 未声明即只采集不判定，避免"先写死一个漂亮阈值"。
   */
  retrieval?: { minRecallAtK?: number; minMrr?: number };
  /**
   * L5：DB 不可用期间发生的持久化失败**必须留痕**（日志里能找到），不得静默丢弃。
   * 这是"不静默丢弃"的可判定形态 —— 停 Loop 那一半需要写 journal 的副作用工具，探针工具压不到。
   */
  dbFailureMustBeLogged?: boolean;
  /** L5：时钟回拨必须被检出，且单调时钟不得倒退 */
  clockSkewDetected?: boolean;
  /**
   * L5 幂等重放：同一工具被执行体调用的次数不得超过上限。
   * `maxExecutions: 1` = 第二次同参调用必须**命中幂等缓存**（不产生第二次副作用）。
   */
  idempotentReplay?: { tool: string; maxExecutions: number };
}

/** 一个 Benchmark 场景 = 任务 + 桩模型脚本 + 注入的故障 + 准入判据 */
export interface Scenario {
  id: string;
  title: string;
  /** 能力标签：convergence / tool-use / constraint-retention / recovery / governance / cost */
  tags: string[];
  task: { description: string; goal?: string };
  agentRole?: string;
  loop?: {
    maxIterations?: number;
    tokenBudget?: number;
    timeoutMs?: number;
    stream?: boolean;
    /** 打开上下文压缩（约束保持面实验） */
    compress?: boolean;
    /** 压缩触发阈值（tokens，估算法与运行期一致 = chars/4） */
    compressTriggerTokens?: number;
  };
  /** 运行前冻结该 Agent（治理面实验：应被前置监管拒绝） */
  freezeBeforeRun?: boolean;
  /**
   * 在第 N 轮结束时**直接置位** `loopState.needsGoalReanchor = true`（约束保持面实验）。
   *
   * 为什么不靠"真触发压缩"来置位：压缩是否触发取决于有效窗口占用率水位线，
   * 在实验台里要凑出确定的触发比例，比测**重锚链路本身**难得多，且一旦调参失败就分不清
   * "压缩没触发"与"重锚坏了"。这条注入通道把两件事解耦：本通道测链路，
   * "压缩是否触发"另有 `Tests/Core/loopMemoryFixes.spec.ts` 在回路层覆盖。
   */
  injectReanchorAfterIteration?: number;
  /**
   * 实验台扮演**审批人**：轮询待决审批并自动批准（`forceApprove`）。
   * 用于验证"危险且不可逆的工具确实落在审批门的阻塞路径上"——
   * 真实系统里这一步由人/前端完成，实验台必须把角色补上，否则场景会卡到 60s 超时。
   */
  approveDangerousTools?: boolean;
  tools?: ScenarioToolSpec[];
  /** 场景级 fixture 内容（`bench.read` 的数据源）。
   * 声明式覆盖默认 fixture —— 安全面实验要靠它把**注入载荷**放进工具返回值，
   * 从而验证"间接注入是否在下一轮被前置监管拦下"。
   */
  fixtures?: Record<string, string>;
  /** 记忆治理探针（运行前依次执行；观测写侧红线/乐观锁/冲突裁决） */
  memoryProbes?: MemoryProbe[];
  /**
   * 真实调用探针 id 列表（见 runner/assertProbes.ts）。
   * 与 staticRecon 的静态对账相对：这些是**真的调用产品公共 API 并读返回值**，
   * 因而可以支撑 attestation=executed 的覆盖声明，而非 attestation=static。
   */
  assertProbes?: string[];
  /** 检索质量套件（运行前 seeding + 逐查询计算 Recall@K / MRR） */
  retrievalSuite?: { goldenSet: string };
  /**
   * L5 混沌注入：在第 N 轮结束时**关闭数据库**，模拟"库不可用/满盘"。
   * 用于验证"持久化失败必须留痕，不得静默丢弃"。
   */
  closeDbAfterIteration?: number;
  /**
   * L5 混沌注入：把系统时钟**回拨** N 毫秒，验证时钟回拨检测是否触发、
   * 且 `monotonicMs()`（基于 performance.now）不受影响。
   */
  clockSkewProbe?: { rewindMs: number };
  model: {
    script: ScriptedTurn[];
    defaultReply?: string;
    /**
     * 桩模型的上下文窗口（tokens）。**小窗口**是触发上下文压缩的确定性手段：
     * 压缩策略按"有效窗口占用率"决策（水位线），窗口越小越早触发——
     * 这比压 token 阈值更贴近真实（真实压缩就该由窗口压力驱动）。
     */
    contextWindow?: number;
  };
  expect: ScenarioExpect;
}

// ── 轨迹（观测面）──────────────────────────────────────────────────

/** 单轮观测 */
export interface TurnTrace {
  index: number;
  /** 十步序列是否严格按序 */
  stepOrderOk: boolean;
  toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>;
  toolResultStatuses: string[];
  outputChars: number;
  tokensConsumed: number;
  exitReason?: string;
  /** 本轮请求里的消息条数（观察上下文增长/压缩） */
  promptMessageCount: number;
}

/** 一次场景运行的完整轨迹 */
/** 真实调用探针的结果 */
export interface MemWriteResult {
  input: Record<string, unknown>;
  ok: boolean;
  code?: string;
  message?: string;
}

export interface AssertProbeResult {
  id: string;
  passed: boolean;
  detail: string;
}

export interface RunTrace {
  scenarioId: string;
  scenarioTitle: string;
  tags: string[];
  startedAt: string;
  durationMs: number;
  /** 运行期异常（非 agent 行为失败） */
  fatalError?: string;
  exitReason?: string;
  exitMessage?: string;
  iterations: TurnTrace[];
  totalIterations: number;
  totalTokensConsumed: number;
  totalToolCalls: number;
  /** 元监控计数（来自 `Infra/Logging/controlTriggers`） */
  controlTriggers: Record<string, number>;
  /** 桩 Provider 观测：每次调用看到的历史规模（诊断上下文漂移用） */
  modelCalls: Array<{
    index: number;
    messageCount: number;
    toolSchemaCount: number;
  }>;
  /** 每轮请求是否含"压缩后重锚"段（约束保持面的可判定信号） */
  reanchorPerCall: boolean[];
  /**
   * 工具**执行体**被调用的次数（按工具名）。
   * 与 `totalToolCalls` 的区别：缓存命中时结果是有的、但执行体不再跑 ——
   * 只有这个计数能证明"第二次副作用被幂等挡住了"（L5 幂等重放实验的判据）。
   */
  toolExecutions: Record<string, number>;
  /** 事件类型 → 条数（可观测面的观测值：治理/安全/审计链路是否真的在产事件） */
  eventTypes: Record<string, number>;
  /** 事件按发生顺序的类型序列（用于"按序产出"，上限 200 条防爆报告） */
  eventSequence: string[];
  /** 记忆治理探针的观测结果（系统轴 · 记忆面） */
  memoryProbes: MemoryProbeResult[];
  /** 真实调用探针的结果（证据形态 executed，区别于静态对账） */
  assertProbes: AssertProbeResult[];
  /**
   * 记忆写入实验结果：由 Agent 经 `bench.memwrite`（转交真实 `memory.write`）驱动，
   * 记录每次的入参与结果（含被拒 code/message）—— 不再直调 Services 写 API。
   */
  memoryWriteResults: MemWriteResult[];
  /** 检索质量结果（系统轴 · 检索系统；未声明检索套件时为 null） */
  retrieval: RetrievalSummary | null;
  /**
   * L5 混沌注入的观测：DB 被关闭后持久化失败是否留痕。
   * `matchedLines` 是日志里命中失败标记的行（截断保存）。
   */
  dbFailureEvidence: {
    injected: boolean;
    logFiles: number;
    matchedLines: string[];
  };
  /** L5 时钟回拨观测（未声明探针时为 null） */
  clockSkew: {
    rewound: boolean;
    rewindMs: number;
    detected: boolean;
    /** 检出的事件里报告的漂移毫秒（取首条） */
    driftMs: number | null;
    /** 单调时钟是否也发生了倒退（应恒为 false） */
    monotonicWentBackward: boolean;
  } | null;
  /** 运行结束后不可变区是否与初始一致（ADR-0005） */
  goalIntact: boolean;
  /** 场景期望（回填，便于报告自解释） */
  expect: ScenarioExpect;
}

// ── 判定 / 评分 / 诊断 ──────────────────────────────────────────────

/**
 * 记忆治理探针（系统轴的记忆面实验）
 *
 * 为什么不是"场景"而是"探针"：记忆写侧的红线/乐观锁/冲突裁决是**判定点**，
 * 只能直接调用写 API 才能压到（当前检索结果不进 prompt，Agent 行为层压不到写侧）。
 * 这与能力轴的分工一致：能力轴测 Agent 行为，系统轴测判定点。
 */
export interface MemoryProbe {
  /** 对应 `Benchmarks/datasets/memoryPoison.json` 的 seed id */
  id: string;
  via: "global-workspace" | "long-term-memory";
  /** global-workspace 必填 */
  key?: string;
  /** long-term-memory 必填 */
  title?: string;
  content: string;
  category?: string;
  assertion?: string;
  expectedVersion?: number;
  actorRole?: string;
}

/** 探针执行结果（观测值） */
export interface MemoryProbeResult {
  id: string;
  rejected: boolean;
  stored: boolean;
  error?: string;
}

/** 检索质量实验结果（系统轴 · 检索系统） */
export interface RetrievalSummary {
  goldenSet: string;
  goldenVersion: string;
  corpusSize: number;
  seeded: number;
  queryCount: number;
  /** 参与指标计算的查询数（期望为空的边界查询不计入） */
  scoredQueries: number;
  /** 指标口径的 K（Recall@K） */
  k: number;
  meanRecallAtK: number | null;
  mrr: number | null;
  queries: Array<{
    id: string;
    query: string;
    topK: number;
    expected: string[];
    returned: string[];
    /** 期望为空的查询记为 null（它们测的是阈值边界，不是排名质量） */
    recallAtK: number | null;
    reciprocalRank: number | null;
  }>;
}

/** 探针的执行结果观测 */
export interface MemoryCheckResult {
  id: string;
  passed: boolean;
  detail: string;
}
export interface CheckResult {
  /** 判据 id（可作为实验矩阵 cell id） */
  id: string;
  passed: boolean;
  detail: string;
  /** 观测值（进报告与基线） */
  observed?: number | string;
}

/** 问题诊断结论 */
export interface Diagnosis {
  /** 问题类型 */
  type:
    | "no_progress" // 空转：多轮无新增进展
    | "tool_loop" // 工具调用重复（极限环）
    | "tool_misuse" // 工具选择/参数错误
    | "tool_pairing" // 调用与结果不成对
    | "context_drift" // 上下文/目标漂移
    | "budget_leak" // 成本失控 / 越过预算
    | "false_success" // 退出类别与真实终止原因不符
    | "step_order" // 十步序列被破坏
    | "recovery_missing" // 注入故障后未能自愈/收敛
    | "none";
  severity: "info" | "warning" | "critical";
  detail: string;
  /** 症状出现的位置（第几轮 / 哪个工具） */
  evidence?: string;
}

/** 打分矩阵的单维得分 */
export interface DimensionScore {
  dimension: string;
  score: number;
  weight: number;
  reason: string;
  /**
   * 本场景是否**真的压到了**该维度。
   * false = 不适用（既不给分也不占权重）——防止"没测过的能力"被算成满分能力。
   */
  applicable: boolean;
}

/** 一次运行的两层结果 */
export interface RunResult {
  trace: RunTrace;
  checks: CheckResult[];
  /** 实验矩阵是否放行（全部准入判据通过） */
  admitted: boolean;
  diagnoses: Diagnosis[];
  scores: DimensionScore[];
  /** 加权总分（0-1）；未放行时为 null */
  totalScore: number | null;
  grade: string | null;
}
