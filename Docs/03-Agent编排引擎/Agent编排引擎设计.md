# Agent 编排引擎设计

> 本文档定义 Prime Director 的编排引擎，包括意图识别、复杂度评估、路由决策、任务拆解、Agent 招募/管理、进度追踪和结果汇总的完整设计。

---

## 1. 职责边界

| 职责 | 说明 |
|------|------|
| 需求解析 | 接收用户需求，理解意图 |
| 复杂度评估 | 评估任务难度、Token 消耗、所需专业域 |
| 路由决策 | 根据评估结果选择 6 种路由模式之一 |
| 任务拆解 | 将复杂任务分解为可分配的子任务 |
| Agent 招募 | 根据子任务需求招募/雇佣合适的 Agent |
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

### 2.1 组件定义

| 组件 | 类名 | 职责 |
|------|------|------|
| 复杂度评估器 | `ComplexityAssessor` | 调用 LLM 分析任务复杂度，输出结构化评估报告 |
| 路由决策器 | `RouteDecision` | 根据评估报告 + 可配规则选择路由模式 |
| 任务拆解器 | `TaskDecomposer` | 将任务拆解为子任务，生成任务分配书 |
| Agent 管理器 | `AgentManager` | 招募/开除/状态管理 Agent 实例 |
| 进度追踪器 | `ProgressTracker` | 监控各 Agent 执行状态，检测超时/异常 |
| 质量检查器 | `QualityInspector` | 评估 Agent 交付物质量（调用 LLM 判定） |
| 结果聚合器 | `ResultAggregator` | 整合子任务结果，生成最终交付物 |

---

## 3. 编排流程（端到端）

### 3.1 主流程

```
用户输入需求
    │
    ▼
[1] Orchestrator.receiveTask(userRequest)
    │
    ▼
[2] ComplexityAssessor.assess(userRequest)
    │  → 调用 LLM（使用 complexityAssessment.md 提示词）
    │  → 输出 ComplexityReport
    │
    ▼
[3] RouteDecision.decide(complexityReport)
    │  → 匹配路由规则
    │  → 输出 RouteDecision { mode, params }
    │
    ▼
[4] 根据 mode 执行对应路由处理器
    │
    ├── DIRECT → Orchestrator.executeDirectly(userRequest)
    ├── DELEGATION → DelegationHandler.execute(taskPlan)
    ├── CONSORTIUM → ConsortiumHandler.execute(taskPlan)
    ├── ASSEMBLY_LINE → AssemblyLineHandler.execute(sop)
    ├── LITIGATION → LitigationHandler.execute(dispute)
    ├── REGULATION → RegulationHandler.handle(event)
    └── AUDIT → AuditHandler.handle(alert)
    │
    ▼
[5] ResultAggregator.aggregate(subtaskResults)
    │
    ▼
[6] QualityInspector.inspect(finalResult)
    │  → 评分 ≥ 60 → 交付
    │  → 评分 < 60 → 标记失败，触发重试/重分配
    │
    ▼
[7] TokenEconomy.settle(traceId, contributions)
    │
    ▼
[8] 返回最终结果给用户
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

## 4. 六种路由模式处理器

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

### 4.5 LITIGATION（司法仲裁）

> 详见 `Docs/05-仲裁系统/仲裁系统设计.md`

### 4.6 REGULATION（行政协调）

> 详见 `Docs/06-监管与审计系统/监管与审计系统设计.md`

### 4.7 AUDIT（税务稽查）

> 详见 `Docs/06-监管与审计系统/监管与审计系统设计.md`

---

## 5. Agent 招募机制

### 5.1 招募流程

```
Director 发起招募请求
    │
    ▼
AgentRecruiter.recruit(requirements)
    │
    ├── [1] 解析需求（专业域、工具集、Token 预算）
    ├── [2] 生成 Agent 配置
    │   ├── 选择角色 Prompt（partner.md / worker.md）
    │   ├── 配置工具白名单（最小权限原则）
    │   └── 分配初始 Token（从系统池划拨）
    ├── [3] AgentFactory.create(config)
    │   ├── 创建 AgentRuntime 实例
    │   ├── 分配 agent_id（格式：{role}-{uuid8}）
    │   ├── 创建私有上下文空间
    │   └── 创建 Token 钱包
    └── [4] 注册到 AgentRegistry
        └── 状态设为 Ready
```

### 5.2 Agent 配置模板

```typescript
interface AgentConfig {
  agentId: string;
  role: 'partner' | 'worker' | 'assembly_node';
  traceId: string;                   // 关联的全局 trace_id
  parentAgentId: string;             // 招募者的 agent_id（通常是 Director）
  
  // Prompt 配置
  systemPrompt: string;              // 角色 Prompt 内容
  taskPrompt?: string;               // 任务特定 Prompt
  
  // 工具配置
  allowedTools: string[];            // 工具白名单
  deniedTools: string[];             // 显式禁止的工具
  
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

```
Director 检测到 Worker 连续 3 次失败
    │
    ▼
AgentManager.expel(agentId, reason)
    ├── [1] 冻结 Agent（状态 → Expelled）
    ├── [2] 回收剩余 Token（退回系统池）
    ├── [3] 保存操作历史（失败原因、历史记录）
    ├── [4] 清理私有上下文
    └── [5] 广播 AGENT_EXPELLED 事件
    │
    ▼
AgentRecruiter.recruit(原需求)  // 重新招募
    └── 新 Agent 继承原任务上下文（从共享记忆获取）
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
