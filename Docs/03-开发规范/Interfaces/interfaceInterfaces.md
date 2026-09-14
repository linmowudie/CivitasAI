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
| `generate_reply` | `{ sessionId, userMessage, messageId }` | 流式生成（经主循环执行器） |
| `stop_generation` | `{ messageId }` | 停止生成 |
| `ping` | — | 心跳 |

### 服务端消息类型

| type | 说明 |
|------|------|
| `subscribed` / `unsubscribed` | 订阅确认 |
| `dashboard` | 大屏数据 |
| `approvals` | 审批队列 |
| `generation_started` | 生成已启动 |
| `generation_stopped` | 生成已停止 |
| `pong` | 心跳响应 |
| `error` | 错误 |

---

## 2. RestApi (`Src/Interface/RestApi/`)

| 路由文件 | 端点 | 说明 |
|---------|------|------|
| `taskApi.ts` | `GET /api/tasks` | 任务列表 |
| `agentApi.ts` | `GET /api/agents` | Agent 列表 |
| `tokenApi.ts` | `GET /api/tokens` | Token 统计 |
| `approvalApi.ts` | `GET /api/approvals` | 审批队列 |
| `loopApi.ts` | `GET /api/loops` / `GET /api/dashboard` | 循环状态 / 大屏 |
| `chatApi.ts` | `GET /api/messages` / `POST /api/messages` | 消息 CRUD |

---

## 3. InputDeduplication (`Src/Interface/InputDeduplication/`)

| 函数 | 签名 | 说明 |
|------|------|------|
| `dedupMiddleware` | `(req, res, next) → void` | 五道防护去重中间件 |
