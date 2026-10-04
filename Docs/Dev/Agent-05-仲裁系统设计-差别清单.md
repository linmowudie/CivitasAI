# Agent/05 仲裁系统设计 — 文档-代码差别清单

> 审查日期 2026-10-03 · 文档路径 `Docs/Agent/05-仲裁系统/仲裁系统设计.md` · 审查基准：当前工作区代码（含未提交改动，HEAD=493b005）

## 摘要

- **差别共 14 条**：文档过时 **9** · 声明错误 **2** · 需人工裁定 **3** · 代码未实现（新发现且文档未标注）**0**。
- 总体判断：2026-09-22 校准的结论**主体仍然成立**（六步闭环函数齐备、扩缩容算法已实现但零生产触发、事件无业务订阅方、案件不落库），但**知识沉淀链路出现三处口径冲突**（Doc 14 §8 #24 裁定"撤仲裁发布" vs tribunal.ts 新增注释"当前保留此发布" vs 本文档"记入待办"），且 **long_term_memory 已于 2026-10-02 同步落库**，文档"表已建但无写入方"的标注已失效；另有律师函挂起"半接线底座"（`LoopState.suspension`、AgentRuntime 状态机）未被文档承认。
- 行号锚点因 lint/类型债修复（69df683/493b005 + 工作区未提交改动）整体漂移 +1~4 行，属批量小改。

## 差别清单

| # | 文档章节 | 文档声明 | 代码实态(文件:行) | 分类 | 建议处理 |
|---|---------|---------|------------------|------|---------|
| 1 | §3.1/§4/§5 全部行号锚点 | `tribunal.ts:34/81/127/195/234/260/290/315`、`capsuleAssembler.ts:39/:29`、`arbitratorPool.ts:34,70,146`、`restorationManager.ts:22,60,84`、`dynamicScaling.ts:72,150`、`memoryConsolidator.ts:23/:55`、`writeGuard.ts:32`、`conflictPrecheck.ts:55` | 现为 tribunal.ts:35/82/128/196/235/261/**294**/**319**（闭环内 :344/:348-350/:353/:356-359、Map :21-22、:27、:49、ACK :276）；capsuleAssembler :40/:30；arbitratorPool :35/:71/:147；restorationManager :23/:61/:85（Map :18）；dynamicScaling :73/:151；memoryConsolidator :24/:56；writeGuard :33；conflictPrecheck **:54**（净减 1 行） | 文档过时 | 批量改锚点；tribunal :287 之后偏移 +3~4 是因新增裁定注释（见 #2），conflictPrecheck 方向相反，需逐条替换 |
| 2 | §4 Step 6（:310 附近）"现状"标注 | "仅校验案件已有 finalVerdict 后发布 KNOWLEDGE_CONSOLIDATION……不做窗口检查、不写库"，未提及任何裁定 | `tribunal.ts:289-292` 新增注释：**"Docs/Agent/14 §8 #24 裁定 KNOWLEDGE_CONSOLIDATION 应仅由 Loop 成功退出点发布，但该接线尚未落地……当前保留此发布以维持六步治理闭环的事件契约"**——发布代码本身未撤（:294-312） | 文档过时 | Step 6 补记裁定出处与代码方"明示保留"的立场变化（这是 09-22 之后新出现的代码事实） |
| 3 | §4 Step 6（:318）/ §7 | "SharedMemory/memoryConsolidator.ts:55 也自行发布同名事件，全系统无订阅者——重复发布问题记入 Docs/Agent/07 §4.3 待办" | 三处口径互相冲突：Doc 14 参数总典 §3.4 行 :596 与 §8 #24（:900）**裁定"撤 tribunal.ts:297 的发布"**；代码方（#2 注释）决定**保留**；Doc 07 :421-429 亦记录裁定。Loop 成功退出路径（Core/Loop、LoopControl）至今仍零发布（grep KNOWLEDGE_CONSOLIDATION 仅 tribunal:301 与 memoryConsolidator:56 两个发布点） | 需人工裁定 | 裁定执行方与仲裁庭方需拍板"撤发布"还是"改裁定"；文档在 Step 6 增一行链接 Doc 14 §8 #24 并标注"存在立场冲突，未决" |
| 4 | §4 Step 6c | "⚠️ 未接线：long_term_memory 表已建但**无写入方**（Docs/Agent/09 §4.2）" | **已失效**：`longTermMemory.ts:8-10`（2026-10-02 注释）+ `writeMemory()` 经 `longTermMemoryStore.ts:119 INSERT INTO long_term_memory` 同步落库、`projectMemoryEntry` 镜像 memory_entries、`hydrateLongTermMemory()` 已在 `main.ts:160` 启动回灌；`memoryConsolidator.ts:40-47` 的 `consolidateFromTrace→writeMemory` 即真实写入方。仍成立的只有"**触发链未接线**（无业务订阅者调用沉淀入口）" | 文档过时 | 改为"写入方与落库已就绪（2026-10-02），缺的是 Loop/仲裁成功退出→consolidateFromTrace 的触发接线"；联动 Doc 09 §4.2 同步修订 |
| 5 | §4 Step 4（:244-249） | "Src 中无 SUSPEND_AND_NOTIFY 订阅方，[4a]-[4c] 为设计目标态（冻结快照亦未接线）" | 订阅方确实仍无（全仓 subscribe 仅 progressTracker 的 TASK_* 与 Interface 层泛订阅），但**承接底座已半接线**：`LoopControl/loopState.ts:113-116` 定义 `SuspensionRecord{reason,suspendedAt,suspendedBy,conflictId}`、`:149 LoopState.suspension?` 字段，注释明书"**Docs/Agent/05 定义**"；`Core/AgentRuntime/stateMachine.ts:27,31` 支持 `SUSPEND: running→suspended`、`types.ts:15` 注"挂起（律师函）"；`suspension` 字段在 Src/Tests 中**零写入方** | 文档过时 | 承认"类型/状态机就位、仅缺事件订阅与写入"；且 doc05 正文（§6 数据模型）应补 `SuspensionRecord` 定义或反向引用——代码声称该类型出自 doc05，文档却没有 |
| 6 | §4 Step 3（:213-214） | "ARBITRATION_DEADLOCK 事件与 Regulation.escalateDeadlock 在 Src 中均无调用方，**死锁升级仍为设计目标**" | 承接端已实现并测试覆盖：`regulatoryAuthority.ts:96 escalateDeadlock→finalArbiter.ts:37 issueFinalVerdict`（校验 deadlocked/reasoning 态、落 interventions Map、广播 ARBITRATION_VERDICT 带 `isRegulatoryIntervention:true` :82-93），E2E/Judicial 用例调用（`Tests/E2E/regulationAuditMode.spec.ts:117`、`Tests/Judicial/judicialSupervision.spec.ts:979`）；**仍缺**的是 tribunal 死锁分支发事件/调用（tribunal.ts:348-350 死锁仅 return）与 `ARBITRATION_DEADLOCK` 的**任何发布方**（全仓仅 eventTypes.ts:57 枚举定义） | 文档过时 | 更新为"监管侧最终裁决已实现（含测试），缺仲裁侧触发发布；deadlockTimeoutSec 超时分枝依旧未实现" |
| 7 | §4 Step 1（:100）/ §7 行 1 | "CONFLICT_DETECTED 实际发布方为 conflictPrecheck.ts:55（同文件多 Agent 修改）" | 发布函数存在但**整条链在生产不可达**：发布点现为 :54；其唯一调用方 `mergePhase.ts:59 precheckConflicts`，而 `executeMergePhase` 在 Src 中**无任何导入者**（仅 Tests/Parallel/parallelCollaboration.spec.ts 引用）；亦无任何代码订阅 CONFLICT_DETECTED→fileCase（仲裁自动立案环节缺失） | 文档过时 | 补注"发布链本身尚未接入主循环（mergePhase 无生产调用方），且 CONFLICT_DETECTED→fileCase 无订阅桥，Step1→Step2 为手动/测试驱动" |
| 8 | §7 事件清单 | 订阅者列：涉事 Agent/Arbitration/TokenEconomy/SharedMemory/Regulation/Dashboard；Step 6 称"全系统无 KNOWLEDGE_CONSOLIDATION 订阅者" | 服务端**业务订阅者全部不存在**（Src 内 subscribe 业务方仅 progressTracker）；"Dashboard 订阅"经由 Interface 层两条泛订阅近似成立：`ipcBridge.ts:121 subscribeMany(全部 EventType→前端转发)`、`aiEventStore.ts:26-30,178`（'arbitration:' 前缀事件持久化供回放）。"全系统无订阅者"的绝对表述已不精确 | 文档过时 | §7 表加"生效状态"列：逐行标注 实际发布方/订阅方现状；"无订阅者"改为"服务层无业务消费者（Interface 层有转发/落库型泛订阅）" |
| 9 | §5.4 消费状态注（:416-421） | 列出 8 个"没有任何代码读取"的键，**未含** `coreArbitrators`/`caseArbitratorCount`（暗示其被消费）；且称所列键无任何代码读取 | `coreArbitrators`、`caseArbitratorCount` 在 Src 同样**零引用**（grep 仅命中 JSON/文档）——应列入未消费清单；反向：这两键（及多数 arbitration.* 键）在 **Client 配置 UI 有真实读写方** `Client/src/config/configSchema.ts:163-171+`，"没有任何代码读取"表述过宽，准确口径是"**服务端运行期无消费**（main.ts 从不读 arbitration 段）"（与 Doc 14 §2.5 的 ⚠️a 口径一致） | 声明错误 | 修正未消费清单（补 2 键）并将表述限定为"运行期生效通路不存在"，注明前端 UI 可编辑但编辑结果无下游 |
| 10 | §8 依赖表 | "LlmCaller｜Tools｜仲裁 LLM 调用（3 个独立实例）" | 全仓**不存在** `LlmCaller` 组件（Src 与 Src/Tools 均无此名）；LLM 调用实际位于 `Src/Infra/Llm/{Provider,Router}`，且 `modelRouter.json:44-48 routing.arbitrationModels` 已配 3 模型（`configValidator.ts:167-173` 强制 ≥3；`main.ts:219` 读入）、`Prompts/roles/arbitrator.md` 已存在——但仲裁服务不调用任何 LLM（Phase 0-2 规则裁决） | 声明错误 | 组件名改为实际的 Infra/Llm 层；补注"arbitrationModels 路由与提示词底座已备、仲裁侧未接入"（可顺带提示三模型当前同 provider，或涉 ADR-0004 多样性口径） |
| 11 | §8 依赖表（整体） | 8 行依赖无"生效状态"标注；未列 Interface 消费方 | 实际 import 图：Arbitration 模块仅依赖 EventBus + Infra types；WriteGuard/TokenEconomy/AgentRuntime/Database 四条**无任何代码接线**；遗漏真实消费方 `Interface/RestApi/loopApi.ts:9-10,42-52,86-91`（GET /api/loops/arbitration[:caseId]、dashboard 概览聚合 getPoolStats/getAllCases）与 `Regulation/finalArbiter`（反向依赖 Arbitration/types） | 文档过时 | §8 加"生效状态"列；补"被谁依赖"方向（loopApi/finalArbiter/conflictPrecheck→S12 字样注释） |
| 12 | §4 Step 4 防抖（:229） | "防抖：同 **conflictId** 5 分钟内只挂一次（SUSPEND_COOLDOWN_MS，tribunal.ts:26）" | 实现确以 conflictId 为键（`tribunal.ts:28,203-206`），但 `tribunal.ts:25、:194` 代码注释与 **ADR-0002 决策第 4 条**均写"同一 **(loopId, conflictId)** 5 分钟内只挂一次"——文档-05 与实现一致、与 ADR/代码注释冲突；ADR-0002 另声称的 running→suspended 订阅与"RESTORATION_ACK 后从 last_checkpoint_id 续接"仍未实现（lastCheckpointId 仅服务于崩溃恢复 `DurableExecution/recoveryExecutor.ts:43-47`），其"与 Docs/12 §6 审批门一致"仍指向已迁移的旧编号（approvalGate 现为 Docs/Agent/11 §6） | 需人工裁定 | 裁定挂起去重键是否含 loopId（含则改代码与本文档，否则修 ADR-0002 与代码注释）；ADR-0002 的"已接受"状态与实际进度的落差建议单独立项复核 |
| 13 | §3.1"仲裁者池"行 + §2 架构图（Pool→推理引擎） | 将 initArbitratorPool/assignArbitrators 列为闭环组件，图示仲裁者池流向推理引擎 | `reasonVerdict` **不从池取仲裁者**：自造 `arbitrator-1..3`（tribunal.ts:140-150）；`initArbitratorPool/assignArbitrators/executeVerdicts/releaseArbitrators` 在 Src 中零生产调用方（仅 dynamicScaling 调 resizeAuxiliaryPool、loopApi 调 getPoolStats——未 init 时统计恒 0） | 文档过时 | §3.1/§5 补注"裁决路径与仲裁者池当前解耦，池仅扩缩 API 与统计存在"；扩缩容本身"已实现未接线"的结论不变（见抽查项） |
| 14 | §6/§5.4 数据模型未提 | —（文档只描述 dynamicScaling 的 9 键 `ScalingConfig`） | `types.ts:152-158` 另有一个 `ScalerConfig{baseArbitratorCount,scalingFactor,scalingExponent,cooldownMs,maxArbitratorCount}`：与 ScalingConfig 字段名/子集不一致，全仓（含 Tests）**零引用**，疑为早期设计残留 | 需人工裁定 | 裁定：删除该死类型，或在 doc05 §6 登记为"目标态扩缩配置形状"；否则接线时会出现双配置源漂移（Doc 14 §2.8 同类问题已有先例） |

## 未发现差异的抽查项（核实一致，供置信度参考）

- **六步闭环函数名/签名全部存在且语义一致**：`fileCase`（返回 `Result<ArbitrationCase>`，同 conflictId 进行中案件去重 :43-47）、`assembleCapsule`（闭环简化版与 capsuleAssembler 完整版双轨、未 init 回落 `createSimpleCapsule '(简化模式)'`、limit=5 硬编码 :69-70、`tokenBudget ?? 5000` :96）、`reasonVerdict`（规则裁决 verdict 恒 'new_wins'、confidence 0.8、3 unique 判 deadlock :158-160）、`issueSuspension`（payload={caseId,conflictId,targetAgentIds,suspensionReason}、priority critical，确无 conflictSummary/issuedAt）、`createPlan/executePlan`（仅标记 executed，Phase 3 才真实回滚的注释仍在 :57-59/:75）、`consolidateKnowledge`（仅验 finalVerdict，payload 三字段）、`executeFullArbitration`（顺序执行、死锁提前 return 跳过挂起、固定 self_healing）。
- **§6 数据模型与 types.ts 逐字段一致**：CaseStatus :10、ArbitrationCase :100（扁平 plaintiff/defendant、completedAt、suspendIssued）、FinalVerdict :85、RestorationPlan :130、`case-{n}` 格式——行号引用（types.ts 各处）**未漂移**。
- **§5.2 扩缩算法与 dynamicScaling.ts 逐行对应**：冷却 120_000、300 秒窗口硬编码（:82）、f=k·n^m（默认 1.5/0.5）、ceil/min(…,15)、缩容 ×0.5 硬编码、双计数清零、`ARBITRATOR_POOL_RESIZED` source/payload 形状——全部一致；"仅频率一项有采集""持续时长/涉及 Agent 数/队列长度三项无实现"仍成立。
- **动态缩放"已实现但未接线"**：`initDynamicScaling`/`recordConflict`/`startAutoScaling` 在 Src 零调用方（与文档 :384-389 待办一致）；Tests 有覆盖（E2E/conflictArbitration 等）。
- **不落库结论不变**：`arbitration_cases` 在 `migrations.ts` 确无建表（long_term_memory 有 v17/v21）；案件/恢复计划仍为模块级 Map。
- **writeGuard 三件事**（红线 key / 乐观锁→发布 `MEMORY_VERSION_CONFLICT` 事件 :50-60 / inferred·assumed 不入 L 分区与长期记忆 :65-68）与 Step 1"实际实现"框一致；`Configs/memory.json` 的 `conflictSimilarityThreshold:0.85`、`capsuleRecentOpsCount`、`capsuleBudgetTokens:4000` 确无任何 Src 引用（代码缺省 5000 与 JSON 4000 的差异亦被文档如实记录）。
- **§7 八个 EventType 枚举值全部存在**（eventTypes.ts:51-58）；RESTORATION_ACK 双路径字段差异（restorationManager 多 conflictId/restorerAgentId/restoredAt/compensationActions；tribunal 仅 planId/caseId；均无 restoredTaskId）与文档一致。
- **§2 校准注**仍成立：无 ConflictReceiver/ReasoningEngine/InjunctionPublisher/KnowledgeConsolidator/DynamicArbitratorScaler 类名；`Prompts/roles/arbitrator.md` 存在；`Configs/arbitration.json` 键集与 §5.4 表格一致（minArbitrators=1 与代码默认 0 的漂移文档-14 §2.5 已记，doc05 表述以代码为准，无误）。
- **approvalGate 无律师函逻辑**：全文核实仅审批队列/超时默认拒绝/FE-003~005 加固，不含 SUSPEND 处理（Step 4"订阅方未实现"的判定按当前代码依然正确，仅"底座半接线"见 #5）。

---
*审查人：自动化文档-代码对账（只读）· 分类口径：文档过时/代码未实现/声明错误/需人工裁定 · 本清单不改动任何源码与原设计文档*

---

## 回写记录（2026-10-03）

已逐条重新核实并回写 `Docs/Agent/05-仲裁系统/仲裁系统设计.md`：回写 11、【需人工裁定】登记 3（#3 KNOWLEDGE_CONSOLIDATION 冲突、#12 防抖键、#14 ScalerConfig 死类型）、代码追平 0、未处理 0。行号锚全部改"文件+符号"。
