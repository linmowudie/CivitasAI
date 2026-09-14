# Tools 层接口文档

> Tools 层：工具注册、执行、安全管控。
> 依赖方向：Tools → Infra

---

## 1. Registry (`Src/Tools/Registry/`)

| 函数 | 签名 | 说明 |
|------|------|------|
| `registerTool` | `(def: ToolDefinition) → Result<void>` | 注册工具（缺字段拒注） |
| `registerTools` | `(defs: ToolDefinition[]) → Result<number>` | 批量注册 |
| `executeTool` | `(name, input, ctx: ToolExecutionContext) → Promise<ToolResult>` | 统一执行入口（含超时） |
| `getTool` | `(name: string) → ToolDefinition \| undefined` | 查找工具 |
| `getToolsByDangerLevel` | `(level: string) → ToolSpec[]` | 按危险级别过滤 |

---

## 2. Traits (`Src/Tools/Traits/`)

### ToolSpec 必填字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | `string` | 全局唯一 |
| `version` | `string` | 语义化版本 |
| `dangerLevel` | `SAFE \| CONTROLLED \| DANGEROUS \| FORBIDDEN` | 危险分级 |
| `idempotency` | `YES \| NO \| CONDITIONAL` | 幂等性声明 |
| `reversibility` | `REVERSIBLE \| PARTIAL \| IRREVERSIBLE` | 可逆性声明 |
| `sideEffectScope` | `none \| workspace \| filesystem \| network \| process \| external` | 副作用范围 |

### ToolResult

| 字段 | 类型 | 说明 |
|------|------|------|
| `role` | `'tool'` | 固定值 |
| `tool_call_id` | `string` | 调用 ID |
| `status` | `'success' \| 'error'` | 执行状态 |
| `recoverable` | `boolean` | 是否可恢复 |
| `content?` | `unknown` | 返回内容 |
| `error?` | `ToolError` | 错误信息 |

---

## 3. Factory (`Src/Tools/Factory/`)

| 函数 | 签名 | 说明 |
|------|------|------|
| `getVisibleTools` | `(role: string) → ToolSpec[]` | 按角色过滤可见工具 |
| `isToolVisible` | `(name, role) → boolean` | 检查工具对角色可见 |
