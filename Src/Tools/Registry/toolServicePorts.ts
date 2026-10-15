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
 *  - 工具级端口（todoStore / memoryRetrieverFactory / recruitment / review）：
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

// ── todo.write 存储端口（Services/Planning/todoStore 注入）──────────────────

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

// ── vector.search 检索端口（FE-058，Services/Retrieval/retriever 注入）──────

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
 * 故由组合根把 Services 的写实现接到此端口上，供内置工具 `memory.write` 调用。
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

// ── agent.recruit 端口（FE-072，Services/Recruitment/recruiter 注入）────────

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

// ── agent.submit_review 端口（FE-050/056/057，评审链路服务注入）─────────────

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

// ── 端口容器 ────────────────────────────────────────────────────────

export interface ToolServicePorts {
  toolResultCache?: ToolResultCachePort;
  dispatchHook?: DispatchHookPort;
  todoStore?: TodoStorePort;
  memoryRetrieverFactory?: MemoryRetrieverFactoryPort;
  memoryWrite?: MemoryWritePort;
  recruitment?: RecruitmentPort;
  review?: ReviewPort;
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
