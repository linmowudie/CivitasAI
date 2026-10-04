# Server/02 使用指南 — 文档-实态差别清单

> 审查日期 2026-10-03 · 审查基准：当前工作区（含未提交改动）
> 范围：`Docs/Server/02-使用指南/` 下 quickStart.md、configuration.md、fullGuide.md、troubleshooting.md
> 方法：逐条命令/路径/键名/端口用 `git status`、`ls`、`grep`、`package.json`、`Configs/*.json`、`Src/**`、`Scripts/**`、`Client/**` 核实；未修改任何被审文件。

## 摘要

| 分类 | 计数 | 说明 |
|------|------|------|
| 【声明错误】 | 15 | 文档给出的命令、键名、数值、类型签名与代码/配置实态**直接矛盾**，照做会失败或得出错误结论 |
| 【文档过时】 | 9 | 重构/删 WS/加脚本后文档未跟进；多为遗漏与未指向现成能力 |
| 【需人工裁定】 | 11 | 实态本身存在冲突或半接线状态（重复配置键、遗留 `ws` 依赖、浏览器模式能力缺失、守恒告警未发射、跨平台命令），需产品/工程先定权威口径 |
| 合计 | **35** | 分节：quickStart 8 / configuration 10 / fullGuide 5 / troubleshooting 12；抽查通过（无差异）项另列 22 条，见末节 |

**总体判断**：四份文档的"骨架"仍与工程一致（五层结构、十步迭代、四区间预算、8 角色、Prompts/Data/db 路径、WS 已删除的说明），说明近期做过一轮校准。但**操作层已实质性失真**：

1. **quickStart 的安装与启动流程在干净克隆上跑不通**——`Client/` 是独立 npm 工程（`Client/package.json` + `Client/node_modules`，根 `package.json` 无 `workspaces`），单靠根 `npm install` 起不了 Vite；"生产模式 `npm run build` + `npm run start`" 名不副实（`build` 只做类型检查，不产出 `dist/`）。
2. **configuration.md 的三层覆盖模型是错的**——它把"环境变量 > 本地覆盖"写成有效层级；实态是环境变量**不参与**层级竞争（`Src/Infra/Config/configLoader.ts:7`），而 `local.json` 的覆盖会在 `configLoader.ts:95-114` 被 11 个功能 JSON 无条件回覆盖（该 bug 已在 `Configs/README.md:32` 自认，但使用指南仍按"可用"宣传）。三个 `CIVITAS_HTTP_PORT/WS_PORT/LOG_LEVEL` 在 `Src/` 全无消费者。
3. **fullGuide 的角色信任级表与工具开发示例是"能误导人写错代码"的级别**——4 个角色级别与 `Src/Infra/Security/trustLevels.ts:132-143` + `Configs/security.json:3-7` 相反；`ToolDefinition` 示例缺 `spec` 包裹层，照抄无法编译也无法通过 Registry 校验。
4. **troubleshooting 的处置建议部分指向不存在的配置项**——`memory.json → maxEntries` 无此键、`loopConfig.json` 里的审批超时不存在（实为 `security.json:approvalTimeoutSec`）、`llmLatency` 日志指标不存在、注入检测阈值不可配（硬编码正则）；同时全文未引用 `Scripts/` 已有诊断能力。

优先修复顺序建议：**先修 quickStart 的安装与启动链（阻断干净克隆首次跑通）→ 再修 configuration.md §2 覆盖模型与 troubleshooting 的键名指向（避免用户改无效文件、误判已生效）→ 最后修 fullGuide 两张表（污染扩展开发）**；同时由工程侧先裁定三处"双头配置/遗留物"（`approvalTimeoutSec` 重复键、`wsPort` + `ws` 依赖遗留、`local.json` 回覆盖缺陷）。

---

## 1. quickStart.md

| 编号 | 章节 | 文档声明 | 实态(文件:行) | 分类 | 建议处理 |
|------|------|---------|--------------|------|---------|
| QS-1 | 安装 | `git clone` → `cd CivitasAI` → `npm install` 即完成安装 | `Client/` 为独立 npm 工程（`Client/package.json` 含 vite/@vitejs/plugin-react/tailwindcss；`Client/package-lock.json`、`Client/node_modules` 独立存在），根 `package.json:1-143` 无 `workspaces`、无 `postinstall`，而 `dev` 脚本执行 `cd Client && npx vite`（`package.json:17`） | 【声明错误】 | 安装步骤补 `cd Client && npm install && cd ..`（或把 Client 纳入 npm workspaces 后改脚本），否则 `npm run dev` 在干净克隆上直接失败 |
| QS-2 | 启动 | "或生产模式：`npm run build` → `npm run start`" | `build` = `tsc --noEmit && npm run typecheck:electron`（`package.json:11`），仅类型检查、**不产出任何 dist**；`start` = `tsx Src/main.ts`（`package.json:15`），从源码运行。真正的产物构建是 `build:server`（`Scripts/build.cjs` → `dist/main/`）与 `build:client`（→ `dist/renderer/`） | 【声明错误】 | 把"生产模式"改写为 `npm run build:all` + `npm run start:electron`；`npm run build` 更名为语义准确的"校验（typecheck）"或加注"不产出可运行产物" |
| QS-3 | 启动/前端 | 称"前端界面：经 Electron 壳（`preload.ts` 的 IPC 桥接）与后端通信"，但全文未给任何 Electron 启动命令 | `package.json:16,19,35` 提供 `start:electron`（`electron .`，入口 `dist/main/electron/main.js`）、`dev:electron`（先 `build:server` 再起 vite + electron）、`electron:dev` 别名；`npm run dev` 不含 Electron | 【文档过时】 | 增加"桌面模式"小节列 `npm run dev:electron` / `npm run start:electron`，并说明 `start:electron` 前必须先 `build:server` |
| QS-4 | 启动/前端 | "开发模式亦可由 Vite 提供 `http://localhost:5173`"（暗示浏览器模式功能等价） | 浏览器（非 Electron）下 `send()` 走降级分支并**静默丢弃命令**：`Client/src/services/eventBusBridge.ts:72-80`（`console.warn('[eventBusBridge] 浏览器模式下 send 不可用，命令已忽略')`）；`isElectron()` 判据为 `window.electronAPI?.onBackendEvent`（同文件 `:35-37`） | 【需人工裁定】 | 先裁定浏览器模式定位（只读观测 vs 完整操作）。若维持现状，文档须写明"浏览器模式仅可观测，发起任务/审批须 Electron 壳" |
| QS-5 | 常见问题·端口冲突 | "默认端口 3000（REST）/5173（Vite）被占用时，修改 `Configs/default.json` 中的端口配置" | `default.json` 仅有 `server.httpPort: 3000`（`:12`）；`5173` 在 `default.json` 中只出现在 `server.corsOrigins`（`:14`，是 CORS 白名单不是端口）；真实 Vite 端口在 `Client/vite.config.ts:40`，且 `strictPort: true`（`:41`）冲突即硬失败 | 【声明错误】 | 拆分表述：3000 改 `Configs/default.json → server.httpPort`；5173 改 `Client/vite.config.ts → server.port`（并提示 `strictPort`）；如改 3000 需同步 `vite.config.ts:42-44` 的 proxy target 与 `corsOrigins` |
| QS-6 | 启动/常见问题 | "`wsPort: 3001` 为历史遗留配置（2026-09-28 已删除 WebSocket，无实际 WS 服务）" | 结论正确：`Src/` 已无 `WebSocketServer`/`from 'ws'` 任何引用，改为 `Src/Interface/IpcBridge/ipcBridge.ts:4`。但遗留未清：`package.json:104` 仍依赖 `ws@^8.21.3`、`Scripts/build.cjs:41-42` 仍将 `ws` 列为 external、`Scripts/wsDiagnose.cjs` 仍在（`Scripts/README.md:12` 称其"模拟前端 WS 行为"）、`configValidator.ts:52-54` 仍强制 `server.wsPort` 为整数（**用户删掉该键会 FATAL**） | 【需人工裁定】 | 裁定一次性清理（移除 `ws` 依赖 + `wsDiagnose.cjs` + validator 的 `wsPort` 校验）或在文档加"请勿删除 `wsPort` 键，校验器仍要求其为整数" |
| QS-7 | 前置要求 | "Node.js ≥ 20.0.0、npm ≥ 10" | Node 约束属实（`package.json:7-9` `engines.node: ">=20.0.0"`）；npm ≥ 10 无 `engines.npm` 也无 `packageManager` 字段，属纯口头约定；`Scripts/install.sh:14-24` 也只打印版本、不校验 | 【需人工裁定】 | 要么补 `"engines": {"npm": ">=10"}` + `packageManager` 使声明可强制，要么文档降级为"建议 npm ≥ 10" |
| QS-8 | 安装 | 未提及任何一键安装方式 | `Scripts/install.sh` / `Scripts/install.ps1` 已存在并做 6 步（node/npm 检查、`npm install`、`cp .env.example .env`、`mkdir -p Data/{Cache,...,db,Hooks} Logs`、`tsc --noEmit`）；`Scripts/README.md:14` 已登记 | 【文档过时】 | 安装节补一行"或执行 `bash Scripts/install.sh` / `.\Scripts\install.ps1`"；同时注意脚本尾部也写着"访问 http://localhost:5173 查看界面"，与 QS-4 同源问题需一起改 |

## 2. configuration.md

| 编号 | 章节 | 文档声明 | 实态(文件:行) | 分类 | 建议处理 |
|------|------|---------|--------------|------|---------|
| CF-1 | §1 配置文件体系 | 表格列出 14 个配置文件 | `Configs/` 实有 **15** 个 JSON（多 `dataStorage.json`，七类数据保留期/上限/清理策略）；`Configs/README.md:3,24` 已按 15 个登记。另：`configLoader.ts:88-93` 的 `extraConfigs` 仅加载 11 个文件，`dataStorage.json`/`coverageBaseline.json`/`benchBaseline.json` **不进入 merged 配置** | 【文档过时】 | 表格补 `dataStorage.json` 行，并注明"仅 `dataStorage` 目录约定用途，不由 configLoader 加载"（若属应接线项则另立工程 TODO） |
| CF-2 | §2 配置优先级 | `环境变量 > 本地覆盖 > 配置文件 > 默认值` | 两处不符：(a) `configLoader.ts:7` 明确"环境变量仅解析 `api_key_ref: "env:XXX"` 引用，**不参与层级竞争**"，全文无 `process.env` 覆盖 merged 的代码；(b) `local.json` 虽在 `configLoader.ts:72-82` 参与三层合并，但 `:95-114` 随后把 11 个功能 JSON `deepMerge(merged[key], 文件值)` **反向覆盖**回 merged，故 local.json 对 `loopDefaults/stopRules/supervision/security/...` 等所有功能顶层键的覆盖被静默吃掉；仅 `default.json` 独有的 `system/server/database/ui` 段可被 local 覆盖。该缺陷已由 `Configs/README.md:32` 自认 | 【声明错误】 | 文档改为如实描述："当前只有 `default.json` 段可被 local 覆盖；功能文件同名键 local 覆盖失效（已知缺陷）"，并挂修复工单：把 extra 合并顺序调整为 `default < {env} < local(功能键)` |
| CF-3 | §2 与 §4 | "环境变量格式：`CIVITAS_` 前缀 + 大写键名（如 `CIVITAS_LOG_LEVEL=debug`）"；§4 列 `CIVITAS_LOG_LEVEL` / `CIVITAS_HTTP_PORT` / `CIVITAS_WS_PORT` | 全仓 `Src/` + `electron/` 实际消费的仅：`CIVITAS_ENV`（`configLoader.ts:53`）、`CIVITAS_DATA_DIR/LOG_DIR/CONFIG_DIR/PROMPTS_DIR/SKILLS_DIR`（`Src/Infra/Fs/pathResolver.ts:8-12,27,58,72,82,90`）、`CIVITAS_PORTABLE`（`:23`，由 `electron/main.ts:40-44` 注入）。上述三个 `LOG_LEVEL/HTTP_PORT/WS_PORT` **零引用**，端口只读 `config.server.httpPort`（`Src/main.ts:361`），日志级别只读 `system.logLevel`（`Src/main.ts:77`） | 【声明错误】 | §2/§4 改写为"环境变量只用于目录重定向与 `env:` 取值；日志级别/端口须改 `Configs/default.json`"，并给出真实可用变量清单 |
| CF-4 | §4 环境变量 | 代码块列出 4 个变量并称"详见 `.env.example`" | `.env.example` 全文仅 6 行、只有 `HUAWEI_MAAS_API_KEY`（`F:\ProjectCode\CivitasAI\.env.example`），未含任何 `CIVITAS_*` | 【文档过时】 | 二选一：把可用 `CIVITAS_*`（ENV/DATA_DIR/LOG_DIR/CONFIG_DIR/PROMPTS_DIR/SKILLS_DIR）补进 `.env.example`，或删除"详见"指向并就地给清单 |
| CF-5 | §3.4 调整监管阈值 | 示例片段顶层写 `rateLimit`，注释"maxRequestsPerMinute: 30 // **默认 60**" | 实态需 `supervision` 包层：`Configs/supervision.json:2,18-23` → `supervision.rateLimit.maxRequestsPerMinute = 30`（即"默认"就是 30，注释的 60 无出处）；消费点 `Src/main.ts:252-260`（另有 `supervision.apiRateLimit.maxRequestsPerMinute = 600`，`Configs/supervision.json:24-26` 文档未提） | 【声明错误】 | 片段补 `"supervision": { ... }` 外层；注释改"当前 30"；补 `apiRateLimit`（UI 侧 HTTP 限流）与两者用途区分（见 `main.ts:250-251` 注释） |
| CF-6 | §1 表 | `memory.json` = "共享记忆配置（**容量**、**衰减率**）" | `Configs/memory.json` 无任何容量/衰减键，实际键为 `conflictSimilarityThreshold / capsuleBudgetTokens / capsuleMemoryTopK / capsuleRecentOpsCount / capsuleMessageBudgetTokens / longTermConsolidationDelayMs / privateStateTtlSec / vectorDim / supersedeGraceSec`，外加 `eventBus` 段；且 `memory.*` 在 `Src/` 中**无一处读取**（`Src/Services/SharedMemory/*` 无相关 getConfigValue 调用） | 【声明错误】 | 描述改"胶囊记忆预算/相似度阈值/向量维度 + 事件总线参数"，并标注"当前多为登记未接线键" |
| CF-7 | §1 表 | `session.json` = "会话参数（**超时**、最大消息数）" | 无超时键（实为 `sessionKeyHexLength / archiveInactiveDays / historyMaxMessagesInMemory` + `retention.*`，`Configs/session.json:2-7`）；三个 session 键在 `Src/` 无读取点（grep 命中 0）；`retention.*` 同样未见消费 | 【声明错误】 | 改描述为"会话归档/保留期参数"，并加"当前未接线"提示或补工程 TODO |
| CF-8 | §3.2 调整角色参数 | 示例仅示范可覆盖键，未给约束 | `configValidator.ts:108-121` 对 roleOverrides 强制白名单，只允许 `max_iterations / token_budget / temperature`，其他键直接判错；角色键必须与 8 角色一一对应且禁止未知键（`:91-106`） | 【文档过时】 | 补一句硬约束说明（可覆盖键白名单 + 角色集合固定），避免用户加 `timeout_ms` 等键后启动失败 |
| CF-9 | §2 | "`modelRouter.json` 中的 `env:XXX` 引用会自动从 `.env` 读取" | 结论可用但机制与文档不同：`configLoader.ts:85` 的 `resolveEnvReferences` 在 extra 合并（`:95-114`）**之前**执行，故 modelRouter.json 里的 `env:` 从未经由它解析；真正生效的是启动时 `Src/main.ts:65` `process.loadEnvFile('.env')` + `Src/Infra/Llm/Provider/providerBase.ts:185-200` 自行解析 `env:`/`inline:` 前缀 | 【需人工裁定】 | 文档补"仅 `api_key_ref` 一类引用被 Provider 层解析"；工程侧宜把 `resolveEnvReferences` 调用移到 extra 合并之后，使任意 `env:` 键一致生效 |
| CF-10 | 全文（缺项） | 未提示"改配置须重启生效" | `Src/Infra/Watcher/configWatcher.ts` 扫描逻辑为注释桩，`startWatching/onConfigChange` 无调用者；`Configs/README.md:28-30` 已注明"当前不存在真正的运行期热重载" | 【文档过时】 | §2 末补"热重载现状"小节，明确 L0/L2 分级未接线、改动需重启 |

## 3. fullGuide.md

| 编号 | 章节 | 文档声明 | 实态(文件:行) | 分类 | 建议处理 |
|------|------|---------|--------------|------|---------|
| FG-1 | §2.2 Agent 角色表 | 信任级别：Prime Director **L0**、Worker **L1**、Reviewer **L1**、Assembly Node **L1**（Partner L1、治理三权 L0 正确） | `Src/Infra/Security/trustLevels.ts:10-11,132-143`：L0 = `regulator/auditor/arbitrator`；**L1 入口级 = `prime_director/partner`**；**L2 外部级 = `worker/reviewer/assembly_node`**。由 `Configs/security.json:3-7` 的 `systemRoles/userRoles/externalRoles` 驱动，值与代码默认完全一致。即 8 行里 4 行错 | 【声明错误】 | 按 `security.json` 重写该表为三级（L0 治理 / L1 入口 / L2 外部），并补权限后果（`trustLevels.ts:195-204`：L1 只能执行 SAFE/CONTROLLED，L0 除 FORBIDDEN 外皆可） |
| FG-2 | §4.1 创建自定义工具 | 示例 `export const myTool: ToolDefinition = { name, version, dangerLevel, idempotency, reversibility, sideEffectScope, execute: async (ctx) => {...} }` | 类型实态：`ToolDefinition = { spec: ToolSpec, execute: ToolExecutor }`（`Src/Tools/Traits/toolSpec.ts:198-201`），`name/version/dangerLevel/...` 属 `spec` 内字段；`execute` 签名为 `(input, context) => Promise<ToolResult>`（`:188-193`）；`spec` 另**必填** `description / inputSchema / outputSchema / requiredRoles / sandboxMode / timeoutMs`（`:53-84`，注释"缺一字段则 Registry 拒注"）。示例照抄既不过 `tsc` 也不能注册。真实写法见 `Src/Tools/Custom/agentRecruiter.ts:39-45`（`export const agentRecruiter: ToolDefinition = { spec: {...} ...`） | 【声明错误】 | 用仓库真实工具作模板重写示例（含 `spec` 包裹、六个必填安全字段、`(input, context)` 签名），或直接链接 `Src/Tools/Custom/agentRecruiter.ts` 为参考实现 |
| FG-3 | §4.2 工具危险分级 | 表格定义 SAFE/CONTROLLED/DANGEROUS/FORBIDDEN 四级及执行约束 | 枚举与约束成立（`trustLevels.ts:35`；`FORBIDDEN` 系统拒绝 `:195,203-204`；DANGEROUS 建审批 `Src/Services/LoopControl/middleware/toolSafetyGate.ts:141-142`）。但文档未提两条实态约束：(a) `dangerLevel` 还受调用者信任级二次裁剪（L1 不可用 DANGEROUS，即便审批通过）；(b) `Configs/security.json:19-23` 存在 `autoApprove.tools` 白名单，命中即**跳过人工确认自动执行**，与"需 ApprovalGate"表述相反 | 【需人工裁定】 | 补"信任级 × 危险级"矩阵小节；`autoApprove` 是否该出现在对外指南请裁定（涉安全语义，建议明示并加风险注记） |
| FG-4 | §1 架构概览 | "Interface 层：HTTP 接口 + Electron IPC 桥接，接收用户输入" | 组件属实（`Src/Interface/WebServer/httpServer.ts` 绑 `server.httpPort`、`Src/Interface/IpcBridge/ipcBridge.ts`）。但"接收用户输入"在非 Electron 浏览器下不完整成立——命令通道被丢弃（详见 QS-4 的 `eventBusBridge.ts:72-80`） | 【需人工裁定】 | 与 QS-4 一并裁定：Interface 层描述补一句"命令通道当前以 IPC 为准，浏览器侧仅 REST 查询" |
| FG-5 | §2.4 Verifier 四级验证 | "L1 硬验证 → L2 规则验证 → L3 LLM Judge → L4 人类审批门" | 四级实现齐备（`Src/Services/LoopControl/verifier/`：`hardVerifier.ts / ruleVerifier.ts / llmJudge.ts / humanGateCore.ts / antiGaming.ts`）。但文档未提"通过判据不是四级全跑"：`Configs/loopConfig.json:48-53` `minLevelsRequired: 2`、`l3MinAgreementWithHuman: 0.85`、`l3CalibrationDataset: Tests/GoldenSets/review-50` | 【需人工裁定】 | 补"最少通过级数 + L3 校准数据集与重校准周期（`l3RecalibrateIntervalDay: 90`，脚本 `Scripts/rubricRecalibrate.ts`）"，避免读者按"四级全过"理解 |

## 4. troubleshooting.md

| 编号 | 章节 | 文档声明 | 实态(文件:行) | 分类 | 建议处理 |
|------|------|---------|--------------|------|---------|
| TS-1 | 1.1 症状 | 症状串 `[FATAL] 配置加载失败: ...` | 抛错文本为 `配置加载失败: ...`（`Src/main.ts:71`），但用户实际看到的行是 `[FATAL] 启动失败: Error: 配置加载失败: ...`（统一 catch 于 `Src/main.ts:384-386`） | 【文档过时】 | 症状串改为用户真实可见的 `[FATAL] 启动失败:`，并注明子串用于定位 |
| TS-2 | 1.2 解决 | `rm Data/db/civitas_*.db*` 后重启自动重建 | 文件名与通配命中正确（`Data/db/` 实有 `civitas_main.db`、`civitas_events.db`、`civitas_memory.db` 各带 `-shm`/`-wal`，共 9 个文件）；`rm` 为 POSIX/PowerShell 语义，**cmd.exe 不可用**，而仓库同时提供 `Scripts/install.sh` 与 `install.ps1`（跨平台意图明确）。另：未提示必须先停进程（WAL 句柄占用会致删除失败），也未给"保留数据先备份"选项；`Data/` 整体被 `.gitignore:12` 忽略，删了不可从 git 恢复 | 【需人工裁定】 | 按平台分列（bash / PowerShell `Remove-Item` / cmd `del`），加"先停机 + 先备份 + -wal/-shm 会随主库重建"三句 |
| TS-3 | 1.3 解决 | `netstat -ano \| findstr :3000` | 仅 Windows 可用；Linux/macOS 应为 `ss -lntp` / `lsof -i :3000`。项目定位含跨平台安装脚本（`Scripts/install.sh`），文档单一 OS | 【需人工裁定】 | 同 TS-2：命令按 OS 分列，或改为"用你平台的端口查询命令"并给两条示例 |
| TS-4 | 1.3 解决 | "或修改配置：`Configs/default.json → server.httpPort` 改为其他端口" | 键路径正确（`Configs/default.json:12`，消费 `Src/main.ts:361`）。但同文件 `server.wsPort`（`:13`）**不可删除**：`configValidator.ts:52-54` 要求其为整数，删键即 FATAL；改端口后 `server.corsOrigins`（`:14`）与 `Client/vite.config.ts:42-44` 的 proxy target 需同步 | 【文档过时】 | 加"保留 wsPort 键（校验器仍要求整数）"与"同步 corsOrigins + Vite proxy"两条注意 |
| TS-5 | 2.4 审批门超时 | "调整 **`loopConfig.json`** 中审批超时时间" | `loopConfig.json` 无任何审批超时键（全文件 87 行，见 `Configs/loopConfig.json`）。生效链：`Configs/security.json:18 approvalTimeoutSec: 300` → `Src/main.ts:120` → `toolSafetyGate.ts:141`（未配置时兜底 60，`:43`）。`Configs/supervision.json:15-16` 另有 `approvalTimeoutSec: 60` 与 `approvalDefaultOnTimeout: "reject"`，**两者在 `Src/` 全无消费者**（`approvalDefaultOnTimeout` grep 命中 0；实态 `toolSafetyGate.ts:142` 硬编码 `defaultOnTimeout: 'reject'`） | 【声明错误】 | 文件名改 `Configs/security.json → security.approvalTimeoutSec`；"默认拒绝"表述可保留但注明"由 `toolSafetyGate` 硬编码，非配置项" |
| TS-6 | 2.4 关联（同 TS-5 根因） | 未提示 supervision.json 与 security.json 存在同名审批键冲突 | 同上：`supervision.approvalTimeoutSec(60)` 与 `security.approvalTimeoutSec(300)` 并存，只有后者生效，实际生效值是 **300s** 而非用户可能预期的 60s | 【需人工裁定】 | 请裁定权威键（建议保留 `security.*` 并删 `supervision.*` 的 approvalTimeout/approvalDefaultOnTimeout，或接线后者），文档在此之前先注明"以 security.json 为准" |
| TS-7 | 3.1 响应缓慢 | "检查 LLM 调用延迟（日志中的 **`llmLatency`** 指标）" | 全仓 `Src/`、`Scripts/` 无 `llmLatency` 字段或字符串；日志行固定字段为 `timestamp/epochMs/level/track/message/traceId/spanId/operationId/source/data`（`Src/Infra/Logging/logger.ts:190-200`）。存在的是离线压测脚本 `Scripts/llmLatency.cjs`（`Scripts/README.md:13`：实测华为云 MaaS 各模型流式首响延迟） | 【声明错误】 | 改为"用 `node Scripts/llmLatency.cjs` 实测模型首响延迟"，或删除该指标名并列日志真实字段 |
| TS-8 | 3.2 内存占用 | "检查共享记忆容量（`memory.json → maxEntries`）"、"检查事件队列大小（`maxQueueSize`）" | `Configs/memory.json` **无 `maxEntries` 键**（见 CF-6），且 `memory.*` 全部无消费者；`eventBus.maxQueueSize` 虽在 `memory.json:14` 存在，但 EventBus 初始化是硬编码：`Src/main.ts:350 initEventBus({ maxQueueSize: 10000 })`，模块默认亦 10000（`Src/Services/EventBus/eventBus.ts:25,31`）→ 改配置不生效。真实 `maxEntries` 属三个**内置默认值、不可配**的缓存：`promptCache.ts:46`(100)、`toolResultCache.ts:38`(200)、`archiveManager.ts:38`(1000) | 【声明错误】 | 删/改两条：明确"事件队列 10000 为硬编码，需改 `main.ts:350`"；把 `maxEntries` 指向缓存模块（并说明当前不可经 JSON 配置） |
| TS-9 | 4.1 注入检测 | "日志中出现 `INJECTION_DETECTED` **事件**" | `EventType` 枚举无该值（`Src/Services/EventBus/eventTypes.ts:11` 起，全枚举无 INJECTION 项）；真实产出是 `runPreSupervision` 返回体的 `rejectReason: 'PROMPT_INJECTION_DETECTED'` 与 `injectionDetected: true`（`Src/Services/Supervision/preSupervision.ts:70-77`）；`Configs/security.json:24-27` 的 `INJECTION_DETECTED` 只是 `criticalSecurityEvents` 标签字符串。`Tests/Experiments/adversarial/security.spec.ts:5` 已明确注记"security.json 的 INJECTION_DETECTED 等仅为配置标签" | 【声明错误】 | 表述改"前置监管以 `rejectReason=PROMPT_INJECTION_DETECTED` 拒绝该输入（无独立事件类型）" |
| TS-10 | 4.1 注入检测 | "如为误报，调整 `supervision.json` 中的**检测阈值**" | `supervision.json` 无注入检测相关阈值键（全文 29 行，只有 qualityThreshold/限流/审批/风暴熔断等）；检测规则为**硬编码 5 条正则** `INJECTION_PATTERNS`（`preSupervision.ts:56-62`），当前无任何配置化入口，误报只能改代码 | 【声明错误】 | 改"误报须修改 `Src/Services/Supervision/preSupervision.ts` 的 INJECTION_PATTERNS（暂无配置项）"，或立工程 TODO 做可配化后再回填文档 |
| TS-11 | 4.2 Token 守恒异常 | "审计局报告守恒验证失败"，处理仅"检查 Loop / 查看审计日志 / 必要时重启" | 守恒校验本身存在（`Src/Services/TokenEconomy/tokenLedger.ts:43-62`、`walletManager.ts:253`），但**告警链未接线**：`EventType.LEDGER_MISMATCH = 'token:ledger_mismatch'` 已定义（`Src/Services/EventBus/eventTypes.ts:48`），全仓却无任何发射点（grep 仅命中枚举定义与 `tokenLedger.ts:6` 的"异常时广播"注释），实际只 `return err('LEDGER_MISMATCH #…')`（`:62`）。故"报告/告警"当前不存在，用户按文档去日志里找该事件必然找不到 | 【需人工裁定】 | 文档先改为"守恒失败目前以 `verifyLedgerConservation` 返回值的 `LEDGER_MISMATCH` 文本呈现，无事件广播"；并立工程 TODO 把 `EventType.LEDGER_MISMATCH` 真正发到 EventBus，回填后再补"搜索 `token:ledger_mismatch`" + `node Scripts/dbPeek.cjs` + `tsx Scripts/traceAnalysis.ts` 的排查指路 |
| TS-12 | 全文（能力缺口） | 故障处置仅给 `node -e "JSON.parse(...)"` 一条自证命令 | `Scripts/` 已有针对性诊断能力（`Scripts/README.md:10-14`）：`dbPeek.cjs`（看某会话最近消息）、`dupCheck.cjs`（后端是否对同一 chunk 双推）、`llmLatency.cjs`（模型首响延迟）、`traceAnalysis.ts`（Trace 回放）、`experimentMatrix.cjs`（实验矩阵守门）。四份文档零引用；其中 `wsDiagnose.cjs` 针对已删除的 WS 通道（见 QS-6），照文档去用必然失败 | 【文档过时】 | troubleshooting 各节末尾加"可用诊断脚本"指路；同步废弃/改造 `wsDiagnose.cjs` 与其 README 条目 |

---

## 5. 未发现差异的抽查项（已逐条核实为真）

quickStart
1. `engines.node: ">=20.0.0"`（`package.json:7-9`）与"前置要求 Node ≥ 20.0.0"一致。
2. `npm install` / `npm test`（`vitest run`）/ `npm run lint`（`eslint Src/ --ext .ts`）/ `npx tsc --noEmit` 四条命令均可执行，且 `lint` 与 `typecheck` 与 CI 步骤一致（`.github/workflows/ci.yml:19-22,53-54`：`npm ci` → `npm run lint` → `npx tsc --noEmit` → `npm run typecheck:electron`）。
3. `cp .env.example .env` 可行：`.env.example` 存在且只需填 `HUAWEI_MAAS_API_KEY`；运行期由 `Src/main.ts:65 process.loadEnvFile(resolve('.env'))` 加载。
4. "首次启动自动创建 SQLite（`Data/db/`），无需手动操作"成立：`Src/Infra/Db/database.ts:131 mkdirSync(dir, {recursive:true})`。
5. "WebSocket 已删除（2026-09-28），现为 Electron IPC 桥接 + REST(:3000)"结论成立：`Src/` 无 WS 服务端引用，`Src/Interface/IpcBridge/ipcBridge.ts:4` 注明替代原 wsGateway/wsServer/wsHandler（遗留物另见 QS-6）。

configuration
6. §3.1 `loopDefaults.token_budget` 默认 100000、`stopRules.budget.softRatio 0.6 / hardRatio 1.0` 与 `Configs/loopConfig.json:7,34-37` 一致。
7. §3.2 `roleOverrides.worker` 的"默认"值 30 / 100000 / 0.2 与 `loopConfig.json:19`（及 `loopDefaults:4,7,6`）一致。
8. §3.3 切换 Provider 的字段名（`provider/base_url/api_key_ref/models`）与 `modelRouter.json:2-8` 及 `providerBase.ts:34`、`main.ts:206-215` 一致。
9. §1 表中 `modelRouter.json`＝"Provider、模型选择、超时"成立：超时键确在该文件的 `routing` 段（`timeoutMs 60000 / firstByteTimeoutMs 10000 / interChunkTimeoutMs 15000`，被 `main.ts:221-228` 读取）。
10. "空配置可直接启动"成立：`loadConfig` 仅强制 `default.json` 存在（`configLoader.ts:56-59`），其余功能文件全部 `existsSync` 可选（`:96`）；`config.spec.ts:23` 有"全默认值可运行"用例。

fullGuide
11. 五层目录结构与 `Src/` 实际目录一一对应（Core/Infra/Interface/Services/Tools + `main.ts`）。
12. §2.1 十步序列表述与代码枚举逐项吻合：`Src/Core/Loop/loopEngine.ts:27-31` 与 `assertStepOrder` 顺序 `:98-103`（InputReceived/PreSupervision/Middleware/ContextAssembly/LazySupervision/ModelCall/OutputParse/ToolExecute/PostSupervision/IterationDecision）。
13. §2.3 四区间百分比 warm 36% / soft 60% / expand 80% / hard 100% 与 `loopConfig.json:34-37`（`warmRatio 0.36 / softRatio 0.6 / expandRequestRatio 0.8 / hardRatio 1.0`）一致；校验器并要求严格递增（`configValidator.ts:123-124`）。
14. §4.1 目录与导入路径成立：`Src/Tools/Custom/`（`agentRecruiter.ts`、`submitForReview.ts`）存在，`../Traits/toolSpec.js` 对应 `Src/Tools/Traits/toolSpec.ts` 存在（示例内容问题见 FG-2）。
15. §5 四条 Prompts 路径与链接全部有效：`Prompts/roles/`（8 个 `{role}.md`，角色名与 8 角色集合一致）、`Prompts/system/mainLoop.md`、`Prompts/tasks/defaultTask.md`、`Prompts/versions/manifest.json`；相对链接 `../../../Prompts/README.md` 在 `Docs/Server/02-使用指南/` 分类后仍解析到仓库根 `Prompts/README.md`（未因迁移而失效）。
16. §6.1 "Logs/ 目录、JSON Lines、支持文件轮转"成立：`Src/Infra/Logging/logWriter.ts:6,243-253,265-271` 按大小 `rotateFile`（`business.log.1` 等），实测 `Logs/business.log` 每行为 JSON（含 `timestamp/level/track/message`）。
17. §6.2 `trace_id` 贯穿成立：`logger.ts:195-197` 自动注入 `traceId/spanId/operationId`（`traceContext.ts`），`loopEngine.ts:38-40` 以 `traceId` 为 Loop 一等字段。
18. §6.3 三个库名与配置、磁盘实存三方一致：`default.json:17-19` ↔ `Data/db/` 实际文件。

troubleshooting
19. 1.1 三条排查全部成立：`configLoader.ts:188-197` 任一 JSON 解析失败即 FATAL；`default.json` 缺失 FATAL（`:57-59`）；`roleOverrides` 缺任一角色即报错，8 角色白名单见 `configValidator.ts:91-100`。给出的 `node -e "JSON.parse(require('fs').readFileSync('Configs/default.json','utf8'))"` 命令在当前工作目录语义下可直接执行通过。
20. 1.2 症状串与 `Src/main.ts:140,146`、`Src/Infra/Db/database.ts:69` 抛错文本一致（仅"配置加载失败"前缀有 TS-1 的偏差）。
21. 1.4 "无可用 LLM Provider" 为真实抛错点 `Src/main.ts:232`；`base_url` 键名与 `modelRouter.json:4` 一致；API Key 键 `env:HUAWEI_MAAS_API_KEY` 与 `.env.example` 变量名闭环一致。
22. 2.1 参数与链路成立：`stopRules.noProgress.stagnationWindowRounds` 默认 3（`loopConfig.json:41` + `main.ts:305 ?? 3`），`action: switch_strategy` 与 `escalate_human` 升级语义见 `loopConfig.json:43`、`failureFeedback.sameDefectCategoryEscalateRounds: 3`（`:70`）。2.2 的 `loopDefaults.token_budget`、`context.truncationUsageRatio 0.92`（`loopConfig.json:79`）键名与默认值均正确。2.3 的"连续失败 3 次"对应 `stopRules.limits.maxConsecutiveErrors: 3`（`loopConfig.json:31`），EffectJournal `INTENT → EXECUTING` 状态名与 `Src/Infra/DurableExecution/effectJournal.ts:64,75,199,236` 一致。

---

## 回写记录（2026-10-03）

按四份指南拆两个代理并行回写，共 35 条全部处置：
- quickStart + configuration：回写 14、裁定登记 4（QS-4/6/7、CF-9）、复核纠正清单本身 5 处（start:electron 未打包行为、浏览器模式能力、示例字段不存在等）。
- fullGuide + troubleshooting：回写 11、裁定登记 6（FG-3/4、TS-2/3/6/11）、未处理 0。
