# Infra 层接口文档

> Infra 层：基础设施，无上层依赖。
> 依赖方向：无（最底层）

---

## 1. Db (`Src/Infra/Db/`)

| 函数 | 签名 | 说明 |
|------|------|------|
| `initDatabase` | `(config?) → Result<void>` | 初始化 SQLite 连接 |
| `getMainDb` | `() → Database` | 获取主库实例 |
| `closeDatabase` | `() → void` | 关闭连接 |
| `migrateUp` | `() → Result<void>` | 执行迁移 |

---

## 2. DurableExecution (`Src/Infra/DurableExecution/`)

| 子模块 | 核心函数 | 说明 |
|--------|---------|------|
| `effectJournal.ts` | `recordIntent(input: CreateEffectInput) → Result<EffectRecord>` | 写 INTENT |
| `effectJournal.ts` | `updateEffectStatus(input: UpdateEffectInput) → Result<void>` | 更新状态 |
| `idempotencyStore.ts` | `makeIdempotencyKey(tool, args, loopId) → string` | SHA-256 幂等键 |
| `idempotencyStore.ts` | `lookup(key) → Result<IdempotencyLookup>` | 查询幂等缓存 |
| `idempotencyStore.ts` | `store(key, loopId, result) → Result<void>` | 存储结果 |
| `checkpointStore.ts` | `saveCheckpoint(data) → Result<string>` | 保存检查点 |
| `recoveryScanner.ts` | `scanAndProposeRecovery() → Result<RecoveryPlan>` | 启动扫描 |

---

## 3. Logging (`Src/Infra/Logging/`)

| 函数 | 签名 | 说明 |
|------|------|------|
| `logger.info/warn/error/debug` | `(msg, meta?) → void` | 双轨日志 |
| `initLogger` | `(config?) → void` | 初始化 |
| `shutdownLogger` | `() → Promise<void>` | flush 队列 |

**追踪 ID 约定**：
- `session_key`：SHA-256 前 16 位 hex
- `trace_id`：UUID v4
- `operation_id`：`{timestamp_ms}-{4位hex}`

---

## 4. Llm (`Src/Infra/Llm/`)

| 子模块 | 核心函数 | 说明 |
|--------|---------|------|
| `Provider/providerBase.ts` | `LlmProvider.chat(options) → Promise<Result<CallResult>>` | 非流式调用 |
| `Provider/providerBase.ts` | `LlmProvider.chatStream(opts, onChunk) → Promise<Result<CallResult>>` | 流式调用 |
| `Router/modelRouter.ts` | `resolveModel(qualified) → Result<{provider, spec}>` | 模型路由 |
| `Router/modelRouter.ts` | `getRoutingConfig() → RoutingConfig` | 获取路由配置 |

---

## 5. Security (`Src/Infra/Security/`)

| 子模块 | 核心函数 | 说明 |
|--------|---------|------|
| `trustLevels.ts` | `initTrustLevels(config)` | 初始化信任级别 |
| `whitelist.ts` | `initWhitelist(config)` | 初始化白名单 |
| `pathGuard.ts` | `initPathGuard(config)` | 路径守卫 |

---

## 6. types.ts

| 类型 | 说明 |
|------|------|
| `Result<T> = Ok<T> \| Err` | 统一结果类型 |
| `ok<T>(value: T): Ok<T>` | 成功构造 |
| `err(msg, severity?): Err` | 失败构造 |
| `SessionKey` | SHA-256 前 16 位 hex |
| `TraceId` | UUID v4 |
| `OperationId` | `{ts}-{4hex}` |
