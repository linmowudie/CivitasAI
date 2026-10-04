# Agent 编排引擎设计

> 本文档定义 Prime Director 的编排引擎，包括意图识别、复杂度评估、路由决策、任务拆解、Agent 招募/管理、进度追踪和结果汇总的完整设计。

---

## 1. 职责边界

> **v2.2 修订**：编排引擎不再限于 Prime Director 独占，所有 L1 入口级 Agent（Prime Director + Partner）均具备编排能力。治理三权（Regulator/Auditor/Arbitrator）不参与编排，仅在冲突时介入。

> **2026-10-03 校准**：下表为**职责清单**，非"已实现清单"。按当前代码，本表中真正接入编排主流程的只有「复杂度评估 / 路由决策 / 任务拆解 / 路由分发 / 返回结果」五步；
> 「Agent 招募」「进度追踪」「质量验收」「结果汇总」「Token 结算」四项**编排链路内零调用**（详见 §3.1、§6、§7 各节 ⚠️ 标注）。
> **关于"Agent 招募（仅 L1 可操作）"**——现状记录：L1 门禁只存在于 `agent.recruit` 工具 Spec 的 `requiredRoles: ['prime_director','partner']`（`Src/Tools/Custom/agentRecruiter.ts`，2026-10-03 已从 S10 桩改为真实实现），
> 服务层 `recruitAgent()` 仅校验 `traceId / parentAgentId / tokenBudget`，**不校验调用者角色**；编排器更直接调用 `createAgent()`，连招募服务都未走，因此该约束对现网路径既未生效也未被验证。
> **待办**：由编排负责人裁定在 `createAgent()` / `recruitAgent()` 增加 `callerRole` 参数校验，或把本行职责限定为"仅工具层 L1 可招募"。

| 职责 | 说明 |
|------|------|
| 需求解析 | 接收用户需求，理解意图 |
| 复杂度评估 | 评估任务难度、Token 消耗、所需专业域 |
| 路由决策 | 根据评估结果选择路由模式（后端 `RoutingMode` 6 成员，实际可路由仅 4 种，见 §4） |
| 任务拆解 | 将复杂任务分解为可分配的子任务 |
| Agent 招募 | 根据子任务需求招募/雇佣合适的 Agent（仅 L1 可操作） |
| 进度追踪 | 监控各 Agent 的执行状态和进度 |
| 质量验收 | 评估 Agent 交付物的质量 |
| 结果汇总 | 整合各子任务结果，生成最终交付物 |
| Token 结算 | 任务完成后触发 Token 分润 |

**不负责：** Token 扣减（由 TokenEconomy 服务负责）、仲裁裁决（由 Arbitration 服务负责）、异常稽查（由 Audit 服务负责）。

---

## 2. 编排引擎核心组件

```
┌────────────────────────────────────────────────────────┐
│                   Orchestrator                          │
│                                                        │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐ │
│  │ Complexity   │  │ Route        │  │ Task         │ │
│  │ Assessor     │→ │ Decision     │→ │ Decomposer   │ │
│  └──────────────┘  └──────────────┘  └──────────────┘ │
│         ↑                                   ↓          │
│  ┌──────────────┐                  ┌──────────────┐   │
│  │ Prompt       │                  │ Agent        │   │
│  │ Templates    │                  │ Manager      │   │
│  └──────────────┘                  └──────────────┘   │
│                                          ↓            │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐ │
│  │ Progress     │  │ Quality      │  │ Result       │ │
│  │ Tracker      │← │ Inspector    │← │ Aggregator   │ │
│  └──────────────┘  └──────────────┘  └──────────────┘ │
└────────────────────────────────────────────────────────┘
```

> 上图为**概念视图**，框内名称非真实类名（`AgentManager` / `QualityInspector` 全库不存在）。真实的函数名与模块路径见 §2.1。

### 2.1 组件定义

> **2026-09-22 校准**：原表以「类名」列列出 `AgentManager`、`QualityInspector`，两者**全库不存在**；其余组件在代码中亦为**自由函数**而非类。现改列真实函数名与模块路径，并补「实现状态」列。
>
> **2026-10-03 校准**：①目录大小写按仓库实际拼写更正——真实目录为 `complexityAssessor/`、`routeDecision/`（首字母小写），仅 `TaskDecomposer/` 大写；`orchestrator.ts` 的 import 亦为小写。
> **待办**：`Tests/Decision/multiAgentOrchestration.spec.ts`、`Tests/E2E/*.spec.ts` 仍以 `Orchestrator/`、`RouteDecision` 大写路径引用，Linux/CI 大小写敏感环境下会解析失败，需由测试负责人统一改为小写。
> ②本表**取消精确行号**，改为「文件 + 导出符号」定位，以免类型债清偿类改动造成行号漂移。
> ③原表遗漏「工作区隔离 / worktree 合并」「合并阶段」两个已存在模块，现补入末两行。

| 组件 | 实现（函数 / 模块路径） | 职责 | 实现状态 |
|------|----------------------|------|---------|
| 复杂度评估器 | `assessComplexity()` · `Core/Decision/complexityAssessor/complexityAssessor.ts` | 分析任务复杂度，输出结构化评估报告 | ✅ 已实现，但为**关键词启发式**（Phase 0-2），尚未接 LLM；`Prompts/` 下亦无 `complexityAssessment.md` |
| 路由决策器 | `decideRoute()` · `Core/Decision/routeDecision/routeDecision.ts` | 根据评估报告 + 规则选择路由模式 | ✅ 已实现（纯函数，非类）；⚠️ 规则**并非"可配"**，运行期取进程内硬编码 `DEFAULT_RULES`（`routeDecision/routingRules.ts`），详见 §3.3 校准注 |
| 任务拆解器 | `decomposeTask()` · `Core/Decision/TaskDecomposer/taskDecomposer.ts` | 将任务拆解为子任务，生成任务分配书 | ✅ 已实现 |
| Agent 生命周期管理 | 创建 `createAgent()` · `Core/AgentRuntime/agentFactory.ts`；注册/查询 `Core/AgentRuntime/agentRegistry.ts`；招募 `recruitAgent()` / 开除 `expelAgent()` / 替换 `expelAndReplace()` · `Services/Recruitment/recruiter.ts` | 招募/开除/状态管理 Agent 实例 | ⚠️ 原类名 `AgentManager` 全库不存在；能力由上述函数式 API 分担。⚠️ **编排链路不调用 `recruitAgent()`**，四个 Handler 一律直接 `createAgent()`（见 §3.1 [4]） |
| 进度追踪器 | `initProgressTracker()` / `registerAssignment()` / `updateProgress()` / `checkTimeouts()` / `checkStagnation()` / `checkConsecutiveFailures()` / `detectAllAnomalies()` · `Core/Decision/orchestrator/progressTracker.ts` | 监控各 Agent 执行状态，检测超时/异常 | ⚠️ 函数齐备但**链路未闭合**：`orchestrator.ts` 只 import 并调用 `initProgressTracker()` / `registerAssignment()`，五个异常检测函数**零生产调用者**；且 `TASK_STARTED/TASK_PROGRESS/TASK_FAILED` 全仓无发布者（见 §6.1） |
| 质量验收 | 四级 Verifier · `Services/LoopControl/verifier/`（`hardVerifier` / `ruleVerifier` / `llmJudge` / `humanGateCore` / `antiGaming`）+ Checker 实例 `performReview()` · `Services/ReviewerAgent/reviewerAgent.ts` | 评估 Agent 交付物质量（详见 §7） | ⚠️ 原类名 `QualityInspector` 全库不存在；**编排器主流程未调用**（见 §3.1 [6]）；`performReview()` 为**桩级：`accepted = true` 硬编码恒通过**，不构成质量门禁 |
| 结果聚合器 | `aggregateResults()` / `calculateQualityScore()` · `Core/Decision/orchestrator/resultAggregator.ts` | 整合子任务结果，生成最终交付物 | ⚠️ 函数已实现但**无任何生产调用者**；`orchestrator.ts` 现仅 import `resetAggregator()`（测试复位用，被 `resetOrchestrator()` 调用），`aggregateResults` 的 import 已被移除 |
| 工作区隔离 | `createIsolatedWorkspace()` / `getTaskWorkspaces()` / `markMerged()` · `Infra/Sandbox/workspaceIsolator.ts`；Git worktree 全套 `createWorktree()` / `detectConflicts()` / `mergeWorktrees()` · `Infra/Sandbox/gitWorktreeManager.ts` | 并行 Agent 目录/分支级隔离（§7A.1） | ✅ 已实现（原表未记录，2026-10-03 补）；⚠️ **未被编排链路调用** |
| 合并阶段 | `executeMergePhase()` · `Core/Decision/orchestrator/mergePhase.ts`；`precheckConflicts()` · `Core/Decision/orchestrator/conflictPrecheck.ts` | 多 Agent 产物确定性合并 + 冲突预检测（§7A.2） | ⚠️ 已实现但**未接入编排器**，仅测试调用（原表未记录，2026-10-03 补） |

---

## 3. 编排流程（端到端）

### 3.1 主流程

> **2026-09-22 校准**：下图按代码实际接线重绘（`Core/Decision/orchestrator/orchestrator.ts`）。
> `[4]` 的 `switch` **仅落地 4 个模式**，`RoutingMode` 另 2 个成员（`LITIGATION`/`REGULATION`）落 `default` 直接返回错误；`AUDIT` 非 `RoutingMode` 成员（仅前端 `WorkingMode`），不经此 switch；`[5]`~`[7]` 三步**当前均未接入主流程**——各已实现模式在 `[4]` 内即以 `status:'success'` 直接返回。
>
> **2026-10-03 校准**：①锚点改为符号定位（行号已随类型债清偿漂移）；②补编排**入口与事件发布清单**，便于后续接线核对；
> ③`[4]` 分支内的"招募"一字与代码不符——四个 Handler 一律 `createAgent()` + `assignTask()`，**`recruitAgent()` 在编排链路零调用**，因此既不发 `AGENT_RECRUITED` 事件，也不走 `RecruitmentRequest` 的预算校验；
> ④`[5]` 描述再降级：`orchestrator.ts` 现只 import `resetAggregator()`（供 `resetOrchestrator()` 测试复位用），`aggregateResults` 的 import 已被移除，生产调用者为 0；
> ⑤`[7]` 的 `TokenEconomy.settle(...)` **全仓不存在该符号**，真实结算 API 为 `calculateDistribution()` / `executeDistribution()`（`Services/TokenEconomy/profitDistributor.ts`），入参是 `PartnerContribution[]` + `tokenPool`，**不接收 traceId**。

```
入口：REST POST /api/tasks（`Interface/RestApi/taskApi.ts` → `submitTask()` → `receiveTask`；**不携带工作模式参数**）
    │
    ▼
用户输入需求
    │
    ▼
[1] receiveTask(params)                         ✅ orchestrator.ts · `receiveTask()`（函数式入口，非 Orchestrator 类）
    │  → 发布 TASK_RECEIVED（payload: taskId / estimatedTokens）
    ▼
[2] assessComplexity(input)                     ✅ complexityAssessor.ts · `assessComplexity()`
    │  → 当前为「关键词启发式 + 文本长度估算」（Phase 0-2）
    │    ⚠️ 未接 LLM，Prompts/ 下亦无 complexityAssessment.md
    │  → 输出 ComplexityReport
    │
    ▼
[3] decideRoute(report)                         ✅ routeDecision.ts · `decideRoute()`
    │  → 按 §3.3 优先级匹配路由规则
    │  → 输出 RouteDecisionResult { mode, params }
    │
    ▼
[4] switch (route.mode)                         ⚠️ orchestrator.ts · `receiveTask()` 内 —— 仅 4 个分支已接线
    │
    │  ┌─ 已实现（4）：createAgent → 拆解 → createAgent + assignTask → registerAssignment → 直接返回 status:'success'
    │  │   ⚠️ 全程不经 recruitAgent()（招募服务未接入编排），无 AGENT_RECRUITED 事件、无预算校验
    ├── DIRECT         → executeDirect()         ✅ orchestrator.ts · `executeDirect()`
    ├── DELEGATION     → executeDelegation()     ✅ orchestrator.ts · `executeDelegation()`
    │                     └ 发布 TASK_DECOMPOSED（payload 键为 subtaskCount）、TASK_ASSIGNED（含 assignmentId/agentId/parentAgentId）
    ├── ASSEMBLY_LINE  → executeAssemblyLine()   ✅ orchestrator.ts · `executeAssemblyLine()`
    ├── CONSORTIUM     → executeConsortium()     ✅ orchestrator.ts · `executeConsortium()`
    │
    │  ┌─ S12 待接线（2）：RoutingMode 中无 Handler，落 default → err(`路由模式 X 尚未实现（S12）`)
    ├── LITIGATION     → ⚠️ 待实现（S12）
    ├── REGULATION     → ⚠️ 待实现（S12）
    └── AUDIT          → ⚠️ 待实现（S12）；且不属于后端 RoutingMode（见 Docs/Agent/01 §4.1），
    │                       由监管/稽查服务链路承载，不经上述 default 分支
    ▼
[5] aggregateResults(subtaskResults)            ⚠️ 未接线：函数已实现（resultAggregator.ts · `aggregateResults()`），
    │                                              但 orchestrator 连 import 都已移除，生产调用者 0
    ▼
[6] 质量验收                                     ⚠️ 未接线（桩）：全库无 QualityInspector 类
    │  → 旧「LLM 打分 ≥ 60 才交付」已被 §7 四级 Verifier 取代
    │  → 目标态：Services/LoopControl/verifier/ L1→L4 + Reviewer Agent（§7.1 Maker-Checker）
    ▼
[7] calculateDistribution() / executeDistribution()
    │                                             ⚠️ 未接线：编排主流程无任何分润调用；原写法
    │                                                `TokenEconomy.settle(traceId, contributions)` 不存在（见 §7.7）
    ▼
[8] 返回 OrchestrationResult                      ✅ 当前各已实现模式实际在 [4] 内即返回
                                                   ⚠️ 与 §7A.2 的「[8] 合并阶段」编号语义冲突，2026-10-03 起
                                                      本文的合并步骤一律记作 [M]，[8] 专指本行返回
```

**事件发布清单（编排链路当前真实发布者，2026-10-03 校准新增）：**

| 事件 | 发布者 | 载荷键 | 订阅方 |
|------|--------|--------|--------|
| `TASK_RECEIVED` | `orchestrator.ts · receiveTask()` | `taskId` / `estimatedTokens` | — |
| `TASK_DECOMPOSED` | `orchestrator.ts · executeDelegation()` | `taskId` / `subtaskCount` | — |
| `TASK_ASSIGNED` | `orchestrator.ts · executeDelegation()`；`agentRuntime.ts · assignTask()` | `taskId` / `assignmentId` / `agentId` | — |
| `TASK_COMPLETED` | `agentRuntime.ts · reviewSubmission()`；`mergePhase.ts · executeMergePhase()`（未接线） | **`taskId`** | ⚠️ `progressTracker.ts` 按 `payload.assignmentId` 取值 → **键名不匹配**（见 §6.1） |
| `TASK_STARTED` / `TASK_PROGRESS` / `TASK_FAILED` | **全仓无发布者** | — | `progressTracker.ts` 四路订阅之一，永不触发 |
| `CONFLICT_DETECTED` | `conflictPrecheck.ts · precheckConflicts()`（未接线） | `taskId` / `conflicts` | **全仓无订阅者**（见 §7A.2） |
| `AGENT_RECRUITED` / `AGENT_EXPELLED` | `recruiter.ts`（编排链路不调用招募） | `agentId` / `role` / … | — |

### 3.2 复杂度评估报告（ComplexityReport）

```typescript
interface ComplexityReport {
  // 基础评估
  estimatedTokens: number;           // 预估总 Token 消耗
  requiredDomains: string[];         // 所需专业域列表（如 ["backend", "frontend", "database"]）
  couplingScore: number;             // 任务耦合度（0.0-1.0，越低越适合并行）
  
  // 结构分析
  subtaskCount: number;              // 建议的子任务数量
  hasSopMatch: boolean;              // 是否匹配已有 SOP 模板
  matchedSopId?: string;             // 匹配的 SOP ID
  
  // 风险评估
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  potentialConflicts: string[];      // 潜在的冲突点
  
  // 元数据
  assessedAt: number;                // epoch ms
  assessorModel: string;             // 使用的评估模型
  confidenceScore: number;           // 评估置信度（0.0-1.0）
}
```

### 3.3 路由决策规则

> **2026-10-03 校准**：①接口名更正——代码中该类型名为 `RoutingRulesConfig`（`Src/Core/Decision/types.ts`），文档旧写法 `RoutingRules` 全仓不存在；6 个字段名与默认值与代码逐项一致。
> ②**⚠️ 配置化未接线**：阈值实际来自进程内硬编码 `DEFAULT_RULES`（`routeDecision/routingRules.ts`）。`Configs/routingRules.json` **已存在**且已被 `Infra/Config/configLoader.ts` 的配置文件白名单收录，但写入运行期的唯一入口 `updateRoutingRules()` **零生产调用者**（仅测试），故改 JSON 不生效。
> ③代码侧 `routingRules.ts` 文件头注释自述"从 routingRules.json 加载"同样不成立——该注释属代码，本文不代改，**登记为待办**（随本条一并由配置加载负责人在启动序列接入 `updateRoutingRules()` 后，再校订本条与代码注释）。

```typescript
interface RoutingRulesConfig {          // 真实类型名（Core/Decision/types.ts）；旧文档误作 RoutingRules
  // Consortium 模式阈值
  consortiumTokenThreshold: number;    // 默认 50000
  consortiumDomainThreshold: number;  // 默认 2
  
  // Delegation 模式阈值
  delegationMaxCouplingScore: number; // 默认 0.3（低于此值适合并行）
  delegationMinSubtaskCount: number;  // 默认 2
  
  // Assembly Line 阈值
  assemblyLineSopRequired: boolean;   // 默认 true（必须有匹配 SOP）
  
  // 直接执行阈值
  directExecMaxTokens: number;        // 默认 10000（低于此值 Director 直接做）
}
```

**决策优先级（按序判定，首个命中即路由）：**

| 优先级 | 条件 | 路由 |
|--------|------|------|
| 1 | `estimatedTokens > consortiumTokenThreshold` 或 `requiredDomains.length >= consortiumDomainThreshold` | `CONSORTIUM` |
| 2 | `hasSopMatch == true` 且 `assemblyLineSopRequired` 满足 | `ASSEMBLY_LINE` |
| 3 | `couplingScore < delegationMaxCouplingScore` 且 `subtaskCount >= delegationMinSubtaskCount` | `DELEGATION` |
| 4 | `estimatedTokens <= directExecMaxTokens` | `DIRECT`（Director 直接执行） |
| 5 | 以上均不命中 | `DELEGATION`（默认降级） |

---

## 4. 路由模式处理器（前端 WorkingMode 7 值 · 后端 RoutingMode 6 成员 · 可路由 4 种）

> **2026-09-22 校准**：原标题「六种路由模式处理器」与下列 4.1–4.7 共 **7** 个子节自相矛盾。按 `orchestrator.ts` 中 `receiveTask()` 的 `switch` 实际接线更正为：
> - 前端 `WorkingMode` 共 **7** 值（`DIRECT`/`DELEGATION`/`ASSEMBLY_LINE`/`CONSORTIUM`/`LITIGATION`/`REGULATION`/`AUDIT`，见 `Client/src/stores/chatStore.ts` 的 `WorkingMode` 类型声明）；
> - 后端 `RoutingMode` 共 **6** 成员（无 `AUDIT`，见 `Src/Core/Decision/types.ts` 的 `RoutingMode`）；
> - **已接线（4）**：`DIRECT` / `DELEGATION` / `ASSEMBLY_LINE` / `CONSORTIUM`；
> - **S12 待接线（2）**：`LITIGATION` / `REGULATION`——在 `RoutingMode` 类型中存在，但 `switch` 落 `default` 返回"尚未实现（S12）"；
> - **S12 待接线（1）**：`AUDIT`——**不属于后端 `RoutingMode`**，由监管/稽查服务链路（`Services/Audit/`）承载，见 Docs/Agent/01 §4.1。
>
> **2026-10-03 校准 · 现状记录 + 待办（需人工裁定）**：上表的枚举成员与判定顺序经复核**与代码逐字一致，无漂移**；但**前端所选模式不进入编排**——
> `Interface/IpcBridge/ipcBridge.ts` 取出 `workingMode` 后传入 `startStreamGeneration(..., _workingMode)`，形参带下划线**即传即弃**；
> `Interface/RestApi/taskApi.ts` 调用 `receiveTask()` 时不传任何模式；`routeDecision.ts · forceRoute()` **零生产调用者**。
> 因此**当前 7 值仅供 UI 展示 / 会话标记，后端路由完全由复杂度阈值自动决定**（§3.3 顺序）。
> **待办**：需产品/编排负责人裁定二选一——(a) 把"用户选模式"作为正式需求接线（`receiveTask` 增 `forcedMode` 参数 + IPC 透传 + `forceRoute` 落地），或 (b) 承认 WorkingMode 为纯展示概念并从设计口径中移除其"决定编排"的暗示；本文**不代为裁决**。

### 4.1 DIRECT（直接执行）

```
Director 自身执行任务
├── 进入标准 10 步主循环
├── 无子任务拆解
└── 结果直接返回用户
```

**适用场景：** 简单问答、单文件修改、小型任务（预估 < 10K tokens）

### 4.2 DELEGATION（并行委派）

```
Director 作为 PM
├── [1] TaskDecomposer 拆解任务
│   └── 输出 TaskPlan { subtasks[], dependencies[] }
├── [2] AgentManager 雇佣 Worker
│   └── 为每个 subtask 创建 Worker 实例
├── [3] 分发任务（生成《任务分配书》）
│   └── 每个 Worker 收到 TaskAssignment
├── [4] ProgressTracker 并行追踪
│   ├── 监听 Worker 状态变化事件
│   ├── 检测超时（超过 maxIterations 或 wall-clock 限制）
│   └── 检测连续失败（3 次 → 开除重募）
├── [5] 收集结果
│   ├── QualityInspector 逐个验收
│   ├── 验收失败 → 反馈给 Worker 重试（最多 2 次）
│   └── 重试仍失败 → 开除 Worker，重新招募
└── [6] ResultAggregator 汇总
    └── 整合所有子任务结果 → 最终交付物
```

> **2026-09-22 校准**（上图为目标态流程，组件名沿用旧称；真实实现与接线状态如下）：
> `[1] TaskDecomposer` → `decomposeTask()` ✅｜`[2] AgentManager` → `createAgent()` + `recruitAgent()`（**无 `AgentManager` 类**）✅ 函数已实现｜
> `[4] ProgressTracker` → `registerAssignment()` / `detectAllAnomalies()`（**非类**）✅｜
> `[5] QualityInspector` → §7 四级 Verifier + Reviewer Agent —— ⚠️ **未接线**（**无 `QualityInspector` 类**）；"重试 2 次"旧机制已被 §7.5 `FailureFeedback` 取代｜
> `[6] ResultAggregator` → `aggregateResults()` —— ⚠️ 函数已实现但 `orchestrator.ts` 未调用。
> 当前 `executeDelegation()`（`orchestrator.ts`）实际执行到 `[4]` 招募与进度注册后，即以 `status:'success'` 返回。
>
> **2026-10-03 校准**（上图三条描述被代码推翻，逐条更正）：
> - `[1]` 的产物**不是** `TaskPlan { subtasks[], dependencies[] }`：真实字段是 `assignments: TaskAssignment[]`，依赖以每项的 `dependsOn` 表达（`Core/Decision/types.ts · TaskPlan`）。**全仓不存在 `SubTask` 类型**——概念名 subtask ≡ `TaskAssignment`。
> - `[2]` **不调用 `recruitAgent()`**：`executeDelegation()` 实为 `createAgent({role:'worker', model})` + `agentRuntime.ts · assignTask()` + 置 `assignment.status='assigned'`；招募服务的三项校验与 `AGENT_RECRUITED` 事件均被绕过（§2.1 / §3.1 [4] 已同步更正）。
> - `[4]` **不是 ✅ 而是断链**：`orchestrator.ts` 只调用 `initProgressTracker()` / `registerAssignment()`，`detectAllAnomalies()` / `checkTimeouts()` / `checkStagnation()` / `checkConsecutiveFailures()` **零生产调用者**（原 import 已随类型债清偿被删除），"检测超时/连续失败→开除重募"在当前代码中不会发生（详见 §6.1）。
> - `[6]` 进一步降级：`aggregateResults` 的 import 已完全移除。
> - 本节及 §2.1 的行号锚点统一改为「文件 + 导出符号」写法，避免再次腐化。

**TaskAssignment（任务分配书）结构：**

> **2026-10-03 校准**：以下按 `Src/Core/Decision/types.ts · TaskAssignment` 逐字段对齐。旧版遗漏 3 个字段（`parentAgentId` / `status` / `assignedAgentId`），
> 且 `inputContext` 的 value 类型实为 `unknown` 非 `any`；`outputSchema` 的类型实为 `Record<string, unknown>`，**全仓不存在 `JSONSchema` 类型**。

```typescript
interface TaskAssignment {
  assignmentId: string;              // 形如 assign-{taskId}-{i}（非 UUID）
  taskId: string;                    // 关联的主任务 ID
  traceId: string;                   // 全局追踪 ID
  parentAgentId: string;             // 拆解时写入的 directorAgentId
  subtaskIndex: number;              // 子任务序号
  
  // 任务定义
  description: string;               // 任务描述
  inputContext: Record<string, unknown>; // 输入上下文（originalTask / domain / partIndex / totalParts）
  outputSchema: Record<string, unknown>; // 期望输出 Schema —— ⚠️ 由 taskDecomposer 硬编码生成，全仓无消费者（见 §7.2 [L1]）
  
  // 约束
  maxIterations: number;             // 最大迭代次数（拆解器固定 20）
  timeLimitMs: number;               // 时间上限（毫秒）= 全局时限 / 子任务数
  tokenBudget: number;               // Token 预算 = 总预算 / 子任务数
  
  // 依赖
  dependsOn: string[];               // 依赖的子任务 assignmentId 列表
  requiredTools: string[];           // 允许使用的工具列表（最小权限）
  // ⚠️ 2026-09-22 校准：字段真实存在（Core/Decision/types.ts）且由 taskDecomposer.ts getToolsForDomain() 填充，
  // 但全仓无任何运行期消费者——子任务工具集不影响主循环 ④ 的角色裁剪；
  // 名义上的校验函数 whitelist.ts isToolAllowedForRole 仅被 Tests 引用。"最小权限"当前为装饰性声明。

  // 状态（运行期由编排器改写；⚠️ 无 progressTracker 参与，见 §6.1）
  status: AssignmentStatus;          // pending | assigned | in_progress | completed | failed | cancelled
  assignedAgentId?: string;          // 由 createAgent() 回填
}
```

### 4.3 CONSORTIUM（高难攻坚）

```
Director 作为项目负责人
├── [1] 生成《联合开发契约》
│   └── ConsortiumContract { partners[], profitSharing, disputeResolution }
├── [2] AgentManager 招募 Partner
│   ├── 根据 requiredDomains 匹配专业域
│   ├── 每个 Partner 独立上下文、独立工具集
│   └── 签署契约（记录到共享记忆）
├── [3] 并行/协同开发
│   ├── 各 Partner 在隔离环境中工作
│   ├── 通过 SharedMemory 共享必要信息
│   └── 中间过程物理隔离（PrivateState）
├── [4] 冲突处理
│   ├── Partner 间冲突 → 触发 LITIGATION
│   ├── 仲裁庭介入 → 裁决 → 恢复
│   └── Token 违约金划扣
├── [5] 结果整合
│   ├── 各 Partner 提交交付物
│   ├── QualityInspector 逐个验收
│   └── ResultAggregator 合并
└── [6] Token 分润
    └── 按契约 + 贡献度自动结算
```

> **2026-09-22 校准**：上图 `[2] AgentManager` / `[5] QualityInspector` / `ResultAggregator` 均为旧称（全库无同名类），真实函数见 §2.1。
> 接线状态：`[1]`《联合开发契约》生成 ⚠️ 未实现｜`[2]` 招募 Partner ✅ 由 `createAgent({role:'partner'})` 完成（Prompt / 工具裁剪 / 契约签署 ⚠️ 未实现）｜
> `[4]` 冲突触发 `LITIGATION` + 违约金划扣 ⚠️ 待接线（S12）｜`[5]` 质量验收 ⚠️ 未接线（见 §3.1 [6]）｜`[6]` Token 分润 ⚠️ 未接线（见 §3.1 [7]）。
> 当前 `executeConsortium()`（`orchestrator.ts`）仅执行到"创建 Director → 拆解 → 逐子任务 `createAgent({role:'partner'})` + `registerAssignment()`"，即以 `status:'success'` 返回。
>
> **2026-10-03 校准**：①上句旧写作"招募 Partner"，实际**不经 `recruitAgent()`**，Partner 与 Worker 走同一 `createAgent()` 路径，无 `AGENT_RECRUITED` 事件、无 `RecruitmentRequest` 预算校验；
> ②`[6]` 分润的真实 API 是 `calculateDistribution()` / `executeDistribution()`（`Services/TokenEconomy/profitDistributor.ts`），不存在 `settle()`；
> 且其权重是**质量/数量/效率三维**（`qualityWeight .5 / quantityWeight .3 / efficiencyWeight .2`），与 §7.7 的 L1/L2/L3 口径**不是同一套分数**；
> ③`ConsortiumContract` / `PartnerEntry` 两个 interface **全仓无对应类型定义**，整块保留为 ⚠️ 未实现 / 目标态。

**ConsortiumContract 结构：**

```typescript
interface ConsortiumContract {
  contractId: string;
  traceId: string;
  
  // 参与方
  director: string;                  // Director agent_id
  partners: PartnerEntry[];          // Partner 列表
  
  // 任务定义
  taskDescription: string;
  subtaskAllocation: Record<string, string>; // partner_id → subtask_description
  
  // 收益分配
  profitSharing: {
    weights: { quality: number; quantity: number; efficiency: number };
    tokenPool: number;               // 总 Token 池
  };
  
  // 争议解决
  disputeResolution: {
    method: 'arbitration';           // 仲裁方式
    arbitratorCount: number;         // 仲裁者数量（默认 3）
    penaltyRate: number;             // 违约金比例（默认 0.1）
  };
  
  // 状态
  status: 'active' | 'completed' | 'terminated' | 'disputed';
  createdAt: number;                          // epoch ms
  completedAt?: number;                       // epoch ms
}

interface PartnerEntry {
  agentId: string;
  domain: string;                    // 专业域
  role: string;                      // 角色描述
  tokenWalletId: string;             // 独立 Token 钱包
}
```

### 4.4 ASSEMBLY_LINE（流水线）

```
预设 SOP 自动执行
├── [1] 加载 SOP 定义
│   └── SopDefinition { nodes[], edges[], globalBudget }
├── [2] 按节点顺序执行
│   ├── 每个节点 = 一个 Agent 实例
│   ├── 节点内 max_iterations = 1
│   ├── 节点间通过事件总线传递数据
│   └── 每个节点有明确的输入/输出契约
├── [3] 异常处理
│   ├── 节点失败 → 按失败语义（重试/跳过/中断）
│   └── 无幂等标记的写节点不允许重试
└── [4] 最终节点输出 = 任务结果
```

> **2026-10-03 校准（补 §4.2/§4.3 同格式的状态标注）**：上图 `[1]`~`[3]` 全为**目标态**，当前**未实现**，旧版本节无状态标注易被误读为现状：
> - `[1]` 加载 `SopDefinition { nodes[], edges[], globalBudget }` —— ⚠️ **未实现 / 目标态**：全仓不存在 `SopDefinition` 类型，亦无 SOP 引擎；
>   所谓"SOP 匹配"只是 `complexityAssessor.ts · KNOWN_SOPS` 的 **4 条硬编码关键词表**（`sop-code-review` / `sop-data-migration` / `sop-api-design` / `sop-frontend-component`），无节点、无边、无 globalBudget。
> - `[2]` 节点内 `max_iterations = 1`、节点间事件总线传数据 —— ⚠️ **未实现 / 目标态**：`executeAssemblyLine()`（`orchestrator.ts`）实际只做
>   `decomposeTask({ maxParallelism: 1 })` + 把每个 `assignment.dependsOn` 串到前一个 + 逐节点 `createAgent({role:'worker'})` + `registerAssignment()`；
>   `maxIterations` 由拆解器统一置 20，**不设 1**；节点间无事件总线数据传递。
> - `[3]` 失败语义（重试/跳过/中断）+ 无幂等写节点禁止重试 —— ⚠️ **未实现 / 目标态**：编排器不消费任何异常，也无幂等判定。
> - 角色亦与设计不符：节点 Agent 用 `role:'worker'` 创建，**未使用 `assembly_node` 角色**（该角色在 `UserRole` 中存在）。
> - §3.1 把本模式计入"已实现（4）"仅指**分支已接线并返回 success**，不代表本节 `[1]`~`[3]` 语义已落地。

### 4.5 LITIGATION（司法仲裁）⚠️ 待接线（S12）

> 详见 `Docs/Agent/05-仲裁系统/仲裁系统设计.md`
> **实现状态**：`RoutingMode` 含此成员，但 `orchestrator.ts` 的 `switch` 无对应分支，命中即落 `default` 返回"尚未实现（S12）"。

### 4.6 REGULATION（行政协调）⚠️ 待接线（S12）

> 详见 `Docs/Agent/06-监管与审计系统/监管与审计系统设计.md`
> **实现状态**：同 §4.5——`RoutingMode` 含此成员，编排器落 `default` 返回"尚未实现（S12）"；`Services/Regulation/` 已有实现但尚未被编排链路调用。

### 4.7 AUDIT（税务稽查）⚠️ 待接线（S12）

> 详见 `Docs/Agent/06-监管与审计系统/监管与审计系统设计.md`
> **实现状态**：**不是后端 `RoutingMode` 成员**（仅前端 `WorkingMode` 有 `AUDIT`，见 Docs/Agent/01 §4.1），不经编排路由，由 `Services/Audit/`（`resourceAuditBureau` / `anomalyDetector` / `freezeManager` / `patrolScheduler`）稽查服务链路承载，S12 接线。

---

## 5. Agent 招募机制

### 5.1 招募流程

> **v2.2 修订**：招募权不再限于 Director，所有 L1 入口级 Agent（Prime Director + Partner）均可发起招募。L2 子 Agent 不可招募下级。
>
> **2026-09-22 校准**：实际 API 为**函数式** `recruitAgent(request: RecruitmentRequest)`（`Services/Recruitment/recruiter.ts`），非 `AgentRecruiter.recruit(requirements)`；实例创建为 `createAgent({role, model}, traceId)`（`Core/AgentRuntime/agentFactory.ts`），非 `AgentFactory.create(config)`。下图逐步标注实现状态。
>
> **2026-10-03 校准**（三处被代码改动推翻/推进，行号锚点已换成符号名）：
> ① **`agent.recruit` 工具已不再是 S10 桩**——`Tools/Custom/agentRecruiter.ts · agentRecruiter.execute()` 现为真实实现：校验 role/task 非空与长度、**拒绝治理三权角色**、按 `RECRUITABLE_ROLES`（worker/reviewer/partner/assembly_node）白名单放行、
> `tokenBudget ∈ [100, 2_000_000]`、`maxIterations ∈ [1, 200]`、`traceId` 必填、**每 trace 存活子 Agent 上限 8**（`MAX_LIVE_SUBAGENTS_PER_TRACE`，防递归招募失控），
> `dangerLevel: DANGEROUS` + `requiredRoles: ['prime_director','partner']` + `reversibility: IRREVERSIBLE`，即每次招募都须经安全门/审批。下文旧"桩实现 `NOT_IMPLEMENTED`"表述作废。
> ② `RecruitmentRequest` 现多一字段 `taskPrompt?`（`Core/Decision/types.ts`），招募时随 `agentRepository.upsertAgent()` **落库到 `agents` 表**（任务提示词 / 工具白名单 / Token 预算 / 迭代上限 / 超时）——此前这些约束被完全忽略。
> ③ **编排链路依旧不经招募服务**：四个 Handler 直接 `createAgent()`（§3.1 [4]），故下图整条流程只在 **LLM 通过 `agent.recruit` 工具**时才被走到；工具返回明确标注 `dispatch: 'pending'`，即"招募 + 登记约束"已实现，**把子任务真正派发给子 Agent 执行的调度链路仍未实现**。

```
L1 入口级 Agent（Prime Director / Partner）发起招募请求
    │   入口：LLM 调用 agent.recruit 工具（Tools/Custom/agentRecruiter.ts）
    ▼
recruitAgent(request)                              ✅ Services/Recruitment/recruiter.ts · `recruitAgent()`
    │  （入参 RecruitmentRequest：role / domain / taskPrompt? / requiredTools / tokenBudget /
    │    maxIterations / timeLimitMs / traceId / parentAgentId）
    │  校验：traceId、parentAgentId 非空，tokenBudget > 0
    │  ⚠️ 不校验调用者角色（L1 门禁仅在工具层 requiredRoles 声明，见 §1 校准注）
    │
    ├── [1] 解析需求（专业域、工具集、Token 预算）    ✅ 入参校验 + 工具层上下限校验
    ├── [2] 生成 Agent 配置                          ⚠️ 部分实现（2026-10-03 推进）
    │   ├── 选择角色 Prompt（partner.md / worker.md / reviewer.md 等）   ⚠️ 未实现（无 Prompt 文件加载器）
    │   ├── 工具可见性由 requiredRoles 白名单自动裁剪（最小权限原则）      ⚠️ 未实现（requiredTools 仅落库，运行期无消费者）
    │   ├── 分配初始 Token（从系统池划拨）            ⚠️ 未实现（仅创建钱包 + 记录 tokenBudget 字段）
    │   └── 约束落库 agents 表                        ✅ `agentRepository.upsertAgent()`（2026-10-03 新增）
    ├── [3] createAgent({ role, model }, traceId)     ✅ agentFactory.ts · `createAgent()`
    │   ├── 创建 AgentInstance                        ⚠️ model 当前由调用方写死（'worker-model'）
    │   ├── 分配 agent_id（实际格式：agent-{role}-{n}，进程内递增序号，非 {role}-{uuid8}）
    │   ├── 创建私有上下文空间                        ⚠️ 未实现（createAgent 不建上下文空间）
    │   └── 创建 Token 钱包                           ✅ createWallet()；失败不阻断（降级）
    └── [4] 注册到 AgentRegistry                      ✅ registerAgent()，状态置为 ready（小写）
        ├── 登记父子关系                              ✅ `setAgentParent()`（`getRecruitedAgents()` 据此过滤）
        └── 发布 AGENT_RECRUITED 事件                 ✅（仅经招募服务时；编排直连 createAgent 不发）
```

> **工具层入口（2026-10-03 校准更正）**：`agent.recruit`（`Tools/Custom/agentRecruiter.ts`）原为**桩实现**（`execute` 直接返回 `NOT_IMPLEMENTED / 'agent.recruit 待 S10 实现'`），
> 现已替换为真实实现并**直接调用 `recruitAgent()`**——即"工具入口 ↔ 招募服务"的接线已完成。
> 未完成的下游是**派发执行**：工具返回值自带 `dispatch: 'pending'` 与提示"子 Agent 已就绪并把任务与约束登记入库；派发执行由编排调度负责"。

### 5.2 Agent 配置模板

> **v2.2 修订**：`role` 扩展为完整 8 角色（对齐 `UserRole` 类型），工具可见性由 `requiredRoles` 白名单决定（详见 Docs/Agent/10 §3.3.1），不再使用 `allowedTools` 手动指定。

> **⚠️ 权限声明校准（2026-09-22）**：下方 `AgentConfig` **在代码中不存在**。运行期实际类型仅有：
> - `CreateAgentParams { role, model, taskId?, parentAgentId? }`（`Src/Core/AgentRuntime/types.ts · CreateAgentParams`）——**无任何权限/资源字段**；
> - `AgentInstance`（同文件 `AgentInstance`）——仅身份与状态字段；
> - `RoleToolConfig { role, additionalTools?, excludedTools }`（`Src/Tools/Factory/toolFactory.ts · RoleToolConfig`）——`additionalTools/excludedTools` 只活在这里，其消费者 `getVisibleTools` **全仓 0 生产调用者**；
> - `trustLevel` **不是配置字段**，由角色经 `getTrustLevel(role)` 推导（`Infra/Security/trustLevels.ts`）；`sandboxEnabled`/`systemPrompt`/`tokenBudget` 等在此上下文均不存在（Token 预算在 LoopConfig，提示词由 `Prompts/` 侧承载）。
> 本块整体为**目标态设计**，保留不删。
>
> **2026-10-03 复核**：全仓仍**不存在 `AgentConfig` 标识符**，上述结论不变，本块继续按"⚠️ 未实现 / 目标态"保留。
> 唯一推进：`RecruitmentRequest` 新增 `taskPrompt?` 字段，招募时把 role / 工具白名单 / tokenBudget / maxIterations / timeLimitMs **落库 `agents` 表**（见 §5.1 [2]），
> 但这些字段仍**不构造运行期 Agent 配置对象**，`createAgent()` 也不读取它们。

```typescript
interface AgentConfig {
  agentId: string;
  role: 'prime_director' | 'partner' | 'regulator' | 'auditor' | 'arbitrator'
      | 'worker' | 'reviewer' | 'assembly_node';
  traceId: string;                   // 关联的全局 trace_id
  parentAgentId: string;             // 招募者的 agent_id（入口级为 'self'）
  
  // Prompt 配置
  systemPrompt: string;              // 角色 Prompt 内容
  taskPrompt?: string;               // 任务特定 Prompt
  
  // 工具配置（v2.2：由 requiredRoles 白名单自动裁剪，此处仅用于额外覆盖）
  additionalTools?: string[];        // 额外允许的工具名（覆盖默认 requiredRoles 限制）
  excludedTools?: string[];          // 显式禁止的工具名
  
  // 资源限制
  tokenBudget: number;               // Token 预算
  maxIterations: number;             // 最大迭代次数
  timeLimitMs: number;               // 时间上限
  
  // 安全配置
  trustLevel: 'L0' | 'L1' | 'L2';
  sandboxEnabled: boolean;
}
```

### 5.3 开除与重新招募

> **2026-09-22 校准**：实际 API 为**函数式** `expelAgent(params)`（`Services/Recruitment/recruiter.ts · expelAgent()`），入参是对象 `{ agentId, taskId, traceId, reason, evidence, decidedBy }`，非 `AgentManager.expel(agentId, reason)`；重新招募为 `recruitAgent(originalRequest)`，二者已组合为 `expelAndReplace()`（同文件）。

```
Director 检测到 Worker 连续 3 次失败
    │
    ▼
expelAgent({ agentId, taskId, traceId, reason, evidence, decidedBy })   ✅ recruiter.ts · `expelAgent()`
    │   reason ∈ { capability | laziness | goal_unreasonable | external_error }
    ├── [0] 记录 TerminationRationale                  ✅ `recordTermination()`（terminationRationale.ts）——⚠️ 由 expelAgent **自身**调用，非"Director 先写"
    ├── [1] 冻结 Agent（状态 → expelled，小写）         ✅ handleAgentEvent(type:'EXPEL')
    ├── [2] 回收剩余 Token（退回系统池）                ⚠️ 待实现（S10）——代码未做 Token 回收
    ├── [3] 保存操作历史（失败原因、历史记录）           ⚠️ 部分：仅落终止理由 + 事件
    ├── [4] 清理私有上下文                             ⚠️ 待实现（S10）
    └── [5] 广播 AGENT_EXPELLED 事件                    ✅
    │
    ▼
recruitAgent(originalRequest)  // 重新招募（或直接用 expelAndReplace）
    └── 新 Agent 继承原任务上下文（从共享记忆获取）      ⚠️ 待实现（S10）：expelAndReplace 仅按原
                                                           RecruitmentRequest 新建，未做上下文继承
```

> **2026-10-03 校准**：①锚点全部换成符号名（原 `recruiter.ts:81 / :134` 等行号已漂移）；②上图 `[0]` 的**方向须与 §7.6 区分**——
> 现实现是 `expelAgent()` 内部先 `recordTermination()`、校验不过即 `return termResult` 中止开除；
> 不存在"Director 必须先写理由，否则**审计局回滚**开除决定"这一环（`Services/Audit/` 全目录无 rationale / expel / rollback 相关代码，见 §7.6）。
> ③`[2]` Token 回收、`[4]` 私有上下文清理、末行上下文继承三项**仍未实现**，与原 ⚠️ 标注一致。

---

## 6. 进度追踪与异常检测

### 6.1 ProgressTracker

> **2026-10-03 校准 · 现状记录 + 待办（需人工裁定）**：下述 `class ProgressTracker` **在代码中不存在**，真实实现为函数式模块 `Core/Decision/orchestrator/progressTracker.ts`；
> 且**事件驱动链未闭合**，具体四点：
> 1. **零生产调用者**：`orchestrator.ts` 只调用 `initProgressTracker()` 与 `registerAssignment()`；`detectAllAnomalies()` / `checkTimeouts()` / `checkStagnation()` / `checkConsecutiveFailures()` 的 import 已随类型债清偿被删除，当前无人在运行期触发异常检测。
> 2. **无发布者**：`TASK_STARTED` / `TASK_PROGRESS` / `TASK_FAILED` 全仓**只有本模块订阅、无任何发布者**（`grep` 复核仅命中 3 处 `subscribe(...)`），因此 `status` 永不被置为 `in_progress`，而三个检测函数都以 `p.status !== 'in_progress' → continue` 开头（`checkConsecutiveFailures` 亦因 `failures` 永不增长而恒空）——**异常检测结果恒为空集**。
> 3. **载荷键名不匹配**：订阅端读 `event.payload.assignmentId`，而发布端（`agentRuntime.ts · reviewSubmission()`、`mergePhase.ts · executeMergePhase()`）发的是 `taskId`，即便 `TASK_COMPLETED` 被发布也命中不到追踪项。
> 4. **约束未保存**：`registerAssignment()` 构造的 `AgentProgress` 不含 `timeLimitMs` / `maxIterations`，`checkTimeouts()` 因此要求**外部传参** `timeLimitMs`，无法自持判定。
>
> **待办（不代为裁决）**：需编排负责人统一 payload 键名（`assignmentId` vs `taskId`）并补齐 `TASK_STARTED` / `TASK_PROGRESS` 发布点，或改由主循环直接调用 `updateProgress()` 绕过事件；
> 在接线完成前，本节所有"✅ 已实现"表述一律读作"函数存在、链路不通"。

```typescript
// ⚠️ 概念视图（目标态）：代码中无同名类，真实 API 为 progressTracker.ts 导出的自由函数
class ProgressTracker {
  // 追踪所有活跃 Agent 的执行状态
  private agentStatuses: Map<string, AgentStatus>;   // 真实实现：模块级 progressMap: Map<assignmentId, AgentProgress>
  
  // 监听事件总线 —— ✅ 四路 subscribe 均存在，但 ⚠️ TASK_STARTED/PROGRESS/FAILED 无发布者（见上）
  onTaskStarted(event: TaskStartedEvent): void;      // 真实：subscribe(EventType.TASK_STARTED, …)
  onTaskProgress(event: TaskProgressEvent): void;
  onTaskCompleted(event: TaskCompletedEvent): void;
  onTaskFailed(event: TaskFailedEvent): void;
  
  // 异常检测
  checkTimeouts(): AgentStatus[];      // ✅ 存在（真实签名需入参 timeLimitMs）；⚠️ 零生产调用者
  checkStagnation(): AgentStatus[];    // ✅ 存在；⚠️ 零生产调用者
  checkLoopDetection(): AgentStatus[]; // ⚠️ 未实现 / 目标态：全仓无该函数（详见 §6.2）
}
```

### 6.2 异常处理策略

> **2026-10-03 校准**：本表原以"现状"口吻描述策略，与代码不符，现拆为「现状（代码实际行为）」与「目标态」两列，未实现者显式标注。

| 异常类型 | 检测方式 | 现状（代码实际行为） | 目标态 |
|---------|---------|-------------------|--------|
| 超时 | 超过 `timeLimitMs` | ⚠️ `checkTimeouts(timeLimitMs)` 单次命中即 `severity:'critical'`，**无两级升级**；且无生产调用者、`in_progress` 恒不成立 | 警告 → 二次超时 → 终止任务 |
| 停滞 | 5 分钟内无 `TaskProgressEvent` | ⚠️ `checkStagnation()` 以 `lastProgressAt` 距今 > `TRACKER_THRESHOLDS.stagnationTimeoutMs`（5 分钟）判定，仅返回 `severity:'warning'`；**无心跳探测、无二次确认** | 发送心跳探测 → 无响应则标记异常 |
| 循环 | 连续 3 次输出相似度 > 0.85 | ⚠️ **未实现 / 目标态**：无 `checkLoopDetection()`；`TRACKER_THRESHOLDS.loopSimilarityThreshold` / `loopConsecutiveCount` 两常量**无任何消费者**；`AgentProgress.lastOutput` 从不写入；`AnomalyReport.anomalyType` 的 `'loop'` 无生产者 | 连续 3 次输出相似度 > 0.85 → 通知 Audit Bureau → 可能冻结 |
| 连续失败 | 连续 3 次 `TaskFailedEvent` | ✅ 常量与判定存在（`consecutiveFailureLimit = 3`）；⚠️ 依赖的 `TASK_FAILED` 无发布者，`failures` 恒为 0，故实际永不触发；"开除 + 重新招募"未被任何调用方执行 | 开除 + 重新招募（见 §5.3） |
| Token 耗尽 | 钱包余额 < 单次调用成本 | ⚠️ **未实现 / 目标态**：`'token_exhausted'` 只存在于 `AnomalyReport` 联合类型，无任何检测实现。Token 压力实际由 §7B 的 `dualBudget` + `LoopConfig.token_budget` 四档比例承担（`runIteration.ts` / `iterationController.ts`），**非进度追踪器职责** | 暂停任务 → 通知 Director 补充或终止（由 §7B 预算档位替代） |

---

## 7. 质量验收（v2 重大修订）

> **修订依据**：`Docs/99-审查记录/设计审查报告-Loop与Harness工程.md` §5.1 §5.2 §5.8。
> **旧版错误**：仅用 `QualityInspector` 一个 LLM 打分。命中业界失效二“生成者自评”与失效一“目标不可验证”。

### 7.1 Maker-Checker 分离红线

| 角色 | 实例 | 上下文 | 模型 | 职责 |
|------|------|--------|------|------|
| **Maker** | Worker / Partner | 自己工作上下文 | producerModel（workerModel） | 产出交付物 |
| **Checker** | 独立 Reviewer Agent | 不共享 Maker 上下文 | **verifierModel（必≠ producerModel）** | 运行 Verifier |
| Coordinator | Director | 仅看到 Verifier 结果 | directorModel | 路由/分派/预算，**不参与质量判定** |

**红线**：
1. Director **不得**直接对交付物评分，只能消费 Reviewer Agent 的结果；
2. Worker **不得**自行宣告完成——必须走 `agent.submit_review` 工具触发 Reviewer；
3. Reviewer 使用的模型 id 与 Maker 相同时 → **运行期拒绝**（L3 层，ADR-0004）；
4. （2026-10-03 新增事实）Reviewer 的 `performReview()` 当前恒 `accepted = true`，故红线 1/2 在实践中**尚不构成有效门禁**。
   （2026-10-04 更新：评审链路已接线——工具入口、Reviewer 创建点、台账回写均已就位；但恒真判定未变，**门禁强度**仍待 LLM Judge 阶段补齐，详见下方校准注记补充段。）

> **2026-10-03 校准（红线 2、3 原文与代码不符，逐条更正）**：
> - **红线 2**：注册的工具名是 **`agent.submit_review`**（`Tools/Custom/submitForReview.ts` 的 `spec.name`），不是 `submit_for_review`（后者全仓仅作为模块/函数名出现）。
>   且该工具的 `execute()` **仍是桩**：直接返回 `toolError(..., 'NOT_IMPLEMENTED', 'agent.submit_review 待 S9 实现')` —— ⚠️ **LLM 侧当前无法触发评审**。
>   服务层 `Core/AgentRuntime/agentRuntime.ts · submitForReview()` 已实现，但 **零生产调用者**，且它发布的事件是 **`APPROVAL_REQUESTED`**（不是"submit_for_review 事件"）。
>   "Worker 不得自行宣告完成"这一约束目前**没有任何运行期强制点**。
> - **红线 3**：原文"→ CI 拒收（ADR-0004）"**不成立**。`.github/workflows/ci.yml` 仅有 3 个 job（Lint & Type Check / Test / Build），**无模型一致性检查**。
>   该约束只在运行期 `Services/LoopControl/verifier/llmJudge.ts · runLlmJudge()` 中以 `err(...)` 实现（`spec.payload.model === ctx.producerModel` 即报错），
>   而 `runVerifierPipeline()`（`verifier/index.ts`）本身**无生产调用者**，故运行期校验亦未被走到。`verifierModel` 目前只存在于 `Infra/Llm/Router/modelRouter.ts` 与配置/UI 透传。
>   **待办**：要么补一条 CI 脚本使原句成立，要么把"CI 门禁"记为 S12 目标项——本文按当前代码取后者。
>
> **2026-10-04 更新（FE-050 评审链路已接线，红线 2 相关过期描述闭环）**：
> - 工具 `agent.submit_review`（`Tools/Custom/submitForReview.ts`）**已实装**（v0.2.0），不再返回 NOT_IMPLEMENTED；执行链为 4 步：
>   `submitForReview()` 登记待审 → `ensureReviewerAgent()` 复用/创建本 trace 独立 Reviewer（Maker-Checker 分离）→ `performReview()` → `markSubtaskReviewed()` 回写 `subtasks` 台账。
> - `requiredRoles` 为 `['worker', 'partner', 'assembly_node']`（FE-050 放宽）—— CONSORTIUM 的 Partner、流水线 assembly_node 此前无评审通道，现与 worker 统一。
> - `submitForReview()` 已有**真实生产调用者**（即上述工具；发布事件仍为 `APPROVAL_REQUESTED`）；评审通过由 `reviewSubmission()` 发布 `TASK_COMPLETED`（payload 含 `assignmentId`，与进度追踪/编排聚合同一 ID 空间）。
> - **运行期强制点已落地**：提交须满足「角色 ∈ SUBMITTABLE_ROLES（worker/partner/assembly_node）且 Agent 处于 running」；执行级的完成宣告（`TASK_COMPLETED` → running→ready）仅由评审通过路径（`reviewSubmission`）发布。
> - **诚实边界（红线 4 未变）**：`performReview()` 仍是 Phase 0-2 规则审核（恒 `accepted = true` + 记录策略评论）——链路已通、**质量门禁强度**待 LLM Judge 阶段补齐；红线 3（模型一致性 CI 检查）照旧。

### 7.2 验收流程（四级 Verifier）

> **2026-10-03 校准**：本节流程图原**全节无状态标注**，易被读作现状；现逐行按 `Services/LoopControl/verifier/` 实际实现对齐（✅ 已实现 / ⚠️ 未实现·目标态 / ⚠️ 未接线）。
> 四级顺序与 ADR-0003「不可跨越」在代码中成立：`runVerifierPipeline()` 确按 L1→L2→L3→L4 执行、L1 未过即返回、并有 `minLevelsRequired`（默认 2）下限。

```
收到 submit_for_review 事件                        ⚠️ 名称不符（历史校准）；**接线已于 2026-10-04 打通**：
    │                                                 真实事件是 APPROVAL_REQUESTED，由 agentRuntime.ts · submitForReview() 发布；
    │                                                 生产调用者 = 工具 agent.submit_review（已实装，见 §7.1 红线 2 更新）
    ▼
[L1] 硬验证（必须全过）                            ✅ runHardVerification() 已实现（kinds: test/schema/numeric/http/file_exists）
    ├─ Schema 校验（TaskAssignment.outputSchema）   ⚠️ 见下「现状记录 + 待办」——转换层不存在
    ├─ 自动测试（如交付物为代码：测试用例必须全通）   ✅ kind:'test'（payload.command + expectExit）
    ├─ 数值/阈值/存在性检查                         ✅ kind:'numeric' / 'file_exists' / 'http'
    └─ 任一失败 → 直接返 FailureFeedback(evidence=具体失败项)  ✅ verifier/index.ts 在 L1 未过时直接返回
    │
    ▼
[L2] 规则验证（如定义）                            ✅ runRuleVerification() 已实现（kinds: rule / golden）
    ├─ 清单覆盖率（必选字段齐备）                   ✅ kind:'rule'
    ├─ 参考答案比对（golden dataset）               ✅ kind:'golden'
    ├─ 反游戏检查：变更范围不超合理边界 / 未删失败测试 / 未忽略错误
    │     ⚠️ **未实现（未接线）**：`antiGaming.ts · validateAntiGaming()` / `checkAntiGaming()` 两函数已实现，
    │        但 `runVerifierPipeline()`（`verifier/index.ts`）**从不调用它们**，`hardVerifier.ts` / `ruleVerifier.ts` 内亦无引用；
    │        配置项 `antiGamingMinRules` / `antiGamingMaxChangedFiles`（`Configs/loopConfig.json → verifier`）**无生产读取方**
    └─ 失败 → FailureFeedback
    │
    ▼
[L3] 独立 LLM Judge（不同模型 + 不同提示 + Rubric）  ⚠️ 桩级/条件式：函数齐备（runLlmJudge），
    │                                                  未配置 L3 spec 时整层跳过；无 ctx.callModel 时
    │                                                  直接产出 defectCategory:'external' 失败项
    ├─ 输出必须为：{ pass, evidence[], defectCategory }   ✅ 结构化输出，禁止自然语言评分
    ├─ 禁止自然语言评分（避免不可重现）                    ✅
    ├─ Rubric 需先通过 50 样本人工标注校准，一致率 ≥ 85%   ⚠️ **未达前置条件**：见 §7.4「现状记录 + 待办」
    └─ 失败 → FailureFeedback
    │
    ▼
[L4] Human Gate（命中以下任一条件时启用）           ⚠️ Phase 0：runHumanGate() 无超时逻辑，恒返回
    │                                                 pass:false + status:'PENDING_APPROVAL'（仅落 DB 队列）
    ├─ 不可逆动作（发布/删除/支付）                 ⚠️ 目标态：条件判定未由 Verifier 侧实现
    ├─ 金额超预算 20%                               ⚠️ 目标态：实际预算档位由 §7B 四档比例承担
    ├─ 上面三层存在矛盾结论                         ⚠️ 目标态：无矛盾检测代码
    ├─ TaskAssignment 显式声明 L4                   ⚠️ **未实现 / 目标态**：`TaskAssignment`（`Core/Decision/types.ts`）
    │                                                  无任何 verifier / 审批级别字段，需先增加如 `requiredVerifierLevel`
    └─ 60s 超时 → 默认拒绝（ADR-0001）              ⚠️ 数值与真源均不符，见下「审批超时」
    │
    ▼
验收完成：写入 verifier_results 表 + 事件广播        ⚠️ **未实现（持久化未接线）**：表由迁移 v12 创建
                                                     （`Infra/Db/migrations.ts · create_verifier_results`），
                                                     但全仓**无 INSERT / Repository**，亦无验收结果广播事件
```

**L1「Schema 校验」——现状记录 + 待办（需人工裁定，不代为裁决）**：
`TaskAssignment.outputSchema` 由拆解器硬编码生成（`taskDecomposer.ts · decomposeTask()` 固定写
`{ type:'object', properties:{ result:{ type:'string' } } }`），**全仓无任何消费者**；
而 `hardVerifier` 的 schema 校验要求调用方自行构造 `VerifierSpec{ level:'L1', kind:'schema', payload:{ jsonSchema } }`（`LoopControl/loopState.ts`）。
二者之间**不存在任何桥接/转换代码**——即"分配书声明的输出契约"当前完全不参与验收。
**目标态字段**：由拆解器产出 `TaskAssignment.outputSchema` → 新增转换层（暂命名 `verifierSpecFromAssignment`）映射为 `VerifierSpec{level:'L1',kind:'schema'}`。
**待办**：该转换层归属（Decision 侧还是 LoopControl 侧）需架构负责人裁定后再落代码，本文不指定归属。

**审批超时（L4 / §7B）——现状记录 + 待办（需人工裁定）**：
- 文档原写"60s 超时 → 默认拒绝"，并称比例与超时一律引用 `Configs/supervision.json → approvalTimeoutSec`（默认 60）。
- 代码实态：运行期取值来自 **security.json**——`Src/main.ts` 以 `securityConfig['approvalTimeoutSec'] ?? 300` 写入审批门配置，而 `Configs/security.json` 实值为 **300**；
  `Configs/supervision.json` 的 `approvalTimeoutSec = 60` **未被编排/审批链读取**（`toolSafetyGate.ts` 内置默认 60 会被 main 覆盖）。
- L4 自身**没有超时逻辑**：`runHumanGate()` 恒返回 `pass:false` + `PENDING_APPROVAL`；"默认拒绝"实际由**重启清理** `expireStaleApprovals()`（`approvalPersistence.ts`）间接实现。
- **待办**：真源二选一（文档改为生效值 300s + security.json，或代码改读 supervision.json），且需与 Docs/Agent/10 §2.7、Docs/Agent/11 §6.3 三处同步；本文**保留原文不裁决**。

**不可跨越红线**（ADR-0003）：L1 未通过时 **禁止** 直接进 L3，避免 Agent “用能说会道绕过硬验证”。

### 7.3 Reviewer Agent 定义

> **2026-10-03 校准**：下列 `ReviewerAgent` interface **在代码中不存在**（`role:'reviewer'` 仅是 `UserRole` 的一个成员），且两处声明与代码冲突：
> - **`tools` 四个名字全仓未注册**：已注册工具全集为
>   `file.read` / `file.write` / `file.edit` / `file.grep` / `dir.list` / `shell.exec` / `code.eval` / `web.search` / `vector.search` / `todo.write` / `agent.recruit` / `agent.submit_review`。
>   `run_tests` / `check_schema` / `compare_golden` / `llm_judge` **均不存在**——其中 `llm_judge` 等只作为 `VerifierSpec.kind` 取值出现在 `LoopControl/loopState.ts`，不是工具。
>   现状映射：跑测试 ≈ `shell.exec`，读产物 ≈ `file.read` / `file.grep`；⚠️ 无等价 schema/golden 工具。
> - **`promptTemplate` 路径错误**：真实文件是 `Prompts/roles/reviewer.md`（非 `prompts/reviewer.md`）。
>   ⚠️ 但**运行期不存在任何 Prompt 文件加载器**——`createAgent()` 不加载角色 Prompt，全仓对 `Prompts/` 的引用仅 `Src/main.ts` 的目录放行与一行注释；故 `promptTemplate` 整体为 ⚠️ 未实现 / 目标态。

```typescript
// 新增 Agent 角色
interface ReviewerAgent {
  role: 'reviewer';
  model: string;               // 必不同于 producerModel
  promptTemplate: 'Prompts/roles/reviewer.md';   // ⚠️ 目标态：无运行期加载器（2026-10-03 校准）
  // ⚠️ 原写法 ['run_tests','check_schema','compare_golden','llm_judge'] 全为未注册工具名
  tools: ['shell.exec', 'file.read', 'file.grep', 'dir.list'];   // 现状可用近似物（2026-10-03 校准）
  context: {
    receives: ['TaskAssignment.originalRequirement', 'deliverable', 'verifierSpecs'];
    doesNotReceive: ['maker_messages_history', 'maker_scratchpad'];   // 隔离 Maker 上下文
  };
}
```

### 7.4 Rubric 模板（L3 使用）

> **2026-10-03 校准**：下面这段 YAML 是**目标态模板，仓库中不存在该文件**——
> 无 `Skills/rubrics/{domain}/` 子目录、无 `.yaml` 后缀文件、无 `id: rb-code-delivery-v3`。整块按 ⚠️ 未实现 / 目标态 保留。
>
> **代码/配置实态**（唯一实存文件：`Skills/rubrics/verifierL3Calibration.json`，**单文件 JSON、无 domain 分层**）：
>
> | 项 | 文档（目标态） | 实存文件 |
> |----|---------------|---------|
> | 路径 | `Skills/rubrics/{domain}/quality.yaml` | `Skills/rubrics/verifierL3Calibration.json` |
> | id | `rb-code-delivery-v3` | 无 id 字段（仅 `version: 1.0.0`） |
> | 维度与权重 | correctness .5 / scope_discipline .2 / test_integrity .2 / readability .1 | **correctness .4 / code_quality .25 / security .2 / efficiency .15** |
> | 校准数据集 | `Tests/GoldenSets/code-review-50` | ⚠️ `Tests/GoldenSets/` **目录不存在**；`Configs/loopConfig.json → verifier.l3CalibrationDataset` 指向的是**第三个名字** `Tests/GoldenSets/review-50`，同样不存在 |
> | 一致率基线 | `minAgreementWithHuman: 0.85` | `calibrationTarget.consistencyRate: 0.80`（文件描述"一致性 ≥ 80%"） |
> | 样本量 | 50 | 实存 **5 条**（`cal-001`~`cal-005`），而 `minSamples` 自述为 50 |
>
> **三处名字互斥**（文档 `code-review-50` / 配置 `review-50` / 数据目录不存在），**待办**：由质量负责人统一命名后，本文再按统一名改写。
>
> **现状记录 + 待办（需人工裁定）**：L3 校准基线三方数值互斥——`Configs/loopConfig.json → verifier.l3MinAgreementWithHuman = 0.85`，
> 而 `verifierL3Calibration.json` 自述 `consistencyRate: 0.80`；样本量 **5/50，未达"50 样本人工标注"前置条件**。
> 需质量/算法负责人裁定基线取 0.80 还是 0.85 并补齐样本，本文**不代为选定数值**。

```yaml
# ⚠️ 未实现 / 目标态模板（仓库无此文件；实存文件见上表）
# Skills/rubrics/{domain}/quality.yaml
id: rb-code-delivery-v3
calibration:
  dataset: Tests/GoldenSets/code-review-50
  minAgreementWithHuman: 0.85
dimensions:
  - name: correctness
    weight: 0.5
    failFast: true
    rubric: "功能是否完整实现需求。逐条对照 originalRequirement 中验收项"
  - name: scope_discipline
    weight: 0.2
    rubric: "是否只改了需要的文件，未越界修改"
  - name: test_integrity
    weight: 0.2
    rubric: "未删除/注释已有测试；新代码有测试"
  - name: readability
    weight: 0.1
    rubric: "命名、注释、结构"
outputSchema:
  pass: boolean
  evidence: [{ dimension, quote, reasoning }]
  # ⚠️ 2026-10-03 校准：代码 DefectCategory 为 5 值，本行旧写法少 external
  defectCategory: enum[spec_missing, logic_error, quality_low, risk_violation, external]
```

> **defectCategory 校准说明**：真实枚举在 `Src/Services/LoopControl/types.ts · DefectCategory`，共 **5 值**（多 `external`）。
> `external` 并非可选项：`verifier/llmJudge.ts` 在 `callModel` 缺失或调用异常时正是产出 `defectCategory:'external'` 的失败项，
> 该值是 §7.6「外部异常不计入 Worker 失败」判定的唯一数据来源。
> 另：`evidence` 的真实结构是 `{ kind, data, excerpt? }`（`EvidenceKind` 6 值：test_output / error_stack / diff_from_expected / tool_error / rule_violation / judge_rubric），非文档旧写的 `{ dimension, quote, reasoning }`。

### 7.5 FailureFeedback 下发（取代旧版"重试 2 次"）

旧版“验收失败 → 反馈给 Worker 重试（最多 2 次）”**直接删除**，改为结构化反馈：

```typescript
// 验收失败时必写
const feedback: FailureFeedback = {
  iteration: current,
  failureCategory: verifierResult.defectCategory,
  evidence: verifierResult.evidence,        // 具体失败项，不是“再试一次”
  comparedWithLastAttempt: {                // 与上次尝试对比
    improvement: 0.15,
    newFailures: ['test_concurrent_lock'],
    resolvedFailures: ['test_token_refresh'],
  },
  triedStrategies: makerState.failedAttempts.map(a => a.strategy),
  remainingBudget: { tokens, iterations, seconds },
  recommendedNextAction: 'switch_strategy',  // 或 abort / escalate_human
};
```

**行为约束**：
- 同一 `defectCategory` 连续 3 次 → 自动升级为 `escalate_human`；
- 无改善（improvement < 0.05）连续 2 次 → 命中 §Docs/Agent/11 无进展退出；
- **禁止**不写 FailureFeedback 就重试。

> **2026-10-03 校准**：`FailureFeedback` 接口字段与代码**一致**（`Services/LoopControl/failureFeedback.ts · FailureFeedback`，
> 含 `comparedWithLastAttempt?` 为**可选**；`evidence` 为 `{kind, data, excerpt?}` 结构，构建时**强制非空**），
> 但下列三处与本文表述不符，逐条更正：
> - **`recommendedNextAction` 是 5 值而非 3 值**：真实类型 `NextAction`（`Services/LoopControl/types.ts`）为
>   `switch_strategy` | `request_approval` | `abort` | `escalate_human` | `rollback_and_abort`（旧写法 `'switch_strategy' | abort | escalate_human` 少了 `request_approval` 与 `rollback_and_abort`，且后两个成员未加引号）。
>   该字段本身是**可选**（`recommendedNextAction?`）。
> - **"同类 defectCategory 连续 3 次 → escalate_human" 为近似实现**：`recommendNextAction()` 实际判据是
>   `input.triedStrategies.length >= config.sameDefectCategoryEscalateRounds`——**数的是已试策略条数，不是同类缺陷连续次数**，与语义不等价。
> - **"无改善连续 2 次"不在 feedback 层实现**：`noImprovementAbortRounds: 2` 与 `improvementMinRatio: 0.05` 在 `failureFeedback.ts` 的配置类型里声明，
>   但**代码未消费 `noImprovementAbortRounds`**（feedback 层 improvement < 阈值只给 `switch_strategy`）；
>   真正的无进展退出由 `stopRules` + `Configs/loopConfig.json → stopRules.noProgress`（`minDeltaRatio: 0.05`、`stagnationWindowRounds: 3`）在 `Core/Loop/` 侧承担。
>
> **现状记录 + 待办（需人工裁定）**：两条阈值分别落在 `failureFeedback.ts` 与 `stopRules`/`noProgress` **两处**，且前者为近似实现。
> 需 Loop 负责人裁定：把"同类缺陷连续次数"改由真实 `defectCategory` 序列判定（并在 `FailureFeedback` 增 `consecutiveSameCategoryCount` 字段），
> 或承认近似口径并把本节文字改为"已试策略数 ≥ 3"；`unreasonableGoalEscalateCount = 5`（对应 §7.6「不同策略均失败 ≥5 次」）目前同样**无消费点**。本文不裁决。

### 7.6 验收失败与"开除"判定（修订旧版）

旧版“3 次失败 → 开除”**需细化**，避免错杀：

| 失败性质 | 定义 | 处理 | 实现状态（2026-10-03 校准） |
|---------|------|------|--------------------------|
| 能力不足 | L1/L2 失败 + 不同 defectCategory + 不同策略 | 3 次后开除 | ⚠️ **未实现（差异化）**：代码只有单一阈值 `progressTracker.ts · TRACKER_THRESHOLDS.consecutiveFailureLimit = 3` + `checkConsecutiveFailures()`，不区分 defectCategory / 策略是否不同；且该函数零生产调用者（§6.1） |
| 不努力 | 同一 fingerprint 重复 | 1 次后警告、2 次后开除 | ⚠️ **未实现**：`lastFingerprint` 仅作为 `TerminationRationale` 的可选字段存在（`terminationRationale.ts` / `Core/Decision/types.ts`），无写入方、无 1 警告/2 开除的分级判定 |
| 目标不合理 | 不同策略但均失败 ≥ 5 次 | **不开除 Worker，回到 Director 重新拆分任务** | ⚠️ **未实现**：`failureFeedback.ts` 配置类型里的 `unreasonableGoalEscalateCount = 5` **无消费点**；无"回 Director 重拆"路径 |
| 外部异常 | L4 拒绝 / 5xx 服务不可用 | 开除计数 **+0**（不计入 Worker 失败） | ⚠️ **未实现**：`defectCategory:'external'`（`llmJudge.ts`）与失败计数器之间**无映射代码**；`consecutiveFailures` 由 `agentRuntime.ts · reviewSubmission()` 在拒绝时**无条件自增**。仅存在一条**反向守卫**：`recordTermination()` 会以 `external_error 不应计入 Worker 失败次数` 拒绝"有失败计数却按外部异常开除"，属校验而非 +0 计数 |

**关键**：开除前 Director **必须**写一份 `TerminationRationale`，列举证据，否则审计局会回滚开除决定。

> **2026-10-03 校准（上句方向相反 + 后半句无实现）**：
> - **前半句的"谁写"与"何时写"被代码改写**：实际是 `recruiter.ts · expelAgent()` **自身**在冻结前调用 `terminationRationale.ts · recordTermination()`，
>   写入失败/校验不过就 `return termResult` 中止本次开除——**不是"Director 先写、再请求开除"**的调用顺序。
> - **"否则审计局会回滚开除决定" ⚠️ 未实现 / 目标态**：`Services/Audit/`（`resourceAuditBureau` / `anomalyDetector` / `freezeManager` / `patrolScheduler`）
>   全目录**无任何 rationale / expel / rollback 相关代码**，也不存在回滚开除的机制；审计服务本身尚未被编排链路调用（§4.7）。
> - `TerminationReason` 枚举 4 值（`capability` / `laziness` / `goal_unreasonable` / `external_error`）与设计一致，是**四类差异化处理唯一落地了类型定义**的部分。
> - 另：`terminationRationale.ts · validateTermination()` 存在，但**无生产调用者**（`expelAgent` 走的是 `recordTermination()` 内部的即时校验）。

### 7.7 与 Token 分润的耦合修订

旧版评分 0-100 直接作为分润因子。新版：
- 分润中的"质量分" = **L1 pass率 x 0.4 + L2 pass率 x 0.3 + L3 rubric 加权得分 x 0.3**；
- L1/L2 失败 → 质量分上限 0.4（不允许“能言善辩”拉回）；
- 无 L3（完全确定性任务） → 质分 = L1 x 0.6 + L2 x 0.4。

> **2026-10-03 校准（函数已实现、链路未接；且与分润实际口径不是同一套分数）**：
> - 上式（含"无 L3 时 L1×0.6 + L2×0.4"）**已实现**为 `resultAggregator.ts · calculateQualityScore({l1PassRate, l2PassRate, l3RubricScore?})`，
>   但**零生产调用者**（仅 `Tests/Decision/multiAgentOrchestration.spec.ts` 引用）。
> - 第二条"L1/L2 失败 → 质量分上限 0.4" ⚠️ **未实现 / 目标态**：函数体内**无任何封顶/钳制逻辑**，纯加权求和。
> - **口径冲突**：真实分润模块 `Services/TokenEconomy/profitDistributor.ts` 用的是另一套**三维权重**
>   （`qualityWeight .5 / quantityWeight .3 / efficiencyWeight .2`），且 `PartnerContribution.qualityScore` **由调用方直接传入**，
>   模块本身不感知 L1/L2/L3——即 §7.7 的"L1/L2/L3 质量分"与 `profitDistributor` 的"三维贡献分"是**两个不同口径**，不可混用。
> - **无数据通路**：`SubtaskResult.qualityScore`（`Core/Decision/types.ts`）**无任何写入方**，
>   Verifier 的 L1/L2/L3 通过率到分润池之间**当前完全没有链路**（§3.1 [5]/[6]/[7] 三步均未接线所致）。

---

## 7A. 隔离工作区（v2 新增）

> **修订依据**：审查报告 §4.3 —— 并行 Agent 必须隔离工作区。

### 7A.1 隔离级别

> **2026-10-03 校准**：本表原**无状态标注**。经复核，隔离机制**已落地且路径与本文逐字一致**（此前 §2.1 / §3.1 完全未记录这两个模块，已在 §2.1 补行）。现补「实现状态 + 真实模块」列。

| 任务类型 | 隔离方式 | 适用场景 | 实现状态（2026-10-03 校准） |
|---------|---------|---------|--------------------------|
| **只读** | 无隔离 | 搜索、查询 | ✅ 现状即如此（无代码） |
| **写入不同文件** | 目录隔离：`Data/Workspace/{session}/{taskId}/{agentId}/` | 默认 | ✅ 已实现：`Infra/Sandbox/workspaceIsolator.ts · createIsolatedWorkspace()`，真实路径 `{dataRoot}/Workspace/{sessionKey}/{taskId}/{agentId}`（`dataRoot` 默认 `Data`），含 `getTaskWorkspaces()` / `markMerged()` / `cleanAgentWorkspace()`；⚠️ 未被编排链路调用 |
| **写入同一仓库** | Git worktree：每 Agent 一个分支 | 代码任务 | ✅ 已实现（API 全集）：`Infra/Sandbox/gitWorktreeManager.ts · createWorktree()` / `writeFileInWorktree()` / `commitWorktree()` / `detectConflicts()` / `mergeWorktrees()` / `getAgentWorktree()`；⚠️ 未被编排链路调用 |
| **修改共享数据** | 乐观锁 + 版本号（见 Docs/Agent/07 修订） | SharedMemory | ✅ 已实现：`SharedMemory/globalWorkspace.ts`（`expectedVersion` 不匹配即拒写 + `VERSION_CONFLICT` 事件），类型与冲突结构在 `versionedEntry.ts`（`version` / `VersionConflict`），键级互斥在 `workspaceLock.ts · acquireLock()` |
| **不可逆副作用** | 先写沙箱，验收后提交（draft mode） | 发布/支付类 | ⚠️ **未实现 / 目标态**：`workspaceIsolator.ts` 仅有状态枚举成员 `'sandbox_draft'`，**全仓无写入方**，不存在"先草稿、验收后提交"的两段式提交流程 |

### 7A.2 合并阶段

合并阶段 `[M] 合并与冲突预检测`（⚠️ 2026-10-03 校准：原文写作"Orchestrator **新增** `[8]`"，与 §3.1 的 `[8] 返回 OrchestrationResult` **编号语义冲突**，现统一记作 `[M]`）：
- 多 Agent 产物 → `ResultAggregator` 先尝试确定性合并（不同文件直接拼装）；
- 同文件冲突 → 写入 `WriteGuard` 拦截，触发冲突→ 交给 Docs/Agent/05 仲裁系统；
- 不可自动合并 → 风险退出（`escalate_human`）。

> **2026-10-03 校准（三条逐条更正，均为"已实现但未接线"或表述错误）**：
> - **编号与接线**：合并阶段已实现为 `orchestrator/mergePhase.ts · executeMergePhase()`（内部依次 `precheckConflicts()` → 逐工作区 `markMerged()` / `markFailed()` → 发布 `TASK_COMPLETED`）
>   与 `orchestrator/conflictPrecheck.ts · precheckConflicts()`，但 `orchestrator.ts` **无 mergePhase 的 import**，
>   两者仅被 `Tests/Parallel/parallelCollaboration.spec.ts` 调用——⚠️ **未接入编排流程**，故 §3.1 主流程图中的 `[M]` 步骤当前不存在。
>   第一条的 `ResultAggregator` 同样未接线（§2.1 / §3.1 [5]）。
> - **第二条"写入 `WriteGuard` 拦截"为声明错误**：真实 `SharedMemory/writeGuard.ts` 是 **SharedMemory 键级写守卫**
>   （`interceptWrite()` / `isForbiddenKey()`），**不拦截工作区文件写入**；文件级冲突当前**只被打上标记**：
>   `conflictPrecheck.ts · detectDirectoryConflicts()` 给冲突项写 `FileConflict{resolution:'arbitration'}` 并发布 `CONFLICT_DETECTED`，
>   而 **`CONFLICT_DETECTED` 全仓无订阅者**，也没有任何对 `Services/Arbitration` 的调用 → 应为"冲突 → 事件（无人消费）→ **S12 仲裁待接线**"。
> - **worktree 层检测未实现**：`conflictPrecheck.ts` 文件头注释承诺"检测维度 2. Worktree 层——不同分支修改了同一文件"，
>   实际函数体**只走目录层**（`detectDirectoryConflicts()`），无 worktree 分支比对。
>   真实的分支级冲突检测在另一模块：`gitWorktreeManager.ts · detectConflicts(worktreeIds)` / `mergeWorktrees()`，与 `conflictPrecheck` **无调用关系**（该归属关系原文件未记录，2026-10-03 补）。
> - **第三条"风险退出 escalate_human"未实现**：`executeMergePhase()` 冲突时仅返回 `status:'conflict'` 并跳过冲突 Agent，不产出 `NextAction:'escalate_human'`。

---

## 7B. 预算与预算内降级（v2 新增）

与 Docs/Agent/11 §2.1 、Docs/Agent/04 修订同步；**本文不重复定义数值**，比例与超时一律引用 `Configs/loopConfig.json → stopRules.budget.*Ratio`（Docs/Agent/10 §2.8）与 `Configs/supervision.json → approvalTimeoutSec`（Docs/Agent/10 §2.7）。

> **2026-10-03 校准**：本节的**四档比例与事件**与代码/配置一致——`Configs/loopConfig.json → stopRules.budget` 实值 warm 0.36 / soft 0.6 / expandRequest 0.8 / hard 1.0，
> 运行期由 `Src/main.ts` 读取并下发、`Core/Loop/runIteration.ts` 换算，`BUDGET_WARMING` 与 `APPROVAL_REQUESTED(kind:'budget_expand')` 由 `TokenEconomy/dualBudget.ts` 触发，两事件均已在 `Services/EventBus/eventTypes.ts` 注册。
> **唯一偏差是"超时"真源**：原文声明超时取自 `Configs/supervision.json → approvalTimeoutSec`（60），
> 实际运行期取自 **`Configs/security.json → approvalTimeoutSec`（300）**（`Src/main.ts` 以 `?? 300` 兜底，覆盖 `toolSafetyGate.ts` 的内置默认 60），`supervision.json` 的该键未被审批链读取。
> 且 L4 `runHumanGate()` 自身无超时逻辑，"超时默认拒绝"由重启清理 `expireStaleApprovals()` 间接达成。
> **本文不在此选定数值**：详见 §7.2「审批超时——现状记录 + 待办（需人工裁定）」，裁定后需与 Docs/Agent/10 §2.7、Docs/Agent/11 §6.3 三处同步。

- **任务总预算** = Director 从钱包划扣到任务子账户；
- **子预算** = 每个 Worker 从任务子账户预分配（数值上 = 该 Worker 的 `LoopConfig.token_budget`）；
- 命中 `warmRatio`（默认 **0.36**）→ 仅记 `BUDGET_WARMING`，不阻断；
- 命中 `softRatio`（默认 **0.6**）→ Reasoning Sandwich 自动降级：Planning 仍强模型、Acting 降级更便宜模型，并行度 ÷2，**继续执行**；
- 命中 `expandRequestRatio`（默认 **0.8**）→ 发 `PendingApproval(kind='budget_expand')` + `APPROVAL_REQUESTED`（Docs/Agent/11 §6），超时 `approvalTimeoutSec`（默认 **60 秒**；⚠️ 2026-10-03 校准：运行期生效值实为 **300 秒 / security.json**，60 为未被读取的 supervision.json 值——真源待裁定，见本节校准注）无应答 → **默认拒绝并命中硬预算**；
- 命中 `hardRatio`（默认 **1.0**）→ 立即中止 + 回滚至 `lastCheckpointId`。

> **v2.1 修正三处**：① 原文"软预算 50%"与 Docs/Agent/04 的 `taskSoft = 0.6` 不兼容，现统一为 0.36 / 0.6 / 0.8 / 1.0 四档比例；
> ② 原文引用的事件 `BUDGET_EXPAND_APPROVAL` **未在 Docs/Agent/07 §4.3 注册**（违反其自身"禁止自由字符串"红线），改用 `PendingApproval.kind` + `APPROVAL_REQUESTED`；
> ③ 原文"20s 无应答自动硬停"与 `approvalTimeoutSec = 60` 且**超时默认拒绝（而非硬停）**矛盾，已按 Docs/Agent/11 §6.3 对齐。


---

## 8. 依赖关系

> **2026-10-03 校准**：原表以"类名"口径列出 `LlmCaller` / `ContextManager` / `AgentFactory` / `AgentRegistry` ——
> 前两者**全仓不存在该标识符**，后两者实为**函数模块**而非类。现与 §2.1 已做过的"类名不存在"清理保持一致：改为真实模块路径 + 函数名，并新增「是否被编排链路实际引用」列。

| 依赖组件 | 真实来源（模块 · 符号） | 用途 | 是否被编排链路引用 |
|---------|----------------------|------|------------------|
| ~~`LlmCaller`（Tools 层）~~ → 模型调用 | `Core/Model/modelCaller.ts` + `Infra/Llm/*`（Tools 层**无**此件） | 复杂度评估、质量验收的 LLM 调用 | ❌ 否——评估器为关键词启发式、`llmJudge` 需调用方注入 `callModel`，编排链路无调用点 |
| `agentFactory` | `Core/AgentRuntime/agentFactory.ts · createAgent()` | 创建 Agent 实例 | ✅ 是——`orchestrator.ts` 四个 Handler 均直接调用（⚠️ 绕过招募服务，见 §3.1 [4]） |
| `agentRegistry` | `Core/AgentRuntime/agentRegistry.ts · registerAgent() / getAgent() / setAgentParent()` | 注册/查询 Agent 状态 | ⚪ 间接——由 `createAgent()` / `recruitAgent()` 内部调用，编排器本身不 import |
| ~~`ContextManager`（Core）~~ → 上下文装配 | `Services/Context/assembler.ts`（**Core 下无此件**） | 上下文组装与分区 | ❌ 否——由主循环侧使用，编排链路无引用 |
| `agentRuntime` | `Core/AgentRuntime/agentRuntime.ts · assignTask() / submitForReview() / reviewSubmission()` | 任务派发、提交评审、状态迁移 | ✅ 部分——仅 `assignTask()` 被 `executeDirect()` / `executeDelegation()` 调用；评审两函数零生产调用者（§7.1） |
| `progressTracker` / `resultAggregator` / `mergePhase` / `conflictPrecheck` | `Core/Decision/orchestrator/*` | 进度追踪、结果聚合、合并与冲突预检测 | ⚠️ 仅前者部分——`orchestrator.ts` import `initProgressTracker()` / `registerAssignment()` / `resetAggregator()`；后三者（聚合、合并、预检测）**未被 import 或未被调用** |
| `EventBus` | `Services/EventBus/eventBus.ts · publish() / createEvent()`（事件枚举 `eventTypes.ts`） | 事件发布/订阅 | ✅ 是——`receiveTask()` / `executeDelegation()` 发布 `TASK_RECEIVED` / `TASK_DECOMPOSED` / `TASK_ASSIGNED`（清单见 §3.1） |
| `TokenEconomy` | `Services/TokenEconomy/walletManager.ts · createWallet()`；`profitDistributor.ts · calculateDistribution() / executeDistribution()`；`dualBudget.ts` | Token 扣减、结算、预算档位 | ⚪ 部分——仅 `createWallet()` 经 `createAgent()` 被调用；**分润 API 未被编排调用**（§3.1 [7]），预算档位由 `Core/Loop/runIteration.ts` 侧消费（§7B） |
| `SharedMemory` | `Services/SharedMemory/`（`globalWorkspace.ts` / `versionedEntry.ts` / `workspaceLock.ts` / `writeGuard.ts`） | 共享记忆读写、乐观锁 | ❌ 否——编排链路无引用（§7A.1 的乐观锁能力已就绪但未接入编排） |
| `Arbitration` | `Services/Arbitration/` | 冲突触发仲裁 | ❌ 否——`CONFLICT_DETECTED` 无订阅者，无对仲裁服务的调用（§7A.2） |
| `Sandbox 隔离` | `Infra/Sandbox/workspaceIsolator.ts` / `gitWorktreeManager.ts` | 并行 Agent 工作区隔离 | ❌ 否——仅被 `mergePhase` / `conflictPrecheck` 调用，而后者未接入编排（§7A.1） |
| `LoopControl Verifier` | `Services/LoopControl/verifier/index.ts · runVerifierPipeline()` | 四级质量验收 | ❌ 否——`runVerifierPipeline()` 零生产调用者（§7.2） |

---

## 9. 修订历史

| 日期 | 修订 | 摘要 |
|------|------|------|
| 2026-09-22 | 文档-代码对账（第一轮） | 建立"函数式 API + 实现状态列"骨架；澄清 `AgentManager`/`QualityInspector` 类名不存在、`AgentConfig`/`trustLevel` 为权限声明目标态、RoutingMode 6 成员 vs WorkingMode 7 值 |
| 2026-10-03 | **文档-代码校准（第二轮）** | 依据 `Docs/Dev/Agent-03-Agent编排引擎设计-差别清单.md` 逐条复核当前代码后回写：目录大小写更正（`complexityAssessor/`、`routeDecision/`）；**全文行号锚点改为「文件 + 导出符号」定位**；`RoutingRules` → `RoutingRulesConfig`；`TokenEconomy.settle()` → `calculateDistribution()`/`executeDistribution()`；`submit_for_review` → `agent.submit_review`；`TaskPlan.subtasks/dependencies` → `assignments[].dependsOn`；`TaskAssignment` 补 3 字段并更正 2 个类型写法；defectCategory 补第 5 值 `external`；`NextAction` 补至 5 值；§7.4 Rubric 按实存 `verifierL3Calibration.json` 重写（维度/权重/样本量）；§6/§7/§7A/§7.7 全部"函数存在但零生产调用者 / 事件链不闭合"降级为 ⚠️；§4.4 ASSEMBLY_LINE 与 §7A.1 补状态标注；§7A.2 `[8]` 重编号为 `[M]`；§8 依赖表改真实模块 + "是否被编排引用"列。**新增事实（代码已推进，原结论作废）**：`agent.recruit` 工具已从 S10 桩改为真实实现并调用 `recruitAgent()`，`RecruitmentRequest` 新增 `taskPrompt?`、编排约束落库 `agents` 表、`getRecruitedAgents()` 已非桩——但**编排链路仍不经招募服务**。 |

### 9.1 待人工裁定登记（本文不代裁决）

| # | 事项 | 现状 | 归属 |
|---|------|------|------|
| 1 | 前端 `WorkingMode` 7 值是否应真正决定后端路由 | 现仅 UI 展示；IPC 收下即弃、REST 不传、`forceRoute()` 零调用（§4） | 产品 + 编排 |
| 2 | 进度追踪事件链断链的修法 | `TASK_STARTED/PROGRESS/FAILED` 无发布者；payload 键 `assignmentId` vs `taskId` 不匹配；`AgentProgress` 未存时限（§6.1） | 编排 |
| 3 | `TaskAssignment.outputSchema → VerifierSpec(L1,schema)` 转换层归属 | 两侧均存在，中间无桥接代码（§7.2 [L1]） | 架构 |
| 4 | 审批超时真源（300s/security.json vs 60s/supervision.json） | 运行期取 300；需与 Docs/Agent/10 §2.7、11 §6.3 同步（§7.2 / §7B） | 治理 + 文档 |
| 5 | L3 校准基线（0.80 还是 0.85）与样本量（实存 5 / 要求 50） | 配置、校准文件、文档三方互斥；数据集目录不存在（§7.4） | 质量 / 算法 |
| 6 | `FailureFeedback` 两条升级阈值是否统一实现 | "同类缺陷连续 3 次"被近似为"已试策略数 ≥ 3"；"连续 2 次无改善"实由 `stopRules.noProgress` 承担（§7.5） | Loop |
| 7 | "仅 L1 可招募"的门禁落点 | 仅工具 Spec `requiredRoles` 声明；服务层与编排层无角色校验（§1 / §5.1） | 编排 + 安全 |

**代码侧待办（文档不代改，仅登记）**：
- `routeDecision/routingRules.ts` 文件头"从 routingRules.json 加载"注释与实际不符，且 `updateRoutingRules()` 无生产调用者（§3.3）；
- `Tests/Decision/multiAgentOrchestration.spec.ts`、`Tests/E2E/*.spec.ts` 仍用 `Orchestrator/`、`RouteDecision` 大写路径，Linux/CI 大小写敏感下会解析失败（§2.1）；
- `reviewerAgent.ts · performReview()` 恒 `accepted = true`（§2.1 / §7.1）、ADR-0004 缺 CI 门禁（§7.1 红线 3）。
