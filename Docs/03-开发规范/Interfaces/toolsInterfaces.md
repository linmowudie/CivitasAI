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

> **2026-09-22 校准**：本表原仅列 6 项；实际注册校验由 `Traits/specValidator.ts:35-100` 强制执行 **11** 项必填（缺任一即拒注），并另有两条规则：`idempotency ≠ NO` 时必须提供非空 `idempotencyKeyFields`（:71）；`FORBIDDEN` 级工具不允许注册（:112）。

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | `string` | 全局唯一 |
| `version` | `string` | 语义化版本 |
| `description` | `string` | 工具描述 |
| `inputSchema` | `object` | 入参 Schema（结构递归校验） |
| `outputSchema` | `object` | 出参 Schema（结构递归校验） |
| `dangerLevel` | `SAFE \| CONTROLLED \| DANGEROUS \| FORBIDDEN` | 危险分级（FORBIDDEN 拒注） |
| `idempotency` | `YES \| NO \| CONDITIONAL` | 幂等性声明 |
| `idempotencyKeyFields?` | `string[]` | `idempotency ≠ NO` 时必填且非空 |
| `reversibility` | `REVERSIBLE \| PARTIAL \| IRREVERSIBLE` | 可逆性声明 |
| `sideEffectScope` | `none \| workspace \| filesystem \| network \| process \| external` | 副作用范围 |
| `requiredRoles` | `string[]` | 非空数组 |
| `sandboxMode` | `strict \| standard \| none` | 沙箱模式（`toolSpec.ts:34` / `specValidator.ts:93`） |
| `timeoutMs` | `number > 0` | 执行超时 |

### ToolResult

| 字段 | 类型 | 说明 |
|------|------|------|
| `role` | `'tool'` | 固定值 |
| `tool_call_id` | `string` | 调用 ID |
| `status` | `'success' \| 'error'` | 执行状态 |
| `recoverable` | `boolean` | 是否可恢复 |
| `content?` | `unknown` | 返回内容 |
| `error?` | `ToolError` | 错误信息 |
| `effects?` | `string[]` | 实际产生的副作用清单（2026-09-22 校准补录，`toolSpec.ts:117`） |
| `artifacts?` | `ArtifactEntry[]` | 产出物引用（2026-09-22 校准补录，`toolSpec.ts:118`） |

---

## 3. Factory (`Src/Tools/Factory/`)

> **2026-09-22 校准**：本表原签名与代码不符，已按 `toolFactory.ts` 实际导出更正。

| 函数 | 签名 | 说明 |
|------|------|------|
| `getVisibleTools` | `(config: RoleToolConfig) → ToolSpec[]` | 按角色工具配置过滤可见工具（`toolFactory.ts:40`，非"按角色字符串"） |
| `getVisibleToolsForRole` | `(role: UserRole) → ToolSpec[]` | 按角色过滤可见工具（`toolFactory.ts:75`，运行期消费者 `Core/Loop/runIteration.ts:38`） |
| `isToolVisible` | `(toolName: string, role: UserRole) → boolean` | 检查工具对角色可见（`toolFactory.ts:91`，role 类型为 `UserRole` 非 `string`） |

### 相关模块（2026-09-22 校准补录）

§1"缺字段拒注"的实际执行者为 `Traits/specValidator.ts`；工具实现位于 `Builtin/`（经 `builtinLoader.ts` 装载）与 `Custom/`。

---

## 修订记录

| 日期 | 说明 |
|------|------|
| 2026-09-22 | 文档-代码对账校准：ToolSpec 必填字段表补全至 11 项（含 idempotencyKeyFields 条件必填、FORBIDDEN 拒注规则）；ToolResult 补录 effects/artifacts；§3 Factory 三函数签名更正并补 `getVisibleToolsForRole`；补录 specValidator/Builtin/Custom/builtinLoader |
