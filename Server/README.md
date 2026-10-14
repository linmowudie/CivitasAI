# Civitas-AI 服务端（`Server/`）

账号与数据服务：**账户登录、设置管理、个人数据统计、记忆存储、一键备份/恢复**。

设计目标是「**删掉软件也不丢数据**」：所有需要跨设备/跨重装保留的数据都存在服务端，
客户端（Electron）只保留缓存；用户重装后用同一账号登录即可拿回全部数据。

> 这是一个**独立部署的 Java 服务**（Spring Boot 3 + Maven，JDK 21+），依赖不进入 Electron 打包。
> 它跑在**你自己的机器或服务器**上（自托管），与桌面端进程内的本地服务（`:3000`）互不影响。
>
> 📐 **设计文档**（架构选型、数据模型、鉴权/同步/备份语义、失败模式与演进路线）：
> [`Docs/Server/01-服务端/服务端设计文档.md`](../Docs/Server/01-服务端/服务端设计文档.md)。本文件偏**使用与运维**。
>
> 🔁 历史上曾为 TypeScript（Fastify 5）实现，2026-10 已重写为 Java（Spring Boot 3）；
> 对外契约（路由/信封/错误码/环境变量/迁移 SQL）保持不变，旧 npm 命令对照见 §8。

---

## 1. 快速开始

### 1.1 环境要求

| 依赖 | 版本 | 说明 |
|---|---|---|
| JDK | **21+** | `pom.xml` 以 `release=21` 编译（本机验证环境：Java 23） |
| Maven | 3.9+ | 构建与测试入口 |
| PostgreSQL | 15+（或 Docker） | 数据库 |

### 1.2 启动数据库（Docker，推荐）

```bash
cd Server
docker compose up -d db  # postgres:16，端口 5432，卷 civitas_pgdata
cp .env.example .env     # 按需修改；至少要确认 DATABASE_URL
```

### 1.3 没有 Docker？用本机 PostgreSQL

```bash
# 初始化一个独立集群（示例端口 55432，不干扰已有实例）
initdb -D ./pgdata -U postgres --auth=trust --encoding=UTF8 --no-locale
pg_ctl -D ./pgdata -o "-p 55432 -c listen_addresses=127.0.0.1" -l ./pg.log start
createdb -h 127.0.0.1 -p 55432 -U postgres civitas_server

# 然后在 .env 中设置：
# DATABASE_URL=postgres://postgres@127.0.0.1:55432/civitas_server
```

### 1.4 构建、建表并启动

```bash
cd Server
mvn -DskipTests package        # 产出 target/civitas-server-0.1.0.jar

java -jar target/civitas-server-0.1.0.jar --migrate        # 执行 migrations/*.sql（幂等；重复执行安全）
java -jar target/civitas-server-0.1.0.jar --migrate-status # 查看已应用/待执行
java -jar target/civitas-server-0.1.0.jar --migrate --dry-run  # 只列出将执行的迁移

mvn spring-boot:run            # 开发模式直接启动（等价 java -jar …，无需先打包）
```

启动后：

```bash
curl http://127.0.0.1:8787/healthz
# {"ok":true,"data":{"status":"ok","uptimeSec":3}}
curl http://127.0.0.1:8787/readyz
# {"ok":true,"data":{"status":"ready","db":"up"}}
```

### 1.5 跑测试

```bash
mvn test                 # 全部测试（JUnit 5；unit + integration）
mvn test -Dtest='PlatformBasicsTest'   # 只跑指定测试类
```

集成测试使用独立库（默认 `postgres://postgres@127.0.0.1:55432/civitas_server_test`，可用 `TEST_DATABASE_URL` 覆盖）：

```bash
createdb -h 127.0.0.1 -p 5432 -U civitas civitas_server_test
TEST_DATABASE_URL=postgres://civitas@127.0.0.1:5432/civitas_server_test mvn test
```

> 数据库不可用时，集成测试会**自动跳过并打印提示**，不会让 `mvn test` 变红（与旧版口径一致）。

### 1.6 端到端验证脚本（可选）

服务运行中且 `psql` 在 PATH 上时，可跑全流程验证（注册 → 写入 → 备份 → 重装登录 → 清空 → 恢复 → 令牌重用检测 → 响应头）：

```powershell
$env:SERVER_BASE = 'http://127.0.0.1:8787'
pwsh -File scripts/verify-e2e.ps1
```

---

## 2. 配置（`.env`）

服务端启动时读取 `Server/.env`（真实环境变量优先），全部字段见 `.env.example`。

| 变量 | 默认 | 说明 |
|---|---|---|
| `NODE_ENV` | `development` | `production` 时会做更严格的安全校验（变量名为历史契约，Java 版沿用不改） |
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
| `TRUST_PROXY` | `false` | 位于可信反向代理之后时开启，使客户端 IP 取 `X-Forwarded-For` |
| `LOG_LEVEL` | `info` | 日志级别（密码/令牌字段已做脱敏） |

**生成密钥**（任一工具）：

```bash
openssl rand -base64 48
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
| `rate_limit_buckets` | 限流共享计数 | `RATE_LIMIT_STORE=postgres` 时多实例共享（单条原子 UPSERT） |
| `schema_migrations` | 迁移记录 | 记录 checksum，已应用迁移被改动会拒绝启动 |

另有验证码/设备绑定（002/003）、用户任务（005）、A2A 镜像（006）等表，完整清单见
`migrations/001_init.sql` ~ `006_a2a_messages.sql`。

所有用户数据表均带 `user_id … ON DELETE CASCADE`：注销账号即彻底清除。

---

## 6. 安全设计

- **密码**：Argon2id（19 MiB / t=2 / p=1，OWASP 推荐），每用户独立盐；哈希串损坏时校验返回 `false` 而非抛错；**PHC 串与旧 TS 版互认**（既有数据库直接可用）。
- **防账号枚举**：登录失败统一返回 `INVALID_CREDENTIALS`；邮箱不存在时执行等价耗时的假校验。
- **访问令牌**：JWT HS256，短期（默认 15 分钟），只放 `sub`/`sid`，不含邮箱等 PII；业务请求按 `sid` 回查会话状态（改密/登出后旧令牌即时失效，SV-002）。
- **刷新令牌**：256 位随机不透明串，服务端只存哈希；**每次刷新轮换**，旧令牌被重用 → 判定泄漏 → 吊销整个令牌家族。
- **改密**：验证当前密码；成功后吊销该用户全部会话，并为当前设备换发新令牌。
- **限流**：鉴权接口按 IP 严格限流，其他接口按 IP 粗限流，写操作按用户限流；超限返回 `429` + `Retry-After`。
- **输入校验**：所有 body/query 经统一校验层（与原型 Zod 语义一致的字段级校验：类型/长度/枚举/归一化），错误统一为 `VALIDATION_ERROR` 并带字段路径。
- **SQL 注入**：全部使用参数化查询（JDBC `PreparedStatement`），无字符串拼接 SQL。
- **错误暴露**：5xx 只回 `服务器内部错误`，细节仅进日志；日志对密码/令牌字段脱敏。
- **生产 fail-closed**：`NODE_ENV=production` 下 `JWT_SECRET` 缺失或仍是示例值 → 拒绝启动。
- **迁移防漂移**：已应用迁移文件被修改 → 启动/迁移时报错（需新增迁移文件）。
- **响应头**：`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy: no-referrer`、`Cache-Control: no-store`。

---

## 7. 运维

```bash
java -jar target/civitas-server-0.1.0.jar --migrate            # 应用迁移（幂等）
java -jar target/civitas-server-0.1.0.jar --migrate-status     # 查看状态
java -jar target/civitas-server-0.1.0.jar --migrate --dry-run  # 只列出将执行的迁移
```

- **备份数据库**：`pg_dump`（整库）或使用 `/v1/backup`（按用户，可给用户自助导出）。
- **升级**：拉代码 → `mvn -DskipTests package` → `java -jar … --migrate` → 重启进程。迁移失败会回滚且不记录。
- **优雅退出**：收到中断信号时关闭 HTTP 与连接池。
- **横向扩展**：应用本身无状态（会话在 PG），可多实例；限流计数设 `RATE_LIMIT_STORE=postgres`（生产默认）即多实例共享，无需引入额外中间件。

---

## 8. 从旧 npm 版迁移（TS → Java 命令对照）

| 旧命令（npm/tsx） | 新命令（Maven） |
|---|---|
| `npm install` | 不需要（Maven 自包含依赖；`Server/node_modules` 已移除） |
| `npm run dev` / `npm start` | `mvn spring-boot:run`（或 `java -jar target/civitas-server-0.1.0.jar`） |
| `npm run build` | `mvn -DskipTests package` |
| `npm run migrate` | `java -jar target/civitas-server-0.1.0.jar --migrate`（打一次包后可用） |
| `npm run migrate:status` | `java -jar target/civitas-server-0.1.0.jar --migrate-status` |
| `npm test` / `test:unit` / `test:integration` | `mvn test`（集成用例缺库自动跳过；单类用 `-Dtest='类名'`） |
| `npm run seed:dev` | 未保留（开发辅助脚本，依赖 Electron 侧设备指纹模块；可直接用 `/v1/auth/register` 注册开发账号） |
| `npm run db:up` / `db:down` | 不变：`docker compose up -d db` / `docker compose down` |

根目录还有 `npm run server:dev` / `server:migrate` / `server:test` 等包装脚本（已改为 Maven 口径），见根 `package.json`。

---

## 9. 目录结构

```
Server/
├── pom.xml                     # Maven 构建（Spring Boot 3.3 / Java 21）
├── docker-compose.yml          # 本地 PostgreSQL（可选）
├── .env.example                # 环境变量样例（名与含义不变）
├── migrations/                 # 纯 SQL 迁移（001~006，按文件名升序；字节不动）
├── scripts/verify-e2e.ps1      # 端到端验证脚本（真实 HTTP 全流程）
└── src/
    ├── main/java/com/civitas/server/
    │   ├── CivitasServerApplication.java   # 入口（--migrate 子命令在此拦截）
    │   ├── application/        # Spring 装配（Bootstrap + Bean 配置）
    │   ├── cli/                # 迁移 CLI
    │   ├── config/             # .env 解析 + 校验 + 生产 fail-closed
    │   ├── db/                 # Db 门面（JDBC 参数化）+ 迁移器
    │   ├── http/               # 过滤器链（安全头/IP 限流/CORS）、鉴权与写限流拦截器、错误体
    │   ├── logging/            # JSON 日志（敏感键脱敏）
    │   ├── repositories/       # 参数化 SQL 访问层
    │   ├── routes/             # 40 条路由（控制器）
    │   ├── security/           # 密码（Argon2id）/ JWT / 刷新令牌 / 验证码
    │   ├── services/           # 业务逻辑（鉴权/设置/统计/记忆/备份/任务/A2A）
    │   └── util/               # JS 语义辅助（Number 解析、ISO 时间）
    └── test/java/com/civitas/server/  # JUnit 5：unit + integration（真 PostgreSQL）
```

---

## 10. 已知限制与后续计划

> 缺陷与已知限制的**跟踪清单**（含根因、影响面、建议修法与验收标准）：
> [`Docs/Server/01-服务端/服务端缺陷清单.md`](../Docs/Server/01-服务端/服务端缺陷清单.md)（编号 `SV-xxx`）。
> 下面列出其中影响使用决策的几条。

- **限流存储可配置**：默认进程内（单实例）；**多实例部署请设 `RATE_LIMIT_STORE=postgres`**（生产默认已是 postgres），
  否则各实例各算一份、阈值 ≈ 配置值 × 实例数（见清单 `SV-003`，已修复）。
- **统计为实时聚合**：数据量极大时建议增加日汇总表（接口无需变化）。
- **中文全文检索**：使用 `ILIKE` 兜底（PG 自带 `simple` 分词器不切分中文）；如需更好的中文检索，可接入 `pg_jieba`/`zhparser` 或外部检索服务——见清单 `SV-005`。
- **备份导出**：默认全量导出（键集分页，无静默截断）；显式传 `statsLimit` 且实际超限时，包内 `truncated` 字段标注截断（见清单 `SV-001`，已修复）。
- **备份包明文**：导出 JSON 未加密，请自行妥善保存（见清单 `SV-007`，已知限制）。
- **改密/登出的即时性**：业务请求已按 `sid` 回查会话（即时生效）；仅纯 JWT 校验路径（不经守卫的极端场景）仍依赖 TTL——见清单 `SV-002`。
- **邮件通道**：投递通道（webhook）已实现，但**邮箱验证、忘记密码功能尚未实现**（需要具体业务流程设计）；当前注册即可用。
- **客户端接入**：`Client/src/services/serverApi.ts`（登录/令牌自动续期）与 `syncService.ts`（设置/记忆/统计同步、备份/恢复）已接入；Electron 桌面登录流程的 GUI 冒烟为人工验证项。
- **无二次验证（2FA）**：可作为后续增强。
