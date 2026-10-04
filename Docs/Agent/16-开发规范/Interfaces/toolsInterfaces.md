# Tools 层接口文档

> Tools 层：工具注册、执行、安全管控。
> 依赖方向（规范）：Tools → Infra

---

## 0. 依赖方向现状与待办（2026-10-03 校准新增，T-12）

上方"Tools → Infra"是**规范声明**；代码实态已出现越层上行依赖，本文档按"只记录现状、不擅自裁决"的口径登记（与 servicesInterfaces.md 的"现状+待办"段同构）。

| 违规位置（文件 → 符号） | 越层 import | 门禁实测 |
|---|---|---|
| `Src/Tools/Custom/agentRecruiter.ts` → 头部 import（`agentRecruiter` 定义之前） | `../../Services/Recruitment/recruiter.js`（`recruitAgent` / `getRecruitedAgents`，值导入）、`../../Core/AgentRuntime/types.js`（`AgentRole`，类型导入） | `import/no-restricted-paths` **2 errors**："Tools 层不可依赖上层（Services/Core/Interface）" |
| `Src/Tools/Builtin/Plan/todoWriter.ts` → 头部 import（`todoWriter` 定义之前） | `../../../Services/Planning/todoStore.js`（`replaceTodos` / `listTodosForAgent` / `MAX_TODOS_PER_AGENT` / `TodoStatus`） | 同规则 **1 error**（**2026-10-03 校准新增**：差别清单 T-12 仅记 agentRecruiter，此处为第二处破口） |

- 现状合计 **2 个文件 / 3 处越层 import**；`npx eslint Src/Tools` 实测 `✖ 20 problems (3 errors, 17 warnings)`，error 级为 **CI 阻断项**。
- 【需人工裁定】T-12 待办（三选一，未裁决）：①把 `agent.recruit` 类工具上移到 Services/Core 侧；②经 `Src/Core/index.ts` 门面 + 依赖注入解耦（`todo.write` 同理，把 todoStore 读写交回调用方注入）；③调整门禁 zone 承认“工具直连业务模块”并同步改写本文档的依赖方向声明。

> **✅ 已裁决并修复（2026-10-04，FE-064~072 批次收口）**：采纳**方案②（依赖注入解耦）**——新增 `Src/Tools/Registry/toolServicePorts.ts`（Tools 层端口接口 + `configure/get/reset`），组合根 `Src/main.ts` ⑫.6 启动时注入真实实现（`toolResultCache`/`dispatchHook`/`todoStore`/`memoryRetrieverFactory`/`recruitment`/`review`）；未注入时增强项（缓存/Hook）静默跳过、工具项如实 `NOT_ENABLED`（不伪造成功）。门禁 zone 红线**未放宽**：`npx eslint Src/` 实测 **0 errors**（218 warnings）。上述两个文件（`agentRecruiter.ts`/`todoWriter.ts`）及 `submitForReview.ts`/`vectorSearch.ts`/`toolDispatcher.ts` 均已改为经端口访问上层能力；`Infra/Db/Repositories/*` 对 `Services/AccountScope` 的直连也随属主上下文下移 `Src/Infra/AccountScope/activeAccount.ts` 一并消除（详见缺陷清单第四批分层修正段）。
- 入站消费面（**下行方向，合规**，2026-10-03 校准登记）：`Services/LoopControl/middleware/toolSafetyGate.ts` 用 `getTool`；`Interface/RestApi/toolsApi.ts` 用 `getAllToolSpecs`；`Core/Loop/runIteration.ts` 用 `dispatchToolCall` + `buildToolHeader`；`Src/main.ts` 用 `setToolHeaderConfig`。

---

## 1. Registry (`Src/Tools/Registry/`)

### 1.1 `toolRegistry.ts` 导出（2026-10-03 校准补全至 10 项，T-07）

| 函数 | 签名 | 说明 |
|------|------|------|
| `registerTool` | `(definition: ToolDefinition) → Result<void>` | 注册工具：先过 `validateToolSpec`（缺字段/非法枚举 → `err(..., 'FATAL')`）；再**拒绝重复注册**（`工具 X 重复注册`，FATAL） |
| `registerTools` | `(definitions: ToolDefinition[]) → Result<number>` | 批量注册，返回**成功条数**；仅当"全部失败"才返回 `err(..., 'FATAL')`——部分失败不报错，调用方需自校数量 |
| `getTool` | `(name: string) → ToolDefinition \| undefined` | 查找工具（安全门 `toolSafetyGate` 的唯一入口） |
| `executeTool` | `(name, input, context: ToolExecutionContext) → Promise<ToolResult>` | 统一执行入口，四条分支：①未注册 → `TOOL_NOT_FOUND`（`recoverable=false`）；②`spec.requiredRoles` **运行期硬门禁** → `ROLE_FORBIDDEN`（`recoverable=false`，2026-10-03 校准补录，原表未记）；③`spec.timeoutMs` 竞速超时 → `TOOL_TIMEOUT`（`recoverable=true`）；④执行抛异常 → `TOOL_EXECUTION_ERROR`（`recoverable=true`）。四条分支均回填 `tool_call_id = context.operationId` |
| `getRegisteredToolNames` | `() → string[]` | 已注册工具名清单（测试与启动自检） |
| `getAllToolSpecs` | `() → ToolSpec[]` | 全部 Spec，Factory / `toolHeader` / REST `toolsApi` 的共同数据源 |
| `getToolsByDangerLevel` | `(level: string) → ToolSpec[]` | 按危险级别过滤（⚠️ 存在同名双源，见下方裁定项） |
| `getToolCount` | `() → number` | 已注册数量 |
| `clearRegistry` | `() → void` | 清空注册表（测试隔离入口） |
| `isToolRegistered` | `(name: string) → boolean` | 是否已注册（启动自检） |

> 原表 5 行的签名与行为复查全部命中；后 5 项同为 `Registry/index.ts` 与 `Tools/index.ts` 门面 re-export 的公开契约，予以补录。
>
> 【需人工裁定】T-08：`getToolsByDangerLevel` **存在两个同名实现，勿按名字猜层级**——
> - `Src/Tools/Registry/toolRegistry.ts` 版：`(level: string) → ToolSpec[]`，读 Registry 实时状态；当前 `Src/` 内**无调用点**（仅经 `Registry/index.ts`、`Tools/index.ts` 门面导出）。
> - `Src/Infra/Security/whitelist.ts` 版：`(level: DangerLevel) → ToolRegistration[]`，读 Infra 自有白名单表；`Src/` 内亦**无调用点**，仅 `Tests/Infra/security.spec.ts` 消费。
> - ⚠️ `whitelist.ts` 除 `initWhitelist`（`main.ts` 启动装配）与 `isCommandForbidden`（`shellRunner` 命令黑名单）外的其余导出（含 `getToolsByDangerLevel`、`isToolAllowedForRole`、`getToolRegistration`、`isPathForbidden`、`isNetworkAllowed`、`clearWhitelist`）在 `Src/` 内均无消费者——**未实现目标态，不删除登记**。
> - 待办：裁定合并 / 重命名 / 明确 Registry 为唯一对外门面。本文档不做取舍。

### 1.2 `toolDispatcher.ts`（2026-10-03 校准补录：原表未提该模块）

统一派发收口（单一入口 + 审计埋点 + 结果归一 + 遥测），内部复用 `executeTool`，并按 `Infra/Logging/logger` 记录开始/完成/失败三态。

| 符号 | 签名 | 说明 |
|---|---|---|
| `dispatchToolCall` | `({ toolName, arguments, context, iteration? }) → Promise<DispatchOutcome>` | 所有工具调用的实际入口（`runIteration` 与元工具 `tool.execute` 均走此处） |
| `DispatchOutcome` | `{ result: ToolResult; text: string; durationMs: number; errorClass?: string }` | `errorClass` ∈ `DISPATCH_REJECTED`（`TOOL_NOT_FOUND`/`ROLE_FORBIDDEN`/`INVALID_INPUT`）\| `TOOL_TIMEOUT` \| `EXECUTION_ERROR`；成功为 `undefined` |
| `normalizeToolContent` | `(content: unknown) → string` | `null`/`undefined` → `''`；字符串原样；对象 → `JSON.stringify`（异常退化 `String()`） |

> ⚠️ 该模块**未列入** `Registry/index.ts` 与 `Tools/index.ts` 门面导出桶，跨层消费者走深路径 import（`Src/Core/Loop/runIteration.ts`）。

### 1.3 `toolHeader.ts`（2026-10-03 校准补录：原表未提该模块）

工具头部（`tools` 参数）的**冻结**与**探索**机制，用于保持提供商前缀缓存字节稳定。

| 符号 | 签名 | 说明 |
|---|---|---|
| `buildToolHeader` | `(role: UserRole, options?: ToolHeaderOptions) → ToolSpec[]` | 只含热工具 + 元工具、按名称排序、按 `requiredRoles` 过滤；超出 `maxHeaderTools` 时截断（元工具恒保留） |
| `listDiscoverableSpecs` | `(role: UserRole, options?) → ToolSpec[]` | 头部之外、该角色可探索（需经 `tool.search` 发现）的工具集 |
| `searchToolSpecs` | `(query: string, role: UserRole, limit = 5) → Array<{ name; description; dangerLevel; parameters; inHeader }>` | 名称/描述/类别子串检索，空查询返回前 N 个；`tool.search` 的实现底座 |
| `setToolHeaderConfig` | `(cfg: { hotTools?; maxHeaderTools? }) → void` | 启动期注入（`Src/main.ts` 调用，源 `Configs/tools.json → tools.hot` / `tools.maxHeaderTools = 12`）；**会话运行中禁止调用**（否则头部抖动） |
| `resetToolHeaderConfig` | `() → void` | 测试/诊断：清除注入配置，回退默认 |
| `DEFAULT_HOT_TOOLS` / `META_TOOLS` | `readonly string[]` | 热工具 10 项；元工具恒为 `['tool.search', 'tool.execute']` |

> ⚠️ 同样未进门面导出桶（`main.ts` / `toolSearcher.ts` 走深路径 import）。

---

## 2. Traits (`Src/Tools/Traits/`)

### ToolSpec 必填字段

> **2026-09-22 校准**：本表原仅列 6 项，已按 `Traits/specValidator.ts` 补全。
>
> **2026-10-03 校准（T-01 / T-02）**：必填口径由"11 项"更正为 **12 项无条件必填 + 1 项条件必填（`idempotencyKeyFields`）**——原"11"与本表 12 个非可选字段行自相矛盾（表内第 13 行即条件必填项），属注册门禁的核心数字。校验落点定位改为符号：12 项无条件必填检查全部位于 `specValidator.ts` 的 `validateToolSpec()` 函数体内（`name → version → description → inputSchema → outputSchema → dangerLevel → idempotency(+条件) → reversibility → sideEffectScope → requiredRoles → sandboxMode → timeoutMs` 依序）；两条附加规则亦在同一函数内——`idempotency ≠ NO` 时必须提供非空 `idempotencyKeyFields`、`FORBIDDEN` 级工具不允许注册（该分支在字段校验之后）。

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | `string` | 全局唯一（重复注册由 `registerTool` 拦截） |
| `version` | `string` | 语义化版本 |
| `description` | `string` | 展示给模型的描述 |
| `inputSchema` | `JsonSchema` | 入参 Schema（**仅**禁 `additionalProperties: true`；**非**结构递归校验，见 §2 校验细则） |
| `outputSchema` | `JsonSchema` | 出参 Schema（**仅**要求 `properties` 含 `status` + `recoverable`；**非**结构递归校验） |
| `dangerLevel` | `DangerLevel`（`SAFE \| CONTROLLED \| DANGEROUS \| FORBIDDEN`） | 危险分级（FORBIDDEN 拒注）。**类型出处为 `Src/Infra/Security/trustLevels.ts` 的 `DangerLevel`**，由 `toolSpec.ts` 跨层引用（Tools→Infra，方向合规）（2026-10-03 校准，T-06） |
| `idempotency` | `Idempotency`（`YES \| NO \| CONDITIONAL`） | 幂等性声明 |
| `idempotencyKeyFields?` | `string[]` | `idempotency ≠ NO` 时必填且非空（**条件必填**） |
| `reversibility` | `Reversibility`（`REVERSIBLE \| PARTIAL \| IRREVERSIBLE`） | 可逆性声明 |
| `sideEffectScope` | `SideEffectScope`（`none \| workspace \| filesystem \| network \| process \| external`） | 副作用范围 |
| `requiredRoles` | `UserRole[]` | 非空数组；类型来自 `Src/Infra/types.ts` 的 `UserRole`（8 角色单一真相源），**非 `string[]`**（2026-10-03 校准，T-04）。运行期由 `executeTool` 以 `ROLE_FORBIDDEN` 硬校验，并由 `buildToolHeader` 用于头部过滤——不只是注册期声明 |
| `sandboxMode` | `SandboxMode`（`strict \| standard \| none`） | 沙箱模式。`toolSpec.ts` 的 `SandboxMode` 类型别名与 `specValidator.ts` 中 `validateToolSpec()` 的合法值数组两处**逐字一致**（2026-10-03 复查仍精确命中，保留为文档精确度锚点范例，T-06） |
| `timeoutMs` | `number > 0` | 执行超时，`executeTool` 据此竞速 |
| `rateLimitPerAgent?` | `RateLimit`（`{ max: number; windowMs: number }`） | 每 Agent 限流（2026-10-03 校准补录，T-04）。⚠️ **未实现/目标态**：类型与字段已在 `toolSpec.ts` 定义，但 `validateToolSpec()` 不校验、`executeTool()` 与派发链均不消费，`Src/` 内无读取点 |

具名类型（`JsonSchema` / `Idempotency` / `Reversibility` / `SideEffectScope` / `SandboxMode` / `RateLimit`）与 `ToolSpec` 同处 `toolSpec.ts`，均由 `Traits/index.ts`、`Tools/index.ts` 门面导出；`JsonSchema = { type; properties?; required?; additionalProperties?; items?; description?; enum? }`。

### 校验细则（2026-10-03 校准新增，T-03）

`specValidator.ts` 的实际校验强度**低于**原表"结构递归校验"的表述：

| 校验项 | 实现符号（`specValidator.ts`） | 实际行为 |
|---|---|---|
| `inputSchema` | `validateInputSchema()`（模块私有） | 单条判定 `additionalProperties === true` → 报错；**不下探** `items` / 嵌套对象 |
| `outputSchema` | `validateOutputSchema()`（模块私有） | 仅判 `properties` 是否含 `status` 与 `recoverable`；无 `properties` 直接报错；**不下探**嵌套结构 |
| 运行期入参 | `validateInput()`（公开） | 单层遍历 `schema.properties` + 校验 `required` + `additionalProperties === false`；类型判定由私有 `matchesType()` 完成（`string/number/integer/boolean/array/object`，未知类型不检查）；**无嵌套递归** |

- ⚠️ **未实现/目标态**：`validateInput()` 虽经 `Traits/index.ts` 与 `Tools/index.ts` 门面导出，但 **`Src/` 内零调用点**（`executeTool` 不调用它，仅 `Tests/Tools/tool.spec.ts` 消费）——"注册期 Spec 校验 + 运行期入参校验"目前只落地前者。
- ⚠️ **未实现/目标态**：`specValidator.ts` 文件头声明的另两条职责在代码中**无实现体**——"`idempotency='NO'` 时 EffectJournal 前置检查"（`validateToolSpec()` 内无此逻辑）与"DANGEROUS + IRREVERSIBLE 需要 L4 HumanGate"（同函数末段为空 `if` 分支，注释明示"标记但不阻断，L4 HumanGate 在 approvalGate 中强制"）。
- `outputSchema` 的 `status` / `recoverable` 由 `Src/Tools/Builtin/_shared.ts` 的 `BASE_OUTPUT_SCHEMA` 与 `contentOutputSchema()` 统一供给，内置工具复用（两者 `additionalProperties: true`，与被校验的 `inputSchema` 约束方向相反，属既有约定）。

### ToolResult

> **2026-10-03 校准（T-05）**：8 字段的名称/可选性/类型复查 **8/8 一致**；原表 `effects` / `artifacts` 两行以 `toolSpec.ts` 内绝对行号为锚，因 `ToolExecutionContext` 的 `sessionId` / `workDir` 文档块插入而整体漂移，现统一改为"`toolSpec.ts` → `ToolResult` 接口字段"符号定位，并按代码声明顺序重排（`effects` / `artifacts` 位于 `error` **之前**）。

| 字段 | 类型 | 说明 |
|------|------|------|
| `role` | `'tool'` | 固定值 |
| `tool_call_id` | `string` | 调用 ID（失败路径由 `executeTool` 回填 `context.operationId`） |
| `status` | `'success' \| 'error'` | 执行状态 |
| `recoverable` | `boolean` | 是否可恢复（`toolSuccess` 恒为 `false`；`toolError` 默认 `true`） |
| `content?` | `unknown` | 返回内容 |
| `effects?` | `string[]` | 实际产生的副作用清单（`toolSpec.ts` 的 `ToolResult`；2026-09-22 校准补录） |
| `artifacts?` | `ArtifactEntry[]`（`{ path; hash; size }`） | 产出物引用（同上） |
| `error?` | `ToolError`（`{ code; message; details? }`） | 错误信息 |

构造入口：`toolSuccess(toolCallId, content, extras?)` / `toolError(toolCallId, code, message, recoverable = true, details?)`（均在 `toolSpec.ts`）。

### ToolExecutionContext（2026-10-03 校准补录，T-05 关联）

`executeTool` / `dispatchToolCall` 的 `context` 形态（`toolSpec.ts`），由 Loop 侧注入：

| 字段 | 类型 | 说明 |
|---|---|---|
| `operationId` | `string` | 用作 `tool_call_id` |
| `agentId` | `string` | 调用者 Agent |
| `agentRole` | `UserRole` | 参与 `requiredRoles` 硬校验 |
| `loopId?` | `string` | EffectJournal 归属 |
| `sessionId?` | `string` | 会话归属（`todo.write` 据此落库；会话未绑定为 `undefined`） |
| `traceId?` | `string` | trace_id |
| `workDir?` | `string` | 任务工作目录，路径型工具据此收敛（缺省退化为全局 `pathGuard`；配套守卫在 `Infra/Security/workspaceGuard`） |
| `signal?` | `AbortSignal` | ⚠️ **未实现/目标态**：`executeTool` 未将其透传给 `execute`，中止目前仅靠 `timeoutMs` 竞速 |

---

## 3. Factory (`Src/Tools/Factory/`)

> **2026-09-22 校准**：本表原签名与代码不符，已按 `toolFactory.ts` 实际导出更正。
>
> **2026-10-03 校准（T-09）**：原三行的函数名 / 形参类型 / 返回类型复查全部一致（本表为文档精确度基线）；表缺第 4 个导出 `getVisibleToolNames`，予以补录。
>
> **2026-10-04 修订（FE-051）**：按 `Docs/Agent/10 §3.3.1`（v2.2）"可见性唯一真相源 = `ToolSpec.requiredRoles`"裁定，本模块导出**已收敛到同一谓词 `isSpecVisibleForRole`**（`requiredRoles.includes`），与生产链路（`toolHeader.buildToolHeader` / `toolRegistry.executeTool`）口径逐字一致；原 `dangerLevel × trustLevel` 第二重裁剪与 L0 兜底分支均已删除。

| 函数 | 签名 | 说明 |
|------|------|------|
| `isSpecVisibleForRole` | `(spec: ToolSpec, role: UserRole) → boolean` | **唯一判定谓词**（FE-051 新增导出）：`requiredRoles` 显式白名单命中即可见；生产消费者为 `toolHeader.ts`（3 处过滤） |
| `getVisibleTools` | `(config: RoleToolConfig) → ToolSpec[]` | 过滤顺序：`excludedTools` 强制排除 → `isSpecVisibleForRole` → `additionalTools` 配置级放行（不再走信任级别推导） |
| `getVisibleToolNames` | `(config: RoleToolConfig) → string[]` | `getVisibleTools` 的名字投影（2026-10-03 校准补录） |
| `getVisibleToolsForRole` | `(role: UserRole) → ToolSpec[]` | 按 `requiredRoles` 过滤；原 L0 兜底分支已删除（FE-051），与 `buildToolHeader` 口径一致 |
| `isToolVisible` | `(toolName, role: UserRole) → boolean` | 同谓词（`isSpecVisibleForRole`），与 `executeTool` 运行期硬门禁口径一致，不再存在"可见但被拒"漂移（FE-051） |

- 类型：`RoleToolConfig = { role: UserRole; additionalTools?: string[]; excludedTools?: string[] }`（`toolFactory.ts`）。
- `Infra/Security/trustLevels.ts` 的 `isToolAllowed`（危险级 × 信任级矩阵）：**已标注 `@deprecated`（FE-051）**——不是工具可见性闸门，不得用于可见性/执行许可判定；`getTrustLevel(role)` 对未登记角色仍默认返回 L2（威胁模型参考用）。
- **2026-10-03 校准（T-10）**：原表 `getVisibleToolsForRole` 行登记的"运行期消费者 `Core/Loop/runIteration.ts`（原以绝对行号标注）"**已失效**——`runIteration.ts` 现 import `Tools/Registry/toolDispatcher.js` 的 `dispatchToolCall` 与 `Tools/Registry/toolHeader.js` 的 `buildToolHeader`，**不再调用本模块任何函数**。
  - 现状（2026-10-04 更新）：`isSpecVisibleForRole` 有 1 个生产消费者（`toolHeader.ts`）；其余四个导出在 `Src/` 内**零消费者**（调用点仅存于 `Tests/Tools/tool.spec.ts`、`Tests/Integration/agentPermissionSplit.spec.ts`）；角色/头部过滤的实际执行者已迁至 `toolHeader.buildToolHeader`（内部即用 `isSpecVisibleForRole`）。
  - 待办：`Factory/index.ts` 与 `Tools/index.ts` 门面只导出 `getVisibleTools` / `getVisibleToolNames` / `isToolVisible`，**`getVisibleToolsForRole` 与 `isSpecVisibleForRole` 未进门面**。需裁定"补进门面 / 与 `getVisibleTools` 合并为单一门禁 / 标记废弃"，本文档只登记现状。⚠️ 未实现目标态（消费者缺位）不删除登记。

### 3.1 相关模块与装载链

> **2026-09-22 校准**：§1"缺字段拒注"的实际执行者为 `Traits/specValidator.ts`。
>
> **2026-10-03 校准（T-11）**：工具实现位于 `Builtin/`（`Read` / `Write` / `Execute` / `System` / `Plan` / `Search` 六个子目录 + 共享模板 `_shared.ts`）与 `Custom/`，由 `Src/Tools/builtinLoader.ts` 的 `BUILTIN_TOOLS` 聚合、`registerBuiltinTools()` 经 `registerTools` 批量注册（启动 ⑫ 步调用）。聚合数量为 **14 个 `ToolDefinition`**（差别清单记 12，此后代码新增 `todoWriter` 等已追平并越过该数字）。⚠️ `builtinLoader.ts` 中 `// Custom (stub)` 注释对 `agentRecruiter` 已过期（该工具已实装落库），代码侧注释漂移可另提 issue。

### 3.2 当前注册工具清单（14 个，2026-10-03 校准补录）

| 工具名 | 危险级 | 实现位置（文件 → 符号） | 实现状态 |
|---|---|---|---|
| `file.read` | SAFE | `Builtin/Read/fileReader.ts` → `fileReader` | 实装 |
| `dir.list` | SAFE | `Builtin/Read/dirLister.ts` → `dirLister` | 实装 |
| `file.grep` | SAFE | `Builtin/Read/grepTool.ts` → `grepTool` | 实装 |
| `file.write` | CONTROLLED | `Builtin/Write/fileWriter.ts` → `fileWriter` | 实装 |
| `file.edit` | CONTROLLED | `Builtin/Write/fileEditor.ts` → `fileEditor` | 实装 |
| `shell.exec` | DANGEROUS | `Builtin/Execute/shellRunner.ts` → `shellRunner` | 实装（命令黑名单经 `Infra/Security/whitelist.isCommandForbidden`） |
| `code.eval` | DANGEROUS | `Builtin/Execute/codeSandbox.ts` → `codeSandbox` | 实装 |
| `tool.search` | SAFE | `Builtin/System/toolSearcher.ts` → `toolSearcher` | 实装（元工具，恒在头部；底座 `toolHeader.searchToolSpecs` / `listDiscoverableSpecs`） |
| `tool.execute` | CONTROLLED | `Builtin/System/toolExecutor.ts` → `toolExecutor` | 实装；**拒绝 DANGEROUS / FORBIDDEN 借壳执行**（须出现在头部以便审批） |
| `todo.write` | SAFE | `Builtin/Plan/todoWriter.ts` → `todoWriter` | 实装；⚠️ 越层 import Services（见 §0） |
| `web.search` | SAFE | `Builtin/Search/webSearch.ts` → `webSearch` | ⚠️ 桩实现（返回占位结果，待 S9 接入真实搜索引擎） |
| `vector.search` | SAFE | `Builtin/Search/vectorSearch.ts` → `vectorSearch` | ⚠️ 桩实现（待 S8 接入 Embedding + 向量存储） |
| `agent.recruit` | DANGEROUS | `Custom/agentRecruiter.ts` → `agentRecruiter` | 实装（2026-10-03 接线：招募与约束落库；返回值 `dispatch: 'pending'` 为语义标注——编排调度链路已随 FE-050 于 2026-10-04 落地）；⚠️ 越层 import Services/Core（见 §0） |
| `agent.submit_review` | CONTROLLED | `Custom/submitForReview.ts` → `submitForReview` | 实装（2026-10-04 FE-050：提交 → 独立 Reviewer → 规则审核 → `subtasks` 台账回写；requiredRoles 放宽为 `worker/partner/assembly_node`） |

> 头部冻结集为上述 14 个中的 10 个（`DEFAULT_HOT_TOOLS`，可被 `Configs/tools.json → tools.hot` 覆盖）：`file.read`、`file.write`、`file.edit`、`dir.list`、`file.grep`、`shell.exec`、`todo.write`、`web.search`、`tool.search`、`tool.execute`；其余 4 个（`code.eval`、`vector.search`、`agent.recruit`、`agent.submit_review`）需经 `tool.search` 探索后以工具结果形式追加到消息尾部。

---

## 修订记录

| 日期 | 说明 |
|------|------|
| 2026-09-22 | 文档-代码对账校准：ToolSpec 必填字段表补全至 11 项（含 idempotencyKeyFields 条件必填、FORBIDDEN 拒注规则）；ToolResult 补录 effects/artifacts；§3 Factory 三函数签名更正并补 `getVisibleToolsForRole`；补录 specValidator/Builtin/Custom/builtinLoader |
| 2026-10-03 | 依 `Docs/Dev/Agent-16-开发规范接口契约-差别清单.md` Tools 层条目 T-01～T-12 逐条复核后回写：必填口径 11→**12 项 + 1 项条件必填**（T-01）；绝对行号全部改为"文件 + 函数/符号名"定位（T-02）；删除"结构递归校验"误述并新增"校验细则"（T-03，附 `validateInput` 与两条文件头声明未落地 ⚠️）；补 `rateLimitPerAgent?` 并把 `inputSchema`/`outputSchema` 改 `JsonSchema`、`requiredRoles` 改 `UserRole[]`、`dangerLevel` 补 Infra 出处（T-04/T-06）；ToolResult 行号改符号并按声明序重排，新增 ToolExecutionContext 字段表（T-05）；§1 Registry 补录 5 个门面导出 + `executeTool` 四条分支与错误码，新增 `toolDispatcher` / `toolHeader` 两节（T-07）；`getToolsByDangerLevel` 同名双源登记为【需人工裁定】+ 待办（T-08）；Factory 补 `getVisibleToolNames`、更正 `runIteration` 消费者已迁出的现状（T-09/T-10）；装载链更正为 14 个 `ToolDefinition` 并新增"当前注册工具清单"含实现状态列（T-11）；文首新增 §0"依赖方向现状与待办"，登记 **2 文件 / 3 处越层 import**（较清单新增 `todoWriter`）并为【需人工裁定】项（T-12）。复查通过、未改动项：`sandboxMode` 枚举双点、Factory 三行签名、ToolResult 字段名/类型、Registry 原 5 函数签名 |
