# ADR-0006: 中间件类型契约下沉至 Infra 共享内核

## 状态
已接受（Accepted）

## 背景
中间件系统的引擎实现（注册表 `middlewareRegistry`、六钩子执行器 `executePrePostHooks`/`executeWrapHooks`）位于 `Core/Middleware`，属 Core 层职责（Docs/02 §1）。但其**类型契约**（`AgentMiddleware`、`MiddlewareContext`、`ModelCallInput/Output`、`ToolCallInput/Output`、六钩子函数类型、`HookFunction`、`MiddlewareHook`）原置于 `Core/Middleware/types.ts`。

Services 层的中间件实现（`Services/LoopControl/middleware/` 下的 `toolSafetyGate`、`stopRuleEvaluator`、`goalReanchorControl`、`fingerprintDetectorControl`、`budgetSentinelControl`、`checkpointWriter`）必须引用这些类型契约，因而形成 **6 处 `Services → Core` 的引用**。

依据 Docs/02 §1.1 与 §2.2 五层单向依赖红线：`Services → Core` 是被 CI 门禁明令禁止的反向依赖方向（下层绝对不可引用上层）。虽然这 6 处均为 `import type`（编译期擦除、无运行时耦合），但严格按红线仍属违规，且会随中间件实现增多而扩散。

> 说明：`Core/Loop/runIteration.ts` 对 `Services/Supervision`、`Services/LoopControl`、`Services/Hook` 的调用是 **`Core → Services` 向下依赖**，由 §1.1 明确允许、§3 十步序列表强制规定（②⑨⑩ 步实现位于 Services、由 Core/Loop 编排），**不属违规，不在本决策范围**。

## 决策
- 新建 `Src/Infra/Contracts/` 目录，作为跨层共享内核契约的存放处（纯类型、零运行时、零上层 import）。
- 将中间件类型契约整体从 `Core/Middleware/types.ts` 迁移至 `Src/Infra/Contracts/middlewareTypes.ts`，作为**单一真相源**；迁移后删除原 `Core/Middleware/types.ts`（不保留 re-export shim，避免幽灵文件与双重导入路径）。
- 全部消费方（Core 7 处、Services 6 处、Tests 1 处）重指向 `Infra/Contracts/middlewareTypes.js`：
  - `Core → Infra` 向下依赖，合规；
  - `Services → Infra` 向下依赖，合规——**红线违规消除**。
- Core 内部消费方一律**直连 Infra 契约**，不经 `Core/Middleware/index.js` 桶文件导入类型，以规避 `builtin/*.ts → index.ts → builtin/index.ts` 的循环导入风险。
- 保留 `Core/Middleware/index.ts` 桶文件对契约类型的 re-export（源改为 Infra），维持 `import ... from 'Core/Middleware/index.js'` 的既有对外 API 面不变。
- 运行时引擎（注册表、六钩子执行器、内建中间件）仍全部留在 `Core/Middleware`，本决策仅下沉**纯类型契约**。

## 被否决的替代方案
- **保留 `Core/Middleware/types.ts` 作 re-export shim**：留下幽灵文件与两条等价导入路径，未来易被重新填充实现，违背架构卫生与单一真相源原则。
- **契约追加进 `Infra/types.ts`**：会让基础原语文件（`Result`/`UserRole`/`LogLevel` 等）承载领域特定契约，违反单一职责。
- **契约放在 Services 层**：将导致 Core 反向依赖 Services 取自身中间件类型，语义倒置，且 Core 的中间件引擎与其类型契约分属两层，割裂内聚。

## 适用边界
- 仅适用于**零运行时的纯类型契约**需被多层共同向下依赖的场景。
- 凡涉及运行时逻辑（函数/类/常量）的跨层协作，不得借此下沉至 Infra；应通过事件总线（Services/EventBus）或依赖注入解耦。
- `Infra/Contracts/*` 模块必须保持零 `import`（尤其禁止 import 任何上层），以满足 Infra「禁止依赖所有上层」红线。

## 后果
- `Services → Core/Middleware` 引用归零，五层单向依赖红线在中间件契约维度完全合规。
- `tsc --noEmit` 错误数与迁移前基线一致（237 项预存错误，无新增）；`Tests/Runtime`、`Tests/Infra/security`、`Tests/Tools/tool`、`Tests/Integration/agentPermissionSplit` 共 132 项测试全绿。
- Core 与 Services 现在共享同一份中间件类型契约，新增 Services 层中间件不再引入反向依赖。
- **遗留（独立跟进，不在本决策范围）**：`Services/Recruitment/recruiter.ts` 与 `Services/ReviewerAgent/reviewerAgent.ts` 存在对 `Core/AgentRuntime/*` 的**运行时级** `Services → Core` 引用，属更严重的红线违规，需通过依赖倒置（事件总线或接口注入）单独治理。
- **遗留（独立跟进）**：ESLint `import/no-restricted-paths` 因 `eslint-import-resolver-typescript` 加载异常（`invalid interface loaded as resolver`）当前无法实际执行层间门禁校验，需单独修复以使红线可自动拦截。
