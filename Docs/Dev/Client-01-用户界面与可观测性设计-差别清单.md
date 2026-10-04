# Client/01 用户界面与可观测性设计 — 文档-代码差别清单

> 审查日期 2026-10-03 · 审查基准：当前工作区代码（含未提交改动）
> 被审文档：`Docs/Client/01-用户界面与可观测性/用户界面与可观测性设计.md`（正文 273 行，含 2026-09-14 修订 + 2026-09-22 校准注记）
> 代码真源：`Client/src/{views,components,stores,hooks,services,shared,ai-components,config}` + `electron/{main,preload}.ts` + `Src/Interface/{IpcBridge,RestApi,EventStore,WebServer}` + `Configs/default.json`

---

## 摘要

| 分类 | 条数 | 含义 |
|------|------|------|
| 【文档过时】 | 18 | 文档描述被代码现状超越（含 9-22 校准注记本身已过期） |
| 【代码未实现】 | 16 | 文档声明的组件/字段/事件消费方/指标在代码中不存在 |
| 【声明错误】 | 5 | 文档给出的 API 名、配置生效方式、约束与实际实现不符（含"配置假生效"） |
| 【需人工裁定】 | 4 | 真假两难：疑似前端自造契约 / 残留物 / 性能反模式，需产品或架构裁决 |
| **合计** | **43** | — |

**总体判断**：文档 §4「技术选型」与 §5「目录结构」两节质量最高（9-14 修订 + 9-22 校准基本可用，但仍存在 store 数、视图数、组件清单三处数量级失真）；**§1「界面总体结构」与 §2「视图模块」已整体失效**——代码自 F2 起转向"三栏自适应工作区（LeftPanel / MainContainer / RightPanel）+ 独立视图深链"，文档描述的二栏导航 + 底部事件流 + 底部状态栏结构在代码中不存在，且 §2 六个视图中五个的子功能（详情/曲线/趋势/拓扑边）未落地。

**两条最高优先级问题**：
1. **§3 实时链路的"节流 / 配置驱动"叙事不成立（D-16、D-17、D-18、D-19、D-20）**：`ui.*` 四个键在 `Configs/default.json` 与 `Client/src/config/configSchema.ts` 都存在，但**四个消费点全部硬编码数值**（`chatStore.ts:281`、`useDashboardData.ts:10`、`useApprovalPolling.ts:21`、`eventStore.ts:31-32`），配置面板可编辑却不生效；且逐 token 的 `agent:stream_chunk` **确实在逐条 `webContents.send` 给渲染进程**，100ms 合批只发生在渲染层显示缓冲——文档"禁止逐 token 推送"的红线在传输层被违反。
2. **事件契约双轨漂移（D-24、D-25、D-26）**：前端镜像 `shared/eventTypes.ts` 比后端 SSOT 少一个 `AGENT_TODO_UPDATED`（71 vs 72，无 CI 门禁），同时前端存在多处**自写字面量**（`approvalStore.ts:145`、`todoStore.ts:69`、`LoopDebugger.tsx:35`），最严重的是 `ai-components` 注册表订阅了 **6 个后端从不发布的事件名**（`agent:reasoning_chunk/-end`、`agent:message_start/-end`、`agent:tool_call`、`agent:tool_result`），导致 CoTFolder / MessageShell / ToolGroup 三个事件驱动组件的订阅永不命中。

---

## 差别清单

| 编号 | 文档章节 | 文档声明 | 代码实态（文件:行） | 分类 | 建议处理 |
|------|---------|---------|-------------------|------|---------|
| D-01 | §1 界面总体结构 | 二栏结构：左侧导航 + 主内容区 + 底部实时事件流 + 底部状态栏（系统状态/活跃 Agent 数/当前税率）+ 顶部导航栏（系统名/当前任务/全局 Token 余额） | 实为三栏自适应工作区：`Client/src/components/Layout/AppLayout.tsx:41-95`（LeftPanel/拖拽手柄/MainContainer/RightPanel）、`Client/src/stores/uiStore.ts:9-14`（`mainView` = conversation/task/feature/agent）；底部状态栏组件 `Layout/StatusBar.tsx` **已在工作区删除**（`git status` D，全仓 0 引用）；顶部 `AppTitleBar.tsx:27-31` 仅项目标识 + 窗口三键预留；无任何"全局 Token 余额 / 活跃 Agent 数 / 税率"字段；无底部事件流常驻区 | 【文档过时】 | 整节重写为"三栏工作区"结构图（引用 `Docs/Client/02/三栏自适应工作界面设计规格.md`），并显式声明"状态栏/底部事件流已撤销" |
| D-02 | §1 / §2.2-2.5 导航清单 | 左侧导航含：任务面板、Agent 监控、Token 账本、仲裁案件、系统配置 | 左侧功能列表为：审批 / Loop 任务 / Harness 工程检查 / 记忆 / 数据中台 / 插件（Skill·MCP·自定义工具）/ 账号 —— `Client/src/components/Layout/LeftPanel/FeatureList.tsx:31-52`；文档所列 5 项**均不在导航中** | 【文档过时】 | §1 导航表按 FeatureList 实际条目重写 |
| D-03 | §1 主内容区"根据左侧选择切换视图" | 侧栏选择即切换视图 | `/dashboard /agents /tasks /working-modes /approvals /loop-debug /arbitration /trace /token-ledger /system-config` 十条路由仅在 `AppLayout.tsx:128-137` 注册，**全仓无 `<Link>` / `navigate()` 指向它们**（唯一导航是 `LoginPage.tsx:58 → /chat`）；即 10 个独立视图当前只能通过手敲 URL 到达 | 【代码未实现】 | 要么在 FeatureList/TitleBar 补导航入口，要么在文档标注"深链专用，无导航入口" |
| D-04 | §2.1 系统状态卡片 | 卡片内容：活跃任务数、活跃 Agent 数、**系统 Token 总量** | `Client/src/views/Dashboard.tsx:46-49` 四卡为：在线 Agent / 任务总数 / 事件总数 / 仲裁案件；后端概览亦无 Token 字段：`Src/Interface/RestApi/loopApi.ts:33-55`（`activeAgents/totalAgents/activeArbitrationCases/totalArbitrationCases/arbitratorPool/recentEvents`） | 【代码未实现】 | 文档改为现状四卡；若保留"Token 总量"则改为前端并读 `tokenStore.overview.systemPool`（端点已存在） |
| D-05 | §2.1 Agent 活跃状态图 | "力导向图" | `Client/src/components/Dashboard/AgentTopologyGraph.tsx:53-86` 为**按角色半径的静态环形分层布局**（代码注释自称"简化力导向"），无引力/斥力迭代，`svgRef` 拿了不用（`:45`） | 【文档过时】 | 文档改述为"角色分层环形布局"，力导向列为待办 |
| D-06 | §2.1 Agent 活跃状态图 | 边 = 通信关系 | 该文件全篇无 `<line>` / `<path>` 边渲染（`:120-148` 仅节点 circle + text），代码亦无 Agent 间通信关系数据源 | 【代码未实现】 | 文档标注"边未实现"；补 `delegation:`/`agent:` 事件聚合出通信边，或改述为"仅健康状态分布图" |
| D-07 | §2.1 仲裁案件状态 | 大屏内"卡片列表：进行中的仲裁案件 + 状态" | `Dashboard.tsx:49` 只有案件计数 StatCard；后端已有 `GET /api/loops/arbitration`（`loopApi.ts:86-88`）与 `getPoolStats()`（`:52`），大屏未调用 | 【代码未实现】 | 大屏接入 `/api/loops/arbitration`，或把该行下移到 §2.5 并声明大屏不放案件列表 |
| D-08 | §2.2 任务详情 | 子任务拆解视图、各 Worker 进度、质量评分 | `Client/src/views/TaskPanel.tsx:80-112`（TaskCard）与 `Client/src/components/Layout/MainContainer/TaskView.tsx:26-45` 均只渲染 taskId / traceId / status / createdAt / result；`Client/src/stores/taskStore.ts:7-15` 的 `TaskRecord` 无 subtasks / worker / qualityScore 字段 | 【代码未实现】 | 文档标注三项为 Phase 2 待办；同步在 §7 Phase 表登记 |
| D-09 | §2.2 任务提交区 | "支持流式输出预览" | `TaskPanel.tsx:42-53` 仅输入框 + 提交按钮，无流式订阅；流式链路只服务对话视图（`useEventBus.ts:78-140` → `chatStore`） | 【代码未实现】 | 文档改述为"提交后到对话区查看流式结果" |
| D-10 | §2.3 Agent 列表 | 列：状态、角色、**Token 余额** | `views/AgentMonitor.tsx:41` 表头为 Agent / 状态 / 角色 / 信任级；`stores/agentStore.ts:7-15` `AgentInfo` 无余额字段（余额需另走 `/api/tokens/wallets`） | 【代码未实现】 | 文档标注 Token 余额待接；或前端联表 `tokenStore` 钱包 |
| D-11 | §2.3 Agent 详情 | 执行历史、Token 消耗曲线、操作日志 | `views/AgentMonitor.tsx:68-93` 详情面板只有 6 态生命周期徽标条 + agentId/traceId | 【代码未实现】 | 文档标注详情三项为占位；接 `/api/loops/events?traceId=` 复用 TraceReplay 组件 |
| D-12 | §2.3 Agent 监控 | 视图内含"Agent 拓扑图" | 拓扑组件仅在大屏使用：`views/Dashboard.tsx:58`；`views/AgentMonitor.tsx` 未引用 `AgentTopologyGraph` | 【文档过时】 | 拓扑图归属 §2.1 单列，§2.3 标注"复用 Dashboard 组件（待接）" |
| D-13 | §2.4 税率趋势 | 税率随时间变化的折线图 | `views/TokenLedger.tsx` 全篇无折线/趋势实现，仅 `:90` "当前税率"数值卡（文件头注释 `:3` 自称"税率折线"亦不实）；后端无税率历史端点（`tokenApi.ts` 仅 overview/wallets/transactions） | 【代码未实现】 | 文档标注依赖后端 `token:tax_rate_updated` 历史落库，前端折线待建 |
| D-14 | §2.5 仲裁视图 | 案件列表 / 案件详情 / 仲裁者池状态 | `views/ArbitrationView.tsx:20-30`：从 `/api/loops/events` 原始事件流里"造案件"——`caseId` 直接用 `e.eventId`、`status` 仅二分（含 filed 否则 reasoning）、`defendant` 恒空；无案件详情、未调 `GET /api/loops/arbitration(/:caseId)`（`loopApi.ts:86-94`）；`arbitratorPool` 已在 `stores/systemStore.ts:12` 建模但视图未渲染 | 【代码未实现】 | 前端改接仲裁案件 REST（后端契约已存在），文档同步"三态"实际字段 |
| D-15 | §3.1 事件桥接层 | `class EventBusBridge { connect(url?); send(m); subscribeWs(h); disconnect(); }` | 实为模块级函数：`services/eventBusBridge.ts:41 connectBridge` / `:60 disconnectBridge` / `:66 subscribe` / `:71 send`；**`subscribeWs` 名称已不存在**（`hooks/useEventBus.ts:7` 即证） | 【文档过时】 | 代码块改为实际导出签名；全局搜 `subscribeWs` 清零 |
| D-16 | §3.1 / §3.2 前端约束 | 浏览器开发模式"降级为 HTTP 轮询"取事件；`FALLBACK_POLL` 走配置 | `services/eventBusBridge.ts:85-94` 的降级轮询**只每 3s 检测 `window.electronAPI` 是否出现**，不拉任何事件；轮询间隔 `:25` 硬编码 `FALLBACK_POLL_MS = 3000`，与 `ui.*` 无关；即浏览器模式前端事件通道实际为空 | 【声明错误】 | 文档改述为"浏览器模式仅恢复检测，事件能力不可用（REST 拉取兜底）"；或后端补 `/api/events` 增量端点后接真轮询 |
| D-17 | §3.2 流式输出 | IPC 推 `agent:stream_chunk`，按 `ui.streamFlushIntervalMs`（默认 100ms）批量合并，**禁止逐 token 推送** | 后端逐 delta 发布：`Src/Interface/IpcBridge/ipcBridge.ts:817-826`；桥接层逐事件转发：`ipcBridge.ts:119-135`（`subscribeMany(Object.values(EventType))` → 每事件 `win.webContents.send('backend-event')`，无合批、无节流）；100ms 合批**只存在于渲染层显示缓冲**：`Client/src/stores/chatStore.ts:281 const FLUSH_INTERVAL_MS = 100`、`:742 setInterval(flushBuffer)` | 【声明错误】 | 文档改述为"传输层逐 token（IPC 内部），渲染层 100ms 合批"；或在 ipcBridge 侧补合批后再 send，并让该值读 `ui.streamFlushIntervalMs` |
| D-18 | §3.2 审批队列 | HTTP 轮询间隔 = `ui.approvalQueueRefreshSec`（默认 3 秒） | `Client/src/hooks/useApprovalPolling.ts:21` 默认 `intervalMs = 30_000`（`:9-11` 注释解释为规避 API 限流 FE-012，**10 倍于文档值**）；`Configs/default.json:25 approvalQueueRefreshSec: 3` 全仓无消费方，仅 `configSchema.ts:254` 暴露为可编辑控件 | 【文档过时】 | 文档更新为 30s + 限流依据；`ui.approvalQueueRefreshSec` 要么接入、要么在 §3.2 标注"当前未生效" |
| D-19 | §3.2 大屏概览 | HTTP 轮询间隔 = `ui.dashboardPollIntervalSec`（默认 5 秒） | `Client/src/hooks/useDashboardData.ts:10 const POLL_INTERVAL = 5000; // dashboardPollIntervalSec` —— 数值巧合等于默认，**未读配置**；另 `useEventBus.ts:25,176-188` 的事件驱动刷新用的是另一个硬编码 `SYSTEM_REFRESH_THROTTLE_MS = 3_000` | 【文档过时】 | 统一由 `configStore` 注入 `ui.*`，文档补"事件驱动侧另有 3s 尾随节流" |
| D-20 | §3.2 前端约束 | 本地事件缓冲上限 = `ui.maxEventBufferSize`，超限丢弃最旧项 | `Client/src/stores/eventStore.ts:31-32 MAX_EVENTS = 1000 / TRIM_TO = 500` 硬编码；`:42-45` 超限**一次性裁到最新 500 条**（非"逐条丢最旧"）；`ui.maxEventBufferSize` 无任何消费方（仅 `configSchema.ts:256`） | 【声明错误】 | 文档改述实际容量策略；若维持 SSOT 则 `eventStore` 需读配置 |
| D-21 | §3.2 前端约束 | 桥接断开时"显示离线横幅" | 横幅存在（`components/Layout/OfflineBanner.tsx:7-11`，条件 `systemStore.online === false`），但 `eventBusBridge.ts:51/56` 在 Electron 与浏览器两种模式下都立刻 `setOnline(true)`，`disconnectBridge` **全仓零调用**（仅 `:41/:91` 自身引用）→ 横幅只在首帧 `online` 初值 false 时闪现，断开场景永不触发 | 【代码未实现】 | 把 `online` 改由真实心跳/REST 健康检查驱动（含 `api.ts` 429/网络错误路径），文档补"当前为乐观置位" |
| D-22 | §3.2 会话消息 | IPC 推 `agent:chat_message` + REST 补齐 | 后端确实发布（`Src/Interface/RestApi/chatApi.ts:252`），**前端 0 消费方**：`AGENT_CHAT_MESSAGE` 只出现在 `shared/eventTypes.ts:21`，`useEventBus.ts:78-188` 无该分支；前端消息靠 REST `hydrateMessages` + `stream_chunk/stream_end`（`views/ChatView.tsx:47-50`） | 【代码未实现】 | 文档标注"该事件当前仅作 AI 组件事件回放素材（ai_events 落库），消息列表以 REST 为准" |
| D-23 | §3.2 仲裁状态 | IPC 推 `arbitration:` 域，状态变化即推 | `hooks/useEventBus.ts` 全文无 `arbitration` 分支，无 `arbitrationStore`；13 个 store 中无一消费 `arbitration:` 事件（`grep` 仅 `ArbitrationView.tsx:20` 一次性 REST 结果里前缀过滤）；`stores/{agent,task,token}Store` 才做前缀增量 | 【代码未实现】 | 文档标注"仲裁域前端未接，仅事件流展示" |
| D-24 | §5 注记 | `Client/src/shared/eventTypes.ts` **已生成**（由 `Scripts/genEventTypes.ts` 从后端 SSOT 产出） | 生成物**已与 SSOT 漂移**：后端 72 项、前端镜像 71 项，缺 `AGENT_TODO_UPDATED = 'agent:todo_updated'`（`Src/Services/EventBus/eventTypes.ts:35`，且已被 `Src/Services/Planning/todoStore.ts:225,256` 实际发布）；`package.json:20` 有 `gen:event-types` 脚本，但 `.github/workflows/ci.yml` 与 `Scripts/build.cjs` **无漂移校验门禁** | 【文档过时】 | 立即 `npm run gen:event-types`；并在 CI/构建加"生成后 git diff 必须为空"的漂移门禁 |
| D-25 | §3.2 / §5 注记 | "前端不得自写事件名字符串" | 多处违反：`stores/approvalStore.ts:145`（`'loop:approval_requested'`/`'loop:approval_decided'`/`'loop:approval_timeout_rejected'` 字面量）、`stores/todoStore.ts:69 const TODO_EVENT_TYPE = 'agent:todo_updated'`、`views/LoopDebugger.tsx:35 'strategy:switch'`（该事件名**注册表中不存在**，`:34` 分支恒 false → 策略高亮为死代码）；71 个事件里仅 13 个被 `EventType.*` 引用 | 【声明错误】 | 字面量全部改回 `EventType.*`；`strategy:switch` 要么后端登记、要么前端删除 |
| D-26 | §5 注记（未覆盖 `ai-components`） | 文档目录树与注记均未提及 `Client/src/ai-components/` 这一事件驱动组件族层 | `ai-components/core/index.ts:17,23,29` 与 `harness/index.ts:15` 注册了 6 个后端**从不发布**的事件名：`agent:reasoning_chunk` / `agent:reasoning_end` / `agent:message_start` / `agent:message_end` / `agent:tool_call` / `agent:tool_result`（后端真实名为 `agent:tool_call_started` / `_result` / `_pending`，见 `eventTypes.ts:33-36` 区段与 `shared/eventTypes.ts:23-26`）→ `CoTFolder` / `MessageShell` / `ToolGroup` 的 Subscribe 永不命中（组件目前靠 `MessageBubble.tsx:14-17` 直接 import 渲染才可见）；`registry.ts:119-123` 亦按前缀猜测分类 | 【需人工裁定】 | 裁决口径：若"事件驱动组件族"为既定方向，则**后端补登记这 6 个事件**并把该层写入 §5；否则删除注册表订阅、文档明确"组件族仅由 chatStore segments 驱动" |
| D-27 | §5 目录树 | 树中列 `stores/dashboardStore.ts`、`components/Dashboard/DashboardView.tsx`、`components/Dashboard/{SystemStatusCards,TaskTimeline}.tsx`、`components/TaskPanel/*`、`components/AgentMonitor/*`、`components/TokenLedger/*`、`components/ArbitrationView/*`、`components/SystemConfig/{ConfigView,ConfigForm}.tsx` | 全部不存在：大屏概览在 `stores/systemStore.ts:47-52`；Dashboard 实际为 `views/Dashboard.tsx` + 4 个可视化组件；`components/Dashboard` 无 `DashboardView/SystemStatusCards/TaskTimeline`（甘特叫 `TaskGanttChart.tsx`）；`components/{TaskPanel,AgentMonitor,ArbitrationView,TraceReplay,LoopDebugger,ApprovalQueue}` 均为 `.gitkeep` 空目录，`components/TokenLedger` 目录根本不存在；系统配置在 `views/SystemConfig.tsx` + `components/Settings/{fields,ModelProviderPanel}.tsx` | 【文档过时】 | 目录树按"目标态 / 现状"双列改写，或直接把树换成当前真实树（现 `components/` 有 39 个 tsx、`views/` 12 个 tsx） |
| D-28 | §4 / §5 注记 | Zustand 落地 **8 个 store**（system/agent/task/token/approval/loop/chat/config） | 实际 **15 个**：新增 `accountStore`(696 行) / `chatStore`(1199) / `eventStore` / `hotReloadStore` / `modelStore` / `prefsStore` / `todoStore` / `uiStore`；`uiStore`/`eventStore`/`hotReloadStore` 分别支撑三栏布局、事件缓冲、配置热重载，均未被文档提及 | 【文档过时】 | §5 注记刷新为 15 个并按域分组；§3 补"事件缓冲 store + 热重载 store"链路 |
| D-29 | §4 / §5 注记 | 视图层"实际为 **11 个**单体视图（8 → 11）" | 现为 `Client/src/views/*.tsx` **12 个**（新增 `AccountPanel.tsx` 390 行）+ `views/Auth/LoginPage.tsx`（229 行，登录可选：`App.tsx:24-32`）= 13 个视图组件；文档还漏 `views/AccountPanel` 与登录链路 | 【文档过时】 | 计数改 12（+Auth），并在 §2 补"账号/登录"视图模块条目 |
| D-30 | §5 注记（9-22 校准的组件清单） | "F1/F2 落地 `Layout/{AppLayout,OfflineBanner,**StatusBar**}`、`Chat/{MessageList,MessageBubble,Composer,**StreamingIndicator**,MessageActions,MarkdownRenderer,**Conversation\***}`" | 被点名的 4 个组件在工作区已删除：`components/Layout/StatusBar.tsx`、`components/Chat/StreamingIndicator.tsx`、`ConversationCard.tsx`、`ConversationGrid.tsx`、`ConversationSidebar.tsx`（`git status` 全为 D）；同时文档未记录新增：`Layout/{AppTitleBar,ProjectLogo,LeftPanel/,MainContainer/,RightPanel/,hooks/useResizablePanels.ts}`、`Chat/AgentPreparing.tsx`、`Settings/ModelProviderPanel.tsx`、`shared/ai-components/` | 【文档过时】 | 9-22 校准段整体重写为 2026-10 时点；组件清单按 `find Client/src/components -name '*.tsx'` 重出 |
| D-31 | §5 注记 | "`AgentMonitor/TaskPanel/**TokenLedger**/ArbitrationView/TraceReplay/LoopDebugger` 等仍为 `.gitkeep` 占位" | `Client/src/components` 下**没有 TokenLedger 目录**（`ls` 确认）；真实 `.gitkeep` 目录为 7 个：`{AgentMonitor,ApprovalQueue,ArbitrationView,Dashboard,LoopDebugger,TaskPanel,TraceReplay}` —— 文档漏 `ApprovalQueue`，且 `Dashboard` 已有 4 个实组件却仍带 `.gitkeep` | 【文档过时】 | 目录清单校准；顺手清理 `components/Dashboard/.gitkeep` 与空占位目录（属代码侧，非本审查范围） |
| D-32 | §5 注记 | hooks 列举 `useEventBus / useDashboardData / useAlerts`（3 个） | 实际 4 个：另有 `hooks/useApprovalPolling.ts`（FE-012 限流核心，带引用计数） | 【文档过时】 | 补入 hooks 清单 |
| D-33 | §5 前端分层约束 | `views → hooks → stores → services` 单向、禁止反向与跨层直连；视图层不得出现 fetch/ipcRenderer | 后半句成立（`grep` 在 `views/` 与 `components/` 中 `fetch(`/`ipcRenderer`/`new WebSocket`/`window.electronAPI` **0 命中**）；但存在跨层直连与反向依赖：`views/ChatView.tsx:17` 直接 `import { send } from '@/services/eventBusBridge'`、`views/TokenLedger.tsx:10` 直接 `import { apiGet }`、`components/Layout/MainContainer/FeatureView.tsx:9-10` 直接 import `api` + `ipcApi`；反向：`services/api.ts:7`、`services/eventBusBridge.ts:11`、`services/syncService.ts:18-20` **import stores** | 【声明错误】 | 二选一：承认"services 与 stores 存在双向（桥接回写在线状态）"并改写约束，或把这些调用下沉到 hooks |
| D-34 | §4 可视化库「现状」列 | "⏳ 待引入（F4）：现实际为**纯 CSS 条形图**；echarts/echarts-for-react 仍未安装" | 后半句成立（`Client/package.json` 无 echarts/d3/recharts，`grep` 全 `Client/src` 0 命中）；前半句已过期：大屏与账本已是**自绘 SVG 图表**——`Dashboard/TokenFlowSankey.tsx:134 <path>`（真桑基流带）、`Dashboard/AgentTopologyGraph.tsx:113 <svg>`、`Dashboard/TaskGanttChart.tsx:116 <svg>`、`views/TokenLedger.tsx` 消耗柱状（注释自称"简化 SVG"） | 【文档过时】 | 现状列改为"自绘 SVG（桑基/环形拓扑/甘特/柱状），未上图表库"；重评 F4 引入 ECharts 的必要性 |
| D-35 | §6.1 日志追踪 | trace_id 贯穿（✓）；**span** = 每次 LLM 调用/工具执行，记录耗时、Token 消耗；层级为 trace→span | `Src/Services/EventBus/eventTypes.ts:115-124` `DomainEvent` 只有 `traceId?/loopId?`，**无 spanId/parentSpanId**；前端 `views/TraceReplay.tsx:60-80` 实为"按 traceId 过滤 + 时间排序的扁平事件列表"，总耗时 = 末事件-首事件（`:77-80`），无嵌套 span 树（文件头 `:3` 宣称"span 树"）、无 per-span 耗时/Token 归因；span 仅存在于日志侧 `Src/Infra/Logging/traceContext.ts:6-9` | 【文档过时】 | 文档区分"日志域三级 ID（已实现）"与"事件/前端 span 树（未实现）"；`TraceReplay` 若要 span 树需后端补 spanId |
| D-36 | §6.1 关联 | operation_id 关联具体操作（工具调用、文件操作） | 后端日志与工具调用侧已有：`Src/Infra/Logging/logger.ts:179-193`、`logWriter.ts:63-64`、`Src/Core/Loop/runIteration.ts:614`、`Infra/Db/migrations.ts:123`（`ai_events` 含 `operation_id` 列）；**前端零消费**：`Client/src` 中 `operationId` 0 命中，TraceReplay 详情面板不展示、无按 operation 筛选 | 【代码未实现】 | TraceReplay 详情补 operation_id 展示/筛选；文档标注"前端未接" |
| D-37 | §6.2 监控指标 | 四类指标（系统健康含**内存使用**；性能含 **LLM 延迟 P50/P95**；成本；质量），采集方式"定时采集/事件驱动" | 前端只有 `hooks/useAlerts.ts` 从三个 store 现算；全仓 `Src/` grep `memoryUsage`/`heapUsed`/`percentile`/`P50`、`P95` **0 命中**（唯一近似是 `Scripts/llmLatency.cjs` 离线脚本，未接入指标体系）；`/api/loops/dashboard` 亦无内存/延迟字段 | 【代码未实现】 | 把 §6.2 标注为"目标态（除成本/质量类可由现有 REST 推导外均未落地）" |
| D-38 | §6.3 告警规则 | 规则 1：Token 异常消耗（单 Agent 5 分钟超预算）→ Critical | `Client/src/hooks/useAlerts.ts:92-97`：规则 1 为 **TODO 空分支**（注释："实际实现需要后端提供 Agent 级别消耗统计"），仅判断 `walletCount > 0` 后什么都不做 | 【代码未实现】 | 文档该行标"未实现（依赖 Agent 级消耗聚合端点）"；`audit:anomaly_detected` 事件已存在可作数据源 |
| D-39 | §6.3 告警规则 | 仲裁积压：待处理案件 **> 5** → Warning | `useAlerts.ts:30 ARBITRATION_BACKLOG_THRESHOLD = 3`，`:82` 按 `> 3` 触发；文件头注释 `:8` 亦写 "> 3"（与文档相互矛盾） | 【文档过时】 | 统一为 3（或改代码为 5）；阈值宜入 `Configs/*.json` 而非硬编码 |
| D-40 | §6.3 告警规则 | 系统 Token 不足：系统池余额 **< 10000** → Critical | `useAlerts.ts:26-27,43`：阈值为 `INITIAL_SUPPLY(10000) × 10% = **1000**`，且 `INITIAL_SUPPLY` 硬编码（注释称"与 Configs/economyRules.json 对齐"，实际未读该文件） | 【文档过时】 | 文档改述为"低于初始供应 10%（当前=1000）"；并把初始供应量与阈值改为读配置 |
| D-41 | §6.3 告警规则 | 任务积压：任务队列长度 > 10 | `useAlerts.ts:54-55`：用的是"**前端已加载任务里 status ∈ {submitted, running} 的条数**"，不是后端队列长度；`taskStore.tasks` 来自 `/api/tasks`（无分页/无队列深度） | 【需人工裁定】 | 裁定"队列长度"定义：若指后端等待队列，需要新端点；若维持现状则文档改述为"未完成任务数（前端可见集）" |
| D-42 | §3.1 / §7 / §8 | WebSocket 及 `wsGateway.ts`、`server.wsPort(3001)` 已删除（2026-09-28） | 前端确实删净（`Client/src` 中 `new WebSocket` 0 命中；`services/ws.ts`、`hooks/useWebSocket.ts` 为 D）；但**后端配置残留**：`Configs/default.json:13 "wsPort": 3001` 仍在，且 `Src/Infra/Config/configValidator.ts:52-53` 仍强制校验其为整数、`Tests/gateG0.spec.ts:54` 断言该键存在；`Scripts/wsDiagnose.cjs` 亦仍在仓库 | 【需人工裁定】 | 裁定 wsPort 是"预留字段"还是"待清理残留"；若清理需同步 validator + G0 门禁 + 脚本，属 Agent/10 与本档联合改动 |
| D-43 | §3.2 前端约束（隐含） | Agent 状态"状态变化即推，无节流"；流式禁止逐 token | `Client/src/stores/agentStore.ts:35-40`：`applyEvent` 对**任何 `agent:` 前缀**都执行 `hydrate()` 全量 `GET /api/agents` —— 而 `useEventBus.ts:71` 对每条消息（含逐 token 的 `agent:stream_chunk`）都调用它，等于**每个 token 一次 HTTP**；同文件对 `task:/token:/loop:` 已另有 3s 尾随节流（`useEventBus.ts:25,59-64`），agent 域被漏掉 | 【需人工裁定】 | 代码侧修（agent 域也纳入尾随节流 / 只对 `agent:{recruited,ready,expelled,destroyed}` 刷新）；文档无需改，但应在 §3.2 加"agent 域增量策略"一行 |

---

## 未发现差异的抽查项（核实且一致）

| 抽查项 | 文档位置 | 核实依据 |
|--------|---------|---------|
| `Configs/default.json → ui.*` 四键齐备且默认值与文档一致：`dashboardPollIntervalSec=5`、`approvalQueueRefreshSec=3`、`streamFlushIntervalMs=100`、`maxEventBufferSize=500` | §3.2 | `Configs/default.json:23-28` |
| 技术选型四行完全成立：React 19（`react ^19.1.0`）、Tailwind 4 + 自绘组件（`tailwindcss ^4.1.10` + `@tailwindcss/vite`，无 antd）、Zustand（`zustand ^5.0.15`，文档"实际为 5 非 4"正确）、无 axios / recharts / echarts / d3 | §4 | `Client/package.json` dependencies/devDependencies 全量核对 |
| HTTP 客户端为原生 `fetch` 封装（超时 + AbortController + `Result<T>` + 429 重试一次），后端 `Src/Interface/WebServer/httpServer.ts` 绑定 `server.httpPort`(3000)、CORS 走 `server.corsOrigins`、生产模式静态托管 `Client/dist` | §4 HTTP 客户端行 / §7 | `Client/src/services/api.ts:3,40-60`（文档写 `:41`，现为 `:47`，仅行号漂移）、`Configs/default.json:11`、`httpServer.ts:5-7,53,58,84` |
| 前端统一事件入口为 `services/eventBusBridge.ts`，组件侧经 `hooks/useEventBus.ts`，且**只在布局挂载一次** | §3.1 / §5 | `Client/src/components/Layout/AppLayout.tsx:110` + `hooks/useEventBus.ts:54-56` |
| IPC 通道名与文档一致：渲染侧 `onBackendEvent`/`sendBackendCommand`，主进程 `backend-event`/`backend-command`（桥接实现位于主进程 `Src/Interface/IpcBridge/ipcBridge.ts`，与 §8"Electron Main + preload.ts"相符） | §3.1 / §8 | `electron/preload.ts:92-98`、`Src/Interface/IpcBridge/ipcBridge.ts:130,138,645`、`Client/src/views/ChatView.tsx:57-66,73`（`generate_reply` / `stop_generation` 命令） |
| 流式展示主链路（**文档与代码最一致的一块**）：`agent:stream_chunk` → `chatStore.appendStreamChunk`（正文 + `reasoning`）、`agent:stream_end` → `finalizeStream/setStreamError` + 触发 `hotReloadStore.flushAfterReply`、`agent:iteration_complete` → `applyIterationComplete`（toolCalls/toolResults/totalIterations），并有 `tool_call_pending/_started/_result` 三态工具卡链路 | §3.2 流式行 | `Client/src/hooks/useEventBus.ts:78-140`、`stores/chatStore.ts:224-253,742-761,839`、`stores/hotReloadStore.ts:8` |
| `agent:stream_chunk` 不落库、只落"组件相关"事件（与"禁止逐 token 落库"精神一致） | §3.2 隐含 | `Src/Interface/EventStore/aiEventStore.ts:24 SKIP_TYPES`、`:27-45 PERSIST_PREFIXES` |
| 视图/组件层无 `fetch(` / `ipcRenderer` / `new WebSocket` / `window.electronAPI`（§5 约束的"视图层"半边成立） | §5 分层约束 | `grep -rn` 覆盖 `Client/src/views` + `Client/src/components`，0 命中 |
| 展示层百分比 ×100、内部存 0.0–1.0 | §3.2 第三条 | `Client/src/views/TokenLedger.tsx:90`（`currentTaxRate * 100`）、`hooks/useAlerts.ts:75`（`failureRate * 100`） |
| `shared/eventTypes.ts` 确为构建期生成物：文件头 SSOT 声明与 `Scripts/genEventTypes.ts` 输出模板逐字一致，源/目标路径与文档所述完全相符（唯一问题是未重跑，见 D-24） | §5 注记 | `Scripts/genEventTypes.ts:16-17,41-62`、`Client/src/shared/eventTypes.ts:1-6`、`package.json:20 "gen:event-types"` |
| §5 列出的 3 个 store 域（`system` / `agent` / `task` / `token` / `approval` / `loop` / `chat` / `config`）命名与文件确实一一对应（数量不符见 D-28） | §4 / §5 | `ls Client/src/stores` |
| `data/mockData.ts` 已删除、`src/` 内 0 引用，默认数据源为 REST + IPC；`WorkingModes` 系列确实自带 `demoData.ts` | §5 注记 | `Client/src/data/` 目录为空；`components/WorkingModes/*.tsx` 7 处 `import ... from './demoData'`，无任何 store/API 混用 |
| 已删除组件确已删净：`services/ws.ts`、`hooks/useWebSocket.ts`、`hooks/useTaskStream.ts`（文档"旧流式订阅已被 useEventBus+chatStore 取代"成立） | §4 / §5 | `git status`（三者均为 D）+ `grep` 全 `Client/src` 0 引用 |
| 后端 REST 契约齐备（文档 §8"REST API 数据查询"）：`/api/agents(/:id)`、`/api/tasks` CRUD、`/api/tokens/{overview,wallets,transactions}`、`/api/loops/{events,dashboard,arbitration,arbitration/:caseId}`、`/api/configs/:name` 均已注册 | §8 | `Src/Interface/RestApi/{agentApi.ts:32,37, taskApi.ts:100-121, tokenApi.ts:56+, loopApi.ts:74-94, configApi.ts:46-50}` |
| 可观测性 trace_id 半边成立：日志自动注入 trace_id/span_id/operation_id 三级上下文 | §6.1 第 1 行 | `Src/Infra/Logging/traceContext.ts:6-9`、`logger.ts:6,179-193`、`migrations.ts:123`（`ai_events.trace_id/operation_id` 列） |
| 前端已落地 trace 可视化的**基础形态**（文档 §6 未记，但值得确认"落地状态"）：`views/TraceReplay.tsx` 273 行三栏（Trace 列表 / 事件时间线 / 详情），数据源 `/api/loops/events?traceId=`，能按 traceId 聚合、计错误、按事件域分类着色 | §6.1 | `Client/src/views/TraceReplay.tsx:1-90`、`stores/loopStore.ts:27-36` |

---

## 备注：本次审查未覆盖 / 移交项

1. `Docs/Client/02-前端改造基础/` 的 F0–F6 完成度与本文 §7 Phase 表的对账（属 Client/02 审查范围）。
2. `RightPanel`（AgentPreview / TodoPanel / PreviewCache）与 `WorkDirBar` 等 F2 新增能力在本文 §1/§2 完全缺位——属"文档缺章节"，未计入差异条数，建议在重写 §1 时一并补。
3. `ai-components` 组件族（`AIEventBus` / `Subscribe` / `registry` / `FallbackUI` / `FamilyErrorBoundary`）在本设计文档中**零记载**，且 `AgentView.tsx:40` 仍写着"待集成 AIEventBus + Subscribe 事件驱动渲染"——该层的归属文档需人工裁定（本表 D-26 只登记事件名漂移这一硬事实）。
4. 未修改任何源代码或被审文档；本文件为唯一新增产物。

---

## 回写记录（2026-10-03）

已逐条重新核实并回写 `Docs/Client/01-用户界面与可观测性/用户界面与可观测性设计.md`：回写 39/43、【需人工裁定】登记 4（D-26/41/42/43）、代码追平 0、未处理 0。§1 重写为三栏工作区，§3.2 增"ui.* 四键假生效"汇总表，§5 换真实目录树；33 处"2026-10-03 校准"。
