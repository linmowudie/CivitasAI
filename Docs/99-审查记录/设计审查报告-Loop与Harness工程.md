# Civitas-AI 设计审查报告：Loop Engineering × Harness Engineering 视角

> **审查基准**：不是本仓库 skill 内部规范，而是 2026 年业界公开的 **Loop Engineering**（arXiv 2608.21884 / CSDN 2026-09 / Anthropic Building Effective Agents / OpenAI Agents SDK）与 **Harness Engineering**（awesome-harness-engineering / Codex App Server / Claude Agent SDK / Pi pi-agent-core / LangChain Deep Agents Tuning）共识实践。
>
> **审查对象**：`Docs/01` ~ `Docs/11` 共 11 份设计文档。
>
> **审查日期**：2026-09-13 · **版本**：v1.0

---

## 0. 结论摘要

| 维度 | 状态 | 说明 |
|------|------|------|
| 架构分层完整性 | ✅ 良好 | 五层 / 事件驱动 / 角色建模扎实 |
| 多 Agent 协作建模 | ✅ 良好 | 6 种路由 + 3 类治理机制完备 |
| 数据模型与持久化 | ✅ 良好 | 3 库 14 表结构清晰 |
| **Loop 控制系统** | 🔴 **严重缺失** | 缺 Verifier 分层、Stop Rules、失败反馈协议、Action Fingerprint |
| **状态与上下文分离** | 🔴 **严重缺失** | Context ≠ State 未落实，压缩即丢状态风险 |
| **Durable Execution** | 🔴 **完全缺失** | 进程重启无法从最后成功步续接 |
| **Maker-Checker 分离** | 🟠 **部分违反** | Director 兼任规划+评判；Worker 自证完成 |
| **并行工作区隔离** | 🟠 **规范未强制** | 只提沙箱未提 worktree/lock |
| **触发防风暴** | 🟠 **未设计** | 无去重键、冷却、并发上限 |
| **双预算治理** | 🟠 **只设硬阈值** | 无软预算→降模型；无每轮信息增益度量 |
| **人工审批门** | 🟠 **缺具体机制** | 只写"升级人工"无审批队列实现 |
| **中间件循环级守卫** | 🔴 **缺失 5 类** | 无进展检测 / 上下文重锚 / 换策略 / 幂等 / 成本预警 |

**总评**：当前设计是一个**优秀的多 Agent 协作架构文档**，但**尚未达到 Loop Engineering 所定义的"L2 受控闭环"成熟度**——按 arXiv 成熟度模型评级为 **L1.5**（有工具循环 + 有中间件雏形，但缺可验证目标 / 独立验证器 / 外部状态 / 收敛控制）。

必须在开工前补齐 4 份关键子系统：**循环控制系统 / 状态与检查点 / Durable Execution / 失败反馈协议**。

---

## 1. Loop Engineering 七部件对照审查

业界共识（CSDN 长文 §3.2 + OpenAI Practical Guide）：一个生产级 Loop **必须同时具备 7 个部件**，缺一即退化为自动化脚本。

| # | 部件 | 业界定义 | 当前设计（01~11） | 差距 |
|---|------|---------|-----------------|------|
| ① | **Trigger** 触发器 | 事件/定时/人工触发，含去重键+冷却+并发上限 | 01 提及"用户任务提交"；02 有 InputReceived | 🔴 **无去重键/冷却/幂等 ID**，重复触发即雪崩 |
| ② | **Goal** 可验证目标 | 终态必须可机器判定（测试通过/Schema 满足/清单覆盖） | 03 ComplexityReport + TaskAssignment.outputSchema | 🟠 **仅有 Schema 层，缺"验收清单"层**（比如：秒杀系统 = QPS≥3000 通过压测） |
| ③ | **Policy/Agent** 决策器 | 单/多 Agent，Planner/Worker/Reviewer 角色分离 | 01/02/03 完整 | ✅ |
| ④ | **Tools/Environment** 执行器 | 输入结构化、输出可解析、错误可区分、动作幂等、高风险审批 | 11 有危险分级；02 有工具注册 | 🔴 **无幂等键；工具返回格式未强制 `{status,recoverable}`** |
| ⑤ | **Verifier** 验证器 | **四级分层**：硬验证 → 规则 → 独立 LLM Judge → 人工门 | 03 QualityInspector（LLM 打分）；05 仲裁庭 3-LLM | 🔴 **只覆盖第 3 层，第 1、2、4 层完全缺失**（最严重的漏洞） |
| ⑥ | **State** 外部状态 | 长期事实持久化：目标/阶段/已完成/失败历史/预算/产物路径 | 07 SharedMemory；10 SQLite | 🟠 **State 与 Context 混用**，压缩时状态可能被摘要掉 |
| ⑦ | **Stop Rules** 停止规则 | **四类独立退出**：成功/轮次时间/成本/无进展/风险 | 03 定义"3 次交付失败"；11 有 error/fatal/panic | 🔴 **缺"无进展"退出**（连续 K 轮指标不改善）；缺**软预算退出** |

**判定**：七部件中 **⑤ Verifier 与 ⑦ Stop Rules 是致命缺失**，直接导致系统进入业界的"失效模式一（目标不可验证）"和"失效模式四（重复动作）"。

---

## 2. Harness Engineering 六钩子中间件对照

`awesome-harness-engineering` 引用 LangChain AgentMiddleware 的 6 个钩子，作为业界事实标准：

```
before_agent → before_model → wrap_model_call → wrap_tool_call → after_model → after_agent
```

| 钩子 | 当前设计 | 差距 |
|------|---------|------|
| before_agent | 02 "会话初始化" | ✅ 覆盖 |
| before_model | 02 "前置监管" + "上下文注入" | ✅ 覆盖 |
| **wrap_model_call** | 未定义 | 🔴 无法拦截重试/降级/评分 |
| **wrap_tool_call** | 11 有危险分级但无拦截器链 | 🟠 未串联幂等、审批、限流 |
| after_model | 02 "后置监管" | ✅ 覆盖 |
| after_agent | 02 "会话归档" | ✅ 覆盖 |

**判定**：需要在 02 补齐 **`wrapModelCall` / `wrapToolCall`** 两个环绕钩子，其他 Loop 级守卫挂在 `wrapModelCall` 上。

---

## 3. Loop 五大失效模式 × 当前设计命中情况

**（来源：CSDN Loop Engineering §8 + frognew Agent Loop §失效模式）**

### 🔴 失效一：目标不可验证，系统永远不知道何时完成

- **业界处方**：把目标写成**可机器执行的检查清单**；无法形式化的至少三层（硬约束 + Rubric + Human Gate）。
- **当前设计**：`TaskAssignment.successCriteria` 只有"评分≥60"这一条 LLM 主观判定。
- **命中位置**：`03-Agent编排引擎设计.md §4.3 QualityInspector`
- **修复**：见 §5.1 补丁

### 🔴 失效二：生成者自评，错误被自洽放大

- **业界处方**：**Maker-Checker 分离**——产出与评判由不共享上下文的不同角色/不同模型承担。
- **当前设计**：
  - Worker 交付后 Director 用 LLM 打分——同一 trace 上下文，Director 会受 Worker 表达惯性影响；
  - `UNABLE_TO_COMPLETE` 由 Worker 自己上报——Worker 可能虚假宣告完成；
  - 复杂度自评 `confidenceScore` 也是 LLM 自证。
- **命中位置**：`03 §4.3` + `02 §Agent 生命周期状态机`
- **修复**：见 §5.2 补丁

### 🔴 失效三：上下文漂移，循环越跑越偏

- **业界处方**：**每轮从外部 State 重建核心目标与不可变约束**；对上下文做高信号选择；定期从原始 Spec 重新锚定。
- **当前设计**：02 只有 S/L/M/H 分区，未定义"目标重锚"；Worker 一旦进入 30 轮工具调用，原始 `TaskAssignment.requirement` 早已被工具结果挤出可见区。
- **命中位置**：`02 §上下文分区` + `07 §SharedMemory`
- **修复**：见 §5.3 补丁（新增 GoalReanchorMiddleware）

### 🔴 失效四：重复动作与局部循环

- **业界处方**：**Action Fingerprint** 记录 + 已尝试策略账本 + 换策略而非重试。
- **当前设计**：skill 定义了"相邻 3 次工具（名+参数哈希）相同 → 停止"，但我 11 份文档里**只在 06 监管部分简单提到 3 次循环**，**没有"已尝试策略账本"，没有"换策略机制"**。
- **命中位置**：`06 §异常消耗检测`
- **修复**：见 §5.4 补丁

### 🔴 失效五：自治范围过大，错误直接作用于生产

- **业界处方**：最小权限 + 沙箱 + **草稿态（shadow write）** + **审批门** + 速率限制 + 可回滚。
- **当前设计**：11 有危险四级分类，但**没有具体的"审批队列 / 草稿态 / dry-run / 双人复核"实现设计**。仲裁庭有类似结构但仅限冲突解决。
- **命中位置**：`11 §工具危险分级`
- **修复**：见 §5.5 补丁

### 🟠 额外：错误传播（frognew 六失效之六）

- 某轮的错误被后续轮次当作事实前提，上下文中累积。
- **当前设计**：07 有 WriteGuard 拦截冲突，但**未拦截"自己上轮错误结论被自己引用"**（self-reinforcing hallucination）。
- **修复**：见 §5.3 补丁（配合 GoalReanchor 定期从原始数据源校验）

---

## 4. Harness 关键实践对照

### 4.1 Reasoning Sandwich（LangChain Deep Agents）

> 最强模型集中在**规划阶段**与**验证阶段**，中间执行用便宜模型。

- **当前设计**：`11 modelRouter.json` 有 directorModel / workerModel 分离，但**QualityInspector / ComplexityAssessor / Arbitration 都未指定独立强模型**。
- **修复**：见 §5.6 补丁

### 4.2 Durable Execution（第五阶段循环）

> Matt Van Horn：进程迟早会死。恢复意味着从上一个成功步骤续接，而不是从头开始。

- **当前设计**：**完全缺失**。10 §数据生命周期 只讲归档，不讲运行中的 checkpoint。
- **修复**：新增 `13-持久执行与恢复`

### 4.3 并行工作区隔离

> 并行 Agent 必须隔离 workspace：Git worktree / 沙箱 / 租户隔离 / 临时数据库 / 锁 / 版本号。

- **当前设计**：11 §沙箱隔离 只讲"文件/网络/进程"三维，未讲 **Workspace Lock** 与 **文件级乐观锁**。
- **命中位置**：`07 §GlobalWorkspace`
- **修复**：见 §5.7 补丁

### 4.4 Context ≠ State

> State 是长期事实，必须持久化、结构化、有版本；Context 是当前一轮从 State 中挑出来给模型看的。

- **当前设计**：07 的 `SharedMemory` 里 `messages` 与 `task_context` 一起塞入 `GlobalWorkspace`，压缩时会互相污染。
- **修复**：见 §5.3 补丁（拆 StateStore / ContextBuilder）

### 4.5 反馈必须是"可行动的失败信息"

> 最差的反馈是"没通过，请再试一次"；最好的反馈是"test_x 仍失败，预期 401 实际 500，栈顶 auth/service.py:184，已试过方案 A/B"。

- **当前设计**：03 §4.3 QualityInspector 只返回 `score: number`；重试消息只有 `TASK_FAILED: reason string`。
- **修复**：见 §5.8 补丁（FailureFeedback 结构化协议）

### 4.6 触发防风暴

> 一个重复告警可能同时启动几十个 Agent 对同一资源冲突操作。生产系统必须考虑：去重键 + 冷却时间 + 幂等 ID + 优先级队列 + 并发上限。

- **当前设计**：无。
- **修复**：见 §5.9 补丁

### 4.7 双预算（soft / hard）

> 软预算触发降级（换便宜模型、减并行、请求审批）；硬预算触发立即停止。

- **当前设计**：04 Token 经济只有"预算耗尽 → 停止"，无软阈值。
- **修复**：见 §5.10 补丁

### 4.8 Intent Debt / Comprehension Debt

> Agent 系统越自主，越要把稳定意图沉淀成 Skill / Spec / 决策记录；越要设计"人类理解机制"：关键变更摘要、ADR、可审计 Trace、定期 Review。

- **当前设计**：01~11 完全没有 `Skills/` 目录、没有 ADR 机制、没有人类 Review 队列。
- **修复**：见 §5.11 补丁

---

## 5. 修复方案索引

### 🔴 优先级 P0（不修复不能开工）

| 补丁 | 目标问题 | 修复方式 | 交付物 |
|------|---------|---------|--------|
| §5.1 | 目标不可验证 | 引入 **Verifier 四级分层**协议 | 新增 `12-循环控制系统设计.md §3` |
| §5.2 | 生成者自评 | **Maker-Checker 分离**：独立 Reviewer Agent + 不同模型 | 修订 `03 §4.3` |
| §5.3 | 上下文漂移 | **GoalReanchor** + State/Context 分离 | 新增 `12 §4` + 修订 `07` |
| §5.4 | 重复动作 | **ActionFingerprintLedger** + 策略账本 + 换策略 | 新增 `12 §5` |
| §5.5 | 自治过大 | **HumanGate 审批队列** + 草稿态 + 回滚 | 新增 `12 §6` + 修订 `11` |
| §5.12 | Stop Rules 缺失 | 四类独立退出（成功/上限/成本/无进展/风险） | 新增 `12 §2` |
| §5.13 | Durable Execution | 每轮 checkpoint + 崩溃恢复 | 新增 `13-持久执行与恢复设计.md` |

### 🟠 优先级 P1（第一迭代必须包含）

| 补丁 | 目标问题 | 修复方式 | 交付物 |
|------|---------|---------|--------|
| §5.6 | Reasoning Sandwich | 阶段化模型路由 | 修订 `11 modelRouter.json` |
| §5.7 | 并行工作区隔离 | WorkspaceLock + 文件乐观锁 | 修订 `07 §GlobalWorkspace` |
| §5.8 | 可行动失败反馈 | FailureFeedback Schema | 新增 `12 §7` |
| §5.9 | 触发防风暴 | 去重键 + 冷却 + 并发上限 | 修订 `06 §AnomalyDetector` |
| §5.10 | 双预算 | softBudget / hardBudget | 修订 `04 §预算` |
| §5.11 | Intent Debt | Skills 目录 + ADR | 修订 `02 §目录骨架` |

---

## 6. 审查结论

**当前 11 份文档质量评价**：
- 作为**架构蓝图**：**B+**（分层清晰、角色齐全、扩展性好）
- 作为**Loop 工程规范**：**D**（关键闭环控制机制缺失）
- 作为**可开工实施文档**：**未达门槛**——按当前设计直接开工，前 3 个迭代内必然命中"失效模式一 + 四 + 五"

**关键判定**：**Civitas-AI 是 T6 多 Agent 协作型 + 长程自治任务，恰好命中 Loop Engineering 复杂度上限最陡的那一段**。行业上 Single Agent 都能翻车的循环控制问题，在 T6 里会以 `O(n²)` 冲突面放大。因此 Loop 控制系统不是"锦上添花"，是**第一优先级**的基础设施。

**行动**：立即补齐 `Docs/12` `Docs/13` 两份新文档，并对现有 03/06/07/11/04 五份文档做定向修订。

---

## 附录 A：外部参考源

1. **Loop Engineering**（CSDN 2026-09-03）：`m.blog.csdn.net/xiaofeng10330111/article/details/163927720` — 七部件 / 四退出 / 五失效 / 七方法 / 五成熟度
2. **awesome-harness-engineering**（GitHub ai-boost）— LangChain 六钩子 / Pi 事件流 / Codex App Server / Middleware 模式
3. **Agent Loop**（frognew wiki）— 六失效 / 五阶段 / 四代演进 / Durable Execution
4. **arXiv 2608.21884** — Loop Engineering: Building Blocks, Adoption, and Impact
5. **Anthropic**：Building effective agents / Effective harnesses for long-running agents
6. **OpenAI**：A practical guide to building AI agents / Agents SDK: Running agents
7. **LangChain**：Improving Deep Agents with Harness Engineering（Terminal Bench 2.0 rank 30→top5）

## 附录 B：Loop 成熟度自评

按 CSDN Loop Engineering §13 五级模型：

| 级别 | 定义 | Civitas 当前 | 目标（Phase 1 末） |
|------|------|-------------|------------------|
| L0 | 单次调用 | — | — |
| L1 | 工具循环，模型会行动 | ✅ 有 | ✅ |
| L2 | **受控闭环：会验证会停止** | ❌ 缺 | 🔴 **必须达到** |
| L3 | 生产自治：长期运行、事件触发、审批门、回滚 | ❌ 缺 | Phase 2 目标 |
| L4 | 自适应任务工厂 | ❌ 缺 | Phase 3 目标 |
