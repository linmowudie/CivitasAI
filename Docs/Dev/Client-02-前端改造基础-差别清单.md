# Client/02 前端改造基础 — 文档-代码差别清单

> 审查日期 2026-10-03 · 审查基准：当前工作区代码（含未提交改动）
> 审查范围：`Docs/Client/02-前端改造基础/` 四份文档 vs `Client/src/`、`Src/Interface/`、`electron/`、`Configs/`、`Tests/`
> 分类口径：【文档过时】文档描述已被后续变更取代 · 【代码未实现】文档裁决的产出无对应代码 · 【声明错误】文档陈述与代码事实相反（含"已完成"实为已删除）· 【需人工裁定】事实清楚但取舍/语义需人定

---

## 摘要

| 分文档 | 登记差异 | 其中声明错误 | 代码未实现 | 文档过时 | 需人工裁定 |
|---|---|---|---|---|---|
| 前端改造基础文件.md | 16 | 3 | 5 | 8 | 0 |
| 前端改造方案与构建顺序.md | 24 | 6 | 7 | 9 | 2 |
| 三栏自适应工作界面设计规格.md | 20 | 3 | 9 | 6 | 2 |
| 前端验收缺陷清单.md | 18 | 2 | 0（+2 描述违例） | 11 | 5 |
| **合计** | **78** | **14** | **21** | **34** | **9** |

**总体判断**

1. **一条系统性失效链贯穿前三份文档**：`CHANGELOG.md:367`「2026-10-02 本地后端 HTTP 迁移 Electron IPC」+ FE-017 死代码清理，把 F0.2/F1.3/F1.5 的 WebSocket 地基整体拆除——`Src/Interface/WebSocket/` 现仅剩 `.gitkeep`，`Client/src/services/ws.ts`、`hooks/useWebSocket.ts`、`hooks/useTaskStream.ts` 已删除。凡引用"WS :3001 / wsGateway / services/ws.ts / 断线重连退避"的条目**全部失效**，共 12 条（本次最大宗）。
2. **F0/F1 可核部分基本兑现**（HTTP 服务、50 条 REST 路由、15 个 store、三栏骨架、会话持久化），但 **F4/F5/F6 明显未完**：ECharts 未安装（大屏三图仍是自绘 SVG）、Playwright E2E 不存在（F6.2）、`Subscribe` 声明式渲染在生产代码中零调用、Gate G6 五条验收有两条不成立。
3. **缺陷清单的修复状态绝大多数经得起核查**（抽查 27 条 🟩，25 条完全成立、2 条部分成立），FE-001/FE-037 两条"未修复/已知限制"也未假装修好；但**清单自身的工作流未被执行**（🟩 项仍滞留"未修复"表）、**FE-006 已被顺带修掉却仍标未实现**、**FE-017 把 HEAD 中仍有引用的 `StatusBar.tsx` 记为死代码**、**FE-028 的修复载体随 FE-031 合并已消失**。
4. **审查前提需修正**：任务描述称"10-03 有一批 FE 修复提交"。`git log -1` = `493b005`（2026-09-23），`git log -- Client/src` 只有 2 条提交。**10-01~10-03 的 FE 修复全部以未提交的工作区改动存在**（`git status` 366 条，含 8 个 `D`）。这直接影响"验证痕迹"的可追溯性——CHANGELOG 有文字记录，但无提交粒度可回溯。且三栏改造的**全部新增载体均为 git 未跟踪文件**（`?? Client/src/components/Layout/{LeftPanel,MainContainer,RightPanel,hooks}/`、`AppTitleBar.tsx`、`ProjectLogo.tsx`、`?? stores/uiStore.ts`、`?? services/eventBusBridge.ts`、`?? ai-components/`），一旦误清工作区即整体丢失。
5. 附带发现（代码侧，文档未覆盖）：`ws@^8.21.3` 已成为无人使用的 runtime 依赖；`server.wsPort=3001` 为死配置键；`Client/src/shared/eventTypes.ts` 镜像落后一个事件（缺 `AGENT_TODO_UPDATED`），且 `approvalStore.ts:145`、`todoStore.ts:69` 用裸字符串事件名，与"前端零自造字符串"的铁律 2 不符。

---

## 一、前端改造基础文件.md

| 编号 | 章节 | 文档声明 | 代码实态(文件:行) | 分类 | 建议处理 |
|---|---|---|---|---|---|
| BF-01 | §1.2 实时通信硬约束 | 流式输出走 WS `agent:stream_chunk` | 无 WS 服务：`Src/Interface/WebSocket/` 仅 `.gitkeep`；事件经 IPC 下行 `Src/Interface/IpcBridge/ipcBridge.ts:120-131`（`webContents.send('backend-event')`），事件名仍为 `agent:stream_chunk`（`Src/Services/EventBus/eventTypes.ts:28`） | 【文档过时】 | 约束改述为"IPC 事件下行 + `generate_reply` 命令上行"，WS 写法归入废弃注 |
| BF-02 | §1.2 | 重连参数取 `ui.wsReconnectBackoffMs` / `ui.wsReconnectMaxAttempts` | 两键全仓 0 命中；`Configs/default.json` 的 `ui` 段只有 `dashboardPollIntervalSec/approvalQueueRefreshSec/streamFlushIntervalMs/maxEventBufferSize` | 【代码未实现】 | 随 WS 一并删除该约束，或改为 IPC 重连语义并补配置键 |
| BF-03 | §1.2 | 技术选型约束：原生 WebSocket + axios | `Client/src` 内 `new WebSocket` 0 命中；`axios` 未安装（`Client/package.json` deps 无）；HTTP 用原生 fetch（`services/api.ts:47`） | 【文档过时】 | 需求溯源列加"已被 §3 裁决 + IPC 迁移取代"注 |
| BF-04 | §1.3 | S13 交付 WebSocket 模块 `wsServer.ts`/`wsHandler.ts` | 两文件均不存在（目录空）；`Src/Interface/WebSocket/wsGateway.ts` 亦不存在 | 【文档过时】 | 该段整体标注"已由 IPC 桥接替代" |
| BF-05 | §1.3 校准注 | `httpServer.ts:52,89`、`wsGateway.ts:37`、`main.ts:252-263` 三步装配 | 实为 `httpServer.ts:55`（createServer）/`:93`（listen）；`wsGateway.ts` 不存在；`main.ts:359` registerAllRoutes → `:365` startHttpServer → **`:368` startIpcBridge** | 【声明错误】 | 更新三处行号，第三步改 `startIpcBridge()` |
| BF-06 | §2.1 状态管理行 | `src/stores/` 落地 8 个 store | 实为 **15 个**（`Client/src/stores/`：+account/config/event/hotReload/model/prefs/todo/ui） | 【文档过时】 | 数字刷新为 15 |
| BF-07 | §2.1 HTTP 行 / §2.3 | `services/api.ts:41` 用 fetch；`chatStore.ts:191` GET sessions、`:257` POST messages | fetch 在 `:47`；`chatStore.ts:458`（GET /api/sessions）、`:657`（POST /messages） | 【文档过时】 | 行号整体刷新（低危但成批出现） |
| BF-08 | §2.1 WebSocket 行 | `services/ws.ts:67` 原生 WebSocket + 指数退避，`hooks/useWebSocket.ts` 已建 | 两文件已被 FE-017 删除（`git status` 显示 ` D`）；仅 `hooks/useEventBus.ts:4` 注释残留"替代原 useWebSocket hook" | 【文档过时】 | 校准注补"Phase 0 IPC 迁移后删除" |
| BF-09 | §2.1 目录行 | `services/`×2（api.ts、ws.ts）、`hooks/`×4 | services 实为 **6**（api/eventBusBridge/ipcApi/secureStore/serverApi/syncService）；hooks 4（useAlerts/useApprovalPolling/useDashboardData/useEventBus） | 【文档过时】 | 重写目录实况清单 |
| BF-10 | §2.1 UI 组件库行 | `index.css` 15KB | 31.6KB | 【文档过时】 | 顺带更新 |
| BF-11 | §2.2 校准注 | `Client/src/views/` 实际为 11 个视图 | 顶层 12 个 `.tsx`（+`Auth/LoginPage.tsx` = 13）；多出 `AccountPanel` | 【文档过时】 | 刷新为 12/13 |
| BF-12 | §2.3 第二条校准注 | `components/Chat/{StreamingIndicator,MessageActions,MarkdownRenderer}.tsx` 已落地；Stop 见 `ChatView.tsx:69-73` | `StreamingIndicator.tsx` 已删（FE-017）；MessageActions/MarkdownRenderer 在；Stop 实为 `ChatView.tsx:70-75` | 【文档过时】 | 去掉 StreamingIndicator，或改指 `ai-components/core/StreamBuffer.tsx` |
| BF-13 | §2.3 第三条校准注 | "§6.3 五条告警规则在 `hooks/useAlerts.ts` 实现" | 仅 4 条落地（`useAlerts.ts:42,53,65,81`）；规则 1「Token 异常」是空 if + TODO（`:92-97`） | 【声明错误】 | 改述为"4/5，规则 1 待后端 Agent 级消耗统计" |
| BF-14 | §2.3 第四条校准注 | 同 BF-05（含 `wsGateway.ts:37` 绑 3001） | 同 BF-05 | 【声明错误】 | 与 BF-05 合并修正 |
| BF-15 | §4 差距矩阵 #4 | WS 断线重连 + 降级轮询 + 离线横幅（P0） | 离线横幅 ✅（`OfflineBanner.tsx`）；兜底轮询 ✅（`hooks/useApprovalPolling.ts` 30s）；**重连与退避 0 实现**——`online` 仅由 `eventBusBridge.ts:51/56/63` IPC 探测一次性置位，横幅文案"正在尝试重连…"无对应代码 | 【代码未实现】 | P0 项重述为"IPC 连通状态 + 轮询兜底"，或补重连实现；横幅文案改口径 |
| BF-16 | §4 差距矩阵 #7 | ECharts 桑基/力导向/甘特（P1） | `echarts`/`echarts-for-react` 未安装；三图为自绘 SVG（`Dashboard/TokenFlowSankey.tsx:111-176`） | 【代码未实现】 | 标注"以 SVG 自绘替代，ECharts 路线作废"并请裁决 |
| BF-17 | §5 验收 1 | 断后端→离线横幅并降级轮询；恢复后自动重连（≤5 次退避） | 前半成立，后半不成立（见 BF-15） | 【代码未实现】 | Gate G6 判据同步收窄 |
| BF-18 | §5 验收 2 | 流式期间 Stop 可用，中断后保留输出并可"继续" | Stop ✅（`ChatView.tsx:70-75`）+ 部分回复落库 ✅（FE-025）；**"继续"无任何入口**（Client/src 无 `continue`/`resume` 生成路径） | 【代码未实现】 | 要么补"继续生成"，要么改判据为"保留已输出" |

---

## 二、前端改造方案与构建顺序.md

| 编号 | 章节 | 文档声明 | 代码实态(文件:行) | 分类 | 建议处理 |
|---|---|---|---|---|---|
| PLAN-01 | §1 校准 #2 | 真实 WebSocket 服务 ✅ `wsGateway.ts:37` `new WebSocketServer({port:3001})` | 文件与目录内容均不存在；`ws` 仅在 `Tests/Integration/realAgentCallTest.ts:28-35`（旧脚本，连 `ws://localhost:3001`） | 【声明错误】 | 该行改为"曾交付，2026-10-02 由 IPC 替代并删除" |
| PLAN-02 | §1 校准 #3 | `main.ts:252` registerAllRoutes → `:260` startHttpServer → `:263` startWsGateway | `main.ts:359/365/368`，第三步是 `startIpcBridge()`；全仓无 `startWsGateway`/`initWsServer` | 【声明错误】 | 行号 + 第三步名称重写 |
| PLAN-03 | §1 校准 #5 | `taskApi.ts:46` 触发 receiveTask、`:119` DELETE | 实为 `:48` 与 `:121`（功能 ✅ 存在） | 【文档过时】 | 行号刷新 |
| PLAN-04 | §1 校准 #7 | `chatApi.ts` 会话 API（`RestApi/chatApi.ts`）+ 落库 v18/v19 | ✅ 成立（`migrations.ts:272,282`），但 chatApi 现达 500+ 行、12 个端点（`:340-519`），远超文档描述 | 【文档过时】 | 端点清单改指向附录 A 重写版 |
| PLAN-05 | §2 目标架构图 | `Interface/WebSocket ←─ WS:3001 ─→ services/ws.ts`；`hooks/*(useWebSocket/useTaskStream/useDashboardData)` | WS 层与 ws.ts 已不存在；hooks 实为 `useEventBus`（消费 `services/eventBusBridge.ts`）+ useAlerts/useApprovalPolling/useDashboardData | 【文档过时】 | 重画分层图：`IpcBridge → eventBusBridge → useEventBus → eventStore/各 store → views` |
| PLAN-06 | §2 铁律 3 | UI 参数一律读 `Configs→ui.*`，禁止硬编码 | `stores/chatStore.ts:281` `const FLUSH_INTERVAL_MS = 100; // streamFlushIntervalMs` 直接硬编码，未读配置 | 【声明错误】 | 改读 configStore/IPC 配置，或在铁律处注明例外 |
| PLAN-07 | §2 铁律 1/2 + §5 规则 4/5 | 视图层禁 fetch/WS；事件名只取 `shared/eventTypes.ts`；五层单向 `views→hooks→stores→services` | 事件侧：`stores/approvalStore.ts:145`、`stores/todoStore.ts:69` 裸字符串事件名；镜像缺 `AGENT_TODO_UPDATED`（后端 72 个 vs 前端 71 个，未重跑 `Scripts/genEventTypes.ts`）。依赖侧：`components/Layout/MainContainer/FeatureView.tsx:9,107` 组件层直接 `apiGet('/api/...')`，跳过 hooks/stores | 【声明错误】 | 铁律判据补自动化检查；重跑生成脚本；FeatureView 的取数下沉到 store |
| PLAN-08 | §3 WS 服务端裁决 + §6 风险表 | 新增 `ws` 为"全项目唯一新增 runtime 依赖" | `package.json` dependencies 仍含 `ws ^8.21.3`，但 `Src/`、`electron/` 0 引用 → 死依赖；runtime deps 实为 5 个 | 【文档过时】 | 删除 `ws`+`@types/ws` 或在文档登记保留理由（当前仅剩旧测试脚本引用） |
| PLAN-09 | §3 状态管理裁决 | "F1 实际落地为 5"、"stores/×8" | `Client/src/stores/` 实为 15 个；同一行两处数字互斥 | 【文档过时】 | 统一为 15 并解释增量来源 |
| PLAN-10 | §4 F0.2 / F0.3 | 产出 `wsGateway.ts`、`initWsServer({maxBufferSize})` 装配 | 均不存在；`ui.maxEventBufferSize=500` 仍在配置中但无前端缓冲实现引用 | 【代码未实现】(已废弃) | 在阶段表加"已被 IPC 迁移取代"作废标记 |
| PLAN-11 | §4 F0.5b | `wsHandler.ts` 帧协议拉齐（subscribe 多事件、`type` 取 EventType、回写 Docs/Agent/08 §5.1） | `wsHandler.ts` 不存在；等价实现落在 `ipcBridge.ts:120`（`subscribeMany(Object.values(EventType))`）与 `:138` `ipcMain.on('backend-command')` | 【文档过时】 | 帧协议章节改写为 IPC 命令/事件通道语义 |
| PLAN-12 | §4 Gate G0 | curl `:3000/api/agents` 通、`wscat -p 3001` 收到 `loop:started`、附录 A 每条 curl 通、"既有 582 项测试零回归" | HTTP 半边成立（`httpServer.ts:55/93`，注册路由 50 条）；**WS 半边物理不可执行**；测试规模现为 73 个 spec / ~1041 用例；`Tests/gateG0.spec.ts` 是另一套"工程基线（配置文件键）"测试，并非本 Gate 判据 | 【声明错误】+【需人工裁定】 | Gate 判据重写（去 WS 项），并指定由哪个自动化测试承接"附录 A 每条路径可通" |
| PLAN-13 | §4 F1.3 | `services/ws.ts`：单例连接 + 心跳 ping/pong + 指数退避 + 耗尽降级轮询并置 `online=false` | 文件已删；`online` 仅在 `eventBusBridge.ts:51/56/63` 置位，无心跳、无退避、无"耗尽后降级"状态机 | 【代码未实现】 | 与 BF-15/PLAN-12 合并处理；降级轮询目前只有审批队列（30s）具备 |
| PLAN-14 | §4 F1.5 | `hooks/{useWebSocket,useDashboardData,useTaskStream}.ts` 为组件侧唯一入口 | 现存 `useDashboardData.ts`；`useWebSocket.ts`/`useTaskStream.ts` 已删，替代者为 `useEventBus.ts`；`useAlerts`/`useApprovalPolling` 未登记 | 【文档过时】 | 产出清单改写 |
| PLAN-15 | §4 F1.6 | 产出 `components/Layout/{AppLayout,OfflineBanner,StatusBar}.tsx`，补顶部导航（当前任务/全局余额）与底部状态栏（系统状态/活跃 Agent 数/税率） | `StatusBar.tsx` 已被 FE-017 删除；三栏 `AppLayout.tsx:112-142` 无状态栏；`AppTitleBar.tsx` 仅 logo + 窗口按钮留白，无当前任务/全局余额；税率仅 `views/TokenLedger.tsx:90` 出现 | 【声明错误】 | **功能回归**：要么恢复状态栏，要么把 Docs/Client/01 §1 的布局要求正式注销并请裁决 |
| PLAN-16 | §4 F1.1 | 代理已配（`Client/vite.config.ts:18-25`） | 代理实为 `:42-47` 且只有 `/api→:3000`，无 `/ws→3001`；echarts 确未安装（与文档校准注一致） | 【文档过时】 | 行号 + 端点改写 |
| PLAN-17 | §4 F2 控件清单 | Stop/Regenerate/编辑重发（显式分叉或替换）/复制/赞踩/导出为图片 | ✅ Stop、Regenerate、复制、赞踩（`Chat/MessageActions.tsx:3,31-53`）；❌ 编辑重发/分叉（0 命中）、❌ 导出为图片（0 命中）；另 §F2"会话搜索"未实现（TaskList/ChatView 无搜索框） | 【代码未实现】 | 三项从"已交付"改为待办；Gate G2 判据同步 |
| PLAN-18 | §4 F4 产出 | ECharts 桑基/力导向/甘特；每图表写明"它回答什么问题"（写进 props 校验） | 图表为 SVG 自绘；红线 ✅ 但只是默认 props + 注释（`AgentTopologyGraph.tsx:12,42,92`、`AlertList.tsx:12`），无 props 校验 | 【代码未实现】(ECharts) +【需人工裁定】(校验强度) | 请裁决 SVG 路线是否替代 F4；红线校验可加 dev-only invariant |
| PLAN-19 | §4 F5 | TraceReplay 对齐 LangSmith 三段式；LoopDebugger/TokenLedger/SystemConfig 接真实数据 | ✅ `views/TraceReplay.tsx:2-5,42-68`（trace 列表/时间线/span 详情，数据源 loopStore→`/api/loops/events`）；SystemConfig 走 `GET /api/configs`（`configApi.ts:46,50`） | 无差异 | 保持（见抽查项） |
| PLAN-20 | §4 F6.1 / F6.2 | `Tests/Interface/frontendIntegration.spec.ts` 契约测试；Playwright E2E（断线重连/审批闭环/流式中断） | 契约测试文件 ✅ 存在；Playwright **全仓无依赖、无配置**，`Tests/E2E/*.spec.ts` 为 vitest 后端场景仿真（如 `crashRecovery.spec.ts:11` 用 vitest），不含前端 E2E | 【代码未实现】 | F6.2 明确标注未启动，避免 Gate G6 误判 |
| PLAN-21 | §4 F6.3/F6.5 | build 产物 <1.2MB gz；≥3 轮真实 Agent 端到端验证记录于 CHANGELOG | 产物尺寸未见门禁脚本；`CHANGELOG.md` 有多处零散"Electron 实测"，但无"三轮/≥3 轮"专节（关键词 0 命中） | 【需人工裁定】 | 补一轮汇总记录或降级该项 |
| PLAN-22 | 附录 A 校准注 | 端点已实现（`approvalApi.ts:42`、`taskApi.ts:119`、`chatApi.ts:102-158`） | 实为 `approvalApi.ts:56`、`taskApi.ts:121`、`chatApi.ts:340-519`（端点确实存在，行号成批漂移） | 【文档过时】 | 建议改用"文件 + 路由名"引用，弃用行号 |
| PLAN-23 | 附录 A 路由表 | 表列 13 行为权威映射 | 实际注册 50 条路由，**表中缺 17 条已在用端点**：`PATCH /api/sessions/:id`、`POST /api/sessions/:id/archive`、`POST /api/sessions/:id/messages/rich`、`GET /api/sessions/:id/ai-events`、`GET|DELETE /api/sessions/:id/todos`、`GET /api/todos`、`GET /api/models`、`GET /api/configs[/:name]`、`GET/POST /api/memory/long-term[/bulk]`、`GET /api/memory/entries[/:key]`、`GET|PUT /api/account/active-user`、`GET /api/skills[/:id]`、`GET /api/tools[/custom]`、`GET /api/data-hub`、`GET /api/mcp/connections`、`GET /api/user/profile`、`GET /api/sync/stats-events` | 【文档过时】 | 附录 A 按 `registerRoute` 全量重建（可脚本生成） |
| PLAN-24 | 附录 A WS 约定 | 端口 3001；服务端帧 `{type,data,timestamp}`；客户端帧 `subscribe/unsubscribe/get_dashboard/get_approvals/ping` | 全部作废：实际为 IPC 双通道——下行 `win.webContents.send('backend-event', {type,data,timestamp})`（`ipcBridge.ts:123-131`，帧形恰好一致），上行 `ipcMain.on('backend-command', {type,payload})`（`:138-140`）+ 24 个 `ipc-*` handle；`server.wsPort=3001` 仍存在（`default.json:24`）但无消费方 | 【文档过时】 | 改写为"IPC 帧约定"，并清理 `wsPort` 死配置 |

---

## 三、三栏自适应工作界面设计规格.md

| 编号 | 章节 | 文档声明 | 代码实态(文件:行) | 分类 | 建议处理 |
|---|---|---|---|---|---|
| CANVAS-01 | §1.2 映射表 | `AppLayout.tsx` 为"二栏（aside+main）"，需重构三栏 | 重构已完成 ✅（`AppLayout.tsx:41-95` 三栏 + 拖拽手柄 + 折叠角标；HEAD 版才是 aside/main 二栏） | 无差异（正向） | 可在表头补"已落地"标记 |
| CANVAS-02 | §2.1 uiStore 落地 | 建 `stores/uiStore.ts` 管 mainView + 面板状态 | ✅ `uiStore.ts:9-96`，字段与文档逐条对应 | 无差异 | — |
| CANVAS-03 | §2.2 交互规则 | 左侧任务项 → `{type:'task', id}` | 会话任务点击 → `{type:'conversation'}`（`LeftPanel/TaskList.tsx:68`），仅"后台任务"分组用 `task` 视图（`:126`）；这是 FE-021 修复的结果 | 【文档过时】 | 按 FE-021 后实况改写交互表 |
| CANVAS-04 | §3.2 featureItems | 6 项固定列表（loop-tasks/harness/memory/data-hub/plugins/account），明确"替代 navItems" | 代码首项多 `{id:'approvals',label:'审批'}`（`LeftPanel/FeatureList.tsx:31`，TitleBar 同步 `:12`）；`navItems` 确已移除 | 【文档过时】 | 补 `approvals` 项并说明与 FE-024 的联动 |
| CANVAS-05 | §4.2.1 conversation 渲染 | Agent 回复区由 `Subscribe` 按事件类型渲染（stream_chunk→StreamBuffer、tool_call→ToolGroup、reasoning→CoTFolder、loop\*→IterationCard、memory\*→MemoryCard） | `ChatView.tsx:84-101` 只挂 `AIEventBus`；**`Subscribe` 组件在生产代码零调用**（仅 `ai-components/Subscribe.tsx` 定义与 `index.ts:23` 导出）；实际渲染走 `chatStore.segments` + `MessageBubble`；`ai-components/loop/index.ts`、`memory/index.ts` 的 `registerAll()` 是空函数（Phase 2） | 【代码未实现】 | 明确"当前为 store-segments 路线，Subscribe/Loop/Memory 族为 Phase 2 目标态" |
| CANVAS-06 | §4.2.1 自动折叠 | >50 子容器按 50 分批折叠 | ✅ `Chat/MessageList.tsx:31-32,104-119` | 无差异 | — |
| CANVAS-07 | §4.2.2 task 视图 | 任务信息卡片 + **任务对话区**，底部输入框隐藏 | `MainContainer/TaskView.tsx` 65 行只有信息卡片（`:26`），无对话区 | 【代码未实现】 | 补对话区或注销该子项 |
| CANVAS-08 | §4.2.4 agent 视图 | Agent 信息卡 + 用户消息 + Agent 回复容器 | `MainContainer/AgentView.tsx:19` 信息卡 ✅，`:36-40` 明示"待集成 AIEventBus + Subscribe 事件驱动渲染" | 【代码未实现】 | 与 CANVAS-05 同批交付 |
| CANVAS-09 | §4.2.3 数据来源表 | memory←`memoryStore`；profile←`userStore`；loop-tasks←`loopStore`；harness←Harness 族事件；data-hub←REST（待定义） | 无 `memoryStore`/`userStore`（对应 `accountStore`）；memory/skills/custom-tools 由组件内 `apiGet` 直连（`FeatureView.tsx:214,281,346`）；loop-tasks `items: []` 空；harness/data-hub/mcp/profile 显示**硬编码字符串数组**（`FeatureView.tsx:23-90` featureData） | 【声明错误】 | 数据来源列按实况重写；store 命名对齐 |
| CANVAS-10 | §5.1 预览标签 | **6 种**（agent/subagent/terminal/summary/fileview/filepreview） | **7 种**：新增 `{id:'plan',label:'计划'}`（`RightPanel/index.tsx:19`，`uiStore.ts:16`） | 【文档过时】 | 补第 7 项及其数据源（TodoPanel/`agent:todo_updated`） |
| CANVAS-11 | §5.1/§11.1 标签功能 | 6 种预览可用 | 7 标签中仅 `agent`（AgentPreview）与 `plan`（TodoPanel）有实现；`subagent/terminal/summary/fileview/filepreview` 5 个为"待实现"占位（`index.tsx:101-141`） | 【代码未实现】 | 在 §9.2 步骤表补"未交付"状态，避免 §11 验收被误判通过 |
| CANVAS-12 | §5.2 DOM 缓存 | `PreviewCache` display:none/flex 保持状态 | ✅ `RightPanel/PreviewCache.tsx:12-22`，配合 `visitedTabs` 懒渲染（`index.tsx:96-141`） | 无差异 | — |
| CANVAS-13 | §5.2 大数据优化 | 终端日志 >1000 行 → 序列化快照入 IndexedDB | 全仓 `indexedDB` 0 命中 | 【代码未实现】 | 标注 Phase 3 未启动（与 §9.3 一致即可） |
| CANVAS-14 | §5.3 文件联动 | 文件查看点击可渲染文件 → 自动切"文件预览" | `uiStore.previewFile/setPreviewFile` 存在但**除 uiStore 外无任何调用方**；`FileViewPreview.tsx`/`FilePreviewPreview.tsx` 不存在 → §9.2 S6 未交付 | 【代码未实现】 | 与 CANVAS-11 合并交付 |
| CANVAS-15 | §6 色板 | bgBase `#0e0e0e`、bgInput `#1a1a1a`，其余经令牌引用 | `index.css:11` `--color-surface-950: #000000`（注释自陈"为与 titleBarOverlay 无接缝而改纯黑"）；无 `#1a1a1a` 对应令牌；surface-900/800/700、brand-500、text-primary/secondary/muted(#555) 与文档一致 | 【需人工裁定】 | 决定以代码色板为准回写规格，或恢复 `#0e0e0e` |
| CANVAS-16 | §7.1/7.2/7.3 拖拽与折叠 | PANEL_MIN 120 / DEFAULT 220 / HANDLE 6 / 左 25% 右 50%；ResizeObserver + mouse 三事件；面板状态入 uiStore 跨视图持久化 | 常量与机制 ✅（`uiStore.ts:19-20`、`useResizablePanels.ts:14-16,28-40,49-87`）；但 uiStore **无 persist 中间件**，宽度/开合仅存内存（刷新回默认，且 `rightPanelOpen` 默认 false，`uiStore.ts:70`） | 【需人工裁定】 | "持久化"若指跨刷新，需补 localStorage persist |
| CANVAS-17 | §8.2 组件族映射 | text/harness/tool 已有 ✅，loop/data ❌ Phase 2 | 与实况一致（`core/MessageShell.tsx`、`harness/ToolGroup.tsx` 存在；loop/memory/multiagent 族为空注册） | 无差异 | — |
| CANVAS-18 | §8.3 EventEmitter 适配 | 后端 `Src/Core/EventBus/eventBus.ts`；主进程 `eventBus.on('*')` → `webContents.send('backend-event')` | eventBus 实际在 `Src/Services/EventBus/`；广播用 `subscribeMany(Object.values(EventType), …)`（`ipcBridge.ts:120-131`），非 `on('*')`；前端 `services/eventBusBridge.ts` + `hooks/useEventBus.ts`（"原 useWebSocket"注记 ✅ `useEventBus.ts:4`） | 【声明错误】 | 路径与 API 名两处校正 |
| CANVAS-19 | §9.1 所属阶段 | "不改变 F0/F1 已完成的地基工作" | 该规格定稿（09-29）之后即发生 IPC 迁移 + FE-017 清理，F0.2/F1.3/F1.5/F1.6 四项地基被删除 | 【文档过时】 | 补时间线注记，指向本差别清单 |
| CANVAS-20 | §10 文件结构规划 | 15 个规划文件 | 缺失 7：`MainContainer/ConversationView.tsx`（由 `views/ChatView.tsx` 承担）、`RightPanel/PreviewTabs.tsx`（内联 `index.tsx:73-92`）、`SubAgentPreview/TerminalPreview/SummaryPreview/FileViewPreview/FilePreviewPreview.tsx`；多出 4：`WorkDirBar.tsx`（FE-019）、`TodoPanel.tsx`（计划面板）、`AppTitleBar.tsx`、`ProjectLogo.tsx` | 【文档过时】 | 以代码树为准重写，并把新增 4 项纳入规格 |
| CANVAS-21 | §11.3 视觉验收 | MessageBubble 拆分后"快照测试 pixel diff = 0（对齐 Docs/Client/03 测试策略 §2）" | 全仓 `toMatchSnapshot`/图像快照 0 命中；`Tests/AIComponents/components.spec.tsx` 等为行为断言 | 【代码未实现】 | 判据改为行为测试，或补快照基线 |

---

## 四、前端验收缺陷清单.md

> 抽查口径：27 条标 🟩 的条目逐条 grep/read 核代码锚点 + 引用的测试文件；4 条"未修复/已知限制"核是否被顺带修掉。

| 编号 | 章节 | 文档声明 | 代码实态(文件:行) | 分类 | 建议处理 |
|---|---|---|---|---|---|
| FECHK-01 | §未修复 表 | 该区用于登记"尚未修复"的条目（§工作流 第 3 步要求 🟩 项移入文末归档） | 表内 28 行中 **26 行标 🟩已修复**，且文末归档表重复登记同一批 ID（如 FE-003/004/005/007~017/027/031/034/036/040 两处都在） | 【文档过时】(流程违例) | 执行一次清单清账：未修复区只留 FE-001/FE-006/FE-037（+ 待重述项），其余移归档 |
| FECHK-02 | FE-006 | ⬜ 未实现功能（待 S10），`agentRecruiter.ts:37` 返回 `NOT_IMPLEMENTED` | **已被顺带修掉**：`Src/Tools/Custom/agentRecruiter.ts:2,39-46` 头注"2026-10-03 接线，替代原 S10 桩实现"，改调 `Services/Recruitment/recruiter.ts recruitAgent()` 并落库约束；全文件无 `NOT_IMPLEMENTED`（该错误码现只剩 `submitForReview.ts:44` 的 `agent.submit_review` 待 S9）。残留边界：`dispatch:'pending'`——子任务真正派发未实现（文件自陈 `:14-15`） | 【文档过时】 | FE-006 改标"🟩 已修复（招募+登记），派发待办另立条目" |
| FECHK-03 | FE-017 | 死代码清单含 `components/Layout/StatusBar.tsx`，"已无引用" | 在 HEAD（`493b005`）中 `AppLayout.tsx:22` 有 import、`:106` 有渲染，**并非无引用**；工作区新三栏 AppLayout 不再挂载它，删除随之发生。其余 7 个 `D` 文件（ConversationGrid/Sidebar/Card、StreamingIndicator、ws.ts、useWebSocket.ts、useTaskStream.ts）在 `Client/src` 确已 0 引用 ✅；`#06b6d4`/`#22d3ee` 0 命中 ✅ | 【声明错误】 | 描述改为"随三栏重构解除引用后删除"，并联动 PLAN-15 的底部状态栏回归问题 |
| FECHK-04 | FE-028 | 🟩 修复：authStore 的 `String.hashCode()` 改为 djb2 `uaFingerprint()`；验证"同一 UA 连续调用同指纹" | **修复载体已消失**：`Client/src/stores/authStore.ts` 随 FE-031 合并删除，`uaFingerprint` 全仓 0 命中；现行设备标识为 `accountStore.ts:172-191` 的 `install-<randomToken>` + `deviceCredential`（safeStorage 持久），不再依赖 UA 哈希 | 【文档过时】 | 条目保留"已修复"，但补一行"该实现已被 FE-031/FE-033 的设备凭据方案取代" |
| FECHK-05 | FE-037 | ⬜ 已知限制：切换账号后运行中任务继续，"流式输出仍指向旧会话" | **前半仍成立**（后端不中止生成）；**后半已被顺带修掉**：`accountStore.ts:298-309` 在真实切换时清空 `chatStore`（含 `streamingMessageId: null`）并重取属主会话 | 【文档过时】 | 描述收窄为"运行中任务不被中止/不回收 Token"，删除"指向旧会话"半句 |
| FECHK-06 | FE-001 | ⬜ 已知限制：浏览器模式无上行/下行通道 | ✅ 成立：`eventBusBridge.ts:79` 浏览器 `send` 仅告警丢弃；50 条 REST 路由中无 `/api/commands`，亦无 SSE/轮询事件下行端点；`ipcBridge.ts:112-116` 非 Electron 环境直接空操作 | 无差异 | 保持；建议登记绕行入口（`npm run dev:electron`） |
| FECHK-07 | FE-003 | 🟩 2026-10-03：decidedBy 去重 + 按角色判定；单操作者按序补角色 | ✅ `approvalGate.ts:196-216`（`!approval.decidedBy.includes(identity)` + satisfiedRoles 按角色计数）、前端 `approvalStore.ts` FE-003 锚点；测试 `Tests/LoopControl/toolSafetyGate.spec.ts` 存在；证据目录 `.verify/` 存在 | 无差异（状态成立） | — |
| FECHK-08 | FE-004 | 🟩 2026-10-03：审批生命周期写穿落库，"重启/超时后的历史均可回溯" | ✅ `approvalPersistence.ts` 被 `approvalGate.ts:17,179,228,256,276,320` 全量调用；`migrations.ts:228` v15 建表、`:483` v24 重建。**注意语义**：`main.ts:149-151` 重启时 `expireStaleApprovals()` 把上次未决一律置 TIMEOUT——即"待办不复活、仅历史可回溯"，与条目标题"重启即丢失"的直觉修法不同 | 【需人工裁定】 | 请确认"历史可回溯"即满足验收；否则需恢复 PENDING 队列 |
| FECHK-09 | FE-005 | 🟩 `GET /api/approvals?status=all` + UI 待处理/已决分栏 | ✅ `approvalApi.ts:23,42-43`、`ApprovalQueue.tsx:21,47,66-94` | 无差异（状态成立） | — |
| FECHK-10 | FE-007/008/009/010/011 | 🟩 打包路径 / dev:electron 单实例 / electron 纳入 tsc / 补齐 ipcMain / 加载 .env | ✅ 逐项命中：`electron/main.ts:101-106`（`../../renderer/index.html`）；根 `package.json` `dev:electron = build:server + concurrently(Vite, wait-on→electron)`；`tsconfig.electron.json` 存在且 `build = tsc --noEmit && typecheck:electron`；`electron/main.ts:144,163,178-180,210-243` 通道齐（preload 170 行有对应暴露）；`main.ts:62-65 process.loadEnvFile('.env')` | 无差异（5 条全部成立） | 建议为每条补文件:行锚点（现多为"FE-0xx 注释锚点"式自证） |
| FECHK-11 | FE-012/013/014/015/016 | 🟩 节流合并+decidingId/lastError、乐观更新、子容器类型头、空停止容器、dist 门禁 | ✅ 全部命中：`useEventBus.ts:27,58-62,175`、`approvalStore.ts:71-73,94,123`；`chatStore.ts:634-666`（`pending-` 气泡 + 失败回滚）；`MessageBubble.tsx:90`→`MessageShell.tsx:83-86`；`MessageList.tsx:82,90,98`；`Scripts/verifyClientDist.cjs` 挂于 `build:client`（`package.json:12`） | 无差异（5 条全部成立） | — |
| FECHK-12 | FE-027 | 🟩 2026-10-03：`ai_events` 为统计主源 + `effect_journal.tool_call_id` 精确配对；顺带加迁移撞号检测 | ✅ `syncApi.ts:13-17,150-169`；`migrations.ts:567`（v25）、`:653-663`（重复 version → FATAL）；`Tests/Interface/syncApi.spec.ts` 存在 | 无差异（状态成立） | — |
| FECHK-13 | FE-031 | 🟩 2026-10-03：删 authStore，LoginPage 只调 accountStore | ✅ `Client/src/stores/authStore.ts` 不存在；`accountStore.ts:38`+`:298-309` 统一账号态与个人数据清理；`Tests/Client/login-flow.spec.ts`(4) + `account-store.spec.ts`(9) 存在 | 无差异（状态成立） | — |
| FECHK-14 | FE-034/036/039/040 | 🟩 2026-10-03：memory_entries 建表+投影 / 同类型多供应商唯一化 / 限流 30→600 / 限流与监管拆键 | ✅ `memoryEntryStore.ts`(112 行) + `memoryApi.ts:221-226` + `Tests/Services/memoryEntryStore.spec.ts`；`modelRouter.ts:70 uniqueProviderName` + `Tests/Infra/providerMultiInstance.spec.ts`；`Configs/supervision.json` 拆 `rateLimit(30)`/`apiRateLimit(600)` 两键（**当前为未提交改动**），`apiRateLimiter.ts`/`preSupervision.ts`/`rateLimitTypes.ts` 带 FE-040 锚点 | 无差异（状态成立） | — |
| FECHK-15 | FE-018/019/021/022/023/024/025/026/030/032/033/035/038 | 🟩（10-01~10-03） | ✅ 抽查锚点齐全：`NewTaskButton.tsx:25` createSession；`WorkDirBar.tsx`(83 行)+`chatStore.ts:617` setWorkDir+migration v20(`:296`)；`TaskList.tsx:68,126`；`Src/Core/Model/sessionNamer.ts`(96)+`EventType.CHAT_SESSION_RENAMED`(`eventTypes.ts:36`↔镜像`:27`)；segments/`toolMessageIndex`(chatStore 16 处)+`AGENT_TOOL_CALL_STARTED/RESULT`(`ipcBridge.ts:831,888`)；`ToolGroup` 内嵌审批卡+`security.json approvalTimeoutSec=300/autoApprove`；`Tests/Client/paused-reply-persistence.spec.ts`；`longTermMemoryStore.ts`(227)+`main.ts:161` 回灌；`App.tsx:30-39` 无 AuthGuard；`migrations.ts:322,394`(v21/v22 owner)+`Tests/Interface/ownerScope.spec.ts`；`Server/src/routes/auth.ts:117-123` 设备自助；`secretsStore.ts`+`migrations.ts:446`(v23 ai_events)+`chatStore.ts:331` 回放重建 | 无差异（13 条全部成立） | — |
| FECHK-16 | 归档表 FE-027 行 | — | **表格行损坏**：第 566 行以 `` `n| FE-039 … `` 收尾（转义丢失），FE-027 与 FE-039 被渲染为同一行，归档表实际少一行 | 【文档过时】(笔误) | 拆回两行 |
| FECHK-17 | 多处"Client 90 项全绿" | 90 项 | `Tests/Client/` 实为 13 个 spec、静态计数 ~94 用例（`it(`/`test(`）；本次 `npx vitest run Tests/Client` **退出码 0**（全绿），用例数与文档略有出入 | 【文档过时】(轻微) | 数字改为随测试报告生成，或写"约 90+" |
| FECHK-18 | 全清单 | "修复完成 → 写入 CHANGELOG"（隐含可回溯提交） | `git log -1` = `493b005`（2026-09-23）；`git log -- Client/src` 仅 2 条（`b5da690` 09-22、`369d031` 09-14）。**10-01~10-03 的 FE 修复无对应提交**，全在工作区（`git status` 366 条，含 8 个删除）；CHANGELOG 文字记录齐备 | 【需人工裁定】 | 决定提交切分方式（按 FE 条目 or 按主题），否则"验证证据"无法用 git 复现 |

---

## 未发现差异的抽查项

以下条目经 grep/read 核对，**文档与代码一致**，无需改动（列作正面基线）：

- **基础文件 §1.3 / §2.3**：`webServer.ts` 仍自陈"内存请求模拟"且仅供单测（`Src/Interface/WebServer/webServer.ts:4`）；`chat_sessions`/`chat_messages` = 迁移 v18/v19（`migrations.ts:272,282`）；`src/` 下对 `mockData` 引用为 **0**，`Client/src/data/` 已空；`POST /api/tasks` 真实调用 `receiveTask`（`taskApi.ts:11,48`）。
- **方案 §1 校准 #1/#4/#6**：`httpServer` 真实监听（`:55/:93`）、`POST /api/approvals/:approvalId/decide` 存在（`approvalApi.ts:56`）、流式与会话四事件已登记（`eventTypes.ts:28-31`）且前端镜像由 `Scripts/genEventTypes.ts` 生成（脚本写 `Client/src/shared/eventTypes.ts`，`genEventTypes.ts:17,76`）。
- **方案 附录 A 13 行中的 10 行**：任务/Agent/Token/审批/loops/dashboard/loops/events/arbitration/sessions 路径与代码逐一对应；三条"未实现"经复核**仍不存在**（`/api/dashboard/token-flow`、`/api/audit/reports`、`/api/system/config` 0 命中）。
- **方案 F1.4/F1.7 + Gate G1**：`stores/{system,agent,task,token,approval,loop,chat}` 七个齐全；Dashboard 经 `useDashboardData`→store 取数（`Dashboard.tsx:2-7`），`views/` 无 mockData。
- **三栏 §4.1 / §5.2 / §7.1-7.2 / §9.2 S8**：主容器三段式（`MainContainer/index.tsx:20-42`）、PreviewCache DOM 缓存、面板常量与 ResizeObserver 拖拽、>50 子容器分批折叠，均与规格逐行相符。
- **三栏 §2.1 / §2.2 三类点击驱动 mainView**：功能项（`FeatureList.tsx:94,136`）、右侧 L1 Agent（`AgentPreview.tsx:43`）、新任务（`NewTaskButton.tsx:32`）均走 `setMainView`。
- **三栏 文首"关联文档"4 篇 + 缺陷清单引用路径**：`Docs/Client/03-AI组件族架构/{AI组件族架构设计,后端接口契约,测试策略设计}.md`、`Docs/Client/04-…/客户端接入设计.md`、根 `CHANGELOG.md` 均存在，无坏链。
- **缺陷清单 §工作流 / 状态约定 / 严重度约定**：FE-018~FE-027 的 12 个测试文件（new-task/task-list/message-segments/tool-segment-order/inline-approval/paused-reply-persistence/workspaceGuard/sessionNamer/longTermMemoryPersistence/syncApi/toolSafetyGate/approval-entry）与 `.verify/` 证据目录**全部实存**，未发现"声称有测试但文件不存在"的情况。

---

## 回写记录（2026-10-03）

按四份文档拆四个代理并行回写，共 81 条所属条目全部处置：
- 三栏自适应工作界面设计规格：回写 16、正向核实 5（CANVAS-01/02/06/12/17）、裁定登记 2（§6 色板、§7.3 持久化语义）。
- 前端改造基础文件：回写 18/18、裁定登记 1（BF-16 ECharts vs SVG）。
- 前端改造方案与构建顺序：回写 23、跳过 1（PLAN-19 代码已追平）、裁定登记 4 + 清单外新差异 8。
- 前端验收缺陷清单：回写 9、锚点更正 9；缺陷条目关闭 27、仍存在 FE-001/FE-037、部分成立 FE-017；新增待办 6（5 项需裁定）。
