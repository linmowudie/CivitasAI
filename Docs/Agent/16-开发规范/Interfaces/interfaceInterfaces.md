# Interface 层接口文档

> Interface 层：对外暴露的 REST API / WebSocket / WebServer。
> 依赖方向：Interface → Core → Services → Tools → Infra

---

## 1. WebSocket (`Src/Interface/WebSocket/`)

### 客户端消息类型

| type | payload | 说明 |
|------|---------|------|
| `subscribe` | `{ events: string[] }` | 订阅事件 |
| `unsubscribe` | `{ events: string[] }` | 取消订阅 |
| `get_dashboard` | — | 获取大屏数据 |
| `get_approvals` | — | 获取审批队列 |
| `generate_reply` | `{ sessionId, userMessage, messageId, model?, workingMode? }` | 流式生成（经主循环执行器）。`model` 指定模型（未注册则回退默认），`workingMode` 为工作方式；二者可选。payload 缺失时兼容扁平字段（`payload ?? message`，wsHandler.ts:119-124）。（2026-09-22 校准） |
| `stop_generation` | `{ messageId }` | 停止生成 |
| `ping` | — | 心跳 |

### 服务端消息类型

> 下表 7 类为**控制帧**（`wsHandler.ts` 显式构造）。事件帧另见 §1.1。（2026-09-22 校准）

| type | 说明 |
|------|------|
| `subscribed` / `unsubscribed` | 订阅确认 |
| `dashboard` | 大屏数据 |
| `approvals` | 审批队列 |
| `generation_started` | 生成已启动 |
| `generation_stopped` | 生成已停止 |
| `pong` | 心跳响应 |
| `error` | 错误 |

### 1.1 事件帧（2026-09-22 校准 新增）

除控制帧外，服务端还会**以事件名作为 `type`** 推送事件帧：EventBus 事件经 `wsServer.ts:64-65` 直接广播 `type: event.eventType`，帧形如 `{ type: <EventType 值>, data: <payload>, timestamp }`。`wsGateway.ts:41` 在建连时以 `connectClient(Object.values(EventType))` 订阅全部事件，故命中订阅的事件均会成为下行帧。当前流式链路实际推送的三类：

| type（事件名） | payload（data） | 触发源 |
|------|------|------|
| `agent:stream_chunk` | `{ messageId, chunk?, reasoning? }` | LLM 增量输出（`wsHandler.ts:275-285`） |
| `agent:stream_end` | 成功 `{ messageId, tokensUsed? }`；失败/中止 `{ messageId, error? }` | 一轮流式收尾（`wsHandler.ts:349`）；`stop_generation` 主动中止（`:159`） |
| `agent:iteration_complete` | `{ messageId, iteration, totalIterations, outputText, toolCalls, toolResults, tokensConsumed, decision }` | 每次迭代完成（`wsHandler.ts:311-335`） |

**约束**：事件名字符串一律取自 `Src/Services/EventBus/eventTypes.ts`，前端侧由 `Scripts/genEventTypes.ts` 构建期生成 `Client/src/shared/eventTypes.ts`，不得自造帧名（详见 Docs/16 §2 铁律 2）。

---

## 2. RestApi (`Src/Interface/RestApi/`)

> **2026-09-22 校准**：原表按设计意图写就，已与代码不符——`/api/messages`、裸 `/api/loops`、`/api/dashboard`、裸 `/api/tokens` **均不存在**。下表以各文件 `registerRoute()` 的实际注册项为准重写（行号见括号）；路径权威映射另见 Docs/16 附录 A。

| 路由文件 | 端点 | 说明 |
|---------|------|------|
| `taskApi.ts` | `POST /api/tasks`、`GET /api/tasks?status=`、`GET /api/tasks/:taskId`、`DELETE /api/tasks/:taskId` | 提交（异步转调 `orchestrator.receiveTask`，:46）/ 列表 / 详情 / 取消（:98-119） |
| `agentApi.ts` | `GET /api/agents?status=`、`GET /api/agents/:agentId` | Agent 列表 / 详情（:31,36） |
| `tokenApi.ts` | `GET /api/tokens/overview`、`GET /api/tokens/wallets`、`GET /api/tokens/wallets/:agentId`、`GET /api/tokens/transactions?walletId=` | Token 总览 / 钱包列表 / 单钱包 / 交易流水（:55-69）；**无裸 `/api/tokens`** |
| `approvalApi.ts` | `GET /api/approvals`、`GET /api/approvals/:approvalId`、`POST /api/approvals/:approvalId/decide` | 审批队列 / 详情 / 决策（:29-42，body `{ decidedBy, approve, reason? }`，默认拒绝语义不变） |
| `loopApi.ts` | `GET /api/loops/events`、`GET /api/loops/dashboard`、`GET /api/loops/arbitration`、`GET /api/loops/arbitration/:caseId` | 事件日志 / 大屏概览 / 仲裁案件列表 / 详情（:73-89）；**无裸 `/api/loops` 与 `/api/dashboard`** |
| `chatApi.ts` | `GET /api/sessions`、`POST /api/sessions`、`GET /api/sessions/:sessionId/messages`、`POST /api/sessions/:sessionId/messages`、`PATCH /api/sessions/:sessionId`、`GET /api/models` | 会话 CRUD + 消息读写（:102-124）；`PATCH` 改会话标题，供首条消息自动命名回写（:144）；`GET /api/models` 转 `modelRouter.getRegisteredModels()`（:158）；**不存在 `/api/messages`** |
| `configApi.ts` | `GET /api/configs`、`GET /api/configs/:name` | `Configs/` 目录 JSON 配置只读列表 / 详情（:45,49）（2026-09-22 补漏） |

**接线方式**：以上路由统一由 `registerAllRoutes()`（`WebServer/routes.ts:19`）注册，由 `WebServer/httpServer.ts:52,89` 的 Node 原生 `http.createServer` 监听 `server.httpPort`(3000)（`main.ts:260` 启动）；旧 `webServer.ts` 的内存请求模拟仅保留给单测，不再对外服务。

---

## 3. InputDeduplication (`Src/Interface/InputDeduplication/`)

> **2026-09-22 校准**：原列 `dedupMiddleware(req, res, next)` 在代码中不存在——本模块不是 Express 式中间件，而是一组纯函数 + 聚合入口，按实际导出名重写如下。

| 函数 | 签名 | 说明 |
|------|------|------|
| `dedupCheck` | `(params: { source, intent, target, agentId, idempotencyId? }) → Result<{ dedupKey }>` | 五道防护聚合入口，依序：熔断 → 去重键 → 冷却 → 幂等 → 并发槽（:183-216） |
| `initDedupMiddleware` / `resetDedupMiddleware` | `(cfg: Partial<DedupConfig>) → void` / `() → void` | 初始化 / 复位（:52,238） |
| `computeDedupKey` | `(source, intent, target) → string` | 去重键 |
| `checkDedup` / `checkCooldown` / `checkIdempotency` / `storeIdempotency` | 见 :69 / :88 / :103 / :122 | 单道防护，可独立调用 |
| `acquireConcurrencySlot` / `releaseConcurrencySlot` | `(userId) → Result<void>` / `(userId) → void` | 并发槽（:128,143） |
| `checkCircuitBreaker` / `getDedupStats` | `() → { open, reason? }` / `() → 统计对象` | 熔断状态 / 计数（:151,220） |
