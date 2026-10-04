# Infra 层接口文档

> Infra 层：基础设施，无上层依赖。
> 依赖方向：无（最底层）
>
> **2026-10-03 校准**：
> 1. 复查 `Src/Infra/` 全目录对 `Core/` / `Services/` / `Tools/` / `Interface/` 的 import 仍为 **0 命中**，文首"无上层依赖"声明成立（本轮唯一零差异项）。
> 2. 全文**绝对行号引用一律改为「文件名 · 符号名」定位**（历轮校准证明行号随注释增行整片漂移，不再作主锚）。
> 3. §1—§6 仅覆盖每模块 2-4 个"代表函数"，实际单层导出为其 3-6 倍；本轮补齐（`transaction.ts` / `Repositories/` / `recoveryExecutor.ts` / `traceContext.ts` / `logWriter.ts` / `Provider/*` / Security 四模块 / `types.ts` 根类型），并新增 §7 覆盖此前**整节缺席的 9 个目录**（`Config/` `Contracts/` `Fs/` `Hook/` `Sandbox/` `Slm/` `Time/` `Watcher/` `Workspace/` 及 `Embedding/`）。
> 4. 新增 §8「现状与未接线登记」：三库分离与 DurableExecution 恢复链路存在"已实现未接线"缺口，按目标态保留并加 ⚠️ 标记，不删除。

定位约定：下文 `database.ts · initDatabase` 指 `Src/Infra/` 对应子目录下的同名文件与同名导出符号。

---

## 1. Db (`Src/Infra/Db/`)

### 1.1 database.ts — 三库连接管理

**2026-10-03 校准**：本节原列 4 函数（`initDatabase` / `getMainDb` / `closeDatabase` / `migrateUp`）中，`initDatabase` 签名两处不符（config 非可选、返回非 void），另 6 个导出与 `transaction.ts`、`Repositories/` 整目录未登记。三库分离是本层核心设计，读者须按下列全量导出理解接口面。

| 符号 | 签名 | 说明 |
|------|------|------|
| `initDatabase` **2026-10-03 校准** | `(config: DatabaseConfig) → Result<DatabaseConnections>` | 初始化三个 SQLite 连接（main / events / memory）：建目录、开连接、设 PRAGMA。**config 为必填**（三路径无代码级默认，由 `main.ts` 从 `database` 配置段兜底后传入），**返回值携带三库句柄**而非 void——调用方可直接持有句柄。幂等：已初始化时返回既有 `ok(connections)`；失败 `err(..., 'FATAL')`（启动终止） |
| `getDatabases` **2026-10-03 校准** | `() → DatabaseConnections` | 取连接集合；**未初始化直接 throw**（非 `Result`）。跨层消费点：`IpcBridge/ipcBridge.ts`、`RestApi/memoryApi.ts`、`RestApi/syncApi.ts`、`Services/SharedMemory/memoryEntryStore.ts` |
| `getMainDb` | `() → Database.Database` | 主库（任务 / Agent / Token / 会话 / effect_journal / checkpoints / ai_events） |
| `getEventsDb` **2026-10-03 校准** | `() → Database.Database` | 事件库（仅追加设计）；⚠️ 当前无生产写入点，见 §1.5 |
| `getMemoryDb` **2026-10-03 校准** | `() → Database.Database` | 记忆库（`memory_entries`）；实际消费经 `getDatabases().memory` |
| `closeDatabase` | `() → void` | 依次关闭三连接（各自 try/catch 吞异常），置空单例 |
| `isDatabaseInitialized` **2026-10-03 校准** | `() → boolean` | 启动/降级判定入口；`RestApi/syncApi.ts`、`Interface/EventStore/aiEventStore.ts`、`Services/LoopControl/approvalPersistence.ts` 消费 |

`DatabaseConfig`（database.ts 导出类型）**2026-10-03 校准**：
`{ mainPath, eventsPath, memoryPath, walMode? = true, busyTimeoutMs? = 5000, writeSynchronous? = 'FULL' }`
— `writeSynchronous` 仅作用于 main 库（承载 effect_journal，Docs/Agent/12 §10 由 `durable.effect.writeSynchronous` 注入）；events / memory 库固定 `synchronous = NORMAL`。三库均设 `journal_mode = WAL`（可关）、`busy_timeout`、`foreign_keys = ON`。

`DatabaseConnections`：`{ readonly main, readonly events, readonly memory }`（better-sqlite3 句柄）。

### 1.2 migrations.ts — 版本化迁移

| 符号 | 签名 | 说明 |
|------|------|------|
| `registerMigration` **2026-10-03 校准** | `(migration: Migration) → void` | 追加并按 version 升序排序 |
| `registerDefaultMigrations` **2026-10-03 校准** | `() → void` | 幂等注册内置默认迁移（`defaultsRegistered` 闸门）。**当前 32 条：main 28 / events 3 / memory 1** |
| `initMigrations` **2026-10-03 校准** | `() → Result<void>` | 注册默认迁移 + **版本号冲突检测**（同库内重复 version 会致后者被 `isApplied()` 静默跳过，故返回 `err(..., 'FATAL')`）+ 在**三个库各建 `_migrations` 表**。失败 `err(..., 'FATAL')` |
| `migrateUp` **2026-10-03 校准** | `() → Result<number>` | 原述 `Result<void>` 不实：**返回本次实际应用条数**（`main.ts` 启动日志即取该值作 `migrationsApplied`）。逐条按 `migration.database`（缺省 main）路由到对应句柄，未应用者执行 `up` 并登记 |
| `migrateDown` **2026-10-03 校准** | `() → Result<number>` | 回滚"最新一条"；⚠️ **实现仅从 main 库 `_migrations` 取 MAX(version)**，events / memory 库的迁移不可经此回滚（Gate G1 "可上可下"在两库上未闭合） |
| `getAppliedMigrations` **2026-10-03 校准** | `(db: 'main' \| 'events' \| 'memory' = 'main') → MigrationStatus[]` | 形参为库名枚举，非句柄 |
| `getCurrentVersion` **2026-10-03 校准** | `(db: 'main' \| 'events' \| 'memory' = 'main') → number` | `MAX(version)`，空表返回 0 |
| `clearMigrations` **2026-10-03 校准** | `() → void` | 清空注册表并复位 `defaultsRegistered`（测试隔离入口，可重复装配） |

`Migration` 类型（migrations.ts）**2026-10-03 校准**：`{ version, name, up, down, database?: 'main' \| 'events' \| 'memory' }` — `database` 为三库路由字段。
`MigrationStatus`：`{ version, name, appliedAt }`。

### 1.3 transaction.ts（**2026-10-03 校准**：整文件此前未登记）

| 符号 | 签名 | 说明 |
|------|------|------|
| `transaction` | `<T>(fn: () => T) → Result<T>` | **main 库**事务包装，异常自动回滚并 `err(..., 'ERROR')` |
| `eventsTransaction` | `<T>(fn: () => T) → Result<T>` | events 库事务 |
| `memoryTransaction` | `<T>(fn: () => T) → Result<T>` | memory 库事务 |

注：三函数经 `Db/index.ts` 门面导出；**当前 `Src/` 内无调用点**，各落库模块（Services / Interface）直接用 better-sqlite3 的 `db.transaction(...)`（如 `checkpointStore.ts` 的插入事务、`Services/Planning/todoStore.ts`、`Services/SharedMemory/memoryEntryStore.ts`）。⚠️ 目标态：跨模块写多表应统一经此层，避免事务边界散落到上层。

### 1.4 Repositories/（**2026-10-03 校准**：整目录此前未登记）

| 文件 | 导出符号 | 说明 |
|------|---------|------|
| `Repositories/sessionRepository.ts` | `Session`（类型）、`createSession(session) → Result<Session>`、`getSession(sessionKey) → Result<Session \| null>`、`updateLastActive(sessionKey, lastActiveAt) → Result<void>`、`archiveSession(sessionKey, archivedAt) → Result<void>`、`listActiveSessions() → Result<Session[]>` | `sessions` 表读写（main 库）；`archiveSession` 支撑会话归档闭环 |
| `Repositories/agentRepository.ts` | `AgentRow` / `AgentPersistInput`（类型）、`upsertAgent(input) → void`、`updateAgentRow(...)`、`loadAgents(includeDestroyed = true) → AgentRow[]`、`countLiveAgentsByTrace(traceId) → number`、`rowToAgentInstance(row) → AgentInstance`、`parentOf(agentId) → string \| null` | `agents` 表读写与行↔实例映射；`loadAgents` 是重启回灌（`main.ts` Agent 注册表 hydrate）的数据源。⚠️ `upsertAgent` / `updateAgentRow` / `rowToAgentInstance` 返回裸值/裸 void，与本层 `Result` 约定不一致（差异登记，见 §8） |

### 1.5 三库分离现状（**2026-10-03 校准**）

| 库 | 文件（默认） | 已建表（代表） | 生产写入点 |
|----|-------------|----------------|-----------|
| main | `Data/db/civitas_main.db` | `sessions` `agents` `tasks` `token_*` `effect_journal` `loop_checkpoints` `idempotency_cache` `pending_approvals` `ai_events` `session_todos` `global_workspace` … | ✅ 有（含 `ai_events`） |
| events | `Data/db/civitas_events.db` | `events` `action_fingerprints` `domain_events`（3 条迁移） | ⚠️ **无生产写入点**：`Src/` 全域未见 `INSERT INTO events` / `INSERT INTO domain_events`，`action_fingerprints` 亦仅建表；事件流实际落在 main 库 `ai_events`（写入方 `Interface/EventStore/aiEventStore.ts`，经 `getMainDb`） |
| memory | `Data/db/civitas_memory.db` | `memory_entries`（该库**唯一**一条迁移） | ✅ 有（经 `getDatabases().memory`，`Services/SharedMemory/memoryEntryStore.ts`）。⚠️ 注意：长期记忆表 `long_term_memory` 实际建在 **main** 库（`registerDefaultMigrations` 中 `database: 'main'`），记忆数据横跨两库 |

> ⚠️ 目标态（未实现）：事件溯源落 events 库、main 库承载主业务。当前实现是"三连接就绪、事件写入仍走 main"，故事件库读接口（`getEventsDb` / `eventsTransaction`）实际为低使用面。相关待办见 §8。

启动装配顺序（`main.ts`）：`initDatabase({ mainPath, eventsPath, memoryPath, walMode, busyTimeoutMs, writeSynchronous })` → `initMigrations()` → `migrateUp()`（返回条数入日志）。关闭顺序：`closeDatabase()` 于 ⑧ 步。

> **2026-10-03 校准**（门面缺口登记）：`Db/index.ts` 导出 database.ts 六项（**不含 `getDatabases`**）、migrations.ts 七项（**不含 `registerDefaultMigrations`**）、transaction.ts 三项，并**完全不 re-export 类型**（`DatabaseConfig` / `DatabaseConnections` / `Migration` / `MigrationStatus` 均不可经门面取得）。后果是 `getDatabases` 的 4 处跨层消费（`IpcBridge/ipcBridge.ts`、`RestApi/memoryApi.ts`、`RestApi/syncApi.ts`、`Services/SharedMemory/memoryEntryStore.ts`）一律**直连 `Infra/Db/database.js` 深路径**而非门面。待办：门面补 `getDatabases` 与类型 re-export，上层改走门面。

---

## 2. DurableExecution (`Src/Infra/DurableExecution/`)

> **2026-09-22 校准（仍成立）**：`checkpointStore` 仅有 `createCheckpoint`，**不存在 `saveCheckpoint`**（本轮复查 `Src/` + `Tests/` 全域 0 命中）。
> **2026-10-03 校准**：原表列 3 文件 8 行，实有 5 个实现文件 **31 个函数导出**（含此前**整节缺席的 `recoveryExecutor.ts`**）+ `schemas/` 目录；`checkpointStore` 四处行号 +1 漂移、形参名与默认值按代码回填；`scanAndProposeRecovery` 返回类型修正为数组。

### 2.1 effectJournal.ts — 副作用意图日志（main 库，`synchronous = FULL`）

| 符号 | 签名 | 说明 |
|------|------|------|
| `initEffectJournal` **2026-10-03 校准** | `(config: { defaultTimeoutMs?: number }) → void` | 启动装配；默认超时由 `durable.effect.defaultTimeoutMs` 注入（兜底 30000ms） |
| `hashPayload` **2026-10-03 校准** | `(payload: unknown) → string` | SHA-256(JSON)，用于意图指纹 |
| `recordIntent` | `(input: CreateEffectInput) → Result<EffectRecord>` | 写 INTENT（副作用执行前必调，Gate G2 / DUR-006） |
| `updateEffectStatus` | `(input: UpdateEffectInput) → Result<void>` | 更新状态 |
| `markExecuting` **2026-10-03 校准** | `(effectId: string) → Result<void>` | INTENT → EXECUTING |
| `markSucceeded` **2026-10-03 校准** | `(effectId: string, result?: unknown) → Result<void>` | → SUCCEEDED |
| `markFailed` **2026-10-03 校准** | `(effectId: string, errorClass: ErrorClass, result?: unknown) → Result<void>` | → FAILED，`ErrorClass = 'retryable' \| 'non_retryable' \| 'unknown'` |
| `resolveTimedOutEffects` **2026-10-03 校准** | `() → Result<number>` | 超时 EXECUTING 判定为 UNKNOWN，返回处理条数 |
| `getUnknownEffects` **2026-10-03 校准** | `(loopId: string) → Result<EffectRecord[]>` | 恢复裁决输入 |
| `getPendingEffects` **2026-10-03 校准** | `(loopId: string) → Result<EffectRecord[]>` | 未决副作用 |
| `findByIdepotencyKey` **2026-10-03 校准** | `(loopId: string, idempotencyKey: string) → Result<EffectRecord \| null>` | ⚠️ 符号名代码即拼作 `Idepotency`（非 `Idempotency`），调用方须按实名 import |
| `getPendingCount` **2026-10-03 校准** | `() → number` | 全表未决计数（裸返回，非 `Result`） |

生产写入方：`Services/LoopControl/middleware/toolSafetyGate.ts`（`recordIntent` / `updateEffectStatus` / `hashPayload`）。

### 2.2 idempotencyStore.ts — 幂等缓存（表 `idempotency_cache`）

| 符号 | 签名 | 说明 |
|------|------|------|
| `initIdempotencyStore` **2026-10-03 校准** | `(config: { cacheTtlHour?: number }) → void` | 启动装配，TTL 默认 24 小时 |
| `makeIdempotencyKey` | `(toolName: string, args: unknown, loopId: string) → string` | 确为 SHA-256：`sha256(toolName + canonicalJson(args) + loopId)`（键名排序后 `JSON.stringify`） |
| `lookup` | `(idemKey: string) → Result<IdempotencyLookup>` | DUR-005；`hit=true` 携首次结果，过期视同 miss |
| `store` | `(idemKey: string, loopId: string, result: unknown) → Result<void>` | 存结果 + 设 `expires_at` |
| `purgeExpired` **2026-10-03 校准** | `() → Result<number>` | 清过期缓存并返回条数；已挂 `main.ts` 关闭 ⑦.5（阻止 `idempotency_cache` 单调增长） |
| `getCacheSize` **2026-10-03 校准** | `() → number` | 当前缓存条数（裸返回） |

### 2.3 checkpointStore.ts — 快照读写（main 库，表 `loop_checkpoints`）

**2026-10-03 校准**：下列四处行号漂移已改为符号定位；`loadLatestCheckpoint` 形参为 `loopId`（原文误作 `id`）；`listCheckpoints` / `pruneCheckpoints` 补默认值。

| 符号 | 签名 | 说明 |
|------|------|------|
| `makeCheckpointId` **2026-10-03 校准** | `(loopId: string, iteration: number) → string` | 格式 `{loopId}#{iteration}#{ts}` |
| `createCheckpoint` | `(input: CreateCheckpointInput) → Result<Checkpoint>` | DB 事务原子写入（Gate G2 / DUR-003，写一半断电旧快照完好） |
| `loadLatestCheckpoint` | `(loopId: string) → Result<Checkpoint \| null>` | 取该 loop 最新一条 |
| `loadCheckpoint` | `(checkpointId: string) → Result<Checkpoint \| null>` | 按 ID 取 |
| `listCheckpoints` | `(loopId: string, limit: number = 20) → Result<Checkpoint[]>` | 默认 20 条 |
| `pruneCheckpoints` | `(loopId: string, keepLast: number = 20) → Result<number>` | 保留末尾 N 条，返回删除条数 |

> ⚠️ 未接线：`createCheckpoint` / `loadLatestCheckpoint` 等在 `Src/` 内**无生产调用点**；Loop 侧当前由 `Services/LoopControl/middleware/checkpointWriter.ts` 的**内存 Map（自述 "Phase 0"）**承担 checkpoint 记录，形成与 DB 版并行的第二套实现。收敛待办见 §8。

### 2.4 recoveryScanner.ts — 启动扫描

| 符号 | 签名 | 说明 |
|------|------|------|
| `initRecoveryScanner` **2026-10-03 校准** | `(config: Partial<RecoveryConfig>) → void` | 阈值注入（`autoResumeMaxUnknownEffects` / `autoResumeMaxBudgetUsedRatio` / `requireHumanOnArtifactDrift`） |
| `scanAndProposeRecovery` **2026-10-03 校准** | `() → Result<RecoveryPlan[]>` | 原述 `Result<RecoveryPlan>`（标量）不实：**一次扫描对多个 loop 产出计划数组**，按单对象处理会误导调用方 |
| `getHumanRequiredPlans` **2026-10-03 校准** | `(plans: RecoveryPlan[]) → RecoveryPlan[]` | 数组分流：需人工裁决 |
| `getAutoResumePlans` **2026-10-03 校准** | `(plans: RecoveryPlan[]) → RecoveryPlan[]` | 数组分流：可自动恢复 |

### 2.5 recoveryExecutor.ts（**2026-10-03 校准**：整模块此前未登记，DUE 三件套第三条腿）

| 符号 | 签名 | 说明 |
|------|------|------|
| `executeRecovery` | `(plan: RecoveryPlan) → Result<ResumeResult>` | **仅 `AUTO_RESUME` 策略可自动执行**，其余策略返回 `err(..., 'ERROR')` 交人工；`AUTO_RESUME` 缺 `lastCheckpointId` 亦报错 |
| `resume` | `(loopId: string, checkpointId: string) → Result<ResumeResult>` | 四步：加载 Checkpoint → 校验产出清单结构（⚠️ 仅结构校验，真实文件哈希比对未实现）→ 装载 state（不装载消息历史）→ 返回 `iteration = state.iteration + 1` |
| `validateRecoveryPlan` | `(plan: RecoveryPlan) → Result<boolean>` | 计划合法性检查 |

`ResumeResult`：`{ loopId, checkpointId, iteration, stateSnapshot }`。

> ⚠️ 未接线：`main.ts` 启动仅调 `scanAndProposeRecovery()` 且**丢弃返回值**，`executeRecovery` / `resume` / `validateRecoveryPlan` / `getHumanRequiredPlans` / `getAutoResumePlans` 在 `Src/` 内均无调用点（仅 `Tests/Durable`、`Tests/E2E/crashRecovery` 使用）。崩溃恢复闭环尚未成立。

### 2.6 schemas/（**2026-10-03 校准**：整目录此前未登记）

数据模型细节指向 `Docs/Agent/09` 与 `Docs/Agent/12`，此处仅登记契约形态：

| 文件 | 导出 | 关键取值 |
|------|------|---------|
| `schemas/EffectRecord.ts` | `EffectRecord`、`EffectKind`、`EffectStatus`、`ErrorClass` | `EffectKind` 七值：`tool_execute` `file_write` `http_call` `db_write` `agent_message_send` `token_debit` `external_api`；`EffectStatus` 五值：`INTENT` `EXECUTING` `SUCCEEDED` `FAILED` `UNKNOWN`；`effectId` 即 `operation_id` |
| `schemas/Checkpoint.ts` | `Checkpoint`、`CheckpointRow`、`CreateCheckpointInput` | 含 `stateSnapshot` / `artifactManifest` / `pendingEffects` / `nextStepHint?` |
| `schemas/RecoveryPlan.ts` | `RecoveryPlan`、`RecoveryStrategy`、`RecoveryError`（class） | `RecoveryStrategy` 四值：`AUTO_RESUME` `REQUIRE_HUMAN` `RESTART_FROM_SCRATCH` `REBUILD_FROM_JOURNAL`；`RecoveryError` 带 `code` / `detail?` |

---

## 3. Logging (`Src/Infra/Logging/`)

### 3.1 logger.ts

**2026-10-03 校准**：`initLogger` / `shutdownLogger` 签名与返回类型按代码重写；`logger` 补第 5 个方法 `fatal` 与形参实名；补 3 个等级/写入器访问器。

| 符号 | 签名 | 说明 |
|------|------|------|
| `initLogger` | `(config: LoggerConfig) → boolean` | 原述 `(config?) → void` 两处不符：**config 必填**（`logDir` 无默认），**返回 boolean**＝"日志目录是否可写"（Gate G1 静默降级判据）。已初始化时幂等返回 `writer?.isDirWritable() ?? false`。调用方须判返回值决定是否降级 |
| `shutdownLogger` | `() → void` | 原述 `() → Promise<void>` 不实：**非 async**。flush 语义成立（内部 `writer.close()` → `flush()` + 写元数据 + 释放资源），但无异步边界。⚠️ 现状：`main.ts` 关闭 ⑥ 步写作 `await shutdownLogger()`（await 一个 void，无副作用但语义误导），`beforeExit` 侧为非 await 调用 |
| `logger.debug` | `(message: string, data?: LogData) → void` | 双轨日志（业务轨 / 系统轨，轨道由 `data.track` 指定或自动路由） |
| `logger.info` | `(message: string, data?: LogData) → void` | 同上；形参实名 `data`（非原文的 `meta`） |
| `logger.warn` | `(message: string, data?: LogData) → void` | 同上 |
| `logger.error` | `(message: string, data?: LogData) → void` | 同上 |
| `logger.fatal` **2026-10-03 校准** | `(message: string, data?: LogData) → void` | **第 5 级**：除入轨写盘外**强制 `console.error` 输出**（运维可见性契约）。⚠️ 当前 `Src/` 内无调用点（`Infra` 侧 FATAL 一律经 `err(..., 'FATAL')` 返回上层） |
| `getLogLevel` **2026-10-03 校准** | `() → LogLevel` | 当前级别 |
| `setLogLevel` **2026-10-03 校准** | `(level: LogLevel) → void` | 运行时改级（L2 热重载入口） |
| `getWriter` **2026-10-03 校准** | `() → LogWriter \| null` | 取写入器做高级操作 |

`LoggerConfig`：`{ logDir: string; level?: LogLevel; writerOverrides?: Partial<LogWriterConfig> }`
`LogData`：`{ track?: LogTrack; source?: string; [key: string]: unknown }`
级别权重：`debug 0 < info 1 < warn 2 < error 3 < fatal 4`，低于当前级别不写。

### 3.2 traceContext.ts（**2026-10-03 校准**：整文件此前未登记，§3 的追踪 ID 约定实际由它实现）

| 符号 | 签名 | 说明 |
|------|------|------|
| `runInTrace` | `<T>(options: CreateTraceOptions, fn: (ctx: TraceContext) => Promise<T>) → Promise<T>` | **async**：AsyncLocalStorage 建立 trace；`traceId` 缺省取 `randomUUID()` |
| `runInSpan` | `<T>(options: CreateSpanOptions, fn: (ctx: TraceContext) => Promise<T>) → Promise<T>` | **async**：无活跃 trace 时在空 ctx 下直跑；span 内 `operationId` 置空可再设 |
| `runWithOperation` | `<T>(...) → Promise<T>` | **async**：operation 粒度上下文 |
| `currentContext` | `() → TraceContext \| undefined` | 当前上下文 |
| `currentTraceId` | `() → string` | 无上下文时返回空串 |
| `currentSpanId` | `() → string \| undefined` | |
| `currentOperationId` | `() → string \| undefined` | |
| 类型 | `SpanType = 'llm_call' \| 'tool_exec' \| 'agent_run' \| 'middleware' \| 'custom'`、`TraceContext`、`CreateTraceOptions`、`CreateSpanOptions` | `TraceContext = { traceId, spanId?, spanType?, operationId?, parentAgentId?, agentId?, createdAt }` |

内部生成器（非导出，但决定 §3.3 约定）：`generateSpanId()` = UUID 去横杠前 **8** 位 hex；`generateOperationId()` 见 §3.3。

### 3.3 追踪 ID 约定

| 字段 | 约定 | 实现出处 |
|------|------|---------|
| `session_key` | SHA-256 前 16 位 hex（`hexLength` 可覆盖，合法区间 8-64） | `Workspace/sessionKeyGenerator.ts · generateSessionKey`（输入为 `Time.now()` + 16 随机字节） |
| `trace_id` | UUID v4 | `Logging/traceContext.ts · runInTrace`（`randomUUID()`） |
| `span_id` | 8 位 hex **2026-10-03 校准**（新登记） | `Logging/traceContext.ts · generateSpanId` |
| `operation_id` | `{base36(timestamp_ms)}-{4位hex}` **2026-10-03 校准** | `Logging/traceContext.ts · generateOperationId` |

> **2026-10-03 校准**：原约定写作 `{timestamp_ms}-{4位hex}` 与代码不符 —— 时间戳段实为 **`Date.now().toString(36)`（base36）**，非十进制毫秒；代码注释（同文件 `generateOperationId` 上方）亦沿误 `{timestamp_ms}`。文档按代码现状更正。
> 待办：①代码注释更正可另提 issue；②若下游（日志检索 / 外部解析）已按十进制解析该段，需先确认再决定是否反向改代码 —— 本项属对外可见格式，涉及取舍。

### 3.4 logWriter.ts（**2026-10-03 校准**：整文件此前未登记）

| 符号 | 签名 | 说明 |
|------|------|------|
| `LogWriter`（class） | `constructor(config: LogWriterConfig)`；方法 `init()` / `write(line: LogLine)` / `flush()` / `close()` / `isDirWritable()` / `hasWriteFailed()` / `getLogDir()` | 双轨落盘 + 缓冲；`close()` 内先 `flush()` 再写元数据 |
| `createLogWriter` | `(logDir: string, overrides?: Partial<LogWriterConfig>) → LogWriter` | 工厂；`logger.ts · initLogger` 唯一生产调用方 |
| 类型 | `LogTrack = 'business' \| 'system'`、`LogWriterConfig`、`LogLine` | 双轨日志的轨别与行结构定义处 |

---

## 4. Llm (`Src/Infra/Llm/`)

### 4.1 Router/modelRouter.ts

**2026-10-03 校准**：原表仅 2 行，实有 10 个导出；`getRoutingConfig` 补 `| null`。

| 符号 | 签名 | 说明 |
|------|------|------|
| `registerProvider` | `(provider: LlmProvider) → Result<void>` | 以 `provider.name` 为键注册，并逐模型登记 `provider/model` 全限定名；失败 `err(..., 'FATAL')` |
| `uniqueProviderName` | `(base: string) → string` | 注册名去重（FE-036）：占用则依次试 `base-2`、`base-3`…… 同类型多实例共存的前提 |
| `setRoutingConfig` | `(config: RoutingConfig) → void` | 注入路由配置 |
| `getRoutingConfig` | `() → RoutingConfig \| null` | **未注入配置时为 `null`**（原述无 `\| null`），调用方须判空 |
| `resolveModel` | `(qualifiedName: QualifiedModelName) → Result<{ provider, spec }>` | `provider/model` → Provider + ModelSpec；未注册 `err(..., 'ERROR')` |
| `getProviders` | `() → LlmProvider[]` | 全部 Provider |
| `unregisterProvider` | `(name: string) → void` | 运行时注销（连带其模型） |
| `getRegisteredModels` | `() → QualifiedModelName[]` | **REST `GET /api/models`（`RestApi/chatApi.ts`）与 IPC `ipc-get-models`（`IpcBridge/ipcBridge.ts`）的共同数据源** |
| `getFallbackProviders` | `() → LlmProvider[]` | 按 `fallbackOrder` 取；**无路由配置时退化为全部 Provider** |
| `resetRouter` | `() → void` | 清空注册表与配置（测试隔离） |

`RoutingConfig`：`{ defaultModel, directorModel, workerModel, verifierModel, arbitrationModels[], fallbackOrder[], timeoutMs, firstByteTimeoutMs, interChunkTimeoutMs }`；`QualifiedModelName = string`。

### 4.2 Provider/providerBase.ts

| 符号 | 签名 | 说明 |
|------|------|------|
| `LlmProvider`（abstract class） | `constructor(config: ProviderConfig)`；`get name` / `get displayName`；`getModels(): ModelSpec[]`；`supportsModel(modelId): boolean`；`getModelSpec(modelId): ModelSpec \| undefined`；`protected resolveApiKey(): string` | **构造即校验** `context_window` 必填且 >0，缺失 **throw**（拒注 → 启动失败，Docs/Agent/02 §10.4）。`resolveApiKey` 支持 `env:XXX` / `inline:XXX` 两式（inline 不持久化） |
| `LlmProvider.chat` | `abstract (options: CallOptions) → Promise<Result<CallResult>>` | 非流式调用 |
| `LlmProvider.chatStream` | `abstract (options: CallOptions, onChunk: (chunk: StreamChunk) => void) → Promise<Result<CallResult>>` | 流式调用 |

> **2026-10-03 校准**：原表两方法签名与返回类型（均 `Promise<Result<CallResult>>`）经复查**仍精确**；形参实名为 `options` / `onChunk`。

providerBase.ts 类型群（本层对外契约的形态来源，字段明细指向 `Docs/Agent/10` 配置文档）**2026-10-03 校准**（此前未列表）：
`ModelSpec`、`ProviderConfig`、`ChatMessage`、`CallOptions`、`CallResult`、`StreamChunk`、`ErrorCategory`（联合）、`ProviderError`（class，带 category）。

### 4.3 其余模块（**2026-10-03 校准**：此前未登记）

| 文件 | 导出 | 说明 |
|------|------|------|
| `Provider/openaiProvider.ts` | `OpenAIProvider`（class extends LlmProvider）、`createOpenAIProvider(config: ProviderConfig) → OpenAIProvider` | 唯一具体 Provider 实现 |
| `Provider/retryPolicy.ts` | `getRetryDecision(category: ErrorCategory) → RetryDecision`、`delay(ms: number, signal?: AbortSignal) → Promise<void>`、`classifyNetworkError(error: Error) → ErrorCategory`；类型 `RetryDecision` | 错误分类 → 重试/退避决策 |
| `Llm/index.ts` | 门面桶：Provider + Retry + Router 全量 re-export，并**跨目录 re-export** `Slm`（`callSlm` / `callSlmBatch`）与 `Embedding`（`getEmbeddings` / `getEmbedding`） | 上层经 `Infra/Llm` 单点取用三者；文档 §7 的 Slm/Embedding 亦经此门面进入消费视野 |

---

## 5. Security (`Src/Infra/Security/`)

> **2026-10-03 校准**：原表仅 3 个 `init*`（三行行号经复查精确，现改符号定位）。本层实有 7 文件、约 60 个导出；**`deviceFingerprint.ts` / `secretsStore.ts` / `keyStore.ts` / `workspaceGuard.ts` 四个整模块此前完全缺席**，其中 `secretsStore`（凭据读写）与 `workspaceGuard`（Tools 层运行期路径收敛依赖）优先补齐。

### 5.1 已登记项（现状复核）

| 模块 | 符号 | 签名 | 说明 |
|------|------|------|------|
| `trustLevels.ts` | `initTrustLevels` | `(config: { systemRoles?: string[]; userRoles?: string[]; externalRoles?: string[] }) → void` | 角色→信任级映射装配；**须在启动 ④ 步调用**。缺省三档恰为 `types.ts · UserRole` 的三分组：`systemRoles = ['regulator','auditor','arbitrator']` → L0、`userRoles = ['prime_director','partner']` → L1、`externalRoles = ['worker','reviewer','assembly_node']` → L2；调用即 `roleTrustMap.clear()` 后重建 |
| `whitelist.ts` | `initWhitelist` | `(config: WhitelistConfig) → void` | 白名单 / 禁止路径 / 禁止命令 / 网络域装配 |
| `pathGuard.ts` | `initPathGuard` | `(config: PathGuardConfig) → void` | 路径守卫装配 |

### 5.2 trustLevels.ts 其余导出（**2026-10-03 校准**）

| 符号 | 签名 | 说明 |
|------|------|------|
| `DangerLevel`（type） | `'SAFE' \| 'CONTROLLED' \| 'DANGEROUS' \| 'FORBIDDEN'` | **`Tools/Traits/toolSpec.ts` 的 `dangerLevel` 字段定义源**（Tools→Infra，方向合规）；`Docs/Agent/09`/`14` 同集合 |
| `TrustLevelInfo` / `DangerLevelInfo`（interface） | — | 级别语义描述体 |
| `getTrustLevel` | `(role: string) → TrustLevel` | 角色查询；**未登记角色一律返回 `'L2'`**（最小权限兜底） |
| `getTrustLevelInfo` | `(level: TrustLevel) → TrustLevelInfo` | 级别详情 |
| `hasTrustLevel` | `(role: string, requiredLevel: TrustLevel) → boolean` | 是否具备该级别 |
| `getDangerLevelInfo` | `(level: DangerLevel) → DangerLevelInfo` | 危险级详情 |
| `isValidDangerLevel` | `(level: string) → level is DangerLevel` | 字符串→枚举守卫 |
| `isToolAllowed` | `(toolDangerLevel: DangerLevel, userTrustLevel: TrustLevel) → boolean` | 危险级 × 信任级授权矩阵判定 |
| `getAllRoleTrustLevels` | `() → ReadonlyMap<string, TrustLevel>` | 全量映射（只读） |
| `isTrustLevelsInitialized` | `() → boolean` | 装配自检 |

### 5.3 whitelist.ts 其余导出（**2026-10-03 校准**）

| 符号 | 签名 | 说明 |
|------|------|------|
| `ToolRegistration` / `WhitelistConfig`（interface） | — | 注册条目与配置体 |
| `registerTool` | `(tool: ToolRegistration) → boolean` | 登记（注意：与 `Tools/Registry/toolRegistry.ts · registerTool` **同名不同义**，勿按名字猜层级） |
| `isToolRegistered` / `getToolRegistration` / `getRegisteredToolNames` | `(name) → boolean` / `(name) → ToolRegistration \| undefined` / `() → string[]` | 注册面查询 |
| `isToolAllowedForRole` | `(toolName: string, allowedTools: string[]) → boolean` | 角色可见性交叉校验 |
| `isPathForbidden` / `isCommandForbidden` / `isNetworkAllowed` | `(path) → boolean` / `(command) → boolean` / `(hostname) → boolean` | 三类禁止/放行判定 |
| `getToolsByDangerLevel` | `(level: DangerLevel) → ToolRegistration[]` | ⚠️ **同名双源**：`Tools/Registry/toolRegistry.ts` 另有 `getToolsByDangerLevel(level: string) → ToolSpec[]`，形参与返回元素类型均不同，两侧各自导出、测试侧（`Tests/Infra/security.spec.ts`）引的是 **Infra 版**。二者关系属跨层裁定项，口径由 `toolsInterfaces.md` 承接，本文档只记录现状 |
| `clearWhitelist` | `() → void` | 测试隔离 |

### 5.4 pathGuard.ts 其余导出（**2026-10-03 校准**）

| 符号 | 签名 | 说明 |
|------|------|------|
| `checkPath` | `(path: string, action: 'read' \| 'write' \| 'delete' \| 'list' = 'read') → PathCheckResult` | 守卫主入口 |
| `safeResolve` | `(path: string, action? = 'read') → Result<string>` | 解析 + 校验合一 |
| `onPathAccess` | `(callback: (event: PathAccessEvent) => void) → void` | 访问事件订阅（审计挂钩点） |
| `getProjectRoot` / `isPathGuardInitialized` / `addForbiddenPath` / `resetPathGuard` | `() → string` / `() → boolean` / `(path) → void` / `() → void` | 根路径、装配自检、运行期禁列扩充、重置 |
| `PathGuardConfig` / `PathCheckResult` / `PathAccessEvent` | 类型 | 形态定义处 |

### 5.5 secretsStore.ts（**2026-10-03 校准**：整模块此前未登记，凭据面）

存储机制（按代码自述与实现登记）：经 **Electron `safeStorage`** 动态导入做系统级加密（Windows DPAPI / macOS Keychain / Linux libsecret），落盘路径 `Data/.secrets/providers.json.enc`；`safeStorage` 不可用（非 Electron 环境）时**降级为带 `__base64__:` 前缀的 Base64 编码**（代码注释限定"仅开发环境"），解密侧对两种格式自适应；明文 API_KEY 只存内存，不随 `syncService` 上云，`Data/.secrets/` 由 `.gitignore` 排除。

| 符号 | 签名 | 说明 |
|------|------|------|
| `saveProviderSecrets` | `(secrets: ProvidersSecrets) → Promise<void>` | **async**：整表序列化 → 加密（或降级编码）→ `writeFileSync` 落盘 |
| `loadProviderSecrets` | `() → Promise<ProvidersSecrets \| null>` | **async**：文件不存在返回 `null`；解密失败被 try/catch 吞掉后亦返回 `null`（⚠️ 读失败与无数据不可区分） |
| `upsertProviderSecret` | `(entry: ProviderSecret) → Promise<void>` | **async**：**单条合并语义** —— 先 `loadProviderSecrets()`，按 `name`（兼容 `provider`）匹配剔除旧条目后整表回写，**保留其余供应商**（修复"再加一个模型就把上一个 API_KEY 刷掉"） |
| `removeProviderSecret` | `(name: string) → Promise<boolean>` | **async**：无存储或无命中一律返回 `false` 且**不写盘**；命中则回写余下表并返回 `true` |
| `isEncryptionAvailable` | `() → Promise<boolean>` | **async**：`safeStorage.isEncryptionAvailable()` 探测，决定加密/降级路径 |
| `hasUsableSecret` | `(entry: ProviderSecret) → boolean` | 同步判可用性（无网络、无解密） |
| `ProviderSecret` / `ProvidersSecrets` | 类型 | 凭据条目与集合形态 |

跨层消费：`Interface/IpcBridge/ipcBridge.ts`（`ipc-save-secrets` / `ipc-load-secrets` 通道）。规范层约束待办见 §8（凭据读写路径需在开发规范显式约束）。

### 5.6 deviceFingerprint.ts / keyStore.ts / workspaceGuard.ts（**2026-10-03 校准**：整模块此前未登记）

| 模块 | 导出符号与签名 | 说明 |
|------|----------------|------|
| `deviceFingerprint.ts` | `getDeviceFingerprint() → string` | MAC 列表 + 主机名 + 磁盘序列号 → SHA-256，**64 位 hex**；单项采集失败以空串参与（不抛）。经 `ipcBridge.ts`（`ipc-get-device-fingerprint`）对外 |
| `keyStore.ts` | `registerKey(name: string, refs: KeyRef[], purpose?: string) → void`、`resolveKey(name) → Result<ResolvedKey>`、`isKeyAvailable(name) → boolean`、`getMaskedKey(name) → string`、`resolveSingleRef(ref) → Result<{ value, envVar }>`、`isKeyRef(value) → boolean`、`clearKeyStore() → void`、`getRegisteredKeyNames() → string[]`、`scanAndRegisterRefs(config: Record<string, unknown>, prefix? = '') → void`；类型 `KeyRef` / `ResolvedKey` / `KeyEntry` | 密钥引用注册与解析。**引用格式仅 `env:XXX`**（`inline:` 是 `Llm/Provider/providerBase.ts · resolveApiKey` 的另一套，勿混用）；`refs` 按序回退（首个为主键，命中靠后者时 `ResolvedKey.isFallback = true`），解析结果按 `name` **缓存**（环境变量变更不会自动失效，须 `clearKeyStore`）；全部未设置时 `err(..., 'FATAL')`。`getMaskedKey` 为日志专用脱敏形态（前 3 位 + `****` + 后 4 位；不可用返回 `'[未设置]'`） |
| `workspaceGuard.ts` | `workspaceBaseDir() → string`、`defaultWorkspaceDir(sessionId, baseDir?) → string`、`ensureWorkspaceDir(dir) → Result<string>`、`isWithinWorkspace(target, workspaceRoot) → boolean`、`resolveWithinWorkspace(target, workspaceRoot) → Result<string>`、`findEscapingPathInCommand(command, workspaceRoot) → string \| null` | **`ToolExecutionContext.workDir` 收敛的运行期守卫**（toolSpec 注释直接指向本模块）：`Tools/Builtin/Read/*`、`Write/*`、`Execute/shellRunner` 全部经 `resolveWithinWorkspace` / `findEscapingPathInCommand` 做逃逸判定；`Interface/RestApi/chatApi.ts` 亦消费 `defaultWorkspaceDir` / `ensureWorkspaceDir` |

---

## 6. types.ts（`Src/Infra/types.ts`）

> **2026-10-03 校准**：原 6 条目经复查 **6/6 精确**（符号名、可选性、默认值均一致）；补 `UserRole`（8 角色单一真相源，缺位会导致角色定义在规范层无锚点）与 `ErrorSeverity`，另登记本文件其余 3 个横切类型。

| 类型 | 定义/签名 | 说明 |
|------|-----------|------|
| `Result<T>` | `= Ok<T> \| Err` | 统一结果类型（判别字段 `ok`） |
| `Ok<T>` | `{ readonly ok: true; readonly value: T }` | 成功分支 |
| `Err` | `{ readonly ok: false; readonly error: string; readonly severity: ErrorSeverity }` | 失败分支 |
| `ok<T>(value: T): Ok<T>` | — | 成功构造 |
| `err(error: string, severity: ErrorSeverity = 'ERROR'): Err` | — | 失败构造，`severity` 可选、默认 `'ERROR'` |
| `SessionKey` | `= string` | SHA-256 前 16 位 hex |
| `TraceId` | `= string` | UUID v4 |
| `OperationId` | `= string` | `{ts}-{4hex}`（⚠️ 该文件注释写作 `{timestamp_ms}-{4位hex}`，与实现不符，见 §3.3 校准注） |
| `UserRole` **2026-10-03 校准** | `'prime_director' \| 'partner' \| 'regulator' \| 'auditor' \| 'arbitrator' \| 'worker' \| 'reviewer' \| 'assembly_node'` | **8 角色单一真相源**：L0 治理级 regulator/auditor/arbitrator、L1 入口级 prime_director/partner、L2 执行子级 worker/reviewer/assembly_node。被 `Tools/Traits/toolSpec.ts`、`Core/AgentRuntime/types.ts`、`Tools/Factory/toolFactory.ts` 等跨层引用，是分层契约的根类型 |
| `ErrorSeverity` **2026-10-03 校准** | `'ERROR' \| 'FATAL' \| 'PANIC'` | `err()` 严重度取值域；Infra 启动/落库类失败一律 `'FATAL'` |
| `LogLevel` **2026-10-03 校准** | `'debug' \| 'info' \| 'warn' \| 'error' \| 'fatal'` | 与 `Logging/logger.ts` 五方法、`logWriter` 权重表同源 |
| `TrustLevel` **2026-10-03 校准** | `'L0' \| 'L1' \| 'L2'` | 信任级（Docs/Agent/10 §3.2） |
| `MutabilityLevel`（enum） **2026-10-03 校准** | `L0 \| L1 \| L2 \| L3` | 配置可变性四档（L0 启动锁定 / L1 启动读一次 / L2 热重载 / L3 实时）；`Config/mutationLevels.ts` 消费 |

---

## 7. 其余 Infra 目录（**2026-10-03 校准**：新增本节）

> 原文档分 6 节，`Src/Infra/` 实有 **17 个子目录**（`types.ts` 除外）。下列 10 个目录此前整目录未设节；其中 `Contracts/` 缺位最需优先补——它是"跨层契约"的物理位置（`AgentMiddleware` 已迁入，ADR-0006 结论落点），层间契约文档不提它等于漏掉整条 ADR。
> 每目录只列接口面要点，字段级细节指向对应设计文档。

| 目录 | 门面 | 代表导出 | 说明 |
|------|------|---------|------|
| `Contracts/` | `Contracts/index.ts` | `middlewareTypes.ts`：`AgentMiddleware`、`MiddlewareHook`、`MiddlewareContext`、`ModelCallInput/Output`、`ToolCallInput/Output`、`BeforeAgentHook` / `BeforeModelHook` / `WrapModelCallHook` / `WrapToolCallHook` / `AfterModelHook` / `AfterAgentHook`、`HookFunction`；`rateLimitTypes.ts`：`RateLimitConfig` + `DEFAULT_RATE_LIMIT_CONFIG`、`ApiRateLimitConfig` + `DEFAULT_API_RATE_LIMIT_CONFIG`、`RateLimitState` + `createInitialRateLimitState()`、`RateLimitCheckResult` | **跨层共享内核契约**（纯类型、零运行时、零上层 import），用于消除层间反向依赖，详见 ADR-0006。`AgentMiddleware` 现定义于此，`Core/Middleware` 不再持定义；`Services/LoopControl/middleware/*` 直接 import 本目录 |
| `Config/` | （无 index） | `configLoader.ts`：`loadConfig(options: ConfigLoaderOptions = {}) → Result<LoadedConfig>`、`getConfigValue<T>(config, path)`、`getConfigValueOr<T>(config, path, defaultValue)`；`configValidator.ts`：`validateDefaultConfig` / `validateLoopConfig`（均 `→ Result<ValidationError[]>`）、`validateAllConfigs(configs) → Result<void>`、类型 `ValidationError`；`mutationLevels.ts`：`getMutabilityLevel(section)`、`isHotReloadable(section)`、`isStartupLocked(section)`、`getStartupLockedSections()`、类型 `MutabilityEntry` | `main.ts` 启动第 ① 步底座；`getConfigValueOr` 是所有 `init*` 配置装配的取值入口。被其余四份契约文档大量隐式引用 |
| `Fs/` | （无 index） | `atomicWrite.ts`：`atomicWrite(filePath, content, options?)`、`atomicWriteBuffer(filePath, data, options?)`、`atomicAppend(filePath, content, options?)`（均 `→ Result<string>`）；`fsSafe.ts`：`safeReadFile` / `safeWriteFile` / `safeReadJson<T>` / `safeWriteJson` / `validateDirectory` / `ensureDir` / `safeExists` / `safeListDir`；`pathResolver.ts`：`isPortableMode`、`getDataDir` / `getLogDir` / `getConfigDir` / `getPromptsDir` / `getSkillsDir` / `getDatabaseDir` / `getWorkspaceDir`、`ensureDir`、`initDirectories`、`paths` 对象；`quotaManager.ts`：`setQuota` / `canWrite` / `recordUsage` / `getUsage` / `syncUsage` / `scanDirectorySize` / `clearQuotas` | 全层唯一文件写入面（临时文件 + rename 原子语义）；`canWrite` 支撑 Gate G2 满盘拒绝；`paths` 是路径单一真相源（便携模式感知）。`main.ts` 的"文件系统初始化"步骤调 `initDirectories()` 完成目录装配 |
| `Hook/` | `Hook/index.ts` | `hookExecutor.ts`：`initHookExecutor(userConfig?: Partial<HookExecutorConfig>) → void`、`executeHookWithRetry(hookName: string, fn: () => Promise<void>) → Promise<HookExecutionResult>`（**async**，按 `maxRetries` 循环重试）、`getHookExecutorConfig() → HookExecutorConfig`；类型 `HookExecutorConfig` / `HookExecutionResult`；`System/auditHook.ts`：`systemAuditHook(event)`、`systemBackupHook(event)`、`systemMetricsHook(event)` | Infra 侧 Hook **执行底座**（重试/超时/降级），与 `Services/Hook`（注册与派发）分层配套。⚠️ 门面仅导出 `hookExecutor` 三项，`System/auditHook.ts` 三个系统钩子须经文件直引 |
| `Sandbox/` | （无 index） | `workspaceIsolator.ts`：`initWorkspaceIsolator({ dataRoot? })`、`createIsolatedWorkspace(params)`、`recordFileModification(agentId, filePath)`、`getAgentWorkspace` / `getAllWorkspaces` / `getTaskWorkspaces` / `listOutputFiles`、`validateIsolation(agentId, accessedPath)`、`cleanAgentWorkspace`、`markMerged` / `markFailed` / `resetWorkspaceIsolator`；类型 `IsolationLevel`、`AgentWorkspace`；`gitWorktreeManager.ts`：`initGitWorktreeManager`、`createWorktree`、`writeFileInWorktree` / `readFileFromWorktree`、`listModifiedFiles`、`commitWorktree`、`detectConflicts`、`mergeWorktrees`、`cleanWorktree`、`getWorktree` / `getAgentWorktree` / `resetGitWorktreeManager`；类型 `WorktreeEntry` / `MergeResult` / `MergeConflict` | `main.ts` 启动 ⑧ 步调 `initWorkspaceIsolator`；关闭序列调 `getAllWorkspaces` + `cleanAgentWorkspace` |
| `Slm/` | `Slm/index.ts`（并 `Llm/index.ts` re-export） | `slmCaller.ts`：`callSlm(options: SlmCallOptions) → Promise<Result<SlmCallResult>>`、`callSlmBatch(calls: SlmCallOptions[]) → Promise<Array<Result<SlmCallResult>>>`（**顺序串行**逐条 `await callSlm`，非并发）；类型 `SlmCallOptions`、`SlmCallResult` | 小模型调用面（分类/摘要类轻任务），与 §4 Llm 并存但独立 Provider 路由 |
| `Time/` | （无 index） | `timeService.ts`：`Time` 门面对象 —— `now(): number`、`nowSec(): number`、`isoNow(): string`、`monotonicMs(): number`、`since(startMs): number`、`format(epochMs): string`、`getState(): TimeServiceState`、`onDrift(callback)`；类型 `ClockDriftEvent`、`TimeServiceState` | **系统取时唯一推荐入口**：含时钟回拨检测与补偿（回拨时不更新基准、累加补偿并保证单调递增）。`Workspace/sessionKeyGenerator.ts` 即经 `Time.now()` 取时 |
| `Watcher/` | `Watcher/index.ts` | `configWatcher.ts`：`initConfigWatcher(config)`、`onConfigChange(handler)`、`startWatching(): Result<void>`、`stopWatching()`、`notifyChange(filePath, changeType)`、`isWatching()`、`resetConfigWatcher()`；类型 `ConfigChangeHandler`、`ConfigWatcherConfig`；`fileWatcher.ts`：同构一套 `initFileWatcher` / `onFileChange` / `startFileWatching` / `stopFileWatching` / `notifyFileChange` / `isFileWatching` / `resetFileWatcher` | `main.ts` 启动 ⑨ 步 `initConfigWatcher({ watchDir: 'Configs/', pollIntervalMs: 5000 })`；`changeType = 'modified' \| 'deleted' \| 'added'`。是 L2 热重载的触发源 |
| `Workspace/` | `Workspace/index.ts` | `workspaceManager.ts`：`initWorkspace(config: WorkspaceConfig) → Result<void>`、`getWorkspaceConfig(): WorkspaceConfig \| null`、`getSessionPaths(sessionKey)`、`createSessionWorkspace(sessionKey)`、`archiveSessionWorkspace(sessionKey)`、`removeSessionWorkspace(sessionKey)`、`sessionWorkspaceExists(sessionKey): boolean`、`resetWorkspace()`；类型 `WorkspaceConfig` / `SessionWorkspace` / `SessionMeta`；`sessionKeyGenerator.ts`：`generateSessionKey(options: SessionKeyOptions = {}) → Result<string>`、`isValidSessionKey(key, hexLength = 16): boolean`；类型 `SessionKeyOptions` | `main.ts` 启动 ⑦ 步 `initWorkspace({ dataRoot })`；`generateSessionKey` 为 §3.3 `session_key` 格式的实现处（可选 `existsFn` 碰撞重试，最多 `maxRetries = 10`） |
| `Embedding/` | `Embedding/index.ts`（并 `Llm/index.ts` re-export） | `embeddingClient.ts`：`getEmbeddings(options: EmbeddingOptions) → Promise<Result<EmbeddingResult>>`、`getEmbedding(model: string, text: string, timeoutMs?) → Promise<Result<number[]>>`（内部调 `getEmbeddings`，返回集为空时 `err('Embedding 返回结果为空', 'ERROR')`）；类型 `EmbeddingOptions`、`EmbeddingResult` | 向量化调用面（检索/记忆侧底座）；**原差别清单亦未列此目录**，属本轮新发现缺项 |
| `Env/`、`Terminal/` | — | — | ⚠️ **未实现/目标态**：目录存在但**无任何源文件**（占位）。接口面无内容可登记；勿在文档中当作可用能力引用 |

---

## 8. 现状与未接线登记（**2026-10-03 校准**）

> 本节按"现状记录 + 待办"登记，不对任何跨层取舍作裁定。

| 项 | 现状（代码实态） | 待办 |
|----|------------------|------|
| 分层红线 | ✅ `Src/Infra/` 对上层 import **0 命中**，"最底层、无上行依赖"成立 | 无 |
| events 库写入 | ⚠️ `events` / `action_fingerprints` / `domain_events` 三表由迁移建出但**无生产写入点**；事件实际落 main 库 `ai_events`（`Interface/EventStore/aiEventStore.ts`） | 明确事件溯源落库归属（events 库 vs main `ai_events`），避免两套事件面并存 |
| Checkpoint 双实现 | ⚠️ Infra `checkpointStore.ts`（DB 事务，Gate G2/DUR-003）无调用点；`Services/LoopControl/middleware/checkpointWriter.ts` 以内存 Map 自述 "Phase 0" 记录 checkpoint | 二选一收敛：把 Loop 侧写入接到 Infra DB 版，或将 Infra 版标记为仅供测试。属跨层归属，需裁定 |
| 恢复闭环 | ⚠️ `scanAndProposeRecovery()` 在 `main.ts` 被调用但**返回值被丢弃**；`executeRecovery` / `resume` / `validateRecoveryPlan` / `getHumanRequiredPlans` / `getAutoResumePlans` 无生产调用点（仅 `Tests/Durable`、`Tests/E2E`） | 启动扫描结果需分流（人工队列 / 自动恢复）并接线，否则 DUR 恢复链仅存在于测试 |
| `migrateDown` 覆盖面 | ⚠️ 仅读 main 库 `_migrations` 的 MAX(version)，events / memory 库迁移不可回滚 | 补齐两库回滚语义或显式声明"down 仅作用于 main" |
| `transaction.ts` 使用面 | ⚠️ 三个事务包装函数无调用点，上层各自用 `db.transaction(...)` | 决定是否将本层作为事务唯一入口（Gate 一致性所需），属规范取舍 |
| `Repository` 返回形态 | ⚠️ `agentRepository.ts` 的 `upsertAgent` / `updateAgentRow` / `rowToAgentInstance` 返回裸值（void/对象），与本层 `Result` 约定不一致；`sessionRepository.ts` 全部返回 `Result` | 统一为 `Result` 需改代码，文档仅登记差异 |
| `logger.fatal` | ⚠️ 定义存在且强制 `console.error`，但 `Src/` 内无调用点 | 明确致命错误的日志面（当前仅经 `err(..., 'FATAL')` 返回） |
| 凭据与设备指纹面 | 现状：`secretsStore.ts`（全 `Promise` 化，Electron `safeStorage` 可用则加密、否则 Base64 降级）与 `deviceFingerprint.ts` 经 `ipcBridge.ts` 的 `ipc-save-secrets` / `ipc-load-secrets` / `ipc-get-device-fingerprint` 直接对外 | **建议**在规范层成文补约束：①降级存储的适用环境（仅开发）与生产禁用条件；②对外仅允许 `keyStore · getMaskedKey` 脱敏形态；③上述三条 IPC 通道的鉴权与审计要求。`getToolsByDangerLevel` 同名双源口径由 `toolsInterfaces.md` 裁定 |
| 密钥解析缓存 | 现状：`keyStore · resolveKey` 结果按 `name` 缓存，环境变量变更后不自动失效（须显式 `clearKeyStore`） | 是否纳入 L2 热重载面需裁定；文档只登记"改 env 不即时生效"这一既有语义 |
| `operation_id` 时间戳进制 | 现状：实现为 `{base36(ts)}-{4hex}`，代码注释与本层 `OperationId` 注释均误作 `{timestamp_ms}` | 注释可径改（低风险）；是否反向改代码取决于下游是否已按十进制解析（§3.3） |
