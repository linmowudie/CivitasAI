# Agent 编排引擎设计

> 本文档定义 Prime Director 的编排引擎，包括意图识别、复杂度评估、路由决策、任务拆解、Agent 招募/管理、进度追踪和结果汇总的完整设计。

---

## 1. 职责边界

> **v2.2 修订**：编排引擎不再限于 Prime Director 独占，所有 L1 入口级 Agent（Prime Director + Partner）均具备编排能力。治理三权（Regulator/Auditor/Arbitrator）不参与编排，仅在冲突时介入。

| 职责 | 说明 |
|------|------|
| 需求解析 | 接收用户需求，理解意图 |
| 复杂度评估 | 评估任务难度、Token 消耗、所需专业域 |
| 路由决策 | 根据评估结果选择 6 种路由模式之一 |
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

| 组件 | 实现（函数 / 模块路径） | 职责 | 实现状态 |
|------|----------------------|------|---------|
| 复杂度评估器 | `assessComplexity()` · `Core/Decision/ComplexityAssessor/complexityAssessor.ts:51` | 分析任务复杂度，输出结构化评估报告 | ✅ 已实现，但为**关键词启发式**（Phase 0-2），尚未接 LLM；`Prompts/` 下亦无 `complexityAssessment.md` |
| 路由决策器 | `decideRoute()` · `Core/Decision/RouteDecision/routeDecision.ts:26` | 根据评估报告 + 可配规则选择路由模式 | ✅ 已实现（纯函数，非类） |
| 任务拆解器 | `decomposeTask()` · `Core/Decision/TaskDecomposer/taskDecomposer.ts:35` | 将任务拆解为子任务，生成任务分配书 | ✅ 已实现 |
| Agent 生命周期管理 | 创建 `createAgent()` · `Core/AgentRuntime/agentFactory.ts:25`；注册/查询 `Core/AgentRuntime/agentRegistry.ts`；招募 `recruitAgent()` · `Services/Recruitment/recruiter.ts:26`；开除 `expelAgent()` · `:81` | 招募/开除/状态管理 Agent 实例 | ⚠️ 原类名 `AgentManager` 全库不存在；能力由上述函数式 API 分担 |
| 进度追踪器 | `initProgressTracker()` / `registerAssignment()` / `updateProgress()` / `checkTimeouts()` / `checkStagnation()` / `checkConsecutiveFailures()` / `detectAllAnomalies()` · `Core/Decision/orchestrator/progressTracker.ts` | 监控各 Agent 执行状态，检测超时/异常 | ✅ 已实现（函数式，非 `ProgressTracker` 类；见 §6.1） |
| 质量验收 | 四级 Verifier · `Services/LoopControl/verifier/`（`hardVerifier` / `ruleVerifier` / `llmJudge` / `humanGateCore` / `antiGaming`）+ Checker 实例 `performReview()` · `Services/ReviewerAgent/reviewerAgent.ts:42` | 评估 Agent 交付物质量（详见 §7） | ⚠️ 原类名 `QualityInspector` 全库不存在；且**编排器主流程未调用**（见 §3.1） |
| 结果聚合器 | `aggregateResults()` · `Core/Decision/orchestrator/resultAggregator.ts:18` | 整合子任务结果，生成最终交付物 | ✅ 函数已实现；⚠️ `orchestrator.ts` 仅 import，**未接入主流程** |

---

## 3. 编排流程（端到端）

### 3.1 主流程

> **2026-09-22 校准**：下图按代码实际接线重绘（`Core/Decision/orchestrator/orchestrator.ts`）。
> `[4]` 的 `switch` **仅落地 4 个模式**，其余 3 个落 `default` 直接返回错误；`[5]`~`[7]` 三步**当前均未接入主流程**——各已实现模式在 `[4]` 内即以 `status:'success'` 直接返回。

```
用户输入需求
    │
    ▼
[1] receiveTask(params)                         ✅ orchestrator.ts:65（函数式入口，非 Orchestrator 类）
    │
    ▼
[2] assessComplexity(input)                     ✅ complexityAssessor.ts:51
    │  → 当前为「关键词启发式 + 文本长度估算」（Phase 0-2）
    │    ⚠️ 未接 LLM，Prompts/ 下亦无 complexityAssessment.md
    │  → 输出 ComplexityReport
    │
    ▼
[3] decideRoute(report)                         ✅ routeDecision.ts:26
    │  → 按 §3.3 优先级匹配路由规则
    │  → 输出 RouteDecisionResult { mode, params }
    │
    ▼
[4] switch (route.mode)                         ⚠️ orchestrator.ts:97-108 —— 仅 4 个分支已接线
    │
    │  ┌─ 已实现（4）：创建 Agent → 拆解 → 招募 → 注册进度 → 直接返回 status:'success'
    ├── DIRECT         → executeDirect()         ✅ orchestrator.ts:113
    ├── DELEGATION     → executeDelegation()     ✅ orchestrator.ts:140
    ├── ASSEMBLY_LINE  → executeAssemblyLine()   ✅ orchestrator.ts:220
    ├── CONSORTIUM     → executeConsortium()     ✅ orchestrator.ts:275
    │
    │  ┌─ S12 待接线（3）：无 Handler，落 default → err(`路由模式 X 尚未实现（S12）`)
    ├── LITIGATION     → ⚠️ 待实现（S12）
    ├── REGULATION     → ⚠️ 待实现（S12）
    └── AUDIT          → ⚠️ 待实现（S12）；且不属于后端 RoutingMode（见 Docs/01 §4.1），
    │                       由监管/稽查服务链路承载
    ▼
[5] aggregateResults(subtaskResults)            ⚠️ 未接线：函数已实现（resultAggregator.ts:18），
    │                                              但 orchestrator 仅 import、主流程未调用
    ▼
[6] 质量验收                                     ⚠️ 未接线（桩）：全库无 QualityInspector 类
    │  → 旧「LLM 打分 ≥ 60 才交付」已被 §7 四级 Verifier 取代
    │  → 目标态：Services/LoopControl/verifier/ L1→L4 + Reviewer Agent（§7.1 Maker-Checker）
    ▼
[7] TokenEconomy.settle(traceId, contributions) ⚠️ 未接线：编排主流程中无任何 settle 调用（见 §7.7）
    │
    ▼
[8] 返回 OrchestrationResult                     ✅ 当前各已实现模式实际在 [4] 内即返回
```

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

```typescript
interface RoutingRules {
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

## 4. 路由模式处理器（7 种，4 已接线 / 3 待 S12）

> **2026-09-22 校准**：原标题「六种路由模式处理器」与下列 4.1–4.7 共 **7** 个子节自相矛盾。按 `orchestrator.ts:97-108` 实际接线更正为：
> - **已接线（4）**：`DIRECT` / `DELEGATION` / `ASSEMBLY_LINE` / `CONSORTIUM`；
> - **S12 待接线（2）**：`LITIGATION` / `REGULATION`——在 `RoutingMode` 类型中存在，但 `switch` 落 `default` 返回"尚未实现（S12）"；
> - **S12 待接线（1）**：`AUDIT`——**不属于后端 `RoutingMode`**，由监管/稽查服务链路（`Services/Audit/`）承载，见 Docs/01 §4.1。

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
> 当前 `executeDelegation()`（`orchestrator.ts:140`）实际执行到 `[4]` 招募与进度注册后，即以 `status:'success'` 返回。

**TaskAssignment（任务分配书）结构：**

```typescript
interface TaskAssignment {
  assignmentId: string;              // UUID
  taskId: string;                    // 关联的主任务 ID
  traceId: string;                   // 全局追踪 ID
  subtaskIndex: number;              // 子任务序号
  
  // 任务定义
  description: string;               // 任务描述
  inputContext: Record<string, any>; // 输入上下文
  outputSchema: JSONSchema;          // 期望输出 Schema
  
  // 约束
  maxIterations: number;             // 最大迭代次数
  timeLimitMs: number;               // 时间上限（毫秒）
  tokenBudget: number;               // Token 预算
  
  // 依赖
  dependsOn: string[];               // 依赖的子任务 assignmentId 列表
  requiredTools: string[];           // 允许使用的工具列表（最小权限）
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
> 当前 `executeConsortium()`（`orchestrator.ts:275`）仅执行到"创建 Director → 拆解 → 逐子任务招募 Partner 并注册进度"，即以 `status:'success'` 返回。

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

### 4.5 LITIGATION（司法仲裁）⚠️ 待接线（S12）

> 详见 `Docs/05-仲裁系统/仲裁系统设计.md`
> **实现状态**：`RoutingMode` 含此成员，但 `orchestrator.ts` 的 `switch` 无对应分支，命中即落 `default` 返回"尚未实现（S12）"。

### 4.6 REGULATION（行政协调）⚠️ 待接线（S12）

> 详见 `Docs/06-监管与审计系统/监管与审计系统设计.md`
> **实现状态**：同 §4.5——`RoutingMode` 含此成员，编排器落 `default` 返回"尚未实现（S12）"；`Services/Regulation/` 已有实现但尚未被编排链路调用。

### 4.7 AUDIT（税务稽查）⚠️ 待接线（S12）

> 详见 `Docs/06-监管与审计系统/监管与审计系统设计.md`
> **实现状态**：**不是后端 `RoutingMode` 成员**（仅前端 `WorkingMode` 有 `AUDIT`，见 Docs/01 §4.1），不经编排路由，由 `Services/Audit/`（`resourceAuditBureau` / `anomalyDetector` / `freezeManager` / `patrolScheduler`）稽查服务链路承载，S12 接线。

---

## 5. Agent 招募机制

### 5.1 招募流程

> **v2.2 修订**：招募权不再限于 Director，所有 L1 入口级 Agent（Prime Director + Partner）均可发起招募。L2 子 Agent 不可招募下级。
>
> **2026-09-22 校准**：实际 API 为**函数式** `recruitAgent(request: RecruitmentRequest)`（`Services/Recruitment/recruiter.ts:26`），非 `AgentRecruiter.recruit(requirements)`；实例创建为 `createAgent({ role, model }, traceId)`（`Core/AgentRuntime/agentFactory.ts:25`），非 `AgentFactory.create(config)`。下图逐步标注实现状态。

```
L1 入口级 Agent（Prime Director / Partner）发起招募请求
    │
    ▼
recruitAgent(request)                              ✅ Services/Recruitment/recruiter.ts:26
    │  （入参 RecruitmentRequest：role / domain / requiredTools / tokenBudget /
    │    maxIterations / timeLimitMs / traceId / parentAgentId）
    │  校验：traceId、parentAgentId 非空，tokenBudget > 0
    │
    ├── [1] 解析需求（专业域、工具集、Token 预算）    ✅ 仅做入参校验
    ├── [2] 生成 Agent 配置                          ⚠️ 待实现（S10）——当前不做下列任一项
    │   ├── 选择角色 Prompt（partner.md / worker.md / reviewer.md 等）
    │   ├── 工具可见性由 requiredRoles 白名单自动裁剪（最小权限原则）
    │   └── 分配初始 Token（从系统池划拨）
    ├── [3] createAgent({ role, model }, traceId)     ✅ agentFactory.ts:25
    │   ├── 创建 AgentInstance                        ⚠️ model 当前由调用方写死（'worker-model'）
    │   ├── 分配 agent_id（实际格式：agent-{role}-{n}，进程内递增序号，非 {role}-{uuid8}）
    │   ├── 创建私有上下文空间                        ⚠️ 未实现（createAgent 不建上下文空间）
    │   └── 创建 Token 钱包                           ✅ createWallet()；失败不阻断（降级）
    └── [4] 注册到 AgentRegistry                      ✅ registerAgent()，状态置为 ready（小写）
        └── 发布 AGENT_RECRUITED 事件                 ✅
```

> **工具层入口**：LLM 可调用的 `agent.recruit` 工具（`Tools/Custom/agentRecruiter.ts`）当前为**桩实现**，`execute` 直接返回 `NOT_IMPLEMENTED`——"agent.recruit 待 S10 实现"（`:37`）。上述 `recruitAgent()` 服务函数已可用，但**尚未与工具入口接线**。

### 5.2 Agent 配置模板

> **v2.2 修订**：`role` 扩展为完整 8 角色（对齐 `UserRole` 类型），工具可见性由 `requiredRoles` 白名单决定（详见 Docs/11 §3.3.1），不再使用 `allowedTools` 手动指定。

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

> **2026-09-22 校准**：实际 API 为**函数式** `expelAgent(params)`（`Services/Recruitment/recruiter.ts:81`），入参是对象 `{ agentId, taskId, traceId, reason, evidence, decidedBy }`，非 `AgentManager.expel(agentId, reason)`；重新招募为 `recruitAgent(originalRequest)`，二者已组合为 `expelAndReplace()`（`:134`）。

```
Director 检测到 Worker 连续 3 次失败
    │
    ▼
expelAgent({ agentId, taskId, traceId, reason, evidence, decidedBy })   ✅ recruiter.ts:81
    │   reason ∈ { capability | laziness | goal_unreasonable | external_error }
    ├── [0] 记录 TerminationRationale                  ✅ 必须在开除前（terminationRationale.ts）
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

---

## 6. 进度追踪与异常检测

### 6.1 ProgressTracker

```typescript
class ProgressTracker {
  // 追踪所有活跃 Agent 的执行状态
  private agentStatuses: Map<string, AgentStatus>;
  
  // 监听事件总线
  onTaskStarted(event: TaskStartedEvent): void;
  onTaskProgress(event: TaskProgressEvent): void;
  onTaskCompleted(event: TaskCompletedEvent): void;
  onTaskFailed(event: TaskFailedEvent): void;
  
  // 异常检测
  checkTimeouts(): AgentStatus[];      // 检测超时 Agent
  checkStagnation(): AgentStatus[];    // 检测停滞 Agent（长时间无进展）
  checkLoopDetection(): AgentStatus[]; // 检测循环（输出相似度 > 0.85）
}
```

### 6.2 异常处理策略

| 异常类型 | 检测方式 | 处理策略 |
|---------|---------|---------|
| 超时 | 超过 `timeLimitMs` | 警告 → 二次超时 → 终止任务 |
| 停滞 | 5 分钟内无 `TaskProgressEvent` | 发送心跳探测 → 无响应则标记异常 |
| 循环 | 连续 3 次输出相似度 > 0.85 | 通知 Audit Bureau → 可能冻结 |
| 连续失败 | 连续 3 次 `TaskFailedEvent` | 开除 + 重新招募 |
| Token 耗尽 | 钱包余额 < 单次调用成本 | 暂停任务 → 通知 Director 补充或终止 |

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
2. Worker **不得**自行宣告完成——必须走 `submit_for_review` 工具触发 Reviewer；
3. Reviewer 使用的模型 id 与 Maker 相同时 → **CI 拒收**（ADR-0004）。

### 7.2 验收流程（四级 Verifier）

```
收到 submit_for_review 事件
    │
    ▼
[L1] 硬验证（必须全过）
    ├─ Schema 校验（TaskAssignment.outputSchema）
    ├─ 自动测试（如交付物为代码：测试用例必须全通）
    ├─ 数值/阈值/存在性检查
    └─ 任一失败 → 直接返 FailureFeedback(evidence=具体失败项)
    │
    ▼
[L2] 规则验证（如定义）
    ├─ 清单覆盖率（必选字段齐备）
    ├─ 参考答案比对（golden dataset）
    ├─ 反游戏检查：变更范围不超合理边界 / 未删失败测试 / 未忽略错误
    └─ 失败 → FailureFeedback
    │
    ▼
[L3] 独立 LLM Judge（不同模型 + 不同提示 + Rubric）
    ├─ 输出必须为：{ pass, evidence[], defectCategory }
    ├─ 禁止自然语言评分（避免不可重现）
    ├─ Rubric 需先通过 50 样本人工标注校准，一致率 ≥ 85%
    └─ 失败 → FailureFeedback
    │
    ▼
[L4] Human Gate（命中以下任一条件时启用）
    ├─ 不可逆动作（发布/删除/支付）
    ├─ 金额超预算 20%
    ├─ 上面三层存在矛盾结论
    ├─ TaskAssignment 显式声明 L4
    └─ 60s 超时 → 默认拒绝（ADR-0001）
    │
    ▼
验收完成：写入 verifier_results 表 + 事件广播
```

**不可跨越红线**（ADR-0003）：L1 未通过时 **禁止** 直接进 L3，避免 Agent “用能说会道绕过硬验证”。

### 7.3 Reviewer Agent 定义

```typescript
// 新增 Agent 角色
interface ReviewerAgent {
  role: 'reviewer';
  model: string;               // 必不同于 producerModel
  promptTemplate: 'prompts/reviewer.md';   // 不共享 Maker 上下文
  tools: ['run_tests', 'check_schema', 'compare_golden', 'llm_judge'];
  context: {
    receives: ['TaskAssignment.originalRequirement', 'deliverable', 'verifierSpecs'];
    doesNotReceive: ['maker_messages_history', 'maker_scratchpad'];   // 隔离 Maker 上下文
  };
}
```

### 7.4 Rubric 模板（L3 使用）

```yaml
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
  defectCategory: enum[spec_missing, logic_error, quality_low, risk_violation]
```

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
- 无改善（improvement < 0.05）连续 2 次 → 命中 §Docs/12 无进展退出；
- **禁止**不写 FailureFeedback 就重试。

### 7.6 验收失败与"开除"判定（修订旧版）

旧版“3 次失败 → 开除”**需细化**，避免错杀：

| 失败性质 | 定义 | 处理 |
|---------|------|------|
| 能力不足 | L1/L2 失败 + 不同 defectCategory + 不同策略 | 3 次后开除 |
| 不努力 | 同一 fingerprint 重复 | 1 次后警告、2 次后开除 |
| 目标不合理 | 不同策略但均失败 ≥ 5 次 | **不开除 Worker，回到 Director 重新拆分任务** |
| 外部异常 | L4 拒绝 / 5xx 服务不可用 | 开除计数 **+0**（不计入 Worker 失败） |

**关键**：开除前 Director **必须**写一份 `TerminationRationale`，列举证据，否则审计局会回滚开除决定。

### 7.7 与 Token 分润的耦合修订

旧版评分 0-100 直接作为分润因子。新版：
- 分润中的"质量分" = **L1 pass率 x 0.4 + L2 pass率 x 0.3 + L3 rubric 加权得分 x 0.3**；
- L1/L2 失败 → 质量分上限 0.4（不允许“能言善辩”拉回）；
- 无 L3（完全确定性任务） → 质分 = L1 x 0.6 + L2 x 0.4。

---

## 7A. 隔离工作区（v2 新增）

> **修订依据**：审查报告 §4.3 —— 并行 Agent 必须隔离工作区。

### 7A.1 隔离级别

| 任务类型 | 隔离方式 | 适用场景 |
|---------|---------|---------|
| **只读** | 无隔离 | 搜索、查询 |
| **写入不同文件** | 目录隔离：`Data/Workspace/{session}/{taskId}/{agentId}/` | 默认 |
| **写入同一仓库** | Git worktree：每 Agent 一个分支 | 代码任务 |
| **修改共享数据** | 乐观锁 + 版本号（见 Docs/07 修订） | SharedMemory |
| **不可逆副作用** | 先写沙箱，验收后提交（draft mode） | 发布/支付类 |

### 7A.2 合并阶段

Orchestrator 新增 `[8] 合并与冲突预检测`：
- 多 Agent 产物 → `ResultAggregator` 先尝试确定性合并（不同文件直接拼装）；
- 同文件冲突 → 写入 `WriteGuard` 拦截，触发冲突→ 交给 Docs/05 仲裁系统；
- 不可自动合并 → 风险退出（`escalate_human`）。

---

## 7B. 预算与预算内降级（v2 新增）

与 Docs/12 §2.1 、Docs/04 修订同步；**本文不重复定义数值**，比例与超时一律引用 `Configs/loopConfig.json → stopRules.budget.*Ratio`（Docs/11 §2.8）与 `Configs/supervision.json → approvalTimeoutSec`（Docs/11 §2.7）。

- **任务总预算** = Director 从钱包划扣到任务子账户；
- **子预算** = 每个 Worker 从任务子账户预分配（数值上 = 该 Worker 的 `LoopConfig.token_budget`）；
- 命中 `warmRatio`（默认 **0.36**）→ 仅记 `BUDGET_WARMING`，不阻断；
- 命中 `softRatio`（默认 **0.6**）→ Reasoning Sandwich 自动降级：Planning 仍强模型、Acting 降级更便宜模型，并行度 ÷2，**继续执行**；
- 命中 `expandRequestRatio`（默认 **0.8**）→ 发 `PendingApproval(kind='budget_expand')` + `APPROVAL_REQUESTED`（Docs/12 §6），超时 `approvalTimeoutSec`（默认 **60 秒**）无应答 → **默认拒绝并命中硬预算**；
- 命中 `hardRatio`（默认 **1.0**）→ 立即中止 + 回滚至 `lastCheckpointId`。

> **v2.1 修正三处**：① 原文"软预算 50%"与 Docs/04 的 `taskSoft = 0.6` 不兼容，现统一为 0.36 / 0.6 / 0.8 / 1.0 四档比例；
> ② 原文引用的事件 `BUDGET_EXPAND_APPROVAL` **未在 Docs/07 §4.3 注册**（违反其自身"禁止自由字符串"红线），改用 `PendingApproval.kind` + `APPROVAL_REQUESTED`；
> ③ 原文"20s 无应答自动硬停"与 `approvalTimeoutSec = 60` 且**超时默认拒绝（而非硬停）**矛盾，已按 Docs/12 §6.3 对齐。


---

## 8. 依赖关系

| 依赖组件 | 来源 | 用途 |
|---------|------|------|
| `LlmCaller` | Tools 层 | 复杂度评估、质量验收的 LLM 调用 |
| `AgentFactory` | Core/AgentRuntime | 创建 Agent 实例 |
| `AgentRegistry` | Core/AgentRuntime | 注册/查询 Agent 状态 |
| `ContextManager` | Core | 上下文组装与分区 |
| `EventBus` | Services | 事件发布/订阅 |
| `TokenEconomy` | Services | Token 扣减、结算 |
| `SharedMemory` | Services | 共享记忆读写 |
| `Arbitration` | Services | 冲突触发仲裁 |
