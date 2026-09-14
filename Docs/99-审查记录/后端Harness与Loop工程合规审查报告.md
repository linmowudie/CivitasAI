# 后端 Harness 与 Loop 工程合规审查报告

> **审查基准**：agent-project-skill（source-code / code-gate / documentation / test-suite / security / logging-system / history / prompt-storage / data-storage / benchmark / benchmark-system / ci-cd / package-management / configuration）+ 项目自身 v2 设计（Docs/02 §3 十步主循环、Docs/12 LoopControl、Docs/13 DurableExecution、ADR-0001~0005）+ 记忆约束（Agent 主循环 10 步标准序列、五层单向依赖红线、架构变更后三轮真实 Agent 调用）。
>
> **审查范围**：`Src/`（后端全量）+ `Configs/` + `Prompts/` + `Skills/` + `Tests/` + `Docs/` + 项目根工程资产。
>
> **审查日期**：2026-09-14 · **版本**：v1.0

---

## 0. 执行摘要

| 维度 | 状态 | 关键结论 |
|------|------|---------|
| 五层单向依赖红线 | ✅ 合规 | ESLint `import/no-restricted-paths` 封死 Infra←Tools←Services←Core←Interface 四条反向依赖 |
| LoopConfig 七字段契约 | ✅ 合规 | `Core/Loop/loopConfig.ts` 强制校验 + 8 角色 ROLE_OVERRIDES |
| 十步序列类型与断言 | ✅ 合规 | `LoopStep` 枚举 + `assertStepOrder()` 存在 |
| **十步主循环执行器** | ❌ **严重缺失** | 无 `runIteration()`；`wsHandler.startStreamGeneration` 直接调 `callModelStream`，绕过 ②③④⑤⑦⑧⑨⑩ 八步 |
| 中间件六钩子注册表 | ✅ 合规 | `Core/Middleware` 完整（beforeAgent/beforeModel/wrapModelCall/wrapToolCall/afterModel/afterAgent） |
| **中间件管线消费** | ❌ **未挂接** | `executePrePostHooks` / `executeWrapHooks` 无任何主循环调用点；4 个内置中间件仅注册未消费 |
| 上下文四级分区 S/L/M/H | ✅ 合规 | `Services/Context` 完整（partitions/scoring/assembler/truncation/appendWriter） |
| **上下文装配消费** | ❌ **未挂接** | `assembleContext()` 无调用方；LLM 调用仍传原始 `chatMessages` |
| 监管六模块 | ✅ 合规 | `Services/Supervision` 六文件齐全 |
| **监管六模块消费** | ❌ **未挂接** | 六个 `runXxxSupervision()` 无主循环调用点 |
| LoopControl（StopRules/Verifier/ApprovalGate/Fingerprint/StrategyLedger/FailureFeedback） | ✅ 合规 | `Services/LoopControl` 完整，ADR-0003/0004/0005 落地 |
| **LoopControl 五中间件消费** | ❌ **未挂接** | GoalReanchorControl / FingerprintDetectorControl / BudgetSentinelControl / StopRuleEvaluator / CheckpointWriter 未注入主循环 |
| DurableExecution（EffectJournal/Checkpoint/Idempotency/Recovery） | ✅ 合规 | `Infra/DurableExecution` 完整，DUR-001~006 全覆盖 |
| **EffectJournal 与工具层联动** | ❌ **未联动** | `Tools/Builtin/Write` 与 `Execute` 未走 `recordIntent → EXECUTING → SUCCEEDED/FAILED` 生命周期 |
| Maker-Checker 硬分离 | ✅ 合规 | `submitForReview` / `reviewSubmission` / `ReviewerAgent` 落地，verifierModel ≠ producerModel |
| Agent 状态机 6 态 | ✅ 合规 | `Core/AgentRuntime/stateMachine.ts` 合法转换表完整 |
| 仲裁六步治理闭环 | ✅ 合规 | `Services/Arbitration` 完整（立案→胶囊→裁决→律师函→恢复→沉淀） |
| Token 经济双预算 | ✅ 合规 | `Services/TokenEconomy` 完整（四档 warm/soft/expand/hard + 守恒验证） |
| Hook 系统 9 事件 | ✅ 合规 | `Services/Hook` + `Infra/Hook` 完整（拦截/fail-open/fail-closed） |
| 输入去重五道防护 | ✅ 合规 | `Interface/InputDeduplication/dedupMiddleware` |
| 配置全量默认值（14 个 JSON） | ✅ 合规 | 空配置可直接启动 |
| ADR 五篇 | ✅ 合规 | 0001~0005 齐全 |
| 测试覆盖（26 spec / 609 项） | ✅ 合规 | 单元 + 集成 + E2E + 故障注入 + 真实 Agent 调用 |
| **Prompts/ 提示词外置** | ❌ **空目录** | `roles/` `system/` `tasks/` `versions/` 全部仅 `.gitkeep` |
| **Skills/ 策略与 Rubric** | ❌ **空目录** | `playbooks/` `rubrics/` `rules/` `strategies/` 全部仅 `.gitkeep`；Verifier L3 校准集缺失 |
| **CI/CD 流水线** | ❌ **缺失** | 无 `.github/workflows/`、无 `.husky/`、无 CODEOWNERS、无 PR 模板 |
| **接口文档（层间契约）** | ❌ **缺失** | 无 `Docs/03-开发规范/Interfaces/{层}Interfaces.md`（记忆 0e73ceeb 强制要求） |
| **使用指南 / 部署运维文档** | ❌ **缺失** | 无 `Docs/04-使用指南/`、无 `Docs/05-部署运维/`、无 `quickStart.md` |
| **README.md / LICENSE / .gitattributes / .env.example** | ❌ **缺失** | 项目根四件基础资产均未建立 |
| **install.sh / install.ps1 一键安装脚本** | ❌ **缺失** | `Scripts/` 仅有构建/诊断脚本 |
| **关闭序列 9 步** | ⚠️ **部分** | SIGINT 仅停 HTTP/WS/Logger，缺 ②中断模型 ③后置监管 ④追踪索引 ⑤会话归档 ⑦沙箱销毁 ⑧DB 关闭 |
| **启动 14 步序号** | ⚠️ **跳号** | main.ts 注释 ①②③④⑥⑦⑦.5⑫⑬⑭⑮⑯⑰⑲，跳过 ⑤⑧⑨⑩⑪⑱ |
| **工具危险级别 ↔ ApprovalGate 联动** | ❌ **未联动** | DANGEROUS + IRREVERSIBLE 工具（shell.exec / code.eval / agent.recruit）未强制走审批门 |

**总体判断**：后端 **设计层已达 Loop Engineering L2 完备**（Docs/12 + Docs/13 + ADR-0001~0005），**实现层各子系统模块齐全且单元测试通过**，但 **主循环执行器缺位** 导致所有监管/中间件/上下文装配/LoopControl 控制中间件/DurableExecution 联动 **形同孤岛**——当前 `wsHandler` 走的是一条"裸调 LLM"的旁路，未经过任何 Harness 工程约束。

**成熟度定位**：**L1.5 实现 / L2 设计**（与设计审查报告 v1.0 结论一致，但代码侧仍未跨越 L1.5 → L2 分水岭）。

---

## 1. LOOP 工程合规审查

### 1.1 十步主循环（Docs/02 §3 / 记忆 c59c1ab7）

| 步骤 | 设计要求 | 实现状态 | 证据 |
|------|---------|---------|------|
| ① 输入接收 | Interface → Core | ⚠️ 部分 | `wsHandler.handleClientMessage` 接收 `generate_reply` 帧，但未转交 Core/Loop |
| ② 前置监管 | `Services/Supervision.preSupervision` | ❌ 未挂接 | `runPreSupervision()` 无调用方 |
| ③ 中间件管线 | `Core/Middleware.executePrePostHooks('beforeAgent')` | ❌ 未挂接 | `executePrePostHooks` 无调用方 |
| ④ 上下文组装 | `Services/Context.assembler.assembleContext` | ❌ 未挂接 | `assembleContext()` 无调用方；`wsHandler` 直接传 `chatMessages` |
| ⑤ 监管懒监听 | compress/summary/reasoning/loop 四监管 | ❌ 未挂接 | 四个 `runXxxSupervision()` 无调用方 |
| ⑥ 模型调用 | `Core/Model.modelCaller.callModelStream` | ✅ 已实现 | `wsHandler` 调用，含超时/重试/降级 |
| ⑦ 输出解析 | `Core/Decision` 解析文本/工具调用/混合 | ❌ 未实现 | 无 `parseModelOutput()` 函数 |
| ⑧ 工具执行 | `Tools/Factory` 按危险分级管控 | ⚠️ 部分 | 工具已注册，但无主循环调用入口；未走 EffectJournal |
| ⑨ 后置监管 | `Services/Supervision.postSupervision` | ❌ 未挂接 | `runPostSupervision()` 无调用方 |
| ⑩ 迭代判定 | `Core/Loop.iterationController.decideIteration` | ⚠️ 部分 | 函数存在，但无主循环调用 |

**核心缺陷**：`Src/Core/Loop/loopEngine.ts` 仅提供 **状态管理原语**（createLoopState / startLoop / pauseLoop / resumeLoop / terminateLoop / failLoop / recordLoopEvent / assertStepOrder），**没有实际执行十步序列的 `runIteration()` 或 `executeLoop()` 函数**。

**影响**：
- 五大失效模式（无限循环 / 目标漂移 / 上下文退化 / 静默失败 / Token 爆炸）的防护机制全部失效
- Verifier 四级、StopRules 五类退出、ActionFingerprint、GoalReanchor、ApprovalGate 均无法在运行时触发
- 记忆 aa6cb969 要求的"架构变更后三轮真实 Agent 调用测试"无法验证完整链路

### 1.2 Verifier 四级分层（Docs/12 §3 / ADR-0003）

| 层级 | 实现 | 状态 |
|------|------|------|
| L1 硬验证（test/schema/numeric/http/file_exists） | `verifier/hardVerifier.ts` | ✅ |
| L2 规则验证（rule/golden） | `verifier/ruleVerifier.ts` | ✅ |
| L3 LLM Judge（rubric + minScore + requireEvidence） | `verifier/llmJudge.ts` | ✅ |
| L4 人类审批门 | `verifier/humanGateCore.ts` | ✅ |
| 反博弈防御 | `verifier/antiGaming.ts` | ✅ |
| 编排器（L1→L2→L3→L4 不可跨越） | `verifier/index.ts runVerifierPipeline` | ✅ |
| **Rubric 校准集（50 条人工标注）** | `Skills/rubrics/` | ❌ **空目录** |
| **主循环调用 Verifier** | — | ❌ **未挂接** |

### 1.3 Stop Rules 五类独立退出（Docs/12 §2）

| 退出条件 | 实现 | 状态 |
|---------|------|------|
| ① 成功（successCriteria 全通过） | `stopRules.ts` | ✅ |
| ② 上限（maxIterations / maxWallClockMs / maxToolCalls / maxConsecutiveErrors） | `stopRules.ts` | ✅ |
| ③ 硬预算（softTokens / hardTokens / warmTokens / expandRequestTokens） | `stopRules.ts` | ✅ |
| ④ 无进展（stagnationWindow + minDelta） | `stopRules.ts` | ✅ |
| ⑤ 风险（riskTriggers） | `stopRules.ts` | ✅ |
| 判定优先级（risk > limits > budget_hard > no_progress > success） | `EVALUATION_ORDER` | ✅ |
| **主循环调用 evaluateStopRules** | — | ❌ **未挂接** |

### 1.4 LoopState 不可变区（ADR-0005）

| 要求 | 实现 | 状态 |
|------|------|------|
| goal / immutableConstraints 不可被压缩/摘要修改 | `loopState.ts setGoalImmutable / verifyGoalIntegrity` | ✅ |
| 持久化真源唯一为 SQLite | `loops.goal_json / loops.state_json` | ✅ |
| **主循环每轮校验 goal 完整性** | — | ❌ **未挂接** |

---

## 2. Harness 工程合规审查

### 2.1 中间件六钩子（Docs/02 §4 / skill source-code.md）

| 钩子 | 类型定义 | 注册表 | 内置中间件 | 主循环消费 |
|------|---------|--------|-----------|-----------|
| beforeAgent | ✅ | ✅ | — | ❌ |
| beforeModel | ✅ | ✅ | — | ❌ |
| wrapModelCall | ✅ | ✅ | — | ❌ |
| wrapToolCall | ✅ | ✅ | — | ❌ |
| afterModel | ✅ | ✅ | budgetSentinel / goalReanchor / fingerprintDetector | ❌ |
| afterAgent | ✅ | ✅ | — | ❌ |

**核心缺陷**：`middlewareRegistry.executePrePostHooks` 与 `executeWrapHooks` 已实现洋葱模型，但 **无任何主循环调用点**。`main.ts` 仅 `registerMiddleware()` 注册三个内置中间件，注册后从未被消费。

### 2.2 Hook 系统（Docs/02 §11 / skill source-code.md）

| 事件 | 可拦截 | 实现 | 状态 |
|------|--------|------|------|
| SessionStart | 否 | `hookRegistry.ts` | ✅ |
| UserInputReceived | **是** | `hookRegistry.ts` | ✅ |
| PreModelCall / PostModelCall | 否 | `hookRegistry.ts` | ✅ |
| PreToolExecute | **是** | `hookRegistry.ts` | ✅ |
| PostToolExecute | 否 | `hookRegistry.ts` | ✅ |
| PreCompression / PostCompression | 否 | `hookRegistry.ts` | ✅ |
| SessionEnd | 否 | `hookRegistry.ts` | ✅ |
| OnError | 否 | `hookRegistry.ts` | ✅ |
| **系统 Hook 实现** | — | `Infra/Hook/System/` | ❌ **目录不存在** |
| **用户 Hook 加载** | — | `Data/Hooks/` | ❌ **目录不存在** |

### 2.3 工具层危险分级 ↔ ApprovalGate 联动（Docs/11 §6.3）

| 工具 | dangerLevel | idempotency | reversibility | 强制审批 | 状态 |
|------|------------|-------------|---------------|---------|------|
| shell.exec | DANGEROUS | NO | IRREVERSIBLE | 应强制 | ❌ 未联动 |
| code.eval | DANGEROUS | NO | IRREVERSIBLE | 应强制 | ❌ 未联动 |
| agent.recruit | DANGEROUS | NO | IRREVERSIBLE | 应强制 | ❌ 未联动 |
| file.write | CONTROLLED | NO | REVERSIBLE | 应走 EffectJournal | ❌ 未联动 |
| file.edit | CONTROLLED | NO | REVERSIBLE | 应走 EffectJournal | ❌ 未联动 |

**核心缺陷**：`Tools/Traits/specValidator.ts` 仅"标记但不阻断"，注释明示"L4 HumanGate 在 S6 的 approvalGate 中强制"——但 S6 已交付，联动仍未实现。

---

## 3. Durable Execution 合规审查（Docs/13）

| 组件 | 实现 | 主循环/工具层联动 |
|------|------|------------------|
| EffectJournal（INTENT→EXECUTING→SUCCEEDED/FAILED/UNKNOWN） | ✅ `effectJournal.ts` | ❌ 工具层未调用 `recordIntent` |
| CheckpointStore（DB 事务原子写入） | ✅ `checkpointStore.ts` | ❌ 主循环未定期写 Checkpoint |
| IdempotencyStore（SHA-256 幂等键） | ✅ `idempotencyStore.ts` | ❌ 工具层未生成幂等键 |
| RecoveryScanner（启动扫描四分支裁决） | ✅ `recoveryScanner.ts` | ✅ `main.ts ⑦.5` 调用 `scanAndProposeRecovery()` |
| RecoveryExecutor（从 Checkpoint 恢复） | ✅ `recoveryExecutor.ts` | ⚠️ 仅测试调用 |
| **关闭序列 ⑤ Checkpoint 强制 flush** | — | ❌ SIGINT 未调用 |

---

## 4. agent-project-skill 清单缺失项

### 4.1 prompt-storage.md（提示词外置）

| 要求 | 当前状态 |
|------|---------|
| `Prompts/roles/{role}.md` 8 角色提示词 | ❌ 空目录 |
| `Prompts/system/` 系统提示词 | ❌ 空目录 |
| `Prompts/tasks/` 任务提示词 | ❌ 空目录 |
| `Prompts/versions/` 版本化 | ❌ 空目录 |
| 热加载机制 | ❌ 未实现 |

### 4.2 benchmark.md / benchmark-system.md

| 要求 | 当前状态 |
|------|---------|
| `Benchmarks/baselines/metrics.json` 六维基线 | ✅ 已登记（582 项测试 / 六维评分） |
| `Benchmarks/datasets/sampleTasks.json` 数据集 | ⚠️ 仅 4 个任务，schema 不完整 |
| **Verifier L3 Rubric 校准集（50 条人工标注）** | ❌ `Skills/rubrics/` 空 |
| **策略候选集** | ❌ `Skills/strategies/` 空 |
| **Playbooks / Rules** | ❌ `Skills/playbooks/` `Skills/rules/` 空 |
| 劣化告警阈值 | ❌ 未配置 |

### 4.3 code-gate.md / ci-cd.md

| 要求 | 当前状态 |
|------|---------|
| `.github/workflows/ci.yml` | ❌ 不存在 |
| `.husky/pre-commit` / `pre-push` | ❌ 不存在 |
| `commitlint` 配置 | ❌ 不存在 |
| `CODEOWNERS` | ❌ 不存在 |
| `.github/pull_request_template.md` | ❌ 不存在 |
| 覆盖率基线 `Configs/coverageBaseline.json` | ✅ 80% |
| 依赖安全扫描（npm audit / snyk） | ❌ 未配置 |

### 4.4 documentation.md

| 要求 | 当前状态 |
|------|---------|
| `Docs/01-需求与规划/` | ❌ 当前为 `Docs/01-系统概览/`（命名偏离） |
| `Docs/02-设计方案/Architecture + DataFlow + Decisions` | ⚠️ 当前为 `Docs/02-核心架构/`（命名偏离，无 DataFlow 子目录） |
| **`Docs/03-开发规范/Interfaces/{层}Interfaces.md`** | ❌ **完全缺失**（记忆 0e73ceeb 强制要求） |
| `Docs/03-开发规范/codingStandards.md` | ❌ 缺失 |
| **`Docs/04-使用指南/quickStart.md`** | ❌ **完全缺失** |
| `Docs/04-使用指南/fullGuide.md` / `configuration.md` / `toolDevelopment.md` / `troubleshooting.md` | ❌ 缺失 |
| **`Docs/05-部署运维/Deployment/`** | ❌ **完全缺失** |
| `Docs/05-部署运维/Runbooks/` | ❌ 缺失 |
| `Docs/CHANGELOG.md` | ✅ 完整（v1→v2→S0~S14→F0~F6→P1） |
| **ADR 目录位置** | ⚠️ 当前在项目根 `ADR/`，skill 要求 `Docs/02-设计方案/Decisions/` |

### 4.5 项目根基础资产

| 文件 | 当前状态 | 影响 |
|------|---------|------|
| `README.md` | ❌ 缺失 | GitHub 默认展示页空白，新人无入口 |
| `LICENSE` | ❌ 缺失 | 法律状态不明 |
| `.gitattributes` | ❌ 缺失 | 跨平台换行符策略未定义（skill 要求 LF 统一） |
| `.env.example` | ❌ 缺失 | `modelRouter.json` 引用 `env:HUAWEI_MAAS_API_KEY`，新人不知需配何变量 |
| `CONTRIBUTING.md` | ❌ 缺失 | 协作规范未声明 |
| `Scripts/install.sh` / `install.ps1` | ❌ 缺失 | 一键安装脚本未提供 |

### 4.6 data-storage.md

| 要求 | 当前状态 |
|------|---------|
| `Data/` 七类目录（Cache/Decisions/Loops/Operations/Sessions/Workspace/db） | ✅ 齐全 |
| **`Data/Hooks/{HookName}/` 用户 Hook 目录** | ❌ 缺失 |
| **`Data/Auth/credentials.enc` 加密密钥存储** | ❌ 缺失（当前仅 env 引用） |
| 配额仲裁与清理优先级 | ⚠️ `quotaManager.ts` 存在，但清理策略未配置化 |

### 4.7 logging-system.md / history.md

| 要求 | 当前状态 |
|------|---------|
| 双轨日志（business + system） | ✅ `Infra/Logging` |
| `trace_id` UUID v4 / `operation_id` `{ts}-{4hex}` / `session_key` SHA-256 前 16 位 | ✅ 三 ID 语义一致 |
| JSON Lines + 文件轮转 | ✅ |
| AsyncLocalStorage trace 上下文 | ✅ |
| **会话/操作/决策三类历史归档闭环** | ⚠️ `Session/archiveManager.ts` 存在，但操作历史与决策历史归档未完整 |

---

## 5. 启动 / 关闭序列审查

### 5.1 启动 14 步（Docs/02 §7.1 / skill source-code.md）

| 顺序 | 组件 | main.ts 实际 | 状态 |
|------|------|-------------|------|
| ① | 配置系统 | ✅ `loadConfig()` | ✅ |
| ② | 日志系统 | ✅ `initLogger()` | ✅ |
| ③ | 时间系统 | ✅ `Time.onDrift()` | ✅ |
| ④ | 安全系统 | ✅ `initTrustLevels/Whitelist/PathGuard` | ✅ |
| ⑤ | 文件系统 | ❌ **跳过** | ❌ |
| ⑥ | 数据库 | ✅ `initDatabase/Migrations/migrateUp` | ✅ |
| ⑦ | 工作空间管理 | ✅ `initWorkspace` | ✅ |
| ⑦.5 | 持久执行底座 | ✅ `initEffectJournal/IdempotencyStore/RecoveryScanner` | ✅ |
| ⑧ | 沙箱系统 | ❌ **跳过** | ❌ |
| ⑨ | 配置热加载注册 | ⚠️ `initConfigWatcher` 在 ⑰ 才调 | ⚠️ 顺序错 |
| ⑩ | 提示词加载 | ❌ **跳过**（Prompts/ 空） | ❌ |
| ⑪ | 工具注册 | ✅ `registerBuiltinTools` | ✅ |
| ⑫ | 监听系统 / 事件总线 | ✅ `initEventBus` | ✅ |
| ⑬ | LLM/SLM/Embedding 客户端 | ✅ `registerProvider/setRoutingConfig` | ✅ |
| ⑭ | 环境激活自检 | ❌ **跳过** | ❌ |

**问题**：main.ts 注释序号 ①②③④⑥⑦⑦.5⑫⑬⑭⑮⑯⑰⑲ 跳号严重，⑤⑧⑨⑩⑪⑱ 缺失或错位。

### 5.2 关闭 9 步（skill source-code.md）

| 顺序 | 动作 | SIGINT 实际 | 状态 |
|------|------|------------|------|
| ① | 停止接收新输入 | ❌ | ❌ |
| ② | 中断当前模型调用（关闭流） | ❌ | ❌ |
| ③ | 触发后置监管（保存/备份/同步） | ❌ | ❌ |
| ④ | 生成追踪索引文件（≤5s） | ❌ | ❌ |
| ⑤ | 归档活跃会话 | ❌ | ❌ |
| ⑥ | flush 日志队列 | ✅ `shutdownLogger()` | ✅ |
| ⑦ | 销毁沙箱 | ❌ | ❌ |
| ⑧ | 关闭数据库连接 | ❌ | ❌ |
| ⑨ | 退出进程 | ✅ `process.exit(0)` | ✅ |

**问题**：关闭序列 9 步仅实现 2 步，活跃会话/模型流/沙箱/DB 连接均无优雅关闭。

---

## 6. 修复优先级与建议

### P0（阻断性，必须立即修复）

1. **实现主循环执行器 `Src/Core/Loop/runIteration.ts`**
   - 严格按十步序列组合：InputReceived → PreSupervision → Middleware(beforeAgent/beforeModel) → ContextAssembly → LazySupervision → ModelCall(wrapModelCall) → OutputParse → ToolExecute(wrapToolCall) → PostSupervision → IterationDecision
   - 每步发布 `LoopEvent`，供 `assertStepOrder` 校验
   - 每轮末尾调用 `evaluateStopRules` + `verifyGoalIntegrity`
   - 每轮写 Checkpoint（`checkpointWriterMiddleware`）

2. **将 `wsHandler.startStreamGeneration` 改为调用主循环执行器**
   - 禁止裸调 `callModelStream`
   - 流式 chunk 通过 `AGENT_STREAM_CHUNK` 事件透传，但上下文/监管/中间件必须走完整链路

3. **工具层接入 EffectJournal + ApprovalGate**
   - `wrapToolCall` 中间件强制：DANGEROUS + IRREVERSIBLE → ApprovalGate；CONTROLLED → EffectJournal.recordIntent
   - 工具执行前生成 `idempotencyKey`，查 IdempotencyStore

### P1（高优先级，本迭代内完成）

4. **填充 `Prompts/` 与 `Skills/`**
   - `Prompts/roles/{prime_director,partner,worker,reviewer,assembly_node,arbitrator,auditor,regulator}.md` 8 角色
   - `Prompts/system/` 系统提示词（含 Reasoning Sandwich 结构）
   - `Skills/rubrics/` Verifier L3 校准集（≥50 条人工标注）
   - `Skills/strategies/` 策略候选集（供 StrategyLedger.selectNextStrategy）
   - `Skills/playbooks/` + `Skills/rules/`

5. **建立 CI/CD 与代码门禁**
   - `.github/workflows/ci.yml`：lint + typecheck + test + coverage + build
   - `.husky/pre-commit`：prettier + eslint + tsc --noEmit + gitleaks
   - `.husky/pre-push`：vitest run + 接口文档比对
   - `commitlint.config.js`：强制 Conventional Commits
   - `CODEOWNERS`：Core/Infra 需 2 人 Review

6. **补齐接口文档 `Docs/03-开发规范/Interfaces/`**
   - `coreInterfaces.md` / `servicesInterfaces.md` / `toolsInterfaces.md` / `infraInterfaces.md` / `interfaceInterfaces.md`
   - 每模块：签名 / 参数 / 返回值 / 异常 / 下级关联 / 被调用方

7. **补齐使用指南与部署运维文档**
   - `Docs/04-使用指南/quickStart.md`（5 分钟跑起来）
   - `Docs/04-使用指南/fullGuide.md` / `configuration.md` / `troubleshooting.md`
   - `Docs/05-部署运维/Deployment/{local,docker,windows}.md`
   - `Docs/05-部署运维/Runbooks/{healthCheck,logAnalysis,commonIssues,rollback}.md`

### P2（中优先级，下一迭代完成）

8. **项目根基础资产**
   - `README.md`（项目简介 + 快速开始 + 架构概览 + 文档索引）
   - `LICENSE`（建议 Apache-2.0 或 MIT）
   - `.gitattributes`（`* text=auto eol=lf`）
   - `.env.example`（列出所有 `env:XXX` 引用）
   - `CONTRIBUTING.md`
   - `Scripts/install.ps1` + `Scripts/install.sh`

9. **关闭序列 9 步完整实现**
   - `main.ts` SIGINT handler 扩展：停输入 → abort 模型流 → 后置监管 → 追踪索引 → 会话归档 → flush 日志 → 销毁沙箱 → 关 DB → exit

10. **启动 14 步序号对齐**
    - 补 ⑤文件系统 / ⑧沙箱 / ⑩提示词加载 / ⑭环境自检
    - ⑨配置热加载移至 ⑦ 之后

11. **Hook 系统落地**
    - `Infra/Hook/System/` 内置 Hook（审计/备份/指标采集）
    - `Data/Hooks/` 用户 Hook 目录 + 沙箱执行 + 声明 schema 校验

12. **Benchmarks 数据集扩充**
    - `sampleTasks.json` 扩至 ≥20 任务，覆盖 6 种路由模式
    - 登记劣化告警阈值（`Configs/benchBaseline.json` 补 `degradationThreshold`）

### P3（低优先级，长期演进）

13. **Docs 目录结构对齐 skill 规范**
    - 重命名 `01-系统概览` → `01-需求与规划`
    - `02-核心架构` → `02-设计方案/Architecture`
    - ADR 移至 `Docs/02-设计方案/Decisions/`

14. **配额仲裁配置化**
    - `Configs/dataStorage.json` 登记七类数据保留期与清理优先级

15. **操作历史与决策历史归档闭环**
    - `Services/Session/archiveManager` 扩展至操作/决策两类

---

## 7. 架构变更验证要求（记忆 aa6cb969）

完成 P0 修复后，**必须进行至少三轮真实 Agent 调用测试**：

| 轮次 | 场景 | 验证点 |
|------|------|--------|
| Round 1 | 单 Agent 编码任务 | 十步序列完整执行 + Verifier L1/L2 通过 + Token 守恒 |
| Round 2 | 多 Agent 协作（Director + Worker + Reviewer） | Maker-Checker 分离 + submitForReview + 审批门 |
| Round 3 | 故障注入（崩溃恢复 + 副作用回滚） | EffectJournal UNKNOWN 裁决 + Checkpoint 恢复 + 幂等键去重 |

---

## 8. 结论

Civitas-AI 后端 **设计层已达 Loop Engineering L2 完备**，**实现层各子系统模块齐全且单元测试通过（609 项）**，但 **主循环执行器缺位** 是当前最严重的合规缺陷——它导致所有监管/中间件/上下文装配/LoopControl/DurableExecution 联动形同孤岛。

**跨越 L1.5 → L2 分水岭的唯一路径**：实现 `runIteration()` 十步执行器，并将 `wsHandler` 旁路改造为主循环入口。在此之前，任何新增子系统都只会加剧"模块齐全但链路断裂"的矛盾。

**建议立即启动 P0 修复**，并在修复完成后按记忆 aa6cb969 执行三轮真实 Agent 调用测试，方可视为 S9 M1 里程碑的真正达成。

---

> 审查人：Qoder · 审查方法：静态代码分析 + 设计文档比对 + skill 清单核对 + 记忆约束校验
