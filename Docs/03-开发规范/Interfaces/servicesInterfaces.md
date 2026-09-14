# Services 层接口文档

> Services 层：业务逻辑编排，消费 Core 层原语组合。
> 依赖方向：Services → Tools → Infra

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
| `verifier/index.ts` | `runVerifierPipeline(spec, ctx) → VerifierResult` | L1→L2→L3→L4 管线 |
| `actionFingerprint.ts` | `computeFingerprint(input) → string` | 计算动作指纹 |
| `actionFingerprint.ts` | `detectFingerprintAction(state, fp) → FingerprintAction` | 检测重复 |
| `strategyLedger.ts` | `selectNextStrategy() → TurnStrategy` | 选择下一轮策略 |
| `failureFeedback.ts` | `buildFailureFeedback(input) → FailureFeedback` | 构建失败反馈 |
| `approvalGate.ts` | `createApproval(input) → Result<PendingApproval>` | 创建审批请求 |
| `approvalGate.ts` | `decideApproval(input) → Result<PendingApproval>` | 审批决策 |
| `middleware/toolSafetyGate.ts` | `createToolSafetyGateMiddleware(...) → AgentMiddleware` | 工具安全门（P0-3） |

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
| `tokenLedger.ts` | `debit/credit` | Token 收支记账 |
| `budgetGuard.ts` | `checkBudgetPhase()` | 四档预算阶段检测 |
| `conservationVerifier.ts` | `verifyConservation()` | 守恒验证 |

---

## 5. Arbitration (`Src/Services/Arbitration/`)

| 子模块 | 核心函数 | 说明 |
|--------|---------|------|
| `tribunal.ts` | `initiateCase()` | 立案 |
| `capsuleAssembler.ts` | `assembleCapsule()` | 胶囊组装 |
| `arbitratorPool.ts` | `selectArbitrators()` | 仲裁者选取 |
| `restorationManager.ts` | `restoreScene()` | 现场恢复 |

---

## 6. Hook (`Src/Services/Hook/`)

| 子模块 | 核心函数 | 说明 |
|--------|---------|------|
| `hookRegistry.ts` | `dispatchHook(event, data) → HookDispatchResult` | 事件分发（9 事件） |
| `hookRegistry.ts` | `registerHookHandler(handler) → Result<void>` | 注册处理器 |
