# agent.md —— AI 编码代理 / 新人实操指南

> 这份文件只写**代码里读不出来、但每次干活都要用到**的东西：怎么跑、怎么验、哪里会踩坑。
> 项目**设计**（五层架构、十步主循环、治理闭环、Token 经济…）一律以 `Docs/` 为准，
> 索引见 [`Docs/README.md`](Docs/README.md)；本文不重复设计内容。
>
> 最后更新：2026-10-08。**计数类数字（测试数、警告数）会漂移**，以命令实际输出为准。

---

## 0. 30 秒上手

```bash
node -v                 # 需 >= 20（package.json engines）；实测 v22.23.0
npm install             # 根 + Client 两处依赖（Client 是独立 package）

npm run dev:electron    # 完整应用（后端 + Vite + Electron 窗口）——开发首选
npm test                # 全量测试（vitest run）
npm run typecheck       # 后端类型检查（tsc --noEmit）
cd Client && npx tsc --noEmit   # 前端类型检查（注意：不在根 typecheck 里）
npm run lint            # ESLint（**只覆盖 Src/**）
```

> 🔑 **本机启动 Electron 前必须清掉 `ELECTRON_RUN_AS_NODE`**（见 §9.1），否则应用启动即崩。

---

## 1. 技术栈与目录地图

| 位置 | 内容 | 改动要点 |
|---|---|---|
| `Src/` | 后端（TS ESM），五层：`Interface / Core / Services / Tools / Infra` | 主战场；分层由 ESLint `import/no-restricted-paths` 约束（见 §3.1） |
| `Client/` | 前端（React 19 + Vite + Zustand），**独立 package** | 有独立 `tsconfig.json`；Vite 端口 5173 |
| `electron/` | Electron 主进程 + preload（TS） | 打包为 **CJS**（`dist/main/electron/*.cjs`） |
| `Tests/` | Vitest 用例（按被测分层的同名目录） | 见 §4；`tsconfig.json` **不包含** Tests |
| `Configs/` | 运行配置 JSON（`modelRouter.json` = 供应商/密钥引用/路由） | 用户可编辑 → 校验失败必须报错，不能静默跳过 |
| `Prompts/` `Skills/` | 角色提示词与技能资产（`.md`/`.json`） | 装载失败要告警（"加了资产却不生效"最难查） |
| `Scripts/` | 构建/打包/校验脚本（`build.cjs`、`package.cjs`…） | `build.cjs` = esbuild 打包（详见 §6） |
| `Docs/` | **设计文档唯一事实源**（`Agent/` `Client/` `Server/` `Dev/` `99-审查记录/`） | 改行为要同步文档 |
| `Data/` `Logs/` | 运行时数据与日志（**均 gitignore**） | 见 §10 |
| `dist/` | 构建产物（gitignore）：`dist/main`（后端+electron）、`dist/renderer`（前端） | 见 §6 |

`Src/` 内部快速定位：

| 需求 | 去哪 |
|---|---|
| 主循环 / 迭代判定 | `Src/Core/Loop/`（`runIteration.ts` 是核心） |
| 模型调用与供应商 | `Src/Infra/Llm/`（`Router/modelRouter.ts`、`Provider/openaiProvider.ts`） |
| 工具实现 | `Src/Tools/Builtin/`（读/写/编辑/grep/shell…） |
| 路径安全（工作目录隔离） | `Src/Infra/Security/workspaceGuard.ts`、`Src/Infra/Security/pathGuard.ts` |
| 密钥与凭据 | `Src/Infra/Security/keyStore.ts`（`env:` 引用）、`secretsStore.ts`（加密持久化） |
| REST 接口 | `Src/Interface/RestApi/`（按域分文件）+ `WebServer/httpServer.ts`（端口 3000） |
| Electron IPC | `Src/Interface/IpcBridge/ipcBridge.ts`（**唯一** IPC 边界，含供应商/会话/密钥/配置通道） |
| 事件总线 | `Src/Services/EventBus/`（前端消费见 `Client/src/hooks/useEventBus.ts`） |

---

## 2. 三种运行形态（别混用端口）

| 命令 | 形态 | 说明 |
|---|---|---|
| `npm start` | 纯后端（浏览器模式） | `tsx Src/main.ts`，HTTP 3000；无 Electron → 原生目录对话框等能力降级为 `window.prompt` |
| `npm run dev` | 后端 + Vite | 后端 `tsx watch` + 前端 5173（浏览器访问 `http://localhost:5173`） |
| `npm run dev:electron` | **完整应用** | `build:server` → Vite(5173) → `electron .`（开发态窗口 `loadURL('http://localhost:5173')`） |
| `npm run dev:server` / `start:electron` | 分离启动 | 需自行先起 Vite |

- 后端端口 **3000**（`server.httpPort`），Vite **5173**。**3000 被占用时新实例会直接失败退出**（不再静默）——启动前先确认端口空闲。
- Electron 主进程**内嵌启动后端**（同一进程），所以 `dev:electron` 与 `npm start` 不能同时跑。
- 需要 GUI 自动化时加 `--remote-debugging-port=9222`（见 §5）。

---

## 3. 开发规范

### 3.1 分层（ESLint 强制，`.eslintrc.json`）

```
Interface → Core → Services → Tools → Infra     （只允许向下依赖）
```

`import/no-restricted-paths` 规则要点：
- `Infra` 不得依赖上层；`Tools` 不得依赖 Services/Core/Interface；
- `Services` 不得依赖 `Interface`；**可以**依赖 `Core/AgentRuntime` 与 `Core/Decision`（`except` 白名单，
  历史原因，见 `Docs/Dev/Cordis改造可行性评估报告.md` 对 Core↔Services 双向依赖的分析）；
- `Core` 不得依赖 `Interface`。

⚠️ **陷阱**：`npm run layer-check` 的 `--rule` 传了**空的 `zones`**，等价于没检查（no-op）。
真正的分层门禁是 `npm run lint`（读 `.eslintrc.json` 里的 zones）。

### 3.2 错误处理（**项目铁律**）

> **后端不能静默吞掉错误；可被用户解决的错误不能吞。**

- 允许 fail-soft（不阻断主链路），但**必须写明理由**：`catch { /* fail-soft：… */ }`；
- **可被用户解决的错误必须可观测**：缺 API Key、路径/权限、配置写错、磁盘满、凭据写入失败、
  资产文件读不出来 → 至少 `logger.warn` 带上下文；面向界面的通道（REST/IPC/事件）要能把原因回传；
- 禁止"失败后什么都不回"：典型反例是主循环失败但 `AGENT_STREAM_END` 不带 `error`，
  界面只剩一个空进度条；
- 机械化门禁：[`Tests/Infra/noSilentErrorSwallow.policy.spec.ts`](Tests/Infra/noSilentErrorSwallow.policy.spec.ts)
  用 TS AST 扫描 `Src/**`，**每个空 `catch {}` / 空 `.catch(() => {})` 都必须带理由注释**，否则测试红。

新增 `Result.err` 的路径，请同时考虑：调用方是否会把 err 丢掉（丢掉也是吞错）。

### 3.3 其他约定

- 注释写**为什么**（含"哪次修复、什么现象"），不写"做了什么"——本仓库注释普遍很长，请保持这个风格；
- 面向用户的文案用中文；日志 message 中文 + 结构化 `data`（`logger.warn('…', { source, error, … })`）；
- 只改必要范围：**不要顺手重排格式**（仓库无 `.prettierrc`，prettier 默认规则会把整文件重排，见 §9.5）；
- 时间戳在日志里是 **UTC**（本地时间 = +8）。

---

## 4. 测试

```bash
npm test                      # 全量（vitest run）：2026-10-08 基线 145 文件 / 1734 用例全绿
npx vitest run Tests/Infra/workspaceGuard.spec.ts   # 单文件
npx vitest run -t '关键词'     # 按用例名
npm run test:coverage
```

- 配置：[`vitest.config.ts`](vitest.config.ts)。`include` 仅 `Tests/**`，默认 `environment: 'node'`；
  别名：`@`→`Client/src`、`@Infra|@Tools|@Services|@Core|@Interface`→`Src/*`，并把 `react/react-dom/zustand`
  固定到根 `node_modules`（**避免双 React 实例**）。
- 用例放在 `Tests/<被测分层>/xxx.spec.ts`（目录与 `Src/` 对齐，如 `Tests/Infra/`、`Tests/LoopControl/`）。
- **前端组件测试**：文件首行加 `// @vitest-environment jsdom`，从 `../../Client/src/...` 导入，
  需要时补 `@testing-library/jest-dom/vitest`；`jsdom` 缺 `Element.prototype.scrollTo` 等 API 时自行打桩。
- **类型检查盲区**：根 `tsconfig.json` 排除了 `Tests/`，`npm run typecheck` **不会**检查测试代码；
  测试里的类型错误只在 vitest 转译时报出来。改测试后务必真的跑一遍。
- ESLint **不覆盖 `Client/`**：前端类型问题靠 `cd Client && npx tsc --noEmit`。
- 数据库/模型**不 mock**（集成与 E2E 打真实 SQLite）；新增 `Tests/Experiments/` 用例要同步
  `Benchmarks/experimentMatrix.json`，禁止伪断言（未实现的检测点标 `declared-only`）。

> `Tests/README.md` 里的计数（"43 个 spec / 823 用例"）已过时，以 `npx vitest run` 输出为准。

---

## 5. 真实 GUI 测试（Electron + CDP）

浏览器模式测不出 Electron 特有行为（原生对话框、preload、IPC、窗口）。要测真实窗口：

```powershell
# 1) 先起 Vite（Electron 开发态窗口加载 5173）
cd Client; npx vite
# 2) 再起 Electron，并开放 CDP
cd ..; Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
node_modules\.bin\electron.cmd . --remote-debugging-port=9222
# 3) 确认目标：http://127.0.0.1:9222/json/list → type=page 且 url 含 5173
```

用 `ws`（已是依赖）写脚本驱动：`Runtime.evaluate` 点击/输入/读 DOM，`Page.captureScreenshot` 存证。
**关键坑**：CDP 响应的 RemoteObject 在 `msg.result.result` 里，封装的 `send()` 要 resolve `m.result`，
否则拿到的永远是 `undefined`；Vite HMR 重载后旧 WebSocket 会失效，**脚本要重新 `/json/list` 取目标**。

可直接复用的脚本（本次开发留在 `.tmp/`，随时可重写）：

| 脚本 | 作用 |
|---|---|
| `.tmp/gui-drive.mjs` | 新任务→发送→断言空态/锁定/输入框位置（含截图） |
| `.tmp/gui-apikey.mjs` | 缺 API Key → 弹窗 + 跳设置页 |
| `.tmp/gui-provider-url.mjs` | 供应商表单：URL 可编辑 / 自动填充 / 自动识别 |
| `.tmp/gui-secret-guard.mjs` | 凭据写入防护（拒绝空列表覆盖） |
| `.tmp/cdp-secrets3.mjs` | 读应用内解密后的凭据（**不回显密钥**，只看名字/地址/长度） |
| `.tmp/log-window.mjs` | 按时间窗读 `Logs/business.log` |

在渲染层调用后端能力的入口：`window.electronAPI.<group>.<method>()`
（分组：`modelProviders / sessions / todos / configs / data / device / secrets / secureStore / onboarding / serverFetch`）。

---

## 6. 构建与打包

| 命令 | 产物 |
|---|---|
| `npm run build` | 仅类型检查（`tsc --noEmit` + `tsc -p tsconfig.electron.json`） |
| `npm run build:server` | `Scripts/build.cjs`：esbuild 单文件 → `dist/main/Src/main.js`(**ESM**)、`dist/main/electron/main.cjs`+`preload.cjs`(**CJS**) |
| `npm run build:client` | `Client` vite build → `Client/dist`，并跑 `Scripts/verifyClientDist.cjs` |
| `npm run build:all` | 上面两个 |
| `npm run electron:build` | `build:all` + `electron-builder --win portable` |
| `npm run package*` / `package:check` | `Scripts/package.cjs` 系列（NSIS/便携/目录） |

要点：
- `Scripts/build.cjs` 的 `external`: `better-sqlite3 / fsevents / electron / ws`——**原生模块与 electron 不打进包**。
- Electron 主进程必须是 **CJS**：Electron 44 / Node 24 下 ESM 拿不到 `electron` 模块
  （`import { app } from 'electron'` 报 "does not provide an export named 'app'"），这是刻意的。
- **后端跑的是 `dist/main`，不是 `Src/`**：改了 `Src/` 后必须 `npm run build:server` 并**重启 Electron**
  才生效；前端在开发态走 Vite（改完 HMR 即可）。
- 打包态静态托管会从 `dist/renderer` 与 `Client/dist` 中**取 mtime 最新的**（旧产物曾盖住新界面，见 `Src/main.ts`）。

---

## 7. 提交前固定门禁

```powershell
npm run typecheck                     # 后端类型
cd Client; npx tsc --noEmit; cd ..    # 前端类型
npm run lint                          # ESLint（Src/）
npm test                              # 全量用例
npm run build:server                  # 确认打包无碍
```

改动涉及界面/启动/凭据时**再加**真实 GUI 验证（§5）。提交信息用 `fix(scope):` / `feat(scope):` 风格，
正文写清"现象 → 根因 → 修复 → 验证"（本仓库 git log 是重要的事故档案）。

---

## 8. 重要文档索引（按"什么时候看"）

| 你要做的事 | 先读 |
|---|---|
| 找任何设计文档 | [`Docs/README.md`](Docs/README.md)（三端索引 + 引用记法） |
| 搞懂整体架构与启动步骤 | `Docs/Agent/01-系统概览/系统设计总览.md`、`Docs/Agent/02-核心架构/核心架构设计.md`（含启动 18 步/关闭 9 步） |
| 改主循环 / 迭代判定 | `Docs/Agent/11-循环控制系统/循环控制系统设计.md` |
| 改持久执行 / 恢复 | `Docs/Agent/12-持久执行与恢复/持久执行与恢复设计.md` |
| 接口契约与开发规范 | `Docs/Agent/16-开发规范/`（五层 Interfaces 契约） |
| 前端架构 / AI 组件族 | `Docs/Client/02-前端改造基础/`、`Docs/Client/03-AI组件族架构/` |
| 参数与默认值 | `Docs/Agent/14-参数总典与接口契约/参数总典.md` |
| **现状与设计的差异** | `Docs/Dev/README.md` + 各 `*-差别清单.md`（806 条差异，标注了什么已实现） |
| 架构决策依据 | `ADR/README.md`（ADR-0003 Verifier 不可跨级 / 0004 Maker-Checker / 0005 LoopState 不可变区…） |
| 代码/工程变更历史 | 根 `CHANGELOG.md`；设计文档变更史在 `Docs/CHANGELOG.md` |
| 打包与签名 | `ELECTRON.md`、`Scripts/README.md` |
| 各目录速览 | 各目录 `README.md`（`Src/` `Client/` `Server/` `Configs/` `Tests/` `Prompts/` `Skills/` `electron/` `Data/` `Logs/`） |
| Cordis 改造评估（未实施） | `Docs/Dev/Cordis改造可行性评估报告.md`、`Docs/Dev/Qoder-Cordis容器化与分层插件树-实现提示词.md` |
| 已知循环/路径缺陷 | `Docs/Dev/Agent循环与路径-Bug登记.md` —— **只读**：登记用，禁止改动 |

---

## 9. 环境坑（Windows / Electron 实测）

### 9.1 `ELECTRON_RUN_AS_NODE=1` 会让 Electron 崩
某些宿主/终端会注入该变量，此时 `electron.exe` 退化为**纯 Node**：`require('electron')` 只返回二进制路径字符串，
主进程报 `TypeError: Cannot read properties of undefined (reading 'isPackaged')` 并退出。
判别：`electron --version` 打印 Node 版本（如 `v24.20.0`）而非 Electron 版本（如 `v44.3.0`）。
修法：启动前 `Remove-Item Env:ELECTRON_RUN_AS_NODE`。

### 9.2 端口
`START` 前确认 3000 空闲；`EADDRINUSE` 现在会**明确报错退出**（曾被吞掉，导致"日志说启动成功但服务是旧的"）。
残留进程（Vite/后端/electron）要按命令行核对后清理。

### 9.3 密钥存放位置随模式变化
- 开发态：`Data/.secrets/providers.json.enc`（**gitignore**）
- 安装态：`%APPDATA%\CivitasAI\.secrets\providers.json.enc`
用 Electron `safeStorage` 加密（非 Electron 环境降级 Base64）。**不要**把明文密钥写进 `Configs/`。

### 9.4 preload 与 `window.electronAPI`
浏览器模式下 `window.electronAPI` 不存在 → 相关能力降级（如目录选择用 `window.prompt`）。
界面代码必须对"非 Electron"分支优雅降级。

### 9.5 husky 提交钩子
`.husky/pre-commit` 会对**暂存文件**跑 `pretty-quick`（prettier）。仓库**没有 `.prettierrc`**，
prettier 默认 `printWidth: 80` 会把单文件重排成几百行噪声 diff。对策：要么加 `.prettierrc`（`singleQuote: true`、`printWidth: 120`），
要么 `git commit --no-verify`（本仓库近几次提交均如此），但**不要**把格式化噪声混进功能提交。

### 9.6 其它
- 部分文件是 CRLF，git 会提示 "CRLF will be replaced by LF"——正常，别在同一个提交里顺手转换行尾。
- 用 PowerShell 跑 `node -e "…"` 时嵌套引号极易写坏；**复杂脚本写进 `.tmp/*.mjs` 文件再执行**。

---

## 10. 运行时数据与排查

```
Data/db/civitas_main.db      # 主库（会话/消息/审批/记忆…）
Data/db/civitas_events.db    # 事件溯源
Data/db/civitas_memory.db    # 记忆
Data/.secrets/               # 加密凭据
Data/workspaces/sess-xxxx/   # 每个会话的工作目录（工具沙箱根）
Logs/business.log            # 业务日志（JSON Lines，UTC 时间戳，排查首选）
Logs/system.log
```

排查姿势：
```powershell
node .tmp\log-window.mjs 2026-10-08T11:49      # 时间窗读日志（UTC 前缀）
node -e "const D=require('better-sqlite3');const d=new D('Data/db/civitas_main.db',{readonly:true});console.table(d.prepare('SELECT ...').all())"
```
**先看 `Logs/business.log` 的 `level=warn|error`**：本仓库关键失败路径都会落日志（这正是 §3.2 的目的）。

---

## 11. 明确禁止

- ❌ **不要**创建影子源码树（`SrcNext/`、平行副本）来做重构——历史上造成过"改了一份、跑的是另一份"的事故。
  需要大改造请**另开分支或另建目录**，并明确说明哪份是事实源。
- ❌ **不要**修改 `Docs/Dev/Agent循环与路径-Bug登记.md`（只读登记簿）。
- ❌ **不要**用"整包覆盖"的方式写供应商凭据（会丢密钥）；后端已加防护：
  拒绝用空列表覆盖已有凭据（`Src/Infra/Security/secretWriteGuard.ts`）。
- ❌ **不要**在 `catch` 里什么都不做且不留理由（政策测试会红）。
- ❌ **不要**把 `Src/` 的改动当成已生效——后端跑的是 `dist/main`（见 §6）。
- ❌ **不要**提交 `Data/`、`Logs/`、`.tmp/`、`client/dist`、证书私钥（已 gitignore，别强行 `-f`）。

---

## 12. 完成定义（DoD）

一次改动算完成，必须同时满足：

1. `npm run typecheck` + `cd Client && npx tsc --noEmit` 均 0 error；
2. `npm run lint` 不新增 error；
3. `npm test` 全绿（新增行为**有对应测试**：纯逻辑走单测，界面走 jsdom 组件测试，端到端走真实 GUI/CDP 或 REST 验证）；
4. 涉及启动/界面/IPC/凭据的改动，**在真实 Electron 应用里验证过**（§5），并保留证据（截图/断言输出）；
5. 错误路径符合 §3.2（可被用户解决的必须可见）；
6. 行为变化同步到 `Docs/`（设计）与根 `CHANGELOG.md`（工程）；
7. 提交信息说明"现象→根因→修复→验证"。
