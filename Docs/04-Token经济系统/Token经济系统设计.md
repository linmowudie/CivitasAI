# Token 经济系统设计

> 本文档定义 Civitas-AI 的 Token 经济系统，包括钱包管理、消耗计量、税收机制、收益分配和 Token 流转的完整设计。

---

## 1. 职责边界

| 职责 | 说明 |
|------|------|
| 钱包管理 | 为每个 Agent 创建/销毁独立 Token 钱包 |
| 消耗计量 | 精确记录每次 LLM 调用的 Token 消耗 |
| 税收征收 | 按动态税率征收"系统税" |
| 收益分配 | Consortium 模式下按贡献度自动分润 |
| 异常稽查 | 配合 Audit Bureau 检测异常消耗 |
| 账本审计 | 保证 Token 总量守恒，每笔交易可追溯 |

**不负责：** 异常判定（由 Audit Bureau 负责）、冻结执行（由 FreezeManager 负责）、仲裁裁决中的 Token 划扣（由 Arbitration 触发，本系统执行）。

---

## 2. 核心数据模型

### 2.1 Token 钱包

```typescript
interface TokenWallet {
  walletId: string;                  // UUID
  agentId: string;                   // 所属 Agent
  balance: number;                   // 当前余额
  totalEarned: number;               // 累计收入
  totalSpent: number;                // 累计消耗
  totalTaxPaid: number;              // 累计纳税
  totalFrozen: number;               // 被冻结金额（稽查中）
  
  status: 'active' | 'frozen' | 'closed';
  createdAt: number;                        // epoch ms
  updatedAt: number;                        // epoch ms
}
```

### 2.2 Token 交易记录

```typescript
interface TokenTransaction {
  transactionId: string;             // UUID
  walletId: string;                  // 关联钱包
  traceId: string;                   // 关联运行会话
  operationId?: string;              // 关联操作
  
  type: TransactionType;
  amount: number;                    // 正数=收入，负数=支出
  balanceAfter: number;              // 交易后余额
  
  // 交易详情
  description: string;               // 人类可读描述
  metadata: Record<string, any>;     // 扩展信息
  
  createdAt: number;                        // epoch ms
}

type TransactionType =
  | 'LLM_CONSUMPTION'               // LLM 调用消耗
  | 'TASK_REWARD'                    // 任务完成奖励
  | 'PROFIT_SHARING'                 // 分润收入
  | 'TAX_PAYMENT'                    // 纳税
  | 'ARBITRATION_PENALTY'           // 仲裁罚款
  | 'ARBITRATION_COMPENSATION'      // 仲裁补偿
  | 'INITIAL_ALLOCATION'            // 初始分配
  | 'FREEZE'                        // 冻结
  | 'UNFREEZE'                      // 解冻
  | 'CONFISCATION'                  // 罚没
  | 'REFUND';                       // 退款
```

### 2.3 消耗记录

```typescript
interface ConsumptionRecord {
  recordId: string;
  traceId: string;
  agentId: string;
  operationId: string;
  
  // 模型信息
  provider: string;                  // 如 "openai"
  model: string;                     // 如 "gpt-4o"
  
  // Token 计量
  promptTokens: number;              // 输入 Token
  completionTokens: number;          // 输出 Token
  totalTokens: number;               // 总 Token
  
  // 成本计算
  unitCostPer1K: number;            // 每 1K Token 单价
  calculatedCost: number;            // 计算出的消耗量
  taxAmount: number;                 // 税额
  netDeduction: number;              // 实际扣减（消耗+税）
  
  // 时间
  startedAt: number;                        // epoch ms
  completedAt: number;                      // epoch ms
}
```

---

## 3. 核心流程

### 3.1 Token 消耗流程

```
Agent 发起 LLM 调用
    │
    ▼
[1] WalletManager.checkBalance(agentId, estimatedCost)
    ├── 余额充足 → 继续
    └── 余额不足 → 抛出 InsufficientBalanceError
    │
    ▼
[2] LlmCaller.call(model, messages)
    │  → 获得响应 + 实际 Token 用量
    │
    ▼
[3] TokenLedger.recordConsumption(consumption)
    ├── [3a] 计算消耗：totalTokens × unitCostPer1K / 1000
    ├── [3b] 计算税额：consumption × currentTaxRate
    ├── [3c] 扣减钱包：balance -= (consumption + tax)
    ├── [3d] 写入交易记录（LLM_CONSUMPTION + TAX_PAYMENT）
    └── [3e] 广播 TOKEN_CONSUMED 事件
    │
    ▼
[4] 返回响应给 Agent
```

### 3.2 任务奖励流程

```
Director 确认任务完成
    │
    ▼
[1] QualityInspector 评估质量 → 得到质量评分
    │
    ▼
[2] TokenEconomy.calculateReward(taskAssignment, qualityScore)
    ├── 基础奖励 = taskTokenBudget × (qualityScore / 100)
    ├── 效率加成 = 基础奖励 × efficiencyBonus(实际耗时/预算耗时)
    └── 最终奖励 = 基础奖励 + 效率加成
    │
    ▼
[3] WalletManager.credit(agentId, reward, 'TASK_REWARD')
    ├── 增加钱包余额
    ├── 写入交易记录
    └── 广播 TOKEN_EARNED 事件
```

### 3.3 Consortium 分润流程

```
Consortium 任务完成
    │
    ▼
[1] ProfitDistributor.calculate(contract, contributions)
    │
    ├── 对每个 Partner 计算三维贡献分：
    │   ├── 质量分 = QualityInspector 评估的采纳率
    │   ├── 数量分 = 有效输出 Token 数 / 总输出 Token 数
    │   └── 效率分 = (1 / 实际耗时) / Σ(1 / 各Partner耗时)
    │
    ├── 综合分 = Wq×质量分 + Wn×数量分 + We×效率分
    │   默认权重：Wq=0.5, Wn=0.3, We=0.2
    │
    └── 各 Partner 分润 = tokenPool × (综合分 / Σ所有综合分)
    │
    ▼
[2] 对每个 Partner 执行钱包入账
    ├── WalletManager.credit(partnerId, share, 'PROFIT_SHARING')
    ├── 写入交易记录（关联 contractId）
    └── 广播 TOKEN_DISTRIBUTED 事件
```

---

## 4. 税收机制

### 4.1 税率模型

```typescript
interface TaxConfig {
  // 基础税率
  baseRate: number;                  // 默认 0.05（5%）
  
  // 动态调整
  dynamicEnabled: boolean;           // 是否启用动态税率
  adjustmentInterval: number;        // 调整间隔（秒），默认 300
  maxRate: number;                   // 最高税率，默认 0.20
  minRate: number;                   // 最低税率，默认 0.02
  
  // 调整规则
  highLoadMultiplier: number;        // 系统高负载时税率乘数，默认 1.5
  lowLoadDiscount: number;           // 系统低负载时税率折扣，默认 0.8
  loadThreshold: number;             // 负载阈值（活跃 Agent 数），默认 10
}
```

### 4.2 动态税率调整算法

```
每 adjustmentInterval 秒执行一次：

currentLoad = activeAgentCount
if currentLoad > loadThreshold:
    currentRate = min(baseRate × highLoadMultiplier, maxRate)
else:
    currentRate = max(baseRate × lowLoadDiscount, minRate)

广播 TAX_RATE_UPDATED 事件
```

### 4.3 税收用途

| 用途 | 比例 | 说明 |
|------|------|------|
| 系统运转基金 | 60% | 用于支付 LLM 调用的基础成本 |
| 风险准备金 | 30% | 用于异常情况的 Token 补偿 |
| 销毁 | 10% | 通缩机制，防止 Token 通胀 |

---

## 5. 异常消耗处理

### 5.1 与 Audit Bureau 的协作

> **发布方口径**（与 `Docs/06 §3`、`Docs/07 §4.3` 一致）：`WALLET_FROZEN` / `WALLET_UNFROZEN` / `TOKEN_CONFISCATED` 的 `source` **统一为本子系统（TokenEconomy）**，审计仅作为 `payload.initiator`；审计自身只发布 `ANOMALY_DETECTED` / `AUDIT_COMPLETED` / `PATROL_REPORT`。

```
Audit Bureau 的 AnomalyDetector 检测到异常（发布 ANOMALY_DETECTED）
    │
    ▼
[1] Audit → TokenEconomy: freezeWallet(agentId, reason)
    ├── 将钱包状态设为 'frozen'
    ├── 记录冻结金额
    ├── 发布 WALLET_FROZEN（source='TokenEconomy'，initiator='AuditBureau'）
    └── 该 Agent 后续 LLM 调用被 TokenBudgetMiddleware 拒绝
    │
    ▼
[2] Audit Bureau 执行稽查
    ├── 稽查结论：误报 → unfreezeWallet(agentId)
    └── 稽查结论：确认异常 → confiscateWallet(agentId, amount)
        ├── 罚没指定金额
        ├── 写入 CONFISCATION 交易记录
        └── 发布 TOKEN_CONFISCATED
```

### 5.2 消耗预算控制（v2 修订：双预算）

> **修订依据**：`Docs/99-审查记录` §4.7 —— 旧版只有硬预算，无软预算。对齐 Loop Engineering dual-budget 实践。
> **本节不维护默认值**：下表数值全部来自 `Configs/economyRules.json → economy.budgetLimits.*` / `economy.rollingWindow.*`（Docs/11 §2.4）与 `Configs/loopConfig.json → stopRules.budget.*`（Docs/11 §2.8）。

| 控制维度 | 机制 | 配置键 |
|---------|------|--------|
| 单次调用上限 | 单次 LLM 调用消耗不得超过此值 | `economy.budgetLimits.singleCallMaxTokens` |
| 单任务预算 | 每轮 Loop 的硬预算基准 | `loopDefaults.token_budget` / `roleOverrides[role].token_budget` |
| 滚动窗口预算 | 窗口内最大消耗 | `economy.rollingWindow.tokens` + `.windowSec` |
| 全局预算 | 单个 trace 下的总 Token 消耗上限 | `economy.budgetLimits.globalTraceHardTokens` |

#### 5.2.1 双预算机制（v2 修订）

任何预算层（任务/全局/滚动窗口）**必须同时**定义 soft 与 hard 两个阈值。四档比例**全部相对该层硬预算**，
唯一数值源为 `Configs/loopConfig.json → stopRules.budget.*Ratio`（Docs/11 §2.8），**本文不得另写百分比**：

| 阶段 | 触发条件（usage / hard） | 行为 | 发布事件 |
|------|---------|------|---------|
| **正常** | < `warmRatio`（默认 0.36） | 无动作 | — |
| **预热** | `warmRatio` ≤ usage < `softRatio` | 仅写预警日志，**不阻断** | `BUDGET_WARMING` |
| **软预算命中** | ≥ `softRatio`（默认 0.6） | 自动降级：Reasoning Sandwich 切至 `reasoningSandwich.fallbackOnBudgetSoft`；并行度 ÷2；写审计日志；**继续执行** | `BUDGET_SOFT_REACHED` |
| **扩展审批** | ≥ `expandRequestRatio`（默认 0.8） | 发 `PendingApproval(kind='budget_expand')`（Docs/12 §6 审批门），超时 `supervision.approvalTimeoutSec` → **默认拒绝** | `APPROVAL_REQUESTED` / `APPROVAL_TIMEOUT_REJECTED` |
| **硬预算命中** | ≥ `hardRatio`（默认 1.0） | **立即中止当前 iteration**，回滚至 `lastCheckpointId`，写 `FailureFeedback(category='budget_hard')` | `BUDGET_HARD_REACHED` |

> **v2.1 修正四处**：① 原表以"soft × 0.6"嵌套乘积定义预热，与 `warmRatio` 直读模型不等价且难验证，现改为单一基准；
> ② 原表"soft 后仍上涨至 hard × 0.8"与"软预算 = hard × 0.6"两套描述共存，现统一为四档平铺比例；
> ③ 原引用事件 `BUDGET_EXPAND_APPROVAL` / `BUDGET_EXPAND_REQUESTED` **均未在 Docs/07 §4.3 注册**，改用 `APPROVAL_REQUESTED` + `PendingApproval.kind`；
> ④ 原默认值块（`budget.taskSoft` / `taskHard` / `expandApprovalTimeoutSec: 20` 等 9 键）**已整块删除**：已在 Docs/11 §2.4 裁决废弃 `economyRules.budget.*`，且 `expandApprovalTimeoutSec: 20` 与 `supervision.approvalTimeoutSec: 60` 直接矛盾。

#### 5.2.2 每轮信息增益度量（v2 新增）

成本优化不应只看“花了多少”，必须看“花了但有没有推进”。`LoopState` 中新增：

```typescript
interface EfficiencyMetrics {
  iteration: number;
  tokensSpent: number;
  goalDelta: number;              // 向目标前进量（由 Verifier 提供）
  newInformationBytes: number;    // 本轮产生的新信息量（去重后）
  repeatRatio: number;            // 与上轮内容重复率 0~1
}
```

**无效循环判定**：`repeatRatio > 0.85` 且 `goalDelta < 0.02` → 命中 Docs/12 无进展退出。

---

## 6. Token 成本计算

### 6.1 模型定价表

> **定价不存在独立配置文件**（v2.1 裁决）：原引用的 `Configs/modelPricing.json` **未在 Docs/11 §1.1 配置文件清单登记**，且与 `modelRouter.json` 的单价字段构成双事实源。现删除该文件，**唯一定价源 = `Configs/modelRouter.json → providers[].models[].cost_per_1k_input` / `cost_per_1k_output`**（Docs/11 §2.2，豁免 X1：内层 snake_case）。

```typescript
// Infra/Llm 边界层从 modelRouter.json 读入后转成的 camelCase 领域对象
interface ModelPricing {
  provider: string;                    // = providers[].provider
  modelId: string;                     // = models[].id（与 provider 拼为全局唯一 `provider/model`）
  costPer1kInput: number;              // ← models[].cost_per_1k_input
  costPer1kOutput: number;             // ← models[].cost_per_1k_output
  contextWindow: number;               // ← models[].context_window
}
```

> 字段名修正：原 `promptCostPer1K` / `completionCostPer1K` 已在 Docs/11 §2.2 迁移表中列为 **废弃**（`K` 大写不合规、且与上游字段不同名），改用 `costPer1kInput` / `costPer1kOutput`。

### 6.2 成本计算公式

```
消耗 Token 成本(USD) = promptTokens × costPer1kInput / 1000 + completionTokens × costPer1kOutput / 1000
税额 = 消耗 Token × currentTaxRate          // currentTaxRate ∈ [economy.tax.minRate, economy.tax.maxRate]
实际扣减 = 消耗 Token + 税额
```

> **单位口径**：系统内部统一以 **Token** 计量钱包余额与扣减（`token_wallets.balance` / `token_transactions.amount` 均为 INTEGER Token）；
> USD 仅用于观测与 `loops.budget_used_usd`（REAL）。两者不得混用同一字段（见 Docs/10 §1.1 “金额列”行）。

### 6.3 定价示例

> 下表**仅为 `modelRouter.json` 当前默认内容的展开展示**，**不作事实源**；修改价格只改 `modelRouter.json`，本表由文档校验脚本自动比对（不一致 = 门禁失败）。

| Provider | Model | 输入成本/1K | 输出成本/1K |
|----------|-------|------------|------------|
| openai | gpt-4o | 2.5 | 10.0 |
| openai | gpt-4o-mini | 0.15 | 0.6 |
| anthropic | claude-sonnet-4-20250514 | 3.0 | 15.0 |
| aliyun | qwen-max | 2.0 | 6.0 |

---

## 7. 账本守恒验证

### 7.1 守恒规则

**系统 Token 总量 = Σ(所有活跃钱包余额) + 系统池余额 + 已销毁量**

每次交易后验证：
```
Σ(wallet.balance) + systemPool + destroyed = initialSupply + Σ(外部注入) - Σ(销毁)
```

### 7.2 验证时机

| 触发点 | 验证类型 |
|--------|---------|
| 每次交易完成后 | 单钱包余额校验 |
| 每个 trace 结束时 | 该 trace 下所有交易汇总校验 |
| 每日定时 | 全局守恒校验 |
| Audit Bureau 稽查时 | 涉事 Agent 全量交易审计 |

### 7.3 不一致处理

```
检测到守恒异常
    │
    ▼
[1] 记录异常详情（期望值、实际值、差异）
[2] 广播 LEDGER_MISMATCH 事件（最高优先级）
[3] 通知 Audit Bureau 介入调查
[4] 暂停相关 Agent 的交易能力
[5] 等待人工/监管介入
```

---

## 8. 配置项汇总

> **本文件不维护默认值**（SSOT 裁决，见 Docs/11 文档头）。唯一事实源为 **Docs/11 §2.4**（`economyRules.json`）与 **§2.8**（`loopConfig.json`）。
> 下表只列本子系统消费的键与其当前定义位置；原表自带的"默认值"列与已过时的路径（`economy.budget.*`）已删除。

| 配置键 | 定义位置 | 用途 |
|--------|---------|------|
| `economy.initialSupply` / `defaultWalletBalance` | Docs/11 §2.4 | 初始发行量与新建 Agent 钱包默认余额 |
| `economy.tax.*`（baseRate / dynamicEnabled / adjustmentIntervalSec / maxRate / minRate / highLoadMultiplier / lowLoadDiscount / loadThresholdAgents） | Docs/11 §2.4 | 税率与动态调节（原名 `adjustmentInterval` → `adjustmentIntervalSec`，`loadThreshold` → `loadThresholdAgents`） |
| `economy.profitSharing.{quality,quantity,efficiency}Weight` | Docs/11 §2.4 | **分润**权重（三者和=1）；与 §7 的**质量分**权重（0.4/0.3/0.3）是两个不同概念，不得混用同一组数值 |
| `economy.rollingWindow.{tokens,windowSec,checkIntervalSec,deviationMultiplierWarn,deviationMultiplierCritical,budgetWarnRatio}` | Docs/11 §2.4 | 滚动窗口与偏离检测（原 `rollingWindowTokens`/`rollingWindowSeconds` 扁平键已归入对象） |
| `economy.budgetLimits.{singleCallMaxTokens,globalTraceHardTokens,globalTraceSoftRatio}` | Docs/11 §2.4 | 单次调用 / 整 trace 上限（原名 `singleCallMax`/`globalTraceMax` 补单位后缀并迁入 `budgetLimits`） |
| `loopDefaults.token_budget` / `roleOverrides[role].token_budget` | Docs/11 §2.8 | 单任务硬预算基准 |
| `stopRules.budget.{warmRatio,softRatio,expandRequestRatio,hardRatio}` | Docs/11 §2.8 | 四档预算比例（见 §5.2.1） |
| `supervision.approvalTimeoutSec` / `approvalDefaultOnTimeout` | Docs/11 §2.7 | 扩容审批超时与默认动作（取代原 `budget.expandApprovalTimeoutSec: 20`） |

---

## 9. 事件清单

> 事件名唯一定义处为 `Docs/07 §4.3`；本表仅列本子系统相关项。`source` 统一为 `TokenEconomy`（发布方口径见 §5.1）。

| 事件 | 触发时机 | 订阅者 |
|------|---------|--------|
| `TOKEN_CONSUMED` | LLM 调用消耗后 | Audit, Dashboard |
| `TOKEN_EARNED` | 任务奖励入账后 | Dashboard |
| `TOKEN_DISTRIBUTED` | 分润完成后 | Dashboard |
| `TAX_PAID` | 纳税完成后 | Audit, Dashboard |
| `TAX_RATE_UPDATED` | 动态税率调整后 | TokenEconomy(内部), Dashboard |
| `WALLET_FROZEN` | 钱包被冻结 | Core(中间件), Dashboard |
| `WALLET_UNFROZEN` | 钱包解冻 | Core(中间件), Dashboard |
| `TOKEN_CONFISCATED` | Token 被罚没 | Audit, Dashboard |
| `LEDGER_MISMATCH` | 账本守恒异常 | Audit, Regulation |
| `INSUFFICIENT_BALANCE` | 余额不足 | Orchestrator |

---

## 10. 依赖关系

| 依赖组件 | 来源 | 用途 |
|---------|------|------|
| `Database` | Infra | 钱包和交易记录持久化 |
| `EventBus` | Services | 事件发布/订阅 |
| `LlmCaller` | Tools | 获取 Token 消耗量 |
| `Logger` | Infra | 交易审计日志 |
