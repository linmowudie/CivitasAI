# Agent/02 核心架构设计 — 文档-代码差别清单

> 审查日期 2026-10-03 · 文档路径 `Docs/Agent/02-核心架构/核心架构设计.md` · 审查基准：当前工作区代码（含未提交改动，`Src/` 五层 + `Src/main.ts` + `Configs/*.json`）

## 摘要

| 分类 | 条数 |
|---|---|
| 【文档过时】代码已变、文档未跟 | 23 |
| 【声明错误】文档声称存在/会发生，代码没有 | 13 |
| 【代码未实现】纯目标态（仅列状态有变化者） | 2 |
| 【需人工裁定】语义冲突 / 口径不一致 | 5（含 D-35 双重标注） |
| **合计** | **43** |

**总体判断**：五层骨架、十步主循环枚举与 `decideIteration` 五类退出序、LoopConfig 7 字段、Hook 事件表、上下文四级系数等**结构性声明与代码高度一致**（2026-09-22/23 校准条目大部分仍成立）；主要脱节集中在三处——**§4.4 中间件清单的钩子/优先级/注册数与 `main.ts` 实际注册项已全面漂移**（RateLimiter 已实现并注册、FingerprintDetector 实际挂 `afterModel`、启动注册 4 件而非 3 件），**§5/§11 所述的"上下文装配 + Hook 生命周期"在生产路径上仍是单点落地**（十步中④⑤为桩、六钩子只派发 5 个、9 个 Hook 事件只派发 1 个），以及**§6 状态机"枚举三处同形"的 DB 一侧完全未接通**（`agents`/`loops` 表建了但全仓零 INSERT/UPDATE，`loopEngine.ts` 另有一套 5 值 phase）。§12 的"TS 硬编码 ROLE_OVERRIDES 双源漂移"技术债已在代码中消除，文档仍标注为待办。

## 差别清单

| 编号 | 文档章节 | 文档声明 | 代码实态(文件:行) | 分类 | 建议处理 |
|---|---|---|---|---|---|
| D-01 | §4.4 引言注 / §7.1 ⑬ | "启动仅注册 3 件（GoalReanchor / FingerprintDetector / BudgetSentinel）" | `Src/main.ts:237-240` 注册 **4** 件：第 4 件为 `rateLimiterMiddleware` | 文档过时 | 步骤 ⑬ 与 §4.4 注改为"4 件"，补 RateLimiter 行 |
| D-02 | §4.4 引言注 | `Core/Middleware/builtin/` "实际存在 4 件" | 实际 5 个实现文件：`Src/Core/Middleware/builtin/rateLimiter.ts:117-120` 已存在（另 `builtin/index.ts`） | 文档过时 | 改为"实际存在 5 件" |
| D-03 | §4.4 表 | `wrapToolCall / RateLimiter / 优先级 30 / **未实现**` | 已实现且随启动注册：`Src/Core/Middleware/builtin/rateLimiter.ts:117-120`（hook=wrapToolCall、priority=30，与规划完全一致）+ `Src/main.ts:40,240` | 文档过时（文档滞后） | 状态列改 ✅ 已注册 |
| D-04 | §4.4 表 | GoalReanchor `beforeModel / priority 20` | `Src/Core/Middleware/builtin/goalReanchor.ts:12-15`：priority=**10**（注释自述"最先执行"） | 文档过时 | 数值改 10；或注明 Services 侧 GoalReanchorControl(5) 才是"最先" |
| D-05 | §4.4 表 | ActionFingerprintDetector 挂 **beforeModel / 40** | `Src/Core/Middleware/builtin/fingerprintDetector.ts:23-26`：挂 **afterModel / priority 10**（它消费模型输出算指纹） | 文档过时 | 钩子列改 `afterModel`，优先级改 10 |
| D-06 | §4.4 表 | BudgetSentinel `wrapModelCall / priority 10` | `Src/Core/Middleware/builtin/budgetSentinel.ts:17-20`：priority=**50** | 文档过时 | 数值改 50 |
| D-07 | §4.4 表 | ApprovalGate `wrapToolCall / priority 10`（以 toolSafetyGate 实现） | `Src/Services/LoopControl/middleware/toolSafetyGate.ts:78-81`：name=`ToolSafetyGate`、wrapToolCall、priority=**1**（"先于其他 wrap 中间件"） | 文档过时 | 优先级改 1，名称对齐 `ToolSafetyGate` |
| D-08 | §4.4 表 | StopRuleEvaluator 挂 **afterModel / 50** | `Src/Services/LoopControl/middleware/stopRuleEvaluator.ts:28-31`：挂 **afterAgent / priority 1** | 文档过时 | 钩子与优先级均按代码改写 |
| D-09 | §4.4 表 | CheckpointWriter `afterAgent / 60` | `Src/Services/LoopControl/middleware/checkpointWriter.ts:42-45`：priority=**50** | 文档过时 | 数值改 50 |
| D-10 | §4.4 引言注 | "StopRuleEvaluator / CheckpointWriter / **ToolSafetyGate** 等以控制件形态实现，**并非注册进 Core 中间件表的实例**" | ToolSafetyGate **确实注册进 Core 注册表**（Loop 实例级）：`Src/Core/Loop/runIteration.ts:720` `registerMiddleware(safetyGate)`、`:821` `unregisterMiddleware('ToolSafetyGate')` | 文档过时 | 注中把 ToolSafetyGate 移出"未注册"名单，说明为 per-loop 注册 |
| D-11 | §4.4 表 | 表内无 FailureInjector 行（§13 又把它列为挂载点） | `Src/Core/Middleware/builtin/failureInjector.ts:25-28`：wrapToolCall / priority 100，未随启动注册 | 文档过时 | 表中补一行（测试用，未注册） |
| D-12 | §12 ⚠️ 已知技术债 | "`loopConfig.ts:63-72` 另有一份硬编码 `ROLE_OVERRIDES`，`createRoleLoopConfig()` 实际读的是 TS 常量，两份数值已漂移（prime_director 50/200_000/0.2、arbitrator 15/60_000）" | 已消除：`Src/Core/Loop/loopConfig.ts:83-127` 只有注入式 `_roleOverrides`（未注入即报 unknown role），`:63-72` 现为 `validateLoopConfig`；`Src/main.ts:305-315` 从 `Configs/loopConfig.json → roleOverrides` 注入；JSON 值 prime_director=100/500000/0.3、arbitrator=5/50000（`Configs/loopConfig.json:16-25`） | 文档过时 | 删除该 ⚠️ 注，改为"已由 main.ts 注入 JSON，硬编码双源已消除" |
| D-13 | §10.4 | 多 Provider 配置示例：`directorModel`/`workerModel`/`verifierModel`/`arbitrationModels`/`reasoningSandwich` 与 `providers` **同级（顶层）** | 实际嵌套在 `routing` 段：`Configs/modelRouter.json:39-53`；读取侧 `Src/main.ts:196` `getConfigValueOr(config,'routing')`、`:214-224`；`reasoningSandwich` 才在顶层（`:54`） | 文档过时 | 示例 JSON 改嵌套结构，并补 `defaultModel`/`fallbackOrder`/`timeoutMs`/`firstByteTimeoutMs`/`interChunkTimeoutMs` 键 |
| D-14 | §10.4 尾注 | "任何 model 缺 `context_window` 拒注（**启动 ⑫** 会失败）" | 校验在 Provider 构造器：`Src/Infra/Llm/Provider/providerBase.ts:144-148`；`Src/main.ts:211` 对单个 Provider `catch` 后**继续启动**，只有全部失败（`:225` `providerCount===0`）才终止。且 LLM 通道在文档自身编号中是 **⑪** | 文档过时 | 措辞改"该 Provider 跳过注册；仅当无任何 Provider 时启动失败（步骤 ⑪）" |
| D-15 | §7.1 ⑦.5 注 | "⚠️ AUTO_RESUME 入队未实现（`getHumanRequiredPlans` **已导入未使用**）" | `Src/main.ts:28` 已不再导入 `getHumanRequiredPlans`（仅 `scanAndProposeRecovery`，`:179`）；`getAutoResumePlans` 亦无生产调用者（`Src/Infra/DurableExecution/recoveryScanner.ts:96-104`） | 文档过时 | 删去"已导入未使用"细节，保留"AUTO_RESUME 未入队" |
| D-16 | §7.1 ⑱ | "…`startIpcBridge()`；见 `Src/main.ts:296-307`" | 实际 `Src/main.ts:351-362`（HTTP 启动 `:358`、IPC `:361`） | 文档过时 | 行号更新 |
| D-17 | §3.2 校准注(2026-09-22) | "`runIteration.ts:290` 调 `getVisibleToolsForRole`" | 调用点在 `Src/Core/Loop/runIteration.ts:370`；`toolFactory.ts:75-86` 规则（requiredRoles 命中 ∪ L0 非 FORBIDDEN 全可见）仍与文档一致 | 文档过时 | 仅更新行号，规则描述保留 |
| D-18 | §7.1 表（声称"编号①–⑱与代码注释一一对应"） | 18 行步骤 | 代码另有 5 个带编号注释的步骤未入表：⓪ `.env` 加载（`Src/main.ts:60-65`）、⑦.1 审批残留清理 `expireStaleApprovals()`（`:148-150`）、⑦.2 长时记忆回灌（`:157-165`）、⑰.2 AI 事件持久化（`:347-349`）、④ 段内的工具安全门配置 `configureToolSafetyGate`（`:113-120`）+ ⑬ 段内三层限流初始化（`:242-259`） | 文档过时 | 表格补 ⓪/⑦.1/⑦.2/⑰.2，并在 ④/⑬ 说明中补安全门与限流装配 |
| D-19 | §7.2 表（关闭 9 步） | 9 步，无持久执行清理 | 代码在 ⑦ 与 ⑧ 之间插入 **⑦.5 `purgeExpired()`**（过期幂等缓存清理）：`Src/main.ts:422-431` | 文档过时 | 表补一行，或把它并入 ⑦ |
| D-20 | §2 目录树 | 目录清单 | 代码存在但文档未列：`Src/Services/{AccountScope,LoopScheduler,Planning,Recruitment,ReviewerAgent}/`、`Src/Interface/EventStore/`、`Src/Core/Middleware/toolCallClassifier.ts`、`Src/Core/Model/{contextHistory.ts,sessionNamer.ts}`、`Src/Tools/Builtin/Plan/`、`Src/Services/LoopControl/{approvalPersistence.ts,types.ts}`、`Src/Infra/{Db/Repositories,Hook/System}`、`Configs/dataStorage.json`、`Data/{Hooks,db,workspaces}` | 文档过时 | 目录树补齐；`Data/Auth/` 见 D-21 |
| D-21 | §2 目录树 / §1.1 | `Data/` 含 `Auth/`（硬禁访问） | `Data/` 实际无 `Auth/` 目录；仅 `Configs/security.json`/`main.ts:102,108` 以 `forbiddenPaths: ['Data/Auth/']` 形式引用（白名单默认值仍成立） | 文档过时 | 注明"目录尚未创建，仅作禁用路径声明" |
| D-22 | §2 目录树 | `Core/Middleware/hooks/`（空预留目录） | 不存在：`Src/Core/Middleware/` 仅 `index.ts`、`middlewareRegistry.ts`、`toolCallClassifier.ts`、`builtin/` | 文档过时 | 删掉该预留行（Git 不保留空目录） |
| D-23 | §2 命名规范 §2.1 | "文件一律 camelCase" | `Src/Infra/DurableExecution/schemas/{Checkpoint.ts,EffectRecord.ts,RecoveryPlan.ts}` 为 PascalCase | 文档过时 | 命名例外清单补一条（schema 文件与导出类型同名） |
| D-24 | §1.2 表 / §2 目录树 | "每层对外暴露的类型定义必须写在 `Src/{LayerName}/types.ts`"，树中 Interface/Core/Services/Tools 各列 `types.ts` | 只有 `Src/Infra/types.ts` 存在；`Src/Core`、`Src/Services`、`Src/Tools`、`Src/Interface` 均无层根 types.ts（实际类型散在 `Core/AgentRuntime/types.ts`、`Core/Decision/types.ts`、`Services/LoopControl/types.ts`、`Services/TokenEconomy/types.ts`、`Services/Arbitration/types.ts`、`Tools/Traits/toolSpec.ts`） | 声明错误 | 规则改为"就近模块 types.ts"，或补建层根再导出文件 |
| D-25 | §4.1 / §4.2 | 六钩子全部生效；`afterAgent` 在"⑩ 完成之后"触发（✗ 不可短路） | `afterAgent` **从未被派发**：`Src/Core/Loop/runIteration.ts` 只调 `executePrePostHooks` 派发 beforeAgent、beforeModel、afterModel 三钩（`:345,:356,:509`）与 `executeWrapHooks` 派发 wrapModelCall、wrapToolCall 两钩（`:455,:484,:545`）；故 afterAgent 类控制件（StopRuleEvaluator/CheckpointWriter）在生产永不执行 | 声明错误 | §4.1 标注 ⚠️ "afterAgent 派发点未接入 executeLoop" |
| D-26 | §3 ⑧ / §11.1 | "⑧ 工具执行前触发 Hook `PreToolExecute`（可拦截）" | 全仓唯一 `dispatchHook` 生产调用是 `UserInputReceived`：`Src/Core/Loop/runIteration.ts:303`；⑧ 段（`:523-594`）只走 `wrapToolCall`，无 Hook 派发 | 声明错误 | ⑧ 行加 ⚠️；或把 wrapToolCall 内的审批门说明为替代实现 |
| D-27 | §11.1 事件表 | 9 个 Hook 事件（触发时机列均给出生产时机） | 枚举与拦截/fail 语义完全一致（`Src/Services/Hook/hookRegistry.ts:12-33`：9 事件、`SessionStart` fail-closed、`PreToolExecute` fail-closed，其余 fail-open ✓），但 `SessionStart/PreToolExecute/PostToolExecute/ModelCallStart/ModelCallEnd/VerifierExecuted/ApprovalRequested/SessionEnd` **8 个无任何生产派发点** | 声明错误 | 表加"实现状态"列：仅 `UserInputReceived` 已接线 |
| D-28 | §11.2 | "执行引擎 `Infra/Hook/`（统一派发 + 超时 + 重试）；注册与调度 `Services/Hook/`" | 派发 + 超时 + fail-open/closed 实际在 **Services**（`Src/Services/Hook/hookRegistry.ts:87-141`）；`Src/Infra/Hook/hookExecutor.ts` 只提供一个 `executeHookWithRetry` 工具（默认 10s/1 次重试，`:10-32`），`main.ts:236` 仅 `initHookExecutor()`，未被 Hook 派发路径使用 | 声明错误 | 按代码改写职责切分（或注明 ADR 待办：把派发下沉 Infra） |
| D-29 | §10.2 尾 | "重试耗尽后…写入 `FailureFeedback(category='external')`，交给 ⑩ 判定" | 无任何生产写入：`buildFailureFeedback` 零调用者（定义 `Src/Services/LoopControl/failureFeedback.ts:70`，仅 `LoopControl/index.ts:63` 再导出）；模型失败在 `runIteration.ts:476-481,499` 直接以 `exitReason:'risk'` 短路 | 声明错误 | 改标 ⚠️ 未实现，或把当前"风险退出"行为写入文档 |
| D-30 | §10.3 | "流式必须支持中途取消（AbortSignal），**取消时也写 EffectJournal**" | `Src/Core/Model/abortSignal.ts` 文件头宣称"流式取消时写 EffectJournal 的桥接"（`:7`），但全文件无 `recordIntent`/`updateEffectStatus` 调用；取消仅传播 abort（`:37-59`） | 声明错误 | 桥接标注 ⚠️；或从 §10.3 移除该硬约束 |
| D-31 | §8 表 | "磁盘配额超限 → 按清理优先级依次淘汰，不阻断业务" | `Src/Infra/Fs/quotaManager.ts` 仅有 `setQuota/canWrite/recordUsage/getUsage/scanDirectorySize/syncUsage/clearQuotas`（`:50-149`），**无淘汰/优先级清理 API** | 声明错误 | 改标 ⚠️ 未实现（当前 `canWrite` 返回 false 即拒绝写入） |
| D-32 | §3 ② | 前置监管内容含"**权限验证**" | 权限验证为桩：`Src/Services/Supervision/preSupervision.ts:91` `// 权限验证（桩：后续接入 RBAC）` 恒返回 `permissionOk:true`；注入检测与频率限制已实现（`:55-90`） | 声明错误 | 该行补 ⚠️（与④⑤同款标注） |
| D-33 | §3.2 递归派发特有约束 | "⑩ 需额外检测互相回传死锁，命中直接触发风险退出" | `detectDeadlock` 已实现（`Src/Services/Supervision/loopSupervision.ts:75`）但**无生产调用者**（仅 `Tests/Runtime/runtime.spec.ts:317,322`）；`runIteration` ⑩ 段（`:613-676`）不含死锁检测 | 声明错误 | 标注 ⚠️ 未接入主循环 |
| D-34 | §6.1 转换表 | 律师函 `SUSPEND_AND_NOTIFY` → `suspended`；`RESTORATION_ACK` → `running`；"任意 → destroyed"；"expelled →(RECRUIT) creating" | 状态机表支持这些转换（`Src/Core/AgentRuntime/stateMachine.ts:16-41`），但 `SUSPEND`/`RESTORE`/`DESTROY`/`RECRUIT`/`INIT_COMPLETE` **均无生产事件派发点**（全仓仅 `EXPEL`（`Services/Recruitment/recruiter.ts:107-109`）、`TASK_ASSIGNED`/`TASK_COMPLETED`（`Core/AgentRuntime/agentRuntime.ts:105,210`））；`RESTORATION_ACK` 只是 EventBus 事件（`Services/Arbitration/restorationManager.ts:84-86`），不驱动状态机；另外 `creating` 态**没有** DESTROY 转换，与"任意→destroyed"不符；`creating→ready` 由工厂直接赋值绕过状态机（`Core/AgentRuntime/agentFactory.ts:56-58`） | 声明错误 | 表加"实现状态"列；"任意"改"ready/running/suspended/expelled" |
| D-35 | §6 表 + §3 表首行 | `loops.phase` 6 值 `planning/acting/verifying/awaiting_approval/completed/failed`；"loopEngine.ts = LoopPhase/步骤枚举定义" | 存在**三套** LoopPhase：①文档口径 6 值（`Core/AgentRuntime/types.ts:21-27`、`Services/LoopControl/types.ts:37-42`）②`Core/Loop/loopEngine.ts:13` 另一套 **5 值 `idle/running/paused/completed/failed`**，且后者才是主循环真正使用的（`startLoop/pauseLoop/terminateLoop/failLoop` `:58-80`）；`planning` 仅在 `Services/LoopControl/loopState.ts:220` 初始值出现，`acting/verifying/awaiting_approval` **无任何赋值点**（审批门不改 phase：`Services/LoopControl/approvalGate.ts` 全文无 phase 写入） | 文档过时 + 需人工裁定（见 D-41） | §6 说明"运行时 phase 由 loopEngine 5 值驱动，6 值规范态尚未接线" |
| D-36 | §5.3 红线 | "LoopState 必须独立持久化到 `Data/Loops/{session_key}/state.json`" | 无任何持久化：`Services/LoopControl/loopState.ts` 无 DB/文件写入（导出仅 `cloneImmutableZone/setGoalImmutable/verifyGoalIntegrity/hashGoal/createInitialLoopState`，`:155-212`），文件头反称"持久化真源唯一为 SQLite（loops.goal_json/state_json）"（`:8`）；`loops` 表也从未写入（见 D-40）；仅 `Infra/Workspace/workspaceManager.ts:32` 预留 `Data/Loops/{session_key}` 目录概念 | 声明错误 | 需先裁定真源（文件 vs SQLite），再改文档并落地 |
| D-37 | §5.4 | "压缩后必须触发 `GoalReanchorMiddleware`（下轮开头）" | 标记生产/消费链断裂：压缩侧写 `needsGoalReanchor`（`Services/Context/truncation.ts:114`），但 `truncation`/`assembleContext` 无生产调用者（`runIteration.ts:400` 仍为 TODO 降级桩），中间件侧读的是 `MiddlewareContext.data`（`Core/Middleware/builtin/goalReanchor.ts:19`），二者从未串联；另一读点 `Services/LoopControl/middleware/goalReanchorControl.ts:49` 未注册 | 声明错误 | 与 §3 ④ 的 ⚠️ 合并说明"链路未通" |
| D-38 | §12 注 | "`DEFAULT_LOOP_CONFIG` 默认值**来自** `Configs/loopConfig.json → loopDefaults`（唯一事实源）" | `DEFAULT_LOOP_CONFIG` 是 TS 字面量：`Src/Core/Loop/loopConfig.ts:20-27`；main.ts 只从 `loopDefaults` 取 `token_budget`（`Src/main.ts:285,336`），`model/timeout_ms/temperature/stream/max_iterations` 不回灌 | 需人工裁定 | 明确"当前两处数值相同但来源独立"，或改造为启动注入 |
| D-39 | §12 | `pauseSignal?: AbortController` 为"v2 强制补充（仅供审批门/暂停信号使用）"（关联 ADR-0001） | 字段存在（`Src/Core/Loop/loopConfig.ts:17`）但**零消费者**（全仓无 `pauseSignal` 引用）；审批门用自身超时机制（`Services/LoopControl/middleware/toolSafetyGate.ts:141,211` + `approvalGate.ts:45` 默认 60s） | 代码未实现 | 标注 ⚠️ 字段已定义未接线（审批门尚未消费中止信号） |
| D-40 | §6 "枚举三处同形" / §7.1 ⑥-⑦.5 | 枚举同形于 DB 列 `agents.status`/`loops.phase`/`loops.stopped_reason` | DB 侧只建表不落数据：`Src/Infra/Db/migrations.ts:66-78`（agents）、`:141-154`（loops）；全仓 **0 处 INSERT/UPDATE agents/loops**；Agent 态只在内存 `agentRegistry`（`:38-59`）；连锁后果：`recoveryScanner.ts:70-73` `SELECT … FROM loops WHERE phase NOT IN ('completed','failed')` 恒返回空 → 启动 ⑦.5 崩溃恢复实际 no-op；`createCheckpoint`（`Infra/DurableExecution/checkpointStore.ts:36`）亦无生产调用者，checkpoint 只进进程内 Map（`Services/LoopControl/middleware/checkpointWriter.ts:34`） | 代码未实现（状态变化：影响面从"AUTO_RESUME 未入队"扩大到"整个恢复链 no-op"） | 文档 §7.1 ⑦.5 与 §5.3 需合并标注；排期把 loops/agents 落库 |
| D-41 | §6 表 vs `Core/Loop/loopEngine.ts:13` | 文档以 6 值为唯一规范态 | 代码同时存在 5 值运行态与 6 值规范态，且 `runIteration`/`ipcBridge` 使用 5 值版本；两文件同名导出 `LoopPhase`（`Core/AgentRuntime/types.ts`、`Services/LoopControl/types.ts`）无 re-export 关系 | 需人工裁定 | 裁定"运行时 phase"与"持久化 phase"是否同一列；若不同一，文档需分列两态 |
| D-42 | §1.1 表 / §2.2 表 | "Services **绝对不可**引用 Core"、CI 必须拒绝 `Services → Core` | ESLint zone 带例外：`.eslintrc.json` `{ target: ./Src/Services, from: ./Src/Core, except: ["AgentRuntime","Decision"] }`；并有真实导入 `Src/Services/Recruitment/recruiter.ts:9-13`、`Src/Services/ReviewerAgent/reviewerAgent.ts:9-12` | 需人工裁定 | 文档补记例外清单（或将相关类型契约迁入 `Infra/Contracts`，沿 ADR-0006 思路） |
| D-43 | §1.1 表 / §2.2 表 | Interface 禁止依赖 Tools/Infra；Tools 禁止依赖 Services | Interface 直连下层：`Src/Interface/RestApi/toolsApi.ts:9`（→Tools）、7 个文件直 import `../../Infra/...`；Tools→Services 违规仍在工作区并**使 lint 报错**：`Src/Tools/Builtin/Plan/todoWriter.ts:15`（`npx eslint` 输出 1 error "Tools 层不可依赖上层"） | 需人工裁定 | ①文档 §2.2 补"现存违规"清单；②修复 todoWriter 违规（或下沉 todoStore） |

### 未列条目说明（纯目标态、状态无变化）

§3 ④ 上下文装配降级桩、§3 ⑤ 四项懒监管未接入（`runIteration.ts:402-407`；`Services/Supervision/{compress,summary,reasoning,loop}Supervision.ts` 四者零生产调用者）、§7.1 ⑦.5 AUTO_RESUME 入队、§7.1 ⑭ 完整环境自检、§7.1 "启动总时限 ≤60s"、§7.2 ②③④ 桩、§4.4 其余"未实现"条目（SessionBootstrap / InjectionGuard / ReasoningSandwichRouter / IdempotencyGuard 中间件化 / OutputSafetyFilter / TraceReporter）——经核实**代码确仍未实现**，文档 ⚠️/未实现标注仍准确，不计入差异。

## 未发现差异的抽查项

**分层与骨架**
- 五层目录名与层序完全一致：`Src/{Interface,Core,Services,Tools,Infra}`；`Infra` 实际 16 件 + `Contracts`（`Fs/Db/Terminal/Logging/Time/Llm/Slm/Embedding/Hook/Config/Sandbox/Security/Watcher/Workspace/Env/DurableExecution`）与文档逐一对应，无多余目录。
- `Src/Services/Supervision/` 六模块齐全（pre/compress/summary/reasoning/loop/post），`Services/Context/partitions/`、`Infra/DurableExecution/` 五文件（effectJournal/checkpointStore/recoveryScanner/recoveryExecutor/idempotencyStore）、`Skills/{strategies,rubrics,rules,playbooks}`、`ADR/0001..0006` 六篇文件名全部对得上；`Configs/` 无 `.toml` 混用。
- `Src/Interface/WebSocket/*.ts` 确已删除（`git status` 显示 D，目录仅剩 `.gitkeep`），入口为 `Src/Interface/IpcBridge/ipcBridge.ts`；原校准注"入口无角色校验"仍成立（`ipcBridge.ts:95` 硬编码 `role:'prime_director'`，无入站角色校验）。

**主循环**
- 十步枚举字符串与顺序逐字一致：`Core/Loop/loopEngine.ts:27-31` 与 `:98-114 assertStepOrder`（① InputReceived … ⑩ IterationDecision）。
- ⑩ 五类退出评估序与文档"风险→预算→上限→成功→无进展"完全一致：`Core/Loop/iterationController.ts:47-73`；"有文本输出且无工具调用 → success"判定在位（`:63-67`），即 493b005 修复后仍对齐。
- ① `UserInputReceived` Hook 可拦截短路（`runIteration.ts:303-316`）、② 前置监管（`:321-339`）、⑥ 流式/非流式均包 `wrapModelCall`（`:455,:484`）、⑧ 包 `wrapToolCall`（`:545`）、⑨ 调 `runPostSupervision`（`:599`）均落地。
- 工具可见性规则文本一致：`Tools/Factory/toolFactory.ts:75-86`（requiredRoles 命中 ∪ L0 非 FORBIDDEN 全可见）；`isToolAllowed` 矩阵仍只被非主循环路径消费。

**中间件契约**
- §4.2 接口定义逐字段一致：`Infra/Contracts/middlewareTypes.ts:87-98`（name/hook/priority/canShortCircuit/execute 单钩子字段 + `HookFunction` 联合类型 `:77-84`）；`Core/Middleware/types.ts` 确已删除；分派函数名 `executePrePostHooks`/`executeWrapHooks`（洋葱组合 `middlewareRegistry.ts:111-130`）与文档一致。

**LoopConfig**
- 7 字段名与 snake_case 全一致：`Core/Loop/loopConfig.ts:10-18`；`DEFAULT_LOOP_CONFIG` 数值（30/60_000/0.2/100_000/true/`workerModel`）与 `Configs/loopConfig.json → loopDefaults` 逐项相同。
- 硬上限默认（`LOOP_LIMITS` 200/2_000_000/600_000/最小 5_000，`:39-44`）与 JSON `hardLimits` 一致，且由 `main.ts:276-281` 注入；`timeout_ms` 确非整轮墙钟（墙钟 `maxWallClockMs=900000` 只在 `stopRules.limits`，`main.ts:292`）。
- §12 尾注"roleOverrides 未知键 → 启动失败并列出合法键"**已实现**：`Infra/Config/configValidator.ts:91-116` 校验键集与 `agents.role` 全集一一对应、且只允许 `max_iterations/token_budget/temperature`。
- `Configs/loopConfig.json → roleOverrides` 8 个角色键与文档表格完全对应。

**Hook 系统**
- 9 个事件名、可拦截性、fail-open/fail-closed 逐项一致：`Services/Hook/hookRegistry.ts:12-33`；超时默认 5s（`:73`）、fail-closed 命中即 intercepted（`:134-136`）。

**状态机 / DB**
- Agent 6 态名与 `agents.status` 默认值 `'creating'` 同形：`Core/AgentRuntime/types.ts:11-17` vs `Infra/Db/migrations.ts:72`；`StoppedReason` 7 值与文档逐字一致（`Services/LoopControl/types.ts:47-55`、`Core/AgentRuntime/types.ts:31-38`），并有 7→5 映射函数（`runIteration.ts:189-199`）。
- 合法转换主体（ready↔running、running→suspended/expelled、suspended→running、expelled→creating、→destroyed）与 §6.1 行一致：`stateMachine.ts:16-41`；`supervision.agentConsecutiveFailuresToExpel=3` 与文档默认值一致（`Configs/supervision.json:3`）。

**上下文与模型契约**
- 四级 S/L/M/H 预算上限 0.15/0.15/0.15/0.45 与分件系数 0.05/0.5/0.3/1.0 **两处**（代码 + JSON）一致：`Services/Context/partitions/partitions.ts:62-65` vs `Configs/loopConfig.json:75-79`；截断阈值 0.92 一致（`Services/Context/assembler.ts:73`、`truncation.ts:62,124`）；四段式追加写入的类型→分区映射齐备（`appendWriter.ts:21-36`）。
- 超时默认 60_000/10_000/15_000 一致：`main.ts:221-223`、`modelCaller.ts:53`、`streamParser.ts:57-58`；401/403→`auth`→不重试且返回 FATAL 级：`providerBase.ts:215-219`、`openaiProvider.ts:128,295`；§10.2 重试矩阵（429→1 次 5s 后降级、5xx/网络→2 次 1s+2s、503→1 次直接降级、Schema→1 次、内容安全禁止）逐项对齐 `retryPolicy.ts:21-76`。
- `context_window` 缺失拒注：`providerBase.ts:144-148`；EffectJournal 先写意图再执行（fail-closed）在 wrapToolCall 内：`Services/LoopControl/middleware/toolSafetyGate.ts:242-262`，幂等键同文件 `:17`。

---

## 回写记录（2026-10-03）

已逐条重新核实并回写 `Docs/Agent/02-核心架构/核心架构设计.md`：43 条全部处置——实质回写 39、代码已追平改写 2（D-12 ROLE_OVERRIDES 双源已消除、D-40 agents 半边已写透）、【需人工裁定】登记 5（D-36/38/41/42/43）、未处理 0。§14 追加 v3.1 校准行。
