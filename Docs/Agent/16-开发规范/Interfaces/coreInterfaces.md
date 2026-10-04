# Core 层接口文档

> Core 层（引擎层）：主循环、中间件、模型调用、Agent 运行时、决策编排。
> 依赖方向：Core → Services → Tools → Infra
>
> **2026-10-03 校准**：
> ① 全文行号引用改为「文件名 + 函数/符号名」锚点（绝对行号随代码漂移即失效）；
> ② 各节按 `Src/Core/**` 实际导出补齐，原表仅登记"代表函数"，读者易误判接口面全貌；
> ③ 修正三处失真描述——`validateLoopConfig` 的"7 字段校验"、`createRoleLoopConfig` 的"8 角色覆盖"来源、`AgentMiddleware` 契约类型归属（ADR-0006 已迁 Infra/Contracts）；
> ④ 分层方向声明复查仍成立：`Src/Core/**` 对 `Src/Interface/**` 的 import 为 0（ESLint `import/no-restricted-paths` 唯一禁令）。

---

## 1. Loop 子模块 (`Src/Core/Loop/`)

> **2026-10-03 校准**：桶文件 `Src/Core/Loop/index.ts` 再导出各文件主入口与全部公共类型，但**不含** `runIteration.ts` 的 `buildStableSystemPrompt` / `resetSystemPromptCache` / `mapStoppedReasonToExitReason`（需按文件路径直连）；`Core` 层门面为 `Src/Core/index.ts` 的 `Loop` 命名空间。

### loopEngine.ts

| 函数 | 签名 | 说明 |
|------|------|------|
| `createLoopState` | `(options: LoopEngineOptions) → LoopState` | 创建循环状态（内部即调 `createIterationState(config.max_iterations, config.token_budget)`） |
| `startLoop` | `(state: LoopState) → Result<LoopState>` | idle → running |
| `pauseLoop` | `(state: LoopState) → Result<LoopState>` | running → paused |
| `resumeLoop` | `(state: LoopState) → Result<LoopState>` | paused → running |
| `terminateLoop` | `(state, reason) → Result<LoopState>` | → completed（`reason` 当前未落库，形参 `_reason`） |
| `failLoop` | `(state, reason) → Result<LoopState>` | → failed（同上 `_reason`） |
| `recordLoopEvent` | `(state, step, data?) → LoopEvent` | 记录步骤事件，并刷新 `lastActivityAt` |
| `assertStepOrder` | `(steps: LoopStep[]) → boolean` | 校验十步顺序（只禁回退，允许缺步/重复） |
| `getLoopSummary` | `(state: LoopState) → Record<string, unknown>` | 运行态快照（phase/iteration/token 消耗/elapsedMs/exitReason）——**2026-10-03 校准补录** |

导出类型：`LoopPhase`（`'idle' | 'running' | 'paused' | 'completed' | 'failed'`）、`LoopState`、`LoopStep`（十步 `'① InputReceived' … '⑩ IterationDecision'`）、`LoopEvent`、`LoopEngineOptions`。

> ⚠️ 命名冲突提示（**2026-10-03 校准**）：`Loop/loopEngine.ts` 的 `LoopPhase`（5 值运行态机）与 `AgentRuntime/types.ts` 的 `LoopPhase`（6 值业务阶段）同名不同集，引用时须看清出处。

### runIteration.ts（P0-1 十步主循环执行器）

| 函数 | 签名 | 说明 |
|------|------|------|
| `runIteration` | `(loopState, ctx: IterationContext) → Promise<Result<IterationResult>>` | 执行一次十步迭代 |
| `executeLoop` | `(loopState, initialCtx: Omit<IterationContext, 'currentIteration' \| 'totalTokensConsumed'>) → Promise<Result<LoopExecutionResult>>` | 多轮主循环直到退出；进入时注册 `ToolSafetyGate` 中间件、`finally` 中 `unregisterMiddleware('ToolSafetyGate')` |
| `parseModelOutput` | `(output, callResult?) → { text, toolCalls: ParsedToolCall[] }` | 优先读原生 `tool_calls`，回退 ```` ```tool_call ```` JSON 块 |
| `buildStableSystemPrompt` | `(toolNames: string[], cache = true) → string` | 前缀稳定系统提示（静态段 + 按名排序工具目录，字节级一致以利提供商前缀缓存）——**2026-10-03 校准补录** |
| `resetSystemPromptCache` | `() → void` | 清系统提示缓存（测试/诊断入口）——**2026-10-03 校准补录** |
| `mapStoppedReasonToExitReason` | `(reason: StoppedReason) → ExitReason` | StopRules 7 值 → 运行期 ExitReason 5 值映射（Docs/Agent/11 §2.2 枚举收敛过渡）——**2026-10-03 校准补录** |

跨层引用的四个类型（Interface 层调用 `runIteration`/`executeLoop` 的契约形态，**2026-10-03 校准补录**）：

| 类型 | 字段（必填 / 可选） |
|------|---------------------|
| `IterationContext` | 必填 `userInput` `sessionId` `agentId` `agentRole` `config: LoopConfig` `currentIteration` `totalTokensConsumed` `chatMessages: ChatMessage[]` `recentCallTimestamps: number[]`；可选 `workDir` `signal?: AbortSignal` `onToolCallStart` `onToolCallResult` `onStreamChunk` `onToolCallPending` `onIterationComplete` `loopControlSnapshot?: Partial<LoopRuntimeSnapshot>` `contextStore?: ContextStore` |
| `ParsedToolCall` | `id` `name` `arguments: Record<string, unknown>` |
| `IterationResult` | 必填 `outputText` `toolCalls` `toolResults: ToolResult[]` `tokensConsumed` `decision: IterationDecision` `steps: LoopStep[]` `events: LoopEvent[]` `shortCircuited`；可选 `stopDecision?: StopDecision` `shortCircuitReason` |
| `LoopExecutionResult` | `iterations: IterationResult[]` `totalTokensConsumed` `totalToolCalls` `totalMs` `allEvents: LoopEvent[]`；可选 `exitReason` `exitMessage` |

### iterationController.ts

| 函数 | 签名 | 说明 |
|------|------|------|
| `createIterationState` | `(maxIterations, tokenBudget) → IterationState` | 迭代状态初始化——**2026-10-03 校准补录** |
| `decideIteration` | `(state, input: IterationDecisionInput) → IterationDecision` | 迭代决策（5 类退出，判定序：risk → budget_exhausted → max_iterations → success → no_progress；副作用：`current++`、累计 token、`consecutiveNoToolCalls`） |
| `getIterationStats` | `(state: IterationState) → Record<string, unknown>` | 迭代统计（含 `tokenUsageRatio` / `elapsedMs`）——**2026-10-03 校准补录** |

导出类型：`ExitReason`（5 值）、`IterationState`、`IterationDecisionInput`、`IterationDecision`。

### loopConfig.ts

> **2026-10-03 校准**：`validateLoopConfig` 说明由"7 字段校验"更正为 **6 字段校验 + 硬上限**；`createRoleLoopConfig` 的"8 角色覆盖"来源更正为 **配置注入**（非代码常量）。

| 函数 / 常量 | 签名 | 说明 |
|------------|------|------|
| `validateLoopConfig` | `(config: LoopConfig) → Result<LoopConfig>` | 校验 6 个字段：`model`（非空 string）、`max_iterations`（≥1）、`timeout_ms`、`temperature`（∈[0,2]）、`token_budget`（≥1）、`stream`（boolean）；另按 `LOOP_LIMITS` 施三项硬上限（`max_iterations ≤ 200`、`token_budget ≤ 2_000_000`、`timeout_ms ∈ [5_000, 600_000]`）；失败返回 `INVALID_CONFIG: …`。**⚠️ 不校验 `pauseSignal`**（见下差异登记） |
| `createLoopConfig` | `(overrides?) → Result<LoopConfig>` | `{ ...DEFAULT_LOOP_CONFIG, ...overrides }` 后调 `validateLoopConfig` |
| `createRoleLoopConfig` | `(role: string) → Result<LoopConfig>` | 读 `getRoleOverrides()[role]`；未命中即 `err('INVALID_CONFIG: Unknown role: …')`。**覆盖集来自 `Configs/loopConfig.json → roleOverrides`（8 角色：prime_director / partner / worker / reviewer / assembly_node / arbitrator / auditor / regulator），由 `Src/main.ts` 启动时 `setRoleOverrides()` 注入**；未注入时 `getRoleOverrides()` 返回 `{}`，任何 role 都报错 |
| `DEFAULT_LOOP_CONFIG` | `LoopConfig` | workerModel / 30 轮 / 60_000ms / 0.2 / 100_000 / stream=true——**2026-10-03 校准补录** |
| `LOOP_LIMITS` | `LoopLimits` | 硬上限可变对象（默认值对齐 `Configs/loopConfig.json → hardLimits`）——**2026-10-03 校准补录** |
| `setLoopLimits` | `(limits: Partial<LoopLimits>) → void` | 由 `main.ts` 读 `hardLimits` 段后注入，消除双源漂移——**2026-10-03 校准补录** |
| `getLoopLimits` | `() → LoopLimits` | 返回硬上限快照（浅拷贝）——**2026-10-03 校准补录** |
| `setRoleOverrides` | `(overrides: Record<string, Partial<LoopConfig>>) → void` | 注入 role 覆盖（`main.ts` 启动序列 ⑮）——**2026-10-03 校准补录** |
| `getRoleOverrides` | `() → Record<string, Partial<LoopConfig>>` | 仅使用注入值，未注入返回 `{}`——**2026-10-03 校准补录** |
| `ROLE_OVERRIDES` | `Record<string, Partial<LoopConfig>>` | **`@deprecated`** Proxy，转发 `getRoleOverrides()`，仅为兼容旧引用而存——**2026-10-03 校准补录** |

导出类型：`LoopConfig`、`LoopLimits`。

> ⚠️ 差异登记 + 待办（**2026-10-03 校准**，不裁决）：`LoopConfig.pauseSignal?: AbortController` 是接口字段但 `validateLoopConfig` 不校验，且主循环不使用它——实际中止路径是 `IterationContext.signal: AbortSignal`（`executeLoop` 检查 `initialCtx.signal?.aborted`）。**待办**：`pauseSignal` 应"纳入校验并接线"还是"从契约中删除"，需人工裁定后回写本文与 `Docs/Agent/14-参数总典`。

---

## 2. Middleware 子模块 (`Src/Core/Middleware/`)

### middlewareRegistry.ts

> **2026-10-03 校准**：原表只登记 3 个函数，补齐至 9 个；同文件的 `clearMiddlewares` / `unregisterMiddleware` 是测试隔离与热卸载入口，属公开契约。

| 函数 | 签名 | 说明 |
|------|------|------|
| `registerMiddleware` | `(mw: AgentMiddleware) → Result<void>` | 校验 `name`/`hook`/`execute` 后入队；同名返回 `DUPLICATE_ENTRY` |
| `registerMiddlewares` | `(list: AgentMiddleware[]) → Result<number>` | 批量注册，任一失败即返回该 `err`（已注册项**不回滚**）——**2026-10-03 校准补录** |
| `getMiddlewaresForHook` | `(hook: MiddlewareHook) → AgentMiddleware[]` | 按 hook 过滤出**副本**并按 `priority` 升序返回（不改动注册表本体顺序）——**2026-10-03 校准补录** |
| `getAllMiddlewares` | `() → AgentMiddleware[]` | 浅拷贝全量——**2026-10-03 校准补录** |
| `getMiddlewareCount` | `() → number` | 计数——**2026-10-03 校准补录** |
| `clearMiddlewares` | `() → void` | 清空（测试隔离入口）——**2026-10-03 校准补录** |
| `unregisterMiddleware` | `(name: string) → void` | 按名注销（`executeLoop` 用它摘除 `ToolSafetyGate`）——**2026-10-03 校准补录** |
| `executePrePostHooks` | `(hook, ctx, ...args) → Promise<{ shortCircuited, result? }>` | 顺序执行 before/after 钩子；命中 `shortCircuit` 或 `beforeModel` 通过时发布 `middleware:before_model` 事件 |
| `executeWrapHooks` | `<I,O>(hook, ctx, input, coreFn) → Promise<O>` | 洋葱模型包裹执行（逆序组装 `next` 链） |

**契约类型出处**（**2026-10-03 校准**，ADR-0006）：`AgentMiddleware`、`MiddlewareHook`、`MiddlewareContext`、`ModelCallInput`/`ModelCallOutput`、`ToolCallInput`/`ToolCallOutput`、`HookFunction` 及六个钩子函数类型**定义在 `Src/Infra/Contracts/middlewareTypes.ts`**，经 `Src/Infra/Contracts/index.ts` 门面 `export * from './middlewareTypes.js'` 暴露；`Src/Core/Middleware/index.ts` 对这批契约类型**仅为再导出**（`export type { … } from '../../Infra/Contracts/middlewareTypes.js'`），Core 侧不再持有定义（该桶另再导出注册表 8 个函数与 4 个内置中间件）。请勿在 `Core/Middleware` 下找 `AgentMiddleware`。
⚠️ 桶面不一致（**2026-10-03 校准** 登记）：`Middleware/index.ts` 的注册表再导出**漏了 `unregisterMiddleware`**（本文件 9 个导出的第 9 个），消费方（`Loop/runIteration.ts`）按文件路径直连。

### 2.1 内置中间件清单 `builtin/`（**2026-10-03 校准** 新增小节）

原文只描述 `middlewareRegistry.ts`，未登记 `builtin/` 的 6 个文件。

| 中间件 | hook / priority | 附带导出 | 注册现状 |
|--------|-----------------|----------|----------|
| `goalReanchorMiddleware` | `beforeModel` / 10 | — | `main.ts` 启动时 `registerMiddleware` |
| `fingerprintDetectorMiddleware` | `afterModel` / 10 | `computeOutputFingerprint(output) → string` | `main.ts` 注册 |
| `budgetSentinelMiddleware` | `wrapModelCall` / 50 | `BUDGET_WARNING_THRESHOLD = 0.8`、`BUDGET_CRITICAL_THRESHOLD = 0.95` | `main.ts` 注册 |
| `rateLimiterMiddleware` | `wrapToolCall` / 30 | `initRateLimiter(cfg)`、`getRateLimiterStatus()`、`resetRateLimiter()`（配置源 `Configs/supervision.json → supervision.rateLimit`） | `main.ts` 注册 |
| `failureInjectorMiddleware` | `wrapToolCall` / 100 | `FailureInjectionConfig` 类型 | ⚠️ **经 `builtin/index.ts` 导出但 `main.ts` 未注册**（故障注入用途，需调用方显式注册） |

> `builtin/index.ts` 的再导出**不含 `rateLimiterMiddleware`**（`main.ts` 走文件直连），桶面与实态不一致——**2026-10-03 校准** 登记。
> 另注：审批门 `createToolSafetyGateMiddleware` 属 Services 层（`Src/Services/LoopControl/middleware/toolSafetyGate.ts`），由 `executeLoop` 运行时注册，不在 `builtin/`。

### 2.2 toolCallClassifier.ts（**2026-10-03 校准** 新增小节）

| 函数 | 签名 | 说明 |
|------|------|------|
| `inferSubgroup` | `(toolName: string) → ToolSubgroup` | 由工具名前缀推断子组：`'read' \| 'write' \| 'exec' \| 'system'` |
| `assessRiskLevel` | `(toolName: string, args?) → RiskLevel` | 静态风险分级：`'low' \| 'medium' \| 'high' \| 'critical'` |

已是跨层消费点：`Src/Interface/IpcBridge/ipcBridge.ts` 直接 `import { inferSubgroup, assessRiskLevel } from '../../Core/Middleware/toolCallClassifier.js'`。
⚠️ 该模块**未列入 `Src/Core/Middleware/index.ts` 桶导出**，消费方按文件路径直连——**2026-10-03 校准** 登记。

---

## 3. Model 子模块 (`Src/Core/Model/`)

### modelCaller.ts

| 函数 | 签名 | 说明 |
|------|------|------|
| `callModel` | `(qualifiedModel, messages, options?) → Promise<Result<CallResult>>` | 非流式调用（重试+降级）；`options = { temperature?, max_tokens?, signal?, tools? }` |
| `callModelStream` | `(qualifiedModel, messages, onChunk, options?) → Promise<Result<CallResult>>` | 流式调用；同一 `options` 形态 |

导出类型：`CallResult`、`StreamChunk`、`ChatMessage`（三者实现在 `Src/Infra/Llm/Provider/providerBase.ts`，本模块仅类型再导出）。

**同目录其余模块**（**2026-10-03 校准** 补录；桶导出列为实际状态）：

| 模块 | 导出 | 是否在 `Model/index.ts` 桶中 |
|------|------|------------------------------|
| `streamParser.ts` | `parseSseStream`、`StreamTimeoutError`、类型 `StreamParserConfig`/`StreamParseResult`/`ChunkHandler` | ✓ 已再导出 |
| `abortSignal.ts` | `createManagedAbortController`、`mergeAbortSignals`、`createTimeoutAbortController`、`isAborted`、`getAbortSource`、类型 `AbortSource`/`ManagedAbortController` | ✓ 已再导出 |
| `contextHistory.ts` | `buildContextHistory`、类型 `ContextMessage` | ✗ 未进桶，消费方按文件路径直连（`Src/Interface/IpcBridge/ipcBridge.ts` 用 `buildContextHistory`） |
| `sessionNamer.ts` | `sanitizeSessionName`、`fallbackSessionName`、`generateSessionName`、`MAX_SESSION_NAME_LENGTH = 24`、类型 `NamingProvider`/`GenerateSessionNameOptions` | ✗ 未进桶，`ipcBridge.ts` 直连 `generateSessionName`/`fallbackSessionName` |

---

## 4. AgentRuntime 子模块 (`Src/Core/AgentRuntime/`)

### agentRuntime.ts

> **2026-09-22 校准**：`submitForReview` / `reviewSubmission` 实际均为**对象入参**，返回 `Result<SubmitResult>`（`SubmitResult` 定义于 `Core/AgentRuntime/types.ts`）；`assignTask` 为位置参数且第三参为 `traceId`，返回 `Result<AgentInstance>`。
> **2026-10-03 校准**：上述签名与副作用复查**全部仍成立**；原文三处行号（`:38-42` / `:81-86` / `:206`）各漂移 −1 行，故**改为函数名锚点**，不再标行号。同文件另有 5 个导出未登记，现已补齐。

| 函数 | 签名 | 说明 |
|------|------|------|
| `submitForReview` | `(params: { taskId, workerAgentId, payload }) → Result<SubmitResult>` | Worker 提交审查；要求 `role === 'worker'` 且 `status === 'running'`；成功后 `updateAgent(workerAgentId, { awaitingApproval: true })` 并广播 `loop:approval_requested` |
| `reviewSubmission` | `(params: { taskId, reviewerAgentId, accepted, comment? }) → Result<SubmitResult>` | Reviewer 审查（要求 `role === 'reviewer'`）；广播 `loop:approval_decided`，通过时另发 `task:completed` 并把 Worker 转 `ready`、拒绝时 `consecutiveFailures++`；无待审记录 / 重复审核返回 `err` |
| `assignTask` | `(agentId, taskId, traceId) → Result<AgentInstance>` | 任务分配，`ready → running`；写入 `currentLoopId = loop-${taskId}` 并广播 `task:assigned` |
| `isTaskApproved` | `(taskId: string) → boolean` | Director 侧查询任务是否已过审——**2026-10-03 校准补录** |
| `getPendingReview` | `(taskId: string) → PendingReview \| undefined` | 待审记录快照（浅拷贝）——**2026-10-03 校准补录** |
| `getPendingReviewCount` | `() → number` | 仅计 `status === 'pending'`——**2026-10-03 校准补录** |
| `handleAgentEvent` | `(agentId, event: AgentEvent) → Result<AgentStatus>` | Agent 状态机统一入口；转 `running`/`destroyed`/`expelled` 时分别广播 `agent:ready`/`agent:destroyed`/`agent:expelled`——**2026-10-03 校准补录** |
| `resetAgentRuntime` | `() → void` | 清空待审队列（测试隔离入口）——**2026-10-03 校准补录** |

⚠️ `getPendingReview` 的返回类型 `PendingReview` 是 `agentRuntime.ts` 内的**非导出**局部接口，也未出现在 `AgentRuntime/index.ts` 桶导出中，外部只能按结构推断（字段：`taskId` `workerAgentId` `submittedAt` `payload` `status: 'pending'|'accepted'|'rejected'` `reviewerComment?`）——**2026-10-03 校准** 登记。

### types.ts（Core 对外的构造/结果契约，**2026-10-03 校准** 展开）

| 类型 | 形态 |
|------|------|
| `AgentStatus` | 6 值：`creating` / `ready` / `running` / `suspended` / `expelled` / `destroyed` |
| `LoopPhase` | 6 值：`planning` / `acting` / `verifying` / `awaiting_approval` / `completed` / `failed`（与 `Loop/loopEngine.ts` 同名类型**不同集**） |
| `StoppedReason` | 7 值：`success` / `limits` / `budget_soft` / `budget_hard` / `no_progress` / `risk` / `human_abort`（运行期映射见 `Loop/runIteration.ts#mapStoppedReasonToExitReason`） |
| `AgentRole` | = `Infra/types.ts` 的 `UserRole`（8 角色单一真相源，本文件再导出 `UserRole`） |
| `AgentInstance` | 必填 `agentId` `role` `status` `model` `createdAt` `updatedAt` `consecutiveFailures` `awaitingApproval`；可选 `traceId` `currentLoopId` `walletId` `lastTaskId` |
| `CreateAgentParams` | `{ role: AgentRole; model: string; taskId?: string; parentAgentId?: string }`——Core 对外的构造契约 |
| `SubmitResult` | 必填 `taskId` `agentId` `status: 'submitted' \| 'accepted' \| 'rejected'`；可选 `reviewerComment` `reviewedAt` |
| `AgentEvent` | 9 个判别联合：`INIT_COMPLETE` / `TASK_ASSIGNED{taskId}` / `TASK_COMPLETED` / `TASK_FAILED{reason}` / `SUSPEND{reason}` / `RESTORE` / `EXPEL{reason}` / `DESTROY` / `RECRUIT{newAgentId}` |

### 同目录其余模块（**2026-10-03 校准** 补录；均经 `AgentRuntime/index.ts` 桶导出）

| 模块 | 导出 |
|------|------|
| `stateMachine.ts` | `transition`、`canTransition`、`getAvailableEvents`、`getNextStates` |
| `agentRegistry.ts` | `registerAgent`、`getAgent`、`getAllAgents`、`getAgentsByStatus`、`getAgentsByRole`、`getReadyWorkers`、`updateAgentStatus`、`updateAgent`、`unregisterAgent`、`getAgentCount`、`getStatusSummary`、`resetAgentRegistry` |
| `agentFactory.ts` | `createAgent`、`createAgentBatch`、`resetAgentFactory` |

---

## 5. Decision 子模块 (`Src/Core/Decision/`)

### orchestrator/orchestrator.ts

> **2026-09-22 校准**：原列 `orchestrate()` **不存在**；实际路径为 `Src/Core/Decision/orchestrator/orchestrator.ts`（目录名小写），编排入口为同步函数 `receiveTask(params)`，端到端流程「评估 → 路由 → 拆解 → 招募 → 执行 → 聚合」。
> **2026-10-03 校准**：`orchestrate()` 全库 0 命中、目录小写两项复查**仍成立**；原行号引用（`receiveTask :65` / `configureOrchestrator :55` / `resetOrchestrator :324` / `taskApi.ts:44-46`）已漂移或失准，**改为符号锚点**：`receiveTask`、`configureOrchestrator`、`resetOrchestrator`，触发点为 `Src/Interface/RestApi/taskApi.ts` 的 `submitTask()` 内 `queueMicrotask(() => receiveTask({ taskId, traceId, taskDescription }))`。

| 函数 | 签名 | 说明 |
|------|------|------|
| `receiveTask` | `(params: { taskId, traceId, taskDescription, tokenBudget?, timeLimitMs? }) → Result<OrchestrationResult>` | 多 Agent 编排入口（同步）；首步 `initProgressTracker()`，发 `task:received` → `assessComplexity` → `decideRoute` → 按 `route.mode` 分支（`DIRECT` / `DELEGATION` / `ASSEMBLY_LINE` / `CONSORTIUM`），其余模式返回 `err('路由模式 … 尚未实现（S12）')` |
| `configureOrchestrator` | `(partial: Partial<OrchestratorConfig>) → void` | 浅合并覆盖编排配置 |
| `resetOrchestrator` | `() → void` | 重置配置为 `DEFAULT_CONFIG` + `resetProgressTracker()` + `resetAggregator()` |

导出类型 `OrchestratorConfig`：`defaultTokenBudget`（默认 30000）、`defaultTimeLimitMs`（默认 5 分钟）、`directorModel`（`'director-model'`）、`workerModel`（`'worker-model'`）、`maxRetries`（2）。
四个模式执行分支 `executeDirect` / `executeDelegation` / `executeAssemblyLine` / `executeConsortium` 为**模块私有**（未导出）。`Decision/types.ts#RoutingMode` 共 6 值，`receiveTask` 的 `switch` 只实现 `DIRECT` / `DELEGATION` / `ASSEMBLY_LINE` / `CONSORTIUM`，`LITIGATION` 与 `REGULATION` 走 `default` 返回 `err('路由模式 … 尚未实现（S12）')`。四个已实现分支都只做编排侧动作（建 Agent / 拆解 / 招募 / 登记进度）并回 `status: 'success'`，实际执行由主循环驱动（Phase 0-2 语义）；其中**仅 `DELEGATION`** 额外调用 `assignTask` 并发布 `task:decomposed` / `task:assigned` 事件——**2026-10-03 校准** 补注。

⚠️ 层门面提示（**2026-10-03 校准** 登记，不作裁决）：`Src/Core/index.ts` 把 `Decision` 命名空间指向 `Decision/types.js`，**不含 `receiveTask`**；跨层调用只能按文件路径直连。该直连与分层白名单议题在 `servicesInterfaces.md` 登记【需人工裁定】，本文只记录 Core 侧接口实态。

### 同目录其余子模块（**2026-10-03 校准** 由"一句话点名"扩为完整导出面）

`orchestrator/progressTracker.ts` —— 进度与异常检测，10 个函数 + 1 常量 + 1 类型：

| 函数 | 签名要点 |
|------|----------|
| `initProgressTracker` | `() → void`（`receiveTask` 首步即调） |
| `registerAssignment` | `(assignment: TaskAssignment) → void` |
| `updateProgress` | `(assignmentId, agentId: string \| null, updates: Partial<AgentProgress>) → void` |
| `getProgress` | `(assignmentId) → AgentProgress \| undefined` |
| `getAllProgress` | `() → AgentProgress[]` |
| `checkTimeouts` | `(timeLimitMs) → AnomalyReport[]` |
| `checkStagnation` | `() → AnomalyReport[]` |
| `checkConsecutiveFailures` | `() → AnomalyReport[]` |
| `detectAllAnomalies` | `(timeLimitMs?) → AnomalyReport[]`（聚合三类检测） |
| `resetProgressTracker` | `() → void`（测试隔离契约） |
| `TRACKER_THRESHOLDS` | `stagnationTimeoutMs=300000` / `loopSimilarityThreshold=0.85` / `loopConsecutiveCount=3` / `consecutiveFailureLimit=3` |

`orchestrator/resultAggregator.ts` —— `aggregateResults({ taskPlan, subtaskResults }) → Result<AggregatedResult>`、`calculateQualityScore({ l1PassRate, l2PassRate, l3RubricScore? }) → number`（L3 存在时 0.4/0.3/0.3 加权）、`resetAggregator() → void`（**补录**）。

`orchestrator/mergePhase.ts` —— `executeMergePhase({ taskId, traceId, failedAgentIds? }) → Result<MergePhaseResult>`、`deterministicMerge({ workspaces }) → { mergedFiles, conflicts }`、`resetMergePhase() → void`（**补录**）、类型 `MergePhaseResult`。

`orchestrator/conflictPrecheck.ts` —— `precheckConflicts({ taskId, traceId }) → Result<ConflictReport>`、`hasConflicts(taskId) → boolean`（**补录**）、`getConflictingFiles(taskId) → string[]`（**补录**）、`resetConflictPrecheck() → void`（**补录**）、类型 `ConflictReport`/`FileConflict`。

> `reset*` 四件套（`resetProgressTracker` / `resetAggregator` / `resetMergePhase` / `resetConflictPrecheck`）是测试隔离契约，其中前两个由 `resetOrchestrator()` 串联调用。

### Decision 目录其余模块

`complexityAssessor/complexityAssessor.ts`（`assessComplexity`）、`routeDecision/routeDecision.ts`（`decideRoute`）与 `routeDecision/routingRules.ts`、`TaskDecomposer/taskDecomposer.ts`（`decomposeTask`）。

`Decision/types.ts` 的全部 14 个导出（**2026-10-03 校准** 补全；`Src/Core/index.ts` 的 `Decision` 命名空间即指向此文件）：`RoutingMode`（6 值，其中 `LITIGATION` / `REGULATION` ⚠️ 未实现，属 S12 目标态）、`ComplexityReport`、`RoutingRulesConfig`、`RouteDecisionResult`、`TaskAssignment`、`AssignmentStatus`、`TaskPlan`、`AgentProgress`、`SubtaskResult`、`AggregatedResult`、`RecruitmentRequest`、`TerminationRationale`、`TerminationReason`、`OrchestrationResult`。

---

## 修订记录

| 日期 | 说明 |
|------|------|
| 2026-09-22 | 首轮文档-代码对账校准：§4 `submitForReview`/`reviewSubmission` 改对象入参并注明返回 `Result<SubmitResult>`、`assignTask` 第三参为 `traceId`；§5 删除虚构 `orchestrate()`、入口更正为 `orchestrator/orchestrator.ts` 的 `receiveTask`。 |
| 2026-10-03 | 按 `Docs/Dev/Agent-16-开发规范接口契约-差别清单.md` Core 层条目 C-01～C-10 回写：C-01 `validateLoopConfig` 改述为"6 字段校验 + `LOOP_LIMITS` 三项硬上限"，并把 `pauseSignal` 不校验登记为 ⚠️ 差异+待办；C-02 `createRoleLoopConfig` 的 8 角色覆盖来源更正为 `Configs/loopConfig.json → roleOverrides` + `main.ts` 注入（`ROLE_OVERRIDES` 已 `@deprecated`）；C-03 §1 补齐 `getLoopSummary` / `createIterationState` / `getIterationStats` / `buildStableSystemPrompt` / `resetSystemPromptCache` / `mapStoppedReasonToExitReason` 与 `DEFAULT_LOOP_CONFIG`/`LOOP_LIMITS`/`set·getLoopLimits`/`set·getRoleOverrides`，并展开 `IterationContext`/`ParsedToolCall`/`IterationResult`/`LoopExecutionResult` 四类型字段表；C-04 `middlewareRegistry` 补录 6 个导出；C-05 注明 `AgentMiddleware` 等契约类型已按 ADR-0006 迁至 `Infra/Contracts/middlewareTypes.ts`；C-06 新增 §2.1 内置中间件清单（含注册现状）与 §2.2 `toolCallClassifier` 跨层消费点；C-07 全部行号引用改为符号锚点；C-08 §4 补录 `isTaskApproved`/`getPendingReview`/`getPendingReviewCount`/`handleAgentEvent`/`resetAgentRuntime` 与 `types.ts` 八类型字段表、登记 `PendingReview` 未导出；C-09 §5 四处行号更正并复查 `orchestrate()` 不存在结论仍成立；C-10 §5 同目录其余子模块扩为完整导出面（含四个 `reset*` 与 `initProgressTracker`）。另补 §3 `Model/` 同目录其余模块、§4 AgentRuntime 同目录其余模块、层门面 `Core/index.ts` 的 `Decision` 命名空间实指 `types.js` 之现状记录。 |
