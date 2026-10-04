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
| 用户交互 | 用户 ↔ Interface | Electron IPC 桥接 + REST | 双向 |

> **2026-09-22 校准**：上表第 4 行原写 `WriteGuard ↔ Arbitration ↔ Agent`，**检测发起方不成立**——
> `CONFLICT_DETECTED` 的唯一发布点是 `Src/Core/Decision/orchestrator/conflictPrecheck.ts` 中 `precheckConflicts()`
> 内的 publish（合并阶段由 `orchestrator/mergePhase.ts` 调用，检测维度为"多 Agent 修改同一文件"），
> `Services/SharedMemory/writeGuard.ts` 现态只做**红线 key / 乐观锁版本 / assertion** 三项拦截，
> 语义向量冲突检测为 ⚠️ 未实现目标态。同口径见 `Docs/Agent/07 §3.2、§4.3、§5`（2026-09-22 校准）。
>
> **2026-10-03 校准**：本注原引 `conflictPrecheck.ts:55`、`mergePhase.ts:62`、`writeGuard.ts:54`、`loopApi.ts:10-11`
> 等行号已随代码迭代漂移，一律改为**文件名 + 函数/符号名**定位；经复核，本注全部结论**仍然成立**
> （`conflictPrecheck.ts` 仍是 `Src/` 内 `CONFLICT_DETECTED` 唯一发布点，且仍无订阅方）。

---

## 2. 消息信封格式

> **⚠️ 目标态信封（2026-10-03 校准）**：下文 `AgentMessage` 为**设计目标**，非运行现态。类型本身已在
> `Src/Services/EventBus/eventTypes.ts`（`AgentMessage` / `MessageType` 21 值 / `MessagePriority`）原样声明，且**字段层与本文逐字一致**
> （13 字段、4 个 priority 值、`timestamp` 为 epoch 毫秒），但全仓（`Src/`、`Client/`）**无任何运行期构造、发送或消费点**（仅 `Services/EventBus/index.ts` re-export）。
> Agent 间现态通信是 `DomainEvent`（`Services/EventBus/eventBus.ts` 的 `publish`/`subscribe`），UI 侧现态是 IPC `{type,data,timestamp}` 帧
> （`Src/Interface/IpcBridge/ipcBridge.ts` 的 `IpcMessage`，见 §5.1）。现态事件协议见 `Docs/Agent/07 §4.2`。本节按目标态保留。

Agent 间通信消息在目标态下统一使用以下信封格式：

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
  timestamp: number;                   // epoch 毫秒（全局时间戳统一类型，见 Docs/Agent/09 §1.1）
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

> **⚠️ 未实现 / 目标态（2026-10-03 校准）**：下图 `TASK_ASSIGN → TASK_START → TASK_PROGRESS → TASK_COMPLETE → ACK`
> 消息流在运行期**不存在**——`MessageType` 各值在 `Src/` 零引用。同语义的 EventBus 事件仅**部分接线**：
> `task:received` / `task:assigned` 已有发布点（`Core/Decision/orchestrator/orchestrator.ts` 的 `receiveTask`、`Core/AgentRuntime/agentRuntime.ts`）；
> `task:started` / `task:progress` / `task:failed` **只有订阅方**（`orchestrator/progressTracker.ts`）**无发布方**；
> `task:completed` 亦无发布逻辑。当前任务执行的实际链路是 IPC `generate_reply` 命令 → `ipcBridge.ts` `startStreamGeneration()` →
> `Core/Loop/runIteration.ts` `executeLoop()` 单链路驱动，而非本协议消息序列。

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

> **⚠️ 目标态（2026-09-22 校准；2026-10-03 校准刷新行级引注→"文件名+符号名"，结论复核仍成立）**：下图第二泳道原标 `WriteGuard`，实际不成立——`CONFLICT_DETECTED`
> 由 `Src/Core/Decision/orchestrator/conflictPrecheck.ts` 的 `precheckConflicts()` 发布（`orchestrator/mergePhase.ts` 合并前调用），
> 此处记作 `WriteGuard*`；`Services/SharedMemory/writeGuard.ts` 现态由 `interceptWrite()` 只发布 `MEMORY_VERSION_CONFLICT`。
> 另：`Src/` 中**无 `CONFLICT_DETECTED` 订阅方**，`Services/Arbitration/*` 除 REST 只读查询（`Interface/RestApi/loopApi.ts` 仅 import
> `getAllCases/getCase/getPoolStats`）外也无执行入口调用，故"立案 → 律师函 → 裁决 → 恢复"整条闭环**尚未接线**；同口径见 `Docs/Agent/07 §5`、`Docs/Agent/05 Step 1`。

```
Agent-A      WriteGuard*    Arbitration     Agent-B     Restorer
   │              │               │              │            │
   │── write ──→  │               │              │            │
   │              │── CONFLICT ─→ │              │            │   ← ⚠️ 实际发起方：conflictPrecheck.ts
   │              │   DETECTED    │              │            │      precheckConflicts()（按"同文件多 Agent 修改"，非语义向量）
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

> **⚠️ 未实现 / 目标态（2026-10-03 校准）**：`SETTLE` / `PROFIT` **不在** `MessageType` 21 值集合内（`eventTypes.ts` 类型声明即缺这两类消息）；
> 全部 `token:*` 事件成员（`TOKEN_CONSUMED/EARNED/DISTRIBUTED/TAX_PAID/TAX_RATE_UPDATED/TOKEN_CONFISCATED/INSUFFICIENT_BALANCE/LEDGER_MISMATCH`，
> 见 `eventTypes.ts` `EventType`）在 `Src/` **无任何 `publish` 调用点**。现存唯一有发布方的 Token 相关事件是钱包冻结链
> （`Services/Audit/freezeManager.ts` 发布 `WALLET_FROZEN`/`WALLET_UNFROZEN`）；`token:` 前缀另仅出现在落库白名单（`Interface/EventStore/aiEventStore.ts`）。
> 分润结算目前只在 `Services/TokenEconomy/tokenLedger.ts`/`profitDistributor.ts` 的内部记账与 **REST 只读聚合**（`/api/tokens/*`）中体现，**无事件驱动**。

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

> **⚠️ 未实现 / 目标态（2026-10-03 校准）**：`'ACK'` 字面量与 `AckMessage` 接口在 `Src/` **均无实现体**；
> `requiresAck` 字段仅出现在 `AgentMessage` 接口声明（`eventTypes.ts`），**无任何读取方**。
> 唯一近似物是 `Src/Services/Regulation/broadcastChannel.ts` 的 `requiresAck/ackDeadline/acks/getUnacknowledged` 机制
> （`regulatoryAuthority.ts` 传参使用）——那是**监管广播通道自用确认，不等价于本节 AgentMessage ACK 协议**。

### 4.2 超时与重试

> **⚠️ 未实现 / 目标态（2026-10-03 校准）**：`Src/` 内**无任何**消息级超时/重试/失败处理实现。下表数值仅以配置形式存在于
> `Configs/supervision.json` 的 `supervision.broadcastAckTimeoutSec`（现值 300 秒），且其全仓唯一读取方是前端配置 schema
> `Client/src/config/configSchema.ts`，**`Src/` 内 0 消费者**。

| 消息类型 | 超时时间 | 最大重试 | 失败处理 |
|---------|---------|---------|---------|
| TASK_ASSIGN | 30s | 2 | 重新招募 Worker |
| SUSPEND_NOTICE | 5s | 3（高优先级） | 强制冻结 |
| VERDICT_NOTICE | 10s | 2 | 上报 Regulation |
| TASK_PROGRESS | 不要求 ACK | - | - |
| BROADCAST | 不要求 ACK | - | - |

> **⚠️ 幂等边界（2026-10-03 校准，现状记录 + 待办，需人工裁定）**：§2/§4 的 `messageId`/`eventId`/`requiresAck` 暗示消息有唯一 ID 与幂等保障，
> 但现态 `Src/Services/EventBus/eventBus.ts` 的 `publish()` **仅按 `eventId` 去重**（`processedEventIds` 集合），而 `createEvent()` 每次**无条件生成全新**
> `evt-<Date.now()>-<自增计数>` 的 `eventId` ⇒ **同一语义事件的重复 publish 永远不会被去重**（去重只防"同一事件实例重投"，不防"逻辑重复"）；
> 测试清理函数 `resetEventBus()` 会清空该去重集合。**待办**：裁定去重定位——在 EventType+业务键（messageId/toolCallId）层加语义去重，
> 或在协议层明确"eventId 仅防重投"并把重复治理下放消费端（现有消费端做法：`Interface/RestApi/syncApi.ts` `deriveStatsEvents()` 以 `tool_call_id` 配对避免双计）。

---

## 5. 用户交互协议

### 5.1 消息格式（原 WebSocket 帧协议，2026-09-28 起改为 Electron IPC 桥接）

> **⚠️ 现状变更（2026-09-28；2026-10-03 校准重写）**：本节描述的 WebSocket 帧协议已随 `Src/Interface/WebSocket/`（wsGateway/wsServer/wsHandler）删除而退役，现态传输层为 **Electron IPC 桥接**（`Src/Interface/IpcBridge/ipcBridge.ts`：`backend-event` 事件广播 + `backend-command` 命令收发 + `ipc-*` invoke 通道，经 `electron/preload.ts` 的 `contextBridge.exposeInMainWorld('electronAPI', …)` 暴露）。
>
> **帧字段为非对称约定（2026-10-03 校准，修正原"消息载荷结构（type/payload）沿用原约定"的错误声明）**：
> - **服务端 → 客户端**：广播帧与 RPC 应答帧均为 `{ type, data, timestamp }`——`ipcBridge.ts` 的 `IpcMessage` 与 `startIpcBridge()` 广播帧（`type` 取 `EventType` 成员值、`data` 取 `DomainEvent.payload`）；客户端镜像类型同口径（`Client/src/services/eventBusBridge.ts` 的 `BridgeMessage`）。**字段是 `data` 而非 `payload`**，前端需按 `msg.data` 解包；
> - **客户端 → 服务端**：命令帧读 `{ type, payload }`（`ipcBridge.ts` `handleCommand()`，兼容 `message.payload ?? message` 的无信封写法）。
>
> **⚠️ 浏览器形态（2026-10-03 校准，现状记录 + 待办，需人工裁定）**：IPC 桥并非唯一形态的替代推送——`Interface/WebServer/httpServer.ts` 无 `upgrade`/WS 处理，`/api/*` 之后**没有任何推送通道**；`eventBusBridge.ts` 在非 Electron 环境 `send()` 直接告警并丢弃命令，`startFallbackPolling()`（3s 间隔）只重试探测 Electron API 就绪、**从不轮询事件**。待办：裁定浏览器降级是否为受支持形态——若是，本节须补"浏览器模式 = 只读 REST、无事件流"；若否，显式声明 Electron-only。
>
> **⚠️ ws 退役残留（2026-10-03 校准，现状记录 + 待办，需人工裁定）**：退役结论成立，但依赖未清理——`Configs/default.json` 的 `server.wsPort: 3001` 仍被 `Src/Infra/Config/configValidator.ts` 强制校验（缺失即报"必须为整数"）；`package.json` 仍保留 `ws` 依赖；`Scripts/wsDiagnose.cjs` 与 `Scripts/dupCheck.cjs` 仍连接 `ws://localhost:3001`（必然失败）。待办：裁定删 `wsPort` 校验与 `wsDiagnose.cjs`，或把 `dupCheck.cjs` 改造为 IPC 版（重复发布核查仍需该工具）。
>
> **⚠️ 生命周期约束（2026-10-03 校准，现状记录 + 待办，需人工裁定）**：`startIpcBridge()` **非幂等**——无"已启动"守卫，重复调用会二次 `subscribeMany`（⇒ 每事件双发广播）并重复 `ipcMain.handle('ipc-*')`（Electron 对同 channel 重复注册抛错）；现仅在 `Src/main.ts` 启动时调用一次。`stopIpcBridge()` 已具备 `unsubscribe` + `removeHandler`/`removeAllListeners` 清理。待办：裁定是否补 `if (eventSubscription) return;` 守卫，并在本节固化"单实例启动、退出时 unsubscribe"约束。
>
> 下方类型与「命名空间修订」作为协议语义的历史与现状参考保留。

```typescript
// 客户端 → 服务端（命令帧，2026-10-03 校准为 ipcBridge.ts `handleCommand()` 现态，共 7 值）
interface ClientMessage {
  type: 'subscribe' | 'unsubscribe'             // 显式 no-op：应答说明"IPC 模式下订阅由事件总线统一管理"，
                                                // 全量订阅由主进程 startIpcBridge() 的 subscribeMany(Object.values(EventType)) 承担
       | 'get_dashboard' | 'get_approvals'      // 只读查询（大屏 / 待审批队列）
       | 'generate_reply' | 'stop_generation'   // 写操作：启动整轮 Loop 生成 / 中断流式（IPC 专有，REST 无对应端点）
       | 'ping';                                // 探活 → 应答 pong
  payload?: Record<string, any>;                // 兼容无信封写法（message.payload ?? message）
}

// 服务端 → 客户端（2026-10-03 校准：载荷字段是 data，不是 payload）
interface ServerMessage {
  // ① 事件广播帧：type 直接取 EventType 成员值（如 'agent:stream_chunk'），data = DomainEvent.payload
  // ② RPC 应答帧：type ∈ subscribed / unsubscribed / dashboard / approvals /
  //    generation_started / generation_stopped / pong / error
  type: string;
  data: unknown;
  timestamp: number;                   // epoch 毫秒
}
```

> **历史目标态（未实现，2026-10-03 校准保留备查）**：原设计的上行五值 `submit_task`/`cancel_task`/`query_status`/`query_agent`/`query_token`
> 与下行聚合帧 `task_update`/`agent_update`/`stream_chunk`/`response`（含 `requestId` 关联）从未实现，也暂无实现计划——
> 写操作走 REST 或 IPC 专有的 `generate_reply`/`stop_generation`，聚合帧已裁决作废改用具体事件名（见下方修订注）。

> **⚠️ 命名空间修订（2026-09-14；2026-10-03 全面复核校准，引注整体替换——原文 `wsServer.ts`/`wsHandler.ts`/`chatApi.ts` 行级引注随 WebSocket 实现删除已全部失效，历史 WS 实现仅作脚注）**
>
> 本节与 `Docs/Agent/07 §4.3` 的 EventBus 事件名属**两个层级**，旧写法存在冲突，现裁决如下：
>
> 1. **事件帧的 `type` 直接取 `EventType` 成员值**（实现为 `ipcBridge.ts` `startIpcBridge()` 广播帧 `type: event.eventType`），不另造帧名；
>    因此旧写法 `stream_chunk` → **`agent:stream_chunk`**。发布点现态引注（2026-10-03 校准）：
>    `ipcBridge.ts` `startStreamGeneration()` 的 `onStreamChunk` → `agent:stream_chunk`、`onIterationComplete` → `agent:iteration_complete`、
>    `onToolCallStart`/`onToolCallPending`/`onToolCallResult` → `agent:tool_call_started/pending/result`、`stop_generation` 分支与各异常/正常出口 → `agent:stream_end`、
>    `tryAutoNameSession()` → `chat:session_renamed`；`agent:chat_message` 由 `RestApi/chatApi.ts` 的 `addMessage()` 发布。
>    **合批状态（2026-10-03 校准，更新原"仍未实现"表述）**：原注"按 `ui.streamFlushIntervalMs` 合批仍未实现、逐 chunk 直接 publish"已部分过期——
>    **前端**已实现 100ms 定窗合批（`Client/src/stores/chatStore.ts` `FLUSH_INTERVAL_MS = 100` + `setInterval(flushBuffer…)`，注释直指 `streamFlushIntervalMs`）；
>    **后端**仍逐 chunk 直接 publish（`ipcBridge.ts` `onStreamChunk`），`ui.streamFlushIntervalMs` 配置项在 `Src/` 内**无消费者**。详见 `Docs/Agent/07 §4.3`。
>    `task_update` / `agent_update` 属聚合语义帧，**裁决作废**，一律改用具体事件名（如 `task:progress`、`agent:ready`），见 `Docs/Client/02` F0.5b。
>    **EventType 单一真源漂移（2026-10-03 校准，现状记录 + 待办，需人工裁定）**：后端 `Src/Services/EventBus/eventTypes.ts` 的 `EventType` 为唯一真源，
>    前端镜像 `Client/src/shared/eventTypes.ts` 由 `Scripts/genEventTypes.ts`（`npm run gen:event-types`）生成——现镜像**滞后缺 `AGENT_TODO_UPDATED`（`agent:todo_updated`）**，
>    `Client/src/stores/todoStore.ts` 以硬编码字符串 `const TODO_EVENT_TYPE = 'agent:todo_updated'` 绕过类型系统。**待办**：①重跑 codegen 补齐枚举并让 todoStore 改用镜像枚举；
>    ②裁定是否在本文档固化为强制约定"前端镜像仅由生成链产出，禁止手改/硬编码"并加 CI 校验。
>    **stream_end 双发（2026-10-03 校准，现状记录 + 待办，需人工裁定）**：停止生成时，`ipcBridge.ts` `stop_generation` 分支对同一 `messageId`
>    自发布会带 `reason:'user_stopped'` 的 `agent:stream_end`，随后 `startStreamGeneration()` 在 `executeLoop()` 正常返回后的 ok 分支**仍无条件再发**
>    `agent:stream_end`（仅 catch 分支有 `!abortController.signal.aborted` 守卫）⇒ 前端收到两次 end，需二次收敛。**待办**：裁定修法（ok 分支补 aborted 守卫，
>    或 stop_generation 只 abort 不 publish），随后在 §5.1 固化"stream_end 每 messageId 至多一次"不变式。
>    **全量广播与上游重复（2026-10-03 校准，现状记录 + 待办，需人工裁定）**：`startIpcBridge()` 按 `Object.values(EventType)` **全量无窗过滤**转发到所有渲染进程 ⇒
>    上游重复发布直达 UI。已知实例：`arbitration:knowledge_consolidation` 存在**两个发布点**（`Services/Arbitration/tribunal.ts` 与
>    `Services/SharedMemory/memoryConsolidator.ts`），而 `Docs/Agent/14 §8 #24` 裁定"仅由 Loop 成功退出点发布"至今未落地。**待办**：先裁定唯一发布点（建议 memoryConsolidator 不发、由 Loop 退出统一发），再回写本节。
> 2. `response` / `error` 保留为 **RPC 应答帧**（与 EventBus 无关；现态实现为 `ipcBridge.ts` `handleCommand()` 内 `event.reply('backend-event', …)` 应答帧与 `invoke` 返回值）。
> 3. **客户端 → 服务端五值（`submit_task` 等）均未实现**（⚠️ 目标态）；代码现态为 7 值命令集 `subscribe` / `unsubscribe` / `get_dashboard` / `get_approvals` /
>    `generate_reply` / `stop_generation` / `ping`（`ipcBridge.ts` `handleCommand()`）。**2026-10-03 校准两处**：
>    ①原注"`subscribe` 应支持多事件订阅（现仅订阅 `subscriptions[0]`，属 bug）"随 WS 实现一起**失效作废**——IPC 模式下 `subscribe`/`unsubscribe` 是**显式 no-op**，
>    全量广播由主进程 `startIpcBridge()` 一次性 `subscribeMany(Object.values(EventType))` 统一转发，事件过滤在前端 handler 侧完成（如 `chatStore` 按 `messageId`/`type` 自行分发）；
>    ②原裁决"写操作一律走 REST，WS/IPC 仅承担订阅与查询"需修正——`generate_reply`（触发整轮 Loop）与 `stop_generation`（中断流式）是 **IPC 专有写操作，REST 无对应端点**。
>    本表客户端帧集合仍按 `Docs/Client/02` **F0.5b** 口径维护。
> 4. §5.2 的 `GET /api/tasks/:id/stream`（SSE 备选）与 Docs/Client/01 的 WS 方案属**双通道冗余**，裁决为仅保留**单一推送通道**，SSE 行作废（不删除，标废以免遗漏）；
>    2026-10-03 校准：原裁决"仅保留 WS"的表述已过时——现唯一推送通道是 Electron IPC（`backend-event`），且 `/stream` 路由在全仓 `registerRoute` 注册表中确实不存在。

**IPC invoke 通道清单（2026-10-03 校准补记）**：用户交互的实际主用面不止 `backend-event`/`backend-command` 双通道——
`ipcBridge.ts` `registerIpcHandlers()` 还注册了 **25 条 `ipc-*` 请求-响应通道**（`electron/preload.ts` 以 `electronAPI` 分组包装暴露，`Client/src/services/ipcApi.ts` 统一封装调用），
与 §5.2 REST 构成**双入口**（Electron 形态走 IPC 直调主进程，浏览器形态走 REST）：

| 分组 | 通道 | 说明 |
|------|------|------|
| 供应商/路由/模型 | `ipc-get-providers`、`ipc-add-provider`、`ipc-remove-provider`、`ipc-fetch-models`、`ipc-get-routing`、`ipc-update-routing`、`ipc-get-models` | 供应商增删（就地持久化到加密存储，`restoreProvidersFromSecrets()` 启动恢复）与模型路由读写 |
| 会话/消息/待办 | `ipc-list-sessions`、`ipc-create-session`、`ipc-update-session`、`ipc-archive-session`、`ipc-list-messages`、`ipc-add-message`、`ipc-get-todos`、`ipc-clear-todos` | 与 §5.2 `chatApi` 会话/消息/todos 端点同名能力双入口 |
| 配置 | `ipc-get-config` | 只读；REST 侧同样只读（见 §5.2 config 行） |
| 记忆/技能/工具/统计 | `ipc-get-memory-entries`、`ipc-get-long-term-memory`、`ipc-bulk-long-term-memory`、`ipc-get-stats-events`、`ipc-get-skills`、`ipc-get-custom-tools` | 记忆读写/批量导入、技能目录、统计事件派生（`deriveStatsEvents()`） |
| 设备/密钥 | `ipc-get-device-fingerprint`、`ipc-save-secrets`、`ipc-load-secrets` | 供应商密钥加密存储——**配置/密钥写操作仅存在于 IPC，REST 无对应**（`ipc-save-secrets` 带"拒绝不完整凭据"守卫） |

### 5.2 REST API 端点

> **⚠️ 路径已与设计偏离（2026-09-14 核查）**：`Interface/RestApi/*` 实际注册的路径与本表不一致（如 `/api/loops/dashboard` 而非 `/api/dashboard/overview`）。
> **裁决：前端一律以代码实际路径为准**，权威映射表见 `Docs/Client/02-前端改造基础/前端改造方案与构建顺序.md` 附录 A；本表保留作为目标态设计，已逐行标注实现状态。

| 方法 | 路径 | 说明 | 实现状态 |
|------|------|------|---------|
| POST | `/api/tasks` | 提交新任务 | ✅ 已实现（2026-10-03 校准：原"已注册但不触发执行"已过期——`taskApi.ts` `submitTask()` 经 `queueMicrotask → receiveTask()` **异步触发编排**，不等执行结果，状态由内存 `tasks` Map 回写） |
| GET | `/api/tasks` | 任务列表（`?status=`） | ✅ 已实现（本表未列） |
| GET | `/api/tasks/:id` | 查询任务状态 | ✅ 已实现 |
| GET | `/api/tasks/:id/stream` | ⚠️ **已作废**（裁决仅保留单一推送通道，现态为 Electron IPC，见 §5.1 修订注 4；2026-10-03 校准措辞） | ❌ 不实现 |
| DELETE | `/api/tasks/:id` | 取消任务 | ✅ 路由已注册（2026-10-03 校准：原"❌ 未实现"已过期——`taskApi.ts` `cancelTask()`；终态任务不可取消，`?status=` 过滤亦已实现）。**⚠️ 现状记录 + 待办（需人工裁定）**：`cancelTask` 仅翻转内存 `tasks` Map 状态，**不触碰** `startStreamGeneration` 的 `AbortController`，也不被 `executeLoop` 读取——真正的执行中断目前只在 IPC `stop_generation`；`cancelTask` 在 `Src/` 内除本路由外 0 调用者。待办：裁定"REST 取消"语义——明确为**排队态/记账态取消**，或补 Loop abort 接线（另见 §5.1 修订注 3"写操作一律走 REST"已被 IPC 专有写操作修正） |
| GET | `/api/agents` | 查询所有 Agent 状态 | ✅ 已实现 |
| GET | `/api/agents/:id` | 查询单个 Agent 详情 | ✅ 已实现 |
| GET | `/api/tokens/overview` | 系统池/税收/销毁/税率总览 | ✅ 已实现（本表未列） |
| GET | `/api/tokens/wallets` | 查询所有钱包 | ✅ 已实现 |
| GET | `/api/tokens/wallets/:agentId` | 查询指定 Agent 钱包 | ✅ 已实现 |
| GET | `/api/tokens/transactions` | 查询交易记录 | ✅ 已实现 |
| GET | `/api/approvals`、`/api/approvals/:id` | 待审批队列 / 详情 | ✅ 已实现（2026-10-03 校准：原"缺决策端点"已过期——`approvalApi.ts` 注册 `GET /api/approvals`、`GET /api/approvals/:approvalId` 与 **`POST /api/approvals/:approvalId/decide`** 三条路由，F0.4 决策端点补齐） |
| GET | `/api/loops/events`、`/api/loops/dashboard`、`/api/loops/arbitration[/:caseId]` | 事件日志 / 大屏概览 / 仲裁案件 | ✅ 已实现（对应本表下三行的旧路径） |
| GET | `/api/sessions[/:id/messages]` | 会话与消息历史 | ✅ 已实现且**远超原设计**（2026-10-03 校准：原"❌ 未实现→F0.7 新增"已过期。**以代码为准**重建本段——`chatApi.ts` 注册：`GET /api/sessions`、`POST /api/sessions`、`POST /api/sessions/:sessionId/archive`、`GET`/`POST /api/sessions/:sessionId/messages`、`POST /api/sessions/:sessionId/messages/rich`、`PATCH /api/sessions/:sessionId`（改名/工作目录）、`PATCH /api/messages/:messageId`、`GET /api/sessions/:sessionId/ai-events`、`GET`/`DELETE /api/sessions/:sessionId/todos`、`GET /api/todos`、`GET /api/models`；同名能力另有 **IPC 双入口**，见 §5.1 invoke 通道清单） |
| GET | `/api/arbitration/cases[/:id]` | 仲裁案件（旧路径） | 🔁 实为 `/api/loops/arbitration` |
| GET | `/api/audit/reports` | 查询稽查报告 | ❌ 未实现（F5 告警/审计视图所需，非阻塞） |
| GET | `/api/dashboard/overview`、`/api/dashboard/token-flow` | 大屏 / Token 流向 | 🔁 前者实为 `/api/loops/dashboard`；**token-flow 未实现**（F4 桑基图需 `transactions` 聚合，或 F0 新增） |
| GET | `/api/configs`、`/api/configs/:name` | 查询（脱敏）系统配置 | 🔁 **路径与设计不同**（2026-10-03 校准）：原行 `GET/PUT /api/system/config` **全仓无注册**；实际只读端点为 `configApi.ts` 的 `GET /api/configs`、`GET /api/configs/:name`。写侧：REST **无 PUT**（"F5 只做只读、写操作暂缓"就 REST 而言仍成立）；配置/密钥写操作目前经 IPC 通道（如 `ipc-save-secrets`、`ipc-update-routing`，见 §5.1），非 REST |

> **表格覆盖度（2026-10-03 校准补记）**：本表**不是**端点全集。全仓现经 `registerRoute()`（`RestApi/router.ts`）注册约 **46 条路由**，
> 由 `Interface/WebServer/routes.ts` 的 `registerAllRoutes()` 统一挂载 **12 个 registrar**（task/agent/token/approval/loop/chat/config/memory/sync/tools/skills/placeholder）——**权威索引以 `registerAllRoutes()` 与各 `register*Routes()` 为准**。本表未列的端点组：
> `toolsApi.ts`（`GET /api/tools`、`GET /api/tools/custom`）；`skillsApi.ts`（`GET /api/skills[/:id]`）；
> `memoryApi.ts`（`GET /api/memory/long-term`、`POST /api/memory/long-term/bulk`、`GET`/`PUT /api/account/active-user`、`GET /api/memory/entries[/:key]`）；
> `syncApi.ts`（`GET /api/sync/stats-events`）；`placeholderApi.ts`（`GET /api/data-hub`、`/api/mcp/connections`、`/api/user/profile`，占位空实现）；
> 以及上条 sessions 行列出的会话/消息扩展端点。
>
> **限流与错误约定（2026-10-03 校准补记）**：所有 `/api/*` 请求在进入 handler 前经统一 `applyApiRateLimit`
> （`WebServer/httpServer.ts` → `WebServer/apiRateLimiter.ts`，按 IP 滑动窗口；配置事实源 `Configs/supervision.json` 的 `supervision.apiRateLimit`，运行时 `initApiRateLimiter()` 注入）；
> 超限返回 **429 + `Retry-After` 头**，响应体 `{ ok: false, error: 'rate_limited', retryAfter }`。
> CORS 按 `server.corsOrigins` 配置放行；生产模式下静态托管前端构建产物 `Client/dist`（同域访问；开发模式由 Vite 代理）。外部调用方需以本节为可用性契约。

---

## 6. 依赖关系

| 依赖组件 | 来源 | 用途 |
|---------|------|------|
| `EventBus` | Services | 消息传递的底层实现（现态唯一通道：`publish`/`subscribe`/`subscribeMany` 直连 handler） |
| `AgentRegistry` | Core | Agent ID 解析与状态查询 |
| `Logger` | Infra | 消息日志记录 |

> **⚠️ 未接线的预留层（2026-10-03 校准）**：`Services/EventBus/eventRouter.ts` 的 `registerRoute`/`startRouter`/`forwardEvent`
> 在 `Src/` 内**零调用者**（仅 `Services/EventBus/index.ts` re-export），属死代码——不存在"事件路由表/分发层"机制，
> 勿按 §3 序列图臆测其存在；与 `Docs/Agent/07` 口径一致（该层为未接线预留，或删除）。
> 同理，§2 `AgentMessage` 信封亦未接入任何分发层（仅类型声明，见 §2 警示）。
