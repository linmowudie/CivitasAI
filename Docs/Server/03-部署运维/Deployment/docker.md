# Docker 部署指南

> 使用 Docker 容器化部署 Civitas-AI

> **2026-10-03 校准**（依据 `Docs/Dev/Server-03-部署运维-差别清单.md` D-01…D-07，逐条复核当前仓库实态后回写）
> ⛔ **仓库当前不存在任何 `Dockerfile`、根级 `docker-compose.yml` 或 `.dockerignore`**：
> `find . -iname 'Dockerfile*'`（排除 `node_modules`）0 命中；`git ls-files | grep -i docker` 只返回本文档自身；
> 全仓唯一真实存在的 compose 是 `Server/docker-compose.yml`，而它**只起 PostgreSQL 16，不含应用本身**。
> 因此原文"构建与运行"章节的 `docker build` / `docker run` **按现状执行必失败**，该章节整体降级为 **⚠️ 目标态草案**；
> 当前真正可执行的容器命令只有 §依赖栈 中的 `cd Server && docker compose up -d db`。

---

## 部署拓扑（2026-10-03 校准，D-07）

原文只描述"单容器跑 Civitas-AI"，实际是**两条独立部署线**：

| 组件 | 代码位置 | 端口 | 依赖 | 探活 | 容器化状态 |
|------|----------|------|------|------|-----------|
| 本地端 HTTP API | `Src/main.ts`（`npm run start` = `tsx Src/main.ts`，`package.json:15`） | 3000（`Configs/default.json:12` `server.httpPort`） | SQLite 三库 `Data/db/civitas_{main,events,memory}.db` | 无专用探活端点（见 `../Runbooks/healthCheck.md`） | ⚠️ 未实现（无 Dockerfile） |
| 本地端桌面壳 | `electron/main.ts`（`npm run start:electron`，`package.json:16`） | — | `dist/main/electron/main.js`（`package.json:6` `main` 字段） | — | 不适用（桌面产物走 `electron-builder`，见 `windows.md`） |
| 服务端 API | `Server/src/`（Fastify 5，`Server/package.json:26`） | 8787（`Server/src/config.ts:164`；`Server/.env.example:8`） | PostgreSQL、`@node-rs/argon2` 原生模块（`Server/package.json:25`） | `GET /healthz` / `GET /readyz`（`Server/src/app.ts:144-145`，免鉴权白名单见 `:56`） | ⚠️ 未实现（compose 仅含数据库） |
| 服务端数据库 | `Server/docker-compose.yml:13-31`（`postgres:16-alpine`、`container_name: civitas-server-db`） | 5432（`:24`） | Docker / 容器运行时 | compose 内置 `pg_isready` 健康检查（`:27-31`） | ✅ 已存在 |

- 两条线互不影响：`Server/README.md` 明确服务端与桌面端进程内的本地服务（`:3000`）各自独立。
- 服务端线的数据迁移**不在容器里做**：`npm run server:migrate`（根 `package.json:22`）→ `cd Server && npm run migrate`。
- ⚠️ `Server/` 目前是工作区**未跟踪目录**（`git status --porcelain Server` = `?? Server/`，`git ls-files Server` 计数 0）→ 按 `git clone` 流程拿到的仓库不含它。是否入库属【需人工裁定】，此处仅登记现状。

## 依赖栈：`Server/docker-compose.yml`（✅ 已存在，D-02）

```bash
cd Server
docker compose up -d db      # PostgreSQL 16：端口 5432、数据卷 civitas_pgdata
docker compose logs -f db    # 查看数据库日志
docker compose down          # 停止（保留数据卷）
docker compose down -v       # ⚠️ 破坏性：连数据卷一起删除，PG 侧全部数据丢失
```

- 默认连接串：`postgres://civitas:civitas@127.0.0.1:5432/civitas_server`（`Server/docker-compose.yml:10`、`Server/.env.example:12`；文件头注释即声明"勿用于生产"）。
- **该 compose 不包含应用自身**：`services` 下只有 `db` 一个服务，应用容器化仍属目标态。

## Dockerfile 草案（⚠️ 未实现 / 目标态，D-01、D-03、D-04）

仓库中**没有** `Dockerfile`，以下是要落地时应采用的版本（原文内容按实态纠正后保留为草案）：

```dockerfile
# ⚠️ 本文件在仓库中不存在；需先写入仓库根目录，§构建与运行 才具备可执行性
FROM node:20-slim

WORKDIR /app

# 原生模块编译依赖（better-sqlite3 等）
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# 依赖层
COPY package.json package-lock.json ./
# 【D-04 注】现状：start = tsx Src/main.ts，而 tsx 在 devDependencies（package.json:137）
# → 要跑 npm run start 就必须 npm ci --production=false，镜像随之保留 Src/ 源码与全量 devDeps；
#   多阶段 + npm ci --omit=dev 的瘦身收益，只有在 CMD 改成直跑 dist 产物后才拿得到。
RUN npm ci --production=false

# 【D-05 注】⚠️ 仓库无 .dockerignore → COPY . . 会把 .gitignore 排除的 node_modules/、dist/、
#   Logs/、Data/（含被 .gitignore:16 排除的密钥存储目录 Data/.secrets/）全部带入镜像层。
#   落地本文件前必须先补 .dockerignore，否则属密钥入镜像级别的安全缺陷。
COPY . .

# 编译：npm run build:server = node Scripts/build.cjs → dist/main/Src/main.js + dist/main/electron/*
RUN npm run build:server

# 【D-03 校准】原文为 EXPOSE 3000 3001；3001 是 WebSocket，已于 2026-09-28 删除
# （Src/Interface/WebSocket/ 仅剩 .gitkeep；wsPort 只在 Configs/default.json:13 存值、
#   由 Src/Infra/Config/configValidator.ts:52 做类型校验，无任何监听方）。
EXPOSE 3000
# 若把服务端线（Server/，Fastify :8787）也容器化，再追加：EXPOSE 8787

# 【D-04 校准】原 CMD ["npm","run","start"] 名不副实：它用 tsx 跑 TS 源码，
#   上面 RUN npm run build:server 的产物不会被加载。目标态改为直跑编译产物：
#   ⚠️ 产物入口是 dist/main/Src/main.js（Scripts/build.cjs:12,25-32），不是 dist/main/main.js；
#   仓库当前没有对应的 npm script，该路径未经运行期验证 → 本行按目标态对待。
CMD ["node", "dist/main/Src/main.js", "--portable"]
```

> `--portable` 并非可选装饰：`Src/Infra/Fs/pathResolver.ts` 的便携判定在 `:21-35`（`CIVITAS_PORTABLE` / `CIVITAS_DATA_DIR` / `--portable`），
> **便携模式**才用当前工作目录下的 `Data`（`getDataDir()` `:48`）、`Logs`（`getLogDir()` `:63`）；
> **非便携模式**则解析到 `%APPDATA%/CivitasAI/`，该变量在 Linux 容器内不存在 → 回落到 `$HOME/.config/CivitasAI/`
> （`:52-53`、`:66-67`，即 `node:20-slim` 里的 `/root/.config/CivitasAI/`）。
> 容器里不带该参数（或 `CIVITAS_PORTABLE=1`），`-v ./Data:/app/Data` 之类的挂载会失效。

## docker-compose.yml 草案（⚠️ 未实现 / 目标态，D-02、D-06）

```yaml
# ⚠️ 仓库根目录不存在该文件（唯一真实 compose 是 Server/docker-compose.yml，见上文）
# 【D-06 校准】删除 version 字段：Compose Spec 已废弃它，仓内真实文件首字段即 services:
services:
  civitasai:
    build: .                # 依赖上文尚未存在的 Dockerfile
    ports:
      - "3000:3000"
      # 【D-03】原 "3001:3001"（WebSocket）已删除
    volumes:
      - ./Data:/app/Data
      - ./Logs:/app/Logs
      - ./Configs:/app/Configs:ro
    env_file:
      - .env
    environment:
      - CIVITAS_PORTABLE=1  # 保证 Data/Logs 落点就是挂载点
    restart: unless-stopped
  # 服务端数据库不在这里重复定义：使用已有的 Server/docker-compose.yml（服务名 db，postgres:16-alpine，5432）
```

## 构建与运行（⛔ 当前不可执行，D-01）

```bash
# ⚠️ 未实现/目标态：仓库根目录目前没有 Dockerfile，以下命令现在执行必然失败。
#    前置条件 = 先落地 Dockerfile + .dockerignore（见上文两节）
docker build -t civitasai:latest .

docker run -d \
  --name civitasai \
  -p 3000:3000 \
  -v "$(pwd)/Data:/app/Data" \
  -v "$(pwd)/Logs:/app/Logs" \
  -e CIVITAS_PORTABLE=1 \
  --env-file .env \
  civitasai:latest
# 【D-03】原命令中的 -p 3001:3001 已删除（WebSocket 不存在）

docker logs -f civitasai
```

## 注意事项

- `Data/` 和 `Logs/` 需挂载到宿主机，确保数据持久化；并确保容器以**便携模式**运行（`CIVITAS_PORTABLE=1` 或 `--portable`），否则落点在 `$HOME/.config/CivitasAI/`（`Src/Infra/Fs/pathResolver.ts:40-53`、`:57-68`），挂载无效。
- `Configs/` 目录可以只读挂载：`Src/Infra/Config/configLoader.ts:72-73` 只读取 `local.json`，`Src/Infra/Config/` 内无任何写 `Configs/` 的代码路径。
- **SQLite（仅本地端线，D-07 校准）**：原文"SQLite 不支持并发写入，单容器运行即可"只适用于 `Src/` 这条线的 `Data/db/*.db`；
  实态已配置并发缓解——`journal_mode = WAL`（`Src/Infra/Db/database.ts:141`）+ `busy_timeout`（`:143`，取自 `Configs/default.json:21` `database.busyTimeoutMs = 5000`）。
  结论不变但理由要正：**单容器/单进程持有写锁**即可，切勿多副本共享同一 `Data/db`。
- **服务端线（`Server/`，8787 + PostgreSQL）不受上述 SQLite 口径约束**，其数据库副本/HA 另议；
  PG 迁移是**前进式**——`Server/src/db/migrate.ts` 无 down 分支，且 `schema_migrations` 带 checksum 漂移锁（`:91-93`，"已应用的迁移不可修改，请新增迁移文件"），回滚语义见 `../Runbooks/rollback.md`。

## 待办 / 未裁决登记

| 编号 | 事项 | 状态 |
|------|------|------|
| D-01 | 落地根目录 `Dockerfile`（`node:20`、apt 构建依赖、多阶段剥离 devDeps） | ⚠️ 未实现，本文只提供草案 |
| D-04 | 新增无头启动入口（如 `start:headless` = `node dist/main/Src/main.js --portable`）并验证产物可独立运行 | ⚠️ 未实现 |
| D-05 | 补 `.dockerignore`（至少 `node_modules`、`Data`、`Logs`、`.git`、`dist`、`.tmp`、`coverage`） | 【需人工裁定】现状：仓库确无 `.dockerignore`，`COPY . .` 会把 `Data/.secrets/` 带入镜像层；本文不代工程侧决策，登记为安全缺陷待办 |
| D-07 | 服务端线（`Server/`）容器化与多进程编排 | ⚠️ 未实现，目前只有 PG 的 compose；`Server/` 自身仍未纳入版本库 |
