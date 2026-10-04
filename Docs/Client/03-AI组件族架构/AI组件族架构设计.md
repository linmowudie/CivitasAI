# Civitas-AI 设计文档：AI 组件族架构（AI Component Families）

> **设计基准**：不是传统前端组件库思维，而是以 **Agent 语义驱动**的组件组织范式——将前端 UI 元素按 Agent 运行时概念（Loop/Harness/Memory/MultiAgent）分组，形成可独立演进、按需加载、后端事件驱动的"AI 组件族"。
>
> **审查对象**：`Client/src/components/` 现有组件组织方式 + `Client/src/views/ChatView.tsx` 渲染逻辑
>
> **设计日期**：2026-09-28 · **版本**：v1.0-draft
>
> **关联文档**：`02-核心架构设计.md` §事件驱动层 | `12-循环控制系统设计.md` §Verifier | `11-配置体系与安全` §中间件钩子
>
> **代码校准状态（2026-10-03 校准）**：本文已按 `Client/src/ai-components/` 与 `Client/src/{views,components,hooks,stores,services}` 当前实态逐条复核；WebSocket → EventEmitter/IPC 迁移（§4A）**已全部完成**。总判定为 **"基建齐、编排空、消费端零"**：
>
> - **已落地且有测试**：`registry.ts` / `types.ts` / `AIEventBus.tsx` / `Subscribe.tsx` / `FamilyErrorBoundary.tsx` / `FallbackUI.tsx`，Core 族 `StreamBuffer` + `CoTFolder` + `MessageShell`，Harness 族 `ToolGroup`；测试为 `Tests/AIComponents/`（6 个 spec / 118 用例）
> - **未落地（本文以 ⚠️ 目标态保留，不删除）**：`AIBubbleContainer.tsx`（全仓 0 命中）、Loop/Memory/MultiAgent 三族 9 个组件（三目录仅 `index.ts`，`registerAll()` 为空函数）、`MiddlewareLog` / `HookTracer` / `subgroups/`、`LoadingSpinner` / `LoadingPlaceholder`、§8 性能与文档验收项
> - **生产中未激活**：`ai-components/index.ts` 是唯一注册点，但 `Client/src` 内无任何模块 `import '@/ai-components'` → 注册表登记与族懒加载在应用 bundle 中根本不执行；真实渲染链为 `useEventBus → eventStore/chatStore → MessageList → MessageBubble → 按具体路径直接 import 四个族组件`
> - **需人工裁定项**：族分类覆盖面（§3.2.1）、Context 与决策表冲突（§3.3 决策 2）、§4A.5 延迟验收、§8.2/§8.3 度量口径——均以"现状记录 + 待办"登记，本文不作裁决

---

## 0. 问题陈述与动机

### 0.1 当前痛点

| 痛点 | 具体表现 | 影响范围 |
|------|---------|---------|
| **组件与 AI 语义脱节** | `MessageBubble.tsx` 硬编码了工具调用、思维链、流式缓冲等 5+ 种渲染逻辑（**2026-10-03 校准：已消解**——`MessageBubble.tsx` 现为薄组合层，渲染委托给 `core/MessageShell` + `core/CoTFolder` + `core/StreamBuffer` + `harness/ToolGroup`，自身只保留片段顺序编排与子容器类型判定 `inferKind`） | 新增一种工具类型需修改 MessageBubble，违反开闭原则 |
| **复用困难** | 工具展示区无法独立于消息气泡使用（比如在 LoopDebugger 中单独回放工具调用历史）（**2026-10-03 校准：组件已可独立挂载，但 `views/LoopDebugger.tsx` / `views/TraceReplay.tsx` 对 `ai-components` 仍 0 引用，复用承诺未兑现，见 §8.1**） | LoopDebugger/TraceReplay 需重复实现工具渲染逻辑 |
| **动态性不足** | 所有组件静态导入，无法根据后端推送的事件类型动态加载对应组件（**2026-10-03 校准：部分缓解**——`Client/vite.config.ts` 的 `manualChunks` 已产出 `ai-core-family` / `ai-harness-family` / `ai-registry` 三个 chunk；但注册表驱动的按事件动态加载仍未激活，见 §3.3 决策 1） | 前端包体积随组件数量线性增长，首屏加载时间 >3s |
| **维护边界模糊** | `components/Chat/` 下有 7 个文件，但 `components/AgentMonitor/` 为空，实际逻辑在 `views/AgentMonitor.tsx`（**2026-10-03 校准：现状为 `components/Chat/` 6 文件**——`AgentPreparing` / `Composer` / `MarkdownRenderer` / `MessageActions` / `MessageBubble` / `MessageList`，`StreamingIndicator.tsx` 已删除并由 `core/StreamBuffer` 取代，`ConversationCard/Grid/Sidebar.tsx` 已删除；`components/` 实有 **12 个目录**，其中 `AgentMonitor` / `ApprovalQueue` / `ArbitrationView` / `LoopDebugger` / `TaskPanel` / `TraceReplay` **6 个仅含 `.gitkeep`**，逻辑全在 `views/` 同名文件） | 新开发者无法判断应该在哪里添加新功能 |
| **测试隔离差** | 想单独测试"工具调用失败展示"，必须启动完整 ChatView + WebSocket 连接（**2026-10-03 校准：已消解**——WS 代码已删除，事件面为 `services/eventBusBridge.ts` + `stores/eventStore.ts`，族组件可在 jsdom 下脱离网络/全局 Store 独立渲染，`Tests/AIComponents/` 6 spec / 118 用例即以此方式运行） | 单元测试覆盖率 <30% |

### 0.2 目标愿景

构建一个 **"后端事件 → 组件注册表 → 动态加载器 → 统一编排容器"** 的前端架构，使得：

1. **语义清晰**：前端组件直接映射 Agent 运行时概念（Loop Iteration / Harness Tool / Memory Version）
2. **按需加载**：只加载当前对话需要的组件族，其他族懒加载或预加载
3. **独立演进**：Harness 族的工具展示优化不影响 Memory 族的版本对比逻辑
4. **后端驱动**：新增后端事件类型只需注册新组件，无需修改现有代码
5. **可测试性强**：每个 AI 组件可独立挂载测试，不依赖 WebSocket/全局 Store

> **2026-10-03 校准**：上述链路中的 **"统一编排容器"环节在代码中不存在**——`AIBubbleContainer.tsx` 全仓 0 命中（仅本文与同目录 README/契约/测试文档、`Docs/99-审查记录/` 提及）。现状由 `AIEventBus`（Context 事件缓冲）+ `chatStore`（消息态）**共同承担**容器职责，族组件由 `MessageBubble.tsx` 按具体路径直接 import。§2.3 / §3.1 / §3.4 中的"容器"按 ⚠️ 目标态保留，落地取舍见 §3.1 校准注。

---

## 1. 业界参考与理论基础

### 1.1 传统前端组件库的局限

AntD/Material-UI 等通用组件库的核心问题是 **"语义真空"**：
- `<Card>` 不知道自己是"Agent 记忆卡片"还是"任务卡片"
- `<Table>` 不知道自己在展示"工具调用日志"还是"Token 流水"
- 业务逻辑被迫塞进视图层，导致组件臃肿

### 1.2 React Server Components (RSC) 的启示

Next.js 13+ 的 RSC 提出了 **"服务端决定渲染什么，客户端决定如何交互"** 的分层思想。虽然本项目不使用 Next.js，但可以借鉴：
- **后端推送事件类型**（相当于 RSC 的服务端数据）
- **前端根据事件类型选择组件**（相当于 RSC 的服务端组件路由）
- **客户端只负责交互状态**（展开/折叠/高亮）

### 1.3 Micro-Frontends 的模块联邦

Webpack 5 Module Federation 允许不同团队独立开发、部署前端模块。本设计的 "组件族" 概念类似：
- **Loop 族**由 Loop 引擎团队维护
- **Harness 族**由中间件/Hook 团队维护
- **Memory 族**由共享记忆团队维护
- 各族通过 **注册表接口** 解耦，而非硬编码 import

### 1.4 Event-Driven UI 模式

GitHub Copilot Chat / Cursor IDE 的聊天界面已采用类似模式：
- 后端推送 `{type: "tool_call", tool: "read_file", status: "running"}`
- 前端查找 `ToolCallRenderer` 组件并传入 payload
- 组件内部根据 `status` 切换 loading/success/error 状态

但它们的组件仍是 **硬编码在 switch-case 中**，缺乏可扩展的注册机制。

---

## 2. 核心概念定义

### 2.1 AI 组件族（AI Component Family）

**定义**：一组共享相同 Agent 运行时语义、响应相同事件前缀、由同一团队维护的前端组件集合。

| 族名 | 后端事件前缀 | 典型组件 | 维护团队 | 落地状态（2026-10-03 校准） |
|------|-------------|---------|---------|--------------------------|
| **Loop 族** | `loop:*` / `task:*` | IterationCard, BudgetTracker, VerifierPanel | Loop 引擎组 | ⚠️ **未实现**：`loop/` 仅 `index.ts`，`registerAll()` 为空函数 + "Phase 2 待实现"注释 |
| **Harness 族** | `agent:tool_*` / `middleware:*` | ToolGroup, MiddlewareLog, HookTracer | 中间件组 | 🟡 **仅 `ToolGroup` 落地**（+ `ToolGroup.module.css`）；`MiddlewareLog` / `HookTracer` / `subgroups/` 均不存在，而后端已真发 `middleware:before_model`、`hook:triggered` → **前端无消费者** |
| **Memory 族** | `memory:*` | MemoryCard, VersionDiff, ReinforceAlert | 共享记忆组 | ⚠️ **未实现**：`memory/` 仅 `index.ts`，`registerAll()` 为空函数 |
| **MultiAgent 族** | `delegation:*` / `arbitration:*` | DelegationTree, ConsortiumVote, ArbitrationFlow | 多 Agent 协作组 | ⚠️ **未实现**：`multiagent/` 仅 `index.ts`，`registerAll()` 为空函数 |
| **Core 族** | `agent:stream_*` / `agent:message_*` | StreamBuffer, CoTFolder, MessageShell | 基础 UI 组 | ✅ **三件全部落地**并被 `MessageBubble.tsx` 消费（`agent:message_*` 前缀本身不存在，见下方校准注） |

> **2026-10-03 校准：事件名前缀与枚举实态**
>
> - 后端事件 SSOT 为 `Src/Services/EventBus/eventTypes.ts` 的 `EventType` 枚举（`enum`，**共 72 条、14 个域前缀**：`task:` / `agent:` / `loop:` / `token:` / `memory:` / `middleware:` / `hook:` / `delegation:` / `arbitration:` / `chat:` / `durable:` / `regulation:` / `audit:` / `system:`）。前端镜像为 `Client/src/shared/eventTypes.ts`（由 `Scripts/genEventTypes.ts` 自动生成，常量对象 + `EventTypeValue`；**当前落后枚举 1 条**，缺 `AGENT_TODO_UPDATED`，需重跑 `npm run gen:event-types`）。
> - **本表所列前缀并非全集**：`agent:` 生命周期（`agent:recruited/ready/expelled/destroyed`）、`chat:`、`token:`、`regulation:`、`audit:`、`hook:`、`durable:`、`system:` 无族归属——归属口径见 §3.2.1 第五类（需人工裁定）。
> - `agent:message_*` 这一前缀**在枚举中不存在**。真实相邻事件是 `agent:chat_message`（会话消息落库完成）与 `agent:iteration_complete`；`registry.ts` 的 `inferFamilyFromEventType` 已额外接受 `agent:iteration_` 前缀归入 Core 族。
> - 工具域真实事件名为 `agent:tool_call_pending` / `agent:tool_call_started` / `agent:tool_call_result`（**不存在** `agent:tool_call` 与 `agent:tool_result`）。

### 2.2 组件注册表（Component Registry）

**定义**：一个运行时数据结构，映射 **后端事件类型 → 前端组件定义**。

```typescript
// Client/src/ai-components/types.ts（2026-10-03 校准：按实态改为泛型形式）
export type ComponentFamily = 'loop' | 'harness' | 'memory' | 'multiagent' | 'core';
export type ComponentSubgroup = 'read' | 'write' | 'exec' | 'system';

interface AIComponentDef<TPayload = any> {
  // 所属族（用于分包懒加载）
  family: ComponentFamily;

  // 子分组（用于 UI 归类，可选）
  subgroup?: ComponentSubgroup;

  // 实际 React 组件（懒加载时可为异步工厂函数，工厂需返回带 default 导出的模块）
  component: React.ComponentType<{ payload: TPayload; event?: AIEvent }>
    | (() => Promise<{ default: React.ComponentType<{ payload: TPayload; event?: AIEvent }> }>);

  // 响应的后端事件类型（支持通配符）
  eventTypes: string[]; // e.g. ['agent:tool_call_pending', 'agent:tool_call_result']

  // 元数据（用于调试和文档生成）
  metadata: {
    name: string;       // e.g. "ToolGroup"
    description: string; // e.g. "展示单条工具调用的参数、结果、错误"
    version: string;    // e.g. "1.0.0"
  };
}

// 另有 AIEvent { id/type/data/timestamp }、FamilyLoader（懒加载回调协议）、ComponentRegistryAPI { register }
```

> **2026-10-03 校准：注册表现存 6 个不存在的事件名（【声明错误】级，唯一可直接导致错渲染的错位）**
>
> `core/index.ts` 与 `harness/index.ts` 的 `registerAll()` 共登记 8 个事件类型，其中 **6 个在 `EventType` 枚举中不存在**：
>
> | 注册表登记名（不存在） | 所在注册点 | 枚举真实名 |
> |---|---|---|
> | `agent:reasoning_chunk` / `agent:reasoning_end` | `core/index.ts` → `CoTFolder` | `agent:stream_chunk` / `agent:stream_end`（思考与正文同帧，`data.reasoning` 字段承载） |
> | `agent:message_start` / `agent:message_end` | `core/index.ts` → `MessageShell` | `agent:chat_message`（+ `agent:stream_end` 表示一轮结束） |
> | `agent:tool_call` | `harness/index.ts` → `ToolGroup` | `agent:tool_call_pending` / `agent:tool_call_started` |
> | `agent:tool_result` | `harness/index.ts` → `ToolGroup` | `agent:tool_call_result` |
>
> 现存 2 个真实名（`agent:stream_chunk` / `agent:stream_end`）恰好被 `StreamBuffer` 占用，`agent:tool_*` 通配符亦无法命中上述死名（真实名后缀为 `_pending/_started/_result`，可被 `agent:tool_*` 匹配，但注册表未使用通配符）。
>
> **另**：`ai-components/**` 全程硬编码事件名字符串，**0 处 `import { EventType } from '@/shared/eventTypes'`**，违背 `Scripts/genEventTypes.ts` 声明的"前端零自造字符串"口径（对照：`Client/src/hooks/useEventBus.ts` 已正确使用 `EventType.*` 常量）。
>
> **待办（需人工裁定后择一）**：① 把 `core/index.ts` / `harness/index.ts` 的 `eventTypes` 改指 `EventType.*` 常量并按真实名登记；② 补一条 CI/测试断言"注册事件名必须 ∈ 前端镜像枚举"；③ 顺手重跑 `npm run gen:event-types` 消除镜像落后。本文仅登记事实，不代作代码裁决。

### 2.3 统一编排容器（AIBubbleContainer）→ 事件订阅总线（AIEventBus）

**原设计缺陷**：之前的 `AIBubbleContainer` 采用"接收 events 数组 → map 渲染"的命令式模式,无法应对 AI 内容的高频增量更新(流式输出/工具调用嵌套/记忆版本冲突)。

**修正后的设计**：采用 **发布-订阅模式**,组件主动订阅感兴趣的事件类型,事件到达时自动触发重渲染。

> **2026-10-03 校准（本节实态）**
> - `AIBubbleContainer` 停留在纸面：**全仓 0 命中**，从未创建。承担"容器"角色的是 `ai-components/AIEventBus.tsx`（React Context 事件缓冲），它 **只做两件事**：把 `stores/eventStore.ts` 的原始消息转成 `AIEvent` 注入 Context；会话 ID 变更时 `clearEvents()` 清空缓冲。
> - 下方"声明式订阅"示例为 ⚠️ **目标态**：`Subscribe` 已完整实现并有测试，但 `Client/src` 生产代码 **0 处调用**（唯一提及处为 `components/Layout/MainContainer/AgentView.tsx` 的占位文案"待集成 AIEventBus + Subscribe 事件驱动渲染"）。`ChatView.tsx` 的实际用法是 `<AIEventBus sessionId={activeAgentSessionId}>` 包住 props 驱动的 `MessageList` + `Composer`，子树内没有任何 `Subscribe`。
> - **会话隔离未实现**：桥接帧为 `{ type, data, timestamp }`——主进程 `Src/Interface/IpcBridge/ipcBridge.ts` 的 `IpcMessage` 与前端 `services/eventBusBridge.ts` 的 `BridgeMessage`、`stores/eventStore.ts` 的 `RawBusMessage` **三处同构且均无 `sessionId` 字段**；`AIEventBus` 的 Context 里虽带 `sessionId`，但没有任何消费者按它过滤。当前语义应表述为 **"切换会话时清空事件缓冲"**，而非"按 `event.sessionId === sessionId` 过滤"。

```typescript
// 目标态设计理念（未接入生产渲染链）
interface AIEventBusProps {
  sessionId: string; // ⚠️ 目标态：会话隔离（现状为"切会话即清空缓冲"，见上方校准注）
  children?: React.ReactNode; // 可嵌套子组件
}

// 使用方式：声明式订阅
function ChatView() {
  return (
    <AIEventBus sessionId={sessionId}>
      {/* 组件声明自己关注的事件类型 */}
      <Subscribe eventTypes={['agent:stream_chunk']}>
        {(events) => <StreamBuffer events={events} />}
      </Subscribe>
      
      <Subscribe eventTypes={['agent:tool_call_pending', 'agent:tool_call_result']}>
        {(events) => <ToolGroup events={events} />}
      </Subscribe>
      
      <Subscribe eventTypes={['memory:written', 'memory:superseded']}>
        {(events) => <MemoryCard events={events} />}
      </Subscribe>
    </AIEventBus>
  );
}
```

**核心优势（2026-10-03 校准落地状态）**：
1. **声明式订阅**：组件只需声明"我关心什么事件",无需手动管理订阅/取消订阅 —— 🟡 机制已实现（`Subscribe.tsx` + `AIEventBus.tsx`），**视图未接入**
2. **自动过滤**：`Subscribe` 组件内部根据 `eventTypes` 过滤,只传递相关事件 —— ✅ 已实现（`matchEventType` 精确匹配短路 + `*`→`.*` 正则全串锚定，有测试）
3. **嵌套支持**：可在不同层级嵌套订阅(如 LoopDebugger 中单独订阅工具调用历史) —— ⚠️ 未实现（`LoopDebugger.tsx` / `TraceReplay.tsx` 均不 import `ai-components`，见 §8.1）
4. **性能优化**：只有订阅的组件事件变化时才重渲染,而非整个容器重渲染 —— 🟡 部分（`AIEventBus` 用 `useMemo` 缓存转换，但 Context 值 `{events, sessionId}` 为对象字面量，每次渲染新引用 → 订阅方无选择性；现状性能路径实际是 `chatStore` 的细粒度 selector）

### 2.4 组件生命周期

每个 AI 组件经历以下阶段：

```
未注册 → 已注册（注册表） → 匹配事件（动态加载） → 挂载（注入 payload） → 更新（新事件） → 卸载（会话结束）
```

关键点：
- **未注册 → 已注册**：应用启动时批量注册或懒加载时动态注册
- **匹配事件 → 动态加载**：首次匹配某族事件时触发该族的 code splitting bundle 加载
- **挂载 → 更新**：组件接收 `payload` prop，内部管理展开/折叠等交互状态

> **2026-10-03 校准**：上述生命周期的前两阶段（**已注册 → 匹配事件 → 动态加载**）目前 **只在测试进程内发生**——`ai-components/index.ts` 是唯一注册点且无人 import（详见 §3.3 决策 1 校准注）。生产中的"挂载"是 `MessageBubble.tsx` 直接以业务 props（`toolCalls` / `content` / `reasoning`）渲染族组件，**不经过注册表、不注入 `payload`**；`ToolGroup` 当前签名甚至不接受 `payload`（见 §5.3 校准注）。

---

## 3. 架构设计

### 3.1 整体架构图

**现状实态图（2026-10-03 校准，按代码重绘）**：

```
┌──────────────────────────────────────────────────────────────────┐
│                Backend（Src/，同进程，无 WebSocket）              │
│  publish(createEvent({eventType, payload, …}))                   │
│    → Services/EventBus/eventBus.ts（自研 publish/subscribeMany，  │
│      eventId 幂等 + 事件环形日志，非 Node EventEmitter）          │
│  推送事件示例：agent:stream_chunk / agent:tool_call_started /     │
│                loop:* / memory:written                            │
└────────────────────────────┬─────────────────────────────────────┘
                             │ Electron IPC：webContents.send('backend-event',
                             │ { type, data, timestamp })（⚠️ 帧内无 sessionId）
                             ▼
┌──────────────────────────────────────────────────────────────────┐
│  electron/preload.ts  contextBridge 白名单                        │
│    onBackendEvent / sendBackendCommand / removeBackendEvent…      │
└────────────────────────────┬─────────────────────────────────────┘
                             ▼
┌──────────────────────────────────────────────────────────────────┐
│  services/eventBusBridge.ts（isElectron() 双分支）                │
│    Electron → IPC；浏览器 → 3s 轮询重探（HTTP 降级为待办）        │
│  hooks/useEventBus.ts（全局唯一 subscribe，原 useWebSocket 已删）  │
└──────┬──────────────────────────────────┬────────────────────────┘
       │ 推入事件缓冲                      │ 分发业务态
       ▼                                  ▼
┌──────────────────────┐        ┌──────────────────────────────────┐
│ stores/eventStore.ts │        │ chatStore / agentStore / taskStore│
│  events[]（≤1000）   │        │ approvalStore / tokenStore / …    │
└──────────┬───────────┘        └───────────────┬──────────────────┘
           │ React Context（{events, sessionId}）│ props
           ▼                                     ▼
┌──────────────────────┐        ┌──────────────────────────────────┐
│ ai-components/       │        │ views/ChatView.tsx →              │
│   AIEventBus         │        │ components/Chat/MessageList →     │
│  （会话变更仅清空）   │        │ components/Chat/MessageBubble     │
└──────────┬───────────┘        └───────────────┬──────────────────┘
           │ ⚠️ 休眠：Subscribe 生产 0 调用      │ 直接 import（非注册表）
           ▼                                     ▼
┌──────────────────────┐        ┌──────────────────────────────────┐
│ Subscribe + registry │        │ core/MessageShell · core/CoTFolder│
│ （仅测试路径可达）    │        │ core/StreamBuffer · harness/     │
└──────────────────────┘        │ ToolGroup（无族级 ErrorBoundary）  │
                                └──────────────────────────────────┘
⚠️ 目标态（全仓 0 命中，未创建）：AIBubbleContainer —— 遍历事件 → 查注册表
   → 动态加载 → 按族分组 → 各族套 ErrorBoundary（见 §3.4）
```

> **2026-10-03 校准**：原图"WS Gateway → useWebSocket → AIBubbleContainer → 三族懒加载"的三段已全部失真：① WS 层被 IPC + 进程内 EventBus 取代（§4A 已迁移完成）；② `useWebSocket` 已重命名为 `useEventBus`；③ **编排容器不存在**，注册表与 `Subscribe` 在整条生产链中处于休眠态（`registry.ts` 的注册/懒加载仅由 `Tests/AIComponents/` 触发）。真实渲染链是 `useEventBus → chatStore → MessageList → MessageBubble → 直接 import 四个族组件`，`AIEventBus` 只是套在 `ChatView` 外层的空 Context 提供者。

### 3.2 目录结构规划

```
Client/src/
  ai-components/           # ✅ 已建（当前 21 个文件）——AI 组件族根目录
    registry.ts            # ✅ 组件注册表（单例；精确匹配 + 通配符兜底 + 族懒加载）
    types.ts               # ✅ 类型定义（AIComponentDef / AIEvent / FamilyLoader / ComponentRegistryAPI）
    index.ts               # ✅ 唯一注册点，但 ⚠️ 无任何模块 import 它 → 注册/懒加载生产中不执行（§3.3 决策 1）
    AIEventBus.tsx         # ✅ 已实现（Context 事件缓冲，读 stores/eventStore.ts）
    Subscribe.tsx          # ✅ 已实现 + 有测试，⚠️ 生产 0 调用
    FamilyErrorBoundary.tsx# ✅ 已实现（重试 + dev 详情 + Sentry TODO 注释），⚠️ 生产 0 装配
    FallbackUI.tsx         # ✅ 已实现（+ FallbackUI.module.css，import.meta.env.DEV 判定）
    AIBubbleContainer.tsx  # ⚠️ 未实现（目标态：全仓 0 命中）

    loop/                  # Loop 族 —— ⚠️ 3/3 占位
      index.ts             # ✅ 存在，registerAll() 为 **空函数** + "Phase 2 待实现"注释
      IterationCard.tsx    # ⚠️ 未实现
      BudgetTracker.tsx    # ⚠️ 未实现
      VerifierPanel.tsx    # ⚠️ 未实现
      README.md            # ⚠️ 未实现（族内文档缺失）

    harness/               # Harness 族 —— 🟡 仅 ToolGroup 落地（实有 3 文件）
      index.ts             # ✅ 存在，registerAll() 注册 ToolGroup（事件名为死名，见 §2.1 校准注）
      ToolGroup.tsx        # ✅ 从 MessageBubble 抽离（含 ToolCallItem / InlineApproval / inferSubgroup）
      ToolGroup.module.css # ✅（目标态未列，实际存在）
      MiddlewareLog.tsx    # ⚠️ 未实现（后端 middleware:before_model 已真发，前端无消费者）
      HookTracer.tsx       # ⚠️ 未实现（后端 hook:triggered 已真发，前端无消费者）
      subgroups/           # ⚠️ 目录不存在（子分组样式现为 ToolGroup.tsx 内的 inferSubgroup + CSS Module 类）
        ReadTools.tsx      # ⚠️ 未实现
        WriteTools.tsx     # ⚠️ 未实现
        ExecTools.tsx      # ⚠️ 未实现
        SystemTools.tsx    # ⚠️ 未实现

    memory/                # Memory 族（新增）—— ⚠️ 3/3 占位
      index.ts             # ✅ 存在，registerAll() 为空函数
      MemoryCard.tsx       # ⚠️ 未实现
      VersionDiff.tsx      # ⚠️ 未实现
      ReinforceAlert.tsx   # ⚠️ 未实现

    multiagent/            # MultiAgent 族（新增）—— ⚠️ 3/3 占位
      index.ts             # ✅ 存在，registerAll() 为空函数
      DelegationTree.tsx   # ⚠️ 未实现
      ConsortiumVote.tsx   # ⚠️ 未实现
      ArbitrationFlow.tsx  # ⚠️ 未实现

    core/                  # Core 族（从 Chat/ 迁移）—— ✅ 3/3 落地
      index.ts             # ✅ registerAll() 注册 StreamBuffer / CoTFolder / MessageShell
      StreamBuffer.tsx     # ✅ 取代 StreamingIndicator（+ StreamBuffer.module.css），签名 {content, isStreaming}
      CoTFolder.tsx        # ✅ 从 MessageBubble 抽离（+ CoTFolder.module.css），签名 {reasoning, isStreaming}
      MessageShell.tsx     # ✅ 消息外壳（无业务逻辑）

  components/              # ← 保留：传统前端组件（2026-10-03 校准：实有 **12 个目录**，非 5 个）
    Layout/                # ✅ 8 项（AppLayout / AppTitleBar / LeftPanel / MainContainer / RightPanel / …）
    Dashboard/             # ✅ 4 组件 + .gitkeep（AgentTopologyGraph / AlertList / TaskGanttChart / TokenFlowSankey）
    Settings/              # ✅ ModelProviderPanel / fields
    WorkingModes/          # ✅ 9 项（7 个模式可视化 + ModeShell + demoData）
    Approval/              # ✅ ApprovalCard.tsx（审批卡片仍属传统组件，非 Agent 运行时）
    Chat/                  # ✅ 6 文件：AgentPreparing / Composer / MarkdownRenderer / MessageActions / MessageBubble / MessageList
    AgentMonitor/          # ⚠️ 仅 .gitkeep（逻辑在 views/AgentMonitor.tsx）
    ApprovalQueue/         # ⚠️ 仅 .gitkeep（逻辑在 views/ApprovalQueue.tsx）
    ArbitrationView/       # ⚠️ 仅 .gitkeep（逻辑在 views/ArbitrationView.tsx）
    LoopDebugger/          # ⚠️ 仅 .gitkeep（逻辑在 views/LoopDebugger.tsx）
    TaskPanel/             # ⚠️ 仅 .gitkeep（逻辑在 views/TaskPanel.tsx）
    TraceReplay/           # ⚠️ 仅 .gitkeep（逻辑在 views/TraceReplay.tsx）

  views/                   # ← 页面级视图
    ChatView.tsx           # 🟡 未用 AIBubbleContainer（⚠️ 目标态）：props 驱动 MessageList + Composer，外层套 AIEventBus
    LoopDebugger.tsx       # ❌ **未复用** Harness.ToolGroup——仅 import react / lucide-react / stores/loopStore，自绘渲染
    TraceReplay.tsx        # ❌ **未复用** ToolGroup + Loop.IterationCard——同上（且 Loop.IterationCard 本身未实现）
```

> **2026-10-03 校准补注**：`registry.registerFamily('loop' | 'memory' | 'multiagent', () => import('./…'))` 三条懒加载登记在位，但三个空族加载后 **注册 0 条**（`registerAll()` 体为空），因此"懒加载生效"不等于"该族可用"——排查时须区分"未加载"与"已加载但空"。分包侧 `Client/vite.config.ts` 也只配了 `ai-core-family` / `ai-harness-family` / `ai-registry` 三块，**空族无 chunk**。

### 3.2.1 组件族分类决策树

**问题**：新开发一个组件时,如何判断它应该属于哪个 AI 组件族,还是放在传统 `components/` 目录?

**决策流程**:

```
新组件开发决策树:

1. 是否响应后端事件（已简化为 EventEmitter/IPC，见 §4A）?
   ├─ 否 → 放入 components/<Domain>/ (传统前端组件)
   └─ 是 ↓

2. 事件类型前缀是什么?
   ├─ loop:/task: → Loop 族
   ├─ agent:tool_:/middleware:/hook: → Harness 族（⚠️ hook: 为 2026-10-03 校准补列目标态，代码尚未识别）
   ├─ memory: → Memory 族
   ├─ delegation:/arbitration: → MultiAgent 族
   ├─ agent:stream_:/agent:message_ → Core 族（⚠️ 枚举无 agent:message_*；真实相邻名为 agent:chat_message，registry.ts 另接受 agent:iteration_）
   └─ **第五类：无族归属**（token:/regulation:/audit:/durable:/system:/chat:/agent: 生命周期）
        → 传统 components/<Domain>/ 或 store 直连（现状即如此：token: → tokenStore 节流刷新，
          agent:recruited/ready/expelled/destroyed → agentStore，task:* → taskStore）

3. 是否需要复用到其他视图(LoopDebugger/TraceReplay)?
   ├─ 是 → 必须是 AI 组件族
   └─ 否 → 可以是传统组件(但建议仍按事件前缀归类)
```

**示例**:

| 组件 | 决策过程 | 归属 |
|------|---------|------|
| 工具调用展示 | 响应 `agent:tool_call` → Harness 族 | `ai-components/harness/ToolGroup.tsx` |
| 记忆版本对比 | 响应 `memory:superseded` → Memory 族 | `ai-components/memory/VersionDiff.tsx` |
| 审批卡片 | 不响应后端事件(EventEmitter/IPC),仅展示 REST API 数据 | `components/Approval/ApprovalCard.tsx` |
| Agent 拓扑图 | 响应 `agent:lifecycle` 但无需复用 | 可放 `components/Dashboard/AgentTopologyGraph.tsx` |
| 委派链路展示 | 响应 `delegation:assigned` → MultiAgent 族 | `ai-components/multiagent/DelegationTree.tsx` |

**边界情况处理**:

- **既响应后端事件(EventEmitter/IPC)又需要复杂布局**: 优先归入 AI 组件族,布局逻辑由父容器负责
- **不确定事件前缀**: 查看 `Src/Services/EventBus/eventTypes.ts` 或咨询后端负责人
- **跨族组件**: 若组件需响应多种事件(如同时处理 `agent:tool_call` 和 `memory:written`),选择主要事件前缀对应的族,并在组件文档中注明依赖

> **2026-10-03 校准 · 现状记录 + 待办（需人工裁定，本文不裁决）**
>
> **现状记录**：
> 1. 五族前缀表**不覆盖后端事件全集**。`EventType` 枚举实有 **14 个域**，其中 `token:`(10) / `agent:` 生命周期(4) / `regulation:`(3) / `audit:`(3) / `durable:`(5) / `system:`(2) / `chat:`(1) / `arbitration:`(9，其中仅 `arbitration:*` 被 MultiAgent 族登记) 等 **共约 8 个域在本决策树中无族归属**，实际由 `useEventBus` 直连各 store（`agentStore` / `taskStore` / `tokenStore` / `approvalStore`）消化。
> 2. `registry.ts` 的 `inferFamilyFromEventType` **没有 `hook:` 分支**（只识别 `loop:`/`task:`/`agent:tool_`/`middleware:`/`memory:`/`delegation:`/`arbitration:`/`agent:stream_`/`agent:message_`/`agent:iteration_`）。后端 `Services/Hook/hookRegistry.ts` 的 `hook:triggered` 一旦进入注册表查询即 **无族可归 → 返回 null → 懒加载不触发**，Harness 族永远拿不到 Hook 事件。
> 3. 本节示例表内的事件名沿用设计期写法，其中 `agent:tool_call`（工具调用展示）**枚举不存在**、`memory:superseded`（版本对比）**仅枚举声明、Src 内 0 发布点**；真实已发布的记忆事件是 `memory:written` / `memory:version_conflict` / `memory:self_reinforcing`。
>
> **待办**：
> - 请裁定族分类的**覆盖口径**：是"五族只覆盖 Agent 运行时语义事件、其余 8 域永久走 store 直连"（则本文应在 §2.1 显式声明该边界），还是"扩族/扩前缀以覆盖全部 72 条事件"（则需同步 `registry.ts` 与 `types.ts` 的 `ComponentFamily`）。
> - `inferFamilyFromEventType` 是否补 `hook:` → `harness` 分支（一行改动；补后 `HookTracer` 才有装配前提）。
> - 示例表事件名是否统一改指 `EventType.*` 常量（与 §2.2 校准注同一议题）。

### 3.3 关键设计决策

#### 决策 1：注册时机

| 方案 | 优点 | 缺点 | 选择 |
|------|------|------|------|
| **启动时全量注册** | 简单，无异步加载延迟 | 首屏包体积大 | ❌ |
| **首次匹配时懒加载** | 按需加载，包体积小 | 首次匹配有加载延迟 | ✅ **默认** |
| **混合策略** | 高频族（Core/Harness）启动注册，低频族懒加载 | 配置复杂 | ✅ **可选** |

**实施**：
```typescript
// Client/src/ai-components/index.ts（2026-10-03 校准：按实态改写，非文档原设想伪代码）
import { registry } from './registry';

// Core / Harness 族：高频，启动即注册（同步 import，非懒加载）
import { registerAll as registerCore } from './core';
registerCore(registry);
import { registerAll as registerHarness } from './harness';
registerHarness(registry);

// 低频族：懒加载（首次匹配事件时由 registry.ensureFamilyLoaded 触发 dynamic import）
registry.registerFamily('loop', () => import('./loop'));
registry.registerFamily('memory', () => import('./memory'));
registry.registerFamily('multiagent', () => import('./multiagent'));
```

> **2026-10-03 校准 · 现状记录 + 待办**：上表选定的"混合策略"在代码里**已按图写好，但整段从不执行**——`ai-components/index.ts` 是唯一注册点，而 `Client/src` 内 **0 个模块 `import '@/ai-components'`**（`grep "from '@/ai-components'"` 无命中；`App.tsx`、`MessageBubble.tsx`、`ChatView.tsx` 全部按具体子路径 import 单个文件），`main.tsx` 也只 import `App` 与 `index.css`。
> 后果：**注册表登记、族懒加载、错误边界导出在应用 bundle 中均为休眠态**（只有 `Tests/AIComponents/` 显式 import 时才跑），"注册表驱动渲染"这一前提因此不成立。
> **待办（择一，需人工裁定优先级）**：① 在 `main.tsx`（或 `AppLayout` 挂载前）显式 `import '@/ai-components'` 激活注册；② 把注册段迁入 `AIEventBus.tsx` 模块副作用，使 `<AIEventBus>` 一挂载即完成注册；③ 删除 `index.ts` 注册段，在文档与代码注释中如实标注"注册表目前仅测试可用"。

#### 决策 2：组件通信方式

| 方案 | 优点 | 缺点 | 选择 |
|------|------|------|------|
| **Props 逐层传递** | 类型安全，易追踪 | 深层嵌套时需透传大量 props | ❌ |
| **Context API** | 避免 prop drilling | 过度使用导致重构困难 | 🟠 局部使用 |
| **Zustand Store** | 全局访问，类型推断好 | 需防止过度耦合 | ✅ **主选** |
| **事件总线** | 完全解耦 | 难以追踪数据流 | ❌ |

**实施**：
- 组件内部交互状态（展开/折叠）用 `useState`
- 跨组件共享数据（当前会话 ID、用户偏好）用 Zustand Store
- 不使用 Context（除非性能瓶颈）

> **2026-10-03 校准 · 现状记录 + 待办（需人工裁定）**：本决策表与本文自身设计**互相矛盾**，登记事实如下，不裁决取舍：
> - `AIEventBus.tsx` 正是用 **React Context** 传递事件流（`EventBusContext` 建 Context → Provider 下发 `{events, sessionId}` → `Subscribe` 用 `useContext` 消费），而 §2.3 的"嵌套订阅"设计目标本身依赖这一机制。
> - `AIEventBus` 的事件源已改为 `stores/eventStore.ts`（Zustand），即"**Store 取数 + Context 广播**"混合形态，非表中任一纯净方案。
> - `useEventBus.ts` 在 `AppLayout` 中挂载，向 **8 个 store** 分发/触发（`eventStore` / `agentStore` / `taskStore` / `approvalStore` / `chatStore` / `tokenStore` / `systemStore` / `hotReloadStore`），与"事件总线 ❌"的否决理由（难以追踪数据流）也并存。
> **待办**：请裁定是否在决策表补例外条款——"事件流传递允许**单点** Context（仅 `AIEventBus` 一处），不得扩散为通用 prop 通道"；若不加例外，则需登记 `AIEventBus` 的 Context 为待改造项。

#### 决策 3：样式隔离策略

| 方案 | 优点 | 缺点 | 选择 |
|------|------|------|------|
| **CSS Modules** | 作用域隔离，类型安全 | 需额外配置 | ✅ **主选** |
| **Tailwind 工具类** | 无需额外配置，设计令牌复用 | 类名冗长 | ✅ **配合使用** |
| **CSS-in-JS (styled-components)** | 动态样式方便 | 运行时开销大 | ❌ |
| **Shadow DOM** | 完全隔离 | 无法继承全局主题 | ❌ |

**实施**：
- 每个 `.tsx` 配套 `.module.css`
- 优先使用 Tailwind 工具类（复用设计令牌）
- 复杂动态样式用 CSS Modules

### 3.4 错误边界隔离策略

**目标**：单个 AI 组件崩溃不应导致整个聊天界面白屏,也不应影响其他族的组件渲染。

**嵌套结构**：

```
AIBubbleContainer                       # ⚠️ 目标态：容器未创建，故本树整体未装配
  ├─ Loop.ErrorBoundary
  │   └─ [Loop 族组件列表]
  ├─ Harness.ErrorBoundary
  │   └─ [Harness 族组件列表]
  ├─ Memory.ErrorBoundary
  │   └─ [Memory 族组件列表]
  ├─ MultiAgent.ErrorBoundary
  │   └─ [MultiAgent 族组件列表]
  └─ Core.ErrorBoundary
      └─ [Core 族组件列表]

现状（2026-10-03 校准）：
ChatView → AIEventBus（无 ErrorBoundary）
        → MessageList（无 ErrorBoundary）
        → MessageBubble → 直接渲染 core/* + harness/ToolGroup
      ⇒ 五个族边界 **一个都没有套上**；单个族组件抛错会向上冒泡到 React 根，
         整棵聊天子树卸载（即本节"目标"要防的白屏场景，目前**仍会发生**）。
```

**实现**：

```typescript
// Client/src/ai-components/FamilyErrorBoundary.tsx（2026-10-03 校准：按实态改写）
// 说明：代码并未按族建 5 个类（HarnessErrorBoundary / MemoryErrorBoundary …），
//       而是提供一个 **通用** 族边界，family 作为 prop 传入，可复用 5 次。
class FamilyErrorBoundary extends Component<
  { children: ReactNode; family: string },
  { hasError: boolean; error?: Error }
> {
  state: State = { hasError: false };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 现状：仅 console.error，Sentry 上报为 TODO 注释（未接入任何监控 SDK）
    console.error(`[${this.props.family} 族错误]`, error, info.componentStack);
    // TODO: reportErrorToSentry(error, { tags: { family }, extra: { componentStack } });
  }

  private handleRetry = () => this.setState({ hasError: false, error: undefined });

  render() {
    if (this.state.hasError) {
      return <FallbackUI family={this.props.family} error={this.state.error} onRetry={this.handleRetry} />;
    }
    return this.props.children;
  }
}
```

**使用方式**：

```typescript
// ⚠️ 未实现（目标态）：ai-components/AIBubbleContainer.tsx —— 该文件全仓 0 命中
export function AIBubbleContainer({ events, sessionId }: Props) {
  // 按族分组事件（groupEventsByFamily 亦不存在）
  const eventsByFamily = groupEventsByFamily(events);

  return (
    <div className="ai-bubble-container">
      <FamilyErrorBoundary family="harness">
        {eventsByFamily.harness.map(event => (
          <DynamicComponent key={event.id} event={event} />
        ))}
      </FamilyErrorBoundary>

      <FamilyErrorBoundary family="memory">
        {eventsByFamily.memory.map(event => (
          <DynamicComponent key={event.id} event={event} />
        ))}
      </FamilyErrorBoundary>

      {/* 其他族同理 */}
    </div>
  );
}
```

> **2026-10-03 校准 · 最小装配待办**：容器不必先建才能拿到隔离效果——现成 `FamilyErrorBoundary` 只需 **0 处生产引用 → 1 处包装** 即可生效：在 `MessageBubble.tsx` 渲染族组件的每个片段位（`CoTFolder` / `ToolGroup` / `StreamBuffer` / `MessageShell`）外各包一层 `<FamilyErrorBoundary family="core" | "harness">`，或在 `MessageList.tsx` 按消息整体包一层。待办登记于此，具体粒度取舍随容器议题（§3.1 校准注）一并裁定。

**Fallback UI 示例（2026-10-03 校准：按 `ai-components/FallbackUI.tsx` 实态改写）**：

```typescript
// Client/src/ai-components/FallbackUI.tsx（配套 FallbackUI.module.css）
interface FallbackUIProps {
  family: string;
  error?: Error;
  onRetry?: () => void;   // 由 FamilyErrorBoundary 传入，复位 hasError（不整页刷新）
}

export function FallbackUI({ family, error, onRetry }: FallbackUIProps) {
  const isDev = import.meta.env.DEV;   // Vite 环境判定（取代原设计的 process.env.NODE_ENV）
  return (
    <div className={styles.fallback} data-family={family}>
      <span className={styles.icon}>⚠️</span>
      <span className={styles.message}>{family} 族组件加载失败</span>
      {isDev && error && <pre className={styles.detail}>{error.message}</pre>}
      {onRetry && <button className={styles.retry} onClick={onRetry}>重试</button>}
    </div>
  );
}
```

**验收标准（2026-10-03 校准状态）**：
- [ ] 单个组件崩溃时,同族其他组件仍能正常渲染 —— **未达成**：`FamilyErrorBoundary` 生产 0 装配，且 `MessageBubble` 内一条消息的多片段共处一层
- [ ] 不同族之间互不影响（Harness 族崩溃不影响 Memory 族）—— **未达成**：同上；Memory 族组件本身亦未实现
- [ ] 错误信息上报到 Sentry,附带组件栈追踪 —— **未达成**：`componentDidCatch` 内为 TODO 注释，全仓无 Sentry 依赖
- [x] 开发环境显示详细错误信息,生产环境显示友好提示 —— **已达成**：`FallbackUI` 以 `import.meta.env.DEV` 判定，dev 显示 `error.message`；额外增强：提供 `onRetry` 复位（目标态原设计只有"刷新页面"）

---

## 4. 实施计划

### Phase 1: 抽离现有组件（1-2 周）

**目标**：将 `MessageBubble` 拆分为 Core 族 + Harness 族组件，建立注册表机制。

| 任务 | 交付物 | 验收标准 | 状态（2026-10-03 校准） |
|------|--------|---------|------------------------|
| 1.1 创建目录结构 | `ai-components/` 骨架 | 通过 TypeScript 编译 | ✅ 五族目录 + 根基建齐备（实有 21 文件） |
| 1.2 实现注册表 | `registry.ts` + 单元测试 | 能注册/查询组件定义 | ✅ 已交付（`Tests/AIComponents/registry.spec.ts` 21 条）；⚠️ 仅测试可达，见 §3.3 决策 1 |
| 1.3 抽离 Core.StreamBuffer | 从 `StreamingIndicator.tsx` 迁移 | 视觉无变化，可独立测试 | ✅ 已交付（`StreamingIndicator.tsx` 已删除，`StreamBuffer` 接 `{content, isStreaming}` 并被 `MessageBubble` 消费） |
| 1.4 抽离 Core.CoTFolder | 从 `MessageBubble` 提取思维链折叠逻辑 | 支持展开/折叠/流式期间强制展开 | ✅ 已交付（`{reasoning, isStreaming}`，流式中强制展开、结束折叠） |
| 1.5 抽离 Harness.ToolGroup | 从 `MessageBubble` 提取工具调用面板 | 支持 read/write/exec/system 四种子样式 | ✅ 已交付（`inferSubgroup` + 四套 badge/图标样式；额外增强：`ToolCallItem`、`InlineApproval`） |
| 1.6 实现 AIBubbleContainer | 统一编排容器 | 能根据事件类型动态渲染组件 | ⚠️ **未实现**（全仓 0 命中，Phase 1 唯一未交付项） |
| 1.7 改造 ChatView | 使用 AIBubbleContainer 替代原有逻辑 | 功能回归测试通过 | 🟡 **部分**：`ChatView.tsx` 改为 `AIEventBus` 包裹 props 驱动的 `MessageList` + `Composer`，**未使用容器**，消息源为 `chatStore` |

**风险**：
- MessageBubble 逻辑复杂，拆分可能引入回归 bug
- **缓解**：先写快照测试（snapshot test），确保视觉无变化

> **2026-10-03 校准**：该缓解措施**未落地**——全仓无 `.snap` / `__snapshots__`、无 `jest-image-snapshot`，"视觉无变化"目前只有结构断言（`Tests/Client/message-list-turn.spec.tsx` 等）背书。详见 `测试策略设计.md` §2（由该文档的校准代理登记）。

### Phase 2: 补全缺失组件（2-3 周）

**目标**：实现 Memory 族和 MultiAgent 族，填补当前 UI 空白。

| 任务 | 交付物 | 验收标准 | 状态（2026-10-03 校准） |
|------|--------|---------|------------------------|
| 2.1 实现 Memory.MemoryCard | 单条记忆展示组件 | 能展示 key/value/version/timestamp | ⚠️ 未开工（`memory/index.ts` 的 `registerAll()` 为空函数）；且后端 `memory:written` 实发 payload 为 `{entryId, key, agentId, assertion}`，**无 value/version/timestamp**，本条验收标准与实发 Schema 冲突（详见 `后端接口契约.md` §3.1） |
| 2.2 实现 Memory.VersionDiff | 版本冲突对比组件 | 左右分栏 diff 视图，高亮变更行 | ⚠️ 未开工；前置依赖已从"补事件"变为"补组件"——`memory:version_conflict` **后端已发布**（`Services/SharedMemory/writeGuard.ts`），前端仅 `useEventBus` 触发大屏节流刷新，无组件消费 |
| 2.3 实现 Memory.ReinforceAlert | 自增强告警组件 | 检测到循环记忆时弹出警告 | ⚠️ 未开工；`memory:self_reinforcing` 后端已发布，但语义为 **访问计数阈值告警**（`{memoryId, title, accessCount, category}`），非"循环引用"，组件字段清单需据此重写 |
| 2.4 实现 MultiAgent.DelegationTree | 委派树可视化 | 展示父 Agent → 子 Agent 的委派链 | ⚠️ 未开工，且 `delegation:assigned` 后端 **0 发布点**（无委派引擎）——阻塞于后端 |
| 2.5 实现 MultiAgent.ConsortiumVote | 联盟投票面板 | 展示各 Agent 投票结果和理由 | ⚠️ 未开工；**2026-10-03 复核**：`arbitration:` 域 9 条中除 `arbitration:request`、`arbitration:deadlock` 外 **7 条已有真实 `publish()` 点**（`Services/Arbitration/tribunal.ts`、`Services/Regulation/finalArbiter.ts` 等）→ 本条 **不再被后端阻塞**，可开工（数据源口径需按 `后端接口契约.md` §5 核对） |
| 2.6 实现 MultiAgent.ArbitrationFlow | 仲裁流程可视化 | 展示仲裁请求 → 裁决过程 → 最终裁决 | 🟡 **部分阻塞**：`arbitration:verdict` / `filed` / `conflict_detected` / `suspend_and_notify` / `restoration_ack` / `knowledge_consolidation` / `pool_resized` 均已发布，"裁决"段有数据源；仅 **`arbitration:request` 0 发布点** → "仲裁请求"这一段仍被后端阻塞 |

**依赖**：后端需先完善 `memory:*` 和 `delegation:*` 事件推送（见 §6 后端配合需求）

> **2026-10-03 校准**：依赖关系已发生变化——`memory:*`（written / version_conflict / self_reinforcing）、`middleware:before_model`、`hook:triggered` **后端均已真发**，Memory 族的阻塞点从"等事件"变为"等组件"；Harness 族的 `MiddlewareLog` / `HookTracer` 因此**可提前开工**（数据源就绪）。MultiAgent 族内部分化：`delegation:assigned` 与 `arbitration:request` 仍是 **0 发布点**（无委派引擎），但 `arbitration:` 域其余 7 条已发布，故 2.5/2.6 **不再全量被后端阻塞**——真正的阻塞点转移到"注册表未激活 + 族目录空壳"这一侧（§3.3 决策 1）。

### Phase 3: 动态加载优化（1 周）

**目标**：按族分包，优化首屏加载性能。

| 任务 | 交付物 | 验收标准 | 状态（2026-10-03 校准） |
|------|--------|---------|------------------------|
| 3.1 配置 Vite code splitting | `vite.config.ts` 手动分包 | 每个族生成独立 chunk | 🟡 部分：已配 `ai-core-family` / `ai-harness-family` / `ai-registry`；**loop / memory / multiagent 三个空族无 chunk 配置** |
| 3.2 实现懒加载逻辑 | `registry.ts` 中的动态 import | 首次匹配事件时触发加载 | 🟡 机制已实现（`ensureFamilyLoaded` + `loadedFamilies`/`loadingFamilies` 双集合去重），但 ⚠️ 注册入口未被 import → 生产中不触发（§3.3 决策 1） |
| 3.3 添加加载状态指示 | LoadingSpinner 组件 | 组件加载期间显示占位符 | ⚠️ **未实现**：全仓无 `LoadingSpinner`，也无 `LoadingPlaceholder` 定义；现状是 **静默跳过**——`Subscribe` 在组件未解析或无匹配注册时 `return null`（既不占位也不报错）。与 §5.2 的实态描述统一 |
| 3.4 性能监控集成 | Lighthouse 跑分 | 首屏加载时间 <2s，FCP <1.5s | ⚠️ 未启动：无 `.lighthouserc*`、无 lighthouse-ci 依赖、`ci.yml` 无 perf job（详见 `测试策略设计.md` §4） |

### Phase 4: 文档与培训（1 周）

| 任务 | 交付物 | 状态（2026-10-03 校准） |
|------|--------|----------------------|
| 4.1 编写组件族开发指南 | `Docs/Client/03-AI组件族架构/开发指南.md` | ⚠️ 未创建（本目录实有 4 份文档：本设计 + `后端接口契约.md` + `测试策略设计.md` + `README.md`） |
| 4.2 编写注册表 API 文档 | `Docs/Client/03-AI组件族架构/注册表API.md` | ⚠️ 未创建 |
| 4.3 录制视频教程 | 5 分钟演示如何新增一个 AI 组件 | ⚠️ 未创建 |
| 4.4 更新 AGENTS.md | 明确新组件应放在哪个族 | ⚠️ 未创建：**仓库内不存在 `AGENTS.md`**（根目录仅有 `.qoder/skills`、`.qoder-cn/canvases`，无任何 agent 规则文件），故族归属口径目前只存在于本文 §3.2.1 |

> **2026-10-03 校准**：`Client/src/ai-components/` 下同样**无任何 README/族内文档**（§3.2 规划的 `loop/README.md` 未创建）。Phase 4 是否随空族一并延后，需人工裁定（见 §8.3 状态列）。

---

## 4A. 架构简化：从 WebSocket 到 EventEmitter

**问题发现**：当前设计仍基于 WebSocket(端口 3001),但本项目是 **Electron 桌面应用**,前后端运行在同一 Node.js 进程中,使用跨进程通信是过度设计。

**简化方案**：用 **Node.js EventEmitter** 替代 WebSocket,实现进程内事件总线。

### 4A.1 当前架构 vs 简化后架构

| 维度 | 当前架构(WebSocket) | 简化后架构(EventEmitter) |
|------|-------------------|------------------------|
| **通信方式** | `ws://localhost:3001` (TCP) | `EventEmitter.emit()` (内存) |
| **延迟** | 5-10ms (网络栈开销) | <0.1ms (函数调用) |
| **端口管理** | 需维护 wsPort/httpPort 分离 | 无需端口 |
| **重连逻辑** | 指数退避 + 降级轮询 | 无需重连 |
| **心跳机制** | 30s ping/pong | 无需心跳 |
| **代码复杂度** | ~300 行(ws.ts + wsGateway.ts) | ~50 行(eventBus.ts) |
| **适用场景** | 浏览器客户端 + 远程服务器 | Electron 单进程应用 |

> **2026-10-03 校准**：本表"简化后"列三处与实态不符——① 通信方式不是 `EventEmitter.emit()`，而是**自研 `publish(DomainEvent)` / `subscribeMany(EventType[], handler)`**（见 §4A.2），"EventEmitter"只是设计期的口语代称；② 工作量不是"~50 行 eventBus.ts"：`Src/Services/EventBus/eventBus.ts` 约 170 行（额外实现 eventId 幂等 + 事件环形日志 + `waitFor`），而承担原 wsGateway/wsServer/wsHandler 职责的桥接体 `Src/Interface/IpcBridge/ipcBridge.ts` 达 **1122 行**（见 §4A.4）；③ "无需端口"仅指**不再有 WS 端口**，HTTP 服务端口 3000 仍在（`Configs/default.json` 的 `server.httpPort`），且 `wsPort: 3001` 字段作为死配置保留。

### 4A.2 后端改造

**原架构**(WebSocket)（⚠️ 已删除：`Src/Interface/WebSocket/` 整个目录不复存在）:
```typescript
// Src/Interface/WebSocket/wsGateway.ts（已删除）
import { WebSocketServer } from 'ws';

const wss = new WebSocketServer({ port: 3001 });

wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    // 解析 JSON → 触发事件
  });
});
```

**简化后**（2026-10-03 校准：按 `Src/Services/EventBus/eventBus.ts` 实态改写）:
```typescript
// Src/Services/EventBus/eventBus.ts
// ⚠️ 不是 Node `EventEmitter`：自研 publish/subscribeMany，带来两项额外保证
//    ① eventId 幂等（processedEventIds 去重，同一事件只分发一次）
//    ② 事件环形日志（eventLog，超 maxQueueSize 丢弃最旧；配套 getEventLog / getEventCount）
//    无 emit()、无 on('*')，分发为 Promise.resolve(handler(event)).catch(() => {}) —— 消费者异常不传播给发布者

export function publish(event: DomainEvent): Result<void>;
export function subscribe(eventType: EventType, handler: EventHandler): Subscription;
export function subscribeMany(eventTypes: EventType[], handler: EventHandler): Subscription;
export function createEvent(params: {
  eventType: EventType; source: string; payload?: Record<string, unknown>;
  traceId?: string; loopId?: string; priority?: EventPriority;
}): DomainEvent;

// 后端推送事件（真实写法：先 createEvent 再 publish，无字符串通道名）
// 载体示例见 Interface/IpcBridge/ipcBridge.ts 的流式回调
publish(createEvent({
  eventType: EventType.AGENT_TOOL_CALL_STARTED,
  source: 'ipcBridge/streamGeneration',
  payload: {
    messageId: streamMessageId,
    toolCallId: info.toolCallId,
    toolName: 'read_file',
    arguments: { path: '/src/main.ts' },
    iteration: info.iteration,
  },
  traceId,
}));
```

> **2026-10-03 校准（路径与形态两处错误）**：原设计写的 `Src/Core/EventBus/eventBus.ts` **不存在**（`Src/Core/` 实为 `AgentRuntime` / `Decision` / `Loop` / `Middleware` / `Model`）；真实载体是 `Src/Services/EventBus/eventBus.ts`。原代码块用 `new EventEmitter()` + `eventBus.emit('agent:tool_call', {...})`，而真实 API 是 **`publish(DomainEvent)`**，且 `agent:tool_call` 这个事件名本身在枚举中不存在。

### 4A.3 前端改造

**原架构**(WebSocket)（⚠️ 已删除：`Client/src/services/ws.ts` 不存在，由 `services/eventBusBridge.ts` 取代）:
```typescript
// Client/src/services/ws.ts（已删除）
let ws: WebSocket | null = null;

export function connect(url: string) {
  ws = new WebSocket(url); // ws://localhost:3001
  ws.onmessage = (event) => {
    handlers.forEach(h => h(JSON.parse(event.data)));
  };
}
```

**简化后**（2026-10-03 校准：按 `Client/src/services/eventBusBridge.ts` + `electron/preload.ts` 实态改写）:
```typescript
// ① electron/preload.ts —— 渲染进程 **不直连** electron，一律走 contextBridge 白名单
contextBridge.exposeInMainWorld('electronAPI', {
  onBackendEvent: (callback) => ipcRenderer.on('backend-event', callback),
  sendBackendCommand: (command: string) => ipcRenderer.send('backend-command', command),
  removeBackendEventListeners: () => ipcRenderer.removeAllListeners('backend-event'),
  // …（invoke 类通道：providers / secrets / sessions 等，见 §4A.4）
});

// ② Client/src/services/eventBusBridge.ts —— 视图层唯一入口
export type BridgeMessage = { type: string; data: unknown; timestamp: number }; // ⚠️ 无 sessionId 字段
const handlers = new Set<(msg: BridgeMessage) => void>();

function isElectron() { return !!window.electronAPI?.onBackendEvent; }

export function connectBridge(): void {
  if (isElectron()) {
    window.electronAPI.onBackendEvent((_e, msg) => handlers.forEach(h => h(msg)));
    useSystemStore.getState().setOnline(true);
  } else {
    startFallbackPolling();   // 浏览器开发模式：**每 3s 重探 Electron API 是否出现**（FALLBACK_POLL_MS）
    useSystemStore.getState().setOnline(true);
  }
}

export function subscribe(handler: (msg: BridgeMessage) => void) {
  handlers.add(handler);
  return () => handlers.delete(handler);   // 取消订阅
}

export function send(message: Record<string, unknown>): void {
  // Electron：electronAPI.sendBackendCommand(JSON.stringify(message))
  // 浏览器：**命令不可用，仅 console.warn 后静默丢弃**（尚无 REST 命令端点承接）
}
```

**主进程桥接**（2026-10-03 校准：实现体在 `Src/Interface/IpcBridge/ipcBridge.ts`，**不是** `Src/main.ts`）:
```typescript
// Src/Interface/IpcBridge/ipcBridge.ts → startIpcBridge()
import { subscribeMany } from '../../Services/EventBus/eventBus.js';

// ① 订阅 EventBus **全部**事件 → 转发到渲染进程
//    注意：自研总线无 on('*')，故用 subscribeMany(Object.values(EventType)) **显式列举**全部类型
eventSubscription = subscribeMany(Object.values(EventType), (event: DomainEvent) => {
  const msg: IpcMessage = { type: event.eventType, data: event.payload, timestamp: event.timestamp };
  for (const win of BrowserWindow.getAllWindows()) {
    try { win.webContents.send('backend-event', msg); } catch { /* 窗口已关闭，静默忽略 */ }
  }
});

// ② 渲染进程命令（替代 wsGateway 的 socket.on('message')）
ipcMain.on('backend-command', (event, raw) => {
  const msg = JSON.parse(raw) as { type: string; payload?: Record<string, unknown> };
  handleCommand(event, msg);   // 7 个 case：见 §4A.4
});

// ③ invoke/handle 请求-响应通道（模型管理、会话数据等）
registerIpcHandlers(ipcMain);
```

> **2026-10-03 校准（三点与原文不符）**：① channel 名 `backend-event` 与原文一致 ✔，但订阅侧不是 `eventBus.on('*')` 而是 `subscribeMany(Object.values(EventType), …)` 显式列举——**新增事件类型若漏进枚举，桥接层收不到**；② 渲染进程不 `import { ipcRenderer } from 'electron'`，全部经 preload 白名单；③ 原文的降级分支缺失——真实存在 `isElectron()` 双分支与 **3s 轮询重探**（轮询只探测 Electron API 是否出现，**不是** HTTP 事件轮询；浏览器侧 `send()` 目前静默丢弃命令）。
> **另**：转发帧 `{type, data, timestamp}` **无 sessionId**，与 §2.3 "会话隔离"目标态的缺口同源（待办见 §2.3 校准注）。

### 4A.4 实施影响

**需修改的文件**（2026-10-03 校准：按实态刷新，新增"实态"列）:

| 文件 | 修改类型 | 原估工作量 | 实态（2026-10-03 校准） |
|------|---------|-----------|------------------------|
| `Src/Interface/WebSocket/wsGateway.ts` | 删除 | -150 行 | ✅ 已删除（目录整体不存在） |
| `Src/Interface/WebSocket/wsServer.ts` | 删除 | -100 行 | ✅ 已删除 |
| `Src/Interface/WebSocket/wsHandler.ts` | 删除 | -120 行 | ✅ 已删除 |
| `Client/src/services/ws.ts` | 重写为 eventBusBridge.ts | -80 行 / +50 行 | ✅ 已删除并被 `services/eventBusBridge.ts`（约 100 行，含 `isElectron()` 双分支 + 3s 轮询重探）取代 |
| `Client/src/hooks/useWebSocket.ts` | 重命名为 useEventBus.ts | 修改 import | ✅ 已重命名为 `hooks/useEventBus.ts`（在 `AppLayout` 挂载，向 8 个 store 分发） |
| **`Src/Interface/IpcBridge/ipcBridge.ts`** | **新增（原文未登记）** | — | 🔴 **实际载体：1122 行**——`startIpcBridge`（`subscribeMany` 全量转发）+ `backend-command` 监听 + `handleCommand` 的 **7 个 case**（`subscribe` / `unsubscribe` / `get_dashboard` / `get_approvals` / `generate_reply` / `stop_generation` / `ping`）+ `registerIpcHandlers` 的 invoke/handle 通道（providers / secrets / sessions / messages 等）+ 流式生成与工具事件发布 |
| `Src/main.ts` | 新增 eventBus 桥接 | +20 行 | 🟡 **实际仅 2 处**：`import { startIpcBridge, stopIpcBridge } from './Interface/IpcBridge/ipcBridge.js'` + 启动序列中 `await startIpcBridge()`（原估的"桥接逻辑写在 main.ts"不成立） |
| `Configs/default.json` | 删除 wsPort 配置 | -1 行 | ⚠️ **未删除**：`server.wsPort: 3001` 字段仍在，且 **无任何监听者**（HTTP 绑 `httpPort: 3000`）——按 `后端接口契约.md` §0.2 的补注口径"字段保留、无实际 WS 服务" |
| `Client/vite.config.ts` | 删除 `/ws` 代理规则 | — | ✅ 代理仅剩 `/api → http://localhost:3000` |

**总工作量**:约 2 小时(删除旧代码 + 新增桥接层 + 测试)

> **2026-10-03 校准**：原估 **严重低估**。删除侧（3 个 WS 文件 + `ws.ts` + `useWebSocket`）确为轻量，但新增侧 `ipcBridge.ts` 达 **1122 行**（含流式生成回调、工具事件发布、命令分发与 invoke 通道），原估"50 行 / 2 小时"对应的是"仅做事件转发"这一子集。另：`ws@^8.21.3` 与 `@types/ws` 仍留在 `package.json`（全仓 `new WebSocket` 已 0 命中），属未清理的遗留依赖。

### 4A.5 验收标准（2026-10-03 校准状态）

- [x] 删除所有 WebSocket 相关代码(wsGateway/wsServer/wsHandler) —— **2026-10-03 核实达成**：`Src/Interface/WebSocket/` 目录不存在，`Client/src/services/ws.ts`、`Client/src/hooks/useWebSocket.ts` 已删除；`Client/src` + `Src` + `electron` 内 `new WebSocket` / `WebSocketServer` / `useWebSocket` **0 命中**（仅 `useEventBus.ts` 头注释留历史说明）。遗留项：`ws` / `@types/ws` 依赖未摘
- [x] 前端能正常接收后端事件(流式输出/工具调用/记忆更新) —— **达成**：`useEventBus.ts` 按 `EventType.*` 常量分流处理 `agent:stream_chunk` / `agent:stream_end` / `agent:tool_call_pending|started|result` / `agent:iteration_complete` / `approval:*` / `memory:version_conflict` / `memory:self_reinforcing` / `middleware:before_model` / `hook:triggered`，并有 `Tests/AIComponents/eventBusBridge.spec.ts` 覆盖桥接
- [ ] **延迟测量:P99 <1ms(原 WebSocket 为 5-10ms)** —— ⚠️ **需人工裁定，登记为待办**（见下方现状记录）
- [ ] 配置文件删除 wsPort 字段 —— **未达成**：`Configs/default.json` 的 `server.wsPort: 3001` **仍在**（保留口径已在契约 §0.2 注明）；本条与 §4A.4 表行冲突，需裁定"删除"还是"保留并改述验收项"
- [x] Vite 代理配置删除 `/ws` 规则 —— **达成**：`Client/vite.config.ts` 的 `server.proxy` 只有 `/api`

> **P99 条 · 现状记录 + 待办（2026-10-03 校准，需人工裁定）**
> **现状记录**：`Tests/AIComponents/typesAndLatency.spec.ts` 已提供 **3 组进程内基准**——"进程内 EventEmitter 事件分发 P99 < 1ms"、"注册表 Map 查找 O(1) 性能验证"、"subscribe handler 分发延迟 < 0.5ms"，即"函数调用级"延迟已有自动化断言背书；但它**不覆盖真实链路**（`publish → subscribeMany → webContents.send → IPC 序列化 → preload → eventBusBridge → useEventBus → store`），端到端 P99 仍无任何采集件，也没有基线数据入库。
> **待办**：① 裁定本条口径是否改写为"进程内分发 P99 <1ms（已自动化）+ 端到端 IPC 延迟另列"；② 若要真测端到端，需补一条渲染侧打点（`timestamp` → `performance.now()` 差值）并给出基线文件，可复用 `typesAndLatency.spec.ts` 的写法作为起点。

### 4A.6 风险评估

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|---------|
| **Electron IPC 阻塞** | 低 | 中 | 限制事件频率(流式 chunk 合并发送) |
| **渲染进程崩溃影响主进程** | 极低 | 高 | EventBus 使用 try-catch 包裹 emit |
| **多窗口支持复杂化** | 中 | 中 | 每个窗口独立订阅,通过 sessionId 隔离 |

> **2026-10-03 校准（三条缓解措施实态）**：
> ① **已落地**：流式 chunk 合批由 `ui.streamFlushIntervalMs`（`Configs/default.json` = 100ms）控制，`chatStore.ts` 的 `FLUSH_INTERVAL_MS` 对应实现，事件枚举注释亦声明"禁逐 token 推送"。
> ② **机制不同但目的达成**：真实异常隔离不是 `try-catch` 包 `emit`，而是 `publish()` 内 `Promise.resolve(sub.handler(event)).catch(() => {})`——消费者异常不传播给发布者；`ipcBridge` 侧另对 `webContents.send` 包了 `try/catch`（窗口可能已关闭）。
> ③ **未落地（⚠️ 目标态）**：主进程对每个事件 **广播给 `BrowserWindow.getAllWindows()` 的全部窗口**，转发帧 `{type, data, timestamp}` **无 sessionId**，渲染侧 `AIEventBus` 也不按会话过滤（仅在会话切换时清空缓冲）——"每窗口独立订阅 + sessionId 隔离"两条手段均未实现，**多会话/多窗口并行必然串流**（缺口登记于 §2.3 与 §5.2）。

**结论**：风险可控,收益显著(代码量减少 70%,延迟降低 90%),建议在 Phase 1 开工前完成此简化。

> **2026-10-03 校准**：本结论的前置条件**已满足**——WS→EventEmitter/IPC 简化已在 Phase 1 期间落地完成（`Src/Interface/WebSocket/`、`services/ws.ts`、`hooks/useWebSocket.ts` 均已删除，见 §4A.5），本节从"待开工的前置任务"转为"已完成的架构现状记录"。"代码量减少 70%"的收益口径未复核（新增 `ipcBridge.ts` 1122 行，见 §4A.4 校准注）。

---

## 5. 技术细节

### 5.1 注册表实现（含泛型类型安全）

```typescript
// ai-components/registry.ts（2026-10-03 校准：按实态补齐，仍为单例 class ComponentRegistry）
class ComponentRegistry implements ComponentRegistryAPI {
  private registry = new Map<string, AIComponentDef>();
  private lazyLoaders = new Map<ComponentFamily, FamilyLoader>();
  private loadedFamilies = new Set<ComponentFamily>();   // 已加载族（防重复）
  private loadingFamilies = new Set<ComponentFamily>();  // 加载中族（防并发重复）

  register<T = any>(def: AIComponentDef<T>): void {
    for (const eventType of def.eventTypes) this.registry.set(eventType, def as AIComponentDef);
  }

  registerFamily(family: ComponentFamily, loader: FamilyLoader): void { this.lazyLoaders.set(family, loader); }

  // 实态另有 preloadFamily(family)：启动时主动触发某族加载（当前无调用方）
  preloadFamily(family: ComponentFamily): Promise<void> { return this.ensureFamilyLoaded(family); }

  async getComponent<T = any>(eventType: string): Promise<ComponentType<{ payload: T; event?: AIEvent }> | null> {
    // ① 精确匹配 → ② 通配符兜底（遍历含 '*' 的 pattern，转 ^…$ 正则） → ③ 族懒加载后再查一次
    let def = this.registry.get(eventType) ?? this.matchByWildcard(eventType);
    if (!def) {
      const family = this.inferFamilyFromEventType(eventType);
      if (family) {
        await this.ensureFamilyLoaded(family);           // module.registerAll(this) 回调协议
        def = this.registry.get(eventType) ?? this.matchByWildcard(eventType);
      }
    }
    if (!def) return null;

    // 异步工厂函数（非 React 组件）→ 执行并取 default 导出
    if (typeof def.component === 'function' && !this.isReactComponent(def.component)) {
      const module = await (def.component as Function)();
      return module.default ?? module;
    }
    return def.component;
  }

  hasComponent(eventType: string): boolean {            // Subscribe 用同步快查
    return this.registry.has(eventType) || this.matchByWildcard(eventType) !== null;
  }
  getRegisteredEventTypes(): string[];                   // 调试用
  get size(): number;

  private inferFamilyFromEventType(eventType: string): ComponentFamily | null {
    if (eventType.startsWith('loop:') || eventType.startsWith('task:')) return 'loop';
    if (eventType.startsWith('agent:tool_') || eventType.startsWith('middleware:')) return 'harness';
    if (eventType.startsWith('memory:')) return 'memory';
    if (eventType.startsWith('delegation:') || eventType.startsWith('arbitration:')) return 'multiagent';
    if (eventType.startsWith('agent:stream_') || eventType.startsWith('agent:message_')
        || eventType.startsWith('agent:iteration_')) return 'core';   // ← 实态多了 agent:iteration_
    return null;   // ⚠️ 无 hook: 分支 → hook:triggered 无族可归（见 §3.2.1 校准注）
  }
}

export const registry = new ComponentRegistry();
```

> **2026-10-03 校准**：本节核心行为与代码一致（Map O(1) + 通配符兜底 + `inferFamilyFromEventType → ensureFamilyLoaded → module.registerAll(this)` 懒加载协议 + 双集合去重），`Tests/AIComponents/registry.spec.ts`（21 条）已覆盖"首次匹配触发一次加载 / 重复与并发不重加载"。差异仅两处：① 原文 `getComponent` 在"未找到"时才懒加载，实态**通配符 pattern 也参与兜底匹配**（故 `agent:tool_*` 类注册可直接命中）；② `inferFamilyFromEventType` 的分支集合与 §3.2.1 决策树不完全一致（补 `agent:iteration_`、缺 `hook:`）。

**使用示例（类型安全）**：

```typescript
// ai-components/harness/ToolGroup.tsx
interface ToolCallPayload {
  id: string;
  name: string;
  arguments: Record<string, any>;
  subgroup: 'read' | 'write' | 'exec' | 'system';
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  status: 'running' | 'success' | 'error';
  result?: any;
  error?: string;
}

export function ToolGroup({ payload }: { payload: ToolCallPayload }) {
  // payload 类型自动推断为 ToolCallPayload
  console.log(payload.subgroup); // TypeScript 能正确提示可用字段
}

// 注册时指定泛型
registry.register<ToolCallPayload>({
  family: 'harness',
  component: ToolGroup,
  eventTypes: ['agent:tool_call'],
  metadata: { /* ... */ }
});

// 使用时类型安全
const Component = await registry.getComponent<ToolCallPayload>('agent:tool_call');
```

> **2026-10-03 校准 · 现状记录 + 待办（本节示例与代码三条不符）**：
> 1. **签名不符**：`ToolGroup` 实际 props 是 `{ toolCalls: ToolCallEntry[]; totalIterations?: number; iteration?: number }`（**多条分组**渲染，内部再拆 `ToolCallItem` / `InlineApproval`），不是单条 `{ payload }`——真实 API 见 §5.3。
> 2. **注册即崩**：`Subscribe` 的注册表分支按 `payload={event.data}` 注入（`Subscribe.tsx`），一旦 `agent:tool_call` 之类真命中 `ToolGroup`，组件内首行 `if (!toolCalls.length)` 会因 `toolCalls` 为 `undefined` 直接抛错 → **注册表 ↔ 族组件之间缺一个 payload→业务 props 适配器**（待办）。
> 3. **事件名不存在**：示例的 `agent:tool_call` 在枚举中不存在（真实为 `agent:tool_call_pending` / `_started` / `_result`），`harness/index.ts` 至今仍按该死名注册（详见 §2.1 / §2.2 校准注）。
> **待办**：裁定适配器落点——① 给 `ToolGroup` 增加 `payload` 兼容层（单条 payload → 长度 1 的 toolCalls）；或 ② 在 `Subscribe` 内按族做 payload 变换；或 ③ 承认"注册表渲染分支仅供自定义组件用"，把 `ToolGroup` 等既有业务组件从注册表摘出。

### 5.2 AIEventBus + Subscribe 实现（发布-订阅模式）

#### AIEventBus：事件总线容器（2026-10-03 校准：按 `ai-components/AIEventBus.tsx` 实态重写）

> **原文两处已失效**：① `import { useWebSocket } from '../hooks/useWebSocket'` —— 该 hook 已删除并改名 `useEventBus`，且 **`AIEventBus` 不再自行订阅**，改读全局缓冲；② `import { WSEvent } from '../shared/eventTypes'` —— 镜像文件 `Client/src/shared/eventTypes.ts` 由 `Scripts/genEventTypes.ts` 生成，只导出常量对象 `EventType` 与类型 `EventTypeValue`，**没有 `WSEvent`**；组件侧的事件类型是本地定义的 `ai-components/types.ts` 的 `AIEvent`。

```typescript
// Client/src/ai-components/AIEventBus.tsx（实态）
import { createContext, useContext, useEffect, useMemo, useRef } from 'react';
import { useEventStore } from '@/stores/eventStore';
import type { AIEvent } from './types';

interface EventBusContextValue { events: AIEvent[]; sessionId: string; }
const EventBusContext = createContext<EventBusContextValue>({ events: [], sessionId: '' });

interface AIEventBusProps { sessionId: string; children: ReactNode; }   // children 必填（非可选）

export function AIEventBus({ sessionId, children }: AIEventBusProps) {
  // 单一数据源：全局事件缓冲（useEventBus 是唯一 subscribe 方）
  const rawEvents = useEventStore((s) => s.events);
  const clearEvents = useEventStore((s) => s.clearEvents);

  // ⚠️ 现状的"会话隔离" = 切会话时清空缓冲；**不按 event.sessionId 过滤**（帧内根本没有 sessionId 字段）
  const prevSessionId = useRef(sessionId);
  useEffect(() => {
    if (prevSessionId.current !== sessionId) { clearEvents(); prevSessionId.current = sessionId; }
  }, [sessionId, clearEvents]);

  // {type,data,timestamp} → AIEvent（补 id：`type-timestamp-index`），useMemo 避免每次渲染重算
  const events = useMemo<AIEvent[]>(() =>
    rawEvents.map((msg, i) => ({
      id: `${msg.type}-${msg.timestamp}-${i}`,
      type: msg.type,
      data: (msg.data ?? {}) as Record<string, unknown>,
      timestamp: msg.timestamp,
    })), [rawEvents]);

  return <EventBusContext.Provider value={{ events, sessionId }}>{children}</EventBusContext.Provider>;
}

export function useEventBusContext(): EventBusContextValue { return useContext(EventBusContext); }
export { EventBusContext };   // 供 Subscribe 使用
```

**数据流（代码注释即为正确版本）**：`eventBusBridge → useEventBus（唯一 subscribe）→ eventStore → AIEventBus → Subscribe`；缓冲容量由 `eventStore` 控制（`MAX_EVENTS = 1000`，超限裁剪至最新 500 条）。

#### Subscribe：声明式订阅组件（2026-10-03 校准：按 `ai-components/Subscribe.tsx` 实态重写）

```typescript
interface SubscribeProps {
  eventTypes: string[];                                   // 支持通配符，如 'agent:tool_*'
  children?: (events: AIEvent[]) => ReactNode;            // 提供时 **覆盖** 注册表自动渲染
}

export function Subscribe({ eventTypes, children }: SubscribeProps) {
  const { events } = useContext(EventBusContext);
  const filteredEvents = useMemo(
    () => events.filter(e => eventTypes.some(p => matchEventType(e.type, p))),
    [events, eventTypes],
  );

  // 三张表：已解析事件 id → 组件；加载中的事件类型；已确认无组件的事件类型（防重复查询）
  const [resolved, setResolved] = useState<Map<string, ComponentType<{ payload: any; event?: AIEvent }>>>(new Map());
  const [pendingTypes, setPendingTypes] = useState<Set<string>>(new Set());
  const [missedTypes, setMissedTypes] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    for (const event of filteredEvents) {
      if (resolved.has(event.id) || missedTypes.has(event.type) || pendingTypes.has(event.type)) continue;
      // hasComponent 同步快查与 getComponent 异步懒加载两条分支，回调体一致
      setPendingTypes(prev => new Set(prev).add(event.type));
      registry.getComponent(event.type).then(comp => {
        if (cancelled) return;
        if (comp) setResolved(prev => new Map(prev).set(event.id, comp));
        else setMissedTypes(prev => new Set(prev).add(event.type));
        setPendingTypes(prev => { const n = new Set(prev); n.delete(event.type); return n; });
      });
    }
    return () => { cancelled = true; };
  }, [filteredEvents, resolved, pendingTypes, missedTypes]);

  // ① children 存在即 **return**：注册表分支被完全跳过（**互斥**，不是叠加）
  if (children) return <>{children(filteredEvents)}</>;

  // ② 注册表自动渲染：未解析 / 无匹配组件 → **静默 return null**（无占位组件）
  return (
    <>
      {filteredEvents.map(event => {
        const Component = resolved.get(event.id);
        if (!Component) return null;
        return <Component key={event.id} payload={event.data} event={event} />;
      })}
    </>
  );
}

// 通配符匹配（与原文语义一致，额外有精确匹配短路）
function matchEventType(actual: string, pattern: string): boolean {
  if (pattern === actual) return true;
  if (pattern.includes('*')) {
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');   // 多个 * 全部展开，全串锚定
    return regex.test(actual);
  }
  return false;
}
```

> **2026-10-03 校准 · 与原文三点不符（现状记录 + 待办）**
> ① **互斥而非叠加**：原文渲染树同时输出"注册表组件 + `children(filteredEvents)`"，实态是 `if (children) return <>{children(filteredEvents)}</>` **提前返回**，注册表分支只在**不传 children** 时生效。
> ② **无占位组件**：原文未加载时渲染 `<LoadingPlaceholder>`，实态直接 `return null`——`LoadingPlaceholder` 与 `LoadingSpinner` 全仓均未定义（同 §4 Phase 3.3）。
> ③ **注入的 props 是 `payload` + `event`**：原文只写 `payload`，实态一并传 `event`；这也正是与 `ToolGroup` 真实 props 冲突的点（见 §5.1 待办）。
> **待办**：若确需"注册表 + children 双输出"或加载占位，应作为前端功能条目另行登记；本文按实态表述，不代作设计取舍。

#### 使用示例

**场景 1：ChatView —— 目标态（⚠️ 未实现）与现状（2026-10-03 校准）**

目标态（保留，供 Phase 2 参照；事件名按真实枚举更正）：

```typescript
// views/ChatView.tsx —— ⚠️ 目标态：三段声明式订阅
export function ChatView() {
  const { sessionId } = useParams();

  return (
    <AIEventBus sessionId={sessionId}>
      <div className="chat-container">
        {/* 流式输出区 */}
        <Subscribe eventTypes={['agent:stream_chunk', 'agent:stream_end']}>
          {(events) => (
            <div className="streaming-area">
              {events.map(e => <StreamBuffer key={e.id} payload={e.data} />)}
            </div>
          )}
        </Subscribe>

        {/* 工具调用区 */}
        <Subscribe eventTypes={['agent:tool_call_pending', 'agent:tool_call_started', 'agent:tool_call_result']}>
          {(events) => (
            <div className="tools-area">
              {events.map(e => <ToolGroup key={e.id} payload={e.data} />)}
            </div>
          )}
        </Subscribe>

        {/* 记忆更新区 */}
        <Subscribe eventTypes={['memory:*']}>
          {(events) => (
            <div className="memory-area">
              {events.map(e => <MemoryCard key={e.id} payload={e.data} />)}
            </div>
          )}
        </Subscribe>
      </div>
    </AIEventBus>
  );
}
```

现状（代码实态，2026-10-03 校准）：

```tsx
// Client/src/views/ChatView.tsx —— 实为 **store / props 驱动**，子树内 0 个 Subscribe
export default function ChatView() {
  const { messages, streamingMessageId, activeAgentSessionId, /* … */ } = useChatStore();
  const activeMessages = messages[activeAgentSessionId ?? ''] ?? [];   // 消息来自 chatStore，不来自事件流

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
      {activeAgentSessionId ? (
        <AIEventBus sessionId={activeAgentSessionId}>
          <MessageList messages={activeMessages} streamingMessageId={…} sessionId={…} />
          <Composer onSend={handleSend} onStop={handleStop} isStreaming={…} … />
        </AIEventBus>
      ) : (
        <div …>选择一个对话开始</div>
      )}
    </div>
  );
}
```

> **现状记录**：**事件流与消息流已解耦**——渲染用的是 `chatStore` 里的 `ChatMessage`（含 `segments` / `toolCalls` / `reasoning`），`AIEventBus` 提供的 `events` 上下文在生产中无人消费；`useEventBus` 收到流式/工具事件后写入 `chatStore`，`MessageList → MessageBubble` 再按 props 分发。历史消息与会话事件的回放同样走 store（`chatStore.ts` 的 `replayAiEvents()` 拉 `GET /api/sessions/:sessionId/ai-events` 后 `eventStore.pushEvent`，注释自述"与实时链路完全一致"）。
> **待办（Phase 2 目标）**：若要把 ChatView 切回声明式三段订阅，前置条件是 §5.1 的 **payload→props 适配器** 与 §2.3 的 **sessionId 帧字段**（否则多会话并行会串）。

**场景 2：LoopDebugger 中的嵌套订阅（⚠️ 未实现，2026-10-03 校准）**

```typescript
// views/LoopDebugger.tsx —— 目标态（代码中不存在）
export function LoopDebugger() {
  const { traceId } = useParams();

  return (
    <AIEventBus sessionId="debug-session">
      <div className="loop-debugger">
        {/* 只订阅 Loop 相关事件 */}
        <Subscribe eventTypes={['loop:*', 'task:*']}>
          {(events) => (
            <div className="iteration-timeline">
              {events.map(e => <IterationCard key={e.id} payload={e.data} />)}
            </div>
          )}
        </Subscribe>

        {/* 嵌套订阅：单独查看工具调用历史 */}
        <Subscribe eventTypes={['agent:tool_call_started', 'agent:tool_call_result']}>
          {(events) => (
            <div className="tool-history">
              <h3>工具调用历史</h3>
              {events.map(e => <ToolGroup key={e.id} payload={e.data} />)}
            </div>
          )}
        </Subscribe>
      </div>
    </AIEventBus>
  );
}
```

> **现状记录**：`views/LoopDebugger.tsx` 与 `views/TraceReplay.tsx` 对 `ai-components` **0 引用**（两者 import 仅 `react` / `lucide-react` / `@/stores/loopStore`），各自按 `DomainEvent` 自绘时间线；且 `useParams()` 取 `traceId` / `sessionId` 的前提也不成立——`App.tsx` 的路由只有 `/login` 与 `/*`（`AppLayout`），**无 `/chat/:sessionId`、无 `/loop/:traceId` 参数路由**。本场景的阻塞项：① `Loop.IterationCard` 未实现（§3.2）；② 族组件复用需要 URL 路由与稳定 `data-testid`（另见 `测试策略设计.md` §3）。

**场景 3：性能优化 - 限制事件数量（⚠️ 未实现，2026-10-03 校准）**

```typescript
// 流式输出可能每秒推送 10+ chunk,需限制渲染数量（目标态写法）
<Subscribe eventTypes={['agent:stream_chunk']}>
  {(events) => {
    const recent = events.slice(-5);
    return <StreamBuffer events={recent} />;
  }}
</Subscribe>
```

> **现状记录**：渲染侧的限量（`slice(-5)`）**未实现**；现状靠两处更靠前的收口控制体量——① 后端按 `ui.streamFlushIntervalMs`（100ms）合批，禁止逐 token 推送；② `stores/eventStore.ts` 的缓冲上限 `MAX_EVENTS = 1000`，超限裁剪至最新 `TRIM_TO = 500` 条。消息本体渲染走 `chatStore` 的片段（`segments`）拼接，不存在"每条 chunk 一个组件实例"的问题。

### 5.3 Harness.ToolGroup 示例

**实态（2026-10-03 校准：按 `Client/src/ai-components/harness/ToolGroup.tsx` 改写）**：

```tsx
// Props 为"多条工具调用 + 迭代轮次"，而非单条 payload
interface ToolGroupProps {
  toolCalls: ToolCallEntry[];   // chatStore 的视图态条目（多条分组渲染）
  totalIterations?: number;     // >1 时头部显示 "N 轮" 徽章
  iteration?: number;           // 指定时头部显示 "第 N 轮"（优先于 totalIterations）
}

export function ToolGroup({ toolCalls, totalIterations, iteration }: ToolGroupProps) {
  const [open, setOpen] = useState(true);          // 默认展开
  if (!toolCalls.length) return null;              // 空组不渲染
  return (
    <div className={styles.wrapper}>
      <button className={styles.header} onClick={() => setOpen(o => !o)}>
        <Wrench size={12} /> 工具调用
        {iteration != null && <span className={styles.badge}>第 {iteration} 轮</span>}
        <span>{toolCalls.length} 次</span>
      </button>
      {open && <div className={styles.body}>{toolCalls.map((tc, i) => <ToolCallItem key={`${tc.id}-${i}`} tc={tc} />)}</div>}
    </div>
  );
}

// 数据源字段（Client/src/stores/chatStore.ts 的 ToolCallEntry —— 与设计期 ToolCallPayload 不同）
interface ToolCallEntry {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  status: 'success' | 'error' | 'pending' | 'generating';  // 4 态：generating=参数仍在生成，pending=已执行
  content?: string;                // 结果文本（不是 result: any）
  error?: { code: string; message: string };   // 结构化错误（不是 error: string）
  approvalId?: string;             // 危险工具被安全门阻塞 → 内嵌审批卡
  approvalStatus?: 'pending' | 'approved' | 'rejected' | 'timeout' | 'auto-approved';
  durationMs?: number;             // 单次执行耗时（成功/失败才显示）
}

// subgroup 由前端本地按工具名推断（4 态），**不读后端 payload.subgroup**，也无 riskLevel 消费
export function inferSubgroup(toolName: string): ComponentSubgroup {
  if (toolName.startsWith('read_') || toolName.startsWith('search_') || toolName.startsWith('list_')) return 'read';
  if (toolName.startsWith('write_') || toolName.startsWith('create_') || toolName.startsWith('update_')) return 'write';
  if (toolName.startsWith('exec_') || toolName.startsWith('run_') || toolName.startsWith('execute_')) return 'exec';
  return 'system';
}
```

**组件构成（实有 3 个渲染单元，无 `subgroups/` 目录）**：

| 单元 | 职责 | 备注 |
|------|------|------|
| `ToolGroup` | 多条分组 + 折叠头 + 轮次徽章 | 头部图标 `Wrench`，`ChevronDown/Right` 表达折叠态 |
| `ToolCallItem` | 单条：状态图标（`CheckCircle2`/`XCircle`/`Loader2`）+ 子组图标（`Eye`/`Pencil`/`Play`/`Settings`）+ 名称 + `generating` 期文案（"准备写入…"/"生成中…"）+ subgroup 徽章 + 耗时 + 参数/结果/错误展开区 | 与 `styles.module.css` 的 `badgeRead/Write/Exec/System` 四套样式配合 |
| `InlineApproval` | 工具行内嵌审批卡，与左侧审批栏**共享同一份 `approvalStore` 决策** | 已批准/自动通过、拒绝/超时、审查中三态；`decide(approvalId, approve, 'human-operator')` |

**原设计版（⚠️ 目标态，与代码不符）**：

```typescript
// ⚠️ 未实现：单条 payload 渲染 + getSubgroupClass(name) 三前缀推断
interface Props { payload: ToolCallPayload; }
export function ToolGroup({ payload }: Props) { /* useState(expanded) 单条展开 */ }
function getSubgroupClass(toolName: string) { /* read_/write_/exec_ 三前缀，其余 system */ }
```

> **2026-10-03 校准 · 现状记录 + 待办**：
> 1. **签名与注册表不兼容**：注册表分支注入 `{ payload, event }`（§5.2），而 `ToolGroup` 只认 `{ toolCalls }` → 一旦走注册表渲染即崩（详见 §5.1 三条待办）。
> 2. **subgroup 双源**：`ToolGroup` 恒用本地 `inferSubgroup(tc.name)`，**不消费后端已注入的 `subgroup`**；后端另有 `Src/Core/Middleware/toolCallClassifier.ts` 的更宽规则（含 `get_/find_`、`delete_/remove_` 等）——两套规则同名工具可归入不同子组。以哪套为准需人工裁定（详见 `后端接口契约.md` §2.1 的校准注）。
> 3. **`riskLevel` 在本组件无消费点**：`riskLevel` 在 `Client/src` 内只出现在审批域（`components/Approval/ApprovalCard.tsx`、`stores/approvalStore.ts`），`ToolGroup` 既无高风险警告图标、`chatStore` 也不保存该字段。
> 4. **无 `.status === 'running'`**：设计期的三态 `running/success/error` 实为四态 `generating/pending/success/error`，且无 `timestamp` 字段（时间信息在外层 `AIEvent`/消息上）。

---

## 6. 后端配合需求

### 6.1 事件类型补充

当前后端事件类型（`Src/Services/EventBus/eventTypes.ts`）需补充的事件 Schema 详见 **`后端接口契约.md`** §3-§5。

**核心需求摘要**：

| 事件类型 | 用途 | 优先级 | 详细 Schema |
|---------|------|--------|------------|
| `memory:written` | 记忆写入 | P1 | 见 `后端接口契约.md` §3.1 |
| `memory:superseded` | 记忆被覆盖 | P1 | 见 `后端接口契约.md` §3.2 |
| `memory:version_conflict` | 版本冲突 | P1 | 见 `后端接口契约.md` §3.3 |
| `memory:self_reinforcing` | 自增强检测 | P1 | 见 `后端接口契约.md` §3.4 |
| `middleware:before_model` | 中间件拦截 | P1 | 见 `后端接口契约.md` §4.1 |
| `hook:triggered` | Hook 触发 | P2 | 见 `后端接口契约.md` §4.2 |

> **2026-10-03 校准（"需补充"清单已部分失效）**：上表六条中 **五条后端已真实发布**——`memory:written`（`Services/SharedMemory/globalWorkspace.ts`，原即已实现）+ 由"需补充"转为已实现的 `memory:version_conflict`（`writeGuard.ts`）、`memory:self_reinforcing`（`longTermMemory.ts`）、`middleware:before_model`（`Core/Middleware/middlewareRegistry.ts`）、`hook:triggered`（`Services/Hook/hookRegistry.ts`）；前端 `useEventBus.ts` 也已按类型分流。**唯一仍为"仅枚举、0 发布点"的是 `memory:superseded`**，故 `Memory.VersionDiff` 的前置依赖是"补发布"而不是"补组件"。另 `delegation:assigned` / `arbitration:request` 经复核确为 0 发布点（无委派引擎）。**字段级差异（实发 payload 与本表预期不符）以 `后端接口契约.md` 的校准注为准**，本节不重复登记。

### 6.2 工具调用事件标准化

当前 `agent:iteration_complete` 携带的 ToolCall 结构需补充字段详见 **`后端接口契约.md` §2.1**。

**核心字段摘要**：

```typescript
interface ToolCall {
  // ... 现有字段
  
  subgroup: 'read' | 'write' | 'exec' | 'system'; // ← 🔴 新增必填
  idempotencyKey?: string; // ← 🟠 新增可选
  riskLevel: 'low' | 'medium' | 'high' | 'critical'; // ← 🔴 新增必填
}
```

**后端实施要求**：
- subgroup 推断逻辑：见 `后端接口契约.md` §2.1 "后端实施要求"
- riskLevel 判定规则：见 `后端接口契约.md` §2.1 "后端实施要求"
- idempotencyKey 生成规则：见 `后端接口契约.md` §2.1 "后端实施要求"

> **2026-10-03 校准（三个"新增必填/可选"字段的实发状态）**：
> - `subgroup` 与 `riskLevel` **已实际下发**：`Interface/IpcBridge/ipcBridge.ts` 的 `onIterationComplete` 在 `payload.toolCalls[]` 上附带 `subgroup: inferSubgroup(tc.name)` 与 `riskLevel: assessRiskLevel(tc.name, tc.arguments)`。注意取值来自 `Core/Middleware/toolCallClassifier.ts` 的**名称规则推断**，**不是工具注册表的显式声明**——与本节"必填"的语义（由工具自述）不同；前端 `harness/ToolGroup.tsx` 另有本地 `inferSubgroup` 兜底，构成双源（§5.3）。
> - `idempotencyKey` **未进该 payload**：目前只存在于 `Infra/DurableExecution/`（`EffectRecord`、`effectJournal.ts`、`idempotencyStore.ts`，键为 SHA-256(toolName + canonicalJson(args) + loopId)），前端 `ToolCallEntry` 无此字段。
> - **需人工裁定（现状记录，本文不裁决）**：`riskLevel` 有两套枚举大小写——`Core/Middleware/toolCallClassifier.ts` 的 `RiskLevel = 'low'|'medium'|'high'|'critical'`（下发给前端的就是这套）与 `Services/LoopControl/types.ts` 的 `RiskLevel = 'LOW'|'MEDIUM'|'HIGH'|'CRITICAL'`（审批门 `approvalGate.ts` 按大写比较）。跨层传递若混用即静默落到默认分支。**字段口径与统一方案归 `后端接口契约.md` §2.1 裁定**，本节只登记前端可见事实。

### 6.3 版本管理与兼容性

后端事件版本管理策略详见 **`后端接口契约.md` §6**。

**核心原则**：
- 已发布的必填字段不可删除
- 新增字段必须可选（第一个版本）
- 枚举值只能扩展，不能删除
- 破坏性变更需提前 2 个版本通知

### 6.4 实施时间表

后端配合任务的详细时间表见 **`后端接口契约.md` §8**。

**关键里程碑**：
- Phase 1（2026-10-07 前）：补充 ToolCall.subgroup/riskLevel
- Phase 2（2026-10-14 前）：实现 memory:* / middleware:* 事件
- Phase 3（2026-10-21 前）：实现 delegation/arbitration 事件 + Pact 契约测试

---

## 7. 风险评估与缓解

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|---------|
| **注册表成为性能瓶颈** | 中 | 高 | 使用 Map 而非数组查找；组件定义缓存 |
| **懒加载导致首次渲染闪烁** | 高 | 中 | 预加载高频族（Core/Harness）；显示 LoadingPlaceholder |
| **组件族边界模糊** | 中 | 中 | 编写明确的族分类指南；Code Review 检查 |
| **后端事件类型变更导致前端崩溃** | 低 | 高 | 注册表查询失败时返回 Fallback 组件；E2E 测试覆盖 |
| **TypeScript 类型推断失效** | 中 | 中 | 使用泛型约束；为每个族定义独立的 Payload 类型 |

> **2026-10-03 校准（五条风险逐条现状）**：
> 1. **注册表成为性能瓶颈** —— 风险暂未成形：注册表在生产中 **0 流量**（§3.3 决策 1），`Map` + `hasComponent` 已由 `typesAndLatency.spec.ts` 做过 O(1) 验证；一旦激活需重测。
> 2. **懒加载导致首次渲染闪烁** —— 缓解措施 **未落地**：既未预加载（`preloadFamily` 无调用方），也 **无 `LoadingPlaceholder`**（全仓未定义），实态是 `Subscribe` 在未解析/无匹配时 `return null` **静默跳过**——不闪，但**也没有任何加载反馈**（同 §4 Phase 3.3、§5.2 校准注）。
> 3. **组件族边界模糊** —— 风险真实存在且在扩大：Loop/Memory/MultiAgent 三族 0 组件、`MiddlewareLog`/`HookTracer` 未建，而 §3.2.1 决策树对 14 个事件域中的约 8 个无归属口径；族分类指南（`开发指南.md`）与 Code Review 检查项均未创建。
> 4. **后端事件类型变更导致前端崩溃** —— 缓解措施 **未落地**：注册表查询失败 **不返回 Fallback 组件**（返回 `null` → `Subscribe` 记入 `missedTypes` 后静默），族级 `FamilyErrorBoundary` 也未装配（§3.4），E2E 亦不覆盖；现存防护只有 `useEventBus` 的 `if (data.messageId)` 一类字段守卫。**本条与 §2.2 校准注的 6 个死名互为因果，是当前最需要先补的一条。**
> 5. **TypeScript 类型推断失效** —— 部分实现：`AIComponentDef<TPayload>` 泛型已到位，但 `types.ts` 内 **未逐族定义 Payload 类型**（族组件 props 各自定义在组件文件 / `chatStore`，如 `ToolCallEntry`），故泛型约束目前只在测试中使用。

---

## 8. 验收标准

### 8.1 功能性验收

- [ ] ChatView 能正确渲染所有现有消息类型（文本/工具调用/思维链）
- [ ] 新增一个 AI 组件只需 3 步：创建组件 → 注册到注册表 → 无需修改其他代码
- [ ] LoopDebugger 能复用 Harness.ToolGroup 展示历史工具调用
- [ ] Memory 族组件能正确响应后端 `memory:*` 事件

> **2026-10-03 校准（四条逐条现状）**：
> 1. **ChatView 渲染现有消息类型** —— ✅ **已达成，但达成路径与本设计不同**：`views/ChatView.tsx → components/Chat/MessageList.tsx → MessageBubble.tsx`，其中族组件的 import **全部集中在 `MessageBubble.tsx`**（`core/MessageShell`、`core/CoTFolder`、`core/StreamBuffer`、`harness/ToolGroup` 四条），`MessageList.tsx` 只 import `MessageBubble` 与本地 `AgentPreparing`；数据来自 `eventStore`/`chatStore`，**不经过注册表与 `Subscribe`**（§3.1、§5.2）。文本/工具调用/思维链三类均可渲染。
> 2. **"只需 3 步"** —— ⚠️ **当前不可达成**：注册到注册表后依然不会生效，因为唯一的注册入口 `ai-components/index.ts` 被 0 个模块 import（§3.3 决策 1 校准注）。今天新增组件实际是 **4 步**：创建组件 → 在 `MessageBubble.tsx` 内补一条 import + 渲染分支（现状是该文件的私有改动，见上条）→ 注册表登记（仅测试用）→ 补测试。本条与 §8.3 第 2 条（30 分钟上手）同源，需在注册表激活后才能复验。
> 3. **LoopDebugger 复用 Harness.ToolGroup** —— ❌ **未达成**：`views/LoopDebugger.tsx` 与 `views/TraceReplay.tsx` 只 import `@/stores/loopStore`（`useLoopStore` + `DomainEvent`），工具调用与中间件日志由各自内联的 JSX 渲染，**未 import `ai-components` 任何符号**，与 `harness/ToolGroup` 存在重复实现（同 §3.2 校准注）。
> 4. **Memory 族响应 `memory:*`** —— ⚠️ **未实现**：`ai-components/memory/index.ts` 的 `registerAll()` 仍为空函数（0 组件注册），后端侧 `memory:superseded` 也尚未发布事件（§6.1）；依赖 §4 Phase 2.3/2.4。

### 8.2 性能验收

- [ ] 首屏加载时间 <2s（Lighthouse 测量）
- [ ] 单次对话渲染 100 个事件时，FPS >50
- [ ] 懒加载组件的平均加载延迟 <200ms

> **2026-10-03 校准（现状：三条均未度量）**：
> - **度量资产缺失**：全仓（`package.json` scripts、`vitest.config.ts`、`.github/workflows/ci.yml`、`Tests/`）**无任何 Lighthouse / FPS / 首屏预算相关配置或脚本**，故本表三条无一条有数据来源；勾选状态保持 `[ ]` 是准确的。
> - **第 3 条口径已失效**：懒加载链路（`ensureFamilyLoaded` ← `registry.resolve` ← `Subscribe`）**在生产中休眠**（§3.3 决策 1），"平均加载延迟"目前无从发生。`Tests/AIComponents/typesAndLatency.spec.ts` 提供的是 **进程内** 基准（事件分发 P99 < 1ms、注册表 O(1) 查询、handler < 0.5ms），与本条 **网络/磁盘 chunk 加载** 口径不同，不能互相替代（同 §4A.5 校准注）。
> - **待办（需人工裁定）**：性能验收是否在"注册表激活"之后再启用；若保留，需先引入浏览器侧度量工具（当前测试栈仅 `vitest` + `jsdom` + `@testing-library/*`，**无 Playwright/Puppeteer 等真实浏览器 runner**，也无 Lighthouse CI 配置，首屏/FPS/chunk 延迟在现有设施下无法测得），并明确 100 事件回放口径（走 `replayAiEvents()` 还是走 store 直渲）。本轮只登记，不裁决。

### 8.3 可维护性验收

- [ ] 每个 AI 组件有独立的单元测试（覆盖率 >80%）
- [ ] 新增开发者能在 30 分钟内完成第一个 AI 组件的开发
- [ ] 文档完整度：开发指南 + API 文档 + 视频教程

> **2026-10-03 校准（现状：1 部分达成 / 2 未达成 / 3 未达成）**：
> 1. **单测覆盖** —— 🟡 **部分达成**：`Tests/AIComponents/` 现有 6 个 spec（`registry.spec.ts` 21 例、`subscribeAndToolGroup.spec.ts`、`components.spec.tsx`、`eventStore.spec.ts`、`eventBusBridge.spec.ts`、`typesAndLatency.spec.ts`），覆盖注册表、`Subscribe`、`ToolGroup`、事件存储与 IPC 桥；但 **">80%" 这个数字目前拿不到**：`ci.yml` 的覆盖率门禁读取 `./coverage/coverage-summary.json`，而 `vitest.config.ts` 的 `coverage.reporter` 是 `['text', 'json', 'html']`（缺 `json-summary`，不产出该文件），仓库内 `coverage/` 目录是 **2026-09-28 的陈旧产物**。族组件侧 `FallbackUI`/`FamilyErrorBoundary` 只有测试内用例，无独立目录级覆盖统计。
> 2. **30 分钟上手** —— ❌ **未达成**：上手路径依赖的"3 步注册"已失效（§8.1 第 2 条），且 `Client/src/ai-components/` 目录下 **无 README / 无开发指南**，新人只能读 `registry.ts` 源码或参照 `MessageBubble.tsx` 的私有分支写法——后者会强化"绕过注册表"的既成路径。
> 3. **文档完整度** —— ⚠️ **未达成**：§4 Phase 4 的三份文档（`AI组件族开发指南.md`、`组件API文档.md`、`AGENTS.md`）均 **未创建**（§4 Phase 4 校准注），视频教程从未有对应资产。
> - **待办（需人工裁定）**：①是否把 `coverage.reporter` 补 `json-summary`（属构建配置，本轮回写未触碰）；②">80%" 与"30 分钟"两项口径是否改为"注册表激活后复测"；③视频教程是否从验收标准中移除。本轮只登记，不裁决。

---

## 9. 后续演进方向

### 9.1 插件化扩展

允许第三方开发者通过 npm 包形式发布新的 AI 组件族：

```typescript
// 第三方插件
import { registry } from '@civitas/ai-components';

registry.register({
  family: 'custom',
  component: MyCustomComponent,
  eventTypes: ['custom:event'],
  metadata: { /* ... */ }
});
```

> **2026-10-03 校准**：§9 三节均为 **⚠️ 目标态**，且共享同一个前置条件——**注册表先被激活**（§3.3 决策 1：`ai-components/index.ts` 目前 0 引用）。逐条现状：
> - §9.1 插件化：`registry.register()` 的入参形态与现行 `AIComponentDef`（`family` / `component` / `eventTypes` / `metadata`）基本吻合，示例可直接用；但 **`@civitas/ai-components` 这个包名不存在**——`ai-components` 未独立打包，`Client/vite.config.ts` 的 `manualChunks` 只配了 core/harness/registry 三类，无插件入口或注册 API 导出面。
> - §9.2 组件生成 CLI：全仓无 `civitas-cli` / `generate-component` 任何痕迹（`package.json` scripts 里只有 `gen:event-types` 与本节无关）。
> - §9.3 可视化编排器：无对应代码或路由。
> 建议保留原文不删（是有效目标态），但排期上应明确：这三节 **不早于 §4 Phase 1.6（统一编排容器）落地**。

### 9.2 AI 辅助组件生成

基于后端事件 Schema，自动生成对应的 React 组件骨架：

```bash
npx civitas-cli generate-component --event-type agent:tool_call
# 输出: ai-components/harness/ToolCall.tsx 骨架文件
```

### 9.3 可视化组件编排器

提供拖拽式 UI，让产品经理能自行编排 AI 组件的显示顺序和布局：

```
[StreamBuffer] → [CoTFolder] → [ToolGroup] → [MemoryCard]
```

---

## 附录 A：与现有设计的兼容性

| 现有设计 | 兼容性 | 说明 |
|---------|--------|------|
| `02-核心架构设计.md` 事件驱动层 | ✅ 完全兼容 | 本设计是事件驱动层的前端实现 |
| `12-循环控制系统设计.md` Verifier | ✅ 兼容 | Loop.VerifierPanel 展示验证结果（**⚠️ 2026-10-03 校准：组件不存在**，Loop 族 `registerAll()` 为空；验证结果目前由 `views/LoopDebugger.tsx` 内联 JSX 展示） |
| `11-配置体系与安全` 中间件钩子 | ✅ 兼容 | Harness.MiddlewareLog 展示钩子拦截日志（**⚠️ 2026-10-03 校准：组件不存在**，Harness 族仅有 `ToolGroup`；钩子/中间件日志由 `views/TraceReplay.tsx` 内联渲染，且后端 `hook:triggered` 已发布但 `registry.inferFamilyFromEventType` 无 `hook:` 分支——见 §3.2.1） |
| `09-用户界面与可观测性设计.md` | 🟠 需修订 | 需补充 AI 组件族的可观测性指标（**2026-10-03 校准：仍未修订**，§4 Phase 4 文档任务未开工） |

> **2026-10-03 校准**：本表"兼容性"一列评的是 **设计层面是否冲突**（结论：不冲突，可保留）；而"说明"一列提到的两个前端组件 `Loop.VerifierPanel`、`Harness.MiddlewareLog` **在 `Client/src/ai-components/` 下均不存在**，属"依赖目标态组件"的兼容声明。也就是说：与 `12-`、`11-` 两份文档的兼容目前 **只体现在事件与数据层面，展示层缺口即 §4 Phase 2/3 未开工部分**。逐条核实结果：
> - **Loop 域（13 条 `loop:*`）中 11 条在 `Src/` 全仓 0 发布点**——`loop:started` / `completed` / `aborted`、`budget_warming` / `soft_reached` / `hard_reached`、`no_progress_stagnated`、`action_fingerprint_duplicate`、`verifier_failed`、`context_compressed`、`approval_timeout_rejected`；它们今天不会经 `ipcBridge.subscribeMany(Object.values(EventType))` 到达前端。
> - **唯一有发布点的 2 条是 `loop:approval_requested`（`Core/AgentRuntime/agentRuntime.ts` + `Services/LoopControl/middleware/toolSafetyGate.ts`）与 `loop:approval_decided`（同前两处 + `Interface/RestApi/approvalApi.ts`）**，可进 `eventStore`。
> - LoopDebugger/TraceReplay 的数据来自 `stores/loopStore.ts` 的 `GET /api/loops/events` HTTP 拉取，与 IPC 事件是两条链路。
> - `middleware:before_model`（`Core/Middleware/middlewareRegistry.ts`）与 `hook:triggered`（`Services/Hook/hookRegistry.ts`）已发布（§6.1），但前端无对应族组件消费。

---

## 附录 B：术语对照表

| 中文 | 英文 | 说明 | 现状（2026-10-03 校准） |
|------|------|------|------|
| AI 组件族 | AI Component Family | 按 Agent 语义分组的组件集合 | 🟡 目录与注册骨架齐备，但 5 族中 **3 族（Loop/Memory/MultiAgent）为空壳**（§2.1） |
| 组件注册表 | Component Registry | 事件类型 → 组件定义的映射表 | 🟡 已实现（精确匹配 + 通配回退 + 族懒加载）且有 `registry.spec.ts` 21 例覆盖，但 **生产 0 流量**（§3.3 决策 1） |
| 统一编排容器 | AIBubbleContainer | 动态渲染 AI 组件的顶层容器 | ⚠️ **未实现 / 目标态**：全仓 0 命中，角色由 `AIEventBus`（Context 注入）+ `eventStore`/`chatStore` → `MessageList` → `MessageBubble` 直渲分担（§0.2、§3.1） |
| 懒加载 | Lazy Loading | 首次匹配事件时触发组件加载 | ⚠️ **目标态**：`preloadFamily`/`ensureFamilyLoaded` 无调用方，`manualChunks` 只配了 core/harness/registry，整条链路休眠（§3.2 补注、§7 第 2 条） |
| 后端事件驱动 | Backend Event-Driven | 后端推送事件类型，前端据此选择组件 | ✅ **前半句已落地、后半句未落地**：推送链路 `Src/Services/EventBus/eventBus.ts` → `ipcBridge` → `preload` → `services/eventBusBridge.ts` → `stores/eventStore.ts` 已在生产运行；"前端据此选择组件"的选择步骤仍是目标态（现由 `MessageBubble` 静态分支完成） |

> **2026-10-03 校准说明**：本表是 **术语对照**，不是实现清单；新增的"现状"列只用于防止把术语当成既有能力。

---

## 10. 修订历史

| 版本 | 日期 | 主要变化 |
|------|------|---------|
| v1.0-draft | 2026-09-28 | 初稿（组件注册中心 + 声明式订阅 + 族懒加载设计）。日期/版本取自本文头部声明；本目录尚未纳入 git，无更细的历史可考 |
| **v1.1 校准** | **2026-10-03** | 依据 `Docs/Dev/Client-03-AI组件族架构-差别清单.md` 中属于本文的 ARCH-01…ARCH-22 逐条复核当前 `Client/src` 后回写（WS→IPC 迁移已完成后的实态）：头部加"代码校准状态"横幅（基建齐 / 编排空 / 消费端零）；§0.1 痛点表与 §0.2（`AIBubbleContainer` 全仓 0 命中）；§2.1 族表增"落地状态"列、§2.2 `AIComponentDef` 改真实泛型签名 + 6 个死名对照表、§2.3（容器未创建、`Subscribe` 0 生产调用、会话隔离因 IPC 帧无 `sessionId` 而不可实现）、§2.4 生命周期仅测试内发生；§3.1 数据流图重绘为 store 驱动链、§3.2 目录树替换为 21 文件清单、§3.2.1 决策树补 `hook:`（目标态）与"第五类：无族归属"、§3.3 决策 1（`ai-components/index.ts` 0 引用）与决策 2（Context vs store 驱动矛盾登记，`useEventBus` 分发 8 个 store）、§3.4（泛型 `FamilyErrorBoundary` 真实实现 + 未装配 + `FallbackUI` 真实形态 + 验收 4 条状态）；§4 Phase 1–4 增状态列（1.1–1.5 ✅、1.6 ⚠️、快照/3.3/3.4/4.1–4.4 ⚠️，`AGENTS.md` 仓库内不存在）；§4A.1–4A.6 按 WS→IPC 完成态改写（`publish(createEvent(...))` 真实调用、preload `contextBridge` + `eventBusBridge` + `startIpcBridge()`、影响面表增实态列、验收勾选销账与 P99 口径现状）；§5.1 注册表改真实 API（`preloadFamily`/`hasComponent`/`matchByWildcard`/`agent:iteration_`、无 `hook:`）+ 使用示例现状记录、§5.2 `AIEventBus`/`Subscribe` 重写为 eventStore 版（`children` 独占渲染、静默 `null`）+ 三场景状态、§5.3 `ToolGroup` 真实 props（`ToolCallEntry[]`）+ `inferSubgroup` 双源登记；§6.1（六条中五条已发布，仅 `memory:superseded` 待补）；§7 五条风险逐条现状；§8.1/§8.2/§8.3 逐条验收状态；§9 ⚠️ 目标态注；附录 A 组件不存在标注 + Loop 域 11/13 无发布点（仅 `loop:approval_requested`/`decided` 已发）核实；附录 B 术语表增"现状"列。行号引用统一改为"文件名 + 组件/符号名"定位。**需人工裁定 4 项以"现状记录 + 待办"登记，本轮未作裁决**：①§3.2.1 族分类对 14 域中约 8 域无归属口径（含 `hook:` 无分支）；②§3.3 决策 2 的 Context vs store 驱动冲突；③§4A.5/§8.2 的 P99 与性能验收口径（进程内基准已存在、端到端未测）；④§8.3 覆盖率与上手时长口径（`coverage-summary.json` 未产出、门禁取不到数）。 |
