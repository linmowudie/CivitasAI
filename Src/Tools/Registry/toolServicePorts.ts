/**
 * @module Tools/Registry/toolServicePorts
 * @description
 * **Tools 层服务端口**（依赖倒置收口）——FE-064/066/050/056/058/072 接线后的分层审计产物。
 *
 * 背景：Tools 层不得 import Services/Core（分层红线，`import/no-restricted-paths` 门禁）。
 * 但"统一收口"的设计（toolDispatcher 的缓存/审计 Hook、若干元工具调用业务服务）需要
 * 消费上层能力。解法：本模块持有**端口接口**；组合根 `Src/main.ts`（Interface 层，
 * 装配期可访问任意层）在启动时经 `configureToolServicePorts` 注入真实实现。
 *
 * 未注入时的行为（诚实降级）：
 *  - `toolResultCache` / `dispatchHook`：增强项，静默跳过（不伪造命中）；
 *  - 工具级端口（todoStore / memoryRetrieverFactory / recruitment / review / orchestration）：
 *    对应工具如实返回 `NOT_ENABLED`，不假成功。
 */

import type { Result } from "../../Infra/types.js";

// ── 工具结果缓存端口（FE-064，Services/Cache/toolResultCache 注入）──────────

export interface ToolResultCachePort {
  get: (
    toolName: string,
    input: Record<string, unknown>,
  ) => Result<unknown> | null;
  put: (
    toolName: string,
    input: Record<string, unknown>,
    result: unknown,
  ) => void;
  clear: () => void;
}

// ── Hook 派发端口（FE-066，Services/Hook/hookRegistry.dispatchHook 注入）────

export type DispatchHookPort = (
  event: string,
  data: Record<string, unknown>,
) => Promise<unknown>;

// ── TodoWrite 存储端口（Services/Planning/todoStore 注入）──────────────────

export type TodoStatusPort = "pending" | "in_progress" | "completed";

export interface TodoStorePort {
  /** 单次提交条目上限（Services 侧 MAX_TODOS_PER_AGENT） */
  maxTodos: number;
  replaceTodos: (input: {
    sessionId: string;
    agentId: string;
    agentRole?: string;
    todos: Array<{ content: string; status?: TodoStatusPort }>;
  }) => Result<{
    progress: {
      total: number;
      completed: number;
      pending: number;
      inProgress: number;
    };
  }>;
  listTodosForAgent: (
    sessionId: string,
    agentId: string,
  ) => Array<{ content: string; status: string }>;
}

// ── VectorSearch 检索端口（FE-058，Services/Retrieval/retriever 注入）──────

export interface MemoryRetrieverFragmentPort {
  id: string;
  content: string;
  score: number;
  metadata: Record<string, unknown>;
}

export interface MemoryRetrieverPort {
  retrieve: (query: {
    query: string;
    topK: number;
    minScore: number;
  }) => Promise<Result<{ fragments: MemoryRetrieverFragmentPort[] }>>;
}

export type MemoryRetrieverFactoryPort = () => MemoryRetrieverPort;

/**
 * 记忆写入端口（裁定 (a)，2026-10-14）：Tools 层不得 import Services（分层红线），
 * 故由组合根把 Services 的写实现接到此端口上，供内置工具 `MemoryWrite` 调用。
 * 参数用**原始类型**而非 Services 的联合类型，避免 Tools → Services 的类型依赖。
 */
export type MemoryWritePort = (params: {
  title: string;
  content: string;
  /** 记忆分类（Services 侧收窄为 MemoryCategory） */
  category: string;
  sourceTraceIds: string[];
  /** 断言级别；Services 侧会按 §8.4 拒绝非 observed 的写入 */
  assertion?: string;
}) => Result<{ memoryId: string }>;

// ── AgentRecruit 端口（FE-072，Services/Recruitment/recruiter 注入）────────

export type RecruitableRolePort =
  "worker" | "reviewer" | "partner" | "assembly_node";

export interface RecruitedAgentPort {
  agentId: string;
  role: string;
  status: string;
}

export interface RecruitmentPort {
  getRecruitedAgents: (traceId: string) => Array<{ status: string }>;
  recruitAgent: (input: {
    role: RecruitableRolePort;
    domain: string;
    taskPrompt: string;
    requiredTools: string[];
    tokenBudget: number;
    maxIterations: number;
    timeLimitMs: number;
    traceId: string;
    parentAgentId: string;
  }) => Result<RecruitedAgentPort>;
}

// ── AgentSubmitReview 端口（FE-050/056/057，评审链路服务注入）─────────────

export interface ReviewPort {
  submitForReview: (input: {
    taskId: string;
    workerAgentId: string;
    payload: { summary: string; artifacts: string[]; submittedBy: string };
  }) => Result<{ reviewId?: string }>;
  ensureReviewerAgent: (traceId: string) => Result<{ agentId: string }>;
  performReview: (input: {
    taskId: string;
    reviewerAgentId: string;
  }) => Promise<
    Result<{ status: string; reviewerComment?: string; reviewId?: string }>
  >;
  markSubtaskReviewed: (
    taskId: string,
    accepted: boolean,
    comment?: string,
  ) => void;
}

// ── OrchestratorCompose / select 端口（C6 的工具身份；组合根注入 Core 的组装闭环）──

/**
 * 组装变更的节点声明（**原始类型**，避免 Tools → Core 的类型依赖，同 S4 账本端口的做法）。
 *
 * 注意：`operator` 这里**不写 enum** —— 算子闭集的唯一持有者是
 * `Core/Assembly/assemblyPipeline.ts` 的 `OPERATORS`（判据 `C-OP-1`）。
 * 在工具头部再抄一份闭集，等于制造"两份真源谁都没改"的经典漂移。
 */
export interface AssemblyNodeDeclPort {
  id: string;
  executableRef: string;
  operator?: string;
  body?: string[];
  inputSections?: string[];
  join?: { deps: string[]; onMissing: string };
  plugins?: Array<{
    id: string;
    hooks?: string[];
    conflictDomain: string;
    enabled?: boolean;
  }>;
}

export interface AssemblyChangePort {
  op: "add" | "remove" | "replace";
  target?: string;
  added?: AssemblyNodeDeclPort;
}

/** 拒绝必须带"判据 + 定位"（否则外层无法重选，见 21 §5 反例 10） */
export interface ComposeOutcomePort {
  committed: boolean;
  assemblyId?: string;
  digest?: string;
  violations: Array<{ criterion: string; where: string; reason: string }>;
  /** 未提交时的人读原因（含落盘/审计失败） */
  reason?: string;
}

export interface ExecutableCatalogEntryPort {
  id: string;
  inputSections: string[];
  toolSet: string[];
}

export interface OrchestrationPort {
  /** 当前组装体 id（C5 持有；工具只读不写） */
  currentAssembly(): { id: string; executables: string[] };
  /** 提议 → 校验 → 提交（闭环全在 Core 侧执行；本端口**不得**跳过校验） */
  compose(input: {
    by: string;
    change: AssemblyChangePort;
  }): Promise<Result<ComposeOutcomePort>>;
  /** 执行件目录（S1，只读） */
  catalog(): ExecutableCatalogEntryPort[];
  /** 提名下一个执行件：必须 ∈ 当前组装体；返回**实际**选中（合法性由 Core 收束） */
  select(candidate: string): Result<{ selected: string; reason: string }>;
}

// ── AgentSplit / AgentMerge 端口（G3：分裂与自合并的兄弟账本链路）──────────

/**
 * 分裂/合并的**失败环节标签**（由端口在各自分支上打点，不是工具层的判断）：
 * 没有它，工具只能靠错误文案猜错误码 —— 那是字符串匹配，不是分类。
 */
export type SplitFailure =
  "none" | "peer_open_failed" | "domain_rejected" | "broadcast_failed";
export type MergeFailure = "none" | "request_rejected" | "submit_failed";

export interface SplitOutcomePort {
  /** 净效果：兄弟是否留在域里 */
  splitHappened: boolean;
  failure: SplitFailure;
  peerId?: string;
  conflictDomain: string;
  /** 域进展是否已投递共享上下文（未投递 ⇒ 自合并判定无从发生） */
  sharedPublished: boolean;
  /** 人读原因（成功时为 ''） */
  reason: string;
}

export interface MergeRequestOutcomePort {
  /** 请求是否已被监管受理 */
  submitted: boolean;
  failure: MergeFailure;
  requestId?: string;
  /** 受理号（未受理 ⇒ 无；请求此时已撤销，绝不谎报"已提交"） */
  caseId?: string;
  reason: string;
}

export interface DomainPeerPort {
  peerId: string;
  state: string;
  conflictDomain: string;
}

export interface DomainViewPort {
  rootId: string;
  selfState: string;
  peers: DomainPeerPort[];
  pendingMergeRequests: number;
  dissolved: boolean;
}

/**
 * 分裂语义的端口视图（实现由组合根接到 `Core/AgentRuntime/splitSemantics`）。
 *
 * 工具层不得 import Core（分层红线），故这里只保留工具**实际要上报的字段**，
 * 形态集合用原始字面量联合表达，不复用 Core 的 `MergeKind`。
 */
export interface SplitApprovalOutcomePort {
  /** 治理侧受理号（本端口只登记，**不代表已批准**） */
  approvalId: string;
  status: "pending";
}

export type MergeKindPort = "self_merge" | "peer_merge" | "absorb" | "none";

/**
 * 分裂与自合并的端口（端口实现在 `Core/Orchestration/splitMergeToolPort.ts`，
 * 「按 L1 身份绑定域账本」的解析器在 `Core/Orchestration/l1HostRegistry.ts`，由组合根注入）。
 *
 * 两条形状级约定（都有负向测试）：
 *  - `split` 产出的对端是**同级兄弟**，走域账本（`DomainLedger`），**不进**下级账本；
 *    因此本端口拿不到 `ChildRegistry`（构造上不可见，见 16 §9 规则 2 的同族纪律）。
 *  - `requestMerge` 只**发起请求**并把请求交给监管：`submitted=true` 仅表示**已被受理**，
 *    不表示已合并 —— 工具侧不存在"已合并"这个返回值，合并只能由监管裁决生效（07 §3）。
 *
 * 宿主约束：一个域账本属于**一个** L1 实例（且 `rootId` 必须等于该实例的 agentId，
 * 因为工具把 `context.agentId` 当作发起端）。端口容器是**进程级单例**，所以这里注入的
 * 只能是 `agentId → 端口` 的解析器，不能是一个共享端口 —— 否则两个 L1 会写进同一本域账本。
 * 解析不到的 agentId 返回 `undefined`，工具侧诚实降级为 `NOT_ENABLED`。
 */
export interface SplitMergePort {
  /** 召唤**恰好一个**同级 L1：按冲突域拆，登记兄弟，广播域进展 */
  split(input: {
    conflictDomain: string;
    task: string;
  }): Promise<Result<SplitOutcomePort>>;
  /** 向监管请求合并（absorbedId 缺省=把该兄弟并回发起端）；本端口**不**裁决 */
  requestMerge(input: {
    by: string;
    withPeerId: string;
    absorbedId?: string;
    evidence: string;
  }): Promise<Result<MergeRequestOutcomePort>>;
  /** 域视图（只读） */
  domainView(): DomainViewPort;
  /** 重投域进展（split 广播失败后的补救入口） */
  republishShared(): Promise<Result<void>>;
  /**
   * 登记**分裂授权单**（治理留痕；返回待审批受理号，本端口不伪造"已批准"）。
   * 发起端取本端口绑定的宿主身份，不由工具传入 —— 与 `split` 同源，
   * 避免"工具声称自己是别人"。
   */
  requestSplitApproval(input: {
    conflictDomain: string;
    task: string;
  }): Result<SplitApprovalOutcomePort>;
  /** 登记一对同级关系（分裂成功后写入，供 `mergeKind` 判定） */
  registerPeerSplit(peerId: string): void;
  /** 合并形态判定（自合并 / 同级合并 / 吸收 / 不可合并）；仅标注，裁决归监管 */
  mergeKind(peerId: string): MergeKindPort;
}

// ── 端口容器 ────────────────────────────────────────────────────────

export interface ToolServicePorts {
  toolResultCache?: ToolResultCachePort;
  dispatchHook?: DispatchHookPort;
  todoStore?: TodoStorePort;
  memoryRetrieverFactory?: MemoryRetrieverFactoryPort;
  memoryWrite?: MemoryWritePort;
  recruitment?: RecruitmentPort;
  review?: ReviewPort;
  orchestration?: OrchestrationPort;
  splitMergeFor?: (agentId: string) => SplitMergePort | undefined;
  /**
   * 沙箱承载门（TOOL-SEC-SANDBOX，设计 §3.1）。
   * 未注入时：声明 `sandboxMode !== 'none'` 的工具一律 fail-closed
   * （`SANDBOX_UNAVAILABLE`）——安全边界不得因"宿主忘了声明"而降级为普通执行。
   */
  sandboxGate?: import("./sandboxGate.js").SandboxGatePort;
}

let ports: ToolServicePorts = {};

/** 注入/局部更新端口（组合根启动时调用；重复调用按字段合并） */
export function configureToolServicePorts(partial: ToolServicePorts): void {
  ports = { ...ports, ...partial };
}

/** 读取当前端口（Tools 内部使用） */
export function getToolServicePorts(): Readonly<ToolServicePorts> {
  return ports;
}

/** 清空全部端口（测试隔离用） */
export function resetToolServicePorts(): void {
  ports = {};
}
