# 健康检查 Runbook

> 系统健康状态检查流程

---

## 部署线概览（2026-10-03 校准）

仓库当前是**两条独立运行线**，探活方式不同，不要混用：

| 线 | 启动方式 | 端口 | 探活端点 |
|----|---------|------|---------|
| 本地端（`Src/`，含 Electron） | `npm run start` = `tsx Src/main.ts`（`package.json:15`） | HTTP **3000**（`Configs/default.json:12` 的 `server.httpPort`，读取点 `Src/main.ts:368`） | **无专用 health 路由**，只能用只读 `/api/*` 判活（见 §1） |
| 服务端（`Server/`，Fastify + PostgreSQL） | `npm run server:dev`（`Server/package.json:11` = `tsx watch src/index.ts`） | API **8787**（`Server/src/config.ts:164`、`Server/.env.example:8`）；PostgreSQL **5432**（`Server/docker-compose.yml`） | `GET /healthz`、`GET /readyz`（`Server/src/app.ts:144`、`:145-152`） |

> WebSocket（`ws://localhost:3001`）已删除（2026-09-28）：`Src/Interface/WebSocket/` 仅剩 `.gitkeep`，`wsPort` 只留在 `Configs/default.json:13` 与 `Src/Infra/Config/configValidator.ts:52` 的校验里，**无监听方**。前端实时事件经 Electron IPC（`electron/preload.ts:93` 的 `backend-event`），无独立端口可探活。

---

## 快速检查清单

| 检查项 | 命令/方法 | 正常状态 |
|--------|----------|---------|
| 本地端进程存活 | `curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/configs`（只读 GET，`Src/Interface/RestApi/configApi.ts:46`） | 200 |
| 本地端业务存活 | `curl -s http://localhost:3000/api/loops/dashboard`（`Src/Interface/RestApi/loopApi.ts:82`） | JSON（字段见 §1） |
| 服务端进程存活 | `curl -s http://127.0.0.1:8787/healthz` | `{"status":"ok","uptimeSec":N}` |
| 服务端数据库连通 | `curl -s http://127.0.0.1:8787/readyz` | `{"status":"ready","db":"up"}`；DB 不可用 → **503** `UNAVAILABLE` |
| 前端通信 | Electron `preload.ts` IPC 桥接（`backend-event` 事件可达，`electron/preload.ts:93`、`Src/Interface/IpcBridge/ipcBridge.ts:130`、`:645`） | 事件正常送达 |
| 数据库 | 表结构：§2 的 `sqlite_master` 查询；内容：`node Scripts/dbPeek.cjs <sessionId>` | 表存在、会话消息可读出 |
| 磁盘空间 | `Data/db/` 目录总大小（**含 `-wal`/`-shm`**；口径见 §7） | 现状约 1.0 MB；阈值属目标态 |
| 日志 | `Logs/business.log` 末行 `timestamp` 与当前时间差 | < 5 分钟前 |
| 进程存活（无端点兜底） | `tail -n 5 Logs/business.log` 找「HTTP 服务器启动」/ `netstat -ano \| findstr :3000` | 见 §6 |

> `/api/*` 全部经过限流中间件（`Src/Interface/WebServer/httpServer.ts:77-81` → `apiRateLimiter.ts:86`）。额度取 `Configs/supervision.json` 的 `supervision.apiRateLimit`（当前 `maxRequestsPerMinute:600` × `burstAllowance:2` ≈ 1200 次/分钟/IP），超限返回 **429** + `Retry-After`；高频探活脚本需按 429 退避。

---

## 详细检查

### 1. 服务存活（本地端 :3000）

```bash
# 只读 API 判活（推荐：无副作用、返回 JSON）
curl -s http://localhost:3000/api/loops/dashboard | jq .
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/configs
```

`/api/loops/dashboard` 返回结构（`Src/Interface/RestApi/loopApi.ts:33-55`）：
`activeAgents` / `totalAgents` / `activeArbitrationCases` / `totalArbitrationCases` / `arbitratorPool` / `recentEvents`。

**⚠️ 为什么不再写 `curl http://localhost:3000/health`（2026-10-03 校准）**

- 本地端**没有任何 health 路由**：`grep -i health Src/Interface/` 0 命中；已注册路由全部是 `/api/*`（注册入口 `Src/Interface/WebServer/routes.ts:24-38`）。
- `Src/Interface/WebServer/httpServer.ts:77` 只把 `/api/` 前缀交给 API 分发；其余路径先试静态文件（`:84`），再走 SPA fallback `Client/dist/index.html`（`:87`）。该文件当前存在（`Client/dist/index.html`，726 B），因此 `/health` **仍返回 200，但 Content-Type 是 `text/html`**，`| jq .` 必然失败。
- **专用探活端点属"目标态/未实现"**：需要 `GET /health` 需先在 `Src/Interface/RestApi/` 增加路由并在 `routes.ts` 注册。在此之前，判活只能引用上面的 `/api/*`。

### 2. 数据库完整性（本地端 SQLite）

```bash
# 表清单与结构（三套库各自独立；以 main 库为例）
node -e "const db=require('better-sqlite3')('Data/db/civitas_main.db',{readonly:true});
console.log(db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name\").all().map(r=>r.name).join('\n'))"

# 迁移水位（当前：main 库 _migrations 最高版本 28，共 28 条）
node -e "const db=require('better-sqlite3')('Data/db/civitas_main.db',{readonly:true});
console.log(db.prepare('SELECT MAX(version) v, COUNT(*) n FROM _migrations').get())"

# 会话内容可读性（诊断脚本的真实用法；参数是 sessionId，不是 --check）
node Scripts/dbPeek.cjs sess-47cc54c8
```

**更正记录（2026-10-03 校准）**

- `node Scripts/dbPeek.cjs --check` **不存在**：`Scripts/dbPeek.cjs` 全文 9 行，`process.argv[2]` 被当作 **session id**（默认 `'sess-24c779f3'`，`:3`），只查 `chat_messages` 最近 5 条（`:4-6`），**没有 `--check` 分支、没有表结构输出**。把 `--check` 当参数传入不会报错，只会把它当作一个不存在的 sessionId 而输出空结果——不可作为检查手段。
- 表结构检查目前没有专用脚本（**目标态**：`Scripts/dbPeek.cjs --check` 或独立的 schema 检查器），只能用上面的 `sqlite_master` 只读查询。
- 三套库：`civitas_main.db`（业务主库，含 `ai_events`/`token_transactions`/`loops` 等）、`civitas_events.db`（事件溯源 + `effect_journal`，见 `Src/Infra/Db/database.ts:12`）、`civitas_memory.db`；路径装配见 `Src/main.ts:135`。

### 3. Token 守恒验证 —— ⚠️ 未实现（目标态）

**当前无法用日志或 API 检查守恒。** 原写法 `grep "token_conservation" Logs/*.log` 已删除（2026-10-03 校准）：

- `token_conservation` 在 `Src/` **0 命中**（全仓仅本文档与 `Prompts/roles/auditor.md:37` 的提示词枚举）。
- 守恒函数 `verifyConservation()`（`Src/Services/TokenEconomy/walletManager.ts:259`）、`verifyLedgerConservation()`（`Src/Services/TokenEconomy/tokenLedger.ts:49`）**运行期无调用点**，只被 `Tests/TokenEconomy/tokenEconomy.spec.ts:135`、`:383` 调用；`Src/Interface/RestApi/tokenApi.ts:55-74` 也没有守恒端点。

可执行的替代手段（只读余额/流水，不做守恒判定）：

```bash
# 系统池 / 税率 / 钱包数（响应统一包一层 {ok, data}，取值走 .data）
curl -s http://localhost:3000/api/tokens/overview | jq '.data'      # tokenApi.ts:56
# 交易流水（可按钱包过滤）——守恒偏差需自行核算
curl -s http://localhost:3000/api/tokens/transactions | jq '.data'  # tokenApi.ts:70
# 唯一真实存在的守恒计算入口：跑单测
npx vitest run Tests/TokenEconomy/tokenEconomy.spec.ts
```

**待办（缺陷登记，非本文档可解决）**：把 `verifyConservation` 接入周期巡检，或新增 `GET /api/tokens/conservation` 后再回填本节。

### 4. Loop / 运行活动状态

**更正记录（2026-10-03 校准）**：原写法 `grep "loop_started\|loop_terminated" Logs/*.log` 两层都不成立——

- 事件名是**冒号**命名：`loop:started` / `loop:completed` / `loop:aborted`（`Src/Services/EventBus/eventTypes.ts:85-87`），**不存在 `*_terminated`**。
- 更关键：`loop:started` 等 Loop 生命周期事件目前**只声明、未发布**——`grep -rn "loop:" Src/ --include=*.ts` 仅命中 `eventTypes.ts` 的枚举定义，无任何发布点；`Data/db/civitas_main.db` 的 `loops`、`loop_checkpoints` 表实测 **0 行**，`Data/db/civitas_events.db` 的 `events`/`domain_events`/`action_fingerprints` 同样 **0 行**。因此无论 grep 旧名还是新名都查不到。

当前真正可观测的运行活动：

```bash
# ① 主循环起止（日志实测：source=runIteration/executeLoop，「主循环启动」/「主循环结束」各 41 条）
grep -c "主循环启动\|主循环结束" Logs/business.log

# ② 会话内 AI 组件事件流（ai_events 已持久化，可判"最近有没有在跑"）
curl -s "http://localhost:3000/api/sessions/sess-47cc54c8/ai-events" | jq '.data.total'   # chatApi.ts:476
node -e "const db=require('better-sqlite3')('Data/db/civitas_main.db',{readonly:true});
console.log(db.prepare('SELECT type, COUNT(*) n FROM ai_events GROUP BY type ORDER BY n DESC LIMIT 10').all())"

# ③ 事件总线内存视图（进程重启即清空；loop:* 恒为空，见上）
curl -s "http://localhost:3000/api/loops/events?limit=50" | jq '.data | length'   # loopApi.ts:74
```

要点：
- `GET /api/loops/events` 的 `eventType`/`traceId`/`limit` 过滤是真实实现的（`Src/Interface/RestApi/loopApi.ts:74-80` → `Src/Services/EventBus/eventBus.ts:117-129`），但数据源是**进程内环形缓冲**（上限 `maxQueueSize`，`Src/main.ts:357` 硬编码 10000），**不是持久化事件库**。
- `ai_events` 才是持久化事件表（迁移 v23 `registerMigration` `Src/Infra/Db/migrations.ts:446`，建表 `:453-463`；启动挂接 `startAiEventPersistence()` `Src/main.ts:363`，模块 `Src/Interface/EventStore/aiEventStore.ts`）。注意其落库前缀白名单（`aiEventStore.ts:27-30`）**不含 `loop:`**，且高频的 `agent:stream_chunk` 被显式跳过（`:24`）。
- **待办**：Loop 生命周期事件的发布点落地后，本节才应改为按 `loop:started|loop:completed|loop:aborted` 检查。

### 5. 服务端（`Server/`，:8787）探活（新增，2026-10-03 校准）

```bash
curl -s http://127.0.0.1:8787/healthz          # { status: 'ok', uptimeSec }        —— 进程存活
curl -s http://127.0.0.1:8787/readyz           # { status: 'ready', db: 'up' }      —— 含数据库连通
```

- `/healthz`：`Server/src/app.ts:144`；`/readyz`：`Server/src/app.ts:145-152`，内部 `await db.ping()`，失败走统一错误链返回 **503 / `UNAVAILABLE`**（`fail(reply, unavailable('数据库不可用'))`）。
- **`/readyz` 才含数据库连通性**，`/healthz` 不查库；判"能不能用"以 `/readyz` 为准。
- 两者均在 `PUBLIC_EXACT` 白名单（`Server/src/app.ts:56`）：**免限流、免鉴权**，可安全用于高频探针。
- 依赖栈健康：PostgreSQL 容器自带 `pg_isready` healthcheck（`Server/docker-compose.yml` healthcheck 段）；起停用根目录 `npm run server:db:up` / `server:db:down`（`package.json:25-26`）。
- 前端已在用这两个端点：`Client/src/stores/accountStore.ts:414`、`:417`。

### 6. 进程存活（无端点兜底手段）

本地端**不写 PID 文件**（`Src/Interface/WebServer/httpServer.ts:93` 只 `listen(port, host)`），也无 `GET /health`。过渡判活：

```bash
# ① 日志锚点：实测 "HTTP 服务器启动" 在 Logs/business.log 出现 182 次
tail -n 20 Logs/business.log | grep "HTTP 服务器启动"      # 携带 { source:'main', port } — Src/main.ts:373

# ② 端口占用（Windows）
netstat -ano | findstr :3000

# ③ 控制台锚点：`npm run start` 前台输出 `[INFO] 服务已启动 — HTTP:3000`（Src/main.ts:389）
```

> 若 `Logs/business.log` 无新的「HTTP 服务器启动」且日志目录整体无写入，先按 `Docs/Server/03-部署运维/Runbooks/logAnalysis.md` 的 `_Meta/config.json → writeFailed` 排查"日志静默丢失"，再判定进程是否真的挂了。

### 7. 磁盘空间 / WAL 现状

`Data/db/` 实测（2026-10-03 校准时的目录快照，共约 1,095,368 B）：

| 文件 | 字节 |
|------|------|
| `civitas_main.db` | 626,688 |
| `civitas_main.db-wal` | 292,552 |
| `civitas_main.db-shm` | 32,768 |
| `civitas_events.db` / `-shm` / `-wal` | 57,344 / 32,768 / 0 |
| `civitas_memory.db` / `-shm` / `-wal` | 20,480 / 32,768 / 0 |

- 三套库都跑在 WAL 模式（`db.pragma('journal_mode = WAL')`，`Src/Infra/Db/database.ts:141`），因此**只看 `.db` 主文件会低估占用**：`-wal` 承载尚未合并回主库的最近事务。
- 仓库**没有任何 checkpoint 巡检代码**（`grep -rn "wal_checkpoint" Src/ Scripts/ Server/src` 0 命中）。WAL 异常增长时只能手工收敛（先停进程，再执行）：

```bash
node -e "const db=require('better-sqlite3')('Data/db/civitas_main.db');console.log(db.pragma('wal_checkpoint(TRUNCATE)'))"
```

**【需人工裁定】现状记录 + 待办**：磁盘阈值是否按"含 `-wal`/`-shm` 的目录总量"计，以及是否把周期性 `wal_checkpoint` 落为运行期能力，均未定；本节只登记现状（`-wal` 确有 292,552 B 未合并），不作裁决。

---

## 告警阈值 —— ⚠️ 目标态（无自动判定）

下表是**目标阈值**，仓库当前**没有采集与判定实现**（2026-10-03 校准加注）：`Src/` 无 Prometheus/metrics 出口、无日志错误率统计器、守恒偏差无运行期计算（见 §3）、DB 体积无巡检代码（见 §7）。现阶段只能人工核对。

| 指标 | 警告 | 严重 | 运行期是否自动判定 |
|------|------|------|------------------|
| HTTP 响应时间 | > 5s | > 30s | 否 |
| 数据库文件大小 | > 500MB | > 1GB | 否 |
| 日志错误率 | > 1% | > 5% | 否 |
| Token 守恒偏差 | > 0.01% | > 0.1% | 否（守恒函数无调用点，§3） |

**已有的、真实运行的告警**是前端 `Client/src/hooks/useAlerts.ts` 的 **5 条规则**（`AlertList.tsx:5` 引用），与上表不同源、不同口径：

| 规则 | 阈值（代码常量） | 严重级 |
|------|-----------------|--------|
| 系统池不足 | `systemPool < 10000 × 10%`（`useAlerts.ts:26-27`） | CRITICAL |
| 队列积压 | 待处理任务 > 10（`:28`） | WARNING |
| 高失败率 | 最近 ≤10 个已完成任务失败率 > 50%（`:29`、`:66-70`） | WARNING |
| 仲裁积压 | 进行中仲裁案件 > 3（`:30`、`:82`） | WARNING |
| Token 异常（单 Agent 消耗 > 均值 3 倍） | `:31` 常量存在，**规则体是 TODO**（`:92-97`，缺 Agent 级消耗统计） | 未生效 |

**待办**：若要"服务端侧告警"，需要先补指标出口；否则本文档不应出现可执行的阈值判定步骤。
