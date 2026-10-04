# 快速开始指南

> 5 分钟内跑起来 Civitas-AI
>
> **2026-10-03 校准**：安装链（`Client/` 是独立 npm 工程）、构建/启动脚本语义（`npm run build` 不产出可运行产物）、桌面模式命令、两个端口的真实来源、浏览器模式能力边界，全部按 `package.json`、`Client/package.json`、`Client/vite.config.ts`、`electron/main.ts`、`Src/main.ts`、`Scripts/` 实态重写。

## 前置要求

| 要求 | 实态 |
|------|------|
| Node.js ≥ 20.0.0 | `package.json → engines.node = ">=20.0.0"`（声明式约束） |
| npm ≥ 10 | **建议值**：仓库无 `engines.npm`、无 `packageManager` 字段，`Scripts/install.sh` / `install.ps1` 也只打印版本、不做校验 |
| 华为云 MaaS API Key | [获取地址](https://console.huaweicloud.com/maas) |

> 【需人工裁定】npm 版本约束是否强制（现状：仅口头约定，无任何强制点）。
> 待办：补 `"engines": { "npm": ">=10" }` + `packageManager` 字段，或在两个安装脚本里加版本校验；否则文档只能写"建议"。本轮仅登记现状，不作裁决。

## 安装

⚠️ **2026-10-03 校准**：本仓库是**三个彼此独立的 npm 工程**——根 `package.json` 既无 `workspaces` 也无 `postinstall`，所以**在根目录执行一次 `npm install` 装不上前端依赖**，而 `npm run dev` 内部要执行 `cd Client && npx vite`，干净克隆会在这一步失败。

| 目录 | 内容 | 是否必装 |
|------|------|---------|
| 仓库根 | 后端 `Src/` + Electron 壳 `electron/` + 构建/诊断脚本 `Scripts/` | 必装 |
| `Client/` | Vite + React 19 前端（自带 `package.json` + `package-lock.json`） | 要看界面就必装 |
| `Server/` | 自托管账号/数据服务端（Fastify + PostgreSQL，独立 npm 包） | 可选，见 `Server/README.md` |

```bash
git clone https://github.com/linmowudie/CivitasAI.git
cd CivitasAI
npm install                        # 根工程：后端 + Electron + 工具链
cd Client && npm install && cd ..  # 前端工程：Vite/React（漏掉这步 npm run dev 起不来）
```

一键安装脚本（6 步：Node/npm 检查 → 根 `npm install` → `cp .env.example .env` → 建 `Data/{Cache,Decisions,Loops,Operations,Sessions,Workspace,db,Hooks}` 与 `Logs/` → `npx tsc --noEmit`）：

```bash
bash Scripts/install.sh            # Linux / macOS
.\Scripts\install.ps1              # Windows PowerShell
```

⚠️ 两个脚本目前**只装根工程依赖**（第 3 步就是根目录 `npm install`，没有 `cd Client && npm install`），且结尾提示"访问 http://localhost:5173 查看界面"仍指向浏览器入口。跑完仍需手动补装 `Client/` 依赖。
待办：脚本补装 `Client/` 依赖、结尾提示改指桌面模式；本轮仅记录现状（不改动脚本）。

## 配置

```bash
cp .env.example .env
```

编辑 `.env`，填入你的 API Key：

```
HUAWEI_MAAS_API_KEY=your_actual_key_here
```

- `.env` 由 `Src/main.ts` 的 `startServer()` 第 ⓪ 步 `process.loadEnvFile(resolve('.env'))` 加载，**按当前工作目录解析**——请在仓库根执行 `npm run ...`。
- `.env` 不存在或被跳过都不报错；真正报错的时点是 Provider 注册后一个都不剩：`无可用 LLM Provider`（`startServer()` ⑪）。
- `.env.example` 现仅声明 `HUAWEI_MAAS_API_KEY` 一个变量。

## 启动

### 开发模式（后端 + Vite 前端，浏览器访问）

```bash
npm run dev
```

= `concurrently` 并行 `tsx watch Src/main.ts` 与 `cd Client && npx vite`：

- 后端 API（REST）：`http://localhost:3000`
- 前端界面（Vite dev server）：`http://localhost:5173`

⚠️ **浏览器模式能力受限**（`Client/src/services/eventBusBridge.ts`，判据 `window.electronAPI?.onBackendEvent`）：

- **命令通道不可用**：`send()` 在非 Electron 下只打印 `console.warn('[eventBusBridge] 浏览器模式下 send 不可用，命令已忽略')` 然后**静默丢弃**——`ChatView` 的 `generate_reply` / `stop_generation` 都走这条通道。
- **聊天整体不可用**：会话创建、消息落库走 IPC（`Client/src/services/ipcApi.ts` → `ipc-create-session` / `ipc-add-message`），浏览器侧没有 `electronAPI`。
- **没有实时事件流**：`connectBridge()` 的降级分支只是每 3 秒重新检测 Electron API 是否出现（`FALLBACK_POLL_MS`），并不拉取事件，因此流式输出/思考卡等组件在浏览器里不会刷新。
- **仍然可用的是 REST**：审批链路走 `GET /api/approvals`、`POST /api/approvals/:id/decide`（`Client/src/stores/approvalStore.ts`），只读视图走 `GET /api/tools`、`/api/skills`、`/api/memory/entries`、`/api/configs/:name` 等；即浏览器可当"查询 + 审批"面板用。

⇒ 要**发起任务 / 观测执行过程**，请用桌面模式（`npm run dev:electron`）。

> 【需人工裁定】浏览器模式定位（"只读 + 审批"观测面 vs 完整操作端）。
> 待办：要么补 REST 命令端点并让 `send()` 落地（`eventBusBridge.ts` 注释里写的"Phase 0 降级方案：后续可接入 REST 命令端点"仍未做）、给浏览器侧接上事件源；要么明确"桌面端是唯一操作入口"的产品口径。本轮按现状记录，不作裁决。

### 桌面模式（Electron 壳 —— 完整操作能力）

```bash
npm run dev:electron     # = npm run build:server，再并行起 Vite 与 Electron（wait-on http://localhost:5173）
npm run electron:dev     # dev:electron 的别名
```

前端界面经 Electron 壳（`electron/preload.ts` 暴露的 `window.electronAPI` IPC 桥）与**同进程内**的后端通信，另有 REST（:3000）。

### 只起后端（无界面）

```bash
npm run start            # tsx Src/main.ts —— 仅 REST(:3000)，不会拉起任何界面
npm run dev:server       # 同一条命令的别名
```

### 构建与生产运行

⚠️ **2026-10-03 校准**：原文"生产模式：`npm run build` → `npm run start`"名不副实——`build` 只做类型检查、**不产出任何 `dist/`**，`start` 是用 `tsx` 从源码跑后端。真实脚本语义如下：

| 目的 | 命令 | 实态 |
|------|------|------|
| 类型校验（**不产出产物**） | `npm run build` | `tsc --noEmit && npm run typecheck:electron`，等价于 `npm run typecheck` + `npm run typecheck:electron` |
| 后端产物 | `npm run build:server` | `Scripts/build.cjs`（esbuild）→ `dist/main/`：`dist/main/Src/main.js`、`dist/main/electron/main.js`、`dist/main/electron/preload.cjs`（preload 必须产为 CJS） |
| 前端产物 | `npm run build:client` | `cd Client && npx vite build` → `dist/renderer/`，并由 `Scripts/verifyClientDist.cjs` 校验产物 |
| 两者一起 | `npm run build:all` | `build:server` + `build:client` |
| 桌面壳直跑 | `npm run start:electron` | `electron .`，入口取 `package.json → main`（`dist/main/electron/main.js`）→ **必须先 `npm run build:server`**；但此时 `app.isPackaged === false`，窗口仍加载 `http://localhost:5173`（需另有 Vite 在跑）⇒ 日常桌面调试请用 `npm run dev:electron` |
| 可分发产物 | `npm run electron:build` | `build:all` + `electron-builder --win portable` → `release/CivitasAI-Portable.exe`（打包态才加载 `dist/renderer/index.html`）；免安装目录版 `npm run electron:build:dir` |

## 验证

```bash
# 运行测试
npm test                 # vitest run

# 类型检查
npm run typecheck        # tsc --noEmit（等价 npx tsc --noEmit）

# ESLint（后端）
npm run lint             # eslint Src/ --ext .ts
```

CI 步骤与之一致（`.github/workflows/ci.yml`）：`npm ci` → `npm run lint` → `npx tsc --noEmit` → `npm run typecheck:electron`；测试 Job 另跑 `npm test -- --coverage` 并按 `Configs/coverageBaseline.json` 设门禁。

> 前端事件类型副本 `Client/src/shared/eventTypes.ts` 由 `npm run gen:event-types` 从后端枚举生成，勿手改。

## 常见问题

### 模型调用失败
检查 `.env` 中的 `HUAWEI_MAAS_API_KEY` 是否正确，以及网络是否能访问华为云 MaaS 端点；端点与模型在 `Configs/modelRouter.json`（`providers[].base_url` / `api_key_ref` / `routing.*Model`）。

### 前端起不来（`vite: command not found` / 找不到 `vite` 包）
根 `npm install` 不含 `Client/` 依赖 → 执行 `cd Client && npm install`。

### 端口冲突（2026-10-03 校准：两个端口来源不同文件）

- **3000（后端 REST）**：改 `Configs/default.json → server.httpPort`（消费点 `Src/main.ts` `startServer()` ⑱）。
  同文件 `server.corsOrigins`（值形如 `["http://localhost:5173"]`）是 **CORS 白名单、不是端口配置**；改后端端口需同步它，并同步 `Client/vite.config.ts → server.proxy['/api'].target`（前端走相对路径 + Vite 代理，代理目标写死了 3000）。
- **5173（Vite 开发服务器）**：改 `Client/vite.config.ts → server.port`；`Configs/default.json` 里**没有** Vite 端口配置。该处 `strictPort: true`，端口被占**直接失败**，不会自动顺延。
- Electron 打包态加载本地 `dist/renderer/`，不依赖 5173。

### `wsPort` / WebSocket
`Configs/default.json → server.wsPort: 3001` 是历史遗留键（WebSocket 已于 2026-09-28 删除，现由 `Src/Interface/IpcBridge/ipcBridge.ts` 的 Electron IPC 桥接 + REST(:3000) 承担；`Src/` 内已无任何 `ws` 服务端引用）。

⚠️ **请勿删除 `server.wsPort` 键**：`Src/Infra/Config/configValidator.ts` 仍强制它为整数，删键会直接启动 FATAL。

> 【需人工裁定】遗留物一次性清理。
> 现状：`package.json` 仍依赖 `ws@^8.21.3`（devDeps 另有 `@types/ws`）、`Scripts/build.cjs` 仍把 `ws` 列为 external、`Scripts/wsDiagnose.cjs` 仍在（`Scripts/README.md` 称其"模拟前端 WS 行为"，而 WS 服务已不存在，照用必然失败）、validator 的 `wsPort` 整数校验仍在。`ws` 包目前仅被 `Scripts/dupCheck.cjs`、`Scripts/wsDiagnose.cjs` 与 `Tests/Integration/realAgentCallTest.ts` 使用，**后端 `Src/` 内已无任何 `ws` 引用**。
> 待办：裁定"移除 `ws` 依赖 + 废弃/改造 `wsDiagnose.cjs` + 去掉 `wsPort` 校验"或长期保留该键并注明。本轮仅登记现状。

### 数据库初始化
首次启动自动创建 SQLite 数据库（`Data/db/` 下三个库，路径见 `Configs/default.json → database`），无需手动操作；`Scripts/install.sh` / `install.ps1` 也会预建 `Data/*` 与 `Logs/`。

### 需要账号/数据服务端（可选，与桌面主流程无关）
根 `package.json` 另提供转发脚本：`npm run server:db:up`（docker compose 起 PostgreSQL）、`npm run server:db:down`、`npm run server:migrate`、`npm run server:migrate:status`、`npm run server:dev`、`npm run server:test` —— 它们都是 `cd Server && npm run <同名脚本>`，需先在 `Server/` 内 `npm install`。详见 `Server/README.md`。
