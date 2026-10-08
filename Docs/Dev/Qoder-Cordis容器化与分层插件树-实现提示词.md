# 【交给 Qoder 执行】Cordis 容器化 + 分层插件树 —— 详细实现提示词

> **⚠️ 本文档由 AI 编码代理（DeepSeek Harness Agent）创建，非人工编写，也非既有设计文档的一部分。**
> 创建时间：2026-10-08 ｜ 归属目录：`Docs/Dev/`
> 用途：**交给 Qoder 执行**的详细实现提示词。本文件把路径、符号、代码骨架、迁移映射表、测试用例、
> 验收命令、易错点全部写死；**请逐条照做，不要自由发挥、不要扩大范围、不要重新论证架构**。
> 背景与论证过程见同目录 [`Cordis改造可行性评估报告.md`](./Cordis改造可行性评估报告.md)（含实测 spike 与反例），
> **不要重做评估，也不要推翻其中的已定决策**。
> 若 Qoder 正在整理文档体系，请把本文档视为外部新增产物，保留本署名块。

---

## 0. 一句话目标

在**隔离工作区**（新分支或新目录，见 §3.0；**禁止在 `main` 上原地修改**）、且**不改动任何业务实现**的前提下，
引入 `@deepseek-ai/cordis` 作为**进程内服务容器**，把 `Src/main.ts` 里**121 次手工装配调用**收敛为一棵
**方向正确的分层插件树**（`infra → platform → agent-core → kernel/governance → interface`），
使：**启动顺序由依赖图保证、关闭顺序自动逆序回卷、服务缺失在启动期即报错（不再静默）**，
并且 **1636 个既有用例全绿、单文件打包形态不变、Electron 行为不变**。

---

## 1. 执行前必读（硬约束）

1. **只做 §3.1 的 P1 范围**。§3.2 的 P2/P3（状态所有权迁移、配置 Schema 化、`cordis.yml` / loader / HMR）**明确禁止本次实施**。
2. **不允许"大爆炸"重写**。每一步（WS）都必须让 `npm start` 能起、`npx vitest run` 全绿；每个 WS 单独提交。
3. **业务代码零改动**：`Src/Infra/**`、`Src/Services/**`、`Src/Core/**`、`Src/Tools/**`、`Src/Interface/**` 的实现逻辑
   一律不修改（WS0 明确列出的 4 处 API 增补除外）。所有 cordis 相关内容只允许出现在新建的 `Src/Composition/**`。
4. **禁止引入 `@deepseek-ai/cordis-plugin-loader`、`dsh-hmr`、`schemastery` 等框架生态包**；本次只加 `@deepseek-ai/cordis` 一个依赖。
5. **禁止修改 `Scripts/build.cjs`**（不要加 external、不要加 splitting）。cordis 会被 esbuild 内联进单文件，这是实测可行的。
6. **禁止把 `@deepseek-ai/cordis` 写进 `NODE_EXTERNALS`**，也不要写进 electron-builder 的 `asarUnpack`。
7. **禁止 `import` `electron`**：`Src/Composition/**` 不得出现 `from 'electron'`；Electron 能力继续走既有注入缝
   （`setElectronRuntime` / `setSafeStorageProvider` / `setIpcMainProvider` / `setWindowBroadcaster`）。
8. **不允许删除或放松既有测试断言**来"通过"；新增行为必须新增测试。
9. 提交前**必须**跑完 §6.2 全部门禁命令，并把**完整输出**贴进交付报告（§7）。
10. 代码风格：ESM + TypeScript 严格模式；注释用中文写**为什么**；不得引入除第 4 条以外的第三方依赖。
11. 任何"我顺手重构一下"的冲动都必须压制：本任务是**装配方式迁移**，不是业务重构。
12. 遇到无法解决的问题：**停下并在交付报告 §7.5 记录**，不要自行改变架构决策。
13. **禁止原地修改（强制）**：不允许在 `main` 分支上直接改代码。所有改动必须在新建的隔离分支上进行（见 §3.0"工作区隔离"）。
14. **另建目录时只允许两种形态**：仓库完整副本，或 `git worktree`。**禁止**在 `Src/` 内新建 `SrcNext/` 之类的"影子源码目录"再逐步替换
    —— 那会造成同一进程内存在两份模块图，正是 `Src/main.ts:976-986` 与 `electron/main.ts:527-529` 记录过的历史事故（重复初始化 → 工具重复注册 → 启动即退出）。
15. **对既有文件的修改必须"最小化 + 单独提交 + 逐条登记"**：本次只有 WS0 的 5 处 API 增补与 `Src/main.ts` 的装配替换会动到既有文件，
    它们**不得**与新建文件混在同一个提交里，以便单独 revert（见 §4 与 §7）。
16. 交付报告必须写明：**分支名 / 工作目录路径 / 提交列表（含每个提交的 hash 与一句话）**。

### 1.1 一组"踩过的坑"（本次实测，务必避免）

| 坑 | 症状 | 正确做法 |
|---|---|---|
| `FiberState` 是 **`const enum`** | `import { FiberState } from '@deepseek-ai/cordis'` 运行时报 `does not provide an export named 'FiberState'` | 只能 `import type { FiberState }`，数值比较用 `const ACTIVE = 2 as FiberState`（PENDING=0/LOADING=1/ACTIVE=2/FAILED=3/DISPOSED=4/UNLOADING=5） |
| **父插件 `inject` 子插件提供的服务** | 父 fiber 永远 `PENDING`，`apply` 不执行 → 整棵树静默死锁 | 被 `inject` 的提供者必须是**祖先或兄弟**，且**不得由消费者自己挂载** |
| 以为"子插件的服务父看不见" | 误判后做出错误的层树设计 | 实测**父、子、兄弟全部互相可见**（服务命名空间是全应用扁平）；树只决定生命周期，不决定可见性 |
| 用 `runtime.fibers.filter(...)` 做自检 | `TypeError: fibers.filter is not a function` | `runtime.fibers` 是 `DisposableList`（可迭代，非数组）→ 用 `[...runtime.fibers]` |
| 调 `ctx.stop()` / `root.stop()` | `TypeError: root.stop is not a function`（4.0.4 无此 API） | 自己持有顶层 fiber 列表，`dispose()` 时**逆序** `await fiber.dispose()` |
| 同名服务重复注册 | 第二个 fiber 变 `FAILED`（不是静默覆盖） | 这是**期望行为**；但必须在启动自检里把 FAILED 报出来，否则表现为"某个服务莫名不存在" |
| 在 `Service` 构造函数里做 I/O | 构造期副作用、报错难以定位 | 构造函数只 `super(ctx, name)`；初始化 I/O 放 `async [Service.init]()`（已实测：`constructor → Service.init` 顺序保证） |
| 把 `configureToolServicePorts` 的端口做成 `inject` | Tools 层等上层实现 → 整棵树死锁 | 端口是**上层实现注入下层**，必须由**后期接线插件**（WS4-8）调用 setter，**不得**声明 `inject` |
| 忘记 `npm run build:server` | Electron 里跑的还是旧代码 | `Src/**` 改动后必须重建（`npm run build:server`），否则冒烟结论无效 |

---

## 2. 背景（已定结论，不要重做）

### 2.1 已实测的 cordis 行为（`@deepseek-ai/cordis@4.0.4`，Node 22 / 仓库 `tsx` / 仓库 `esbuild`）

| 事实 | 实测结论 |
|---|---|
| 包形态 | ESM-only，`"type":"module"`，MIT，依赖 `@deepseek-ai/cosmokit` + `@standard-schema/spec`（共 5 个包） |
| 与仓库 tsconfig 兼容 | 用本仓库完全相同的严格选项（`strict` / `noUncheckedIndexedAccess` / `isolatedModules` / `noUnusedLocals`）编译通过，`tsc --noEmit` exit 0 |
| 与 esbuild 单文件打包兼容 | `--bundle --platform=node --target=node20 --format=esm` 打包成功（约 93 KB），运行正常，**无运行期磁盘模块依赖** |
| 依赖驱动加载 | `inject` 未满足 → `PENDING`；提供者上线 → 自动 `ACTIVE`；提供者卸载 → 消费者自动回退 `PENDING` |
| 加载/卸载顺序 | 祖先先 `apply`、后代后 `apply`；卸载父 → 递归卸载子（逆序回卷） |
| 服务可见性 | **全应用扁平**：父能看到子提供的服务，兄弟互相可见 |
| `isolate` | 子树内可注册同名服务且不影响外层（外层 `outer`、子树 `inner`） |
| 重复注册 | 第二个 fiber `FAILED`，原实例保留（**不静默覆盖**） |
| 自检 API | `ctx.registry.values()` → `Plugin.Runtime{ name, callback, fibers, Config }`，`runtime.fibers` 可迭代 |
| 卸载 API | `await fiber.dispose()`；无 `ctx.stop()` |

### 2.2 已定的架构决策（**不得更改**）

1. **方向**：提供者在祖先/兄弟，消费者在后代。层树顺序固定为
   `infra → platform → agent-core → {kernel, governance} → interface`。
2. **平铺命名空间**：层树**不承担**分层强制；分层仍由 `.eslintrc.json` 的 `import/no-restricted-paths` 承担。
3. **框架隔离**：`@deepseek-ai/cordis` 只允许出现在 `Src/Composition/**` 与测试里；业务层保持与框架零耦合。
4. **服务外壳极薄**：服务方法体只做**转发**到现有模块函数，不改行为、不改状态归属。
5. **端口后接线**：`toolServicePorts` 等"上层实现注入下层"的接线，统一放"后期接线插件"，**不用 `inject`**。
6. **启动自检 fail-fast**：任何 `PENDING` / `FAILED` fiber 都必须让启动失败并打出具体名字。

---

## 3. 范围

### 3.0 工作区隔离（强制，开工第一步）

**禁止在 `main` 分支上原地修改代码。** 必须在隔离工作区里改，改完验证通过后再决定是否合并。

| 方案 | 命令 | 适用场景 | 注意 |
|---|---|---|---|
| **A. 隔离分支（推荐）** | `git switch -c feat/cordis-composition` | 单个工作目录、最省事；`main` 全程保持可发布 | 与既有改动共用同一个工作目录，隔离靠分支 |
| **B. `git worktree`（= 另建目录 + 另开分支）** | `git worktree add ../CivitasAI-cordis -b feat/cordis-composition` | 需要**同时保留原目录**做对照（旧实现 vs 新容器） | worktree 只能从**已提交**状态切出——本仓库已于 `763b113` 提交完整快照，现在可直接使用；切出后需在新目录**单独 `npm install`**（worktree 不共享 `node_modules`） |
| **C. 目录完整副本** | `robocopy . ..\CivitasAI-cordis /E /XD .git node_modules .tmp dist release Logs Data`，再在新目录 `npm install` | 不想让改造分支出现在原仓库的 `git branch` 列表里 | 副本与原仓库脱钩，回退=删目录；**不要**在副本里再开分支混用 |

**禁止方案 D（重要）**：在 `Src/` 内新建 `SrcNext/` / `Src-cordis/` 之类的"影子源码目录"再逐步替换。
那会造成**两套模块图 / 两个入口**，正是 `Src/main.ts:976-986` 与 `electron/main.ts:527-529` 记录过的历史事故
（重复初始化 → 工具重复注册 → "所有工具注册失败" → Electron 启动即退出）。

**开工自检**（必须执行并把输出贴进交付报告）：

```bash
git branch --show-current      # 必须不是 main / master
git worktree list              # 若走方案 B，确认新目录已挂上
git status --porcelain         # 必须为空（干净起点）
git log -1 --format='%h %s'    # 记录基线提交（快照提交为 763b113 或其后续）
```

**隔离工作区内的提交纪律**：

1. **新增文件**（`Src/Composition/**`、`Tests/Composition/**`、文档）与**既有文件修改**（§4.2）**分开提交**；
2. 每个 WS 一个提交，例如
   `chore(composition): WS0 补齐注册撤销 API`、
   `feat(composition): WS1 容器骨架（上线不接管）`、
   `feat(composition): WS2/WS3 服务外壳`、
   `refactor(composition): WS4-1 迁移 infra 层到插件树` …；
3. `Src/main.ts` 的装配替换按层分多次提交（§5 WS4-5），**禁止**压成一个巨型提交；
4. 改造期间 `main` 分支上**不得出现任何 cordis 相关提交**；合并时机由人工决定，本任务只负责在隔离区内做完并给出证据。

### 3.1 本次交付（P1）

| WS | 内容 | 预估人日 |
|---|---|---|
| WS0 | 前置改造：4 处注册撤销 API（Hook/Tool/Route/Middleware）+ 配置监听撤销 + barrel 导出 + 两道门禁修实 | 2–3 |
| WS1 | 容器骨架"上线不接管"：依赖引入、`Src/Composition/**`、自检、`main.ts` 接入 | 2–3 |
| WS2 | 服务外壳第一批（infra 层 9 个） | 5–8 |
| WS3 | 服务外壳第二批（platform / agent-core 层 10 个） | 5–8 |
| WS4 | 层插件树迁移（kernel / governance / interface / 接线插件），替换 `main.ts` 手工装配 | 8–12 |
| WS5 | 验证与收口：自检接入、组合测试、打包/Electron 冒烟、文档与 CHANGELOG | 3–5 |
| | **合计** | **25–40** |

### 3.2 明确不在本次范围（**禁止实施**）

- ❌ P2 状态所有权迁移（把 110/287 个模块的模块级 `let`/`Map` 改为服务实例）。
- ❌ P2 配置 Schema 化（`schemastery`、`getConfigValueOr` → `Schema<Config>`）。
- ❌ P3 `cordis.yml` 声明式插件树、`plugin-loader`、HMR（被单文件 ESM + asar 阻断，需先改构建）。
- ❌ `Src/Infra/AccountScope` 的租户 `isolate` 改造。
- ❌ `Server/`、`Client/`、`electron/` 的任何改造（本任务完全不影响它们）。

---

## 4. 交付物清单（文件级）

> **⚠️ 全部改动都在 §3.0 的隔离工作区（新分支或新目录）内进行；`main` 分支不得出现下述任何改动。**

### 4.1 新增文件（新目录，与既有文件零冲突）

| 路径 | 说明 |
|---|---|
| `Src/Composition/container.ts` | `createContainer` / `mount` / `dispose` / 挂载计划 |
| `Src/Composition/selftest.ts` | `scanFibers` / `assertAllActive`（启动自检） |
| `Src/Composition/plugins/*.ts` | 每层/每服务一个插件（详见 §5 WS2–WS4） |
| `Src/Composition/index.ts` | 统一导出 |
| `Tests/Composition/container.spec.ts` | 容器语义与自检（§6.3） |
| `Tests/Composition/layerTree.spec.ts` | 层树不变量（§6.3） |
| `Tests/Services/hookRegistryUnregister.spec.ts` 等 5 个 | WS0 的 5 个新 API（§6.3） |
| `Docs/Dev/Cordis容器化与分层插件树-实现记录.md` | qoder 的交付记录（§7 内容） |

### 4.2 既有文件修改（**必须最小化、单独提交、逐条登记**）

| 路径 | 动作 | 说明 | 归属提交 |
|---|---|---|---|
| `Src/Services/Hook/hookRegistry.ts` | 改 | 新增 `unregisterHookHandler`（WS0-1） | WS0 |
| `Src/Services/Hook/index.ts` | 改 | 导出上述新函数 | WS0 |
| `Src/Tools/Registry/toolRegistry.ts` | 改 | 新增 `unregisterTool`（WS0-2） | WS0 |
| `Src/Tools/index.ts` | 改 | 导出上述新函数 | WS0 |
| `Src/Interface/RestApi/router.ts` | 改 | 新增 `unregisterRoute`（WS0-3） | WS0 |
| `Src/Interface/WebServer/routes.ts` | 改 | 追加一行 re-export | WS0 |
| `Src/Core/Middleware/index.ts` | 改 | 补导出 `unregisterMiddleware`（WS0-4） | WS0 |
| `Src/Infra/Watcher/configWatcher.ts` | 改 | 新增 `offConfigChange`（WS0-8） | WS0 |
| `Src/Infra/Watcher/index.ts` | 改 | 导出上述新函数 | WS0 |
| `package.json` | 改 | 加依赖 `"@deepseek-ai/cordis": "4.0.4"`（**精确版本，不加 `^`**）、加脚本 `"verify:tree"`、修实 `layer-check`（WS0-5） | WS0 / WS1 |
| `package-lock.json` | 改 | `npm install` 生成 | WS1 |
| `.husky/pre-commit` | 改 | 去掉 `\|\| true`（WS0-6） | WS0 |
| `CHANGELOG.md` | 追加 | 一条 `feat(composition):` 记录 | WS5 |
| `Src/main.ts` | 改 | **本次唯一的功能性既有文件改动**：装配体逐步替换为"建容器 + 挂树 + 自检"；`stopServer()` 改为 `container.dispose()` | WS4（按层分多次提交） |

`.eslintrc.json`、`Scripts/build.cjs`、`electron/**`、`Client/**`、`Server/**`：**不改**。

---

## 5. 任务清单

### WS0 —— 前置改造（先补齐"可逆性"，再谈容器）

> 为什么先做：cordis 的 `ctx.effect` 语义是**可逆 dispose**；现有 Hook / Tool / Route 只有"全清"，没有单条注销，
> 不补这三处，容器化的"卸载"就是假卸载（详见评估报告 §5 B2）。

#### WS0-1 `unregisterHookHandler(name, event)`

`Src/Services/Hook/hookRegistry.ts`（现有 `handlers: HookHandler[]` 在 `:62`，`clearHookHandlers` 在 `:144`）：

```ts
/**
 * 注销一条 Hook handler（按 name + event 唯一确定）。
 *
 * 为什么需要：容器化后插件卸载必须能撤销自己的注册；此前只有 clearHookHandlers() 全清，
 * 卸载一个插件会连带清掉其它插件的 handler。
 * @returns true=找到并删除；false=不存在（调用方自行决定是否告警）
 */
export function unregisterHookHandler(name: string, event: HookEvent): boolean {
  const idx = handlers.findIndex((h) => h.name === name && h.event === event);
  if (idx < 0) return false;
  handlers.splice(idx, 1);
  return true;
}
```

`Src/Services/Hook/index.ts` 追加导出该函数。

#### WS0-2 `unregisterTool(name)`

`Src/Tools/Registry/toolRegistry.ts`（`registry` Map 在 `:18`，`clearRegistry` 在 `:171`）：

```ts
/**
 * 注销一个工具。容器化后由插件卸载调用；返回 false 表示该名字未被注册。
 * 注意：注册时 Map 的插入序决定 `getAllToolSpecs()` 顺序，删除会改变顺序——
 * 若调用方依赖顺序，请在注销后重新注册而非依赖残序。
 */
export function unregisterTool(name: string): boolean {
  return registry.delete(name);
}
```

`Src/Tools/index.ts` 追加导出。

#### WS0-3 `unregisterRoute(method, path)`

`Src/Interface/RestApi/router.ts`（`routes` 数组在 `:56`，`clearRoutes` 在 `:108`，`registerRoute` 在 `:58`）：

```ts
/** 注销一条路由（method + path 精确匹配）。容器化后由插件卸载调用。 */
export function unregisterRoute(method: HttpMethod, path: string): boolean {
  const idx = routes.findIndex((r) => r.method === method && r.path === path);
  if (idx < 0) return false;
  routes.splice(idx, 1);
  return true;
}
```

> ⚠️ 先读 `router.ts` 确认 `RouteEntry` 的字段名（可能是 `method`/`path`/`handler`/`regex`），按**实际字段**写匹配，
> 不要照抄字段名。`Src/Interface/WebServer/routes.ts` **只导出了 `registerAllRoutes`**，因此在该文件追加一行
> `export { unregisterRoute } from '../RestApi/router.js';`（保持对外入口统一）。

#### WS0-4 导出 `unregisterMiddleware`

`Src/Core/Middleware/index.ts` 的 `export { ... } from './middlewareRegistry.js'` 列表中补上 `unregisterMiddleware`（函数已存在）。

#### WS0-5 修实 `layer-check` 脚本

`package.json` 当前为：
```json
"layer-check": "eslint Src/ --ext .ts --rule '{\"import/no-restricted-paths\": [\"error\", {\"zones\": []}]}'"
```
空 `zones` 覆盖了配置 → **永远通过**。改为：
```json
"layer-check": "eslint Src/ --ext .ts"
```
（即与 `lint` 同规则但语义明确；`lint` 已包含 zones。）

#### WS0-6 修实 pre-commit

`.husky/pre-commit` 中 eslint 一行结尾的 `2>/dev/null || true` 改为**失败即中断**（去掉 `|| true`）。
保留 `tsc --noEmit` 两条。若担心误伤，可改 `|| true` 为 `|| exit 1`。

#### WS0-7（可选）`engines.node`

`package.json` 的 `"node": ">=20.0.0"` 与 `Src/Infra/Fs/pathResolver.ts:149` 使用 `import.meta.dirname`（需 ≥20.11）不一致。
本次可改为 `">=20.11.0"` 并在 CHANGELOG 记一行；**不改也可**，但要在这里说明取舍。

#### WS0-8（可选但推荐）`offConfigChange(handler)`

`Src/Infra/Watcher/configWatcher.ts` 的 `onConfigChange(handler)` **无返回值**（`:49-51` 只做 `changeListeners.push`），
因此插件卸载时无法精确撤销自己的订阅。追加：

```ts
/**
 * 取消一条配置监听。
 *
 * 为什么需要：`onConfigChange` 无返回值，容器卸载 watcher 插件时只能靠 `resetConfigWatcher()`
 * 全清（会连带清掉别的监听）。补上 off 之后，插件的 effect disposer 才能精确回卷。
 * @returns true=找到并移除；false=该 handler 未注册
 */
export function offConfigChange(handler: ConfigChangeHandler): boolean {
  const idx = changeListeners.indexOf(handler);
  if (idx < 0) return false;
  changeListeners.splice(idx, 1);
  return true;
}
```

并在 `Src/Infra/Watcher/index.ts` 追加导出。

**WS0 验收**：WS0-1~4 与 WS0-8 共 **5 个新 API** 各有单测；`npm run lint` / `npm run layer-check` 均 0 error；
`npx vitest run` 通过数不低于基线。

---

### WS1 —— 容器骨架："上线但不接管"（风险为零的一步）

> 本步**不改任何业务行为**：容器建起来、挂一个空插件、跑自检，业务仍走原有装配。目的是先把打包链路、
> Electron 链路、自检链路验证通过，再动装配。

#### WS1-1 新建 `Src/Composition/container.ts`

```ts
/**
 * Cordis 容器骨架。
 *
 * 设计约束（与评估报告 §10 一致）：
 * 1) 服务命名空间是全应用扁平的——层树只决定"谁在谁的 apply 里被挂载"（= 生命周期归属与加载/卸载顺序），
 *    不承担依赖方向强制；依赖方向由 inject 表达，提供者必须是祖先或兄弟。
 * 2) 框架只出现在本目录：业务层不得 import cordis（见 §6.4 反例检查）。
 * 3) 卸载必须逆序：cordis 4.0.4 没有 ctx.stop()/root.stop()，只能自己持有顶层 fiber 逐个 dispose。
 */
import { Context } from '@deepseek-ai/cordis';
import type { Fiber } from '@deepseek-ai/cordis';

/** 一个"挂载计划"：在给定上下文挂载若干插件，返回本次挂载的顶层 fiber */
export type MountPlan = (ctx: Context) => Fiber[];

export interface Container {
  readonly ctx: Context;
  /** 挂载一个插件（等价 ctx.plugin），并登记其 fiber 以便卸载 */
  mount(plugin: unknown, config?: unknown): Fiber;
  /** 逆序卸载全部顶层 fiber；可重复调用（第二次为空操作） */
  dispose(): Promise<void>;
}

export function createContainer(plans: MountPlan[] = []): Container {
  const ctx = new Context();
  const mounted: Fiber[] = [];
  let disposed = false;

  const mount = (plugin: unknown, config?: unknown): Fiber => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fiber = (ctx as any).plugin(plugin, config) as Fiber;
    mounted.push(fiber);
    return fiber;
  };

  return {
    ctx,
    mount,
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      for (const fiber of [...mounted].reverse()) {
        await fiber.dispose();
      }
      mounted.length = 0;
    },
  };
}
```

> 说明：`ctx.plugin(plugin, config?)` 是 4.0.4 的实际签名（实测），第二参为配置对象。
> 若 TS 报 `plugin` 类型不匹配，用 `Plugin` 类型（`import type { Plugin } from '@deepseek-ai/cordis'`）而不是 `any`。

#### WS1-2 新建 `Src/Composition/selftest.ts`

```ts
/**
 * 容器启动自检：把"服务缺失/插件加载失败"从"静默什么都不发生"变成"启动期 fail-fast"。
 *
 * 为什么必须做：cordis 的 PENDING 是合法状态——inject 未满足时插件不加载、不报错、甚至可能让进程静默退出。
 * 本仓库原有的"环境自检"（Src/main.ts:613-639）覆盖不到这种情况。
 */
import type { Context, FiberState } from '@deepseek-ai/cordis';

const ACTIVE = 2 as FiberState;
/** FiberState 是 const enum（无运行时导出），故本地维护名字表 */
const STATE_NAMES = ['PENDING', 'LOADING', 'ACTIVE', 'FAILED', 'DISPOSED', 'UNLOADING'] as const;

export interface FiberProblem { plugin: string; state: string }
export interface FiberReport { ok: boolean; total: number; problems: FiberProblem[] }

export function scanFibers(ctx: Context): FiberReport {
  const problems: FiberProblem[] = [];
  let total = 0;
  for (const runtime of ctx.registry.values()) {
    for (const fiber of runtime.fibers) {
      total += 1;
      const state = (fiber as { state: FiberState }).state;
      if (state !== ACTIVE) {
        problems.push({
          plugin: runtime.name ?? '(anonymous)',
          state: STATE_NAMES[state as unknown as number] ?? 'UNKNOWN',
        });
      }
    }
  }
  return { ok: problems.length === 0, total, problems };
}

/** 启动期断言：任何非 ACTIVE 的 fiber 都视为启动失败，并在错误里点名 */
export function assertAllActive(ctx: Context, stage: string): FiberReport {
  const report = scanFibers(ctx);
  if (!report.ok) {
    const detail = report.problems.map((p) => `${p.plugin}=${p.state}`).join(', ');
    throw new Error(`[container] ${stage} 存在未就绪插件：${detail}`);
  }
  return report;
}
```

#### WS1-3 `Src/main.ts` 接入（**不接管业务**）

在 `startServer()` 的 ⓪ 之后（即 `.env` 加载完成后）插入：

```ts
  // 容器骨架（WS1：先"上线不接管"——只验证建容器/自检/卸载链路，业务仍走原装配）
  const container = createContainer();
  container.mount({ name: 'noop-bootstrap', apply() { /* 占位，不做事 */ } });
  const bootReport = assertAllActive(container.ctx, 'WS1 骨架自检');
  logger.info('容器骨架就绪', { source: 'main/container', fibers: bootReport.total });
```

把 `container` 提到 `startServer()` 外层模块作用域，供 `stopServer()` 使用：

```ts
export async function stopServer(): Promise<void> {
  await stopHttpServer();
  stopIpcBridge();
  await container?.dispose();     // 逆序卸载（WS1 阶段只有占位插件）
}
```

**WS1 验收**：`npm run build:server` 成功；`npm start` 能起并打印"容器骨架就绪 fibers=1"；`npx vitest run` 全绿；
`node Scripts/verifyPackage.cjs` 通过。

---

### WS2 —— 服务外壳第一批（infra 层，9 个）

**统一骨架**（每个服务一个文件，`Src/Composition/plugins/<name>.ts`）：

```ts
/**
 * <服务名>：把现有 <模块> 的模块级 API 暴露为容器服务。
 *
 * 本外壳是"极薄转发"：方法体只调用现有函数，不改变任何行为与状态归属（状态仍在原模块里）。
 * 这样既有 1636 个用例（直接调用模块函数）不受影响，容器只是多了一条可注入的查找路径。
 */
import { Service } from '@deepseek-ai/cordis';
import type { Context } from '@deepseek-ai/cordis';
import { initXxx, doYyy } from '../../Infra/.../xxx.js';

export class XxxService extends Service {
  /** 依赖：被 inject 的必须由祖先/兄弟提供，绝不能是自己挂载的插件 */
  static inject = ['config', 'logger'];

  constructor(ctx: Context) {
    super(ctx, 'xxx');            // 只注册，不做 I/O
  }

  async [Service.init](): Promise<void> {
    // 初始化 I/O 放这里（实测执行顺序：constructor → Service.init → 下一个插件）
    initXxx({ /* 来自 ctx.get('config') 的参数，按原 main.ts 片段原样搬 */ });
  }

  doYyy(...args: Parameters<typeof doYyy>): ReturnType<typeof doYyy> {
    return doYyy(...args);
  }
}

export const xxxPlugin = XxxService;   // 类本身就是插件
```

> **禁止**在外壳里新增业务逻辑、做参数校验、改变默认值。参数必须与 `Src/main.ts` 中对应片段的**原值逐字一致**。

| # | 服务名 | 文件 | 承载模块 | 对应 `main.ts` 片段 | `inject` |
|---|---|---|---|---|---|
| 1 | `config` | `plugins/config.ts` | `Infra/Config/configLoader` | ①（155-178）+ ①.0（167-174） | `[]` |
| 2 | `paths` | `plugins/paths.ts` | `Infra/Fs/pathResolver` | ①.1（180-182）+ ⑤（255-265） | `['config','logger']` |
| 3 | `logger` | `plugins/logger.ts` | `Infra/Logging/logger` | ②（184-204） | `['config']` |
| 4 | `time` | `plugins/time.ts` | `Infra/Time/timeService` | ③（206-214） | `['logger']` |
| 5 | `security` | `plugins/security.ts` | `Infra/Security/*` | ④（216-253） | `['config','logger','paths']` |
| 6 | `db` | `plugins/db.ts` | `Infra/Db/*` | ⑥（267-288） | `['config','logger','paths']` |
| 7 | `llm` | `plugins/llm.ts` | `Infra/Llm/*` | ⑪（434-484）+ ⑪.2（467-484） | `['config','logger','security']` |
| 8 | `durable` | `plugins/durable.ts` | `Infra/DurableExecution/*` | ⑦.5（369-381） | `['config','db','logger']` |
| 9 | `workspace` | `plugins/workspace.ts` | `Infra/Workspace` + `Infra/Sandbox` | ⑦（294-297）+ ⑧（383-385） | `['paths','logger']` |

**顺序敏感项（必须原样保持语义）**：

- `config` 插件里必须包含 ①.0：把 `workspace.root` 写入 `process.env.CIVITAS_WORKSPACE_ROOT` 并 `resetPathCache()`，
  **且必须发生在 `paths` 插件加载之前**——本方案由 `paths.inject=['config']` 保证（祖先先于后代）。
- `security` 里的 `configureToolSafetyGate(...)` 与 `setSafeStorageProvider(...)` 可能由 Electron 侧先行注入，
  保持原调用位置与顺序。
- `db` 插件若失败必须抛出（原 `main.ts` 为 fail-fast），不要吞异常。

**WS2 验收**：容器内单独挂 WS2 插件（用测试而非改 main.ts）→ `assertAllActive` 通过；全量测试全绿。

---

### WS3 —— 服务外壳第二批（platform / agent-core 层，10 个）

| # | 服务名 | 文件 | 承载模块 | 对应片段 | `inject` |
|---|---|---|---|---|---|
| 10 | `events` | `plugins/events.ts` | `Services/EventBus` + `Interface/EventStore` | ⑰（822-829）+ ⑰.2（827-829） | `['config','logger']` |
| 11 | `hooks` | `plugins/hooks.ts` | `Services/Hook` + `Infra/Hook` | ⑬.1（541-586） | `['logger','events']` |
| 12 | `cache` | `plugins/cache.ts` | `Services/Cache` | ⑬ 中的 `initPromptCache`/`initToolResultCache`（535-536） | `['logger','config']` |
| 13 | `sessions` | `plugins/sessions.ts` | `Services/Session` | ⑬ 中的 `initSessionManager`/`initArchiveManager`（537-538） | `['logger','db']` |
| 14 | `prompts` | `plugins/prompts.ts` | `Services/Prompts` | ⑩（395-409） | `['config','logger','paths']` |
| 15 | `watcher` | `plugins/watcher.ts` | `Infra/Watcher` | ⑨（387-393）+ ⑩.1（411-432） | `['config','logger','paths','prompts']` |
| 16 | `memory` | `plugins/memory.ts` | `Services/SharedMemory` + `Services/Retrieval` | ⑦.2（299-307）+ ⑦.4（315-329）+ ⑪.1（486-492） | `['db','logger','events']` |
| 17 | `economy` | `plugins/economy.ts` | `Services/TokenEconomy` | ⑯（743-789） | `['db','logger','config']` |
| 18 | `supervision` | `plugins/supervision.ts` | `Services/Supervision` + `Interface/WebServer/apiRateLimiter` | ⑬.3（592-609） | `['config','logger']` |
| 19 | `tools` | `plugins/tools.ts` | `Tools/**` | ⑫（494-502） | `['logger','security']` |

> ⚠️ **`economy` 不得 inject `agents`**：`agent-core` 的 `agentFactory` 需要钱包服务，方向必须是
> **`platform(economy) ← agent-core(agents)`**（下层不 inject 上层，上层 inject 下层）。
> 若出现任何"双向 inject"，一律按此方向改写，否则会互等死锁（评估报告 §10.2 Q3 实测）。

**WS3 验收**：容器内挂 WS2+WS3 全部插件 → `assertAllActive` 通过；全量测试全绿。

---

### WS4 —— 层插件树迁移（替换 `main.ts` 手工装配）

#### WS4-1 层树结构（固定，不得调整方向）

```
level 0  容器根（main.ts）        : .env 加载 / createContainer / 启动自检 / 优雅关闭编排
level 1  infraPlugin             : config → paths → logger → time → security → db → llm → durable → workspace
level 2  platformPlugin          : events → hooks → cache → sessions → prompts → watcher → memory → economy → supervision → tools
level 3  agentCorePlugin         : agents（Core/AgentRuntime）
level 4  kernelPlugin            : loopControl / middleware / reviewer / recruitment
level 4  governancePlugin        : governance / a2a
level 5  wiringPlugin            : 后期接线（toolServicePorts / configureReviewer / …），inject 所有相关服务
level 5  interfacePlugin         : routes + HTTP + IPC
```

**实现方式**：每个 level 一个"组插件"（普通对象插件），在 `apply` 里按顺序 `ctx.plugin(...)` 挂载子插件。
组插件由容器根挂载（`container.mount(infraPlugin)` …），**不得由需要它的插件自己挂载**。

```ts
// Src/Composition/plugins/platform.ts
import type { Context } from '@deepseek-ai/cordis';
import { eventsPlugin } from './events.js';
// ...其余 import

/** platform 组：横向平台能力。祖先已由 infraPlugin 提供，故这里可以安全 inject。 */
export const platformPlugin = {
  name: 'platform',
  apply(ctx: Context) {
    for (const p of [eventsPlugin, hooksPlugin, cachePlugin, sessionsPlugin, promptsPlugin,
                     watcherPlugin, memoryPlugin, economyPlugin, supervisionPlugin, toolsPlugin]) {
      ctx.plugin(p);
    }
  },
};
```

#### WS4-2 `main.ts` 片段 → 插件映射表（**逐条照搬，不要改写逻辑**）

| 原 startup 步骤 | 行范围 | 迁往 |
|---|---|---|
| ⓪ `.env` 加载 | 149-153 | **保留在 main.ts**（必须早于容器创建） |
| ① 配置加载 + ①.0 workspace root | 155-178 | `config` 插件 |
| ①.1 目录契约自检 | 180-182 | `paths` 插件 |
| ② 日志系统 | 184-204 | `logger` 插件 |
| ③ 时间服务 | 206-214 | `time` 插件 |
| ④ 安全基础（trust/whitelist/pathGuard/keyStore/toolSafetyGate） | 216-253 | `security` 插件 |
| ⑤ 文件系统 | 255-265 | `paths` 插件 |
| ⑥ 数据库 + 迁移 | 267-288 | `db` 插件 |
| ⑦.1 审批残留清理 | 290-292 | `kernelPlugin` 的 `loopControl` 插件 |
| ⑦ 工作区 | 294-297 | `workspace` 插件 |
| ⑦.2 长时记忆回灌 | 299-307 | `memory` 插件 |
| ⑦.3 Agent 注册表回灌 | 309-313 | `agents` 插件 |
| ⑦.4 / ⑦.4b 治理台账 + 共享工作区回灌 | 315-329 | 治理台账 → `governance`；共享工作区 → `memory` |
| ⑦.4c / ⑦.4d 仲裁池 + 自动扩缩/空闲回收 | 331-367 | `governance` 插件（周期任务必须用 `ctx.effect` 注册停止函数） |
| ⑦.5 持久执行底座 | 369-381 | `durable` 插件 |
| ⑧ 沙箱 | 383-385 | `workspace` 插件 |
| ⑨ 配置热加载 | 387-393 | `watcher` 插件 |
| ⑩ 提示词/Skills 资产 | 395-409 | `prompts` 插件 |
| ⑩.1 热重载接线 | 411-432 | `watcher` 插件（`onConfigChange` 注册 → 用 `ctx.effect` 回卷） |
| ⑪ LLM 通道 + ⑪.2 密钥预检 | 434-484 | `llm` 插件 |
| ⑪.1 记忆嵌入配置 | 486-492 | `memory` 插件 |
| ⑫ 工具注册 | 494-502 | `tools` 插件 |
| ⑫.6 工具服务端口注入 | 504-532 | **`wiringPlugin`**（禁止用 inject） |
| ⑬ 运行时内核初始化（4 个 init） | 534-543 | `cache` / `sessions` / `hooks` 分工（见 WS2/WS3 表） |
| ⑬.1 内置 Hook 注册（3 个 handler） | 544-586 | `hooks` 插件；注册时必须拿 disposer → 见 WS4-3 |
| ⑬.2 中间件注册 | 587-590 | `kernelPlugin` 的 `middleware` 插件 |
| ⑬.3 限流器 | 592-609 | `supervision` 插件 |
| ⑭ 环境自检（4 项） | 611-639 | **保留在 main.ts**，与容器自检合并（WS5-1） |
| ⑮ Loop 控制 + ⑮.1 评审 + ⑮.2 上下文压缩 + ⑮.3 SOP | 641-742 | `loopControl`（⑮/⑮.2/⑮.3）+ `wiringPlugin`（⑮.1 的 `configureReviewer`） |
| ⑯ Token 经济 + ⑯.1 定价 + ⑯.2 税率周期 | 743-789 | `economy` 插件（周期任务用 `ctx.effect`） |
| ⑲ 治理执法域（监管/审计/仲裁接线/A2A） | 791-820 | `governance` + `a2a` 插件 |
| ⑰ 事件总线 + ⑰.2 持久化 | 822-829 | `events` 插件 |
| ⑱ 路由 + HTTP + IPC | 831-850 | `interface` 插件 |
| `stopServer()` + SIGINT 9 步关闭 | 855-968 | `container.dispose()` + **main.ts 保留 4 项手写收尾**（见 WS4-4） |

#### WS4-3 注册必须"可回卷"（所有 `register*/on*/start*` 调用）

任何在插件里做的注册/订阅/定时器，都必须用 `ctx.effect` 包裹并返回停止函数：

```ts
// 示例：watcher 插件
// ⚠️ 实测：onConfigChange(handler) 返回 void（`Src/Infra/Watcher/configWatcher.ts:49-51`），
//    因此必须新增 offConfigChange（WS0-8）才能真正做到"只撤销自己的订阅"；
//    若不做 WS0-8，退化用 resetConfigWatcher()（它会清空全部监听并停表——当前只有一个插件注册监听，可接受）。
ctx.effect(() => {
  const handler = (filePath: string, changeType: 'modified' | 'deleted' | 'added') => {
    /* 原 main.ts:413-430 的逻辑原样搬进来 */
  };
  onConfigChange(handler);
  startWatching();
  return () => {
    offConfigChange(handler);   // WS0-8
    stopWatching();             // 此前全仓零调用方，本次必须接上
  };
});
```

**硬要求**：`startAuditCycle` / `startIdleRecycling` / `startAutoScaling` / `startTaxAdjustment` /
`startAiEventPersistence` / `startWatching` / `startHttpServer` / `startIpcBridge` 全部必须出现在某个插件的 disposer 中。
（这些正是评估报告指出的"启动了但从不停止"清单。）

#### WS4-4 `main.ts` 保留项（**不得迁走**）

1. ⓪ `.env` 加载（早于一切）。
2. 容器创建、挂树、**启动自检**（§WS5-1）。
3. `process.on('SIGINT')` 的**编排骨架**：① 停止接收新输入 → ② 中断活跃流 → ③ 等待在途流 400ms →
   `container.dispose()` → ④ 生成 trace index → ⑤ 清理沙箱 → ⑥ flush 日志 → ⑦ 退出码。
   **顺序不可变**（trace index 与日志 flush 必须在容器卸载之后、进程退出之前）。
4. `stopServer()` 对外签名不变（Electron 依赖它）。

> 注意：原 9 步关闭里的"关闭数据库"由 `db` 插件的 disposer 承担，但要保证它在**消费者之后**执行——
> 由层树保证（`db` 在 level 1，`interface` 在 level 5，逆序卸载即 interface 先于 db）。

#### WS4-5 每步迁移的节奏（强制）

按 `infra → platform → agentCore → kernel → governance → wiring → interface` **逐层**迁移；
**每迁一层**：
1. 跑 `npm run typecheck` + `npm run lint` + `npx vitest run`；
2. `npm run build:server` 并 `npm start` 冒烟（看到 `[container] 启动自检 OK ...`）；
3. 提交一次（commit message 形如 `refactor(composition): 迁移 infra 层到插件树`）。

**WS4 验收**：`Src/main.ts` 中不再出现 `registerMiddleware(` / `registerHookHandler(` / `registerBuiltinTools(` /
`registerAllRoutes(` / `initEventBus(` / `startAuditCycle(` 等装配调用（见 §6.4 反例检查）。

---

### WS5 —— 验证与收口

#### WS5-1 启动自检接入（fail-fast）

`Src/main.ts` 中，容器挂树之后：

```ts
  // 容器自检：任何 PENDING/FAILED 都必须让启动失败（此前这类问题表现为"什么都没发生"）
  const report = assertAllActive(container.ctx, '启动自检');
  logger.info('容器自检 OK', { source: 'main/container', fibers: report.total });
  // 与原有 ⑭ 环境自检合并：四项检查（DB/Provider/工具/提示词）保留，改为从容器取服务
  const dbSvc = container.ctx.get('db');
  if (!dbSvc) throw new Error('环境自检失败：db 服务缺失');
  // ...其余三项同理
```

#### WS5-2 `npm run verify:tree`

在 `package.json` 增加：
```json
"verify:tree": "vitest run Tests/Composition"
```
（不要新增第三方脚本或构建步骤。）

#### WS5-3 文档与 CHANGELOG

- `CHANGELOG.md` 追加一条 `feat(composition): 引入 cordis 容器与分层插件树（P1）`，列出 WS0–WS5 的净变化与门禁数字。
- 新建 `Docs/Dev/Cordis容器化与分层插件树-实现记录.md`，内容按 §7 的交付报告格式。
- **不要**改动 `Docs/Agent/**`、`Docs/Server/**`、`Docs/Client/**` 的既有结构；
  如需说明，只在 `Docs/Dev/` 下追加。

---

## 6. 验证办法

### 6.1 第一步：记录基线（**改动前必须做，输出贴进交付报告**）

```bash
npx vitest run                      # 记录：测试文件数 / 通过数 / 失败数
npm run typecheck                   # 记录：错误数（应为 0）
npm run lint                        # 记录：错误数 / 警告数（当前基线 0 error / 307 warnings）
npm run build:server                # 记录：dist/main/Src/main.js 的字节数（当前约 735 KB）
node Scripts/verifyPackage.cjs      # 记录：输出结论
```

> ⚠️ **基线必须自己实测记录**，不要抄本文档里的数字（那些是 2026-10-08 的快照，可能已变化）。
> 后续所有"不低于基线"的判定都以你实测的数字为准。

### 6.2 统一验收命令（每个 WS 结束都要跑，全部必须通过）

```bash
# ⓪ 隔离校验（必须最先跑：确认不在 main 上改、且基线提交可追溯）
git branch --show-current               # 必须不是 main / master
git log -1 --format='%h %s'             # 记录基线（快照提交 763b113 或其后续）
git status --porcelain                  # 提交后必须为空

# ① 类型门禁（四套，全部 0 错误）
npx tsc --noEmit                        # 根
npm run typecheck:electron              # Electron 主进程/preload
cd Client && npx tsc --noEmit && cd ..  # 客户端（本任务不应影响它，用于确认没误伤）
cd Server && npx tsc --noEmit && cd ..  # 服务端（同上）

# ② 分层门禁（必须真正生效 —— WS0-5 之后）
npm run lint
npm run layer-check

# ③ 测试（通过数不得低于 §6.1 基线）
npx vitest run
npx vitest run Tests/Composition        # WS1 之后可用

# ④ 构建与产物校验
npm run build:server
node Scripts/verifyPackage.cjs

# ⑤ 隔离边界（必须为空输出）
git diff --name-only main...HEAD -- .eslintrc.json Scripts/build.cjs electron Client Server
```

### 6.3 新增自动化验证（**必须新建，逐条覆盖**）

#### `Tests/Composition/container.spec.ts`（容器语义，≥9 用例）

| # | 用例 | 断言 |
|---|---|---|
| 1 | 空容器自检 | `scanFibers(ctx).ok === true`，`total === 0` |
| 2 | 依赖驱动加载 | 挂载 `{inject:['a']}` 与提供 `a` 的服务 → 前者最终 `ACTIVE` |
| 3 | 缺失依赖被点名 | 挂载 `{name:'x', inject:['missing'], apply(){}}` → `assertAllActive` **抛错**，错误信息含 `x=PENDING` |
| 4 | 逆序卸载 | `dispose()` 后 `ctx.get('a') === undefined`，且卸载函数调用顺序为**注册逆序**（用数组记录） |
| 5 | 卸载幂等 | 连续两次 `dispose()` 不抛错 |
| 6 | 重复注册被拒 | 同服务名注册两次 → 第二个 fiber `state === 3 (FAILED)`，原服务仍可用 |
| 7 | 注册可撤销（WS0 回归） | 容器挂载插件 A 注册一条 hook/tool/route → `dispose()` 后 `getHookHandlerCount()`/`getToolCount()`/路由表回到挂载前 |
| 8 | `Service.init` 顺序 | 记录数组为 `constructor → Service.init`（防止有人把 I/O 写回构造函数） |
| 9 | `isolate` 语义留存 | 子树内同名服务不影响外层（为 P2 多租户留回归） |

#### `Tests/Composition/layerTree.spec.ts`（层树不变量，≥5 用例）

| # | 用例 | 断言 |
|---|---|---|
| 1 | 轻量挂载全树（不含 interface，避免占端口） | `assertAllActive` 通过；`total` ≥ 25 |
| 2 | 关键服务就位 | `config/paths/logger/db/llm/tools/events/hooks/memory/economy/agents/loopControl/governance` 逐个 `ctx.get(...)` 非空 |
| 3 | **无循环 inject** | 静态遍历层树所有插件的 `inject` 声明与服务提供者映射，拓扑排序成功（有环即失败） |
| 4 | **tools 不得 inject 上层** | `toolsPlugin.inject` 中不得出现 `memory/reviewer/recruitment/loopControl/agents`（防"端口变 inject"回归） |
| 5 | 卸载全树无残留 | `dispose()` 后：`getHookHandlerCount() === 0`、`getToolCount() === 0`、`getMiddlewareCount() === 0`、`abortAllActiveStreams() === 0`、`getAllWorkspaces().length === 0`（**没有 `getRouteCount`**，路由断言改用 `unregisterRoute` 的返回值或 `clearRoutes()` 后再查匹配结果） |

#### WS0 的 5 个 API 单测

- `Tests/Services/hookRegistryUnregister.spec.ts`：注册 2 条 → 注销 1 条 → 只剩 1 条；注销不存在的返回 `false`。
- `Tests/Tools/toolRegistryUnregister.spec.ts`：注册 → 注销 → `executeTool` 返回 `TOOL_NOT_FOUND`。
- `Tests/Interface/routeUnregister.spec.ts`：注册 → 注销 → 该路由不再匹配（用现有 router 匹配函数验证，不启 HTTP）。
- `Tests/Core/middlewareUnregister.spec.ts`（或扩展现有 `Tests/Core/middlewareHookContract.spec.ts`）：barrel 能取到 `unregisterMiddleware` 且注销生效。
- `Tests/Infra/configWatcherUnregister.spec.ts`（WS0-8）：`onConfigChange` 注册两个 handler → `offConfigChange` 撤销其一 → 变更通知只到剩下那个。

### 6.4 反例检查（grep 级硬断言，**必须逐条执行并把输出贴进报告**）

```powershell
# ① 框架隔离：cordis 只允许出现在 Composition 与测试里（输出必须为空）
Get-ChildItem Src -Recurse -File -Include *.ts | Where-Object { $_.FullName -notmatch '\\Composition\\' } |
  Select-String -Pattern "@deepseek-ai/cordis"

# ② main.ts 装配调用清零（WS4 完成后，输出必须为空或只剩允许项）
Select-String -Path Src\main.ts -Pattern "registerMiddleware\(|registerHookHandler\(|registerBuiltinTools\(|registerAllRoutes\(|initEventBus\("

# ③ 禁入依赖（输出必须为空）
Select-String -Path package.json -Pattern "cordis-plugin-loader|dsh-hmr|schemastery"

# ④ 构建脚本未被动过（输出必须为空）
git diff --stat -- Scripts/build.cjs

# ⑤ Electron 隔离（输出必须为空）
Get-ChildItem Src\Composition -Recurse -File -Include *.ts | Select-String -Pattern "from 'electron'"

# ⑥ 启动即停止的定时器全部接了 disposer（人工核对：下列符号必须出现在某个 ctx.effect 的返回值里）
Select-String -Path Src\Composition -Recurse -Pattern "stopWatching|stopAuditCycle|stopAutoScaling|stopIdleRecycling|stopTaxAdjustment|stopAiEventPersistence|stopHttpServer|stopIpcBridge"
```

### 6.5 打包与 Electron 冒烟（人工，必须做）

1. `npm run build:server` → 记录 `dist/main/Src/main.js` 体积（预期比基线大 **80–150 KB**，因为内联了 cordis）。
2. `node Scripts/verifyPackage.cjs --stage=post` → 通过。
3. `npm start` → 看到 `容器自检 OK` 与原有的 `环境自检完成`，HTTP 端口可访问。
4. `npm run dev:electron` → Electron 窗口能起、能发一条消息、能收到回复；关闭窗口后进程正常退出（无挂起）。
5. 关闭时观察日志：各插件的 disposer 按逆序执行（interface → governance/kernel → agent-core → platform → infra）。

### 6.6 验收矩阵（交付报告必须逐行打勾并附证据）

| 项 | 判据 | 证据形式 |
|---|---|---|
| **隔离合规** | 当前分支不是 `main`；`main` 上无 cordis 相关提交；§6.2 ⑤ 输出为空 | `git branch --show-current` + `git log --oneline main..HEAD` + 空输出 |
| 既有用例不减少 | `npx vitest run` 通过数 ≥ 基线 | 命令 + 尾部输出 |
| 新增用例全绿 | `npx vitest run Tests/Composition` 全通过 | 命令 + 输出 |
| 四套类型门禁 | 全部 0 错误 | 四条命令输出 |
| 分层门禁生效 | `npm run layer-check` 真正检查（可用一次故意违规验证后回滚） | 命令输出 |
| 框架隔离 | §6.4 ① 输出为空 | 命令 + 空输出 |
| 装配清零 | §6.4 ② 输出为空 | 命令 + 空输出 |
| 启动自检生效 | 人为把某插件 `inject` 改错 → 启动**失败且点名** → 改回 | 两次启动日志 |
| 卸载完整 | `layerTree.spec.ts` 用例 5 通过 | 测试输出 |
| 打包不变形 | `verifyPackage.cjs --stage=post` 通过 + 体积记录 | 命令输出 |
| Electron 可用 | §6.5 第 4 步通过 | 截图/日志 |
| 关闭无挂起 | 进程退出码 0，无残留定时器告警 | 终端输出 |

---

## 7. 交付报告格式（写入 `Docs/Dev/Cordis容器化与分层插件树-实现记录.md`）

0. **隔离信息（置顶）**：采用哪种隔离方案（A 分支 / B worktree / C 副本）、**分支名**、**工作目录绝对路径**、
   基线提交 hash（`git log -1 --format='%h %s'`）、以及本次全部提交的列表（`git log --oneline <基线>..HEAD`）。
1. **改动文件清单**（路径 + 一句话改动 + 新增/修改），并**明确区分 §4.1 新增 与 §4.2 既有文件修改**。
2. **基线 vs 结果对照表**：测试通过数、typecheck 错误数、lint 错误/警告数、`dist/main/Src/main.js` 体积。
3. **每个 WS 的完成证据**：命令 + 关键输出（**不要只写"已实现"**）。
4. **验收矩阵**（§6.6）逐行打勾 + 证据。
5. **未完成/存疑项**：遇到无法解决的点**必须写下来**（含复现命令与现象），不要只在对话里说明。
6. **与评估报告的偏差**：若实施中发现评估报告的某个判断不成立，**列出并附证据**，不要静默偏离。
7. **合并建议**：给出"是否建议合并到 main / 需要人工复核的点 / 建议的合并方式（squash 或保留分步提交）"。

---

## 8. 明确**不要**做的事

- ❌ **不要在 `main` 分支上原地修改**（见 §3.0）；不要在 `Src/` 内新建 `SrcNext/` 之类的影子源码目录。
- ❌ 不要重写业务逻辑、不要"顺手"重构 `Src/Infra|Services|Core|Tools|Interface` 的内部实现。
- ❌ 不要引入 loader / `cordis.yml` / HMR / schemastery（本次不在范围）。
- ❌ 不要改 `Scripts/build.cjs`、不要改 electron-builder 配置、不要新增 external。
- ❌ 不要让业务层 import cordis（框架只活在 `Src/Composition/**`）。
- ❌ 不要用 `inject` 声明"上层实现注入下层"的端口（`toolServicePorts` 等），必须走接线插件。
- ❌ 不要把层树方向改成 `Interface → … → Infra`（实测会因 `inject` 死锁）。
- ❌ 不要删除/放宽既有测试断言；不要为了让测试过而改 `vitest.config.ts` 的 include/exclude。
- ❌ 不要一次提交多个 WS；不要把 WS4 的七层压在同一个 commit 里。
- ❌ 不要修改 `Docs/Agent/**`、`Docs/Client/**`、`Docs/Server/**` 的既有结构与章节编号。

---

## 9. 回退方案

> 前提：全部改动都在 §3.0 的隔离分支/目录里，**`main` 从未被污染**，因此回退成本极低。

| 场景 | 回退动作 |
|---|---|
| 想彻底放弃本次改造 | 方案 A：`git switch main` 后删除分支（`git branch -D feat/cordis-composition`）；方案 B：`git worktree remove ../CivitasAI-cordis --force`；方案 C：直接删除副本目录。`main` 不受任何影响 |
| 某个 WS 卡住 | `git revert` 该 WS 的提交（每个 WS 独立提交正是为此） |
| 只想回退"对既有文件的修改" | `git checkout main -- <path>`（§4.2 的清单是有限且已知的），新建的 `Src/Composition/**` 可原样保留 |
| `Src/main.ts` 装配替换出错 | `git checkout main -- Src/main.ts` 即可回到旧装配；容器骨架（新增文件）仍在，不影响启动 |
| 容器导致启动变慢/异常且短期无法定位 | 在 `main.ts` 保留一个开关常量 `const USE_CONTAINER = true`，置 `false` 时走原装配路径**一次完整版本**再移除；**不允许长期双轨**（会形成两套装配入口） |
| 打包后 Electron 白屏 | 先确认 `dist/main/Src/main.js` 生成且 `verifyPackage.cjs` 通过；本任务不应触碰 Electron 主进程，若确实相关立即 revert WS1 之后的提交 |
| cordis 版本问题 | 依赖已精确锁 `4.0.4`；如需回退到上游，改动仅限 `package.json` 一处（但需重新跑 §6.2 全套） |
| 改造中途需要同步 `main` 的新提交 | 在隔离分支上 `git merge main`（或 `git rebase main`）；**不要**把隔离分支的改动 cherry-pick 回 `main` |

---

## 附录 A：服务名总表（本次新建）

| 层 | 服务名 | 承载模块 | 备注 |
|---|---|---|---|
| infra | `config` | `Infra/Config` | 含 ①.0 workspace root 注入（必须先于 paths） |
| infra | `paths` | `Infra/Fs/pathResolver` | 含目录契约自检 |
| infra | `logger` | `Infra/Logging` | — |
| infra | `time` | `Infra/Time` | — |
| infra | `security` | `Infra/Security` | trust/whitelist/pathGuard/keyStore/toolSafetyGate |
| infra | `db` | `Infra/Db` | 迁移 fail-fast |
| infra | `llm` | `Infra/Llm` | provider 注册 + routing + 密钥预检 |
| infra | `durable` | `Infra/DurableExecution` | — |
| infra | `workspace` | `Infra/Workspace` + `Infra/Sandbox` | — |
| platform | `events` | `Services/EventBus` + `Interface/EventStore` | — |
| platform | `hooks` | `Services/Hook` + `Infra/Hook` | 3 个内置 handler |
| platform | `cache` | `Services/Cache` | — |
| platform | `sessions` | `Services/Session` | — |
| platform | `prompts` | `Services/Prompts` | — |
| platform | `watcher` | `Infra/Watcher` | 必须接上 `stopWatching` |
| platform | `memory` | `Services/SharedMemory` + `Services/Retrieval` | 两个 hydrate 回灌 |
| platform | `economy` | `Services/TokenEconomy` | 不得 inject `agents` |
| platform | `supervision` | `Services/Supervision` + `apiRateLimiter` | — |
| platform | `tools` | `Tools/**` | 提供注册表；端口走接线插件 |
| agent-core | `agents` | `Core/AgentRuntime` | 提供 registry/factory/runtime |
| kernel | `loopControl` | `Services/LoopControl` + `Core/Loop` 配置 | — |
| kernel | `middleware` | `Core/Middleware` | — |
| kernel | `reviewer` | `Services/ReviewerAgent` | — |
| kernel | `recruitment` | `Services/Recruitment` | — |
| governance | `governance` | `Services/Governance` + `Audit` + `Arbitration` + `Regulation` | 周期任务用 effect |
| governance | `a2a` | `Services/A2A` | — |
| — | （无服务） | `Src/Composition/plugins/wiring.ts` | 只做接线，不提供服务 |
| interface | `http` / `ipc` | `Interface/**` | 叶子 |

## 附录 B：cordis API 速查（本项目实测，4.0.4）

```ts
import { Context, Service } from '@deepseek-ai/cordis';
import type { Fiber, FiberState, Plugin } from '@deepseek-ai/cordis';

const ctx = new Context();                       // 根上下文
const fiber = ctx.plugin(plugin, config?);       // 挂载 → Fiber（& PromiseLike）
const child = ctx.isolate('svcName');            // 为某服务名开独立作用域
ctx.get('svcName');                              // 可选读取（未提供返回 undefined）
ctx.effect(() => { /* 申请资源 */; return () => { /* 释放 */ }; });
await fiber.dispose();                           // 卸载（递归卸载子插件）

class MyService extends Service {
  static inject = ['other'];                     // 服务间依赖（提供者必须是祖先/兄弟）
  constructor(c: Context) { super(c, 'myName'); } // 只注册
  async [Service.init]() { /* 构造后的初始化 I/O */ }
}

for (const rt of ctx.registry.values()) {        // 自检
  for (const f of rt.fibers) { /* f.state: 0 PENDING / 1 LOADING / 2 ACTIVE / 3 FAILED / 4 DISPOSED / 5 UNLOADING */ }
}
```

**必须记住的三条**：
1. `FiberState` 是 `const enum` → **只能 `import type`**，比较用 `2 as FiberState`。
2. 服务可见性是**全局扁平**的；树只决定生命周期。依赖方向靠 `inject`，与树形无关。
3. 没有 `ctx.stop()` / `root.stop()`；卸载只能自己持有 fiber 逆序 `dispose()`。

## 附录 C：术语对照

| 本文档 | cordis | 本仓库现状 |
|---|---|---|
| 容器 | `Context` | `Src/main.ts` 的 121 次手工装配 |
| 服务 | `Service` + `ctx.<name>` | 6 个模块级注册表 + 17 个全局 setter |
| 插件 | `ctx.plugin(...)` | 无（全部静态 import） |
| 依赖声明 | `inject` | 人工排序的 ①~⑲ 启动步骤 |
| 资源回卷 | `ctx.effect(disposer)` | 9 步手写关闭 |
| 层树 | 父/子插件挂载关系 | 目录分层（`Infra/Tools/Services/Core/Interface`） |
