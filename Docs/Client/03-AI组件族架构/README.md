# AI 组件族架构 - 文档索引

> **设计目标**：将前端 UI 元素按 Agent 运行时概念（Loop/Harness/Memory/MultiAgent）分组，形成可独立演进、按需加载、后端事件驱动的"AI 组件族"体系。
>
> **关联审查**：`../../99-审查记录/设计审查报告-AI组件族架构.md`（2026-10-03 校准：原写 `../99-审查记录/…`，该相对路径在本目录下不存在，已修正为仓库实际位置）
>
> **当前状态**：⚠️ 原"Phase 1 准备就绪，待开工"已过时 —— **2026-10-03 校准**：Phase 1 的基建部分（目录骨架、`registry.ts`、Core 族 3 件、Harness.ToolGroup、`AIEventBus`/`Subscribe`/`FamilyErrorBoundary`/`FallbackUI` + `Tests/AIComponents/` 6 spec）**已交付**；但 **统一编排容器 `AIBubbleContainer` 从未创建**、注册表 **在应用中 0 引用**、Phase 2/3 **未开工**。判定口径与主设计文档头部"基建齐、编排空、消费端零"一致。

---

## 文档清单

| 文档 | 用途 | 阅读对象 |
|------|------|---------|
| **[AI组件族架构设计.md](./AI组件族架构设计.md)** | 主设计文档，定义核心概念、架构、实施计划 | 前端开发 / 架构师 |
| **[测试策略设计.md](./测试策略设计.md)** | 单元测试/快照测试/E2E测试方案 | 前端开发 / QA |
| **[后端接口契约.md](./后端接口契约.md)** | 后端事件（EventEmitter/IPC）Schema 规范，前后端协作契约 | 前端开发 / 后端开发 |

---

## 快速导航

### 想了解设计理念？
→ 阅读 `AI组件族架构设计.md` §0-§2（问题陈述 + 业界参考 + 核心概念）

### 想开始开发组件？
→ 阅读 `AI组件族架构设计.md` §3.2.1（组件族分类决策树）

### 需要了解注册表 API？
→ 阅读 `AI组件族架构设计.md` §5.1（含泛型类型安全）

### 需要编写测试？
→ 阅读 `测试策略设计.md` §1-§3（单元/快照/集成测试示例）

### 需要对接后端事件？
→ 阅读 `后端接口契约.md` §2-§5（Harness/Memory/MultiAgent 事件 Schema）

### 需要配置 Vite 分包？
→ 阅读 `测试策略设计.md` §4.4（Bundle Analyzer 配置）

> **2026-10-03 校准**：本索引指向主文档的小节均已按当前代码回写——§3.2.1 决策树补了 `hook:`（⚠️ 目标态）与"第五类：无族归属"、§5.1 已改写为 `registry.ts` 的真实 API（其"使用示例"仍是目标态，照抄会挂）、§4A 为 WS→IPC 迁移**完成态**。上手前请先读小节内的校准注。指向 `测试策略设计.md` / `后端接口契约.md` 的导航行本轮未改动（由对应文档的校准代理负责）。

---

## 核心概念速查

### AI 组件族分类

| 族名 | 后端事件前缀（⚠️ 2026-10-03 校准为真实枚举名） | 典型组件 | 落地状态 |
|------|-------------|---------|---------|
| **Loop 族** | `loop:*`（13 条）/ `task:*`（7 条） | IterationCard, BudgetTracker, VerifierPanel | ⚠️ **空壳**：`loop/index.ts` 的 `registerAll()` 为空；事件侧 13 条中 **11 条 0 发布点**，仅 `loop:approval_requested` / `loop:approval_decided` 已发布 |
| **Harness 族** | `agent:tool_call_pending/started/result` / `middleware:before_model` / `hook:triggered` | ToolGroup ✅, MiddlewareLog ⚠️, HookTracer ⚠️ | 🟡 **仅 `ToolGroup`**；族前缀 `agent:tool_*` / `middleware:*` 能匹配真实事件，**死名是注册表里的裸名** `agent:tool_call` / `agent:tool_result`（§2.2）；`hook:triggered` 已发布但 `registry` 无 `hook:` 分支 → 前端无消费者 |
| **Memory 族** | `memory:written` / `version_conflict` / `self_reinforcing` / `superseded` | MemoryCard, VersionDiff, ReinforceAlert | ⚠️ **空壳**；后端 3/4 已发布（仅 `memory:superseded` 待补）→ 阻塞点已从"等事件"变"等组件" |
| **MultiAgent 族** | `delegation:assigned` / `arbitration:*`（9 条） | DelegationTree, ConsortiumVote, ArbitrationFlow | ⚠️ **空壳** + `delegation:assigned` / `arbitration:request` 后端 0 发布点（无委派引擎），双重阻塞；注：`arbitration:` 域共 9 条，除 `request` 与 `deadlock` 外 **7 条有真实 `publish()` 点**（`Services/Arbitration/tribunal.ts`、`Services/Regulation/finalArbiter.ts` 等） |
| **Core 族** | `agent:stream_chunk` / `agent:stream_end`（✅ 存在）+ `agent:chat_message`（✅，实际渲染链用） | StreamBuffer, CoTFolder, MessageShell | ✅ **3/3 已交付并被 `MessageBubble` 直接 import**；`StreamBuffer` 登记的 `agent:stream_*` 是真实名，**`CoTFolder`/`MessageShell` 的 `agent:reasoning_*` / `agent:message_*` 4 个均为死名**（§2.2） |

> **2026-10-03 校准**：上表事件前缀列已按 `Src/Services/EventBus/eventTypes.ts`（**72 条 / 14 域**）与 `Client/src/shared/eventTypes.ts`（镜像 71 条，缺 `agent:todo_updated`）改写；族内注册死名清单见主文档 §2.2，`ai-components` 内 **0 处** import `@/shared/eventTypes` 的违规也登记在该节。

### 组件族分类决策树

```
1. 是否响应后端事件（EventEmitter/IPC）?
   ├─ 否 → components/<Domain>/ (传统组件)
   └─ 是 ↓

2. 事件类型前缀是什么?                          ← 2026-10-03 校准（与主文档 §3.2.1 同口径）
   ├─ loop:/task: → Loop 族
   ├─ agent:tool_:/middleware:/hook: → Harness 族        ← hook: 为 ⚠️ 目标态，代码未识别
   ├─ memory: → Memory 族
   ├─ delegation:/arbitration: → MultiAgent 族
   ├─ agent:stream_:/agent:message_ → Core 族            ← ⚠️ 枚举无 agent:message_*，真实相邻名 agent:chat_message
   └─ 第五类：无族归属（token:/regulation:/audit:/durable:/system:/chat:/agent: 生命周期）
        → 传统 components/<Domain>/ 或 store 直连（现状：token:→tokenStore、agent: 生命周期→agentStore、task:*→taskStore）
```

> ⚠️ **2026-10-03 校准**：本树是"应然"口径。实际 `registry.inferFamilyFromEventType()` **只有 `agent:iteration_` 特判、没有 `hook:` 分支**，因此 `hook:triggered` 目前无法被归入任何族；14 个事件域中约 8 个无归属口径。已作为【需人工裁定】项登记在主文档 §3.2.1 的"现状记录 + 待办"，本索引不裁决。

---

## 实施计划

### Phase 1: 抽离现有组件（1-2 周）

**目标**：将 `MessageBubble` 拆分为 Core 族 + Harness 族组件，建立注册表机制。

| 任务 | 交付物 | 验收标准 | 状态（2026-10-03 校准） |
|------|--------|---------|------------------------|
| 创建目录结构 | `ai-components/` 骨架 | TypeScript 编译通过 | ✅ 五族目录 + 根基建齐备 |
| 实现注册表 | `registry.ts` | 能注册/查询组件 | ✅ 已交付且 `registry.spec.ts` 21 例覆盖；⚠️ 生产 0 引用（主文档 §3.3 决策 1） |
| 抽离 Core 族 | StreamBuffer/CoTFolder/MessageShell | 视觉无变化 | ✅ 三件已交付；⚠️ 无快照测试，"视觉无变化"仅结构断言背书 |
| 抽离 Harness.ToolGroup | 从 MessageBubble 提取工具面板 | 支持 read/write/exec/system 四种子样式 | ✅ 已交付（+ `ToolCallItem` / `InlineApproval` 增强） |
| 实现 AIBubbleContainer | 统一编排容器 | 能根据事件类型动态渲染 | ⚠️ **未实现**：全仓 0 命中，Phase 1 唯一未交付项 |
| 改造 ChatView | 使用 AIBubbleContainer | 功能回归测试通过 | 🟡 **部分**：`ChatView` 用 `AIEventBus` 包 props 驱动的 `MessageList`，消息源为 `chatStore`，**未使用容器** |

**预计完成时间**：2026-10-11（**2026-10-03 校准**：6 项中 4 ✅ / 1 🟡 / 1 ⚠️，收敛点是"注册表激活 + 容器装配"）

### Phase 2: 补全缺失组件（2-3 周）

**目标**：实现 Memory 族和 MultiAgent 族。

**预计完成时间**：2026-10-28（**2026-10-03 校准**：未开工；阻塞点已从"等后端事件"转移到"等组件 + 等注册表激活"，仅 `delegation:assigned` / `arbitration:request` / `memory:superseded` 仍缺后端发布）

### Phase 3: 动态加载优化（1 周）

**目标**：按族分包，优化首屏加载性能。

**预计完成时间**：2026-11-04（**2026-10-03 校准**：`manualChunks` 已配 core/harness/registry，三个空族无 chunk；懒加载机制已实现但生产中不触发，性能验收无度量设施）

---

## 关键里程碑

| 日期 | 里程碑 | 交付物 | 状态（2026-10-03 校准） |
|------|--------|--------|------------------------|
| 2026-09-28 | 设计文档完成 | 主设计 + 测试策略 + 后端契约 | ✅ 三份文档已交付（本次为按代码回写校准） |
| 2026-10-07 | 后端 Phase 1 | ToolCall.subgroup/riskLevel 字段补充 | ✅ **已提前下发**：`ipcBridge.ts` 在 `agent:iteration_complete` 的 `toolCalls[]` 上附 `subgroup`/`riskLevel`（来自 `toolCallClassifier.ts` 推断）；`idempotencyKey` 仍未进 payload（主文档 §6.2） |
| 2026-10-11 | 前端 Phase 1 | Core/Harness 族抽离完成 | 🟡 组件抽离完成，**容器未建 + 注册表未接入 bundle** |
| 2026-10-14 | 后端 Phase 2 | memory:*/middleware:* 事件实现 | ✅ **大部分已发布**：`memory:written`/`version_conflict`/`self_reinforcing`、`middleware:before_model`、`hook:triggered`；仅 `memory:superseded` 未发（主文档 §6.1） |
| 2026-10-28 | 前端 Phase 2 | Memory/MultiAgent 族实现 | ⚠️ 未开工（两族目录仍为空壳） |
| 2026-11-04 | 前端 Phase 3 | 懒加载优化 + 性能验收 | ⚠️ 未开工；性能验收目前**无任何度量设施**（主文档 §8.2） |

---

## 联系人

| 角色 | 负责人 | 联系方式 |
|------|--------|---------|
| 前端架构师 | _________ | _________ |
| 后端接口负责人 | _________ | _________ |
| QA 负责人 | _________ | _________ |

---

## 更新日志

| 版本 | 日期 | 变更内容 |
|------|------|---------|
| v1.0 | 2026-09-28 | 初始版本，完成设计文档 + 测试策略 + 后端契约 |
| **v1.1 校准** | **2026-10-03** | 依据 `Docs/Dev/Client-03-AI组件族架构-差别清单.md` 中属主设计文档的 ARCH-01…ARCH-22 逐条复核 `Client/src` 后回写 **`AI组件族架构设计.md`** 与本 README 索引（族表/决策树/Phase 表/里程碑已对齐代码实态，行号引用改为"文件名 + 符号名"）。`测试策略设计.md`、`后端接口契约.md` 由各自代理处理，本行不涉及。登记为【需人工裁定】而未裁决：族分类覆盖面（含 `hook:` 无分支）、Context vs store 驱动冲突、P99 与性能验收口径、覆盖率与上手时长口径、`riskLevel` 大小写双源（口径归后端契约）。 |
