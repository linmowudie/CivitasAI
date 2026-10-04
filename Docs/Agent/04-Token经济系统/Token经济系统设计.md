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

> **⚠️ 2026-10-03 校准（职责生效状态一览）**：上表六项职责中，运行期**真正接线的只有"钱包管理"的一半**——`Core/AgentRuntime/agentFactory.ts` 在创建 Agent 时调用 `createWallet`，`Interface/RestApi/tokenApi.ts` 只读暴露钱包/流水/税率。
> **消耗计量、税收征收（动态税率与税收分配）、收益分配、账本审计**四项**已实现但零调用方**（详见 §3 前言与 §4.2/§4.3、§7.1/§7.2）；
> "异常稽查配合"依赖的 `Audit/anomalyDetector` 与 `Audit/patrolScheduler` 由 `initResourceAuditBureau` 初始化，而该函数同样**无调用方**。
> 另外，"账本审计：保证 Token 总量守恒"一句在当前代码下**不成立**——`confiscate()` 既不回流系统池也不计入销毁，罚没后必然 `delta = −amount`（见 §5.1、§7.1）。

---

## 2. 核心数据模型

### 2.1 Token 钱包

```typescript
interface TokenWallet {
  walletId: string;                  // 非 UUID：`w-<agentId>-<epochMs>`，由 `walletManager.createWallet` 拼接（2026-10-03 校准）
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
  transactionId: string;             // 非 UUID：`tx-<epochMs>-<transactions.length>`，由 `walletManager.recordTransaction` 拼接（2026-10-03 校准）
                                     // ⚠️ 同毫秒并发写入存在 ID 碰撞风险（未使用 randomUUID）
  walletId: string;                  // 关联钱包
  traceId: string;                   // 关联运行会话
  operationId?: string;              // 关联操作
  
  type: TransactionType;
  amount: number;                    // 正数=收入，负数=支出
  balanceAfter: number;              // 交易后余额
  
  // 交易详情
  description: string;               // 人类可读描述
  metadata: Record<string, unknown>; // 扩展信息（2026-10-03 校准：原写 `Record<string, any>`，代码为 `unknown`）
  
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

> **2026-10-03 校准（写入点现状）**：枚举 11 成员与 `Src/Services/TokenEconomy/types.ts`（`TransactionType`）**逐字一致**，但代码里只有 `INITIAL_ALLOCATION`（`createWallet`）、`LLM_CONSUMPTION`（`debit`）、`TASK_REWARD` / `PROFIT_SHARING`（`credit`，默认类型 `TASK_REWARD`）、`FREEZE` / `UNFREEZE` / `CONFISCATION`（`freezeWallet` / `unfreezeWallet` / `confiscate`）有写入点；
> **`TAX_PAYMENT`、`ARBITRATION_PENALTY`、`ARBITRATION_COMPENSATION`、`REFUND` 四类全仓无写入方**（纳税只累加 `wallet.totalTaxPaid`，见 §3.1 [3d]）。

### 2.3 消耗记录

```typescript
interface ConsumptionRecord {
  recordId: string;                  // 非 UUID：`cr-<epochMs>-<records.length>`，由 `consumptionRecorder.recordConsumption` 拼接（2026-10-03 校准）
  traceId: string;
  agentId: string;
  operationId: string;
  
  // 模型信息
  provider: string;                  // 如 "huawei-maas"（2026-10-03 校准：原示例 openai 已不在 modelRouter.json 中）
  model: string;                     // 如 "DeepSeek-V4-Flash"
  
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

> **2026-10-03 校准（`startedAt` / `completedAt`——现状记录，待人工裁定）**：本节字段语义按原文写作"LLM 调用起止时间"，但代码侧 `RecordConsumptionInput`（`consumptionRecorder.ts`）**没有这两个入参**，`recordConsumption` 内 `startedAt` 取记账时刻 `now`、`completedAt` 取 `Date.now()`，因此 `completedAt − startedAt` 恒 ≈ 0，**不反映真实调用耗时**；`unitCostPer1K` 亦固定写入 `costPer1kInput`（不含输出单价）。
> **待办（不在此文档裁决）**：① 给 `RecordConsumptionInput` 补 `startedAt` / `completedAt` 由调用方透传，并把 `unitCostPer1K` 定义为加权单价；② 或将本节两字段改注为"记录起止时刻"。两个方向需人工裁定后再回写。

---

## 3. 核心流程

### 3.1 Token 消耗流程

> **⚠️ 2026-10-03 校准（接线现状，适用于 §3.1 / §3.2 / §3.3）**：本节及后两节以"现网行为"口吻描述，实际 **`Src/` 生产链路里 TokenEconomy 只有 `createWallet` + 三个 `init*` 被调用**——写入点为 `Core/AgentRuntime/agentFactory.ts`（`createWallet`）与 `Src/main.ts`（`initWalletManager` / `initTaxCollector` / `initDualBudget`），只读出口为 `Interface/RestApi/tokenApi.ts`（钱包/流水/税率查询）。
> `recordConsumption` / `checkBalance` / `debit` / `credit` / `calculateDistribution` / `executeDistribution` / `adjustTaxRate` / `distributeTax` / `verifyConservation` 在 `Src/` 内**零调用方**（唯二调用者来自 `Tests/TokenEconomy/tokenEconomy.spec.ts` 与 E2E 用例）。运行期真实 LLM 调用在 `Core/Loop/runIteration.ts` 与 `Core/Model/modelCaller.ts`，二者**均不 import TokenEconomy**，即消耗计量、纳税、分润、账本守恒当前都是无人触达的孤岛。
> 下列流程图描述的因此是**已实现但未被调用**的模块行为（逻辑本身与代码一致）。

```
Agent 发起 LLM 调用
    │
    ▼
[1] WalletManager.checkBalance(agentId, estimatedCost)        // Src/Services/TokenEconomy/walletManager.ts（函数 checkBalance）
    ├── 余额充足 → 继续
    ├── 余额不足 → 返回 ok(false)（由调用方决定是否继续；实际拦截发生在 debit）        // ⚠️ 2026-10-03 校准：全仓不存在 InsufficientBalanceError，
    └── 钱包不存在 / status='frozen' / status='closed' → 返回 Result 的 err(...)           //    本子系统统一走 Result 协议，不抛异常
    │                                          //    余额不足时由 WalletManager.debit 返回 err('余额不足 (balance=…, need=…)')
    │                                          //    INSUFFICIENT_BALANCE 事件亦无发布点（见 §9）
    │
    ▼
[2] LlmCaller.call(model, messages)                           // ⚠️ 2026-10-03 校准：`LlmCaller` 这一符号在 Src 中不存在，
                                                              //    实际运行期调用方是 Core/Loop/runIteration.ts → Core/Model/modelCaller.ts
    │  → 获得响应 + 实际 Token 用量
    │
    ▼
[3] ConsumptionRecorder.recordConsumption(input)              // Src/Services/TokenEconomy/consumptionRecorder.ts（函数 recordConsumption）
    ├── [3a] 计算消耗：promptTokens × costPer1kInput/1000 + completionTokens × costPer1kOutput/1000（代码额外 Math.ceil 取整）
    ├── [3b] 计算税额：consumption × currentTaxRate（同样 Math.ceil）
    ├── [3c] 扣减钱包：WalletManager.debit(agentId, consumption + tax, ...)
    ├── [3d] 写入交易记录：**只写 1 条 LLM_CONSUMPTION，金额 = 消耗 + 税（含税扣减）**   // 2026-10-03 校准：原写"LLM_CONSUMPTION + TAX_PAYMENT 两条"与代码不符
    │        ├── 税的另一半只走 walletManager.recordTaxPayment → 累加 wallet.totalTaxPaid，**不产生 TAX_PAYMENT 交易**
    │        └── 连带后果：tokenLedger.summarizeTrace 按 type==='TAX_PAYMENT' 汇总，其 totalTax **恒为 0**
    │        ⚠️ 待办：二选一——代码补写 TAX_PAYMENT 交易，或本表口径永久定为"单条含税扣减"
    └── [3e] 广播 TOKEN_CONSUMED 事件   // ⚠️ 未实现（2026-09-22 校准，2026-10-03 复核仍未实现）：TokenEconomy 全模块无 publish 调用
    │                                 // TokenLedger 仅提供 appendTransaction / verifyLedgerConservation 等账本读写，不含 recordConsumption
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
    │   ⚠️ 未实现/目标态（2026-10-03 校准）：`Src/` 内**不存在 `QualityInspector` 组件**。
    │   承担"质量判定"职责的是 `Src/Services/LoopControl/verifier/*` 与 `Src/Services/ReviewerAgent/reviewerAgent.ts`，
    │   二者输出的是通过/不通过 + 校验明细，**并不产出 0.0–1.0 的"采纳率"质量分**，也没有链路把分数送到本子系统。
    ▼
[2] TokenEconomy.calculateReward(taskAssignment, qualityScore)
    ├── ⚠️ 未实现（2026-09-22 校准，2026-10-03 复核仍未实现）：Src 中不存在 calculateReward，以下为设计目标态
    ├── 基础奖励 = taskTokenBudget × (qualityScore / 100)
    ├── 效率加成 = 基础奖励 × efficiencyBonus(实际耗时/预算耗时)
    └── 最终奖励 = 基础奖励 + 效率加成
    │
    ▼
[3] WalletManager.credit(agentId, amount, traceId, 'TASK_REWARD', metadata)   // Src/Services/TokenEconomy/walletManager.ts（函数 credit）
    ├── 增加钱包余额（并同步扣减系统池 systemPool）
    ├── 写入交易记录（内存账本，见 §7.2 的"双账本"说明）
    ├── ⚠️ 未接入运行时（2026-10-03 校准）：`credit` 在 `Src/` 生产链路零调用方（分润路径 `executeDistribution` 同样无调用方）
    └── 广播 TOKEN_EARNED 事件   // ⚠️ 未实现（2026-09-22 校准，2026-10-03 复核仍未实现）：TokenEconomy 无事件发布
```

### 3.3 Consortium 分润流程

```
Consortium 任务完成
    │
    ▼
[1] calculateDistribution(contributions, tokenPool, weights)   // Src/Services/TokenEconomy/profitDistributor.ts（函数 calculateDistribution）
    │   （原写法 `ProfitDistributor.calculate(contract, contributions)` 无此签名，2026-09-22 校准；2026-10-03 复核：行号引用已改为函数名定位）
    │
    ├── 对每个 Partner（PartnerContribution = { agentId, qualityScore, outputTokens, elapsedMs }）计算三维贡献分：
    │   ├── 质量分 = qualityScore 直接取值   // ⚠️ 未实现/目标态（2026-10-03 校准）：文档原注"QualityInspector 评估的采纳率"，
    │   │        // 但 Src 无 QualityInspector；实际候选是 LoopControl/verifier/* 与 ReviewerAgent/reviewerAgent.ts，均不产出 0.0–1.0 采纳率
    │   │        // 结论：qualityScore 目前**没有生产侧数据源**，只能由调用方手工传入（现仅 Tests 传）
    │   ├── 数量分 = 有效输出 Token 数 / 总输出 Token 数
    │   └── 效率分 = (1 / 实际耗时) / Σ(1 / 各Partner耗时)
    │
    ├── 综合分 = Wq×质量分 + Wn×数量分 + We×效率分
    │   默认权重：Wq=0.5, Wn=0.3, We=0.2（校验三者和 = 1，偏差 > 0.01 直接返回 err）
    │   ⚠️ 2026-10-03 校准：权重取函数形参默认值 `DEFAULT_WEIGHTS`（硬编码），**不读 `economy.profitSharing.*` 配置**（见 §8 生效状态列）
    │
    ├── 各 Partner 分润 = floor( tokenPool × (综合分 / Σ所有综合分) )
    │
    └── 舍入余数回收（2026-10-03 校准补记，原文档未记）：
        余数 = tokenPool − Σfloor(各份额)，余数**全额加给综合分最高的那个 Partner**（并列时取遍历中的前者）
    │
    ▼
[2] executeDistribution(results, traceId, contractId) → 对每个 Partner 执行钱包入账   // profitDistributor.ts（函数 executeDistribution）
    ├── WalletManager.credit(partnerId, share, traceId, 'PROFIT_SHARING', { contractId, compositeScore })
    ├── 写入交易记录（关联 contractId）
    ├── ⚠️ 未接入运行时（2026-10-03 校准）：`calculateDistribution` / `executeDistribution` 在 `Src/` 生产链路零调用方，Consortium 完成侧无分润调用
    └── 广播 TOKEN_DISTRIBUTED 事件   // ⚠️ 未实现（2026-09-22 校准，2026-10-03 复核仍未实现）：TokenEconomy 无事件发布
```

---

## 4. 税收机制

### 4.1 税率模型

```typescript
// 与 Src/Services/TokenEconomy/types.ts（`interface TaxConfig`）及 Configs/economyRules.json → economy.tax.* 逐字对齐
// （2026-10-03 校准：8 个键的名称与顺序仍完全一致；原行号引用改为符号名定位以免漂移）
interface TaxConfig {
  // 基础税率
  baseRate: number;                  // 默认 0.05（5%）
  
  // 动态调整
  dynamicEnabled: boolean;           // 是否启用动态税率
  adjustmentIntervalSec: number;     // 调整间隔（秒），默认 300；原名 adjustmentInterval 已废弃
  maxRate: number;                   // 最高税率，默认 0.20
  minRate: number;                   // 最低税率，默认 0.02
  
  // 调整规则
  highLoadMultiplier: number;        // 系统高负载时税率乘数，默认 1.5
  lowLoadDiscount: number;           // 系统低负载时税率折扣，默认 0.8
  loadThresholdAgents: number;       // 负载阈值（活跃 Agent 数），默认 10；原名 loadThreshold 已废弃
}
```

### 4.2 动态税率调整算法

```
每 adjustmentIntervalSec 秒执行一次（taxCollector.adjustTaxRate，未到间隔直接返回原税率）：

currentLoad = activeAgentCount
if dynamicEnabled == false:
    currentRate = baseRate
elif currentLoad > loadThresholdAgents:
    currentRate = min(baseRate × highLoadMultiplier, maxRate)
else:
    currentRate = max(baseRate × lowLoadDiscount, minRate)

广播 TAX_RATE_UPDATED 事件   // ⚠️ 未实现（2026-09-22 校准，2026-10-03 复核仍未实现）：TokenEconomy 无事件发布
```

> **⚠️ 2026-10-03 校准（无调度方）**：上述分支逻辑与 `Src/Services/TokenEconomy/taxCollector.ts`（函数 `adjustTaxRate`）**逐分支等价**，但 `adjustTaxRate` 在 `Src/` 内**没有任何调用方、也没有任何定时器**（`setInterval` 只出现在 `Audit/patrolScheduler.ts` 与 Infra 若干处，均未挂税率调整；且 `initResourceAuditBureau` 亦无人调用）。`Src/main.ts` 只做了 `initTaxCollector(...)`。
> **运行期后果**：`currentRate` **恒等于 `baseRate`（0.05）**，高负载 ×1.5 / 低负载 ×0.8 两条分支都不会触发。
> **待办**：在 `Src/main.ts`（或巡检调度器）挂 `adjustTaxRate(activeAgentCount)` 定时器，并把 `activeAgentCount` 的来源（Agent 注册表）确定下来。

### 4.3 税收用途

| 用途 | 比例 | 说明 |
|------|------|------|
| 系统运转基金 | 60% | 用于支付 LLM 调用的基础成本 |
| 风险准备金 | 30% | 用于异常情况的 Token 补偿 |
| 销毁 | 10% | 通缩机制，防止 Token 通胀 |

> **⚠️ 2026-10-03 校准（接线现状）**：`taxCollector.distributeTax(taxAmount)` 与 `taxCollector.getTotalDestroyed()` 均**无生产调用方**（`getTotalDestroyed` 仅被只读 REST `tokenApi.ts` 展示），因此运行期**销毁量恒为 0**、税收的 60/30/10 三分从不发生；同时 §3.1 [3d] 的扣减也不产生 `TAX_PAYMENT` 交易，"已收税"目前只体现在 `wallet.totalTaxPaid` 字段上。
>
> **现状记录（取整余数归属，待人工裁定）**：代码实现为 `systemFund = floor(t × 0.6)`、`riskReserve = floor(t × 0.3)`、`destroyed = t − systemFund − riskReserve`，即**两次 floor 的取整余数全部落入"销毁"**，销毁实际占比可显著高于 10%（例：t=7 → 基金 4 / 准备 2 / 销毁 1，销毁占 14.3%）。
> **待办（不在本文裁决）**：需裁定"余数归销毁"属设计还是缺陷——若为缺陷，改代码为四舍五入或余数归系统基金；若为设计，本表需加注"销毁 ≥10%，含取整余数"。

---

## 5. 异常消耗处理

### 5.1 与 Audit Bureau 的协作

> **发布方口径**（与 `Docs/Agent/06 §3`、`Docs/Agent/07 §4.3` 一致）：`WALLET_FROZEN` / `WALLET_UNFROZEN` / `TOKEN_CONFISCATED` 的 `source` **统一为本子系统（TokenEconomy）**，审计仅作为 `payload.initiator`；审计自身只发布 `ANOMALY_DETECTED` / `AUDIT_COMPLETED` / `PATROL_REPORT`。

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

> **2026-09-22 校准（现状 + 待办，不改代码）**：上图为目标态，当前实现只落了"记账"一半：
> - `freezeWallet` / `unfreezeWallet` / `confiscate`（`Src/Services/TokenEconomy/walletManager.ts` 同名函数，2026-10-03 校准：原行号引用改为函数名定位）确实存在，但只写 `token_transactions` 语义的内存数组（`FREEZE` / `UNFREEZE` / `CONFISCATION`），**不发布任何事件**，且在 Src 生产链路中**无调用方**（仅 Tests）；
> - 实际的冻结标记由 `Audit/freezeManager.freezeAgent` 维护内存 `frozenAgents` 并以 `source='Audit/freezeManager'` 发布 `WALLET_FROZEN` / `WALLET_UNFROZEN`（`freezeManager.ts` 的 `freezeAgent` / `unfreezeAgent` / `checkAutoUnfreeze`），与本节"发布方口径"不一致；**`TOKEN_CONFISCATED` 至今无人发布**；
> - "后续 LLM 调用被拒"一句：Src 中**不存在 `TokenBudgetMiddleware`**，承担该职责的是 `Core/Middleware/builtin/budgetSentinel.ts`（`budgetSentinelMiddleware`，注册点在 `Src/main.ts` 的 `registerMiddleware(budgetSentinelMiddleware)`，2026-10-03 校准：原写 `main.ts:188` 已漂移），它只按 `ctx.data['tokenBudget'] / ctx.data['tokensConsumed']` 的比值截断，**不读钱包 `status='frozen'`**；
> - **⚠️ 2026-10-03 校准（预算哨兵当前完全不生效）**：`ctx.data['tokenBudget']` 与 `ctx.data['tokensConsumed']` 这两个键在 `Src/` 内**没有任何写入方**（只有 `budgetSentinel.ts` 自己读），因此该中间件恒走 `next(input)` 放行分支——既不会"按比值截断"，也不会拒绝已冻结 Agent，属于事实上的 no-op（与 §5.2.1 的双预算未接线问题同源）。
> - **⚠️ 2026-10-03 校准（罚没破坏守恒）**：`confiscate()` 只做 `wallet.balance -= amount` 与 `wallet.totalSpent += amount`，**既不回流 `systemPool`、也不增加 `destroyedTotal`**；一旦调用过 `confiscate`，`verifyConservation()` 必然得到 `delta = −amount` 而返回 err（见 §7.1）。现有测试只验余额扣减，未覆盖守恒。
>
> 待办：① 审计侧改为调用 TokenEconomy 的钱包接口，事件发布权收回本子系统（对齐 Docs/Agent/06 §3）；② 冻结状态接入预算中间件，否则"冻结"对运行中的 Agent 无实际约束力；③ **补 `confiscate` 的池语义**（计入销毁或回流系统池），否则 §1"账本审计：保证 Token 总量守恒"不成立；④ 中间件上游（`runIteration` / `modelCaller`）注入 `ctx.data` 的预算与已用量，否则预算哨兵永远放行。

### 5.2 消耗预算控制（v2 修订：双预算）

> **修订依据**：`Docs/99-审查记录` §4.7 —— 旧版只有硬预算，无软预算。对齐 Loop Engineering dual-budget 实践。
> **本节不维护默认值**：下表数值全部来自 `Configs/economyRules.json → economy.budgetLimits.*` / `economy.rollingWindow.*`（Docs/Agent/10 §2.4）与 `Configs/loopConfig.json → stopRules.budget.*`（Docs/Agent/10 §2.8）。

| 控制维度 | 机制 | 配置键 | 生效状态（2026-10-03 校准） |
|---------|------|--------|--------------------------|
| 单次调用上限 | 单次 LLM 调用消耗不得超过此值 | `economy.budgetLimits.singleCallMaxTokens` | ⚠️ **键无人读**：`dualBudget.checkSingleCallLimit` 内硬编码 `const singleCallMax = 5000`，与配置值巧合相同但**不是同一事实源**（改 JSON 无效）；且 `checkSingleCallLimit` 本身也无生产调用方 |
| 单任务预算 | 每轮 Loop 的硬预算基准 | `loopDefaults.token_budget` / `roleOverrides[role].token_budget` | ✅ **生效**：`main.ts` 读入后传给 `buildStopRuleSet` 与 `setRoleOverrides`，运行期由 `runIteration` 判定 |
| 滚动窗口预算 | 窗口内最大消耗 | `economy.rollingWindow.tokens` + `.windowSec` | ⚠️ **键无人读**：`Src/` 零读取；等价功能由 `Audit/anomalyDetector.ts` 自带的 `rollingWindowMs = 5*60*1000` 常量实现，而 `initAnomalyDetector`（经 `initResourceAuditBureau`）在生产链路**无人调用** |
| 全局预算 | 单个 trace 下的总 Token 消耗上限 | `economy.budgetLimits.globalTraceHardTokens` | ⚠️ **键无人读**（2026-10-03 校准）：运行期 trace 级预算实际取 `loopDefaults.token_budget`（当前 100000），`globalTraceHardTokens`（当前 200000）在 `Src/` 内**无任何读取方**，只存在于 JSON 与 `types.ts` 的 `BudgetLimits` 孤立接口 → 文档所指的两级预算数值源在代码中不存在，且与 loopConfig 存在潜在数值冲突。**待办**：在 Docs/Agent/10 §2.4 裁决 `globalTraceHardTokens` 的去留（删除或接入 `dualBudget`） |

#### 5.2.1 双预算机制（v2 修订）

任何预算层（任务/全局/滚动窗口）**必须同时**定义 soft 与 hard 两个阈值。四档比例**全部相对该层硬预算**，
唯一数值源为 `Configs/loopConfig.json → stopRules.budget.*Ratio`（Docs/Agent/10 §2.8），**本文不得另写百分比**：

| 阶段 | 触发条件（usage / hard） | 行为 | 发布事件 | 实现状态（2026-10-03 校准） |
|------|---------|------|---------|--------------------------|
| **正常** | < `warmRatio`（默认 0.36） | 无动作 | — | ✅ 与代码一致 |
| **预热** | `warmRatio` ≤ usage < `softRatio` | 仅写预警日志，**不阻断** | `BUDGET_WARMING` | ⚠️ **未实现/目标态**：`detectBudgetPhase` 能算出 `warm`，但运行期无人据其动作；`BUDGET_WARMING` 全仓**无发布点**（只在 `eventTypes.ts` 注册、在 `dualBudget.ts` 作返回值类型） |
| **软预算命中** | ≥ `softRatio`（默认 0.6） | 自动降级：Reasoning Sandwich 切至 `reasoningSandwich.fallbackOnBudgetSoft`；并行度 ÷2；写审计日志；**继续执行** | `BUDGET_SOFT_REACHED` | ⚠️ **未实现/目标态**：`fallbackOnBudgetSoft` 只存在于 `Configs/modelRouter.json → reasoningSandwich`，`Src/` 内 `reasoningSandwich` **零引用**（无边界层读取）；无任何并行度降级代码；`BUDGET_SOFT_REACHED` 无发布方。详见下方"降级三项均未落地" |
| **扩展审批** | ≥ `expandRequestRatio`（默认 0.8） | 发 `PendingApproval(kind='budget_expand')`（Docs/Agent/11 §6 审批门），超时 `supervision.approvalTimeoutSec` → **默认拒绝** | `APPROVAL_REQUESTED` / `APPROVAL_TIMEOUT_REJECTED` | ⚠️ **未实现/目标态**：`ApprovalKind` 确实含 `'budget_expand'`（`LoopControl/types.ts`），`dualBudget.recordUsageAndDetect` 也会返回该事件对象，但 `createApproval`（`LoopControl/approvalGate.ts`）**唯一生产调用方是 `middleware/toolSafetyGate.ts`，kind 为 `irreversible_action`** → 扩容审批从不生成，超时口径亦无从生效。详见下方"超时事实源待裁定" |
| **硬预算命中** | ≥ `hardRatio`（默认 1.0） | **立即中止当前 iteration**，回滚至 `lastCheckpointId`，写 `FailureFeedback(category='budget_hard')` | `BUDGET_HARD_REACHED` | ⚠️ **部分实现**（2026-10-03 校准）：只做到"中止"——`stopRules.checkHardBudget` 判 hard 后由 `runIteration.mapStoppedReasonToExitReason` 映射为 `exitReason='budget_exhausted'`；**回滚**（`loopState.lastCheckpointId` 由 `checkpointWriter.ts` 写入，但预算路径无人读）与 **`FailureFeedback(category='budget_hard')`**（`failureFeedback.ts` 的 `rollback_and_abort` 只挂在 `category==='risk'`）两项**均未实现**；`BUDGET_HARD_REACHED` 亦无发布点 |

> **⚠️ 2026-10-03 校准（接线现状：检测器双份，且本子系统那份没人用）**：四档双预算在代码里有**三处实现、一处接线**——
> 1. `Src/Services/TokenEconomy/dualBudget.ts`（`detectPhase` / `recordUsageAndDetect` / `checkTraceBudget` / `checkSingleCallLimit`）：由 `main.ts` 的 `initDualBudget(...)` 初始化，但**初始化后无任何调用方**，`traceUsage` Map 恒为空（usage 恒 0），`BudgetEvent` 只作返回值不外发 → 本节机制在本子系统内是**空转的**；
> 2. `Src/Services/LoopControl/stopRules.ts`（`detectBudgetPhase` / `checkHardBudget`）+ `Src/main.ts` 的 `buildStopRuleSet(...)` → `Core/Loop/runIteration.ts` 的 `evaluateStopRules(...)`：**这才是运行期真正的执行者**，且只有 **hard 档会动作**（`budget_soft` / `budget_warm` / `expand_request` 判定结果无人消费）；
> 3. `Src/Services/LoopControl/middleware/budgetSentinelControl.ts`（`createBudgetSentinelControlMiddleware`，带 warm/soft/expand 回调与 `ctx.data['budgetSoftReached']` 等写入）：**从未被实例化注册**（`main.ts` 只注册了 `budgetSentinelMiddleware`）。
>
> 后果：本节表格描述的"warm → soft → expand → hard"四档递进，运行期实际只有"未超 hard / 超 hard 即止"两态。
> **待办（需人工裁定合并方向）**：把检测器归一为单一份（`dualBudget.ts` 与 `stopRules.detectBudgetPhase` 语义重复），并把 `budgetSentinelControl` 注册进 `main.ts`，否则本子系统文档不应继续以"由本子系统实现"口吻陈述。

> **⚠️ 2026-10-03 校准（"降级三项均未落地"）**：软预算命中行的三个动作逐项现状——
> ① Reasoning Sandwich 切档：`Configs/modelRouter.json → reasoningSandwich.fallbackOnBudgetSoft` 存在，但 `Src/` 内**没有任何代码引用 `reasoningSandwich`**（含 `Infra/Llm` 装载路径），配置为纯静态；
> ② 并行度 ÷2：**无对应实现**（`Src/` 无并行度降级代码）；
> ③ 写审计日志 + 发 `BUDGET_SOFT_REACHED`：**无写入方、无发布点**。
> 待办：软预算降级属未实现的纯设计目标，落地前本节按 ⚠️ 目标态理解，不得据此评估线上行为。

> **⚠️ 2026-10-03 校准（"超时事实源待裁定"，与 §8 同条）**：扩容审批超时口径在本表中写作 `supervision.approvalTimeoutSec`（Docs/Agent/10 §2.7 为定义处，v2.1 注④已裁决统一到 supervision:60），但代码实际取的是**第三个源**：
> `Src/main.ts` → `configureToolSafetyGate({ approvalTimeoutSec: securityConfig['approvalTimeoutSec'] ?? 300 })`，值来自 `Configs/security.json → security.approvalTimeoutSec = 300`；
> 而 `Configs/supervision.json → supervision.approvalTimeoutSec = 60` 与 `approvalDefaultOnTimeout = 'reject'` 在 `Src/` 内**零引用**（仅 `Client/src/config/configSchema.ts` 把它们暴露成可编辑表单项，改了不影响运行期）。
> **现状**：因 `budget_expand` 审批从不生成（见上表），该冲突当前只影响**工具危险操作**的人工确认窗口（300s）。
> **待办（不在本文裁决）**：与 Docs/Agent/10 §2.7 / §2.3 一并裁定归一——建议保留 `supervision.*` 为唯一事实源并改代码读取，或在文档层正式登记 `security.approvalTimeoutSec` 为运行期真源。

> **v2.1 修正四处**：① 原表以"soft × 0.6"嵌套乘积定义预热，与 `warmRatio` 直读模型不等价且难验证，现改为单一基准；
> ② 原表"soft 后仍上涨至 hard × 0.8"与"软预算 = hard × 0.6"两套描述共存，现统一为四档平铺比例；
> ③ 原引用事件 `BUDGET_EXPAND_APPROVAL` / `BUDGET_EXPAND_REQUESTED` **均未在 Docs/Agent/07 §4.3 注册**，改用 `APPROVAL_REQUESTED` + `PendingApproval.kind`；
> ④ 原默认值块（`budget.taskSoft` / `taskHard` / `expandApprovalTimeoutSec: 20` 等 9 键）**已整块删除**：已在 Docs/Agent/10 §2.4 裁决废弃 `economyRules.budget.*`，且 `expandApprovalTimeoutSec: 20` 与 `supervision.approvalTimeoutSec: 60` 直接矛盾。

#### 5.2.2 每轮信息增益度量（v2 新增）

> **⚠️ 未实现/目标态（2026-10-03 校准）**：下文"新增到 `LoopState`"未落地——`EfficiencyMetrics` 目前只是 `Src/Services/TokenEconomy/types.ts` 里的**孤立接口**（仅被 `TokenEconomy/index.ts` 再导出，`Src/` 内无任何引用）；`Src/Services/LoopControl/loopState.ts` 的 `LoopState` **可变区没有该字段**（只有 `budgetUsed` / `lastCheckpointId` / `failedAttempts` 等）。原文保留以便目标态可追溯。

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

**无效循环判定**：`repeatRatio > 0.85` 且 `goalDelta < 0.02` → 命中 Docs/Agent/11 无进展退出。

> **⚠️ 2026-10-03 校准（现行判据与阈值归属）**：上面这组阈值在 `Configs/loopConfig.json → efficiency.{invalidLoopRepeatRatio: 0.85, invalidLoopGoalDelta: 0.02}` **确实存在，但 `Src/` 内零读取**；运行期真正生效的无进展退出用的是另一套判据——`stopRules.noProgress`：
> `metric = goal_distance`、`stagnationWindowRounds = 3`、`minDeltaRatio = 0.05`（`main.ts` 经 `buildStopRuleSet` 注入，由 `runIteration` 的 `evaluateStopRules` 消费；未登记全局规则集时兜底为 **5 轮 / minDelta 0.01**）。
> **差异登记（待人工裁定，不在本文裁决）**：`efficiency.*`（repeatRatio + goalDelta 绝对值）与 `noProgress.*`（窗口内指标相对变化率）是**两套并存、语义不同的无进展判据**，前者仅有配置与孤立接口、无实现。待办：① 裁定保留哪一套并删除另一份配置键；② 若保留目标态，需把 `EfficiencyMetrics` 真正挂进 `LoopState` 可变区并由 Verifier 供数（`newInformationBytes` 现无任何计算方）。

---

## 6. Token 成本计算

### 6.1 模型定价表

> **定价不存在独立配置文件**（v2.1 裁决）：原引用的 `Configs/modelPricing.json` **未在 Docs/Agent/10 §1.1 配置文件清单登记**，且与 `modelRouter.json` 的单价字段构成双事实源。现删除该文件，**唯一定价源 = `Configs/modelRouter.json → providers[].models[].cost_per_1k_input` / `cost_per_1k_output`**（Docs/Agent/10 §2.2，豁免 X1：内层 snake_case）。

```typescript
// Infra/Llm 边界层从 modelRouter.json 读入后转成的 camelCase 领域对象
// ⚠️ 未实现/目标态（2026-10-03 校准）：Src 中不存在这一边界层转换，见下方现状说明
interface ModelPricing {
  provider: string;                    // = providers[].provider
  modelId: string;                     // = models[].id（与 provider 拼为全局唯一 `provider/model`）
  costPer1kInput: number;              // ← models[].cost_per_1k_input
  costPer1kOutput: number;             // ← models[].cost_per_1k_output
  contextWindow: number;               // ← models[].context_window
}
```

> 字段名修正：原 `promptCostPer1K` / `completionCostPer1K` 已在 Docs/Agent/10 §2.2 迁移表中列为 **废弃**（`K` 大写不合规、且与上游字段不同名），改用 `costPer1kInput` / `costPer1kOutput`。

> **⚠️ 2026-10-03 校准（边界层适配未实现，现状记录）**：
> - `Src/Infra/Llm/Provider/providerBase.ts` 的 `ModelSpec` **原样保持 snake_case**（`cost_per_1k_input` / `cost_per_1k_output` / `context_window`），**没有任何 `ModelSpec → ModelPricing` 的适配器**；
> - `ModelPricing`（`TokenEconomy/types.ts`）只能经 `consumptionRecorder.registerPricing()` 逐个注入，而 `registerPricing` 在 `Src/` 内**无调用方**（仅 Tests）；
> - 后果：运行期 `pricingTable` **恒为空**，一旦有人调用 `recordConsumption`，必然在第一行短路返回 `err('模型 <provider>/<model> 未注册定价')` —— 即 §3.1 的整条消耗链路目前**连"能否算出成本"这一步都不具备运行条件**（与 §3.1 的"零调用方"叠加）。
> **待办**：在 `Src/main.ts` 装载 providers 的段落（`Infra/Llm` 注册处）遍历 `providers[].models[]` 调用 `registerPricing`，或让 `consumptionRecorder` 直接查 `Infra/Llm` 注册表（二者需一次设计裁决，避免把 snake_case 泄漏进 Services 层）。

### 6.2 成本计算公式

```
消耗 Token 成本(USD) = promptTokens × costPer1kInput / 1000 + completionTokens × costPer1kOutput / 1000
税额 = 消耗 Token × currentTaxRate          // currentTaxRate ∈ [economy.tax.minRate, economy.tax.maxRate]
实际扣减 = 消耗 Token + 税额
```

> **2026-10-03 复核**：公式与 `consumptionRecorder.recordConsumption` 一致；代码另有两点未写在上式——① 成本与税额**各做一次 `Math.ceil` 向上取整**，且税额的计算基数是**取整后的 `calculatedCost`**；② 税率由入参 `currentTaxRate` 透传，**不主动调 `taxCollector.getCurrentTaxRate()`**（因此 §4.2 的动态税率与本公式在代码层面尚未衔接）。

> **单位口径**：系统内部统一以 **Token** 计量钱包余额与扣减（`token_wallets.balance` / `token_transactions.amount` 数值语义为 Token，列型为 **REAL**——见 `Src/Infra/Db/migrations.ts` v5 `create_token_wallets` / v6 `create_token_transactions`，2026-09-22 校准；原写 INTEGER 与迁移不符）；
> USD 仅用于观测与 `loops.budget_used_usd`（REAL）。两者不得混用同一字段（见 Docs/Agent/09 §1.1 “金额列”行）。

### 6.3 定价示例

> 下表**仅为 `modelRouter.json` 当前默认内容的展开展示**，**不作事实源**；修改价格只改 `modelRouter.json`，本表由文档校验脚本自动比对（不一致 = 门禁失败）。
>
> **2026-10-03 校准**：原表四项（openai/gpt-4o 2.5–10.0、openai/gpt-4o-mini 0.15–0.6、anthropic/claude-sonnet-4-20250514 3.0–15.0、aliyun/qwen-max 2.0–6.0）与当前配置**全部失配**——`Configs/modelRouter.json` 现只有 **1 个 provider `huawei-maas`**（3 个模型），`routing.defaultModel = huawei-maas/DeepSeek-V4-Flash`。下表已按当前配置重贴。

| Provider | Model | 输入成本/1K | 输出成本/1K |
|----------|-------|------------|------------|
| huawei-maas | GLM-5.1 | 2.0 | 8.0 |
| huawei-maas | DeepSeek-V4-Flash | 0.5 | 2.0 |
| huawei-maas | Kimi-K2.6 | 1.0 | 4.0 |

> 三个模型的 `context_window` 均为 128000、`max_output` 均为 8192（同上文件，供 §6.1 `ModelPricing.contextWindow` 目标态参考；注意 §6.1 已记录该字段目前**无人注入**）。

---

## 7. 账本守恒验证

### 7.1 守恒规则

**系统 Token 总量 = Σ(所有活跃钱包余额) + 系统池余额 + 已销毁量**

每次交易后验证（目标式，⚠️ 2026-10-03 校准：代码未实现"外部注入"这一项）：
```
Σ(wallet.balance) + systemPool + destroyed = initialSupply + Σ(外部注入) - Σ(销毁)
```

> **⚠️ 2026-10-03 校准（代码现状：两份实现、式子互不相同，且都未接线）**
>
> | 实现 | 实际等式 | 现状 |
> |------|---------|------|
> | `walletManager.verifyConservation()` | `Σ(balance) + systemPool + destroyedTotal = initialSupply` | **无"外部注入"项**，全仓亦无任何注入登记 API；模块内的 `destroyedTotal` **只有读取与 reset，从未自增**，故该项恒 0 |
> | `tokenLedger.verifyLedgerConservation(totalWalletBalance, systemPool, destroyedTotal, initialSupply, externalInjections = 0)` | `Σ(balance) + systemPool + destroyedTotal = initialSupply + externalInjections − destroyedTotal` | `externalInjections` **由调用方传入而无人调用**；`destroyedTotal` 在等号**两侧各出现一次**（左加右减），语义可疑：只有当 `2·destroyed = externalInjections` 时才可能与 §7.1 目标式同解 |
>
> 另需注意"销毁量"在代码里其实有**两个互不相通的计数器**：`walletManager.destroyedTotal`（恒 0）与 `taxCollector.totalDestroyed`（由 `distributeTax` 累加，但 §4.3 已记录其无调用方）。
>
> **待办（代码侧，需一次裁决后同步）**：① 确定唯一守恒式（建议采用"目标式"并要求注入/销毁各自登记一个 `externalInjection` / `burn` API）；② 让 `confiscate` 与 `distributeTax` 写入同一个销毁计数器（否则罚没必然破坏守恒，见 §5.1 待办③）；③ 二选一保留 `verifyConservation` 或 `verifyLedgerConservation`，删除重复实现。

### 7.2 验证时机

| 触发点 | 验证类型 | 生效状态（2026-10-03 校准） |
|--------|---------|--------------------------|
| 每次交易完成后 | 单钱包余额校验 | ⚠️ **未实现**：`recordTransaction` 内不调用任何校验 |
| 每个 trace 结束时 | 该 trace 下所有交易汇总校验 | ⚠️ **未实现**：`tokenLedger.summarizeTrace` 仅 Tests 调用 |
| 每日定时 | 全局守恒校验 | ⚠️ **未实现**：`main.ts` 无相关定时器（全仓 `setInterval` 只在 `Audit/patrolScheduler.ts` 与 Infra 若干处，且 patrol 亦未初始化） |
| Audit Bureau 稽查时 | 涉事 Agent 全量交易审计 | ⚠️ **未实现**：`Audit/*` 不引用 TokenEconomy 的校验接口 |

> **⚠️ 2026-10-03 校准（本表为设计意图，且"账本"当前是双份）**：四类验证时机均无接线；`verifyConservation` / `verifyLedgerConservation` / `summarizeTrace` / `appendTransaction` 的调用方**只有 Tests**。
> 同时存在**双账本**：`walletManager` 内部的 `transactions[]` 数组（由 `recordTransaction` 写入，是**目前唯一真正有数据的流水**，并经只读 REST `tokenApi.ts` 暴露）与 `tokenLedger` 内部的 `ledger[]` 数组（`appendTransaction` **从未被生产代码调用**，恒为空）。二者互不写入，§7 所述"账本"实际只有一个。

### 7.3 不一致处理

> **⚠️ 未实现/目标态（2026-10-03 校准）**：下述五步**只实现了第 [1] 步**——`tokenLedger.verifyLedgerConservation` 在 `|delta| > 0.01` 时执行 `mismatchCount++` 并返回 `err('LEDGER_MISMATCH #n: expected=… actual=… delta=…')` 字符串；
> 第 [2] 步（广播 `LEDGER_MISMATCH`）、第 [3] 步（通知 Audit Bureau）、第 [4] 步（暂停相关 Agent 交易）**均无任何代码**（TokenEconomy 全模块无 `publish`，`Audit/*` 也不订阅本事件）；第 [5] 步"人工介入"无入口。
> 且该校验本身无人调用（见 §7.2），所以运行期连第 [1] 步也从不执行，`getMismatchCount()` 恒 0。

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

> **本文件不维护默认值**（SSOT 裁决，见 Docs/Agent/10 文档头）。唯一事实源为 **Docs/Agent/10 §2.4**（`economyRules.json`）与 **§2.8**（`loopConfig.json`）。
> 下表只列本子系统消费的键与其当前定义位置；原表自带的"默认值"列与已过时的路径（`economy.budget.*`）已删除。

| 配置键 | 定义位置 | 用途 | 生效状态（2026-10-03 校准） |
|--------|---------|------|--------------------------|
| `economy.initialSupply` / `defaultWalletBalance` | Docs/Agent/10 §2.4 | 初始发行量与新建 Agent 钱包默认余额 | ✅ 生效：`main.ts` 读入后传给 `initWalletManager` |
| `economy.tax.*`（baseRate / dynamicEnabled / adjustmentIntervalSec / maxRate / minRate / highLoadMultiplier / lowLoadDiscount / loadThresholdAgents） | Docs/Agent/10 §2.4 | 税率与动态调节（原名 `adjustmentInterval` → `adjustmentIntervalSec`，`loadThreshold` → `loadThresholdAgents`） | ⚠️ **部分生效**：八键由 `main.ts` 传入 `initTaxCollector`，但运行期只有 `baseRate` 影响 `currentTaxRate`；其余七键因 `adjustTaxRate` 无调度方而**从不参与决策**（见 §4.2） |
| `economy.profitSharing.{quality,quantity,efficiency}Weight` | Docs/Agent/10 §2.4 | **分润**权重（三者和=1）；与 §7 的**质量分**权重（0.4/0.3/0.3）是两个不同概念，不得混用同一组数值 | ⚠️ **不影响计算**：`profitDistributor` 用硬编码 `DEFAULT_WEIGHTS`；三键在 `Src/` 内**只被 `Infra/Config/configValidator.ts` 做"权重和=1"静态校验**，改 JSON 不改变分润结果（见 §3.3） |
| `economy.rollingWindow.{tokens,windowSec,checkIntervalSec,deviationMultiplierWarn,deviationMultiplierCritical,budgetWarnRatio}` | Docs/Agent/10 §2.4 | 滚动窗口与偏离检测（原 `rollingWindowTokens`/`rollingWindowSeconds` 扁平键已归入对象） | ⚠️ **无人读**：`Src/` 零读取；等价能力在 `Audit/anomalyDetector.ts` 里用自带默认值（`rollingWindowMs = 5*60*1000` 等），而该检测器未经 `initResourceAuditBureau` 初始化（见 §5.2） |
| `economy.budgetLimits.{singleCallMaxTokens,globalTraceHardTokens,globalTraceSoftRatio}` | Docs/Agent/10 §2.4 | 单次调用 / 整 trace 上限（原名 `singleCallMax`/`globalTraceMax` 补单位后缀并迁入 `budgetLimits`） | ⚠️ **无人读**：三键均无读取方（只对应 `types.ts` 的孤立接口 `BudgetLimits`）；单次上限在 `dualBudget.checkSingleCallLimit` 里硬编码 5000，trace 预算实际取 `loopDefaults.token_budget`（见 §5.2 生效状态列与其待办） |
| `loopDefaults.token_budget` / `roleOverrides[role].token_budget` | Docs/Agent/10 §2.8 | 单任务硬预算基准 | ✅ 生效：`main.ts` → `buildStopRuleSet` / `setRoleOverrides`，`runIteration` 消费 |
| `stopRules.budget.{warmRatio,softRatio,expandRequestRatio,hardRatio}` | Docs/Agent/10 §2.8 | 四档预算比例（见 §5.2.1） | ⚠️ **仅 `hardRatio` 实际起作用**：四值都进入 `StopRuleSet`，但运行期只有 hard 档触发中止，warm/soft/expand 的判定结果无人消费（`initDualBudget` 读到的同一组比例则完全空转，见 §5.2.1） |
| `supervision.approvalTimeoutSec` / `approvalDefaultOnTimeout` | Docs/Agent/10 §2.7 | 扩容审批超时与默认动作（取代原 `budget.expandApprovalTimeoutSec: 20`） | ⚠️ **无人读 + 待人工裁定**：两键在 `Src/` 内零引用（仅 `Client/src/config/configSchema.ts` 暴露为可编辑表单项）；运行期审批超时实际取 `Configs/security.json → security.approvalTimeoutSec`（`main.ts` 的 `configureToolSafetyGate`，兜底 300）。详见 §5.2.1"超时事实源待裁定" |

---

## 9. 事件清单

> 事件名唯一定义处为 `Docs/Agent/07 §4.3`；本表仅列本子系统相关项。`source` 统一为 `TokenEconomy`（发布方口径见 §5.1）。

| 事件 | 触发时机 | 订阅者 | 发布状态（2026-10-03 校准） |
|------|---------|--------|--------------------------|
| `TOKEN_CONSUMED` | LLM 调用消耗后 | Audit, Dashboard | ⚠️ **零发布点** |
| `TOKEN_EARNED` | 任务奖励入账后 | Dashboard | ⚠️ **零发布点** |
| `TOKEN_DISTRIBUTED` | 分润完成后 | Dashboard | ⚠️ **零发布点** |
| `TAX_PAID` | 纳税完成后 | Audit, Dashboard | ⚠️ **零发布点**（亦无 `TAX_PAYMENT` 交易，见 §3.1 [3d]） |
| `TAX_RATE_UPDATED` | 动态税率调整后 | TokenEconomy(内部), Dashboard | ⚠️ **零发布点**（且 `adjustTaxRate` 无调度方，见 §4.2） |
| `WALLET_FROZEN` | 钱包被冻结 | Core(中间件), Dashboard | ⚠️ **有发布但代发方错位**：由 `Audit/freezeManager.freezeAgent` 以 `source='Audit/freezeManager'` 发布，与本节"source 统一为 TokenEconomy"口径冲突（见 §5.1）；`Core` 侧无订阅者 |
| `WALLET_UNFROZEN` | 钱包解冻 | Core(中间件), Dashboard | ⚠️ 同上：`freezeManager.unfreezeAgent` 与 `checkAutoUnfreeze` 两处代发 |
| `TOKEN_CONFISCATED` | Token 被罚没 | Audit, Dashboard | ⚠️ **零发布点**（`confiscate()` 只写交易记录） |
| `LEDGER_MISMATCH` | 账本守恒异常 | Audit, Regulation | ⚠️ **零发布点**（校验失败只返回 err 字符串，见 §7.3） |
| `INSUFFICIENT_BALANCE` | 余额不足 | Orchestrator | ⚠️ **零发布点**（余额不足走 Result 的 err，见 §3.1 [1]） |

> **2026-10-03 校准（补充现状）**：
> - **事件名本身与代码逐字一致**：上表 10 项与 `Src/Services/EventBus/eventTypes.ts` 的 `token:` 段枚举成员名/字符串值完全对应，无需改名；失真只在**发布侧**——`Src/Services/TokenEconomy/` 全部文件都**不 import `publish` / `eventBus`**（其 import 面只有 `Infra/types.js` 的 `Result/ok/err` 与模块内部互相引用，见 §10）。
> - **订阅侧无本子系统专属消费者**：现存两类通用订阅者——① `Interface/EventStore/aiEventStore.ts` 按前缀 `token:` 做通用事件持久化；② `Interface/IpcBridge/ipcBridge.ts` 以 `subscribeMany(Object.values(EventType), …)` 全量转发到前端。上表"订阅者"列所写的 Audit / Dashboard / Orchestrator / Regulation **均无针对这些事件的专属订阅代码**；前端 Token 页面实际靠 REST 轮询（`/api/tokens/*`，见 `Client/src/stores/tokenStore.ts`）。
> - **关联的 loop 段预算/审批事件同样零发布点**：`BUDGET_WARMING` / `BUDGET_SOFT_REACHED` / `BUDGET_HARD_REACHED` 无任何发布方（仅 `dualBudget.ts` 的返回值类型）；`APPROVAL_REQUESTED` 只由 `ToolSafetyGate`（kind=`irreversible_action`）与 `agentRuntime` 发布，`APPROVAL_TIMEOUT_REJECTED` **全仓零发布点**（见 §5.2.1）。
> **待办**：① TokenEconomy 接入 EventBus 并按 §5.1 口径收回钱包三事件的发布权；② 补齐 `TOKEN_CONSUMED` / `TAX_PAID` / `LEDGER_MISMATCH` / `INSUFFICIENT_BALANCE` 的发布点；③ 在 Docs/Agent/07 §4.3 复核"订阅者"列，避免登记不存在的消费者。

---

## 10. 依赖关系

> **2026-10-03 校准：下表为"目标依赖"，当前代码尚未依赖其中任何一项。** `Src/Services/TokenEconomy/` 八个文件的 import 面只有 `../../Infra/types.js`（`Result` / `ok` / `err`）与模块内部互相引用（`types.js` / `walletManager.js`），**没有 Database、没有 EventBus、没有 Logger**；状态全部驻留在模块级 `Map` / 数组里。

| 依赖组件 | 来源 | 用途 | 现态（2026-10-03 校准） |
|---------|------|------|----------------------|
| `Database` | Infra | 钱包和交易记录持久化 | ⚠️ **未依赖**：`Src/Infra/Db/migrations.ts` 里 `create_token_wallets`(v5) / `create_token_transactions`(v6) / `add_owner_scope_to_personal_data`(v22 给两表加 `owner_user_id`) **建表存在，但全仓无任何 INSERT/UPDATE**；`Interface/RestApi/syncApi.ts` 仍按 `token_transactions` 聚合 `token.consumed`，该表**恒空** → 钱包与流水重启即失 |
| `EventBus` | Services | 事件发布/订阅 | ⚠️ **未依赖**：见 §9，TokenEconomy 不 import `publish`，10 项事件仅 2 项由 Audit 代发 |
| `LlmCaller` | Tools | 获取 Token 消耗量 | ⚠️ **符号不存在**：`Src/` 内无 `LlmCaller`；实际对应 `Core/Model/modelCaller.ts` 与 `Infra/Llm/*`，两者都不引用 TokenEconomy（消耗量目前由 `runIteration` 自行累加 `usage`，不回写钱包） |
| `Logger` | Infra | 交易审计日志 | ⚠️ **未依赖**：模块内无 logger 引用，交易只进内存数组 |

> **当前真实形态**：钱包 = 纯内存单例（`initWalletManager` 设定 `initialSupply` / `defaultWalletBalance`，`agentFactory` 建 Agent 时 `createWallet`），对外只有 `Interface/RestApi/tokenApi.ts` 的只读 GET 端点。
> **待办**：① 接入 `Database`（`token_wallets` / `token_transactions` 的读写与启动期重建）；② 接入 `EventBus` 与 `Logger`；③ 在 `runIteration` / `modelCaller` 侧把真实 `usage` 汇给 `recordConsumption`（前置条件是 §6.1 的定价注入已落地）。
