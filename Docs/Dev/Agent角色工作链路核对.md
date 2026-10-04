# Agent 角色工作链路核对（2026-10-04）

> **目的**：梳理全部 Agent 角色（9 身份）的完整工作链路，逐段检查逻辑自洽性。
> **方法**：对每个角色追踪 **定义源 → 创建/赋权点 → 执行驱动 → 工具可见性 → 治理门 → 事件/持久化** 六段链路；以运行期代码为唯一事实源，文档/提示词仅作对照。
> **口径**：生产调用点 = 非测试代码的引用；"零调用/仅测试"均已 grep 全仓复核。当日门禁：根 `vitest` 1189/1189（93 文件）、四套 `tsc` 0 错误（构成"函数存在且测试通过"的背景事实——**测试全绿不代表端到端接线成立**）。
> **配套**：本轮发现的缺陷已登记 `Docs/Client/02-前端改造基础/前端验收缺陷清单.md` **FE-041 ~ FE-051**（2026-10-04 治理层核查新增缺陷）。
> **修复进展注记（2026-10-04 晚）**：FE-050（§2.2/§2.3 编排三链路）已接线完成——派发 → 评审 → 聚合，
> `Tests/Decision/orchestrationPipelines.spec.ts` 9 项端到端 + 全量 1214 测试通过；其余条目进展见清单状态列。**正文保持核查当日快照原样，未改动。**

---

## 一、角色总表（9 身份）

| 角色 | 层级 | 信任级别<br>(security.json) | 提示词标注 | 生产创建点 | 执行驱动 | 工具权限<br>(requiredRoles 口径) | 治理职责 | 链路现状 |
|---|---|---|---|---|---|---|---|---|
| `user`（人类所有者） | owner | 非 UserRole | — | 人类本体 | — | 不经工具层 | 审批池常驻决策方；跨域唯一标识 | ✅ |
| `prime_director` | L1 入口级 | `userRoles` → L1 | ⚠ 误标 L0 | ipcBridge 单例 + orchestrator×4 | ✅ **唯一真实驱动**（executeLoop） | READ+EXEC+DANGEROUS | 无（L1 不自审） | ✅ |
| `partner` | L1 入口级 | `userRoles` → L1 | ✅ L1 | orchestrator CONSORTIUM | ❌ 无 loop 驱动 | READ+EXEC+DANGEROUS | 无 | 🟡 创建后无人驱动 |
| `worker` | L2 执行级 | `externalRoles` → L2 | ⚠ 误标 L1 | orchestrator DELEGATION / ASSEMBLY_LINE | ❌ 无 loop 驱动 | READ+EXEC+DANGEROUS | 无 | 🟡 同上 |
| `reviewer` | L2 执行级 | `externalRoles` → L2 | ⚠ 误标 L1 | ❌ **无生产创建点** | ❌ | READ + ORCHESTRATOR(空转) | 内容审查（非治理，G-06 裁定） | 🟥 链路未接线 |
| `assembly_node` | L2 执行级 | `externalRoles` → L2 | ⚠ 误标 L1 | ❌ **无任何创建点** | ❌ | READ（词表备好） | 无 | 🟥 专设角色悬空 |
| `regulator` | L0 治理级 | `systemRoles` → L0 | ✅ L0 | governanceProvisioning 按需（审批池） | ❌ | READ only | 行为监管（规则/干预/广播） | 🟡 见 §2.4 |
| `auditor` | L0 治理级 | `systemRoles` → L0 | ✅ L0 | governanceProvisioning 按需（审批池） | ❌ | READ only | 副作用审计（巡逻/调查/冻结） | 🟡 见 §2.4 |
| `arbitrator` | L0 治理级 | `systemRoles` → L0 | ✅ L0 | 启动初始化（`initArbitratorPool`）+ 立案扩容 | ❌ | READ+EXEC+DANGEROUS | 冲突仲裁（裁决/停职/沉律） | 🟡 见 §2.4 |

> 层级判定源：`Infra/Roles/roleVocabulary.ts`（L1=PD/Partner；L2=worker/reviewer/assembly_node；L0=regulator/auditor/arbitrator）与 `Configs/security.json trustLevels` 三组**完全一致** ✓（有一致性测试 `Tests/Governance/roleVocabulary.spec.ts` 锁死）。
> **提示词"信任级别"标注 4 处不一致**（PD 标 L0、worker/reviewer/assembly_node 标 L1）——详见 §4.2。
> 提示词运行期**无加载器**（`Prompts/roles/*.md` 全仓无运行时消费者，已是既知校准结论），故标注错误仅影响文档一致性；其头部参数行（温度/迭代/预算）与 `Configs/loopConfig.json roleOverrides` **8/8 全一致** ✓。

---

## 二、运行时链路全景（5 条）

### 2.1 聊天链路 —— ✅ 唯一端到端运行的链路

```
前端消息 → ipcBridge（getOrCreateEntryAgent 单例）
  → createLoopState/createLoopConfig（roleOverrides 生效）
  → executeLoop（10 步：①输入 ②前置监管 ③中间件 ④上下文 ⑤惰性监管 ⑥模型 ⑦解析 ⑧工具 ⑨后置监管 ⑩迭代判定）
  → 工具可见性：buildToolHeader(agentRole) 按 requiredRoles 过滤
  → 工具执行：toolRegistry.execute + toolExecutor 双点复核 requiredRoles（借壳防护）
  → toolSafetyGate 中间件（wrapToolCall，priority 1）：
       FORBIDDEN 硬拒 → 幂等缓存 → DANGEROUS+IRREVERSIBLE → 阻塞式审批
  → 事件：AGENT_STREAM_CHUNK / TOOL_CALL_* / ITERATION_COMPLETE →IPC→ 前端
  → 消息与 AI 组件落库（ai_events / messages）
```

- **角色恒为 `prime_director`**（`ipcBridge: agentRole: 'prime_director'` 硬编码）——当前产品形态下所有对话都跑在 L1 入口角色。
- 唯一完全接通的 L0 治理链路 = **审批**（§2.4）。

### 2.2 任务编排链路 —— 🟡 规划完、执行断（FE-050 / FE-006）

```
POST /api/tasks → receiveTask(taskApi)
  → assessComplexity → decideRoute（CONSORTIUM > ASSEMBLY_LINE > DELEGATION > DIRECT > 兜底）
  → decomposeTask → createAgent（director/worker/partner）→ assignTask + 注册进度
  → 【断】无人驱动这些 agent 的 loop；subtasks 表无派发器
  → taskApi 直接把任务状态置 completed（实为"规划完成"）
```

- 路由侧：DIRECT/DELEGATION/ASSEMBLY_LINE/CONSORTIUM 四种编排骨架**已实现**（创建 agent + 分配 + 事件）；`LITIGATION`/`REGULATION` 返回 `err('尚未实现（S12）')`。
- 编排器创建的 agent 全部止步于 `assigned`（与 `agent.recruit` 的 `dispatch:'pending'` 同源）。
- 附加发现：**(a)** ASSEMBLY_LINE 节点用 `worker` 角色创建（专设 `assembly_node` 备而未用）；**(b)** CONSORTIUM 用 `partner` 角色承载执行 assignment——与 partner 提示词"不直接执行/评审把关"定位冲突，且 partner 无评审通道（§4.2）；**(c)** DIRECT 模式语义"Director 直接执行"与 PD 提示词"不直接执行"冲突（Phase 0-2 实为仅标记）。

### 2.3 评审链路 —— 🟥 未接线（FE-050）

```
设计：Worker 完成 → agent.submit_review（工具）→ submitForReview（运行时）→ Reviewer 审核 → reviewSubmission → Director 侧 isTaskApproved 才能标记成功
实际：工具=桩（NOT_IMPLEMENTED「待 S9」）；performReview 仅测试调用；
      无 reviewer 生产创建点；submitForReview/reviewSubmission 硬编码 worker↔reviewer；
      评审记录 pendingReviews 仅内存（无写穿，重启即失）
```

- 核心规则"**Worker 不可自行宣告完成**"在运行期**无实现路径**。

### 2.4 治理链路（L0 三权 + 审批）

| 链路 | 触发/入口 | 状态 |
|---|---|---|
| **审批**（阻塞式 ApprovalGate） | toolSafetyGate（每 Loop 注册）→ 按请求方层级建池（L2→user/L1/L0 任意两方；L1→user+L0；请求方角色剔除；法定人数 2 + 身份级去重）→ 决策池治理角色按需创建真实 Agent（`ensureAgentsForRoles`）→ `decideApproval`（池校验/系统角色只能拒/超时默认拒）→ 写穿落库 | ✅ **完全接通**（含治理留痕 `governance_records`） |
| **审计**（auditor） | `resourceAuditBureau.{investigate,runPatrol,unfreeze}` / `freezeManager`——函数齐、守卫齐（audit.* 统一留痕） | 🟥 **无生产触发入口**（无 REST/定时器；仅测试调用） |
| **监管**（regulator） | ①`preSupervision`（主循环②步，每轮执行 ✓）②`postSupervision`（⑨步 ✓）③`regulatoryAuthority.{escalateDeadlock,emergencyIntervene}` / `broadcastChannel.broadcast`——守卫齐 | 🟡 ②⑨ 接通；③ **无生产触发入口** |
| **仲裁**（arbitrator） | 池初始化 ✓（main.ts ⑦.4c）；fileCase→recordConflict+evaluateScaling→resizeAuxiliaryPool ✓（闭合）；`executeFullArbitration`/`reasonVerdict`/`issueSuspension` 守卫齐 | 🟡 立案无生产触发（fileCase 仅被 executeFullArbitration 调，后者零生产调用）；空闲回收/自动监测未接线（FE-049） |

> 治理三权（审计/监管处置/仲裁）当前是"**服务层全副武装、运行期入口悬空**"状态——与 LITIGATION/REGULATION 编排未实现（S12）互相印证。

### 2.5 事件与持久化（角色相关）

- 事件：`AGENT_RECRUITED / TASK_ASSIGNED / TASK_DECOMPLETED / APPROVAL_* / ARBITRATION_* / GOVERNANCE_ACTION_RECORDED / CONFLICT_DETECTED` 等经 EventBus → ipcBridge 全量转发 → 前端 store。
- 落库：`agents`（招募约束/白名单/预算，upsertAgent）；`governance_records`（治理留痕，写穿）；`approvals`（写穿 + 重启 expire）；`messages/ai_events`（对话）；**`subtasks` 表存在但零写入**；评审记录仅内存。

---

## 三、逐角色链路明细

**`user`（owner）**：人类本体，不经 UserRole/工具层。链路：前端点击审批 → `approvalApi.decide` → 身份验真（方案 A 本地活动账号绑定 ✓；方案 B 服务端验真 **HTTP 链路死代码**，FE-041）→ 入池权重 1。

**`prime_director`（L1 入口）**：创建（ipcBridge 单例 + orchestrator 四模式）→ 驱动（executeLoop 10 步，**运行时唯一活跃角色**）→ 工具（READ/EXEC/DANGEROUS 全通；`agent.recruit` 仅 PD/Partner 可用）→ 治理门（危险工具走审批，作为 L1 请求方入池规则=user+L0）→ 产出（消息落库 + 事件流）。判定：**链路完整**；缺口=信任级别标注误（L0→应 L1）。

**`partner`（L1 入口）**：创建（orchestrator CONSORTIUM）→ ❌ 无驱动 → 工具（同 PD）→ 判定：**创建后悬置**；且现行编排让其承接执行 assignment 与提示词定位（协同推理/评审）冲突（FE-050 关联）。

**`worker`（L2 执行）**：创建（orchestrator DELEGATION/ASSEMBLY_LINE；`agent.recruit`）→ ❌ 无驱动 → 工具（READ+EXEC：file.write 走 EffectJournal；shell.exec 走审批）→ 治理门（作为请求方=L2 池）→ ❌ 评审出口（submitForReview 无工具路径）。判定：**执行与验收双断**。

**`reviewer`（L2 执行）**：❌ 无创建点 → ❌ 无驱动 → 工具（READ；EXEC 不含——不能写文件 ✓ 合理）→ 设计上对接 `performReview`（规则版默认接受，LLM Judge 未接）。判定：**角色全链悬空**（FE-050）；提示词"Verifier L1-L4 管线"未实现（Phase 0-2 态）。

**`assembly_node`（L2 执行）**：❌ 零创建点（词表/提示词/招募白名单/工具 requiredRoles 全备）→ ASSEMBLY_LINE 模式实际以 `worker` 顶替。判定：**专设角色悬空**（§4.2）。

**`regulator`（L0 治理）**：创建（审批池按需；`ensureAgentForRole` 归一化掉 `regulatory_authority` 别名）→ 工具（READ only：**可观察不可执行副作用** ✓ 对齐"裁判不做运动员"）→ 治理门（`requireGovernanceRole` 放行/拒绝双留痕）→ 服务（addBehaviorRule/removeBehaviorRule/escalateDeadlock/emergencyIntervene/broadcast 守卫齐；**缺口**：`issueFinalVerdict` 无守卫 FE-042、`updateVersion` 无守卫 FE-043）→ 判定：**服务链路自治，运行期触发悬空**。

**`auditor`（L0 治理）**：创建（审批池按需）→ 工具（READ only ✓）→ 服务（investigate/runPatrol 守卫齐；monitorAgent 自动冻结以 auditor 透传；checkAutoUnfreeze 系统路径绕过守卫为设计豁免）→ 判定：同上，**无运行期巡逻定时器**。

**`arbitrator`（L0 治理）**：创建（启动池初始化 + 立案驱动扩容；池位绑定真实 Agent）→ 工具（READ+EXEC：**含 shell.exec 取证**——工具层未再分审计/执行边界，属设计取舍）→ 服务（reasonVerdict/issueSuspension/consolidateKnowledge 守卫齐；`executeFullArbitration` 无 actor 参数 FE-047）→ 判定：**池与守卫齐、触发链断**（FE-049 + 立案无入口）。

---

## 四、自洽性检查结果

### 4.1 🔴 链路级断点（阻断"多 Agent 闭环"的实现）

| # | 问题 | 影响 | 对应 |
|---|---|---|---|
| 1 | 评审链路未接线（工具桩 + 无创建点 + 仅测试调用 + 硬编码 worker↔reviewer） | "Worker 不可自行宣告完成"规则无实现路径 | FE-050 |
| 2 | 子任务派发未实现（subtasks 零写入；编排创建 agent 后无人驱动） | 任务 API 的 completed 名不副实 | FE-050 / FE-006 |
| 3 | 结果聚合未接线（mergePhase/aggregateResults 零调用） | 多 Agent 产出无合并通道 | FE-050 |
| 4 | 治理三权（审计巡逻/监管处置/仲裁立案）无生产触发入口 | L0 服务"武装但悬空" | §2.4；仲裁侧 FE-049 |

### 4.2 🟡 角色-资源级不自洽（同域角色口径冲突）

| # | 问题 | 详情 | 建议 |
|---|---|---|---|
| 1 | **提示词"信任级别"标注 4 处错误** | `prime_director.md` 标"L0（系统级）"实为 L1；`worker/reviewer/assembly_node.md` 标"L1（用户级）"实为 L2（`security.json externalRoles` + `roleVocabulary L2_ROLES`） | 改提示词标注为 L1/L2；顺带核对 `Docs/Agent/10 §3.2` 措辞 |
| 2 | **ASSEMBLY_LINE 模式用 `worker` 顶替 `assembly_node`** | 专设角色全备（词表/提示词/招募白名单/工具 requiredRoles）但零创建；若为有意简化需在 Docs/Agent/03/13 正式注销该角色 | 编排改 createAgent({role:'assembly_node'}) 或文档注销 |
| 3 | **CONSORTIUM 让 `partner` 承接执行 assignment** | partner 提示词定位"协同推理/方案评审/质量把关（不直接执行）"；且 partner 无评审出口（submitForReview 拒非 worker） | 明确 partner 在 CONSORTIUM 的职责=方案裁决（对应各域 assignment 的"输入"而非"产出"），或改派 worker |
| 4 | **评审通道硬编码 worker↔reviewer** | `submitForReview` 拒非 worker；`reviewSubmission` 拒非 reviewer | 接线评审链时把角色校验与"是否可提交"解耦（如按 assignment.assignedAgentId 判定） |
| 5 | DIRECT 模式语义冲突 | "Director 直接执行" vs PD 提示词"不直接执行具体编码/文件操作"（Phase 0-2 实为仅标记） | 接线时明确 DIRECT=PD 亲自跑 loop 或改路由语义 |

### 4.3 🔵 工程级收敛项（不影响当前行为，防埋雷）

- 工具可见性双轨：生产用 `requiredRoles`，`trustLevels` trust×danger 矩阵零生产消费；若接入将使 L2 无法写文件（FE-051）。
- `routingRules.json` 配置化未接线（`updateRoutingRules` 零调用；Docs/Agent/03 §3.3 已记）。
- LITIGATION/REGULATION 编排未实现（S12，`receiveTask` 显式 err）。
- 悬空常量：`GOVERNANCE_TOOL_ROLES` / `ORCHESTRATOR_ROLES`（FE-048）；`executeFullArbitration` 无 actor（FE-047）；`issueFinalVerdict`/`updateVersion` 无守卫（FE-042/043）；方案 B 身份验真 HTTP 死代码（FE-041）；治理台账内存层属主隔离缺位（FE-044）。

### 4.4 ✅ 一致的正例（防误伤，已有测试锁）

- `loopConfig.json roleOverrides` × 8 角色 × 3 参数（温度/迭代/预算）与提示词头部 **8/8 全一致**。
- `security.json trustLevels` 三组与 `roleVocabulary` 分层**完全一致**。
- 两套词表（执行域 `regulator` ↔ 审批域 `regulatory_authority`）由 `roleVocabulary` 双向别名 + 一致性测试锁死；G-11 赋权守卫双入口（agentFactory/agentRegistry）。
- 审批池层级规则（L2→任意两方 / L1→user+L0 / 请求方剔除 / 法定人数 2 / 身份去重）已在 `governanceGuard.buildApprovalDeciders` + `approvalGate.countDistinctRoleMatches` 落实。
- 工具执行借壳防护（toolRegistry + toolExecutor 双点复核 requiredRoles）、DANGEROUS 不含 auditor/regulator、READ 全员含 L0 —— 与"裁判不做运动员"一致。

---

## 五、结论与建议

1. **当前运行期的真实故事线只有一条**：用户 ↔ `prime_director` 单 agent 对话链路（+ 审批治理门）。其余 8 个角色的"多 Agent 世界"目前是**服务层与词表层已建成、编排执行层未接线**的状态（S9/S10/S12 未完成）。
2. **逻辑自洽性的主要矛盾集中在两处**：①"角色词表/提示词/信任级别"三份口径中，词表与 config 一致、提示词标注有 4 处历史错误；②"编排设计（谁创建、谁驱动、谁验收）"与运行期实现断链（FE-050 是总闸）。
3. **建议修复顺序**：先文档口径（提示词标注 4 处 + ASSEMBLY_LINE/partner 定位二选一裁定）→ 再 FE-050 三段接线（派发 → 评审 → 聚合，每段端到端测试）→ 最后 L0 三权触发入口（随 S12 编排）。
4. 本文所有结论均已按"定义→构造点→消费者"三段法核实；与 FE-041 ~ FE-051 条目互为证据。
