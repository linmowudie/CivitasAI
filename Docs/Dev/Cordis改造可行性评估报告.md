# Civitas-AI 支持 Cordis 改造的可行性评估报告

| 项 | 值 |
|---|---|
| 评估对象 | `F:\ProjectCode\CivitasAI`（后端 `Src/`、桌面端 `electron/`、服务端 `Server/`、前端 `Client/`） |
| 评估目标框架 | `cordis`（Koishi 系插件/依赖注入框架）及其 DSH 分支 `@deepseek-ai/cordis` |
| 评估日期 | 2026-10-08 |
| 评估方法 | 只读代码审计（结论均附 `path:line`）+ 可运行 spike（Node 22 / 仓库 `tsx` / 仓库 `esbuild`）+ 现有门禁基线实测 |
| 仓库改动 | **零**。spike 全部位于 `.tmp/cordis-spike/`（`.gitignore` `.tmp/` 已忽略），根 `package.json` / `package-lock.json` 未被触碰 |
| 编写者 | 评估 agent（Lead） |

---

## 0. 结论速览

### 0.1 一句话结论

> **代码结构"可改造"，构建与打包形态"不支持"声明式插件加载。**
> 把 cordis 当作**进程内服务容器 + 生命周期管理**引入（阶段 1/2）是可行的，已用 spike 在本仓库的运行时与工具链下跑通；
> 但把 cordis 的 **`cordis.yml` 声明式插件树 + 运行期热模块替换（HMR）** 原样搬过来，会被 `Scripts/build.cjs` 的单文件 ESM 打包 + `asar: true` 直接阻断，**必须先改构建产物形态**。

> **追加（按层嵌套插件树的提案）**：把后端做成 `Interface → … → Infra` 的父子插件树在 cordis 里**结构可行，但方向必须反过来**（提供者在祖先、消费者在后代），否则整棵树会因 `inject` **死锁**；且 cordis 的服务命名空间是**全应用扁平**的，树形**不构成分层约束**。详见 [§10](#10-追加评估按层嵌套的插件树下一层作为上一层的子插件)。

### 0.2 分级判定

| 级别 | 改造内容 | 判定 | 前置条件 | 工作量（估算） |
|---|---|---|---|---|
| **L1 容器化装配** | 引入 cordis 作为组合根替代：6 个模块级注册表 → `Service`，`initXxx/setXxx/configureXxx` → 插件 `Config` + `apply`，人工 19 步启动 → `inject` 依赖图，9 步手写关闭 → `ctx.effect` disposer | ✅ **支持**（spike 已验证） | 无（可渐进式，业务内核不动） | 15–25 人日（薄容器化）<br>60–95 人日（含 110 个模块的状态所有权迁移与租户 scope 化） |
| **L2 配置 Schema 化** | 扁平 `getConfigValueOr` 字典 + `as number` 断言 → 每插件 `Schema<Config>` 校验 + 默认值 + volatile 热更新 | ✅ **支持但成本高** | L1 完成；先定"配置分节归属" | 10–20 人日 |
| **L3 声明式插件树 + HMR** | `cordis.yml` 声明插件、运行期 `import()` 插件文件、保存即热替换 | ❌ **当前不支持** | 必须改构建：多入口 / esbuild `splitting` / `packages:'external'`；插件目录不得落在只读资源根 | 20–40 人日（仅构建链路） |
| **L4 全仓 Harness 化重写** | 整个后端（工具/LLM/Loop/治理）按 DSH 方式重写为插件树，Electron 降级为宿主 | ⚠️ **不建议** | 与 133 个测试文件、1635 用例、5 条分层红线、6 篇 ADR 正面冲突 | 6–12 人月（估算） |

**推荐路线**：走 **阶段 0 前置 → L1（1a→1b→1c）→ L2 →（视需要）L3**，不走 L4。

**两个有利条件（降低"模块图"层面的迁移风险）**：
1. **导入期副作用 ≈ 0**：`Src/` 顶层 `new` / 定时器 / IO / `process.on` / 顶层 await 全为 0，唯一"导入即启动"点是 `Src/main.ts:986` 的 Electron 守卫 → 模块可被容器按需挂载，无需先做"去副作用化"。
2. **只有 1 个真实循环依赖**（3 个模块，`Src/Services/SharedMemory` 组），1222 条 import 边中 0 条越层违规 → **迁移不必先拆环或重构依赖图**，风险集中在"装配与状态所有权"。

---

## 1. 现状画像（评估依据）

### 1.1 规模与分层

| 指标 | 实测值 | 来源 |
|---|---|---|
| `Src/` TypeScript 文件 | 287 | 实测 |
| `Src/` 代码行 | 38,730 | 实测 |
| 后端入口 | `Src/main.ts`，**988 行** | `Src/main.ts` |
| 层结构 | `Infra / Tools / Services / Core / Interface` | `Src/` |
| 分层门禁 | 5 条 `import/no-restricted-paths` 区 | `.eslintrc.json:15-47` |
| 测试 | **133 个测试文件 / 1635 个用例**（`npx vitest run` 实测全绿，2026-10-08） | `Tests/`，实测 |
| 门禁基线 | `npm run typecheck` → **0 error**；`npm run lint` → **0 error / 307 warning** | 本次实测 |
| **含模块级可变状态的模块** | **110 / 287 = 38.3%**（149 个顶层 `let`、73 个 `Map/Set`、17 个数组注册表） | 独立审计实测 |
| class 数量 | **仅 7 个**（含 4 个 Error 子类）；6 个构造函数中真正"注入配置"的只有 2 个 | 独立审计实测 |
| 装配/生命周期类导出函数 | **202 个**：`initXxx` 41 / `configureXxx` 8 / `setXxx` 22 / `registerXxx` 42 / `startXxx` 12 / `stopXxx` 12 / `resetXxx` 65 | 独立审计实测 |
| 组合根装配规模 | `startServer()` 体 144–853 行，**121 次**装配调用、**74 个**装配符号、77 条静态 import | `Src/main.ts` |
| **导入期副作用** | **≈ 0**：顶层 `new` / 定时器 / IO / `process.on` / 顶层 await **全部为 0**；唯一"导入即启动"点是 `Src/main.ts:986` 的 Electron 守卫 | 独立审计实测 |
| 真实循环依赖 | **仅 1 个 3 模块环**（`Src/Services/SharedMemory/{longTermMemory,longTermMemoryStore,memoryEntryStore}.ts`），1222 条静态 import 边 | Tarjan SCC |

### 1.2 组合根是"手工 DI 容器"

`Src/main.ts` 是一个**单点、全序、手工**的组合根：

- 启动 ⓪~⑲ 约 19 个编号步骤（`Src/main.ts:144-853`），每步的先后**由注释和人工排序保证**，例如：
  - `Src/main.ts:167-174` 必须**在任何路径解析之前**写入 `CIVITAS_WORKSPACE_ROOT` 并 `resetPathCache()`，否则 `Src/Infra/Fs/pathResolver.ts:59` 的进程级缓存会永久记住错误的根；
  - `Src/main.ts:823`（EventBus）→ `:832`（路由注册）→ `:838`（HTTP 启动）的顺序被依赖。
- 关闭是 9 步手写序列（`Src/main.ts:886-968`），依赖人工对称。
- 装配类调用：`startServer()` 本体 144–853 行内共 **121 次**语句级装配调用，涉及 **74 个**装配符号（正文中同类符号名出现 77 次），另有 **77 条静态 import**（独立审计实测）。
- 组合根**被排除在覆盖率之外**（`vitest.config.ts:27`），即"最关键、最容易错的一段"零测试保护；且**没有任何测试 import `main.ts` 或调用 `startServer()`**。

### 1.3 已有 6 个模块级扩展点注册表（全部是全局单例）

| 扩展点 | 契约位置 | 单例状态 | 可撤销 | 排序 | 错误隔离 |
|---|---|---|---|---|---|
| Hook | `Src/Services/Hook/hookRegistry.ts:35-41` | `:62` 模块级数组 | ❌ 仅 `clearHookHandlers()` `:143-145` | priority 升序 `:96-98` | ✅ 逐条 `Promise.race` 超时 + fail-open/fail-closed `:120-138` |
| 中间件 | `Src/Infra/Contracts/middlewareTypes.ts:22-28,87-98` | `Core/Middleware/middlewareRegistry.ts:14` | ✅ `unregisterMiddleware(name)` `:59-62`（但 `Core/Middleware/index.ts:7-11` **未导出**） | priority 升序 `:42-46` | ❌ 无 try/catch `:82,133-138` |
| 工具 | `Src/Tools/Traits/toolSpec.ts` + `specValidator.ts` | `Src/Tools/Registry/toolRegistry.ts:18` | ❌ 仅 `clearRegistry()` `:171-173` | ❌ 插入序 | ✅ 每个工具独立 try/catch + 超时 `:81-138` |
| EventBus | `Src/Services/EventBus/eventBus.ts` | `:22-26` | ✅ `Subscription.unsubscribe` `:81-86` | ❌ 注册序 | ⚠️ 异常被 `catch(()=>{})` **静默吞掉** `:61-63` |
| LLM Provider | `Src/Infra/Llm/Router/modelRouter.ts` | `:36-38` | ✅ `unregisterProvider` `:114-119`（运行期已被 IPC 使用 `Interface/IpcBridge/ipcBridge.ts:364,399,425`） | — | ⚠️ `registerProvider` **静默覆盖** `:47-61` |
| 路由 | `Src/Interface/RestApi/router.ts:56` | 模块级数组 | ❌ 仅 `clearRoutes()` `:108-110` | ❌ 插入序首个命中 `:74-91` | 请求层兜 500 `Interface/WebServer/webServer.ts:69-80` |

### 1.4 已存在"手写依赖注入"的雏形

- `Src/Tools/Registry/toolServicePorts.ts`：`let ports = {}`（`:113`）+ `configureToolServicePorts()`（`:116-118`），注入 6 个端口（缓存 / Hook 派发 / todoStore / 记忆检索 / 招募 / 评审）。动机写在文件头 `:1-15`：**Tools 层不许 import Services/Core，因此把接口留在 Tools、实现由组合根注入**。未注入时"诚实降级"为 `NOT_ENABLED`。
- 同类缝：`setElectronRuntime()`（`Src/main.ts:137-141`，CJS→ESM 注入 `ipcMain`/`safeStorage`/窗口广播）、`setIpcMainProvider`、`setSafeStorageProvider`、`setToolHeaderConfig`、`setRoutingConfig`、`configureReviewer`、`configureContextCompression`、`setLoopLimits`、`setActiveStopRuleSet`、`setRoleOverrides`、`registerPricing` 等。
- **这些正是 cordis `Service` + `inject` + `ctx.get()` 要解决的同一类问题——目前用 121 次手工装配调用 + 17 个全局 setter 解决。**（审计定性：`toolServicePorts` 是**服务定位器**而非 DI，是 `ctx.<service>` 的"穷人版"。）

### 1.5 后端零动态代码加载

| 扩展点 | 今天怎么加 | 动态？ |
|---|---|---|
| 工具 | 写文件 → **手工加 1 行 import** → 加入 `BUILTIN_TOOLS` 数组（`Src/Tools/builtinLoader.ts:14-39,42-64,71-73`） | ❌ |
| 中间件 | 写文件 → `Src/main.ts:52-56` 静态 import → `registerMiddleware()` `:587-590` | ❌ |
| Hook | **无文件**：3 个 handler 闭包直接内联在 `Src/main.ts:544-586` | ❌ |
| Provider | 唯一数据驱动项：config `providers[]` → `Src/main.ts:438-453` 循环；但 provider **类**硬编码为 `OpenAIProvider` `:442` | ⚠️ 半动态 |
| 路由 | 写 `xxxApi.ts` → `Interface/WebServer/routes.ts:7-23` 手工加 import + 一行调用 `:31-47` | ❌ |
| Prompts / Skills | ✅ 真 `readdirSync` 扫描 + 热重载（`Services/Prompts/promptRegistry.ts:38`、`skillsAssets.ts:72`、`Src/main.ts:413-430`） | ✅ 但**只是数据**，不是代码 |

> 全仓 `await import()` 仅 5 处：4 处在 `Src/` 内且为**静态字符串说明符**（esbuild 会内联）；第 5 处 `electron/main.ts:47-50` 故意用**变量说明符**以阻止 esbuild 内联整个后端，注释 `:44-45` 明写原因。
> 另注：`toolRegistry.ts:4`、`builtinLoader.ts:4` 的注释声称"**扫描** Builtin/ + Custom/"，实现却是静态数组 —— **文档承诺了一个不存在的机制**。

### 1.6 构建与打包形态（L3 的硬约束）

| 产物 | 格式 | 证据 |
|---|---|---|
| `dist/main/Src/main.js` | **ESM 单文件** | `Scripts/build.cjs:39-50`（`outbase:'.'` 有专门注释 `:37-38`） |
| `dist/main/electron/main.cjs` | CJS | `:53-63` |
| `dist/main/electron/preload.cjs` | CJS | `:67-77` |

- `external: ['better-sqlite3','fsevents','electron','ws']`（`build.cjs:25,48`），**无 `packages:'external'`、无 `splitting`** → 其余依赖全部内联。
- `asar: true`（`package.json:130`）+ `asarUnpack`（`:131-134`）。
- `Configs/`、`Prompts/`、`Skills/` **双份投递**：既进 asar（`package.json:59-61`），又作为 `extraResources` 落到只读资源根（`:68-90`）。
- Electron 44/Node 24 下 ESM 侧拿不到 `ipcMain/safeStorage`（`Src/main.ts:127-136`、`electron/main.ts:9-18` 有实测记录）→ **任何 cordis 服务都不能直接 `import electron`**，必须继续走注入缝。
- 后端模块图**必须全进程唯一**：`main.ts:855-868`、`electron/main.ts:527-529` 记录过"两侧各自 import 拿到副本 → stop 了个空对象"；`main.ts:976-986` 的自启动守卫注释 `:982` 记录"内联 → 重复初始化 → 工具重复注册 → 所有工具启动即失败"。

### 1.7 配置体系现状（L2 的输入）

| 维度 | 现状 | 证据 |
|---|---|---|
| 合并层序 | **7 层深合并**：内置 default → 内置 `{env}` → 用户 `{env}` → 内置 11 个功能文件 → 用户功能文件 → 内置 local → 用户 local | `Src/Infra/Config/configLoader.ts:87-155`、`FEATURE_CONFIGS :37-42` |
| 校验 | **手写、非 zod**：仅 `system/server/database` 逐字段 typeof + `loopConfig` 的部分跨字段约束；且**同一份 merged 被传两次冒充 `'default'` 与 `'loopConfig'`** | `Src/Infra/Config/configValidator.ts:25-74,79-183,188-197`；`configLoader.ts:157-165` |
| 读取 API | `getConfigValueOr<T>(config, path, default)` → `getConfigValue` 末尾 `return current as T \| undefined`，**纯 TS 断言、零运行时校验** | `configLoader.ts:185-195,200-202`（`:194`） |
| 调用集中度 | `getConfigValueOr` 在 `Src/` 共 **25 处，全部在 `main.ts`**；其余模块 0 处 | 实测 grep |
| 无 schema | merged 是**单一扁平字典**，"分节"只到顶层键；无按节类型/范围校验，非法值静默落默认值或透传下游（如 `pc['base_url'] as string` 直进 `OpenAIProvider`，`main.ts:443-447`） | 同上 |
| 死配置 | `tools.json`/`dataStorage.json` **未加载**但 `main.ts:499-502` 仍读 `'tools'`（恒 `{}`）；`mutationLevels` 分级表**零调用方** | `configLoader.ts:32-42`、`Src/Infra/Config/mutationLevels.ts:24-75` |
| 重入性 | `configLoader` **无模块级缓存**，可被任意次重复调用 → 对容器友好；真正难点是**下游无 apply/reload 门面**（`reloadConfig`/`invalidateConfig` 符号不存在） | `configLoader.ts:87-177` |
| 热重载 | **5s 轮询 mtime**（非 chokidar，chokidar 声明未用）；只处理 `Prompts`/`Skills`；**`Configs/*.json` 变更只写一条日志，不重载** | `Src/Infra/Watcher/configWatcher.ts:30-136`；`Src/main.ts:413-430` |
| 定时器泄漏 | `stopWatching()`（`configWatcher.ts:67-73`）与 `resetConfigWatcher()`（`:144-151`）在 `Src/` **零调用方** | 实测 |

> 有利事实：`zod` 已在 dependencies（`package.json:141`）但完全未用于配置校验 → **L2 无需引入新依赖**，只需把 ~16 个配置文件的段结构写成 `Schema`。

### 1.8 测试与门禁现状（迁移的安全网，也是阻力）

- **组合根零测试复用**：没有任何测试 import `Src/main.ts` 或调用 `startServer()`；`vitest.config.ts` 连 `setupFiles` 都没有，覆盖率明确排除 `Src/main.ts`（`:27`）。
- **测试自带 mini 组合根**：`Tests/Decision/orchestrationPipelines.spec.ts:60-95` 的 `fullReset()` 复刻 **15 次**装配调用；`Tests/Services/infraWiring.spec.ts:46-72` 每次 `beforeEach/afterEach` 各 7 次全局重置。20 个测试文件含 ≥5 处装配/重置调用。
- **201 个装配符号中 153 个被测试引用**（`initDatabase` 出现在 33 个测试文件）。
- 分层门禁当前**实际违规 0 条**（1222 条 import 边全部合规），但执行链有**三个漏洞**：
  1. `npm run layer-check` 用**空 `zones`** 覆盖规则 → 永远通过（`package.json:32`）；
  2. `.husky/pre-commit:15` 以 `2>/dev/null || true` 结尾 → 本地提交不阻断；
  3. `tsconfig.json` 的 `exclude` 含 `Tests`，而 eslint 用 `parserOptions.project` → **测试不受门禁约束**。
- 现有例外是"承重墙"：`Services → Core` 的 **22 条边全部落在 `.eslintrc.json:29-34` 的 `except: ["AgentRuntime","Decision"]`** 内（评审/招募/A2A/监管直接持有 Core 的 Agent 注册表）。在容器模型里，这些应变成 `ctx.agentRegistry` 之类的服务，而不是目录白名单例外。

---

## 2. 框架侧事实（cordis 能力边界）

### 2.1 版本与形态（实测查询 npm registry）

| 包 | 最新版本 | 形态 | 说明 |
|---|---|---|---|
| `cordis`（上游） | **4.0.0-rc.10**（`latest` tag） | `"type":"module"`，仅 ESM | 上游 v4 **仍是 RC**；v3 线终止于 `3.18.1`（Koishi 4 所用） |
| `@deepseek-ai/cordis`（DSH 分支） | **4.0.4**（`latest`） | `"type":"module"`，仅 ESM | **MIT**；`repository: deepseek-ai/deepseek-harness`，`directory: vendor/cordis`；依赖 `@deepseek-ai/cosmokit` + `@standard-schema/spec`；可选 peer `@deepseek-ai/cordis-plugin-loader`(~1.0.5) / `-include`(~1.0.9) |

> **选型要点**：上游 v4 尚未 GA，DSH 用的是**同源代码的再发布分支**（`@deepseek-ai/cosmokit`、`@deepseek-ai/schemastery` 为 scope 重命名版）。两条线的 API 高度一致，但**版本演进责任方不同**，必须在评估阶段就明确"跟随哪一支 + 如何锁定版本"。

### 2.2 核心能力（对本文结论有影响的四条）

1. **服务与依赖**：`class X extends Service { constructor(ctx) { super(ctx, 'name') } }`；消费者 `export const inject = ['name']`，服务缺失时插件停在 `PENDING`，服务消失时消费者**自动卸载**、恢复后**自动重载**。
2. **生命周期与 effect**：`ctx.effect(() => { ...; return disposer })`；fiber 状态机 `PENDING → LOADING → ACTIVE → (FAILED) → UNLOADING → DISPOSED`；disposer **逆序**执行，异步 disposer 并发。
3. **配置**：插件导出 `Schema<Config>`（`@deepseek-ai/schemastery`，实现 Standard Schema），`apply(ctx, config)` 拿到的是**已校验、已补默认值**的配置；校验失败 → fiber `FAILED`，插件绝不带残缺配置启动。`.volatile()` 字段可不重挂载地热更新。
4. **作用域**：`ctx.isolate(name, label)` 让同一服务名在不同插件组解析到不同实例；`ctx.intercept` 可注入服务配置。

### 2.3 声明式插件树（loader/HMR）的机制与代价

`@deepseek-ai/cordis-plugin-loader` 的实现在 `lib/index.js` 中**运行期按路径动态导入模块**：

- `import(name, getOuterStack)` → `await import(rewriteRelativeImportExtension(...))`（loader `lib/index.js:214-223`）；
- 同时 `createRequire(import.meta.url)`（`:1,10`），并尝试 `--expose-internals`（`:11-13`）或 `require('node-addon-require-builtin').requireBuiltin(id)`（`:14-16`）以访问 Node 内部模块加载器（HMR 依赖）。

→ 结论：**loader/HMR 要求插件以真实文件存在于磁盘**。这与"esbuild 打成单文件、`dist/main/Src/` 下只有一个 `main.js`、asar 只读"的现状**直接冲突**。

---

## 3. Spike 验证结果（可复现）

全部在 `.tmp/cordis-spike/`（`.gitignore` 忽略），依赖安装在**该子目录**，根 `package.json` 未改。安装：`@deepseek-ai/cordis@4.0.4` + `@deepseek-ai/schemastery@3.18.4` + `@deepseek-ai/cordis-plugin-loader@1.0.5`（共 5 个包）。

### 3.1 运行时行为（`tsx` 直跑，与 `npm start` 同一条运行时路径）

```
[check1] 依赖缺失时 consumer 状态 = PENDING
[metrics] 资源已申请（timer）
[consumer] ACTIVE，metrics.boot = 1
[check2] 提供方上线后 consumer 状态 = ACTIVE
[check3] standard-schema 接口存在 = true
[check3] 配置补默认值 = {"greeting":"Hello","targets":["civitas"],"retries":2}
[check3] 非法配置 issues = [{"message":"$.targets expected array but got not-an-array","path":["targets"]}]
[metrics] 资源已释放（timer）
[check4] 提供方卸载后 consumer 状态 = PENDING
[metrics] 资源已申请（timer）
[consumer] ACTIVE，metrics.boot = 1
[check4] 提供方恢复后 consumer 状态 = ACTIVE
[consumer] ACTIVE，metrics.boot = 2
[consumer] ACTIVE，metrics.boot = 3
[check5] 同一插件挂载两次 → 两个独立 fiber: true | a = ACTIVE | b = ACTIVE
[done] 所有 fiber 已 dispose，effect 已回卷
```

**验证到**：依赖驱动加载、`PENDING` 语义、`ctx.effect` 资源自动回卷、服务重建后消费者自动重载、同一插件多次挂载互不干扰、Schema 校验与默认值填充。

### 3.2 严格类型配置下的编译（用本仓库的编译选项逐条对齐）

以 `tsconfig.json:16-35` 的同款选项（`strict` / `noUncheckedIndexedAccess` / `isolatedModules` / `noUnusedLocals` / `noUnusedParameters` / `noImplicitReturns` / `moduleResolution: "bundler"`）对以下代码做 `tsc --noEmit`：

```ts
declare module '@deepseek-ai/cordis' { interface Context { civitasGreeter: CivitasGreeterService } }
export class CivitasGreeterService extends Service { constructor(ctx: Context) { super(ctx, 'civitasGreeter') } }
export const name = 'civitas-greeter-consumer'
export const inject = ['civitasGreeter']
export function apply(ctx: Context, config: Config): void {
  ctx.effect(() => { const t = setInterval(() => { for (const x of config.targets) ctx.civitasGreeter.greet(x) }, 1000); return () => clearInterval(t) })
}
```

**结果：`tsc --noEmit` exit 0**（声明合并、`inject`、`Schema<Config>`、`ctx.effect` 均通过）。
唯一注意点：`FiberState` 是 **`const enum`**（cordis `src/fiber.ts:147`），在 `isolatedModules: true` 下**只能作为类型**导入（值访问会报 TS2748）——这正是 spike 用 `import type` + 本地映射表打印状态的原因。

### 3.3 单文件 ESM 打包（复刻 `Scripts/build.cjs` 的形态）

```
esbuild bundle-entry.ts --bundle --platform=node --target=node20 --format=esm
→ dist/bundle.mjs  (93 KB)
node dist/bundle.mjs
[bundled] service+inject+config OK → Hello, civitas!
[bundled] consumer fiber uid = 2 state = 2
[bundled] 单文件 ESM 打包可行，无运行期磁盘模块依赖
```

**验证到**：cordis 内核（含 schemastery）可被 esbuild **静态内联进单文件 ESM**，不依赖磁盘上的模块文件；`"type":"module"` 与 ESM-only 依赖无兼容问题，**无原生扩展、无 `__dirname` 依赖**。

### 3.4 spike 的边界（未验证项）

- ❌ 未验证 loader + `cordis.yml` 在本仓库的**打包产物**中能工作（分析上已判定不可行，见 §2.3，未做端到端反证）。
- ❌ 未验证与 `better-sqlite3` 的生命周期耦合（DB 连接挂在哪个 effect 上、关闭顺序能否对齐现有 9 步）。
- ❌ 未在 Electron 打包态（asar）下实测 cordis。
- ❌ 未验证 1635 个现有用例在容器化后的通过率（未运行测试套件，只跑了 typecheck/lint）。

---

## 4. 概念映射表（现有机制 → cordis）

| 现有机制 | cordis 对应 | 差距 | 工作量 |
|---|---|---|---|
| 6 个模块级注册表（Hook/中间件/工具/EventBus/Provider/路由） | `Service` 子类 + `ctx.xxx` | 需实例化、需补 `unregister*`、需处理"名字永久占用"语义 | 8–12 人日 |
| `Src/main.ts` 19 步人工启动 | `inject = [...]` 依赖图 | 顺序由依赖决定，需先梳理真实依赖（含 `pathResolver` 缓存等隐式时序） | 5–8 人日 |
| `Src/main.ts:886-968` 9 步手写关闭 | `ctx.effect()` disposer 逆序回卷 | 需逐项确认资源归属；`closeDatabase()` 等全局副作用需要一个明确的"最后卸载"插件 | 3–6 人日 |
| `getConfigValueOr` + `as number` 断言（25 处，全在 main.ts） | `Schema<Config>` + `apply(ctx, config)` | 现配置**无运行时类型校验**（仅断言）；需按 ~16 个配置文件的段结构切分 schema；`zod` 已在依赖里但未用 | 4–6（schema）+ 含在 L1/L2 内（改造消费点） |
| `Src/Tools/Registry/toolServicePorts.ts`（6 端口手工注入） | `ctx.get('name')` / `inject` | 语义几乎 1:1，是本仓库与 cordis 最贴合的一处 | 2–3 人日 |
| `setElectronRuntime` / `setSafeStorageProvider` 等注入缝 | 无直接对应（应保留） | Electron 能力**必须**继续注入，cordis 服务不可 `import electron` | 1–2 人日 |
| `Src/Infra/Watcher` 数据热重载（Prompts/Skills，5s 轮询） | loader 配置热更新 / `volatile` | 现在是**数据热重载**且只覆盖 2 类资产；JSON 配置变更完全不重载；`stopWatching()` 无调用方 | 5–10 人日 |
| **110 / 287 个模块的模块级可变状态**（149 `let`、73 `Map/Set`、17 个数组注册表） | `Service` 实例 + `ctx.effect` | **迁移的本质是重写状态所有权**，不是改写构造函数（全仓仅 7 个 class、6 个构造函数，真正注入配置的只有 2 个） | 25–40 人日 |
| `Src/Infra/AccountScope` 的全局 `activeOwner`（跨 3 层约 120 处读取，186 处 `owner_user_id` SQL） | `ctx.isolate(name, label)` / 按 context 派生实例 | **已验证：这不是 DI 隔离，而是"全局当前属主 + 查询条件过滤"**；无按账号实例，切换属主是全局副作用（缓存键都在拼 owner：`Services/Cache/toolResultCache.ts:60`）。走 `isolate` 需把 owner 从全局态提升为 context 维度 | 10–15 人日 |
| 测试的 mini 组合根（153 / 201 装配符号被测试引用；无 `setupFiles`） | 每个测试 `new Context()` + 挂载插件子集 | 需先建立 vitest `setupFiles` 与"测试插件树"约定，否则 133 个测试文件要各自适配容器 | 8–12 人日 |
| Hook / EventBus 的 `priority` 排序语义 | cordis 事件 `ctx.on`（无 priority） | 需自建优先级或保留现有注册表作为服务内部实现 | 2–4 人日 |
| `main.ts` 988 行组合根（0 覆盖率） | 12–18 个插件模块（**可被测试**） | 覆盖率分母变化，需同步 `Configs/coverageBaseline.json` 与 CI 阈值 | 含在 L1 内 |

---

## 5. 阻塞项与风险

### P0（不解决则改造无法落地）

| 编号 | 阻塞项 | 证据 | 影响 |
|---|---|---|---|
| **B1** | **单文件 ESM 打包阻断声明式插件加载** | `Scripts/build.cjs:39-50`；loader 运行期 `import()` 文件路径（loader `lib/index.js:214-223`）；asar `package.json:130` | L3 完全不可行，除非改构建（多入口 / `splitting` / `packages:'external'`） |
| **B2** | **Hook / Tool / Route 三处无单条注销** | `hookRegistry.ts:143-145`、`toolRegistry.ts:171-173`、`router.ts:108-110` 均只有"全清" | cordis `effect` 的核心是**可逆 dispose**；这三处不补 `unregister`，容器化后"卸载"就是假卸载 |
| **B3** | **后端模块图必须全进程唯一** | `Src/main.ts:976-986`（注释 `:982` 记录重复初始化 → 工具重复注册 FATAL）、`electron/main.ts:47-50,527-529` | cordis 容器必须保持单例语义，且不能被 esbuild 内联两份；迁移中任何"把变量说明符改回静态 import"都会踩雷 |

### P1（显著抬高成本）

| 编号 | 风险 | 证据 | 说明 |
|---|---|---|---|
| **B4** | 启动时序存在**隐式**硬约束 | `Src/main.ts:167-174`（env → `resetPathCache()` 必须在任何路径解析前）；`pathResolver.ts:59` | 异步 `apply()` 与隐式时序冲突；需把隐式约束显式化为插件间依赖 |
| **B5** | 覆盖缺口 + 测试强耦合全局单例 | `vitest.config.ts:27`（`Src/main.ts` 排除覆盖率，且**无 `setupFiles`**）；**153 / 201** 个装配符号被测试引用；**20 个测试文件自带 mini 组合根**（`Tests/Decision/orchestrationPipelines.spec.ts:60-95` 的 `fullReset()` 一次 15 次装配）；0 个测试 import `main.ts` | 改造会同时动大量测试的隐含假设；也意味着"先迁移、后有测试保护"的顺序错误 |
| **B6** | 版本与生态耦合 | 上游 `cordis@4.0.0-rc.10` 为 RC；DSH 分支 `@deepseek-ai/cordis@4.0.4` 为 MIT 但由第三方（DeepSeek）维护；loader/HMR 依赖 Node 内部加载器与 `node-addon-require-builtin`（本机**不可用**，loader 内 try/catch 降级） | 需明确版本跟随策略；HMR 能力在 DSH 运行时之外可能降级 |
| **B7** | 原生依赖需"双处登记" | `build.cjs:25`（external）+ `package.json:131-134`（asarUnpack） | cordis 内核纯 JS，风险低；但其生态插件若引入原生依赖需同步 |
| **B8** | 配置无运行时校验 + 下游无 apply 门面 | `getConfigValueOr` 末尾 `as T`（`configLoader.ts:194`）；25 处调用全在 `main.ts`；**不存在** `reloadConfig`/`invalidateConfig`；`stopWatching()`/`resetConfigWatcher()` **零调用方**（定时器无 dispose 路径）；`tools.json`/`dataStorage.json` 未加载、`mutationLevels` 零调用 | 迁到 Schema 是收益（也是主要工作量）；但"改配置即生效"需要新建 apply/reload 门面，现有子系统只暴露 `init*/set*` |
| **B13** | **状态所有权分散：110 / 287（38.3%）模块持有模块级可变状态** | 149 个顶层 `let` + 73 个 `Map/Set` + 17 个数组注册表；全仓**仅 7 个 class、6 个构造函数**，真正注入配置的只有 2 个 | 这是工作量最大的单项（25–40 人日）。若只做"装配容器化"而保留 110 个模块级状态，容器会沦为第二套全局态，收益减半 |
| **B14** | 分层门禁"纸面合规" | `package.json:32` 的 `layer-check` 用**空 `zones`** 覆盖规则（永远通过）；`.husky/pre-commit:15` 以 `\|\| true` 结尾；`tsconfig.json` 排除 `Tests` → 测试不受强类型 lint 约束 | 迁移期正是最需要门禁的时候；**必须先把这三处补上**，否则依赖倒置会被静默引入 |

### P2（低风险，注意即可）

| 编号 | 事项 | 说明 |
|---|---|---|
| B9 | **分层红线不构成阻塞**（一条常见误判的纠正） | `import/no-restricted-paths`（`.eslintrc.json:15-47`）只约束**项目内相对路径**；`import { Context } from '@deepseek-ai/cordis'` 属于外部依赖，各层均可导入。且 `Src/Infra` 已有外部依赖先例（`Infra/Db/database.ts:19` 引 `better-sqlite3`），所谓"Infra 零依赖"仅指 `Infra/Contracts/middlewareTypes.ts:15-16` 那一个文件的自我约束。**真正需要约定的是"服务名清单与 `declare module` 声明落点"的目录规范。** ⚠️ 但例外是承重墙：`Services → Core` 的 22 条边全部落在 `.eslintrc.json:29-34` 的 `except` 内（评审/招募/A2A/监管直取 Agent 注册表），容器化时应改为 `ctx.agentRegistry` 一类服务 |
| B10 | 多租户隔离语义（**已验证**） | **不是 DI 隔离，而是"全局当前属主 + 查询条件过滤"**：`Src/Infra/AccountScope/activeAccount.ts:27` 的模块级 `let activeOwner` 被 3 层约 120 处读取，配套 186 处 `owner_user_id` SQL 与内存旁表；切换属主是全局副作用，且只回灌长时记忆（`Interface/RestApi/memoryApi.ts:225`），`globalWorkspace`/`governanceAudit` 仅在启动期 hydrate（`Src/main.ts:319,324`）。**cordis `isolate` 无法直接套用，需先把 owner 从全局态提升为 context 维度** |
| B11 | 前端与 `Server/` 不受影响 | `Client/` 是独立 SPA（REST/IPC 通信）；`Server/` 是独立 fastify 包（`Server/src/app.ts:15-21` 手写工厂），不进单文件打包、不进 Electron 包 → **可作为独立决策，不必同时改造** |

---

## 6. 分阶段实施建议

### 阶段 0：前置改造（不改容器，先补齐 cordis 的语义前提与安全网）

1. **补齐可逆性**：新增 `unregisterHookHandler(name, event)`、`unregisterTool(name)`、`unregisterRoute(method, path)`；把 `unregisterMiddleware` 从 `Core/Middleware/index.ts` 导出（B2）。
2. **补门禁三漏洞**（B14）：修掉空 `zones` 的 `layer-check`、去掉 pre-commit 的 `|| true`、让 `Tests/` 纳入强类型 lint —— 迁移期正是最依赖门禁的时候。
3. **建立测试安全网**：给 `vitest.config.ts` 加 `setupFiles`，提供统一的"测试上下文重置"入口，替掉 20 个测试文件里的 mini 组合根（`Tests/Decision/orchestrationPipelines.spec.ts:60-95` 一类）。
4. **定"服务名清单 + 类型声明落点"约定**（建议新建 `Src/Composition/`，或在 `Src/Infra/Contracts/` 下开 `services/`），明确 6–10 个核心服务的名字、接口与 `declare module` 位置。
5. **显式化隐式时序**：把 121 次装配调用梳理成"启动步骤 → 真实依赖"对照表，标出 `pathResolver` 缓存、四个 hydrate 回灌点等硬约束（`Src/main.ts:167-174,299-329`）。
6. 建立 spike 回归脚本，把 §3 的四项验证固化为可重跑命令。

**验收**：`typecheck` / `lint` 0 error；新增 3 个 unregister 有单测；`setupFiles` 落地后原有 1635 用例仍全绿；依赖对照表评审通过。

### 阶段 1：容器化（L1，收益最高、风险最低）

建议拆成三个可独立验收的子阶段：

**1a 薄容器化（装配层）**
- 引入 `@deepseek-ai/cordis`（或上游 `cordis`，见 §2.1 选型）作为**纯进程内容器**：不使用 loader/HMR，不做声明式配置。
- 把 6 个注册表 + `toolServicePorts`（穷人版服务定位器）改写为 `Service` 子类；把 `Src/main.ts` 的装配体切成 **12–18 个插件模块**（也可按 §10 的**层插件树**形态挂载，方向须为"提供者在祖先"）；用 `inject` 取代人工排序；用 `ctx.effect` 取代 9 步手写关闭。
- 按独立审计建议的次序：先接管 `toolServicePorts` 与 17 个全局 setter，再用 `ContextStore`（全仓唯一按参数传递的实例对象，`ipcBridge.ts:941` → `runIteration.ts:216`）做 scope 试点。
- **业务内核（Core/Loop/Services 内部逻辑）不动**。

**1b 状态所有权迁移（B13，工作量最大项）**
- 对 110 个持有模块级可变状态的模块逐个决策："提升为 `ctx.xxx` 服务 / 保持模块私有 / 移入 effect 生命周期"。优先处理 20 个高后果项（数据库连接、工具表、Provider 表、Agent 注册表、长时记忆、审批队列、EventBus、路径守卫、钱包等）。
- 明确"服务实例 vs 模块私有状态"的判定标准，避免容器退化成"第二套全局态"。

**1c 租户 scope 化（B10）**
- 把 `getActiveOwner()` 的约 120 个调用点从"读进程全局"改为"从 context 取值"；缓存键、内存旁表、SQL 过滤三处同步。
- 顺带修复现状缺陷：切换属主只回灌长时记忆，`globalWorkspace`/`governanceAudit` 不重灌（`memoryApi.ts:225` vs `main.ts:319,324`）。

**验收**：1635 用例全绿；`npm run typecheck` / `lint` / `build` / `Scripts/verifyPackage.cjs` 全绿；打包产物体积与启动时序无回归（`dist/main/Src/main.js` 基线约 735 KB）；并发/嵌套属主场景有新增测试。

### 阶段 2：配置 Schema 化（L2）

- 按子系统把 `initXxx(params)` 的参数与 `getConfigValueOr(...) as T` 迁移为插件 `Schema<Config>`；优先从风险最高的路径/安全/预算/循环上限四处开始（这些当前是"断言即信任"）。
- 保留 `Configs/*.json` 作为数据源，由容器按插件分节喂入。

**验收**：非法配置在启动期即被拒绝（fiber `FAILED`），替换现有"启动成功但运行期才炸"的行为。

### 阶段 3：声明式插件树 + HMR（L3，**需先改构建**）

前置：把 `build.cjs` 从"单文件全内联"改为 **多入口 / `splitting` / `packages:'external'`**，并解决 asar 内 `import()` 不可靠与资源目录只读的问题（`Configs/Prompts/Skills` 的双份投递需重新设计）。
**只有当前两阶段稳定运行 1–2 个版本后**，再评估这一步的收益是否值得。

### 不建议做（反模式）

- ❌ 一次性全量重写为 harness 式插件树（L4）：与 133 个测试文件、6 篇 ADR、5 条分层红线正面冲突，且收益（HMR）被构建形态阻断。
- ❌ 在解决 B1 之前引入 loader：会得到一个"开发态能跑、打包后必崩"的系统。
- ❌ 依赖 cordis 事件替代现有 Hook 的 `priority` + fail-open/fail-closed 语义：语义不等价（cordis 事件无优先级），会静默改变治理行为（本项目有 ADR-0003/0004 约束验证层级与模型多样性，属高危面）。
- ❌ 把 `src/main.ts` 的组合根直接删掉：它是当前唯一保证启动时序的地方，且零测试覆盖。

---

## 7. 工作量汇总（估算，非实测）

| 阶段 | 内容 | 人日（估算） | 风险 |
|---|---|---|---|
| 0a | 3 处 unregister + 修门禁三漏洞 + vitest `setupFiles` | 5–8 | 低 |
| 0b | 服务名/落层约定 + 依赖对照表 + spike 回归脚本 | 4–7 | 低 |
| 1a | 薄容器化（6 注册表 + 端口定位器 + 12–18 插件 + 关闭回卷） | 15–25 | 中（B3/B4/B5） |
| **1b** | **状态所有权迁移（110 / 287 个模块的模块级状态）** | **25–40** | **高（B13，最大单项）** |
| 1c | 租户 scope 化（~120 个 `getActiveOwner()` 调用点） | 10–15 | 高（B10） |
| 2 | 配置 Schema 化（~16 个配置段 + 消费点改造 + apply/reload 门面） | 10–20 | 中（B8） |
| 3 | 构建形态改造 + loader/HMR + 打包验证 | 20–40 | 高（B1/B6） |
| — | 回归与验收（1635 用例 + 打包冒烟 + 安装包） | 10–20 | 中 |
| **合计** | **阶段 0 + 1a（最小可用容器化）** | **25–40** | 可控 |
| **合计** | **完整 L1（含 1b/1c）** | **60–95** | 中等偏高 |
| **合计** | **含 L2 / L3** | **90–155** | 高（集中在状态所有权与构建/打包） |

**交叉验证**：独立审计（按"保留现有分层与公开 API 形状"的保守口径）给出的迁移总量为 **约 100–165 人日**，与本表"完整 L1 + L2"的 70–115 人日量级一致，差异来自对 1b（状态所有权）与测试改造的计入口径。建议对外报数使用 **100–165 人日** 作为保守上界。

> 估算依据：121 次装配调用、202 个装配符号、110 个含可变状态的模块、6 个注册表、988 行组合根、1635 处用例、单文件打包链路。**均为估算，未做真实排期**。

---

## 8. 附录

### 附录 A：验证环境

| 项 | 值 |
|---|---|
| Node / npm | `v22.23.0` / `10.9.8` |
| 运行时 | 仓库 `node_modules/.bin/tsx`（与 `npm start` 同路径） |
| 打包器 | 仓库 `node_modules/.bin/esbuild`（与 `build.cjs` 同版本 `^0.28.2`） |
| 编译器 | 仓库 `node_modules/.bin/tsc`（TS `^5.7.0`），编译选项逐条对齐 `tsconfig.json` |
| spike 依赖 | `@deepseek-ai/cordis@4.0.4`、`@deepseek-ai/schemastery@3.18.4`、`@deepseek-ai/cordis-plugin-loader@1.0.5`（5 包，仅装于 `.tmp/cordis-spike/node_modules`） |
| spike 文件 | `.tmp/cordis-spike/{spike.ts, bundle-entry.ts, strict-typed.ts, tree-spike.ts, tree-spike2.ts, tsconfig.json, dist/bundle.mjs}`（`.tmp/` 已被 `.gitignore` 忽略） |

### 附录 B：复现命令

```powershell
# 1) 运行时行为
node_modules\.bin\tsx.cmd .tmp\cordis-spike\spike.ts

# 2) 严格类型编译（本仓库编译选项）
node_modules\.bin\tsc.cmd -p .tmp\cordis-spike\tsconfig.json     # → exit 0

# 3) 单文件 ESM 打包 + 运行
node_modules\.bin\esbuild.cmd .tmp\cordis-spike\bundle-entry.ts --bundle --platform=node `
  --target=node20 --format=esm --outfile=.tmp\cordis-spike\dist\bundle.mjs
node .tmp\cordis-spike\dist\bundle.mjs

# 4) 层树方向性实验（父/子可见性、inject 死锁、isolate、卸载级联）
node_modules\.bin\tsx.cmd .tmp\cordis-spike\tree-spike.ts

# 5) 同名重复注册 / 加载顺序 / 作用域内重复注册
node_modules\.bin\tsx.cmd .tmp\cordis-spike\tree-spike2.ts
```

### 附录 C：未验证项（需在立项前补齐）

1. loader + `cordis.yml` 在**打包产物**中的端到端失败复现（本报告 §2.3 为机制分析，未做反证实验）。
2. `better-sqlite3` 连接在 cordis 生命周期下的关闭顺序与现有 9 步关闭的等价性。
3. Electron 打包态（asar）加载 cordis 的实测。
4. ~~`Src/Infra/AccountScope` 的隔离语义~~ → **已查清**：是"全局当前属主 + 查询过滤"，不是实例隔离（见 B10）。**未验证**的是"把 owner 提升为 context 维度"的具体方案（约 120 个调用点 + 186 处 SQL 过滤 + 内存旁表 + 缓存键）。
5. 1635 个现有用例在容器化后的通过率（本报告未运行测试套件，只跑了 `typecheck` / `lint`）。
6. `@deepseek-ai/cordis` 与上游 `cordis` 的 API 差异清单（是否可直接互换）。
7. 上游 `cordis` 4.x GA 时间表与 DSH 分支的版本跟随策略（对应 B6）。
8. 安装态下"内置 `local.json` 与用户功能文件"的实际覆盖顺序（代码推演为"内置 local 会覆盖用户功能文件"，未实机验证）。
9. 层插件树在 **Electron/asar 打包态**下的挂载行为（本报告的树形实验均在 `tsx` 直跑下完成）。
10. 层插件数量增加对**启动耗时**的影响（未做基准测量；现有 19 步装配耗时亦无基线）。
11. `isolate` 与模块级可变状态的交互：isolate 只隔离服务查找，不隔离 `let`/`Map` 全局态——多租户方案必须与 B13 一并设计（本报告给出的是机制结论，未做端到端验证）。

---

## 9. 最终判定

> **支持，但需要分两步走，并且"改造级别"必须先在立项时锁定。**
>
> - 若目标是**治理手工装配、拿回生命周期与可测试性**（L1/L2）：**技术可行、风险可控**，spike 已在本仓库的真实运行时与工具链下验证通过；建议立即启动阶段 0。
> - 若目标是**声明式插件树与代码热替换**（L3）：**当前构建形态不支持**，必须先完成构建产物形态改造；在此之前引入 loader 会产出"开发态可用、打包后必崩"的系统。
> - 若目标是**整体重写为 DSH 式 Harness**（L4）：**不建议**，投入（6–12 人月）与现有 1635 用例/ADR/分层门禁的冲突不成比例。
>
> **最小可用切入**：阶段 0 + 1a（约 **25–40 人日**）即可验收"容器接管装配、依赖驱动启动、effect 自动关闭"，且业务内核零改动、风险最低。
> **最大不确定性**不在框架，而在 **B13（110/287 个模块的状态所有权）与 B10（全局租户态）** —— 这两项决定改造是"换装配方式"还是"重写状态模型"，立项时应先明确取舍；只做 1a 而不动这两项，容器收益有限（装配变清晰，但全局态依旧）。
> **建议下一步**：基于本报告产出一篇 ADR（记录 L1/L2/L3 的选型与版本策略），再进入阶段 0。

---

## 10. 追加评估：按层嵌套的插件树（"下一层作为上一层的子插件"）

> 提案：把后端组织为一棵 `Interface → Services → Core → Tools → Infra` 的插件树，**下一层作为上一层的子插件**。
> 本节结论基于新增的 4 组实测（`.tmp/cordis-spike/tree-spike.ts`、`tree-spike2.ts`），不是推断。

### 10.1 结论（三句话）

1. **结构可行，但方向必须反过来**：`Infra → Tools → Core/Services → Interface`（**提供者在祖先，消费者在后代**）。按提案方向（Interface 为根、Infra 为叶）会让整棵树**死锁**（实测 Q3）。
2. **这棵树买到的是"生命周期 + 作用域"，不是"分层依赖约束"**。cordis 的服务命名空间是**全应用扁平**的：父能看到子提供的服务、兄弟互相可见（实测 Q1/Q2）→ **树形结构无法阻止任何跨层访问**，分层仍只能靠 `.eslintrc.json` 的 zones 与评审。
3. **新增的最大失效模式是"PENDING 静默失败"**：某层 `inject` 未满足时该层不加载、不报错、进程甚至可能静默退出。必须配套"启动自检遍历 fiber 状态"，否则改造后会表现为"什么都没发生"。

### 10.2 实测结果

| # | 问题 | 实测输出 | 结论 |
|---|---|---|---|
| Q1 | 兄弟插件互相可见？ | 未提供时消费者 `PENDING` → 提供后 `ACTIVE`，`ctx.get('svcA') = true` | ✅ 可见（平铺命名空间） |
| Q2 | **父插件能否看到子插件提供的服务**？ | `ctx.get('svcB') = true`（父）、`root.get('svcB') = true`（根） | ✅ **可见** → 上层消费下层**不受树形限制** |
| Q3 | **父用 `inject` 依赖"将由子插件提供"的服务** | `parent-2 = PENDING`、`apply 是否执行过 = false`、`svcC 是否被提供 = false` | ❌ **死锁**：apply 不跑 → 不挂子插件 → 服务永不就绪 |
| Q4 | `isolate` 子树独立实例 | 子树消费者看到 `tag = inner`，外层消费者看到 `tag = outer` | ✅ 可用于按层/按租户多实例 |
| Q5 | 卸载父插件是否级联 | 卸载后 `svcE 存在 = false`、`consumerE = PENDING` | ✅ 递归卸载 + 依赖方自动回退 |
| 补 1 | 同名重复注册 | 第二次注册 fiber = `FAILED`，原实例仍可用 | ✅ 拒绝覆盖（比现状 `registerProvider` 静默覆盖安全） |
| 补 2 | 加载顺序 | `ancestor.apply → child.apply → grandchild.apply` | ✅ 祖先必先于后代 |
| 补 3 | `isolate` 内同名注册 | 内层 `ACTIVE`、`iso.get(svcX) = true`，外层不受影响 | ✅ 作用域隔离有效 |

### 10.3 机制（为什么是这样）

- **服务注册落在全局扁平 store**：`provide()` 用 `ctx.root[symbols.isolate][name]` 作为 key 写进共享 store（cordis `src/reflect.ts:237-243,277-305`）；未调用 `isolate()` 时全应用共用一个 key → 任何 ACTIVE fiber 提供的服务对全树可见。DSH 文档亦称"每个应用中的服务名称共用一个扁平命名空间"。
- **只有 fiber 生命周期是树形的**：子插件由父的 `ctx.effect(...)` 持有（cordis `src/fiber.ts:265-297`），因此"卸载父 → 递归卸载子"成立，而"子服务只对父可见"**不成立**。
- **`inject` 是全局就绪检查，与树形无关**（`src/fiber.ts:314-319`）→ 父等子 = 死锁。

### 10.4 针对本仓库的正确层树

实测层级依赖：`Infra ←(29) Tools ←(Core 3 / Services 2 / Interface 1)`，`Infra ← Core(69) / Services(201) / Interface(33)`，另有 `Core ↔ Services` 看似双向（Core→Services 38 条、Services→Core 22 条且全在 `except` 内）。

**但逐条解析后，"双向"其实只发生在两个具体错配点上，不是整个 Core 与整个 Services 互缠**（全量边表见 §10.8）：

| 方向 | 边数（运行时/纯类型） | 指向 | 性质 |
|---|---|---|---|
| Core → Services | 38（**35 运行时** / 3 类型） | EventBus 18、TokenEconomy 4、Prompts 4、LoopControl 4、Supervision 2、SharedMemory 2、Hook 1、Context 1、Cache 1、Audit 1 | **内核调用横向平台能力**（发事件、记账、装 prompt、取 stopRules、前后监管）——方向正确 |
| Services → Core | 22（**14 运行时** / 8 类型） | **全部集中在 `Core/AgentRuntime` 的 3 个模块**：`agentRegistry` 8、`agentFactory` 3、`agentRuntime` 3 | **治理类服务读取 Agent 模型**（A2A/招募/评审/审计/治理问"当前有哪些 Agent、责任人是谁"）——方向也正确 |

关键观测：**`Core/Loop`、`Core/Decision`、`Core/Middleware` 与 `Services/` 的治理类服务之间没有任何运行时边**（只有 `Services/Recruitment/*` 引用 `Core/Decision/types` 的 2 条 **纯类型**边）。而且 `Core/AgentRuntime/agentRegistry.ts` 只依赖 Infra（`Infra/types`、`Infra/Logging`、`Infra/Roles`、`Infra/Db/Repositories/agentRepository`），**不依赖 Core 的循环内核**。

根因：`Src/Services` 目录把两类模块混在一起——
- **横向平台能力**（EventBus / Hook / Cache / Prompts / Context / SharedMemory / TokenEconomy / LoopControl / Supervision / Session），它们在依赖图的**下层**，Core 依赖它们；
- **领域治理能力**（A2A / Recruitment / ReviewerAgent / Audit / Governance / Regulation / Arbitration），它们在依赖图的**上层**，依赖 Core 的 Agent 模型。

历史成因（git 证据）：`.eslintrc.json` 的分层 zones 是 2026-09-23 提交 `493b005`（"恢复分层 zones"）补上的，commit message 明确写着"**`AgentRuntime/Decision` 以 `except` 豁免**"。也就是说：**代码先长成这样，门禁后补，为了不推翻既有实现而开了豁免**；并且 zones 从未禁止 `Core → Services`，只豁免了反方向——所以"双向"从来不是违规，而是**声明层序（链式）与真实依赖（菱形）不一致的指纹**。

把两个错配点各自归位，双向依赖即消失：

```
root  (Context)
└── infra            DB / paths / config / logger / time / security
    └── platform     横向平台能力：EventBus / Cache / Prompts / SharedMemory / TokenEconomy / Hook / Context / LoopControl / Supervision
        └── agent-core   AgentRuntime：agentRegistry / agentFactory / agentRuntime / stateMachine（只依赖 Infra + platform）
            ├── kernel-loop    Loop / Decision / Middleware / agentExecutor（inject agent-core + platform）
            ├── governance     A2A / Recruitment / ReviewerAgent / Audit / Governance / Regulation / Arbitration（inject agent-core + platform）
            └── interface      REST / IPC（inject 全部）
```

- `kernel-loop` 与 `governance` 是**同级兄弟**：它们之间没有边（实测），各自只依赖 `agent-core` 与 `platform` → 不构成互等。
- **"AgentRuntime 下沉"是关键一步**：它把 14 条 Services→Core 运行时边从"向上依赖 Core"变成"依赖下层共享服务"。

> 注意：由于命名空间扁平，这些插件之间的**可见性**不依赖树形，树形只决定**谁在谁的 `apply` 里被挂载**（= 生命周期归属与加载/卸载顺序）。

**两条硬规则**（否则踩 Q3 死锁）：

1. **任何插件不得挂载"自己要 `inject` 的插件"**——挂载者必须是祖先或外部 loader。层级树里由**上层负责挂载下层**，正好满足这一条。
2. **同级兄弟不得互相 `inject`**：若两者互等，会同时 PENDING → 死锁。按上面的划分，`kernel-loop` 与 `governance` 落在此约束内是可以满足的（实测二者无边）；若将来出现新边，必须三选一：
   - **下沉**：把被依赖能力降到共同祖先层（推荐，本仓库的 `AgentRuntime` 属此类）；
   - 或**端口化**：沿用 `toolServicePorts` 模式由下层提供（`Tools` 层已在用）；
   - 或**同级 + 可选读取**：双方只用 `ctx.get()`（放弃就绪保证，必须靠启动自检兜底）。

### 10.5 Core ⇄ Services 全量边表（实测证据）

**Core → Services（38 条 / 12 文件；运行时 35、纯类型 3）**

| 文件 | 条数 | 目标 |
|---|---|---|
| `Core/Loop/runIteration.ts` | 10（9 运行时） | preSupervision / postSupervision / stopRules / LoopControl.types(type) / hookRegistry / contextStore / promptRegistry / skillsAssets / strategyLedger / toolSafetyGate |
| `Core/Loop/loopEconomy.ts` | 6 | eventTypes / eventBus / consumptionRecorder / dualBudget / taxCollector / anomalyDetector |
| `Core/AgentRuntime/agentFactory.ts` | 3 | walletManager / promptRegistry / skillsAssets |
| `Core/Decision/orchestrator/orchestrator.ts` | 3（2 运行时） | eventTypes ×2 / eventBus |
| `Core/Decision/orchestrator/progressTracker.ts` | 3（2 运行时） | eventTypes / eventBus / eventTypes(type) |
| `Core/AgentRuntime/agentRuntime.ts` | 2 | eventTypes / eventBus |
| `Core/Decision/orchestrator/conflictPrecheck.ts` | 2 | eventTypes / eventBus |
| `Core/Decision/orchestrator/mergePhase.ts` | 2 | eventTypes / eventBus |
| `Core/Loop/contextCompression.ts` | 2 | eventTypes / eventBus |
| `Core/Loop/loopKnowledge.ts` | 2 | globalWorkspace / memoryConsolidator |
| `Core/Middleware/middlewareRegistry.ts` | 2 | eventBus / eventTypes |
| `Core/Model/modelCaller.ts` | 1 | promptCache |

**Services → Core（22 条 / 12 文件；运行时 14、纯类型 8）**

| 文件 | 条数 | 目标（运行时） | 纯类型 |
|---|---|---|---|
| `Services/ReviewerAgent/reviewerAgent.ts` | 5 | agentRuntime ×2、agentRegistry、agentFactory | AgentRuntime/types |
| `Services/Recruitment/recruiter.ts` | 5 | agentFactory、agentRegistry、agentRuntime | AgentRuntime/types、Decision/types |
| `Services/A2A/cardSync.ts` | 2 | agentRegistry | AgentRuntime/types |
| `Services/Governance/governanceProvisioning.ts` | 2 | agentFactory、agentRegistry | — |
| `Services/A2A/a2aBroker.ts` | 1 | — | AgentRuntime/types |
| `Services/A2A/agentCard.ts` | 1 | — | AgentRuntime/types |
| `Services/A2A/types.ts` | 1 | — | AgentRuntime/types |
| `Services/A2A/visibility.ts` | 1 | agentRegistry | — |
| `Services/Audit/auditScheduler.ts` | 1 | agentRegistry | — |
| `Services/Governance/approvalIdentity.ts` | 1 | agentRegistry | — |
| `Services/Recruitment/terminationRationale.ts` | 1 | — | Decision/types |
| `Services/Supervision/preSupervision.ts` | 1 | agentRegistry | — |

> 含义：**14 条运行时边的目标只有 3 个模块**（`agentRegistry` 8、`agentFactory` 3、`agentRuntime` 3），另 8 条是纯类型（TS 类型运行时擦除 → 对容器化零成本）。因此"打通双向依赖"的实际工作量远小于边的表面数量：**把 AgentRuntime 三个模块提升为共享服务（`ctx.agents` / `ctx.agentRuntime` / `ctx.agentFactory`）即可一次性消掉全部 14 条**。

### 10.6 这个方案真实买到了什么

| 收益 | 现状痛点 | 树形如何解决 |
|---|---|---|
| **启动顺序由结构保证** | `Src/main.ts` 19 步人工排序，含"env 必须在路径解析前"这类隐式约束 | 祖先必先 `apply`（实测补 2）→ 顺序变成拓扑事实，不靠注释 |
| **关闭顺序自动逆序** | 9 步手写关闭、`stopWatching()` 等零调用方 | 卸载父 → 子先卸（实测 Q5），disposer 逆序回卷 |
| **整层重启 / 局部重载** | 配置改动必须重启进程（JSON 变更仅打日志） | `fiber.dispose()` 一个层插件 = 整层卸载重挂；配合 loader 可做到"改配置只重启该层" |
| **故障域隔离** | 单点组合根，任一步抛错整进程启动失败 | 子树 FAILED 不影响兄弟子树，可做降级启动 |
| **多租户/S 多实例** | 全局 `activeOwner` 字符串 + 186 处 SQL 过滤 | `isolate` 给每棵子树独立实例（实测 Q4），把 owner 提升为作用域维度 |
| **注册语义变严** | `registerProvider` 后注册静默覆盖；Hook/Tool/Route 只有全清 | 同名重复注册被拒绝（fiber FAILED，原实例保留，实测补 1） |

### 10.7 它没买到什么 / 新增风险

1. **不构成分层强制**（Q1/Q2）：`Infra` 作为子插件时，它的服务对整棵树可见；`Interface` 也照样能 `ctx.get` 到任何东西。**想用树来消灭分层违规是误解**——zones 门禁仍需保留并先修好（B14）。
2. **PENDING 静默失败**（最高优先级新增措施）：必须实现"启动自检 = 遍历 `ctx.registry` 打印 PENDING/FAILED 的 fiber 名"，取代/增强现有环境自检（`Src/main.ts:613-639`）。DSH 教程第 6 章给了现成写法（`FiberState.PENDING` 扫描）。
3. **`inject` × 自挂子插件 = 死锁**是最容易犯的写法错误，需写进团队规范（10.4 规则 1）。
4. **不改变 B1**：本方案是**代码内挂载**（`ctx.plugin()`），不是 YAML 声明树；L3 的 loader/HMR 依旧被单文件 ESM + asar 阻断，与树形无关。
5. **测试与状态所有权问题照旧**：1635 用例的 mini 组合根要改造成"挂载子树"；B13（110/287 模块的状态）与 B10（全局租户态）不因树形而减少。
6. **`isolate` 的边界**：isolate 只隔离**服务查找**，不隔离模块级可变状态（`let`/`Map` 仍在模块里全局唯一）。所以"用 isolate 实现多租户"必须与 B13 的状态迁移一起做，否则只是换了个查找路径。

### 10.8 落地建议（并入 §6 阶段）

- 把 §6 阶段 1a 的"12–18 个平铺插件"改为**层插件树**：先做 3 层试点 `infra → tools → interface`（选只读子集：配置/日志/路径 + 工具注册 + 一条 REST 路由），验证：祖先先加载、逆序卸载、PENDING 自检、`isolate` 试点。
- 试点通过后再逐层展开；`Core ↔ Services` 的双向边按 10.4 三选一处理（建议先合并 `AgentRuntime`/`Decision` 相关切片）。
- 工作量与风险不变（§7）；树形只改变**挂载形态**，不改变 B1/B10/B13 的成本。
- 追加未验证项：Electron/asar 下的树形挂载、层插件数量对启动耗时的影响、`loader` 声明式树（仍受 B1 阻断）。
