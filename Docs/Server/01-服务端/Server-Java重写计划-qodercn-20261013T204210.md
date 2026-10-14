# Server Java 重写计划（Spring Boot 3）

> **本文档定位**：`Server/`（账号与数据服务）由 TypeScript（Fastify 5）**重写为 Java（Spring Boot 3）**的实施计划。
> 本文件是**执行前计划**，经人工确认后按里程碑实施；实施过程中的取舍与偏差回写本文件或对应设计文档。
>
> **已确认决策（2026-10-13，用户口径）**：
> ① 重写对象 = `Server/`（处理登录的账号/数据服务，非 `Src/` Electron 进程内服务）；
> ② 技术栈 = **Spring Boot 3**（本机：Java 23 / Maven 3.9.11，无 Gradle）；
> ③ 落位 = **直接替换 `Server/` 目录内容**（新分支上执行；旧 TS 版本仅存于 git 历史）；
> ④ **命名约束（硬性）**：Java 标识符一律**大驼峰（PascalCase）类名 + 小驼峰（camelCase）方法/字段/变量**；
> 对外契约（HTTP JSON 字段、环境变量名、DB 列名、迁移 SQL 文件内容）**不随语言改写而变化**。
>
> **关联文档**：[服务端设计文档](服务端设计文档.md)（语义唯一事实源）、[服务端缺陷清单](服务端缺陷清单.md)、
> [`Server/README.md`](../../../Server/README.md)、[客户端接入设计](../../Client/04-客户端接入账号与同步/客户端接入设计.md)。
>
> **代码为唯一事实源**：本文所有"现状"均按 2026-10-13 的 `Server/` 代码实态盘点（含设计文档未收录的迁移 006 / A2A 三端点）。

---

## 1. 目标与范围

### 1.1 目标

1. 用 **Spring Boot 3 + Maven** 重写 `Server/` 全部功能，**对外行为逐位兼容**：端口 8787、HTTP 路由、请求/响应 JSON 逐字段一致、错误码与状态码一致、响应头一致、鉴权语义一致、数据库（PostgreSQL）结构与迁移 checksum 一致。
2. **既有数据库可直接衔接**：重写后的服务能直接连上旧 TS 版本已迁移过的库（不重跑迁移、不产生 checksum 漂移），**既有用户密码（Argon2id PHC）与刷新令牌（sha256）直接可用**。
3. **测试覆盖对等**：TS 侧 11 个测试文件 / 117 项（unit 32 + integration 85）语义等价迁移为 JUnit 5 测试；集成测试跑真 PostgreSQL，无库环境自动跳过（与现状一致）。
4. **修复不回归**：缺陷清单中 SV-001~SV-004、SV-008~SV-014 的已修行为与 SV-005/SV-007 的已知限制，在重写版中**逐条保留**（详见 §6.8 对照表）。

### 1.2 范围盘点（现状实态）

| 维度 | 数量 | 明细 |
|---|---|---|
| HTTP 路由 | **40** | 设计文档附录 C 收录 37 条 + A2A 三条（`POST /v1/a2a/messages/bulk`、`GET /v1/a2a/messages`、`POST /v1/a2a/cards/bulk`，A2A 域另有 `GET /v1/a2a/...` 详见 §5） |
| 数据库业务表 | **12** | `users` / `refresh_tokens` / `user_settings` / `usage_events` / `memories` / `audit_log`（001）+ `verification_codes` / `user_devices`（002/003）+ `rate_limit_buckets`（004）+ `user_tasks`（005）+ `a2a_messages` / `a2a_agent_cards`（006）；另有迁移器自建 `schema_migrations` |
| 迁移文件 | 6 + 1 | `001_init.sql` ~ `006_a2a_mirror.sql`（**原样保留，字节不动**，见 §6.2） |
| 错误码 | **14** | `VALIDATION_ERROR(400)` / `UNAUTHENTICATED(401)` / `INVALID_CREDENTIALS(401)` / `TOKEN_EXPIRED(401)` / `TOKEN_REUSED(401)` / `FORBIDDEN(403)` / `NOT_FOUND(404)` / `CONFLICT(409)` / `REVISION_MISMATCH(409)` / `PAYLOAD_TOO_LARGE(413)` / `UNSUPPORTED(415)` / `RATE_LIMITED(429)` / `INTERNAL(500)` / `UNAVAILABLE(503)` |
| 环境变量 | 40+ | 见 `Server/.env.example` 与设计文档附录 A；名与语义不变（§6.7） |
| 测试用例 | **117** | 11 文件：unit 32（config 11 / core 21）+ integration 85（auth 14 / backup 9 / memories 9 / platform 9 / rateLimitStore 6 / settings 9 / stats 9 / tasks 6 / verificationCode 14） |

**不在范围**：`Src/`（Electron 进程内 `:3000` 服务）、`Client/`（前端）；但 `Client/src/services/serverApi.ts` 的契约假设（端口、路径、信封、刷新流程）是本计划的**验收基线**，不改前端一行代码。

### 1.3 验收标准（重写版完成的定义）

| # | 标准 | 验证方式 |
|---|---|---|
| J1 | 40 条路由行为对等 | JUnit 集成测试逐路由断言 + 与 TS 版**同库双跑对比**（§7.3 差分验证） |
| J2 | 既有库直接衔接 | 用 TS 版迁移过的库启动 Java 版：不报 checksum 漂移、老用户可登录、旧刷新令牌可用 |
| J3 | 密码哈希互认 | TS 版（Argon2id PHC，m=19456,t=2,p=1,len=32）创建的账号在 Java 版登录成功，反之亦然 |
| J4 | 前端零改动可用 | `Client/` 连接 Java 版跑通：注册→登录→拉取设置/记忆/任务→刷新令牌→登出 |
| J5 | 测试对等 | JUnit 侧 unit+integration 全绿；集成覆盖 117 项对应语义清单（可合并，但清单逐条勾稽） |
| J6 | 配置 fail-closed 对等 | 生产缺 `JWT_SECRET`/`MAIL_WEBHOOK_URL`/误开 `ALLOW_DEV_CODE` → 拒绝启动（消息口径一致） |
| J7 | 部署替换平滑 | 根 `package.json` 的 `server:*` 脚本、`Server/README.md` 命令更新为 Maven 口径；旧脚本给出去向说明 |

---

## 2. 硬性约束（不可破坏的契约）

以下契约**任何一条破坏即视为重写失败**，全部纳入 §7 测试清单：

| # | 契约 | 关键点 |
|---|---|---|
| C1 | **HTTP 信封** | 成功 `{ok:true,data}`；失败 `{ok:false,error:{code,message,details?}}`；`/v1/backup/download` 与 `/healthz`/`/readyz` 例外（裸体） |
| C2 | **错误码→状态码** | 上表 14 码映射不变；`internal` 非 expose 时 message 不外泄细节（统一"服务器内部错误"） |
| C3 | **速率限制头** | 429 带 `Retry-After`（秒）；限流计数键 `auth:<ip>` / `api:<ip>` / `write:<userId>` 语义不变；`/healthz`、`/readyz` 跳过限流 |
| C4 | **安全响应头** | 全响应 `X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy: no-referrer`、`Cache-Control: no-store` |
| C5 | **JWT** | HS256；`iss=civitas-server`、`aud=civitas-client`；claims `sub`/`sid`/`typ=access` + 标准时间声明；TTL 默认 900s；过期→`TOKEN_EXPIRED`、其他无效→`UNAUTHENTICATED` |
| C6 | **刷新令牌** | 32 字节 CSPRNG → base64url；库中仅存 sha256 hex；轮换制 + 家族吊销（重用→`TOKEN_REUSED` 且吊销整族）；`ALLOW_REFRESH_REUSE` 开关语义不变 |
| C7 | **会话即时吊销（SV-002）** | 业务请求经守卫按 `sid` 回查 `refresh_tokens`（revoked/missing/expired → 401"会话已失效，请重新登录"） |
| C8 | **密码** | Argon2id PHC 格式互认（§6.3）；注册校验 8..200 且含字母+数字；登录失败统一 `INVALID_CREDENTIALS`"邮箱或密码不正确"（防枚举）+ `fakeVerify` 恒定时耗 |
| C9 | **验证码** | sha256 存 `code_hash`；`crypto.randomInt` 等价 CSPRNG；一次性 + 单活码；`attempts` 达 `CODE_MAX_ATTEMPTS` 作废；按邮箱配额/冷却；`devCode` 仅 `ALLOW_DEV_CODE` 时回传；错码文案"验证码错误"/"验证码无效或已过期"（SV-010） |
| C10 | **数据库** | 表结构、列名、索引、约束与迁移 SQL **字节级不动**（§6.2）；`$n` 占位符→JDBC `?` 改写但 SQL 语义不变 |
| C11 | **JSON 时间与数字** | `Date`→ISO 8601 含毫秒 + `Z`（等价 JS `toISOString()`）；`numeric`→JSON number；bigint epoch-ms 列为 JSON number（int8 解析器语义，§6.6） |
| C12 | **备份包** | `format=civitas.backup`、`version=1`；键集分页全量导出；`statsLimit` 显式超限才标 `truncated.stats`（SV-001）；`mode=replace` 单事务（§4.7） |
| C13 | **A2A 镜像** | 服务端二次脱敏（敏感键 + 正则：`sk-`/`Bearer`/`AKIA`/`gh[pousr]_`/`eyJ...`JWT）；>64KiB 截断保留 `contentHash`；`redactedFields`/`truncated` 标记；游标 base64url 编解码不变 |
| C14 | **配置系统** | `.env` 文件 + 真环境变量覆盖；生产 fail-closed 校验与警告文案；`RATE_LIMIT_STORE` 生产默认 `postgres`（§6.7） |
| C15 | **命名约束（用户硬性要求）** | Java 类 PascalCase、方法/字段/变量/参数 camelCase；包名按 Java 惯例全小写；**不改** HTTP JSON 字段（camelCase 原样）、环境变量名、DB 列名、迁移文件名与内容 |

---

## 3. 技术选型与映射

### 3.1 TS → Java 依赖映射

| 能力 | TS 现状 | Java 选型 | 理由/注意 |
|---|---|---|---|
| Web 框架 | Fastify 5 | **Spring Boot 3.3.x（spring-boot-starter-web）** | 内嵌 Tomcat；用 `Filter`/`HandlerInterceptor` 复刻钩子链 |
| 数据库访问 | `pg` + 手写参数化 SQL | **spring-boot-starter-jdbc（JdbcTemplate）+ HikariCP** | 仓储层 SQL 手工控制（不引 JPA——40 条路由的 SQL 均已是显式语句，ORM 反而添乱） |
| JSON | 手写 `JSON.parse/stringify` | **Jackson（Spring 默认）** | 定制 `ObjectMapper`：时间 ISO 毫秒+Z、null 省略策略需逐字段核对（§6.6） |
| 校验 | Zod | **Jakarta Validation（hibernate-validator）+ 手写归一化器** | Zod 的 transform（trim/lowercase/默认值）用自定义序列化或 DTO 注解+后处理实现；错误 `details.issues[{path,message,code}]` 结构手工复刻 |
| JWT | `jose` HS256 | **jjwt 0.12.x**（或 `com.auth0:java-jwt`） | 声明名与校验错误分流（Expired vs 其他）需对齐 C5 |
| 密码哈希 | `@node-rs/argon2`（Argon2id PHC） | **BouncyCastle `Argon2BytesGenerator` 或 Spring Security `Argon2PasswordEncoder`** | **必须验证 TS 生成的 PHC 串**（§6.3 有专项验证） |
| 验证码/令牌随机 | `node:crypto`（randomInt/randomBytes，CSPRNG） | `java.security.SecureRandom` | `/dev/urandom` 等价；base64url 无填充 |
| 邮件 | 手写 `fetch` webhook | **JDK17+ `java.net.http.HttpClient`** | 不引 spring-web 的 RestTemplate，保持依赖最小 |
| 限流 | 手写内存滑动窗口 + PG 固定窗口 UPSERT | 手写 `RateLimiter` 接口双实现（`ConcurrentHashMap` + `JdbcTemplate` UPSERT） | 语义逐条对齐（§6.5）；不引 Bucket4j（固定/滑动窗口混合语义自定义更可控） |
| 定时任务 | `setInterval().unref()` | **`@Scheduled`（`spring.task.scheduling`）** | 令牌清理每 6h（SV-004）、限流桶清理每 10min；线程需 daemon 语义（不阻止退出） |
| CORS | `@fastify/cors` | Spring MVC `CorsRegistry` / `CorsFilter` | 仅 `CORS_ORIGINS` 非空时启用 |
| 日志 | 自研 JSON-lines + 敏感键脱敏 | **Logback + 自定义 JSON encoder**（或 logstash-logback-encoder） | 键名脱敏清单一致（password/secret/token/... 含 `devcode`/`code`）；字段 `ts/level/message` 结构对齐 |
| 构建 | npm / tsx | **Maven（pom.xml）** | 本机 Maven 3.9.11；`maven-compiler-plugin` release=21（JDK 23 编译，兼容主流 LTS 运行） |
| 测试 | vitest + `fastify.inject()` | **JUnit 5 + Spring Boot Test（MockMvc / `@SpringBootTest(webEnvironment=RANDOM_PORT)`）** | MockMvc 对位 `inject`（无端口）；集成层直连 TEST_DATABASE_URL |

### 3.2 钩子链映射（`app.ts` 生命周期 → Servlet 过滤体系）

现状顺序（**必须保持**）：安全响应头(onSend) → 限流(onRequest，先 IP 后写限流位置见下) → 路由 → 统一错误体。

```
TS: onSend(安全头) ─→ onRequest(IP 限流: /v1/auth/* 用 auth 桶, 其余 api 桶)
      ─→ preHandler(写限流: 已鉴权请求用 write:<userId> 桶) ─→ handler
Java 对应:
  SecurityHeadersFilter(filter 链首位，response 包装写头)
    → IpRateLimitFilter(/v1/auth/ 前缀判断选桶；/healthz /readyz 跳过)
      → JwtAuthFilter(解析 Bearer → 验签 → 按 sid 回查会话 → 注入请求上下文)
        → WriteRateLimitFilter(仅已鉴权 + 写方法/路径白名单语义对齐现状)
          → Controller
  BodyLimitFilter(413) / 异常 → @RestControllerAdvice(统一错误体) / 404 → ErrorController 兜底
```

> 现状实现细节需逐行对照：写限流是**全局 preHandler**（仅 `request.auth` 存在时消费 `write:<userId>`），并非只拦写方法——重写时以 `app.ts` 源码为准逐条移植，勿凭直觉"优化"。

---

## 4. 目录结构与命名规范

### 4.1 目标目录（`Server/` 直接替换后的形态）

```
Server/
├── pom.xml                          # Maven 构建（替代 package.json）
├── .env.example                     # 原样保留（变量名不变）
├── README.md                        # 更新为 Maven 口径（§11）
├── migrations/                      # ★ 原样保留 001~006（字节不动）
├── src/main/java/com/civitas/server/
│   ├── CivitasServerApplication.java        # 入口（替代 src/index.ts）
│   ├── config/                      # ServerConfig 组装 + 生产 fail-closed 校验
│   │   ├── ServerConfig.java        #   配置快照（record/不可变类）
│   │   ├── ConfigLoader.java        #   .env 解析 + 真环境覆盖 + 校验/警告
│   │   └── WebMvcConfig.java        #   CORS、ObjectMapper、拦截器注册
│   ├── http/                        # 复刻 src/http/
│   │   ├── ApiErrorCode.java        #   14 错误码枚举 + 状态映射
│   │   ├── AppException.java        #   业务异常（code/status/details/expose）
│   │   ├── ErrorFactory.java        #   badRequest()/invalidCredentials(message) 等工厂
│   │   ├── ApiResponse.java         #   {ok,data} / {ok,error} 信封
│   │   ├── GlobalExceptionHandler.java  # @RestControllerAdvice
│   │   ├── JwtAuthFilter.java       #   守卫（含 sid 回查，SV-002）
│   │   ├── IpRateLimitFilter.java / WriteRateLimitFilter.java
│   │   ├── SecurityHeadersFilter.java / BodyLimitFilter.java
│   │   ├── RateLimiter.java         #   接口 + MemoryRateLimiter + PostgresRateLimiter
│   │   └── ValidationSupport.java   #   Zod 等价：路径化 issues
│   ├── security/                    # 复刻 src/security/
│   │   ├── TokenService.java        #   JWT 签/验（jose 对位）
│   │   └── PasswordService.java     #   Argon2id + fakeVerify
│   ├── repository/                  # 复刻 src/repositories/（JdbcTemplate，SQL 逐条移植）
│   │   ├── UserRepository.java / RefreshTokenRepository.java / SettingsRepository.java
│   │   ├── UsageEventRepository.java / MemoryRepository.java / AuditRepository.java
│   │   ├── VerificationCodeRepository.java / TaskRepository.java / A2aRepository.java
│   │   └── RowMapper 工具（int8→Long、jsonb↔JsonNode、inet→String）
│   ├── service/                     # 复刻 src/services/（事务边界 = 现状 tx() 位置）
│   │   ├── AuthService.java / SettingsService.java / StatsService.java
│   │   ├── MemoryService.java / TaskService.java / BackupService.java / A2aService.java
│   │   └── MailTransport.java（接口）+ WebhookMailTransport + ConsoleMailTransport
│   ├── dto/                         # 请求/响应 DTO（camelCase 字段名 = 现 JSON 字段）
│   └── db/
│       ├── Db.java                  # JdbcTemplate 封装（query/one/execute/tx）
│       └── MigrationRunner.java     # 迁移器（sha256 checksum + 漂移检测）
├── src/main/resources/
│   ├── application.yml              # 仅框架级（端口默认等）；业务配置仍走 .env 装载（C14）
│   └── logback-spring.xml           # JSON-lines 输出
└── src/test/java/com/civitas/server/   # 对位 test/（§7）
    ├── unit/  config/ core/
    ├── integration/（auth/backup/memories/platform/rateLimitStore/settings/stats/tasks/verificationCode）
    └── support/（TestApp/Fixtures/PgTestBase — 对位 test/helpers/）
```

- **包名**：`com.civitas.server`（全小写，Java 惯例；用户命名约束针对类/方法/变量，包名不冲突）。
- **类名**：一律 PascalCase 名词；**方法/字段/参数/局部变量**：一律 camelCase（HardConst：禁止下划线命名 Java 标识符；DTO 字段名 = JSON 字段名，天然 camelCase 合规）。
- **常量**：沿用 Java 惯例 `static final` 大写下划线（如 `JWT_ISSUER`）——这是 Java 语言约定而非"对外契约"，如需与用户约束对齐可改为 camelCase 静态常量，**实施启动前请人工确认**（默认按 Java 惯例，见 §10 待确认项 Q1）。

### 4.2 TS 文件 → Java 类映射表（全量 40+ 文件）

| TS 源文件 | Java 目标 | 备注 |
|---|---|---|
| `src/index.ts` | `CivitasServerApplication` + `LifecycleComponent`（shutdown） | 启动顺序：config→db→migrate?(现状不自动迁移，实施前核实) →app→定时器 |
| `src/app.ts` | `WebConfig`（buildApp 对位）+ 各 Filter | 路由注册拆到 Controller |
| `src/config.ts` | `ConfigLoader` / `ServerConfig` / `EnvSchema` | 逐变量对照 §6.7 |
| `src/logger.ts` | `logback-spring.xml` + `SensitiveKeys` 常量 | 脱敏键清单一致 |
| `src/db/pool.ts` | `Db` + `DataSourceConfig` | Hikari 参数对位（poolMax/idle/timeout/statement_timeout/application_name） |
| `src/db/migrate.ts` | `MigrationRunner` | checksum=sha256(文件字节)（§6.2） |
| `src/http/errors.ts` | `ApiErrorCode` / `AppException` / `ErrorFactory` / `GlobalExceptionHandler` | |
| `src/http/respond.ts` | `ApiResponse`（静态工厂 ok/fail）+ `ErrorFactory` 写头辅助 | `Retry-After` 逻辑 |
| `src/http/rateLimit.ts` | `RateLimiter` / `MemoryRateLimiter` / `PostgresRateLimiter` | §6.5 |
| `src/http/authGuard.ts` | `JwtAuthFilter` + `RequestAuthContext` | SV-002 回查 |
| `src/http/schemas.ts` | `dto/` 下各 Request DTO + `ValidationSupport` | 逐 schema 对位（含边界值） |
| `src/http/validate.ts` | `ValidationSupport` + `EmailValidator`/`PasswordValidator` | issues 结构 |
| `src/routes/*.ts`（8 文件） | `controller/AuthController`/`MeController`/`SettingsController`/`StatsController`/`MemoryController`/`TaskController`/`BackupController`/`A2aController` | 路由→方法级映射，**路径与动词逐条不变** |
| `src/services/*.ts`（8 文件） | `service/` 同名类 | 事务边界、审计写点、错误分支逐条移植 |
| `src/security/*.ts` | `TokenService` / `PasswordService` | §6.3/§6.4 |
| `test/**`（11 文件） | `src/test/...`（§7） | |
| `migrations/*.sql` | **原地保留** | 不属于 Java 构建产物，运行期从磁盘读取 |
| `package.json` / `tsconfig.json` / `vitest.config.ts` / `tsx` 相关 | 删除，替换为 `pom.xml` | 旧文件仅存 git 历史 |

---

## 5. 路由清单（40 条，逐条移植台账）

> 用途：实施时的勾稽表；每条移植后须在本表打勾并由测试覆盖（§7）。路径/动词/守卫/限流桶/成功状态码/信封形态六项一致。

| # | 方法 路径 | 守卫 | 成功码 | 特殊点 |
|---|---|---|---|---|
| 1 | POST /v1/auth/register | 无 | 201 | 注册即发令牌 |
| 2 | POST /v1/auth/login | 无 | 200 | fakeVerify 时耗均衡 |
| 3 | POST /v1/auth/refresh | 无 | 200 | 轮换+重用检测 |
| 4 | POST /v1/auth/logout | 有 | 200 | allDevices 分支 |
| 5 | POST /v1/auth/change-password | 有 | 200 | 新旧令牌过渡语义 |
| 6 | POST /v1/auth/send-code | 无 | 200 | 配额/冷却/devCode |
| 7 | POST /v1/auth/login-with-code | 无 | 200 | 自动注册/设备三模式 |
| 8 | GET /v1/me | 有 | 200 | |
| 9 | PATCH /v1/me | 有 | 200 | |
| 10 | DELETE /v1/me | 有 | 200 | 密码确认+审计置 NULL |
| 11 | GET /v1/me/sessions | 有 | 200 | |
| 12 | DELETE /v1/me/sessions/:sessionId | 有 | 200 | |
| 13 | GET /v1/me/devices | 有 | 200 | isPrimary 恒 false（现状保留） |
| 14 | DELETE /v1/me/devices/:deviceId | 有 | 200 | 自助解绑 |
| 15 | GET /v1/me/audit | 有 | 200 | limit≤200 |
| 16 | GET /v1/settings | 有 | 200 | 无行时 {revision:0,data:{}} |
| 17 | PUT /v1/settings | 有 | 200 | revision 乐观并发 |
| 18 | PATCH /v1/settings | 有 | 200 | 合并后验尺寸 |
| 19 | DELETE /v1/settings | 有 | 200 | |
| 20 | POST /v1/stats/events | 有 | 201 | 单批+配额 |
| 21 | GET /v1/stats/summary | 有 | 200 | 默认近 30 天 |
| 22 | GET /v1/stats/daily | 有 | 200 | tz 分日 |
| 23 | GET /v1/stats/overview | 有 | 200 | |
| 24 | DELETE /v1/stats/events | 有 | 200 | |
| 25 | GET /v1/memories | 有 | 200 | 键集分页；CJK→ILIKE（SV-005 保留） |
| 26 | GET /v1/memories/:id | 有 | 200 | |
| 27 | POST /v1/memories | 有 | 201/200 | clientMemoryId 幂等；created 区分 |
| 28 | PATCH /v1/memories/:id | 有 | 200 | |
| 29 | DELETE /v1/memories/:id | 有 | 200 | ?hard=true |
| 30 | POST /v1/memories/bulk | 有 | 200 | ≤maxMemoriesPerBulk |
| 31 | GET /v1/tasks | 有 | 200 | archived 归一化；limit≤2000 |
| 32 | POST /v1/tasks/bulk | 有 | 200 | ≤500；仅元数据 |
| 33 | GET /v1/backup | 有 | 200 | truncated 标注（SV-001） |
| 34 | GET /v1/backup/download | 有 | 200 | 裸包+Content-Disposition |
| 35 | POST /v1/restore | 有 | 200 | 单事务 merge/replace |
| 36 | POST /v1/a2a/messages/bulk | 有 | 200 | 二次脱敏+截断 |
| 37 | GET /v1/a2a/messages | 有 | 200 | 游标分页 |
| 38 | POST /v1/a2a/cards/bulk | 有 | 200 | |
| 39 | GET /healthz | 无 | 200 | 跳限流；裸体 |
| 40 | GET /readyz | 无 | 200/503 | UNAVAILABLE 统一错误体（SV-008） |

> 【实施前核对】以 `Server/src/routes/*.ts` 与 `app.ts` 实际注册为准逐行复核本表（本表由设计文档附录 C + A2A 增量合成，可能存在个别遗漏的隐藏端点，实施第一步即做代码级重盘点）。

---

## 6. 关键兼容性设计

### 6.1 Wire 契约保真（C1–C4）

- 信封、错误码、状态码、头字段由 `ApiResponse`/`GlobalExceptionHandler`/各 Filter 集中实现，逐路由断言（§7.2 契约测试）。
- 404/405/415/413/400 等**框架级兜底**必须映射为现信封：Spring 默认的 `ProblemDetail`/`Whitelabel` 全部关闭，统一走 advice。
- JSON 序列化逐字段核对：**空对象 vs null vs 省略**（例：`displayName: null` 是否输出）、数组空 `[]`、`details` 仅在存在时输出。

### 6.2 迁移与 checksum 字节一致（C10）

- **策略：`migrations/*.sql` 文件原样保留（含行尾符）**，Java 迁移器读磁盘文件、`sha256(原始字节)` 计算 checksum —— 与 TS 版算法一致（sha256 of file content）。
- 验证：拿 TS 版迁移过的库跑 Java 版 `migrate:status` 等价命令 → **0 漂移**；Java 版对空库新迁移 → `schema_migrations` 行的 version/name/checksum 与 TS 版完全一致（可双跑比对）。
- 构建配置：确保 Maven 资源处理**不触碰** `migrations/`（不要复制到 `target/classes` 后变行尾）；运行期路径与 `SERVER_ROOT` 逻辑对位。
- **迁移器行为对位清单**：排序规则、version=前缀、逐文件事务、dry-run、漂移报错文案。

### 6.3 Argon2id PHC 跨语言互认（J3，最高风险项）

- TS 参数：`Argon2id, memoryCost=19_456 KiB, timeCost=2, parallelism=1, outputLen=32`，输出标准 PHC `$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>`。
- Java 方案（二选一，实施前做**互认冒烟**）：
  - A：**BouncyCastle `Argon2BytesGenerator`**（自行解析/生成 PHC 串，控制最强）；
  - B：Spring Security `Argon2PasswordEncoder`（内置 PHC 处理；需确认其对 m/t/p 参数的编码与 TS 串位对兼容）。
- **冒烟脚本（M1 门禁）**：从 TS 测试库取真实哈希 5 条 → Java 校验全通过；Java 新建用户 → TS 脚本校验通过。任一失败则切换到方案 A 手写 PHC 编解码（格式固定，风险可控）。
- `fakeVerify`（防枚举时耗拉平）用固定损坏哈希对位复刻。

### 6.4 JWT 与令牌（C5/C6/C7）

- 声明顺序无关，但**字段名与值域**一致；`typ=access` 必须写入；时钟容差对齐（现状 jose 默认允许 0 秒偏差——重写保持严格，不加 leeway，避免语义漂移）。
- `verifyAccessToken` 错误分流：`ExpiredJwtException`→`TOKEN_EXPIRED`；其余（签名/结构/aud/iss）→`UNAUTHENTICATED '访问令牌无效'`；缺 sub/sid→'令牌缺少必要声明'。
- 刷新令牌 sha256 hex 计算、base64url 无填充编码、家族吊销 SQL（`revokeFamily`/`revokeById`+`rotated_to`）逐条移植。
- 守卫的 `sid` 回查（SV-002）与 6 处业务路由接线保持一致。

### 6.5 限流语义（C3）

- 内存实现：**滑动窗口 60s**（`Map<key, long[]>` 语义对位：窗口内时间戳列表、`peek` 不消费、`reset`、`dispose` 停清理定时器）；`retryAfterSec` 计算口径（ceil）。
- PG 实现：单条原子 UPSERT（`INSERT ... ON CONFLICT (bucket_key) DO UPDATE SET ... CASE WHEN 窗口过期 THEN 重置`）→ `RETURNING used, window_start`；固定窗口（与内存语义差异**保留**并在注释声明）；DB 异常→warn 日志"限流共享存储不可用，回退到进程内限流"+ 内存兜底。
- 清理任务：10min 周期删过期桶（保留 3 窗口），Java 用 `@Scheduled(fixedDelay)`；线程池设为 daemon/`setDaemon` 或 shutdown 时显式关闭。
- 键拼装与跳过的路径清单（`/healthz`、`/readyz`）对齐 `app.ts`。

### 6.6 时间与数字格式（C11）

| 场景 | JS 现状 | Java 做法 |
|---|---|---|
| 响应中的 `Date`（如 `createdAt`/`expiresAt`/`updatedAt`） | `toISOString()` → `2026-10-13T12:34:56.789Z` | Jackson 自定义 `LocalDateTime/Instant` 序列化器：UTC + 毫秒（**3 位固定**）+ `Z`；禁止输出无毫秒变体 |
| pg `int8`（bigint） | 全局解析为 JS number | RowMapper 手动转 `Long`（Jackson 输出为 number，**不加引号**；禁用 `WRITE_BIGDECIMAL_AS_PLAIN` 之类意外行为） |
| `numeric`（stats value） | number | `BigDecimal` → Jackson number（避免科学计数法与尾零抖动） |
| 请求 `occurredAt` 等 | Zod `datetime({offset:true})`→Date | `OffsetDateTime` 解析且**必须带时区偏移**（无偏移→VALIDATION_ERROR，文案'需为 ISO 8601 时间（含时区）'） |
| epoch-ms 列（tasks/a2a） | number passthrough | `Long` 直传，不做转换 |

### 6.7 配置系统（C14）

- `.env` 解析：`KEY=VALUE`、注释、空行、**真环境变量优先**——`ConfigLoader` 逐条对位 `config.ts`（含 `parseEnvFile`/`readEnv` 的细节行为）。
- 40+ 变量默认值、生产 fail-closed 规则、警告清单逐条列表移植（错误/警告**文案保持中文原样**，便于运维肌肉记忆与文档对账）。
- 端口/HOST 来自 `HOST`/`PORT`（Spring 的 `server.port` 不直接暴露，由 `ConfigLoader` 装填到 `ServerConfig.port` 后设置内嵌容器）。
- `STATS_TIMEZONE` 影响统计分日：Java 用 `ZoneId` 对位 JS 的时区分桶算法（**注意跨日边界用例**，纳入测试）。

### 6.8 缺陷不回归对照（SV 清单）

| ID | 状态 | 重写版义务 |
|---|---|---|
| SV-001 备份截断 | 🟩 修复 | 键集分页全量 + `truncated.stats` 显式标注（含路由 schema 校验 1..100000 与两处透传） |
| SV-002 旧令牌即时吊销 | 🟩 修复 | 守卫 `sid` 回查（C7） |
| SV-003 PG 共享限流 | 🟩 修复 | 双实现 + `RATE_LIMIT_STORE` 开关 + 故障回退 |
| SV-004 令牌清理接线 | 🟩 修复 | 启动即扫 + 每 6h + unref 等价（不阻止退出） |
| SV-005 CJK 检索 | ⬜ 限制 | `containsCjk` → ILIKE 双路径**保留**（不得"顺手优化"引入行为差异；优化留独立议题） |
| SV-006 测试污染 | 🟩 修复 | 迁移漂移用例清理 `version='999'` 行（重写测试时注意 try/finally 位置之争——**采用 finally 清理**，同时报 SV-006 文档待裁口径） |
| SV-007 备份明文 | ⬜ 限制 | 保持明文、不新增加密字段（加密留独立议题） |
| SV-008 /readyz 统一错误体 | 🟩 修复 | `UNAVAILABLE(503)` 走统一信封 |
| SV-009~SV-014 | 🟩 修复 | 分别对位：类型/文案（SV-009/010 在 Java 静态类型下自然消除，但**验证码错误文案**须显式保留）、测试覆盖（SV-011→§7）、验证码加固（C9）、邮件通道（生产缺配置拒启）、设备凭据（credential_hash 语义） |

---

## 7. 测试策略（117 项语义等价迁移）

### 7.1 分层

| 层 | TS 现状 | Java 对位 | 说明 |
|---|---|---|---|
| unit/config（11 项） | `test/unit/config.spec.ts` | `ConfigLoaderTest` | 纯 JUnit，不启 Spring |
| unit/core（21 项） | 核心纯函数 | `TokenServiceTest`/`RateLimiterTest`/`RedactTest`/`CursorTest` 等 | 对应被测符号逐一映射 |
| integration（85 项） | vitest + inject + 真 PG | `@SpringBootTest` + MockMvc + Testcontainers 或本机 PG | 优先 **Testcontainers（postgres:16）**：CI 无库也能跑；本机 Docker 不可用时回退 `TEST_DATABASE_URL`（与现状"无库自动跳过"对位） |
| helpers（test/helpers） | `app.ts`/`pg.ts` | `TestAppFactory`/`PgTestBase`（truncateAll 清表清单一致，含 verification_codes/user_devices） | |

### 7.2 契约测试（新增，超出 TS 覆盖的补强）

- 全 40 路由的**信封/状态码/头**矩阵测试（表驱动）：由本文件 §5 台账生成。
- JSON 逐字段 schema 快照测试：时间格式（毫秒+Z）、bigint as number、错误体结构。
- 差分冒烟（§7.3）。

### 7.3 双跑差分验证（J1/J2 的硬证据）

在原始 TS 版**仍可从 git 检出**的前提下：
1. 同一 PostgreSQL 库，先用 TS 版灌数据（注册/记忆/任务/A2A/备份）；
2. Java 版接同一库启动，对**同输入同令牌**逐路由请求，断言响应 JSON 语义相等（忽略键序、时间毫秒级容差 0、字段集合一致）；
3. 反向：Java 版写入后 TS 版读取，校验互认（密码/令牌/记忆）。
> 该步骤在 `Server/` 被替换后无法原地执行 → **安排为 M2-M5 每里程碑末尾的临时双跑**（从 git 检出旧版到 `.tmp/servertjs-diff`，**不落库产物、不入库代码**，属于一次性验证脚手架）。若用户不接受临时目录方案，降级为"响应快照人工比对"（保留快照 JSON 于测试资源）。【待确认项 Q2】

### 7.4 覆盖勾稽表

`Docs/Server/01-服务端/` 下新增**测试映射表**（实施期产出，或并入本文件附录）：TS 117 项 → Java 测试方法逐条映射，**任一项无人认领即不可宣告完成**。

---

## 8. 里程碑拆分（每步含独立验收）

| 里程碑 | 内容 | 验收（运行级） |
|---|---|---|
| **M1 · 骨架与配置** | Maven 工程、`ConfigLoader`+`ServerConfig`+fail-closed、日志 JSON 脱敏、`Db`+Hikari、`MigrationRunner`、/healthz /readyz、启动/优雅停机 | unit/config 11 项对位全绿；`migrate:status` 对 TS 库 0 漂移；生产缺密钥拒启（文案一致） |
| **M2 · 鉴权域** | 错误体系/信封/过滤器链、TokenService、PasswordService、auth 全 7 路由、me 全 8 路由、守卫 sid 回查 | auth 14 + verificationCode 14 + 密码互认冒烟（§6.3）；契约矩阵（鉴权段）通过 |
| **M3 · 数据域** | settings 4 + stats 4 + memories 6 路由（含事务/幂等/分页/时区分桶） | settings 9 + stats 9 + memories 9 对位 |
| **M4 · 任务/备份/A2A** | tasks 2 + backup 3 + a2a 3 路由（keyset 全量、单事务恢复、脱敏截断、游标） | tasks 6 + backup 9 + A2A 新增若干；差分验证（§7.3）通过 |
| **M5 · 限流与平台** | memory/postgres 双限流、写限流、CORS、安全头、body limit、404/415/413 兜底、平台测试 | rateLimitStore 6 + platform 9 对位（含双实例共享计数复现） |
| **M6 · 收口** | 全量回归、前端连通冒烟（J4）、文档/脚本更新（§11）、旧文件删除、CHANGELOG 登记 | J1–J7 全绿；`Client/` 无改动跑通登录链路 |

**分支策略**：新分支 `rewrite/server-java`（名待定，见 Q3）。现状注意：`main` 工作区有大量未提交修改（客户端/文档），**开分支前先确认这些修改的处置**（提交/暂存），避免替换 `Server/` 时混入无关变更。【待确认项 Q4】
**提交粒度**：每里程碑独立提交（替换是破坏性操作，保留可回退点）；`Server/` 旧内容删除与 Java 版新增在**同一组提交**内完成（避免中间态双实现并存被误用）。

---

## 9. 风险清单

| # | 风险 | 等级 | 缓解 |
|---|---|---|---|
| R1 | Argon2id PHC 互认失败（m/t/p 参数编码差异） | 高 | M1 冒烟门禁（§6.3），失败即切 BouncyCastle 手写 PHC |
| R2 | 迁移 checksum 漂移（行尾/编码被构建流程改动） | 高 | 文件字节不动 + 构建排除 + M1 对真实库验证 |
| R3 | JSON 序列化细节漂移（null/省略/时间/数字） | 高 | 契约快照测试 + 双跑差分（§7.3） |
| R4 | 钩子链顺序/语义偏差（限流桶判定、写限流触发条件） | 中 | 以 `app.ts` 源码逐行为移植依据；矩阵测试覆盖 |
| R5 | 定时器存活语义（unref≈不阻止退出） | 中 | daemon 线程 + shutdown 显式 stop；进程退出冒烟 |
| R6 | 40 路由台账遗漏（设计文档与代码已有漂移史：006/A2A 未入档） | 中 | M1 第一步代码级重盘点（§5 注） |
| R7 | Testcontainers 依赖 Docker（本机可用性未知） | 中 | 双通道：Testcontainers 优先、TEST_DATABASE_URL 回退、均不可用则跳过（与现状一致） |
| R8 | 生产文案/日志口径漂移（中文文案被"顺手翻译"） | 低 | 文案清单化对位，纳入测试断言 |
| R9 | 文档-代码再次漂移（本计划执行后 设计文档附录需回写） | 低 | M6 统一回写；CHANGELOG 登记 |

---

## 10. 待确认项（实施启动前需人工裁定）

| # | 问题 | 默认建议 |
|---|---|---|
| Q1 | Java `static final` 常量命名：用户约束"大驼峰+小驼峰"是否也覆盖常量（即 `jwtIssuer` 而非 `JWT_ISSUER`）？ | 默认按 Java 惯例 `UPPER_SNAKE`（常量非"对外契约"），若要求严格 camelCase 请指示 |
| Q2 | 差分验证（§7.3）需临时检出旧 TS 版到 `.tmp/` 跑双服务——是否接受该一次性脚手架？（否则降级为快照比对） | 建议接受（证据强度最高，且产物不入库） |
| Q3 | 目标分支名（建议 `rewrite/server-java`） | 建议值 |
| Q4 | `main` 上大量未提交修改（Client/Docs 等）如何处置后再开分支？ | 建议先提交/或确认这些修改与本任务无关后带工作区开分支（不做 stash 风险动作） |
| Q5 | Spring Boot 版本与 Java release：本机 JDK 23，建议 `maven.compiler.release=21`（LTS 运行兼容），Boot 3.3.x | 建议值 |
| Q6 | `Server/README.md` 更新口径：直接改写为 Maven 版本（旧 npm 命令仅在 CHANGELOG/文档留痕） | 建议值 |

---

## 11. 文档与周边更新清单（M6 执行）

| 对象 | 动作 |
|---|---|
| `Server/README.md` | 全面改写：Maven 命令（`mvn spring-boot:run`/`mvn test`/迁移命令）、目录结构、部署口径 |
| 根 `package.json` | `server:*` 6 条脚本改写为 Maven 口径或标注"服务端已迁移至 Maven，见 Server/README.md"（**保留脚本名**避免下游引用断裂） |
| `Docs/Server/01-服务端/服务端设计文档.md` | §2.4 技术选型、附录 A（环境变量不变但补充 Java 装载说明）、附录 C/E（路由对账口径）、§10 测试计数更新为 JUnit 口径；**A2A 域与迁移 006 入档**（历史欠账一并还） |
| `Docs/Server/01-服务端/服务端缺陷清单.md` | SV 条目全部复核（代码为 Java 版）+ 新增"重写引入风险"记录（如有）；SV-006 待裁项同步 |
| `Docs/Client/03-AI组件架构/后端接口契约.md` | 如含服务端路径/字段，核对无措辞漂移（应无字节变化） |
| `Docs/CHANGELOG.md` / 根 `CHANGELOG.md` | 分别登记：文档集变更 / 代码变更（重写本身） |
| `agent.md` §1 表格 | "Server 独立 npm 包"描述更新为 Maven/Spring Boot |
| `Scripts/*` | 核查是否引用 `Server/` npm 脚本（`package.cjs` 等），按需更新 |

---

## 12. 附录：实施第一步（M1 前置动作）

1. **代码级重盘点**：以 `Server/src/routes/*.ts` + `app.ts` 为准，逐行生成 40 路由六要素台账（§5 表补全/纠偏）；
2. **契约快照抓取**：对 TS 版跑一遍全路由（成功+典型错误），把响应 JSON+头存为测试资源（供 Java 版快照对位）——**在替换 `Server/` 之前执行**；
3. **真实库基线**：用 TS 版对演练库完成 001–006 迁移并记 `schema_migrations` 全行（checksum 基线）；
4. 取 5 条真实 Argon2 PHC 哈希 + 1 组有效刷新令牌（测试账号）作为 M1 互认冒烟样本。

> 以上三步产物存放于测试资源/本地 `.tmp`，**不入库生产数据**；测试账号与哈希样本使用合成数据（不取真实用户）。

---

**计划完毕。** 待 Q1–Q6 裁定后即按 M1→M6 执行；执行中每里程碑完成后回写本文件状态与 CHANGELOG。

---

## 13. 实施记录（2026-10-13 ~ 2026-10-14，分支 `rewrite/server-java`）

> 本节为执行回写：里程碑状态、验收证据、实施中的取舍与偏差、踩坑记录。Q1–Q6 均按默认建议裁定执行。

### 13.1 里程碑状态

| 里程碑 | 状态 | 验收证据 |
|---|---|---|
| M1 · 骨架与配置 | ✅ 完成 | unit/config 11 项对位全绿；`migrate:status` 对 TS 库 0 漂移；生产缺密钥拒启 |
| M2 · 鉴权域 | ✅ 完成 | auth 14 + verificationCode 14；Argon2 PHC 互认冒烟通过 |
| M3 · 数据域 | ✅ 完成 | settings 9 + stats 9 + memories 9 对位 |
| M4 · 任务/备份/A2A | ✅ 完成 | tasks 6 + backup 9 + A2A 3 路由；备份 keyset 全量 + 单事务恢复 |
| M5 · 限流与平台 | ✅ 完成 | rateLimitStore 6 + platform 9；双实例共享计数复现通过 |
| M6 · 收口 | ✅ 完成 | 全量 `mvn -B test` **138/138 绿**（旧 TS 文件删除后重跑）；E2E 全绿；客户端连通冒烟全绿；真实 Agent 三轮 4/4 绿；文档/脚本回写完成；旧 TS 文件删除 |

### 13.2 J1–J7 验收对位

| 项 | 结果 | 证据 |
|---|---|---|
| J1 全量测试 138/138 | ✅ | `.tmp/m6-final-mvn-test.out`（收口期全量 `mvn -B test` 138/138 绿 + `BUILD SUCCESS`；早前 137/137 口径已被其覆盖） |
| J2 迁移零漂移 | ✅ | `--migrate-status` 对既有库 0 漂移；checksum 与 TS 版逐字节一致 |
| J3 E2E 九段脚本 | ✅ | `Server/scripts/verify-e2e.ps1` 全绿（注册→数据→备份→重装登录→清空→恢复→令牌重用→校验→响应头），输出留档 `.tmp/m6-server-e2e-java.out` |
| J4 前端零改动连通 | ✅ | `.tmp/m6-client-smoke.out`：tsx 直接驱动未改动的 `Client/src/services/serverApi.ts` 走通注册→读写→备份→令牌自动续期重试（refreshCalls=1） |
| J5 真实 Agent 三轮 | ✅ | `.tmp/m6-realagent-3rounds.out`：`Tests/AgentRuntime/realAgent.spec.ts` 4/4（Round1/2/3 + 并行守恒） |
| J6 生产缺密钥拒启 | ✅ | 无 `JWT_SECRET` 时启动即报错退出（文案与 TS 版一致） |
| J7 旧文件删除后无残留引用 | ✅ | 删除后全量测试仍 138/138（`.tmp/m6-final-mvn-test.out`）；`Scripts/*` 无 `Server/` npm 脚本引用 |

### 13.3 实施取舍与偏差（相对计划的显式差异）

| # | 偏差 | 说明 | 处置 |
|---|---|---|---|
| ① | **写限流单侧生效**（Java 实际生效、TS 为死代码） | TS `app.ts` 的写限流用实例级 `preHandler` 钩子，Fastify 实例钩子先于路由级鉴权钩子执行 → `request.auth` 恒为空 → 限流从未触发。Java 按"设计意图"实现于 `AuthInterceptor` 之后，**真实生效**（429 `写入过于频繁，请稍后再试`） | 属"修复型偏差"：对既有客户端无破坏（TS 版本来就从不 429）；已在缺陷清单登记 **SV-015** |
| ② | `seed:dev` 未移植 | 依赖跨工程 `Src/Infra/Security/deviceFingerprint.js`，属开发辅助脚本 | README §8 映射表标注"未保留" |
| ③ | 差分双跑 → 快照对位 | 按 Q2 裁定，未做临时检出双跑；以契约快照测试 + E2E 逐段断言对位 | 计划 §7.3 预案已按裁定降级，无遗留 |
| ④ | 手写 `Validator`（不用 hibernate-validator） | 需逐字对位 Zod 校验的错误文案与 `details`（含中文字段消息），注解式校验无法等价产出 | 手写校验层单测覆盖，E2E 文案逐段断言 |
| ⑤ | `--migrate` 等 CLI 由 `main()` 拦截 | 迁移命令需在 Spring 启动前执行且不初始化数据源 | `CivitasServerApplication.main()` 内 `MigrationCli.intercepts(args)` → `System.exit(MigrationCli.run(args))` |
| ⑥ | **TokenSweeper 初版漏接线**（重写引入、自查修复） | 重写初版未把过期刷新令牌清理接进应用生命周期（TS 版在 `index.ts` 启动时接线）→ 令牌表将单调增长；验证期抽查发现 | 补 `application/TokenSweeper.java`（6h 定时 + 守护线程 ≈ TS `unref()` + `DisposableBean.shutdownNow()`）；真实重启实测 `已清理历史刷新令牌 purged=1 olderThanDays=60`；缺陷清单「重写引入风险 1」已登记 |

### 13.4 实施踩坑记录（供后续维护参考）

1. **`DataSourceAutoConfiguration` 必须排除**：配置装载为两段式（先 `ConfigLoader` 读 env，再 `setDefaultProperties` 注入 `server.address`/`server.port`），若不禁用自动数据源，Hikari 会在配置就绪前初始化。
2. **`server.address/port` + `civitas.cleanupOnShutdown` 仅真实启动注入**：测试（`TestAppFactory`）走 MockMvc，不注入保证随机端口/不清理；真实启动路径唯一注入点。
3. **静态 `Bootstrap` 多测试上下文安全**：多个 `@SpringBootTest` 上下文并存时，Bean 在启动瞬间捕获静态单例快照，测试间不串扰（注意不要在多测试类中并发改动静态状态）。
4. **Windows GBK 控制台乱码**：`verify-e2e.ps1` 中 `curl.exe` 输出 UTF-8 中文被按 GBK 解码，偶发拆字导致 JSON 解析失败（曾误报"0 条记忆"/错误码为空）。修复：脚本内 `[Console]::OutputEncoding = UTF8`（已随脚本提交）。
5. **迁移 SQL 字节不可动**：`MigrationRunner` 读文件字节计算 checksum，任何编辑器"顺手格式化"都会造成漂移（R2 缓解措施生效中）。

### 13.5 证据文件索引（均在 gitignored `.tmp/`，不随库提交）

| 文件 | 内容 |
|---|---|
| `.tmp/m6-server-e2e-java.out` | `verify-e2e.ps1` 九段真实 HTTP 输出（注册→数据→备份→重装登录→清空→恢复→令牌重用→校验→响应头） |
| `.tmp/m6-final-mvn-test.out` | 收口期全量 `mvn -B test` **138/138 全绿**（TS 旧文件删除后重跑，含 `BUILD SUCCESS`） |
| `.tmp/m6-client-smoke.out` | 客户端 `serverApi.ts` 真实驱动冒烟（含令牌续期） |
| `.tmp/m6-realagent-3rounds.out` | 真实 Agent 三轮 + 并行守恒（4/4） |
| `Server/.verify-out/`（gitignored） | `verify-e2e.ps1` 运行产物（响应快照） |

### 13.6 环境事实（收口时）

- 本机 JDK 23.0.2 / Maven 3.9.11；`maven.compiler.release=21`（Q5 裁定）。
- 测试库：`postgres://postgres@127.0.0.1:55432/civitas_server_test`（本机 PG 集群，收口后保留运行，未被脚本删除）。
- 真实密钥 `HUAWEI_MAAS_API_KEY` 由环境注入，未落盘任何凭据。

### 13.7 测试类级勾稽表（TS 126 项 → Java 138 项）

> 供设计文档 §1.3 / §10.4 的"逐条对位"引用。TS 计数以 `Server/test/**`（删除前实盘）为准：
> **12 个 spec / 126 项**（unit 2 文件 32 项 + integration 10 文件 94 项）；Java 为 **15 个测试类 / 138 项**
> （unit 5 类 42 项 + integration 10 类 96 项）。净增 12 项 = 语义对位之外的补强。

| TS 原文件（项数） | Java 测试类（项数） | 差异说明 |
|---|---|---|
| `unit/config.spec.ts`（11） | `config/ConfigLoaderTest`（14） | **+3**：弱密钥/端口等边界值增补 |
| `unit/core.spec.ts`（21） | `security/CryptoVectorsTest`（10）+ `http/AppExceptionTest`（6）+ `http/RateLimiterTest`（4）+ `db/DbBindingTest`（8） | 密码/令牌向量 9 + 限流 3 + 错误对象 2 等按类拆分对位（共 20 项）；`DbBindingTest` **8 项为 Java 专有**（`$1`→`?` 占位符翻译与参数绑定）；净 **+7** |
| `integration/auth.spec.ts`（14） | `integration/AuthIntegrationTest`（14） | 1:1 |
| `integration/verificationCode.spec.ts`（14） | `integration/VerificationCodeIntegrationTest`（14） | 1:1（含 SV-004 清理用例，见下注） |
| `integration/platform.spec.ts`（9） | `platform/PlatformBasicsTest`（11） | **+2**：请求体上限等边界增补；收口期新增 `SV015_已鉴权写请求进入write桶_达上限返回429`（写限流=2 时第 3 次写 429，证据见 §13.3 偏差①） |
| `integration/a2a.spec.ts`（9） | `integration/A2aIntegrationTest`（9） | 1:1 |
| `integration/backup.spec.ts`（9） | `integration/BackupIntegrationTest`（9） | 1:1 |
| `integration/memories.spec.ts`（9） | `integration/MemoriesIntegrationTest`（9） | 1:1 |
| `integration/settings.spec.ts`（9） | `integration/SettingsIntegrationTest`（9） | 1:1 |
| `integration/stats.spec.ts`（9） | `integration/StatsIntegrationTest`（9） | 1:1 |
| `integration/rateLimitStore.spec.ts`（6） | `integration/RateLimitStoreIntegrationTest`（6） | 1:1 |
| `integration/tasks.spec.ts`（6） | `integration/TasksIntegrationTest`（6） | 1:1 |
| **合计 126** | **合计 138** | **净 +12**（ConfigLoaderTest +3、core 拆分 +7、PlatformBasicsTest +2） |

> 注：`AuthIntegrationTest` 第 291 行起含 `SV004_purgeInactive清理超龄历史令牌…` 用例（TS 版即有），
> 覆盖 §13.3 偏差⑥所修「定时清理未接线」的另一半（仓储函数本身）；接线侧由 `application/TokenSweeper.java` 承载。

