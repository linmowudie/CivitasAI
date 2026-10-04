# Services 层接口文档

> Services 层：业务逻辑编排，消费 Core 层原语组合。
> 依赖方向：Services → Tools → Infra
>
> **2026-09-22 校准（现状记录 + 待办）**：上行"Services → Tools"与实际依赖不符。全量扫描 `Src/Services/`：对 Tools 仅 **1 处** import（`LoopControl/middleware/toolSafetyGate.ts` 顶部 `import { getTool }` → `Tools/Registry/toolRegistry.js`，2026-10-03 复查仍为全层唯一 Tools 直连点，原 :15 行号精确）；对 Core 的直连当时记为 **2 处**（`Recruitment/recruiter.ts`、`ReviewerAgent/reviewerAgent.ts`），**违反分层裁定**。
>
> **2026-10-03 校准（Core 直连由 2 处增至 3 个文件）**：复核 `Src/Services/` 全量父级 import，实为 **3 个文件**：
>
> | 文件 | 符号定位 | 导入性质 |
> |------|---------|---------|
> | `Recruitment/recruiter.ts` | 文件头 import 块（:9-13）：`createAgent`（agentFactory）、`getAgent`/`getAllAgents`/`updateAgent`/`setAgentParent`/`getAgentParent`（agentRegistry）、`handleAgentEvent`（agentRuntime）+ `type RecruitmentRequest`（Decision/types）、`type AgentInstance`（AgentRuntime/types） | **值导入 + 类型导入混合**（原记 `:10-13` 范围有误，含 :9 的类型导入应为 :9-13） |
> | `ReviewerAgent/reviewerAgent.ts` | 文件头 import 块（:9-12）：`reviewSubmission`/`getPendingReview`（agentRuntime）、`getAgent`（agentRegistry）+ `type SubmitResult`（AgentRuntime/types） | 值导入为主（原记 `:9-12` ✓ 精确） |
> | `Recruitment/terminationRationale.ts` | 文件头单行（:8）：`type TerminationRationale`、`type TerminationReason`（Decision/types） | **新增项**，纯类型导入 |
>
> 按文件计为 **值导入 2 个文件 + 纯类型导入 1 个文件**——二者收敛成本不同（类型导入仅需改引用路径，值导入需走门面或依赖注入）。`Services → Interface` 直连 0 处 ✓。
>
> **待办**（2026-10-03 状态更新）：⚠️ **未开始 / 已改由门禁豁免**——原待办"由代码侧修复（收敛至 Core 公开门面或调整模块归属）"**并未执行**，上述三个文件仍走 `../../Core/...` 深路径；而修复载体已具备却未被采用：Core 门面 `Src/Core/index.ts` 已 `export * as AgentRuntime`（:5）/ `export * as Decision`（:6）。若维持待办，收敛范围即"3 个文件的 import 改写"。本文档只记录现状，不据代码抹平原分层裁定。
>
> **【需人工裁定】门禁口径与本文档措辞冲突**：代码侧未做收敛，改为放宽门禁——`.eslintrc.json` 中 Services←Core zone 已写作 `{ target: "./Src/Services", from: "./Src/Core", except: ["AgentRuntime", "Decision"] }`（该规则块 :30-34，提交 493b005"恢复五类退出判定与分层 zones"，**晚于 09-22 校准**）。2026-10-03 复测 `npx eslint` 三个直连文件为 **0 error / 1 warning**（唯一告警是 `recruiter.ts:17` 的 `import/order`）。即"违反分层裁定"已被门禁豁免，而本文档仍记为违规——二选一需人工裁定：①回退 `except` 白名单、按待办收敛到门面；②承认 `AgentRuntime`/`Decision` 为 Core 对 Services 的合法暴露面，据此改写"违反分层裁定"措辞与待办。本文档不擅自裁决。
>
> **2026-10-03 校准（反向依赖现状记录，【需人工裁定】）**：分层红线另有一处已在代码侧破裂，但**不属 Services 层主动越层**：`Src/Tools/Custom/agentRecruiter.ts` 顶部 `import { recruitAgent, getRecruitedAgents } from '../../Services/Recruitment/recruiter.js'`（:20）与 `import type { AgentRole } from '../../Core/AgentRuntime/types.js'`（:21），即 **Tools → Services/Core 上行依赖**。`npx eslint Src/Tools/Custom/agentRecruiter.ts` 实测 **2 error**（`import/no-restricted-paths`，20:50 与 21:32，提示"Tools 层不可依赖上层"），属 CI 阻断项。本节按"现状记录 + 待办"登记（本文档是五份契约中唯一设有该段落的文档）：**待办** —— 处理口径由 toolsInterfaces.md 侧的同类裁定项统一决定（①把 recruit 类工具上移到 Services/Core；②经 `Src/Core/index.ts` 门面 + 依赖注入解耦；③在 toolsInterfaces.md 增设与本文档同构的现状+待办段），本代理不裁决、不改写 Services 层自身接口面。
>
> **✅ 2026-10-04 收口（FE-064~072 批次）**：① Services→Core 直连收敛结果——`reviewerAgent.ts` 对 `Core/Model` 的直连已**消除**（L3 Judge 调用器改为组合根注入 `configureReviewer.callModelFn`；该文件剩余的 `Core/AgentRuntime` 直连与门禁 `except: ["AgentRuntime","Decision"]` 完全一致）；`Recruitment/recruiter.ts`、`Recruitment/terminationRationale.ts` 的 `Core/AgentRuntime`/`Core/Decision` 直连**维持不变**——上述【需人工裁定】栏采纳**口径②**：**AgentRuntime/Decision 视为 Core 对 Services 的合法暴露面**，"违反分层裁定"措辞以门禁（`.eslintrc.json` zones）为准。② 反向依赖（Tools→Services 的 `agentRecruiter.ts` 等）已按 toolsInterfaces.md 裁决**消除**（依赖注入端口 `Src/Tools/Registry/toolServicePorts.ts`，组合根 `main.ts` ⑫.6 装配）。③ 全量门禁 `npx eslint Src/` = **0 errors**（218 warnings）、两套 tsc 0 错误、全量测试 1343/1343，五份契约文档与门禁口径现已一致。

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
| `verifier/index.ts` | `runVerifierPipeline(specs, ctx, minLevelsRequired?=2) → Promise<Result<{ results, levelsRun, allPassed }>>` | L1→L2→L3→L4 管线（async；定位 `verifier/index.ts` 的 `runVerifierPipeline()`，导出行现 :44 —— **2026-10-03 校准**：签名与 `minLevelsRequired = 2` 默认值经复查完全一致，原记 `:43` 系 +1 行漂移） |
| `actionFingerprint.ts` | `computeFingerprint(toolName, args) → string` | 计算动作指纹（:38） |
| `actionFingerprint.ts` | `detectFingerprintAction(currentFingerprint, currentIteration, history, config) → FingerprintAction` | 检测重复（四参，:81） |
| `strategyLedger.ts` | `selectNextStrategy(loopId, candidates) → { strategy, escalated }` | 选择下一轮策略；候选耗尽返回 `{ strategy: 'escalate_human', escalated: true }`（:105） |
| `failureFeedback.ts` | `buildFailureFeedback(input) → FailureFeedback` | 构建失败反馈 |
| `approvalGate.ts` | `createApproval(input, defaultTimeoutSec = 60) → Result<PendingApproval>` | 创建审批请求；定位 `approvalGate.ts` 的 `createApproval()`（:43-46）。**2026-10-03 校准**：原只写单参，实为**双参**——第二参 `defaultTimeoutSec` 承载"timeoutSec 保存生效时长快照（防配置热更新突变存量审批）"语义，仅当 `input.timeoutSec` 缺省时取用，属契约信息 |
| `approvalGate.ts` | `decideApproval(input) → Result<PendingApproval>` | 审批决策（单参 ✓，`decideApproval()` :189，2026-10-03 复查） |
| `middleware/toolSafetyGate.ts` | `createToolSafetyGateMiddleware(...) → AgentMiddleware` | 工具安全门（P0-3） |

> **2026-09-22 校准**：上表 `runVerifierPipeline` / `computeFingerprint` / `detectFingerprintAction` / `selectNextStrategy` 四行原签名与代码不符，已按实际导出更正（`selectNextStrategy` 返回轻量对象而非 `TurnStrategy`）。四行签名 2026-10-03 复查**仍与代码一致**（`computeFingerprint()` :38、`detectFingerprintAction()` :81、`selectNextStrategy()` :105 均未漂移）。
>
> **⚠️ 同名易混（2026-10-03 校准，行号修正）**：本模块 `detectBudgetPhase`（定位 `stopRules.ts` 的 `detectBudgetPhase()`，**现 :207**，原记 :206 系头部注释 +1 行漂移；返回类型 `BudgetPhase` 五值定义在同文件 :205）与 TokenEconomy 的 `detectPhase`（`dualBudget.ts` :52，2026-10-03 复查行号精确）是**两个不同函数**，勿混淆（见 §4）。

### 1.1 LoopControl 中间件族与审批落盘（2026-10-03 校准 补录）

§1 上表覆盖 **8 个文件 / 14 行**，而 `Src/Services/LoopControl/` 实有 **22 个 `.ts` 文件**。以下三类资产此前完全未登记：

| 文件 | 导出（函数名 + 当前行号） | 说明 |
|------|--------------------------|------|
| `middleware/toolSafetyGate.ts` | `createToolSafetyGateMiddleware()` :69、`configureToolSafetyGate(config)` :60；类型 `ToolSafetyGateConfig` :26 | 工具安全门（上表已登记前者）；本层唯一 Tools 直连点 |
| `middleware/budgetSentinelControl.ts` | `createBudgetSentinelControlMiddleware()` :25；类型 `BudgetEventCallbacks` :17 | 预算哨兵控制 |
| `middleware/checkpointWriter.ts` | `createCheckpointWriterMiddleware()` :37、`getCheckpoints(loopId)` :85、`getLatestCheckpoint(loopId)` :90、`clearCheckpointStore(loopId?)` :96；类型 `CheckpointRecord` :16、`CheckpointCallbacks` :28 | 检查点写入 |
| `middleware/fingerprintDetectorControl.ts` | `createFingerprintDetectorControlMiddleware()` :16 | 指纹检测控制 |
| `middleware/goalReanchorControl.ts` | `createGoalReanchorControlMiddleware()` :31；类型 `GoalReanchorControlConfig` :16 | 目标重锚控制 |
| `middleware/stopRuleEvaluator.ts` | `createStopRuleEvaluatorMiddleware()` :21；类型 `StopRuleCallbacks` :16 | 退出规则求值 |
| `approvalPersistence.ts` | `persistApprovalCreated(approval)` :89、`persistApprovalUpdated(approval)` :141、`expireStaleApprovals(reason = '服务重启，默认拒绝')` :178、`listPersistedApprovals(owner, limit = 100)` :205 | 审批落盘与重启过期（整个文件此前未登记） |

### 1.2 已登记文件的其余导出（2026-10-03 校准 补录）

| 文件 | 未登记导出（函数名 + 当前行号） |
|------|--------------------------------|
| `stopRules.ts` | `getEvaluationOrder()` :255、`setActiveStopRuleSet(rules)` :267、`getActiveStopRuleSet() → StopRuleSet \| null` :272 —— **两个 setter/getter 均为跨层消费点，必须登记**：写入侧 `Src/main.ts:44` 经 `Services/LoopControl/index.js` 同时导入 `buildStopRuleSet` + `setActiveStopRuleSet`，:298 用 `loopConfig.json` 顶层键（`loopDefaults`/`stopRules`）构建规则集、:317 登记；读取侧 `Src/Core/Loop/runIteration.ts:20` 导入 `getActiveStopRuleSet`，:712 读取、:725 传入 `evaluateStopRules`（未登记时在 :728 按 `LoopConfig` **内联构造**临时 `StopRuleSet` 兜底，并非调用 `buildStopRuleSet`） |
| `loopState.ts` | `cloneImmutableZone(state)` :155、`hashGoal(goal)` :186；类型群 `VerifierSpec` :22 / `VerifierResult` :39 / `FailedAttempt` :51 / `FingerprintRecord` :62 / `ApprovalDecider` :72 / `PendingApproval` :77 / `SuspensionRecord` :113 / `LoopState` :122 / `CreateLoopStateInput` :201 |
| `actionFingerprint.ts` | `canonicalJson(obj)` :16、`recordFingerprint(...)` :149；类型 `FingerprintConfig` :53、`FingerprintAction` :63 |
| `strategyLedger.ts` | `validateTurnStrategy(ts)` :29、`recordStrategy(loopId, strategy)` :49、`backfillStrategyResult(...)` :63、`getStrategies(loopId)` :83、`getFailedStrategies(loopId)` :90、`clearLedger(loopId?)` :125 |
| `failureFeedback.ts` | `feedbackToToolResult(feedback) → object` :166；类型 `FailureFeedback` :17 / `FailureFeedbackConfig` :37 / `BuildFeedbackInput` :48 |
| `approvalGate.ts` | 全文件 **11 个函数导出**，上表登记 2 个，其余 9 个：`waitForApprovalDecision(...)` :126、`registerApproval(approval)` :174、`forceApprove(...)` :240、`checkTimeoutApprovals(now = Date.now())` :265、`getApproval(approvalId)` :288、`getApprovalsByLoop(loopId)` :298、`getPendingApprovals()` :305、`getRecentApprovals(limit = 100)` :316、`clearApprovalQueue()` :337 |
| `types.ts` / `index.ts` | `FailureCategory` :11 / `NextAction` :24 / `RiskLevel` :33 / `LoopPhase` :37 / `StoppedReason` :47 / `ApprovalKind` :58；`index.ts` 为桶文件（`export type` 分组 :9-85） |

---

## 2. Supervision (`Src/Services/Supervision/`)

| 子模块 | 核心函数 | 说明 |
|--------|---------|------|
| `preSupervision.ts` | `runPreSupervision(input, rateLimitConfig?) → Result<PreSupervisionResult>` | 前置监管（注入/频率/权限） |
| `postSupervision.ts` | `runPostSupervision(input) → Result<PostSupervisionResult>` | 后置监管（异常/退出决策） |
| `compressSupervision.ts` | `runCompressSupervision(before, after, dropped) → Result<CompressSupervisionResult>` | 压缩监管 |

> **2026-10-03 校准（复查通过）**：§2 三行签名与代码一致（`preSupervision.ts` 的 `runPreSupervision()` :65、`postSupervision.ts` 的 `runPostSupervision()` :34、`compressSupervision.ts` 的 `runCompressSupervision()` :18；形参实名 `tokensBefore/tokensAfter/droppedEntryTypes`）。补充契约细节：`runPreSupervision` 的第二参并非纯可选，而是**带默认值** `rateLimitConfig: RateLimitConfig = currentRateLimitConfig`，同文件另有 `initPreSupervisionRateLimit(config)` :21 用于注入全局频率配置。本节其余导出（`loopSupervision.ts` / `reasoningSupervision.ts` / `summarySupervision.ts`）见文末"未收录模块清单"。

---

## 3. Context (`Src/Services/Context/`)

| 子模块 | 核心函数 | 说明 |
|--------|---------|------|
| `assembler.ts` | `assembleContext(options) → Result<AssemblyResult>` | S/L/M/H 四级装配；定位 `assembler.ts` 的 `assembleContext()`（:68，复查 ✓）。`PartitionId = 'S'\|'L'\|'M'\|'H'` 定义在 `partitions/partitions.ts` :19 ✓；`truncationThreshold` 默认 **0.92**（:59 声明 / :73 取默认 / :86 判定），与"未收录清单"中 `truncation.ts` 的表述一致 ✓ |
| `assembler.ts` | `computeCachePrefixHash(...)`（:148） | 缓存前缀哈希（**2026-10-03 校准** 补录，此前未登记） |
| `partitions/partitions.ts` | `getTotalTokens(context) → number` | 计算总 Token（定位 `getTotalTokens()` :134） |
| `partitions/partitions.ts` | 其余导出：`createEmptyPartition` :80、`createEmptyContext` :85、`appendEntry` :98、`serializeEntry` :128、`getTotalEntries` :139、`getPartitionRatio` :144、`isPartitionOverBudget` :154、`estimateTokens` :164、`clearHighFreqPartition` :173；常量 `PARTITION_CONFIG` :61、`PARTITION_ORDER` :69；类型 `ContextEntry` :22、`PartitionConfig` :44、`PartitionState` :52 | **2026-10-03 校准** 补录：分区读写与容量估算才是 Context 的底座契约，原表仅登记 1 个函数 |
| `scoring.ts` | `scoreAllEntries(context, now = Date.now(), config = DEFAULT_SCORING_CONFIG) → EntryScore[]` | 评分排序（截断用）；定位 `scoring.ts` 的 `scoreAllEntries()`（:129-133）。**2026-10-03 校准**：原只写首参，实为**三参**——`now` 与 `config` 均有默认值，调用方可注入非默认 ScoringConfig 做离线重算，属契约信息 |
| `scoring.ts` | 其余导出：`computeRecencyScore` :64、`computeFrequencyScore` :78、`scoreEntry` :90、`getDroppableEntries` :150；常量 `DEFAULT_SCORING_CONFIG` :51；类型 `EntryScore` :21、`ScoringConfig` :39 | **2026-10-03 校准** 补录 |
| `contextStore.ts` | `messageFingerprint(role, content) → string`（:119）；类型 `ContextSection` :17 | **2026-10-03 校准** 抽查补录：本文件此前整体未出现在文档中 |

---

## 4. TokenEconomy (`Src/Services/TokenEconomy/`)

| 子模块 | 核心函数 | 说明 |
|--------|---------|------|
| `walletManager.ts` | `debit(agentId, amount, traceId, type?, metadata?) → Result<TokenWallet>` | 扣减钱包余额（LLM 消耗）；定位 `walletManager.ts` 的 `debit()`（**2026-10-03 校准** :97，原记 :96 系 +1 漂移；参数序复查 ✓） |
| `walletManager.ts` | `credit(agentId, amount, traceId, type?, metadata?) → Result<TokenWallet>` | 增加钱包余额（奖励/分润）；定位 `credit()`（**2026-10-03 校准** :131，原记 :130） |
| `walletManager.ts` | `verifyConservation() → Result<{ expected, actual, delta }>` | 钱包-系统池守恒验证；定位 `verifyConservation()`（**2026-10-03 校准** :259，原记 :258） |
| `tokenLedger.ts` | `appendTransaction(tx) → void` | 追加台账流水；定位 `tokenLedger.ts` 的 `appendTransaction()`（**2026-10-03 校准** :21，原记 :20） |
| `tokenLedger.ts` | `verifyLedgerConservation(totalWalletBalance, systemPool, destroyedTotal, initialSupply, externalInjections = 0) → Result<{ expected, actual, delta }>` | 全局守恒校验；定位 `verifyLedgerConservation()`（**2026-10-03 校准** :49，原记 :48；5 参与默认值复查 ✓） |
| `tokenLedger.ts` | `summarizeTrace(traceId) → { totalConsumed, totalEarned, totalTax, transactionCount }` | 单 trace 交易汇总；定位 `summarizeTrace()`（**2026-10-03 校准** :70，原记 :69；4 字段返回形态复查 ✓） |
| `dualBudget.ts` | `detectPhase(tokensUsed, config) → BudgetPhase` | 预算阶段检测：`normal`/`warm`/`soft`/`expand_request`/`hard` 五档四阈值（定位 `detectPhase()` :52 —— 2026-10-03 复查**行号精确** ✓；`BudgetPhase` 类型在同文件 :14） |
| `dualBudget.ts` | `checkTraceBudget(traceId, additionalTokens) → Result<BudgetPhase>` | 单 trace 预算闸门（定位 `checkTraceBudget()` :112 —— 2026-10-03 复查**行号精确** ✓） |

### 4.1 TokenEconomy 其余导出（2026-10-03 校准 补录）

§4 上表覆盖 **3 个文件 / 8 行**，而 `Src/Services/TokenEconomy/` 实有 8 个 `.ts` 文件。以下导出此前未登记（2026-10-03 逐一回查调用点，标注"消费点"列的真实状态）：

| 文件 | 未登记导出（函数名 + 当前行号） | 消费点（2026-10-03 复查） |
|------|--------------------------------|--------|
| `walletManager.ts` | **`createWallet(agentId, traceId) → Result<TokenWallet>`** :42 | `Src/Core/AgentRuntime/agentFactory.ts:9`（值导入，:49 调用）—— **跨层消费，必须登记** |
| `walletManager.ts` | `getTransactions(walletId?) → TokenTransaction[]` :248 | REST 数据源：`Src/Interface/RestApi/tokenApi.ts:8`（值导入，:50 调用）；亦经 `TokenEconomy/index.ts` :18 桶导出 |
| `walletManager.ts` | `checkBalance(agentId, estimatedCost) → Result<boolean>` :86 | ⚠️ **未接线**：`Src/` 内无调用点，仅 `index.ts` :16 导出——预算闸门目前由 `dualBudget` 侧承担 |
| `walletManager.ts` | `freezeWallet(agentId, reason, traceId)` :165、`unfreezeWallet(agentId, traceId)` :190、`confiscate(agentId, amount, traceId)` :215 | ⚠️ **未接线**：`Src/` 内无调用点。`Audit/freezeManager.ts` 的 `freezeAgent()` :42 / `unfreezeAgent()` :77 走**自有** `freezeRecords: Map`（:29）并发事件，**不回写钱包状态**，即"冻结即扣币"尚未打通 |
| `walletManager.ts` | `initWalletManager(config)` :30、`getWallet(agentId)` :239、`getAllWallets()` :244、`getSystemPool()` :307、`recordTaxPayment(agentId, taxAmount, _traceId)` :312、`resetWalletManager()` :298 | 启动装配 / 查询 / 测试隔离（`getWallet`/`getAllWallets`/`getSystemPool` 亦为 REST `tokenApi.ts:8` 导入项；`resetWalletManager` 经 `index.ts` :18 桶导出） |
| `tokenLedger.ts` | `getLedgerTransactions(filter?)` :27、`getTransactionCount()` :39、`getMismatchCount()` :104、`clearLedger()` :111 | 台账查询与测试隔离 |
| `dualBudget.ts` | `initDualBudget(config)` :43、`getBudgetStatus(traceId) → Result<BudgetStatus>` :68、`recordUsage(traceId, tokens)` :92、`checkSingleCallLimit(tokens) → Result<boolean>` :100、`recordUsageAndDetect(traceId, tokens) → BudgetEvent \| null` :138、`resetDualBudget()` :167、`getTraceUsage(traceId)` :172 | 预算闸门全流程（`BudgetEvent` 类型 :128） |
| `types.ts` / `index.ts` | `TransactionType` :10、`WalletStatus` :25、`TokenWallet` :29、`TokenTransaction` :44、`ConsumptionRecord` :59、`TaxConfig` :79、`ModelPricing` :92、`EfficiencyMetrics` :102、`ProfitSharingConfig` :112、`BudgetLimits` :120、`RollingWindowConfig` :128 | 钱包/台账类型群是 REST 与守恒校验的对外形态；`index.ts` 为桶文件 |

> **2026-09-22 校准**：本表原三行全部有误——`budgetGuard.ts` 与 `conservationVerifier.ts` **在代码中不存在**，`checkBudgetPhase()` 全库无定义；`debit/credit` 不在 `tokenLedger.ts`，实际为 `walletManager.ts` 的 `debit()` / `credit()`；`verifyConservation()` 亦位于 `walletManager.ts`。预算阶段检测的真实实现为 `dualBudget.ts` 的 `detectPhase`（另有 `checkTraceBudget`）；同名 `detectBudgetPhase` 属 LoopControl（`stopRules.ts`，见 §1），**勿混淆**。
>
> **2026-10-03 校准**：①上述"不存在"三项复查**仍成立**（`grep budgetGuard\|conservationVerifier\|checkBudgetPhase Src/` → 0 命中），予以保留；②本表 `walletManager.ts` 三行与 `tokenLedger.ts` 三行的行号全部 **+1 漂移**（本轮源于各文件头部注释增行），已按当前代码回填为上表括注值；③`dualBudget.ts` 的 :52 / :112 未漂移，精确命中；④自本轮起本文件改以"**文件名 + 函数/符号名**"为主锚、行号为辅（见各表"定位"列）。

---

## 5. Arbitration (`Src/Services/Arbitration/`)

| 子模块 | 核心函数 | 说明 |
|--------|---------|------|
| `tribunal.ts` | `executeFullArbitration(params) → Result<ArbitrationCase>` | **仲裁全流程入口**（六步治理闭环端到端；`params` 为 9 字段对象 `{conflictId, traceId, conflictType, plaintiffAgentId, defendantAgentId, newMemoryContent, oldMemoryContent, taskDescription, restorerAgentId}`）。**2026-10-03 校准** 首位登记：定位 `tribunal.ts` 的 `executeFullArbitration()` :319 |
| `tribunal.ts` | `fileCase(params) → Result<ArbitrationCase>` | 立案（params: `{ conflictId, traceId, conflictType, plaintiffAgentId, defendantAgentId }`）；定位 `tribunal.ts` 的 `fileCase()`（**2026-10-03 校准** :35，原记 :34 系 +1 漂移；5 字段集逐字复查 ✓，:35-41） |
| `capsuleAssembler.ts` | `assembleCapsule(params) → Result<ContextCapsule>` | 胶囊组装；定位 `capsuleAssembler.ts` 的 `assembleCapsule()`（**2026-10-03 校准** :40，原记 :39）。`tribunal.ts` 另有同名封装 `assembleCapsule(caseId, params)`（**现 :82**，原记 :81） |
| `arbitratorPool.ts` | `assignArbitrators(caseId, count) → Result<Arbitrator[]>` | 仲裁者选取；定位 `arbitratorPool.ts` 的 `assignArbitrators()`（**2026-10-03 校准** :71，原记 :70） |
| `restorationManager.ts` | `createPlan(params) → Result<RestorationPlan>` / `executePlan(planId) → Result<{ executed, failed }>` | 现场恢复：建计划 / 执行计划；定位 `restorationManager.ts` 的 `createPlan()`（**2026-10-03 校准** :23，原记 :22）与 `executePlan()`（**现 :61**，原记 :60）；返回形态 `Result<{executed, failed}>` 复查 ✓ |

### 5.1 Arbitration 其余导出（2026-10-03 校准 补录）

原表仅 4 行、`tribunal.ts` 的 12 个导出中只登记 1 个：

| 文件 | 未登记导出（函数名 + 当前行号） |
|------|--------------------------------|
| `tribunal.ts` | `reasonVerdict(caseId) → Result<FinalVerdict>` :128、`issueSuspension(caseId) → Result<void>` :196、`createRestorationPlan(caseId, params) → Result<RestorationPlan>` :235、`completeRestoration(planId) → Result<void>` :261、`consolidateKnowledge(caseId) → Result<void>` :294、`getCase(caseId)` :372、`getCaseByConflictId(conflictId)` :377、`getAllCases()` :384、`resetTribunal()` :390 |
| `arbitratorPool.ts` | `initArbitratorPool(config)` :35、`releaseArbitrators(caseId)` :95、`executeVerdicts(params)` :111、`resizeAuxiliaryPool(targetCount) → Result<{added, removed}>` :147、`getPoolStats()` :174、`getAllArbitrators()` :191、`resetArbitratorPool()` :197；类型 `Arbitrator` :16 |
| `capsuleAssembler.ts` | `initCapsuleAssembler(source)` :30、`resetCapsuleAssembler()` :127；类型 `EvidenceSource` :16 |
| `restorationManager.ts` | `addCompensatingAction(planId, action)` :47、`getPlan(planId)` :103、`getPlansByCase(caseId)` :108、`getAllPlans()` :112、`resetRestorationManager()` :118 |
| `dynamicScaling.ts` | `initDynamicScaling(cfg)` :54、`recordConflict(timestamp?)` :64、`evaluateScaling()` :73、`startAutoScaling()` :151、`stopAutoScaling()` :158、`getScalingConfig()` :167、`getScalingStats()` :171、`resetDynamicScaling()` :187（另见"未收录模块清单"） |
| `types.ts` | `CaseStatus` :10、`VerdictType` :23、`ConflictType` :31、`ContextCapsule` :38、`OperationRecord` :59、`ArbitratorVerdict` :69、`FinalVerdict` :85、`ArbitrationCase` :100、`RestorationPlan` :130、`CompensatingAction` :142、`ScalerConfig` :152 |

> **【需人工裁定】现场恢复存在双入口**：恢复职责并非单一归属 `restorationManager.ts`。`tribunal.ts` 侧另有同一职责的另一套编排封装 `createRestorationPlan()`（:235）与 `completeRestoration()`（:261），与 `restorationManager` 的 `createPlan()`/`executePlan()` 并行。
> **现状记录**（2026-10-03 复核）：两套实现**互不调用、各持状态**——`tribunal.ts` 维护模块内私有 `restorationPlans: Map`（:22，紧邻 `cases: Map` :21，计划 ID 形如 `restore-${caseId}`），`restorationManager.ts` 维护另一份私有 `plans: Map`（:18，配自增 `planCounter` :19）；两文件均只依赖 `EventBus` + `Infra/types`，彼此无 import；`restorationManager` 在 `Src/` 内**无任何消费者**，唯一引用是 `Tests/Judicial/judicialSupervision.spec.ts:54`。即当前事实上的执行链走 tribunal，而 `restorationManager` 处于"仅测试覆盖"状态，存在两套状态机并存的漂移风险。
> **待办**：需人工裁定权威实现归属（清单建议：`restorationManager` 为执行层、`tribunal` 为编排层，由 tribunal 调用 restorationManager），并在本文档显式标注调用方向后回填本节。本代理不擅自裁决，仅登记现状。

> **2026-09-22 校准**：原表 `initiateCase()`、`selectArbitrators()`、`restoreScene()` **均为虚构名**，代码中不存在；实际导出依次为 `fileCase`、`assignArbitrators`、`createPlan`+`executePlan`。`assembleCapsule()` 正确，予以保留。
> **2026-10-03 校准**：①三虚构名复查**仍不复活**（`grep initiateCase\|selectArbitrators\|restoreScene Src/` → 0 命中）；②上表五处行号（`fileCase`/`assembleCapsule`/tribunal 同名封装/`assignArbitrators`/`createPlan`+`executePlan`）**全部 +1**，源于各文件头部注释增行，已按当前代码回填；③主锚改为"文件名 + 函数名"，行号降为辅助。

---

## 6. Hook (`Src/Services/Hook/`)

| 子模块 | 核心函数 | 说明 |
|--------|---------|------|
| `hookRegistry.ts` | `dispatchHook(event, data) → Promise<HookDispatchResult>` | 事件分发（9 事件）；定位 `hookRegistry.ts` 的 `dispatchHook()`（:87-91）。**2026-10-03 校准**：实为 **`export async function`**，原表漏写 `Promise<>`——调用方若按同步语义书写会拿到 pending Promise；`data` 形参类型 `Record<string, unknown>` |
| `hookRegistry.ts` | `registerHookHandler(handler) → Result<void>` | 注册处理器（定位 `registerHookHandler()` :64，单参 ✓ 复查） |
| `hookRegistry.ts` | `registerHookHandlers(list) → Result<number>`（:77）、`getAllHookHandlers()`（:143）、`clearHookHandlers()`（:144）、`getHookHandlerCount()`（:145） | **2026-10-03 校准** 补录：批量注册与测试隔离/热卸载入口 |

> **`HOOK_EVENTS` 治理配置表（2026-10-03 校准 补录）**：定位 `hookRegistry.ts` 的 `HOOK_EVENTS`（:23-33，`Record<HookEvent, HookEventConfig>`；`HookEvent` 联合类型 :12-15 **恰 9 值** ✓）。`interceptable` 与 `defaultFailBehavior`（fail-open / fail-closed）是治理契约——决定中间件能否阻断动作、处理器抛错时放行还是拦截：
>
> | HookEvent | interceptable | defaultFailBehavior |
> |-----------|--------------|---------------------|
> | `UserInputReceived` | true | fail-open |
> | `SessionStart` | true | **fail-closed** |
> | `PreToolExecute` | true | **fail-closed** |
> | `PostToolExecute` | false | fail-open |
> | `ModelCallStart` | false | fail-open |
> | `ModelCallEnd` | false | fail-open |
> | `VerifierExecuted` | false | fail-open |
> | `ApprovalRequested` | false | fail-open |
> | `SessionEnd` | false | fail-open |
>
> 相关类型：`HookEventConfig` :17、`HookHandler` :35（`handle` 返回 `Promise<HookHandlerResult>`）、`HookPayload` :43、`HookHandlerResult` :49、`HookDispatchResult` :55。`dispatchHook` 对未知 event 返回 `{ intercepted: false, handlersExecuted: 0, errors: [...] }` 而非抛错。`Src/Services/Hook/` 另有 `index.ts` 桶文件（目录共 2 个 `.ts` 文件）。

---

## 未收录模块清单（2026-09-22 校准 补录 / 2026-10-03 校准 扩容）

> **2026-10-03 校准**：`Src/Services/` 实有 **19 个子目录 / 99 个 `.ts` 文件**（98 个分布于子目录，另 1 个为层桶 `Src/Services/index.ts`）。原清单 9 项路径经逐一复查**全部存在** ✓，但 9 项都只是"已展开章节所在目录内的次要文件"；**13 个目录整体未登记**，接口面全貌被"核心函数"措辞掩盖。下表分两类登记：A 类为原 9 项，B 类为本次补录的 13 个目录（含文件数）。
> 特别说明：`EventBus` 与 `Hook` 同为全局横切契约，原文档只展开了 Hook；`EventBus.eventTypes` 是 Hook / LoopControl / Arbitration / SharedMemory 的事件名单一真相源（全系统事件名的唯一定义处，禁止自由字符串），不应缺席。

### A. 已展开目录内的未登记文件（原 9 项，2026-10-03 复查路径 ✓）

| 所属服务 | 模块 | 一句话职责 |
|---------|------|-----------|
| Supervision | `loopSupervision.ts` | 循环监管：无进展 / 死循环 / 互相等待死锁检测（`runLoopSupervision()` :34、`detectDeadlock()` :75） |
| Supervision | `reasoningSupervision.ts` | 推理监管：推理链异常（重复、空推理）（`runReasoningSupervision()` :22） |
| Supervision | `summarySupervision.ts` | 摘要监管：摘要质量与关键信息保留（`runSummarySupervision()` :22） |
| Context | `truncation.ts` | 上下文截断策略（使用率 ≥92% 才触发实际截断；`truncateContext()` :58、`needsTruncation()` :121、`trimPartitionToBudget()` :132） |
| Context | `appendWriter.ts` | 追加式写入器：强制四段式格式并按类型路由分区（`writeEntry()` :58、`writeEntries()` :88、`serializeContext()` :106、`TYPE_PARTITION_MAP` :22） |
| Arbitration | `dynamicScaling.ts` | 动态仲裁者扩缩：按冲突频率调整辅助池（f = k·n^m；函数清单见 §5.1） |
| TokenEconomy | `taxCollector.ts` | 税收征收：固定税率 + 高/低负载动态调节（`initTaxCollector` :24、`getCurrentTaxRate` :32、`calculateTax` :45、`adjustTaxRate` :60、`distributeTax` :90、`getTotalTaxCollected` :107、`getTotalDestroyed` :111、`resetTaxCollector` :115、`getTaxConfig` :36） |
| TokenEconomy | `profitDistributor.ts` | 收益分配：Consortium 模式三维贡献度分润（质量 0.5 / 数量 0.3 / 效率 0.2；`calculateDistribution` :51、`executeDistribution` :113） |
| TokenEconomy | `consumptionRecorder.ts` | 消耗记录：单次 LLM 调用消耗 + 成本与税额（`registerPricing` :25、`getPricing` :33、`recordConsumption` :60、`getConsumptionRecords` :119、`getTotalConsumption` :129、`clearConsumptionRecords` :137） |

### B. 整体未登记的 13 个目录（2026-10-03 校准 补录）

| 目录（文件数） | 主要文件 | 一句话职责 | 文档归属建议 |
|---------------|---------|-----------|-------------|
| `EventBus/`（4） | `eventBus.ts`、`eventRouter.ts`、`eventTypes.ts`、`index.ts` | 内存事件总线（发布-订阅、事件溯源，Docs/Agent/07 §4.2）+ 按事件类型/优先级路由（§4/§08）+ **事件类型注册表**（全系统事件名唯一定义处，§4.3） | **应增设独立章节**（全局横切契约，被 Hook/LoopControl/Arbitration/SharedMemory 与 Interface 层消费） |
| `Recruitment/`（2） | `recruiter.ts`、`terminationRationale.ts` | Agent 招募与终止理由；两文件即文首"Core 直连 3 文件"中的 2 个 | 应增设章节（分层裁定焦点） |
| `ReviewerAgent/`（2） | `reviewerAgent.ts`、`index.ts` | 审核 Agent（Docs/Agent/13 §S9）——Maker-Checker 模式的 Checker 实例 | 应增设章节（与 Core `agentRuntime.reviewSubmission` 往返） |
| `SharedMemory/`（10） | `globalWorkspace.ts`、`longTermMemory.ts`、`longTermMemoryStore.ts`、`memoryEntryStore.ts`、`memoryConsolidator.ts`、`writeGuard.ts`、`workspaceLock.ts`、`versionedEntry.ts`、`causalTokens.ts`、`index.ts` | 共享记忆系统（Docs/Agent/07）：全局工作区 + 长期记忆 + SQLite 持久化层 + 写入守卫/版本冲突 + 工作区锁（READ/WRITE/EXCLUSIVE）+ 因果令牌（happens-before，供仲裁重建因果链） | 应增设独立章节（体量与横切性均高于现有多数小节） |
| `Audit/`（4） | `resourceAuditBureau.ts`、`anomalyDetector.ts`、`freezeManager.ts`、`patrolScheduler.ts` | 资源审计局（Docs/Agent/06 §2）：异常检测三规则（滚动窗口超限/偏离均值/循环检测）→ 冻结/解冻记录 → 定期全量巡检 | 应增设章节（⚠️ `freezeManager` 用**自有** `freezeRecords: Map`，未调用 §4.1 的 `walletManager.freezeWallet/confiscate`，"冻结即扣币"尚未打通） |
| `Regulation/`（4） | `regulatoryAuthority.ts`、`behaviorCode.ts`、`broadcastChannel.ts`、`finalArbiter.ts` | 监管局（Docs/Agent/06 §1）：行为准则加载发布 → 全局广播通道（规则更新/紧急警报/仲裁死锁）→ 最终裁决器（仲裁庭死锁时介入） | 应增设章节（§5 仲裁死锁的下游） |
| `Cache/`（3） | `promptCache.ts`、`toolResultCache.ts`、`index.ts` | Prompt Cache 管理（Docs/Agent/02 §5.1）+ 工具结果缓存（仅缓存 `idempotency='YES'` 的结果） | 建议增设（缓存命中语义影响 Context §3 前缀哈希契约） |
| `Retrieval/`（3） | `retriever.ts`、`reranker.ts`、`index.ts` | 检索器（从共享记忆/外部源检索上下文片段，Docs/Agent/02 §3）+ 重排器（交叉编码器或启发式二次排序） | 建议增设（与 Context §3 装配互为上下游） |
| `LoopScheduler/`（4） | `scheduler.ts`、`dedupStore.ts`、`circuitBreaker.ts`、`index.ts` | Loop 调度器（Docs/Agent/13 §S8）：去重 + 熔断防事件风暴（60s 内重复 100 次触发，只启动 1 个 Loop） | 建议增设（§1 LoopControl 的调度侧对偶） |
| `Pipeline/`（4） | `commandPipeline.ts`、`dataPipeline.ts`、`eventPipeline.ts`、`index.ts` | 命令/数据/事件三类标准化管道（解析、验证、执行；事件路由过滤分发） | 建议增设 |
| `Session/`（3） | `sessionManager.ts`、`archiveManager.ts`、`index.ts` | 会话生命周期管理 + 会话/循环归档存储 | 建议增设（消费点为启动装配：`Src/main.ts:34` 导入 `initSessionManager`、:35 导入 `initArchiveManager`） |
| `Planning/`（1） | `todoStore.ts` | Agent 计划清单（TODO）存储，**按来源 agent 归属**（多 agent / 部分平级） | 建议增设（跨端消费：`IpcBridge/ipcBridge.ts:21` 与 `RestApi/chatApi.ts:22` 导入 `listTodosBySession`/`listAllTodos`/`clearTodos`） |
| `AccountScope/`（1） | `activeAccount.ts` | **账号数据命名空间**（个人数据隔离的单一真源） | 建议增设（跨端消费：`RestApi/chatApi.ts:20`、`RestApi/syncApi.ts:21`、`EventStore/aiEventStore.ts:21` 导入 `getActiveOwner`） |

---

## 修订记录

| 日期 | 说明 |
|------|------|
| 2026-09-22 | 文档-代码对账校准：§4 TokenEconomy 三行按 `walletManager.ts`（debit :96 / credit :130 / verifyConservation :258）、`tokenLedger.ts`（appendTransaction :20 / verifyLedgerConservation :48 / summarizeTrace :69）、`dualBudget.ts`（detectPhase :52 / checkTraceBudget :112）重写，原 `budgetGuard.ts` / `conservationVerifier.ts` / `checkBudgetPhase()` 均不存在；§5 Arbitration 三虚构名更正为 `fileCase` / `assignArbitrators` / `createPlan`+`executePlan`；§1 四处签名（`runVerifierPipeline` / `computeFingerprint` / `detectFingerprintAction` / `selectNextStrategy`）按代码修正；文首依赖方向记现状+待办（Services→Tools 仅 1 处 import，直连 Core 2 处，违反分层裁定，须代码侧修复）；新增"未收录模块清单"9 项。 |
| 2026-10-03 | 按《Agent-16-开发规范接口契约-差别清单》Services 层条目（S-01～S-17）逐条复核后回写，文档一律向当前代码看齐：**文首**——Core 直连由 2 处改为 **3 个文件**（新增 `Recruitment/terminationRationale.ts`），区分值导入 2 文件 + 纯类型导入 1 文件；待办状态更新为 ⚠️ 未开始 / 已改由门禁豁免（`.eslintrc.json` 已为 `Services←Core` 开 `except:["AgentRuntime","Decision"]` 白名单，复测 0 error；Core 门面 `Src/Core/index.ts` 已具备但未被采用）→ **【需人工裁定】**；`Services→Tools` 仅 1 处（`toolSafetyGate.ts` `getTool`）复查仍成立；另登记**反向越层**现状（`Tools/Custom/agentRecruiter.ts:20/21` → `Services/Recruitment/recruiter.js` + `Core/AgentRuntime/types.js`，`npx eslint` 实测 2 error，属 CI 阻断）为 **【需人工裁定】** 现状+待办，口径交由 toolsInterfaces.md 侧同类裁定项统一。**§1**——`createApproval` 补第二参 `defaultTimeoutSec = 60`；`runVerifierPipeline` :43→:44；`detectBudgetPhase` :206→:207（`BudgetPhase` :205），同名易混警告保留加粗；新增 §1.1 LoopControl 中间件族（`middleware/` 5 控制模块 + `approvalPersistence.ts`）与 §1.2 其余导出（`setActiveStopRuleSet` 由启动侧 `main.ts:44/298/317` 写入、`getActiveStopRuleSet` 由 `Core/Loop/runIteration.ts:20/712` 读取）。**§2**——三行复查通过，补 `runPreSupervision` 第二参默认值。**§3**——`scoreAllEntries` 由单参补为三参（`now`、`config` 均有默认值）；补 `computeCachePrefixHash`、`partitions/` 与 `scoring/` 其余导出、`contextStore.ts`。**§4**——`walletManager` 与 `tokenLedger` 六处行号 +1 修正（debit :97 / credit :131 / verifyConservation :259 / appendTransaction :21 / verifyLedgerConservation :49 / summarizeTrace :70），`dualBudget` :52 / :112 复查精确；"不存在"三项复查仍成立；新增 §4.1 其余导出（跨层消费：`createWallet`←`agentFactory.ts:9`、`getTransactions`←`tokenApi.ts:8`；⚠️ `checkBalance`/`freezeWallet`/`unfreezeWallet`/`confiscate` 经回查在 `Src/` 内**无调用点**，登记为未接线，`Audit/freezeManager` 另用自有 `freezeRecords`，"冻结即扣币"未打通）。**§5**——五处行号 +1 修正（`fileCase` :35、`assembleCapsule` :40、tribunal 同名封装 :82、`assignArbitrators` :71、`createPlan` :23 / `executePlan` :61）；新增 §5.1 其余导出并把全流程入口 `executeFullArbitration` 提至表首；现场恢复双入口（tribunal 与 restorationManager 各持私有状态 Map、互不调用，`restorationManager` 仅测试消费）登记为 **【需人工裁定】**；三虚构名复查仍不复活。**§6**——`dispatchHook` 补 async/`Promise<HookDispatchResult>`（同步写法会拿到 pending Promise）；补 `registerHookHandlers`/`getAllHookHandlers`/`clearHookHandlers`/`getHookHandlerCount` 与 `HOOK_EVENTS` 的 `interceptable`/`defaultFailBehavior` 治理表（9 事件复查 ✓）。**未收录模块清单**——由 9 项扩容为 A（9 项复查 ✓）+ B（13 个整体未登记目录，含 EventBus/SharedMemory/Recruitment/Audit/Regulation 等），并标注 19 子目录 / 99 `.ts` 文件实际接口面。**锚点策略**——全文主锚由绝对行号改为"文件名 + 函数/符号名"，行号降为辅助（本轮漂移主因是文件头部注释增行）。 |
