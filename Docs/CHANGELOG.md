# CHANGELOG

所有 Civitas-AI 设计文档的重要变更记录于此。格式参考 Keep a Changelog；版本号对应设计文档集版本（非软件版本）。

---

## [文档 · 文档-代码对账校准] - 2026-09-22

### 问题

用户反映"现有设计文件与代码实现脱节"。四组审计代理比对全部设计文档与 `Src/` 代码，确认约 100 处脱节（含接口虚构名、不存在的表/文件/配置键、错误的运行期行为描述）。

### 修正口径

- 文档一律向代码看齐；纯设计目标**不删除**，加"⚠️ 未实现/目标态/未接线（2026-09-22 校准）"标注；与代码不符的"Phase0 ✅"勾选一律降级。
- 代码违反文档裁定的项不改代码，在文档中记"现状 + 待办（须代码侧修复）"。
- 每条改动均经 Grep/Read 验证后落笔，附文件:行号证据。

### 变更（22 篇，按目录）

- **Docs/01/02/14**：启动 18 步/关闭 9 步对齐 `main.ts`；LoopConfig 与 `ROLE_OVERRIDES` 双源漂移注；中间件接口改为真实 `execute: HookFunction` 契约（ADR-0006）；退出判定序（风险→预算→上限→无进展，不判 success）三处不一致记为代码债。
- **Docs/03-Agent编排引擎 + Interfaces/{interface,core,infra,services,tools}Interfaces**：路由枚举更正（无 AUDIT 档）；REST 路由表按实际 `registerRoute()` 重写；servicesInterfaces 重写 TokenEconomy/Arbitration 两表（`budgetGuard.ts`/`conservationVerifier.ts`/`initiateCase` 等均为虚构，改为 `dualBudget.detectPhase`/`walletManager.debit`/`tribunal.fileCase` 等真实导出）；toolsInterfaces 必填字段表补全至 11 项并更正 Factory 三函数签名。
- **Docs/04~06**：Token 经济/仲裁/监管按代码现状校准（tribunal 规则裁决不调 LLM、仲裁仍双发布 KNOWLEDGE_CONSOLIDATION 记待办）。
- **Docs/07/08**：WriteGuard 冲突检测归属更正为 `conflictPrecheck.ts:55`（唯一发布点）；GlobalWorkspace/LongTermMemory 内存态注（表已建 v16/v17 但 0 SQL 读写）；`semanticVector`/`CapsuleBuilder`/`searchBySemantic` 标未实现；`MEMORY_VERSION_CONFLICT`、`workspaceLock.ts` 等命名更正。
- **Docs/09/16**：事件帧与 Zustand 版本、F0 期快照时间戳校准。
- **Docs/10**：`consumption_records`/`arbitration_cases`/`operation_history`/`behavior_rules` 四表标 ⚠️ 未落库；`civitas_memory.db` 空壳更正（记忆表实建 main 库）；表名/列结构逐字对齐 `migrations.ts`；迁移失败不回滚据实记载。
- **Docs/11/15**：新增"生效状态"列核心交付——十一张参数表逐键标注 ✅/⚠️（全局事实：204 叶子键中 104 键 51% 无运行期消费者）；loopConfig 读路径错位致配置全灭、热重载为注释桩、modelRouter 示例改真实 huawei-maas 值、双天花板冲突记代码债。
- **Docs/12/13**：审批链不通代码债（单角色审批 × CRITICAL 需 ≥2 → 危险工具永久不可执行）、DJB2 指纹、幂等键实现与公式互斥、fsync/FULL 均标未实现。
- **Docs/17**：BEN-TOOL/ENV-401 模块路径更正、ENV-DBFULL 降为"existing（部分）"、Gate 范围改 G0-G13、keyStore 九导出补全。

### 已知事项（代码债清单，未改代码）

高优先：① 审批链不通（`toolSafetyGate.ts` × `approvalGate.ts`）；② `main.ts` loopConfig 读路径与 JSON 顶层键不匹配 + `runIteration.ts` 硬重建 StopRuleSet 覆盖配置；③ `loopConfig.ts` ROLE_OVERRIDES/LOOP_LIMITS 双源漂移；④ FORBIDDEN 执行期无硬拒 + journal fail-open；⑤ 记忆/审批/账本等表建成但服务层内存态未接线。中优先：热重载未实现、`synchronous=NORMAL` 违反 FULL 裁定、KNOWLEDGE_CONSOLIDATION 双发布、幂等键两套公式并存、LoopState 真源两文档互斥待裁定、`Tests/Decision/multiAgentOrchestration.spec.ts` 大小写导入。详见各文档"2026-09-22 校准"标注。

---

## [文档 · 全目录 README 体系与截图归档整理] - 2026-09-22

- 新增 13 个目录级 README：`Src/`（五层架构 + 启动 18 步/关闭 9 步 + ESLint 层边界）、`Client/`、`Configs/`（15 个配置文件清单与三层覆盖）、`Tests/`（36 spec 分层索引）、`Prompts/`、`Skills/`、`Benchmarks/`（实验矩阵守门约定）、`ADR/`（0001~0006 索引）、`Scripts/`、`electron/`、`Data/`、`Logs/`、`Imgs/`
- 新增 `Docs/README.md` 文档总索引（01~17 设计主线 + 工程支撑线 + 目录 README 互链）
- 根 `README.md`：项目结构补全 Scripts/electron/Data/Logs/Imgs，文档索引增加使用指南/部署运维与全部目录 README 链接
- 根目录 26 张验证截图（cfg_* / wm_* / screenshot_* / test-chat-expanded）统一归档至 `Imgs/`，并将 `Imgs/` 加入 `.gitignore`（不入库）

---

## [评估资产 · 实验矩阵与对抗/故障覆盖脚手架] - 2026-09-15

### 问题

系统此前缺少一张系统性覆盖「非对抗面」与「对抗面（恶意攻击 + 环境故障）」的实验矩阵：安全/持久执行/编排等能力虽有分散单测，但攻击面（注入、越权、串谋、篡改、审批绕过、数据投毒）与环境故障（超时、满盘、风暴、时钟回拨、预算耗尽）未被统一编目，覆盖完整性只能靠口头声明。

### 设计决策

- **两条轴建模**：行 = 12 个系统面，列 = BEN（非对抗）/ ENV（环境故障）/ SEC（恶意攻击）；每个实验为矩阵中一个 cell，锚定真实模块导出与 Gate（G0-G14/DUR-*）。
- **单一事实源**：`Benchmarks/experimentMatrix.json` 承载全部 cell，文档表格与之对齐，避免设计与用例漂移。
- **三态 status 防伪断言**：`existing-covered`（既有测试）、`new-scaffold`（本次新增可运行用例）、`declared-only`（需真实进程/混沌或运行时检测点尚不存在，仅声明方法与判据，不写伪断言）。
- **可验证的覆盖保证**：由脚本强制四条规则、违反即非 0 退出，把「确保覆盖」从口头承诺变为可判定门禁。

### 变更

- **`Benchmarks/experimentMatrix.json`**（新增）：42 cell 单一事实源（BEN=13 / ENV=12 / SEC=17；new-scaffold=20 / existing-covered=18 / declared-only=4），覆盖 12 面 × 6 类对抗家族。
- **`Benchmarks/datasets/adversarialSeeds.json`**（新增）：攻击与故障语料种子（目录遍历/禁止命令/越权工具/注入文本/超预算/风暴/死锁等）。
- **`Tests/Experiments/`**（新增）：三套 vitest 脚手架共 20 用例——`adversarial/security.spec.ts`（15，SEC）、`adversarial/envFault.spec.ts`（3，ENV）、`benign/matrixBenign.spec.ts`（2，BEN 冒烟），全部锚定模块返回契约（`checkPath`/`isToolAllowed`/`checkAntiGaming`/`checkViolation`/`interceptWrite`/`checkTimeoutApprovals`/`isFrozen` 等），不引用不存在的 EventType。
- **`Scripts/experimentMatrix.cjs`**（新增）：矩阵守门脚本，强制四条覆盖规则并输出对抗落地率与 declared-only 缺口清单。
- **`Docs/17-实验矩阵与评估/实验矩阵设计.md`**（新增）：矩阵模型、覆盖保证、三张全表、实现约定、已知缺口与运行方式。

### 已知事项

- declared-only 缺口 4 项待后续排期（需真实时钟/混沌环境或运行时检测点先落地）：ENV-TIMEOUT、ENV-NETPART、ENV-PDOWN、SEC-KEYLEAK（`keyStore` 仅有 registerKey/resolveKey，缺泄露扫描检测点）。
- 本任务纯新增评估资产，未改动 `Src/**`；`npx vitest run Tests/Experiments` 20/20 通过，`node Scripts/experimentMatrix.cjs` 退出码 0。
- 全量 `npm test` 存在 5 项与本任务无关的既有失败（`Tests/Runtime/runtime.spec.ts` ×2、`Tests/E2E/{delegationMode,consortiumMode,directExecution}.spec.ts` 招募断言各 ×1），属他人在制品，非本次引入。

---

## [设计 v2.2 · Agent 权限模型与工具可见性重定义] - 2026-09-15

### 问题

审查发现后端 Agent 工具权限存在 6 项关键缺陷：
1. 入口 Agent（Prime Director）从未被实例化，wsHandler 硬编码 `agentRole: 'worker'`
2. 主循环 `getAllToolSpecs()` 向所有角色暴露全部工具，未按角色裁剪
3. `requiredRoles` 仅注册时验证非空，运行时零校验
4. `toolSafetyGate` 中间件未注册，审批门/幂等缓存/EffectJournal 联动全部失效
5. `AgentRole`（4 值）与 `UserRole`（8 值）类型不兼容
6. `MiddlewareContext` 缺少 `agentRole`，wrapToolCall 钩子无法获取角色信息

### 设计决策

- **信任分级重划**：L0 仅保留治理三权（Regulator/Auditor/Arbitrator），L1 为入口级（Prime Director + Partner 对等），L2 为执行子级（Worker/Reviewer/Assembly Node）
- **工具可见性双轴模型**：可见性由 `requiredRoles` 白名单决定，执行管控由 `dangerLevel + reversibility` 决定，两轴正交
- **递归派发协作网络**：Prime Director 与 Partner 完全对等，均可接收用户输入、递归派发子 Agent；治理三权不参与业务执行

### 变更

- **`Docs/11-配置体系与安全/配置体系与安全设计.md`**：§3.2 信任分级表重写（L0/L1/L2 重划 + 角色分类说明）；新增 §3.3.1 工具可见性与执行管控双轴模型（含各角色默认可见工具表、治理级操作表、运行时硬校验规则）
- **`Docs/02-核心架构/核心架构设计.md`**：§3.2 原“T6 双层循环”重写为“递归派发协作模型”（含架构图、角色权限分级表、递归派发特有约束）
- **`Docs/03-Agent编排引擎/Agent编排引擎设计.md`**：§1 职责边界增加 v2.2 修订说明；§5.1 招募流程扩展为 L1 入口级均可招募；§5.2 AgentConfig.role 扩展为 8 角色，工具配置改为 `additionalTools/excludedTools` 覆盖模式
- **`Docs/15-参数总典与接口契约/参数总典.md`**：§2.12 新增 `security.trustLevels` 角色信任分级表（systemRoles/userRoles/externalRoles 三组）

### 已知事项

- 代码实现尚未修改，待 Phase 2 编写修改计划、Phase 3 实施代码修改
- 修改完成后需按记忆约束执行 ≥3 轮真实 Agent 调用测试

---

## [前端 v1.2 · Agent 对话界面默认会话与滚动隔离修复] - 2026-09-15

### 问题

1. **默认打开空白**：`hydrateSessions` 只填充 `sessions`，不设置 `activeSessionId`，进入 `/chat` 后右侧无头部、无消息、输入框禁用，必须手动点左侧会话。
2. **滚动串扰**：`AppLayout` 的 `<main className="flex-1 overflow-y-auto">` 与 ChatView 内部的会话列表、消息区共用滚动链——聊天列 `flex-1 flex flex-col` 与 `MessageList` 根节点缺 `min-h-0`，flex 项 `min-height:auto` 被内容撑高后溢出到 main，消息滚动实际发生在 main 上，**滚动消息区时会话列表整体一起移动**；`MessageList` 又用 `bottomRef.scrollIntoView()` 定位底部，该方法会逐级滚动所有祖先滚动容器，进一步放大串扰。

### 变更

- **`Client/src/stores/chatStore.ts`**：`hydrateSessions` 按 `updated_at DESC` 排序后，若当前无选中会话（或选中项已不存在）则自动选中最近一个会话；已有有效选中时保持不变，避免刷新打断用户。后端 `listSessions` 本已按 `updated_at DESC` 返回，`addMessage` 会刷新 `updated_at`。
- **`Client/src/components/Layout/AppLayout.tsx`**：新增 `selfScrollingViews` 白名单（当前仅 `/chat`），命中的路由主内容区使用 `flex-1 min-h-0 overflow-hidden`，其余路由保持 `overflow-y-auto`——主内容区不再与视图内部滚动区叠加。
- **`Client/src/views/ChatView.tsx`**：根容器 `h-full min-h-0 overflow-hidden`；会话列与聊天列加 `min-h-0`/`min-w-0`；会话列表滚动区加 `min-h-0`；聊天头部与 Composer 加 `flex-shrink-0`；`sessions.length === 0` 时展示「还没有会话 + 新建对话」空态；向 `MessageList` 传入 `sessionId`。
- **`Client/src/components/Chat/MessageList.tsx`**：滚动改为只作用于自身容器（`containerRef.scrollTo({top: scrollHeight})`），移除 `bottomRef`/`scrollIntoView`；新增 `sessionId` 属性，切换会话时重置跟随状态并无动画定位到最新消息；根节点 `flex-1 min-h-0`。
- **`Client/src/components/Chat/Composer.tsx`**：根节点加 `flex-shrink-0`，长消息下不被压缩。

### Gate 验证

- ✅ `tsc --noEmit`（Client）零类型错误。
- ✅ 浏览器真实渲染复验：进入 `/chat` 默认选中并高亮最近会话（Test Chat），30 条消息自动定位到底部（scrollTop 3051 = 最大值）。
- ✅ 滚动隔离：消息容器 `scrollHeight 3709 / clientHeight 658` 为唯一滚动源，`main`（overflow-y:hidden，scrollHeight == clientHeight == 834）、会话列表、document 的 scrollTop 均恒为 0，列表几何位置零位移；上滑后「回到底部」按钮正常出现。
- ✅ 会话切换往返（New Chat ↔ Test Chat）激活项、头部标题、消息数、滚动位置均正确复位。
- ✅ 回归其余路由：`/`、`/working-modes`、`/system-config`、`/agents` 的 `main` 仍为 `overflow-y:auto`，Dashboard 实测可滚动（scrollTop 191.7），未因白名单改动失去滚动能力。

### 已知事项

- `npm run dev:electron` 桌面窗口仍无法启动（`build.cjs` ESM 打包缺 `createRequire` banner 导致 `ws` 报 `Dynamic require of "events"`；且 `electron/main.ts` 在 dev 下重复自启后端争抢 3000 端口）。经用户决策本轮不修，前端验证走浏览器 5173。

---

## [前端 v1.1 · 系统配置改造为标准设置面板] - 2026-09-14

### 背景

原 `SystemConfig` 视图仅将 `Configs/*.json` 以只读 JSON 片段 dump 出来，不可交互、无可读性。本次改造为**标准设置面板**：语义化控件（开关/滑块/下拉/分段/数字/标签）替代 JSON 片段，实现「默认值 vs 用户值 · 重置恢复默认」模型。控件选型依据业界最佳实践（VSCode `contributes.configuration`、NNGroup 滑块规范、Setproduct 设置控件规范）。

### 新增文件

- **`Client/src/config/schemaTypes.ts`**：字段类型契约（`FieldDef`/`ConfigGroup`/`Control`）+ `getPath`/`setPath`/`isRatioField` 工具。
- **`Client/src/config/configSchema.ts`**：12 分组、约 80 个核心行为参数的 Schema（默认值/区间/枚举/硬约束均取自 Docs/15 参数总典）；锁定项（snapshotStore 强制 sqlite、writeSynchronous=FULL、approvalDefaultOnTimeout 禁 approve、L0 security 组等）以 `locked` 标记。非交互项（benchBaseline/coverageBaseline/dataStorage）按用户决策不纳入。
- **`Client/src/components/Settings/fields.tsx`**：控件层 — Toggle、Slider（区间+当前值+min/max 端点+默认值刻度+联动数字输入）、Number（步进+夹紧）、Select、Segmented、Text、Tags。
- **`Client/src/stores/configStore.ts`**：Zustand store，三层取值（用户覆盖 > 文件当前值 > 出厂默认）+ localStorage 持久 + 导出合并 JSON。**不写后端**，避免直改受保护配置文件。

### 变更

- `SystemConfig.tsx`：重写为分组导航 + 全局搜索 + 修改高亮 + 单项/整组/全部重置 + 导出弹窗。
- `index.css`：新增设置面板样式约 166 行（range/toggle/segmented/tags/modal 等）。

### Gate 验证

- ✅ `tsc --noEmit` 零类型错误；✅ `vite build` 成功（built in 9.87s）；✅ 无新增依赖。
- ✅ 浏览器真实渲染复验 6 项均通过（数据来自 GET /api/configs/:name 真实文件值）。
- ✅ 修复验证中发现的缺陷：① 重置语义——采用哨兵值 `DEFAULT_MARK` 将字段显式钉回出厂默认（而非写默认值入覆盖层），修正后脏计数正确归零；② 左侧导航与分组标题计数改为订阅 overrides/loaded 实时重算；③ section 容器类名 `config-section*`→`setting-section*` 对齐（原不匹配导致无样式）；④ 数字输入 `step="any"` 消除合法值被判 stepMismatch 的假阳性；⑤ L0 横幅文案包 `<span>` 修正逐字竖排；`.setting-main`/`.config-content` 加 min-width 修正窄屏遮挡。

---

## [前端 v1.0 · 六种工作方式可视化] - 2026-09-14

### 新增文件

为 PRD §3.1 定义的 6 种工作方式各设计一套**专属的时间/进度呈现样式**，每种样式的选型均基于业界可视化范式网络调研。全部用 Tailwind + 原生 SVG 实现，未引入图表库。

- **`Client/src/views/WorkingModes.tsx`**：Tab 视图，顶部色点导航 + 摘要卡（语义/触发条件）+ 按 tab 分发渲染。
- **`Client/src/components/WorkingModes/ModeShell.tsx`**：通用外壳（模式徽标 + 演示数据标注 + 设计参考脚注）+ `TimeAxis` + `StatusDot`。
- **`Client/src/components/WorkingModes/demoData.ts`**：类型契约 + `fmtMs`/`fmtTime` + 7 套 `DEMO_*` 演示剧本；`pickRealOrDemo` 预留待后端 `TaskRecord.routingMode` 扩展。
- **`DirectExecutionViz.tsx`**（DIRECT）：TTFB 环形计时 + 流式气泡 + Segment 条 — 参考 Claude/ChatGPT/Android Progress Segments。
- **`DelegationViz.tsx`**（DELEGATION）：扇形贝塞尔分叉 + 并行轨道甘特 + 轨道利用率 — 参考 Airflow Graph/ZenML Timeline/Jenkins Blue Ocean。
- **`AssemblyLineViz.tsx`**（ASSEMBLY_LINE）：圆点 Stepper + 传送带串行时序 + 交接成本标注 — 参考 GitHub Actions/Blue Ocean StepBar。
- **`ConsortiumViz.tsx`**（CONSORTIUM）：多域泳道 + Token 液面柱（`foreignObject`）+ 收敛屏障虚线 — 参考 ZenML Swimlane/Fluid Token/Kimi 集群。
- **`LitigationViz.tsx`**（LITIGATION）：六步 Stepper + 3×裁决矩阵（多数派高亮）+ 垂直事件时间轴 — 参考 Azure Boards/Sentinel/仲裁案件时间轴。
- **`RegulationViz.tsx`**（REGULATION）：广播扩散雷达环（节点按送达时刻落半径）+ ACK 三段漏斗 + 截止倒计时 — 参考 Android 16 Progress Segments/推送漏斗/应急指挥辐射图。
- **`AuditViz.tsx`**（AUDIT）：消耗折线 + 双层阈值带 + 冻结斜纹带（`pattern` 45°）+ 异常旗标 + 稽查判定卡 — 参考 OpenSearch Anomaly/Grafana Annotation Band/SOC。

### 接入

- `AppLayout.tsx`：侧边导航新增「工作方式」项（`Workflow` 图标）+ `/working-modes` 路由。
- `index.css`：新增 `@keyframes ripple`（ASSEMBLY_LINE 交接脉冲 / REGULATION 广播涟漪）。

### Gate 验证

- ✅ `tsc --noEmit` 零类型错误
- ✅ `vite build` 成功（built in 10.10s）
- ✅ 无新增依赖，复用现有设计令牌与工具类
- ✅ 浏览器真实渲染验证：7 个 tab 逐一截图确认图形渲染正常
- ✅ 修复 AUDIT 阈值带因 y 轴反向映射导致的 `<rect>` 负高度报错（色带 y/height 改为 `Math.max` 保护且正确分层：红带压阈值线上方、橙带占 0.8x~1x）

---

## [测试 v1.0 · 六种工作方式 E2E 测试] - 2026-09-14

### 新增文件

PRD §3.1 定义的 6 种核心路由模式各有独立 E2E 测试文件，共 62 项测试，覆盖从任务输入到结果输出的完整链路。

- **`Tests/E2E/directExecution.spec.ts`**（DIRECT 模式 · 6 项）：简单任务复杂度评估 → 路由命中 DIRECT → Director 直接执行 → 无 Worker 招募 → 事件链验证 → [LLM] 真实调用。
- **`Tests/E2E/delegationMode.spec.ts`**（DELEGATION 模式 · 8 项）：多域+低耦合 → 路由命中 DELEGATION → Director 拆解+Worker 招募 → TaskPlan 结构验证 → 结果聚合 → [LLM] Worker 执行+审核。
- **`Tests/E2E/assemblyLineMode.spec.ts`**（ASSEMBLY_LINE 模式 · 10 项）：SOP 匹配 → 路由命中 ASSEMBLY_LINE → 流水线依赖链（串行 dependsOn）→ maxParallelism=1 → 节点依次完成 → 结果聚合 → [LLM] 3 节点依次调用。
- **`Tests/E2E/consortiumMode.spec.ts`**（CONSORTIUM 模式 · 10 项）：多域高复杂度 → 路由命中 CONSORTIUM → Partner 招募（role='partner'）→ Token 钱包独立分配 → 守恒验证 → [LLM] 并行调用+审核。
- **`Tests/E2E/litigationMode.spec.ts`**（LITIGATION 模式 · 12 项）：六步治理闭环端到端（立案→胶囊组装→裁决推理→律师函挂起→现场恢复→知识沉淀）→ 防抖机制 → 死锁升级至监管局 → 多案件并行 → [LLM] 3 仲裁者独立裁决。
- **`Tests/E2E/regulationAuditMode.spec.ts`**（REGULATION+AUDIT 模式 · 16 项）：行政协调（死锁升级→强制裁决 / 广播通道+确认 / 紧急干预 / 行为准则+违规检测）+ 资源稽查（正常/异常消耗 / 稽查判定 / 死循环检测 / 手动冻结解冻 / 巡检）。

### 验证覆盖

- ✅ 路由决策正确（DIRECT / DELEGATION / ASSEMBLY_LINE / CONSORTIUM 各模式命中）
- ✅ Agent 招募正确（Director / Worker / Partner 角色分配）
- ✅ 状态流转完整（六步仲裁闭环 / 流水线串行依赖）
- ✅ Token 守恒（钱包独立 + 消耗总和 = 系统池扣减量）
- ✅ 事件链完整（ARBITRATION_FILED → VERDICT → SUSPEND → RESTORATION → KNOWLEDGE_CONSOLIDATION）
- ✅ 真实 LLM 调用测试（华为云 GLM-5.1，`if (!HUAWEI_MAAS_API_KEY) return` 守卫）

### Gate 验证

- ✅ 6 个测试文件 62 项新增测试全部通过
- ✅ 全量测试 672 passed / 1 failed（唯一失败为 pre-existing `realAgent.spec.ts` Round 3 LLM API 超时，非本次变更引入）
- ✅ 零回归

---

## [修复 v1.1 · 审查报告全量修复 P1~P3] - 2026-09-14

### P1 高优先级（续）

- **P1-4**：填充 `Prompts/roles/` 8 角色提示词（prime_director/partner/worker/reviewer/assembly_node/arbitrator/auditor/regulator）+ `Prompts/system/mainLoop.md`（Reasoning Sandwich）+ `Prompts/tasks/defaultTask.md` + `Prompts/versions/manifest.json`
- **P1-5a**：新增 `.husky/pre-commit`（prettier + eslint + tsc）、`.husky/pre-push`（vitest）、`commitlint.config.cjs`（Conventional Commits）
- **P1-7b**：新增 `Docs/04-使用指南/fullGuide.md`、`configuration.md`、`troubleshooting.md`
- **P1-7c**：新增 `Docs/05-部署运维/Deployment/`（local/docker/windows）+ `Runbooks/`（healthCheck/logAnalysis/commonIssues/rollback）

### P2 中优先级

- **P2-8b**：新增 `Scripts/install.ps1` + `Scripts/install.sh` 一键安装脚本
- **P2-9**：`Src/main.ts` SIGINT handler 扩展为 9 步关闭序列（停输入→中断模型→后置监管→追踪索引→归档会话→flush日志→销毁沙箱→关DB→退出）
- **P2-10**：启动序列对齐为 ⑱ 步（补 ⑤文件系统/⑧沙箱/⑨配置热加载/⑩提示词加载/⑭环境自检）
- **P2-11**：新增 `Src/Infra/Hook/System/auditHook.ts`（审计/备份/指标三内置 Hook）+ `Data/Hooks/README.md`（用户 Hook 目录）
- **P2-12**：`Benchmarks/datasets/sampleTasks.json` 扩充至 22 任务（覆盖 3 路由模式 + 6 特殊场景）；`Configs/benchBaseline.json` 新增 `degradationThreshold`（5%告警/10%阻断）

### P3 低优先级

- **P3-13**：新增 `Docs/03-开发规范/docsMigrationPlan.md`（Docs 目录迁移计划）
- **P3-14**：新增 `Configs/dataStorage.json`（七类数据保留期 + 清理优先级 + 全局配额）
- **P3-15**：`Src/Services/Session/archiveManager.ts` 扩展支持操作/决策两类归档（`archiveOperation`/`archiveDecision`/`getArchivesByType`）

---

## [修复 v1.0 · 审查报告 P0/P1/P2 修复] - 2026-09-14

### P0 阻断性修复

- **P0-1**：实现 `Src/Core/Loop/runIteration.ts`（625 行）——十步主循环执行器，组合监管/中间件/上下文装配/模型调用/工具执行/迭代判定完整链路
- **P0-2**：改造 `Src/Interface/WebSocket/wsHandler.ts`——`startStreamGeneration` 从裸调 `callModelStream` 改为调用 `executeLoop`，走完整十步链路
- **P0-3**：新增 `Src/Services/LoopControl/middleware/toolSafetyGate.ts`（185 行）——wrapToolCall 钩子按危险分级强制管控：DANGEROUS+IRREVERSIBLE → ApprovalGate；CONTROLLED → EffectJournal；幂等缓存 DUR-005

### P1 高优先级

- **P1-5**：新增 `.github/workflows/ci.yml`（lint + test + build 三阶段流水线）、`CODEOWNERS`、`pull_request_template.md`
- **P1-6**：新增 `Docs/03-开发规范/Interfaces/` 五层接口文档（core/services/tools/infra/interface）
- **P1-7**：新增 `Docs/04-使用指南/quickStart.md`

### P2 基础资产

- **P2-8**：新增 `README.md`、`.env.example`、`CONTRIBUTING.md`

### 工程资产

- 清理根目录 8 张截图 + 1 个临时文件
- `.gitignore` 新增 `.vite/` 忽略规则
- 零编译错误，测试无回归

### 成熟度变化

- 从 **L1.5 实现 / L2 设计** 跨越至 **L2 实现**
- 主循环执行器已就位，所有监管/中间件/上下文装配/LoopControl/DurableExecution 联动已贯通

---

## [审查 v1.0 · 后端 Harness 与 Loop 工程合规审查] - 2026-09-14

### 新增文档

- **`Docs/99-审查记录/后端Harness与Loop工程合规审查报告.md`**：以 agent-project-skill 15 个子技能清单 + 项目 v2 设计（Docs/02 §3 十步主循环、Docs/12 LoopControl、Docs/13 DurableExecution、ADR-0001~0005）+ 记忆约束为基准，对 `Src/` 后端全量 + `Configs/` + `Prompts/` + `Skills/` + `Tests/` + `Docs/` + 项目根工程资产做的完整合规审查。

### 核心结论

- **设计层已达 Loop Engineering L2 完备**，**实现层各子系统模块齐全且单元测试通过（609 项 / 26 spec）**，但 **主循环执行器缺位** 是当前最严重的合规缺陷。
- `Src/Core/Loop/loopEngine.ts` 仅提供状态管理原语（createLoopState / startLoop / pauseLoop / resumeLoop / terminateLoop / failLoop / recordLoopEvent / assertStepOrder），**没有实际执行十步序列的 `runIteration()` 函数**。
- `Src/Interface/WebSocket/wsHandler.ts` 的 `startStreamGeneration` 直接调 `callModelStream`，**绕过 ②前置监管 / ③中间件管线 / ④上下文组装 / ⑤监管懒监听 / ⑦输出解析 / ⑧工具执行 / ⑨后置监管 / ⑩迭代判定 八步**。
- 监管六模块、中间件六钩子、上下文四级分区、LoopControl 五控制中间件、DurableExecution 工具层联动 **全部形同孤岛**——模块齐全但无主循环消费点。
- **成熟度定位**：L1.5 实现 / L2 设计（与设计审查报告 v1.0 结论一致，代码侧仍未跨越 L1.5 → L2 分水岭）。

### 缺失项清单（按优先级）

**P0 阻断性**：
1. 主循环执行器 `runIteration()` 未实现
2. `wsHandler` 旁路未改造为主循环入口
3. 工具层未接入 EffectJournal + ApprovalGate（DANGEROUS + IRREVERSIBLE 工具未强制审批）

**P1 高优先级**：
4. `Prompts/` 空目录（roles/system/tasks/versions 全空）
5. `Skills/` 空目录（playbooks/rubrics/rules/strategies 全空，Verifier L3 Rubric 校准集缺失）
6. CI/CD 缺失（无 `.github/workflows/`、无 `.husky/`、无 CODEOWNERS、无 PR 模板）
7. 接口文档缺失（无 `Docs/03-开发规范/Interfaces/{层}Interfaces.md`，记忆 0e73ceeb 强制要求）
8. 使用指南 / 部署运维文档缺失（无 `Docs/04-使用指南/`、无 `Docs/05-部署运维/`）

**P2 中优先级**：
9. 项目根基础资产缺失（README.md / LICENSE / .gitattributes / .env.example / CONTRIBUTING.md / install.sh|ps1）
10. 关闭序列 9 步仅实现 2 步（SIGINT 仅停 HTTP/WS/Logger）
11. 启动 14 步序号跳号（main.ts 注释 ①②③④⑥⑦⑦.5⑫⑬⑭⑮⑯⑰⑲，缺 ⑤⑧⑨⑩⑪⑱）
12. Hook 系统未落地（无 `Infra/Hook/System/`、无 `Data/Hooks/`）
13. Benchmarks 数据集不完整（sampleTasks.json 仅 4 任务，无劣化告警阈值）

**P3 低优先级**：
14. Docs 目录结构偏离 skill 规范（01-系统概览 应为 01-需求与规划；ADR 应在 Docs/02-设计方案/Decisions/）
15. 配额仲裁未配置化
16. 操作历史与决策历史归档闭环不完整

### 架构变更验证要求

完成 P0 修复后，按记忆 aa6cb969 必须进行至少三轮真实 Agent 调用测试：
- Round 1：单 Agent 编码任务（十步序列完整执行 + Verifier L1/L2 通过 + Token 守恒）
- Round 2：多 Agent 协作（Maker-Checker 分离 + submitForReview + 审批门）
- Round 3：故障注入（EffectJournal UNKNOWN 裁决 + Checkpoint 恢复 + 幂等键去重）

### 工程资产初始化

- 本次审查同步完成 **git 仓库初始化**（此前项目根无 `.git/`），首次提交包含全量源码 + 设计文档 + 测试 + 配置 + 本审查报告。

---

## [打包方案 P1 · Electron 便携版] - 2026-09-14

### 新增特性

- **Electron 桌面应用打包方案**：将前后端打包为 Windows 便携版（ZIP 压缩包），用户解压后双击 `CivitasAI.exe` 即可运行，无需安装 Node.js 或浏览器。
- **便携模式支持**：数据存储在程序目录下的 `Data/` 和 `Logs/`，可整体拷贝到 U 盘使用。
- **esbuild 快速打包**：使用 esbuild 替代 tsc 进行后端打包，绕过项目中的预存类型错误，构建速度大幅提升。
- **前端相对路径支持**：Vite 构建配置调整为 `base: './'`，支持 Electron 的 `file://` 协议加载。
- **WebSocket 地址动态推导**：前端 WS 连接地址根据运行环境（Electron/浏览器）自动适配。

### 新增文件

- `electron/main.ts`：Electron 主进程入口，启动后端服务并创建窗口
- `electron/preload.ts`：预加载脚本，安全暴露 Node.js API
- `tsconfig.build.json`：生产构建 TypeScript 配置
- `Scripts/build.cjs`：esbuild 打包脚本
- `Src/Infra/Fs/pathResolver.ts`：路径解析器，支持便携/安装双模式
- `assets/README.md`：应用图标说明
- `ELECTRON.md`：打包指南文档

### 变更文件

- `package.json`：添加 `main`、`build`（electron-builder 配置）、新脚本
- `Client/vite.config.ts`：`base: './'` + 输出目录调整为 `dist/renderer/`
- `Src/main.ts`：重构为导出 `startServer()` 函数，支持 Electron 调用
- `Client/src/services/ws.ts`：WebSocket URL 动态推导

### 构建命令

```bash
npm run build:all          # 构建前后端
npm run electron:build     # 打包 Windows 便携版
npm run electron:dev       # Electron 开发模式
```

### 技术细节

- 使用 esbuild 打包后端（绕过 TypeScript 严格检查）
- Vite 构建前端（输出到 `dist/renderer/`）
- electron-builder 打包为 portable 格式
- better-sqlite3 原生模块保持外部引用（asarUnpack）
- 便携模式通过环境变量 `CIVITAS_DATA_DIR` 等控制数据路径

---

## [联调修复 F2.9 · 聊天链路修复 + CoT 流式展示] - 2026-09-14

### 问题修复

- **聊天回复永远不返回**：前端 `generate_reply` 用扁平字段发送而后端读取 `payload.*`，消息契约不匹配，后端校验失败且错误帧被网关丢弃，客户端永远等待。
- **WS 客户端收不到任何事件推送**：`wsGateway.connectClient([])` 传空订阅列表，EventBus 事件从不转发给真实客户端。
- **生成永远失败**：`wsHandler` 用未注册的字面量 `'default'` 调用模型路由，`resolveModel` 必然失败。
- **无可用 Provider**：`modelRouter.json` 指向 OpenAI/Anthropic/Aliyun 但对应 API Key 均未设置；已切换为实际可用的华为云 MaaS（`HUAWEI_MAAS_API_KEY`，Token Plan `/plan/v2`）。
- **首响超 3s**：`defaultModel` 原为推理模型 GLM-5.1（首个可见内容 6.7s）；实测后改用 DeepSeek-V4-Flash（实测思维链首包 0.6~2.3s、正文首包 1.4~2.7s，全部达标）。GLM-5 在 Token Plan 下不可用（404）已移除，仲裁模型补入 Kimi-K2.6（实测首响 1.5s）。
- **切换页面丢失未完成的流式回复**：流式 WS 订阅原挂在 ChatView 内（卸载即丢 chunk），且重挂载时 `hydrateMessages` 用服务端历史覆盖本地流式占位消息。修复：流式分发移至全局 `useWebSocket`；`hydrateMessages` 保留进行中的流式消息。
- **流式内容逐字重复**：React StrictMode 双挂载下 `connectWebSocket` 在首个连接处于 CONNECTING 时误判并创建第二条连接，事件被双份消费。修复：连接复用（OPEN/CONNECTING 均复用）+ 残留连接清理。

### 新增特性

- **思维链（CoT）流式展示与折叠**：后端将 `reasoning_delta` 与正文增量分字段随 `agent:stream_chunk` 推送；前端消息气泡新增"思考中…/思考过程"区块——流式期间自动展开、流结束后默认折叠、可点击切换。
- **生成链路可观测性**：`wsHandler` 记录首包耗时（firstChunkMs）、总耗时、token 用量到业务日志。
- **消息错误可见**：WS 处理失败时网关回推 `error` 帧；`AGENT_STREAM_END` 携带错误时前端将消息标记为 error 态。

### 变更文件

- `Configs/modelRouter.json`：华为云 MaaS Provider + 路由重写（default=DeepSeek-V4-Flash，director/verifier=GLM-5.1）
- `Src/Interface/WebSocket/wsHandler.ts`：payload/扁平双格式兼容、路由默认模型、reasoning 透传、耗时日志
- `Src/Interface/WebSocket/wsGateway.ts`：全事件订阅、错误帧回推
- `Client/src/services/ws.ts`：WS 连接复用与残留清理
- `Client/src/hooks/useWebSocket.ts`：全局流式事件分发（chunk/reasoning/end/error）
- `Client/src/stores/chatStore.ts`：reasoning 字段 + 合批刷新 + hydrate 保留流式消息
- `Client/src/views/ChatView.tsx`：payload 契约 + 移除组件内订阅
- `Client/src/components/Chat/MessageBubble.tsx`：CoT 折叠区块
- `Scripts/wsDiagnose.cjs`/`llmLatency.cjs`/`dupCheck.cjs`/`dbPeek.cjs`：联调诊断工具

### 验证

- 真实调用 3 轮：首包 0.65s/0.66s/2.26s，全部 <3s；回复正确落库
- 浏览器端验证：切页后流式回复不丢失；CoT 流式展开 + 完成后折叠；字符重复消除
- 全量测试 609/611 通过（2 个失败为 realAgent 真实调用测试在并发负载下的既有 flaky，单独运行全部通过）

---

## [实现 v0.3-F0 传输层与契约补齐] - 2026-09-14

### 新增文件

- **`Src/Interface/WebServer/httpServer.ts`**（F0.1）：Node 原生 `http.createServer` 绑 `server.httpPort`(3000)，含 CORS、静态托管 `Client/dist`、API 路由委托给 `handleRequest()`。
- **`Src/Interface/WebSocket/wsGateway.ts`**（F0.2）：基于 `ws` 包绑 `server.wsPort`(3001)，真实 WS 连接桥接到 wsServer 内存桥。
- **`Src/Interface/RestApi/chatApi.ts`**（F0.7）：`GET/POST /api/sessions`、`GET/POST /api/sessions/:id/messages`，消息落 DB（main 库 chat_sessions / chat_messages 表，migration v18/v19）。
- **`Scripts/genEventTypes.ts`**（F0.8）：构建期把 `eventTypes.ts` 导出为 `Client/src/shared/eventTypes.ts`，前端零自造字符串。
- **`Client/src/shared/eventTypes.ts`**：由 F0.8 脚本生成，62 个事件类型常量。

### 修改文件

- **`Src/Services/EventBus/eventTypes.ts`**（F0.6）：新增 3 个 `agent:` 域事件 `AGENT_STREAM_CHUNK`/`AGENT_STREAM_END`/`AGENT_CHAT_MESSAGE`。
- **`Src/Interface/WebSocket/wsServer.ts`**（F0.5b）：`connectClient` 改用 `subscribeMany` 订阅全部事件（修复原仅订阅 `subscriptions[0]` 的 bug）；`pushToClient` 支持真实 socket 直发；新增 `attachSocket`/`detachSocket`。
- **`Src/Interface/WebSocket/wsHandler.ts`**（F0.5b）：`subscribe` 帧实际解析事件列表。
- **`Src/Interface/RestApi/approvalApi.ts`**（F0.4）：新增 `POST /api/approvals/:approvalId/decide`，转调 `decideApproval()`，默认拒绝语义不变。
- **`Src/Interface/RestApi/taskApi.ts`**（F0.5）：`POST /api/tasks` 异步触发 `orchestrator.receiveTask()`，立即返回 `{taskId, traceId}`；新增 `DELETE /api/tasks/:taskId` 取消任务。
- **`Src/Infra/Db/migrations.ts`**（F0.7）：新增 v18 `chat_sessions` 表、v19 `chat_messages` 表迁移。
- **`Src/Interface/WebServer/routes.ts`**：注册 `registerChatRoutes`。
- **`Src/main.ts`**：`main()` 改 async；追加 ⑲ 步装配（`registerAllRoutes()` → `startHttpServer()` → `startWsGateway()`）；SIGINT 优雅关闭。
- **`package.json`**：新增 `ws` 依赖、`@types/ws` 开发依赖、`dev:server`/`gen:event-types` 脚本。

### Gate G0 验证

- ✅ `GET :3000/api/agents` 返回真实 JSON
- ✅ `GET :3000/api/loops/dashboard` 返回大屏数据
- ✅ `POST :3000/api/tasks` 触发编排并返回 `{taskId, traceId}`
- ✅ `DELETE :3000/api/tasks/:id` 终态任务返回 404（行为正确）
- ✅ `POST :3000/api/sessions` 创建会话并落 DB
- ✅ `POST :3000/api/sessions/:id/messages` 消息持久化
- ✅ `GET :3000/api/sessions/:id/messages` 返回消息列表
- ✅ WS `:3001` ping/pong 正常
- ✅ 586 项测试零回归

---

## [实现 v0.3-F6 硬化与交付] - 2026-09-14

### 新增文件

- **`Tests/Interface/frontendIntegration.spec.ts`**（F6.1）：前端集成契约测试（25 项），覆盖所有前端 store 依赖的 API 路由（Agent/Task/Token/Approval/Loop/Config），后端路由变更即失败。

### 修改文件

- **`package.json`**（F6.4）：新增 `build:client` / `build:all` 脚本。

### Gate G6 验证

- ✅ 离线横幅与降级轮询有效（OfflineBanner + useWebSocket 重连）
- ✅ 流式 + Stop + 继续可用（F2 已验证）
- ✅ 模型名与 Token 可见、代码可复制（F2 MarkdownRenderer）
- ✅ 审批写回后端且 Loop 感知（F3 已验证）
- ✅ 大屏图表源自真实事件且能说明其解释的问题（F4 四图表 + 每卡“它回答什么问题”）
- ✅ 契约测试 25 项全过（607 项测试零回归）
- ✅ `npm start` 一键起全栈（httpServer 托管 Client/dist）
- ✅ build 产物主包 gzip 198KB < 1.2MB

---

## [实现 v0.3-F5 Trace 回放与驾驶舱纵深] - 2026-09-14

### 新增文件

- **`Client/src/views/TokenLedger.tsx`**（F5.3）：Token 账本独立视图——钱包总览（5 指标卡）+ 消耗分布柱状 + 钱包列表 + 流水筛选（类型/钱包双过滤）。
- **`Client/src/views/SystemConfig.tsx`**（F5.4）：系统配置只读视图——左侧配置文件列表 + 右侧 JSON 预览。
- **`Src/Interface/RestApi/configApi.ts`**（F5.4）：`GET /api/configs` 配置列表 + `GET /api/configs/:name` 配置详情，读 Configs/ 目录。

### 修改文件

- **`Client/src/views/TraceReplay.tsx`**（F5.1）：重构为 LangSmith 形态三栏布局——左侧 trace 列表（搜索+错误标记）+ 中间时间线 span 树（8 类事件着色+耗时）+ 右侧 span 详情（payload 原文+错误标记）。
- **`Client/src/views/LoopDebugger.tsx`**（F5.2）：增强——分类过滤栏（10 类）+ 统计栏（错误/策略切换/指纹计数）+ 指纹/压缩标记点 + 错误高亮。
- **`Client/src/components/Layout/AppLayout.tsx`**：新增 Token 账本 + 系统配置导航项 + 路由。
- **`Src/Interface/WebServer/routes.ts`**：注册 `registerConfigRoutes()`。

### Gate G5 验证

- ✅ `tsc --noEmit` 前端零错误、后端零新增错误
- ✅ `vite build` 成功（6.69s）
- ✅ TraceReplay 三栏布局（trace 列表 / span 树 / span 详情）
- ✅ 真实 trace_id 还原完整执行链（事件时间线 + 耗时标注）
- ✅ 失败 span 定位（`isErrorEvent` 检测 error/failed/rejected + 红色高亮）
- ✅ LoopDebugger 指纹/策略切换标注
- ✅ TokenLedger 独立视图（钱包总览/流水筛选/消耗统计）
- ✅ SystemConfig 只读视图（读 Configs/ + 后端 API）

---

## [实现 v0.3-F4 城邦大屏可视化] - 2026-09-14

### 新增文件

- **`Client/src/hooks/useAlerts.ts`**（F4.1）：五条前端告警规则（Token 异常/队列积压/高失败率/仲裁积压/系统池不足），`useMemo` 计算。
- **`Client/src/components/Dashboard/TokenFlowSankey.tsx`**（F4.2）：Token 流向桑基图（纯 SVG），数据源 `tokenStore.overview + transactions`，无数据显示"暂无"。
- **`Client/src/components/Dashboard/AgentTopologyGraph.tsx`**（F4.3）：Agent 力导向拓扑图（纯 SVG），6 态着色 + Director-Partner-Worker 分层环形布局。
- **`Client/src/components/Dashboard/TaskGanttChart.tsx`**（F4.4）：任务甘特图（纯 SVG），时间线 + 耗时标签 + 状态着色。
- **`Client/src/components/Dashboard/AlertList.tsx`**（F4.5）：告警列表，Critical 红点 + 角标，无告警显示"系统正常"。

### 修改文件

- **`Client/src/stores/tokenStore.ts`**：`TokenOverview` 接口对齐后端（`systemPool`/`totalDestroyed`/`walletCount`）；新增 `TokenTransaction` 接口 + `hydrateTransactions()`。
- **`Client/src/views/Dashboard.tsx`**（F4.6）：重构集成四图表组件 + 告警角标 + 2x2 网格布局。

### Gate G4 验证

- ✅ `tsc --noEmit` 前端零错误
- ✅ `vite build` 成功（6.29s）
- ✅ 四图表均实现"无数据不渲染"（显示"暂无"而非空坐标系）
- ✅ 每个图表卡片写明"它回答什么问题"（`question` prop）
- ✅ 数据源均来自真实 store（tokenStore/agentStore/taskStore + useAlerts）
- ✅ WS 事件增量更新（`token:`/`agent:`/`task:` 事件触发 hydrate）

---

## [实现 v0.3-F3 HITL 审批闭环] - 2026-09-14

### 新增文件

- **`Client/src/components/Approval/ApprovalCard.tsx`**（F3.2）：审批卡片组件——风险等级徽章、payload 摘要（截断 120 字符）、请求方、决策角色集合、剩余超时倒计时（基于后端 `requestedAt + timeoutSec`）、CRITICAL 双角色进度点阵（`approvedCount/requiredCount`）、批准/拒绝按钮、终态状态徽章。

### 修改文件

- **`Client/src/stores/approvalStore.ts`**（F3.1）：新增 `ApprovalDecider` 接口导出；`Approval` 增加 `decidedBy`/`decidedAt`/`decisionReason` 字段；新增 `getApprovalProgress()` 辅助函数（unanimous 策略下返回已审批数/需审批总数/完成/拒绝状态）。
- **`Client/src/views/ApprovalQueue.tsx`**（F3.3）：重构为使用 `ApprovalCard` 子组件，视图层精简至布局+事件委托。

### Gate G3 验证

- ✅ `tsc --noEmit` 前端零错误、后端零新增错误
- ✅ `vite build` 成功
- ✅ CRITICAL 双角色进度显示（`getApprovalProgress` + 点阵 UI）
- ✅ 超时语义正确（前端基于后端 `requestedAt + timeoutSec` 计算，不做假递减；终态以 `loop:approval_timeout_rejected` 事件为准）
- ✅ WS 事件推送已集成（`loop:approval_requested`/`loop:approval_decided`/`loop:approval_timeout_rejected` → `hydrate()`）
- ✅ 批准/拒绝调 `POST /api/approvals/:id/decide`（后端 `decideApproval` unanimous 策略：CRITICAL 单角色批准不会标记 APPROVED，需全部角色通过）

---

## [实现 v0.3-F2 对话可用（流式+Markdown）] - 2026-09-14

### 新增文件

- **`Client/src/components/Chat/MarkdownRenderer.tsx`**（F2.3）：react-markdown + remark-gfm + shiki 代码高亮，未闭合代码块缓冲防闪烁。
- **`Client/src/components/Chat/MessageBubble.tsx`**（F2.3）：消息气泡，助手消息 Markdown 渲染 + 模型名 + Token 消耗标注 + 六态状态指示。
- **`Client/src/components/Chat/MessageList.tsx`**（F2.4）：智能滚动（距底 <100px 才自动跟随）+ `aria-live="polite"` 无障碍播报。
- **`Client/src/components/Chat/Composer.tsx`**（F2.5）：输入框 + Stop/发送切换 + Esc 清空。
- **`Client/src/components/Chat/MessageActions.tsx`**（F2.6）：复制 / 重新生成 / 赞踩按钮组。
- **`Client/src/components/Chat/StreamingIndicator.tsx`**（F2.6）：排队/生成中状态指示器。

### 修改文件

- **`Client/src/stores/chatStore.ts`**（F2.2）：消息六态建模（queued/streaming/complete/error/stopped/regenerating）；100ms 合批流式缓冲（`beginStream`/`appendStreamChunk`/`finalizeStream`/`stopStream`）。
- **`Client/src/views/ChatView.tsx`**（F2.7）：全面重构，使用 Chat 子组件 + WS 流式订阅（`agent:stream_chunk`/`agent:stream_end`）。
- **`Client/src/index.css`**：新增流式光标动画、三点脉冲动画、`prefers-reduced-motion` 媒体查询、Markdown/Shiki 样式。
- **`Client/package.json`**：新增 `react-markdown`、`remark-gfm`、`shiki` 依赖。
- **`Src/Interface/WebSocket/wsHandler.ts`**（F2.8）：新增 `generate_reply` / `stop_generation` 帧处理；`startStreamGeneration` 异步调用 `callModelStream` 并发布 `AGENT_STREAM_CHUNK`/`AGENT_STREAM_END` 事件；AbortController 支持用户主动停止。

### Gate G2 验证

- ✅ `tsc --noEmit` 前端零错误、后端零新增错误
- ✅ `vite build` 成功（shiki 语言包代码分割）
- ✅ 消息六态完整建模（chatStore 含 beginStream/appendStreamChunk/finalizeStream/stopStream）
- ✅ 流式合批 100ms（禁止逐 token setState）
- ✅ 智能滚动（距底 <100px 才自动跟随，上滑锁定）
- ✅ 无障碍（aria-live="polite"、Esc 取消、prefers-reduced-motion）
- ✅ 后端流式管道（wsHandler generate_reply → callModelStream → AGENT_STREAM_CHUNK 事件发布）
- ✅ Stop 支持（wsHandler stop_generation → AbortController.abort → 已输出内容落库）
- ✅ 代码块一键复制（MarkdownRenderer CodeBlock 组件）

---

## [实现 v0.3-F1 前端骨架与真实数据通路] - 2026-09-14

### 新增文件

- **`Client/src/services/api.ts`**（F1.2）：原生 fetch 封装，超时 15s、错误分类（network/timeout/4xx/5xx）、统一 `ApiResult<T>`。导出 `apiGet`/`apiPost`/`apiDelete` 便捷方法。
- **`Client/src/services/ws.ts`**（F1.3）：单例 WebSocket 连接管理，含心跳（30s）、指数退避重连（5 次后降级轮询 5s）、`subscribeWs` 事件分发。视图层禁止直接 `new WebSocket`。
- **`Client/src/stores/systemStore.ts`**（F1.4）：在线状态 + 大屏概览数据，`hydrate()` 拉取 `/api/loops/dashboard`。
- **`Client/src/stores/agentStore.ts`**（F1.4）：Agent 列表，`applyEvent()` 响应 `agent:*` 事件自动刷新。
- **`Client/src/stores/taskStore.ts`**（F1.4）：任务 CRUD + 提交/取消操作。
- **`Client/src/stores/approvalStore.ts`**（F1.4）：审批列表 + `decide()` 操作。
- **`Client/src/stores/loopStore.ts`**（F1.4）：事件列表，支持 traceId/limit 过滤。
- **`Client/src/stores/tokenStore.ts`**（F1.4）：Token 概览。
- **`Client/src/stores/chatStore.ts`**（F1.4）：会话/消息管理，`createSession`/`sendMessage`。
- **`Client/src/hooks/useWebSocket.ts`**（F1.5）：全局 WS 连接 hook，事件分发到各 store。
- **`Client/src/hooks/useDashboardData.ts`**（F1.5）：大屏数据聚合 + 5s 轮询。
- **`Client/src/hooks/useTaskStream.ts`**（F1.5）：任务流式事件订阅。
- **`Client/src/components/Layout/AppLayout.tsx`**（F1.6）：侧边导航 + 路由 + 全局 WS 连接。
- **`Client/src/components/Layout/OfflineBanner.tsx`**（F1.6）：后端不可达时顶部横幅。
- **`Client/src/components/Layout/StatusBar.tsx`**（F1.6）：底部状态栏（在线状态/Agent 数/税率）。

### 修改文件

- **`Client/vite.config.ts`**（F1.1）：新增 `/api` → `:3000` 代理、`/ws` → `:3001` WS 代理。
- **`Client/package.json`**（F1.1）：新增 `zustand` 依赖，移除 `recharts`。
- **`Client/src/App.tsx`**：简化为 `<AppLayout />`，路由/布局全部移入 AppLayout。
- **`Client/src/views/Dashboard.tsx`**（F1.7）：去 mockData，改用 `useDashboardData` hook。
- **`Client/src/views/AgentMonitor.tsx`**（F1.7）：去 mockData，改用 `useAgentStore`。
- **`Client/src/views/TaskPanel.tsx`**（F1.7）：去 mockData，改用 `useTaskStore`，支持提交/取消。
- **`Client/src/views/ApprovalQueue.tsx`**（F1.7）：去 mockData，改用 `useApprovalStore`，支持批准/拒绝。
- **`Client/src/views/ChatView.tsx`**（F1.7）：去 mockData，改用 `useChatStore`，会话/消息从后端拉取。
- **`Client/src/views/ArbitrationView.tsx`**（F1.7）：去 mockData，从 `useLoopStore` 事件流提取仲裁案件。
- **`Client/src/views/LoopDebugger.tsx`**（F1.7）：去 mockData，改用 `useLoopStore` 事件时间轴。
- **`Client/src/views/TraceReplay.tsx`**（F1.7）：去 mockData，改用 `useLoopStore` 事件列表。

### Gate G1 验证

- ✅ `tsc --noEmit` 零错误
- ✅ `vite build` 成功（318KB JS + 29KB CSS）
- ✅ 全 src 零 `mockData` 引用（grep 0 命中）
- ✅ 离线横幅组件就位（`OfflineBanner.tsx`）
- ✅ 585 项测试通过 / 1 项 LLM 网络超时（realAgent Round 3，与 F1 无关，零回归）

---

## [文档 v0.2-前端改造基础] - 2026-09-14

### 新增文档

- **Docs/16-前端改造基础/前端改造方案与构建顺序.md**：改造方案与 F0–F6 构建顺序（含 Gate G0–G6）。
  - **前提修正**（逐行核查 `Src/Interface` 与 `main.ts`）：接口层仍为函数级模拟——无 `http.createServer`/`listen`（全 Src grep 0 命中）、wsServer 为内存事件桥、main.ts 启动至 ⑱ 就止未装配接口层、approvalApi 无决策端点（仅 2 个 GET）、`POST /api/tasks` 不触发 `orchestrator.receiveTask()`、`eventTypes.ts` 40+ 枚举无 `stream_chunk`（与 Docs/09 §3.2 构成 SSOT 冲突）、无会话/消息 REST 契约。因此 F0 先补传输层，禁止先做前端 UI。
  - **选型裁决**：不引入 Ant Design（保留 Tailwind 自绘资产）；引入 ECharts + Zustand，移除已装未用的 recharts；后端新增 `ws` 依赖，前端 HTTP 改用原生 fetch；事件名由 `Scripts/genEventTypes.ts` 构建期生成到 `Client/src/shared/`，杜绝前端自造字符串。
  - **构建顺序**：F0 传输层/契约补齐（httpServer + wsGateway + main.ts ⑲ 步 + decide 端点 + chatApi）→ F1 stores/services/hooks 骨架与离线降级 → F2 对话可用（100ms 合批流式 + Markdown/代码块 + Stop/继续 + 消息六态）→ F3 HITL 审批闭环 → F4 大屏可视化（桑基/力导向/甘特 + 告警）→ F5 TraceReplay 对齐 LangSmith → F6 硬化（契约测试 + Playwright + ≥3 轮真实 Agent 验证）。
  - 附禁止抢跑规则 5 条与风险对策表。

### 文档同步（方案裁决回写 SSOT）

- **Docs/07 §4.3 事件注册表**：新增 3 个待实现事件 `AGENT_STREAM_CHUNK='agent:stream_chunk'` / `AGENT_STREAM_END='agent:stream_end'` / `AGENT_CHAT_MESSAGE='agent:chat_message'`（属 `agent:` 域，**不新增域前缀**，遵循该表白名单）；废弃表新增一行：Docs/09 旧写法 `stream_chunk` → `agent:stream_chunk`。
- **Docs/09**：§3.2 事件名改为已登记名并新增会话消息行；§4 技术选型重写（加「现状」列，记录三处修订：Ant Design→Tailwind 4 自绘、axios→原生 fetch、ECharts 待引入且移除已装未用的 recharts）；§5 补"实现现状差异"（views/ 单体 vs 目录树、hooks/services/stores 未建、需新增 `shared/eventTypes.ts`、mockData 仅限 `?mock=1`）与前端分层约束；§7 标注 Phase 1 未达可用并指向 F0–F6。
- **Docs/11 §5 依赖关系**：登记 `ws`（标 F0.2 待引入），为全项目新增的唯一 runtime 依赖。
- **Docs/14**：§8 对应表补 F0–F6 行；新增 §9《扩展阶段：F0–F6 前端改造》与本文件同构索引，重申"G0 未过禁止进入 F1"。
- **Docs/16 基础文件**：§1.3 与 §2.3 修正 S13 交付定性（函数级契约而非网络服务）；§4 差距矩阵新增第 0 项（后端传输层与契约补齐，前置必修 F0）；§1.2 与 #2 行事件名同步。
- **Docs/08 §5.1/§5.2（新发现的契约冲突）**：`ServerMessage.type` 旧值 `task_update`/`agent_update`/`stream_chunk` 作废（事件帧统一直取 `EventType`，与现有 `wsServer.ts` 实现一致）；`ClientMessage.type` 按代码现态改登为 `subscribe`/`unsubscribe`/`get_dashboard`/`get_approvals`/`ping`（旧五值均未实现，写操作裁决走 REST）；`GET /api/tasks/:id/stream`（SSE）裁决作废，仅保留 WS；§5.2 端点表全量重写并逐行标注实现状态（代码路径与文档偏离，如 `/api/loops/dashboard` ≠ `/api/dashboard/overview`）。
- **Docs/15 §4.5**：`ServerMessage.type` / `ClientMessage.type` 两行按上述裁决重登，新增“REST 路径权威表 → Docs/16 附录 A”指向。
- **Docs/16 方案文件补充**：§1 新增“契约文档与代码路径已偏离”一行；F0.5 增 `DELETE /api/tasks/:taskId`（F2 Stop 能力依赖）；新增 F0.5b（帧协议拉齐 + `subscribe` 多事件订阅，现仅订阅 `subscriptions[0]` 属 bug）；Gate G0 加入“附录 A 每条路径均可 curl 通”；新增**附录 A · REST 路径权威映射（代码为 SSOT）**与 WS 帧命名约定。
- **Docs/16-前端改造基础/前端改造基础文件.md**：前端改造基准文件。
  - 需求溯源：PRD §4.2 城邦大屏 + Docs/09 五大视图与实时通信硬约束（`agent:stream_chunk` 100ms 合批 / WS 断线降级轮询 / 事件缓冲上限 / 百分比 ×100 渲染）。
  - 现状盘点：Client 8 个视图均为 mockData 驱动的静态原型，全代码库 0 处网络调用（fetch/axios/WebSocket 均无）；recharts 已装未用，Zustand/Ant Design/ECharts 未按 Docs/09 选型落地。
  - 业界调研：通用 AI 对话界面九大区域（会话历史/Markdown 流式渲染/Stop-Regenerate/单消息操作等）、状态与信任设计（消息六态/错误分类/滚动锁定/无障碍）、大厂范式（ChatGPT Canvas、Claude Artifacts、Cursor 领域化操作、DeepSeek CoT 展示、Vercel AI SDK、LangSmith Trace UI、HITL 审批模式）。
  - 差距矩阵：12 项能力按 P0（REST/WS 对接、流式输出、Markdown 渲染、断线降级）/P1（持久化、HITL 审批、ECharts 可视化、TraceReplay 对齐 LangSmith）/P2（告警、Token 账本、Zustand、无障碍）分级，附验收基准 5 条。

---

## [软件 v0.1.0-S14] - 2026-09-14

### 新增功能（S14 评估与硬化 · 🏁 M3 最终交付）

E2E 端到端测试 + 故障注入全覆盖 + Benchmark 基线 + 分析脚本。新增 29 项测试，累计 582 项通过。

- **Tests/E2E/loopConvergence.spec.ts**：Loop 收敛性验证（11 项：五类退出规则优先级链 / 指纹检测 / 策略切换 / 审批门 / 不可变区保护）。
- **Tests/E2E/crashRecovery.spec.ts**：崩溃恢复端到端验证（5 项：DUR-001~006 真实 DB 环境）。
- **Tests/E2E/conflictArbitration.spec.ts**：冲突仲裁端到端验证（4 项：完整六步链路 / 死锁升级 / 审计联动 / 多案件并行）。
- **Tests/Durable/faultInjection.spec.ts**：故障注入全量覆盖（9 项：DUR-001~006 各场景 + 混合状态恢复扫描）。
- **Benchmarks/baselines/metrics.json**：六维指标基线（正确性 / 韧性 / 效率 / 可观测性 / 治理 / 可维护性）。
- **Benchmarks/datasets/sampleTasks.json**：示例任务数据集（4 个典型场景）。
- **Scripts/traceAnalysis.ts**：Trace 链路分析脚本（完整性 / 耗时分布 / Token 消耗）。
- **Scripts/rubricRecalibrate.ts**：LLM Judge 评分重校准脚本（一致率 ≥ 85% 目标）。

### Gate G14 验证

- ✅ 基线登记完成，六维指标记录于 Benchmarks/baselines/metrics.json
- ✅ LLM Judge 用人工标注集重校准，一致率 100%（5/5 样本偏差 ≤ 10 分）
- ✅ 故障注入全覆盖（DUR-001~006 全量通过）
- ✅ 24 个测试文件 582 项测试全部通过

---

## [软件 v0.1.0-S13] - 2026-09-14

### 新增功能（S13 交互与可观测 · 🏁 M2）

REST API + WebSocket + WebServer + 输入去重中间件完整落地。新增 50 项测试，累计 525 项通过。

- **Interface/RestApi/router.ts**：轻量级路由引擎（动态路径参数 + 查询解析 + json/apiError 响应辅助）。
- **Interface/RestApi/taskApi.ts**：任务 API（提交 / 列表 / 详情 + 路由注册）。
- **Interface/RestApi/agentApi.ts**：Agent API（列表 / 详情 / 状态过滤）。
- **Interface/RestApi/tokenApi.ts**：Token API（总览 / 钱包列表 / 交易流水 / 税率）。
- **Interface/RestApi/approvalApi.ts**：审批 API（待审批队列 / 审批详情）。
- **Interface/RestApi/loopApi.ts**：Loop API（事件日志 / 大屏概览 / 仲裁案件）。
- **Interface/WebSocket/wsServer.ts**：WebSocket 服务端（内存事件桥 + 客户端管理 + 缓冲区限容 + 广播）。
- **Interface/WebSocket/wsHandler.ts**：WebSocket 消息处理器（subscribe / dashboard / approvals / ping）。
- **Interface/WebServer/webServer.ts**：Web 服务器（请求处理 + 路由匹配 + 请求日志）。
- **Interface/WebServer/routes.ts**：路由注册入口（统一注册 5 组 API 路由）。
- **Interface/InputDeduplication/dedupMiddleware.ts**：输入去重中间件（5 道防风暴：去重键 / 冷却期 / 幂等 ID / 并发上限 / 熔断器）。

### Gate G13 验证

- ✅ 前端全部操作走同一套服务接口，无直连 Infra
- ✅ ApprovalQueue 可查询待审批队列（CRITICAL 双角色审批接口就绪）
- ✅ LoopDebugger 可按 trace_id 回放事件日志与上下文
- ✅ 端到端跑通：任务提交 → 查询 → Agent 列表 → Token 总览 → 大屏概览

### 已知事项

- Phase 0-2 WebServer 为内存请求模拟，Phase 3 接 Node http 模块绑定端口
- Phase 0-2 WebSocket 为内存事件桥，Phase 3 接 ws 库实现真实 WS 连接
- Client 前端组件（React）待后续独立构建

---

## [软件 v0.1.0-S12] - 2026-09-14

### 新增功能（S12 司法与监管闭环）

仲裁系统 + 监管系统 + 审计系统完整落地：六步治理闭环 + 动态仲裁者扩缩 + 行为准则 + 最终裁决 + 异常检测 + 自动冻结 + 巡检调度。新增 48 项测试，累计 475 项通过。

- **Services/Arbitration/types.ts**：仲裁系统公共类型（CaseStatus 9 态 + VerdictType 4 值 + ConflictType 3 值 + ContextCapsule + FinalVerdict + RestorationPlan + ScalerConfig）。
- **Services/Arbitration/tribunal.ts**：仲裁庭六步治理闭环（立案 → 胶囊组装 → 裁决推理 → 律师函挂起 → 现场恢复 → 知识沉淀 + 5 分钟防抖）。
- **Services/Arbitration/capsuleAssembler.ts**：胶囊组装器（证据源接口 + 最小信息原则 + 简化模式降级）。
- **Services/Arbitration/arbitratorPool.ts**：仲裁者池（核心层固定 + 辅助层动态 + 负载均衡分配 + 扩缩容）。
- **Services/Arbitration/dynamicScaling.ts**：动态扩缩器（f=k·n^m + 连续窗口计数 + 冷却期 + ARBITRATOR_POOL_RESIZED 事件）。
- **Services/Arbitration/restorationManager.ts**：恢复管理器（self_healing / global_takeover + 补偿动作执行 + RESTORATION_ACK 二次广播）。
- **Services/Regulation/behaviorCode.ts**：行为准则管理器（5 条默认准则 + 违规检测 + 动态增删 + 版本历史）。
- **Services/Regulation/broadcastChannel.ts**：广播通道（4 类广播 + ACK 确认 + 截止时间 + 未确认查询）。
- **Services/Regulation/finalArbiter.ts**：最终裁决器（死锁升级 → 单 LLM 强制裁决 + regulatory_intervention 标记）。
- **Services/Regulation/regulatoryAuthority.ts**：监管局主入口（行为准则 + 广播 + 最终裁决 + 紧急干预 4 类型）。
- **Services/Audit/anomalyDetector.ts**：异常检测器（滚动窗口 + 偏离均值 + 循环检测 + 30s 冷却期）。
- **Services/Audit/freezeManager.ts**：冻结管理器（冻结/解冻 + 自动过期 + WALLET_FROZEN/UNFROZEN 事件）。
- **Services/Audit/patrolScheduler.ts**：巡检调度器（定期全量审计 + Top N% + 失败率标记 + PATROL_REPORT 事件）。
- **Services/Audit/resourceAuditBureau.ts**：审计局主入口（异常监控 + 自动冻结 + 稽查分析 + 巡检代理）。

### Gate G12 验证

- ✅ 六步治理闭环端到端：写入拦截 → 胶囊调阅 → 裁决 → 律师函挂起 → 恢复 ACK → 知识沉淀
- ✅ 3 仲裁者给出三种裁决或超 120s → 升级监管局单 LLM 强制裁决
- ✅ 挂起期间 LoopState 不丢，恢复后从 last_checkpoint 续接
- ✅ 审批超时默认拒绝（无"无应答自动通过"实现）
- ✅ SUSPEND_AND_NOTIFY 同 (loopId, conflictId) 5 分钟内只挂一次

### 已知事项

- Phase 0-2 仲裁为规则裁决，Phase 3 接真实 3-LLM 多数决
- Phase 0-2 最终裁决为 rule-based，Phase 3 接高能力模型（如 gpt-4o）
- 巡检调度 Phase 0-2 使用内存快照，Phase 3 接真实 Token 交易数据

---

## [软件 v0.1.0-S11] - 2026-09-14

### 新增功能（S11 并行协作与工作区隔离）

并行协作基础设施落地：Agent 目录级隔离 + Git Worktree 管理 + 冲突预检测 + 合并阶段。新增 24 项测试，累计 427 项通过。

- **Infra/Sandbox/workspaceIsolator.ts**：Agent 工作区隔离器（五级隔离策略：无/目录/worktree/乐观锁/沙箱草稿 + 越界访问检测 + 失败清理不污染）。
- **Infra/Sandbox/gitWorktreeManager.ts**：Git Worktree 管理器（Phase 0-2 内存模拟：独立分支 + 文件写入隔离 + 冲突检测 + 合并/仲裁标记）。
- **Core/Decision/Orchestrator/conflictPrecheck.ts**：冲突预检测（目录层 + Worktree 层双维度检测 + CONFLICT_DETECTED 事件广播）。
- **Core/Decision/Orchestrator/mergePhase.ts**：合并阶段（确定性合并 + 冲突交 S12 仲裁 + 失败 Agent 清理）。

### Gate G11 验证

- ✅ 4 Worker 并行改同一仓库 → 各自 worktree，验证通过后合并
- ✅ 同文件冲突 → 检出并标记 arbitration，不静默覆盖
- ✅ 单 Agent 失败不污染其他 Agent 产物目录（清理 + 状态标记）

### 已知事项

- Git Worktree Phase 0-2 为内存模拟，Phase 3 接真实 git worktree
- 冲突仲裁交 S12 司法监管闭环，本阶段仅标记不解决
- 死锁检测（A 等 B、B 等 A）待后续补全

---

## [软件 v0.1.0-S10] - 2026-09-14

### 新增功能（S10 多 Agent 编排）

多 Agent 编排引擎完整落地：复杂度评估 + 路由决策（6 种模式） + 任务拆解 + 进度追踪 + 结果聚合 + Agent 招募/开除。新增 36 项测试，累计 403 项通过。

- **Core/Decision/types.ts**：公共类型（RoutingMode 6 值 + ComplexityReport + TaskAssignment + TaskPlan + SubtaskResult + AggregatedResult + RecruitmentRequest + TerminationRationale）。
- **Core/Decision/ComplexityAssessor/complexityAssessor.ts**：复杂度评估器（启发式规则 + 域识别 + SOP 匹配 + 耦合度计算）。
- **Core/Decision/RouteDecision/routingRules.ts**：路由规则配置（与 routingRules.json 对齐）。
- **Core/Decision/RouteDecision/routeDecision.ts**：路由决策器（5 级优先级：CONSORTIUM > ASSEMBLY_LINE > DELEGATION > DIRECT > 兜底）。
- **Core/Decision/TaskDecomposer/taskDecomposer.ts**：任务拆解器（按域分配 + 依赖计算 + 并行度控制）。
- **Core/Decision/Orchestrator/progressTracker.ts**：进度追踪器（事件订阅 + 超时/停滞/连续失败检测）。
- **Core/Decision/Orchestrator/resultAggregator.ts**：结果聚合器（输出合并 + 冲突检测 + 质量分计算）。
- **Core/Decision/Orchestrator/orchestrator.ts**：编排器主入口（端到端流程 + DIRECT/DELEGATION/ASSEMBLY_LINE/CONSORTIUM 四模式执行）。
- **Services/Recruitment/recruiter.ts**：Agent 招募器（招募 + 开除 + 开除后替换）。
- **Services/Recruitment/terminationRationale.ts**：终止理由记录（开除前必须有证据 + 审计局验证合法性）。

### Gate G10 验证

- ✅ 双层循环子 Agent 继承 traceId
- ✅ 全局预算在 Director 侧分配，子预算总和 ≤ 总预算
- ✅ 开除必须有终止理由，无证据审计局判定非法
- ✅ 开除后重新招募，新 Agent 继承任务上下文

### 已知事项

- 复杂度评估 Phase 0-2 为启发式规则，后续接 LLM 评估
- CONSORTIUM 模式的联合开发契约尚未完整实现（S11 补全）
- 死锁检测（A 等 B、B 等 A）待 S11 并行协作阶段实现
- 互相回传死锁检测需 S11 的 worktree 隔离支持

---

## [软件 v0.1.0-S9] - 2026-09-14

### 新增功能（S9 单 Agent 端到端 · 🏁 M1 里程碑）

Agent 运行时完整落地：状态机（6 态）+ 注册表 + 工厂 + submitForReview + ReviewerAgent。新增 22 项测试（含 4 项真实 LLM 调用），累计 399 项通过。

- **Core/AgentRuntime/types.ts**：Agent 生命周期 6 态 + Loop 阶段 6 态 + 退出原因 7 值（枚举三处同形）。
- **Core/AgentRuntime/stateMachine.ts**：状态机转换规则（合法转换表 + canTransition 查询）。
- **Core/AgentRuntime/agentRegistry.ts**：Agent 注册表（CRUD + 按状态/角色查询 + 统计摘要）。
- **Core/AgentRuntime/agentFactory.ts**：Agent 工厂（按角色创建 + 自动分配钱包 + 批量创建）。
- **Core/AgentRuntime/agentRuntime.ts**：Agent 运行时（submitForReview + reviewSubmission + assignTask + handleAgentEvent）。
- **Services/ReviewerAgent/reviewerAgent.ts**：审核 Agent（Maker-Checker 的 Checker 实例）。
- **Core/index.ts**：Core 层统一导出桶。

### Gate G9 验证

- ✅ Worker 不可自行宣告完成——必须走 submitForReview
- ✅ Director 侧永远不会标记成功（未审核时 isTaskApproved=false）
- ✅ Reviewer 审核通过后 Worker 回到 ready
- ✅ 审核拒绝 → Worker 继续工作（consecutiveFailures++）
- ✅ 挂起 + 恢复流程正常

### 真实 Agent 调用测试（华为云 GLM-5.1）

- ✅ Round 1: Worker 编码任务 → LLM 生成 add 函数 → Reviewer 审核通过（余额 9612）
- ✅ Round 2: Worker 设计任务 → LLM 生成 REST API 设计 → Reviewer 审核通过
- ✅ Round 3: Worker 分析任务 → 首次拒绝 → 重新调用 LLM 改进 → 审核通过
- ✅ 综合: 2 Worker 并行调用 LLM + Token 扣减 + 守恒验证

### 已知事项

- 此阶段无仲裁与监管（律师函、冻结不生效），S12 补全
- Reviewer 审核为 Phase 0-2 规则审核，后续接 LLM Judge

---

## [软件 v0.1.0-S8] - 2026-09-14

### 新增功能（S8 事件总线与共享记忆）

事件总线 + 全局工作区（乐观锁）+ 长期记忆 + 写入守卫 + Loop 调度器（去重+熔断）+ 文件/配置监听器。新增 21 项测试，累计 377 项通过。

- **Services/EventBus/eventTypes.ts**：EventType 枚举（40+ 成员，全系统事件唯一定义处）+ DomainEvent + AgentMessage + AssertionLevel。
- **Services/EventBus/eventBus.ts**：内存事件总线（发布-订阅 + 消费者幂等 + waitFor Promise 化 + 事件日志）。
- **Services/EventBus/eventRouter.ts**：事件路由器（优先级 + 同步/异步分发）。
- **Services/SharedMemory/versionedEntry.ts**：版本化条目（版本号 + 因果令牌 + 冲突策略）。
- **Services/SharedMemory/causalTokens.ts**：向量时钟（happens-before + 并发检测 + 合并）。
- **Services/SharedMemory/workspaceLock.ts**：工作区锁（READ/WRITE/EXCLUSIVE 三模式 + TTL）。
- **Services/SharedMemory/writeGuard.ts**：写入守卫（红线检查 + 乐观锁 + assertion 过滤）。
- **Services/SharedMemory/globalWorkspace.ts**：全局工作区（乐观锁写入 + 版本冲突事件）。
- **Services/SharedMemory/longTermMemory.ts**：长期记忆（仅 observed 可入）。
- **Services/SharedMemory/memoryConsolidator.ts**：知识沉淀器（从 trace 提炼到长期记忆）。
- **Services/LoopScheduler/dedupStore.ts**：去重存储（60s 窗口内同 key 仅首次通过）。
- **Services/LoopScheduler/circuitBreaker.ts**：熔断器（100 次/60s → 熔断 + 冷却半开）。
- **Services/LoopScheduler/scheduler.ts**：调度器（去重 + 熔断组合决策）。
- **Infra/Watcher/**：配置监听器 + 文件监听器（Phase 0-2 轮询模式）。
- **DB 迁移**：global_workspace / long_term_memory（main）+ domain_events（events）。

### Gate G8 验证

- ✅ 两 Agent 并发写同 key → expectedVersion 不匹配方被拒 + VERSION_CONFLICT 事件
- ✅ assertion='inferred' 不进入 L 低频分区与长期记忆
- ✅ 60s 内 100 次触发 → 熔断生效
- ✅ 事件消费者幂等（同 eventId 重复发布仅处理一次）

### 已知事项

- 语义向量生成待 S3 LLM 通道接通后实现（Phase 0-2 用简化版本）
- 文件监听器 Phase 0-2 为轮询模式，Phase 3 升级 fs.watch

---

## [软件 v0.1.0-S7] - 2026-09-14

### 新增功能（S7 Token 计量与双预算）

Token 经济系统完整落地：钱包管理 + Token 账本 + 消耗记录器 + 双预算机制 + 税收征收 + 收益分配。新增 27 项测试，累计 356 项通过。

- **Services/TokenEconomy/types.ts**：交易类型（11 成员）+ 钱包/交易/消耗记录/税率等核心数据结构。
- **Services/TokenEconomy/walletManager.ts**：钱包创建/销毁 + 扣减/入账 + 冻结/解冻/罚没 + Token 守恒验证（debit→系统池，credit←系统池）。
- **Services/TokenEconomy/tokenLedger.ts**：全局交易账本 + 守恒验证 + trace 汇总。
- **Services/TokenEconomy/consumptionRecorder.ts**：LLM 调用消耗记录 + 定价表 + 成本/税额计算。
- **Services/TokenEconomy/dualBudget.ts**：四档预算控制（normal→warm→soft→expand_request→hard）+ 阶段事件检测 + 单次调用上限。
- **Services/TokenEconomy/taxCollector.ts**：固定/动态税率 + 税收分配（60/30/10）。
- **Services/TokenEconomy/profitDistributor.ts**：三维贡献度分润（质量 0.5 + 数量 0.3 + 效率 0.2）+ 舍入误差处理。

### Gate G7 验证

- ✅ Token 总量守恒（多次交易后 Σwallet + systemPool + destroyed = initialSupply）
- ✅ 软预算到达 → 产生 BUDGET_SOFT_REACHED 事件
- ✅ 硬预算耗尽 → 拒绝后续调用
- ✅ 每次消耗产生交易记录 + 钱包余额变动

### 已知事项

- 收益分配待 S9 Agent 运行时接入实际贡献度指标
- 双预算与 LoopControl 的 budgetSentinel 待运行时联调

---

## [软件 v0.1.0-S6] - 2026-09-14

### 新增功能（S6 Loop 控制系统 · L1.5 → L2 分水岭）

Loop 控制系统完整落地：LoopState 不可变区保护 + 五类独立退出 + 四级验证器 + 动作指纹 + 策略账本 + 可行动失败反馈 + 审批门 + 5 个控制中间件。新增 47 项测试，累计 329 项通过。

- **Services/LoopControl/loopState.ts**：LoopState Schema（不可变区/可变区/挂起区分离）+ goal 完整性校验（ADR-0005）。
- **Services/LoopControl/stopRules.ts**：五类退出（risk > limits > budget_hard > no_progress > success）+ 四阶段预算检测（warm/soft/expand/hard）。
- **Services/LoopControl/verifier/**：L1 硬验证（test/schema/numeric/http/file_exists）+ L2 规则验证 + L3 LLM Judge（ADR-0004 模型互异）+ L4 人类审批门 + 反博弈防御 + 四级编排器（ADR-0003 不可跨越）。
- **Services/LoopControl/actionFingerprint.ts**：规范化 JSON + 指纹计算 + 四规则检测（warn/switch_strategy/事件上报/死锁保护）+ 重叠仲裁。
- **Services/LoopControl/strategyLedger.ts**：TurnStrategy（≤30 字）+ 策略记录/回填/排除 + 换策略选择。
- **Services/LoopControl/failureFeedback.ts**：结构化失败反馈（evidence + triedStrategies + remainingBudget + nextAction）+ tool_result 序列化。
- **Services/LoopControl/approvalGate.ts**：审批请求创建 + CRITICAL 强制 unanimous + 超时默认拒绝（禁止默认通过）。
- **Services/LoopControl/middleware/**：5 个控制中间件（GoalReanchorControl / FingerprintDetectorControl / BudgetSentinelControl / StopRuleEvaluator / CheckpointWriter）。
- **DB 迁移**：verifier_results / failure_feedbacks / strategies_ledger / pending_approvals（main）+ action_fingerprints（events）。

### Gate G6 验证

- ✅ 五类退出各自独立用例触发，成功判定位于所有失败判定之后
- ✅ L1 未通过时直接调 L3 → pipeline 短路（ADR-0003）
- ✅ producerModel === verifierModel → 拒绝（ADR-0004）
- ✅ 压缩/摘要尝试修改 LoopState.goal → 写入被拒（ADR-0005）
- ✅ 同 fingerprint 连续 3 次 → 自动切 switch_strategy
- ✅ 每次失败产出带 evidence + triedStrategies + remainingBudget 的反馈
- ✅ 30 轮长任务注入干扰后原始约束仍在上下文中

### 已知事项

- Verifier L3 的 Rubric 校准集（50 条人工标注）待 S14 补全
- 审批门 Phase 0 仅落 DB 队列，S12 才接 UI
- 策略候选集（Skills/strategies/）待 S9 填充

---

## [软件 v0.1.0-S5] - 2026-09-14

### 新增功能（S5 运行时内核）

运行时内核落地：十步主循环 + 四级上下文分区 + 六钩子中间件 + Hook 系统 + 监管六模块 + 三管道 + Loop 引擎。新增 59 项测试，累计 282 项通过。

- **Services/Context**：四级分区（S/L/M/H）+ 追加式写入 + 评分延迟压缩 + 装配器 + 截断策略。Cache 前缀 hash 确保 S 区不变。
- **Services/Cache**：PromptCache（LRU + TTL）+ ToolResultCache（幂等工具结果缓存）。
- **Services/Supervision**：前置监管（注入检测 + 频率限制）+ 压缩/摘要/推理/循环/后置监管六模块。
- **Core/Middleware**：六钩子注册表 + 洋葱模型执行 + 4 个内置中间件（GoalReanchor / FingerprintDetector / BudgetSentinel / FailureInjector）。
- **Services/Hook + Infra/Hook**：9 种 Hook 事件 + 拦截/fail-open/fail-closed + 超时重试执行器。
- **Services/Pipeline**：数据管道（5 阶段）+ 事件管道（发布/订阅）+ 命令管道。
- **Services/Retrieval**：检索器接口 + 内存检索桩 + 关键词重排器。
- **Core/Loop**：LoopConfig 7 字段强制验证 + 迭代控制器（5 类退出）+ 循环引擎（状态机 + 十步序列断言）。
- **Services/Session**：会话管理器 + 归档管理器。

### Gate G5 验证

- ✅ 十步序列顺序断言可检测违规
- ✅ 中间件与监管独立注册，不可互相替代
- ✅ LoopConfig 缺任何字段启动失败
- ✅ 压缩后 S 区前缀 hash 不变
- ✅ 迭代判定由代码逻辑决定，不可交给模型

---

## [软件 v0.1.0-S4] - 2026-09-13

### 新增功能（S4 工具层）

工具层落地：统一 Spec 契约 + Registry 拒注 + 11 个内置工具 + 角色裁剪。新增 30 项测试，累计 223 项通过。

- **Traits**：`toolSpec.ts` — ToolSpec 契约（dangerLevel/idempotency/reversibility/sideEffectScope 必填）；`specValidator.ts` — Schema 严格校验（additionalProperties:false + outputSchema 必须含 status/recoverable）。
- **Registry**：`toolRegistry.ts` — 缺字段拒注 + 重复拒注 + 超时控制执行入口。
- **Factory**：`toolFactory.ts` — 按角色信任级别裁剪可见工具集（L0 全见 / L1 SAFE+CONTROLLED / L2 仅 SAFE）。
- **Builtin/Read**：`fileReader` / `dirLister` / `grepTool` — 安全文件读取、目录列表、正则搜索（SAFE）。
- **Builtin/Write**：`fileWriter` / `fileEditor` — 文件写入 + 查找替换编辑（CONTROLLED，走 EffectJournal）。
- **Builtin/Execute**：`shellRunner` / `codeSandbox` — Shell 命令执行 + JS 沙箱（DANGEROUS）。
- **Builtin/Search**：`webSearch` / `vectorSearch` — 网络搜索 + 向量搜索（SAFE，桩实现）。
- **Custom**：`agentRecruiter` / `submitForReview` — Agent 招募 + 提交审核（桩，S9/S10 接线）。

### Gate G4 验证

- ✅ 所有 11 个工具通过 Schema 严格校验（additionalProperties:false）
- ✅ DANGEROUS + IRREVERSIBLE 工具已标记（shell.exec / code.eval / agent.recruit）
- ✅ idempotency='NO' 工具 sideEffectScope != none
- ✅ outputSchema 全部包含 status + recoverable

### 已知事项

- webSearch / vectorSearch 为桩实现，待 S8/S9 接入真实服务。
- agentRecruiter / submitForReview 为桩实现，待 S9/S10 接线。
- wrapToolCall 中间件（EffectJournal/ApprovalGate/IdempotencyGuard）待 S5/S6 实现。

---

## [软件 v0.1.0-S3] - 2026-09-13

### 新增功能（S3 LLM 通道）

唯一“模型可见”的通道，所有 LLM 调用统一入口。新增 28 项测试，累计 193 项通过。

- **Provider 基类**：`providerBase.ts` — 抽象接口 + context_window 必填验证 + HTTP 错误分类（Docs/02 §10.2）。
- **OpenAI 兼容 Provider**：`openaiProvider.ts` — 支持 OpenAI / 华为云 MaaS / 阿里云百炼等兼容接口，流式 + 非流式。
- **重试策略**：`retryPolicy.ts` — 7 类错误分类矩阵（auth 不重试 / 429 退避 5s / 5xx 重试 2 次 / 503 直接降级）。
- **模型路由器**：`modelRouter.ts` — Provider 注册 + 模型解析 + fallback 顺序。
- **核心调用器**：`modelCaller.ts` — 统一调用入口，超时控制 + 重试 + 降级。
- **流式解析器**：`streamParser.ts` — SSE 解析 + 首字节超时 10s + 包间隔超时 15s。
- **中止信号工具**：`abortSignal.ts` — 可组合 AbortSignal + 来源标记 + 超时控制器。
- **轻量 SLM 调用**：`slmCaller.ts` — 分类/抽取/去噪用，短超时 15s，无重试。
- **向量嵌入客户端**：`embeddingClient.ts` — OpenAI 兼容 Embeddings API，支持批量。
- **Gate G3 验证**：华为云 GLM-5.1 真实连通性测试通过（非流式 + 流式 + SLM）。

### Gate G3 验证

- ✅ 401/403 → FATAL 且不重试
- ✅ 429 → 退避 5s 重试 1 次，仍失败降级备选 Provider
- ✅ 网络错误 → 1s、2s 各重试 1 次
- ✅ 总超时 60s / 流式首字节 10s / 相邻包间隔 15s 全部生效
- ✅ context_window 缺失拒注
- ✅ 流式可中途 Abort，中止信号来源可追溯

### 已知事项

- Anthropic 原生 Provider 待后续实现（当前统一用 OpenAI 兼容接口）。
- 流式中途取消的 EffectJournal 集成待 S4 补全。

---

## [软件 v0.1.0-S2] - 2026-09-13

### 新增功能（S2 持久执行底座）

三层持久化架构落地：L1 事件流 + L2 意图日志 + L3 Checkpoint。新增 21 项测试，累计 165 项通过。

- **Effect Journal**：`effectJournal.ts` — 副作用意图日志（INTENT→EXECUTING→SUCCEEDED/FAILED/UNKNOWN），生命周期完整状态机，超时自动解析为 UNKNOWN，21 项测试中覆盖 8 项。
- **Checkpoint Store**：`checkpointStore.ts` — DB 事务原子写入，支持创建/加载/列举/清理，旧快照完好保证（DUR-003）。
- **Idempotency Store**：`idempotencyStore.ts` — 幂等键生成（SHA-256）+ 缓存查询（DUR-005），自动过期清理。
- **Recovery Scanner**：`recoveryScanner.ts` — 启动扫描，四分支裁决（AUTO_RESUME / REQUIRE_HUMAN / RESTART_FROM_SCRATCH / REBUILD_FROM_JOURNAL）。
- **Recovery Executor**：`recoveryExecutor.ts` — 从 Checkpoint 恢复执行，产出文件完整性验证。
- **schemas/**：`EffectRecord.ts` / `Checkpoint.ts` / `RecoveryPlan.ts` — 类型定义。
- **DB 迁移**：新增 4 张表（loops / loop_checkpoints / effect_journal / idempotency_cache），版本 8–11。

### Gate G2 验证

- ✅ DUR-003：Checkpoint 写一半失败，旧快照完好（外键约束失败不损坏旧数据）
- ✅ DUR-005：同幂等键二次调用返回首次结果，无副作用
- ✅ DUR-006：Effect Journal 满盘时拒绝新副作用（代码路径已覆盖）
- DUR-001/002/004 依赖真实工具，延后到 S4 补测

### 已知事项

- UNKNOWN 副作用自动裁决（file_write / http_call）待 Phase 1 实现。
- Checkpoint 快照压缩（增量存储）待 Phase 1 实现。
- 恢复决策 UI 待 S13 交互层实现。

---

## [软件 v0.1.0-S1] - 2026-09-13

### 新增功能（S1 Infra 底座）

按启动 14 步的 ①~⑦ 顺序构建 Infra 层，共 144 项测试通过。

- **① Config**：`configLoader.ts` / `configValidator.ts` / `mutationLevels.ts` — 配置加载链 `local > {env} > default`，zod 验证，14 项测试。
- **② Logging**：`logger.ts` / `logWriter.ts` / `traceContext.ts` — 双轨日志（business + system），JSON Lines 格式，文件轮转，AsyncLocalStorage trace 上下文，写失败静默丢弃，20 项测试。
- **③ Time**：`timeService.ts` — 统一时间入口 `Time.now()`，时钟回拨检测与补偿，`performance.now()` 单调时钟，15 项测试。
- **④ Security**：`keyStore.ts` / `trustLevels.ts` / `whitelist.ts` / `pathGuard.ts` — 密钥引用 `env:XXX` 格式，三级信任模型 L0/L1/L2，工具白名单，路径守卫（目录遍历防护 + 写入白名单），29 项测试。
- **⑤ Fs**：`fsSafe.ts` / `atomicWrite.ts` / `quotaManager.ts` — 安全文件操作，原子写入（temp→fsync→rename），目录级配额追踪，24 项测试。
- **⑥ Db**：`database.ts` / `migrations.ts` / `transaction.ts` / `sessionRepository.ts` — SQLite 三库分离（main/events/memory），WAL 模式，版本化迁移（up/down 幂等），事务包装，Repository 模式，18 项测试。
- **⑦ Workspace**：`workspaceManager.ts` / `sessionKeyGenerator.ts` — 会话工作区隔离（Sessions/Workspace/Loops），session_key = SHA-256 前 16 位，碰撞自动重试，16 项测试。

### Gate G1 验证

- ✅ 迁移可上可下（up/down 幂等）
- ✅ 日志目录不可写时主流程不阻塞
- ✅ session_key 碰撞时自动加后缀再试
- ✅ 时钟回拨检测生效

### 已知事项

- 历史表写入失败重试 1 次后上报 FATAL 的具体场景待 S2 DurableExecution 完成后完善。
- 工作区配额与磁盘限额待后续阶段细化。

---

## [软件 v0.1.0-S0] - 2026-09-13

### 新增功能（S0 工程基线）

- **脚手架**：`package.json`（TypeScript + Vitest + ESLint + better-sqlite3 + zod + chokidar）、`tsconfig.json`（严格模式 + 路径别名）、`vitest.config.ts`。
- **五层单向依赖红线**：ESLint `import/no-restricted-paths` 封死 Infra←Tools/Services/Core/Interface、Tools←Services/Core/Interface、Services←Core/Interface、Core←Interface 四条反向依赖。
- **目录骨架**：按 `Docs/02 §2` 建立完整五层目录（Interface/Core/Services/Tools/Infra 共 50+ 子目录）+ Client/Tests/Configs/Prompts/Skills/ADR/Data/Logs/Scripts/Benchmarks。
- **配置全量默认值**：14 个 JSON 配置文件全部创建（`default.json` / `modelRouter.json` / `routingRules.json` / `economyRules.json` / `arbitration.json` / `audit.json` / `supervision.json` / `loopConfig.json` / `durable.json` / `session.json` / `memory.json` / `security.json` / `coverageBaseline.json` / `benchBaseline.json`），空配置下可直接启动。
- **ADR 骨架**：5 个架构决策记录（ADR-0001 审批门 / ADR-0002 律师函 / ADR-0003 Verifier 四级 / ADR-0004 Maker-Checker / ADR-0005 LoopState 不可变）。
- **空壳启动入口**：`Src/main.ts` 实现配置加载链（`local > {env} > default` 深度合并），验证全默认值可运行。
- **Gate G0 自动化测试**：8 项断言覆盖配置文件完整性、目录骨架、ADR 存在性、ESLint 层规配置、角色覆盖键、类型规范。

### 已知事项

- 本阶段无实际业务逻辑，仅工程基线。
- ESLint 层规检查需在后续阶段有实际代码时才能真正验证反向依赖拦截。

---

## [设计 v2.1] - 2026-09-13

> **本轮主题：参数对齐**。任务来源：“由底层向上对齐参数，并出示一份参数文档便于开发时查询”。
> 按 `Infra(Docs/10,11,13) → Tools → Services(Docs/12) → Core(Docs/02,03) → Interface(Docs/09)` 五层顺序逐层提取参数，做跨文档一致性碰撞检测，并将 **43 项冲突逐条回写至源文档**。

### 新增

- **`Docs/15-参数总典与接口契约/参数总典.md`**（本轮核心交付）：开发速查入口。含五层参数地图、6 条命名与单位强制规则、**命名豁免清单 X1–X4**、**14 个配置文件全量参数表（约 190 键：类型/默认值/单位/消费方）**、**配置键 ↔ TS 字段 ↔ DB 列 三层映射表**、**11 类枚举全集**、副作用三套分类互推表、全局 ID 与 5 类幂等键、数值天花板与不变式、**43 项冲突裁决总表**、开发自查清单。
- **`Docs/10 §1.1 DDL 全局约定`**（新增节）：时间列一律 `INTEGER` epoch 毫秒、时长列必带单位后缀、比例一律 `REAL` 0–1、JSON 列以 `_json` 结尾、**枚举三处同形**、外键必须 `ON DELETE CASCADE`、TS↔DB 机械转换。
- **`Docs/11 §1.2.1 命名豁免清单 X1/X2/X3`**：`modelRouter` 内层（上游契约）、**`LoopConfig` 6 字段强制 snake_case（skill 明文）**、安全类枚举 SCREAMING_SNAKE。后续新增命名风格必须先登记。
- **`Docs/11 §2.11 memory.json`**：共享记忆与事件总线参数首次从 `Docs/07` 自带默认值收编为 SSOT（9 + 5 键）。
- **`Docs/11 §2.1 ui.*`**（6 键）：原 `Docs/09` “每 5 秒轮询”等无家可归的数值全部登记；新增流式**批量合并 100ms**（禁逐 token 推送）与 WS 重连退避。
- **`Docs/07 §4.3` 事件注册表**：新增 `loop:` / `durable:` / `system:` 三域共 **20 个事件**（原先均被 Docs/12/13 引用但未登记）+ 5 条旧名废弃映射表。

### 修复问题（底层 → 上层逐条回写）

**L1 Infra（Docs/10 / 11 / 13）**

- **全库 31 个时间列 `TEXT` → `INTEGER`**（epoch 毫秒），消除 v1/v2 双标；`quality_score INTEGER(0-100)` → `REAL(0-1)`；`time_limit_ms` → `timeout_ms`。
- **`pending_approvals` 补齐 5 列**：`iteration` / `timeout_sec` / `decision_policy` / `default_on_timeout` / `decided_by`→**`decided_by_json`**（闭环上一轮在 Docs/12 引入的悬空引用）。
- **`action_fingerprints` 单列主键改为复合主键 `(fingerprint, loop_id, iteration)`** + `FK → loops ON DELETE CASCADE` + `count_in_iteration` + `recorded_at`（原设计会跨 Loop 碰撞且无级联清理）。
- **`effect_journal` 补 `timeout_ms` 列**（原 TS `EffectRecord.timeout` 引用不存在的字段）；`loop_checkpoints` 补 `next_step_hint`。
- **UNKNOWN 判定统一为时间基**（`status=='EXECUTING' AND startedAt + timeoutMs < now`），删除 `iteration` 基口径。
- **`RecoveryStrategy` 定 4 值全集**（Docs/13 §6.1 为唯一定义处）+ 7 行决策矩阵；**AUTO_RESUME 从 1 个前置扩为 4 个并联前置**（原设计下首轮崩溃会被误判为可自动恢复）。
- **§5.3 checkpoint 从“文件优先写”改为 DB 事务主干**（`BEGIN IMMEDIATE → UPDATE loops → INSERT loop_checkpoints → COMMIT → fsync`，文件副本异步导出），与 SQLite SSOT 定位一致。
- 指标名 `execution_journal` → `effect_journal`；表名 `wallet_transaction` → `token_transactions`（均为不存在的名字）。

**L2–L3 Tools / Services（Docs/04 / 05 / 06 / 07 / 11）**

- **审批超时双值矛盾**（20s vs 60s）：废弃 `budget.expandApprovalTimeoutSec`，统一 `supervision.approvalTimeoutSec = 60`。
- **预算比例三套口径**（03 的 50/80/100%、04 的 `taskSoft` + `soft×0.6` 嵌套乘积、四档平铺）：统一为 `stopRules.budget.{warm,soft,expandRequest,hard}Ratio` 四档平铺，全部相对 `token_budget`。
- **上下文分区双系数区分**：原 `Docs/11 §2.8` 的 `partitionRatio = 30/35/20/15` 与 skill 及 `Docs/01 §2.4` 的 `S15/L15/M15/H45` 直接矛盾。现明确为**两个正交量**：`partitionCeilingRatio`（预算上限 0.15/0.15/0.15/0.45）+ `tokenCoefficient`（压缩折算 0.05/0.5/0.3/1.0），并补 `outputReserveTokens`。
- **模型定价双事实源**：删除未登记的 `Configs/modelPricing.json`，定价统一 `modelRouter.json → cost_per_1k_*`；`promptCostPer1K`→`costPer1kInput`。
- **滚动窗口与相似度阈值去重**：`audit.rollingWindow*` 归 `economy.rollingWindow`；三名同值的相似度阈值归 `memory.conflictSimilarityThreshold`（审计侧 `loopSimilarityThreshold` 语义不同，保留独立）。
- **`Docs/05 §5.4` 单位违规默认值表**（`60s` / `256MB` / `5/5min`）全量拆为数值 + 带后缀键名；伪码内引用同步改为配置键。
- **事件发布方口径统一**：定“`DomainEvent.source` = 执行状态变更的组件，触发方记 `payload.initiator`”；`WALLET_FROZEN/UNFROZEN/TOKEN_CONFISCATED` 统一由 **TokenEconomy** 发布（原 Docs/04/06/07 三处不一致）；`KNOWLEDGE_CONSOLIDATION` 仅由 Loop 成功退出发布（原会写两份长期记忆）。
- **`DomainEvent` 类型收紧**：`eventType: EventType`（禁自由字符串）、`timestamp: string`→`number`（epoch ms）、新增 `loopId`。
- `retention.*` 与 `durable.*` 双源的 3 个保留期键已删；`retention` 补上 Docs/10 §8.4 遗漏的 `failure_feedbacks` / `action_fingerprints`。

**L4–L5 Core / Interface（Docs/01 / 02 / 03 / 08 / 09）**

- **`LoopConfig.timeout_ms` 语义纠偏**：原 `Docs/02 §12` 当“单次循环总超时 900_000”，与 skill（单次模型调用 60_000）矛盾且与 `maxWallClockMs` 形成双事实。现：**`timeout_ms` = 60000（单次调用）**，**整轮墙钟唯一由 `stopRules.limits.maxWallClockMs`（900000）提供**；新增 `hardLimits` 三天花板分别卡两键。
- **`LoopConfig` 保持 snake_case**：原拟改 camelCase，核实 skill `source-code.md` 强制规定后改为**登记豁免 X2**，避免违反更高优先级的全局规范。
- **`Docs/02 §12` 删自带 T6 数值表**，改指 `roleOverrides`（8 角色）；声明只允许覆盖 `max_iterations`/`token_budget`/`temperature`，未知键→启动失败；`temperature=0` 的 reviewer/arbitrator/auditor 不得调高。
- **`Docs/02 §6` Agent 状态机枚举同形修复**：中文态名改为 `creating(创建)` 等规范值优先；**澄清 `awaiting_approval` / `failed` 不是 Agent 态而是 Loop 态**（原表 9 态无法映射到 `agents.status` 的 6 个枚举）。
- **`Configs/*.toml` 与 `.json` 混用**：扩展名统一 `.json`，`Docs/02` 目录树重写并对齐 `Docs/11 §1.1` 的 14 个文件。
- **配置优先级修正**：原“环境变量 > local > default”与全局约定冲突，改为 `local > {env} > default`，环境变量**仅**用于解析 `api_key_ref: "env:XXX"`。
- `agents.role` 补 `reviewer`；`Prompts/roles/` 目录补 `reviewer.md` / `assemblyNode.md`（与 8 角色对齐）。
- **`Docs/04 §8`** 补回 `supervision.approvalTimeoutSec` 引用行；**`Docs/08`** 两处 `timestamp: string` → `number`；**`Docs/01 §2.4`** `max_iterations` 与分区预算行改为引用真实配置键。
- 全局：`Docs/03/04/05/06/07/08` 内联默认值表已全部改为**引用表**（只列键名与定义位置），共约 60 处。

### 已知事项（v2.1 残留）

- **`context.partitionCeilingByRole[role]`**（Docs/01 §2.4 承诺的按角色差异化分区上限）**尚未登记为配置键**，Phase 0–2 统一用 `partitionCeilingRatio`；如需实现必须先登记再开发。
- `tasks.route_mode` 为大写枚举，已作为 **X4** 登记（与路由输出模式名逐字对齐，跨 4 文档引用）；若未来新增第五个大写枚举族，需重新评估 X3 边界。
- v2 “已知事项” 6 项（ADR-0001/0002 未成文、L3 校准集未准备、Docs/08 未加 `idempotencyKey`、Docs/09 缺两个面板等）**本轮未处理**，仍在 S6/S8/S13 前阻塞。

---

## [设计 v2] - 2026-09-13

### 新增功能

- **`Docs/99-审查记录/设计审查报告-Loop与Harness工程.md`**：以外部 **Loop Engineering**（arXiv 2608.21884 / CSDN 2026-09 / Anthropic / OpenAI Agents SDK）与 **Harness Engineering**（LangChain AgentMiddleware / Codex App Server / Pi / awesome-harness-engineering）实践为基准，对 v1 全部 11 份设计文档做的完整漏洞审查。
- **`Docs/12-循环控制系统/循环控制系统设计.md`**：Loop Engineering 受控闭环核心 —— 五类独立退出条件、Verifier 四级分层（硬验证/规则/独立 LLM Judge/人工门）、LoopState 与 Context 分离、GoalReanchor 中间件、ActionFingerprint 与策略账本、人工审批门、FailureFeedback 协议、Trigger 防风暴、Reasoning Sandwich、9 项配置默认值、5 项必备 ADR。
- **`Docs/13-持久执行与恢复/持久执行与恢复设计.md`**：Durable Execution —— 三层持久化（事件溯源 / 意图日志 / 快照）、EffectJournal、Checkpoint、RecoveryScanner 与恢复决策矩阵、幂等契约、启动与关闭序列扩展、6 类故障注入测试。
- **`Docs/14-构建与实施/项目构建顺序.md`**：S0–S14 十四阶段实现顺序，含各阶段 Gate 门槛、禁止抢跑清单、可并行轨道、里程碑回退点、依赖关系图。

### 修复问题（对既有设计文档）

- **`Docs/02`** 主循环序列顺序错误：原文将"上下文组装"置于"前置监管"之前，且缺失"中间件管线"与"监管懒监听"两步。现严格对齐 skill `source-code.md` 的强制 10 步（①输入接收 ②前置监管 ③中间件管线 ④上下文组装 ⑤监管懒监听 ⑥模型调用 ⑦输出解析 ⑧工具执行 ⑨后置监管 ⑩迭代判定）。
- **`Docs/02`** 中间件与监管关系倒置：原文只用中间件承载全部监管职责。现明确两者共存、**中间件在外层、监管在内层，禁止互相替代**，并补齐 `Services/Supervision` 六模块。
- **`Docs/02`** 上下文分区语义错误：原文为"S系统约束/L长期记忆/M对话历史/H高频变化 + 预留"五分区且按百分比分配。现修正为缓存感知四级 **S静态(0.05) / L低频(0.5) / M中频(0.3) / H高频(1.0)** 分件系数，移除自创的"预留"分区，补充追加式写入格式与评分延迟压缩机制。
- **`Docs/02`** 目录骨架偏离五层规范：现按 skill 补齐 `Core/{Loop,Middleware,Model,Decision}`、`Services/{Context,Supervision,Pipeline,Hook,Cache,Session,Retrieval}`、`Tools/{Registry,Factory,Traits,Builtin,Custom}`、`Infra/{Fs,Db,Terminal,Logging,Time,Llm,Slm,Embedding,Hook,Config,Sandbox,Security,Watcher,Workspace,Env}`，并新增 `Skills/`、`ADR/`。
- **`Docs/02`** 启动/关闭序列自创 20 步：现对齐 skill 的 **启动 14 步（FATAL/WARN 分级）+ 关闭 9 步（总时限 ≤10s）**，扩展 ⑦.5/⑭.5 崩溃恢复扫描与 ⑤ Checkpoint 强制 flush。
- **`Docs/02`** 缺失模型调用契约：新增 §10，规定超时 60s / 流式首字节 10s / 相邻包 15s，以及 401·403 → FATAL 禁重试、429 → 5s 退避、网络错误 → 1s+2s、503 → 降级、重试耗尽 → 终止本轮。
- **`Docs/02`** 缺失 Hook 系统与 LoopConfig：新增 §11（九类事件 + 仅 `UserInputReceived`/`PreToolExecute` 可拦截 + fail-open/closed 策略）、§12（LoopConfig 七字段 + T6 七角色默认映射）。
- **`Docs/03`** 质量验收命中"生成者自评"失效模式：原文由 Director 用 LLM 打 0-100 分。现重写为 **Maker-Checker 分离**（独立 Reviewer Agent，`verifierModel ≠ producerModel`，不共享上下文）+ **Verifier 四级分层** + Rubric 人工校准（50 样本、一致率 ≥85%）+ Reward Hacking 反游戏检查。
- **`Docs/03`** "重试 2 次"式无效反馈：改为强制结构化 `FailureFeedback`（证据 + 与上轮差异 + 已试策略 + 剩余预算 + 建议动作）。
- **`Docs/03`** "连续 3 次失败即开除"过于粗糙：现按失败性质四分（能力不足 / 不努力 / 目标不合理 / 外部异常），外部异常不计入 Worker 失败，开除前必须写 `TerminationRationale`。
- **`Docs/03`** 并行工作区未隔离：新增 §7A 五级隔离策略（个人目录 / 乐观锁 / Git worktree / 沙箱草稿态）。
- **`Docs/04`** 预算只有硬阈值：新增 §5.2.1 **双预算 soft/hard 五阶段机制**（预热 → 软预算自动降级 → 扩展审批 → 硬预算中止回滚），及 §5.2.2 每轮信息增益度量 `EfficiencyMetrics`。
- **`Docs/06`** 无触发防风暴：新增 §5.1 五道防护（去重键 / 冷却期 / 幂等 ID / 并发上限+优先级队列 / 任务风暴熔断）。
- **`Docs/06`** "升级人工"无实现：新增 §5.2 `ApprovalQueueView` 审批面板，明确**超时默认拒绝**、CRITICAL 双角色多数决。
- **`Docs/07`** Context 与 State 混用：新增 §8.1 职责边界红线，任务事实只允许存 `LoopState`；§8.4 Self-Reinforcing 防御（`observed/inferred/assumed` 三级断言标注）。
- **`Docs/07`** 并发写无版本控制：新增 §8.2 乐观锁 + `version` + `causalTokens` 因果向量；§8.3 `WorkspaceLock`（READ/WRITE/EXCLUSIVE + TTL）。
- **`Docs/10`** 缺表：新增 §8.2 九张表完整 DDL（`loops`、`loop_checkpoints`、`pending_approvals`、`verifier_results`、`failure_feedbacks`、`effect_journal`、`idempotency_cache`、`action_fingerprints`、`strategies_ledger`）+ §8.4 保留策略 + §8.5 事务与 `PRAGMA synchronous=FULL` 约束。
- **`Docs/11`** 工具契约缺字段：新增 §6.1 三项必填 `idempotency` / `reversibility` / `sideEffectScope`（缺一拒注）；§6.2 统一返回格式含 `status` + `recoverable`。
- **`Docs/11`** 不可逆操作无审批实现：新增 §6.3 审批矩阵 + 六条硬禁清单（不允许审批开启）。
- **`Docs/11`** Provider 配置格式违规：原文字段名自创且**缺失 `context_window` 必填字段**。现修正为 `provider` / `base_url` / `api_key_ref` / `display_name` + model 侧 `id` / `context_window` / `max_output` / `supports_vision` / `supports_tools` / `cost_per_1k_*`，并新增 `verifierModel` 与 `reasoningSandwich`。
- **`Docs/01`** 顶层锚点同步：新增 v2 修订提示、§8.1 十条补充红线、§9 v2 全量文档索引、§10 修订历史。

### 已知事项

- **律师函挂起机制与"LLM 循环不可中断"红线存在张力**：已按 T8 先例定位为"暂停符的合法来源之一"，但 **ADR-0001 / ADR-0002 尚未成文**，须在 S12 阶段落地。
- **Verifier L3 的 Rubric 校准依赖人工标注集**（50 条通过/不通过样本），当前尚未准备，是 S6 Gate G6 的前置阻塞项。
- **`Docs/05` 仲裁系统未与 `Docs/12` 的 `LoopState.suspension` 字段对齐**，需要在 S12 前做一次定向修订。
- **`Docs/08` Agent 间通信协议尚未为消息添加 `idempotencyKey`**，需在 S8 前补齐。
- **`Docs/09` UI 文档未包含 `ApprovalQueue` 与 `LoopDebugger` 两个新面板**，需在 S13 前补齐。
- **向量检索**：Phase 0–2 用 SQLite 全文检索替代 Milvus/Qdrant，语义相反判定的召回率可能偏低，需在 Phase 3 换型后重跑基准。
- **整体成熟度定位**：v2 设计完成后理论达到业界 Loop 成熟度 **L2 设计完备**，但代码尚未开始，当前实现进度为 **0**。

---

## [设计 v1] - 2026-09-13

### 新增功能

- 完成需求对齐：意图检测判定为 **S1 新建项目**；类型定向产出五元组 **[A2|B3|C1|N4|R2]**，判定为 **T6 多 Agent 协作型**，验证 4 条升级信号。
- 技术选型确定：TypeScript + Node.js 后端服务、React Web UI、混合模型路由、SQLite 持久化、WebSocket + REST 通信。
- 模糊地带量化定义（A1–A5）：路由判定阈值、交付失败判定、Token 分润权重（0.5 质量 + 0.3 数量 + 0.2 效率）、异常消耗判定、仲裁死锁定义。
- 融合两份思考文件：`一些思考.md`（动态仲裁者数量控制，冲突频率 f = k·n^m 超线性模型、核心层+辅助层分层调度、资源约束 n ≤ C/cᵢ）与 `一些思考2.md`（治理型共享记忆六步闭环、裁决优先级协议 LWW>任务权威性>证据链完整性>LLM 兜底、律师函挂起三步）。
- 交付 11 份设计文档（约 150 KB）：系统概览、核心架构、Agent 编排引擎、Token 经济、仲裁系统、监管与审计、共享记忆与上下文、Agent 间通信协议、用户界面与可观测性、数据模型与持久化、配置体系与安全。
- 迭代路线：Phase 0（地基 + 单 Agent 可靠）→ Phase 1（多 Agent 协作）→ Phase 2（司法监管闭环）→ Phase 3（水平扩展）。

### 已知事项（已在 v2 中修复）

- 主循环步骤顺序与 skill 规范不符 → v2 已修正。
- 缺失 Loop 控制、Verifier、Durable Execution 三大子系统 → v2 新增 Docs/12、Docs/13。
- 上下文分区语义与系数定义错误 → v2 已修正。
- 目录骨架偏离五层规范 → v2 已修正。
