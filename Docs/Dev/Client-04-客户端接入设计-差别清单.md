# Client/04 客户端接入账号与同步 — 文档-代码差别清单

> 审查日期 2026-10-03 · 审查基准：当前工作区代码（含未提交改动）
>
> 审查对象：`Docs/Client/04-客户端接入账号与同步/客户端接入设计.md`
> 代码真源：`Client/src/`（stores/accountStore.ts、services/syncService.ts、services/serverApi.ts、services/secureStore.ts、services/ipcApi.ts、services/api.ts、views/AccountPanel.tsx、views/Auth/LoginPage.tsx、stores/prefsStore.ts、stores/configStore.ts）、`electron/`（main.ts、preload.ts）、`Src/`（Interface/RestApi/syncApi.ts、memoryApi.ts、Interface/IpcBridge/ipcBridge.ts、Services/SharedMemory/longTermMemory(Store).ts、Services/AccountScope/activeAccount.ts、Infra/Db/migrations.ts）、`Server/src/`（routes、services、repositories、security、config、migrations）

## 摘要

| 分类 | 计数 |
|---|---|
| 文档过时 | 6 |
| 代码未实现 | 1 |
| 声明错误 | 2 |
| 需人工裁定 | 3 |
| **合计** | **12** |

**总体判断**：文档主体（令牌 safeStorage、401 单飞续期、重试队列、同步编排、统计口径 FE-027、跨账号隔离 FE-032、验证码加固、设备策略 warn 默认）与代码高度一致，§11 C1"自动后台同步为下一轮"**仍然成立**（未发现任何自动上行/防抖实现）。主要脱节集中在三处：① 代码在 10-03 已把同步范围扩展到"配置 overrides + 任务元数据"，文档 §1/§5/接口清单未跟进；② 客户端设备解绑/会话吊销调 **POST** 而服务端只注册 **DELETE**（文档 §12.3 自述"✅ 自助解绑"端到端实际不可用，服务端测试已覆盖 DELETE、客户端测试 mock fetch 检测不到）；③ 设备凭据仅在验证码登录路径发送，密码登录/注册完全绕过设备策略，文档 §12.3 表述覆盖过宽。另有 SV-001 服务端已修复但文档 §11 C5 仍写"静默截断"、§9 测试表计数过时等。

## 差别清单

| 编号 | 文档章节 | 文档声明 | 代码实态(文件:行) | 分类 | 建议处理 |
|---|---|---|---|---|---|
| C4-01 | §1 范围 / §5.1 / §5.2 | 同步数据为"应用偏好 + 长时记忆 + 个人统计"三项；接口清单只列 PUT/GET /v1/settings、POST /v1/memories/bulk、GET /v1/memories、POST /v1/stats/events | 代码已新增两类同步数据：① 配置 overrides（push `settings.data.config` / pull `applyFromCloud`）`Client/src/services/syncService.ts:333-337,401-418`；② 任务元数据（`POST /v1/tasks/bulk`、`GET /v1/tasks?archived=all`，归档状态对齐；服务端 `Server/src/routes/tasks.ts:21-33`、`Server/migrations/005_user_tasks.sql`；备份包亦含 tasks `Server/src/services/backupService.ts:122-137`）；两端点均存在 | 文档过时 | 更新 §1 范围表、§5.1/§5.2 表格补"配置 overrides、任务元数据（仅标题/归档态，正文不上传）"两行；§1 明确不做清单相应修订 |
| C4-02 | §7 UI / §12.3 自助恢复 | "设备可单独吊销 ✅""DELETE /v1/me/devices/:deviceId 移除（界面移除按钮）" | 服务端仅注册 DELETE（`Server/src/routes/auth.ts:123`、`Server/src/routes/me.ts:40`；测试按 DELETE 验证 `Server/test/integration/verificationCode.spec.ts:227-245`）；客户端却用 **POST** 调用同一批路径：`Client/src/stores/accountStore.ts:565`（revokeDevice）、`Client/src/stores/accountStore.ts:576`（revokeSession）→ 真实服务端将 404（无 POST 别名，`Server/src/app.ts` 无 method-override）。客户端测试 mock fetch（`Tests/Client/account-store.spec.ts:56`）掩盖该缺陷 | 需人工裁定 | 高优先级修复客户端改 DELETE（或补 serverDelete）；文档在修复前不应标"✅ 自助解绑"可用；建议加一条端到端断言防回归 |
| C4-03 | §12.3 设备身份 | "设备凭据（安装期随机串…）**登录时随请求发送**；服务端只存 sha256(credential)"；strict 模式拒绝未登记设备 | 仅验证码登录路径随发 deviceId/deviceCredential（`Client/src/stores/accountStore.ts:486-501`）；密码 `login`/`register` 只带 deviceLabel（同文件 :424-441）。服务端设备登记与 off/warn/strict 校验**只存在于 loginWithCode**（`Server/src/services/authService.ts:550-588`），login(:203)/register(:184) 无任何设备处理 → 密码登录完全绕过设备策略，user_devices 不增长 | 代码未实现 | 密码路径补发设备凭据并在服务端 login/register 应用同一策略；或文档明确"设备策略仅覆盖验证码登录路径"并登记缺陷 |
| C4-04 | §11 C5 / §8 | "服务端导出 10 000 条**静默截断**（SV-001），客户端暂无法感知不完整" | SV-001 服务端已修复：默认键集分页**全量导出、无上限**，显式 statsLimit 才截断且包内 `truncated.stats` 如实标注（`Server/src/services/backupService.ts:72-112,181-185`；`Server/src/routes/backup.ts:20-44`）。客户端类型已声明 `truncated?`（`Client/src/services/syncService.ts:507-508`）但 UI 未展示（AccountPanel/accountStore 无 truncated 引用） | 文档过时 | C5 改为"服务端已全量导出；客户端尚未向用户展示 truncated 告警"；同步更新服务端缺陷清单 SV-001 状态 |
| C4-05 | §9 测试 | 测试表：longTermMemoryPersistence 6 / syncApi 8 / server-api 12 / account-store 9 / sync-service 12，合计 47 项 | 实测 it() 数：6 / **13** / 12 / **11** / **13** = 55（`Tests/Interface/syncApi.spec.ts` 等）；且 4 个后续新增相关 spec 未入表：login-flow.spec.ts(7)、prefs-account-scope.spec.ts(6)、longTermMemoryOwnership.spec.ts(6)、ownerScope.spec.ts(4) | 文档过时 | 重列测试表并纳入 FE-027/FE-031/FE-032/FE-033 修复配套用例；"整体 958 项全绿"为运行态口径本次未复跑（见 C4-12） |
| C4-06 | §12.6 缺陷编号 | "FE-031（两套鉴权并存，**部分修复**）" | 已合并为单 store：`Client/src/stores/accountStore.ts:15-17`（"本 store 是账号唯一真源（FE-031 合并）：验证码登录不再有独立 store"）；LoginPage 直接调用 `sendCode/loginWithCode`（`Client/src/views/Auth/LoginPage.tsx:18,36-37`）；验证码路径登录成功后自动 pull（accountStore.ts:514） | 文档过时 | FE-031 改"已修复"，或在缺陷清单说明残留范围 |
| C4-07 | §4 架构/§3 数据流 | 本地数据访问为 `fetch /api/sync/stats-events、/api/memory/long-term`；组件清单 = AccountPanel/accountStore/prefsStore/syncService/serverApi/api.ts | Electron 下实际**IPC 直连优先、HTTP 降级**（`Client/src/services/syncService.ts:22,186-191,235-241,261-274`；处理器 `Src/Interface/IpcBridge/ipcBridge.ts:372,406,526,544,564,598`；桥 `Client/src/services/ipcApi.ts`）；新组件 secureStore.ts、ipcApi.ts、views/Auth/LoginPage.tsx 未出现在架构图 | 文档过时 | §3 图补 IPC 通道与 secureStore/LoginPage；说明浏览器模式才走 HTTP |
| C4-08 | §5.3 冲突与失败 | "网络类失败（NETWORK/TIMEOUT）入重试队列；**4xx（校验/权限等）不入队**（重试无意义）" | 入队判定额外包含 `SESSION_EXPIRED`（`Client/src/stores/accountStore.ts:247`），该错误由刷新失败产生、HTTP 语义即 401（serverApi.ts:304-309）→ 与"4xx 不入队"矛盾；未登录状态下重试必然再次失败 | 声明错误 | 裁定二选一：文档补"会话过期除外"，或代码剔除 SESSION_EXPIRED（倾向后者，重新登录后已有自动 pull） |
| C4-09 | §5.4 统计派生 | 三类来源口径表未提属主过滤（10-03 前口径） | 三个来源查询已全部 `WHERE owner_user_id = ?`（`Src/Interface/RestApi/syncApi.ts:69,115,133,163,169`），列由迁移 v22 添加（`Src/Infra/Db/migrations.ts:394-406`）；§12.4 已述但 §5.4 未回写 | 文档过时 | §5.4 表格加一句"全部按当前属主分区（FE-032），未登录=local" |
| C4-10 | §6 字段映射 | "assertion 仅 observed 可入本地，**故恒为 observed**" | `writeMemory` 确实只收 observed（`Src/Services/SharedMemory/longTermMemory.ts:83-84`），但云端恢复 `importMemories` 不做 observed 过滤、原样落库（同文件 :172-194），上行映射也放行 inferred/verified/disputed（`Client/src/services/syncService.ts:128`）→ pull 含非 observed 断言的云端记忆后，"恒为 observed"不成立 | 声明错误 | 文档改"本地写入仅 observed；云端导入透传枚举值"；或在 importMemories 统一回落 observed |
| C4-11 | §11 C1 / §1 "明确不做" | 无后台自动同步：登录后自动拉取 + 手动上传 | 核实一致：push 触发点仅面板手动按钮与冲突"以本机为准"（`Client/src/views/AccountPanel.tsx:301,367`），全仓无防抖/定时自动上行；仅有网络失败 30s 单次自动重试队列（accountStore.ts:260-266，与 §5.3 一致）。**该"下一轮"声明尚未过期** | 需人工裁定 | 无需改动；若做 C1 注意已存在的 dirty 标记（prefsStore/configStore）可直接作为变更信号 |
| C4-12 | §10 端到端验证 / §9 "958 项全绿" | 真实 Electron+服务端+PostgreSQL 全链路验证记录、项目整体测试全绿 | 运行态声明，静态审查无法复现/复跑（本次未执行测试与端到端）；且 §10 ⑤"统计 35 条=chat.turn 31+tool.call 4"发生在 FE-027 修复前，token.consumed=0 未解释是否当时库中无流水 | 需人工裁定 | 下轮 FE-027 口径上线后重跑一次端到端并更新记录；测试总数以最近一次 CI 输出为准 |

## 未发现差异的抽查项

以下关键项逐一核实过、与文档一致（置信度参考）：

- **令牌 safeStorage 实存实用**：主进程 `safeStorage.encryptString/decryptString` 密文写 `userData/secure-store.json`（`electron/main.ts:186-250`，IPC 通道 `secure-store-available/get/set/remove`）；渲染进程经桥读写（`Client/src/services/secureStore.ts:30-96`），令牌键 `civitas.account.tokens` 仅存模块级变量、不进 zustand/localStorage（`Client/src/stores/accountStore.ts:131-133,205-220`）；非 Electron 降级 sessionStorage 且 UI 明示"仅本会话"（secureStore.ts:56-84、AccountPanel.tsx:182-186）。设备凭据 `civitas.device.id/credential` 同样落 safeStorage（accountStore.ts:149-192）。
- **主进程转发 server-fetch**：`ipcMain.handle('server-fetch')` Node fetch（`electron/main.ts:144-162`）、preload 暴露（`electron/preload.ts:26`）、serverApi 传输层选择主进程/原生 fetch 降级（`Client/src/services/serverApi.ts:135-169`）；服务端默认不注册 CORS，仅 `CORS_ORIGINS` 非空才启用（`Server/src/app.ts:134-137`、`Server/src/config.ts:202`）。
- **401 自动续期 + 单飞 + TOKEN_REUSED**：TOKEN_EXPIRED/401-UNAUTHENTICATED → 刷新后重试一次（serverApi.ts:282-317）；并发单飞（:263-277）；FATAL_AUTH_CODES 含 TOKEN_REUSED → onAuthLost 清空登录态并提示（serverApi.ts:254、accountStore.ts:341-352）；鉴权钩子 store 创建时注入一次（accountStore.ts:322-353），与 §4 全同。
- **init() 启动拉取恢复**：读 localStorage 地址 + await 探测 safeStorage → 恢复令牌 → `GET /v1/me` 校验 → 失败回落匿名（accountStore.ts:375-400）；由左栏 FeatureList 挂载触发（`Client/src/components/Layout/LeftPanel/FeatureList.tsx:62-69`）；入口「账号→个人信息」渲染 AccountPanel（`Client/src/components/Layout/MainContainer/FeatureView.tsx:137`）；登录态指示点绿/灰+悬停显示邮箱（FeatureList.tsx:115-119），均与 §4/§7 一致。
- **§5.4 统计口径（FE-027）一致**：`tool.call` 以 `ai_events` 的 `agent:tool_call_result` 为主源（覆盖只读工具），与 `effect_journal` 精确配对（`tool_call_id`，迁移 v25 `Src/Infra/Db/migrations.ts:567-571`；旧数据 180s 时间近似兜底），配对沿用 `eff:<effect_id>`、无 effect 用 `tool:<event_id>`，不重复计数；每源 limit+1 判截断、只取 `occurredAt<=now`、表缺失降级空结果（`Src/Interface/RestApi/syncApi.ts:148-256`）。
- **§12.4 三道闸**：服务端仓储按令牌 `sub` 过滤、按 ID 访问他人资源 404（`Server/src/services/memoryService.ts:74,89,95` 等）；本地 `long_term_memory` 复合主键 `(owner_user_id, memory_id)`（迁移 v21 `Src/Infra/Db/migrations.ts:344-384`），未登录=`local`（`Src/Services/AccountScope/activeAccount.ts:20-33`），`GET/PUT /api/account/active-user` 存在且客户端登录/登出时切换（`Src/Interface/RestApi/memoryApi.ts:198-219`、accountStore.ts:278-313）；`civitas.sync.meta.userId`、旧数据无 userId 一律按换账号处理（`Client/src/stores/prefsStore.ts:36-56,124-138`）。
- **§12.5 验证码加固**：sha256 存储（迁移 003 已 DROP 明文 code 列 `Server/migrations/003_auth_hardening.sql:13-17`）、`crypto.randomInt(100000,1000000)`、`timingSafeEqual`、一次性+新码作废旧码、attempts≥5 作废（`Server/src/repositories/verificationCodes.ts:13-50`、`Server/src/services/authService.ts:503-515`）、配额 3/600s、冷却 60s、`ALLOW_DEV_CODE` 与 devCode 仅非生产、生产无 `MAIL_WEBHOOK_URL` 拒绝启动（`Server/src/config.ts:179-260`）、webhook 投递（`Server/src/services/mailTransport.ts:27-36`）——逐项一致。
- **§12.3 设备策略本身**：`DEVICE_BINDING_MODE` off/warn/strict 默认 warn；warn 记 `auth.new_device` 审计并放行；strict 拒绝未登记设备但**首个设备放行**；服务端存 `sha256(credential)`（`Server/src/services/authService.ts:550-588`、`Server/src/repositories/users.ts:135-190`、`Server/src/config.ts:178`）；硬件指纹降级为展示标签（accountStore.ts:194-203，`wmic` 仍在 `Src/Infra/Security/deviceFingerprint.ts` 但不再参与身份）。
- **§2 长时记忆落库修复**：写穿 upsert、`hydrateLongTermMemory()` 回灌并把计数器推到 `max(ltm-N)+1`、`persistAccess/persistStatus`、`importMemories()` 幂等+计数器同步（`Src/Services/SharedMemory/longTermMemory.ts:54,88,134-194,217`），`Src/main.ts:158-161` 步骤 ⑦.2 挂载。
- **§5.1/§5.2 既有三项语义**：PUT /v1/settings 带 expectedRevision、409 REVISION_MISMATCH 附 `currentRevision`（`Server/src/http/errors.ts:33,96`；面板"以云端为准/以本机为准" `AccountPanel.tsx:362-369`）；记忆批 500 ≤ 服务端 `MAX_MEMORIES_PER_BULK=1000`（`Server/src/config.ts:199`、`memoryService.ts:99`）；记忆下行键集分页 50 页×200（syncService.ts:304-318）；统计分批 ≤500 成功后推进 `statsSyncSince`（syncService.ts:441-467）；测试连接走 /healthz+/readyz（accountStore.ts:412-420）。
- **§8 防枚举/限流**：auth 端点更严 IP 桶（`Server/src/app.ts:116-130`、迁移 004）、统一失败文案 + `fakeVerify()` 等价耗时（`Server/src/services/authService.ts:206,490`）。
- **§7 导出/导入**：Blob+`<a download>`（AccountPanel.tsx:126-135）、导入 JSON→merge(默认)/replace→POST /v1/restore→自动 pull（accountStore.ts:637-648）；C6"未接原生另存为"核实属实（无 showSaveDialog）。

---

## 回写记录（2026-10-03）

已逐条重新核实并回写 `Docs/Client/04-客户端接入账号与同步/客户端接入设计.md`：回写 8、跳过 1（C4-11 结论仍成立）、【需人工裁定】登记 4（C4-02/08/10/12）、清单外新发现回写 4 处（SV-002 已修、init 双触发等）、未处理 0。32 处"2026-10-03 校准"。
