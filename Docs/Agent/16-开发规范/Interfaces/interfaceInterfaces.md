# Interface 层接口文档

> Interface 层：对外暴露的 Electron IPC 桥接 / REST API / WebServer（HTTP + 限流）/ AI 事件持久化 / 输入去重。
> 依赖方向：Interface → Core → Services → Tools → Infra

> **2026-10-03 校准（总则，N-01/N-10/N-12）**
> 1. **定位方式改造**：本文所有代码引用改为「文件名 + 函数/符号名」，不再使用绝对行号（差别清单 N-10 实测约 40 处行号引用已不可跳转，`chatApi.ts` 漂移幅度达 3-4 倍）。
> 2. **分层实测**：`Src/Interface/` 对上层 import 共 53 处（Core 10 / Services 22 / Infra 20 / Tools 1）；`Core`、`Services`、`Tools`、`Infra` 反向 import Interface **0 处** ✓ —— 文首依赖方向声明成立。
> 3. **覆盖面**：本文覆盖 Interface 层 **5 个实体目录**（`IpcBridge/`、`RestApi/`、`WebServer/`、`EventStore/`、`InputDeduplication/`）；原稿只登记前两者的代表面，`EventStore/` 与 `WebServer/apiRateLimiter.ts` 整目录缺席（N-12）。`WebSocket/` 目录现仅剩 `.gitkeep`。

---

## 1. Electron IPC 桥接 (`Src/Interface/IpcBridge/ipcBridge.ts`)

> **迁移（2026-09-28）**：WebSocket 网关已删除——`Src/Interface/WebSocket/` 现仅剩 `.gitkeep`，`wsHandler.ts`/`wsServer.ts`/`wsGateway.ts` 三文件已不存在。通信层现由 Electron IPC 桥接 `ipcBridge.ts` 承担（`ipcMain` + `BrowserWindow`：下行 `webContents.send('backend-event')`，上行 `ipcRenderer.send('backend-command')`）。浏览器开发模式下的降级链现状见 §5（**不是 HTTP 轮询事件**，见 2026-10-03 校准）。
>
> **2026-10-03 校准（N-01）**：原稿正文残留 **7 处**历史死引用（`wsHandler.ts:119-124`、`wsServer.ts:64-65`、`wsGateway.ts:41`、`wsHandler.ts:275-285`、`wsHandler.ts:349`、`wsHandler.ts:159`、`wsHandler.ts:311-335`），均已重指向 `ipcBridge.ts` 的符号（见本节与 §1.1）。历史路径降级为下方职责映射脚注：
>
> | 原 WebSocket 职责 | 现 IPC 实现（`ipcBridge.ts`） |
> |------|------|
> | `wsServer.connectClient` + 事件广播 | `startIpcBridge()` 内 `subscribeMany(Object.values(EventType), …)` → 逐窗口 `webContents.send('backend-event', msg)` |
> | `wsGateway` 的 `socket.on('message')` 收帧 | `startIpcBridge()` 内 `ipcMain.on('backend-command', …)` → `handleCommand()` |
> | `wsHandler.handleClientMessage` 命令分发 | `handleCommand()` 的 switch 分支 |
> | `wsHandler.activeStreams` 活跃流表 | 模块级 `activeStreams: Map<string, ActiveStream>` + `startStreamGeneration()` |
>
> 环境降级：`loadElectron()` 在非 Electron 主进程（`ipcMain` 不可用）或 `import('electron')` 失败时返回 null，`startIpcBridge()` 随之**以空操作模式运行**（仅记 info 日志，HTTP 链路不受影响）。`stopIpcBridge()` 退订事件、清空 `activeStreams`，并逐个 `removeHandler` 移除全部 25 个 `ipc-*` 通道。

### 客户端消息类型（上行 `backend-command`）

| type | payload | 说明 |
|------|---------|------|
| `subscribe` | `{ events: string[] }` | 订阅事件（IPC 下为 no-op 确认，见下方校准注） |
| `unsubscribe` | `{ events: string[] }` | 取消订阅（同上） |
| `get_dashboard` | — | 获取大屏数据（`handleCommand()` → `RestApi/loopApi.ts getDashboardOverview()`） |
| `get_approvals` | — | 获取审批队列（`handleCommand()` → `RestApi/approvalApi.ts listPendingApprovals()`） |
| `generate_reply` | `{ sessionId, userMessage, messageId, model?, workingMode? }` | 流式生成（经主循环执行器 `Core/Loop/runIteration.ts executeLoop`）。`model` 指定模型（未注册则回退默认），`workingMode` 为工作方式；二者可选。payload 缺失时兼容扁平字段（`handleCommand()` 的 `generate_reply` 分支 `const p = (message.payload ?? message)`，与 `stop_generation` 分支同一写法）。（2026-10-03 校准，N-02：原「wsHandler.ts:119-124」重指向符号锚点；payload 字段表经逐字核对与代码解构一致，无需改动） |
| `stop_generation` | `{ messageId }` | 停止生成：`activeStreams` 命中则 `abort()` 并 `publish` 一条 `agent:stream_end`（payload 见 §1.1 校准注） |
| `ping` | — | 心跳，回 `pong` |

> **2026-10-03 校准（N-14）三条现状补记**（帧语义与类型表全部保留，只补默认分支）：
> - `subscribe` / `unsubscribe` 在 IPC 下**退化为确认回执 no-op**：`handleCommand()` 固定回 `{ type: 'subscribed' \| 'unsubscribed', data: { message: 'IPC 模式下订阅由事件总线统一管理' } }`，不做任何实际订阅管理（订阅在 `startIpcBridge()` 里已全量完成）。
> - **未知 `type` 只记 warn、不回 `error` 帧**：`handleCommand()` 的 default 分支仅 `logger.warn('未知 IPC 命令')`；非法 JSON 帧在 `ipcMain.on('backend-command')` 的 try/catch 中被**静默忽略**。前端若发错命令名，表现为"无响应"。
> - `generate_reply` 缺 `sessionId`/`userMessage`/`messageId` 任一项 → 回 `error` 帧（`'generate_reply requires sessionId, userMessage, messageId'`）并直接 return，不启动生成。

### 服务端消息类型

> **2026-10-03 校准（N-03）**：控制帧是 **8 类**——下表 7 行（`subscribed` 与 `unsubscribed` 合写一行），由 `ipcBridge.ts handleCommand()` 显式构造。原稿"下表 7 类"是**计数写错**，不是表多列了一类；代码实际构造的正是这 8 个 type。事件帧另见 §1.1。

| type | 说明 | 构造位置（`ipcBridge.ts handleCommand()`） |
|------|------|------|
| `subscribed` / `unsubscribed` | 订阅确认（no-op，见上注） | `case 'subscribe'` / `case 'unsubscribe'` 合并分支 |
| `dashboard` | 大屏数据 | `case 'get_dashboard'` |
| `approvals` | 审批队列 | `case 'get_approvals'` |
| `generation_started` | 生成已启动（`data { messageId, sessionId }`） | `case 'generate_reply'` |
| `generation_stopped` | 生成已停止（`data { messageId }`） | `case 'stop_generation'` |
| `pong` | 心跳响应（`data { timestamp }`） | `case 'ping'` |
| `error` | 错误（`data { message }`；当前仅 `generate_reply` 参数缺失分支构造） | `case 'generate_reply'` 校验分支 |

### 1.1 事件帧

> **2026-10-03 校准（N-04）**：本节首段按代码重写。事件帧**不再是独立 WS 帧**，而是 **IPC 单通道 `backend-event` 的载荷**，且**命令回执与事件推送复用同一通道**：
> - `startIpcBridge()` 以 `subscribeMany(Object.values(EventType), …)` 订阅 **全部** EventType（"全量订阅"事实 ✓ 保留，原稿 `connectClient(Object.values(EventType))` 的等价物），回调构造 `{ type: event.eventType, data: event.payload, timestamp: event.timestamp }`（帧形如原稿所述 ✓ 保持），再遍历 `BrowserWindow.getAllWindows()` 逐窗 `webContents.send('backend-event', msg)`，窗口已关闭时静默忽略；
> - `handleCommand()` 内的 `reply()` 走 `event.reply('backend-event', msg)`——即 §1 控制帧与本节事件帧在**同一通道混流**（原稿未提），由前端 `Client/src/services/eventBusBridge.ts subscribe()` 统一分发。

**流式链路实际推送的事件**（2026-10-03 校准，N-05 + 新增登记：原稿只列三类，代码现推送七类；推送点全部重指到 `ipcBridge.ts` 符号）：

| type（事件名） | payload（data） | 触发源（`ipcBridge.ts`） |
|------|------|------|
| `agent:stream_chunk` | `{ messageId, chunk?, reasoning? }`（两字段均只在有值时挂上） | `startStreamGeneration()` 的 `IterationContext.onStreamChunk` |
| `agent:tool_call_pending` | `{ messageId, toolCallId, index, toolName, iteration }`（`toolName` 未生成完时为 `''`） | `onToolCallPending`（模型正在生成工具调用、尚未执行） |
| `agent:tool_call_started` | `{ messageId, toolCallId, toolName, arguments, iteration }` | `onToolCallStart`（工具开始执行前） |
| `agent:tool_call_result` | `{ messageId, toolCallId, toolName, status, content, recoverable, iteration, durationMs }`（`content` 非字符串时 `JSON.stringify`，`durationMs` 缺省为 `null`） | `onToolCallResult` |
| `agent:iteration_complete` | `{ messageId, iteration, totalIterations, outputText, toolCalls, toolResults, tokensConsumed, decision }`（`toolCalls` 每项附 `inferSubgroup()`/`assessRiskLevel()` 派生的 `subgroup`/`riskLevel`；`toolResults` 每项为 `{ tool_call_id, status, content, error? }`） | `onIterationComplete`（**每轮即时上报**；原稿 `wsHandler.ts:311-335` 重指） |
| `agent:stream_end` | 见下方分支表——成功 `{ messageId, tokensUsed }`；失败 `{ messageId, error }`；主动中止 `{ messageId, reason: 'user_stopped' }` | `startStreamGeneration()` 收尾各分支 + `handleCommand()` 的 `stop_generation` 分支 |
| `chat:session_renamed` | `{ sessionId, title, byModel }` | `tryAutoNameSession()`（首条请求自动命名成功后广播） |

**`agent:stream_end` 分支实况**（2026-10-03 校准，N-05；原稿声明的"失败/中止 `{ messageId, error? }`"与代码不符，逐分支回填）：

| 分支（`ipcBridge.ts`） | payload |
|------|------|
| `startStreamGeneration()`：未配置默认模型 | `{ messageId, error: '未配置默认模型（routing.defaultModel）' }` |
| `startStreamGeneration()`：请求模型未注册且回退后仍无模型 | `{ messageId, error: '无可用模型' }` |
| `startStreamGeneration()`：`createLoopConfig()` 失败 | `{ messageId, error: <loopConfig 错误串> }` |
| `startStreamGeneration()`：`executeLoop()` 返回 `ok:false` | `{ messageId, error: loopResult.error }` |
| `startStreamGeneration()`：catch 且**非**主动中止 | `{ messageId, error: <异常消息> }`（`abortController.signal.aborted` 时**不发**此帧，交由 `stop_generation` 分支独占中止语义） |
| `startStreamGeneration()`：成功 | `{ messageId, tokensUsed }` |
| `handleCommand()` `case 'stop_generation'` 主动中止 | **`{ messageId, reason: 'user_stopped' }`** —— 用 `reason` 而非 `error` 字段 |

> ⚠️ **【需人工裁定】现状记录 + 待办（2026-10-03 校准，N-05，P0）**：中止分支的字段口径与失败分支不一致——代码发 `{ messageId, reason: 'user_stopped' }`，而原契约（以及前端按 `data.error` 判中止/失败的读法）期望 `error` 字段。**现状**：`ipcBridge.ts` 的 `stop_generation` 分支确为 `reason`；失败分支（五处）确为 `error`；两者互斥且中止时不再补发 `error`。**待办**：裁定 ①改码统一为 `error`（并把 `user_stopped` 放进 error 或新增 `aborted: true`），或 ②改前端契约按 `reason` 识别中止 + 本文档正式登记两字段并存口径。本条**只记录不裁决**，另需同步 `Docs/Client/*` 的流式收尾约定。

**约束**：事件名字符串一律取自 `Src/Services/EventBus/eventTypes.ts`，前端侧由 `Scripts/genEventTypes.ts` 构建期生成 `Client/src/shared/eventTypes.ts`，不得自造帧名（详见 Docs/Client/02 §2 铁律 2）。

### 1.2 IPC invoke/handle 通道（2026-10-03 校准 新增，N-06）

> `ipcBridge.ts registerIpcHandlers(ipcMain)` 注册 **25 个 `ipc-*` 请求-响应通道**（`ipcMain.handle` 全集实测计数 = 25；差别清单 N-06 记为 28 系分类小计重复，本表以代码为准）。返回信封统一为 `{ ok: boolean, data?, error? }`；**四个通道为例外**：`ipc-get-providers` 返回**裸数组**、`ipc-get-models` 返回**裸 `string[]`**、`ipc-get-routing` 返回**裸 `RoutingConfig \| null`**、`ipc-add-provider` 直接回传 `registerProvider()` 的 `Result`（成功字段为 `value` 而非 `data`）。整节原稿未登记。

**模型与供应商（7）**

| 通道 | 入参 | 返回 | 后端来源 / REST 等价 |
|------|------|------|------|
| `ipc-get-providers` | — | `Array<{ name, displayName, models }>`（**裸数组，非信封**） | `Infra/Llm/Router/modelRouter getProviders` + `provider.getModels()` |
| `ipc-add-provider` | `config { provider\|display_name, base_url, api_key, models? }` | `registerProvider()` 的 `Result`（成功字段为 **`value`**、失败为 `error`；异常分支回 `{ ok:false, error }`）；注册成功后就地 `upsertProviderSecret` 落盘（失败只 warn，不影响本次注册） | `modelRouter registerProvider` / `uniqueProviderName`（同类型多实例不再互相覆盖）；无 REST 等价 |
| `ipc-remove-provider` | `name: string` | `{ ok: true }` | `modelRouter unregisterProvider` + `secretsStore removeProviderSecret`；无 REST 等价 |
| `ipc-fetch-models` | `config { base_url, api_key }` | `{ ok, data: Array<{ id, context_window, max_output, supports_vision, supports_tools, cost_per_1k_input, cost_per_1k_output }> }`——直连上游 `GET ${base_url}/models`（Bearer 鉴权），**除 `id` 外六个字段为代码硬编码默认值**（`128000`/`8192`/`false`/`true`/`0`/`0`，注释自述"拉取后由用户确认"） | 无 REST 等价 |
| `ipc-get-routing` | — | **`RoutingConfig \| null`（裸返回）** | `modelRouter getRoutingConfig`；无 REST 等价 |
| `ipc-update-routing` | `config: Partial<RoutingConfig>`（9 键逐键合并，缺省取现值或代码默认：`timeoutMs 60000`/`firstByteTimeoutMs 10000`/`interChunkTimeoutMs 15000`） | `{ ok, data: RoutingConfig }` | `modelRouter setRoutingConfig`；无 REST 等价 |
| `ipc-get-models` | — | `string[]`（qualified name 列表，**裸返回**） | `modelRouter getRegisteredModels` ≡ REST `GET /api/models` |

**会话 / 消息 / 待办（8）**

| 通道 | 入参 | 返回 | 后端来源 / REST 等价 |
|------|------|------|------|
| `ipc-list-sessions` | `{ archived?: boolean \| 'all' }`（默认 `false`） | `{ ok, data: ChatSessionRow[] }` | `RestApi/chatApi listSessions` ≡ `GET /api/sessions?archived=` |
| `ipc-create-session` | `{ title?, workDir? }` | `{ ok, data: ChatSessionRow }` | `chatApi createSession` ≡ `POST /api/sessions` |
| `ipc-update-session` | `{ sessionId, title?, workDir?: string \| null }` | `{ ok, data }`（带 `workDir` 时返回 `updateSessionWorkDir` 结果，仅改标题时返回 `getSession()`） | `chatApi updateSessionTitle` / `updateSessionWorkDir` ≡ `PATCH /api/sessions/:sessionId` |
| `ipc-archive-session` | `{ sessionId, archived: boolean }` | `{ ok, data }` / 失败 `{ ok:false, error }` | `chatApi archiveSession` ≡ `POST /api/sessions/:sessionId/archive` |
| `ipc-list-messages` | `{ sessionId, limit? = 50 }` | `{ ok, data: ChatMessageRow[] }` | `chatApi listMessages` ≡ `GET /api/sessions/:sessionId/messages` |
| `ipc-add-message` | `{ sessionId, role: 'user'\|'assistant'\|'system', content, model?, tokens_used? }` | `{ ok, data: ChatMessageRow }` | `chatApi addMessage` ≡ `POST /api/sessions/:sessionId/messages` |
| `ipc-get-todos` | `{ sessionId?, all? }` | `all` → `{ items, total }`；否则 `{ sessionId, groups, total }`（按来源 agent 分组） | `Services/Planning/todoStore listAllTodos` / `listTodosBySession` ≡ `GET /api/todos`、`GET /api/sessions/:sessionId/todos` |
| `ipc-clear-todos` | `{ sessionId, agentId? }` | `{ ok, data: { removed } }` | `todoStore clearTodos` ≡ `DELETE /api/sessions/:sessionId/todos?agentId=` |

**配置（1）**

| 通道 | 入参 | 返回 | 后端来源 / REST 等价 |
|------|------|------|------|
| `ipc-get-config` | `name: string` | `{ ok, data }`；未找到 → `{ ok:false, error: 'Config not found' }` | `RestApi/configApi getConfig` ≡ `GET /api/configs/:name` |

**记忆 / 技能 / 工具 / 统计（6）**

| 通道 | 入参 | 返回 | 后端来源 / REST 等价 |
|------|------|------|------|
| `ipc-get-memory-entries` | `{ namespace?, limit? = 50（上限 200）, offset? }` | `{ ok:true, data:{ items, total } }`；恒按 `getActiveOwner()` 过滤（FE-032），异常分支也返回 `ok:true` 空列表 | `Infra/Db getDatabases().memory` 直查 `memory_entries` ≡ `GET /api/memory/entries` |
| `ipc-get-long-term-memory` | `{ category?, status?, limit? = 1000（上限 5000） }` | `{ ok, data:{ items, total } }` | `Services/SharedMemory listAllMemories` ≡ `GET /api/memory/long-term` |
| `ipc-bulk-long-term-memory` | `{ items: unknown[] }`（≤5000；逐条 `parseLongTermMemoryEntry()` 校验 `memoryId/title/content` 必填，非法即整批拒绝） | `{ ok, data:{ imported, updated, total } }` | `Services/SharedMemory importMemories` ≡ `POST /api/memory/long-term/bulk` |
| `ipc-get-stats-events` | `{ since? = 0, limit? = 500（上限 2000） }` | `{ ok, data: DerivedStatsResult }` | `RestApi/syncApi deriveStatsEvents` ≡ `GET /api/sync/stats-events` |
| `ipc-get-skills` | — | `{ ok, data:{ items: SkillEntry[], total } }` | 本文件内 `listSkills()`（读 `Skills/{playbooks,rubrics,rules,strategies}/*.md`）≡ `GET /api/skills` |
| `ipc-get-custom-tools` | — | **恒为** `{ ok:true, data:{ items: [], total: 0 } }`（桩语义：当前所有注册工具均视为 builtin） | ≡ REST `GET /api/tools/custom`（同样恒空，见 `RestApi/toolsApi.ts listTools()`） |

**设备与凭据（3）** ⚠️ 凭据面

| 通道 | 入参 | 返回 | 后端来源 / REST 等价 |
|------|------|------|------|
| `ipc-get-device-fingerprint` | — | `{ ok, data:{ fingerprint } }` | `Infra/Security/deviceFingerprint getDeviceFingerprint`；无 REST 等价 |
| `ipc-save-secrets` | `secrets: ProvidersSecrets`（**整包**） | `{ ok }` / 拒绝 → `{ ok:false, error }` | `Infra/Security/secretsStore saveProviderSecrets`；写入前用 `hasUsableSecret()` 拒绝"把已有 key 覆盖为空"的整包 |
| `ipc-load-secrets` | — | `{ ok, data: ProvidersSecrets }`（**含解密后的明文 apiKey**） | `secretsStore loadProviderSecrets`；无 REST 等价 |

> ⚠️ **凭据面约束（2026-10-03 校准，N-06 建议项回写）**：`ipc-save-secrets` 是**整包覆盖**通道，代码注释自述保留仅为兼容（历史客户端会把已有供应商的 apiKey 写空——"再加一个模型就刷掉上一个"）。供应商增删改的持久化**已改走后端就地 upsert**：`ipc-add-provider` → `upsertProviderSecret`、`ipc-remove-provider` → `removeProviderSecret`，重启时由 `registerIpcHandlers()` 内 fire-and-forget 的 `restoreProvidersFromSecrets()` 按加密凭据恢复注册（跳过 `hasUsableSecret()` 不合格的历史脏数据）。**新代码不得再用 `ipc-save-secrets` 写单条供应商**。`ipc-load-secrets` 返回明文凭据，仅限主进程→受信渲染进程，禁止落 localStorage（前端令牌类凭据走 `Client/src/services/secureStore.ts` 的 safeStorage 路径）。

> 脚注：另有**非 `ipc-*` 通道**在 Electron 主进程 `electron/main.ts` 注册（`server-fetch`、`pick-directory`、`get-server-ports`、`get-app-version`、`open-external`、`secure-store-available\|get\|set\|remove`），**不属 `Src/Interface` 层**，故不入本表；渲染进程侧统一由 `Electron/preload.ts` 暴露为 `window.electronAPI`。

---

## 2. RestApi (`Src/Interface/RestApi/`)

> **2026-10-03 校准（N-07/N-08/N-09/N-10）**：
> - **断言更正（N-07）**：原稿在 `chatApi.ts` 行末的加粗断言"**不存在 `/api/messages`**"**已被代码推翻**——现存在 **`PATCH /api/messages/:messageId`**（`chatApi.ts registerChatRoutes()`，回填消息富结构）。收窄为："**不存在裸 `GET/POST /api/messages`；存在 `PATCH /api/messages/:messageId`**"。裸 `/api/tokens`、裸 `/api/loops`、`/api/dashboard` 三条断言 **复查仍成立**（`Src/Interface/` 全域 0 命中）。
> - **覆盖面（N-08/N-09）**：`WebServer/routes.ts registerAllRoutes()` 现注册 **12 个路由模块 / 46 个端点**（原稿 7 模块）。新增 `memoryApi`/`syncApi`/`toolsApi`/`skillsApi`/`placeholderApi` 五模块（15 端点），`chatApi` 从 6 端点增至 **13 端点**（单列 §2.1）。
> - **定位方式（N-10）**：原稿 7 处行号锚全部漂移（`chatApi.ts` 由约 124 行膨胀到 523 行），本节改为「文件 + `registerXxxRoutes()` + 路径」三元组。

| 路由文件 | 端点 | 说明（注册函数一律为各文件的 `registerXxxRoutes()`） |
|---------|------|------|
| `taskApi.ts` | `POST /api/tasks`、`GET /api/tasks?status=`、`GET /api/tasks/:taskId`、`DELETE /api/tasks/:taskId` | 提交（`submitTask()` 内经 `queueMicrotask` 异步转调 `Core/Decision/orchestrator receiveTask()`）/ 列表 / 详情 / 取消（`cancelTask()`）。测试隔离入口 `resetTaskApi()` |
| `agentApi.ts` | `GET /api/agents?status=`、`GET /api/agents/:agentId` | Agent 列表 / 详情（`listAgents()` / `getAgentDetail()`） |
| `tokenApi.ts` | `GET /api/tokens/overview`、`GET /api/tokens/wallets`、`GET /api/tokens/wallets/:agentId`、`GET /api/tokens/transactions?walletId=` | Token 总览 / 钱包列表 / 单钱包 / 交易流水（`getTokenOverview()` / `listWallets()` / `getWalletDetail()` / `listTransactions()`）；**无裸 `/api/tokens`** ✓ |
| `approvalApi.ts` | `GET /api/approvals?status=all\|include=decided`、`GET /api/approvals/:approvalId`、`POST /api/approvals/:approvalId/decide` | 审批队列 / 详情 / 决策（body `{ decidedBy, approve, reason? }`，`decidedBy` 必填字符串、`approve` 必填布尔；默认拒绝语义不变）。**2026-10-03 校准补充**：列表默认只回待审，`?status=all` 或 `?include=decided` 才含已决策（`listApprovals(includeDecided)`）。决策成功后 `publish` `approval:decided` 事件（payload 含 `toolCallId`/`sessionId`/`toolName`/`status`/`approve`/`decidedBy`/`loopId`），供其他客户端与内嵌审批卡同步 |
| `loopApi.ts` | `GET /api/loops/events?eventType=&traceId=&limit=`、`GET /api/loops/dashboard`、`GET /api/loops/arbitration`、`GET /api/loops/arbitration/:caseId` | 事件日志（`getEvents(filter)`，三个查询参数均为可选）/ 大屏概览（`getDashboardOverview()`，亦为 IPC `get_dashboard` 数据源）/ 仲裁案件列表（`listArbitrationCases()`）/ 详情（`getArbitrationCase()`）；**无裸 `/api/loops` 与 `/api/dashboard`** ✓ |
| `chatApi.ts` | 13 个端点，见 §2.1 | 会话 CRUD + 消息读写 + 富结构回填 + AI 事件回放 + 计划清单；IPC 会话/消息通道与 REST 共用同一批纯函数 |
| `configApi.ts` | `GET /api/configs`、`GET /api/configs/:name` | `Configs/` 目录 JSON 配置只读列表 / 详情（`listConfigs()` / `getConfig()`）；IPC 等价通道 `ipc-get-config` |
| `memoryApi.ts` | `GET /api/memory/long-term`、`POST /api/memory/long-term/bulk`、`GET /api/account/active-user`、`PUT /api/account/active-user`、`GET /api/memory/entries`、`GET /api/memory/entries/:key` | 长时记忆查询 / 批量导入（≤5000 条，按 `memoryId` 幂等，写入**当前属主**）/ 属主读取 / 属主切换（`setActiveOwner()` + `hydrateLongTermMemory()` 回灌）/ 记忆条目列表 / 单条目。条目按属主过滤（FE-032），`memory_entries` 为长时记忆镜像投影（FE-034）。**IPC 等价**：`ipc-get-memory-entries`、`ipc-get-long-term-memory`、`ipc-bulk-long-term-memory` |
| `syncApi.ts` | `GET /api/sync/stats-events?since=&limit=` | 从**本地库派生**个人统计事件（`deriveStatsEvents()`）：`chat.turn`（键 `msg:<message_id>`）、`token.consumed`（键 `tx:<transaction_id>`）、`tool.call`（键 `eff:<effect_id>` 优先、无副作用记录时用 `tool:<event_id>`）。**IPC 等价**：`ipc-get-stats-events` |
| `toolsApi.ts` | `GET /api/tools?type=`、`GET /api/tools/custom` | 工具只读视图（数据源 `Tools/Registry getAllToolSpecs()`）。⚠️ `ToolSpec` 无 builtin/custom 标记，`listTools()` 对 `type=custom` **恒返回空列表**；`ipc-get-custom-tools` 同样恒空 |
| `skillsApi.ts` | `GET /api/skills`、`GET /api/skills/:id` | `Skills/` 下 `.md` 只读视图，`:id` 形如 `category/name`（四分类 playbooks/rubrics/rules/strategies）。**IPC 等价**：`ipc-get-skills` |
| `placeholderApi.ts` | `GET /api/data-hub`、`GET /api/mcp/connections`、`GET /api/user/profile` | ⚠️ **占位 / 未实装（目标态）**：三者均返回 `{ items: [], message: 'Coming in Phase 3' }`，**前端不得按可用接口对接**（N-08 要求显式标注） |

### 2.1 chatApi.ts 端点全表（13，2026-10-03 校准 新增，N-09）

| 方法 + 路径 | 说明 |
|------|------|
| `GET /api/sessions?archived=` | 会话列表。`?archived` 为**三态**：缺省/`false` → 仅未归档；`true`\|`1` → 仅已归档；`all` → 全部（`listSessions({ archived })`）。原稿写作"无查询参数"，已更正 |
| `POST /api/sessions` | 创建会话（可选 `title`/`workDir`；缺省工作目录为 `Data/workspaces/<sessionId>/`），返回 201 |
| `GET /api/sessions/:sessionId/messages?limit=` | 消息列表（`limit` 默认 50） |
| `POST /api/sessions/:sessionId/messages` | 发送消息（`role` 默认 `user`，限 `user\|assistant\|system`；`content` 必填；可带 `model`/`tokens_used`/`trace_id`），返回 201 |
| `PATCH /api/sessions/:sessionId` | 更新会话：`title` → `updateSessionTitle()`（首条消息自动命名回写即走此路径）；显式携带 `workDir` 键（含 `null`/`''` 表示重置为默认目录）→ `updateSessionWorkDir()` |
| `POST /api/sessions/:sessionId/archive` | 归档 / 取消归档（软状态，body `archived` 必须为布尔；不删消息） |
| `PATCH /api/messages/:messageId` | **消息级富结构回填**（`updateMessageRich()`：`reasoning`/`toolCalls`/`segments`/`totalIterations`/`error`/`status`/`model`/`tokensUsed`/`traceId`）。此端点推翻原稿"不存在 `/api/messages`"断言（N-07） |
| `POST /api/sessions/:sessionId/messages/rich` | 按「会话 + 角色 + 正文」定位并回填/创建富消息（`upsertRichMessage()`）——前端不知后端 `message_id`，故以此路径补齐组件数据 |
| `GET /api/sessions/:sessionId/ai-events?since=&limit=` | 会话内 AI 组件事件流（重启后回放重建），数据源 `EventStore/aiEventStore.ts listAiEvents()`（`limit` 默认 2000） |
| `GET /api/sessions/:sessionId/todos` | 该会话的 Agent 计划清单，**按来源 agent 分组**（`listTodosBySession()`） |
| `DELETE /api/sessions/:sessionId/todos?agentId=` | 清空计划：不带 `agentId` 清全会话，带则只清该 agent（`clearTodos()`） |
| `GET /api/todos` | 全部计划（跨会话/跨 agent；备份包携带用，`listAllTodos()`） |
| `GET /api/models` | 可用模型列表 → `Infra/Llm/Router getRegisteredModels()`；IPC 等价 `ipc-get-models` |

### 2.2 路由底座与限流（2026-10-03 校准 新增，N-12）

**`RestApi/router.ts`（注册底座，46 个端点必经）**

| 导出 | 签名 | 说明 |
|------|------|------|
| `registerRoute` | `(method: HttpMethod, path: string, handler: ApiHandler) → void` | 注册路由（`path` 支持 `:param` 段） |
| `matchRoute` | `(method, path) → { handler, params } \| undefined` | 路径匹配与参数提取 |
| `parseQuery` | `(search: string) → Record<string, string>` | 查询串解析 |
| `clearRoutes` | `() → void` | 清空路由表（`registerAllRoutes()` 首步即调用，保证重复注册幂等） |
| `json` / `apiError` | `(data, status = 200) → ApiResponse` / `(message, status = 400) → ApiResponse` | 统一响应构造 |
| 类型 | `HttpMethod`（`GET\|POST\|PUT\|DELETE\|PATCH`）、`ApiRequest`、`ApiResponse`、`ApiHandler` | 请求/响应契约 |

**`WebServer/webServer.ts`（HTTP 分发入口）**

> **2026-10-03 校准更正**：原稿称"旧 `webServer.ts` 的内存请求模拟仅保留给单测，不再对外服务"——**与代码不符**。实际 `WebServer/httpServer.ts handleApiRequest()` 对**每一个 `/api/*` 请求**都调用 `webServer.ts handleRequest()` 完成 `matchRoute`/`parseQuery` 分发、404/500 兜底与请求日志记录；`webServer.ts` 仍是生产分发链的一环。仍然成立的部分是**它不绑定端口**（端口绑定在 `startHttpServer()`），以及 `getRequestLogs()` / `getRequestCount()` / `resetWebServer()` 主要供 `Tests/Interface/interactionObservability.spec.ts` 观测使用。

**`WebServer/apiRateLimiter.ts`（HTTP 入口限流）**

| 导出 | 签名 | 说明 |
|------|------|------|
| `initApiRateLimiter` | `(overrides: Partial<ApiRateLimitConfig> = {}) → void` | 注入/更新配置并清空计数桶；由 `main.ts startServer()` 以 `supervision.apiRateLimit` 调用（FE-040：与监管侧 `supervision.rateLimit` **解耦**，为 UI 放宽不影响 Agent 阈值）。默认 `600 次/分钟 × burstAllowance 2`（`Infra/Contracts/rateLimitTypes.ts DEFAULT_API_RATE_LIMIT_CONFIG`，`Configs/supervision.json` 同值） |
| `applyApiRateLimit` | `(req: IncomingMessage, res: ServerResponse) → boolean` | 返回 `true` 表示已写 429 并拦截（`httpServer.ts` 的 `/api/` 分支在路由分发前调用）。按 **IP**（`x-forwarded-for` 首段优先）固定 60s 窗口计数；响应头 `X-RateLimit-Limit` / `X-RateLimit-Remaining`，限流时另发 `Retry-After`，体为 `{ ok:false, error:'rate_limited', message, retryAfter }` |
| `resetApiRateLimiter` | `() → void` | 复位配置与桶（仅测试使用） |

> ⚠️ 现状记录：`Client/src/hooks/useApprovalPolling.ts` 头注释仍按"后端 API 限流为 30 次/分钟 × burst 1.5"（监管侧 `supervision.rateLimit` 旧口径）解释轮询间隔，与 HTTP 层实际使用的 `supervision.apiRateLimit`（600×2）不一致；前端 429 处理（`Client/src/services/api.ts api()` 按 `Retry-After` 重试一次）与后端行为吻合。是否同步该注释属代码侧事项，本文档只登记现状。

**接线方式**（2026-10-03 校准，N-11：机制全部成立，四处行号改符号）

- `WebServer/routes.ts registerAllRoutes()`：先 `clearRoutes()`，再依次调用 12 个 `registerXxxRoutes()`（task → agent → token → approval → loop → chat → config → memory → sync → tools → skills → placeholder）。
- `WebServer/httpServer.ts startHttpServer(config)`：Node 原生 `http.createServer`，`server.listen(config.port, config.host)`；同一 handler 内依次处理 CORS（`config.corsOrigins` 命中才发头）、`OPTIONS` 预检 204、`/api/*` → `applyApiRateLimit()` → `handleApiRequest()`（→ `webServer.handleRequest()`）、非 API → 静态目录（默认 `Client/dist`）→ SPA fallback `index.html` → 404。停止用 `stopHttpServer()`。
- `Src/main.ts startServer()` 的装配次序：`initApiRateLimiter()`（`supervision.apiRateLimit`）→ `startAiEventPersistence()`（§4）→ `registerAllRoutes()` → `startHttpServer({ host, port, corsOrigins })` → `startIpcBridge()`（§1）。端口默认值取自 `server` 配置节：`httpPort` **3000**、`host` `0.0.0.0`、`corsOrigins` `['http://localhost:5173']`。
- **IPC 与 HTTP 是两条并行链路**：`main.ts` 同时拉起 `startHttpServer()` 与 `startIpcBridge()`；Electron 模式下渲染进程优先走 `ipc-*` / `backend-event`，浏览器开发模式走 `/api/*`（Vite 代理 `/api` → `http://localhost:3000`）。

---

## 3. InputDeduplication (`Src/Interface/InputDeduplication/dedupMiddleware.ts`)

> **2026-09-22 校准**：原列 `dedupMiddleware(req, res, next)` 在代码中不存在——本模块不是 Express 式中间件，而是一组纯函数 + 聚合入口，按实际导出名重写如下。
> **2026-10-03 校准（N-10 关联）**：本节是五份契约文档中精确度最高的一节——12 个函数名与全部签名**逐条复查命中 ✓**，原绝对行号（`:183-216`、`:52,238`、`:69`、`:88`、`:103`、`:122`、`:128,143`、`:151,220`）改为符号定位，不再依赖行号。

| 函数 | 签名 | 说明 |
|------|------|------|
| `dedupCheck` | `(params: { source, intent, target, agentId, idempotencyId? }) → Result<{ dedupKey }>` | 五道防护聚合入口，依序：熔断 → 去重键 → 冷却 → 幂等 → 并发槽（`dedupCheck` 函数体） |
| `initDedupMiddleware` / `resetDedupMiddleware` | `(cfg: Partial<DedupConfig>) → void` / `() → void` | 初始化 / 复位（默认值见模块内 `DEFAULT_CONFIG`） |
| `computeDedupKey` | `(source, intent, target) → string` | 去重键 |
| `checkDedup` / `checkCooldown` / `checkIdempotency` / `storeIdempotency` | 见各函数签名 | 单道防护，可独立调用 |
| `acquireConcurrencySlot` / `releaseConcurrencySlot` | `(userId) → Result<void>` / `(userId) → void` | 并发槽（全局 `maxConcurrent` 20 + 单用户 `maxPerUser` 5） |
| `checkCircuitBreaker` / `getDedupStats` | `() → { open, reason? }` / `() → 统计对象` | 熔断状态 / 计数 |
| 类型 `DedupConfig` | 7 字段：`dedupTtlMs`/`cooldownMs`/`idempotencyTtlMs`/`maxConcurrent`/`maxPerUser`/`circuitBreakerThreshold`/`circuitBreakerCooldownMs` | 配置契约（默认 5min / 30s / 24h / 20 / 5 / 100 次每分钟 / 60s） |

> ⚠️ **未实现 / 目标态（2026-10-03 校准新增）**：本模块**无生产调用方**——全仓消费者只有 `Tests/Interface/interactionObservability.spec.ts`，`Src/` 内既不调用 `dedupCheck()` 也不调用 `initDedupMiddleware()`；`main.ts` 启动装配的 `initDedupStore()` / `initCircuitBreaker()` 属 `Services/LoopScheduler`，与本模块无关联。状态全为进程内 `Map`（模块头注释自述"Phase 0-2 内存实现；Phase 3 接 Redis/DB"）。**待办**：接口层去重/防风暴何时接入生产链路（HTTP 入口或 IPC `handleCommand()`）需另行排期；接入前，本文档中的"五道防护"应读作**已就绪、未接线**。

---

## 4. EventStore：AI 事件持久化 (`Src/Interface/EventStore/aiEventStore.ts`)（2026-10-03 校准 新增，N-12）

> 背景（代码注释自述）：AI 组件族是**事件驱动**的，事件只存内存总线时重启后组件全部消失。本模块把会话内与组件相关的事件写入 `ai_events` 表（迁移 v23），前端打开会话时按序回放重建。REST 侧消费者为 `GET /api/sessions/:sessionId/ai-events`（`chatApi.ts`）。

| 导出 | 签名 | 说明 |
|------|------|------|
| `shouldPersist` | `(type: string) → boolean` | 过滤规则：`SKIP_TYPES`（`agent:stream_chunk`，逐 token 高频且正文已由 `chat_messages` 持久化）之外，按 `PERSIST_PREFIXES`（`agent:` `task:` `tool:` `approval:` `memory:` `middleware:` `hook:` `delegation:` `arbitration:` `token:` `chat:`）**前缀匹配** |
| `persistAiEvent` | `(event: DomainEvent, ownerOverride?: string) → void` | 写入一行；`session_id` 由 `sessionIdOf()` 从 payload 的 `sessionId`/`session_id`/`chatSessionId` 依次提取，取不到时用模块级 `lastKnownSessionId` 兜底（否则 `agent:iteration_complete`、`agent:stream_end` 这类不带会话字段的关键事件会以 NULL 落库、按会话回放取不到）；属主按 `getActiveOwner()` 标注 |
| `listAiEvents` | `(sessionId, options?: { sinceTs?, limit? }) → PersistedAiEvent[]` | 按会话顺序读取（事件回放入口） |
| `countAiEvents` | `(sessionId?) → number` | 计数 |
| `clearSessionEvents` | `(sessionId) → void` | 清空会话事件 |
| `startAiEventPersistence` | `() → number` | 对 `Object.values(EventType)` 过滤后 `subscribeMany` 全量订阅（新增组件族事件无需改此处），返回实际订阅类型数；重复调用短路。由 `main.ts startServer()` 在接口层装配前调用 |
| `stopAiEventPersistence` | `() → void` | 取消启用（测试用） |
| 类型 `PersistedAiEvent` | `{ event_id, session_id, owner_user_id, type, data_json, ts, seq }` | 落库行形态（`data_json` 为事件 payload 序列化，读取侧 `chatApi.ts safeParse()` 还原） |

---

## 5. 前端通信模块 → 后端通道映射（2026-10-03 校准 新增，N-13）

> 原稿只描述了一条"IPC ↔ HTTP 轮询"降级链。实际 `Client/src/services/` 有 6 个通信层模块、`Client/src/hooks/` 4 个消费钩子，Electron 与浏览器两条路径的模块划分如下（按代码实况）：

| 前端模块 | 后端通道 | 说明 |
|------|------|------|
| `services/eventBusBridge.ts` | `backend-command`（上行）/ `backend-event`（下行） | `connectBridge()` / `subscribe()` / `send()` / `disconnectBridge()`。Electron 判定依据是 `window.electronAPI.onBackendEvent` 是否存在 |
| `services/ipcApi.ts` | 全部 25 个 `ipc-*` invoke 通道（经 `Electron/preload.ts` 暴露的 `window.electronAPI`，按 `modelProviders` / `sessions` / `todos` / `configs` / `data` / `device` / `secrets` 分组） | 供应商/路由/会话/消息/待办/配置/记忆/技能/工具/统计/设备指纹/密钥的读写。**2026-10-03 校准（⚠️ 目标态未落实）**：模块头注释称"非 Electron 环境下降级为 HTTP 或空操作"，实装只有**空操作**——`isElectron()` 为假时各函数直接返回 `[]` 或 `{ ok:false, error:'Electron API 不可用' }`，**无任何 HTTP 兜底实现** |
| `services/api.ts` | REST `/api/*`（相对路径，Vite 代理 → 3000） | `api()` / `apiGet` / `apiPost`：15s 超时、错误分类（`network\|timeout\|4xx\|5xx\|rate_limited\|unknown`）、429 按 `Retry-After` 自动重试一次 |
| `services/secureStore.ts` | `electron/main.ts` 的 `secure-store-*` 通道 | 账号令牌持久化：Electron 走 `safeStorage`（DPAPI/Keychain/libsecret），浏览器降级 `sessionStorage`；明文凭据不进 localStorage |
| `services/serverApi.ts` | `Server/` 远端 HTTP（默认 `http://127.0.0.1:8787`） | **与本地进程内服务无关**：Bearer 令牌 + 自动刷新重试一次 + `{ok,data}` 约定 |
| `services/syncService.ts` | 本地 `/api/sessions?archived=all`、`/api/sessions/:id/archive`、`/api/memory/long-term`、`/api/memory/long-term/bulk`、`/api/sync/stats-events` ↔ 服务端 `/v1/*` | 上下行编排与幂等键（`clientMemoryId` / `clientEventId`） |
| `hooks/useEventBus.ts` | `eventBusBridge.subscribe()` | 组件族事件分发 |
| `hooks/useApprovalPolling.ts` | 经 `stores/approvalStore.ts hydrate()` 走 REST `GET /api/approvals?status=all`（30s） | 事件下行的**兜底**（浏览器模式无事件通道才依赖轮询）；引用计数保证多组件共享一个定时器 |
| `hooks/useDashboardData.ts` | 经 `stores/systemStore.ts hydrate()` 走 REST `GET /api/loops/dashboard`（5s） | 大屏聚合轮询（头注释仍写"WS 增量"，为历史措辞） |
| `hooks/useAlerts.ts` | 纯前端派生（stores 计算） | 五条告警规则，不触网 |

> ⚠️ **未实现 / 目标态（2026-10-03 校准，N-13）**：原稿与 `eventBusBridge.ts` 头注释均称"浏览器开发模式经 **HTTP 轮询获取事件**降级"。代码实态：`startFallbackPolling()` 每 3s 只做**"Electron API 是否已可用"的重连探测**（命中则 `stopFallbackPolling()` 并切回 IPC），**并未轮询任何事件端点**；`send()` 在浏览器模式下直接 `console.warn` **静默丢弃命令**。当前浏览器模式的事件近似来自各钩子对 REST 端点的定时轮询（审批 30s / 大屏 5s）。**待办**：要么补实现"事件 → REST 轮询"通道，要么把 §1 与头注释的"HTTP 轮询降级"措辞降格为"仅可用性探测 + 命令不可用"，二者需一并裁定（涉及 `Docs/Client/*` 的降级约定）。
>
> 复查结论：前端原 WebSocket/流式文件 `ws.ts`、`useWebSocket.ts`、`useTaskStream.ts` 均已不存在，其职责由 `eventBusBridge.ts`（事件/命令）+ `ipcApi.ts`（invoke）+ 各轮询钩子承接；`eventBusBridge.ts` 存在 ✓（N-13 中"文件存在"这一条原稿声明成立，缺的是它只描述了一条降级链）。

---

## 6. 现状与待办登记（2026-10-03 校准）

| 关联条目 | 现状（一句话） | 待办 |
|------|------|------|
| N-05 | `agent:stream_end` 中止分支用 `reason`、失败分支用 `error`，字段口径分裂；前端按 `data.error` 判中止会读空 | **【需人工裁定】** 改码统一 vs 改前端契约 + 文档正式登记两字段并存（§1.1 已按代码回填全部六处分支实况） |
| N-13 | 浏览器模式"HTTP 轮询取事件"未实现，仅可用性探测；命令在浏览器模式静默丢弃 | **【需人工裁定】** 补实现或降格措辞（§5 已登记 ⚠️ 未实现/目标态） |
| N-06 | `ipc-get-custom-tools` / `GET /api/tools/custom` 恒返回空列表（`ToolSpec` 无 builtin/custom 标记） | 待 Tools 层补 `isBuiltin` 标记后回写；现文档已显式标注桩语义 |
| N-08 | `placeholderApi` 三端点为 Phase 3 占位 | 已标 ⚠️ 占位/未实装；实装后需同步 §2 与 `Docs/Client/02 附录 A` 路径映射 |
| N-12 | §3 InputDeduplication 五道防护无生产调用方 | 待接线排期（§3 已标 ⚠️ 未实现/目标态） |
| N-01/N-10 | 绝对行号已全部改为符号锚；`ipcBridge.ts` 的 `stream_end` 推送点相对清单记载再漂移 +1（清单 :938/:947/:957 → 现 `startStreamGeneration()` 收尾三分支） | 后续改动请继续以「文件 + 函数/符号」引用，避免集体失效 |

> 交叉引用：层内其他契约文档见 `coreInterfaces.md` / `servicesInterfaces.md` / `toolsInterfaces.md` / `infraInterfaces.md`；路径权威映射见 Docs/Client/02 附录 A；本节的 6 条登记项与 `Docs/Dev/Agent-16-开发规范接口契约-差别清单.md` §5 的 N-01…N-14 一一对应。
