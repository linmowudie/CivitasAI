# Changelog

本文件记录 Civitas-AI 项目的所有重要变更。

> **📌 定位说明**：本文件是**代码与工程变更记录**（前端/后端实现改动）。设计文档集的变更有独立记录 [Docs/CHANGELOG.md](Docs/CHANGELOG.md)（唯一事实源，含文档-代码对账校准）。二者分工不同：改代码看本文件，查设计演进看 Docs/CHANGELOG。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/)。

---

## [2026-10-07] 模型导入重设计：逐个校验可用性 + 用户勾选导入（不再全量导入）

> 用户实测发现：**部分模型不可用**（`/models` 只代表"账号可见"，未开通/无权限的模型也在列表里）。
> 选中其中一个不可用的模型对话，就会得到"空气泡"。因此导入流程重做。

### 规则（新）

1. 拉取列表（`GET /models`）后**逐个模型发一次最小对话请求**确认可用；
2. **绝不自动全量导入**，也**不再自动勾选**任何模型 —— 由用户在列表里勾选要导入的模型；
3. 只有勾选的模型会写入供应商配置。

### 后端

- **`Src/Infra/Llm/providerProbe.ts` 新增 `verifyModels()`**：批量校验（默认并发 4，可配 1–8），
  每个模型 `POST /chat/completions`（`max_tokens: 1`），返回每模型结论 + 汇总。
  **分类原则（防误杀）**：2xx → `available`；400/404/403 且命中模型级错误特征
  （model_not_found / not exist / not enabled / 无权限 / 未开通 …）→ `unavailable`；
  **429 限流、5xx、超时、网络、401/403 鉴权 → `unknown`**（一次限流不能把好模型全标死）；
  结果顺序与入参一致（并发完成顺序不影响 UI）。
- **IPC 通道 `ipc-verify-models`**（`onboardingIpc.ts` + preload + `ipcApi.ipcVerifyModels`）：
  渲染层按**小批次（8 个/批）**调用以便展示进度；只校验不导入。

### 前端

- **`onboardingStore`**：新增 `availability`（id → 结论）、`verifying`、`verifyProgress`、`verifiedAt`；
  `verifyAvailability()`（分批 + 可取消，用运行令牌在批次边界退出）、`selectOnlyAvailable()`、
  `clearSelection()`；`probeConnection` **不再自动勾选**；`registerProvider` **只导入勾选项**
  （去掉"回退到探测建议"）；`canProceed('credentials')` 要求**至少勾选 1 个模型**。
- **引导页**：新增"校验可用性（逐个探测）"+ 进度 `n/总数` + 取消 + "仅选可用（N）"+ "清空勾选"；
  模型 chip 显示 **可用 / 不可用 / 未知 / 未检测** 徽标与耗时，悬停可看供应商原话；
  文案明确"列表可见 ≠ 当前可用，只会导入你勾选的"。

### 测试

- `Tests/Services/onboarding.spec.ts` 新增 4 例：可用/不可用/未知三态分类（限流不判死）、
  401 整批 unknown、并发下结果顺序稳定、去重与缺参保护（共 **35 例**）。
- `Tests/Client/onboarding-wizard.spec.tsx`：改为"连通后不自动勾选 → 手动勾选才可继续"，
  新增"校验 → 仅选可用只勾选 available"用例。

## [2026-10-07] Agent 列表凭空增殖 · 点击 Agent 只看到占位页

> 用户实测（开发版）：① 右栏 L1 Agent 列表冒出多个 agent（只发了一句"你好"）；
> ② 点 Agent 只切到"开发中"占位页，不是该 Agent 的对话。

### 修复 1：启动即创建治理 Agent → 改为按需绑定（`Src/Services/Arbitration/arbitratorPool.ts`）

- **证据**：`GET /api/agents` 显示 5 个 agent，其中 4 个是**当天新建**：
  `agent-arbitrator-1/-3`（同一秒创建）+ `agent-prime_director-4/-2`。
- **根因（两处叠加）**：
  1. `Src/main.ts` **每次启动无条件** `initArbitratorPool({coreCount:1, auxiliaryCount:2})`，
     而 `addArbitrator` 会立刻 `ensureDistinctAgentsForRole('arbitrator', …)` → 启动即产生 3 个
     真实仲裁 Agent（用户从未使用仲裁）；每重启一次再累积一批。
  2. `ipcBridge.getOrCreateEntryAgent` 只在**进程内**去重 → 每次启动都新建一个 `prime_director`。
- **修复**：池位改为**懒绑定**（`initArbitratorPool` 只建内存槽；`ensurePoolAgents()` 在
  `assignArbitrators` / `resizeAuxiliaryPool` 扩容时绑定真实 Agent；`provisionAgents: true` 保留旧行为）；
  入口 Agent 改为**优先复用未销毁且同模型**的现役 Director（模型不同才新建，避免请求打到旧模型）。
- **实测**：修复后重启，`/api/agents` **未新增任何 agent**（历史行仍在，其中空闲的已由 G-21 回收机制清掉一个）。
- **测试**：`Tests/Governance/arbitratorPoolBridge.spec.ts` 更新为"初始化不建 Agent / 分配时才绑定 /
  `provisionAgents` 保留旧行为 / 扩容驱动绑定"，回收用例显式 `provisionAgents: true`（它们测的是 G-21 回收）。

### 修复 2：AgentView 实装（`Client/src/components/Layout/MainContainer/AgentView.tsx`）

- 此前是占位视图（"待集成 AIEventBus + Subscribe 事件驱动渲染"），点 Agent 只看到"开发区域"。
- 现接入真实数据：`GET /api/sessions/:sessionId/ai-events`（历史）+ `eventStore`（实时，经 `backend-event` 推送），
  合并去重后按 Agent 归属过滤（浅层 + 一层嵌套匹配 `agentId`/`workerAgentId`/`fromAgentId` 等键）、
  按时间排序渲染时间线；含角色/状态/模型/会话信息与类型计数，以及"无归属事件"的说明空态。

### 验证

- `npx vitest run`：**133 文件 / 1630 用例全通过**；`npm run lint` 0 error；`tsc`（后端/客户端）0 错误。
- 开发态重启后 `/api/agents` 无新增；AgentView 经 Vite HMR 即时生效。

## [2026-10-07] 设置页只读回归 · 模型无法添加 · 事件广播整条失效

> 用户实测（开发版）：①「功能 → 设置」只能看不能改，**连模型都添加不了**；
> ② 开发态启动日志出现 `UnhandledPromiseRejection: ... reading 'getAllWindows'`。

### 修复 1：设置页仍是旧的只读视图（`Client/src/components/Layout/MainContainer/FeatureView.tsx`）

- **根因**：可编辑的设置面板 `views/SystemConfig.tsx`（内含模型供应商管理 `ModelProviderPanel`）
  只挂在路由 `/system-config`；而左侧「功能 → 设置」卡走的 `FeatureView` 里，
  `id === 'settings'` 分支**依然是把 `configStore.loaded` 直接列成只读键值对的占位视图**。
  `SystemConfig.tsx` 文件头注释写明"替换原 JSON 片段只读视图"，但这处接线从未切换 ——
  于是用户从功能卡进来**改不了配置、也找不到添加模型的入口**（两个症状同一根因）。
- **修复**：`settings` 分支改为渲染 `<SystemConfig />`（去掉只读占位实现与不再使用的 configStore 订阅）。
- 同时删除 `FeatureView` 里已无用的 `useConfigStore` 依赖（hydrate 由 SystemConfig 自理）。

### 修复 2：后端 → 渲染进程的事件广播整条失效（`Src/Interface/IpcBridge/ipcBridge.ts`）

- **现象**：开发态启动日志
  `TypeError: Cannot read properties of undefined (reading 'getAllWindows')`（UnhandledPromiseRejection）。
- **根因**：`setIpcMainProvider` 只注入 `ipcMain`，后端据此拼出一个**残缺的假 electron 模块**，
  `BrowserWindow` 恒为 `undefined`；事件订阅回调里 `BrowserWindow.getAllWindows()` 每次必抛 →
  **`backend-event` 推送全部丢失**（界面拿不到实时事件），且异常向上变成未处理拒绝。
- **修复**：改为注入**能力函数** `broadcastToWindows`（主进程实现 `webContents.send` 广播），
  广播内部吞掉所有异常、失败只记一次日志；`setWindowBroadcaster(null)` 可清除（测试用）。
- **测试**：新增 `Tests/Infra/ipcBroadcast.spec.ts`（4 例）：注入实现优先调用、无实现不抛、
  实现抛异常不外溢、可清除。

### 修复 3：`console-message` 弃用警告（`electron/main.ts`）

- Electron 44 改用 `Event<WebContentsConsoleMessageEventParams>`（参数挂在 event 对象上）；
  早期实现按旧签名声明 5 个形参，启动即打印 `'console-message' arguments are deprecated`。
  现统一读 event 对象，并对参数式旧版本保留兜底。

### 验证

- 开发态重启后日志干净：无 `getAllWindows` 拒绝、无弃用警告（仅剩 dev 固有 CSP 提示）。
- 「功能 → 设置」经 Vite HMR 立即生效为可编辑面板（含模型供应商管理）。

## [2026-10-07] 打包态白屏根因修复 · 渲染兜底与诊断 · API Key 处理与错误归因 · 对话探测模型选择

> 背景：用户在**安装版**上"跳过初始化引导后主界面全黑"、"测试连接报 401 但看不出原因"。
> 两件都在打包态才暴露（开发态与引导向导弹层都掩盖了问题）。

### 修复 1：跳过引导后主界面全黑（`Client/src/components/Layout/AppLayout.tsx`）

- **根因**：打包态由 Electron 以 `file:///…/dist/renderer/index.html` 加载，初始 pathname 是
  `/…/index.html`（不是 `/`）；`AppLayout` 内层 `<Routes>` 只有 `/`、`/chat`、`/workspace` 等，
  **没有通配兜底** → 一个路由都匹配不上 → 渲染 `null`。外层 `App` 的 `/*` 仍匹配，所以
  **标题栏在、下面是一片黑的空卡片**。开发态 pathname 是 `/`（重定向到 `/chat`）、引导向导是
  `position: fixed` 的全屏浮层（不经过内层路由），因此两处都看不出这个 bug。
- **修复**：内层补 `<Route path="*" element={<WorkspaceLayout />} />` 兜底。
- **验证**（同一 DOM 探针，前后对比）：

  | | root 子节点 | 页面可见文字 | 渲染错误 |
  |---|---|---|---|
  | 修复前 | 2（标题栏 + 空 AppLayout） | 仅 `CIVITAS 智体城邦 · AI` | 无 |
  | 修复后 | 2 | `…+ 新任务｜任务｜暂无任务…｜功能｜审批｜Loop｜Harness｜记忆｜数据中台｜插件｜账号｜人工审批…` | 无 |

### 修复 2：前端渲染异常只会留一个黑窗口（新增 `Client/src/components/ErrorBoundary.tsx`）

- `App` 现在整体包在错误边界里：渲染异常时展示**错误信息 + 组件栈 + JS 栈**，并提供
  "重新加载界面 / 复制诊断信息"两个动作（不再白屏无提示）。
- 顺带修 `App.tsx`：`init()` 用 `.catch().finally()` 收口，避免初始化异常把应用永远卡在"正在初始化"。
- 入口抽层 `Client/src/AppRoot.tsx`（`BrowserRouter` + `App`），供测试渲染与生产一致的入口组合。

### 修复 3：对话探测盲用 `models[0]`（`Src/Infra/Llm/providerProbe.ts`）

- **根因**：`/models` 会返回上百个模型，其中混着 `text-embedding-*`、`wanx-*`、TTS/ASR 等**非对话模型**。
  早期实现直接拿 `models[0]` 去 `POST /chat/completions` —— 首位若是 embedding，
  **Key 完全正确也会失败**，用户被误导成"Key 有问题"。
- **修复**：
  - 新增 `pickChatCandidates()`：排除非对话模型（embedding/rerank/tts/asr/audio/image/wanx/ocr/…），
    优先常见对话前缀（qwen/gpt/claude/deepseek/glm/ernie/…），最多取 5 个候选；
  - 对话探测**逐个尝试候选**：400/404 类失败自动换下一个；**401/403 立即停止**（换模型无意义）；
  - 结果新增 `chatModelUsed` / `chatCandidates` / `chatAttempts`，界面显示实际使用的模型、
    重试次数，以及"已依次尝试 N 个候选模型"；
  - 引导页新增**手选探测模型**下拉（留空 = 自动挑），默认勾选对话成功的那个模型。
- **测试**：新增 6 例（排除非对话模型、跳过 embedding、失败自动重试、401 不重试、显式指定优先、
  全部失败如实报告），`Tests/Services/onboarding.spec.ts` 共 **31 例**通过。

### 修复 4：API Key 处理与错误归因（`Src/Infra/Llm/providerProbe.ts`）
实测（真实 DashScope 端点，2026-10-07）：`GET /models` 存在且假 Key 返回`401 {"code":"invalid_api_key"}`；无 Key 返回"You didn't provide an API key"。

- **不再把 401 说成"该端点不提供"**：新增 `listStatus` / `listAttempted` / `chatAttempted` /
  `listNotProvided`；只有 404/405 才标记"端点不提供"，401/403 明确显示"鉴权失败（HTTP 401）"。
- **展示供应商原话**：解析响应体里的 `error.message` / `code`（如 `invalid_api_key`），
  与可执行建议一起给出；引导页新增"供应商原话"区块（可选中复制）。
- **不再谎称"对话未通过"**：鉴权失败会提前返回，此时显示"对话：未探测（先解决上面的问题）"。
- **Key 规范化 `normalizeApiKey()`**：清理零宽字符（`\u200B-\u200D`、`\uFEFF` —— **不在** `trim()`
  范围内）、不间断/全角空格、换行制表、外层引号、`Bearer ` 前缀；清理内容在引导页如实展示。
- **非 ASCII 字符给可执行提示**：Key 里仍有 >0xFF 字符时（HTTP 头不允许）直接返回
  `invalid_input` + "请重新复制 Key"，而不是让 `fetch` 抛 ByteString 异常后被误报成"网络不可达"。

### 诊断能力（打包态可排障）

- `electron/main.ts`：转发渲染进程 `console` 的错误/警告到主进程日志（`[Renderer:error]`），
  并记录 `did-fail-load` / `render-process-gone`；兼容两代 `console-message` 签名。
- `electron/main.ts`：`CIVITAS_UI_DEBUG=1` 时 dump 页面 DOM 结构（root 子节点数、可视尺寸、
  可见文字、错误列表）——"看起来全黑但没报错"这类问题只能靠它定位。
- `Scripts/probePackagedBackend.cjs`：新增**打包态 UI 白屏守卫**——自动把引导状态置为"已跳过"
  启动打包产物，断言"root 子节点 ≥2、可见文字 ≥40 字、含主界面标志性文案、未命中错误边界"，
  不满足即失败退出。白屏回归从此由 `npm run package:probe` 兜住。

### 已知未修（诚实记录）

- **代理支持缺失**：探测走 Node 全局 `fetch`（undici），**不读取系统代理**；若用户环境必须走代理
  （例如访问 OpenAI/Claude），会表现为 `network` 类失败。当前提示只是建议"检查代理设置"，
  实际不支持 `HTTP_PROXY`/`HTTPS_PROXY`。后续可接 `undici.ProxyAgent` 或改用 Electron `net`。

### 验证

- `npx vitest run` 全量通过（含本轮新增的 Key 处理与模型选择用例）；`npm run lint` 0 error；`tsc`（后端/electron/client）0 错误。
- `npm run package:signed -- --all` 重新打包并签名（4 产物 `Valid`，发布者 `Ma Hongyu (Self-Signed)`）。
- `npm run package:probe`：26 端点全 200、写路径 201、三库齐全、**UI 结构正常（非白屏）**。

---

## [2026-10-06] 打包态后端缺陷修复：日志探针垃圾文件 · shell 默认 cwd · 便携标记误判

> 方法：先写了一个"打包态后端探针"（`npm run package:probe`）——以**安装模式 + 干净数据根**
> 启动打包产物，把 26 个真实 API 全打一遍、走一次写路径（建会话）、检查数据根落盘与日志 ERROR，
> 用运行证据定位问题，而不是靠读代码猜。探针结论：**打包态后端整体健康**（端点全 200、
> `POST /api/sessions` → 201、三个 SQLite 库正常创建，原生模块在 asar 下加载正常）；
> 下面三个问题是被它/审计抓出来的。

### 修复

1. **日志可写探针留下垃圾文件**（`Src/Infra/Logging/logWriter.ts`）
   - 现象：每次启动都在用户数据目录留下 `<DATA_ROOT>\Logs\.write_test.tmp`（探针写完只 `rename`，从未删除）。
   - 修复：改为真删除（`rmSync(force)`），删除失败才退回 `rename`；并**自动清理历史版本遗留的**
     `.write_test.tmp`，升级后自动收敛。
   - 验证：探针跑完后 `Logs/` 只剩 `business.log` 与 `_Meta/`；新增回归测试 3 例。

2. **`shell.exec` 默认工作目录回落到 `process.cwd()`**（`Src/Tools/Builtin/Execute/shellRunner.ts`）
   - 现象：打包态进程 cwd 由启动方式决定（快捷方式"起始位置"、计划任务等，常见 `C:\Windows\System32`
     或用户主目录）。缺少 `context.workDir` 时命令会在与任务无关、可能权限敏感的位置执行，
     且越界检查（`findEscapingPathInCommand`）因 workDir 为空而**完全失效**。
   - 修复：无 workDir 且未显式指定 cwd 时，一律收敛到 `getSessionWorkspaceDir(sessionId)`（拿不到会话就退到
     `getWorkspaceRoot()`），并确保目录存在；准备失败直接返回 `PATH_DENIED`。**不再回落到 `process.cwd()`**。
   - 验证：新增回归测试 2 例（断言命令实际 cwd 为会话工作目录、不等于进程 cwd；目录不可建时返回拒绝）。

3. **便携标记检测在打包态会看 cwd**（`Src/Infra/Fs/pathResolver.ts`）
   - 现象：`hasPortableMarker()` 除 exe 同级外还检查 `process.cwd()/.portable`；若快捷方式"起始位置"
     恰有该文件，安装版会被判成便携版 → **数据根/工作空间整体错位**。
   - 修复：新增 `isPackagedRuntime()`（`process.resourcesPath` 存在且非 `defaultApp`），打包态只看 exe 同级；
     cwd 兜底保留给开发态直跑。
   - 验证：新增回归测试 2 例（打包态忽略 cwd 标记、开发态仍生效）。

### 加固（未触发，但值得有）

- **`electron/main.ts` userData 探针 + 回落链**：按"显式 `CIVITAS_USER_DATA_DIR` → `%APPDATA%\CivitasAI`
  → `%LOCALAPPDATA%\CivitasAI` → 系统临时目录"顺序，用**建目录 + 建子目录 + 写文件 + 清理**四步探针
  选第一个真正可用的（第一版只测"写文件"不够——实测就是栽在这里：探针通过、缓存目录照样建不出来），
  并把选择与原因写入 `CIVITAS_USER_DATA_DIR` / `CIVITAS_USER_DATA_REASON`（排障用）。
  本机实测该探针正确选中产品口径 `%APPDATA%\CivitasAI`。

### 排查后判定为环境现象（非代码缺陷，未改）

- 打包进程日志里 Chromium 的 `Failed to create directory: …\Code Cache\js`、
  `Failed to create network context data directory …\Network: 拒绝访问。(0x5)`：
  同一进程用探针**能**在 `%APPDATA%\CivitasAI` 下建目录、写文件、清理，说明不是权限/签名问题；
  是受限会话下 Chromium 网络/缓存子进程拿不到该目录（缓存自动仅内存化，功能可用）。
  **已排除**：与代码签名无关（本轮产物已签名仍复现），与 `asar`/数据根无关。
  建议在普通桌面会话复核一次。

### 工具与文档

- 新增 `Scripts/probePackagedBackend.cjs` + `npm run package:probe`：打包态后端冒烟探针
  （端点全量探测 + 写路径 + 落盘检查 + 日志 ERROR 汇总），后续每次改打包都可一键回归。
- 新增 `Tests/Infra/packagedRuntime.spec.ts`（**7 例**）覆盖上述三个修复。

### 验证

- `npx vitest run`：**132 文件 / 1613 用例全通过**；`npm run lint` 0 error；
  `tsc`（后端 / electron / client）0 错误。
- `npm run package:signed -- --all`：重新打包并签名，4 个产物 `Valid`（发布者 `Ma Hongyu (Self-Signed)`）。

---

## [2026-10-06] 安装交付改造（三）：本地自签代码签名（自用，零成本、不交出发布权）

> 目标：不购买 CA 证书、也不把发布者身份登记到第三方（如 SignPath Foundation），
> 让**本机/已部署根证书的内部设备**双击安装不再出现"未知发布者"。

### 新增

- **`Scripts/setupSelfSignedCert.ps1`**：生成本机自签代码签名证书（`CurrentUser\My`，RSA-3072、
  CodeSigning EKU、默认 5 年），导出 `.pfx`（含私钥）+ `.cer`（公钥）+ `signing.env.json`
  （供打包脚本读取，含随机 PFX 密码）；支持 `-Subject` / `-PfxPassword` / `-Years` / `-Force` /
  `-InstallTrustedRoot` / `-TrustScope CurrentUser|LocalMachine`。
- **`Scripts/packageSigned.cjs`**：自签打包包装——读 `signing.env.json` → 注入
  `CSC_LINK`/`CSC_KEY_PASSWORD`（Windows 同时 `WIN_CSC_*`）→ 调既有一键打包 → 再跑签名校验门禁。
- **`Scripts/verifySign.ps1`**：签名校验与发布门禁——逐个检查安装包/便携版/应用本体/`elevate.exe`，
  打印状态、签名者、证书到期、**是否带时间戳**、链校验说明；`-Targets nsis|portable|all|dir` 只校验本次目标
  （避免把上次遗留的旧产物算进来）；`-Require`（未签名即失败）/`-RequireTrusted`（链不可信也失败）。
- **npm scripts**：`sign:setup` / `sign:verify` / `package:signed`。
- **`.gitignore`**：新增 `*.pfx` / `*.p12` / `*.snk` / `signing.env.json` / `*selfsigned.cer`
  （证书与私钥绝不入库）。

### 变更

- **`ELECTRON.md`**：新增"代码签名（本地自签，自用）"章节（三步流程、原理、实测对比表、边界与撤销命令），
  并在 FAQ 增补"SmartScreen 提示三条路"（自签自用 / SignPath 免费但发布权在对方 / OV 证书）。
- **签名配置不进 `package.json`**：仓库内没有任何证书路径或密码，未配置证书时 `npm run package` 行为不变。

### 实机验证（本机，2026-10-06）

- 生成证书：主体 `CN=Ma Hongyu (Self-Signed)`，指纹 `7A8BEB8ED9F01B33402B53EE2E5871B7206A1338`，有效至 2031-10-06。
  （首发先用 `CN=Civitas AI (Self-Signed)` 打通链路，随后按需求把发布者改为 `Ma Hongyu`：
  删旧根证书/旧签名证书 → 用 `-Force` 重生成 → 重装受信任根 → 重新打包，最终产物发布者即为 `Ma Hongyu (Self-Signed)`。）
- `npm run package:signed -- --all`：**一次构建签完 4 个产物**——`CivitasAI-Setup-0.1.0.exe`、
  `CivitasAI-Portable.exe`、`win-unpacked\CivitasAI.exe`、`win-unpacked\resources\elevate.exe`
  （含卸载器链路由 electron-builder 在打包期自动完成，日志可见 `*.__uninstaller.exe` 与 Setup 的签名步骤）。
- 签名校验：装根证书前 `UnknownError`（"已处理证书链，但在不受信任的根中终止"）→
  用 `certutil -f -user -addstore Root` 把 `.cer` 装进**当前用户受信任根**后，4/4 变为 **`Valid`**，
  且**均带时间戳**（`npm run sign:verify -- -Require -RequireTrusted` 通过）。
- 踩到并修掉的两个脚本问题：
  1. **PowerShell 变量名大小写不敏感**：校验脚本局部集合 `$targets` 覆盖了参数 `$Targets`，导致目标过滤失效
     （已改名 `$checkFiles` 并加注释）；
  2. **往受信任根写证书会弹模态"安全警告"**：`Import-Certificate` / `X509Store.Add` 在非交互会话里
     **挂起等人工确认**或报"此操作中不允许使用 UI"；`certutil -f -user -addstore Root` 是静默路径，
     已作为脚本首选实现。
- 另修：`verifySign` 的 PowerShell 回退逻辑曾把"校验未通过（非零退出）"误判为"没找到 pwsh"，
  于是用 Windows PowerShell 5.1 重跑 UTF-8 无 BOM 脚本触发中文乱码；现改为**仅 ENOENT 才回退**，
  并给两个 `.ps1` 写入 UTF-8 BOM。

### 未做（有意保留）

- **对外分发仍需正式证书**：自签只对装了根证书的机器有效，别人下载后仍是"未知发布者"。
- **自动更新（electron-updater）** 未接线；若启用，`publisherName` 需与实际证书主体一致
  （自签场景下即 `Ma Hongyu (Self-Signed)`）。

---

## [2026-10-06] 安装交付改造（二）：首次运行初始化引导（onboarding）

> 承接同日"安装交付改造（一）"：安装包已能装、能跑，这一批补上**首启引导**——
> 用户首次打开不再面对空界面，而是走完「目录透明化 → 个性化 → 供应商 → API_KEY 与连通性校验 →
> 默认模型 → 使用引导 → 完成」，全程**无需重启**。

### 新增

- **`Src/Services/Onboarding/onboardingState.ts`**：引导状态机与持久化——落 `<DATA_ROOT>/.state/onboarding.json`
  （原子写）；`completed` / `skipped` / `version` 三态；文件缺失或损坏一律视为"未初始化"（宁可重引导，不可静默跳过）；
  提供 `needsOnboarding()` / `completeOnboarding()` / `skipOnboarding()` / `resetOnboarding()`。
- **`Src/Infra/Config/userConfigWriter.ts`**：用户配置层（`<DATA_ROOT>/Configs/local.json`）**白名单写入**——
  允许 `server.httpPort|host|corsOrigins`、`system.logLevel`、`ui.*`、`routing.*`、`reasoningSandwich.*`、
  `workspace.*`、`onboarding.*`；其余键**拒绝写入并如实返回 `rejected`**；端口/日志级别做取值校验；
  与既有 `local.json` 深度合并、原子写；文件损坏时拒绝覆盖并报 FATAL。
- **`Src/Infra/Llm/providerProbe.ts`**：供应商**连通性校验**——`GET /models`（校验鉴权与端点、拉模型清单）
  + 最小 `POST /chat/completions`（`max_tokens:1`，真验证"这个 Key 能对话"，并测首字节时延）；
  失败按 `auth / http / network / timeout / invalid_input` 归因并给出中文处置建议；`/models` 缺失（404）不算致命。
- **`Src/Interface/IpcBridge/onboardingIpc.ts`**：8 条 IPC 通道——`ipc-get-app-paths`（目录透明化）、
  `ipc-get-onboarding`（状态 + 已有供应商/模型/路由 + 用户配置）、`ipc-test-provider`、`ipc-write-user-config`、
  `ipc-complete-onboarding`、`ipc-skip-onboarding`、`ipc-reset-onboarding`、`ipc-patch-onboarding`；
  由 `stopIpcBridge` 统一摘除。供应商注册仍复用既有 `ipc-add-provider`（加密落盘），不重复实现。
- **`Client/src/views/Onboarding/OnboardingWizard.tsx` + `Onboarding.module.css`**：全屏七步向导
  （左侧步骤进度 + 右侧内容 + 底部上一步/下一步/跳过）：目录卡片（可一键打开数据/日志目录）、
  日志级别与工作空间根选择、9 家预置供应商 + 自定义、API Key 输入与**测试连接**（结果面板含模型清单勾选与错误归因）、
  角色模型与**仲裁模型 ≥3 硬约束**、使用引导卡片（工作模式/工作目录/审批安全门/Token 预算/数据位置/换模型）、
  完成前汇总。
- **`Client/src/stores/onboardingStore.ts`**：引导状态机（步骤、草稿、探测结果、路由推导、`canProceed()` 校验）。
- **`Client/src/services/ipcApi.ts`**：8 个引导 API 包装 + `ipcOpenPath()`；非 Electron 环境一律返回"不可用"。
- **`electron/preload.ts` / `electron/main.ts`**：暴露 `onboarding.*` 与 `openPath`；新增 `open-path` handler（仅允许打开已存在路径）。

### 变更

- **`Client/src/App.tsx` 首启门控**：启动后查询引导状态，**仅当主进程明确"需要引导"**才进入全屏向导；
  IPC 不可用（浏览器/测试）或探测失败一律放行——避免把应用锁死在向导里；向导内可随时跳过。
- **`Src/main.ts`**：读取用户配置 `workspace.root` 并注入 `CIVITAS_WORKSPACE_ROOT` + 清路径缓存 →
  引导里选的工作空间目录**本次启动即生效**（无需重启）。
- **`Src/Infra/Fs/pathResolver.ts`**：新增 `getStateDir()`（`<DATA_ROOT>/.state`）并纳入目录初始化与可写性诊断。

### 测试

- 新增 `Tests/Services/onboarding.spec.ts`（**20 例**）：引导状态机（未初始化/完成/跳过/重置/损坏回退/幂等 patch）、
  用户配置白名单（越权拒绝、取值校验、合并、损坏保护）、连通性探测（成功/401/404+对话成功/列表可读对话失败/缺参/网络异常）。
- 新增 `Tests/Client/onboarding-wizard.spec.tsx`（**9 例**）：门控（无 Electron 不拦截、探测失败放行）、
  目录透明化渲染、供应商选择 → 测试连接 → 勾选模型、失败提示不可继续、仲裁模型 ≥3 硬约束、
  完成时写出的 `configPatch`（含路由/日志级别/工作空间）、跳过通道。
- 全量：`npx vitest run` **131 文件 / 1606 用例全通过**；`npm run lint` **0 error**；`npm run build:client` 通过。



---

## [2026-10-06] 安装交付改造（一）：目录契约 · 一键打包 · NSIS 安装包

> 目标：让非开发者"下载安装包 → 选安装目录 → 一键安装 → 打开就能用"。
> 本批解决**打不开/数据乱放**的根因（打包曾被当作便携、所有落盘路径走 `process.cwd()`），
> 并交付 NSIS 安装包与一键打包链；首次运行引导向导为**下一批**（见 `Docs/Dev/安装包与首次运行引导-实施方案.md`）。

### 新增

- **目录与环境契约**（`Src/Infra/Fs/pathResolver.ts` 重写）：三个根变量
  - `CIVITAS_APP_ROOT`（程序/只读资源根：`Configs`/`Prompts`/`Skills`/`assets`）
  - `CIVITAS_DATA_ROOT`（全局数据根：数据库/日志/密钥/用户配置；安装态 = `%APPDATA%\CivitasAI`）
  - `CIVITAS_WORKSPACE_ROOT`（工作空间根：会话工作目录/沙箱/`.civitas` 备份；安装态 = `<安装目录>\Workspace`，只读则回落数据根）
  - 细粒度 `CIVITAS_LOG_DIR` / `CIVITAS_CONFIG_DIR` / `CIVITAS_CONFIG_DIR_BUILTIN` / `CIVITAS_BACKUP_DIR`；旧名 `CIVITAS_DATA_DIR` 保留兼容。
  - 新 API：`getAppRoot` / `getDataRoot` / `getWorkspaceRoot` / `getSecretsDir` / `getBackupDir` / `getSessionWorkspaceDir` / `getSessionBackupDir` / `getBundledConfigDir` / `resolveDataPath` / `ensureDirSafe` / `probeWrite` / `describePaths`（目录+可写性诊断快照）。
- **`Scripts/package.cjs` + `Scripts/verifyPackage.cjs` + npm scripts**：`npm run package`（一键：预检 → 构建后端 → 构建前端 → 产物校验 → electron-builder → 产物体积/SHA256 汇总），另含 `package:nsis` / `package:portable` / `package:dir` / `package:check`。
- **NSIS 安装包配置**：`win.target = [nsis, portable]`；`nsis.oneClick=false`、`allowToChangeInstallationDirectory=true`（自选安装目录）、`perMachine=false`（默认 `%LOCALAPPDATA%\Programs\CivitasAI`，**无需管理员**）、桌面/开始菜单快捷方式、`deleteAppDataOnUninstall=false`（卸载不删数据）。
- **图标资产**：`assets/icon.ico`（多尺寸）+ `assets/icon.png`（512）与可重跑的生成脚本 `Scripts/genIcons.py`。
- **文档**：`Docs/Dev/安装包与首次运行引导-实施方案.md`（方案 + 验收清单 + 剩余待办）；`.env.example` 补齐 `CIVITAS_*` 目录契约与多供应商 Key 示例。

### 修复

- **FE-P1 打包态数据写入只读安装目录导致启动失败**：`electron/main.ts` 不再把 `app.isPackaged` 当便携；只在显式便携信号（`--portable` / exe 同级 `.portable` / `CIVITAS_PORTABLE`）下重定向到程序目录，否则注入 `%APPDATA%\CivitasAI`（数据）+ `<安装目录>\Workspace`（工作空间）；便携版按 `PORTABLE_EXECUTABLE_DIR` 定基，避免单文件包解压到临时目录后数据丢失。
- **FE-P2 数据/日志/密钥/工作区绕过环境变量**：`secretsStore`（原 `process.cwd()/Data/.secrets`）、`configApi`（原 `cwd/Configs`）、`skillsApi` 与 `ipcBridge`（原 `cwd/Skills`）、`Src/main.ts` 的 DB 路径/日志目录/工作区/沙箱/配置监听、`workspaceGuard` 全部改由目录契约解析；DB 相对路径统一以数据根为基准（`resolveDataPath`）。
- **FE-P3 `local.json` 覆盖被功能文件吃掉**：`configLoader` 改为"内置 `default` → 内置 `{env}` → 内置功能文件 → 内置 `local` → 用户 `{env}` → 用户功能文件 → 用户 `local`"，`local.json` 成为最高优先级——首次运行引导写一个文件即可选中供应商/模型/端口。
  - 保持口径：`env:` 引用**只在 `default`+`{env}` 层解析**，`api_key_ref: "env:XXX"` 必须保持引用形态交由 Provider 层请求期解析（新增回归测试钉住）。
- **FE-P4 启动失败无提示**：数据根不可写时抛出可操作错误（含 `CIVITAS_DATA_ROOT` 指引）；Electron 用 `dialog.showErrorBox` 展示程序根/数据根/工作空间与常见处理方式，不再静默退出。
- **FE-P5 图标路径少一级**：`resolveIcon()` 修正为 `<APP_ROOT>/assets/icon.png`（原指向 `dist/assets/`，图标恒缺失）。
- **FE-P6 静态托管目录**：`startHttpServer` 的 `staticDir` 由程序根推导（`Client/dist` → `dist/renderer`），不再依赖 cwd。
- **FE-P7 打包后渲染进程 `/api/*` 必失败**（`file://` 下相对 fetch）：`Client/src/services/api.ts` 在 Electron 下把相对 `/api/*` 经主进程 `serverFetch` 转发（统一 `ApiResponseLike` 适配，429/超时语义不变），浏览器与测试环境行为不变；顺带兼容"只 mock 了 `json()` 的测试替身"。
- **FE-P8 退出时停的是另一份模块副本**：Electron 侧改为调用后端导出的 `stopServer()`，与 `startServer()` 同实例，HTTP/IPC 真正优雅关闭。
- **FE-P9 打包产物路径漂移**（本轮改造中实测踩到）：`Scripts/build.cjs` 单入口时 esbuild 会把 outbase 算成 `Src/`，后端产物落到 `dist/main/main.js`；加 `outbase: '.'` 钉死为 `dist/main/Src/main.js`。
- **FE-P10 主进程/后端 electron 互操作不确定**：主进程与 preload 统一产出 **CJS**（`dist/main/electron/main.cjs`），`package.json.main` 同步；后端仍为 ESM，由主进程动态 import 并**注入 `ipcMain` / `safeStorage`**（`Src/main.ts` 新增 `setElectronRuntime()`），使 IPC 注册与 API Key 加密存储不再依赖 ESM↔CJS interop 的版本行为。
- **FE-P11 用户数据目录名与产品名不一致**：`app.isPackaged` 时显式 `app.setName('CivitasAI')` + `app.setPath('userData', %APPDATA%\CivitasAI)`（原为 package.json 的 `civitas-ai`），与文档口径一致；同时不再注入 `CIVITAS_LOG_DIR`/`CIVITAS_CONFIG_DIR`，日志与用户配置一律从数据根派生（避免"改了数据根、日志仍写别处"）。

### 测试

- 新增 `Tests/Infra/appPaths.spec.ts`（**24 例**）：三根变量与旧变量兼容、开发/便携/安装三态、安装目录只读时工作空间回落 + 告警、`resolveDataPath` 语义、`ensureDirSafe`/`probeWrite` 不抛错、配置分层（`local.json` 覆盖功能文件 / `env:` 引用不被展开 / 用户层同名文件覆盖内置）。
- 全量：`npx vitest run` **129 文件 / 1577 用例全通过**；`npx tsc --noEmit` 与 `tsc -p tsconfig.electron.json` **0 错误**；`npm run lint` **0 error**（既有 warning）。
- 安装态实机模拟（`CIVITAS_INSTALLED=1` + 临时根，真实启动后端）：数据落 `<数据根>\{db,Logs,.secrets,Configs}`、工作空间落 `<安装目录>\Workspace`、`/api/configs` 200，且 `local.json` 改的端口真实生效。
- **打包应用实机冒烟**（`release/win-unpacked/CivitasAI.exe`，安装态 + 临时根）：`[Electron] 模式: 安装` → 三根打印正确 → 3 个 DB 落数据根 → `<安装目录>\Workspace\.civitas` 建好 → 读用户 `local.json` 后在自定义端口上 `/api/configs` **HTTP 200（4 秒内）**。
  - 自动化注意：验证脚本须 `delete env.ELECTRON_RUN_AS_NODE`（该变量会让 electron 退化为纯 Node，表现为"打包应用一启动就退出"的假故障），受限/无桌面会话下需加 `--no-sandbox`（否则 Chromium 沙箱初始化失败、进程以 `0x80000003` 静默退出）。二者均已写入 `Docs/Dev/安装包与首次运行引导-实施方案.md`。

### 实机验证（安装 → 运行 → 卸载）

用最终安装包 `release/CivitasAI-Setup-0.1.0.exe`（SHA256 `ac46b72d…`）在真机跑了一遍完整链路：

| 步骤 | 结果 |
|------|------|
| 静默安装到自选目录（`/S /D=…`） | ✅ 退出码 0，装入 186 文件 / 409.2MB（含主程序、卸载器、`resources/app/{Configs,Prompts,Skills}`、`app.asar(.unpacked)`） |
| 启动已安装应用（干净环境） | ✅ `模式: 安装`；程序根/数据根/工作空间打印正确；主进程 + GPU + 渲染进程正常 |
| 后端就绪与落盘 | ✅ 读用户 `Configs/local.json` 后在自定义端口 **HTTP 200（3 秒内）**；`.secrets`/`Configs`/`db`(3 库)/`Logs`/`Workspace\.civitas` 全部落位 |
| 静默卸载 | ⚠️ 退出码 0 但**未删文件**；且静默安装不建快捷方式、不写卸载注册表项（electron-builder 26 辅助式安装器的限制）→ 交互式安装/卸载仍需人工验证 |
| 卸载后数据 | ✅ `deleteAppDataOnUninstall:false` 生效，用户数据保留 |
| 本机环境限制 | ⚠️ 未签名打包 exe 在本会话无法写入 `C:`（`EPERM`），而 PowerShell/Node/官方 Electron 二进制对同一路径可写、且未启用 CFA/ASR → 判定为环境侧对未签名二进制的写入限制；**默认 `%APPDATA%` 数据根需在普通桌面会话或签名后复核**（数据根换到工程盘即完全正常） |



### 交付物

- `release/CivitasAI-Setup-<version>.exe`（NSIS 安装程序，105.1MB、SHA256 `ac46b72d2455123e98ce34486a69c9fa1b1eb1afa306b3eb52b40122eaaccfbf`：自选安装目录、免管理员、桌面/开始菜单快捷方式）
- `release/CivitasAI-Portable.exe`（便携单文件，104.8MB、SHA256 `2a0c0b0821552c8593300b04a2d4fbb8b260836567b1437dc02fd68a48c7542e`）
- 一键命令：`npm run package`（另有 `package:nsis|portable|dir|check`）；首次打包自 GitHub 不可达时脚本自动注入 npmmirror 镜像
- 未做（下一批）：代码签名（SmartScreen 提示）、自动更新、**首次运行引导向导**（方案见 `Docs/Dev/安装包与首次运行引导-实施方案.md` §4）


## [2026-10-05] 工具展示动画：语义化执行动效 + 人读描述（Harness.ToolGroup）

> 工具在前端的"使用中"观感改造：每行 `+工具+描述`；执行期按语义播放动效，出结果即回落静态；
> 一组内只要还在探索（读/查/列/搜）就持续显示小眼睛，直到探索完。

### 新增

- `Client/src/ai-components/harness/toolVisuals.ts`：工具视觉语义**纯函数层**（无 React 依赖，便于单测）——
  - `classifyToolVisual`：五类语义 `gaze`（小眼睛）/ `flow`（光流）/ `erase`（方块阵列沉浮）/ `pulse`（终端扫描）/ `gear`（轨道环），按 `.`/`_`/`-`/`/` 分词 + 驼峰切分匹配，显式覆盖 `tool.execute`→gear、`tool.search`→gaze；
  - `inferSubgroup`：扩展点号/驼峰命名（`file.read`→read、`file.grep`→read、`file.write`→write、`shell.exec`/`code.eval`→exec），旧前缀口径与**大小写敏感**语义保持不变（`Read_file`→system）；
  - `isExploratoryTool`、`describeToolCall`（动作 · 对象 · 量词，如「写入文件 · Client/src/index.css · 写入 2.0 KB」「执行代码 · 3 行」）、`summarizeToolGroup`（组状态/语义计数/探索态）、`formatCounts`。
- `Client/src/ai-components/harness/ToolGlyph.tsx` + `ToolGlyph.module.css`：五类执行动画 —— 小眼睛（瞳孔左右扫视 + 定时眨眼）、光流（细→宽→细，双光条错相半程，全程无空窗）、方块阵列沉浮（错峰上下 + 明暗）、终端扫描线、轨道环。
  - `data-mode`：`running`（执行中）/ `preparing`（模型仍在生成参数，放慢并降透明）/ `settled`（出结果 → 静态同义图标，停止动画）；
  - 尺寸由 `--glyph-size` 按比例推导，`--glyph-phase` 可错峰；`prefers-reduced-motion` 下停用动画但保留图形，装饰性图形对读屏 `aria-hidden`。
- `Tests/AIComponents/toolVisuals.spec.tsx`：**52 用例**（语义分类 18 / 子分组与探索型 8 / 描述构建 13 / 组汇总与计数 8 / ToolGlyph 态 7 / ToolGroup 集成 8）。

### 变更

- `Client/src/ai-components/harness/ToolGroup.tsx`：工具行改为 `状态图标 + 动画/图标 + 工具名 + 人读描述 + 子分组徽章 + 耗时 + 参数`；组头增加语义动画、运行状态词（准备中… / 执行中… / 探索中… / N 项失败）与语义计数（`查阅 2 · 写入 1`），运行中组边框按语义着色；新增 `data-testid="tool-group"` 与 `data-state` / `data-exploring`，工具行新增 `data-status` / `data-visual`，出结果时播放一次"落定"扫光。
- **探索态**：组内仍存在未完成的探索型（读/查/列/搜）调用时，组头持续显示小眼睛且组状态为 `exploring`；探索一完成即切回运行中工具的语义（或静态图标）——对应"接下来都是探索性内容就一致显示小眼睛直到探索完"。
- `Client/src/ai-components/harness/ToolGroup.tsx` 保留 `inferSubgroup` 等纯函数对外导出（既有 `Tests/AIComponents/subscribeAndToolGroup.spec.ts` 断言口径不变）。

### 测试

- `npx vitest run Tests/AIComponents Tests/Client`：**23 文件 / 288 用例全通过**（含新增 52）。
- `npx tsc --noEmit -p Client/tsconfig.json` **0 错误**；`npm run build:client`（vite 构建 + renderer 入口校验）通过。
- 动效实测：headless Chrome 加载**真实** `ToolGlyph.module.css` 逐相位渲染截图 —— 五类图形/配色与 running→preparing→settled 三态符合预期，光流 0.1s 步进 16 相位无空窗（截图为本地临时产物，未入库）。

## [2026-10-04] 桩实现治理第四批：缓存接线 · 运维实装 · 决策诚实化 · 基础设施 · Skills 消费 · 招募执行（FE-063/064/066/069 ~ 072）

> 第四批 P3 收口（平台运维与基础设施域）+ **同批分层修正**（18 个门禁违规清零）。验证：单测 + 质量门禁 + 真实 LLM 三轮执行（.verify/verify-fe063-fe072.mjs **10/10 PASS**）。

### 新增

- `Src/Tools/Registry/toolServicePorts.ts`：Tools 层服务端口（依赖倒置）——缓存 / Hook / 计划 / 检索 / 招募 / 评审六类端口，组合根 `main.ts` ⑫.6 注入（未注入时增强项静默跳过、工具项如实 `NOT_ENABLED`）。
- `Src/Infra/AccountScope/activeAccount.ts`：属主上下文本体下移（原 `Src/Services/AccountScope/` 保留兼容薄壳，消除 Infra→Services 上行依赖）；库行→运行时实例映射迁回运行时侧（`Core/AgentRuntime/agentRegistry.rowToAgentInstance`，原 Infra 侧删除）。
- `Src/Services/Prompts/skillsAssets.ts`：Skills 资产装载（playbooks/rubrics/strategies/法典文档，fail-soft + 热重载）。
- `Src/Core/AgentRuntime/agentExecutor.ts` + `Src/Interface/RestApi/agentApi.ts` 的 `POST /api/agents/:agentId/execute`（FE-072 执行入口）。
- `.verify/verify-fe063-fe072.mjs`：真实调用验证脚本（R1~R5）。

### 修复

- **FE-064 缓存**：`toolResultCache` 接入派发器（SAFE+YES 二次同参命中跳过执行；副作用工具保守清空读缓存）；`promptCache` 接入 `modelCaller.trackPromptPrefix`（前缀哈希命中登记）。
- **FE-069 运维**：关闭②③④实装（`abortAllActiveStreams` 中断活跃流 / 停事件持久化前等待在途流释放 / `writeTraceIndex` 追踪索引）；环境自检四项（database/providers/tools 关键项 fail-fast，prompts 告警）；提示词 + Skills 热加载（`configWatcher` 真实轮询扫描）；系统资产消费（mainLoop/taskTemplate/manifest → 稳定系统提示注入）。
- **FE-070 决策**：`riskTriggers` 装配（缺省 `signal == "UNRECOVERABLE_TOOL_ERROR" → abort`）；TaskDecomposer 高耦合依赖引用真实 `assignmentId`（消除 `assign-current-N` 假 ID）；SOP 外部化（`sopTemplates` 配置段）；`archived` 假标记诚实化为 false；`code.eval` 边界声明诚实化（vm 非安全边界）。
- **FE-066 基础设施**：`atomicWrite` 接入 `file.write`/`file.edit`；`quotaManager` 接入 `file.write`（QUOTA_EXCEEDED 拒绝不落盘）；`keyStore` 启动预检（⑪.2）；`auditHook` 三哨接入（⑬.1：UserInputReceived 审计 + Pre 审计 + Post 指标）。
- **FE-063 调度决策收口**：LoopScheduler/Pipeline 标注保留（决策痕迹入 `index.ts`）；`eventRouter.ts` 删除（与 eventBus 重复且 0 注册方）。
- **FE-071 Skills**：四类接线——playbook→`agentFactory` 执行级角色提示；rubric→L3 Judge（`getL3Rubric`）；strategies→策略账本候选；法典文档→监管链（`regulationApi` 查询 + `initBehaviorCode`）。
- **FE-072 招募**：`agent.recruit` 返回值如实标注 `dispatch: 'manual'` + 执行入口闭环（executor + REST 驱动；`ready→running` 状态驱动）。
- **分层修正（P4-H）**：`reviewerAgent` 的 `Core/Model` 直连消除（L3 Judge 调用器改组合根注入 `configureReviewer.callModelFn`）；`npx eslint Src/` **0 errors**（zone 红线不放宽）。

### 测试

- 新增：`cacheWiring` / `platformOps` / `decisionFixes` / `infraWiring` / `skillsAndAgentExec` / `recruitment` 等 spec；受端口注入影响的既有 spec（`memoryRetrieval` / `orchestrationPipelines` 等）同步注入。
- 全量：**1343/1343（114 文件）**；两套 `tsc`（root / electron）**0 错误**；`npm run lint` **0 errors**（218 warnings）。

### 实机验证（真实 LLM，10/10 PASS）

- R1 提示词/Skills 资产真实装载（roles=8、playbooks=1、strategies=8、rubric=true）；
- R2 recruit → 三轮真实执行（worker ×2 + assembly_node，exit=success；余额 10000→9994 经济记账）；R2e 状态驱动（ready→running）；
- R3 工具缓存真实命中 + 写后失效（size 1→0）；R4 trace 索引真实落盘（traces=5）；R5 密钥预检 OK。

## [2026-10-04] 桩实现治理第三批：监管执法 · 审计巡检 · 仲裁闭环（FE-060 ~ FE-062）

> 第三批 P2 修复（治理执法域）。验证三级：单测 + 质量门禁 + 12 项 HTTP/真实 LLM 验证（12/12 PASS）。

### 新增

- `Src/Services/Arbitration/arbitrationWiring.ts`：`CONFLICT_DETECTED` → 六步闭环自动仲裁 + 裁决应用
  （new_wins：废弃冲突旧条目 + 仲裁者身份落定新内容；同 key 去重；文件冲突来源不自动仲裁）。
- `Src/Services/Audit/auditScheduler.ts`：审计周期（快照刷新：经济记账+注册表真实聚合 → 滚动窗口检查 → 全量巡检 → 冻结到期自动解冻）。
- `Src/Interface/RestApi/regulationApi.ts` / `auditApi.ts` / `arbitrationApi.ts`：监管/审计/仲裁动作端点（共 17 个）。
- `.verify/verify-fe060-fe062.mjs`：真实调用验证脚本。

### 修复

- **FE-060 监管**：`checkViolation` 增强 `tool.forbid(<name>|<prefix>.*)` 可执行语法并接入 `toolSafetyGate`
  （工具调用前检查，命中即拒绝并携带规则依据）；REST 触发面（规则维护/广播/紧急干预/僵局升级终审/记录查询）；
  `main.ts` ⑲ 步 `initRegulatoryAuthority()`（此前从未初始化）。
- **FE-061 审计**：审计周期启动（间隔/阈值从 `Configs/audit.json` 注入；手动巡检端点即时刷新快照）；
  `loopEconomy` 真实消耗流入 `anomalyDetector`（此前 0 消费）；**冻结执行效力**：`runPreSupervision` 拒绝冻结 Agent（`AGENT_FROZEN`）。
- **FE-062 仲裁**：自动（事件驱动 + 裁决应用）、手动（`POST /api/arbitration/cases`）双触发面；
  `capsuleAssembler`/`restorationManager` 双实现收敛（`tribunal` 委托唯一实现，兼容既有测试）；
  `globalWorkspace.getEntryById` 供冲突归属解析。
- **FE-068/061 联动**：前置监管的权限验证扩展（驱逐/销毁/挂起 + 审计冻结双重拒绝）。

### 测试

- 新增 `Tests/Services/governanceEnforcement.spec.ts`（12 项：法典执行 5 / 审计 4 / 仲裁闭环 3）。
- 收敛回归：4 个既有仲裁测试文件 70/70 全过。
- 全量：根 **1313/1313（109 文件）**；两套 `tsc`（root / electron）**0 错误**。

### 实机验证（HTTP + 真实 LLM，12/12 PASS）

- R1 立法端点（200 + 非治理 403）+ 行为准则查询；
- R2 **真实 LLM 尝试 `shell.exec` → 行为法典阻断**（工具结果携带规则依据）；
- R3 冻结 → 状态 → 手动巡检（totalAgents=1/flagged=1）→ 解冻（非治理 403）；
- R4 HTTP 驱动六步闭环（case-1 `completed`/`new_wins` + 恢复计划 `completed` + 干预查询）。

## [2026-10-04] 桩实现治理第二批：记忆检索 · 知识沉淀 · 经济记账 · 工具与权限（FE-058 ~ FE-068）

> 第二批 P2 修复（记忆与运行时域）。验证三级：单测 + 质量门禁 + 4 轮真实 LLM 调用（7/7 PASS）。

### 新增

- `Src/Services/Retrieval/textScore.ts`：确定性文本相关性打分（CJK bigram + 拉丁词元；覆盖率 × 饱和词频）。
- `Src/Services/SharedMemory/memoryEmbeddings.ts`：记忆向量存取（内存 + `long_term_memory.embedding_json`，迁移 **v30**）与语义重排
  （余弦混合 0.7/0.3 + 后台补齐，fail-soft；嵌入为可选增强）。
- `Src/Core/Loop/loopKnowledge.ts`：Loop 成功退出知识沉淀（观察入 GlobalWorkspace → `consolidateFromTrace` 提炼长期记忆；门槛 ≥50 字符防噪声）。
- `Src/Core/Loop/loopEconomy.ts`：单轮迭代经济记账（消耗明细+税扣费、双预算档位事件、TOKEN_CONSUMED/TAX_PAID 发布）。
- `taxCollector.startTaxAdjustment/stopTaxAdjustment`：税率周期评估（心跳 60s，内部按 adjustmentIntervalSec 节流）。
- `.verify/verify-fe058-fe068.mjs`：真实调用验证脚本（R1 检索 / R2 主循环沉淀+记账 / R3 闭环 / R4 诚实失败）。

### 修复

- **FE-058 检索**：`createMemoryRetriever` 恒空桩 → 长时记忆真实检索（文本打分 → 语义重排 → topK）；
  `longTermMemory.searchMemories`（title×0.6 + content×0.4）；`vector.search` 工具接真实检索；`memoryApi` 支持 `?query=`；
  `routing.embeddingModel` 可选启用嵌入增强（`embeddingClient` 首条真实消费路径）。
- **FE-059 沉淀**：`executeLoop` 成功退出口接 `consolidateFromTrace`；`tribunal.consolidateKnowledge` 落实写长期记忆
  （category=decision + caseId 溯源；事件 payload 补 memoryId）；**GlobalWorkspace 运行期写方建立**（此前 0 写方）。
- **FE-065 经济**：`runIteration` ⑥ 步记账接线（`recordConsumption` + `dualBudget` 档位事件）；`main.ts` ⑯.1 定价注册（0 注册方→全量）；
  税额与钱包扣费真实发生（此前钱包余额恒定）。
- **FE-067 工具**：`web.search` 真实调用（`CIVITAS_WEB_SEARCH_API_KEY`/`SERPER_API_KEY`；端点可覆写）或 fail-closed `NOT_ENABLED`
  （不再“成功空结果”误导模型）。
- **FE-068 权限**：`runPreSupervision` 拒绝已驱逐/销毁/挂起的 Agent（`AGENT_NOT_PERMITTED`）；未注册放行不引入额外门槛。

### 测试

- 新增 `Tests/Services/memoryRetrieval.spec.ts`（16）/`consolidationWiring.spec.ts`（6）/`preSupervisionPermission.spec.ts`（7）/`Tests/TokenEconomy/tokenEconomyWiring.spec.ts`（6）/`Tests/Tools/webSearchTool.spec.ts`（6）**共 41 项**。
- 全量：根 **1301/1301（108 文件）**；两套 `tsc`（root / electron）**0 错误**。

### 实机验证（真实 LLM 调用，4 轮 7/7 PASS）

- R1 检索命中目标（score 0.6667；无关记忆不召回，恒空桩已修）；
- R2 真实主循环：exitReason=success，453 tokens，沉淀（GW 1 条 + 长期记忆 2→3），记账（余额 10000→9998 / TOKEN_CONSUMED=1）；
- R3 沉淀记忆可被检索（闭环）；
- R4 web.search 无配置 → NOT_ENABLED（诚实失败）。

### 文档校准

- `Docs/Agent/14-参数总典与接口契约/参数总典.md`：`verifier.minLevelsRequired`、`context.{outputReserveTokens,summaryTriggerUsageRatio}`
  升 ✅（注入+消费链路）；新增 `routing.embeddingModel` 登记；定价/税率键补 2026-10-04 校准注。

## [2026-10-04] 桩实现治理第一批：四级验证器接线 · 真实评审 · 上下文压缩（FE-055 ~ FE-057）

> 背景：全库桩实现专项诊断（FE-055~072 登记于前端验收缺陷清单）后的第一批 P1 修复。
> 验证三级：单测 + 质量门禁 + 4 轮真实 LLM 调用（8/8 PASS）。

### 修复

- **四级验证器接线（FE-056）**：`runVerifierPipeline`（L1→L4，ADR-0003 不可跳）此前仅 barrel 导出、0 生产调用。
  现由评审链路承载：`performReview` 构建「L1 schema（summary 必填）+ L2 rule（成果非空）+ [L3 独立 LLM Judge]」spec 并执行管线；
  `minLevelsRequired` 由 `loopConfig.json` 的 `verifier.minLevelsRequired` 经 `main.ts` ⑮.1 注入。
- **真实评审（FE-057）**：`Services/ReviewerAgent/reviewerAgent.ts` 的 `performReview` 由「恒 accepted=true」桩
  改为验证管线判定：转 async；L3 Judge 自动选择异模型（ADR-0004：verifierModel → directorModel →
  arbitrationModels → defaultModel → 已注册模型，全部与产出者相同/不可用时降级 L1+L2）；Judge 调用失败/管线层数不足
  一律 fail-closed 拒绝；`judgeModel` 显式配置（含空串禁用）完全接管自动路径；`ReviewConfig` 新增
  `minLevelsRequired/judgeModel/minScore/callModelFn`。
- **L3 Judge 输出容错**：`verifier/llmJudge.ts` 的 JSON 解析新增围栏/片段提取（真实模型常带 ```json 包裹），
  Judge prompt 明示「只输出裸 JSON」。
- **上下文压缩链路（FE-055）**：新增 `Src/Core/Loop/contextCompression.ts`——`runIteration` ⑤ 步由「仅记录规模」空壳
  改为实装：超阈值（`context.summaryTriggerUsageRatio` × (context_window - outputReserveTokens)，缺省 0.8/4096）
  时把历史旧段压缩为 LLM 摘要（保留最近 keepRecentMessages 条），摘要后注入 GoalReanchor 重锚消息，
  发布 `CONTEXT_COMPRESSED` 事件（此前仅枚举定义、0 发布方），压缩成功且装配素材与共享历史内容等价时原位回写
  （跨轮生效）；未达阈值/摘要失败/异常/空输出一律 fail-soft 保留原上下文（绝不阻断迭代）。

### 变更

- `Src/main.ts` ⑮.1/⑮.2 配置注入（评审 minLevelsRequired / 压缩阈值链路复用既有 `context` 段，未新增配置键）。
- `Src/Tools/Custom/submitForReview.ts` 适配 async 评审与契约口径。

### 测试

- 新增 `Tests/Services/reviewerPipeline.spec.ts`（10 项：L1/L2 确定性拒绝、L3 通过/拒绝/异常 fail-closed、
  ADR-0004 显式降级、ADR-0003 层数不足 fail-closed、criteria 注入、围栏 JSON 容错）。
- 新增 `Tests/Core/contextCompression.spec.ts`（11 项：触发条件 3 项、压缩结构/事件/回写、fail-soft 3 项、
  阈值解析、内容等价；runIteration ⑤ 步端到端 2 项）。
- 既有测试适配（评审 async + payload 契约 + L3 显式禁用）：`agentRuntime.spec.ts`、`realAgent.spec.ts`、
  `E2E/delegationMode.spec.ts`、`E2E/consortiumMode.spec.ts`。
- 全量：根 **1260/1260（103 文件）**；两套 `tsc`（root / electron）**0 错误**。

### 实机验证（真实 LLM 调用，4 轮 8/8 PASS）

- 新增 `.verify/verify-fe055-057.mjs`（`npx tsx .verify/verify-fe055-057.mjs`）：
  - R1 合格成果评审 → GLM-5.1 真实 Judge（25.9s）→ 「评审通过：L1+L2+L3 共 3 项验证全过（layers=3）」；
  - R2 空泛成果 → 真实 Judge 拒绝（score=0，evidence 指明「空泛占位描述」）→ rejected；
  - R3 真实压缩：4 条 → 4 条（摘要+重锚+2 保留），tokens 1960 → 1278，`CONTEXT_COMPRESSED` 事件 + 回写，
    压缩后真实模型调用正常；
  - R4 压缩后连贯性：第 2 轮真实迭代准确引用摘要事实（「凤凰计划…产物写入 src/ 目录并保持编号」）。

## [2026-10-04] 治理层分层与权限落地（L0 独占治理，L1/L2 只做事）

### 新增

- **治理守卫** `Src/Services/Governance/governanceGuard.ts`：`tierOf`（所有者/L0/L1/L2 分层判定）、
  `buildApprovalDeciders`（按**请求方层级**构造审批决策池）、`requireGovernanceRole`（治理动作入口守卫）。
- **治理留痕** `Src/Services/Governance/governanceAudit.ts`：统一治理台账 + `governance:action_recorded`
  事件，强制四类元数据（全局唯一 ID / 时间戳 / 来源 Agent / 任务标识）；**放行与拒绝都留痕**。
- **记忆治理** `Src/Services/SharedMemory/memoryGovernance.ts`：键分层（治理键/共享键/隔离键）、
  分层写入权限（治理键仅 L0；隔离键禁入共享层）、语义碰撞检测（命题相似度 ≥0.85 且极性相反 → 阻断 + `CONFLICT_DETECTED`）。
- **迭代快照** `Src/Infra/DurableExecution/iterationCheckpoint.ts`：迭代边界写入 checkpoint（修复"运行期无 checkpoint"）。
- **Loop 主表落库** `Src/Infra/Db/Repositories/loopRepository.ts`：`ensureLoopRow` / `touchLoop`
  （补齐 `loop_checkpoints.loop_id` 外键父行；`loops` 表首次接线）。
- **工具层角色常量** `Src/Tools/roles.ts`：`READ_ROLES` / `EXEC_ROLES` / `DANGEROUS_ROLES` /
  `GOVERNANCE_TOOL_ROLES` + `GOVERNANCE_TOOL_NAME_PATTERN`（自动校验治理工具不得对 L1/L2 开放）。
- **事件类型** `EventType.GOVERNANCE_ACTION_RECORDED = 'governance:action_recorded'`（含客户端镜像）。

### 修复

- **审批自审（两层）**：① `approvalGate` 由"按角色去重"改为**身份级去重**（Kuhn 二分匹配），
  同一人换角色名不再满足多角色；② 默认审批人由 `user + prime_director`（L1 自审）改为
  **用户 + L0 治理角色**，并**按请求方层级**构造决策池 + 法定人数 2。
- **幂等键拒绝合法重试**：`effect_journal` 唯一约束冲突时按既有记录状态区分 ——
  FAILED/UNKNOWN/**陈旧**进行中 → 允许重试（复用 `effect_id`）；SUCCEEDED/进行中 → 仍 fail-closed。
- **运行期无 checkpoint**：`checkpointStore.createCheckpoint` 此前无任何运行期调用方 → 现于每轮迭代末尾写入。
- **监管角色不可用**：`regulator` / `auditor` 此前不在只读工具白名单 → 已补入 7 个只读/检索工具；
  同时将 `auditor` / `regulator` 移出 DANGEROUS 工具白名单（治理层不执行副作用）。
- **审批决策越权**：`decideApproval` 现校验"角色必须在决策池内 + 法定人数 + 系统角色不得自动通过"。

### 变更

- 治理动作入口统一接收显式 `actorRole`：审计（freeze/unfreeze/investigate/patrol）、仲裁（verdict/suspension/consolidation）、
  监管（intervene/escalate/rule_add/rule_remove）、广播；系统到期自动解冻走内部 `applyUnfreeze`（不走治理门）。
- 广播 `broadcast()` 写入 `globalWorkspace`（经 `writeGuard`），使"广播 = 全员可见的记忆条目"成立。

### 测试

- 新增 `Tests/Governance/{auditGovernanceGate,sharedMemoryGovernance,governanceAuditTrail,toolLayerGovernance,broadcastGovernance}.spec.ts`、
  `Tests/Infra/bugfixes-approval-retry-checkpoint.spec.ts`；
- 全量：根 **1126/1126（84 文件）**；四套 `tsc`（root / Client / electron / Server）**0 错误**；
- 服务端 **117/117**。

### 修复（续）

- **两套 `UserRole` 词表统一（G-16）**：项目此前存在同义不同名的两套角色词表（执行域 `Infra/types.ts`
  用 `regulator`；审批域 `Services/LoopControl/types.ts` 用 `regulatory_authority`），本会话已因此踩坑三次。
  新增权威模块 `Src/Infra/Roles/roleVocabulary.ts`（权威集合 + 双向别名 `toCanonicalRole`/`toApprovalRole`
  + 分层判定 `tierOfRole`/`isL0Role`），`governanceGuard` 的 L0 集合与 `tierOf` 改为**委托权威实现**，
  并新增一致性测试 `Tests/Governance/roleVocabulary.spec.ts` 锁死"新增角色必须同步登记"。

- **审批决策者身份绑定（G-09）**：新增 `Src/Services/Governance/approvalIdentity.ts` —— `user` 角色身份
  **绑定活动账号**（自报身份作废并留痕 `approval.identity_mismatch`）；Agent 角色必须是**真实注册 Agent**
  且真实角色与所报角色一致（两套词表等价判定）；失败一律 fail-closed。接入
  `POST /api/approvals/:id/decide`（校验失败返回 403）。
- **L0 角色不可被赋权（G-11）**：`agentFactory.createAgent` 此前**无任何角色校验** ⇒ 任意调用方可伪造
  L0 Agent。现由 `roleVocabulary.{isAssignableAgentRole, denyReasonForAgentRole}` 在**工厂层与注册表层**
  双重拦截；系统播种需显式 `{ allowGovernance: true }`；`hydrateAgents()` 回灌遇治理角色行仅告警不中断恢复。
- **共享记忆属主隔离与持久化（G-13③）**：`globalWorkspace` 写穿 `global_workspace`（含 owner）、
  `read()` 合并持久化条目并按属主过滤、新增 `hydrateGlobalWorkspace()` 于启动期回灌（`main.ts` ⑦.4）。

### 新增（治理可观测面，G-17）

- **后端查询端点** `Src/Interface/RestApi/governanceApi.ts`：`GET /api/governance/records`
  （支持 `action` / `actorRole` / `outcome` / `limit` 过滤）与 `GET /api/governance/summary`，
  已注册进 `Src/Interface/WebServer/routes.ts`。
- **前端治理记录面板**：`Client/src/stores/governanceStore.ts`（实时消费 `governance:action_recorded`
  + `hydrate()` 启动回填、幂等入列、上限 300、筛选与概览 selector）+
  `Client/src/components/Layout/RightPanel/GovernancePanel.tsx`（右侧面板「⚖治理」页，
  展示 谁·何时·何动作·结果·依据，拒绝同样可见）；`uiStore.PreviewKind` 新增 `governance`。
- **实机验证**：渲染进程发起伪造裁决（`decidedBy=auditor:agent-伪造`）→ HTTP **403**；
  面板**无需刷新**即显示「裁决审批 / 拒绝 / auditor / 理由：不是已注册 Agent」。

### 修复（续）

- **治理面板无限重渲染崩溃**：初版使用返回**新对象**的 zustand 选择器（`selectSummary`），
  触发 `getSnapshot should be cached` → `Maximum update depth exceeded` → 渲染树崩溃（页面空白）。
  已改为只选原始字段（`s.records` / `s.filterOutcome`）并用 `useMemo` 派生，重启后验证正常。

### 新增（治理台账落库，G-18）

- **迁移 v29** `create_governance_records`：治理留痕落库（`record_id` 主键 / 四类元数据 /
  `action`·`outcome`·`reason`·`target_ids_json` / `owner_user_id` 属主 / 两个查询索引）。
- **写穿 + 回灌**：`Governance/governanceAudit.recordGovernanceAction` 写穿落库；
  `listGovernanceRecords` 合并持久化记录（按属主）；新增 `hydrateGovernanceLedger()`
  于 `main.ts` ⑦.4b 启动期回灌（幂等 + 计数器恢复）；落库失败不阻断治理动作。
- **实机验证（重启不丢）**：触发伪造裁决 → 403 → 重启前 `total:1` → **重启后仍 `total:1`
  `denied:1`**；SQLite 直读 `governance_records` 1 行（`approval.decide / denied / auditor / owner=local`）。
  修复前该台账为进程内数组，重启即归零。

### 新增（G-09 方案 B：服务端令牌身份验真）

- **`Src/Services/Governance/serverIdentity.ts`**：`extractBearerToken`（兼容 `Authorization: Bearer`
  与 `X-Account-Token`）→ 向服务端 `GET /v1/me` 验真 → 可信 `userId`；令牌**哈希短 TTL 缓存**（60s）；
  验真失败一律 fail-closed（403）。服务端基址取 `CIVITAS_SERVER_URL`，默认 `http://127.0.0.1:8787`。
- **请求头透传**：`ApiRequest` 新增可选 `headers`，`Interface/WebServer/httpServer.ts` 从 HTTP 请求填充
  —— 此前本地 REST 层无法读取请求头，方案 B 无从落地。
- **审批路由接入**：`approvalApi` 先验真（有令牌时）再绑定身份；`bindApprovalIdentity` 支持
  `verifiedUserId`（**服务端身份优先于本地活动账号与自报身份**），并返回 `source`
  （`server_token` / `active_account` / `registered_agent` / `human_proxy`）。

### 变更（G-09 语义细化）

- **Agent 角色身份分两档**：形如 `agent-<role>-<n>` → **必须是真实注册 Agent 且角色匹配**（否则 403 + 留痕）；
  其它形态 → 视为**人类代理**治理角色（客户端"单操作者模式"），接受但**显式留痕**
  `approval.human_proxy`（不静默）。原因：客户端一次点击需按顺序补齐多个角色，若一律要求真实
  Agent，L1 自有请求在本机无 L0 Agent 实例时将永远无法满足（**该项待产品裁定**，见清单 G-09 备注）。
- 实测：伪造令牌 → 服务端 **401** → fail-closed；无令牌 → 回退方案 A（本地活动账号）。

### 新增（G-19：治理角色按需创建 / 按需扩容）

- **`Src/Services/Governance/governanceProvisioning.ts`**：`ensureAgentForRole` / `ensureAgentsForRoles` /
  `setRoleAgentLimit`。语义：已有实例**复用**（幂等）；无实例且未达上限 → **创建**（治理角色经
  `createAgent(..., { allowGovernance: true })` 受控播种通道）；达上限 → 不再扩容（**扩容有度**，默认每角色 2）；
  两套词表归一化（`regulatory_authority` → `regulator`）；创建动作留痕 `governance.agent_provisioned`。
- **接入审批路径**：`toolSafetyGate` 在 `createApproval` 前 `ensureAgentsForRoles(deciders)`，
  使审批裁决可归属**真实 Agent 身份**；创建失败不阻断审批（人类代理兜底 + 留痕）。
- **背景修复**：`Services/Arbitration/{arbitratorPool,dynamicScaling}.ts` 此前只维护**内存池位**
  （idle/busy）而**不产生真实 Agent**，且两者**无生产调用者**（孤岛）——"L0 按需创建"因此只停留在池位层面。
  本项补齐"池位 → 真实 Agent"这一环。
- **实测**：首次 `{agentId:'agent-auditor-1', created:true}`；再次 `created:false`（复用）；
  `regulatory_authority` 归一化为 `regulator` 并复用同一实例；非法角色拒绝。

### 新增（G-20：仲裁者池 ↔ 真实 Agent 桥接）

- **池位绑定真实 Agent**：`Arbitrator` 新增 `agentId`；`arbitratorPool.addArbitrator` 改用
  `ensureDistinctAgentsForRole('arbitrator', desired)`（G-19 新增的**池化扩容** API）——
  池化场景要求**每个池位一个独立身份**（各自裁决 + 负载均衡），与审批侧"够用即复用"语义不同。
- **消除扩缩容孤岛**：`tribunal.fileCase` 立案即 `recordConflict()` + `evaluateScaling()`，
  使 `dynamicScaling` 获得**生产调用者**（此前 `recordConflict/evaluateScaling` 无任何调用者，
  冲突窗口永为 0，"按需扩容"永不触发）。
- **启动期初始化**：`main.ts` **⑦.4c** 调用 `initArbitratorPool`（读取 `arbitration.pool`
  的 `coreCount`/`auxiliaryCount`，默认 1 核心 + 2 辅助），此前该函数无生产调用者。
- **实测**：3 池位 → **3 个唯一 Agent**（`agent-arbitrator-1/2/3`）；`resizeAuxiliaryPool(3)`
  （aux 0→3）后 `arbitrator` Agent 数 **1→4**（池位扩容真正驱动 Agent 扩容）；
  `fileCase` 后 `getScalingStats().recentConflictCount` **0→1**。
- **`Governance/governanceProvisioning.ts` 新增 `ensureDistinctAgentsForRole(role, count)`**：
  按需扩容到指定规模（调用方声明的规模驱动角色上限），返回互不相同的 Agent ID 列表。

### 新增（G-21：按需回收 + 治理面板按任务聚合）

- **按需回收（与 G-19/G-20 的"按需创建/扩容"对称）**：
  - `Governance/governanceProvisioning.recycleAgentsForRole(role, keepCount, { excludeAgentIds })`
    —— 软销毁（库内保留 `destroyed_at`，可审计），留痕 `governance.agent_recycled`；
  - `Arbitration/arbitratorPool.recycleIdleArbitrators({ staleMs })` —— 回收"空闲 + 从未裁决 +
    超过阈值（默认 10 分钟）"的**辅助层**池位并同步回收其 Agent；核心层保底、busy 不回收；
  - `resizeAuxiliaryPool` **缩容路径**同步回收：池缩了，Agent 也收敛。
- **治理面板按任务聚合**：`governanceStore` 新增 `groupBy: 'timeline' | 'task'`，面板提供切换按钮；
  按 `taskId ?? traceId ?? （无任务标识）` 分组、最近活跃任务在前——一次任务的完整治理链
  （审批 → 按需创建 L0 → 裁决 → 留痕）可一屏看清。
- **实测**：缩容 `aux 4→1` 后可用 Agent **5→2**，库内 `loadAgents(true)` **5 行、3 行有 `destroyed_at`**
  （软销毁 ≠ 物理删除）；空闲回收仅动 idle 辅助层；分组口径 2/1/1 三组。

### 文档

- `Docs/Agent/06-监管与审计系统/监管与审计系统设计.md` 新增 **§6 v3 补丁：治理层分层与权限**；
- `Docs/Agent/10-配置体系与安全/配置体系与安全设计.md` 新增 **§8 v3 补丁：治理权限、记忆治理与留痕**
  （含 §3.3.1 工具白名单两处现状更正）；
- 过程清单：`Docs/Dev/治理层完善清单.md`（AI 代理创建，非规范文档）。

### 修复（治理层核查反馈：FE-041 ~ FE-049、051）

> 来源：`Docs/Client/02-前端改造基础/前端验收缺陷清单.md` 2026-10-04 治理层核查新增 11 条（逐条代码级"定义 → 构造/赋值点 → 运行时消费者"三段链路核查产出）。

- **FE-041 请求头透传 + CORS 补头**：`Interface/WebServer/httpServer.handleApiRequest` 此前不透传 HTTP 请求头
  （`ApiRequest.headers` 恒 `undefined`，G-09 方案 B 令牌验真在 HTTP 链路上永不生效）——现透传
  `normalizeRequestHeaders(req.headers)`（新增归一化：`IncomingMessage.headers` → `Record<string, string>`，
  重复头按 RFC 9110 §5.2 以 `, ` 合并）；CORS `Access-Control-Allow-Headers` 由 `Content-Type` 补全为
  `Content-Type, Authorization, X-Account-Token`（浏览器预检放行）。
- **FE-042 终审裁决守卫**：`Services/Regulation/finalArbiter.issueFinalVerdict` 此前无守卫
  （`actorRole` 可选且未使用，直调可绕 L0 门）→ 改 `actorRole: string` **必填** + `requireGovernanceRole` fail-closed；
  上层 `escalateDeadlock` 已有守卫、透传 `actorRole`（代理层不重复守卫，避免双重留痕）。
- **FE-043 行为法典守卫下沉**：`behaviorCode.addRule / removeRule / updateVersion` 三个底层入口补齐守卫
  （此前仅 `regulatoryAuthority` 代理层把守，直调可绕过；取建议修法之"同加守卫"）。
- **FE-044 治理台账属主隔离 + total 口径**：`governanceAudit` 新增 `recordOwners` 旁表
  （写入 / 回灌 / 截断淘汰三路径同步维护），`listGovernanceRecords` 对内存记录按 `getActiveOwner()` 过滤
  （切号不串号，与持久化视图口径对齐）；`governanceApi` `/summary` 的 `total` 改合并视图长度 `all.length`
  （与 `denied/allowed/byAction` 同源）。
- **FE-045 / FE-046 治理清单勘误**：`Docs/Dev/治理层完善清单.md` G-02 行移出 `executeVerdicts`
  （属 `arbitratorPool.ts` 无副作用纯函数，无需守卫；裁决状态变更由 `reasonVerdict()` 把守）；
  G-05 行更正留痕口径（`BroadcastMessage` **无** `actedByRole` 字段，留痕由统一治理台账 `requireGovernanceRole` 承担；
  `broadcastMessage` 代理定位修正为 `regulatoryAuthority.ts`）；进展记录追加两条勘误行。
- **FE-047 全流程仲裁 actorRole 透传**：`Arbitration/tribunal.executeFullArbitration` 新增可选 `actorRole`
  （此前内部硬编码 `TRIBUNAL_ROLE`，外部无法以实际发起者身份留痕）——`const actor = params.actorRole ?? TRIBUNAL_ROLE`，
  `reasonVerdict` / `issueSuspension` / `consolidateKnowledge` 三步统一透传；缺省不回归，自定义角色非 L0 时子步 fail-closed。
- **FE-048 悬空常量接入注册期校验**：`Tools/Traits/specValidator` 新增两条校验——[13] 工具名命中
  `GOVERNANCE_TOOL_NAME_PATTERN` → `requiredRoles` ⊆ `GOVERNANCE_TOOL_ROLES`（泄漏即拒注）；
  [14] `agent.*` 工具 → `requiredRoles` ⊆ `ORCHESTRATOR_ROLES`（越界即拒注）；`Tools/roles.ts` 两常量悬空消除。
- **FE-049 仲裁池自治周期任务接线**：`main.ts` ⑦.4d 接线 `initDynamicScaling` + `startAutoScaling()` +
  `startIdleRecycling(monitoringIntervalMs)`（此前 `recycleIdleArbitrators` / `startAutoScaling` 无生产调用者，
  运行期池位只增不减）；shutdown 对称 `stopAutoScaling()` + `stopIdleRecycling()`。
- **FE-051 工具可见性双轨收敛**：收敛为**单轨**"唯一真相源 = `requiredRoles`"（`toolHeader.buildToolHeader` /
  `toolFactory.getVisibleTools*` / `registry.execute` 执行期校验为同一谓词）；`trustLevels.isToolAllowed` 补注释
  "保留仅供威胁模型参考与历史测试锚定，**禁止用于可见性 / 执行许可判定**"。

### 新增（编排三链路接线：派发 → 评审 → 聚合，FE-050 / FE-006 残留边界闭环）

- **派发链路**：新增 `Src/Core/Decision/orchestrator/subtaskDispatcher.ts`（`dispatchSubtask` / `markSubtaskReviewed`）
  + 落库层 `Src/Infra/Db/Repositories/taskRepository.ts` / `subtaskRepository.ts`——`receiveTask` 三模式
  （DELEGATION / ASSEMBLY_LINE / CONSORTIUM）创建执行 Agent 后统一 `assignTask` 指派 + `dispatchSubtask` 落库
  （`subtask_id = assignmentId = lastTaskId` 统一 ID 空间；FK 链 `subtasks → tasks → sessions` 贯通，
  `upsertTask` 自动补齐 `run-<traceId>` 会话基座行）。顺带修复：**ASSEMBLY_LINE 流水线节点与 CONSORTIUM 攻坚
  Partner 此前从未被 `assignTask`**（Agent 停在 ready 从未执行）。
- **评审链路**：`Tools/Custom/submitForReview.ts` 由桩（NotImplemented）实装为四步链——[1] 提交登记 `submitForReview`
  → [2] `ensureReviewerAgent`（`reviewerAgent.ts` 新增：按 trace 复用 / 创建独立 Reviewer，Maker-Checker 分离）
  → [3] `performReview` 规则审核 → [4] `markSubtaskReviewed` 台账回写；`agentRuntime` 的 `SUBMITTABLE_ROLES`
  由硬编码 `worker` 放宽为 `['worker','partner','assembly_node']`；`reviewSubmission` 的 TASK_COMPLETED payload
  补 `assignmentId`（供进度 / 聚合按同一键消费）。
- **聚合链路**：orchestrator 新增「活跃编排计划」区块——`initOrchestrator` 幂等订阅 TASK_COMPLETED / TASK_FAILED
  → `handleAssignmentTerminal` → 全部子任务终态 → `finalizeOrchestration`（`aggregateResults` +
  `executeMergePhase` → `tasks` 行回写终态 `final_result` / `completed_at` + 计划出册）；
  汇总事件 payload 不含 `assignmentId`（防事件回路重入聚合）。
- **诚实边界**：Phase 0-2 评审为同进程规则审核（默认通过 + 策略评论留痕，独立 Reviewer Agent 真实创建 / 复用）；
  异步人工 / LLM Judge 评审队列属后续阶段；落库失败不阻断编排（降级内存态视图并留痕）。

### 文档（清单回写）

- `Docs/Client/02-前端改造基础/前端验收缺陷清单.md`：FE-041 ~ FE-051 全部 🟩 已修复 + 逐条
  "修复（2026-10-04）/验证（2026-10-04）"证据段；
- `Docs/Dev/治理层完善清单.md`：G-02 / G-05 勘误（FE-045 / FE-046）；
- `Docs/Agent/03-Agent编排引擎/Agent编排引擎设计.md`：评审链路接线更新（红线 4 / 校准块 / 验收流程图注记）；
- `Docs/Dev/多智能体系统设计验证清单.md`：FE-006 行 🚧 未实现 → ✅ 已修复（随 FE-050 派发链路闭环）。

### 测试（2026-10-04 全量门禁）

- 新增 / 扩充：`Tests/Interface/httpServerHeaderPassthrough.spec.ts`（5 项，真实 HTTP 往返 + CORS 预检）、
  `Tests/Governance/regulationDirectEntryGuards.spec.ts`（6 项：FE-042 组 2 + FE-043 组 4）、
  `Tests/Governance/arbitratorPoolBridge.spec.ts`（FE-049 组 +2，文件共 9 项）、
  `Tests/Governance/governanceLedgerPersistence.spec.ts`（属主隔离 +1，文件共 7 项）、
  `Tests/Governance/toolLayerGovernance.spec.ts`（FE-048 +2）、
  `Tests/Integration/agentPermissionSplit.spec.ts`（12 项，角色可见集按 `requiredRoles` 锚定）、
  `Tests/Decision/orchestrationPipelines.spec.ts`（9 项，三链路端到端）；
- 全量：根 **1214/1214（96 文件）**，含 `Tests/AgentRuntime/realAgent.spec.ts` 三轮真实 LLM 调用
  （Round 1 19s / Round 2 32s / Round 3 拒绝→重提→通过 73s + 综合并行 30s）；
- 四套 `tsc`（root / Client / electron / Server）**0 错误**。

### 修复（提示词链路专项：FE-052 ~ FE-054）

> 来源：`Docs/Client/02-前端改造基础/前端验收缺陷清单.md` 提示词链路专项检查（2026-10-04，对"各个 agent 的系统提示词如何处理"的代码级追踪）。

- **FE-052 角色提示词全链接线**：新增 `Src/Services/Prompts/promptRegistry.ts`（`loadRolePrompts` 装载 `Prompts/roles/*.md` → 内存注册表；`getRolePrompt` 按角色查询；单文件失败跳过降级）；`main.ts` ⑩ 步实装装载（此前仅打日志）；`CreateAgentParams` / `AgentInstance` 增 `systemPrompt?`，`agentFactory.createAgent` 按角色装载（显式传入优先）、`registerAgent` 写透 + `recruiter` 落库 `agents.system_prompt`（此前该列无任何写入方）；`runIteration.buildStableSystemPrompt` 改**三段式**"角色段 + 静态段 + 工具目录"（缓存键含角色段，未装载退化为原行为，前缀稳定设计不破坏）；`Prompts/README.md` 三处表述修订。
- **FE-053 pre/post 钩子消息改写契约修复**：`middlewareRegistry.executePrePostHooks` 链式收集钩子返回值并经 `result` 回传（此前仅消费 shortCircuit、其余整体丢弃）；`runIteration` ③ 步入参改 `[...ctx.chatMessages]`（装配素材，而非恒 `undefined` 的 `mwCtx.data['messages']`）且返回值回接 ④ 装配（`assemblySource`）——GoalReanchor"压缩后重锚"注入链路可达；`mwCtx.data` 注入 `tokenBudget` / `tokensConsumed`（此前恒 `{}`，BudgetSentinel 等依赖 data 的内置中间件永不触发）；`Docs/Agent/02 §3 ③` 与 `§4.4 GoalReanchor` 补校准注。
- **FE-054 ContextStore 追加通道接线**：写侧 `contextStore.recordFileWorkSet`（`file.read` 成功结果以 `file:<path>` 入追加区，同文件原位替换、超长截断 2000 字符）↔ `runIteration` ⑧ 步调用；传递侧 `ipcBridge.streamGeneration` 创建会话级实例并传入 `iterCtx.contextStore`；`Services/Context/index.ts` 补导出。

### 测试（2026-10-04 提示词链路门禁）

- 新增：`Tests/Services/promptRegistry.spec.ts`（6 项）、`Tests/AgentRuntime/agentFactoryPrompt.spec.ts`（4 项）、`Tests/Core/middlewareHookContract.spec.ts`（5 项）、`Tests/Core/goalReanchorWiring.spec.ts`（2 项，mock 模型端到端）、`Tests/Services/contextStoreWiring.spec.ts`（6 项）；`Tests/Core/promptPrefixStability.spec.ts` 追加 2 项；
- 全量：根 **1239/1239（101 文件）**，含 `Tests/AgentRuntime/realAgent.spec.ts` 三轮真实 LLM 调用（17s / 34s / 拒绝→重提→通过 67s + 综合并行 20s）；
- 四套 `tsc`（root / Client / electron / Server）**0 错误**。

## [Unreleased]

### 2026-10-03 — 工具统一派发 / 追加式上下文 / 头部冻结 / 耗时透出 / 热工具配置化

**T1: 工具调用全面收口到统一派发器**
- `Src/Core/Loop/runIteration.ts` 内层工具执行改为 `dispatchToolCall`（不再直接 `executeTool`）；
- 全仓 `await executeTool(` 只出现在 `toolDispatcher.ts` 内（审计/耗时口径一致）。

**T2: 工具耗时（durationMs）透出到界面**
- 后端：`onToolCallResult` 回调新增 `durationMs` 字段，IPC 事件 payload 同步透传；
- 前端：`useEventBus` → `chatStore`（`ToolCallEntry.durationMs`）→ `ToolGroup.tsx` 显示“N ms”；
- 仅在成功/失败且有值时显示，避免“生成中”显示耗时。

**T3: 热工具清单配置化**
- 新建 `Configs/tools.json`（`tools.hot` / `tools.maxHeaderTools`）；
- `Src/Tools/Registry/toolHeader.ts` 新增 `setToolHeaderConfig` / `resetToolHeaderConfig`；
- `Src/main.ts` 启动期读取配置并注入（同一会话内恒定）。

**T4: 追加式上下文（ContextStore 语义）接线**
- 新建 `Src/Services/Context/contextStore.ts`（同键同内容→跳过；同键不同内容→原位替换；新键→追加末尾）；
- `IterationContext` 新增 `contextStore` 可选字段；
- `runIteration` 构造 messages 时把追加段放在历史之后（前缀保持稳定）。

**T5: 文档更新**
- `Docs/Agent/10` 新增 §6.7（工具头部冻结与统一派发三条红线）；
- `Docs/Agent/07` 追加 LTM 校准更新（`long_term_memory` 已真实落库）；
- `Docs/Dev/多智能体系统设计验证清单.md` 更新 5 行状态为 ✅通过/🔧已修复。

**新增测试**
- `Tests/Tools/toolDispatchWiring.spec.ts`（3 项）
- `Tests/Tools/toolHeaderConfig.spec.ts`（3 项）
- `Tests/Services/contextStore.spec.ts`（11 项）
- `Tests/Client/tool-duration.spec.ts`（2 项）

---

### 2026-10-03 — FE-027 修复：`tool.call` 统计覆盖全部工具调用（且不重复计数）

> 背景：统计 `tool.call` 此前只从 `effect_journal` 派生 → **只统计危险/非幂等工具**，
> 安全只读工具（`dir.list`/`file.read`/`file.grep`…）完全不计入，口径明显偏小。

**修复（复用上一轮为组件持久化新增的 AI 事件流）**
- 统计主源改为 `ai_events` 的 **`agent:tool_call_result`**（每次工具调用一条，覆盖全部工具）；
- 与 `effect_journal` **精确配对**以避免重复计数：
  - `effect_journal` 新增 `tool_call_id`（本地迁移 **v25**），由 `toolSafetyGate` 在记录副作用意图时写入；
  - 派生逻辑 `syncApi.deriveStatsEvents`：能配对到 effect 的调用**沿用历史键 `eff:<effect_id>`**
    （旧数据无 `tool_call_id` 时退化为 ±180s 时间近似配对），只有"无对应副作用记录"的调用才使用新键
    **`tool:<event_id>`** —— 因此即使客户端重置水位、全量重传，同一次调用也只计一次；
  - `meta` 携带 `toolName`/`status`/`source`（比原先只有 `effectKind` 更可读）。
- 未被事件覆盖的旧 effect（事件持久化之前的数据）仍按历史键上报；已配对的不会二次上报。

**顺带修复一个危险的静默失败（迁移版本号冲突）**
- 新增迁移时我误用了 **已被 Qoder 占用**的 v24（`rebuild_pending_approvals_for_persistence`）→
  `isApplied(24)` 已为真，**我的迁移被静默跳过**（版本号记录了、列却没建出来，只在测试里暴露）。
- 已改为 **v25**，并给 `initMigrations()` 增加**版本号冲突检测**（同一数据库内重复 version → FATAL 报错），
  附测试 `Tests/Infra/db.spec.ts`（"迁移版本号冲突必须报错"），杜绝同类问题再次静默发生。

**测试**
- `Tests/Interface/syncApi.spec.ts` 新增 4 项：安全只读工具计入（`tool:` 键）、事件+副作用配对**只计一次**且沿用 `eff:`、
  旧数据时间近似配对、无配对调用与纯 effect 旧数据并存、**幂等键在重复派生时保持稳定**；
- `Tests/Infra/db.spec.ts` 新增 1 项（版本冲突检测）。
- 根项目 **1010/1010 全绿**；`tsc --noEmit` 0 错误。

**实机验证（真实 Electron + 本地库）**
```
跑一次 dir.list 任务后 GET /api/sync/stats-events：
  tool.call 共 8 条 = 7 条 tool:<event_id>（toolName=dir.list，此前完全不计入）
                   + 1 条历史 eff:1790870664206-36d0（键保持不变）
  与 ai_events 中的 agent:tool_call_result 一一对应 → 无重复、无遗漏
```

**文档**
- `Docs/16-前端改造基础/前端验收缺陷清单.md`：FE-027 → 🟩 已修复（含修复方案、实机证据与撞号隐患说明），归档表补行。
- `Docs/20-客户端接入账号与同步/客户端接入设计.md`：§5.4 统计口径表与限制表 C3 同步更新。


### 2026-10-03 — SV-003 修复：限流计数改为 PostgreSQL 共享存储（多实例下阈值不再 ×N）

> 背景：限流此前是**进程内计数**，多实例部署时每个实例各算一份 →
> 实际阈值 ≈ 配置值 × 实例数（登录接口的暴力破解防护被等比稀释）。

**方案（不引入 Redis：复用本服务已有的 PostgreSQL）**
- 新增迁移 `Server/migrations/004_rate_limit_buckets.sql`：
  `rate_limit_buckets(bucket_key PK, window_start, used)` + `window_start` 索引。
- `Server/src/http/rateLimit.ts`：
  - 新增 **`createPostgresRateLimiter()`**：单条**原子 UPSERT** 实现固定窗口计数
    （并发安全、多实例共享同一份计数，无需事务/行锁）；
  - `RateLimiter` 接口统一为**异步**（`consume/peek/reset: Promise<...>`），
    内存实现内部仍是同步计算，调用点（`app.ts` 的两个 hook）改为 `await`；
  - **可用性兜底**：PG 查询失败 → 回退进程内限流（仍然限流）+ 错误日志，
    避免"存储抖动导致全员被拒"或"完全不限流"；
  - 过期桶由 `unref` 定时器清理（默认 10 分钟，保留 3 个窗口）。
- 配置 `RATE_LIMIT_STORE=memory|postgres`：**生产默认 `postgres`**、dev/test 默认 `memory`
  （`Server/src/config.ts` + `.env.example` + `Server/README.md` 已同步）。
- 已知语义差异（已注释/文档标注）：PG 为**固定窗口**，内存为**滑动窗口**。

**测试**
- 新增 `Server/test/integration/rateLimitStore.spec.ts`（6 项）：
  **两个 limiter 实例共享计数**（修复前各算一份）、超限拒绝与 `retryAfterSec`、窗口滚动重置、
  `peek` 共享、**存储故障时回退仍限流**、应用级 `RATE_LIMIT_STORE=postgres` 下 429 由共享计数决定且写入桶表。
- 测试脚手架 `buildTestApp` 修正：`rateLimitStore=postgres` 时不再注入内存限流器（避免覆盖真实路径）。
- 服务端 **111/111 全绿**（10 文件）；`Server` `tsc --noEmit` 0 错误。

**实机验证（双实例 + 同一 PostgreSQL）**
```
设 RATE_LIMIT_AUTH_PER_MIN=5，向 A 打满 5 次后再看 B：
  RATE_LIMIT_STORE=memory   → A 第 6 次 429；B 第 1 次 401（未被限流）❌ 阈值实际 ×2
  RATE_LIMIT_STORE=postgres → A 第 6 次 429；B 第 1 次 429 ✅ 共享计数生效
  共享表：auth:127.0.0.1 → used=7
```

**文档**
- `Docs/19-服务端/服务端缺陷清单.md`：SV-003 → 🟩 已修复（含方案与实机证据），归档表补行。
- `Docs/19-服务端/服务端设计文档.md`：§10.5 配置表补 `RATE_LIMIT_STORE`；附录 D 的 **L1** 标注为已解决。
- `Server/.env.example` 与 `Server/README.md`：补 `RATE_LIMIT_STORE`（含"多实例必须用 postgres"的告警说明）。


### 2026-10-03 — SV-001 闭环：备份导出的 `statsLimit` 补上路由透传

> 背景：复核 Qoder 的 SV-001 修复时发现——服务层已支持 `statsLimit` 并会返回 `truncated` 标注，
> 但 `Server/src/routes/backup.ts` 只传了 `{ includeStats }`，**没有透传 `statsLimit`**，
> 因此"限量导出 + 截断标注"这条能力在 **HTTP 接口层不可达**（其测试也只能直调服务层）。

**修复**
- `Server/src/http/schemas.ts`：`backupExportQuerySchema` 新增 `statsLimit`
  （可选、1..100000 整数、非法值 400 校验失败，而非静默忽略）。
- `Server/src/routes/backup.ts`：`GET /v1/backup` 与 `GET /v1/backup/download` **两处均透传**
  `statsLimit`（缺省仍为键集分页全量导出，不会出现静默上限）。

**测试**
- `Server/test/integration/backup.spec.ts` 的 ★SV-001 用例升级为**接口级**断言：
  `?statsLimit=2`（库中 3 条）→ 导出 2 条且 `truncated.stats.limit=2`；`?statsLimit=10` → 全量 3 条无标记；
  下载端点经 `inject` 断言裸备份包内的标注；`statsLimit=abc` / `0` → 400 `VALIDATION_ERROR`。
- 服务端 **105/105 全绿**；`Server` `tsc --noEmit` 0 错误。

**实机验证（真实服务端 + PostgreSQL）**
```
库中 5 条统计事件：
  ?includeStats=true&statsLimit=2 → 导出 2 条，truncated.stats.limit=2（含说明文案）
  ?includeStats=true              → 导出 5 条，无 truncated（完整）
  ?statsLimit=abc / 0             → HTTP 400（校验生效，不再静默忽略）
```

**文档**
- `Docs/19-服务端/服务端设计文档.md`：接口表补 `statsLimit` 参数说明；附录 D L6 补记"路由未透传"的复核结论。
- `Docs/19-服务端/服务端缺陷清单.md`：SV-001 标注为**已闭环**并附实机证据。
- `Server/README.md`：接口速查补 `&statsLimit=N` 说明。

### 2026-10-03 — 缺陷清单清账：前端 18 条 + 服务端 4 条集中修复（FE-003 ~ FE-017 / FE-031 / FE-034 / FE-036 / FE-040 + SV-001/002/004/008）

> 依据：`Docs/16-前端改造基础/前端验收缺陷清单.md`（FE-xxx）与 `Docs/19-服务端/服务端缺陷清单.md`（SV-xxx）
> 中的全部 🟥 条目。本轮全部修复并补测试/实测证据，两份清单状态同步为 🟩 已修复。

**审批闭环加固（FE-003 / FE-004 / FE-005）**
- FE-003（P1，安全语义）：`approvalGate.decideApproval` 对 `decidedBy` **去重**（同一身份只计一次）；
  `unanimous` 策略改按**已满足的角色**判定（决定带 `role:identity` 前缀）——同一操作者重复点击不再绕过双角色要求。
- FE-004（P2）：审批生命周期**写穿落库**——新增 `Src/Services/LoopControl/approvalPersistence.ts`
  （`persistApprovalCreated/Updated` + `listPersistedApprovals`，fail-safe），重启后待审批与已决历史可回溯。
- FE-005（P2）：`GET /api/approvals?status=all` 返回含已决（APPROVED/REJECTED/TIMEOUT）的全部记录；
  `ApprovalQueue` 分「待处理 / 已决」两栏，超时不再从视野消失。

**Electron 壳与工程门禁（FE-007 / FE-008 / FE-009 / FE-010 / FE-011 / FE-016）**
- FE-007：打包分支 renderer 路径修正为 `../../renderer/index.html`（与 electron-builder 布局一致）。
- FE-008：`dev:electron` 改为 `build:server` + `concurrently`（Vite + `wait-on` 就绪后再启 Electron）——不再双起后端。
- FE-009：新增 `tsconfig.electron.json` 与 `typecheck:electron` 并纳入 `npm run build`；`electron/*.ts` 进入类型门禁。
- FE-010：`electron/main.ts` 补齐 `get-server-ports` / `get-app-version` / `open-external` 等处理器，preload 无死接口。
- FE-011：`Src/main.ts` 启动时 `process.loadEnvFile('.env')`（可选调用，缺失不报错）——`.env.example` 承诺生效。
- FE-016：新增 `Scripts/verifyClientDist.cjs` 作为 `build:client` 收尾门禁（入口缺失/< 100 字节即失败）——
  根因判定为构建中断/并发 `emptyOutDir` 竞争留下半写产物，从此在构建期显式暴露。

**前端体验（FE-012 / FE-013 / FE-014 / FE-015 / FE-040）**
- FE-012：`useEventBus` 大屏/概要刷新 3s 尾随节流合并；`approvalStore` 增加 `decidingId`/`lastError`，
  审批卡显示提交中与失败原文（不再"点了没反应"）。
- FE-013：`chatStore.sendMessage` 先插入 `pending-` 乐观气泡，失败回滚。
- FE-014：`MessageBubble.kindLabel` + `MessageShell` 子容器类型头（text/loop/tool/harness），对齐 Canvas 原型。
- FE-015：`MessageList.isEmptyStoppedReply` ——空内容 + 停止不渲染空容器，仅轻提示。
- FE-040：`Configs/supervision.json` 拆分 `apiRateLimit`（HTTP 层，600/分）与 `rateLimit`（监管侧，30/分）两键独立。

**架构清理与合并（FE-017 / FE-031 / FE-034 / FE-036）**
- FE-017：删除无引用死代码（StatusBar / ConversationGrid / ConversationSidebar / ConversationCard / StreamingIndicator
  及残留 ws.ts / useWebSocket / useTaskStream 等）；残留青蓝配色清理。
- FE-031：双鉴权合并——删除 `authStore.ts`，`LoginPage` 只调 `accountStore`（账号唯一真源）。
- FE-034：记忆 KV 表 `memory_entries` 建表（memory 库）+ `memoryEntryStore` 投影与回填。
- FE-036：`modelRouter.uniqueProviderName`（base→base-2→…）+ 凭据按注册名存储——同类型多实例不再互相覆盖。

**服务端（SV-001 / SV-002 / SV-004 / SV-008）**
- SV-001（P1，数据完整性）：导出改为**键集分页全量**（记忆 + 统计）；`BackupBundle` 增加 `truncated`
  显式标注（仅显式 `statsLimit` 超限时），不再静默截断。
- SV-002（P2，安全语义）：`authGuard` 验签后按 `sid` 回查会话行（`refresh_tokens.revoked_at/expires_at`）——
  改密/登出/单会话吊销后旧访问令牌 ≤1 请求周期失效；6 个业务路由接线。
- SV-004（P3）：`index.ts` 接线 `purgeInactive(db, 60)`——启动即扫 + 每 6h 定时（`unref`）+ shutdown 清理。
- SV-008（P3）：新增 `UNAVAILABLE(503)` 错误码走统一错误链；`/readyz` 不再手写 503 报文。

**验证**
- 服务端 **105/105**（9 文件；auth.spec.ts 14 项含 SV-002×2 + SV-004×1、backup.spec.ts 含 SV-001×2、platform.spec.ts 含 SV-008）；
  前端 **90/90**（13 文件，含 login-flow 4 + account-store 9）；三侧 `tsc --noEmit`（root / electron / Client）均 0 错误。
  根工程全量 1002/1004（2 项 `Tests/AgentRuntime/realAgent.spec.ts` 为真实 LLM 非确定性抖动，与本轮改动无关）。
- 文档同步：`Docs/19-服务端/服务端设计文档.md`（术语表 / §4.8 / §5.1 / §5.3 / §9.5 / 附录 D 等 12 处）；
  两份缺陷清单全部条目状态更新 + 归档表补行（详见 `Docs/CHANGELOG.md`）。


### 2026-10-02 — AI 组件族内容持久化：重启后重建思考/工具卡/分段（FE-038）

> 用户报的现象："关闭软件重启后，对话内除对话内容，工具、思考等等组件都没有被重建。"
> 并明确原则：**AI 组件只要被创建了就必须持久化**。
> 排查确认属实——`MessageBubble.tsx` 的注释甚至写着"历史消息没有 segments，回退为正文渲染"。

**根因**
- `chat_messages` 只存 `role/content/model/tokens/trace`，前端运行态里的
  `reasoning`（思考 CoTFolder）、`toolCalls`（工具卡 ToolGroup）、`segments`（分段/子容器 MessageShell）、
  `totalIterations`、`error` **全部没有落库**；
- AI 组件族本身是**事件驱动**的（`ai-components` 按 `eventTypes` 注册、payload 取自事件），
  而事件此前只存在于内存总线 → 重启后组件层信息归零。

**修复（两层持久化 + 回放重建）**
1. **消息富结构**（迁移 v23 给 `chat_messages` 增列）：
   `reasoning` / `tool_calls_json` / `segments_json` / `total_iterations` / `error` / `status`；
   - `chatApi.addMessage` 支持写入富结构；新增 `updateMessageRich` 与
     `upsertRichMessage`（按 `会话+角色+正文` 定位，前端无需知道后端生成的 message_id）；
   - 新增端点：`PATCH /api/messages/:messageId`、`POST /api/sessions/:sessionId/messages/rich`；
   - 前端在**运行结束 / 手动暂停 / 失败**三个收口点回填富结构（`persistMessageRich`）。
2. **AI 事件流**（新表 `ai_events`，迁移 v23）：`Src/Interface/EventStore/aiEventStore.ts`
   订阅事件总线，把组件相关事件（`agent:* / task:* / approval:* / memory:* / delegation:* …`）落库，
   逐 token 增量（`agent:stream_chunk`）除外（正文已单独持久化）；payload 无会话字段的事件沿用"最近已知会话"兜底；
   新增回放端点 `GET /api/sessions/:sessionId/ai-events`（按属主+会话过滤、按时间排序）。
3. **前端重建**：
   - `hydrateRichMessage()` 把库中富结构映射回 `reasoning/toolCalls/segments/totalIterations/error`；
   - `replayAiEvents()` 在打开会话时把持久化事件推回 `eventStore`（与实时链路同一条通路：
     `pushEvent → AIEventBus → Subscribe`），复用同一批组件定义。
   - 事件与消息都按属主隔离（承接上一轮的账号隔离）。

**顺带修复：本地 REST 限流过紧导致写入静默失败（FE-039）**
- 本地 HTTP API 限流原为 **30 次/分**（突发 1.5x）：正常 UI 一轮交互（会话列表+消息+事件+审批轮询）即可触发 429，
  实测导致富结构回填**静默失败**（`apiPost` 返回 `{ok:false}` 而不抛错，原代码只 catch 异常）。
- 调整为 **600 次/分、突发 2x**；并在前端显式检查 `res.ok` 后告警，避免同类静默丢失。

**验证**
- 新增 `Tests/Interface/aiComponentPersistence.spec.ts`（6 项：富结构往返、按正文回填不重复、
  富结构更新受属主限制、事件过滤（增量不落库）、事件按属主+会话隔离与清理、匿名属主）；
- 根项目 **987/987（65 文件）全绿**；服务端 99/99；三包 `tsc --noEmit` 均 0 错误；
- 实机（真实 Electron + 真实 LLM）：发"用 dir.list 列目录并总结" → 库中助手消息
  `hasReasoning=true / hasTools=true / hasSegments=true / iter=2` → **关闭并重开应用** → 打开同一会话：
  「思考过程」✅「工具调用 第 1 轮 1 次 dir.list」✅「2 轮迭代」✅ 与子容器全部重建。

**新发现（未修）**
- `FE-040`（P2）HTTP API 限流与"前置监管（Agent 调用频率）"**共用配置键**
  `supervision.rateLimit.maxRequestsPerMinute`：为本地 UI 放宽的同时也放宽了监管阈值，建议拆分为两个配置。


### 2026-10-02 — Agent 运行数据按账号隔离 + 模型 API_KEY 持久化 + 恢复"登录可选"

> 起因：① 用户提出"每个账户的任务/上下文等属于个人的数据也要隔离"；
> ② 用户怀疑"关闭软件再打开，重新添加模型填写的 API_KEY 会被刷掉"——**经查确有其事**。

**P1 · 模型 API_KEY 重启后被刷掉（FE-035）**
- 根因两条并存：
  1. `ipc-add-provider` 用 `api_key_ref = inline:<key>`，`providerBase.resolveApiKey()` 注释即写明"不持久化，重启后失效"；
  2. 客户端保存凭据时**整包写回**，并把已有供应商的 `apiKey`/`baseUrl` 写成**空串** →
     再加第二个供应商就把第一个的密钥刷掉；重启后按空 key 恢复注册 → 认证失败。
- 修复：**后端为真源**——`ipc-add-provider` / `ipc-remove-provider` 就地 upsert/remove 单条凭据
  （新增 `secretsStore.upsertProviderSecret/removeProviderSecret/hasUsableSecret`，可单测），
  `registerIpcHandlers` 启动时 `restoreProvidersFromSecrets()` 自动恢复注册；
  客户端不再整包覆盖；旧通道 `ipc-save-secrets` 增加"拒绝写入缺 apiKey/baseUrl 的整包数据"防护。
- 验证：添加两个供应商 → 重启 Electron → 两者密钥/地址完好且已自动恢复注册（凭据文件 372 字节，加密存储不落明文）。

**P0/P1 · Agent 运行数据按账号隔离（FE-032 扩展）**
- 原先只有长时记忆与偏好做了隔离，**会话/消息/审批队列/统计仍是"机器级"**：同机换账号后
  B 能在左栏看到 A 的任务与对话、审批角标串号，统计还会把 A 的轮次算进 B。
- 修复：
  - 新增中央属主模块 `Src/Services/AccountScope/activeAccount.ts`（唯一真源，长时记忆改为委托它）；
  - 迁移 **v22**：`chat_sessions`/`chat_messages`/`tasks`/`subtasks`/`global_workspace`/`pending_approvals`/
    `loops`/`effect_journal`/`token_wallets`/`token_transactions` 统一加 `owner_user_id`（旧数据归 `local`，无损）；
  - `chatApi` 全部读写按属主过滤；`addMessage` 落库取**会话自身的属主**（在途任务在切换账号后落库也不会串号）；
  - 审批队列（进程内 Map）按属主隔离（`getPendingApprovals`/`getApproval` 过滤）；
  - 统计派生（`syncApi`）三个来源全部按属主过滤；
  - 客户端 `adoptAccount` 在**账号真正切换**时清空内存态（会话/消息/审批）并按新属主重新拉取。
- 验证：`Tests/Interface/ownerScope.spec.ts`（4 项）+ 实机：A 建"A 的专属任务" → 登出 → B 登录**看到 0 条** →
  重新登录 A → 任务恢复；迁移后原有 20 个会话 / 78 条消息完好归入 `local`。

**P1 · 恢复"登录可选"（FE-030）**
- 去掉 `App.tsx` 的全局 `AuthGuard`：未登录即可使用全部本地能力（服务端不可用时不再"应用直接不可用"）；
  `/login` 与「账号 → 个人信息」两处登录入口保留。实机：未登录访问 `/chat` 停在工作区。

**过程中自查到的两个问题（诚实记录）**
- 迁移 v22 初版用了 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` —— 这是 **Postgres 语法，SQLite 不支持**，
  会导致**应用启动即失败**；已改为普通 `ADD COLUMN` 并补齐 `down` 回滚（SQLite 的 up/down 幂等门禁因此通过）。
- `chatApi` 批量改写时把 `\n` 字面量写进了源码（PowerShell 双引号不转义），已修复并复核 SQL 占位符/参数个数一致。

**测试**
- 新增 `Tests/Interface/ownerScope.spec.ts`（4）、`Tests/Infra/secretsStore.spec.ts`（7）；
  根项目 **981/981（64 文件）全绿**；服务端 99/99；三包 `tsc --noEmit` 均 0 错误。

**新发现 / 仍未处理**
- `FE-034`（P3）记忆 KV 表 `memory_entries` **从未被创建** → `GET /api/memory/entries` 恒为空（记忆视图无数据）。
- `FE-036`（P2）供应商注册表以 **provider 类型为键**，同类型多实例（两个"OpenAI 兼容"）互相覆盖（既有设计限制）。
- `FE-037`（P2，已知限制）运行中的任务在切换账号后仍继续（消息按会话属主落库、不会串号；流式输出仍指向旧会话）。
- `FE-031`（P2）两套鉴权实现仍并存（已补自动拉取，待合并）。


### 2026-10-02 — 安全审计修复：设备策略重设计 + 跨账号数据隔离 + 验证码加固

> 依据：一次参照业界标准（OAuth 2.0/OIDC、RFC 8628 设备授权、NIST SP 1800-13 PKCE、
> ZITADEL/Microsoft 的 AI Agent 身份实践）对登录系统的审计，以及两个实证结论：
> ① 设备绑定让**换机/重装即永久锁死**；② 本地数据是"机器级"的，**同机换账号会互相泄露与污染云端**。

**P0 · 设备策略重设计（FE-033 / SV-014）**
- **不再用易变硬件指纹做身份**：原 `Src/Infra/Security/deviceFingerprint.ts`（MAC 列表 + 主机名 + 磁盘序列号）
  在切换 Wi-Fi/有线、插拔 VPN、改主机名、换盘、Win11 缺 `wmic` 时都会变化；
  现改为**安装期设备凭据**（`crypto.randomUUID` 生成，存 Electron `safeStorage`），服务端只存 `sha256(credential)`；
  硬件指纹降级为设备列表里的**可读标签**。
- **默认不再拒绝新设备**：新增 `DEVICE_BINDING_MODE=off|warn|strict`（默认 `warn` = 记录 + 审计但不阻断；
  实测换机登录由 403 → 200）。严格模式保留给企业场景，且**首个设备必须放行**（否则新账号永远进不来）。
- **新增自助设备管理**（换机/重装的官方恢复路径）：`GET /v1/me/devices`、`DELETE /v1/me/devices/:deviceId`；
  客户端「账号 → 个人信息 → 登录设备」区分为**设备（安装凭据，可移除）**与**会话（登录凭证，可吊销）**。
  原先仓储里的 `users.revokeDevice` 是**死代码**（无任何调用方），现已接通并做越权校验。
- 数据库：`Server/migrations/003_auth_hardening.sql`（`user_devices` 增 `credential_hash`/`device_kind`/`last_seen_at`）。

**P0 · 跨账号数据隔离（FE-032）**
- 根因：本地 `long_term_memory` **没有属主维度**，`syncService` 上行时取**全部**本地记忆配当前账号令牌 →
  A 的记忆被写进 B 的云端账号（实测已发生）。偏好/同步水位同样是机器级。
- 修复：
  - 本地迁移 **v21**：`long_term_memory` 重建为复合主键 `(owner_user_id, memory_id)`，旧数据归入 `local`（无损）；
  - 长时记忆**全部按属主读写**（`longTermMemoryStore` / `longTermMemory` 新增 `setActiveOwner/getActiveOwner`），
    切换属主会清空内存并按新属主回灌（Agent 与同步看到的都只是当前账号的数据）；
  - 新增本地端点 `GET/PUT /api/account/active-user`，客户端在登录/恢复登录/登出时切换命名空间；
  - 偏好与同步元数据加 `userId`：**换账号即丢弃上一账号的偏好与 `serverRevision`/`statsSyncSince`**
    （旧版本地数据无 `userId` → 一律按换账号处理，安全优先）。

**P1 · 验证码与投递加固（SV-012 / SV-013）**
- 验证码**只存 sha256 哈希**（明文列已移除）、`crypto.randomInt` 生成（原 `Math.random()` 可预测）、
  **常量时间比较**、失败计数达 `CODE_MAX_ATTEMPTS`（默认 5）即作废、签发新码作废旧码、
  按邮箱配额（默认 3 次/10 分钟）+ 冷却（默认 60s，0 = 关闭）。
- 新增邮件通道 `Server/src/services/mailTransport.ts`（webhook，零额外依赖）：
  **生产未配置 `MAIL_WEBHOOK_URL` 直接拒绝启动**（否则用户收不到验证码 = 无法登录）；
  `ALLOW_DEV_CODE` 生产环境禁用；控制台通道仅开发使用。
- 新增 `Server/src/logger.ts`（结构化日志，含敏感字段脱敏），并让日志级别跟随 `cfg.logLevel`。

**测试与验证**
- 服务端：新增 `test/integration/verificationCode.spec.ts`（14 项，覆盖哈希存储/CSPRNG/一次性/过期/失败锁定/配额/冷却/
  devCode 开关/warn 模式记录新设备/strict 模式首设备放行·新设备拒绝·解绑后放行/越权不可移除他人设备/off 模式）
  + `config.spec.ts` 新增生产 fail-closed 与默认值断言 → **99/99 全绿**
- 根项目：新增 `Tests/Services/longTermMemoryOwnership.spec.ts`（6）与 `Tests/Client/prefs-account-scope.spec.ts`（6）
  → **970/970 全绿**；三包 `tsc --noEmit` 均 0 错误
- 实机（Electron + 真实服务端 + PostgreSQL）：
  - 换机登录 `设备1 200 / 设备2 200`（修复前 403）、`GET /v1/me/devices` 2 台、`DELETE` 解绑成功且重复移除 404
  - 验证码：明文列已移除、库中为哈希、错码计数累加、第 4 次发送 429
  - 跨账号：A 登录写入本地记忆 → 登出（命名空间回到 `local`）→ B 登录（命名空间为 B 的 userId）→
    **B 的本地记忆列表为空**（修复前会看到 A 的 3 条并已把 A 的数据上传到 B 的云端账号）

**仍未处理（需产品决策 / 属独立改造）**
- `FE-030`（P1）强制登录门禁：`App.tsx` 的 `AuthGuard` 使服务端不可用时应用完全不可用，与"登录可选"的既有决策冲突
- `FE-031`（P2，部分修复）：`accountStore`/`AccountPanel` 与 `authStore`/`LoginPage` 两套鉴权实现仍并存（已补登录后自动拉取）
- `SV-002`（P2）访问令牌无状态：TTL 内不可即时吊销（缓解：TTL 15 分钟）


### 2026-10-02 — 修复 Qoder 改动引入的缺陷：类型门禁回退 + 2 处用户可见问题

> 背景：外部工具（Qoder）新增了「验证码登录 + 设备绑定」功能（`Server/migrations/002_*.sql`、
> `POST /v1/auth/send-code`、`POST /v1/auth/login-with-code`、`Client/src/stores/authStore.ts`、
> `Client/src/views/Auth/LoginPage.tsx`、`App.tsx` 路由门禁），同时留下 4 处缺陷。本轮先测试、再修问题项。

**修复**
- **`Server` 类型门禁回退（3 处，SV-009）**：
  - `Server/src/repositories/users.ts`：`bindDevice()` 的 `db.one()` 可能返回 null → 增加显式兜底抛错（避免 null 外泄）；
  - `Server/src/services/authService.ts`：`bindDevice({ label: input.label ?? undefined, ... })` 修正 `null → undefined` 类型；
  - 与下一条一并修 `invalidCredentials` 签名。
- **验证码错误文案被丢弃（SV-010）**：`Server/src/http/errors.ts` 的 `invalidCredentials()`
  改为接受可选 `message`（默认仍是"邮箱或密码不正确"，保持密码登录防枚举语义）；
  修复前验证码输错会显示"邮箱或密码不正确"，现在返回 `验证码错误`（实测）。
- **`Client/src/stores/authStore.ts` 使用不存在的 `String.hashCode()`（FE-028）**：
  改为确定性 djb2 哈希生成浏览器端设备指纹——原先靠可选调用退化为 `Date.now()`，
  导致**同一台机器每次得到不同指纹**（服务端设备绑定会判为新设备）。
- **登录页"验证码固定 888888"提示与实际不符（FE-029）**：`LoginPage.tsx` 改为
  "发送验证码后在此显示本次验证码（服务端随机生成，无固定码）"——实测 888888 从未被服务端接受。

**验证**
- 三包类型检查全部恢复 0 错误（root / Client / Server）；服务端 82 项、根项目 958 项测试全绿
- 端到端（真实 Electron + 真实服务端 + PostgreSQL）：验证码登录（自动注册 + 设备绑定）→ 进入 `/chat`
  → 简单任务 1「用 dir.list 列出工作目录并总结」回复含工具调用与结论 → 简单任务 2「只回复两个字：收到」回复"收到"
- 服务端落库核对：`users.bound_device_id` 已绑定、`user_devices` 1 条、`verification_codes` 记录正常

**登记但未修改（需产品/架构决策，见缺陷清单）**
- `FE-030`（P1）**强制登录门禁**：`App.tsx` 的 `AuthGuard` 使未登录无法使用应用，
  与服务端不可用时的可用性、"登录可选"既有决策冲突；`AccountPanel` 的登录表单因此不可达。
- `FE-031`（P2）**两套并行鉴权实现**并存（`accountStore`+`AccountPanel` ↔ `authStore`+`LoginPage`），
  靠共享安全存储键桥接；且**验证码登录不触发自动拉取**（实测 `lastPullAt` 未刷新）。
- `SV-011`（P2）新增验证码登录/设备绑定 **0 测试覆盖**；`SV-006` 本轮再次复现
  （`schema_migrations` 残留 `999 999_fake.sql` —— 我的漂移检测测试污染，待清理）。


### 2026-10-02 — 本地后端 HTTP 迁移 Electron IPC

> 设计目标：除云端服务通信外，所有前后端交互走 Electron IPC 通道，消除 HTTP 桥接开销。

**新增（IPC 通道扩展）**
- `Src/Interface/IpcBridge/ipcBridge.ts`：新增 12 个 IPC handler
  - 会话/消息：`ipc-list-sessions`、`ipc-create-session`、`ipc-update-session`、`ipc-list-messages`、`ipc-add-message`
  - 配置管理：`ipc-get-config`
  - 记忆/技能/工具：`ipc-get-memory-entries`、`ipc-get-long-term-memory`、`ipc-bulk-long-term-memory`、`ipc-get-stats-events`、`ipc-get-skills`、`ipc-get-custom-tools`
- `electron/preload.ts`：新增 `sessions`、`configs`、`data` 三个 API 组暴露到渲染进程
- `Client/src/services/ipcApi.ts`：新增对应 IPC 调用封装函数

**迁移（前端 Store/Service 优先 IPC）**
- `stores/chatStore.ts`：`hydrateSessions`、`hydrateMessages`、`createSession`、`setWorkDir`、`sendMessage`、`updateSessionTitle` 优先走 IPC，降级 HTTP
- `stores/configStore.ts`：`hydrate` 优先走 IPC，降级 HTTP
- `services/syncService.ts`：`fetchLocalMemories`、`importLocalMemories`、`fetchDerivedStats` 优先走 IPC，降级 HTTP
- `components/Layout/MainContainer/FeatureView.tsx`：`MemoryFeatureView`、`SkillsFeatureView`、`ToolsFeatureView` 优先走 IPC，降级 HTTP

**架构收益**
- Electron 模式下零 HTTP 开销：前端直连后端模块函数，延迟从 5-10ms 降至 <1ms
- 保留 HTTP 降级路径：浏览器开发模式仍可正常工作
- 云端服务（port 8787）通信保持 HTTP 不变

---

### 2026-10-02 — 设置热重载体系 + 云端配置同步

> 设计目标：配置修改按影响范围分级生效，同时支持与云端账号双向同步。

**新增（热重载体系）**
- `config/schemaTypes.ts`：`FieldDef` 新增 `reloadStrategy` 字段，支持四级热重载策略
- `config/configSchema.ts`：所有配置字段按分组标注热重载策略：
  - `immediate`：UI 参数（轮询间隔、缓冲大小）— 修改立即生效
  - `afterReply`：循环/模型/经济/监管/路由/记忆/审计参数 — Agent 回复完成后生效
  - `onNavigate`：会话/持久执行参数 — 离开当前对话窗口时生效
  - `onRestart`：系统/安全参数 — 需重启服务后生效
- `stores/hotReloadStore.ts`（新）：热重载队列管理——待生效/待重启变更入队、持久化到 localStorage、按触发时机 flush
- `stores/configStore.ts`：`setValue` 按策略分级入队；新增 `applyFromCloud`（云端覆盖）、`getOverridesForSync`（导出供同步）、`applyEffective`（flush 时调用）
- `hooks/useEventBus.ts`：`AGENT_STREAM_END` 后触发 `flushAfterReply()`
- `stores/chatStore.ts`：`setActiveConversation` / `setActiveAgent` 触发 `flushOnNavigate()`
- `stores/uiStore.ts`：`setMainView` 从对话切走时触发 `flushOnNavigate()`

**新增（云端配置同步）**
- `services/syncService.ts`：`pushAll` 携带配置 overrides 到云端 `settings.data.config`；`pullAll` 拉取云端配置并走热重载管线分级生效
- `stores/configStore.ts`：新增 `dirty` 标记（未同步变更）、`markSynced`（同步完成清除标记）

**新增（UI 增强）**
- `views/SystemConfig.tsx`：
  - 每个配置行显示热重载策略标签（绿/橙/蓝/红色块）
  - 顶栏新增待生效计数器（“N 项待生效 (X 回复后, Y 离开时)”）
  - 顶栏新增需重启警示（“N 项需重启”）
  - 顶栏新增云端同步状态（“未同步” / “已同步”）
  - `onRestart` 级修改项显示特殊提示

---

### 2026-10-02 — 客户端接入服务端：账号登录 + 偏好/长时记忆/统计同步（P2）

> 设计依据：[Docs/20-客户端接入账号与同步/客户端接入设计.md](Docs/Client/04-客户端接入账号与同步/客户端接入设计.md)。
> 目标：让上一轮交付的服务端真正可用——登录后即可跨设备/重装恢复数据。

**修复（接入前置缺陷，FE-026）**
- **长时记忆只存进程内 `Map`、重启即丢**：`Src/Services/SharedMemory/longTermMemory.ts` 现写穿到 SQLite
  `long_term_memory` 表（新增 `longTermMemoryStore.ts`），并在启动步骤 ⑦.2 回灌
  （`hydrateLongTermMemory()`，`Src/main.ts`）
- **`memory_id` 重启后重用**（`ltm-${++counter}` 计数器归零 → 复用 `ltm-1`，
  会按 `clientMemoryId` 污染云端同一条记录）：回灌时把计数器推进到 `max(ltm-N)+1`，彻底杜绝
- 访问计数/状态变更同步落库；新增 `importMemories()` 供云端恢复；`resetLongTermMemory()` 仅清内存（测试语义不变）

**新增（本地 REST，供同步使用）**
- `GET /api/memory/long-term`、`POST /api/memory/long-term/bulk`（批量导入，幂等 upsert，
  `Src/Interface/RestApi/memoryApi.ts`）
- `GET /api/sync/stats-events?since&limit`（本地派生统计事件：`chat.turn`←`chat_messages`、
  `token.consumed`←`token_transactions`、`tool.call`←`effect_journal`；含 `nextSince`/`truncated` 续拉语义，
  `Src/Interface/RestApi/syncApi.ts`），并在 `Src/Interface/WebServer/routes.ts` 注册

**新增（客户端）**
- `services/serverApi.ts`：服务端 HTTP 客户端——统一响应解析、Bearer、**401 自动续期并重试（单飞）**、
  `TOKEN_REUSED` 立即失效登录态、地址规范化
- `services/secureStore.ts`：令牌存储抽象——Electron 走 `safeStorage`（密文落 `userData/secure-store.json`），
  浏览器降级 `sessionStorage`（异步探测可用性）
- `stores/accountStore.ts`：登录/注册/登出/设备会话/资料、同步进度与错误、**冲突（revision）呈现**、
  失败重试队列（网络类入队、30s 自动重试一次；4xx 不入队）
- `stores/prefsStore.ts`：可同步偏好（模型/工作方式/主题/上次视图）+ 本地同步元数据（revision、统计水位）
- `services/syncService.ts`：push/pull 编排、字段映射（本地 ↔ 服务端，含状态枚举有损映射）、
  估算幂等键、批量与分批、冲突与降级
- `views/AccountPanel.tsx`（新）：「账号 → 个人信息」由静态占位改为真实面板（服务器配置/测试连接、
  登录注册、账号信息、设备吊销、拉取/上传/导出备份/导入恢复、状态与冲突提示）
- 左栏「账号」增加登录态指示点；`ChatView` 选择模型/工作方式时同步写入偏好（供上传）

**新增（Electron 主进程）**
- `server-fetch` IPC：渲染进程的服务端请求经主进程 Node `fetch` 转发，
  **规避渲染进程跨源限制**（打包后 `file://` 亦可），服务端因此无需为桌面端开放 CORS
- `secure-store-available/get/set/remove` IPC（`safeStorage` 加密读写）

**测试**
- 新增 47 项：`Tests/Services/longTermMemoryPersistence.spec.ts`（6）、`Tests/Interface/syncApi.spec.ts`（8）、
  `Tests/Client/server-api.spec.ts`（12）、`Tests/Client/account-store.spec.ts`（9）、
  `Tests/Client/sync-service.spec.ts`（12）；根项目 958 项全绿，两端 `tsc --noEmit` 干净
- **端到端（真实 Electron + 真实服务端 + 真实 PostgreSQL）**：注册 → 本地写入 2 条记忆 → 上传
  （"记忆 2 新增 · 统计 35 条入库"，服务端核对设置含客户端上传的模型偏好、35 条统计、审计与设备）→
  关闭客户端并清空本地记忆（2→0）→ 重启后**仍为登录态**（safeStorage）→ 一键拉取恢复 2 条记忆

**已知限制（本轮不做）**
- 无后台自动同步（登录后自动拉取 + 手动上传）；冲突只能整包二选一；`tool.call` 仅统计进入副作用日志的工具；
  记忆状态枚举往返有损；备份导出仍受 `SV-001`（10 000 条静默截断）影响 —— 详见 Docs/20 §11


### 2026-10-02 — 新增服务端：账号 / 设置 / 统计 / 记忆 / 备份恢复（`Server/`）

> 目标：把"删掉软件仍然要保留"的数据搬到服务端，用户重装后用同一账号登录即可重建。
> 这是一个**独立 npm 包**（依赖不进 Electron 打包），自托管、可本地运行。

**新增（账户与鉴权）**
- `POST /v1/auth/register|login|refresh|logout|change-password`、`GET/PATCH /v1/me`、
  `GET /v1/me/sessions`、`DELETE /v1/me/sessions/:sessionId`、`GET /v1/me/audit`、`DELETE /v1/me`（注销账号）
- Argon2id 密码哈希（19 MiB / t=2 / p=1）；JWT 访问令牌（15 分钟，仅含 `sub`/`sid`）+
  不透明刷新令牌（服务端只存 sha256）
- **刷新令牌轮换 + 重用检测**：旧令牌再次使用即判定泄漏，吊销同一 `family_id` 全部会话
- 改密吊销该用户其他设备会话并为当前设备换发令牌；登录失败统一文案 + 等价耗时假校验（防账号枚举）
- 审计日志：登录成功/失败、令牌重用、改密、登出、吊销会话（写入失败不影响主流程）

**新增（业务数据）**
- 设置管理：`GET/PUT/PATCH/DELETE /v1/settings`，`jsonb` + 单调递增 `revision`，
  支持 `expectedRevision` 乐观并发（不匹配 → `409 REVISION_MISMATCH` 带 `currentRevision`）、
  浅合并（`null` 删键）、体积上限
- 个人数据统计：`POST /v1/stats/events`（批量、`clientEventId` 幂等）、
  `GET /v1/stats/summary|daily|overview`、`DELETE /v1/stats/events`；
  按日分桶遵循 `STATS_TIMEZONE`
- 记忆存储：`GET/POST /v1/memories`、`GET/PATCH/DELETE /v1/memories/:id`、`POST /v1/memories/bulk`；
  字段与端侧 `long_term_memory` 对齐，`clientMemoryId` 幂等 upsert（重装重传不重复）；
  键集分页、分类/状态过滤、中文 ILIKE + 拉丁全文检索、默认软删除（墓碑）
- 备份/恢复：`GET /v1/backup`、`GET /v1/backup/download`（附件）、`POST /v1/restore`
  （`mode=merge` 幂等合并 / `mode=replace` 清空重建），备份包 `format=civitas.backup, version=1`

**新增（工程与安全）**
- `Server/` 独立包：Fastify 5 + `pg` + `jose` + `@node-rs/argon2`（预编译，无需 node-gyp）+ Zod
- SQL 迁移：`migrations/001_init.sql`（7 张表）+ 迁移 CLI（幂等、记录 checksum、**漂移检测**）
- 配置：`.env` 解析 + Zod 校验 + **生产 fail-closed**（`JWT_SECRET` 缺失/示例值拒绝启动）
- 限流（鉴权按 IP / 其他按 IP / 写操作按用户，超限 `429` + `Retry-After`）、
  统一响应 `{ok,data}` / `{ok:false,error}`、Zod 全量入参校验、参数化 SQL、
  5xx 不外泄细节、日志字段脱敏、安全响应头、优雅退出
- `docker-compose.yml`（postgres:16 + 健康检查 + 数据卷）与 `.env.example`
- 文档：`Server/README.md`（快速开始/配置表/接口一览/curl 全流程/数据模型/安全/运维/限制）、
  `Docs/19-服务端/服务端设计文档.md`（选型决策、数据归属边界、后续路线）

**验证**
- 单元测试 29 项 + 集成测试 53 项（真 PostgreSQL），共 **82 项全绿**；`tsc --noEmit` 干净
- 真实 HTTP 端到端：注册 → 写设置(revision 2)/3 条记忆/3 条统计 → 导出备份 →
  **新设备登录即看到全部数据** → 清空数据 → `POST /v1/restore`(replace) →
  设置/记忆（`clientMemoryId` 保留）/统计全部复原；令牌重用检测返回 `TOKEN_REUSED` 且整族失效

**已知限制**
- 限流为进程内计数（多实例需换 Redis 实现）；统计为实时聚合（超大数据量建议加日汇总表）；
  中文检索用 ILIKE 兜底；无邮件通道（邮箱验证/找回密码未实现）；**客户端接入为下一轮**。

### 2026-10-01 — 前端验收修复（三栏工作区 / 对话渲染 / Electron 链路 / 上下文装配）

> 缺陷发现与未修复项见 [Docs/16-前端改造基础/前端验收缺陷清单.md](Docs/Client/02-前端改造基础/前端验收缺陷清单.md)。

#### 三栏工作区
- **修复**：`AppLayout.tsx` — 收起态改为直接渲染 `LeftPanel`/`RightPanel`（其内部已有角标分支）。原 `{open && <Panel/>}` 使面板内部的展开角标成为死代码，导致**左面板收起后无法恢复、右面板完全无法打开**。
- **修复**：`MainContainer/index.tsx` — 会话视图不再套块级 `overflow-y-auto`，改由 `flex-1 min-h-0 flex flex-col` 承载，使 `ChatView` 的 `flex-1/min-h-0` 生效。原结构下整块内容（含输入框）一起滚动，读历史消息时输入框被顶出视口，且底部有 56px 死区。现仅对话区滚动，输入框常驻底部（底边距 1px）。
- 验证：CDP 实测三栏 220/1116/220 且开合可逆；`log` 为唯一滚动容器、输入框位置恒定。

#### 对话渲染
- **修复**：`MessageList.tsx` — 子容器 >50 时自动折叠（补齐 S8 待办），按 `COLLAPSE_BATCH=50` 分批，前置批次渲染为可点击虚线框，仅最后一批可见；原实现 `useState(false)` 从不参考阈值，55 个子容器会全量展开。
- **新增**：`AgentPreparing.tsx` + 接入 Turn 渲染 — 用户消息发出后、模型尚未产出任何内容（无正文/思维链/工具调用）时不再渲染空的 Agent 对话容器，改为旋转动画准备态；子容器计数也不再包含该占位。
- **修复**：`approvalStore`/`MessageShell` — 后端错误原因透传到 UI（原 `setStreamError` 参数为 `_error` 被丢弃，界面只显示"生成失败"）。现显示「生成出错：环境变量 HUAWEI_MAAS_API_KEY 未设置」这类具体原因。
- **修复**：`ApprovalCard` — `payload` 缺失时 `JSON.stringify(undefined).length` 抛错导致审批视图白屏。
- 验证：`Tests/Client/message-list-turn.spec.tsx`（13 项）、`Tests/AIComponents/components.spec.tsx`、Electron 实测（100ms 准备态 → 2200ms 首字）。

#### 审批（人工审批可达性）
- **新增**：审批入口进入三栏工作区 —— `FeatureList.tsx` 增加「审批」项 + 待处理角标；`TitleBar`/`FeatureView` 增加 `approvals` 视图；`ApprovalQueue` 支持 `embedded` 嵌入模式；新增 `hooks/useApprovalPolling.ts`（共享轮询，多组件仅一个定时器）。
- **修复**：`toolSafetyGate.ts` 创建审批时广播 `loop:approval_requested`；`approvalApi` 决策后广播 `loop:approval_decided` —— 原实现不发事件，前端无法感知。
- 验证：CDP 实测真实 Electron 窗口内角标 8s 内出现、审批视图渲染 CRITICAL 卡片（`agent.recruit` payload / 双角色进度 / 倒计时 / 批准拒绝按钮）；`Tests/Client/approval-entry.spec.tsx`（5 项）、`Tests/LoopControl/toolSafetyGate.spec.ts`（3 项）。

#### 上下文装配
- **新增**：`Src/Core/Model/contextHistory.ts` — `buildContextHistory()` 实现产品决策：**已产出部分回复的暂停轮次保留在上下文中；未产出任何内容就暂停的轮次不写入上下文**（过滤空白 assistant，并剔除因此产生的悬空 user；最后一条消息始终保留 —— 主循环提示词由 `systemPrompt + chatMessages` 组成，`userInput` 不额外追加）。
- **修复**：`chatApi.listMessages()` — 原 `ORDER BY created_at ASC LIMIT ?` 在会话超过 limit 条时**截断最新消息**，导致当前提问进不了上下文（模型答非所问）。改为取最近 N 条后升序返回，`rowid` 作同毫秒 tiebreaker。
- 验证：`Tests/Core/contextHistory.spec.ts`（9 项）；真实会话装配 10 条 → 4 条（剔除 6 条悬空 user）；Electron 实测「请只回复两个字：收到」→ 模型答「收到」。

#### Electron 链路（4 个阻断问题）
- **修复**：`Src/main.ts` 入口加运行时守卫 `if (!process.versions.electron)`。`Scripts/build.cjs` 会把 `Src/main.ts` 与 `electron/main.ts` 一起打包，Electron 主进程 bundle 内联本模块后**无条件二次启动后端** → 工具重复注册 → 启动即退出。
- **修复**：`electron/main.ts` — 以 `fileURLToPath(import.meta.url)` 还原 ESM 下的 `__dirname`（原代码在 `format:'esm'` 产物中直接抛 `ReferenceError`，窗口创建失败）；图标改为存在才传（`assets/icon.png` 缺失）。
- **修复**：`Scripts/build.cjs` + `electron/main.ts` — preload 单独产出 **CommonJS** `preload.cjs`。原产物为 ESM，Electron preload 要求 CJS，静默加载失败 → `window.electronAPI` 不存在 → 前端 `isElectron()` 判定失败、`send()` 退回浏览器降级分支丢弃命令（**"收不到模型消息"的直接原因**）。
- **升级**：`better-sqlite3` 11.10 → **13.0.3**（Node-API 预编译，`prebuilds/win32-x64.node` 同时适配 Node 22(ABI 127) 与 Electron 44(ABI 149)），**无需** `@electron/rebuild`，Node 侧与 Electron 侧共用同一二进制。原版对 Electron 44 的 V8 编译失败（13 处 `v8::External::Value`/`GetIsolate` 错误）。
- **修复**：`openaiProvider` — 请求前剥离 `provider/` 限定前缀（`providerBase.resolveRequestModel()`）。原样透传限定名会让上游返回误导性的 `404 ModelArts.81018: ... does not support the token plan subscription`。
- 验证：Electron 窗口成功创建、`window.electronAPI` 存在、完整回复落库（`huawei-maas/GLM-5.1` / 3388 tok / 2 轮迭代）。

#### 工程
- **修复**：`Client/tsconfig.json` 加 `noEmit` —— `Client npm run build`（`tsc && vite build`）原会向 `Client/src` 写出 87 个 `.js`，而 Vite 解析优先级为 `.js` 高于 `.tsx`，会**遮蔽源码**（编辑 `.tsx` 后仍加载旧编译产物）。
- **修复**：对齐 `Tests/AIComponents/` 三个 spec 到重构后的桥接 API（`connectBridge`/`disconnectBridge`/`subscribe`/`send`），修复 11 项测试失败；新增 `Tests/Client/approval-entry.spec.tsx`、`Tests/LoopControl/toolSafetyGate.spec.ts`、`Tests/Core/contextHistory.spec.ts`、`Tests/Client/message-list-turn.spec.tsx`。
- 验证：`npx tsc --noEmit`（前后端）零错误；`npx vitest run` **856/856 通过**（47 文件）；`npm run build:server` 与 `Client npm run build` 通过。

#### 已知限制 / 决策记录
- 浏览器开发模式（`npm run dev` + `localhost:5173`）**无法产生模型回复**：`eventBusBridge.send()` 在非 Electron 环境丢弃命令，后端无 `/api/commands` 与事件下行端点。2026-10-01 决策：不改前端通道，改用 Electron 验收（见缺陷清单 FE-001）。
- 审批闭环未完成：批准后不会放行工具、双角色可被同一人重复点击绕过、队列仅内存（见 FE-002/003/004）。

#### 任务与工作目录（真新任务 + 工作区约束）
- **修复**：`NewTaskButton` — 「+ 新任务」原来只做 `setMainView({type:'conversation'})`（"假新任务"，消息继续进旧会话）。现改为 `createSession()` → 新会话成为当前会话并清空对话区；创建中显示 spinner、失败给出提示。`chatStore.createSession` 增加"设为当前会话"语义。
- **新增**：会话工作目录（`chat_sessions.work_dir`，迁移 v20）。语义：**每个会话绑定一个工作目录，未指定时自动创建 `<项目根>/Data/workspaces/<sessionId>/` 空目录**，工具与 shell 均以它为根。
  - `Src/Infra/Security/workspaceGuard.ts`：`workspaceBaseDir` / `defaultWorkspaceDir` / `ensureWorkspaceDir` / `resolveWithinWorkspace` / `isWithinWorkspace` / `findEscapingPathInCommand`
  - `POST /api/sessions` 支持 `workDir`；`PATCH /api/sessions/:id` 支持改/重置；`GET /api/sessions` 返回 `work_dir`；迁移前的老会话首次生成时自动补齐（`ensureSessionWorkDir`）
  - 前端：`ChatSession.work_dir` + `chatStore.setWorkDir` + 新增主容器 `WorkDirBar`（显示当前目录 / 更改 / 重置）；Electron 走原生目录选择框（`preload.pickDirectory()` → `main.dialog.showOpenDialog`），浏览器降级为路径输入
- **修复**：`pathGuard` 越界检查 —— 原实现 `if (!isAbsolute(path))` 使**绝对路径绕过**目录遍历检测，只受 `forbiddenPaths`（默认仅 `Data/Auth/`）约束。现改为"解析后必须落在允许根之内"，并新增 `allowedRoots`（安装模式下 `%APPDATA%` 的 Data/Logs/Configs/Prompts/Skills）。
- **修复**：工具执行期按会话工作目录收敛 —— `ToolExecutionContext.workDir` + `IterationContext.workDir`（由 `ipcBridge` 从 `chat_sessions.work_dir` 注入）；`file.read` / `file.write` / `file.edit` / `dir.list` / `file.grep` 入口统一 `resolveWithinWorkspace`（含符号链接 realpath 逃逸检测）；`shell.exec` 强制 `cwd = workDir` 并拒绝越界 `cwd` 与命令中的越界路径片段。顺带修正 `fileWriter` 用 `checkPath(...,'read')` 报告产物信息的问题（改为 `'write'`）。
- 验证：`Tests/Infra/workspaceGuard.spec.ts`（12 项）、`Tests/Client/new-task.spec.tsx`（4 项）；Electron 实测新建任务生成 `Data\workspaces\sess-53cd530d\` 且消息与会话隔离正确；工具级确定性实测 10 项（目录内通过、6 项越界全拒）。
- 残留风险：`shell.exec` 的路径检查是静态尽力而为，非完备沙箱（脚本/变量拼接的逃逸无法拦截），完整隔离需 OS 级机制。

#### 任务列表 / 任务命名 / 气泡内容顺序（FE-018 连带修复）
- **修复**：`TaskList` 主列表改为展示**会话任务**（`chatStore.sessions`）——原先只读后台 `tasks`（`/api/tasks`），而「+ 新任务」创建的是会话，导致新建任务后任务栏始终「暂无任务」。后台任务存在时归入「后台任务」分组保留原入口。
- **新增**：**首次请求时由模型为任务命名**（原实现只把用户第一条消息截断成标题）。
  - `Src/Core/Model/sessionNamer.ts`：`generateSessionName`（≤12 字、去引号/句末标点、超时失败返回 null）、`sanitizeSessionName`、`fallbackSessionName`
  - 命名使用**经济模型**（`workerModel → defaultModel → 本次模型`）+ 30s 超时：实测 GLM-5.1 单次命名 542 completion tokens（831 字思考），原 15s 超时会被迫回退
  - 新增事件 `CHAT_SESSION_RENAMED = 'chat:session_renamed'`（`Scripts/genEventTypes.ts` 重新生成前端镜像），前端 `useEventBus` 监听后 `hydrateSessions()` → 任务栏实时改名
- **修复**：助手气泡按**片段发生顺序**渲染（思考 → 工具 → 正文 → 下一轮…）。原先把全部思考与全部工具调用聚合到气泡顶部、正文追加在下方，多轮时无法对应且视觉上"浮"在回复之上。
  - `chatStore`：新增 `MessageSegment`（`reasoning`/`tools`/`text`）与 `ChatMessage.segments`；`flushBuffer` 与 `applyIterationComplete` 按事件顺序追加（同类相邻合并，工具片段带轮次）
  - `MessageBubble`：优先按 `segments` 渲染，仅**最后一段**享受"流式中"表现；历史消息无片段时回退原顺序
  - `ToolGroup`：新增 `iteration` 属性，标注「第 N 轮」
  - 顺带修掉测试暴露的真实缺陷：片段 key 曾用文本长度（`r-7`/`x-5`），等长片段 key 冲突会让 React 丢子节点，改用片段序号
- 验证：`Tests/Client/task-list.spec.tsx`（3）、`Tests/Core/sessionNamer.spec.ts`（11）、`Tests/Client/message-segments.spec.tsx`（4）；Electron 实测：新任务条目立即出现 → 8s 内改名（`只回复OK` / `目录文件列举`，`byModel: true`）→ 气泡顺序 `思考过程 → 正文 → 工具调用`。
- **修复（FE-023 二修）**：工具事件**前移 + 前端预创建** —— 一修只改了渲染顺序，但后端仅在整轮结束的 `AGENT_ITERATION_COMPLETE` 才带出工具调用，工具块必然落到已流出的正文之后。
  - `runIteration`：新增 `onToolCallStart` / `onToolCallResult` 回调，在**工具执行前/后**触发（含被中间件短路/审批门拦截的情况）
  - `ipcBridge`：新增并立即广播 `AGENT_TOOL_CALL_STARTED` / `AGENT_TOOL_CALL_RESULT`（`Scripts/genEventTypes.ts` 重新生成前端镜像）
  - `chatStore`：`applyToolCallStarted` **预创建**工具片段（`pending`）→ `applyToolCallResult` 就地更新；`applyIterationComplete` 改为按 `toolCallId` 就地更新而非追加（避免重复/挪位）；顺带修掉流式缓冲区覆盖片段的缺陷（原表现：工具块一闪即消失）
  - 验证：`Tests/Client/tool-segment-order.spec.ts`（4）；Electron 实测 6 轮迭代 —— `toolBeforeText: true`、工具行早于正文出现、最终顺序 `思考(0) → 工具(5) → 正文(45)`。

#### 阻塞式审批闭环（FE-024 / 修复 FE-002）
- **新增**：危险且不可逆工具改为**先阻塞、确认后放行执行**（原先只入队并立即返回"等待审批后重试"的错误，审批永远不会放行，即 FE-002）。
  - `Src/Services/LoopControl/approvalGate.ts`：`waitForApprovalDecision()`（阻塞等待决策/超时/中断，超时默认拒绝）与 `forceApprove()`（策略性通过）；`decideApproval` / `checkTimeoutApprovals` / `clearApprovalQueue` 均唤醒等待者
  - `Src/Services/LoopControl/middleware/toolSafetyGate.ts`：创建审批 → 广播 `APPROVAL_REQUESTED`（带 `toolCallId`/`sessionId`/`toolName`）→ 命中自动审批白名单则 `delay(autoApproveDelayMs)` 后自动通过 → 否则阻塞等人工确认 → 通过后继续执行工具；拒绝/超时返回不可重试错误
  - `PendingApproval` 增加 `toolCallId`/`toolName`/`sessionId`/`autoApproved`；`Configs/security.json` 增加 `security.approvalTimeoutSec`（人工确认窗口，默认 300s）与 `security.autoApprove.{tools,delayMs}`（自动审批白名单 + 审查动画时长）
- **新增（前端双处同源）**：审批内容同时出现在**审批栏**与**对话中对应的工具行**内嵌审批卡；二者读同一份 `approvalStore`，任一处点击都走同一个 `decide()`，天然同步。
  - `ToolGroup` 内嵌 `InlineApproval`：`L0 级权限审查中…`（转圈 + 剩余倒计时）+「确认执行 / 拒绝」；已通过 / 已自动通过（策略白名单）/ 已拒绝 / 超时默认拒绝各有明确状态
  - `chatStore`：`ToolCallEntry` 增加 `approvalId`/`approvalStatus`；新增 `applyApprovalRequired` / `applyApprovalDecided`
- **修复（本需求暴露的 4 个真实缺陷）**：
  1. 工具片段在流式期间先写缓冲、审批事件几毫秒后就到，导致**审批与工具行关联永久丢失**（对话里从不出现审批卡）→ 新增 `toolMessageIndex`（toolCallId→messageId），审批事件经 `mutateSegments` 直接写缓冲
  2. `approvalApi` 广播 `APPROVAL_DECIDED` 时**未带 `toolCallId`** → 决策后卡片仍显示"审查中 + 按钮" → 补齐 `toolCallId`/`sessionId`/`toolName`，并让内嵌卡在事件缺失时按审批记录兜底
  3. CRITICAL `unanimous` 需 2 个角色而客户端只有一位操作者 → **一次点击只满足 1/2，工具永久阻塞**（观感即"点击无效"）→ `decide()` 在单操作者模式下按顺序以各所需角色提交（审计留痕 `role:操作者`），且 store 缺少记录时先取审批详情再补齐角色
  4. 中间态决策事件（多角色未集齐时的 `PENDING`）被前端误判为"已拒绝" → 前端忽略非终态事件
- 验证：`Tests/LoopControl/toolSafetyGate.spec.ts`（6）、`Tests/Client/inline-approval.spec.tsx`（8）、`Tests/Client/tool-segment-order.spec.ts`（6）；Electron 实测 `shell.exec`：阻塞并显示内嵌审批卡 → 一次点击满足双角色 → 放行执行。

#### 手动暂停的部分回复不再丢失（FE-025）
- **修复**：生成中点击「停止生成」后，已显示的部分回复在**切换会话/窗口再切回**时会消失。
  - 根因一（后端未落库）：手动暂停时 `runLoop` 往往是**正常返回**而非抛异常（日志 `主循环执行完成 iterations:1, totalTokens:0`），只走 `if (outputText)` 的空分支；`addMessage` 仅存在于成功分支与 `catch` 中断分支 → 中断但未抛异常时部分回复从不入库。修复：`ipcBridge` 增加 `persisted` 标记与 **`finally` 兜底落库**（`aborted && !persisted && fullContent` → `addMessage`，并记录「手动暂停：已落库部分回复」）。
  - 根因二（前端被覆盖）：`hydrateMessages` 用库内消息整体替换，仅保留 `streamingMessageId`；暂停后该 id 已清空，本地已流出的内容被丢弃。修复：保留"本地未入库"消息（`status !== 'complete'`、`created_at >= 末条库消息时间`、`role+content` 不在库中）并与库消息合并，已在库中则以库记录为准。
- 验证：`Tests/Client/paused-reply-persistence.spec.ts`（4）；Electron 实测正文 64 → 暂停后 66 → 切到别的会话再切回仍 66（`是否丢失: false`），落库核对 `sess-29fe463c assistant len=70`（修复前同场景仅有 `user` 行）。
- 已知残留：暂停时若**只有思考、尚无正文**，思考不入库（`chat_messages` 无 `reasoning` 列），仅前端本地保留；应用整体重载后会丢失。需为消息表增加 reasoning/片段持久化，属独立改造。

---

### 2026-09-29 — 三栏自适应工作界面实现

#### 设计文档
- **新增**：`Docs/16-前端改造基础/三栏自适应工作界面设计规格.md`（482 行），涵盖三栏布局、MainView 状态管理、左侧面板、主容器视图切换、右侧预览面板、AI 组件族集成、实施计划（S1–S8）。

#### S1：三栏骨架
- **重构**：`AppLayout.tsx` 从二栏（侧边导航 + 主内容区）改为三栏布局（左侧副容器 | 主容器 | 右侧副容器）。
- **新增**：`components/Layout/hooks/useResizablePanels.ts` — 拖拽调整面板宽度（ResizeObserver + mousedown/mousemove/mouseup）。
- 左右面板可折叠/展开，6px 拖拽手柄，面板宽度约束（120px ~ 容器 25%/50%）。

#### S2：左侧面板
- **新增**：`LeftPanel/index.tsx` — 左侧面板容器（Logo + 新任务按钮 + 任务列表 + 功能列表）。
- **新增**：`LeftPanel/NewTaskButton.tsx` — 新任务按钮（点击切换到对话视图）。
- **新增**：`LeftPanel/TaskList.tsx` — 任务列表（读 taskStore 真实数据，按状态分组，点击驱动 mainView）。
- **新增**：`LeftPanel/FeatureList.tsx` — 向上可扩展功能列表（Loop 任务 / Harness 工程检查 / 记忆 / 数据中台 / 插件 / 账号）。

#### S3：主容器视图切换
- **新增**：`stores/uiStore.ts` — MainView 联合类型 + 面板状态 Zustand store。
- **新增**：`MainContainer/index.tsx` — 主容器（标题栏 + 内容区按 mainView 切换）。
- **新增**：`MainContainer/TitleBar.tsx` — 动态标题栏（conversation/task/feature/agent 四种标题）。
- **新增**：`MainContainer/TaskView.tsx` — 任务详情视图（读 taskStore 真实数据）。
- **新增**：`MainContainer/FeatureView.tsx` — 功能视图（9 种子视图，settings 接入 configStore 真实数据）。
- **新增**：`MainContainer/AgentView.tsx` — Agent 对话视图（读 agentStore 真实数据）。

#### S4：对话视图
- 对话视图复用现有 `ChatView`（已集成 AIEventBus + Subscribe），在 mainView.type === 'conversation' 时渲染。

#### S5：右侧面板
- **新增**：`RightPanel/index.tsx` — 右侧面板容器（6 种预览标签 + PreviewCache 缓存）。
- **新增**：`RightPanel/PreviewCache.tsx` — DOM 缓存包装器（display:none/flex 切换保持状态）。
- **新增**：`RightPanel/AgentPreview.tsx` — L1 Agent 列表（读 agentStore，点击驱动 mainView）。
- 其余 5 种预览标签（SubAgent / 终端 / 概要 / 文件查看 / 文件预览）为占位，待后续实现。

#### 构建验证
- Vite build 通过（19.42s），新增文件零 TypeScript 编译错误。
- 预存 ai-components CSS module 类型声明问题未影响新代码。

#### 待办
- S6：文件查看 → 文件预览联动
- S7：功能视图接入更多真实 store/API 数据
- S8：Agent 回复子容器 >50 个时自动分批折叠

---

### 2026-09-28 — Phase 0 架构简化 + Phase 1 AI 组件族架构落地

#### Phase 0：WebSocket → EventEmitter 架构简化
- **变更**：删除 `Src/Interface/WebSocket/` 目录（wsGateway/wsServer/wsHandler），新增 `Src/Interface/IpcBridge/ipcBridge.ts` 替代。
- **前端**：`Client/src/services/ws.ts` 重写为 `eventBusBridge.ts`（Electron IPC 桥接），`useWebSocket.ts` 重命名为 `useEventBus.ts`。
- **配置**：`Configs/default.json` 删除 wsPort、`vite.config.ts` 删除 `/ws` 代理、`configSchema.ts` 删除 wsPort 配置项。
- **Electron**：`electron/preload.ts` 新增 IPC 事件桥接 API（onBackendEvent/sendBackendCommand）。
- **收益**：代码量减少 ~70%，事件延迟从 5-10ms 降至 <1ms。

#### Phase 1：AI 组件族架构落地
- **新增目录**：`Client/src/ai-components/`（按 Agent 运行时语义分组的组件体系）。
- **类型定义**：`types.ts` — AIComponentDef<ComponentFamily, ComponentSubgroup, AIEvent>。
- **注册表**：`registry.ts` — 泛型注册表 + 懒加载 + 通配符匹配。
- **事件订阅**：`AIEventBus.tsx`（React Context 事件容器）+ `Subscribe.tsx`（声明式订阅组件，支持注册表动态渲染 + children render prop 两种模式）。
- **Core 族**：`StreamBuffer`（流式缓冲）、`CoTFolder`（思维链折叠）、`MessageShell`（消息外壳）。
- **Harness 族**：`ToolGroup`（工具调用展示，支持 read/write/exec/system 四种子样式）。
- **错误边界**：`FamilyErrorBoundary`（族级隔离）+ `FallbackUI`（降级提示，开发环境显示详情）。
- **样式隔离**：所有 AI 组件采用 CSS Modules（`.module.css`），族样式随分包独立提取。
- **组件改造**：`MessageBubble` 从 224 行精简为 72 行组合层，委托给 Core 族 + Harness 族组件。`ChatView` 集成 `AIEventBus` 提供事件上下文。
- **Vite 分包**：`manualChunks` 配置（ai-core-family / ai-harness-family / ai-registry）。
- **测试套件**：新增 `Tests/AIComponents/` 目录，6 个测试文件、117 个测试用例，ai-components 覆盖率 82%+。

#### 已知事项
- `realAgentCallTest.ts` 需要重写为 Electron IPC 测试脚本。
- Loop/Memory/MultiAgent 族组件待 Phase 2 实现。
- 后端 Result 类型存在预存 TypeScript 错误（非本次变更引入）。

### 2026-09-15 — 四项前端体验修复

#### 问题 1：聊着聊着就不干活了（Loop 提前退出）
- **根因**：`iterationController.decideIteration` 中，当模型产生文本输出但无工具调用时，立即以 `success` 退出循环。在对话场景中，模型可能先输出中间文本（如"好的，我先看看文件"），随后才调用工具，过早退出导致 Agent 停止工作。
- **修复**：移除 `hasOutput && !hadToolCall → success` 的提前退出条件。循环仅在 `max_iterations` / `budget_exhausted` / `no_progress`（连续 5 轮无输出无工具）时自然终止。
- **文件**：`Src/Core/Loop/iterationController.ts`

#### 问题 2：不能选择工作区（工作方式）
- **根因**：Composer 组件缺少工作方式选择器，用户无法在聊天界面切换工作方式。
- **修复**：Composer 新增工作方式下拉选择器（7 种模式），选中后随消息发送至后端。
- **文件**：`Client/src/components/Chat/Composer.tsx`、`Client/src/views/ChatView.tsx`、`Client/src/stores/chatStore.ts`

#### 问题 3：首个请求不会自动给会话起名
- **根因**：创建会话时标题默认为 "New Chat"，后端无自动命名逻辑。
- **修复**：`wsHandler.tryAutoNameSession` — 首次助手回复完成后，检查会话标题是否仍为 "New Chat"，若是则取首条用户消息前 40 字符作为标题。同时新增 `PATCH /api/sessions/:id` 端点和 `updateSessionTitle` 导出函数。
- **文件**：`Src/Interface/WebSocket/wsHandler.ts`、`Src/Interface/RestApi/chatApi.ts`

#### 问题 4：不能切换同源供应商的模型
- **根因**：`startStreamGeneration` 硬编码使用 `routing.defaultModel`，前端无模型选择 UI。
- **修复**：
  - 后端：`generate_reply` 支持可选 `model` 参数，优先使用客户端指定模型（未注册则回退默认）；新增 `GET /api/models` 端点返回已注册模型列表。
  - 前端：Composer 新增模型下拉选择器，展示所有已注册模型（显示短名 + 供应商），选中后随消息发送。
- **文件**：`Src/Interface/WebSocket/wsHandler.ts`、`Src/Interface/RestApi/chatApi.ts`、`Client/src/components/Chat/Composer.tsx`、`Client/src/views/ChatView.tsx`、`Client/src/stores/chatStore.ts`、`Client/src/services/api.ts`

### 2026-09-15 — Agent 迭代行为与工具调用前端显示修复

#### 问题
- 前端无法显示 Agent 迭代轮次和工具调用/结果信息

#### 根因
- 后端 `wsHandler.startStreamGeneration` 仅发布 `AGENT_STREAM_CHUNK`（文本）和 `AGENT_STREAM_END` 事件
- `LoopExecutionResult` 中的 `iterations[].toolCalls` / `toolResults` 从未推送到前端

#### 修复
- **后端** `eventTypes.ts`：新增 `AGENT_ITERATION_COMPLETE` 事件类型
- **后端** `wsHandler.ts`：`executeLoop` 完成后，遍历每次迭代发布工具调用/结果事件
- **前端** `shared/eventTypes.ts`：同步新增事件常量
- **前端** `chatStore.ts`：`ChatMessage` 新增 `toolCalls` / `totalIterations` 字段；新增 `applyIterationComplete` 方法合并工具调用与结果
- **前端** `useWebSocket.ts`：处理 `AGENT_ITERATION_COMPLETE` 事件
- **前端** `MessageBubble.tsx`：新增工具调用区块渲染（可折叠，显示名称/参数/结果/错误状态）+ 迭代轮次显示

#### 涉及文件
- `Src/Services/EventBus/eventTypes.ts`
- `Src/Interface/WebSocket/wsHandler.ts`
- `Client/src/shared/eventTypes.ts`
- `Client/src/stores/chatStore.ts`
- `Client/src/hooks/useWebSocket.ts`
- `Client/src/components/Chat/MessageBubble.tsx`

### 2026-09-15 — 对话页卡片化重构（v2：正方形 Agent 卡片 + 侧栏布局）

#### 新增
- **`Conversation` / `AgentCard` 类型**：对话（conversation_id → agents 一对多）+ L1 级 Agent 卡片数据模型
- **`ConversationCard`** 组件：正方形 Agent 卡片（aspect-ratio: 1/1），显示工作方式徽章、Bot 图标、标题、会话 ID、时间戳
- **`ConversationSidebar`** 组件：右侧纵向对话列表（长条型），显示对话标题、Agent 数量、相对时间、状态圆点
- **`ChatView` 三栏布局**：顶部标题栏 + 左侧主区域（Agent 卡片横排 + 聊天区）+ 右侧对话列表

#### 变更
- **`chatStore` 重构**：新增 `conversations`、`activeConversationId`、`activeAgentSessionId` 状态；新增 `setActiveConversation`、`setActiveAgent` 操作
- **`ConversationGrid` 重写**：从递进放缩网格改为 Agent 卡片横向排列区
- **`ChatView` 重写**：移除旧版网格态/展开态双态布局，改为左侧主区域 + 右侧对话列表布局
- **`index.css` 重写**：替换旧版卡片网格样式为新的布局 / 正方形卡片 / 侧栏样式

#### 涉及文件
- `Client/src/stores/chatStore.ts`（类型扩展 + 状态重构）
- `Client/src/components/Chat/ConversationCard.tsx`（重写为正方形 Agent 卡片）
- `Client/src/components/Chat/ConversationGrid.tsx`（重写为 Agent 卡片横排区）
- `Client/src/components/Chat/ConversationSidebar.tsx`（新增 — 右侧纵向对话列表）
- `Client/src/views/ChatView.tsx`（重写为三栏布局）
- `Client/src/index.css`（样式重写）

### 2026-09-15 — 中间件类型契约下沉至 Infra 共享内核

#### 重构
- **中间件类型契约下沉**：将 `AgentMiddleware`、`MiddlewareContext`、`ModelCallInput/Output`、`ToolCallInput/Output`、六钩子函数类型、`HookFunction`、`MiddlewareHook` 从 `Core/Middleware/types.ts` 整体迁移至 `Src/Infra/Contracts/middlewareTypes.ts`，作为单一真相源；原文件已删除
- **消除 6 处 Services → Core 类型级反向依赖**：`Services/LoopControl/middleware/` 下 6 个中间件实现（toolSafetyGate、stopRuleEvaluator、goalReanchorControl、fingerprintDetectorControl、budgetSentinelControl、checkpointWriter）全部改为从 `Infra/Contracts/middlewareTypes.js` 导入，满足五层单向依赖红线
- **Core 内部消费方重指向**：`middlewareRegistry.ts`、`index.ts`、4 个 builtin 中间件、`runIteration.ts` 共 7 处改为从 Infra 契约导入
- **测试消费方重指向**：`Tests/Runtime/runtime.spec.ts` 改为从 Infra 契约导入

#### 新增
- **`Src/Infra/Contracts/`** 目录：跨层共享内核契约存放处（纯类型、零运行时、零上层 import）
- **`Src/Infra/Contracts/middlewareTypes.ts`**：中间件类型契约单一真相源
- **`Src/Infra/Contracts/index.ts`**：桶文件聚合导出
- **`ADR/0006-middleware-contract-relocated-to-infra.md`**：记录契约下沉决策、被否方案与适用边界

#### 删除
- **`Src/Core/Middleware/types.ts`**：已迁移至 Infra/Contracts，不保留 re-export shim

#### 设计文档同步
- `Docs/02-核心架构/核心架构设计.md` §2 目录骨架：Infra 下补 `Contracts/`；Core/Middleware 注明引擎实现在此、类型契约见 Infra/Contracts；ADR 目录补 0006

#### 已知遗留（独立跟进）
- `Services/Recruitment/recruiter.ts` 与 `Services/ReviewerAgent/reviewerAgent.ts` 存在对 `Core/AgentRuntime/*` 的运行时级 Services→Core 反向依赖，需依赖倒置方案单独治理
- ESLint `import/no-restricted-paths` 因 resolver 加载异常当前无法实际执行层间门禁校验

### 2026-09-15 — Agent 权限模型与工具可见性修复

#### 新增
- **`getVisibleToolsForRole()`**：按 `requiredRoles` 主门禁过滤工具集，L0 治理级兜底可见所有非 FORBIDDEN 工具
- **`ROLE_FORBIDDEN` 硬校验**：`executeTool()` 执行前校验调用者角色是否在工具 `requiredRoles` 白名单中
- **`unregisterMiddleware()`**：中间件注册表支持按名称注销
- **`getOrCreateEntryAgent()`**：wsHandler 幂等创建入口 Agent（prime_director），多次请求不重复创建
- **`MiddlewareContext.agentRole`**：中间件上下文新增调用者角色字段
- **集成测试** `agentPermissionSplit.spec.ts`：12 项测试覆盖三级信任模型的工具可见性与执行门禁

#### 变更
- **信任模型重划**（三级）：
  - L0 治理级：`regulator`、`auditor`、`arbitrator` — 监管、审计、仲裁，最高权限
  - L1 入口级：`prime_director`、`partner` — 接收用户输入、递归派发子 Agent、协作
  - L2 执行子级：`worker`、`reviewer`、`assembly_node` — 仅执行上级派发任务
- **`UserRole` 类型统一**：从 `Infra/types.ts` 单一真相源导出，消除 `AgentRole`(4值) 与 `UserRole`(8值) 的类型分裂
- **主循环 ④ 上下文装配**：由 `getAllToolSpecs()` 改为 `getVisibleToolsForRole(role)`，仅将当前角色可见工具传给模型
- **toolSafetyGate 挂载**：在 `executeLoop()` 入口注册、退出时注销，Loop 实例级生命周期
- **工具 `requiredRoles` 更新**：`agentRecruiter`、`shellRunner`、`codeSandbox` 补入 `partner`
- **wsHandler 入口角色**：由硬编码 `agentRole: 'worker'` 改为 `prime_director`

#### 修复
- 入口 Agent 不存在问题：所有用户请求不再降级为 worker 身份
- 工具可见性未按角色裁剪问题：模型现在只看到当前角色有权使用的工具
- `requiredRoles` 仅在模型侧软过滤、运行时无硬校验问题：现在 `executeTool()` 执行前做角色白名单校验

#### 涉及文件
- `Src/Infra/types.ts`、`Src/Infra/Security/trustLevels.ts`
- `Src/Core/AgentRuntime/types.ts`、`Src/Core/AgentRuntime/agentFactory.ts`
- `Src/Core/Loop/runIteration.ts`
- `Src/Core/Middleware/types.ts`、`Src/Core/Middleware/middlewareRegistry.ts`
- `Src/Tools/Factory/toolFactory.ts`、`Src/Tools/Registry/toolRegistry.ts`
- `Src/Tools/Traits/toolSpec.ts`
- `Src/Tools/Custom/agentRecruiter.ts`、`Src/Tools/Builtin/Execute/shellRunner.ts`、`Src/Tools/Builtin/Execute/codeSandbox.ts`
- `Src/Interface/WebSocket/wsHandler.ts`
- `Configs/security.json`、`Src/main.ts`
- `Tests/Infra/security.spec.ts`、`Tests/Tools/tool.spec.ts`
- `Tests/Integration/agentPermissionSplit.spec.ts`（新增）

#### 设计文档同步
- `Docs/02-核心架构/核心架构设计.md` §3.2 角色与工具权限模型
- `Docs/03-Agent能力模型/Agent能力模型.md` §递归派发与角色模型
- `Docs/11-配置体系与安全/配置体系与安全设计.md` §3.2 信任分级表
- `Docs/15-参数总典与接口约束/参数总典.md`

#### 已知事项
- WS chunk 事件推送路由（事件总线 → WebSocket 客户端）存在预存问题，与本次权限模型修改无关
- `agent.recruit` 工具当前仅声明角色白名单，实际递归派发逻辑待后续实现