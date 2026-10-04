# Windows 部署指南

> Windows 环境下的特殊注意事项

> **2026-10-03 校准**（依据 `Docs/Dev/Server-03-部署运维-差别清单.md` W-01…W-04，逐条复核当前仓库实态后回写）：
> 原文只覆盖本地端 `Src/` + Electron，未提服务端线 `Server/`（需 PostgreSQL/容器运行时与独立依赖）；
> 打包前置缺了"放置应用图标"这一条（`package.json:89` 指向的 `assets/icon.ico` 目前不存在）；
> `release/` 产物目录尚未纳入 `.gitignore`。本版逐条登记，其中属取舍问题的以【需人工裁定】记录现状 + 待办，不代作决定。

---

## 前置要求

- **Windows 10/11**
- **Node.js** ≥ 20.0.0（推荐通过 [nvm-windows](https://github.com/coreybutler/nvm-windows) 安装；`package.json:7-9` `engines.node`）
- **Git for Windows**
- **Visual Studio Build Tools**（原生模块编译场景；适用面与是否降级为可选，见下方 W-02 登记，本轮不裁决）
- **仅跑服务端线（`Server/`）时才需要**：Docker Desktop（起 `Server/docker-compose.yml` 的 PostgreSQL 16）**或**本机原生 PostgreSQL 16（`Server/README.md` §1.2 给了无 Docker 的 `initdb`/`pg_ctl` 路径）
  - `Server/package.json:25` 依赖 `@node-rs/argon2` 原生模块，Windows x64 通常有预编译产物，安装失败时才需本机编译链。
  - ⚠️ 仅跑本地端（`:3000` + Electron）可完全忽略上一条。

> **2026-10-03 校准（W-02，【需人工裁定】）**：原前置"Visual Studio Build Tools（better-sqlite3 编译需要）"与实态有出入，登记如下两条事实：
> 1. 根依赖是 `better-sqlite3@^13.0.3`（`package.json:101`），该版本族通常提供 win-x64 预编译包，**多数场景不需要本机编译**；
> 2. 仓库文档里真正点名的编译链动作是 **Electron ABI 不匹配时重编译**——`npx @electron/rebuild`（`ELECTRON.md:103-108`，`@electron/rebuild` 已在 `package.json:110` devDependencies），且打包配置已用 `asarUnpack`（`package.json:95-98`）为 `better-sqlite3`/`*.node` 让路。
>
> **待办**：VS Build Tools 究竟写成"必需"还是"仅在源码安装/ABI 不匹配时需要"，以及是否把 `npx @electron/rebuild` 提为 Windows 打包常规前置（与 `ELECTRON.md` 合并口径），需人工裁定后统一改述；本轮保留原条目 + 登记事实，不裁决。

## 安装步骤

```powershell
# 1. 安装 Node.js（通过 nvm-windows）
nvm install 20
nvm use 20

# 2. 安装 Visual Studio Build Tools（适用面见文首 W-02 登记：多数原生模块有 win-x64 预编译包，
#    Electron ABI 不匹配时仓库既有口径是 npx @electron/rebuild）
# 下载地址：https://visualstudio.microsoft.com/visual-cpp-build-tools/
# 安装时勾选 "Desktop development with C++"

# 3. 克隆仓库
git clone https://github.com/linmowudie/CivitasAI.git
cd CivitasAI

# 4. 安装本地端依赖
npm install

# 4b. 服务端线依赖（Server/ 是独立 npm 包，根 npm install 覆盖不到）
#     ⚠️ 当前 Server/ 为工作区未跟踪目录（git status = ?? Server/），克隆结果里可能不存在它
cd Server; npm install; cd ..

# 5. 配置环境变量
Copy-Item .env.example .env            # 本地端 LLM Key
Copy-Item Server\.env.example Server\.env   # 服务端线（若存在 Server/）
# 编辑 .env，填入 API Key

# 6. 启动本地端
npm run dev

# 6b. 启动服务端线（需 Docker Desktop 或原生 PG；docker compose 属 Docker Desktop 的 CLI）
npm run server:db:up      # PostgreSQL 16，端口 5432，卷 civitas_pgdata
npm run server:migrate
npm run server:dev        # Fastify :8787
```

## Electron 桌面模式

```powershell
# 开发模式
npm run dev:electron

# 打包前置：放置应用图标（W-03，2026-10-03 校准补）
#   package.json:89 的 win.icon 指向 assets/icon.ico，而当前 assets/ 目录只有 README.md（无 icon.ico / icon.png）
#   需按 assets/README.md 放置：icon.ico（256x256，Windows）与 icon.png（512x512，通用）
#   ELECTRON.md:87-90 亦把这两份文件列为打包前置
#   缺省时的实态表现：electron/main.ts:25-26 检测 assets/icon.png 不存在 → 回落 undefined 且**不报错**；
#   ICO 缺失时按 assets/README.md:26-31 的说法由 electron-builder 使用默认图标 →
#   产物能生成，但图标与预期不一致（首次打包易踩，未在实机复验）

# 打包为便携版（= npm run build:all + electron-builder --win portable，package.json:36）
npm run electron:build
# 输出：release/CivitasAI-Portable.exe
#   目录/文件名与配置一致：directories.output = release（package.json:44-46）、
#   win.target = portable/x64（:80-90）、portable.artifactName = CivitasAI-Portable.exe（:91-93）
#   仅展开产物、不打包 exe 可用：npm run electron:build:dir（package.json:37）

# 产物体积提示：约 150-200MB（ELECTRON.md:39）
```

> **2026-10-03 校准（W-04，【需人工裁定】）**：`release/` **目前未被 `.gitignore` 排除**
> （`.gitignore` 全文 36 行无 `release` 条目；`git check-ignore release` 退出码 1），
> 打包一次即有 150-200MB 产物以未跟踪文件形式污染工作区。
> **现状**：本仓库当前尚无 `release/` 目录（尚未打过包）。
> **待办**：由人工裁定后择一落地——①在 `.gitignore` 增加 `release/`（工程侧修复）；②仅在文档保留提醒。本轮不改 `.gitignore`，只登记。

## 常见问题

### better-sqlite3 编译失败

```powershell
# 确保安装了 Visual Studio Build Tools
npm install --build-from-source
```

> **2026-10-03 校准（W-02 补）**：若报错出现在 **Electron 运行时**（ABI/版本不匹配，而非首次编译），
> 仓库既有口径是重编译而非重装：`npx @electron/rebuild`（`ELECTRON.md:103-108`）。
> 打包侧已配 `asarUnpack`（`package.json:95-98`）把 `better-sqlite3` 与 `*.node` 解出 asar，
> 故"asar 内原生模块路径找不到"这一类问题通常不适用本仓库。

### 路径长度超限

```powershell
# 启用长路径支持（管理员权限）
reg add "HKLM\SYSTEM\CurrentControlSet\Control\FileSystem" /v LongPathsEnabled /t REG_DWORD /d 1 /f
```

### PowerShell 执行策略

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

### PostgreSQL 起不来（服务端线）

```powershell
cd Server
docker compose up -d db
docker compose logs -f db   # 看数据库是否完成初始化、端口是否被占用
```

- 无 Docker Desktop 时改用本机 PG，步骤见 `Server/README.md` §1.2；随后把 `Server/.env` 的 `DATABASE_URL` 指向本机实例（`Server/.env.example:12` 为默认值示例）。
