# Server/01 服务端 — 文档-代码差别清单

> 审查日期 2026-10-03 · 审查基准：当前工作区代码（含未提交改动）
> 覆盖文档：`Docs/Server/01-服务端/服务端设计文档.md`、`Docs/Server/01-服务端/服务端缺陷清单.md`
> 比对代码：`Server/src/`（routes/services/repositories/http/security/db/config）、`Server/migrations/001–005`、`Server/test/`、`Server/package.json`、根 `package.json`

## 摘要

| 文档 | 差异条数 | 其中【文档过时】 | 【代码未实现】 | 【声明错误】 | 【需人工裁定】 |
|---|---|---|---|---|---|
| 服务端设计文档.md | 15 | 13 | 0 | 0 | 2 |
| 服务端缺陷清单.md | 7 | 3 | 0 | 1 | 3 |
| 合计 | 22 | 16 | 0 | 1 | 5 |

总体判断：**代码实现质量与文档正文高度相符**——抽查的 8 个标"🟩已修复"缺陷（SV-001/002/003/004/006/008/010/012/013）全部找到代码与测试证据，未见虚报修复；2 个标"⬜已知限制"（SV-005 ILIKE、SV-007 明文备份）与代码现状一致；技术选型（Fastify 5 / PostgreSQL / pg / Argon2id / jose HS256 / Zod / 自研迁移器）以代码为准逐条核实，**全仓无 Mongo/MySQL**。脱节集中在**文档未随后续演进刷新**：最大缺口是 `user_tasks` 表 + `/v1/tasks*` 路由 + 备份包 `tasks` 字段整条功能线（迁移 005、routes/tasks.ts、6 项测试）在设计文档中**零记载**；其次是验证码/设备绑定 4 条路由缺于 §4.3/附录 C"总表"、§7.1 与 §3.4 等处的旧结论（10 000 条截断、purge 未接线）与修复注记并存自相矛盾、测试计数停留在 82 项（实际 11 文件/118 项）。缺陷清单的"未修复"表已无任何未修复项却仍是该标题、归档表第 191 行有 "`n" 断行损坏。均为文档侧问题，不指向代码缺陷。

## 设计文档（服务端设计文档.md）差别

| 编号 | 章节 | 文档声明 | 代码实态(文件:行) | 分类 | 建议处理 |
|---|---|---|---|---|---|
| S01-D01 | §2.1 架构图 / §3.1 ER / §3.2 注 | "PostgreSQL（7 张表 + 迁移记录）"；"001_init.sql（7 张表）" | 001_init.sql 实为 6 张业务表（users/refresh_tokens/user_settings/usage_events/memories/audit_log）；加 002–005 现共 10 张业务表（+verification_codes/user_devices/rate_limit_buckets/user_tasks） | 文档过时 | 改为"10 张业务表 + schema_migrations"，ER 图补 4 表 |
| S01-D02 | §3.2 表定义 | 仅列 6 表字段定义 | `verification_codes`（002:13-33，003 加固 code_hash/attempts/DROP code）、`user_devices`（002:41-57 + 003 credential_hash/device_kind/last_seen_at）、`rate_limit_buckets`（004:13-17）、`user_tasks`（005:13-27）无定义 | 文档过时 | §3.2 增补 4 表小节或引用 002–005 |
| S01-D03 | §1.2 / §4 全节 / 附录 C | 目标①–⑥与隐私边界均无"任务元数据"；"会话与消息不上传"未提元数据例外 | `/v1/tasks`、`/v1/tasks/bulk` 已实现（routes/tasks.ts:21-34；schemas.ts:146-172；services/taskService.ts；repositories/tasks.ts；迁移 005；test/integration/tasks.spec.ts 6 项） | 文档过时 | 新增 §4.x 任务元数据节；§1.2/§5.8 补"标题+归档状态属元数据、会上行" |
| S01-D04 | §4.3 接口表 / §4.1 鉴权列 | 鉴权接口仅 11 条；免鉴权仅"register\|login\|refresh" | 代码另有免鉴权 `POST /v1/auth/send-code`（auth.ts:92）、`POST /v1/auth/login-with-code`（auth.ts:102）及需鉴权 `GET /v1/me/devices`（auth.ts:117）、`DELETE /v1/me/devices/:deviceId`（auth.ts:123），仅 §10.5 有提及，§4.3/§4.1 缺 | 文档过时 | §4.1 免鉴权清单补 2 项；§4.3 表补 4 行或加"另见 §10.5" |
| S01-D05 | 附录 C 路由总表 | 自称"总表"31 行 | 缺上述 4 条 + `/v1/tasks`、`/v1/tasks/bulk`，共缺 6 条；send-code/login-with-code 无鉴权列、tasks 无限流桶信息 | 文档过时 | 附录 C 按 app.ts 注册顺序重建 |
| S01-D06 | §4.7 / §7.1 / §7.2 | 备份包字段列表与 restore 响应不含 tasks；settings 结构未列 updatedAt | `BackupBundle.tasks?: BackupTaskDto[]`（backupService.ts:38）、导出含任务全量（backupService.ts:171-178）、restore 返回 `tasks:{created,updated,total}`（backupService.ts:289）、replace 先清 user_tasks（backupService.ts:267-269）；包内 settings 为 SettingsDto{revision,data,updatedAt}（settingsService.ts:13-22） | 文档过时 | §7.1 jsonc 补 tasks/truncated/updatedAt；§4.7 响应补 tasks 计数 |
| S01-D07 | §7.1 第 2 条 / §7.5 / §9.7 | "导出上限：记忆 10 000 条、事件 10 000 条…⚠️ 超限当前静默截断"；"单用户记忆导出上限 10 000 条" | 已按 SV-001 修复：listAllMemories 键集分页循环、pageSize 仅影响行数不影响完整性（repositories/memories.ts:336-348）；统计同样全量（backupService.ts:92-112）；同节第 1 条（615 行）已是新语义——**同文自相矛盾** | 文档过时 | 删除/改写 616-617、§7.5 首条、§9.7 依据栏的旧上限表述 |
| S01-D08 | §3.4 数据生命周期 | "过期/吊销令牌…⚠️ 当前未挂定时任务，见 §12" | SV-004 已修复：启动即扫 + 每 6h `purgeInactive(db,60)`、unref、shutdown clearInterval（index.ts:37-53）；与 §9.5/§12 P4 矛盾 | 文档过时 | §3.4 该行改为指向 §9.5 |
| S01-D09 | §2.4 技术选型 / §5.4 | 限流"选择：进程内滑动窗口…零外部依赖"；"滑动窗口 60s" | 双实现：`RATE_LIMIT_STORE=memory\|postgres`（config.ts:195,303 生产默认 postgres）、`createPostgresRateLimiter` 原子 UPSERT **固定窗口**（rateLimit.ts:97-176、迁移 004）；§2.4 未随 L1/SV-003 更新 | 文档过时 | §2.4 选择栏改"内存滑动窗口（dev/test）+ PG 固定窗口（生产默认）" |
| S01-D10 | §4.2 错误码表 / 附录 B | 13 个码，称"定义源：errors.ts 的 STATUS_BY_CODE" | errors.ts:21,37 另有 `UNAVAILABLE(503)`（§4.8 已在用），§4.2 表缺行 | 文档过时 | §4.2 补 UNAVAILABLE 行 |
| S01-D11 | §5.5 审计 action 表 | 仅 6 个 auth.* action | 代码另有 `auth.send_code`（authService.ts:434,469）、`auth.login_with_code`（:492,561,602）、`auth.register_with_code`（:540）、`auth.new_device`（:581）、`auth.revoke_device`（:416） | 文档过时 | §5.5 补 5 行 |
| S01-D12 | §10.4 / §1.3 A2/A7 | "8 个文件 / 82 项（单元 29 + 集成 53）"；A2 auth 11 项、A7 backup 7 项；且 §10.4 标题下空、证据代码块排在 §10.5 之后 | 现为 11 文件 / 118 项（unit/config 11 + unit/core 21；integration 86：auth 15、backup 9、memories 9、platform 9、rateLimitStore 6、settings 9、stats 9、tasks 6、verificationCode 14）；排版错位（823 行标题与 850 行代码块被 §10.5 隔断） | 文档过时 | 更新计数并修复小节顺序（§10.4 ↔ §10.5 内容归位） |
| S01-D13 | §9.3 / 附录 E | "当前 001_init.sql"；对账"表结构与索引 \| 001_init.sql" | migrations 实有 001–005 五个文件；checksum sha256/漂移拒绝/--status/--dry-run 均属实（db/migrate.ts:50,91-93；scripts/migrate.ts:31,39） | 文档过时 | 两处改为"Server/migrations/*.sql（当前 001–005）" |
| S01-D14 | §1.4 术语 | 访问令牌"只含 sub/sid" | JWT claims 为 `sub/sid/typ` + 标准 iat/exp（security/tokens.ts:36-38） | 文档过时 | 措辞补 typ（低严重度） |
| S01-D15 | §10.5 send-code 用途 / §4.5 | 文档未说明 purpose 参数与消费范围；统计批量上限未提硬顶 | `sendCodeSchema.purpose ∈ register\|login\|reset_password`（schemas.ts:49-52），但仅 `login` 被 `loginWithCode` 消费（authService.ts:480 硬编码 'login'）——register/reset_password 码**无消费端点**（密码找回未实现）；statsIngest 服务层 500 条（statsService.ts:53-57）之外 schema 另有硬顶 5000（schemas.ts:100） | 需人工裁定 | 明确 purpose 预留语义（文档标注"当前仅 login 生效"）或删除未用枚举；补记 5000 硬顶 |

补充（不计差异）：文首状态行"客户端接入为下一阶段，见 §12"（第 17 行）与 §12 P2 "✅ 已完成（2026-10-02）"冲突，属同文档内部两处其一未刷新，建议随 D12 一并修订。GET /v1/me 响应实际多 `boundDeviceId`（authService.ts:78），文档 §4.3 未列，随 D04 一并更新即可。

## 缺陷清单（服务端缺陷清单.md）差别

| 编号 | 章节 | 文档声明 | 代码实态(文件:行) | 分类 | 建议处理 |
|---|---|---|---|---|---|
| S01-X01 | "## 未修复"表（40-57 行） | 14 条 SV 全部列于"未修复"节下，状态却均为 🟩已修复（12 条）或 ⬜已知限制（2 条） | 无一条真正未修复；与本文件"工作流"第 3 条（修复后移入已修复归档）自相矛盾，且与"已修复归档"表重复登记 | 文档过时 | 未修复节清空/删除，已修复项只留归档表 + 详细条目 |
| S01-X02 | 已修复归档表（191 行） | — | 行内容含字面 `` `n ``（"`| 2026-10-03 |`n| SV-006 …"），SV-003 与 SV-006 两行粘连、表格断裂 | 声明错误（排版损坏） | 拆回两行、修复合成的换行符 |
| S01-X03 | SV-003 / SV-006 归档行 | SV-006 "用例 **finally** 中 DELETE FROM schema_migrations" | 清理语句在 try 块尾部（platform.spec.ts:168），finally 仅 close（:169-171）；断言若先失败仍会残留 '999' 行 | 需人工裁定 | 措辞改"用例尾部清理"，或将 DELETE 移入 finally |
| S01-X04 | 对应关系表 "L4 无邮件通道 — 功能未实现（P7 路线）" | 与设计文档 L4 "✅ 已解决"冲突 | 实态居中：投递通道已实现（mailTransport.ts + config.ts:256-258 生产未配置拒绝启动），但"邮箱验证/找回密码"功能确未实现（无消费 reset_password 码的端点） | 需人工裁定 | 两份文档统一口径："通道已落地；验证/找回功能未实现" |
| S01-X05 | SV-009 验证栏 / 多处 | "服务端 82 项"（SV-009）、"105/105 全绿"（SV-001/002/004/008） | 现 118 项（见 D12 明细）；105 为 tasks.spec 等加入前的快照 | 文档过时 | 归档类历史证据可保留，正文口径注明"截至当日" |
| S01-X06 | SV-012/013/014 详细条目 | 仅"建议修法"，无修复/验证段，状态却在表头标 🟩 | 修复证据齐备：sha256 哈希 + `randomInt` + `timingSafeEqual` + attempts 锁定（repositories/verificationCodes.ts:13,40-50,104-114；迁移 003）；`ALLOW_DEV_CODE` 双闸门（config.ts:252-254；authService.ts:477）；设备凭据 `credential_hash`/`device_kind` + 自助解绑（迁移 003、authService.ts:412-418） | 文档过时 | 补一行"修复（2026-10-02）"指向上述文件 |
| S01-X07 | 工作流第 4 条 | "文档集变更登记到 Docs/CHANGELOG.md" | Docs/CHANGELOG.md 未核验本文件登记情况（属文档流程，非代码事实） | 需人工裁定 | 由文档维护者确认登记即可，不计入代码差异 |

抽查"未修复是否被顺带修复"：**未发现漏报**——所有标 🟩 的修复均有代码与测试证据（见下节），标 ⬜ 的两项确未实现修复，无"已修未标"或"标修未修"的严重错位（X03 属机制描述偏差）。

## 未发现差异的抽查项（均有代码证据）

1. **§10.5 配置表 11 项全部吻合**：DEVICE_BINDING_MODE=warn、ALLOW_DEV_CODE=false（生产 true→拒启 config.ts:252）、CODE_TTL_SEC=300、CODE_MAX_PER_WINDOW=3/CODE_WINDOW_SEC=600、CODE_RESEND_COOLDOWN_SEC=60（0=关，nonNegativeNum）、CODE_MAX_ATTEMPTS=5、RATE_LIMIT_STORE（memory|postgres，缺省按环境 config.ts:303）、MAIL_WEBHOOK_URL/Mail fail-closed（config.ts:256）、MAIL_FROM/MAIL_TIMEOUT_MS=10000；配额+冷却+审计见 authService.ts:426-450。`.env.example` 与 §9.2/§10.5 键一致。
2. **§9.2 配置总表 22 项默认值逐项对上 config.ts:161-206**（含 BODY_LIMIT 1 MiB→413、MAX_SETTINGS 256 KiB 合并后校验 settingsService.ts:39-44、MAX_MEMORIES 1000 于 memoryService.ts:99、MAX_STATS 500 于 statsService.ts:53）。
3. **§3.2 六表列/约束/索引与 001_init.sql 逐字段一致**：email_lower UNIQUE、refresh_tokens.ip inet、部分唯一索引（usage_events:72-74、memories:102-104）、GIN tsvector（110-111）、audit_log 无 FK、CASCADE 链。
4. **接口表 §4.4/§4.5/§4.6 与路由一致**：settings GET/PUT/PATCH/DELETE 参数与 `{reset:true}`；stats 5 条路由 + `resolveRange` 缺省 30 天（routes/stats.ts:13-23）+ `{accepted,submitted}` + 413；memories 6 条路由、`{memory,created}` 201/200、`?hard=true`、bulk `{created,updated,total}`、键集游标 base64url `<createdAt>|<id>`（memories.ts:156-162）、CJK→ILIKE / 拉丁→websearch_to_tsquery（191-199）。
5. **SV-001/002/003/004/008/010 修复实据 + ★断言**：键集全量导出与 truncated 标注（backup.spec.ts:128-189，含 statsLimit=abc/0→400、download 透传）；authGuard 按 sid 回查会话（authGuard.ts:37-43，auth.spec.ts:297-324）；PG 限流器共享计数回退兜底（rateLimitStore.spec.ts:35 等 6 项）；purge 接线（index.ts:37-53，auth.spec.ts:268）；readyz 走 UNAVAILABLE 统一错误体（app.ts:145-152，platform.spec.ts:50）；invalidCredentials(message)（errors.ts:85）。
6. **L6 路由透传复核属实**：backupExportQuerySchema.statsLimit 1..100000（schemas.ts:187-193），/v1/backup 与 /v1/backup/download 两处透传（backup.ts:25-28,36-39）。
7. **技术选型以代码为准全部成立**：Node≥20/ESM、fastify ^5.2.0、pg、@node-rs/argon2（memoryCost 19456/t2/p1/32，password.ts:11-17 + fakeVerify:45）、jose HS256、zod；自研迁移器 checksum/漂移/独立事务/dry-run 属实；根 build.files 确不含 Server；**Server 代码与两份文档均无 Mongo/MySQL 痕迹**（仅 §2.4 备选栏提及 MySQL 作为弃选项，属正常表述）。
8. **安全与运维声明**：日志脱敏 paths（app.ts:76-87）、四个安全头（107-112）、CORS 条件启用（134-141）、TRUST_PROXY 默认 false、写限流 preHandler（163-174）；§9.5 与 §12 的 SV-004/SV-002"已完成"标注与代码一致；引用链接（Server/README.md、Client/04、Agent/09、Agent/10、serverApi.ts、前端验收缺陷清单.md）均存在。

---
*审查方式：逐条 grep/read 核实；未修改任何源代码与原文档。*

---

## 回写记录（2026-10-03）

两份文档分别回写：
- 服务端设计文档：S01-D01~D15 全部处置——首棒回写 §1~§7 主体（42 处标注），接力棒补正 D03/05/06/07/09/10/11/12/13/15（附录 C 31→37 行重建、§4.10 补写、UNAVAILABLE 码、5 个审计 action、§10.4/10.5 归位），跳过已完成的 D01/02/04/08/14；勘误：测试项实测 117 非清单所称 118。
- 服务端缺陷清单：S01-X01~X07 全部处置——缺陷关闭 12（SV-001~004/008~014）、仍存在 2（SV-005 ILIKE、SV-007 明文备份）、裁定登记 3。
