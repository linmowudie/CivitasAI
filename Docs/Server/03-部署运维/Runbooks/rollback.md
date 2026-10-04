# 回滚 Runbook

> 版本回滚与数据恢复流程

---

## 0. 先分清两条线（2026-10-03 校准：新增）

两条部署线的**可逆性相反**，原表把两者笼统写作"数据库"是本文档最大的错处：

| 线 | 存储 | 迁移可否逐条下滚 | 备份/恢复通道 |
|----|------|----------------|--------------|
| 本地端 `Src/` | SQLite 三库 `Data/db/civitas_{main,events,memory}.db`（WAL 模式，`Src/Infra/Db/database.ts:141`） | **可**：每条迁移都带 `down` SQL（`Src/Infra/Db/migrations.ts`），`migrateDown()` 在 `:711`，并由 `Src/Infra/Db/index.ts:6` 导出 | **无**：仓库没有任何备份写入代码（见 §2.1） |
| 服务端 `Server/` | PostgreSQL 16（`Server/docker-compose.yml`，卷 `civitas_pgdata`） | **不可**：`runMigrations()` 无 down 分支（`Server/src/db/migrate.ts:80-122`），`Server/migrations/*.sql` 内 `grep -i down` **0 命中**，且 `schema_migrations` 有 checksum 漂移锁（`:91-95`：已应用的迁移内容改动即报错） | **有**：`GET /v1/backup`、`GET /v1/backup/download`、`POST /v1/restore`（`Server/src/routes/backup.ts:20`、`:33`、`:46`），或运维侧 `pg_dump` |

> 结论：**本地端优先用"迁移下滚"，服务端优先用"备份/恢复"**。原「回滚决策」里"迁移出问题只能备份恢复或重置"的写法对 SQLite 不成立（2026-10-03 校准，见 §2.3）。

## 回滚决策

| 情况 | 本地端（SQLite） | 服务端（PostgreSQL） |
|------|-----------------|---------------------|
| 代码 Bug（无数据库变更） | 只回退代码 | 只回退代码 |
| 迁移后发现问题 | 首选 `migrateDown()` 逐条下滚（§2.3）；下滚不了才重置（§2.4） | 只能走 `/v1/backup`+`/v1/restore` 或 `pg_dump`（§3）；**不可下滚**，最坏 `docker compose down -v` 重建（破坏性） |
| 配置变更导致问题 | `git checkout <hash> -- Configs/`（§4） | 同左（`Configs/` 属本地端；Server 侧配置在 `Server/.env`，需手工回退） |

## 回滚步骤

### 1. 代码回滚

```bash
# 查看历史版本
git log --oneline -10

# 回退到指定版本
git checkout <commit-hash>

# 重新安装依赖（本地端）
npm install

# 服务端线是独立包，需在 Server/ 内二次安装（Server/package.json，name=@civitas/server，根 package.json 无 workspaces）
cd Server && npm install
```

**注意事项（2026-10-03 校准）**

- **回滚点不可追溯是现状**：`git tag` 计数为 **0**，且 `Server/`、大量 `Client/` 改动目前以**未提交工作区改动**存在（`Server/` 为未跟踪目录）→ `git checkout <hash>` 不会带走它们，跨线"整体回滚"做不到。属流程决策，见 §预防措施 2 的【需人工裁定】。
- **本文档不提供迁移 CLI**：根 `package.json:10-40` 的全部 scripts 里**没有**本地端 `migrate`/`rollback`/`db:*` 条目（`migrateDown` 无入口，见 §2.3）；Server 侧只有 `server:migrate` / `server:migrate:status`（`package.json:22-23`），且底层 CLI 只支持前进与状态：`--status`（`Server/scripts/migrate.ts:31`）、`--dry-run`（`:44`）。
- 回滚后"用什么命令起服务"要按代码实态说：`npm run start` = `tsx Src/main.ts`（`package.json:15`），**跑的是 TS 源码**，不加载 `npm run build:all` 的产物 `dist/main/main.js`（`Scripts/build.cjs`）；产物入口是 `npm run start:electron`（`package.json:16`）。因此"回滚到已构建版本"不能靠 `npm run start` 验证。

### 2. 本地端数据库（SQLite）

#### 2.1 备份 —— ⚠️ 未实现（目标态）

**原步骤 `cp Data/db/backup/civitas_main.db.bak …` 已从本文档删除**：

- `Data/db/backup/` **不存在**（`ls Data/db/backup` = No such file）；`Data/db` 实际只有三套 db + 各自 `-wal`/`-shm` + `.gitkeep`。
- 全仓**没有备份写入代码**：`grep -rni backup Src/ Scripts/` 只命中 `Src/Infra/Hook/System/auditHook.ts:32` 的 `systemBackupHook`，它**只打一行 info 日志**（`:37-40`），不写文件；而且**没有任何调用点**，实测 `Logs/business.log` 里「会话结束，触发备份」出现 **0 次**。
- 也没有 `Scripts/dbBackup.cjs` 之类的脚本（`Scripts/` 现况：`build.cjs`、`dbPeek.cjs`、`dupCheck.cjs`、`experimentMatrix.cjs`、`genEventTypes.ts`、`install.sh`/`install.ps1`、`llmLatency.cjs`、`rubricRecalibrate.ts`、`traceAnalysis.ts`、`verifyClientDist.cjs`、`wsDiagnose.cjs`）。

**当前只能手工备份**（顺序不能颠倒，原因见 §2.2）：

```bash
# ① 先停进程（否则 WAL 仍在写）
#  ② 把 WAL 合并回主库
node -e "const db=require('better-sqlite3')('Data/db/civitas_main.db');console.log(db.pragma('wal_checkpoint(TRUNCATE)'))"
#  ③ 整组拷走（.db / -wal / -shm 一起，别只拷 .db）
mkdir -p Data/db/backup && cp -a Data/db/civitas_main.db* Data/db/backup/
```

> `Data/` 整体在 `.gitignore:12` 内，备份目录不会进版本库；`Data/.secrets/` 亦已排除（`.gitignore:16`）。
> **待办（缺陷登记）**：把上述三步固化成 `Scripts/dbBackup.cjs`（或 `VACUUM INTO`），本文档再改为引用真实脚本；在此之前 §2.1 不构成"已具备的备份能力"。

#### 2.2 WAL 前提：三件成套（2026-10-03 校准：新增，原步骤缺此前提）

三套库都开 WAL（`db.pragma('journal_mode = WAL')`，`Src/Infra/Db/database.ts:141`），实测 `civitas_main.db-wal` 有 **292,552 B** 尚未合并回主库（另有各 32,768 B 的 `-shm`）。因此：

- **只拷/只回滚 `.db` 主文件会丢最近事务**；
- 恢复后若残留旧 `-wal`/`-shm`，会与新的主库**错配**（轻则数据看不见的，重则 SQLite 报损坏）。

正确做法二选一：

```bash
# A. 先 checkpoint 再单文件拷贝（推荐）
node -e "const db=require('better-sqlite3')('Data/db/civitas_main.db');db.pragma('wal_checkpoint(TRUNCATE)');db.close()"

# B. 停进程后，整组 .db / .db-wal / .db-shm 一起替换
rm -f Data/db/civitas_main.db-wal Data/db/civitas_main.db-shm
cp -a Data/db/backup/civitas_main.db* Data/db/
```

#### 2.3 首选路径：迁移逐条下滚（2026-10-03 校准：新增）

本地端**具备**逐条回滚能力，这是原表格"只能备份恢复/重置"漏掉的：

- `Migration` 有 `down` 字段（`Src/Infra/Db/migrations.ts:26`），注册的每条迁移均带 down SQL（如 v23 `ai_events` 的 `DROP TABLE`，`:464-466`）。
- `migrateDown()`（`:711-731`）取 `_migrations` 中 `MAX(version)` 那条，执行其 `down` 并删除记录行，一次只退**一条**。当前 main 库水位：**version 28 / 共 28 条**。
- 已通过 `Src/Infra/Db/index.ts:6` 对外导出，测试侧有用例（`Tests/Infra/db.spec.ts:104` 的「migrateDown 回滚最后一次迁移」）。

**⚠️ 但入口不存在，因此下面不是可直接复制的命令**：根 `package.json` 没有 `db:migrate:down` 之类 script，`migrateDown()` 在 `Src/` 内**没有运行期调用点**（只被 `Tests/Infra/db.spec.ts:104` 调用）。现状必须先按启动顺序把 DB 装起来（`initDatabase({ mainPath, eventsPath, memoryPath, walMode, busyTimeoutMs, writeSynchronous })` → `initMigrations()` → `migrateDown()`，参数装配照抄 `Src/main.ts:133-146`），再调用下滚；`migrateDown()` 只退 `_migrations` 里 `MAX(version)` 的**那一条**。

```text
# 目标态（待补根 script 后本节才改写为可执行命令）
npm run db:migrate:down
```

**前置条件**：进程已停 + 已按 §2.1 完成整组备份（`migrateDown` 直接执行 `down` SQL，无快照保护，见 §预防措施 3）。

**待办（缺陷登记）**：补根 script（如 `db:migrate:down`，把 `initDatabase`/`initMigrations` 装配收进去）后，本节才应写成 `npm run db:migrate:down`。在此之前不要把该命令当既有能力引用。

#### 2.4 兜底路径：重置（仅本地端）

```bash
# 停止进程后执行；glob 同时覆盖 .db / -wal / -shm
rm Data/db/civitas_*.db*
# 重启后自动重建
```

- 对本地端成立：`Src/main.ts:133-146` 依次 `initDatabase` → `initMigrations` → `migrateUp`，缺库即重建（数据丢失，迁移从 0 重放到最新水位）。
- **对服务端不成立**（2026-10-03 校准）：`rm Data/db/*` 完全不影响 PostgreSQL。PG 侧重置见 §3。

### 3. 服务端数据库（PostgreSQL）：不可下滚，走备份通道

```bash
# 依赖栈起停（根 package.json:25-26 → Server/docker-compose.yml）
npm run server:db:up        # docker compose up -d db
npm run server:migrate      # 前进式迁移（无 down）
npm run server:migrate:status

# 数据导出（需鉴权；guard = createAuthGuard，见 Server/src/routes/backup.ts:18-20）
curl -s -H "Authorization: Bearer <token>" "http://127.0.0.1:8787/v1/backup?includeStats=true" -o backup.json
curl -s -H "Authorization: Bearer <token>"  http://127.0.0.1:8787/v1/backup/download -o backup-download.json

# 数据恢复（mode=merge 合并 / replace 重建）
#   bundle 必须是先前 /v1/backup 或 /v1/backup/download 导出包里的 data 内容（整包回填，非可省略占位）
curl -s -X POST -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  --data-binary @restoreBody.json http://127.0.0.1:8787/v1/restore
```

要点：

- **参数与鉴权口径**：`includeStats` 接受 `true`/`1`（`Server/src/http/schemas.ts:176-181`），`statsLimit` 必须是 1..100000 的整数（`:187-193`，缺省走键集分页全量导出）；`/v1/restore` 的 body 是 `{ bundle, mode }`，`mode` 取 `merge`（默认）或 `replace`（`:262-265`）。鉴权为 `Authorization: Bearer <token>`（`Server/src/http/authGuard.ts:24-33`），缺失即 `unauthenticated`。
- **改已应用迁移会被硬拒**：`schema_migrations` 存 checksum，内容与已应用记录不一致时 `runMigrations` 直接抛错「已应用的迁移不可修改，请新增迁移文件」（`Server/src/db/migrate.ts:91-95`）。回滚代码时**不要**顺手编辑历史 `.sql`。
- `/v1/backup`、`/v1/restore` 是**账号数据包级**备份/恢复（设置 + 记忆 + 可选统计，`Server/src/routes/backup.ts:4-6`），不等于物理库快照；整库层面请用 `pg_dump` / `pg_restore`（仓库未提供封装脚本，属运维手工）。
- **⚠️ 破坏性**：整库重置 = 删数据卷 + 重放迁移，账号数据不可挽回：

```bash
cd Server && docker compose down -v     # 删除卷 civitas_pgdata（Server/docker-compose.yml volumes 段）
cd Server && docker compose up -d db
npm run server:migrate                  # 迁移从 0 重建 schema
```

### 4. 配置恢复

```bash
# 恢复配置文件（Configs/ 下 16 个 JSON 均为已跟踪文件）
git checkout <commit-hash> -- Configs/
```

- `Configs/local.json` 被 `.gitignore:19` 排除，**不会**因切版本被覆盖丢失（本地覆盖项的唯一落点，`Src/Infra/Config/configLoader.ts:73` 只读它）。
- 服务端线配置不在 `Configs/`：端口等走 `Server/.env`（模板 `Server/.env.example:8` 的 `PORT=8787`），需手工回退。

## 预防措施

| # | 措施 | 落地状态（2026-10-03 校准） |
|---|------|---------------------------|
| 1 | 每次部署前备份数据库 | ⚠️ **无自动化**：无备份代码、无 `Data/db/backup/`、无脚本，只能按 §2.1 手工三步（本地端）/ §3（服务端） |
| 2 | 使用 Git tag 标记稳定版本 | ⚠️ **无落地对象**：`git tag` 计数为 0，且本批改动多为未提交/未跟踪状态 → 【需人工裁定】 |
| 3 | 数据库迁移前创建快照 | ⚠️ **未实现**：`migrateUp()`（`Src/Infra/Db/migrations.ts:688-706`）内无快照/时间戳，调用点 `Src/main.ts:146` 直接执行；Server 侧同样无前置钩子 → 【需人工裁定】 |
| 4 | 保持配置的版本控制 | ✅ 有效（`Configs/` 全部已跟踪，`Configs/local.json` 另行排除） |

**【需人工裁定】现状记录 + 待办（不作裁决，留人定）**

1. **R-04 迁移前快照**：是否把"迁移前自动快照（`VACUUM INTO` + `_Meta` 记录落点）"定为本地端基础能力；若定为，需同时决定快照保留策略与是否覆盖三套库。现状：完全依赖 §2.1 手工备份，`migrateUp` 无任何保护。
2. **R-08 Git tag**：是否先做一次基线提交并打首个 tag（如 `v0.1.0`），使本文档的 `git checkout <hash>` / `<last-known-good-commit>` 有可指代对象。现状：0 个 tag，回滚点仅能靠 `git log` 的临时 hash。
3. **Server 线是否纳入本 Runbook 的常规回滚流程**：现按"另一条线"拆分记录（§0/§3）；是否统一编排（一条命令覆盖两线）属流程决策。

## 相关文档

- 判活与端点：`Docs/Server/03-部署运维/Runbooks/healthCheck.md`
- 日志与 `_Meta` 排查：`Docs/Server/03-部署运维/Runbooks/logAnalysis.md`
- 常见故障：`Docs/Server/03-部署运维/Runbooks/commonIssues.md`
- 依赖栈起停：`Server/docker-compose.yml`、`Server/README.md`
