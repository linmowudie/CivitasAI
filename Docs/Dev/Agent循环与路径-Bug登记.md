# Agent 主循环 Bug 登记（2026-10-08）

> 来源：用户在 Electron 开发态实测反馈（`npm run dev:electron`）。
> 登记：Qoder，2026-10-08。**本文件只登记，不含修复**；修复方案单独立项后再动代码。
> 运行环境：分支 `feat/cordis-composition`（HEAD `bc235a6`），Electron 会话时间窗 18:25:43–18:27+（本地）。

## 0. 归属初判（先说结论）

**三个 bug 都不是本次 cordis 容器化改造引入的。** 证据：相关源码在基线（`fff18b5`）到当前 HEAD 之间**零改动**：

```bash
$ git log --oneline main..HEAD -- Src/Core/Loop/runIteration.ts Src/Services/LoopControl \
      Src/Services/Supervision Src/Services/Context Src/Tools/Builtin/Read Prompts/
（空输出）
```

容器化只改了"装配方式"（`Src/main.ts` + `Src/Composition/**` + 少许可撤销注册 API），
本登记里涉及的主循环/停止规则/上下文装配/工具实现均为基线既有代码 ⇒ 判为**存量缺陷**。
仍建议按 §3 的 A/B 步骤在基线 worktree 上复核一次，把"存量"写成实测结论而不是推断。

**环境观察（不是 bug，但影响复测）**：本次 Electron 启动时 `vite` 报
`Port 5173 is already in use`——5173 被 2026-10-07 23:57 启动的旧 vite 进程占用（pid 27056），
渲染层实际复用的是那个旧 dev server。复测前端相关现象前需人工确认该进程是否为预期的代码状态。

---

## 1. Bug 清单

| ID | 标题 | 严重度 | 状态 | 一句话现象 |
|---|---|---|---|---|
| BUG-2026-10-08-1 | 工具返回**空结果**导致主循环同参空转、对话无法收敛停止 | 高（烧 Token / 对话无法结束） | 待修复 | 空目录 → 模型反复 `dir.list`，每轮结果相同，跑到迭代上限 |
| BUG-2026-10-08-2 | Agent **不知道自己的任务工作目录**，路径型工具落到 `.` / `/` | 高（工具必失败 / 越界被拦） | 待修复 | 模型只能猜路径，列举为空或 `PATH_DENIED` |
| BUG-2026-10-08-3 | 工具**一次失败**即退出 agent 循环（应连续 3 次） | 高（一次抖动就中断任务） | 待复现定位 | 用户实测："一运行工具失败就退出 agent 循环" |

---

## 2. 逐条详情

### BUG-2026-10-08-1 · 空结果 → 同参空转

**现象（实测）**
- UI 截图（18:26）：`Assistant · Tool · huawei-maas/GLM-5.1 · 11 轮迭代 · 已停止`；
  第 1–6 轮全部是 `dir.list`（"列出目录 ."，`read · 0 ms`），第六轮之后仍在继续。
- 模型自述："The directory listing returned empty. Let me try listing the current working directory or root path."
  —— 即模型把"空结果"当成"还没试对"，于是换路径继续试。
- `Logs/business.log` 同窗口（10:26:35Z–10:26:59Z）计数：`工具结果缓存命中，跳过执行`（toolName=`dir.list`）**10 次**、
  `系统审计`（eventType=`UserInputReceived`）**13 次**，平均 3–7 秒一轮。

**根因线索（未验证）**
- `Prompts/roles/worker.md:20` 只有"**连续 3 次工具调用失败** → 停止执行"——空结果**不算失败**，该规则不触发。
- `Prompts/system/mainLoop.md` 原文没有关于"空结果"的任何约束。
- 工具结果缓存（日志里的"缓存命中"）让重复调用的代价≈0，模型没有"重试无意义"的反馈信号。
- 停止规则里 `noProgress.stagnationWindowRounds=3`（`Configs/loopConfig.json`）理论上应兜底，
  但 `dir.list` 每次参数不同（换路径）时 `goal_distance` 变化可能判定为"有进展"，兜底不生效——**待验证**。

**影响面**：任何"目标路径为空/不存在"的对话都会空转到 `maxIterations`（配置 30，硬上限 200），
真实计费且体验上是"停不下来"。

**修复方向（候选，未实施）**
1. 提示词侧：主循环/角色提示词里明确"空结果是有效结论、禁止同参重复调用、限一次换参数探索"；
2. 引擎侧（另一立项）：工具结果缓存命中时给模型显式反馈（如"该调用与上一轮完全相同，结果一致"）；
3. 引擎侧：把"同参重复调用"计入 `noProgress` 信号。

**当前工作区已有一份未提交的提示词草稿**（见 §4），待你确认后再决定是否提交。

**复现**：`npm run dev:electron` → 新会话绑定一个**空目录**为工作目录 → 发一条需要列目录的指令（如"看看工作目录里有什么"）。

---

### BUG-2026-10-08-2 · Agent 不知道任务工作目录

**现象（用户实测）**：模型无法得知当前工作目录是哪个；它发出的列目录命令是 `/`（另一次是 `.`），
结果为空或被路径守卫拒绝，直接触发 BUG-1 的空转。

**根因线索（未验证，但代码路径明确）**
- `Src/Core/Loop/runIteration.ts:140` 定义 `workDir?: string`（注释：来自 `chat_sessions.work_dir`），
  在 `runIteration.ts:710` 只被**传给工具**（`workDir: ctx.workDir`），**从未进入模型可见的任何消息**。
- 系统提示为保证提供商前缀缓存字节恒定（`buildStableSystemPrompt` + `systemPromptCache`，`runIteration.ts:96-124`），
  不能塞入会话级动态路径；而现成的动态槽位——`ContextStore` 追加区（`contextStore.ts:93 toAppendMessages`）——
  目前只写 `file.read` 的工作集（`recordFileWorkSet`，仅 `WORK_SET_FILE_TOOLS=['file.read']`）。
- 结果：模型既不知道绝对工作目录，也不知道"相对路径会以工作目录为根"，只能猜 `.` / `/`。

**影响面**：所有路径型工具（`dir.list` / `file.*` / `shell.exec`）在高概率上第一次就错，
浪费轮次并诱发 BUG-1。

**修复方向（候选，未实施）**：把 `workDir` 以追加区条目（如 `[ctx:workspace] 当前工作目录：<abs>`）
注入模型可见上下文——需同时决定"提示词措辞"与"注入点"，属立项后再动。

**复现**：任意会话发"列出当前目录内容"，观察模型把路径猜成 `.` 或 `/`（UI 里表现为"列出目录 ."）。

---

### BUG-2026-10-08-3 · 一次工具失败即退出循环

**现象（用户实测）**：只要工具运行失败，agent 循环立刻退出——期望是"连续 3 次失败才停"。

**根因线索（未验证，仅登记候选路径）**
- 退化阈值配置本身是 3：`Configs/loopConfig.json` → `stopRules.limits.maxConsecutiveErrors = 3`，
  与 `stopRules.ts:174` 的判定一致。
- 但**风险触发器**可能先行中止：`riskTriggers` 默认注入
  `{ condition: 'signal == "UNRECOVERABLE_TOOL_ERROR"', action: 'abort' }`（本次实现记录 §偏差与本行同源，
  基线 `main.ts` 相同），而 `Src/Services/Supervision/postSupervision.ts:42,48` 会把异常归类为
  `UNRECOVERABLE_TOOL_ERROR` 并触发中止——**若单次工具失败被归入该类，就会一次即退出**。
- 另注意 `runIteration.ts:818` 附近存在一处 `maxConsecutiveErrors: 5` 的疑似硬编码（与配置 3 不一致），
  是否参与判定**待确认**。

**影响面**：瞬时故障（限流、路径暂时不可写）会打断整轮任务；用户视角是"一失败就死"。

**复现（待补）**：构造一次必然失败的工具调用（如 `dir.list` 指向被守卫拒绝的绝对路径），
观察是否**第 1 次**失败即出现循环结束事件；同时抓 `Logs/business.log` 中的
`UNRECOVERABLE_TOOL_ERROR` / `连续错误数` 条目作为证据。

---

## 3. 建议的复核步骤（把"存量"从推断变成实测）

```bash
# 基线 worktree（不含 cordis 改造）
git worktree add F:/ProjectCode/cordis-baseline-fff18b5 fff18b5     # 目录联接复用主区 node_modules
cd F:/ProjectCode/cordis-baseline-fff18b5
npm start            # 或 npm run dev:electron
# 用相同操作复现 BUG-1/2/3，对比 Logs/business.log
```

若基线上三条同样出现 ⇒ 归属为存量缺陷，与 `feat/cordis-composition` 无关（与 §0 静态证据一致）。

---

## 4. 当前工作区未提交内容（供决定）

| 文件 | 内容 | 说明 |
|---|---|---|
| `Prompts/system/mainLoop.md` | 新增「空结果与重复调用（硬约束）」小节 + 推理约束第 4 条自查项 | 针对 BUG-1 的**草稿**，未提交；若要先登记后修复，可 `git checkout -- Prompts/` 丢弃 |
| `Prompts/versions/manifest.json` | `system/mainLoop.md` 升 1.1.0 + changelog 一条 | 同上，与草稿同批 |

> 提交与否请明确指示；本文件登记的三条 bug **均未修改任何源码**。
