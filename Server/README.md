# Civitas-AI 服务端（`Server/`）

账号与数据服务：**账户登录、设置管理、个人数据统计、记忆存储、一键备份/恢复**。

设计目标是「**删掉软件也不丢数据**」：所有需要跨设备/跨重装保留的数据都存在服务端，
客户端（Electron）只保留缓存；用户重装后用同一账号登录即可拿回全部数据。

> 这是一个**独立 npm 包**，依赖不进入 Electron 打包（避免把 fastify/pg 塞进安装包）。
> 它跑在**你自己的机器或服务器**上（自托管），与桌面端进程内的本地服务（`:3000`）互不影响。
>
> 📐 **设计文档**（架构选型、数据模型、鉴权/同步/备份语义、失败模式与演进路线）：
> [`Docs/Server/01-服务端/服务端设计文档.md`](../Docs/Server/01-服务端/服务端设计文档.md)。本文件偏**使用与运维**。

---

## 1. 快速开始

### 1.1 启动数据库（Docker，推荐）

```bash
cd Server
npm install
npm run db:up            # docker compose：postgres:16，端口 5432，卷 civitas_pgdata
cp .env.example .env     # 按需修改；至少要确认 DATABASE_URL
```

### 1.2 没有 Docker？用本机 PostgreSQL

```bash
# 初始化一个独立集群（示例端口 55432，不干扰已有实例）
initdb -D ./pgdata -U postgres --auth=trust --encoding=UTF8 --no-locale
pg_ctl -D ./pgdata -o "-p 55432 -c listen_addresses=127.0.0.1" -l ./pg.log start
createdb -h 127.0.0.1 -p 55432 -U postgres civitas_server

# 然后在 .env 中设置：
# DATABASE_URL=postgres://postgres@127.0.0.1:55432/civitas_server
```

### 1.3 建表并启动

```bash
npm run migrate          # 执行 migrations/*.sql（幂等；重复执行安全）
npm run migrate:status   # 查看已应用/待执行
npm run dev              # 开发模式（tsx watch）
npm start                # 直接启动
```

启动后：

```bash
curl http://127.0.0.1:8787/healthz
# {"ok":true,"data":{"status":"ok","uptimeSec":3}}
curl http://127.0.0.1:8787/readyz
# {"ok":true,"data":{"status":"ready","db":"up"}}
```

### 1.4 跑测试

```bash
npm test                 # 单元 + 集成（集成需要可用数据库）
npm run test:unit        # 仅单元测试（无需数据库）
npm run test:integration # 仅集成测试
```

集成测试使用独立库（默认 `civitas_server_test`，可用 `TEST_DATABASE_URL` 覆盖）：

```bash
createdb -h 127.0.0.1 -p 5432 -U civitas civitas_server_test
npm run test:integration
```

> 数据库不可用时，集成测试会**自动跳过并打印提示**，不会让 `npm test` 变红。

---

## 2. 配置（`.env`）

服务端启动时读取 `Server/.env`（真实环境变量优先），全部字段见 `.env.example`。

| 变量 | 默认 | 说明 |
|---|---|---|
| `NODE_ENV` | `development` | `production` 时会做更严格的安全校验 |
| `HOST` / `PORT` | `127.0.0.1` / `8787` | 监听地址与端口（对外提供服务用 `0.0.0.0`） |
| `DATABASE_URL` | — | **必填**，`postgres://` 连接串 |
| `DB_POOL_MAX` 等 | 10 / 30000 / 5000 / 15000 | 连接池上限、空闲、连接、语句超时（ms） |
| `JWT_SECRET` | 开发用默认值 | 访问令牌签名密钥；**生产必须 ≥32 字符随机值**，否则拒绝启动 |
| `ACCESS_TOKEN_TTL_SEC` | `900` | 访问令牌有效期（秒） |
| `REFRESH_TOKEN_TTL_DAYS` | `30` | 刷新令牌有效期（天）——决定"重装后多久内可免登录恢复" |
| `ALLOW_REFRESH_REUSE` | `false` | `false` 时每次刷新轮换令牌，旧令牌再用即视为盗用并吊销整族 |
| `RATE_LIMIT_AUTH_PER_MIN` | `20` | 鉴权接口每 IP 每分钟上限 |
| `RATE_LIMIT_STORE` | `memory`（生产默认 `postgres`） | 限流计数存储：`postgres` 时多实例共享同一份计数（SV-003），避免阈值 ×实例数 |
| `RATE_LIMIT_API_PER_MIN` | `240` | 其他接口每 IP 每分钟上限 |
| `RATE_LIMIT_WRITE_PER_MIN` | `120` | 每用户每分钟写操作上限 |
| `BODY_LIMIT_BYTES` | `1048576` | 请求体上限 |
| `MAX_SETTINGS_BYTES` | `262144` | 单个用户设置 JSON 体积上限 |
| `MAX_MEMORIES_PER_BULK` | `1000` | 批量上传记忆条数上限 |
| `MAX_STATS_EVENTS_PER_BATCH` | `500` | 单次上报事件条数上限 |
| `STATS_TIMEZONE` | `UTC` | 统计按日分桶所用时区（如 `Asia/Shanghai`） |
| `CORS_ORIGINS` | 空 | 逗号分隔；浏览器客户端才需要（Electron 直连可留空） |
| `TRUST_PROXY` | `false` | 位于可信反向代理之后时开启，使 `req.ip` 取 `X-Forwarded-For` |
| `LOG_LEVEL` | `info` | 日志级别（密码/令牌字段已做脱敏） |

**生成密钥：**

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

---

## 3. 接口一览

统一响应约定（与桌面端一致）：

```jsonc
// 成功
{ "ok": true, "data": { /* ... */ } }
// 失败
{ "ok": false, "error": { "code": "VALIDATION_ERROR", "message": "…", "details": { } } }
```

鉴权：除 `/healthz`、`/readyz`、`/v1/auth/register|login|refresh` 外，均需
`Authorization: Bearer <accessToken>`。

### 3.1 账户

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/auth/register` | 注册（`email` / `password` / `displayName?` / `deviceLabel?`），返回用户 + 令牌 |
| POST | `/v1/auth/login` | 登录，返回用户 + 令牌 |
| POST | `/v1/auth/refresh` | 用 `refreshToken` 换新令牌（**轮换**；重用旧令牌 → `TOKEN_REUSED` 并吊销整族） |
| POST | `/v1/auth/logout` | `{ refreshToken }` 单设备登出；`{ allDevices: true }` 全部登出 |
| POST | `/v1/auth/change-password` | 改密（需当前密码）；成功后吊销其他设备会话并换发当前设备令牌 |
| GET | `/v1/me` | 当前用户资料 |
| PATCH | `/v1/me` | 修改 `displayName` |
| GET | `/v1/me/sessions` | 登录设备（活跃会话）列表 |
| DELETE | `/v1/me/sessions/:sessionId` | 按设备登出 |
| GET | `/v1/me/audit` | 登录/安全审计记录 |
| DELETE | `/v1/me` | **注销账号**（需密码确认；级联删除设置/记忆/统计/令牌） |

### 3.2 设置

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/settings` | 读取（`revision` + `data`；无记录时 `revision=0`、`data={}`） |
| PUT | `/v1/settings` | 整体替换：`{ data, expectedRevision? }` |
| PATCH | `/v1/settings` | 浅合并：`{ patch, expectedRevision? }`；值为 `null` 表示删除该键 |
| DELETE | `/v1/settings` | 重置为默认 |

`revision` 每次写入递增，可用于乐观并发：`expectedRevision` 不匹配 → `409 REVISION_MISMATCH`
（错误体带 `currentRevision`，客户端拉取最新后重试）。

### 3.3 个人数据统计

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/stats/events` | 批量上报：`{ events: [{ kind, value?, occurredAt, clientEventId?, meta? }] }`；`clientEventId` 幂等 |
| GET | `/v1/stats/summary?from&to` | 区间汇总（总数、合计值、活跃天数、按种类） |
| GET | `/v1/stats/daily?from&to&kind` | 按日曲线（按 `STATS_TIMEZONE` 分桶） |
| GET | `/v1/stats/overview` | 个人中心概览（终身统计 + 记忆数 + 设置版本 + 活跃设备） |
| DELETE | `/v1/stats/events` | 清空统计 |

`from`/`to` 为 ISO 8601（含时区），缺省为最近 30 天。

### 3.4 记忆存储

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/memories?limit&cursor&category&status&q` | 列表（键集分页；`q` 中文走 ILIKE、拉丁走全文检索） |
| GET | `/v1/memories/:id` | 详情（含软删除的墓碑记录） |
| POST | `/v1/memories` | 新建或按 `clientMemoryId` **幂等 upsert**（新建 201 / 更新 200） |
| PATCH | `/v1/memories/:id` | 局部更新（内容、分类、状态、访问计数等） |
| DELETE | `/v1/memories/:id` | 默认软删除（保留墓碑，便于多端同步）；`?hard=true` 物理删除 |
| POST | `/v1/memories/bulk` | 批量 upsert：`{ items: [...] }`，返回 `created/updated` |

字段与端侧 `long_term_memory` 对齐：`title` / `content` / `category` / `assertion` /
`sourceTraceIds` / `sourceArbitrationIds` / `status` / `contradictedBy` / `accessCount` /
`createdAt` / `lastAccessedAt`。`clientMemoryId` 建议填端侧 `memory_id`，保证重装后**无损对齐**。

### 3.5 备份 / 恢复（重装重建的关键路径）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/backup?includeStats=true` | 导出完整数据包（设置 + 记忆 + 可选统计；可加 `&statsLimit=N` 限量导出，包内 `truncated` 标注） |
| GET | `/v1/backup/download` | 同上，但以附件 `civitas-backup-<时间>.json` 下载，便于用户自行保存 |
| POST | `/v1/restore` | `{ bundle, mode }` 恢复；`mode=merge`（默认）幂等合并 / `mode=replace` 清空后重建 |

备份包结构：

```jsonc
{
  "format": "civitas.backup",
  "version": 1,
  "exportedAt": "2026-10-02T10:29:10.000Z",
  "account": { "email": "…", "displayName": "…" },   // 仅提示用，不作为身份判定
  "settings": { "revision": 2, "data": { } },
  "memories": [ { "id": "…", "clientMemoryId": "local-memory-1", "title": "…", "content": "…" } ],
  "stats": { "events": [ { "kind": "chat.turn", "value": 100, "occurredAt": "…" } ] }
}
```

---

## 4. curl 全流程示例

```bash
BASE=http://127.0.0.1:8787

# 1) 注册
curl -s -X POST $BASE/v1/auth/register -H 'Content-Type: application/json' \
  -d '{"email":"me@example.com","password":"Passw0rd123","displayName":"我"}'

# 记下返回里的 data.tokens.accessToken / refreshToken
ACCESS=...

# 2) 写设置（revision 1 → 2）
curl -s -X PUT $BASE/v1/settings -H "Authorization: Bearer $ACCESS" -H 'Content-Type: application/json' \
  -d '{"data":{"theme":"dark"}}'
curl -s -X PATCH $BASE/v1/settings -H "Authorization: Bearer $ACCESS" -H 'Content-Type: application/json' \
  -d '{"patch":{"fontScale":1.15}}'

# 3) 写记忆（clientMemoryId 保证幂等）
curl -s -X POST $BASE/v1/memories -H "Authorization: Bearer $ACCESS" -H 'Content-Type: application/json' \
  -d '{"clientMemoryId":"m-1","title":"偏好","content":"用户偏好暗色主题","category":"preference"}'

# 4) 上报统计
curl -s -X POST $BASE/v1/stats/events -H "Authorization: Bearer $ACCESS" -H 'Content-Type: application/json' \
  -d '{"events":[{"kind":"chat.turn","value":120,"occurredAt":"2026-10-02T00:00:00.000Z","clientEventId":"e1"}]}'

# 5) 导出备份（用户自行保存）
curl -s $BASE/v1/backup/download?includeStats=true -H "Authorization: Bearer $ACCESS" -o backup.json

# 6) 重装后用同一账号登录，恢复
curl -s -X POST $BASE/v1/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"me@example.com","password":"Passw0rd123"}'
# 用新 accessToken：
curl -s -X POST $BASE/v1/restore -H "Authorization: Bearer $NEW_ACCESS" -H 'Content-Type: application/json' \
  -d "{\"bundle\":$(cat backup.json | jq -c .data),\"mode\":\"replace\"}"
```

---

## 5. 数据模型（PostgreSQL）

| 表 | 用途 | 关键点 |
|---|---|---|
| `users` | 账户 | 邮箱唯一性建在 `email_lower`（无需 citext 扩展）；`password_hash` 为 argon2id |
| `refresh_tokens` | 刷新令牌/登录设备 | 只存 `sha256` 哈希；`family_id` 支持"重用即吊销整族"；记录设备/IP/UA |
| `user_settings` | 设置 | `jsonb` + 单调递增 `revision` |
| `usage_events` | 统计原始事件 | `(user_id, client_event_id)` 部分唯一索引做幂等；按 `(user_id, occurred_at)` 聚合 |
| `memories` | 记忆 | 与端侧字段对齐；`(user_id, client_memory_id)` 部分唯一索引做幂等；GIN 全文索引 |
| `audit_log` | 安全审计 | 登录成功/失败、令牌重用、改密、注销等（写失败不影响主流程） |
| `schema_migrations` | 迁移记录 | 记录 checksum，已应用迁移被改动会拒绝启动 |

所有用户数据表均带 `user_id … ON DELETE CASCADE`：注销账号即彻底清除。

---

## 6. 安全设计

- **密码**：Argon2id（19 MiB / t=2 / p=1，OWASP 推荐），每用户独立盐；哈希串损坏时校验返回 `false` 而非抛错。
- **防账号枚举**：登录失败统一返回 `INVALID_CREDENTIALS`；邮箱不存在时执行等价耗时的假校验。
- **访问令牌**：JWT HS256，短期（默认 15 分钟），只放 `sub`/`sid`，不含邮箱等 PII。
- **刷新令牌**：256 位随机不透明串，服务端只存哈希；**每次刷新轮换**，旧令牌被重用 → 判定泄漏 → 吊销整个令牌家族。
- **改密**：验证当前密码；成功后吊销该用户全部会话，并为当前设备换发新令牌。
- **限流**：鉴权接口按 IP 严格限流，其他接口按 IP 粗限流，写操作按用户限流；超限返回 `429` + `Retry-After`。
- **输入校验**：所有 body/query 经 Zod 校验（含长度与枚举），错误统一为 `VALIDATION_ERROR` 并带字段路径。
- **SQL 注入**：全部使用参数化查询，无字符串拼接 SQL。
- **错误暴露**：5xx 只回 `服务器内部错误`，细节仅进日志；日志对密码/令牌字段脱敏。
- **生产 fail-closed**：`NODE_ENV=production` 下 `JWT_SECRET` 缺失或仍是示例值 → 拒绝启动。
- **迁移防漂移**：已应用迁移文件被修改 → 启动/迁移时报错（需新增迁移文件）。
- **响应头**：`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy: no-referrer`、`Cache-Control: no-store`。

---

## 7. 运维

```bash
npm run migrate           # 应用迁移（幂等）
npm run migrate:status    # 查看状态
npm run migrate -- --dry-run   # 只列出将执行的迁移
```

- **备份数据库**：`pg_dump`（整库）或使用 `/v1/backup`（按用户，可给用户自助导出）。
- **升级**：拉代码 → `npm install` → `npm run migrate` → 重启进程。迁移失败会回滚且不记录。
- **优雅退出**：收到 `SIGINT`/`SIGTERM` 时关闭 HTTP 与连接池。
- **横向扩展**：应用本身无状态（会话在 PG），可多实例；限流是**进程内**计数，多实例请换 Redis 实现（接口不变：`RateLimiter.consume`）。

---

## 8. 目录结构

```
Server/
├── migrations/            # 纯 SQL 迁移（按文件名升序执行）
│   └── 001_init.sql
├── scripts/migrate.ts     # 迁移 CLI
├── src/
│   ├── index.ts           # 入口：配置 → DB → 监听 → 优雅退出
│   ├── config.ts          # .env 解析 + Zod 校验 + 生产 fail-closed
│   ├── app.ts             # Fastify 组装：限流/错误处理/路由注册
│   ├── db/{pool,migrate}.ts
│   ├── http/{errors,respond,validate,schemas,rateLimit,authGuard}.ts
│   ├── security/{password,tokens}.ts
│   ├── repositories/      # SQL 访问层（参数化）
│   ├── services/          # 业务逻辑（鉴权/设置/统计/记忆/备份）
│   └── routes/            # HTTP 路由（鉴权 + 校验 + 响应）
└── test/
    ├── unit/              # 纯逻辑（无需数据库）
    ├── integration/       # 真 PostgreSQL（含多用户隔离、重装恢复场景）
    └── helpers/           # 测试库与应用构建助手
```

---

## 9. 已知限制与后续计划

> 缺陷与已知限制的**跟踪清单**（含根因 `文件:行`、影响面、建议修法与验收标准）：
> [`Docs/Server/01-服务端/服务端缺陷清单.md`](../Docs/Server/01-服务端/服务端缺陷清单.md)（编号 `SV-xxx`）。
> 下面列出其中影响使用决策的几条。

- **限流存储可配置**：默认进程内（单实例）；**多实例部署请设 `RATE_LIMIT_STORE=postgres`**（生产默认已是 postgres），
  否则各实例各算一份、阈值 ≈ 配置值 × 实例数（见清单 `SV-003`，已修复）。
- **统计为实时聚合**：数据量极大时建议增加日汇总表（接口无需变化）。
- **中文全文检索**：使用 `ILIKE` 兜底（PG 自带 `simple` 分词器不切分中文）；如需更好的中文检索，可接入 `pg_jieba`/`zhparser` 或外部检索服务——见清单 `SV-005`。
- **备份导出上限**：单用户导出上限 10 000 条且**静默截断**（已知缺陷，见清单 `SV-001`，重度用户请先确认条数或自行分批）。
- **改密/登出的即时性**：访问令牌无状态，TTL（默认 15 分钟）内旧令牌仍可用——见清单 `SV-002`。
- **邮件通道缺失**：邮箱验证、忘记密码尚未实现（需要 SMTP 服务）；当前注册即可用。
- **客户端接入未做**：本轮交付服务端；Electron 侧的登录界面、自动同步、冲突提示为下一轮工作（同步语义已定为**服务端权威**）。
- **无二次验证（2FA）**：可作为后续增强。
