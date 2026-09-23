# Changelog

本文件记录 Civitas-AI 项目的所有重要变更。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/)。

---

## [Unreleased]

### 2026-09-15 — 四项前端体验修复

#### 问题 1：聊着聊着就不干活了（Loop 提前退出）
- **根因**：`iterationController.decideIteration` 中，当模型产生文本输出但无工具调用时，立即以 `success` 退出循环。在对话场景中，模型可能先输出中间文本（如"好的，我先看看文件"），随后才调用工具，过早退出导致 Agent 停止工作。
- **修复**：移除 `hasOutput && !hadToolCall → success` 的提前退出条件。循环仅在 `max_iterations` / `budget_exhausted` / `no_progress`（连续 5 轮无输出无工具）时自然终止。
- **文件**：`Src/Core/Loop/iterationController.ts`

#### 问题 2：不能选择工作区（工作方式）
- **根因**：Composer 组件缺少工作方式选择器，用户无法在聊天界面切换工作方式。
- **修复**：Composer 新增工作方式下拉选择器（7 种模式），选中后随消息发送至后端。
- **文件**：`Client/src/components/Chat/Composer.tsx`、`Client/src/views/ChatView.tsx`、`Client/src/stores/chatStore.ts`

#### 问题 3：首个请求不会自动给会话起名
- **根因**：创建会话时标题默认为 "New Chat"，后端无自动命名逻辑。
- **修复**：`wsHandler.tryAutoNameSession` — 首次助手回复完成后，检查会话标题是否仍为 "New Chat"，若是则取首条用户消息前 40 字符作为标题。同时新增 `PATCH /api/sessions/:id` 端点和 `updateSessionTitle` 导出函数。
- **文件**：`Src/Interface/WebSocket/wsHandler.ts`、`Src/Interface/RestApi/chatApi.ts`

#### 问题 4：不能切换同源供应商的模型
- **根因**：`startStreamGeneration` 硬编码使用 `routing.defaultModel`，前端无模型选择 UI。
- **修复**：
  - 后端：`generate_reply` 支持可选 `model` 参数，优先使用客户端指定模型（未注册则回退默认）；新增 `GET /api/models` 端点返回已注册模型列表。
  - 前端：Composer 新增模型下拉选择器，展示所有已注册模型（显示短名 + 供应商），选中后随消息发送。
- **文件**：`Src/Interface/WebSocket/wsHandler.ts`、`Src/Interface/RestApi/chatApi.ts`、`Client/src/components/Chat/Composer.tsx`、`Client/src/views/ChatView.tsx`、`Client/src/stores/chatStore.ts`、`Client/src/services/api.ts`

### 2026-09-15 — Agent 迭代行为与工具调用前端显示修复

#### 问题
- 前端无法显示 Agent 迭代轮次和工具调用/结果信息

#### 根因
- 后端 `wsHandler.startStreamGeneration` 仅发布 `AGENT_STREAM_CHUNK`（文本）和 `AGENT_STREAM_END` 事件
- `LoopExecutionResult` 中的 `iterations[].toolCalls` / `toolResults` 从未推送到前端

#### 修复
- **后端** `eventTypes.ts`：新增 `AGENT_ITERATION_COMPLETE` 事件类型
- **后端** `wsHandler.ts`：`executeLoop` 完成后，遍历每次迭代发布工具调用/结果事件
- **前端** `shared/eventTypes.ts`：同步新增事件常量
- **前端** `chatStore.ts`：`ChatMessage` 新增 `toolCalls` / `totalIterations` 字段；新增 `applyIterationComplete` 方法合并工具调用与结果
- **前端** `useWebSocket.ts`：处理 `AGENT_ITERATION_COMPLETE` 事件
- **前端** `MessageBubble.tsx`：新增工具调用区块渲染（可折叠，显示名称/参数/结果/错误状态）+ 迭代轮次显示

#### 涉及文件
- `Src/Services/EventBus/eventTypes.ts`
- `Src/Interface/WebSocket/wsHandler.ts`
- `Client/src/shared/eventTypes.ts`
- `Client/src/stores/chatStore.ts`
- `Client/src/hooks/useWebSocket.ts`
- `Client/src/components/Chat/MessageBubble.tsx`

### 2026-09-15 — 对话页卡片化重构（v2：正方形 Agent 卡片 + 侧栏布局）

#### 新增
- **`Conversation` / `AgentCard` 类型**：对话（conversation_id → agents 一对多）+ L1 级 Agent 卡片数据模型
- **`ConversationCard`** 组件：正方形 Agent 卡片（aspect-ratio: 1/1），显示工作方式徽章、Bot 图标、标题、会话 ID、时间戳
- **`ConversationSidebar`** 组件：右侧纵向对话列表（长条型），显示对话标题、Agent 数量、相对时间、状态圆点
- **`ChatView` 三栏布局**：顶部标题栏 + 左侧主区域（Agent 卡片横排 + 聊天区）+ 右侧对话列表

#### 变更
- **`chatStore` 重构**：新增 `conversations`、`activeConversationId`、`activeAgentSessionId` 状态；新增 `setActiveConversation`、`setActiveAgent` 操作
- **`ConversationGrid` 重写**：从递进放缩网格改为 Agent 卡片横向排列区
- **`ChatView` 重写**：移除旧版网格态/展开态双态布局，改为左侧主区域 + 右侧对话列表布局
- **`index.css` 重写**：替换旧版卡片网格样式为新的布局 / 正方形卡片 / 侧栏样式

#### 涉及文件
- `Client/src/stores/chatStore.ts`（类型扩展 + 状态重构）
- `Client/src/components/Chat/ConversationCard.tsx`（重写为正方形 Agent 卡片）
- `Client/src/components/Chat/ConversationGrid.tsx`（重写为 Agent 卡片横排区）
- `Client/src/components/Chat/ConversationSidebar.tsx`（新增 — 右侧纵向对话列表）
- `Client/src/views/ChatView.tsx`（重写为三栏布局）
- `Client/src/index.css`（样式重写）

### 2026-09-15 — 中间件类型契约下沉至 Infra 共享内核

#### 重构
- **中间件类型契约下沉**：将 `AgentMiddleware`、`MiddlewareContext`、`ModelCallInput/Output`、`ToolCallInput/Output`、六钩子函数类型、`HookFunction`、`MiddlewareHook` 从 `Core/Middleware/types.ts` 整体迁移至 `Src/Infra/Contracts/middlewareTypes.ts`，作为单一真相源；原文件已删除
- **消除 6 处 Services → Core 类型级反向依赖**：`Services/LoopControl/middleware/` 下 6 个中间件实现（toolSafetyGate、stopRuleEvaluator、goalReanchorControl、fingerprintDetectorControl、budgetSentinelControl、checkpointWriter）全部改为从 `Infra/Contracts/middlewareTypes.js` 导入，满足五层单向依赖红线
- **Core 内部消费方重指向**：`middlewareRegistry.ts`、`index.ts`、4 个 builtin 中间件、`runIteration.ts` 共 7 处改为从 Infra 契约导入
- **测试消费方重指向**：`Tests/Runtime/runtime.spec.ts` 改为从 Infra 契约导入

#### 新增
- **`Src/Infra/Contracts/`** 目录：跨层共享内核契约存放处（纯类型、零运行时、零上层 import）
- **`Src/Infra/Contracts/middlewareTypes.ts`**：中间件类型契约单一真相源
- **`Src/Infra/Contracts/index.ts`**：桶文件聚合导出
- **`ADR/0006-middleware-contract-relocated-to-infra.md`**：记录契约下沉决策、被否方案与适用边界

#### 删除
- **`Src/Core/Middleware/types.ts`**：已迁移至 Infra/Contracts，不保留 re-export shim

#### 设计文档同步
- `Docs/02-核心架构/核心架构设计.md` §2 目录骨架：Infra 下补 `Contracts/`；Core/Middleware 注明引擎实现在此、类型契约见 Infra/Contracts；ADR 目录补 0006

#### 已知遗留（独立跟进）
- `Services/Recruitment/recruiter.ts` 与 `Services/ReviewerAgent/reviewerAgent.ts` 存在对 `Core/AgentRuntime/*` 的运行时级 Services→Core 反向依赖，需依赖倒置方案单独治理
- ESLint `import/no-restricted-paths` 因 resolver 加载异常当前无法实际执行层间门禁校验

### 2026-09-15 — Agent 权限模型与工具可见性修复

#### 新增
- **`getVisibleToolsForRole()`**：按 `requiredRoles` 主门禁过滤工具集，L0 治理级兜底可见所有非 FORBIDDEN 工具
- **`ROLE_FORBIDDEN` 硬校验**：`executeTool()` 执行前校验调用者角色是否在工具 `requiredRoles` 白名单中
- **`unregisterMiddleware()`**：中间件注册表支持按名称注销
- **`getOrCreateEntryAgent()`**：wsHandler 幂等创建入口 Agent（prime_director），多次请求不重复创建
- **`MiddlewareContext.agentRole`**：中间件上下文新增调用者角色字段
- **集成测试** `agentPermissionSplit.spec.ts`：12 项测试覆盖三级信任模型的工具可见性与执行门禁

#### 变更
- **信任模型重划**（三级）：
  - L0 治理级：`regulator`、`auditor`、`arbitrator` — 监管、审计、仲裁，最高权限
  - L1 入口级：`prime_director`、`partner` — 接收用户输入、递归派发子 Agent、协作
  - L2 执行子级：`worker`、`reviewer`、`assembly_node` — 仅执行上级派发任务
- **`UserRole` 类型统一**：从 `Infra/types.ts` 单一真相源导出，消除 `AgentRole`(4值) 与 `UserRole`(8值) 的类型分裂
- **主循环 ④ 上下文装配**：由 `getAllToolSpecs()` 改为 `getVisibleToolsForRole(role)`，仅将当前角色可见工具传给模型
- **toolSafetyGate 挂载**：在 `executeLoop()` 入口注册、退出时注销，Loop 实例级生命周期
- **工具 `requiredRoles` 更新**：`agentRecruiter`、`shellRunner`、`codeSandbox` 补入 `partner`
- **wsHandler 入口角色**：由硬编码 `agentRole: 'worker'` 改为 `prime_director`

#### 修复
- 入口 Agent 不存在问题：所有用户请求不再降级为 worker 身份
- 工具可见性未按角色裁剪问题：模型现在只看到当前角色有权使用的工具
- `requiredRoles` 仅在模型侧软过滤、运行时无硬校验问题：现在 `executeTool()` 执行前做角色白名单校验

#### 涉及文件
- `Src/Infra/types.ts`、`Src/Infra/Security/trustLevels.ts`
- `Src/Core/AgentRuntime/types.ts`、`Src/Core/AgentRuntime/agentFactory.ts`
- `Src/Core/Loop/runIteration.ts`
- `Src/Core/Middleware/types.ts`、`Src/Core/Middleware/middlewareRegistry.ts`
- `Src/Tools/Factory/toolFactory.ts`、`Src/Tools/Registry/toolRegistry.ts`
- `Src/Tools/Traits/toolSpec.ts`
- `Src/Tools/Custom/agentRecruiter.ts`、`Src/Tools/Builtin/Execute/shellRunner.ts`、`Src/Tools/Builtin/Execute/codeSandbox.ts`
- `Src/Interface/WebSocket/wsHandler.ts`
- `Configs/security.json`、`Src/main.ts`
- `Tests/Infra/security.spec.ts`、`Tests/Tools/tool.spec.ts`
- `Tests/Integration/agentPermissionSplit.spec.ts`（新增）

#### 设计文档同步
- `Docs/02-核心架构/核心架构设计.md` §3.2 角色与工具权限模型
- `Docs/03-Agent能力模型/Agent能力模型.md` §递归派发与角色模型
- `Docs/11-配置体系与安全/配置体系与安全设计.md` §3.2 信任分级表
- `Docs/15-参数总典与接口约束/参数总典.md`

#### 已知事项
- WS chunk 事件推送路由（事件总线 → WebSocket 客户端）存在预存问题，与本次权限模型修改无关
- `agent.recruit` 工具当前仅声明角色白名单，实际递归派发逻辑待后续实现
