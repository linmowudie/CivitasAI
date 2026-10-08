# 配置指南

> Civitas-AI 所有可配置项均有默认值，空配置可直接启动。本文档说明如何按需调整。
>
> **2026-10-03 校准**：§1 文件清单补齐为 16 个并区分"是否进入合并配置"；§2 覆盖模型按 `Src/Infra/Config/configLoader.ts` 实际合并顺序重写（原"环境变量 > 本地覆盖 > 配置文件 > 默认值"不成立）；§3.4 补 `supervision` 包层与真实现值；§3.2/§3.3 补校验器硬约束与 `env:` 引用的真实解析方；§4 环境变量清单换为仓库实际消费的变量；新增"改配置须重启"与 `local.json` 覆盖失效两处现状说明。

---

## 1. 配置文件体系

配置文件位于 `Configs/` 目录，JSON 格式。⚠️ **`Configs/` 实有 16 个 JSON，但 `loadConfig()` 实际只加载 12 个**——`default.json` + `extraConfigs` 白名单 11 个：`modelRouter` `routingRules` `economyRules` `arbitration` `audit` `supervision` `loopConfig` `durable` `session` `memory` `security`。白名单外的文件不进入合并后的 `merged` 配置。

| 文件 | 用途（真实键族） | 是否进入 `merged` |
|------|------------------|-------------------|
| `default.json` | 系统基础配置：`system.{name,version,logLevel,dataDir,logDir,promptDir}`、`server.{host,httpPort,wsPort,corsOrigins}`、`database.*`、`ui.*` | ✅ **必需**（缺失即 FATAL）。⚠️ `server.wsPort` 是 WebSocket 已删除后的遗留键，但**不可删**（`configValidator.ts` 仍要求整数）；⚠️ `ui.*` 四键在 `Src/` 无消费者，前端对应值为硬编码常量（`Client/src/hooks/useDashboardData.ts` 的 `POLL_INTERVAL = 5000`、`Client/src/stores/chatStore.ts` 的 `FLUSH_INTERVAL_MS = 100`） |
| `loopConfig.json` | Loop 参数：`loopDefaults` / `hardLimits` / `roleOverrides` / `stopRules`（另含 `verifier` / `context` 等段） | ✅ |
| `modelRouter.json` | LLM 模型路由：`providers[]`（`provider`/`base_url`/`api_key_ref`/`models`）、`routing.*`（含 `timeoutMs`/`firstByteTimeoutMs`/`interChunkTimeoutMs`）、`reasoningSandwich.*` | ✅ |
| `routingRules.json` | 任务路由规则（复杂度→模式映射） | ✅ |
| `supervision.json` | 监管参数：`supervision.rateLimit`（Agent/工具侧）与 `supervision.apiRateLimit`（HTTP 层）两处有消费点；其余质量阈值、触发去重、风暴熔断等键当前**登记未接线** | ✅ |
| `security.json` | 安全配置：`trustLevels`（L0/L1/L2 角色分组）、`forbiddenPaths`/`forbiddenCommands`/`networkWhitelist`、`approvalTimeoutSec`（审批超时**唯一生效键**，现值 300 秒）、`autoApprove.{tools,delayMs}`、`criticalSecurityEvents` | ✅ |
| `session.json` | 会话归档/保留期参数：`session.{sessionKeyHexLength,archiveInactiveDays,historyMaxMessagesInMemory}` + `retention.*`（11 项各类数据保留天数） | ✅（被加载）。⚠️ **无"超时"键**（原描述"超时、最大消息数"不准确），且 `session.*` 与 `retention.*` 在 `Src/` 零读取点 |
| `memory.json` | 胶囊记忆预算与相似度阈值：`memory.{capsuleBudgetTokens,capsuleMemoryTopK,capsuleRecentOpsCount,capsuleMessageBudgetTokens,conflictSimilarityThreshold,vectorDim,privateStateTtlSec,supersedeGraceSec,longTermConsolidationDelayMs}` + `eventBus.{maxQueueSize,consumerTimeoutMs,retryMaxAttempts,deadLetterKeepDays,store}` | ✅（被加载）。⚠️ **无"容量/衰减率"键**（原描述不准确）；`memory.*` 在 `Src/` 零读取点；`eventBus.maxQueueSize` 改值不生效——`Src/main.ts` 的 `initEventBus({ maxQueueSize: 10000 })` 为硬编码 |
| `arbitration.json` | 仲裁参数（仲裁庭规模、超时） | ✅ |
| `audit.json` | 审计参数（巡逻间隔、冻结阈值） | ✅ |
| `economyRules.json` | Token 经济规则（税率、分润比例） | ✅ |
| `durable.json` | 持久执行参数（EffectJournal 超时、幂等缓存 TTL、恢复策略） | ✅ |
| `coverageBaseline.json` | 测试覆盖率基线（`coverageMinimum`） | ❌ 不进 `merged`；由 CI 读取（`.github/workflows/ci.yml` 覆盖率门禁） |
| `benchBaseline.json` | 性能基准基线 | ❌ 不进 `merged`；`Src/`、`Scripts/` 零引用 |
| `dataStorage.json` | 七类数据的保留期 / 上限 / 清理策略（`dataTypes.*` × 7 + `cleanupOrder` + `globalQuotaMb` + `autoCleanupEnabled` + `cleanupIntervalHours`） | ❌ **不在 `extraConfigs` 白名单** → 不进 `merged`，`Src/` 零引用；现状仅作 `Data/` 目录约定用途。待办：纳入白名单并由清理任务消费 |
| `tools.json` | 工具头部（`tools` 参数）冻结集：`tools.hot[]` + `tools.maxHeaderTools` | ❌ **不在白名单** → 不进 `merged`，但 `Src/main.ts`（`startServer()` ⑫.5）已在读 `getConfigValueOr(config, 'tools', {})` → `setToolHeaderConfig()`。**有读取方、无加载方**的半接线：⚠️ 目标态"热工具清单可配置"当前未生效，运行期恒回落 `Src/Tools/Registry/toolHeader.ts` 内置默认。待办：把 `tools` 加入 `extraConfigs`（或并入 `default.json`） |

> 另有 `Configs/README.md` 作为该目录的索引；`local.json` / `{env}.json` 为 `loadConfig()` 支持的**可选覆盖层**文件，仓库不内置（`local.json` 已 gitignore）。

## 2. 配置层级与优先级

**2026-10-03 校准**：原表述"环境变量 > 本地覆盖 > 配置文件 > 默认值"与代码不符。`Src/Infra/Config/configLoader.ts` 的实际合并顺序是（`loadConfig()`）：

```
default.json  <  {env}.json  <  local.json        （三层 deepMerge，override 胜出）
      ↑ 环境变量不参与层级竞争
      ↑ 合并完成后，11 个功能 JSON 的顶层键再被"文件值"无条件合并回 merged
```

- **环境变量**：仅两件事——`CIVITAS_ENV` 决定 `{env}` 取哪个文件（缺省 `dev`），`env:XXX` 引用按取值解析；没有任何"环境变量覆盖 merged 配置"的代码路径。
- **日志级别与服务端口**只能通过 `Configs/default.json`（`system.logLevel` / `server.httpPort`）修改，不能用环境变量。

⚠️ **`local.json` 覆盖的实际生效范围（已知缺陷）**：功能 JSON 的回覆盖发生在三层合并**之后**，凡与功能文件同名的顶层键都会被文件值重新盖回去。因此：

| 想覆盖的键 | 经 `local.json` / `{env}.json` | 说明 |
|-----------|--------------------------------|------|
| `system.*` / `server.*` / `database.*` / `ui.*`（`default.json` 独有段） | ✅ 生效 | 这些键不来自任何功能文件，无回覆盖 |
| 功能文件顶层同名键：`loopDefaults` `hardLimits` `stopRules` `roleOverrides` `verifier` `context` `supervision` `security` `memory` `eventBus` `session` `retention` `providers` `routing` `reasoningSandwich` `economy` `durable` … | ❌ **被静默吃掉** | 必须直接编辑对应功能 JSON（`loopConfig.json`、`supervision.json` 等） |

该缺陷已由 `Configs/README.md` 自认。待办（工程侧）：把 extra 合并顺序调整为 `default < {env} < local(功能键)`，或让 extra 合并尊重已有覆盖值；本轮文档只如实描述现状。

其他事实：

- 任一层 JSON 解析失败 → 启动 FATAL（`JSON 解析失败 [<路径>]`）；`default.json` 缺失 → FATAL。
- ⚠️ "空配置可直接启动"的准确含义：**不需要** `local.json` / `{env}.json` 覆盖层即可启动。`loadConfig()` 层面只有 `default.json` 是必需的（其余功能文件逐个 `existsSync` 可选），但紧随其后的 `configValidator` 仍要求合并结果里存在 `loopDefaults` / `hardLimits` / `stopRules` / `roleOverrides` 四段（由 `loopConfig.json` 提供）以及 `routing.arbitrationModels` 长度 ≥ 3（由 `modelRouter.json` 提供）——**删除这两个文件同样会 FATAL**。
- ⚠️ `Configs/*.json` 由 `JSON.parse` 解析：**不允许注释、不允许尾逗号**。本文示例因此不再在 JSON 块内写 `//` 注释（原示例含 `//` 注释，照抄即 FATAL）。

### 2.1 改配置必须重启（热重载未接线）

`Src/main.ts` 的 `startServer()` 第 ⑨ 步只调用 `initConfigWatcher({ watchDir: 'Configs/', pollIntervalMs: 5000 })` **登记参数**；`Src/Infra/Watcher/configWatcher.ts` 的 `startWatching()` / `onConfigChange()` **无任何调用者**，变更检测函数体写着"Phase 0-2 简化实现：仅记录快照，不实际扫描文件系统"。

⇒ **当前不存在运行期热重载**，`Configs/README.md` 里的 L0（启动锁定）/ L2（热重载）分级只是设计口径，所有配置改动一律需重启进程后生效。⚠️ 未实现/目标态。

前端「系统设置」面板另有一套 `reloadStrategy`（immediate / afterReply / onNavigate / onRestart）四级队列（`Client/src/stores/hotReloadStore.ts`），但它只作用于**渲染进程**：用户值存 `localStorage`，后端配置接口只有 `GET /api/configs`、`GET /api/configs/:name`（只读），**没有写接口**，也不回写 `Configs/*.json`。要让后端行为变化，仍须手工编辑配置文件并重启。

## 3. 常用配置调整

### 3.1 调整 Token 预算

编辑 `Configs/loopConfig.json`：

```json
{
  "loopDefaults": {
    "token_budget": 200000
  },
  "stopRules": {
    "budget": {
      "warmRatio": 0.36,
      "softRatio": 0.6,
      "expandRequestRatio": 0.8,
      "hardRatio": 1.0
    }
  }
}
```

- `loopDefaults.token_budget` 出厂默认 **100000**，调大可处理更复杂任务；受 `hardLimits.tokenBudgetCeiling`（现值 2000000）标注约束。
- 四区间预算比例：`warmRatio`（36% 预热）< `softRatio`（60% 预警）< `expandRequestRatio`（80% 申请扩容）≤ `hardRatio`（100% 强制停止）。
- ⚠️ 硬约束：`configValidator.ts` 要求这四个值**严格递增**且 `hardRatio ≤ 1.0`，否则启动 FATAL。
- ⚠️ 只能在 `loopConfig.json` 内改：经 `local.json` 覆盖会被 §2 的回覆盖缺陷吃掉。

### 3.2 调整角色参数

编辑 `Configs/loopConfig.json` 的 `roleOverrides` 段：

```json
{
  "roleOverrides": {
    "prime_director": { "max_iterations": 100, "token_budget": 500000, "temperature": 0.3 },
    "partner":         { "max_iterations": 50, "token_budget": 200000, "temperature": 0.3 },
    "worker":          { "max_iterations": 50, "token_budget": 150000, "temperature": 0.3 },
    "reviewer":        { "max_iterations": 5,  "token_budget": 50000,  "temperature": 0.0 },
    "assembly_node":   { "max_iterations": 10, "token_budget": 60000,  "temperature": 0.1 },
    "arbitrator":      { "max_iterations": 5,  "token_budget": 50000,  "temperature": 0.0 },
    "auditor":         { "max_iterations": 20, "token_budget": 80000,  "temperature": 0.0 },
    "regulator":       { "max_iterations": 15, "token_budget": 80000,  "temperature": 0.1 }
  }
}
```

示例只把 `worker` 从出厂默认 `30 / 100000 / 0.2` 调成 `50 / 150000 / 0.3`，其余 7 个角色按 `Configs/loopConfig.json` 现值原样列出（它们**必须全部存在**，见下方约束 1）。

⚠️ **硬约束（照做避免启动失败）**，全部来自 `Src/Infra/Config/configValidator.ts`：

1. 角色键**必须与 8 个角色一一对应**：`prime_director` `partner` `worker` `reviewer` `assembly_node` `arbitrator` `auditor` `regulator`——缺任一角色报错，出现未知角色键也报错。
2. 每个角色内**只允许三个键**：`max_iterations` / `token_budget` / `temperature`（白名单）。加 `timeout_ms`、`stream` 等任何其它键 → `不允许覆盖此键` → FATAL。
3. `loopConfig.json` 的 `loopDefaults` / `hardLimits` / `stopRules` / `roleOverrides` 四段**都必须存在**，缺任一段直接 FATAL。
4. 上述三个键的值只能是数字（`main.ts` 注入时对非数字值按 `undefined` 处理）。

⚠️ **接线现状（半接线，需知晓）**：`main.ts` 已通过 `setRoleOverrides()` 注入这份配置，但运行期发起生成的链路（`Src/Interface/IpcBridge/ipcBridge.ts` 的 streamGeneration）用的是 `createLoopConfig({ model, stream: true })`，不经 `createRoleLoopConfig(role)`；后者目前只在测试中被调用。⇒ 改 `roleOverrides` 会改变校验与注入值，但**当前不会改变实际下发给 Agent 的 Loop 参数**。待办：把 IPC 链路切到按角色装配，或在本节撤销"可调角色参数"承诺。

### 3.3 切换 LLM Provider

编辑 `Configs/modelRouter.json`：

```json
{
  "providers": [
    {
      "provider": "openai",
      "base_url": "https://your-api-endpoint/v1",
      "api_key_ref": "env:YOUR_API_KEY",
      "display_name": "我的 OpenAI 兼容通道",
      "models": [
        {
          "id": "gpt-4o",
          "context_window": 128000,
          "max_output": 8192,
          "supports_vision": true,
          "supports_tools": true,
          "cost_per_1k_input": 2.5,
          "cost_per_1k_output": 10.0
        }
      ]
    }
  ]
}
```

- 字段名以代码为准：Provider 层 `provider` / `base_url` / `api_key_ref` / `display_name` / `models[]`（`Src/Infra/Llm/Provider/providerBase.ts` 的 `ProviderConfig`）；模型项为 `ModelSpec` = `id` / `context_window` / `max_output` / `supports_vision` / `supports_tools` / `cost_per_1k_input` / `cost_per_1k_output`。⚠️ 原示例里的 `inputPrice` / `outputPrice` 在代码中不存在。
- ⚠️ `context_window` **必填**：缺失或 ≤ 0 时 `LlmProvider` 构造直接抛 `模型 <id> 缺少 context_window，拒注`；`main.ts` ⑪ 的 try/catch 会跳过该 Provider（不阻塞启动），若因此一个都没注册成功 → 启动 FATAL `无可用 LLM Provider`。
- `provider` 是注册表唯一键兼模型全限定名前缀（`<provider>/<modelId>`）；同类型多实例必须用不同注册名，否则后注册者覆盖先注册者。
- 模型选择与超时在 `routing` 段（`defaultModel` / `directorModel` / `workerModel` / `verifierModel` / `arbitrationModels` / `fallbackOrder` / `timeoutMs` / `firstByteTimeoutMs` / `interChunkTimeoutMs`）。
- ⚠️ `arbitrationModels` 长度必须 **≥ 3**（`configValidator.ts` 校验，不足即 FATAL）。
- `api_key_ref` 支持的引用格式：`env:变量名`（环境变量未设置会抛 `环境变量 XXX 未设置`）与 `inline:明文Key`（不持久化，重启失效）——解析方是 **Provider 层** `Src/Infra/Llm/Provider/providerBase.ts` 的 `resolveApiKey()`，**不是** configLoader。

### 3.4 调整限流阈值

编辑 `Configs/supervision.json`。⚠️ **必须带 `supervision` 包层**（原示例顶层直写 `rateLimit` 与实态不符）：

```json
{
  "supervision": {
    "rateLimit": {
      "maxRequestsPerMinute": 30,
      "maxTokensPerMinute": 100000,
      "maxToolCallsPerMinute": 60,
      "burstAllowance": 2
    },
    "apiRateLimit": {
      "maxRequestsPerMinute": 600,
      "burstAllowance": 2
    }
  }
}
```

- `supervision.rateLimit` = **监管侧限流**：前置调用频率 + 工具调用限流（Agent 侧），消费点 `Src/main.ts` `startServer()` ⑬ → `initRateLimiter()` 与 `initPreSupervisionRateLimit()`。当前值 **30**；代码侧默认同为 30（`Src/Infra/Contracts/rateLimitTypes.ts`），**原注释"默认 60"无出处**。
- `supervision.apiRateLimit` = **HTTP API 层限流**（UI 侧，放宽它不影响监管阈值）：当前值 **600**，消费点 `initApiRateLimiter()`；实际放行阈值为 `maxRequestsPerMinute × burstAllowance`（`apiRateLimiter.ts`）。
- 本文件其余键（`qualityThreshold`、`patrolEnabled`、`triggerDedupWindowSec`、`stormBreakerThresholdPerMin`、`maxConcurrentLoops*`、`approvalTimeoutSec` 等）在 `Src/` 中无消费点，属**登记未接线**参数——改它们目前没有效果。

> 【需人工裁定】审批超时键的双头冲突（现状记录，不裁决）：`Configs/security.json → security.approvalTimeoutSec = 300` 是唯一生效键（`main.ts` ④ → `configureToolSafetyGate()`）；`Configs/supervision.json → supervision.approvalTimeoutSec = 60` 与 `approvalDefaultOnTimeout = "reject"` 在 `Src/` 全无消费者（超时默认拒绝由 `toolSafetyGate` 硬编码）。待办：裁定权威键并删除或接线另一份；在此之前**以 `security.json` 为准**。

### 3.5 日志级别与服务端口

两者都只能改 `Configs/default.json`（环境变量不参与层级竞争，见 §2、§4）：

```json
{
  "system": { "logLevel": "debug" },
  "server": { "httpPort": 3000, "corsOrigins": ["http://localhost:5173"] }
}
```

- `system.logLevel`：`debug` / `info` / `warn` / `error` / `fatal`，消费点 `main.ts` ②（`initLogger({ level })`）。
- `server.httpPort`：REST 监听端口，消费点 `main.ts` ⑱（`startHttpServer`）。改端口后需同步 `server.corsOrigins` 与 `Client/vite.config.ts → server.proxy['/api'].target`；Vite 自身端口在 `Client/vite.config.ts → server.port`（`strictPort: true`），不在此文件。
- ⚠️ `server.wsPort` 无服务使用，但**不要删键**（`configValidator.ts` 仍要求整数，删除即 FATAL）。

## 4. 环境变量

> **2026-10-06 重写（安装包改造）**：环境变量现在有明确的**三根契约**。原表中"环境变量只被 `pathResolver` 读取、DB/日志/密钥全走 `process.cwd()`"的割裂状态已修复——所有落盘路径统一由 `Src/Infra/Fs/pathResolver.ts` 解析。
> 仍无效的变量：`CIVITAS_LOG_LEVEL` / `CIVITAS_HTTP_PORT` / `CIVITAS_WS_PORT`（零消费者，改它们没有任何效果，请改 `Configs/`）。

### 4.1 根目录契约（推荐使用）

| 变量 | 含义 | 缺省 | 消费点 |
|------|------|------|--------|
| `CIVITAS_APP_ROOT` | **程序/资源根**（只读）：`Configs/`（内置种子）、`Prompts/`、`Skills/`、`assets/` | 自动向上查找含 `Configs/default.json`（或 `package.json`）的目录 | `pathResolver.getAppRoot()` |
| `CIVITAS_DATA_ROOT` | **全局数据根**（可写）：数据库、日志、密钥、用户配置 | 开发/便携 = `<APP_ROOT>/Data`；安装态由 Electron 注入 `%APPDATA%\CivitasAI` | `pathResolver.getDataRoot()` |
| `CIVITAS_WORKSPACE_ROOT` | **工作空间根**（可写，体积大户）：会话工作目录、沙箱、`.civitas/` 文件备份 | 开发 = 数据根；便携/安装 = `<APP_ROOT>/Workspace`（只读则回落 `<DATA_ROOT>/Workspace`） | `pathResolver.getWorkspaceRoot()` |

落盘分布（安装态）：
```
%APPDATA%\CivitasAI\            ← CIVITAS_DATA_ROOT
├── db\civitas_{main,events,memory}.db
├── Logs\
├── .secrets\providers.json.enc   ← API Key（safeStorage 加密，不进日志）
└── Configs\local.json            ← 用户覆盖层（首次运行引导写入，优先级最高）
<安装目录>\Workspace\             ← CIVITAS_WORKSPACE_ROOT
├── workspaces\<sessionId>\       ← 每个任务的工作目录
│   └── .civitas\                 ← 文件备份/改写基线（可回滚）
├── Sessions\<sessionKey>\
└── Loops\<sessionKey>\
```

### 4.2 细粒度覆盖与兼容变量

| 变量 | 作用 | 备注 |
|------|------|------|
| `CIVITAS_ENV` | 选择 `Configs/{env}.json` 覆盖层（缺省 `dev`） | 内置目录与用户目录都会读该层 |
| `CIVITAS_LOG_DIR` | 日志目录重定向 | 覆盖数据根派生值 |
| `CIVITAS_CONFIG_DIR` | **用户可写配置层**目录 | 安装态缺省 `<DATA_ROOT>/Configs` |
| `CIVITAS_CONFIG_DIR_BUILTIN` | 内置只读配置目录 | 缺省 `<APP_ROOT>/Configs` |
| `CIVITAS_PROMPTS_DIR` / `CIVITAS_SKILLS_DIR` | 提示词/技能目录重定向 | 缺省 `<APP_ROOT>/...` |
| `CIVITAS_BACKUP_DIR` | 文件备份根 | 缺省 `<WORKSPACE_ROOT>/.civitas` |
| `CIVITAS_DATA_DIR` | `CIVITAS_DATA_ROOT` 的旧名（兼容 Docker/旧脚本） | 两者都设时以 `CIVITAS_DATA_ROOT` 为准 |
| `CIVITAS_PORTABLE` | `1`/`true` 时启用便携模式（数据/工作空间全落程序目录） | 也可用 `--portable` 参数或 exe 同级 `.portable` 标记文件 |
| `CIVITAS_INSTALLED` | `1`/`true` 时按安装态解析（配置层落数据根） | 由 `electron/main.ts` 在打包非便携时注入 |

**打包 ≠ 便携**：历史实现把 `app.isPackaged` 直接当便携，导致装到 `C:\Program Files` 后数据写进只读安装目录、应用启动即失败；现在只有显式信号才算便携。

### 4.3 配置覆盖层顺序（首次运行引导的写入路径）

```
内置(<APP_ROOT>/Configs)/default.json
内置/{env}.json
内置/{feature}.json      ← modelRouter / security / loopConfig / …（11 个）
内置/local.json
用户(<DATA_ROOT>/Configs)/{env}.json      ← 安装态配置写入点
用户/{feature}.json
用户/local.json          ← 最高优先级：个性化设置 / 供应商与路由选择
```

> 2026-10-06 修复：历史实现把 11 个功能文件**无条件覆盖到最后**，导致 `local.json` 覆盖不了 `modelRouter.routing`（`Configs/README.md` 自认的已知问题）。现在 `local.json` 为最高层，首次运行引导写一个文件即可生效。
> 注意：`env:` 引用**只在 `default`+`{env}` 层解析**，功能文件里的 `api_key_ref: "env:XXX"` 必须保持引用形态，由 Provider 层在请求期解析（提前展开会被判为非法引用格式）。

API Key 类变量可写在 `.env` 里，`Src/main.ts` 第 ⓪ 步按 `<DATA_ROOT>/.env` → `<APP_ROOT>/.env` 顺序加载（已在 `process.env` 中的变量优先，不被覆盖）：

```bash
# LLM API Key 示例（首次运行引导会改为写入加密凭据存储，无需手填）
HUAWEI_MAAS_API_KEY=your_key_here
```
