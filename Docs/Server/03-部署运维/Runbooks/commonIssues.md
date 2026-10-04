# 常见问题 Runbook

> 运维中常见问题的快速处理方案

> **适用范围（2026-10-03 校准）**：§1–§4 主要面向**本地端**（`Src/`，HTTP :3000 + Electron）。服务端线（`Server/`，Fastify :8787 + PostgreSQL）的故障面独立，探活见 `healthCheck.md` §5、回滚见 `rollback.md` §3。

---

## 1. 系统无法启动

**症状**：`npm run start`（= `tsx Src/main.ts`，`package.json:15`）后立即退出

**真实退出点**（2026-10-03 校准：按代码列出，取代原"API Key 未配置"这一误判）

| 位置 | 触发条件 |
|------|---------|
| `Src/main.ts:72` | 配置加载失败（`Configs/` 三层合并出错） |
| `Src/main.ts:141` | 数据库初始化失败（`Data/db/` 不可建/不可写） |
| `Src/main.ts:144` | 迁移系统初始化失败 |
| `Src/main.ts:147` | 数据库迁移失败（`migrateUp` 返回 err） |
| `Src/main.ts:157` | 工作区初始化失败 |
| `Src/main.ts:233` | `providerCount === 0` → `throw '无可用 LLM Provider'` |
| `Src/main.ts:237` | 工具注册失败 |
| `Src/main.ts:393` | 顶层 catch → `process.exit(1)` |

**排查步骤**

1. 先看控制台错误，再看 `Logs/business.log` 末行与 `Logs/system.log`（error/fatal 落 system 轨，`Src/Infra/Logging/logger.ts:219-225`）。
2. 若报「无可用 LLM Provider」：检查 `Configs/default.json` 的 `llm` / `routing` 段能否解析出**至少 1 个注册成功**的 Provider。启动期计数只看 `registerProvider()` 是否 ok（`Src/main.ts:217-218`），**Provider 注册失败本身被 `catch` 吞掉不阻塞**（`:219`），所以"全被吞掉"才会走到 `:233` 的 throw。
3. 检查端口占用：3000（本地端 HTTP）、5173（Vite）、8787（Server 线）。
4. 检查 `Data/db/` 目录权限；注意路径可被 `CIVITAS_DATA_DIR` 重定向（`Src/Infra/Fs/pathResolver.ts:42-44`），安装模式下默认落 `%APPDATA%\CivitasAI\Data`（`:52-55`）。

> **更正（原步骤 2）**：`.env` 中 API Key 未配置**不是**启动退出的原因。API Key 是**调用期惰性解析**的：`resolveApiKey()`（`Src/Infra/Llm/Provider/providerBase.ts:186-201`，缺变量时 `throw ProviderError('auth', …)`）、`keyStore.resolveKey()`（`Src/Infra/Security/keyStore.ts:76-100`）、embedding 侧 `Src/Infra/Embedding/embeddingClient.ts:59-63`。启动阶段既不解析 key 也不因缺 key 退出。→ API Key 问题请看 §4。

## 2. 数据库锁定

**症状**：`SQLITE_BUSY: database is locked`

**原因（2026-10-03 校准：原"SQLite 不支持并发写入"表述已过时）**
本地端三套库**已配置并发缓解**，多数读写冲突被吸收：

| PRAGMA | 值/来源 | 位置 |
|--------|--------|------|
| `journal_mode = WAL` | 固定开启（`database.ts:141`，开关来自 `Configs/default.json:20` 的 `database.walMode`，读取点 `Src/main.ts:137`） | `Src/Infra/Db/database.ts:141` |
| `busy_timeout` | `5000` ms（`Configs/default.json:21` → `Src/main.ts:138` → `database.ts:138,143`） | `Src/Infra/Db/database.ts:143` |
| `synchronous` | main 库默认 `FULL`，其余 `NORMAL`（`durable.effect.writeSynchronous`，`Src/main.ts:131-132`） | `Src/Infra/Db/database.ts:147` |
| `foreign_keys = ON` | 固定 | `Src/Infra/Db/database.ts:144` |

所以仍报 `SQLITE_BUSY` 时，**先怀疑有第二个进程或外部工具持写锁**（编辑器/`sqlite3` CLI/另一份 `npm run start`/备份脚本未停进程），而不是"SQLite 天生不能并发"。

**解决**

1. 确认只有一个进程在写数据库（`netstat -ano \| findstr :3000` 查是否有两份后端）。
2. 调大 **`database.busyTimeoutMs`**（完整点分路径；校验见 `Src/Infra/Config/configValidator.ts:67`，缺省回落值见 `Src/main.ts:138`）。**注意**：可新建 `Configs/local.json` 写覆盖项（`default.json → {env}.json → local.json` 三层合并，`Src/Infra/Config/configLoader.ts:72-73`；该文件当前不存在且被 `.gitignore:19` 排除），不必改 `default.json`。
3. 必要时重启进程；若 `-wal` 持续膨胀，按 `rollback.md` §2.2 先停进程再 `wal_checkpoint(TRUNCATE)`。

> **现状记录**：全仓**没有** `SQLITE_BUSY` 的专门处理分支（`grep -rn "SQLITE_BUSY" Src/ Client/src` 0 命中），即重试只能靠 `busy_timeout` 的内建等待，业务层无退避重试。**待办**：若需要自动重试，需先在 DB 层加错误识别。

## 3. 内存泄漏

**症状**：进程内存持续增长

**排查（2026-10-03 校准：更正被指错的配置项）**

1. **共享记忆没有 `maxEntries` 这一项**。原步骤写错了对象：`maxEntries` 只存在于**缓存/归档模块的硬编码默认值**里，且**不从 `Configs/` 读取**，因此"调小 `maxEntries`"当前不可操作：
   - `Src/Services/Cache/promptCache.ts:38`、`:46` → 默认 **100**
   - `Src/Services/Cache/toolResultCache.ts:32`、`:38` → 默认 **200**（`getToolResultCacheStats()` `:118-119` 可读 size/maxEntries）
   - `Src/Services/Session/archiveManager.ts:32`、`:38` → 默认 **1000**
2. **共享记忆的真实可配项**在 `Configs/memory.json` 的 `memory` 段（键为实测清单）：
   `capsuleBudgetTokens`(4000)、`capsuleMessageBudgetTokens`(2000)、`capsuleMemoryTopK`(5)、`capsuleRecentOpsCount`(5)、`longTermConsolidationDelayMs`(5000)、`privateStateTtlSec`(3600)、`vectorDim`(1536)、`supersedeGraceSec`(60)、`conflictSimilarityThreshold`(0.85)。
   内存增长先看 `capsuleBudgetTokens` / `capsuleMessageBudgetTokens` / `privateStateTtlSec`。
3. **事件队列 `maxQueueSize`（现状记录，配置项当前无效）**：`Configs/memory.json:14` 确有 `eventBus.maxQueueSize = 10000`，`initEventBus()` 也接收该字段（`Src/Services/EventBus/eventBus.ts:31`、`:35`），**但启动处的实参是硬编码字面量**——`initEventBus({ maxQueueSize: 10000 })`（`Src/main.ts:357`），且全仓没有任何读取 `Configs/memory.json` 的 `eventBus` 段的代码（`grep -rn "memory.json" Src/` 0 命中）。**改配置不会生效**；要改只能改 `Src/main.ts:357`（属源码改动，需另开单）。队列裁剪逻辑：`eventBus.ts:53`（超上限 `shift()`）。
4. **IPC 监听 / 降级轮询**（三项均真实存在，此处补精确路径）：
   - Electron 渲染侧：`electron/preload.ts:93`（`ipcRenderer.on('backend-event', …)`）、`:101`（`removeAllListeners`）；主进程发送侧 `Src/Interface/IpcBridge/ipcBridge.ts:130`、`:645`。**监听器泄漏只在 Electron 主进程/渲染进程侧可观测**，`:3000` 的 HTTP 侧看不到。
   - 浏览器降级轮询：`Client/src/services/eventBusBridge.ts:25`（`FALLBACK_POLL_MS = 3000`）、`:87-93`（`setInterval` 与 `fallbackTimer` 句柄）。轮询定时器未释放是可疑方向，但需确认 `clearInterval` 在卸载路径被调用。
5. `--inspect` 启动并用 Chrome DevTools 抓 heap snapshot。

## 4. LLM 调用全部超时

**症状**：所有模型调用返回超时

**排查**

1. 检查网络连接与 Provider 服务状态。
2. 检查 API Key 是否有效——**这类症状才对应 key 缺失**：调用期 `resolveApiKey()` 抛 `ProviderError('auth', '环境变量 XXX 未设置')`（`Src/Infra/Llm/Provider/providerBase.ts:186-201`）。本地端 key 走 `api_key_ref: "env:XXX"`（`Src/Infra/Security/keyStore.ts:5`、`:76-100`），根 `.env.example` 当前只提供 `HUAWEI_MAAS_API_KEY`。
3. **超时是三个独立键，语义不同**（2026-10-03 校准：原"检查 `timeoutMs` 是否过短"不足以定位首字节超时）。配置在 `Configs/modelRouter.json:50-52`，运行期一次性读取于 `Src/main.ts:229-231`：

| 键 | 默认 | 语义 |
|----|------|------|
| `timeoutMs` | 60000 | 整次调用总时长 |
| `firstByteTimeoutMs` | 10000 | **首字节/首包**等待 |
| `interChunkTimeoutMs` | 15000 | **块间**空闲等待 |

   只调大 `timeoutMs` 对"连不上/首包慢"**无效**，必须动 `firstByteTimeoutMs`（或 `interChunkTimeoutMs`）。
4. 实测首响延迟，区分"网络/服务慢"与"阈值过短"：

```bash
node Scripts/llmLatency.cjs                    # 需 HUAWEI_MAAS_API_KEY；默认测 GLM-5.1 / GLM-5 / DeepSeek-V4-Flash
node Scripts/llmLatency.cjs GLM-5
```

5. 硬上限参考：`Configs/loopConfig.json:10-12` 的 `hardLimits.timeoutMsCeiling`（当前 600000），读取点 `Src/main.ts:283`（`hardLimits` 段）与 `Src/main.ts:293`（注入 `setLoopLimits` 的 `maxTimeoutMs`）。

> **待办 / 【需人工裁定】**：三键是否应收敛为"一个总超时 + 一个首字节超时"的两键口径、`firstByteTimeoutMs` 是否应随 Provider 而异，属参数口径决策，本文只登记实态，不裁决。

## 5. 回滚操作

**场景**：新版本出现严重问题，需要回滚

**本节不重复流程**——完整步骤（含按两条线拆分的可逆性、WAL 前提、PG 备份通道）见 `Docs/Server/03-部署运维/Runbooks/rollback.md`。最小可用序列：

```bash
# 1. 停止当前服务（含 Electron 主进程，避免持写锁）
# 2. 回退代码
git checkout <last-known-good-commit>
# 3. 重新安装依赖（Server 线需在 Server/ 内再装一次）
npm install
# 4. 重启：注意 npm run start 跑的是 TS 源码（tsx Src/main.ts），不是构建产物
npm run start          # 无头/后端
npm run start:electron # 桌面产物入口（package.json:16）
```

**事实更正（2026-10-03 校准）**：原文注"数据库迁移不可回退"——

- 对**本地端 SQLite 不成立**：每条迁移都带 `down` SQL、`migrateDown()` 存在（`Src/Infra/Db/migrations.ts:26`、`:711-731`），只是**没有 CLI 入口**（根 `package.json` 无 `db:*` 迁移 script）。
- 对**服务端 PG 成立**：`runMigrations()` 无 down 分支 + checksum 漂移锁（`Server/src/db/migrate.ts:80-122`、`:91-95`），但存在 `/v1/backup`、`/v1/restore` 备份通道（`Server/src/routes/backup.ts:20`、`:46`）。

**【需人工裁定】现状记录 + 待办**：本节与 `rollback.md` 属同一流程的双写，历史上已出现口径互相矛盾（本文原写"不可回退"、`rollback.md` 原写"只能备份恢复"）。是否把本节删成一行纯链接、由 `rollback.md` 单点承载，属文档编排决策，留人工定夺；在此之前本节仅做事实对齐，不合并、不删除。

## 相关文档

- 探活与端点：`Docs/Server/03-部署运维/Runbooks/healthCheck.md`
- 日志字段/轨道/失踪排查：`Docs/Server/03-部署运维/Runbooks/logAnalysis.md`
- 回滚与备份：`Docs/Server/03-部署运维/Runbooks/rollback.md`
