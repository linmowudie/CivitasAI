# Agent/08 Agent间通信协议设计 — 文档-代码差别清单

> 审查日期 2026-10-03 · 文档路径 `Docs/Agent/08-Agent间通信协议/Agent间通信协议设计.md` · 审查基准：当前工作区代码（含未提交改动：`Src/Interface/WebSocket/{wsGateway,wsServer,wsHandler}.ts` 与 `Client/src/services/ws.ts`、`hooks/useWebSocket.ts`、`useTaskStream.ts` 在工作区处于删除状态，`git diff --stat HEAD` 计 -95/-173/-402 行；`Src/Interface/IpcBridge/ipcBridge.ts` 含 2026-10-03 流式重复发布修复）
>
> 代码真源：`Src/Services/EventBus/{eventBus,eventRouter,eventTypes}.ts`、`Src/Interface/{IpcBridge,WebServer,RestApi,EventStore}/`、`electron/preload.ts`、`Client/src/services/`、`Client/src/shared/eventTypes.ts` + `Scripts/genEventTypes.ts` 生成链。
>
> 分类口径：【文档过时】代码已变文档未跟 ·【代码未实现】纯目标态仍未实现（文档未标注或标注已失效）·【声明错误】文档声称存在但代码没有 ·【需人工裁定】语义冲突/状态高估

## 摘要

| 分类 | 条数 |
|------|------|
| 文档过时 | 13 |
| 代码未实现 | 5 |
| 声明错误 | 2 |
| 需人工裁定 | 8 |
| **合计** | **28** |

总体判断：**§2 消息信封的字段层与代码逐字一致**（`AgentMessage`/`MessageType` 21 值在 `Src/Services/EventBus/eventTypes.ts:136-161` 原样存在），§1 通信模式表和 2026-09-22 两条校准注（CONFLICT_DETECTED 发起方、writeGuard 三闸、Arbitration 未接线）经复核**仍然成立**；但文档的**运行时描述整体停留在 WebSocket 时代**——§2/§3/§4 把从未在 `Src/` 里被构造、发送或消费过的 `AgentMessage` 协议当作"所有 Agent 间通信统一使用"的现态（真实通信只有 `DomainEvent` + IPC `{type,data,timestamp}`），§5.1/§5.2 的实现状态列被 2026-09-28 之后的多轮修复推翻（WS 文件已物理删除、tasks/approvals/sessions/config 四类端点状态反转、合批与 `subscriptions[0]` bug 判定过期）。最严重的两个问题：①**协议"纸面存在、运行期零引用"**——`'ACK'`/`requiresAck` 重发、超时重试表、§3.3 `SETTLE`/`PROFIT` 及全部 `token:*` 事件在 `Src/` 无任何发布点，却均以实态口径书写，直接误导实现方；②**§5.1 载荷字段声明错误 + 传输层现状缺记载**——文档称"消息载荷结构（type/payload）沿用原约定"，实际双向广播/应答字段是 `data`（`ipcBridge.ts:73-77`、`eventBusBridge.ts:15-19`），且占实际 API 面主导的 25 条 `ipc-*` invoke 通道（`ipcBridge.ts:198-639`）完全未被记录。

## 差别清单

| 编号 | 文档章节 | 文档声明 | 代码实态(文件:行) | 分类 | 建议处理 |
|---|---|---|---|---|---|
| D-01 | §1 校准注 + §3.2 注（2026-09-22） | 行级引用 `conflictPrecheck.ts:55`、`mergePhase.ts:62`、`writeGuard.ts:54`、`loopApi.ts:10-11` | 已漂移：`Src/Core/Decision/orchestrator/conflictPrecheck.ts:54`（publish 起于 :51）、`mergePhase.ts:59`（`precheckConflicts(...)` 调用）、`Src/Services/SharedMemory/writeGuard.ts:55`、`Src/Interface/RestApi/loopApi.ts:8-9`（tribunal/arbitratorPool import） | 文档过时 | 行号统一刷新；建议改为"函数名 + 行号"双引用以降低漂移敏感度 |
| D-02 | §2 首句 | "所有 Agent 间通信消息**统一使用**以下信封格式" | 运行期无任何 `AgentMessage` 构造/消费点：`Src/` 全仓仅 `eventTypes.ts:148-161` 的接口声明本身；Agent 间实际通信为 `DomainEvent`（`eventBus.ts` publish/subscribe），UI 侧为 IPC `{type,data,timestamp}`（`ipcBridge.ts:73-77`） | 声明错误 | 首句改为"⚠️ 目标态信封：类型已定义（`eventTypes.ts:148`），现态通信走 `DomainEvent`，见 Docs/Agent/07 §4.2" |
| D-03 | §3.1 任务委派序列 | `TASK_ASSIGN → TASK_START → TASK_PROGRESS → TASK_COMPLETE → ACK` 序列 | 无消息流：`MessageType` 各值在 `Src/` 零引用；同名语义的 `EventType.TASK_STARTED/TASK_PROGRESS/TASK_FAILED` 有订阅方（`Src/Core/Decision/orchestrator/progressTracker.ts:35,42,59`）但**发布点 0**（全仓 grep 除声明外无命中）；实际执行由 `ipcBridge.ts:903 executeLoop` 单链路驱动 | 代码未实现 | 整节加 ⚠️ 目标态标注，并注明"当前 task:* 事件仅被订阅、无人发布" |
| D-04 | §3.3 Consortium 序列 | `SETTLE` / `PROFIT` 两条消息 + TokenEconomy 结算泳道 | `SETTLE`/`PROFIT` 不在 `MessageType` 21 值内（`eventTypes.ts:136-144`）；`token:*` 全部成员（TOKEN_CONSUMED/EARNED/DISTRIBUTED/TAX_PAID/TAX_RATE_UPDATED/TOKEN_CONFISCATED/INSUFFICIENT_BALANCE/LEDGER_MISMATCH，`eventTypes.ts:39-46`）在 `Src/` 无任何 `publish` 调用，唯一命中是落库前缀白名单 `Src/Interface/EventStore/aiEventStore.ts:29`；钱包冻结链是现存唯一有发布点的 Token 相关事件（`Src/Services/Audit/freezeManager.ts:62,95,121`） | 代码未实现 | 序列图加 ⚠️，并说明"分润结算目前只在 `REST` 只读聚合（`/api/tokens/*`）中体现，无事件驱动" |
| D-05 | §4.1 ACK 协议 | `interface AckMessage` + "requiresAck = true 的消息必须收到 ACK" | `'ACK'` 字面量与 `AckMessage` 在 `Src/` 均无实现体；`requiresAck` 字段仅出现在接口声明（`eventTypes.ts:159`），无读取方；唯一近似物是 `Src/Services/Regulation/broadcastChannel.ts` 的 `ackDeadline/acks/getUnacknowledged`（监管广播自用，非 §4.1 协议） | 代码未实现 | 补 ⚠️ 未实现标注，并把 `broadcastChannel` 的 ACK 实现明确区分为"广播通道自用，不等价于 AgentMessage ACK" |
| D-06 | §4.2 超时与重试表 | 五种消息类型的超时（30s/5s/10s）与最大重试（2/3 次）+ 失败处理 | 无重试/超时实现；表中数值仅以配置形式存在：`Configs/supervision.json:6 supervision.broadcastAckTimeoutSec`，其全仓唯一读取方是前端 schema `Client/src/config/configSchema.ts:154`，`Src/` 内 0 消费 | 代码未实现 | 表头加 ⚠️ 目标态；注明该配置项当前无后端消费者 |
| D-07 | §5.1 现状变更注 | "消息载荷结构（**type/payload**）沿用原约定" | 服务端→客户端两个方向都用 `data` 而非 `payload`：广播帧 `ipcBridge.ts:121-127`（`{type: event.eventType, data: event.payload, timestamp}`）、RPC 应答 `ipcBridge.ts:644-670`；客户端镜像类型同口径 `Client/src/services/eventBusBridge.ts:15-19`。只有**命令入参**读 `payload`（`ipcBridge.ts:139-140`、`:673`、`:702`，且 `message.payload ?? message` 兼容两种写法） | 声明错误 | 改写为"下行 `{type,data,timestamp}`、上行 `{type,payload}` 的非对称约定"，并注明客户端需自行 `msg.data` 解包 |
| D-08 | §5.1 类型定义 + 修订注 3 | 上行五值 `submit_task/cancel_task/query_status/query_agent/query_token`；"代码现态为 `subscribe`/`unsubscribe`/`get_dashboard`/`get_approvals`/`ping`" | 现态为 **7 值**：`ipcBridge.ts:649 subscribe`、`:650 unsubscribe`、`:660 get_dashboard`、`:666 get_approvals`、`:672 generate_reply`、`:700 stop_generation`、`:720 ping`；文档遗漏两条**写操作**命令（`generate_reply` 触发整轮 Loop、`stop_generation` 中断流），与"裁决：写操作一律走 REST，WS/IPC 仅承担订阅与查询"（修订注 3）自相矛盾 | 文档过时 | 补齐两条命令并重新表述裁决："生成/停止为 IPC 专有写操作，REST 无对应端点" |
| D-09 | §5.1 修订注 3 | "`subscribe` 应支持多事件订阅（现仅订阅 `subscriptions[0]`，属 bug）" | bug 随 WS 一起消失：IPC 模式下 `subscribe`/`unsubscribe` 是**显式 no-op**（`ipcBridge.ts:649-658`，应答"IPC 模式下订阅由事件总线统一管理"），主进程一次性全量订阅 `subscribeMany(Object.values(EventType), …)`（`:121`） | 文档过时 | 删除该 bug 描述，改为"IPC 无订阅语义，全量广播由主进程统一转发；事件过滤在前端 handler 侧完成" |
| D-10 | §5.1 修订注 1/3 的行级引注 | 引用 `wsServer.ts`、`wsHandler.ts:281 / 159…`、`RestApi/chatApi.ts:90` 作为发布证据 | 三处全部失效：`Src/Interface/WebSocket/` 目录仅剩 `.gitkeep`（工作区删除 wsGateway/wsServer/wsHandler）；`chatApi.ts:90` 现为会话/消息内部实现，与 `agent:chat_message` 发布无关。现存发布点全在 IPC 桥：`AGENT_STREAM_CHUNK :823`、`TOOL_CALL_STARTED :831`、`TOOL_CALL_PENDING :846`、`ITERATION_COMPLETE :860`、`TOOL_CALL_RESULT :888`、`STREAM_END :710/764/776/788/938/947/957`、`CHAT_SESSION_RENAMED :1030` | 文档过时 | 引注整体替换为 `ipcBridge.ts` 行号；保留"历史 WS 实现"作脚注即可 |
| D-11 | §5.1（整节） | 用户交互传输层 = `backend-event` 广播 + `backend-command` 命令 | 实际主用面是 **25 条 `ipc-*` invoke/handle 通道**（`ipcBridge.ts:198-639`：providers/routing/models/sessions/todos/messages/config/memory/stats/skills/tools/device/secrets），由 `electron/preload.ts:12 contextBridge.exposeInMainWorld('electronAPI', …)` 暴露、`Client/src/services/ipcApi.ts` 调用；文档一字未提 | 文档过时 | §5.1 增补"IPC invoke 通道清单（会话/消息/待办/配置等写读操作的实际入口）"小节，并说明与 §5.2 REST 的双入口关系 |
| D-12 | §5.1 修订注 1 尾（2026-09-22 校准） | "惟'按 `ui.streamFlushIntervalMs` 合批'**仍未实现**'，现态为逐 chunk 直接 publish" | 已**部分实现**：前端 100 ms 合批 `Client/src/stores/chatStore.ts:281 FLUSH_INTERVAL_MS = 100`（注释直指 `streamFlushIntervalMs`）+ `:742 setInterval(flushBuffer…)`；后端仍逐 chunk publish（`ipcBridge.ts:817-828 onStreamChunk`），且 `Src/` 内确实无 `streamFlushIntervalMs` 引用 | 文档过时 | 改为"合批在前端（100ms 定窗），后端逐 chunk；配置项 `ui.streamFlushIntervalMs` 无后端消费者" |
| D-13 | §5.1 现状变更注 | 传输层"现态由 Electron IPC 桥接替代"（隐含唯一形态） | 浏览器形态无等价推送：`httpServer.ts` 无 `upgrade`/WS 处理，`/api/*` 之后没有任何推送通道；`Client/src/services/eventBusBridge.ts:79` 在非 Electron 下 `send()` 直接告警丢弃命令，`:85 startFallbackPolling()` 只重试探测 Electron（`FALLBACK_POLL_MS=3000 :25`），从不轮询事件 | 需人工裁定 | 需裁定浏览器降级模式是否为受支持形态；若是，§5.1 必须补"浏览器模式 = 只读 REST 轮询、无事件流"；若否，显式声明 Electron-only |
| D-14 | §5.1 现状变更注 | "`Src/Interface/WebSocket/`（wsGateway/wsServer/wsHandler）删除而退役" | 结论成立，但依赖未清理：`Configs/default.json:13 "wsPort": 3001` 仍被 `Src/Infra/Config/configValidator.ts:52-53` 强制校验（缺失即报"必须为整数"）；`package.json:104 "ws": "^8.21.3"` 依赖仍在；`Scripts/wsDiagnose.cjs:11`、`Scripts/dupCheck.cjs:4` 仍 `new WebSocket('ws://localhost:3001')`（必然失败） | 需人工裁定 | 裁定 ws 残留去留：建议删 `wsPort` 校验与两个诊断脚本，或改造成 IPC 版 dupCheck（重复发布核查仍需工具） |
| D-15 | §5.2 表 行 1 | POST `/api/tasks` = "⚠️ 已注册但**不触发执行**（F0.5 修）" | 已改为会触发：`Src/Interface/RestApi/taskApi.ts:100` 注册 → `submitTask()` 内 `queueMicrotask(() => receiveTask(...))`（`taskApi.ts:46-58`）异步启动编排；`Src/Core/Decision/orchestrator/orchestrator.ts` 招募登记链路可达 | 文档过时 | 状态列更新为"✅ 已实现（异步触发，不等执行结果）" |
| D-16 | §5.2 表 行 5 | DELETE `/api/tasks/:id` = "❌ 未实现→**F0.5 新增**" | 已注册：`taskApi.ts:121`；GET 列表带 `?status=` 亦在 `:107`、单查在 `:112` | 文档过时 | 状态列改为"✅ 已实现"，但语义风险见 D-17 |
| D-17 | §5.2 表 行 5 + §5.1 修订注 3 | DELETE `/api/tasks/:id` = "取消任务"（且"写操作一律走 REST"） | 语义仅翻转内存状态：`taskApi.ts` 的 `cancelTask` 只改任务 status，不触碰 `executeLoop` 的 `AbortController`（真正的中断只在 IPC `stop_generation`：`ipcBridge.ts:700-713`）；`cancelTask` 在 `Src/` 除本文件外 0 调用者 | 需人工裁定 | 裁定"REST 取消"是否等价于"停止执行"：需在文档明确其为**排队态取消**，或补 loop abort 接线 |
| D-18 | §5.2 表 行 12 | approvals = "✅ 已实现；**缺决策端点**（F0.4 补 POST `…/decide`）" | 决策端点已存在：`Src/Interface/RestApi/approvalApi.ts:56`（`POST /api/approvals/:approvalId/decide`），另有 `:41 GET`、`:47 GET :approvalId` | 文档过时 | 删"缺决策端点"表述 |
| D-19 | §5.2 表 行 13 | `/api/sessions[/:id/messages]` = "❌ 未实现→**F0.7 新增**" | 远超设计：`Src/Interface/RestApi/chatApi.ts` 注册 `GET /api/sessions :340`、`POST /api/sessions/:sessionId/archive :347`、`POST /api/sessions :358`、`GET …/messages :366`、`POST …/messages :376`、`PATCH /api/sessions/:sessionId :396`、`PATCH /api/messages/:messageId :420`、`POST …/messages/rich :445`、`GET …/ai-events :476`、`GET/DELETE …/todos :495/:504`、`GET /api/todos :514`、`GET /api/models :519`；且同名能力另有 IPC 通道（`ipcBridge.ts:372-473`） | 文档过时 | 按代码重建 §5.2 会话/消息段（含 PATCH/rich/ai-events/todos 与 IPC 双入口），标注"以代码为准" |
| D-20 | §5.2 表 行 17 | GET/PUT `/api/system/config` = "❌ 未实现（F5 只做只读，写操作暂缓）" | 实际路径与状态均不同：只读为 `GET /api/configs`、`GET /api/configs/:name`（`Src/Interface/RestApi/configApi.ts:46,50`），`/api/system/config` 全仓无注册；写侧 REST 无 PUT，但 IPC `ipc-save-secrets`（`ipcBridge.ts:612`）等已具备写能力 | 文档过时 | 路径改为 `/api/configs[/:name]`，并注明"配置写操作当前经 IPC，非 REST" |
| D-21 | §5.2 表（整体覆盖度） | 表为 17 行的端点全集（含"本表未列"标注） | 全仓实际注册 49 条路由（grep `registerRoute('…`），表中**缺失约 20 条**：`/api/tools`、`/api/tools/custom`（`toolsApi.ts:48,53`）、`/api/skills[/:id]`（`skillsApi.ts:64,69`）、`/api/data-hub`、`/api/mcp/connections`、`/api/user/profile`（`placeholderApi.ts:15,20,25`）、`/api/memory/long-term` + `/bulk`、`/api/memory/entries[/:key]`、`/api/account/active-user` GET/PUT（`memoryApi.ts:172,178,198,206,221,226`）、`/api/sync/stats-events`（`syncApi.ts:261`）、D-19 列出的会话扩展端点等 | 文档过时 | 以 `registerAllRoutes()`（`Src/Interface/RestApi/routes.ts:24-38`，12 个 registrar）为索引重生成端点全表；至少补 memory/skills/tools/sync 四组 |
| D-22 | §5.2（表头与说明） | 端点表只描述路径/语义，无可用性与限制契约 | 所有 `/api/*` 在进入 handler 前经统一限流：`Src/Interface/WebServer/httpServer.ts` → `applyApiRateLimit`（`Src/Interface/WebServer/apiRateLimiter.ts`，按 IP 滑动窗，超限 `429 + Retry-After`）；文档未提，前端与外部调用方无从知晓 | 文档过时 | §5.2 加"限流与错误约定"小节（429/Retry-After、CORS、静态 `Client/dist` 同域） |
| D-23 | §5.1 修订注 1 | "事件帧的 `type` 直接取 `EventType` 成员值"（作为单一真源约定） | 后端枚举 72 个成员（`Src/Services/EventBus/eventTypes.ts:11-109`），前端镜像 `Client/src/shared/eventTypes.ts` 仅 71 个——**差集 = `AGENT_TODO_UPDATED = 'agent:todo_updated'`（后端 :35）缺失**；生成链 `Scripts/genEventTypes.ts`（`npm run gen:event-types`）未随该成员重跑；`Client/src/stores/todoStore.ts:69` 以硬编码字符串 `const TODO_EVENT_TYPE = 'agent:todo_updated'` 绕过类型，注释 :68 自认"与后端 EventType 一致" | 需人工裁定 | 裁定 SSOT 口径：①立即重跑 codegen 并让 todoStore 改用枚举；②在 §5.1 补"EventType 为唯一真源，前端镜像由 `genEventTypes.ts` 生成，禁止手改/硬编码"的强制约定与 CI 校验 |
| D-24 | §2/§4（幂等与重复投递）+ §5.1 广播 | 文档暗示消息有唯一 ID 与幂等/确认保障（`messageId`/`eventId`/`requiresAck`） | `eventBus.publish` 的去重仅按 `eventId`（`Src/Services/EventBus/eventBus.ts:46-49 processedEventIds`），而 `createEvent` 每次无条件生成新 `evt-${Date.now()}-${++eventCounter}`（`:141-152`）⇒ **同一语义事件重复 publish 永远不会被去重**；`clearEventLog` 会清空该集合（`:167`） | 需人工裁定 | 裁定去重定位：要么在 EventType+业务键（messageId/toolCallId）层加语义去重，要么在 Docs/Agent/07 §4.2/08 §4 明确"eventId 去重只防同一实例重投，不防逻辑重复"，把重复治理交给消费端（现有做法：`syncApi.deriveStatsEvents` 用 v25 `tool_call_id` 配对避免双计） |
| D-25 | §5.1（流式事件）| "agent:stream_end 已发布"（修订注 1，✅ 2026-09-22 校准） | 停止生成时对同一 `messageId` **双发** `AGENT_STREAM_END`：`ipcBridge.ts:709-713`（stop_generation 主动发 `reason:'user_stopped'`）与 `:937`（正常出口无条件再发）；只有 catch 分支加了 `!aborted` 守卫（`:955`），ok 分支没有 ⇒ 前端收到两次 end（chatStore 需二次收敛） | 需人工裁定 | 裁定修法：`generate_reply` ok 分支补 `if (!abortController.signal.aborted)` 守卫，或让 stop_generation 只 abort 不 publish；随后在 §5.1 注明"stream_end 每 messageId 至多一次"的不变式 |
| D-26 | §5.1（广播全量转发）与 `Docs/Agent/14 §8 #24` 裁定 | 文档未描述事件重复发布现状（仅在修订注 1 提及发布点存在性） | `KNOWLEDGE_CONSOLIDATION` 仍有**两个发布点**：`Src/Services/Arbitration/tribunal.ts:301` 与 `Src/Services/SharedMemory/memoryConsolidator.ts:56`，而 tribunal.ts:290 的注释复述的裁定是"应仅由 Loop 成功退出点发布"——裁定未落地；由于 `ipcBridge.ts:121` 全量广播，重复会直达 UI | 需人工裁定 | 先裁定唯一发布点（建议 memoryConsolidator 不发、由 Loop 退出统一发），再在 §5.1 增补"广播为全量、无按窗过滤 ⇒ 上游重复即前端重复"的现状说明 |
| D-27 | §5.1 现状变更注 | "现态由 Electron IPC 桥接（`ipcBridge.ts`）替代"（未提启动约束） | `startIpcBridge()` 非幂等：`ipcBridge.ts:111-121` 无"已启动"守卫，重复调用会二次 `subscribeMany`（⇒ 每事件双发）并重复 `ipcMain.handle('ipc-*')`（Electron 对同 channel 重复注册会抛错）；现有仅一处 `eventSubscription` 变量记录（`:109`），`stop` 路径未防御 | 需人工裁定 | 裁定是否需要 `if (eventSubscription) return;` 守卫；并在 §5.1 补生命周期约束（单实例启动、退出时 unsubscribe） |
| D-28 | §6 依赖关系 + §3.1 委派 | 依赖表只列 `EventBus`/`AgentRegistry`/`Logger`；委派语义隐含存在"事件路由/分发"层 | `Src/Services/EventBus/eventRouter.ts` 的 `registerRoute/startRouter/forwardEvent` **在 `Src/` 内零调用者**（仅 `Src/Services/EventBus/index.ts` re-export），属死代码；分发实态是 `subscribe/subscribeMany` 直连 handler | 代码未实现 | §6 补一行说明 eventRouter 为未接线预留层（或按 Docs/Agent/07 口径删除），避免读者误以为存在路由表机制 |

## 未发现差异的抽查项

以下 21 项经 grep/read 逐条核实**与代码一致**（作为置信度参考，未计入上表）：

1. **§2 字段层逐字一致**：`messageId/traceId/sourceAgentId/targetAgentId/parentMessageId/type/payload/priority/timestamp/ttl/requiresAck/correlationId` 13 字段与 `Src/Services/EventBus/eventTypes.ts:148-161` 完全对应；`priority` 四值与 `MessagePriority`（`:146`）一致；`timestamp` 为 epoch 毫秒（符合 §2 引 Docs/Agent/09 §1.1 的统一口径）。
2. **§2 MessageType 21 值完整**：文档 21 个值与 `eventTypes.ts:136-144` 一一对应，无缺无增（问题只在"零运行期使用"，即 D-02/D-03）。
3. **§1 通信模式表第 5 行**"用户交互 = Electron IPC 桥接 + REST"：`electron/preload.ts:12,93,97,101`（`contextBridge` + `onBackendEvent/sendCommand/removeAllListeners`）、`Src/Interface/IpcBridge/ipcBridge.ts:138`、`Src/Interface/WebServer/httpServer.ts` 全部命中。
4. **§1 校准注（CONFLICT_DETECTED 发起方）**：`conflictPrecheck.ts:54` 是 `Src/` 内 `CONFLICT_DETECTED` 的唯一 `publish`，由 `mergePhase.ts:59` 合并前调用，检测维度确为"多 Agent 修改同一文件"——除行号外结论仍成立。
5. **§1/§3.2 writeGuard 三闸**：`Src/Services/SharedMemory/writeGuard.ts` 现为红线 key（:38）、乐观锁版本（:43）、assertion（:64）三项拦截，`MEMORY_VERSION_CONFLICT` 在 :55 发布，**无语义/向量冲突检测代码**（⚠️ 未实现标注依旧正确）。
6. **§3.2 注"Src 内无 CONFLICT_DETECTED 订阅方"**：全仓 grep `subscribe(EventType.CONFLICT_DETECTED)` / `waitFor(...CONFLICT...)` 0 命中，成立。
7. **§3.2 注"Arbitration 除 REST 只读查询外无执行入口"**：`tribunal.ts` 的 `fileCase`/`executeFullArbitration` 仅测试调用；`loopApi.ts:8-9` 只 import `getAllCases/getCase/getPoolStats`（只读），`Services/Arbitration/*` 内 0 处 `subscribe`/`waitFor`。
8. **§5.1 修订注 1 的事件名裁决**：`agent:stream_chunk`/`agent:stream_end`/`agent:chat_message`/`agent:iteration_complete` 确为 EventType 成员值（`eventTypes.ts` 对应 `AGENT_STREAM_CHUNK/AGENT_STREAM_END/AGENT_CHAT_MESSAGE/AGENT_ITERATION_COMPLETE`），广播帧 `type` 取其值（`ipcBridge.ts:122`）——"不另造帧名"成立。
9. **§5.1 修订注 1"task_update/agent_update 聚合帧裁决作废"**：`Src/`、`Client/src/shared/eventTypes.ts` 中均无这两个帧名，成立。
10. **§5.1 修订注 2**：`response`/`error` 类 RPC 应答确与 EventBus 无关（IPC 走 `event.reply('backend-event', …)` + `invoke` 返回值）。
11. **§5.1 修订注 4**：`GET /api/tasks/:id/stream`（SSE）确未实现（`registerRoute` 全表无 `/stream`），"标废"与代码一致。
12. **§5.2 表 行 3**：`GET /api/tasks/:taskId`（`taskApi.ts:112`）✅ 已实现。
13. **§5.2 表 行 6-7**：`GET /api/agents`（`agentApi.ts:32`）、`GET /api/agents/:agentId`（`:37`）✅ 已实现。
14. **§5.2 表 行 8-11**：`/api/tokens/overview|wallets|wallets/:agentId|transactions`（`tokenApi.ts:56,60,64,70`）四条 ✅ 全部命中，路径与文档一致。
15. **§5.2 表 行 14**：`/api/loops/events|dashboard|arbitration|arbitration/:caseId`（`loopApi.ts:74,82,86,90`）✅ 与"代码实际路径为准"的裁决一致（Docs/Client/02 附录 A 文件确实存在，`Docs/Client/02-前端改造基础/前端改造方案与构建顺序.md` 第 196 行起为附录 A）。
16. **§5.2 表 行 15**：`GET /api/arbitration/cases` 确不存在，实为 `/api/loops/arbitration`（🔁 标注正确）。
17. **§5.2 表 行 16**：`GET /api/audit/reports` 确未实现（全表 0 命中），❌ 标注正确。
18. **§5.2 表 行 17 后半**：`/api/dashboard/token-flow` 确未实现，`/api/dashboard/overview` 确不存在（实为 `/api/loops/dashboard`），🔁/❌ 标注正确。
19. **§6 依赖三项均存在**：`EventBus`（`Src/Services/EventBus/eventBus.ts`）、`AgentRegistry`（`Src/Core/AgentRuntime/agentRegistry.ts`，`loopApi.ts:10` 用 `getAllAgents`）、`Logger`（`Src/Infra/Logger`）。
20. **§5.1 现状变更注的传输层定性**：WS 三文件确已删除（`Src/Interface/WebSocket/` 仅 `.gitkeep`，工作区删除记录 -95/-173/-402），前端 `Client/src/services/ws.ts`、`hooks/useWebSocket.ts`、`useTaskStream.ts` 同步删除——"WebSocket 已被 Electron IPC 取代"的裁定与代码一致（残留问题另见 D-14）。
21. **§5.1 `backend-event`/`backend-command` 双通道命名**：`ipcBridge.ts:130`、`:138` 与 `electron/preload.ts:93/97`、`Client/src/services/eventBusBridge.ts:47` 四处完全一致；`stop_generation` 应答帧 `generation_stopped`、`ping`→`pong`（`:717/:722`）与代码一致。

---

## 回写记录（2026-10-03）

已逐条重新核实并回写 `Docs/Agent/08-Agent间通信协议/Agent间通信协议设计.md`：回写 28/28，其中 8 条清单结论已被代码追平并按新实态改写（D-03/09/12/15/16/18/19/20）、【需人工裁定】登记 8（D-13/14/17/23/24/25/26/27）、未处理 0。
