# 完整使用指南

> 从零到一掌握 Civitas-AI 的核心概念与高级用法

---

## 1. 架构概览

Civitas-AI 采用 **五层单向依赖** 架构：

```
Interface → Core → Services → Tools → Infra
```

- **Interface 层**：HTTP/WebSocket 接口，接收用户输入
- **Core 层**：Agent 运行时、主循环执行器、中间件注册表
- **Services 层**：监管、仲裁、Token 经济、上下文管理等业务逻辑
- **Tools 层**：内置工具 + 自定义工具 + 工具注册表
- **Infra 层**：数据库、日志、LLM 调用、安全、配置等基础设施

## 2. 核心概念

### 2.1 Loop（循环）

Loop 是 Civitas-AI 的核心执行单元。每次用户任务对应一个 Loop，包含多轮迭代。

每轮迭代执行 **十步序列**：

| 步骤 | 名称 | 说明 |
|------|------|------|
| ① | 输入接收 | Interface → Core |
| ② | 前置监管 | 注入检测 + 频率限制 + 权限验证 |
| ③ | 中间件管线 | beforeAgent / beforeModel 钩子 |
| ④ | 上下文组装 | 四级分区（S/L/M/H）上下文装配 |
| ⑤ | 监管懒监听 | compress/summary/reasoning/loop 四监管 |
| ⑥ | 模型调用 | wrapModelCall 中间件包裹 |
| ⑦ | 输出解析 | 文本/工具调用/混合解析 |
| ⑧ | 工具执行 | wrapToolCall + 危险分级管控 |
| ⑨ | 后置监管 | 异常扫描 + 退出决策 |
| ⑩ | 迭代判定 | StopRules 五类退出判定 |

### 2.2 Agent 角色

| 角色 | 信任级别 | 职责 |
|------|---------|------|
| Prime Director | L0 | 任务分解与调度 |
| Partner | L1 | 协同推理与方案评审 |
| Worker | L1 | 具体任务执行 |
| Reviewer | L1 | 产出质量审核 |
| Assembly Node | L1 | 流水线处理节点 |
| Arbitrator | L0 | 冲突裁决 |
| Auditor | L0 | 资源审计 |
| Regulator | L0 | 行为监管 |

### 2.3 Token 经济

系统采用双预算制：
- **warm 区间**（36%）：正常执行
- **soft 区间**（60%）：预警，开始收敛
- **expand 区间**（80%）：可申请扩展
- **hard 区间**（100%）：强制停止

### 2.4 Verifier 四级验证

L1 硬验证（test/schema/numeric）→ L2 规则验证 → L3 LLM Judge → L4 人类审批门

## 3. 配置详解

详见 [configuration.md](configuration.md)。

## 4. 工具开发

### 4.1 创建自定义工具

在 `Src/Tools/Custom/` 下创建工具定义文件：

```typescript
import type { ToolDefinition } from '../Traits/toolSpec.js';

export const myTool: ToolDefinition = {
  name: 'my.custom_tool',
  version: '1.0.0',
  dangerLevel: 'CONTROLLED',
  idempotency: 'NO',
  reversibility: 'REVERSIBLE',
  sideEffectScope: 'workspace',
  execute: async (ctx) => {
    // 工具逻辑
    return { success: true, output: '...' };
  },
};
```

### 4.2 工具危险分级

| 级别 | 说明 | 执行约束 |
|------|------|---------|
| SAFE | 无副作用 | 直接执行 |
| CONTROLLED | 有副作用但可逆 | 走 EffectJournal |
| DANGEROUS | 高危险 | 需 ApprovalGate |
| FORBIDDEN | 禁止使用 | 系统拒绝 |

## 5. 提示词管理

详见 [prompt-storage](../../skills/prompt-storage.md)。

- 角色提示词：`Prompts/roles/{role}.md`
- 系统提示词：`Prompts/system/mainLoop.md`
- 任务模板：`Prompts/tasks/defaultTask.md`
- 版本清单：`Prompts/versions/manifest.json`

## 6. 监控与调试

### 6.1 日志

日志位于 `Logs/` 目录，JSON Lines 格式，支持文件轮转。

### 6.2 事件追踪

每个操作都有 `trace_id`，可通过事件总线查询完整链路。

### 6.3 数据库

SQLite 数据库位于 `Data/db/`：
- `civitas_main.db`：主数据（Loop、Agent、策略等）
- `civitas_events.db`：事件日志
- `civitas_memory.db`：共享记忆
