# Agent/17 · Core 层控制论审查（`Src/Core` Cybernetic Audit）

> **本文档定位**：以控制论（受控闭环）视角逐层审视 `Src/Core` 五层——`Loop` / `Middleware` / `Model` / `Decision` / `AgentRuntime`，并追踪其上下游控制接线（`Services/LoopControl`、`Services/Supervision`）。审查对象不是"代码写得对不对"，而是**每条反馈回路的传感器—控制器—执行器是否闭合**。
>
> **审查日期**：2026-10-11（工作区未提交快照）。**本轮未改动任何源代码。**
>
> **锚点记法**：遵循 2026-10-03 校准裁定，以 **文件名 + 符号名** 为主锚点；行号为快照辅助值，允许 ±5 偏差，合入前须复核。
>
> **上游依据**：`Docs/Agent/02-核心架构`（十步序列）、`Docs/Agent/11-循环控制系统`（五类退出 / §2.2 枚举收敛 / §7 可行动失败）、`Docs/Agent/03-Agent编排引擎`（§3.1 编排 / §6 进度追踪）。

---

## 0. 校准说明与标记口径（必读）

沿用项目既有对账口径，本文条目按以下标记分类：

- **⚠️ 未接线**：实现存在于 `Src/`，但**运行期无调用者**（仅被 `index.ts` 再导出或仅被测试引用），对线上行为零影响；
- **⚠️ 未实现**：文档所述能力在代码中不存在；
- **🔧 代码债**：代码违反设计裁定（双源账本、枚举坍缩、伪成功输出等），**只记录现状与待办，不改文档迁就代码**；
- **✅ 已闭合**：经取证确认该回路传感器→控制器→执行器三段贯通，本文列出以免误伤。

> **与既往记录的关系**：`Docs/Agent/11` 与 `Docs/Dev` 已登记"5 个循环中间件 0 注册""配置半数无消费者"等结论。本轮取证的增量价值在于：**给出了断口的控制论归因**（哪一段断开、断开的后果量级），并新增了既往清单未覆盖的 P0-2（安全门生命周期）、P0-3（Token 四源账本与一步滞后）、P1-9（编排模式无增益）。引用旧结论前仍须核代码——审查期间另一调试代理持续改动，既往"零写入/孤岛"类结论已有约 20 项被代码追平。

---

## 1. 系统建模：Core 作为受控系统的分层回路图

被控对象（plant）= LLM + 工具环境；被控量 = 「任务向目标收敛的速率与安全性」。设计意图为三时间尺度嵌套回路：

| 回路 | 时间尺度 | 应然控制器 | 应然执行器 | 实然状态 | 闭合 |
|---|---|---|---|---|---|
| 快环 | 单工具调用 | 审批门 / 限流 / 幂等 / 行为法典 | `toolSafetyGate`、`rateLimiter` | 审批门生效但生命周期失控（P0-2）；限流串扰（P2-12） | ⚠️ 半闭 |
| 中环 | 单轮迭代 | `postSupervision` + `stopRules` + `iterationController` | `shouldContinue` 布尔 | **只有 `iterationController` 在跑**（P0-1） | ❌ 降级 |
| 慢环 | 跨任务/编排 | `progressTracker.detectAllAnomalies` | `SUSPEND`/`EXPEL`/终态回写 | **无任何轮询方**（P1-10） | ❌ 开环 |
| 设定值通路 | 会话级 | 目标重锚 / 失败策略回灌 | `goalReanchor` 注入消息 | 写侧与注册侧双断（P1-7） | ❌ 开环 |
| 人工监督通路 | 任意 | 暂停 / 恢复 / 中止 | `pauseLoop` / `signal` | 仅 `abort` 可达（P1-8） | ⚠️ 分辨率不足 |

**总评**：*前馈充分、反馈残缺*。文档定义的五个反馈子系统中，实际闭合的只有两个（`postSupervision` 的连续错误计数、`iterationController` 的四条判据）。三条断路的成因高度收敛于同一模式：

1. **控制器读"调用方可选的透传字段"**，而生产调用点不填（P0-1、P1-6）；
2. **控制组件是全局模块单例，没有回路作用域**（P0-2、P1-5、P2-12）；
3. **执行器从未注册进管线**（P1-7、P1-10）。

按 Ashby 必要多样性定律衡量：控制器的名义分辨能力（4 种路由模式、7/5 两套退出枚举、3 档风险处置）远大于执行器实际可达的动作集合（本质只有 `continue` / `stop` 二值 + 审批门）。**多样性在断口处被消耗掉**——配置看起来可调，实际不改变被控对象动力学。

---

## 2. 缺陷清单

### P0-1 ⚠️ 未接线 · 主反馈通路断线：五类退出在生产路径不可达

**断口位置**：`runIteration.ts` → `runIteration()` 中 `if (ctx.loopControlSnapshot)`（快照 2026-10-11：约 847 行）是整段 `evaluateStopRules()` 的**唯一入口**。

**取证**：全仓 grep `loopControlSnapshot` 仅命中 `Src/Core/Loop/runIteration.ts` 自身；两个生产调用点均不传该字段——`ipcBridge.ts`（`streamGeneration` 内构造 `iterCtx`，约 1128-1140 行）与 `agentExecutor.ts`（`executeAssignedTask` 内调 `executeLoop`，约 137-145 行）。

**永不评估的判据**（`stopRules.ts`）：

| 判据 | 符号 | 后果 |
|---|---|---|
| 墙钟上限 | `checkLimits.maxWallClockMs` | Loop 级总时长无上界（叠加 P2-15） |
| 工具调用上限 | `checkLimits.maxToolCalls` | 速率维完全无闭环（叠加 P1-6） |
| 硬预算 | `checkHardBudget` | 仅剩滞后的哨兵与 `iterationController` 兜底 |
| 无进展 | `checkNoProgress`（含 `action: switch_strategy`） | 空转无法识别（叠加 P1-5） |
| 风险处置 | `checkRisk` + `riskTriggers` 三档 | FE-070 刚复活的 `pause_and_request_approval`/`rollback_and_abort` 分支不可达 |
| Verifier 成功 | `snapshot.verifierPassed` | 成功判据无法用真验证器（`runVerifierPipeline` 实为仅 `reviewerAgent` 调用） |
| 策略轮换建议 | FE-071（`runIteration.ts` 约 904-916 行） | 位于死路径内部 |

> **加重情节**：同文件注释（约 972-975 行）已自我诊断过这一族的病因——"两个生产调用点都不传该字段 → 该判定在生产路径上从未生效"，但仅对 `consecutiveErrors` 一条做了本地补接（`executeLoop` 里维护 `accumulateConsecutiveErrors`）。其余判据仍悬空。**修复一处而保留了模式**，是本项最需警惕之处。

### P0-2 🔧 代码债 · 安全执行器生命周期失控：ToolSafetyGate 全局按名注册 + 无引用计数注销

**断口链条**：

```
runIteration.ts  executeLoop()          registerMiddleware(safetyGate)        ← Result 返回值被丢弃
runIteration.ts  executeLoop() finally  unregisterMiddleware('ToolSafetyGate')← 全局按名删除
middlewareRegistry.ts registerMiddleware()  重名 → err(...)
middlewareRegistry.ts unregisterMiddleware() findIndex(name) + splice
```

**并发两会话时的失效形式**：

1. Loop B 注册重名失败（返回值被吞，无留痕）→ B 实际复用 A 的闭包，其 `getLoopId()/getIteration()/getTraceId()` **指向 A 的 LoopState** → `effect_journal` 与审批记录归属错位（审计链污染）；
2. A 先结束 → `finally` 删除全局唯一 `ToolSafetyGate` → **仍在运行的 B 失去 FORBIDDEN 硬拒、行为法典检查、审批门、EffectJournal 全套管控**，`shell.exec` / 删除类工具直接裸执行；
3. 反向成立：A 注销的可能正是 B 注册的实例。

**失效取向不一致（🔧）**：`toolSafetyGate.ts` 在 `recordIntent` 失败时 **fail-closed** 拒绝执行（"副作用必须先写 INTENT，写入失败则禁止执行"，取向正确）；而同一控制族在 `registerMiddleware` 失败时 **fail-open** 静默继续。安全层不得以两种相反方向失效。

> 这是本次审查中**唯一在真实并发下即可复现的失控项**，建议列为修复优先级首位（见 E2）。

### P0-3 🔧 代码债 · 观测器冗余 + 传感器一步滞后 → 预算必然穿透

同一被测量「已消耗 Token」存在四处互不校验的独立累加：

| 账本 | 位置 | 更新时机 |
|---|---|---|
| `executeLoop.totalTokens` | `runIteration.ts`（约 967/1011 行） | 每轮末尾 |
| `loopState.iteration.totalTokensConsumed` | `iterationController.ts` `decideIteration` | 每轮判定内 |
| `postSupervision.totalTokensConsumed` | `runIteration.ts` ⑨（约 815 行，`ctx + tokensConsumed`） | 本轮末尾临时求和 |
| `mwCtx.data['tokensConsumed']` | `runIteration.ts` ③（约 375 行） | **本轮开始前的旧值** |

**相位滞后**：`budgetSentinel.ts` 读第 4 个，即反馈信号恒滞后一整轮。单轮可消耗数十万 token（`agentExecutor.ts` 注释自陈实测"单轮 20.8 万 token"）。对高增益对象，一步滞后等于无保护：哨兵在 0.95 临界档读到的仍是 0.95 之前的值，下一轮直接穿越硬预算。

**观测器欠定**：四源无一致性检查，任一源偏差都会静默扩散到退出判定（`iterationController` 用第 2 源，`postSupervision` 用第 3 源）。

### P1-4 🔧 代码债 · 哨兵以"伪造正常输出"执行停机，把预算耗尽归类为任务成功

`budgetSentinel.ts` 在 `ratio >= BUDGET_CRITICAL_THRESHOLD` 时返回 `{ content: '[BudgetSentinel] Token 预算即将耗尽，终止调用。', usage: {0,0} }`——这是一次**看起来完全成功**的模型回答。随后 ⑦ `parseModelOutput` 无 `tool_calls`，⑩ `decideIteration` 命中 `hasOutput && !hadToolCall` → **`exitReason: 'success'`**。

即"预算耗尽"被记为"Agent 给出最终答复，圆满完成"。这与 `runIteration.ts` 非流式分支中 REV-341 修掉的"把供应商 400 伪装成正文"（约 670-675 行注释）是**同一类错误的重演**，只是换了个哨兵。

附带两点：

- `budgetSentinel` 声明 `canShortCircuit: true` 却未返回 `{ shortCircuit }` 标记（契约见 `middlewareRegistry.ts` `executePrePostHooks`），短路语义在契约层被浪费；
- **退出类别坍缩（🔧）**：`runIteration.ts` 的输入 Hook 拦截、前置监管拒绝、流式失败、非流式失败四处短路**全部硬编码 `exitReason: 'risk'`**；`mapStoppedReasonToExitReason` 又把 `human_abort` 折进 `risk`。观测通道信息量丢失，无法据退出分布做参数整定（`Docs/Agent/11` §2.2 已登记为过渡态，属未收口）。

### P1-5 ⚠️ 未接线 · 死循环探测器没有记忆：振荡检测恒假

`fingerprintDetector.ts` 把 `fingerprintHistory` 写入 `ctx.data`，而 `mwCtx` 在 `runIteration.ts` 每轮**重新构造对象字面量**（约 367 行），跨轮不保留 → 历史长度恒 ≤ 1，任何重复输出都无法命中。系统唯一的"极限环"探测因此**结构上不可能成立**。

配套缺口：

- `progressTracker.ts` `TRACKER_THRESHOLDS` 声明了 `loopSimilarityThreshold` / `loopConsecutiveCount`，但**没有对应检测函数**（仅 `checkTimeouts` / `checkStagnation` / `checkConsecutiveFailures`）——**⚠️ 未实现**；
- `iterationController.ts` 的 `no_progress` 判据要求 `consecutiveNoToolCalls >= 5 && !hasOutput`，而现实空转形态是"有输出 + 有工具但无进展"，**永不命中**；
- 真正的进展量 `recentMetrics` 位于 P0-1 的死路径内，无人填充——**积分环节缺失**。

### P1-6 ⚠️ 未接线 · 频率限制传感器恒为 0

`preSupervision.ts` 用 `input.recentCallTimestamps` 过滤窗口计数；两个生产调用点传**字面量 `[]`**（`ipcBridge.ts` 约 1137 行、`agentExecutor.ts:144`），全仓无任何 `push` 写入方 → `RATE_LIMIT_EXCEEDED` 分支不可达。叠加 P0-1 失效的 `maxToolCalls`，**调用速率这一维完全没有闭环**。

### P1-7 🔧 代码债 + ⚠️ 未注册 · 设定值再注入通路断开（目标漂移）

三处叠加，构成"压缩后必须重锚"这条硬约束（`Docs/Agent/02` §4.4）的执行链断裂：

1. **闩锁不清零**：`goalReanchor.ts` 在 `needsReanchor` 为真且 `goal` 存在时直接 `return [reanchorMsg, ...messages]`，**清标记语句位于 goal 缺失的分支之后**，永不执行 → 一旦置位即每轮重复注入；
2. **无置位方**：生产代码无任何位置写 `ctx.data['needsGoalReanchor']`（真实压缩发生在 `runIteration.ts` ⑤ `maybeCompressContext`，它不置位；`Services/Context/truncation.ts` 的写入路径非 Loop 主链路）；
3. **完整版未注册**：`createGoalReanchorControlMiddleware`（`Services/LoopControl/middleware/goalReanchorControl.ts`，含 `goal.originalRequirement` / `immutableConstraints` / `failedAttempts` 回灌）经 grep 确认**仅被 `Tests/LoopControl/loopControl.spec.ts` 引用，`main.ts` 未注册**——与 `Docs/Agent/11` 既往结论"5 个循环中间件 0 注册"一致（`main.ts` 实注册 3 个 builtin + ToolSafetyGate）。

**控制论后果**：设定值只在会话开头前馈一次，随压缩/裁剪单调衰减，且无再注入通道 → 长任务必然 drift。

### P1-8 ⚠️ 未接线 · 人工控制权限分辨率不足：只有 0/1 两档

`loopEngine.ts` 的 `pauseLoop` / `resumeLoop` 只修改 `state.phase`；`runIteration.ts` `executeLoop` 的循环体与 `runIteration` 全程**从不读 `loopState.phase`**，唯一的运行期干预是 `initialCtx.signal?.aborted`；`loopConfig.ts` 的 `LoopConfig.pauseSignal?: AbortController` 零消费者。

即监督级干预只剩**不可逆的 abort**，缺失"暂停—观察—恢复"这条经典 supervisory 通道。附带状态一致性风险：`paused` 之后若调 `startLoop`，会因 `phase !== 'idle'` 返回 err，而循环照常推进——声明语义与运行语义背离。

### P1-9 🔧 代码债 · 编排层开环：拆解计划的约束没有执行器

- `taskDecomposer.ts` 计算并写入 `maxParallelism`（`calculateMaxParallelism`）与 `dependsOn`（`findDependencyIndexes`）；
- `orchestrator.ts` 的 `executeDelegation` / `executeConsortium` 在 `for (const assignment of taskPlan.assignments)` 循环内**无条件同步派发全部子任务**，两个字段均不消费；
- `executeAssemblyLine` 先串好 `curr.dependsOn = [prev.assignmentId]`，随后同样全量派发 → **流水线不是流水线，是扇出**；
- 四种路由模式对真实动力学的唯一差别是创建的 Agent 角色名 → **控制量增益 ≈ 0**（Good regulator 视角：控制器输出未连接到被控对象输入）。

附带：`assignTask(...)` 的 `Result` 在 `executeDelegation` / `executeAssemblyLine` / `executeConsortium` 三处被忽略，状态机拒绝即静默。

> **裁定建议**：依赖与并行度要么接上执行器，要么**先从 `routeDecision.ts` 撤掉不生效的模式差别**。留着一个大而不闭合的内部模型，比留一个小而闭合的模型更坏——它会让文档、测试与后来者都误以为回路已闭合。

### P1-10 ⚠️ 未接线 · 编排无监视回路（慢环缺失）+ 进展信号无发布方

- `progressTracker.ts` 的 `detectAllAnomalies` / `checkTimeouts` / `checkStagnation` / `checkConsecutiveFailures` 经 grep 确认**只被 `Tests/Decision/*` 引用**，无任何定时器或订阅者调用，其输出也从未接入 `stopRules` 的 `riskSignals` 或 `SUSPEND`/`EXPEL` 处置；
- `EventType.TASK_PROGRESS` **只有订阅方（`initProgressTracker`）没有发布方**（Src 内 0 处 publish）→ `currentIteration` / `tokensUsed` 恒 0，停滞判定唯一可用的"进展"信号也进不来；
- 结果：`orchestrator.ts` 的 `activePlans`（模块级 Map）在某子任务永不终态时永久驻留，`tasks` 行停在 `running`，**无看门狗、无告警**。

> 与已修的 REV-333 / REV-339 同族——那些修复补齐了**事件写侧**，本项缺失的是**监视侧**。写侧到位不等于闭环。

### P2 · 一致性与跨回路耦合

| 编号 | 标记 | 问题 | 锚点 |
|---|---|---|---|
| P2-11 | 🔧 | **两套 `LoopState` 不同构**：`Core/Loop/loopEngine.ts` 精简版无 `goal` / `failedAttempts`；`Services/LoopControl/loopState.ts` 完整版有。于是"需要目标与失败历史的控制器"（`goalReanchorControl` / `failureFeedback`）在真实运行态**没有可依赖的状态对象**——控制器的内部模型与被控状态模型不一致 | 两文件 `LoopState` |
| P2-12 | 🔧 | **限流器无回路作用域**：`rateLimiter.ts` 用模块级 `toolCallCounter`，不按 `sessionId`/`agentId` 分桶 → 一个会话跑满窗口会**饿死其他会话**（跨回路串扰） | `rateLimiterMiddleware.execute` |
| P2-13 | ⚠️ | **算出即丢弃的反馈量**：限流返回 `retryAfterMs`，但无任何消费方用它做等待/退避 | `checkRateLimit` |
| P2-14 | 🔧 | **空敏感器（安全侧）**：② 前置监管每轮检测的是**同一个原始 `userInput`**（Hook 与监管入参同源），从不检查模型新产出与工具返回值 → 工具返回值中的间接注入这条真实攻击面无覆盖；`INJECTION_PATTERNS` 仅 5 条关键词 | `preSupervision.ts` |
| P2-15 | ⚠️ | **Loop 级墙钟缺失**：`timeout_ms` 仅被 P0-1 死路径中的兜底 `StopRuleSet` 读取；`modelCaller.ts` `callModel` 在 `options.signal` 存在时**不再挂墙钟**（`combinedSignal = options?.signal ?? timeoutController.signal`，注释自认 REV-025 未收口），而交互路径恰好传入 `abortController.signal` → 单次模型调用也无超时保护 | `callModel` / `executeLoop` |
| P2-16 | 🔧 | **缓存层方波扰动**：`runIteration.ts` `buildStableSystemPrompt` 在 `size > 64` 时 `clear()` 全量清空而非 LRU 淘汰 → 一次性打掉整个会话的前缀缓存收益（与该项目标"前缀稳定 >90%"直接冲突） | `systemPromptCache` |

### ✅ 已闭合回路（勿误伤）

审查同时确认以下通路**真实在环内**，改造时须保持：

1. **连续工具错误回灌**：`executeLoop` 维护 `consecutiveErrors` → `runPostSupervision` 用同一 `accumulateConsecutiveErrors` 判阈值 → 错误正文经 `chatMessages` 回灌给模型（`runIteration.ts` 历史追加含 `tool_calls`/`tool_call_id` 的 REV-341 修复）——**单轮粒度的负反馈确实生效**；
2. **不可逆操作审批门**（单会话场景）：`toolSafetyGate` 的 DANGEROUS+IRREVERSIBLE → `createApproval` + 阻塞 `waitForApprovalDecision` + 超时默认拒绝；
3. **EffectJournal fail-closed**：INTENT 写失败即拒执行；
4. **幂等缓存**：命中即跳过重复执行（副作用层）；
5. **上下文压缩的即时生效**：⑤ 压缩后重建本轮 `messages` 并 `splice` 回写共享历史；
6. **模型调用失败诚实短路**：非流式分支不再把 400 伪装成正文（REV-341）；
7. **迭代边界 checkpoint 写入**：`writeIterationCheckpoint` 每轮末尾原子写（2026-10-04 修复项）。

---

## 3. 改进建议（按"先闭回路，再谈调参"排序）

### 第一批：一处改动激活一批判据（P0 优先）

1. **把 `loopControlSnapshot` 从"调用方可选的透传字段"降级为 `executeLoop` 内部构造的必填视图。**
   在 `executeLoop` 每轮边界用**本地已有量**（`totalTokens`、`consecutiveErrors`、`iter`、`t0`、`toolCalls.length`）组装快照喂给 `runIteration`，并把该字段从 `IterationContext` 的 public 可选面上**移除**（类型层面禁止外部不传）。这是收益/风险比最高的一改：单点改动同时复活 `limits`（含墙钟与工具数）、`budget_hard`、`no_progress`、`risk` 全部判据。
   *验收即 E1；实施前须与 P0-3 的账本归一同步，否则复活的是仍带一步滞后的传感器。*

2. **安全门改为回路作用域。**
   `middlewareRegistry` 注册接口返回**句柄**（`{ name, ownerId }`），注销按句柄而非按名；更彻底的方案是把 `wrapToolCall` 链做成 `LoopState` 实例字段（与 Loop 同生命周期，天然消除并发互删与归属错位）。同时把 `registerMiddleware` 失败改为 **fail-closed**（拒绝起 Loop 并留日志），与 EffectJournal 的失效取向统一。*验收 E2。*

3. **Token 账本归一。**
   以 `loopState.iteration.totalTokensConsumed` 为**唯一累加器**，`executeLoop` 与 `postSupervision` 从它读；`mwCtx.data['tokensConsumed']` 改为**本轮调用后回写**（或让哨兵读 `估算 prompt tokens + 上轮累计`，把滞后从一整轮缩到半轮以内）。加启动/收尾自检断言：四源差异必须为 0。*验收 E3。*

4. **终止类中间件必须走短路通道 + 产出显式退出类别。**
   `budgetSentinel` 不再返回伪正文，改返回 `{ shortCircuit: true, result: { reason: 'budget_exhausted' } }`，`runIteration` 据此产出 `exitReason`。同步把四处硬编码 `'risk'` 拆为 `intercepted` / `pre_supervision` / `model_error`，并兑现 `Docs/Agent/11` §2.2 已登记的收敛方案：**以 `StoppedReason` 为单一事实源，其余再导出**。

### 第二批：给回路装记忆（消除"结构上不可能成立"的探测）

5. 指纹历史与进展指标**存入 `LoopState`**（跨轮），不再依赖每轮新建的 `mwCtx.data`；连续 N 轮同指纹 → 追加 `riskSignals: ['repetitive_output']`，由 `riskTriggers` 决定处置档位。
6. 定义并填充**真实的 `recentMetrics`**：候选度量 = 本轮相对上轮的「文件工作集变化数」（`contextStore` 已有写侧）、「去重后工具调用数」、或「测试通过数」。禁止再用"有无输出"当进展代理指标。
7. `rateLimiter` 计数器 key 改 `sessionId | agentId`；`recentCallTimestamps` 由 `executeLoop` 本地维护并逐轮 push（同时关闭 P1-6 与 P2-12）。
8. 修 `goalReanchor` 闩锁（置位后**无条件**清零）；在 `maybeCompressContext` 成功后写 `loopState.needsGoalReanchor`；`main.ts` 注册 `GoalReanchorControl`。**本条以 P2-11 的两套 `LoopState` 合并为前置**——否则完整版重锚器仍无可依赖的状态对象。

### 第三批：补执行器与慢环

9. `executeLoop` 每轮边界检查 `loopState.phase === 'paused'` 并阻塞等待（落实 `pauseSignal`），与 `abort` 分级——恢复人工监督的三档分辨率（暂停 / 降速 / 中止）。
10. **新增编排监视器**（周期 = `TRACKER_THRESHOLDS.stagnationTimeoutMs / 4`）：调 `detectAllAnomalies` → 命中即发 `TASK_FAILED`/`SUSPEND`/`EXPEL`，并把异常写入对应 Loop 的 `riskSignals`；同时给 `activePlans` 加 TTL 看门狗。进展信号源建议**改为订阅已有的 `AGENT_ITERATION_COMPLETE`**（现成事件，比新建 `TASK_PROGRESS` 发布方更省改动）。
11. `dependsOn` / `maxParallelism` 二选一：在 `subtaskDispatcher` 接上拓扑序 + 并发上限队列；**或**先从 `routeDecision.ts` 撤掉不生效的模式差别（见 P1-9 裁定建议）。
12. `systemPromptCache` 改 LRU 逐出，取消全量 `clear()`。

### 元监控：让"接线未落地"这类缺陷自动暴露（本文最重要的结构性建议）

13. P0-1 / P1-5 / P1-6 / P1-10 四个缺陷有一个共同形态：**代码存在、契约正确、单测通过、运行期零触发**。现有测试体系无法区分"这条断言恒假"与"这条断言从未被调用"。建议：

    - 在 `getLoopSummary()` / 启动自检中输出**每条判据与每个控制组件的实际触发计数**：`stopRules_evaluated`、`approval_gate_invoked`、`fingerprint_hit`、`rate_limit_checked`、`anomaly_poll_invoked`、`middleware_registered_failed`；
    - 规则：**任一项长期为 0 ⇒ 该回路断线**（而非"没触发"）；
    - 该计数表同时作为 `Docs/Agent/11` 与 `Docs/14 参数总典` 中"配置键是否有消费者"的自动证据源（既往结论：204 叶子键中 104 键无引用）。

---

## 4. 实验方案

> **前置约束（项目现状，必读）**：`npm test` 会删真实密钥文件（REV-429 未修）。因此 E1/E5/E9 用**静态取证 + 定向单测**；E2/E3/E4/E6/E7 需真实 Agent 调用时，**先备份 `Config` 下凭据**再以最小入口跑，禁止跑全量测试。
> **合入前复核**：审查与回写期间另一调试代理持续改代码，本文行号与"零调用/未注册"类结论须逐条 grep 复验后再动手。

| ID | 假说（对应缺陷） | 方法 | 指标 | 现状期望（缺陷在） | 修复后期望 |
|---|---|---|---|---|---|
| **E1** | StopRules 不可达（P0-1） | `evaluateStopRules` 入口加临时计数（或测试替身 spy），跑 3 类任务：① `max_iterations=3` 小预算 ② 单轮工具失败 ③ 长任务 | `stopRules_evaluated` 计数 | **= 0** | 每轮 1 次；①的 `exitReason` 由 `max_iterations` 变 `limits` |
| **E2** | 并发下安全门消失（P0-2）⚠️最高优先 | 会话 A/B 并发；A 触发一次不可逆工具并正常结束（走完 `finally`）；A 结束后 B 继续调删除类工具 | B 侧 `APPROVAL_REQUESTED` 事件数、`effect_journal` INTENT 写入数、工具实际执行数；对照组=单会话同操作 | 并发组：**审批 0 / journal 0 / 执行 1**；且 journal 的 `loopId` 指向 A | 两组恒为 审批 1 / journal 1；`loopId` 归属正确 |
| **E3** | 预算一步滞后 + 类别失真（P0-3 / P1-4） | `token_budget=20_000`，构造单轮 >20k 的输出（长文 + 多工具并行） | `exitReason`；终态 `totalTokensConsumed / token_budget` 超支比；四源账本差异 | `success` 且超支比 ≥ 2 | `budget_exhausted`/`budget_hard`；超支比 ≤ 1 轮增量；四源差异 = 0 |
| **E4** | 极限环不被识别（P1-5） | 工具返回值恒定、任务描述诱导"继续"，`max_iterations=20` | 实际跑到轮数、连续轮输出指纹相同率、`fingerprintHistory.length`、Token 消耗、`no_progress`/`risk` 触发数 | 跑满 20 轮、中断 0 次、`fingerprintHistory.length` 恒 1（可直接断言） | ≤ 6 轮内被 `repetitive_output` 或 `no_progress` 中断 |
| **E5** | 暂停不可执行（P1-8） | `startLoop` → 迭代中途 `pauseLoop(state)`（纯内存/单测，无需真实调用） | 暂停后 `state.iteration.current` 是否继续增长 | **继续增长**（无人读 `phase`） | 停在暂停边界直至 `resumeLoop` |
| **E6** | 编排悬挂且无告警（P1-10 / P1-9） | 提交 4 子任务 DELEGATION，令其中一个 Agent 永不 `submitForReview`，观测 5 分钟 | `tasks.status`、`activePlans.size`、`progressTracker` 条目数、`currentIteration`、`anomaly_poll_invoked`、`AGENT_SUSPEND/EXPEL` 事件数 | `running` 永久 + 告警 0 + `currentIteration` 恒 0（`TASK_PROGRESS` 无发布方） | ≤ `stagnationTimeoutMs` 内出告警并落终态；`activePlans` 出册 |
| **E7** | 路由模式对动力学无差别（P1-9） | 同一任务分别走 DELEGATION / ASSEMBLY_LINE / CONSORTIUM（配高耦合 `ComplexityReport`），记录各子任务 `startedAt/completedAt` | 并发峰值 vs `maxParallelism`；`dependsOn` 前置是否先完成（时间轴重叠度） | 三者并发峰**相同**、依赖序不成立 → 定量证明"模式无增益" | ASSEMBLY_LINE 峰 = 1；DELEGATION 峰 ≤ `maxParallelism`；依赖序成立 |
| **E8** | 压缩后目标漂移（P1-7） | 把压缩阈值调低，强制第 3 轮触发压缩；抓取发给 provider 的 `messages` 全文 | 压缩后请求中"原始目标字符串"命中率、「已失败策略」段出现率、重锚消息是否每轮重复 | 目标命中率随轮次衰减、重锚段 0 出现；若手工置位标记则**每轮重复注入**（闩锁未清的直接证据） | 压缩后 1 轮内注入重锚且仅一次；`GoalReanchorControl` 计数 > 0 |
| **E9** | 限流跨会话串扰（P2-12 / P1-6） | 会话 A 以 >`maxToolCallsPerMinute` 连打，同时会话 B 单线程低频调用 | B 的 `RATE_LIMITED_OUTPUT` 次数；`preSupervision` 的 `rateLimited` 触发数 | B 被误伤（共享计数器）；`preSupervision` 侧恒 0（数组永不 push） | B = 0；`rate_limit_checked` > 0 且分桶正确 |
| **E10** | 元监控可用性（建议 13） | 在真实任务上采样上述全部计数器，形成"判据触发矩阵" | 各计数器值；对照 `Configs/*.json` 叶子键消费者清单 | 多项恒 0（即断线清单） | 除显式关闭项外无恒 0 计数器 |

**收尾门槛（项目既有约定：架构变更后至少三轮真实 Agent 调用测试）**

E1–E10 之后，取 3 个真实多轮任务（一个 DIRECT、一个 DELEGATION、一个含不可逆工具），逐条核对：

1. `exitReason` 分布是否与实际终止原因一致（无"伪 success"）；
2. 审批事件数 ≥ 不可逆工具调用数，且 `loopId` 归属正确；
3. `effect_journal` 行数与非 SAFE 工具执行数一致；
4. Token 四源账本差异 = 0；
5. `stopRules_evaluated` = 轮数 × 1；
6. 构建与 lint 未回归（注意既往 CI 已知项：eslint resolver 缺失 / 越层 8 errors / layer-check 崩溃 / coverage 门禁产物不存在——不得因本轮改动新增）。

---

## 5. 声明与后续动作

- **本轮未改动任何源代码**，仅读取与静态取证 + grep 接线核对；结论以 2026-10-11 工作区未提交快照为准。
- **P0-2** 的两处证据（`middlewareRegistry` 模块级数组 + `executeLoop` 的 `finally` 按名注销）与并发改动无关，但因存在并行编辑，合入前请按锚点复核。
- 本文条目按项目口径应逐条登记进 `Docs/CHANGELOG.md`（唯一事实源），并在 `Docs/Agent/11` 与 `Docs/Agent/03` 对应章节加"2026-10-11 控制论审查"交叉引用。**该登记动作待用户指示**（当前 `Docs/CHANGELOG.md` 正被另一代理修改，直接写入有冲突风险）。
- 建议的修复批次顺序：**第 1 批（1→4）先做**，因第 2、3 批的多条改进依赖第 1 批把主反馈通路接通后才有观测意义；P2-11 的 `LoopState` 合并应作为 P1-7 的前置任务立项。
