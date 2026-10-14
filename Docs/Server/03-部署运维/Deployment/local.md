# 本地部署指南

> 在本地开发环境中部署 Civitas-AI

> **2026-10-03 校准**（依据 `Docs/Dev/Server-03-部署运维-差别清单.md` L-01 / L-02 / L-03，逐条复核当前仓库实态后回写）：
> 本仓库是**两条独立部署线**——本地端 `Src/`（HTTP :3000 + Electron 壳）与服务端 `Server/`（Spring Boot :8787 + PostgreSQL :5432）。
> 原文只覆盖本地端，且把 `npm run start` 写成"生产启动"（实为 `tsx` 跑 TS 源码），本版一并纠正。

---

## 前置要求

- **Node.js** ≥ 20.0.0（`package.json:7-9` `engines.node`）
- **npm** ≥ 10.0.0
- **Git**
- 华为云 MaaS API Key（或其他 LLM Provider）
- 仅当要跑服务端线（`Server/`）时另需：**JDK 21+ 与 Maven 3.9+**（构建/启动），以及 **PostgreSQL 16**（经 Docker/容器运行时起 `Server/docker-compose.yml`，或原生 PG）

## 安装步骤

```bash
# 1. 克隆仓库
git clone https://github.com/linmowudie/CivitasAI.git
cd CivitasAI

# 2a. 安装本地端依赖（根包 civitas-ai）
npm install

# 2b. 服务端线无需 npm 安装 —— Server/ 已是独立 Maven 工程（Server/pom.xml），
#     依赖由 Maven 管理（需 JDK 21+ 与 Maven 3.9+；Server/node_modules 已移除）

# 3. 配置环境变量
cp .env.example .env                    # 本地端：唯一键 HUAWEI_MAAS_API_KEY（.env.example:6）
cp Server/.env.example Server/.env      # 服务端：HOST/PORT/DATABASE_URL 等（Server/.env.example:7-12）

# 4. 启动本地端（后端 tsx watch + 前端 Vite 并发）
npm run dev
```

> ⚠️ 前置说明：`Server/` **已入库**（自提交 763b113 起被跟踪），克隆该分支即包含它；
> 2026-10-14 Java 重写后 `Server/src/main|test`、`pom.xml` 为该分支工作树内的新一轮变更（尚未提交）。

## 服务端口

| 服务 | 默认端口 | 配置项 | 所属线 |
|------|---------|--------|--------|
| HTTP API | 3000 | `server.httpPort`（`Configs/default.json:12`） | 本地端 |
| 前端（Electron 壳） | — | 经 `electron/preload.ts` IPC 桥接与后端通信 | 本地端 |
| 前端（Vite，开发） | 5173 | `Client/vite.config.ts:40`（`strictPort: true`，`/api` 代理到 :3000） | 本地端 |
| 服务端 API | 8787 | `Server/src/main/java/com/civitas/server/config/ConfigLoader.java`（`PORT` 默认 8787）+ `Server/.env.example:8` | 服务端（L-01 补） |
| PostgreSQL | 5432 | `Server/docker-compose.yml:24` + `Server/.env.example:12` `DATABASE_URL` | 服务端（L-01 补） |

> WebSocket（`server.wsPort`，3001）已删除（2026-09-28），现为 Electron IPC 桥接 + REST(:3000)。`Configs/default.json` 中的 `wsPort: 3001` 为历史遗留，无实际 WS 服务。
> 8787 / 5432 属服务端线，仅跑本地端时可忽略。

## 开发模式

```bash
# 后端 + 前端热重载
npm run dev

# 仅后端
npm run dev:server

# Electron 桌面模式
npm run dev:electron
```

## 服务端线（`Server/`，可选）

根 `package.json:21-26` 已提供转发脚本（现为 Maven 包装），无需手工 `cd`：

```bash
npm run server:db:up        # docker compose up -d db（postgres:16-alpine，端口 5432，卷 civitas_pgdata）
npm run server:migrate      # 执行 Server/migrations/*.sql（幂等）
npm run server:dev          # cd Server && mvn spring-boot:run（Spring Boot :8787）
npm run server:test         # Server 单元 + 集成测试（mvn test）
```

- 探活：`GET http://127.0.0.1:8787/healthz`、`GET /readyz`（含数据库连通性）——`Server/src/main/java/com/civitas/server/http/HealthController.java`（免鉴权/免限流白名单见同包 `IpRateLimitFilter.java`）。
- 更多用法见 `Server/README.md`。

## 生产模式

```bash
# 编译产物（esbuild 打包后端 + Vite 打包前端）
npm run build:all          # = build:server + build:client（package.json:14）

# 以产物启动桌面端
npm run start:electron     # = electron .（package.json:16），入口取 package.json:6 的 main = dist/main/electron/main.js
```

> **2026-10-03 校准（L-02）**：原写"`npm run build:all` 后 `npm run start` 即为生产启动"**不成立**。
> `start` = `tsx Src/main.ts`（`package.json:15`）——直接运行 TypeScript 源码，**不加载** `build:all` 的产物，
> 且 `tsx` 属 devDependencies（`package.json:137`）。
> 当前**唯一被脚本覆盖的产物启动方式**是 `npm run start:electron`；`build:all` 的产物主要服务 Electron 打包
> （`electron:build` = `build:all` + `electron-builder --win portable`，`package.json:36`，详见 `windows.md`）。
> ⚠️ 无头（不含 Electron）生产入口**尚未实现**：`Scripts/build.cjs:12,25-32` 产出的后端入口是 `dist/main/Src/main.js`
> （注意不是 `dist/main/main.js`），仓库既没有对应 npm script，也没有对该路径的运行期验证 → 列为目标态，不写成可执行步骤。
> **待办**：如需无头部署，补 `start:headless`（并带 `--portable`，否则 `Data/`、`Logs/` 会落到 `%APPDATA%/CivitasAI/` 或 `$HOME/.config/CivitasAI/`，见 `Src/Infra/Fs/pathResolver.ts:40-53`、`:57-68`）。

## 验证安装

```bash
# 类型检查
npx tsc --noEmit

# Electron 主进程/preload 类型检查
npm run typecheck:electron

# 运行测试
npm test

# ESLint
npm run lint

# 服务端线（可选，需可用的 PostgreSQL）
npm run server:test
```

> **2026-10-14 校准（Java 重写）**：本节 Server 线命令/符号已按 Java 版（Maven）改写；TS 版历史口径不再适用，逐条对位见 `Docs/Server/01-服务端/服务端设计文档.md` 附录 E。
