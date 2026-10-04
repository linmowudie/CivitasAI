# Agent 间通信协议设计

> 本文档定义 Civitas-AI 中 Agent 间通信的完整协议，包括消息格式、通信模式、指令定义和交互序列。

---

## 1. 通信模式

| 模式 | 适用场景 | 实现方式 | 方向 |
|------|---------|---------|------|
| 指令下发 | Director → Worker/Partner | 直接函数调用 + 事件 | 单向 |
| 状态上报 | Worker/Partner → Director | 事件总线 | 单向 |
| 广播 | Regulation/Audit → 所有 Agent | 事件总线（Pub/Sub） | 一对多 |
| 仲裁通信 | 冲突检测（Orchestrator/conflictPrecheck）↔ Arbitration ↔ Agent | 事件总线 + 直接调用 | 双向 |
| 用户交互 | 用户 ↔ Interface | WebSocket + REST | 双向 |

> **2026-09-22 校准**：上表第 4 行原写 `WriteGuard ↔ Arbitration ↔ Agent`，**检测发起方不成立**——
> `CONFLICT_DETECTED` 的唯一发布点是 `Src/Core/Decision/orchestrator/conflictPrecheck.ts:55`（合并前由
> `orchestrator/mergePhase.ts:62` 调用，检测维度为"多 Agent 修改同一文件"），
> `Services/SharedMemory/writeGuard.ts` 现态只做**红线 key / 乐观锁版本 / assertion** 三项拦截，
> 语义向量冲突检测为 ⚠️ 未实现目标态。同口径见 `Docs/07 §3.2、§4.3、§5`（2026-09-22 校准）。

---

## 2. 消息信封格式

所有 Agent 间通信消息统一使用以下信封格式：

```typescript
interface AgentMessage {
  // 信封
  messageId: string;                   // UUID
  traceId: string;                     // 全局追踪 ID
  sourceAgentId: string;               // 发送方 Agent ID
  targetAgentId: string;               // 接收方 Agent ID（'*' = 广播）
  parentMessageId?: string;            // 父消息 ID（用于关联请求-响应）
  
  // 消息内容
  type: MessageType;                   // 消息类型
  payload: Record<string, any>;        // 消息数据
  priority: 'low' | 'normal' | 'high' | 'critical';
  
  // 元数据
  timestamp: number;                   // epoch 毫秒（全局时间戳统一类型，见 Docs/10 §1.1）
  ttl?: number;                        // 消息存活时间（ms），超时丢弃
  requiresAck: boolean;                // 是否需要确认
  correlationId?: string;              // 关联 ID（用于匹配请求-响应对）
}

type MessageType =
  // 任务指令
  | 'TASK_ASSIGN'                     // Director → Worker：分配任务
  | 'TASK_START'                      // Worker → Director：开始执行
  | 'TASK_PROGRESS'                   // Worker → Director：进度上报
  | 'TASK_COMPLETE'                   // Worker → Director：任务完成
  | 'TASK_FAILED'                     // Worker → Director：任务失败
  | 'TASK_CANCEL'                     // Director → Worker：取消任务
  
  // 招募管理
  | 'RECRUIT_REQUEST'                 // Director → AgentFactory：招募 Agent
  | 'RECRUIT_ACK'                     // AgentFactory → Director：招募确认
  | 'EXPEL_NOTICE'                    // Director → Worker：开除通知
  
  // 仲裁通信
  | 'CONFLICT_REPORT'                 // Agent → Arbitration：报告冲突
  | 'SUSPEND_NOTICE'                  // Arbitration → Agent：挂起通知（律师函）
  | 'VERDICT_NOTICE'                  // Arbitration → Agent：裁决通知
  | 'RESTORATION_ORDER'               // Arbitration → Restorer：恢复指令
  | 'RESTORATION_CONFIRM'             // Restorer → Arbitration：恢复确认
  
  // 监管通信
  | 'RULE_UPDATE'                     // Regulation → All：规则更新
  | 'BROADCAST'                       // Regulation → All：广播通知
  | 'EMERGENCY_ORDER'                 // Regulation → Agent：紧急指令
  
  // 审计通信
  | 'FREEZE_NOTICE'                   // Audit → Agent：冻结通知
  | 'UNFREEZE_NOTICE'                 // Audit → Agent：解冻通知
  | 'AUDIT_REQUEST'                   // Audit → Agent：稽查请求
  
  // 确认
  | 'ACK';                            // 通用确认
```

---

## 3. 核心交互序列

### 3.1 任务委派序列（Delegation）

```
Director                Worker-A             Worker-B
   │                       │                    │
   │── TASK_ASSIGN ──────→ │                    │
   │   (subtask_1)         │                    │
   │── TASK_ASSIGN ───────────────────────────→ │
   │                       │   (subtask_2)      │
   │                       │                    │
   │←── TASK_START ─────── │                    │
   │←── TASK_START ──────────────────────────── │
   │                       │                    │
   │←── TASK_PROGRESS ──── │ (30%)              │
   │←── TASK_PROGRESS ──── │ (60%)              │
   │←── TASK_PROGRESS ───────────────────────── │ (50%)
   │                       │                    │
   │←── TASK_COMPLETE ──── │                    │
   │   (result_1)          │                    │
   │←── TASK_COMPLETE ───────────────────────── │
   │                       │   (result_2)       │
   │                       │                    │
   │── ACK ──────────────→ │                    │
   │── ACK ───────────────────────────────────→ │
```

### 3.2 仲裁序列（Litigation）

> **⚠️ 目标态（2026-09-22 校准）**：下图第二泳道原标 `WriteGuard`，实际不成立——`CONFLICT_DETECTED`
> 由 `Src/Core/Decision/orchestrator/conflictPrecheck.ts:55`（`orchestrator/mergePhase.ts:62` 合并前调用）发布，
> 此处记作 `WriteGuard*`；`Services/SharedMemory/writeGuard.ts` 现态只发布 `MEMORY_VERSION_CONFLICT`（:54）。
> 另：`Src/` 中**无 `CONFLICT_DETECTED` 订阅方**，`Services/Arbitration/*` 除 REST 只读查询（`Interface/RestApi/loopApi.ts:10-11`）
> 外也无执行入口调用，故"立案 → 律师函 → 裁决 → 恢复"整条闭环**尚未接线**；同口径见 `Docs/07 §5`、`Docs/05 Step 1`。

```
Agent-A      WriteGuard*    Arbitration     Agent-B     Restorer
   │              │               │              │            │
   │── write ──→  │               │              │            │
   │              │── CONFLICT ─→ │              │            │   ← ⚠️ 实际发起方：conflictPrecheck.ts:55
   │              │   DETECTED    │              │            │      （按"同文件多 Agent 修改"，非语义向量）
   │              │               │── SUSPEND ──→│            │
   │              │               │   (律师函)    │            │
   │              │               │── SUSPEND ──→│            │
   │              │               │              │ (冻结状态)  │
   │              │               │              │            │
   │              │               │── [裁决推理] ─│            │
   │              │               │              │            │
   │              │               │── VERDICT ──→│            │
   │              │               │              │            │
   │              │               │── RESTORATION ──────────→ │
   │              │               │   ORDER       │            │
   │              │               │              │     │── [恢复现场]
   │              │               │              │            │
   │              │               │←── RESTORATION ────────── │
   │              │               │    CONFIRM    │            │
   │              │               │              │            │
   │←── UNFREEZE ────────────────────────────────│            │
   │   (继续执行)  │               │              │            │
```

### 3.3 Consortium 协作序列

```
Director          Partner-A        Partner-B       TokenEconomy
   │                  │                │                │
   │── [生成契约] ──→  │                │                │
   │── RECRUIT ─────→  │                │                │
   │── RECRUIT ──────────────────────→  │                │
   │                  │                │                │
   │── [分发子任务] ─→ │                │                │
   │── [分发子任务] ─────────────────→  │                │
   │                  │                │                │
   │←── TASK_PROGRESS │                │                │
   │←── TASK_PROGRESS ──────────────── │                │
   │   ...            │                │                │
   │←── TASK_COMPLETE │                │                │
   │←── TASK_COMPLETE ──────────────── │                │
   │                  │                │                │
   │── SETTLE ────────────────────────────────────────→ │
   │   (分润计算)     │                │                │
   │                  │←── PROFIT ───────────────────── │
   │                  │                │←── PROFIT ───── │
```

---

## 4. 消息确认机制

### 4.1 ACK 协议

```typescript
interface AckMessage {
  type: 'ACK';
  correlationId: string;               // 关联的原消息 ID
  status: 'received' | 'accepted' | 'rejected';
  reason?: string;                     // rejected 时的原因
}
```

**确认规则：**
- `requiresAck = true` 的消息必须收到 ACK
- 超时未收到 ACK → 重发（最多 3 次）
- 3 次仍无 ACK → 记录异常，上报 Director

### 4.2 超时与重试

| 消息类型 | 超时时间 | 最大重试 | 失败处理 |
|---------|---------|---------|---------|
| TASK_ASSIGN | 30s | 2 | 重新招募 Worker |
| SUSPEND_NOTICE | 5s | 3（高优先级） | 强制冻结 |
| VERDICT_NOTICE | 10s | 2 | 上报 Regulation |
| TASK_PROGRESS | 不要求 ACK | - | - |
| BROADCAST | 不要求 ACK | - | - |

---

## 5. 用户交互协议

### 5.1 WebSocket 消息格式

```typescript
// 客户端 → 服务端
interface ClientMessage {
  type: 'submit_task' | 'cancel_task' | 'query_status' | 'query_agent' | 'query_token';
  payload: Record<string, any>;
  requestId: string;                   // 用于匹配响应
}

// 服务端 → 客户端
interface ServerMessage {
  type: 'task_update' | 'agent_update' | 'stream_chunk' | 'error' | 'response';
  payload: Record<string, any>;
  requestId?: string;                  // 关联的请求 ID（response 类型必有）
  timestamp: number;                   // epoch 毫秒
}
```

> **⚠️ 命名空间修订（2026-09-14，依据 `Docs/16` 前端改造核查）**
>
> 本节与 `Docs/07 §4.3` 的 EventBus 事件名属**两个层级**，旧写法存在冲突，现裁决如下：
>
> 1. **事件帧的 `type` 直接取 `EventType` 成员值**（与现有 `wsServer.ts` 实现 `type: event.eventType` 一致），不另造帧名；
>    因此旧写法 `stream_chunk` → **`agent:stream_chunk`**（✅ 2026-09-22 校准：原写"待 F0.6 实现"已过期——
>    `agent:stream_chunk` / `agent:stream_end` / `agent:chat_message` / `agent:iteration_complete` 均已发布，
>    见 `wsHandler.ts:281 / 159…`、`RestApi/chatApi.ts:90`；惟"按 `ui.streamFlushIntervalMs` 合批"**仍未实现**，
>    现态为逐 chunk 直接 publish，详见 `Docs/07 §4.3` 2026-09-22 校准）；
>    `task_update` / `agent_update` 属聚合语义帧，**裁决作废**，一律改用具体事件名（如 `task:progress`、`agent:ready`），见 `Docs/16` F0.5b。
> 2. `response` / `error` 保留为 **RPC 应答帧**（与 EventBus 无关）。
> 3. **客户端 → 服务端五值（`submit_task` 等）均未实现**：代码现态为 `subscribe` / `unsubscribe` / `get_dashboard` / `get_approvals` / `ping`（`wsHandler.ts`）。
>    裁决：写操作（提交/取消任务）**走 REST**，WS 仅承担订阅与查询；本表客户端帧集合按 `Docs/16` **F0.5b** 定稿，且 `subscribe` 应支持多事件订阅（现仅订阅 `subscriptions[0]`，属 bug）。
> 4. §5.2 的 `GET /api/tasks/:id/stream`（SSE 备选）与 Docs/09 的 WS 方案属**双通道冗余**；裁决为仅保留 WS，SSE 行作废（不删除，标废以免遗漏）。

### 5.2 REST API 端点

> **⚠️ 路径已与设计偏离（2026-09-14 核查）**：`Interface/RestApi/*` 实际注册的路径与本表不一致（如 `/api/loops/dashboard` 而非 `/api/dashboard/overview`）。
> **裁决：前端一律以代码实际路径为准**，权威映射表见 `Docs/16-前端改造基础/前端改造方案与构建顺序.md` 附录 A；本表保留作为目标态设计，已逐行标注实现状态。

| 方法 | 路径 | 说明 | 实现状态 |
|------|------|------|---------|
| POST | `/api/tasks` | 提交新任务 | ⚠️ 已注册但**不触发执行**（F0.5 修） |
| GET | `/api/tasks` | 任务列表（`?status=`） | ✅ 已实现（本表未列） |
| GET | `/api/tasks/:id` | 查询任务状态 | ✅ 已实现 |
| GET | `/api/tasks/:id/stream` | ⚠️ **已作废**（裁决仅保留 WS 推送，见 §5.1 修订注 4） | ❌ 不实现 |
| DELETE | `/api/tasks/:id` | 取消任务 | ❌ 未实现→**F0.5 新增**（F2 的 Stop 能力依赖此） |
| GET | `/api/agents` | 查询所有 Agent 状态 | ✅ 已实现 |
| GET | `/api/agents/:id` | 查询单个 Agent 详情 | ✅ 已实现 |
| GET | `/api/tokens/overview` | 系统池/税收/销毁/税率总览 | ✅ 已实现（本表未列） |
| GET | `/api/tokens/wallets` | 查询所有钱包 | ✅ 已实现 |
| GET | `/api/tokens/wallets/:agentId` | 查询指定 Agent 钱包 | ✅ 已实现 |
| GET | `/api/tokens/transactions` | 查询交易记录 | ✅ 已实现 |
| GET | `/api/approvals`、`/api/approvals/:id` | 待审批队列 / 详情 | ✅ 已实现；**缺决策端点**（F0.4 补 `POST /api/approvals/:id/decide`） |
| GET | `/api/loops/events`、`/api/loops/dashboard`、`/api/loops/arbitration[/:caseId]` | 事件日志 / 大屏概览 / 仲裁案件 | ✅ 已实现（对应本表下三行的旧路径） |
| GET | `/api/sessions[/:id/messages]` | 会话与消息历史 | ❌ 未实现→**F0.7 新增** |
| GET | `/api/arbitration/cases[/:id]` | 仲裁案件（旧路径） | 🔁 实为 `/api/loops/arbitration` |
| GET | `/api/audit/reports` | 查询稽查报告 | ❌ 未实现（F5 告警/审计视图所需，非阻塞） |
| GET | `/api/dashboard/overview`、`/api/dashboard/token-flow` | 大屏 / Token 流向 | 🔁 前者实为 `/api/loops/dashboard`；**token-flow 未实现**（F4 桑基图需 `transactions` 聚合，或 F0 新增） |
| GET / PUT | `/api/system/config` | 查询（脱敏）/ 更新系统配置 | ❌ 未实现（F5 只做只读，写操作暂缓） |

---

## 6. 依赖关系

| 依赖组件 | 来源 | 用途 |
|---------|------|------|
| `EventBus` | Services | 消息传递的底层实现 |
| `AgentRegistry` | Core | Agent ID 解析与状态查询 |
| `Logger` | Infra | 消息日志记录 |
