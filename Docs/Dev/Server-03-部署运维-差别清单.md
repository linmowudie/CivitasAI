# Server/03 部署运维 — 文档-实态差别清单

> 审查日期 2026-10-03 · 审查基准：当前工作区（含未提交改动）
> 审查范围：`Docs/Server/03-部署运维/` 七份文档（Deployment/local.md、windows.md、docker.md；Runbooks/healthCheck.md、logAnalysis.md、rollback.md、commonIssues.md）
> 比对对象：`package.json`（scripts/build）、`ELECTRON.md`、`electron/`、`Configs/`、`Scripts/`、`Src/Interface/{WebServer,RestApi,IpcBridge,WebSocket}`、`Src/Infra/{Logging,Db,Config}`、`Src/main.ts`、`Server/`（未跟踪新目录）、`Logs/`、`Data/`
> 分类口径：【文档过时】文档描述已被后续变更取代 · 【声明错误】文档陈述与代码/文件事实相反 · 【代码未实现】文档承诺的产出无对应代码 · 【需人工裁定】事实清楚但取舍/口径需人定
> 本清单未修改任何被审文档，仅新增本文件。

---

## 摘要

| 分文档 | 登记差异 | 声明错误 | 文档过时 | 代码未实现 | 需人工裁定 |
|---|---|---|---|---|---|
| Deployment/docker.md | 7 | 2 | 3 | 1 | 1 |
| Deployment/local.md | 3 | 1 | 2 | 0 | 0 |
| Deployment/windows.md | 4 | 0 | 2 | 0 | 2 |
| Runbooks/healthCheck.md | 8 | 3 | 1 | 3 | 1 |
| Runbooks/logAnalysis.md | 8 | 4 | 3 | 0 | 1 |
| Runbooks/rollback.md | 8 | 2 | 2 | 2 | 2 |
| Runbooks/commonIssues.md | 7 | 3 | 2 | 0 | 2 |
| **合计** | **45** | **15** | **15** | **6** | **9** |

**总体判断**

1. **docker.md 是本批唯一"整篇不可执行"的文档**：仓库中 **不存在任何 Dockerfile、根级 compose 或 `.dockerignore`**（`ls` 与 `git ls-files | grep -i docker` 双核，唯一命中是文档自身），而文档"构建与运行"章节把 `docker build -t civitasai:latest .` 当作可执行步骤给出——按现状执行必失败。真实存在的唯一 compose 是 `Server/docker-compose.yml`（只有 PostgreSQL 16 一个服务），docker.md 对它零字提及。
2. **一条贯穿七份文档的系统性缺口：`Server/` 这条部署线整体缺席**。`Server/`（Fastify + PG，端口 8787，见 `Server/src/config.ts:164`、`Server/.env.example:8`）在本工作区是**未跟踪目录**（`git status` = `?? Server/`），七份文档内 `grep "Server"` **0 命中**。因此真实存在的探测端点 `/healthz`、`/readyz`（`Server/src/app.ts:144,145`）、备份/恢复端点 `/v1/backup`、`/v1/backup/download`、`/v1/restore`（`Server/src/routes/backup.ts:20,33,46`）、以及"PG 迁移不可回退 + checksum 漂移锁"（`Server/src/db/migrate.ts:88-96`）这套真实运维面，全部无处可查。
3. **Runbooks 的"可执行性"最差**：healthCheck.md 四条命令级检查项中三条不可用（`/health` 端点不存在、`dbPeek --check` 参数不存在、`token_conservation`/`loop_started` 字符串全仓 0 命中）；logAnalysis.md 的日志 schema 与代码字段名不一致（`trace_id`/`metadata` vs `traceId`/`data`），实测 `Logs/business.log` 2648 行中 `traceId`/`operationId`/`metadata` **出现 0 次**，示例消息"模型调用完成"在 `Src/` 也 0 命中。
4. **rollback.md 与代码能力两头错位**：一方面写了不存在的备份路径 `Data/db/backup/`（该目录不存在，且全仓无备份写入代码），另一方面又漏掉本地 SQLite **确实具备**的逐条下滚能力（`Src/Infra/Db/migrations.ts:711 migrateDown()`，每条迁移都带 down SQL）；commonIssues.md:63「数据库迁移不可回退」对 PG 成立、对 SQLite 不成立。真实缺失的是**入口**：`migrateDown` 只被 `Tests/Infra/db.spec.ts` 调用，`package.json` 无任何对应 script。
5. **两份 Deployment 文档还带着已被取代的生产语义**：`npm run start` 实为 `tsx Src/main.ts`（`package.json:15`），不消费 `npm run build:all` 产出的 `dist/main/main.js`（`Scripts/build.cjs:25-32`）——因此 local.md"生产模式"与 docker.md `CMD` 都名不副实，且要求镜像保留 `Src/` 源码与 devDependencies。
6. **可取之处**：WS 删除注（2026-09-28）经核**成立**（`Src/Interface/WebSocket/` 仅剩 `.gitkeep`，`wsPort` 仅存 `Configs/default.json:13` + `configValidator.ts:52` 校验，日志末条"WS 网关启动"停在 2026-09-15）；`electron:build` 产物路径、端口/测试命令、`busyTimeoutMs=5000`、`eventBusBridge` 降级轮询等抽查项与实态一致。
7. **附带发现（文档外，建议一并处置）**：`.gitignore` 未含 `release/`（`git check-ignore release` 退出码 1），打包后约 150-200MB 产物会污染工作区；`Logs/README.md:10` 的排查链接仍指向旧路径 `Docs/05-部署运维/Runbooks/logAnalysis.md`（该目录已 `git mv` 至 `Docs/Server/03-部署运维/`）→ 反链已断；`git tag` 计数为 **0**，rollback.md「预防措施 2：使用 Git tag 标记稳定版本」目前无落地对象。

---

## 一、Deployment/docker.md

| 编号 | 章节 | 文档声明 | 实态(文件:行) | 分类 | 建议处理 |
|---|---|---|---|---|---|
| D-01 | §Dockerfile（参考）+ §构建与运行 | 提供 Dockerfile 内容，并给出可执行命令 `docker build -t civitasai:latest .` | 仓库**无 Dockerfile**：根目录 `ls Dockerfile` = No such file；`git ls-files \| grep -i docker` 仅返回本文档自身 | 【代码未实现】 | 二选一：①真正落一份 `Dockerfile`（含 `node:20`、`apt` 构建依赖、多阶段以剥离 devDeps）；②把章节标题改为"Dockerfile 草案（未落地）"，并把"构建与运行"命令块标注为"需先创建 Dockerfile" |
| D-02 | §docker-compose.yml（参考） | 给出 `civitasai` 服务的 compose 文件 | 唯一真实 compose 是 `Server/docker-compose.yml:12-34`（服务名 `db`、`postgres:16-alpine`、`container_name: civitas-server-db`、`5432:5432`、卷 `civitas_pgdata`）；根目录无 `docker-compose.yml`/`.yaml` | 【文档过时】 | 明确区分两件事：①`Server/docker-compose.yml`（依赖栈，已存在）；②应用自身容器化（不存在）。文档内链到真实文件路径 |
| D-03 | §Dockerfile `EXPOSE 3000 3001` | 暴露 WS 端口 3001 | WS 已于 2026-09-28 删除：`Src/Interface/WebSocket/` 仅剩 `.gitkeep`；`Configs/default.json:13` 的 `wsPort:3001` 仅被 `Src/Infra/Config/configValidator.ts:52` 校验，无监听方 | 【声明错误】 | 改为 `EXPOSE 3000`；若要容器化 Server 线，另加 `8787` |
| D-04 | §Dockerfile `RUN npm run build:server` + `CMD ["npm","run","start"]` | 先编译再以"生产"方式启动 | `build:server` = `node Scripts/build.cjs`（产出 `dist/main/main.js`，见 `Scripts/build.cjs:25-32`），但 `start` = `tsx Src/main.ts`（`package.json:15`）→ 运行 TS 源码，编译步骤白做；且 `tsx` 在 devDependencies（`package.json:137`），靠 `npm ci --production=false` 才能跑 | 【声明错误】 | CMD 改 `["node","dist/main/main.js"]`（保留 `npm ci --omit=dev` 的多阶段收益），或在文档说明"当前 start 依赖 tsx + Src 源码，不可省略 devDeps" |
| D-05 | §Dockerfile `COPY . .` | 直接整目录入镜像 | **无 `.dockerignore`**（根目录 `ls -a \| grep -i docker` 空），而 `.gitignore:2-13` 排除的 `node_modules/`、`dist/`、`Logs/`、`Data/`（含 `Data/.secrets/providers.json.enc`，`.gitignore:20`）都会被 `COPY . .` 带入镜像层 | 【需人工裁定】 | 补 `.dockerignore`（至少 `node_modules`、`Data`、`Logs`、`.git`、`.tmp`、`.verify`、`coverage`）；`Data/.secrets/` 入镜像属安全项，建议按缺陷单登记 |
| D-06 | §docker-compose.yml `version: '3.8'` | 使用 compose `version` 字段 | Compose Spec 已废弃该字段；仓库内真实 compose 已不带（`Server/docker-compose.yml` 首字段即 `services:`） | 【文档过时】 | 删除 `version:` 行，与真实文件风格对齐 |
| D-07 | 全文（部署拓扑覆盖） | 只描述"单容器跑 Civitas-AI" | 实际是两条线：本地端 `Src/`（HTTP :3000 + Electron）与服务端 `Server/`（Fastify :8787 + PostgreSQL，见 `Server/.env.example:8,12`）。文档对 Server 线、PG 依赖、迁移（`npm run server:migrate`）零覆盖 | 【文档过时】 | 新增"部署拓扑"小节：两进程 + 一数据库，各自端口/依赖/健康端点；把 §注意事项的"SQLite 单容器"限定到本地端线 |

## 二、Deployment/local.md

| 编号 | 章节 | 文档声明 | 实态(文件:行) | 分类 | 建议处理 |
|---|---|---|---|---|---|
| L-01 | §服务端口 | 端口表只有 HTTP API 3000 / Vite 5173（+ wsPort 废弃注） | 缺服务端端口 **8787**（`Server/src/config.ts:164` `PORT: num(8787)`；`Server/.env.example:8`；`Server/README.md:51`），也缺 PG 5432（`Server/docker-compose.yml:24`） | 【文档过时】 | 端口表补 `服务端 API 8787`、`PostgreSQL 5432（docker compose up -d db）` 两行，并注明属 Server 线 |
| L-02 | §生产模式 | `npm run build:all` 后 `npm run start` 即为生产启动 | `start` = `tsx Src/main.ts`（`package.json:15`），不加载 `dist/main/main.js`（`build:all` 产物，`Scripts/build.cjs:32`）；真正的产物入口是 `start:electron` = `electron .`（`package.json:16` + `main` 字段 `dist/main/electron/main.js`） | 【声明错误】 | §生产模式 改为 `npm run build:all` → `npm run start:electron`（桌面）或 `node dist/main/main.js`（无头，需先确认该路径受支持）；或明确"当前仅有 tsx 运行方式，`build:all` 只为 Electron 打包准备产物" |
| L-03 | §安装步骤 | 单条 `npm install` 即可安装全工程 | `Server/` 有独立 `package.json`（`name: @civitas/server`、`private: true`，无 workspaces 字段）与独立 `Server/package-lock.json`，需在 `Server/` 内二次 `npm install`；文档未提 | 【文档过时】 | 安装步骤补 `cd Server && npm install`，并链到 `Server/README.md` 的启动三步（`server:db:up` / `server:migrate` / `server:dev`） |

## 三、Deployment/windows.md

| 编号 | 章节 | 文档声明 | 实态(文件:行) | 分类 | 建议处理 |
|---|---|---|---|---|---|
| W-01 | 全文（前置要求/安装步骤） | Windows 侧只覆盖 `Src/` + Electron | Server 线在 Windows 需要容器运行时（`Server/docker-compose.yml` 起 PG）或原生 PG，且 `Server/package.json:26` 依赖 `@node-rs/argon2` 原生模块；文档零提示 | 【文档过时】 | 前置要求补 Docker Desktop（或原生 PostgreSQL 16），并说明跑 Server 线才需要；仅跑本地端可忽略 |
| W-02 | §前置要求 | "Visual Studio Build Tools（better-sqlite3 编译需要）" | `better-sqlite3@^13.0.3`（`package.json:101`）通常有 win-x64 预编译包，多数场景无需自编译；真正强制本机编译链的是 Electron ABI 不匹配时的 `npx @electron/rebuild`（`ELECTRON.md:107`），windows.md 未提；`asarUnpack` 已为原生模块让路（`package.json:95-98`） | 【需人工裁定】 | 措辞降级为"仅在源码安装/ABI 不匹配时需要"；把 `npx @electron/rebuild` 提为 Windows 打包的常规步骤（与 ELECTRON.md 合并口径） |
| W-03 | §Electron 桌面模式 | 打包前置只到 `npm run electron:build` | `package.json:89` `win.icon = assets/icon.ico`，而 `assets/` 目录**只有 README.md**；`ELECTRON.md:87-90` 明确要求打包前放置 `icon.ico`/`icon.png`（`electron/main.ts:25` 用 `assets/icon.png` 且缺省时回落 `undefined`，不报错）→ Windows 文档缺这一前置，首次打包结果与预期不一致 | 【文档过时】 | §Electron 桌面模式 增加前置"按 `assets/README.md` 放置图标文件"，并写明缺图标时的实际表现 |
| W-04 | §Electron 桌面模式 | `# 输出：release/CivitasAI-Portable.exe` | 产物名/目录与 `package.json:41-98` 一致（`directories.output: release`、`portable.artifactName: CivitasAI-Portable.exe`）✓，但 `release/` **未被 gitignore**（`git check-ignore release` 退出码 1），`ls release` 目前不存在 | 【需人工裁定】 | 文档补一句"产物目录 `release/` 需在 `.gitignore` 中排除"，或直接补 `.gitignore` 条目（属工程侧修复，本审查未改） |

## 四、Runbooks/healthCheck.md

| 编号 | 章节 | 文档声明 | 实态(文件:行) | 分类 | 建议处理 |
|---|---|---|---|---|---|
| H-01 | §快速检查清单 / §详细检查 1 | `curl http://localhost:3000/health` → 200 OK；`curl -s ... \| jq .` | 本地端**无任何 health 路由**：`grep -i health Src/Interface/` 0 命中，`registerRoute` 全部为 `/api/*`（如 `taskApi.ts:100-121`、`tokenApi.ts:56-70`），`httpServer.ts:77` 仅 `/api/` 前缀进 API 分发；非 API 路径先静态（`:84`）再 SPA fallback（`:87`），而 `Client/dist/index.html` 存在 → `/health` 实际返回 **200 + text/html**，`jq .` 必失败 | 【声明错误】 | 改为 `curl -s http://localhost:3000/api/loops/dashboard`（`loopApi.ts:82`）或 `curl -s -o NUL -w "%{http_code}" http://localhost:3000/api/configs`（`configApi.ts:46`）；并在文首说明"200 不来自专用探活端点" |
| H-02 | §快速检查清单（跨线覆盖） | 探活只面向 :3000 | Server 线已有标准探活：`GET /healthz`（`Server/src/app.ts:144`，返回 `{status:'ok',uptimeSec}`）、`GET /readyz`（`:145-152`，含 DB 探测，不可用 → 503 `UNAVAILABLE`），两者免限流免鉴权（`app.ts:56` PUBLIC_EXACT）；前端已在用（`Client/src/stores/accountStore.ts:414,417`） | 【文档过时】 | 新增"服务端（Server/，:8787）探活"小节：`curl http://127.0.0.1:8787/healthz`、`/readyz`，并指出 `/readyz` 才含数据库连通性 |
| H-03 | §详细检查 2 | `node Scripts/dbPeek.cjs --check` 可检查表结构 | `Scripts/dbPeek.cjs` 全文 11 行：`process.argv[2]` 被当作 **session id**（`:3`，默认 `'sess-24c779f3'`），只查 `chat_messages` 最近 5 条（`:4-6`）；无 `--check` 分支、无表结构输出 | 【声明错误】 | 删除该命令或改写为 `node Scripts/dbPeek.cjs <sessionId>`；表结构检查改为只读打开后查 `sqlite_master`（或明确"需另建脚本"） |
| H-04 | §详细检查 3 | `grep "token_conservation" Logs/*.log` 查看守恒验证结果 | `token_conservation` 在 `Src/` **0 命中**（全仓仅本文档 + `Prompts/roles/auditor.md:37` 的提示词枚举）；守恒函数 `verifyConservation`（`Src/Services/TokenEconomy/walletManager.ts:259`）、`verifyLedgerConservation`（`tokenLedger.ts:49`）**运行期无调用点**，只被 `Tests/TokenEconomy/tokenEconomy.spec.ts:135,383` 调用；`tokenApi.ts` 也未暴露守恒端点 | 【代码未实现】 | 文档降级为"（待实现）"，同时登记缺陷：把 `verifyConservation` 接入周期巡检或新增 `GET /api/tokens/conservation` |
| H-05 | §详细检查 4 | `grep "loop_started\|loop_terminated" Logs/*.log` 看活跃 Loop | 事件名实为 `loop:started` / `loop:completed` / `loop:aborted`（`Src/Services/EventBus/eventTypes.ts:85-87`），**不存在 `*_terminated`**；且 loop 生命周期是持久化事件，正确查法是 `GET /api/loops/events?eventType=...`（`loopApi.ts:74-80`）或 events 库 `Data/db/civitas_events.db` | 【声明错误】 | 换成 `curl -s "http://localhost:3000/api/loops/events?eventType=loop:started&limit=20"`；若坚持 grep，改正串为 `loop:started\|loop:completed\|loop:aborted` |
| H-06 | §告警阈值 | 四项阈值（HTTP >5s/>30s、DB >500MB/>1GB、日志错误率 >1%/>5%、Token 守恒偏差 >0.01%/>0.1%） | 无采集与判定实现：`Src/` 无 prometheus/metrics 出口；无错误率统计器；守恒偏差如上（H-04）无运行期计算；DB 体积无巡检代码 | 【代码未实现】 | 表头加"目标阈值（未实现自动判定）"，并注明当前只能人工核对；或指明已有的 `useAlerts.ts`（前端 4 条规则）覆盖范围 |
| H-07 | §快速检查清单 | 磁盘空间项为 `Data/db/` 文件大小 < 1GB | 该目录现状：`civitas_main.db` 614,400B + `-wal` 309,032B + `civitas_events.db` 57,344B + `civitas_memory.db` 20,480B（WAL 三件套，`Src/Infra/Db/database.ts:141`）。文档未说明是否计入 `-wal`/`-shm`，且未提 checkpoint 策略 | 【需人工裁定】 | 明确"含 -wal/-shm 的目录总量"口径，并补一条"WAL 异常增长 → `PRAGMA wal_checkpoint(TRUNCATE)`"处置 |
| H-08 | §快速检查清单（进程存活替代方案） | 清单未给出"进程/端口"的无端点替代检查 | `httpServer.ts:93` 仅 `listen(port, host)`，无 PID 文件；`main.ts:366` 记录"HTTP 服务器启动"日志（含 port）；日志实测 181 次，可用于判活但文档未指 | 【代码未实现】 | 补 `tail -n 5 Logs/business.log`（找"HTTP 服务器启动"）或 `netstat -ano \| findstr :3000` 作为过渡判活手段 |

## 五、Runbooks/logAnalysis.md

| 编号 | 章节 | 文档声明 | 实态(文件:行) | 分类 | 建议处理 |
|---|---|---|---|---|---|
| G-01 | §日志结构（示例 JSON） | 字段为 `timestamp`/`level`/`message`/`source`/`trace_id`/`operation_id`/`metadata` | 真实行结构由 `LogLine`（`Src/Infra/Logging/logWriter.ts:46-67`）+ `log()`（`logger.ts:185-196`）决定：`timestamp`、`epochMs`、`level`、`track`、`message`、`traceId`、`spanId`、`operationId`、`source`、`data`。实测 `Logs/business.log` 2,648 行中仅出现 `"data"`（1,725 次），`trace_id`/`operation_id`/`metadata` **0 次**；`Logs/README.md` 自身字段列表已是正确版本 | 【声明错误】 | 示例 JSON 整体替换为真实 schema（补 `epochMs`/`track`/`spanId`，`metadata`→`data`，snake→camel），并与 `Logs/README.md` 对齐 |
| G-02 | §日志结构 / 全文 | "日志位于 `Logs/` 目录"（单轨隐含） | 双轨：`logWriter.ts:194` 写 `business.log`、`:201` 写 `system.log`；`logger.ts:219-225` 把 **error/fatal 默认路由到 system 轨**。实测 `ls Logs/*.log` 当前只有 `business.log`（无 system.log，且实测 level 分布 info 2,558 / warn 90 / error 0） | 【文档过时】 | 明确写"info/debug/warn → business.log；error/fatal → system.log"，并提示 system.log 仅在出现错误后生成 |
| G-03 | §常用分析 2（及全部示例） | `grep '"level":"error"' Logs/*.log` 统计错误分布 | 两处失真：①按 G-02，error 在 `system.log`，而 `Logs/*.log` glob 在 Windows/Git-Bash 下会连带匹配 `dev-server.out`（非 JSON）→ `jq` 报错；②轮转产物命名 `business.log.1…`（`logWriter.ts:271-290`）不被 `*.log` 匹配 → 历史错误漏计 | 【声明错误】 | 改用 `Logs/system.log*`（错误）与 `Logs/business.log*`（业务）分别统计；管道加 `2>/dev/null` 或 `jq -R 'fromjson? // empty'` 兜底非 JSON 行 |
| G-04 | §日志结构示例 + §常用分析 3 | 存在消息 `"模型调用完成"`，可按其 grep | `grep -rn "模型调用完成" Src/ Server/` **0 命中**；实测高频消息为「长时记忆已按属主回灌」386、「日志系统初始化完成」184、「数据库初始化完成」181、「HTTP 服务器启动」181、「配置热加载注册完成」/「环境自检完成」/「沙箱系统初始化完成」/「文件系统初始化完成」/「提示词目录就绪」各 167、「IPC 桥接启动」116、「主循环启动」39 等 | 【声明错误】 | 用真实消息名重写示例；把"模型调用"类分析改为按 `source` 维度（实测 `source` 取值含 `main`/`SharedMemory/LongTermMemory`/`ipcBridge`/`runIteration/executeLoop`/`aiEventStore`/`ipcBridge/streamGeneration`/`ToolSafetyGate`/`secretsStore`） |
| G-05 | §常用分析 3、4 | `jq -r '.metadata.latencyMs'` / `[.timestamp,.metadata.tokensUsed]` | 路径应为 `.data.*`；且 `latencyMs`/`tokensUsed` 在 `Src/` 中属审计事件字段（`Src/Infra/Hook/System/auditHook.ts:51-59`）与 API 字段（`chatApi.ts:80`），并非日志行 `data` 的稳定键 → 按文档 jq 恒 `null` | 【声明错误】 | 改路径为 `.data.*` 并注明"仅当该事件写入日志时存在"；Token 趋势建议改查 `token_transactions` 表或 `GET /api/tokens/transactions`（`tokenApi.ts:70`） |
| G-06 | §常用分析 1 | 按 trace_id 追踪完整链路（示例串 `trace-xxx`） | `logger.ts:191` 仅在 `traceId !== 'no-trace'` 时写入，实测 `business.log` 中 `traceId` 出现 **0 次** → 当前日志无法支撑链路追踪；`traceContext.ts` 具备上下文能力但运行期未产生可 grep 的痕迹 | 【需人工裁定】 | 先定性：是"trace 未在业务路径建立"还是"该样本期无并发业务"。若前者，登记缺陷并把本节标注为待启用；同时给出 DB 侧替代（`events` 表含 trace 维度，`GET /api/loops/events?traceId=`） |
| G-07 | §日志级别 | debug/info/warn/error/fatal 五级 | 与 `logger.ts:60-66` 权重表一致 ✓；但文档未写运行时可调入口 `setLogLevel()`（`logger.ts:120`）与配置项 `Configs/default.json:5` `system.logLevel` | 【文档过时】 | 补"级别来源 `system.logLevel`（默认 info）+ 运行时 `setLogLevel`"一句 |
| G-08 | §日志结构 | 未提目录可重定向与元数据 | `Src/Infra/Fs/pathResolver.ts:58-59` 支持 `CIVITAS_LOG_DIR` 覆盖；`logWriter.ts:295-310` 写 `_Meta/config.json`（`lastFlushAt`/`writeFailed`/`logDir`，实测存在）；`logWriter.ts:119-156` 目录不可写时**静默降级**（Gate G1） | 【文档过时】 | 补两节："日志目录重定向（`CIVITAS_LOG_DIR`）"与"日志失踪先查 `_Meta/config.json` 的 `writeFailed`" |

## 六、Runbooks/rollback.md

| 编号 | 章节 | 文档声明 | 实态(文件:行) | 分类 | 建议处理 |
|---|---|---|---|---|---|
| R-01 | §回滚步骤 2 | `cp Data/db/backup/civitas_main.db.bak Data/db/civitas_main.db` | `Data/db/backup/` **不存在**（`ls` = No such file）；`Data/db` 只有三套 db + wal/shm + `.gitkeep`。全仓 `Src/` 无备份写入代码（`grep -i backup Src/` 仅命中 `auditHook.ts:32 systemBackupHook`，只打日志） | 【代码未实现】 | 先补备份手段（`sqlite3 main.db ".backup ..."` 或 `VACUUM INTO`，可包成 `Scripts/dbBackup.cjs`），文档改为引用真实脚本；未实现前把该步标注"需手工，且见 R-02 的 WAL 前提" |
| R-02 | §回滚步骤 2 | 单文件 `cp` 即可恢复 | `journal_mode = WAL`（`Src/Infra/Db/database.ts:141`），实测 `civitas_main.db-wal` 309,032B 未合并 → 只拷主 .db 会丢最近事务；恢复后若残留旧 `-wal`/`-shm` 还会错配 | 【声明错误】 | 备份/恢复必须三件成套：先 `PRAGMA wal_checkpoint(TRUNCATE)` 再拷，或整组 `.db*` 一起替换且替换前停进程 |
| R-03 | §回滚决策 / §回滚步骤 2 | 迁移出问题 → 只能"备份恢复"或"重置" | 本地 SQLite **具备逐条下滚**：`Migration.down` 字段（`migrations.ts:26`）、每个迁移均带 down SQL（`:63,:78,:92,:118,:137,:156,:298,:337,:384,:464,:523-555,:600` 等），`migrateDown()`（`:711`），并由 `Src/Infra/Db/index.ts:6` 导出 | 【文档过时】 | 新增"首选：`migrateDown()` 逐条回滚"路径（前提是先有 R-04 的 CLI 入口），把"备份恢复/重置"降为兜底 |
| R-04 | §预防措施 3 | "数据库迁移前创建快照" | 无迁移前置钩子：`migrateUp()` 内未做快照/时间戳（`migrations.ts:688-709`），调用点 `Src/main.ts:145` 直接执行；`Tests/Infra/db.spec.ts:104` 证明 `migrateDown` 可用但同样无快照保护 | 【需人工裁定】 | 裁定是否把"迁移前自动快照（`VACUUM INTO` + `_Meta` 记录）"列为基础能力；若是，登记缺陷并在文档写明快照落点 |
| R-05 | §回滚步骤 1 + §回滚步骤 2 | 文档给出 `git checkout <hash>` + `npm install`，未提供任何迁移 CLI | 根 `package.json:10-40` **没有**本地端 migrate/rollback script（`migrateDown` 无入口）；Server 侧 CLI 只支持 up：`Server/scripts/migrate.ts` 仅 `--status`（`:31`）与 `--dry-run`（`:44`），`runMigrations` 无 down 分支（`Server/src/db/migrate.ts:80-122`） | 【代码未实现】 | 补根 script（如 `db:migrate:down`）或明确"目前需经 tsx 调 `migrateDown()`"并给出确切命令；Server 线在文档中标注"仅前进式" |
| R-06 | §回滚决策 表 | 一律按"代码回滚 + 数据库恢复"两件套 | 两条线可逆性相反：PG 迁移**不可回退**——`Server/src/db/migrate.ts` 无 down 处理，且 `schema_migrations` 带 checksum 漂移锁（`:88-96`，"已应用的迁移不可修改，请新增迁移文件"），`grep -i down Server/migrations/*.sql` 0 命中；而 PG 线**有**备份/恢复通道：`GET /v1/backup`、`GET /v1/backup/download`、`POST /v1/restore`（`Server/src/routes/backup.ts:20,33,46`） | 【文档过时】 | 文档按线拆表：SQLite（可下滚，可重置）/ PG（不可下滚，走 `/v1/backup`+`/v1/restore` 或 `pg_dump`）；把 Server 侧备份通道首次写入运维手册 |
| R-07 | §回滚步骤 2 | "如果无备份，重置数据库 `rm Data/db/civitas_*.db*`" 后"重启自动重建" | 对本地 SQLite 成立 ✓；但对 PG 不成立：重置需 `docker compose down -v`（卷 `civitas_pgdata`，`Server/docker-compose.yml:26,33-34`）+ 重跑 `npm run server:migrate`。文档把两者混在一个"数据库"名下，按此操作对 Server 无效 | 【声明错误】 | 拆分小节，明确 `rm Data/db/*` 仅作用于本地端；PG 侧重置命令单独列出并加破坏性警示 |
| R-08 | §预防措施 2 | "使用 Git tag 标记稳定版本" | 仓库当前 `git tag` 数量为 **0**；且本批文档与 `Server/`、大量 `Client/` 改动均以**未提交工作区改动**存在（目录迁移为 staged rename，`Server/` 为 `?? Server/`）→ 无 tag 可依据，回滚点不可追溯 | 【需人工裁定】 | 属流程决策：是否先做一次基线提交并打 `v0.1.0` tag，再让 rollback 文档可执行。本审查未代为操作 |

## 七、Runbooks/commonIssues.md

| 编号 | 章节 | 文档声明 | 实态(文件:行) | 分类 | 建议处理 |
|---|---|---|---|---|---|
| C-01 | §1 系统无法启动（步骤 2） | "`npm run start` 后立即退出"的原因含"`.env` 中 API Key 未配置" | API Key 解析是**惰性**的，不阻塞启动：`api_key_ref` 仅在调用期解析（`Src/Infra/Llm/Provider/providerBase.ts:187-200`、`Src/Infra/Security/keyStore.ts:92,144`、`Src/Infra/Embedding/embeddingClient.ts:59-67`）；启动期 Provider 计数只看注册成功（`Src/main.ts:216-217`），`throw '无可用 LLM Provider'`（`:232`）只由"一个 Provider 都没注册成功"触发。真正的退出原因是 `main.ts:71`（配置加载失败）、`:140/:143/:146`（DB/迁移）、`:232`、`:236`（工具注册）与 `:386`（顶层 catch → `process.exit(1)`） | 【声明错误】 | 步骤 2 改为"检查 `Configs/default.json` 的 `llm`/`routing` 段能否解析出至少 1 个 Provider"；把 API Key 缺失归到"§4 LLM 调用失败"类症状 |
| C-02 | §2 数据库锁定 | "SQLite 不支持并发写入" | 已配置并发缓解：`busy_timeout = 5000`（`database.ts:143`，值来自 `Configs/default.json:21` `busyTimeoutMs:5000`，经 `main.ts:137` 透传）+ `journal_mode = WAL`（`:141`）+ `synchronous`（`:147`）+ `foreign_keys = ON`（`:144`）；全仓代码未见 `SQLITE_BUSY` 专门处理分支 | 【声明错误】 | 措辞改为"WAL + busy_timeout 已缓解多数冲突，仍报 `SQLITE_BUSY` 时先看是否有第二进程/外部工具持写锁"，并补"调大 `database.busyTimeoutMs`"这一**真实存在**的配置动作 |
| C-03 | §2 数据库锁定（步骤 2） | "检查 `busyTimeoutMs` 配置（默认 5000ms）" | 配置项名与默认值均正确 ✓，但完整路径是 `database.busyTimeoutMs`（`configValidator.ts:67` 亦如此校验） | 【文档过时】 | 补全点分路径，避免读者在 `server`/顶层找键 |
| C-04 | §3 内存泄漏（步骤 1） | "检查共享记忆 `maxEntries` 是否过大" | `maxEntries` **不是共享记忆配置**：仅出现在缓存模块默认值（`Src/Services/Cache/promptCache.ts:38,46` 默认 100、`toolResultCache.ts:32,38` 默认 200），且未从 `Configs/` 读取；`Configs/memory.json` 的 `memory` 段实际键是 `capsuleBudgetTokens`/`capsuleMemoryTopK`/`capsuleRecentOpsCount`/`capsuleMessageBudgetTokens`/`longTermConsolidationDelayMs`/`privateStateTtlSec`/`vectorDim`/`supersedeGraceSec`/`conflictSimilarityThreshold`，无 `maxEntries` | 【声明错误】 | 改为"检查 `Configs/memory.json` 的 `capsuleBudgetTokens` / `capsuleMessageBudgetTokens` / `privateStateTtlSec`"；若关心缓存，另指 `Cache` 模块默认值（当前不可配置） |
| C-05 | §3 内存泄漏（步骤 2、3） | 事件队列 `maxQueueSize` 可查；`preload.ts` 的 `backend-event`、`eventBusBridge` 降级轮询 | 全部有效 ✓：`eventBus.maxQueueSize=10000` 在 `Configs/memory.json`（并被 `Src/Services/EventBus/eventBus.ts:31,35` 与 `main.ts:350` 使用）；`backend-event` 见 `electron/preload.ts:93,101` 与 `Src/Interface/IpcBridge/ipcBridge.ts:130,645`；轮询见 `Client/src/services/eventBusBridge.ts:25`（`FALLBACK_POLL_MS = 3000`）。缺的是**精确路径与键前缀**（`eventBus.maxQueueSize`）与 `Configs/` 之外的缓存队列上限说明 | 【文档过时】 | 补全引用路径（`electron/preload.ts`、`Client/src/services/eventBusBridge.ts`、`Configs/memory.json#eventBus.maxQueueSize`），并说明"IPC 监听泄漏只在 Electron 主进程侧可观测" |
| C-06 | §4 LLM 调用全部超时（步骤 3） | "检查 `modelRouter.json` 中的 `timeoutMs` 是否过短" | 存在但指向不清：`timeoutMs: 60000` 在 `Configs/modelRouter.json:50`；运行期实际生效的是 `main.ts:228-230` 一次性读取的三个不同键 `timeoutMs`(默认 60000) / `firstByteTimeoutMs`(10000) / `interChunkTimeoutMs`(15000) → 只调 `timeoutMs` 对"首字节超时"无效 | 【需人工裁定】 | 改写为三键清单并注明语义（总时长 / 首字节 / 块间），指向 `Configs/modelRouter.json` 与 `main.ts:228-230` |
| C-07 | §5 回滚操作 | "git checkout → npm install → `npm run start`"；注释"数据库迁移不可回退" | ①与 rollback.md 重叠且口径冲突（本文"不可回退"对 SQLite 不成立，见 R-03/R-06）；②`npm run start` = `tsx Src/main.ts`（`package.json:15`）与"回滚到已构建版本"不符，回滚产物路径是 `start:electron` / `dist/main/main.js` | 【需人工裁定】 | 删除本节、只留一行链接到 rollback.md（避免双写漂移），并在 rollback.md 内按两条线分别更正"可回退性"与启动命令 |

---

## 八、未发现差异的抽查项（逐条核过，与实态一致）

1. **local.md 前置版本要求**：`engines.node: ">=20.0.0"`（`package.json:7-9`）与"Node ≥ 20 / npm ≥ 10"一致；`.env.example` 存在于根目录且唯一键为 `HUAWEI_MAAS_API_KEY`（`.env.example:6`），与"填入 API Key"相符。
2. **local.md 全部命令**：`npm install`、`npm run dev`（`package.json:17` = concurrently 起 tsx watch + vite）、`dev:server`（`:18`）、`dev:electron`（`:19`）、`build:all`（`:14`）、`test`（`:27` = `vitest run`，`vitest.config.ts:22` include `Tests/**`）、`lint`（`:30` = `eslint Src/ --ext .ts`）、`npx tsc --noEmit`（`tsconfig.json` 存在）全部可解析。
3. **local.md / healthCheck.md 的"WS 已删除"注（2026-09-28）**：`Src/Interface/WebSocket/` 仅剩 `.gitkeep`；`wsPort` 只存于 `Configs/default.json:13` 与 `configValidator.ts:52-53` 的类型校验；`Logs/business.log` 末条"WS 网关启动"时间戳 2026-09-15，此后再无 → 结论成立。
4. **local.md / healthCheck.md 的前端通信描述**：Electron 侧经 `preload.ts` + `backend-event` IPC 桥接（`electron/preload.ts:93`、`ipcBridge.ts:130,645`），无独立端口可探活（HTTP :3000 由 `main.ts:361-366` 绑定，端口值取自 `server.httpPort=3000`）。
5. **local.md 的 Vite 端口 5173**：`Client/vite.config.ts:40` `port: 5173`，与 `Configs/default.json:14` 的 `corsOrigins: ["http://localhost:5173"]` 一致。
6. **windows.md 打包命令与产物**：`npm run electron:build`（`package.json:36` = `build:all` + `electron-builder --win portable`）、`win.target = portable/x64`（`:80-90`）、`portable.artifactName = CivitasAI-Portable.exe`（`:91-93`）、`directories.output = release`（`:44-46`）→ 文档"`release/CivitasAI-Portable.exe`"一致；长路径注册表项、`Set-ExecutionPolicy RemoteSigned` 为通用 Windows 手段，不涉及仓内事实。
7. **docker.md 挂载点存在性**：`Data/`、`Logs/`、`Configs/` 三目录均真实存在；`Configs/` 只读挂载安全（`configLoader.ts:73` 仅"读取" `local.json`，全仓无写 `Configs/` 的代码路径）。
8. **docker.md `npm ci` 前提**：根 `package-lock.json` 存在（426KB，与 `package.json` 同期更新）。
9. **logAnalysis.md 的"JSON Lines"判定**：确为逐行 JSON（`logWriter.ts:167,194,201` 以 `\n` 拼接 `JSON.stringify`），实测 `Logs/business.log` 首/末行均为合法单行 JSON。
10. **logAnalysis.md 的 `source` 字段**：确实存在并可用作分组维度（`logger.ts:194`；实测取值含 `main` 1,818 次、`SharedMemory/LongTermMemory` 386、`ipcBridge` 255 等）。
11. **rollback.md「重置后自动重建」**：`main.ts:137-146` 依次执行 `initDatabase` → `initMigrations` → `migrateUp`，缺库即重建；文档的 `civitas_*.db*` glob 恰好覆盖 `-wal`/`-shm`，该步可执行。
12. **rollback.md 配置恢复步**：`git checkout <hash> -- Configs/` 有效（`Configs/` 16 个 JSON 均为已跟踪文件），且 `Configs/local.json` 被 `.gitignore:23` 排除，不会因切版本被覆盖丢失。
13. **commonIssues.md §3 步骤 3**：`eventBusBridge` 降级轮询确有其物（`Client/src/services/eventBusBridge.ts:6,25,31,53,87`），与"轮询定时器未释放"这一怀疑方向相符。
14. **文档目录归属**：七份文件已由 `Docs/05-部署运维/` 迁移到 `Docs/Server/03-部署运维/`（`git status` 显示 7 条 `R`/`RM` staged rename），迁移后目录内文件集合与任务清单一致，无缺失、无多余。

> 说明（反向链接，非本批文档缺陷但需同步）：`Logs/README.md:10` 的链接仍写 `Docs/05-部署运维/Runbooks/logAnalysis.md`，已随上述 `git mv` 断链。

---

## 回写记录（2026-10-03）

按 Deployment/Runbooks 拆两个代理并行回写，共 45 条全部处置：
- Deployment 三份（docker/local/windows）：回写 11、裁定登记 3（D-05 无 .dockerignore、W-02、W-04）；全仓无 Dockerfile/根 compose——docker 整章标 ⛔ 目标态；产物入口更正为 dist/main/Src/main.js。
- Runbooks 四份（healthCheck/logAnalysis/rollback/commonIssues）：回写 31/31、裁定登记 6；关键新发现：本地无 /health（SPA fallback）、Loop 事件只声明未发布、system.log 现已生成、memory.json#eventBus.maxQueueSize 不生效（main.ts 硬编码）。
