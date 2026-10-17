# 服务端 REST API 接口文档

> **端归属**：`Server/`（云端账号服务，Spring Boot + PostgreSQL）。按 `Docs/README.md` 的三端分类，本文属 **Server 端**。
>
> **事实源**：`Server/src/main/java/com/civitas/server/**`（控制器 / 请求校验 / 响应与错误 / 过滤器 / 配置）。
> 本文按源码逐端点抽取；**代码为唯一事实源**，本文与代码不一致时以代码为准并回改本文。
>
> **抽取基线**：2026-10-17（对应 `Server/` 当前工作树）。抽取方式：控制器注解 + 请求校验器字段链 + DTO record + 过滤器/拦截器装配。
>
> **对位关系**：本服务端由 TS 版 `src/**` 重写而来（见 `Server-Java重写计划-qodercn-20261013T204210.md`），
> 响应包络、错误码、限流与鉴权语义与 TS 版逐项对位；本文只描述**对外 HTTP 契约**，不描述内部仓储实现。

---

## 1. 基本约定

### 1.1 基地址与传输

| 项 | 值 | 来源 |
|---|---|---|
| 默认监听 | `127.0.0.1:8787` | `ConfigLoader`：`HOST` 缺省 `127.0.0.1`、`PORT` 缺省 `8787` |
| 协议 | HTTP/1.1；请求与响应均为 `application/json; charset=utf-8` | `InfrastructureConfiguration`（Jackson 消息转换器只支持 JSON） |
| 路径前缀 | 无全局前缀；业务端点为 `/v1/**`，健康检查为 `/healthz`、`/readyz` | `routes/*Controller.java`、`HealthController` |
| 时间格式 | ISO-8601 字符串（`IsoInstantSerializer` / `IsoTimes`，如 `2026-10-17T02:00:00Z`） | `json/IsoInstantSerializer`、`json/IsoTimes` |
| 反序列化 | **未知字段容忍**（全局 `Json.MAPPER`）；字段类型/格式错误 → `VALIDATION_ERROR` | `Json.MAPPER`、`GlobalExceptionHandler` |

### 1.2 统一响应包络

成功：

```json
{ "ok": true, "data": { } }
```

失败：

```json
{ "ok": false, "error": { "code": "VALIDATION_ERROR", "message": "请求格式不正确", "details": { } } }
```

- `error.details` 为可选（`@JsonInclude(NON_NULL)`）；`RATE_LIMITED` 时 `details.retryAfterSec` 会同时体现在 `Retry-After` 响应头。
- 过滤器层（无法走 `@RestControllerAdvice`）直接写 JSON，包络同上。

来源：`http/ApiResponse.java`。

### 1.3 错误码表

| `code` | HTTP | 语义 |
|---|---:|---|
| `VALIDATION_ERROR` | 400 | 请求格式/字段校验失败 |
| `UNAUTHENTICATED` | 401 | 缺少 Bearer 令牌 / 令牌无效 / 会话已失效 |
| `INVALID_CREDENTIALS` | 401 | 邮箱或密码错误 |
| `TOKEN_EXPIRED` | 401 | 访问/刷新令牌过期 |
| `TOKEN_REUSED` | 401 | 刷新令牌被重用（整族失效） |
| `FORBIDDEN` | 403 | 已认证但无权执行该操作 |
| `NOT_FOUND` | 404 | 资源或接口不存在 |
| `CONFLICT` | 409 | 唯一性/状态冲突 |
| `REVISION_MISMATCH` | 409 | 设置等资源 `expectedRevision` 与当前不一致 |
| `PAYLOAD_TOO_LARGE` | 413 | 请求体超过上限 |
| `RATE_LIMITED` | 429 | 触发限流（`Retry-After` 秒） |
| `UNSUPPORTED` | 415 | 非 JSON 请求体 |
| `UNAVAILABLE` | 503 | 依赖不可用（如 `/readyz` 数据库不可用） |
| `INTERNAL` | 500 | 未处理的服务端错误（文案不外露，原始信息进日志） |

来源：`http/ApiErrorCode.java`、`http/GlobalExceptionHandler.java`。

### 1.4 鉴权

- 头：`Authorization: Bearer <accessToken>`；仅**标注 `@RequireAuth`** 的端点校验，其余匿名（`/v1/auth/*` 的注册/登录/刷新/发码/验证码登录 + 健康检查）。
- 访问令牌为无状态 JWT，但**每次请求回查会话行**（`refresh_tokens.id`）：登出、改密、单会话吊销会立即让旧访问令牌失效，不等 TTL 到期。
- 令牌形态（`AuthResult`）：

```ts
{ user: UserDto, tokens: TokenBundle }
TokenBundle = { tokenType: "Bearer", accessToken, refreshToken, expiresIn, accessExpiresAt, refreshExpiresAt }
```

- 默认 TTL：访问令牌 `900` 秒（`ACCESS_TOKEN_TTL_SEC`）、刷新令牌 `30` 天（`REFRESH_TOKEN_TTL_DAYS`）。
- 刷新令牌重用：默认**拒绝**（`ALLOW_REFRESH_REUSE=false`），命中即 `TOKEN_REUSED` 并使整族失效。
- 设备绑定：`DEVICE_BINDING_MODE = off | warn（默认）| strict`；`strict` 拒绝未登记设备，可用 `/v1/me/devices` 自助解绑。
- 验证码：`CODE_TTL_SEC=300`、`CODE_MAX_PER_WINDOW=3`、`CODE_WINDOW_SEC=600`、`CODE_RESEND_COOLDOWN_SEC=60`、`CODE_MAX_ATTEMPTS=5`；`ALLOW_DEV_CODE=true` 仅非生产可用（生产启动校验强制关闭）。

来源：`http/AuthInterceptor.java`、`security/TokenService`、`config/ConfigLoader.java`、`services/AuthService.java`。

### 1.5 限流、请求体与安全头

| 维度 | 规则 | 来源 |
|---|---|---|
| IP 粗粒度 | `/v1/auth/**` → `RATE_LIMIT_AUTH_PER_MIN`（默认 20 次/分）；其它 → `RATE_LIMIT_API_PER_MIN`（默认 240 次/分）；`/healthz`、`/readyz` 不限流 | `IpRateLimitFilter` |
| 每用户写限流 | `POST/PUT/PATCH/DELETE`（已认证）→ `RATE_LIMIT_WRITE_PER_MIN`（默认 120 次/分） | `WriteRateLimitInterceptor` |
| 计数存储 | `RATE_LIMIT_STORE = memory（非生产默认）| postgres（生产默认，多实例共享）` | `ConfigLoader`、`PostgresRateLimiter` |
| 限流响应头 | `X-RateLimit-Limit`、`X-RateLimit-Remaining`（**判定前**设置）；429 时附 `Retry-After: ceil(retryAfterSec)` | `IpRateLimitFilter`、`ApiResponse` |
| 请求体上限 | 全局 `BODY_LIMIT_BYTES`（默认 1 MiB）；`Content-Length` 预检 + 流式计数双保险 | `BodyLimitFilter` |
| 设置体上限 | `MAX_SETTINGS_BYTES`（默认 256 KiB） | `Services`/`SettingsController` |
| 批量上限 | 记忆批量 `MAX_MEMORIES_PER_BULK`（默认 1000）；统计事件批 `MAX_STATS_EVENTS_PER_BATCH`（默认 500）；A2A 批量 `≤500`；任务批量 `≤500`；统计单批 `≤5000` | 各校验器 |
| 安全响应头 | `X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy: no-referrer`、`Cache-Control: no-store`（错误响应同样补头） | `SecurityHeadersFilter` |
| CORS | 仅当配置 `CORS_ORIGINS` 非空时启用；允许 `GET/POST/PUT/PATCH/DELETE/OPTIONS`，允许头 `Content-Type, Authorization`，`Max-Age=600` | `InfrastructureConfiguration` |
| 过滤器顺序 | `SecurityHeaders(1) → IpRateLimit(2) → Cors(3) → BodyLimit(4)`；拦截器顺序 `Auth(0) → WriteRateLimit(1)` | `InfrastructureConfiguration` |

### 1.6 环境变量（摘要）

`NODE_ENV`（development/test/production）· `HOST` · `PORT` · `DATABASE_URL`（必须 `postgres://`）· `JWT_SECRET`（生产 ≥32 字符且不得为示例值）· `ACCESS_TOKEN_TTL_SEC` · `REFRESH_TOKEN_TTL_DAYS` · `ALLOW_REFRESH_REUSE` · `DEVICE_BINDING_MODE` · `ALLOW_DEV_CODE` · `CODE_*` · `MAIL_WEBHOOK_URL`（生产必填）· `MAIL_FROM` · `MAIL_TIMEOUT_MS` · `RATE_LIMIT_*` · `RATE_LIMIT_STORE` · `BODY_LIMIT_BYTES` · `MAX_SETTINGS_BYTES` · `MAX_MEMORIES_PER_BULK` · `MAX_STATS_EVENTS_PER_BATCH` · `CORS_ORIGINS` · `LOG_LEVEL` · `STATS_TIMEZONE` · `TRUST_PROXY`。

> 生产强校验：`JWT_SECRET` 强度、`ALLOW_DEV_CODE` 必须关闭、`MAIL_WEBHOOK_URL` 必须配置；违反即启动失败。

---

## 2. 端点总览（38 + 2 健康检查）

| # | 方法 | 路径 | 鉴权 | 说明 |
|---:|---|---|:--:|---|
| 1 | GET | `/healthz` | – | 存活探针（不限流、不鉴权） |
| 2 | GET | `/readyz` | – | 就绪探针（DB ping；失败 503 `UNAVAILABLE`） |
| 3 | POST | `/v1/auth/register` | – | 邮箱注册 |
| 4 | POST | `/v1/auth/login` | – | 密码登录 |
| 5 | POST | `/v1/auth/refresh` | – | 刷新令牌 |
| 6 | POST | `/v1/auth/logout` | ✅ | 登出（可全设备） |
| 7 | POST | `/v1/auth/change-password` | ✅ | 修改密码（吊销旧会话） |
| 8 | POST | `/v1/auth/send-code` | – | 发送邮箱验证码 |
| 9 | POST | `/v1/auth/login-with-code` | – | 验证码登录/注册 |
| 10 | GET | `/v1/me` | ✅ | 当前用户资料 |
| 11 | PATCH | `/v1/me` | ✅ | 更新显示名 |
| 12 | DELETE | `/v1/me` | ✅ | 注销账号（需密码确认） |
| 13 | GET | `/v1/me/sessions` | ✅ | 登录会话列表 |
| 14 | DELETE | `/v1/me/sessions/{sessionId}` | ✅ | 吊销单个会话 |
| 15 | GET | `/v1/me/devices` | ✅ | 设备列表 |
| 16 | DELETE | `/v1/me/devices/{deviceId}` | ✅ | 解绑设备 |
| 17 | GET | `/v1/me/audit` | ✅ | 账号审计记录（`limit`） |
| 18 | GET | `/v1/backup` | ✅ | 导出备份包（`includeStats`、`statsLimit`） |
| 19 | GET | `/v1/backup/download` | ✅ | 下载备份包（`Content-Disposition`） |
| 20 | POST | `/v1/restore` | ✅ | 恢复备份（`mode=merge|replace`） |
| 21 | GET | `/v1/memories` | ✅ | 记忆列表（分页/筛选） |
| 22 | GET | `/v1/memories/{id}` | ✅ | 单条记忆 |
| 23 | POST | `/v1/memories` | ✅ | 创建记忆 |
| 24 | PATCH | `/v1/memories/{id}` | ✅ | 更新记忆 |
| 25 | DELETE | `/v1/memories/{id}` | ✅ | 删除记忆（`hard`） |
| 26 | POST | `/v1/memories/bulk` | ✅ | 批量 upsert |
| 27 | GET | `/v1/settings` | ✅ | 读取设置（含 revision） |
| 28 | PUT | `/v1/settings` | ✅ | 覆盖设置（`expectedRevision` 乐观锁） |
| 29 | PATCH | `/v1/settings` | ✅ | 合并设置（`expectedRevision`） |
| 30 | DELETE | `/v1/settings` | ✅ | 重置设置 |
| 31 | POST | `/v1/stats/events` | ✅ | 上报使用事件 |
| 32 | GET | `/v1/stats/summary` | ✅ | 区间汇总（`from/to/kind`） |
| 33 | GET | `/v1/stats/daily` | ✅ | 按日聚合（`from/to/kind`） |
| 34 | GET | `/v1/stats/overview` | ✅ | 账号总览 |
| 35 | DELETE | `/v1/stats/events` | ✅ | 清空统计事件 |
| 36 | GET | `/v1/tasks` | ✅ | 任务列表（`archived`、`limit`） |
| 37 | POST | `/v1/tasks/bulk` | ✅ | 任务批量 upsert |
| 38 | GET | `/v1/a2a/messages` | ✅ | A2A 消息列表（游标分页） |
| 39 | POST | `/v1/a2a/messages/bulk` | ✅ | A2A 消息批量上报 |
| 40 | POST | `/v1/a2a/cards/bulk` | ✅ | A2A Agent 卡批量上报 |

---

## 3. 分模块契约

> 下文 `?` 表示可选；时间字段均为 ISO-8601 字符串；`cursor` 为不透明游标（原样回传）。

### 3.1 健康检查

| 端点 | 成功 `data` | 失败 |
|---|---|---|
| `GET /healthz` | `{ status: "ok", uptimeSec: number }` | — |
| `GET /readyz` | `{ status: "ready", db: "up" }` | 503 `{ code: "UNAVAILABLE" }` |

### 3.2 认证 `/v1/auth/*`

| 端点 | 请求体 | 成功 `data` |
|---|---|---|
| `POST /register` | `{ email, password, displayName?, deviceLabel? }` | `AuthResult` |
| `POST /login` | `{ email, password, deviceLabel? }` | `AuthResult` |
| `POST /refresh` | `{ refreshToken, deviceLabel? }` | `AuthResult` |
| `POST /logout` ✅ | `{ refreshToken?, allDevices? }` | `{ revoked: number }` |
| `POST /change-password` ✅ | `{ currentPassword, newPassword, deviceLabel? }` | `{ tokens: TokenBundle }` |
| `POST /send-code` | `{ email, purpose? }`（`purpose` 缺省 `login`；枚举 `register|login|reset_password`） | `{ sent: boolean, ... }`（开发态可能回带 `devCode`） |
| `POST /login-with-code` | `{ email, code, displayName?, deviceLabel?, deviceId?, deviceCredential? }` | `{ user: UserDto, tokens: TokenBundle, isNewUser: boolean }` |

字段约束（`http/validation/AuthBodies.java`）：

| 字段 | 约束 |
|---|---|
| `email` | 必填、trim、长度 3–254、邮箱格式、**小写归一** |
| `password` | 8–200，**必须同时含字母与数字** |
| `refreshToken` | 20–512 |
| `code` | 长度 6（6 位数字） |
| `displayName` | 可空；trim；1–64 |
| `deviceLabel` | 可空；trim；≤64 |
| `deviceId` / `deviceCredential` | 可空；trim；≤128 / ≤256 |
| `allDevices` | 可选布尔 |

### 3.3 当前用户 `/v1/me*`

| 端点 | 请求 | 成功 `data` |
|---|---|---|
| `GET /v1/me` | — | `UserDto` |
| `PATCH /v1/me` | `{ displayName }`（可空；trim；≤64） | `UserDto` |
| `DELETE /v1/me` | `{ password }`（注销确认） | `{ deleted: true }` |
| `GET /v1/me/sessions` | — | `{ sessions: SessionDto[] }` |
| `DELETE /v1/me/sessions/{sessionId}` | — | `{ sessionId, revoked: true }` |
| `GET /v1/me/devices` | — | `{ devices: DeviceDto[] }` |
| `DELETE /v1/me/devices/{deviceId}` | — | `{ deviceId, revoked: true }` |
| `GET /v1/me/audit?limit=` | `limit`（默认 50，上限由服务端裁剪） | `{ events: AuditEventDto[] }` |

DTO：

```ts
UserDto = { id, email, displayName, status, createdAt, lastLoginAt, boundDeviceId }
SessionDto = { sessionId, deviceLabel, userAgent, ip, issuedAt, ... }   // 见 services/AuthService.java
TokenBundle = { tokenType: "Bearer", accessToken, refreshToken, expiresIn, accessExpiresAt, refreshExpiresAt }
```

### 3.4 备份与恢复

| 端点 | 请求 | 成功 `data` |
|---|---|---|
| `GET /v1/backup?includeStats=&statsLimit=` | `includeStats`（布尔串）、`statsLimit`（正整数） | `BackupBundle` |
| `GET /v1/backup/download?...` | 同上；直接返回备份 JSON 文件（`Content-Disposition`） | `BackupBundle`（文件体） |
| `POST /v1/restore` | `{ bundle: BackupBundle, mode?: "merge"|"replace" }`（缺省 `merge`） | `RestoreReport` |

`BackupBundle`：

```ts
{
  format, version, exportedAt,
  account: { email, displayName },
  settings: SettingsDto,
  memories: MemoryDto[],
  tasks: BackupTaskDto[],
  stats: { events: StatEventRow[] },
  truncated?: { stats: { limit, reason } }   // 仅截断时出现
}
RestoreReport = { mode, settings: {restored, revision}, memories: {created, updated, total}, tasks: {created, updated, total}, stats: {accepted} }
```

### 3.5 记忆 `/v1/memories*`

| 端点 | 请求 | 成功 `data` |
|---|---|---|
| `GET /v1/memories` | query：`limit?`（默认 50，1–200）、`cursor?`（≤200）、`category?`（≤64）、`status?`（`active|archived|deleted`）、`q?`（1–200） | `{ items: MemoryDto[], nextCursor: string|null }` |
| `GET /v1/memories/{id}` | — | `MemoryDto` |
| `POST /v1/memories` | `MemoryInput`（见下） | `{ memory: MemoryDto, created: boolean }` |
| `PATCH /v1/memories/{id}` | `MemoryInput`（全字段可选） | `MemoryDto` |
| `DELETE /v1/memories/{id}?hard=` | `hard` 布尔串 | `{ id, deleted: true }` |
| `POST /v1/memories/bulk` | `{ items: MemoryInput[] }`（1 ≤ n ≤ 1000） | `{ created, updated, total }` |

`MemoryInput`（`MemoryBodies.java`）：

| 字段 | 约束 |
|---|---|
| `clientMemoryId` | 可空；trim；≤128（幂等键） |
| `title` | 创建必填；创建 1–500；更新可选 |
| `content` | 创建必填；1–200000；更新可选 |
| `category` | 可选；trim；1–64 |
| `assertion` | 可选；`observed|inferred|verified|disputed` |
| `sourceTraceIds` | 可选字符串数组 |
| `sourceArbitrationIds` | 可空字符串数组 |
| `status` | 可选；`active|archived|deleted` |
| `contradictedBy` | 可空；trim；≤200 |
| `accessCount` | 可选非负整数 |
| `createdAt` / `lastAccessedAt` | 可选 ISO-8601 |

`MemoryDto`：`{ id, clientMemoryId, title, content, category, assertion, status, contradictedBy, sourceTraceIds, sourceArbitrationIds, accessCount, createdAt, lastAccessedAt, updatedAt }`（见 `MemoryService.java`）。

### 3.6 设置 `/v1/settings*`

| 端点 | 请求 | 成功 `data` |
|---|---|---|
| `GET /v1/settings` | — | `SettingsDto = { revision, data, updatedAt }` |
| `PUT /v1/settings` | `{ data: object, expectedRevision?: number }` | `SettingsDto` |
| `PATCH /v1/settings` | `{ patch: object, expectedRevision?: number }` | `SettingsDto` |
| `DELETE /v1/settings` | — | `{ reset: true }` |

- `expectedRevision` 与当前不一致 → `409 REVISION_MISMATCH`（乐观锁）。
- `data` 为自由 JSON 对象（受 `MAX_SETTINGS_BYTES` 限制）。

### 3.7 统计 `/v1/stats/*`

| 端点 | 请求 | 成功 `data` |
|---|---|---|
| `POST /v1/stats/events` | `{ events: StatsEvent[] }`（1–5000，且 ≤ `MAX_STATS_EVENTS_PER_BATCH`） | `{ accepted, submitted }` |
| `GET /v1/stats/summary?from=&to=&kind=` | `from/to` ISO-8601；`kind` ≤64 | `StatsSummaryDto` |
| `GET /v1/stats/daily?from=&to=&kind=` | 同上 | `{ timezone, days: DayTotalDto[] }` |
| `GET /v1/stats/overview` | — | `StatsOverviewDto` |
| `DELETE /v1/stats/events` | — | `{ deleted }` |

```ts
StatsEvent = { kind, value?, occurredAt, clientEventId?, meta? }
StatsSummaryDto = { from, to, totalEvents, totalValue, activeDays, byKind: KindTotalDto[] }
KindTotalDto = { kind, count, value }
DayTotalDto  = { day, kind, count, value }
StatsOverviewDto = {
  lifetime: { events, value, activeDays, firstAt, lastAt },
  memories: { total }, settings: { revision }, sessions: { active },
  account: { createdAt, lastLoginAt }
}
```

### 3.8 任务 `/v1/tasks*`

| 端点 | 请求 | 成功 `data` |
|---|---|---|
| `GET /v1/tasks?archived=&limit=` | `archived` 布尔串；`limit` 正整数 | `{ items: TaskDto[], total }` |
| `POST /v1/tasks/bulk` | `{ items: TaskInput[] }`（1 ≤ n ≤ 500） | `{ created, updated, total }` |

```ts
TaskInput = { clientSessionId, title?, createdAt, updatedAt, archivedAt? }
TaskDto   = { clientSessionId, title, createdAt, updatedAt, archivedAt }
```

### 3.9 A2A `/v1/a2a/*`

| 端点 | 请求 | 成功 `data` |
|---|---|---|
| `GET /v1/a2a/messages?taskId=&agentId=&since=&limit=&cursor=` | `limit` 1–500；`cursor` ≤600 | `{ items: A2aMessageDto[], nextCursor, total }` |
| `POST /v1/a2a/messages/bulk` | `{ items: A2aMessageInput[] }`（1 ≤ n ≤ 500） | `{ created, updated, total, redacted, truncated }` |
| `POST /v1/a2a/cards/bulk` | `{ items: A2aCardInput[] }`（1 ≤ n ≤ 500） | `{ created, updated, total }` |

`A2aMessageInput`：`{ messageId, taskId, traceId, kind, sourceAgentId, targetAgentId, parentMessageId?, correlationId?, visibility, contentHash, prevHash?, payload?, summary?, verdict, blockReason?, priority?, memoryRefs?[{key,version}], redactedFields?[], createdAt }`

`A2aCardInput`：`{ cardId, agentId, cardVersion, role, createTime, fatherAgentId?, fatherRole?, lineage?[], status, health?, ability?, permission?, fingerprint, expiresAt }`

约束要点：`messageId/taskId/traceId/sourceAgentId/targetAgentId` 1–200；`kind` ≤40；`contentHash` ≤128；`prevHash` 可空 ≤128；`payload` 任意对象；`summary` ≤4000；`blockReason` ≤2000；`memoryRefs` ≤50 项；`redactedFields` ≤200 项（每项 ≤300）。

---

## 4. 客户端调用映射（谁在调）

云端账号服务由渲染进程经主进程 `server-fetch` 白名单转发调用（见 `Docs/Client/05-接口契约/客户端与桌面端接口文档.md`），当前客户端实际使用的端点：

| 用途 | 端点 | 客户端位置 |
|---|---|---|
| 拉取全量记忆 | `GET /v1/memories`（分页） | `Client/src/services/syncService.ts` |
| 批量上行记忆 | `POST /v1/memories/bulk` | 同上 |
| 设置同步 | `GET/PUT /v1/settings` | 同上 |
| 任务同步 | `GET /v1/tasks`、`POST /v1/tasks/bulk` | 同上 |
| 统计上报/总览 | `POST /v1/stats/events`、`GET /v1/stats/overview` | 同上 |
| 备份/恢复 | `GET /v1/backup`、`POST /v1/restore` | 同上 |

> 账号/登录/刷新/登出由 `Client/src/services/serverApi.ts` 的 `configureServerAuth` 钩子驱动（`authedRequest` 负责 401 → refresh → 重放）。

---

## 5. 公共 DTO 速查

| DTO | 字段 |
|---|---|
| `ApiResponse.OkBody<T>` | `{ ok: true, data: T }` |
| `ApiResponse.ErrBody` | `{ ok: false, error: { code, message, details? } }` |
| `UserDto` | `id, email, displayName, status, createdAt, lastLoginAt, boundDeviceId` |
| `TokenBundle` | `tokenType, accessToken, refreshToken, expiresIn, accessExpiresAt, refreshExpiresAt` |
| `SettingsDto` | `revision, data, updatedAt` |
| `MemoryDto` | 见 §3.5 |
| `TaskDto` | 见 §3.8 |
| `A2aMessageDto` | 与 `A2aMessageInput` 同构，另加 `truncated: boolean`（`payload/summary` 可被裁剪） |
| `BackupBundle` / `RestoreReport` | 见 §3.4 |

---

## 6. 变更与维护

- 新增/修改端点时必须同批更新：本文、`Docs/Server/01-服务端/服务端设计文档.md`（行为设计）、`Docs/Server/01-服务端/服务端缺陷清单.md`（如属缺陷修复）。
- 契约相关测试：`Server/src/test/java/**`（控制器/校验/限流/鉴权），以及 `Tests/` 中云同步相关用例。
- 本文与源码不一致时的判定顺序：**源码 > 本文**；改代码必须回写本文，并在 `Docs/CHANGELOG.md` 登记。
