# Agent/01 系统设计总览 — 文档-代码差别清单

> 审查日期 2026-10-03 · 文档路径 `Docs/Agent/01-系统概览/系统设计总览.md` · 审查基准：当前工作区代码（含未提交改动，`git status` 计 365 项改动；`Src/Tools/Custom/agentRecruiter.ts` 等于 2026-10-03 20:56 被改写）
>
> 分类口径：【文档过时】代码已变文档未跟 ·【代码未实现】纯目标态仍未实现（文档未标注或标注已失效）·【声明错误】文档声称存在但代码没有 ·【需人工裁定】语义冲突/状态高估

## 摘要

| 分类 | 条数 |
|------|------|
| 文档过时 | 14 |
| 代码未实现 | 3 |
| 声明错误 | 6 |
| 需人工裁定 | 5 |
| **合计** | **28** |

总体判断：本文档作为"顶层锚点"的**结构层**（角色信任分级、7 种工作方式、路由阈值、Token 分润权重、四级 Verifier、LoopConfig 键、§6 文档索引路径）与代码高度一致，抽查 26 项全部命中；但**执行链层**已明显落后于代码三轮修复（493b005/69df683/af9adfc + 工作区未提交改动）：2026-09-22 校准注中的多条"桩/未实现"判定已被代码推翻（`agent.recruit` 已接线、WebSocket 入口已删除），同时文档中十余条未标注状态的机制描述（3-LLM 多数决、1 次 LLM 复杂度评估、配置热更新、UNABLE_TO_COMPLETE、死锁监管升级、session_key 格式）在代码里其实并不成立。最严重的问题是**多 Agent 执行闭环缺失却被标注为"✅ 已接线"**（编排器只招募登记、不驱动子 Agent 主循环）与**§8 两条不可让渡红线在代码中反向实现**（历史数据写入失败静默丢弃、危险确认可被 `autoApprove` 白名单跳过）。

## 差别清单

| 编号 | 文档章节 | 文档声明 | 代码实态(文件:行) | 分类 | 建议处理 |
|---|---|---|---|---|---|
| D-01 | §3.2 校准注（2026-09-22） | "`agent.recruit` 的 execute 为 `NOT_IMPLEMENTED` 桩，任何角色都实际不可用（审批链不通）" | 桩已替换为真实实现：`Src/Tools/Custom/agentRecruiter.ts:78-152`（角色/预算/迭代校验 → `recruitAgent()` → 约束落库 → 返回 `dispatch:'pending'`）；`requiredRoles:['prime_director','partner']` 仍在 `:73`；DANGEROUS 审批链经 `Src/Services/LoopControl/middleware/toolSafetyGate.ts:130-240` 走通 | 文档过时 | 改写该注：Partner 可招募且工具已接线；保留"派发执行仍未实现"的诚实边界（见 D-05） |
| D-02 | §3.2 校准注 | "`SubTask.requiredTools` 最小权限无消费者" | 已有登记侧消费者：`Src/Services/Recruitment/recruiter.ts:59`（→ `allowedTools`）→ `Src/Infra/Db/Repositories/agentRepository.ts:87` 落库；但执行期校验函数 `Src/Infra/Security/whitelist.ts:102 isToolAllowedForRole` 全仓 0 调用，工具执行仍只按 `requiredRoles ∪ L0 兜底`（`Src/Tools/Factory/toolFactory.ts:75-84`） | 文档过时 | 表述改为"落库已消费、执行闸未接"，并在 Docs/Agent/10 §3.3.1 同步 |
| D-03 | §3.2 校准注 | "WS/HTTP 入口无任何角色校验" | WebSocket 入口整体移除：`Src/Interface/WebSocket/wsGateway.ts / wsHandler.ts / wsServer.ts` 在工作区均为删除状态（目录仅剩 `.gitkeep`）；现入口为 IPC + REST，且 IPC 直接硬编码 `agentRole:'prime_director'`（`Src/Interface/IpcBridge/ipcBridge.ts:810`）；配置残留 `server.wsPort:3001`（`Configs/default.json`，仅 `Src/Infra/Config/configValidator.ts:52` 校验） | 文档过时 | 删除 "WS" 措辞，改为"IPC/REST 入口无角色校验（IPC 固定以 PD 身份运行）" |
| D-04 | §3.1 角色定义表 | RG / AU "系统启动时创建，全局唯一"；AR "仲裁触发时动态组建"；AL "Assembly Line 模式预设" | 实际被 `createAgent` 实例化的角色仅 `prime_director`/`partner`/`worker`/`reviewer`（`Src/Core/Decision/orchestrator/orchestrator.ts:117,144,173,224,252,281`、`Src/Interface/IpcBridge/ipcBridge.ts:95`、`agentRecruiter.ts:132`）；`Src/main.ts` 启动 18 步中无治理角色实例化；`regulator/auditor/arbitrator` 不在任何 `requiredRoles`；仲裁者是内存模拟（`Src/Services/Arbitration/arbitratorPool.ts:6`） | 代码未实现 | 表内"实例化方式/生命周期"两列逐项加 ⚠️ 目标态标注，并说明治理三权当前以 Services 单例存在、非 Agent 实例 |
| D-05 | §2.4 T6 差异表 + §4.1 实现状态列 | "主循环形态 = 编排层循环 + Worker 内层循环"；四种模式"✅ S10 已接线" | 编排层无循环、子 Agent 无内层循环：`executeLoop` 唯一生产调用是 IPC 的 PD 链路（`Src/Interface/IpcBridge/ipcBridge.ts:903`）；编排器招募后仅登记 `status:'assigned'` 即返回 success（`orchestrator.ts:173-186,251-256,300-306`），`agentRecruiter.ts:145` 明确 `dispatch:'pending'`；前端选择的 workingMode 被后端丢弃（`ipcBridge.ts:737 _workingMode` 未使用） | 需人工裁定 | 把"✅ 已接线"降格为"✅ 路由可达 / ❌ 子 Agent 执行未接线"，并同步 §2.4 |
| D-06 | §4.1 表格 ASSEMBLY_LINE 行 | 参与角色 "AL 节点序列" | 流水线节点用 `role:'worker'` 创建（`orchestrator.ts:252`），`assembly_node` 角色全仓仅在类型/配置/白名单出现，无实例化路径 | 文档过时 | 注明当前以 worker 冒充 AL 节点，`assembly_node` 待接线 |
| D-07 | §4.2 Director 评估流程 | "接收用户需求 → 1 次 LLM 调用生成结构化评估报告" | 无 LLM 调用：`Src/Core/Decision/complexityAssessor/complexityAssessor.ts:5`（"Phase 0-2：基于启发式规则评估"）、`:49` 关键词+长度估算、`:89` `assessorModel:'heuristic-v1'`；SOP 匹配为硬编码 4 条模板（`:27-32`） | 声明错误 | 改为"启发式规则评估（LLM 评估为 Phase 后续）"，或按 Docs/Agent/03 §3.2 补 ⚠️ |
| D-08 | §4.2 引注 | "阈值全部写入 `Configs/routingRules.json`，可热更新" | 决策读的是模块内默认常量（`Src/Core/Decision/routeDecision/routingRules.ts:14-21`），`updateRoutingRules`（`:29`）全仓 0 调用；热更新底座为空实现——`Src/Infra/Watcher/configWatcher.ts:64 detectChanges()` 注释"仅记录快照，不实际扫描"，`startWatching()` 从未被调用（main.ts 仅 `initConfigWatcher`，`Src/main.ts:186`） | 声明错误 | "可热更新"改为"配置键已登记、运行期未消费（configWatcher 未启动）" |
| D-09 | §4.3 交付判定表 | "显式放弃 = Worker 返回 `UNABLE_TO_COMPLETE` 标记" | 全仓仅文档命中（`Src/`、`Client/src/`、`Server/src/`、`Prompts/`、`Skills/` 0 命中）；Worker 侧只有 `submitForReview`（`Src/Tools/Custom/submitForReview.ts`、`Src/Core/AgentRuntime/agentRuntime.ts:37`）与 `TerminationReason` 四值（`Src/Core/Decision/types.ts:182-187`） | 声明错误 | 用 `TerminationReason`（capability/laziness/goal_unreasonable/external_error）替换该标记，或标注未实现 |
| D-10 | §4.3 容错规则 | "连续 3 次失败 → 开除并重新招募。阈值可配" | 判定阈值硬编码：`Src/Core/Decision/orchestrator/progressTracker.ts:25 consecutiveFailureLimit:3`；`Configs/supervision.json` 的 `agentConsecutiveFailuresToExpel:3` 无任何 TS 消费者；`expelAgent/expelAndReplace`（`Src/Services/Recruitment/recruiter.ts:103,156`）无生产调用方 | 文档过时 | "阈值可配"改为"配置键存在但无消费者，实际取运行期常量"；补"开除链路未接线" |
| D-11 | §4.5 异常消耗检测表 | "循环检测：连续 3 次输出相似度 > 0.85" | 稽查侧为 5 轮且**不比相似度**：`Src/Services/Audit/anomalyDetector.ts:48 loopConsecutiveRounds:5`、`:142-151` 以"最近 5 指纹唯一数 ≤2"判循环，`loopSimilarityThreshold 0.85` 只作为告警 threshold 字段显示；`Configs/audit.json` 同为 5；另有一套 3 次阈值在 `progressTracker.ts:23-24` | 文档过时 | 拆成两条并给出各自文件/配置键（Audit 5 轮指纹 vs 编排 3 次相似），或修正为 5 |
| D-12 | §4.5 处置流程 | "触发 → 警告（日志）→ 二次触发 → 冻结 Agent + 通知 Director" | 无二次触发计数：critical 告警一步即冻结（`Src/Services/Audit/resourceAuditBureau.ts:82-87`），warning 不冻结；无"通知 Director"动作；且 `monitorAgent`（`:60`）在 `Src/` 内 0 调用（仅 Tests） | 文档过时 | 改写为"critical 即冻结（自动解冻 `audit.json freezeAutoUnfreezeSec=3600`）"，并标注稽查链路待接线 |
| D-13 | §4.6 死锁处理 | "自动升级至 Regulatory Authority → 单 LLM 强制裁决 + 记录为'监管干预' → 通知用户" | 函数存在但无生产调用方：`Src/Services/Regulation/regulatoryAuthority.ts:96 escalateDeadlock`、`finalArbiter.ts:37 issueFinalVerdict` 仅被 `Tests/E2E/*` 调用；`ARBITRATION_DEADLOCK` 事件（`Src/Services/EventBus/eventTypes.ts:57`）全仓 0 发布 0 订阅；`finalArbiter` 无 LLM 调用 | 代码未实现 | 补 ⚠️ 待接线（S12），并说明"单 LLM 强制裁决"未实现 |
| D-14 | §2.3 T6 信号 2 / §4.6 / §5 Phase 2 | "仲裁庭 3-LLM 多数决" | 规则裁决、非 3 LLM：`Src/Services/Arbitration/tribunal.ts:125`（"Phase 0-2：规则裁决；后续接 3-LLM 多数决"）、`:140-150` for 循环伪造 3 个同结论仲裁者；`Configs/modelRouter.json routing.arbitrationModels`（3 模型）仅被 `Src/Infra/Config/configValidator.ts:167-173` 校验长度，运行期无消费者（`Src/main.ts:226` 注入后无人读取） | 声明错误 | 全篇统一标注"L1 硬验证已实现；3-LLM 多数决为规则模拟，LLM 仲裁待接线" |
| D-15 | §4.8 裁决优先级协议 | 四级：时间戳 LWW → 任务权威性 → 证据链完整性 → LLM 语义兜底 | 仅 LWW 落地（`tribunal.ts:135`、`arbitratorPool.ts:109`）；`evidenceChain` 字段只在 `Src/Services/SharedMemory/versionedEntry.ts:33`、`globalWorkspace.ts:40` 存储，未参与裁决排序；权威性/LLM 兜底无实现 | 代码未实现 | 表内逐级加状态标注（LWW ✅ / 其余 ⚠️） |
| D-16 | §7 全局 ID 定义 | `session_key`：会话首次创建时生成，SHA-256 前 16 位十六进制 | 生成器无生产调用方（`Src/Infra/Workspace/sessionKeyGenerator.ts:46`，仅 `index.ts` 再导出 + `Tests/Infra/workspace.spec.ts`）；真实会话主键是 `sess-<uuid8>`（`Src/Interface/RestApi/chatApi.ts:140`，表 `chat_sessions`）与 `sess-<ms>-<base36>`（`Src/Services/Session/sessionManager.ts:52`）；使用 `session_key` 的 `sessions` 表仓储 `Src/Infra/Db/Repositories/sessionRepository.ts` 在 `Src/` 内 0 消费者 | 声明错误 | 说明三套并存事实：session_key 为设计态/休眠表，运行期以 `chat_sessions.session_id` 为准 |
| D-17 | §7 全局 ID 定义 | `trace_id` 格式 UUID v4 | 双轨：`Src/Infra/Logging/traceContext.ts:86`（`randomUUID`）与 `Src/Interface/RestApi/taskApi.ts:35`（`uuidv4`）符合；但主用户链路由 IPC 生成非 UUID——`Src/Interface/IpcBridge/ipcBridge.ts:796` ``trace-${Date.now()}-${hex4}`` | 文档过时 | 修正为"两种来源，REST/ALS 为 UUID v4，IPC 现为时间戳短码（待统一）"，并挂到 §8.1 红线跟踪 |
| D-18 | §7 全局 ID 定义 | `operation_id` 格式 `{timestamp_ms}-{4位随机hex}` | 时间戳段为 36 进制：`Src/Infra/Logging/traceContext.ts:189-192`（`Date.now().toString(36)`），与注释自身"timestamp_ms"不符；另存在同族手写 ID（`toolSafetyGate.ts:244` 用 `${Date.now()}-${hex4}` 作 effectId） | 需人工裁定 | 裁定以文档十进制 ms 为准修码，或以文档补注 base36；避免与 Docs/Agent/14 §6 再次分叉 |
| D-19 | §8 红线表 | "历史数据不可丢失：写入失败重试一次，仍失败则上报 FATAL" | 行为相反：`Src/Interface/EventStore/aiEventStore.ts:107-113` 落库失败仅 `logger.warn('AI 组件事件落库失败（不影响运行）')`；事件总线为纯内存且无重试/死信实现（`Src/Services/EventBus/eventBus.ts:34-53`；`Configs/memory.json` 的 `eventBus.retryMaxAttempts/deadLetterKeepDays` 无 TS 消费者）→ 与相邻红线"日志不阻塞主流程"塌缩为同一条 | 声明错误 | 明确区分"log 静默丢弃"与"历史数据重试 1 次 + FATAL"，后者若暂不实现则加 ⚠️ 待实现 |
| D-20 | §8 红线表 | "所有配置项有默认值：空配置下系统可直接启动" | fail-fast 与红线冲突：`Src/main.ts:232` `if (providerCount === 0) throw new Error('无可用 LLM Provider')`；`Src/Infra/Config/configLoader.ts:58` `default.json` 缺失即 FATAL | 需人工裁定 | 裁定红线范围（业务参数有默认 vs 基础设施必需项 fail-fast），在红线行加限定语 |
| D-21 | §8.1 v2 补充红线 | "每个 Loop 至少 **4 类**退出（成功+上限+预算+无进展+风险，缺一拒发）" | 实为五类：`Src/Services/LoopControl/stopRules.ts:71-73` `EVALUATION_ORDER = ['risk','limits','budget_hard','no_progress','success']`；`Src/Services/LoopControl/types.ts:47-54` `StoppedReason` 8 值；`Docs/Agent/11 §2.1`、`Docs/Agent/02 :251` 均已写"五类退出"（提交 493b005"恢复五类退出判定"） | 文档过时 | 4 类 → 5 类，并与 Docs/Agent/11 §2 对齐"缺一拒发"的落点（当前无启动期校验） |
| D-22 | §8.1 v2 补充红线 | "危险确认不可绕过：危险级动作的确认流程不提供跳过开关" | 存在跳过开关：`Src/Services/LoopControl/middleware/toolSafetyGate.ts:186-193`，命中 `autoApproveTools` 即 `forceApprove(..., 'policy:auto-approve')` 跳过人工等待；开关由 `Configs/security.json security.autoApprove.tools` + `main.ts:116` 注入（默认为空数组，但开关可见可开） | 需人工裁定 | 若接受"策略性白名单"设计，需改写红线为"默认拒绝 + 白名单须审计标记 `autoApproved`"；否则移除开关 |
| D-23 | 文档头 v2 修订提醒（第 7 行） | "Docs/Agent/02 核心架构（… 启动 **14 步** …）" | `Src/main.ts` 实际 ①–⑱ 共 18 个主步骤（`:67,82,87,97,122,126,152,181,185,190,194,227,231,261,265,317,342,351`）；`Docs/Agent/02-核心架构/核心架构设计.md:478` 已改为"启动 18 步（与 Src/main.ts 对齐）" | 文档过时 | 本文头同步为 18 步（关闭 9 步仍正确，见抽查项） |
| D-24 | 文档头 v2 修订提醒（第 7 行） | "…**六钩子**…" | 钩子事件为 9 个：`Src/Services/Hook/hookRegistry.ts:12-16`（UserInputReceived/SessionStart/PreToolExecute/PostToolExecute/ModelCallStart/ModelCallEnd/VerifierExecuted/ApprovalRequested/SessionEnd）与 `:20-31` 配置表 9 项 | 文档过时 | 改为"9 类 Hook 事件（其中 3 类可拦截）"或引用 Docs/Agent/02 §11 现口径 |
| D-25 | 文档头 v2 修订提醒（第 9 行） | "新增目录：… `ADR/`（预定 **5 项**必须登记的架构决策）" | `ADR/` 已登记 6 项：0001 approval-gate、0002 lawyer-letter、0003 verifier-four-tier、0004 maker-checker、0005 loopstate-immutable、0006 middleware-contract | 文档过时 | 更新为"已登记 6 项"，并说明 ADR-0006 为后续新增 |
| D-26 | §9 设计文档索引（v2 全量） | 仍以旧全局编号：09=UI 与可观测性、10=数据模型、11=配置体系、12=循环控制、13=持久执行、14=构建实施、15=参数总典 | 与 §6 及真实目录（2026-10-03 重构后）冲突：实际 `Docs/Agent/09-数据模型与持久化`、`10-配置体系与安全`、`11-循环控制系统`、`12-持久执行与恢复`、`13-构建与实施`、`14-参数总典与接口契约`、`15-实验矩阵与评估`、`16-开发规范`；§9 还缺 15/16 两行 | 文档过时 | 删除 §9 或按新三分类编号重建，避免与 §6 双份索引打架 |
| D-27 | §9 行 09 关键发现列 | "UI 与可观测性：需**新增** ApprovalQueue / LoopDebugger 面板" | 两面板均已实现：`Client/src/views/ApprovalQueue.tsx`（109 行）、`Client/src/views/LoopDebugger.tsx`（282 行），另有 Dashboard/ArbitrationView/AgentMonitor/TokenLedger/TraceReplay/WorkingModes；经 `Client/src/components/Layout/AppLayout.tsx` 挂载 | 文档过时 | 状态改为"已实现"，剩余缺口（如 LoopDebugger 数据面）另行标注 |
| D-28 | §4.4 Token 分润模型 | "默认权重 Wq 0.5/Wn 0.3/We 0.2"、"产出质量 = 交付物被最终采纳的比例（**Director 判定**）"，且 §5 Phase 2 记"自动结算准确" | 公式与权重 ✓ 一致（`Src/Services/TokenEconomy/profitDistributor.ts:48-97`），但：分润**无生产调用方**（`calculateDistribution/executeDistribution` 仅 `Src/Services/TokenEconomy/index.ts:53` 再导出 + `Tests/TokenEconomy/tokenEconomy.spec.ts`）；`qualityScore` 只由调用方注入（`:19`），代码里不存在"Director 判定采纳率"的任何实现（与 §4.3 已废弃"Director 评分"口径自相矛盾）；`Configs/economyRules.json profitSharing` 权重无消费者（`:32` 硬编码 DEFAULT_WEIGHTS） | 需人工裁定 | 加 ⚠️ "算法已就绪、结算链路与质量分来源未接线"；质量分口径统一改挂 Verifier 结果 |

> 另记两条**低优先文档滞后**（未计入上表，建议在 §1.3 修订时一并处理）：
> 1. §1.3 技术选型"持久化 = SQLite（三库分离）"只覆盖 `Src/`，未涵盖 `Server/` 侧的 PostgreSQL 栈（`Server/src/db/pool.ts:10` 引入 `pg`、`Server/package.json` `pg ^8.13.1`、`Server/src/routes/{auth,me,memories,tasks,settings,stats,backup}.ts`）。
> 2. §3.2 校准注"共享记忆服务层为内存态"：`Src/Services/SharedMemory/globalWorkspace.ts:20-21` 仍为 Map，但长期记忆与记忆条目已写穿 SQLite（`longTermMemoryStore.ts:119` INSERT `long_term_memory`、`memoryEntryStore.ts:38` INSERT `memory_entries`）。

## 未发现差异的抽查项（已核实一致）

**结构与配置层**

1. §3.1 角色信任分级：PD/PT = L1、WK/AL/RV = L2、AR/RG/AU = L0 —— `Configs/security.json security.trustLevels` 与 `Src/Infra/types.ts:31-38`、`Src/Infra/Security/trustLevels.ts` 完全一致（对应提交 6758d2a）。
2. §1.2 核心隐喻"总经理 = Prime Director"—— 已按 d044e2e 落文档，代码无"市长"字样残留。
3. §4.1 校准注：后端 `RoutingMode` 恰 6 个成员且行号精确 —— `Src/Core/Decision/types.ts:12-18`；`AUDIT` 不在其中、`LITIGATION/REGULATION` 标 S12 ✓。
4. §4.1 前端 7 种 `WorkingMode`（含 `AUDIT`）—— `Client/src/stores/chatStore.ts:25`（文档注为 `:13`，行号漂移 12 行，成员完全一致）。
5. §4.1 编排器只分派 4 种模式、其余回落 `尚未实现（S12）` —— `Src/Core/Decision/orchestrator/orchestrator.ts:94-104`。
6. §4.2 判定顺序 CONSORTIUM → ASSEMBLY_LINE → DELEGATION → DIRECT → 兜底 DELEGATION —— `Src/Core/Decision/routeDecision/routeDecision.ts:31-91` 逐条对应。
7. §4.2 阈值：50K / 2 域 / 耦合 <0.3 / ≤10K —— `Configs/routingRules.json` 与 `routingRules.ts:14-21`、`types.ts:46-51` 三处数值一致。
8. §4.4 Token 分润公式与权重 0.5/0.3/0.2 —— `Src/Services/TokenEconomy/profitDistributor.ts:32-36,48-97`；`Configs/economyRules.json economy.profitSharing` 同值；权重和为 1 的校验在 `:60-63`。
9. §4.5 滚动窗口 10K/5min、80% 预警、均值 3 倍、近 10 轮基线 —— `anomalyDetector.ts:43-49`、`:102 records.slice(-10)`、`:89 budget*0.8`；`Configs/economyRules.json rollingWindow` 同值。
10. §4.6 超时死锁 120 秒 —— `Configs/arbitration.json deadlockTimeoutSec:120`；§4.7 "连续 3 窗口" —— `arbitration.json consecutiveHighCount:3` + `dynamicScaling.ts:36-37,91-100`（f = k·n^m 在 `:96`，上限 `maxArbitrators:15`，核心层固定 1 —— `arbitratorPool.ts:35-46`），`dynamicScaling` 为已实现（非目标态）。
11. §2.4 引用的 LoopConfig 键全部存在且取值相符 —— `Configs/loopConfig.json`：`loopDefaults.max_iterations:30`、`roleOverrides.<8 角色>`、`stopRules.limits.{maxIterations,maxWallClockMs,maxToolCalls,maxConsecutiveErrors}`、`context.partitionCeilingRatio` S/L/M/H = 0.15/0.15/0.15/0.45；`partitionCeilingByRole` 确认**不存在**（全仓 0 命中），文档"无键不得实现"仍成立。
12. §8.1 红线"Verifier 四级不可跨越"—— `Src/Services/LoopControl/verifier/index.ts:44-62`（L1 未过即返回，禁到 L3/L4），ADR-0003；四档实现齐备 `hardVerifier/ruleVerifier/llmJudge/humanGateCore`。
13. §8.1 红线"Maker ≠ Checker"—— `verifier/llmJudge.ts:28,42-46` 运行期校验 Judge 模型 ≠ 生产者模型（ADR-0004）；`Configs/modelRouter.json routing.verifierModel` 已注入（`Src/main.ts:218`）。
14. §8.1 红线"LoopState 不可被压缩触及"—— `Services/LoopControl/loopState.ts:5-6,132,208` + `SharedMemory/writeGuard.ts:22` 把 `goal.immutableConstraints` 列入禁止写键（ADR-0005）。
15. §8.1 红线"不可逆副作用先写 INTENT 后执行"—— `toolSafetyGate.ts:244-268`（写失败 fail-closed 拒绝执行）+ `Src/Infra/DurableExecution/effectJournal.ts:47-75` INTENT→EXECUTING→终态。
16. §8.1 红线"审批超时默认拒绝"—— `approvalGate.ts:126-152` 超时返回非 APPROVED，`toolSafetyGate.ts:210-236` 拒绝执行；无"无应答自动通过"路径。
17. §8.1 红线"主循环 10 步不可调换"—— `Src/Core/Loop/runIteration.ts:6-14` 十步序列 + `:680` 顺序断言；§8.1"trace_id 跨 Agent 不可变 / parent_agent_id"—— `Core/Decision/types.ts:69,165` + `agents.parent_agent_id`（`Infra/Db/migrations.ts:67,144`）。
18. §8.1 红线"中间件与监管共存"—— `Core/Middleware/middlewareRegistry.ts` 与 `Services/Supervision/{pre,post,loop,reasoning,summary,compress}Supervision.ts` 双轨并存，均在 `runIteration` 中被调用。
19. §1.3 技术选型 —— `package.json:8` `node >= 20.0.0`；`better-sqlite3 ^13`、React 19 + Zustand 5 + Vite；三库分离 `Configs/default.json database.{mainPath,eventsPath,memoryPath}`（`Src/main.ts:132-136`）；REST 原生 http :3000（`Src/Interface/WebServer/httpServer.ts:5-11,50-58` + `Configs/default.json server.httpPort`）；华为云 MaaS OpenAI 兼容（`Configs/modelRouter.json providers[0]` + `Src/Infra/Llm/Provider/openaiProvider.ts`）。
20. §5 Phase 0"事件总线 = 内存事件总线"✓（`eventBus.ts` 内存 + `Configs/memory.json eventBus.store:"in-memory"`）；§5 Phase 1"流式输出现经 Electron IPC 桥接"✓（`ipcBridge.ts:730-903`，WS 已删除）；Phase 3"城邦大屏"✓（`Client/src/views/Dashboard.tsx` + `components/Dashboard/TokenFlowSankey.tsx`）。
21. §4.8 六步治理闭环 ✓ —— `Src/Services/Arbitration/tribunal.ts:30,77,122,190,230,286`（立案→胶囊→裁决→律师函挂起→现场恢复→知识沉淀）+ `:317` 端到端执行；写入拦截在 `SharedMemory/writeGuard.ts`，胶囊去抖在 `tribunal.ts:203-209`。
22. §6 设计文档索引 22 条路径全部存在（`Docs/Agent/01..16`、`Docs/Client/01..04`、`Docs/Server/01..03`），`../16-开发规范/docsMigrationPlan.md` 链接有效。
23. §3.2 校准注其余项 ✓ —— `agentRecruiter.ts:30`（现 `:73`）requiredRoles 确为 PD+Partner；`regulator` 确不在任何 requiredRoles（全仓 0 命中）；主循环第 ④ 步 `getVisibleToolsForRole` = requiredRoles ∪ L0 兜底（`runIteration.ts:428-431` 调用点 + `toolFactory.ts:75-84`）。
24. §2.4 分区上限 S15/L15/M15/H45 与 S-L-M-H 分件系数 0.05/0.5/0.3/1.0 ✓ —— `Src/Services/Context/partitions/partitions.ts:62-65`（注意：值为硬编码常量，`loopConfig.json context.*` 仅被 `configValidator.ts:138-148` 校验、无运行期消费者——该键归属表述属轻微文档过时，未单列）。
25. §4.3"旧口径 Director 评分已废弃"✓ —— 代码中无 Director 质量评分路径，质量判定归 Verifier 链（`Supervision/qualityThreshold` 亦无消费者，仅 `Client/src/config/configSchema.ts:147` 暴露）。
26. §8.1 红线"日志不阻塞主流程 / 写入失败静默丢弃"✓ —— `Src/Infra/Logging/logWriter.ts:141,162-165,258-259,286-287,307-308`。

---

## 回写记录（2026-10-03）

已逐条重新核实并回写 `Docs/Agent/01-系统概览/系统设计总览.md`：回写 23 条、【需人工裁定】登记 5 条（D-05/18/20/22/28，文档中记"现状+待办"）、代码追平 0、未处理 0。行号引用已全部改为"文件名+符号名"。
