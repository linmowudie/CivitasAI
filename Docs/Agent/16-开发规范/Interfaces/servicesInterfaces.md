# Services 层接口文档

> Services 层：业务逻辑编排，消费 Core 层原语组合。
> 依赖方向：Services → Tools → Infra
>
> **2026-09-22 校准（现状记录 + 待办）**：上行"Services → Tools"与实际依赖不符。全量扫描 `Src/Services/`：对 Tools 仅 **1 处** import（`LoopControl/middleware/toolSafetyGate.ts:15` → `Tools/Registry/toolRegistry.js`）；对 Core 存在 **2 处**直连（`Recruitment/recruiter.ts:10-13`、`ReviewerAgent/reviewerAgent.ts:9-12`），**违反分层裁定**。
> **待办**：由代码侧修复（收敛至 Core 公开门面或调整模块归属），本文档只记录现状，不据代码抹平原分层裁定。

---

## 1. LoopControl (`Src/Services/LoopControl/`)

| 子模块 | 核心函数 | 说明 |
|--------|---------|------|
| `stopRules.ts` | `evaluateStopRules(rules, state, snapshot) → StopDecision` | 五类独立退出判定 |
| `stopRules.ts` | `buildStopRuleSet(config) → StopRuleSet` | 构建规则集 |
| `stopRules.ts` | `detectBudgetPhase(rules, tokensUsed) → BudgetPhase` | 预算阶段检测 |
| `loopState.ts` | `createInitialLoopState(input) → LoopState` | 创建 LoopState |
| `loopState.ts` | `setGoalImmutable(state, goal) → Result<LoopState>` | 设置不可变区（仅一次） |
| `loopState.ts` | `verifyGoalIntegrity(state, hash) → boolean` | 校验 goal 完整性 |
| `verifier/index.ts` | `runVerifierPipeline(specs, ctx, minLevelsRequired?=2) → Promise<Result<{ results, levelsRun, allPassed }>>` | L1→L2→L3→L4 管线（async，:43） |
| `actionFingerprint.ts` | `computeFingerprint(toolName, args) → string` | 计算动作指纹（:38） |
| `actionFingerprint.ts` | `detectFingerprintAction(currentFingerprint, currentIteration, history, config) → FingerprintAction` | 检测重复（四参，:81） |
| `strategyLedger.ts` | `selectNextStrategy(loopId, candidates) → { strategy, escalated }` | 选择下一轮策略；候选耗尽返回 `{ strategy: 'escalate_human', escalated: true }`（:105） |
| `failureFeedback.ts` | `buildFailureFeedback(input) → FailureFeedback` | 构建失败反馈 |
| `approvalGate.ts` | `createApproval(input) → Result<PendingApproval>` | 创建审批请求 |
| `approvalGate.ts` | `decideApproval(input) → Result<PendingApproval>` | 审批决策 |
| `middleware/toolSafetyGate.ts` | `createToolSafetyGateMiddleware(...) → AgentMiddleware` | 工具安全门（P0-3） |

> **2026-09-22 校准**：上表 `runVerifierPipeline` / `computeFingerprint` / `detectFingerprintAction` / `selectNextStrategy` 四行原签名与代码不符，已按实际导出更正（`selectNextStrategy` 返回轻量对象而非 `TurnStrategy`）。注意本模块 `detectBudgetPhase`（`stopRules.ts:206`）与 TokenEconomy 的 `detectPhase`（`dualBudget.ts:52`）是**两个不同函数**，勿混淆（见 §4）。

---

## 2. Supervision (`Src/Services/Supervision/`)

| 子模块 | 核心函数 | 说明 |
|--------|---------|------|
| `preSupervision.ts` | `runPreSupervision(input, rateLimitConfig?) → Result<PreSupervisionResult>` | 前置监管（注入/频率/权限） |
| `postSupervision.ts` | `runPostSupervision(input) → Result<PostSupervisionResult>` | 后置监管（异常/退出决策） |
| `compressSupervision.ts` | `runCompressSupervision(before, after, dropped) → Result<CompressSupervisionResult>` | 压缩监管 |

---

## 3. Context (`Src/Services/Context/`)

| 子模块 | 核心函数 | 说明 |
|--------|---------|------|
| `assembler.ts` | `assembleContext(options) → Result<AssemblyResult>` | S/L/M/H 四级装配 |
| `partitions/` | `getTotalTokens(context) → number` | 计算总 Token |
| `scoring.ts` | `scoreAllEntries(context) → EntryScore[]` | 评分排序（截断用） |

---

## 4. TokenEconomy (`Src/Services/TokenEconomy/`)

| 子模块 | 核心函数 | 说明 |
|--------|---------|------|
| `walletManager.ts` | `debit(agentId, amount, traceId, type?, metadata?) → Result<TokenWallet>` | 扣减钱包余额（LLM 消耗，:96） |
| `walletManager.ts` | `credit(agentId, amount, traceId, type?, metadata?) → Result<TokenWallet>` | 增加钱包余额（奖励/分润，:130） |
| `walletManager.ts` | `verifyConservation() → Result<{ expected, actual, delta }>` | 钱包-系统池守恒验证（:258） |
| `tokenLedger.ts` | `appendTransaction(tx) → void` | 追加台账流水（:20） |
| `tokenLedger.ts` | `verifyLedgerConservation(totalWalletBalance, systemPool, destroyedTotal, initialSupply, externalInjections?) → Result<{ expected, actual, delta }>` | 全局守恒校验（:48） |
| `tokenLedger.ts` | `summarizeTrace(traceId) → { totalConsumed, totalEarned, totalTax, transactionCount }` | 单 trace 交易汇总（:69） |
| `dualBudget.ts` | `detectPhase(tokensUsed, config) → BudgetPhase` | 预算阶段检测：`normal`/`warm`/`soft`/`expand_request`/`hard` 五档四阈值（:52） |
| `dualBudget.ts` | `checkTraceBudget(traceId, additionalTokens) → Result<BudgetPhase>` | 单 trace 预算闸门（:112） |

> **2026-09-22 校准**：本表原三行全部有误——`budgetGuard.ts` 与 `conservationVerifier.ts` **在代码中不存在**，`checkBudgetPhase()` 全库无定义；`debit/credit` 不在 `tokenLedger.ts`，实际为 `walletManager.ts:96/:130`；`verifyConservation()` 位于 `walletManager.ts:258`。预算阶段检测的真实实现为 `dualBudget.ts:52 detectPhase`（另有 `checkTraceBudget` :112）；同名 `detectBudgetPhase` 属 LoopControl（`stopRules.ts:206`，见 §1），**勿混淆**。

---

## 5. Arbitration (`Src/Services/Arbitration/`)

| 子模块 | 核心函数 | 说明 |
|--------|---------|------|
| `tribunal.ts` | `fileCase(params) → Result<ArbitrationCase>` | 立案（params: `{ conflictId, traceId, conflictType, plaintiffAgentId, defendantAgentId }`，:34） |
| `capsuleAssembler.ts` | `assembleCapsule(params) → Result<ContextCapsule>` | 胶囊组装（:39；`tribunal.ts:81` 另有同名封装 `assembleCapsule(caseId, params)`） |
| `arbitratorPool.ts` | `assignArbitrators(caseId, count) → Result<Arbitrator[]>` | 仲裁者选取（:70） |
| `restorationManager.ts` | `createPlan(params) → Result<RestorationPlan>` / `executePlan(planId) → Result<{ executed, failed }>` | 现场恢复：建计划（:22）/ 执行计划（:60） |

> **2026-09-22 校准**：原表 `initiateCase()`、`selectArbitrators()`、`restoreScene()` **均为虚构名**，代码中不存在（全库检索仅命中本文档）；实际导出依次为 `fileCase`、`assignArbitrators`、`createPlan`+`executePlan`。`assembleCapsule()` 正确，予以保留。

---

## 6. Hook (`Src/Services/Hook/`)

| 子模块 | 核心函数 | 说明 |
|--------|---------|------|
| `hookRegistry.ts` | `dispatchHook(event, data) → HookDispatchResult` | 事件分发（9 事件） |
| `hookRegistry.ts` | `registerHookHandler(handler) → Result<void>` | 注册处理器 |

---

## 未收录模块清单（2026-09-22 校准 补录）

下列模块在 `Src/Services/` 中真实存在但本文档未展开接口，此处仅登记路径与职责，接口细节另行补充：

| 所属服务 | 模块 | 一句话职责 |
|---------|------|-----------|
| Supervision | `loopSupervision.ts` | 循环监管：无进展 / 死循环 / 互相等待死锁检测 |
| Supervision | `reasoningSupervision.ts` | 推理监管：推理链异常（重复、空推理） |
| Supervision | `summarySupervision.ts` | 摘要监管：摘要质量与关键信息保留 |
| Context | `truncation.ts` | 上下文截断策略（使用率 ≥92% 才触发实际截断） |
| Context | `appendWriter.ts` | 追加式写入器：强制四段式格式并按类型路由分区 |
| Arbitration | `dynamicScaling.ts` | 动态仲裁者扩缩：按冲突频率调整辅助池（f = k·n^m） |
| TokenEconomy | `taxCollector.ts` | 税收征收：固定税率 + 高/低负载动态调节 |
| TokenEconomy | `profitDistributor.ts` | 收益分配：Consortium 模式三维贡献度分润（质量 0.5 / 数量 0.3 / 效率 0.2） |
| TokenEconomy | `consumptionRecorder.ts` | 消耗记录：单次 LLM 调用消耗 + 成本与税额 |

---

## 修订记录

| 日期 | 说明 |
|------|------|
| 2026-09-22 | 文档-代码对账校准：§4 TokenEconomy 三行按 `walletManager.ts`（debit :96 / credit :130 / verifyConservation :258）、`tokenLedger.ts`（appendTransaction :20 / verifyLedgerConservation :48 / summarizeTrace :69）、`dualBudget.ts`（detectPhase :52 / checkTraceBudget :112）重写，原 `budgetGuard.ts` / `conservationVerifier.ts` / `checkBudgetPhase()` 均不存在；§5 Arbitration 三虚构名更正为 `fileCase` / `assignArbitrators` / `createPlan`+`executePlan`；§1 四处签名（`runVerifierPipeline` / `computeFingerprint` / `detectFingerprintAction` / `selectNextStrategy`）按代码修正；文首依赖方向记现状+待办（Services→Tools 仅 1 处 import，直连 Core 2 处，违反分层裁定，须代码侧修复）；新增"未收录模块清单"9 项。 |
