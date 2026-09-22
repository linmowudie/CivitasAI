# Core 层接口文档

> Core 层（引擎层）：主循环、中间件、模型调用、Agent 运行时、决策编排。
> 依赖方向：Core → Services → Tools → Infra

---

## 1. Loop 子模块 (`Src/Core/Loop/`)

### loopEngine.ts

| 函数 | 签名 | 说明 |
|------|------|------|
| `createLoopState` | `(options: LoopEngineOptions) → LoopState` | 创建循环状态 |
| `startLoop` | `(state: LoopState) → Result<LoopState>` | idle → running |
| `pauseLoop` | `(state: LoopState) → Result<LoopState>` | running → paused |
| `resumeLoop` | `(state: LoopState) → Result<LoopState>` | paused → running |
| `terminateLoop` | `(state, reason) → Result<LoopState>` | → completed |
| `failLoop` | `(state, reason) → Result<LoopState>` | → failed |
| `recordLoopEvent` | `(state, step, data?) → LoopEvent` | 记录步骤事件 |
| `assertStepOrder` | `(steps: LoopStep[]) → boolean` | 校验十步顺序 |

### runIteration.ts（P0-1 新增）

| 函数 | 签名 | 说明 |
|------|------|------|
| `runIteration` | `(loopState, ctx: IterationContext) → Promise<Result<IterationResult>>` | 执行一次十步迭代 |
| `executeLoop` | `(loopState, initialCtx) → Promise<Result<LoopExecutionResult>>` | 多轮主循环直到退出 |
| `parseModelOutput` | `(output, callResult?) → { text, toolCalls }` | 解析模型输出 |

### iterationController.ts

| 函数 | 签名 | 说明 |
|------|------|------|
| `decideIteration` | `(state, input: IterationDecisionInput) → IterationDecision` | 迭代决策（5 类退出） |

### loopConfig.ts

| 函数 | 签名 | 说明 |
|------|------|------|
| `validateLoopConfig` | `(config: LoopConfig) → Result<LoopConfig>` | 7 字段校验 |
| `createLoopConfig` | `(overrides?) → Result<LoopConfig>` | 带默认值创建 |
| `createRoleLoopConfig` | `(role: string) → Result<LoopConfig>` | 8 角色覆盖 |

---

## 2. Middleware 子模块 (`Src/Core/Middleware/`)

### middlewareRegistry.ts

| 函数 | 签名 | 说明 |
|------|------|------|
| `registerMiddleware` | `(mw: AgentMiddleware) → Result<void>` | 注册单个中间件 |
| `executePrePostHooks` | `(hook, ctx, ...args) → Promise<{shortCircuited, result?}>` | 执行 before/after 钩子 |
| `executeWrapHooks` | `<I,O>(hook, ctx, input, coreFn) → Promise<O>` | 洋葱模型包裹执行 |

---

## 3. Model 子模块 (`Src/Core/Model/`)

### modelCaller.ts

| 函数 | 签名 | 说明 |
|------|------|------|
| `callModel` | `(model, messages, options?) → Promise<Result<CallResult>>` | 非流式调用（重试+降级） |
| `callModelStream` | `(model, messages, onChunk, options?) → Promise<Result<CallResult>>` | 流式调用 |

---

## 4. AgentRuntime 子模块 (`Src/Core/AgentRuntime/`)

### agentRuntime.ts

> **2026-09-22 校准**：`submitForReview` / `reviewSubmission` 实际均为**对象入参**，返回 `Result<SubmitResult>`（`SubmitResult` 定义于 `Core/AgentRuntime/types.ts`）；`assignTask` 为位置参数且第三参为 `traceId`，返回 `Result<AgentInstance>`。

| 函数 | 签名 | 说明 |
|------|------|------|
| `submitForReview` | `(params: { taskId, workerAgentId, payload }) → Result<SubmitResult>` | Worker 提交审查（:38-42），成功后 `awaitingApproval=true` 并广播 `loop:approval_requested` |
| `reviewSubmission` | `(params: { taskId, reviewerAgentId, accepted, comment? }) → Result<SubmitResult>` | Reviewer 审查（:81-86），广播 `loop:approval_decided`（通过时另发 `task:completed`）；无待审记录/重复审核返回 `err` |
| `assignTask` | `(agentId, taskId, traceId) → Result<AgentInstance>` | 任务分配，`ready → running`（:206） |

---

## 5. Decision 子模块 (`Src/Core/Decision/`)

### orchestrator/orchestrator.ts

> **2026-09-22 校准**：原列 `orchestrate()` **不存在**；实际路径为 `Src/Core/Decision/orchestrator/orchestrator.ts`（目录名小写），编排入口为同步函数 `receiveTask(params)`（:65），端到端流程「评估 → 路由 → 拆解 → 招募 → 执行 → 聚合」，由 `taskApi.submitTask()` 经 `queueMicrotask` 异步触发（taskApi.ts:44-46）。

| 函数 | 签名 | 说明 |
|------|------|------|
| `receiveTask` | `(params: { taskId, traceId, taskDescription, tokenBudget?, timeLimitMs? }) → Result<OrchestrationResult>` | 多 Agent 编排入口（:65） |
| `configureOrchestrator` | `(partial: Partial<OrchestratorConfig>) → void` | 覆盖编排配置（:55） |
| `resetOrchestrator` | `() → void` | 重置内部状态（:324） |

同目录其余子模块：`progressTracker.ts`（进度/异常检测）、`resultAggregator.ts`（`aggregateResults` / `calculateQualityScore`）、`mergePhase.ts`（`executeMergePhase` / `deterministicMerge`）、`conflictPrecheck.ts`（`precheckConflicts`）。
