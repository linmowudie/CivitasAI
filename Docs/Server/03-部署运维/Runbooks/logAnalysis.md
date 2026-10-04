# 日志分析 Runbook

> 日志结构说明与常用分析方法

---

## 日志结构

日志由 `Src/Infra/Logging/logger.ts` 生成、`Src/Infra/Logging/logWriter.ts` 落盘，**JSON Lines**（每行一条独立 JSON，`\n` 拼接）。

### 真实字段（2026-10-03 校准：按 `LogLine` 与 `log()` 重写）

```json
{
  "timestamp": "2026-10-03T19:22:21.217Z",
  "epochMs": 1791055341217,
  "level": "info",
  "track": "business",
  "message": "会话自动命名",
  "source": "ipcBridge",
  "data": { "sessionId": "sess-47cc54c8", "title": "目录文件计数", "byModel": true }
}
```

字段定义来自 `LogLine`（`Src/Infra/Logging/logWriter.ts:46-67`），组装点在 `log()`（`Src/Infra/Logging/logger.ts:171`、`:185-196`）：

| 字段 | 必现 | 说明 |
|------|------|------|
| `timestamp` | 是 | ISO-8601 |
| `epochMs` | 是 | epoch 毫秒（做时间差/排序用） |
| `level` | 是 | `debug`/`info`/`warn`/`error`/`fatal` |
| `track` | 是 | `business` / `system`（决定落哪个文件） |
| `message` | 是 | 中文短语，是 grep 的主锚点 |
| `source` | 否 | 模块名，如 `main`、`ipcBridge`、`aiEventStore` |
| `data` | 否 | 附加结构体（**字段名是 `data`，不是 `metadata`**） |
| `traceId` / `spanId` / `operationId` | 否 | 仅当存在 trace 上下文时写入（`logger.ts:191` 要求 `traceId !== 'no-trace'`）。**实测 `Logs/business.log` 中三者出现 0 次**，见 §常用分析 1 |

**已删除的过时示例**：原文档示例里的 `trace_id` / `operation_id` / `metadata`（snake_case + `metadata`）在代码与真实日志中**均不存在**（`grep` 实测 0 次）；示例消息 `"模型调用完成"` 在 `Src/`、`Server/` 也 0 命中。字段与 `Logs/README.md` 的列表一致。

## 日志文件与轨道

`Logs/` 现状（2026-10-03 校准）：

| 文件 | 写入条件 | 现状 |
|------|---------|------|
| `business.log` | `track === 'business'`（`logWriter.ts:194`）→ **info / debug / warn** | 存在，509,191 B / 2,695 行（info 2,603、warn 92、**error 0**） |
| `system.log` | `track === 'system'`（`logWriter.ts:201`）；`routeTrack()` 把 **error / fatal 默认路由到 system 轨**（`logger.ts:219-225`） | **存在**（首个错误行 230 B），但只在真的出错后才生成 |
| `business.log.1`、`system.log.1` … | 单文件超 10MB 轮转（`logWriter.ts:71`、`:271-290`） | 尚未产生；**注意 `.1` 不被 `Logs/*.log` 匹配** |
| `_Meta/config.json` | 每次 flush 写 `lastFlushAt` / `writeFailed` / `logDir`（`logWriter.ts:295-310`） | 存在 |
| `dev-server.out` | `npm run dev` 的控制台重定向（临时文件，非 JSON，可删） | 存在（历史，2026-09-15） |

## 常用分析

> **glob 用法（2026-10-03 校准）**：错误统计走 `Logs/system.log*`，业务统计走 `Logs/business.log*`。
> 不要用 `Logs/*.log`：既漏掉轮转产物 `.log.1`，也容易把非日志文件卷进来；对可能含非 JSON 行的输入，用 `jq -R 'fromjson? // empty'` 兜底。

### 1. 按 traceId 追踪链路 —— ⚠️ 当前不可用

```bash
# 现状核查：traceId 键在业务日志中 0 命中，因此本节无法产出链路视图
grep -c '"traceId"' Logs/business.log      # 实测输出 0
```

- 能力是有的（`Src/Infra/Logging/traceContext.ts` + `logger.ts:176-179` 取 trace 上下文、`:191` 决定是否写入），但 `Src/` 内**找不到任何建立 trace 上下文的调用点**（`grep -rn "runWithTrace\|withTrace\|startTrace\|setTrace" Src/` 0 命中）。
- `Scripts/traceAnalysis.ts`（`npx tsx Scripts/traceAnalysis.ts --traceId=xxx`）读的是**本进程 fresh 的内存事件总线**（`getEventLog()`，`Src/Services/EventBus/eventBus.ts:117`），不连运行中的服务，独立执行恒返回空结果——**不能当作线上分析工具**。
- 替代（按会话而非按 trace 追）：`curl -s "http://localhost:3000/api/sessions/<sessionId>/ai-events" | jq '.data.total'`（持久化事件流，`Src/Interface/RestApi/chatApi.ts:476`；响应由 `router.ts:32-34` 统一包成 `{ok, data}`，事件数组在 `.data.events`）。

**【需人工裁定】现状记录 + 待办**：`traceId` 全缺有两种解释——①业务路径根本没建 trace 上下文（代码侧缺失）；②样本期内无并发业务。当前证据只支持"代码里没有建立 trace 的调用点"，是否补建、在哪一层补，留人工定夺；本文档不宣称链路追踪已可用。

### 2. 统计错误分布（错误在 system 轨）

```bash
# 全部错误按模块分布
grep '"level":"error"' Logs/system.log* | jq -r '.source' | sort | uniq -c | sort -rn

# 只看最新若干条
tail -n 20 Logs/system.log | jq -c '{timestamp, level, source, message, data}'

# 业务轨里的告警
grep '"level":"warn"' Logs/business.log* | jq -r '.source' | sort | uniq -c | sort -rn
```

### 3. 模型调用延迟分析 —— ⚠️ 未实现（原示例已删除）

- 原示例 `grep "模型调用完成" ... | jq -r '.metadata.latencyMs'` 两处都不成立：消息 `"模型调用完成"` 全仓 0 命中；`latencyMs` 只作为 **`systemMetricsHook` 的入参**出现在 debug 级日志里（`Src/Infra/Hook/System/auditHook.ts:48-61`，`source: 'SystemHook/metrics'`），而该 hook **没有任何调用点**、`PostModelCall` 事件也**没有任何发布点**（`grep` 仅命中其定义），因此实测 `grep -c "SystemHook/metrics" Logs/business.log` = **0**。
- 结论：日志里拿不到模型延迟。真实可用手段是外部实测脚本：

```bash
node Scripts/llmLatency.cjs                 # 实测华为云 MaaS 各模型流式首响延迟（需 HUAWEI_MAAS_API_KEY）
node Scripts/llmLatency.cjs GLM-5 DeepSeek-V4-Flash
node Scripts/dupCheck.cjs                   # 诊断同一 chunk 是否被双重推送
```

- 首字节/块间超时的配置项在 `Configs/modelRouter.json:50-52`（`timeoutMs` / `firstByteTimeoutMs` / `interChunkTimeoutMs`），排查见 `commonIssues.md` §4。

### 4. Token 消耗趋势

```bash
# 日志侧：data 的键不固定，jq 恒为 null 属正常（不要用 .metadata.*）
grep '"source":"aiEventStore"' Logs/business.log* | jq -c '{timestamp, message, data}'

# 正解：查账本表 / API（token_transactions 表在 civitas_main.db）
#   注意 REST 响应统一包一层 {ok, data}（Src/Interface/RestApi/router.ts:32-34），取值走 .data
curl -s "http://localhost:3000/api/tokens/transactions" | jq -r '.data[].amount' | sort -n | tail -5   # tokenApi.ts:70
curl -s "http://localhost:3000/api/tokens/overview" | jq '.data'                                       # tokenApi.ts:56
node -e "const db=require('better-sqlite3')('Data/db/civitas_main.db',{readonly:true});
console.log(db.prepare('SELECT type, COUNT(*) n, SUM(amount) s FROM token_transactions GROUP BY type').all())"
```

**`token_transactions` 的列名是 snake_case**（`transaction_id, wallet_id, trace_id, operation_id, type, amount, balance_after, description, metadata, created_at, owner_user_id`）——与日志行的 camel 字段（`traceId`/`operationId`/`data`）**不同源不同命名**，两套写法别混用；库侧才有 `trace_id`/`operation_id` 可查。

### 5. 按 `source` 维度看系统在做什么

`source` 稳定存在（`logger.ts:194`），是比消息文本更可靠的分组键。实测 `Logs/business.log`（2,695 行）取值分布：

| `source` | 次数 | 备注 |
|----------|------|------|
| `main` | 1,829 | 启动/初始化里程碑（日志系统、数据库、HTTP、Loop 控制等） |
| `SharedMemory/LongTermMemory` | 407 | 「长时记忆已按属主回灌」 |
| `ipcBridge` | 259 | Electron IPC 命令与自动命名 |
| `runIteration/executeLoop` | 82 | 「主循环启动」/「主循环结束」各 41 |
| `aiEventStore` | 35 | `ai_events` 落库/读取告警 |
| `ipcBridge/streamGeneration` | 33 | 「主循环执行完成」 |
| `wsHandler/streamGeneration`、`wsHandler` | 24、3 | **历史残留**：WS 已于 2026-09-28 删除（`Src/Interface/IpcBridge/ipcBridge.ts:4` 注明由 IPC 桥接取代），新日志不会再出现 |
| `ToolSafetyGate` / `secretsStore` / `toolDispatcher/dispatchToolCall` | 17 / 4 / 2 | 工具安全门、密钥、分发 |

```bash
jq -r '.source' Logs/business.log | sort | uniq -c | sort -rn | head -12
```

### 6. 启动与存活里程碑（grep 关键词）

```bash
grep -n "HTTP 服务器启动\|数据库初始化完成\|日志系统初始化完成\|AI 组件事件持久化已启用" Logs/business.log | tail -8
```

实测消息名与次数（`Logs/business.log`，2,695 行，2026-10-03 校准）：「长时记忆已按属主回灌」407、「配置热加载注册完成」/「环境自检完成」/「沙箱系统初始化完成」/「文件系统初始化完成」/「提示词目录就绪」各 168、「日志系统初始化完成」185、「数据库初始化完成」182、「HTTP 服务器启动」182（`Src/main.ts:373`，带 `data.port`）、「IPC 桥接启动」117、「主循环启动」/「主循环结束」各 41、「AI 组件事件持久化已启用」35（`Src/Interface/EventStore/aiEventStore.ts:182`）、「Loop 控制系统初始化完成」11。

## 日志级别

| 级别 | 权重 | 含义 | 处理方式 |
|------|------|------|---------|
| debug | 0 | 调试信息 | 开发环境使用 |
| info | 1 | 正常操作 | 无需处理 |
| warn | 2 | 潜在问题 | 关注但不阻塞 |
| error | 3 | 操作失败 | 需要排查（落 `system.log`） |
| fatal | 4 | 系统级错误 | 立即处理（落 `system.log`） |

权重表与代码一致（`Src/Infra/Logging/logger.ts:60-66`）。**运行时入口（2026-10-03 校准补充）**：

- 级别来源：`Configs/default.json:5` 的 `system.logLevel`（当前 `"info"`），读取点 `Src/main.ts:78`、注入点 `Src/main.ts:86`（`initLogger({ logDir, level })`）。
- 运行期改级别：`setLogLevel(level)`（`logger.ts:120`，注释标为 L2 热重载）；`getLogLevel()`（`:113`）。
- 想抓 debug 级细节必须先降级别，否则该类行根本不落盘（`logger.ts:173` 的级别过滤）。

## 日志目录与"日志失踪"排查（2026-10-03 校准新增）

- **目录可重定向**：环境变量 `CIVITAS_LOG_DIR` 优先级最高（`getLogDir()` `Src/Infra/Fs/pathResolver.ts:57-68`，判定在 `:58-59`），其次才是配置里的 `system.logDir`。便携模式落 `./Logs`（`:61-63`），安装模式落 `%APPDATA%\CivitasAI\Logs`（`:66-67`）——"日志不见了"先确认实际落盘目录，看 `_Meta/config.json` 的 `logDir` 字段。数据目录同构：`CIVITAS_DATA_DIR`（`getDataDir()` `:40-54`）。
- **写失败是静默的**：日志目录不可写时不抛异常、不阻塞主流程（Gate G1，`logWriter.ts:117`、`:139-143`），append/轮转/flush 失败同样静默丢弃（`:259`、`:287`），只把 `writeFailed` 置 true。
- **排查顺序**：

```bash
cat Logs/_Meta/config.json      # lastFlushAt / writeFailed / logDir —— 实测 writeFailed: false
ls -la Logs/                    # business.log 是否在增长
```

`writeFailed: true` 或 `lastFlushAt` 陈旧 → 目录权限/磁盘/占用问题；两者正常但业务无日志 → 进程本身没跑（转 `healthCheck.md` §6）。

## 相关文档

- 判活与端点：`Docs/Server/03-部署运维/Runbooks/healthCheck.md`
- 故障处置：`Docs/Server/03-部署运维/Runbooks/commonIssues.md`
- 目录说明（含本 Runbook 的入口链接）：`Logs/README.md`
