# Src — 后端源码（五层架构）

TypeScript 后端，严格单向分层：**Interface → Core → Services → Tools → Infra**（上层可依赖下层，反向禁止）。
边界由 `.eslintrc.json` 的 `import/no-restricted-paths` zones 强制，`npm run lint` 即门禁。

## 分层职责

| 层 | 目录 | 职责 |
|---|------|------|
| Interface | `Interface/` | 交互层：`WebSocket/`（wsGateway / wsHandler）、`RestApi/`（chatApi 等）、`WebServer/`（httpServer / routes）、`InputDeduplication/` |
| Core | `Core/` | 引擎层：`Loop/`（runIteration 十步主循环 / iterationController）、`Middleware/`（六钩子注册表 + 内置 goalReanchor / fingerprintDetector / budgetSentinel / failureInjector）、`Model/`（modelCaller）、`AgentRuntime/`（agentFactory）、`Decision/`（orchestrator 编排） |
| Services | `Services/` | 服务层：`LoopControl/`、`Supervision/` 监管、`TokenEconomy/` 经济、`Arbitration/` 仲裁、`Audit/` `Regulation/` 审计监管、`SharedMemory/` `Context/` `Retrieval/` 记忆、`EventBus/`、`Session/`、`Cache/`、`Pipeline/`、`Recruitment/`、`ReviewerAgent/`、`Hook/`、`LoopScheduler/` |
| Tools | `Tools/` | 工具层：`Builtin/`（Execute / Read / Write / Search）、`Custom/`（agentRecruiter / submitForReview）、`Registry/`、`Factory/`、`Traits/`（toolSpec） |
| Infra | `Infra/` | 基础设施层：`Config/` `Db/` `Logging/` `Security/` `DurableExecution/` `Llm/` `Fs/` `Time/` `Workspace/` `Sandbox/` `Watcher/` `Hook/` `Embedding/` `Slm/` `Terminal/` `Contracts/` |

> 中间件类型契约已下沉至 `Infra/Contracts/`（见 [ADR-0006](../ADR/0006-middleware-contract-relocated-to-infra.md)），`Core/Middleware` 与 `Services/LoopControl` 共用。

## 启动流程（`main.ts` 的 `startServer()`，18 步）

① 配置加载 → ② 日志 → ③ 时间服务（时钟回拨检测）→ ④ 安全（信任级 / 白名单 / 路径守卫）→ ⑤ 目录初始化 → ⑥ 数据库（三库 + 迁移）→ ⑦ 工作区 → ⑦.5 持久执行底座（EffectJournal / 幂等 / 恢复扫描）→ ⑧ 沙箱 → ⑨ 配置热加载注册（仅存参， watcher 未启动，见 Configs/README）→ ⑩ 提示词 → ⑪ LLM Provider 注册与路由 → ⑫ 工具注册 → ⑬ 运行时内核（缓存 / 会话 / Hook / 中间件）→ ⑭ 环境自检 → ⑮ Loop 控制（StopRules）→ ⑯ Token 经济（钱包 / 税收 / 双预算）→ ⑰ 事件总线（去重 / 熔断）→ ⑱ 接口装配（HTTP :3000 + WS :3001）。

优雅关闭为 9 步序列（SIGINT 触发），见 `main.ts` 底部与 `Docs/02-核心架构/核心架构设计.md` §7.2。

## 约定

- 全部 ESM，`.js` 后缀导入；返回 `Result` 风格（`{ ok, value | error }`）
- `npm run build` 做 `tsc --noEmit` 类型检查；`npm run build:server` 用 esbuild 打包
- `npm run gen:event-types` 从 `Services/EventBus/eventTypes.ts` 同步生成前端枚举
