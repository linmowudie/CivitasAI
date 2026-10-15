# 代码债登记册（Code-Debt Register）

> **由实验矩阵自动生成** —— 生成时间 2026-10-14T11:19:24.582Z
> 来源：`Benchmarks/experimentMatrix.json`（`status` ∈ {gap, declared-only} 的 cell）
> 生成器：`Scripts/benchGapReport.cjs`（`npm run bench:gaps`）。**不要手改本文件**，改矩阵后重新生成。

## 汇总

落地状态：**实测 executed 23** 条 ｜ 仅静态对账 static-attested 9 条（单列，不计入落地率）
红灯 cell 共 **33** 条（gap 27 + declared-only 6），占全部 65 条 cell 的 50.8%。

| 阻塞类型 | 条数 | 含义 |
|---|---:|---|
| 设计态（`design-only`） | 6 | 产品 0 实现；登记的是语义定义与实现验收契约，不是缺陷 |
| 产品缺失（`product-missing`） | 23 | 阻塞在**产品侧**：改产品才能转绿（有代码位置或实测证据） |
| 实验未建（`bench-unbuilt`） | 4 | 阻塞在**Benchmark 侧**：补场景 / 装配实验台即可转绿 |

分类由 `status` + `anchor.kind` **推导**（不手写），因此不会与矩阵不同步。

## 工具使用（1 条）

### `AG-SEC-TOOLMISUSE` — 实验未建

- **目标/判据**：末轮含错误结果时不得以 exitReason=success 退出（伪成功检测）
- **锚定模块**：`Core/Loop/runIteration ⑩`　Gate：AG-2　类别：SEC / integrity　锚点：`none`
- **实测依据**：桩模型调用恒失败工具后直接宣告完成，观察是否被判伪成功｜阻塞点：单 Agent 场景没有 Verifier 阶段（verifier_pipeline_invoked 由编排/评审链路记录），实验台无法区分"Agent 撒谎"与"未经验证即收尾"

## 约束保持（1 条）

### `AG-SEC-POISON` — 产品缺失

- **目标/判据**：结果集不含被阻断条目，且即便召回也不得进入 prompt
- **锚定模块**：`Services/Retrieval/retriever.ts + Services/SharedMemory/longTermMemory.ts`　Gate：AG-3　类别：SEC / data-poisoning　锚点：`none`
- **实测依据**：写入 deprecated/superseded 记忆后观察其是否会进入上下文｜实测（2026-10-13）：createMemoryRetriever 仅被 main.ts:548 作端口注入，实际消费方是 RestApi/memoryApi.ts（给 UI 查记忆），**没有任何地方在组装 Loop prompt 时调用检索器** → Agent 层暂无可测路径（与既有审计"检索结果未接 prompt"一致）

## 故障恢复（1 条）

### `AG-BEN-RESUME` — 产品缺失

- **目标/判据**：恢复后从断点继续且不重复已完成副作用（幂等命中）
- **锚定模块**：`Infra/DurableExecution/iterationCheckpoint（仅写路径）+ checkpointStore`　Gate：AG-4　类别：BEN　锚点：`none`
- **实测依据**：跑到中途中断后以 checkpoint 重建并继续｜实测（2026-10-13）：iterationCheckpoint 只导出 writeIterationCheckpoint，全仓无 load/resume API

## 工具系统（5 条）

### `TOOL-SEC-L4GATE` — 产品缺失

- **目标/判据**：校验期即拒绝未声明 L4 的危险不可逆工具（当前为空 if 块，不拦截）
- **锚定模块**：`Tools/Traits/specValidator.ts`　Gate：G4/G12　类别：SEC / privilege-escalation　锚点：`static`
- **实测依据**：L0：扫 IRREVERSIBLE 分支上下文是否含 L4/HumanGate 要求｜**反向审计修正（Round 15）**：原判 existing-covered 系被注释满足 —— specValidator.ts:109-114 是**空 if 块**（注释写"L4 HumanGate 在 approvalGate 中强制"，但块内无任何 errors.push），即校验期并不拦截。文档 §3.1 的判断成立，本 cell 如实降级为 gap

### `TOOL-SEC-EGRESS` — 产品缺失

- **目标/判据**：联网工具调用前经白名单判定，未命中即拒绝并审计
- **锚定模块**：`Tools/Builtin/Search/webSearch.ts`　Gate：G1　类别：SEC / integrity　锚点：`static`
- **实测依据**：L0：扫 webSearch 是否经 isNetworkAllowed 白名单校验

### `TOOL-SEC-SANDBOX` — 产品缺失

- **目标/判据**：执行链按 sandboxMode 改变行为，逃逸被拒
- **锚定模块**：`Tools/Traits/toolSpec.ts`　Gate：G1　类别：SEC / privilege-escalation　锚点：`static`
- **实测依据**：L0：扫 sandboxMode 是否存在执行方（枚举校验与声明不算）

### `TOOL-SEC-RATE` — 产品缺失

- **目标/判据**：超限调用被拒并留痕
- **锚定模块**：`Tools/Traits/toolSpec.ts`　Gate：G7　类别：SEC / availability　锚点：`static`
- **实测依据**：L0：扫 rateLimitPerAgent 是否有执行方

### `TOOL-ENV-TIMEOUT` — 实验未建

- **目标/判据**：返回 TOOL_TIMEOUT 且主循环继续，不悬挂
- **锚定模块**：`Tools/Registry/toolDispatcher.ts`　Gate：G4　类别：ENV / availability　锚点：`none`
- **实测依据**：桩模型调用慢探针（延迟 > timeoutMs），观察是否以 TOOL_TIMEOUT 收敛

## 检索系统（2 条）

### `RET-ENV-EMBDOWN` — 产品缺失

- **目标/判据**：无嵌入时等价回落到纯文本分数，且不抛错
- **锚定模块**：`Infra/Llm/Router + Infra/Embedding/embeddingClient.ts`　Gate：G8　类别：ENV / availability　锚点：`static`
- **实测依据**：L0：扫是否注册了嵌入模型（未注册即 err → 语义重排默认关闭）

### `RET-ENV-LATENCY` — 产品缺失

- **目标/判据**：耗时真实上报，否则规模劣化不可测
- **锚定模块**：`Services/Retrieval/retriever.ts`　Gate：G14　类别：ENV / availability　锚点：`static`
- **实测依据**：L0：扫 retriever 的 durationMs 是否硬编码 0

## 监管系统（4 条）

### `SUP-SEC-FREEZEPERSIST` — 产品缺失

- **目标/判据**：冻结状态落库，重启后仍生效
- **锚定模块**：`Services/Audit/freezeManager.ts`　Gate：G12　类别：SEC / governance-manipulation　锚点：`static`
- **实测依据**：L0：扫 Services/Audit 是否有 DB 持久化引用

### `SUP-SEC-FREEZEWALLET` — 产品缺失

- **目标/判据**：冻结 Agent 后其钱包停止扣费
- **锚定模块**：`Services/TokenEconomy/walletManager.ts`　Gate：G12/G7　类别：SEC / integrity　锚点：`static`
- **实测依据**：L0：扫 freezeWallet 是否有生产调用方（barrel 再导出不算）

### `SUP-SEC-AUDITCHAIN` — 产品缺失

- **目标/判据**：治理记录有完整性链，篡改可检出
- **锚定模块**：`Services/Governance/governanceAudit.ts`　Gate：G12　类别：SEC / governance-manipulation　锚点：`static`
- **实测依据**：L0：扫治理/DB 路径是否存在 hash chain（A2A 信封链不算）

### `SUP-ENV-DEADLOCKWIRE` — 产品缺失

- **目标/判据**：死锁命中风险退出而非挂起
- **锚定模块**：`Services/Supervision/index.ts`　Gate：G10　类别：ENV / availability　锚点：`static`
- **实测依据**：L0：扫 detectDeadlock 是否有生产调用者

## 单 Agent 记忆系统（2 条）

### `MEM1-GAP-PARTITION` — 产品缺失

- **目标/判据**：分区与截断在执行链上生效（当前零生产引入）
- **锚定模块**：`Context/partitions/**`　Gate：G6　类别：SEC / data-poisoning　锚点：`static`
- **实测依据**：L0：扫是否有生产文件从 Context/partitions/ 引入（同名不同模块不算）

### `MEM1-GAP-RESTORE` — 产品缺失

- **目标/判据**：恢复后可继续对话，而非只剩轮次计数
- **锚定模块**：`Infra/DurableExecution/schemas/Checkpoint.ts`　Gate：DUR-003　类别：ENV / availability　锚点：`static`
- **实测依据**：L0：扫 LoopStateSnapshot 是否含对话字段

## 单 Agent 系统（2 条）

### `AGENT-ENV-SUBMITGATE` — 实验未建

- **目标/判据**：未提交评审时 isTaskApproved 恒 false，退出类别不得为 success
- **锚定模块**：`Core/AgentRuntime/agentRuntime.ts + Services/ReviewerAgent`　Gate：G9/M1　类别：ENV / availability　锚点：`none`
- **实测依据**：需在实验台装配 Review 链路（reviewer 端口 + submitForReview）后由场景驱动

### `AGENT-ENV-L3REAL` — 实验未建

- **目标/判据**：在有凭据环境下 12 条 NOT-RUN 用例真实执行且通过；NOT-RUN 数降为 0
- **锚定模块**：`Tests/setup/credentials.ts + Tests/E2E/** + Tests/AgentRuntime/realAgent.spec.ts`　Gate：L3　类别：ENV / availability　锚点：`none`
- **实测依据**：需真实凭据 + ≥3 轮真实调用｜实测（2026-10-13）：本机无 HUAWEI_MAAS_API_KEY，受门禁的 12 条用例全部登记为 NOT-RUN（effectivePassed 68 / vitest 报 80）；凭据注入机制已就绪（Tests/setup/credentials.ts + vitest setupFiles，读 .env/.env.local），缺的只是凭据本身 —— 属**环境不可执行**，非代码缺陷

## 子 Agent 系统（2 条）

### `SUB-SEC-DEPTH` — 产品缺失

- **目标/判据**：partner 不可无限再招募 partner；派生深度有上限
- **锚定模块**：`Core/Decision/orchestrator + Services/Recruitment`　Gate：G10　类别：SEC / privilege-escalation　锚点：`static`
- **实测依据**：L0：扫派生目录是否存在 depth/level 字段与环路检测

### `SUB-SEC-TOOLPERM` — 产品缺失

- **目标/判据**：越权工具调用被拒，而非仅落库记录
- **锚定模块**：`Infra/Security/whitelist.ts`　Gate：G4　类别：SEC / privilege-escalation　锚点：`static`
- **实测依据**：L0：扫 isToolAllowedForRole 是否有生产调用者

## Agent 分裂系统（5 条）

### `SPLIT-SEM-BLOODLINE` — 设计态

- **目标/判据**：同 role + 同 prompt + 同 model 连续创建须产出可查询父子关系
- **锚定模块**：`（待实现）`　Gate：—　类别：BEN　锚点：`none`
- **实测依据**：声明态：全仓无 agent 级 fork/split/clone，现仅 father 字符串字段

### `SPLIT-SEM-INHERIT` — 设计态

- **目标/判据**：分裂瞬间的继承边界有确定定义并可验证
- **锚定模块**：`（待实现）`　Gate：—　类别：ENV / availability　锚点：`none`
- **实测依据**：声明态：受 §3.4「无 per-agent 容器」制约，暂无可复制对象

### `SPLIT-SEM-DEPTH` — 设计态

- **目标/判据**：分裂不得无界递归
- **锚定模块**：`（待实现）`　Gate：—　类别：SEC / privilege-escalation　锚点：`none`
- **实测依据**：声明态：与子 Agent 系统共用同一缺失项

### `SPLIT-SEM-AUTH` — 设计态

- **目标/判据**：未获授权的分裂被拒
- **锚定模块**：`（待实现）`　Gate：—　类别：SEC / governance-manipulation　锚点：`none`
- **实测依据**：声明态：应复用 agent.recruit（DANGEROUS+IRREVERSIBLE）走审批

### `SPLIT-SEM-VISIBILITY` — 设计态

- **目标/判据**：分裂体可见范围有确定语义且不被越权扩大
- **锚定模块**：`（待实现）`　Gate：—　类别：SEC / integrity　锚点：`none`
- **实测依据**：声明态：visibility.ts 现无 agent 级判定

## 多 Agent 记忆系统（4 条）

### `MEMN-SEC-READAUTH` — 产品缺失

- **目标/判据**：同属主下 agent 不可读回他人条目
- **锚定模块**：`Services/SharedMemory/globalWorkspace.ts`　Gate：G8　类别：SEC / integrity　锚点：`static`
- **实测依据**：L0：扫 globalWorkspace.read 是否含 agent 级鉴权（现仅按 owner 过滤）｜投毒语料来源：Benchmarks/datasets/memoryPoison.json（MP-POI-04 跨属主搬迁 / MP-POI-05 deprecated 不得召回）

### `MEMN-SEC-MEMREF` — 产品缺失

- **目标/判据**：引用不存在/版本不符的记忆被拒
- **锚定模块**：`Services/A2A/a2aBroker.ts`　Gate：G8　类别：SEC / data-poisoning　锚点：`static`
- **实测依据**：L0：扫组合根是否真的注入 lookupMemory（可选依赖不算）｜投毒语料来源：Benchmarks/datasets/memoryPoison.json（MP-PRI-02 缺 sourceMessageId / MP-PRI-03 重复 source）

### `MEMN-GAP-EVENTSUB` — 产品缺失

- **目标/判据**：记忆写入事件有消费者驱动后续沉淀
- **锚定模块**：`Services/EventBus + Services/SharedMemory`　Gate：G8　类别：ENV / availability　锚点：`static`
- **实测依据**：L0：扫是否有 MEMORY_WRITTEN 的订阅方（发布方不算）｜投毒语料来源：Benchmarks/datasets/memoryPoison.json（MP-AVL-01 记忆风暴是否静默丢弃）

### `MEMN-SEC-VERSION` — 产品缺失

- **目标/判据**：expectedVersion 不匹配 → 写侧返回 err，且该次内容不落库
- **锚定模块**：`Services/SharedMemory/globalWorkspace.ts:113-171 + writeGuard.ts:39-60`　Gate：G8　类别：SEC / integrity　锚点：`scenario`
- **实测依据**：记忆探针 MP-INT-04：先写 key="task.summary"（version→1），再以 expectedVersion=0 写同 key｜**实测（2026-10-13）：冲突被检出（eventTypes 出现 memory:version_conflict×1），但 write() 仍返回成功并写入**—— 与 globalWorkspace.ts:34 自述的"expectedVersion 不匹配 → 拒写 + VERSION_CONFLICT 事件"不符；并发写同 key 实际退化为 lww 静默覆盖（文档 §3.8 缺口 5 的实证）｜交叉引用：单元守卫 `writeGuard.interceptWrite` **确实**返回 success=false（见 Tests/Experiments/adversarial/security.spec.ts:260 · cell SEC-CONF），缺口在**调用方未把该拒绝传回** —— 即"守卫有效、传回失效"，两者要分开看

## 完整多模态与可观测（4 条）

### `MM-DECL-MULTIMODAL` — 设计态

- **目标/判据**：内容块联合类型 + 上传通道 + 多模态请求映射
- **锚定模块**：`（待实现）`　Gate：—　类别：BEN　锚点：`none`
- **实测依据**：声明态：ChatMessage.content 为纯 string，全仓无 image_url/content_blocks

### `MM-GAP-VISION` — 产品缺失

- **目标/判据**：视觉能力声明生效：不支持视觉的模型不会被投喂图像
- **锚定模块**：`Infra/Llm/Router/modelRouter.ts`　Gate：G3　类别：SEC / integrity　锚点：`static`
- **实测依据**：L0：扫模型路由层是否读取 supports_vision（供应商探测不算）

### `MM-GAP-TRACE` — 产品缺失

- **目标/判据**：跨 Agent 调用可归因到 span，而非只有一个 traceId
- **锚定模块**：`Infra/Logging/traceContext.ts`　Gate：G10　类别：ENV / availability　锚点：`static`
- **实测依据**：L0：扫 runInSpan 是否有生产调用者

### `MM-GAP-EVENTSTABLE` — 产品缺失

- **目标/判据**：事件可跨进程回放，而非只有进程内 eventLog
- **锚定模块**：`Infra/Db/migrations.ts + EventBus`　Gate：G13　类别：ENV / availability　锚点：`static`
- **实测依据**：L0：扫这两张表是否有 INSERT 写入方

---

## 使用方式

1. **修一条** → 在矩阵里把该 cell 从 `gap` 改成 `existing-covered` 并换上可解析的锚点；
   守门的**双向一致性规则**会在"债已还但矩阵未转正"时报违规，反之亦然。
2. **确认无法修** → 在 cell 的 `method` 里补上更硬的实测依据（日期 + 代码位置），而不是留"待补"。
3. **本册不是 CI 阻断项**：`gap` 按设计不进 CI 阻断（缺口证明实验），
   但登记册的**条数与矩阵必须一致** —— `npm run bench:metrics` 会校验，不一致即视为陈旧。
