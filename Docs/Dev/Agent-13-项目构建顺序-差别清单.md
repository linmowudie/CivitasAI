# Agent/13 项目构建顺序 — 文档-代码差别清单

> 审查日期 2026-10-03 · 审查基准：当前工作区代码（含未提交改动）
>
> 被审文档：`Docs/Agent/13-构建与实施/项目构建顺序.md`（S0~S14 + F0~F6，共 561 行；相对 `HEAD` 有 41 增 / 41 删的未提交改动，为目录重命名 `Docs/14-构建与实施` → `Docs/Agent/13-构建与实施` 所致）
> 核验手段：`npx eslint Src/`、`npx tsc --noEmit`、`npx tsc --noEmit -p tsconfig.electron.json`、`npx vitest run`、`node Scripts/experimentMatrix.cjs`、目录 `find`、逐条 `grep`/`Read`
> 路径均相对仓库根 `F:\ProjectCode\CivitasAI`

---

## 摘要（各类计数 + 总体判断）

| 分类 | 条数 |
|------|------|
| 【文档过时】 | 15 |
| 【代码未实现】 | 13 |
| 【声明错误】 | 11 |
| 【需人工裁定】 | 10 |
| **合计** | **49** |

**实测基线（2026-10-03 工作区）**

- `npx tsc --noEmit` → **0 错误**；`npx tsc --noEmit -p tsconfig.electron.json` → **0 错误**。
- `npx vitest run` → **73 个测试文件 / 1041 项用例全绿**，耗时 213.5s（其中 `Tests/AgentRuntime/realAgent.spec.ts` 4 项为真实 LLM 调用，211.6s）。
- `npx eslint Src/ --ext .ts` → **exit=1，8 errors / 150 warnings**；其中 5 条是**五层单向依赖红线违规**（`Infra→Services`、`Infra→Core`、`Tools→Services`、`Tools→Core`）。
- `npm run layer-check` → **exit=2 直接崩溃**（脚本自身参数在 Windows 下被拆词）。
- CI（`.github/workflows/ci.yml`）→ `lint` job 因上述 8 errors 必红；即使变绿，`test` job 的 Coverage check 步骤读不到 `coverage/coverage-summary.json`（vitest 未配 `json-summary` reporter）→ **CI 今天不可通过，而文档多处 ✅ 门禁以"错误数 0 / CI 拒收"为判据**。
- git 史：`2026-09-22` 之后只有 **8 次提交**，最后一次为 `493b005`（2026-09-23，"逐层清偿类型技术债（124→0 errors）+ 恢复五类退出判定与分层 zones"）；**10-01~10-03 的 366 项变更全部未提交**。

**总体判断**

文档的**骨架与依赖顺序仍然成立**，且 S0~S2、S5、S8、S12 的文件清单与建表范围与代码高度一致（见末节抽查项）；它的"2026-09-22 校准"里对 `retryPolicy` 归属、`anthropicProvider`/`contextWindowRegistry` 缺失、24 条工具未达成、五类退出三处不一致等判断，**大部分至今仍然有效**。

问题集中在三类：

1. **✅ 被当作"已通过"读，而它实际是"判据清单"** —— 至少 11 处 ✅ 门禁的判据在代码里是"标记不阻断"（G4 HumanGate）、"运行期抛错而非 CI 拒收"（G6 ADR-0004）、"内存模拟而非真 git"（G11）、"事件对象无消费者"（G7 双预算）、"用例名不副实"（G14 DUR-006 满盘）。
2. **9-23 之后的代码演进未被回写** —— 五类退出的 `success` 分支已恢复（使本文的"尚不可验证"结论过期一半）、工具数 11→12、`Interfaces/` 目录改名、接口层已真绑端口（§9 的 F0 前提整体失效）、`Server/` 子项目与 `electron/` 壳完全不在阶段图里。
3. **门禁数值多数不可达** —— CI 缺层规/接口文档/劣化三类步骤、`layer-check` 脚本坏、coverage 门禁读不存在的文件、真实调用测试在 CI 静默跳过、50 条人工标注集只有 5 条且指向不存在目录。

**建议优先级**：先修 lint 的 5 条越层 + `layer-check` 脚本 + coverage reporter（让 ✅ 有可判定基线）→ 再回写文档的 15 处过时项 → 最后按【代码未实现】13 项排期（多数对应 §3"禁止抢跑"链条上的真实缺口）。

---

## 差别清单

> 分类标记：〔过〕【文档过时】〔未〕【代码未实现】〔错〕【声明错误】〔裁〕【需人工裁定】

| 编号 | 文档章节 | 文档声明 | 代码实态(文件:行) | 分类 | 建议处理 |
|------|----------|----------|------------------|------|----------|
| D-01 | 推导依据 2；S1 首段 | "启动 **14 步**的运行时依赖顺序（Docs/Agent/02 §7.1）"、"严格按启动 14 步的 ①~⑦ 顺序构建" | `Docs/Agent/02-核心架构/核心架构设计.md:478` 章节标题已是"启动 **18 步**（与 `Src/main.ts` 实际代码对齐）"；`Src/main.ts:60-370` 装配步数远超 14 | 〔过〕 | 把步数基准改为 18，并注明"①~⑦ 为 S1 范围子集" |
| D-02 | S0 0.3 | ESLint `import/no-restricted-paths` "**封死**五层反向依赖" | `.eslintrc.json:29-34` 对 `Services ← Core` 开了 `except: ["AgentRuntime","Decision"]`；`Src/Services/Recruitment/recruiter.ts:11-13`、`Src/Services/ReviewerAgent/reviewerAgent.ts:9-11` 实际反向 import Core | 〔错〕 | 改述为"封死（含 AgentRuntime/Decision 白名单例外）"，并登记例外来由（需 ADR） |
| D-03 | S0 0.8 | "CI 流水线：lint + 单测 + **层规检查** + **接口文档存在性检查**" | `.github/workflows/ci.yml` 只有 lint(22)/tsc(23)/typecheck:electron(24)/test+coverage(35-43)/build(53)；全仓 workflow 仅此一个文件 | 〔未〕 | CI 增加 layer-check 与 `Docs/Agent/16-开发规范/Interfaces/*.md` 存在性步骤 |
| D-04 | S0 0.3 / 0.8 | 层规检查可独立执行（`npm run layer-check`） | `package.json:32` 用 `--rule '{"import/no-restricted-paths":["error",{"zones":[]}]}'`：实测 `npm run layer-check` → **exit=2** `No files matching the pattern "[error,"`；且 `zones:[]` 等于把层规**关掉**，即使可运行也检不出违规 | 〔错〕 | 删除该脚本或改为 `--no-eslintrc` + 完整 zones；Windows 下用 cjs 包装避免引号被拆 |
| D-05 | Gate G0 第 2 条 | ✅"手工写一条 `Services → Core` 的 import，CI 必须失败" | 拦截机制在（`.eslintrc.json:29-39`），但工作区 `eslint Src/` 已有 **8 errors**，其中 5 条正是越层：`Src/Infra/Db/Repositories/agentRepository.ts:17-18`、`Src/Tools/Builtin/Plan/todoWriter.ts:15`、`Src/Tools/Custom/agentRecruiter.ts:20-21` → CI lint job 常红，"违规可被拦"与"错误数 0"两个基线同时不成立 | 〔错〕 | 先清 5 条越层（把类型下沉 `Infra/Contracts` 或反转依赖），再声称门禁有效 |
| D-06 | S0 0.5 | `Configs/` 全量默认值 = 8 个 json | 实有 **14 个** json；`Tests/gateG0.spec.ts:22-31` 已按 14 项硬校验（含 `dataStorage/arbitration/audit/memory/security/coverageBaseline/benchBaseline`） | 〔过〕 | 清单补齐为 14 项，与 gateG0 用例同源 |
| D-07 | S0 0.6 | ADR 骨架 = 0001~0005 | 另有 `ADR/0006-middleware-contract-relocated-to-infra.md`（2026-09-15），是 D-19/D-23 的根因，但 §8 对应关系表与 S5/S6 清单均未登记 | 〔过〕 | 在 S0 0.6 与 §8 补 ADR-0006，并按其结论重写 Middleware 目录 |
| D-08 | S0 0.7 | "空壳启动：`main.ts` 只打一行日志" | `Src/main.ts` 23.6KB / 约 470 行，`startServer()`(:60) 完成 DB/工具/Provider/中间件/路由装配并起 HTTP+IPC(:365-368) | 〔过〕 | 标注为"S0 当时状态，现已被 S5/S13 取代"，避免误读为当前产物 |
| D-09 | Gate G0 第 1 条 | ✅"删除所有 `Configs/local.json` 后仍可启动" | 仓库**从不存在** `Configs/local.json`（`.gitignore:24` 忽略），该断言只能被静态检查替代：`Tests/gateG0.spec.ts:38-56` 校验 `default.json` 键齐全，无启动冒烟测试 | 〔裁〕 | 决定：保留为"默认值完备性"判据（改述）或补一条真启动冒烟用例 |
| D-10 | Gate G1 第 2 条 | ✅"历史表写入失败**重试 1 次后上报 FATAL**" | `Src/Infra/Logging/logWriter.ts:141,165,259,287,308` 全部为"静默丢弃"，`grep 重试\|retry` 在 `Infra/Logging/*`、`Interface/EventStore/aiEventStore.ts` **零命中** | 〔未〕 | 要么实现 1 次重试 + FATAL，要么把 G1 该条改述为"仅静默丢弃"（与 `Docs/Agent/10` 对齐） |
| D-11 | S1 `Infra/Db` | 目录写作 `repositories/` | 实际 `Src/Infra/Db/Repositories/`（首字母大写，与 `Config/Logging/Db` 同级风格一致） | 〔过〕 | 大小写对齐，避免非 Windows 平台 import 失败 |
| D-12 | S3 校准注 | "`Src/Core/Model/` 只有 modelCaller/streamParser/abortSignal/index" | 实有 6 个文件：另含 `Src/Core/Model/contextHistory.ts`、`Src/Core/Model/sessionNamer.ts`（均未在 S3~S13 任何清单登记） | 〔过〕 | 补入 S5/S13 清单（contextHistory 属上下文装配、sessionNamer 属会话） |
| D-13 | Gate G3 第 4 条 | ✅"总超时 60s / 流式首字节 10s / 相邻包间隔 15s **全部生效**" | 参数齐备（`Configs/modelRouter.json:50-52`、`Src/Infra/Llm/Provider/retryPolicy.ts:24-72`、`Src/Core/Model/abortSignal.ts:69`），但**生效性用例自证缺失**：`Benchmarks/experimentMatrix.json` 中 `ENV-TIMEOUT`/`ENV-NETPART`/`ENV-PDOWN` 三格 `status="declared-only"`、`anchor.kind="none"` | 〔错〕 | ✅ 降为 ⚠️"参数就位、生效未验证"，并排期三格用例 |
| D-14 | Gate G3 第 3 条 | ✅"网络错误耗尽 → 终止当前轮次并写 `FailureFeedback(category='external')`" | `category='external'` 只出现在 Verifier 层（`Src/Services/LoopControl/verifier/hardVerifier.ts:127,136`、`llmJudge.ts:52,65`）；`retryPolicy.ts`/`openaiProvider.ts` 重试耗尽路径不产出 FailureFeedback | 〔未〕 | 在 `runIteration` 的 Provider 异常分支补写 FailureFeedback，或改述该条 |
| D-15 | S4 Gate G4 校准 | "当前实际注册 **11 条**（9 builtin + 2 custom，见 `Src/Tools/builtinLoader.ts:13-34`）" | `Src/Tools/builtinLoader.ts:38-57` 的 `BUILTIN_TOOLS` 为 **12 条**（10 builtin：新增 `Builtin/Plan/todoWriter`，见 :27 + 2 custom）；导入区实际跨 13-35 行 | 〔过〕 | 校准数为 12，并把 `Tools/Builtin/Plan/` 补入 S4 清单 |
| D-16 | S4 Gate G4 校准 | "单测 `Tests/Tools/tool.spec.ts:229-233` 断言 `registerBuiltinTools()` 返回 11" | `Tests/Tools/tool.spec.ts:229-234` 实为 `expect(result.value).toBe(BUILTIN_TOOLS.length)` —— **无硬编码条数**，新增/删除工具不会让该用例失败，"逐条纳入"的守护实际不存在 | 〔错〕 | 要么改为快照/常量断言，要么删除"须逐条纳入"的承诺 |
| D-17 | Gate G4 第 2 条 | ✅"`DANGEROUS + IRREVERSIBLE` 工具未声明 L4 HumanGate → **CI 拒收**" | `Src/Tools/Traits/specValidator.ts:103-106` 原文："**标记但不阻断**——L4 HumanGate 在 S6 的 approvalGate 中强制"；`ci.yml` 亦无该检查 | 〔错〕 | 改述为"校验器标记、审批门运行期强制"，并明确 CI 不承担此职责 |
| D-18 | Gate G4 第 3 条 | ✅"`idempotency:'NO'` 工具未先写 `INTENT` → 运行期拒绝执行" | `Src/Services/LoopControl/middleware/toolSafetyGate.ts:242-268` 写 INTENT 的条件是 `dangerLevel !== 'SAFE'`（与 `idempotency` 字段无关）；fail-closed 只覆盖"INTENT 写入失败"（:260-263） | 〔裁〕 | 裁定判据口径：按危险级（现实装）还是按幂等级（文档），二者不等价 |
| D-19 | S5 清单第 4 项 | `Core/Middleware: [middlewareRegistry.ts, hooks/, builtin/]` | 无 `hooks/` 目录：`Src/Core/Middleware/` 实为 `middlewareRegistry.ts`、`index.ts`、`toolCallClassifier.ts`、`builtin/`；六钩子类型已迁 `Src/Infra/Contracts/middlewareTypes.ts`（ADR-0006） | 〔过〕 | 按 ADR-0006 重写该行 |
| D-20 | S6 校准表第 2 行 | "`iterationController.ts:44-76` 自 2026-09-15 修订后**不再返回 `success`**……无产出路径" → 据此判 Gate G6"成功判定"在端到端**尚不可验证** | **已修复**：`Src/Core/Loop/iterationController.ts:62-68` 恢复 success 退出（`hasOutput && !hadToolCall` → `exitReason='success'`），由 `493b005`（2026-09-23）"恢复五类退出判定"完成 | 〔过〕 | 该行改注"2026-09-23 已恢复"；G6 第 1 条的 ⚠️ 尾注同步收敛（保留 D-21 的顺序问题） |
| D-21 | S6 校准表第 2 行（顺序部分）；Gate G6 第 1 条 | 实际驱动顺序"风险→**预算**→上限→无进展"与目标态"风险>上限>预算>无进展>成功"不一致；"成功判定位于所有失败判定之后" | 仍不一致：`iterationController.ts:43-71` 实序 risk → budget → limits → **success** → no_progress；`stopRules.ts:71-72` 为 risk → limits → budget_hard → no_progress → success；两条路径并存（`runIteration.ts:687` 走前者、:705/730 走后者） | 〔裁〕 | 由架构侧裁定唯一权威判定链（ADR），再更新文档；文档不应同时挂两序 |
| D-22 | S6 校准表"待办③" | 统一 `loopConfig.json` 枚举键名并**真正接线读取**，或删除死键 | 死配置仍在：全库 `evaluationOrder` 只出现在 `Configs/loopConfig.json:45` 与测试夹具 `Tests/Infra/config.spec.ts:102`；`EVALUATION_ORDER` 仅经 `stopRules.ts:256 getEvaluationOrder()` 被 `Tests/E2E/loopConvergence.spec.ts:21` 读取，生产路径不读配置 | 〔未〕 | 接线或删除（三处键名 `budget/noProgress` vs `budget_hard/no_progress` 一并统一） |
| D-23 | S6 清单第 8 项 | `Services/LoopControl/middleware: [goalReanchorMiddleware.ts, fingerprintDetectorMiddleware.ts, budgetSentinel.ts, stopRuleEvaluator.ts, checkpointWriter.ts]` | 实名为 `goalReanchorControl.ts`、`fingerprintDetectorControl.ts`、`budgetSentinelControl.ts`（+ 未登记的 `toolSafetyGate.ts`）；哨兵实体在 `Src/Core/Middleware/builtin/budgetSentinel.ts`，`budgetSentinel.ts` 在本目录**不存在** | 〔过〕 | 按实名重写，并注明"哨兵分两层：Core 桩 + LoopControl 控制级" |
| D-24 | S6 清单第 8 项（装配语义） | 五个 Loop 控制中间件为 S6 交付物（隐含"在运行时生效"） | 生产链路**未挂载**：`Src/main.ts:244-247` 仅 `registerMiddleware(goalReanchorMiddleware / fingerprintDetectorMiddleware / budgetSentinelMiddleware / rateLimiterMiddleware)`，四个 `*Control`/`stopRuleEvaluator`/`checkpointWriter` 中间件只被测试引用；等效能力由 `runIteration.ts:705,730` 直调 `evaluateStopRules` 承担 | 〔未〕 | 决定：注册进启动序列，或在 S6 明确"中间件形态未启用，走 runIteration 内联" |
| D-25 | Gate G6 第 3 条 | ✅"`producerModel === verifierModel` → **CI 拒收**（ADR-0004）" | 只有运行期抛错：`Src/Services/LoopControl/verifier/llmJudge.ts:28,42`；`ci.yml` 无相关步骤；且现有 E2E 直接把 producer/verifier 配成同一模型（`Tests/E2E/delegationMode.spec.ts:94`、`assemblyLineMode.spec.ts:87`、`consortiumMode.spec.ts:92`） | 〔错〕 | 改述为"运行期拒判"，另在配置校验层补静态检查；E2E 需分模型或显式豁免 |
| D-26 | Gate G6 末条；§4 "Benchmark 数据集"行 | "构造 30 轮长任务注入干扰"；"L3 Judge 校准集必须在 S6 Gate 前备好 **50 条**人工标注" | `Skills/rubrics/verifierL3Calibration.json` 的 `samples` 仅 **5** 条；`Configs/loopConfig.json:50` 指向 `Tests/GoldenSets/review-50` —— 该目录**不存在**（`find Tests` 无 GoldenSets） | 〔未〕 | 建 `Tests/GoldenSets/review-50` 或改配置指向现有 rubric；补齐标注量 |
| D-27 | Gate G7 第 1 条 | ✅"Token 总量守恒，**1000 次并发**调用后仍成立" | `Tests/TokenEconomy/tokenEconomy.spec.ts:129` 只有顺序式"Token 守恒验证"；该 spec 内 `Promise.all` / `Array.from({length` **零命中** | 〔未〕 | 补并发守恒用例（1000 次 `debit/credit` 混合） |
| D-28 | Gate G7 第 2 条 | ✅"`usage ≥ soft` → Reasoning Sandwich 自动降级 + **并行度 ÷2**" | `Src/Services/TokenEconomy/dualBudget.ts:130,154` 仅**返回** `BUDGET_SOFT_REACHED` 事件对象；除 `TokenEconomy/index.ts:41` re-export 与测试外**无消费者**；全库无 Reasoning 降级/并行度折半实现（`并行度`只出现在 `complexityAssessor.ts:133`、`taskDecomposer.ts:128` 的启发式评分） | 〔未〕 | 接线 `budgetSentinelControl` 的 `onSoft` 回调到降级动作，或删除该判据 |
| D-29 | Gate G7 第 3 条 | ✅"`usage ≥ hard` → 立即中止当前 iteration 并**回滚到 `last_checkpoint`**" | 实装：`Src/Core/Middleware/builtin/budgetSentinel.ts:13,33-41` 在 ratio≥0.95 时**拒绝模型调用**（非回滚）；`stopRules.ts` 的 `budget_hard` 只产生退出；`loadCheckpoint` 仅用于崩溃恢复（`Src/Infra/DurableExecution/recoveryExecutor.ts:62`） | 〔错〕 | 改述为"硬预算 → 退出 + 由恢复器决定是否回滚快照"，与 §3 副作用不可重复原则一致 |
| D-30 | Gate G7 第 4 条 | ✅"每次 Token 变动都是一条 effect（可从 EffectJournal 重建账本）" | `Src/Services/TokenEconomy/` 全目录无 `recordIntent`/`effectJournal` 引用（`tokenLedger.ts:9-12`、`consumptionRecorder.ts:9-13` 只 import `walletManager`）；账本与 journal 是两条独立链路 | 〔未〕 | 若要保住此判据，需在 `walletManager.debit/credit` 落 effect；否则从 G7 移除 |
| D-31 | S8 清单 | `Services/SharedMemory` 7 文件；`eventTypes` 为"40+ 枚举注册表" | 枚举 72 项（`Src/Services/EventBus/eventTypes.ts:11` 起，`Scripts/genEventTypes.ts` 生成）→ 达标；但 SharedMemory 实有 9 文件，`longTermMemoryStore.ts`、`memoryEntryStore.ts` 两个持久层未登记 | 〔过〕 | 补清单；`40+` 建议改为"以 `eventTypes.ts` 为准，由 genEventTypes 生成" |
| D-32 | Gate G9 第 2 条 | ✅"架构变更后必须完成**至少 3 轮真实 Agent 调用测试**（非 mock）" | 用例存在（`Tests/AgentRuntime/realAgent.spec.ts:127,142,232,293`），但缺 key 时 `console.log('SKIP…')` 后直接 `return` —— 用例仍计"通过"；`ci.yml` 不注入 `HUAWEI_MAAS_API_KEY` → **CI 侧恒为静默跳过**。本地实跑：4 项真调用全绿、211.6s（含华为云 Maas 输出正文） | 〔裁〕 | 改为 `it.skipIf` + CI 显式标记 skipped；或 CI 增加带密钥的定时真实调用流水线 |
| D-33 | §6.4 交付要求 | "涉及架构变更的阶段（S5/S6/S10/S11/S12）必须完成至少 3 轮真实 Agent 调用测试，不能只靠 mock" | 唯一的 Integration 真实调用资产 `Tests/Integration/realAgentCallTest.ts:1-24` 整体被注释、自述"⚠ 本测试脚本需要重写 / TODO 重写为 Electron 测试脚本"；且文件名不匹配 `vitest.config.ts:22` 的 include 规则 → **永不被收集**。S5/S6/S10/S11/S12 无对应真实调用资产 | 〔未〕 | 删除死文件或改名 `.spec.ts` 并实现；按阶段补真实调用记录（含 3 轮的产物归档位置约定） |
| D-34 | Gate G9 末条 | "已知缺陷：此阶段无仲裁与监管……**登记在 CHANGELOG 已知事项**" | `CHANGELOG.md` 中"仲裁"仅出现 1 次且非缺陷登记；无"S9 已知缺陷"条目（`grep 无仲裁\|仲裁与监管` 零命中） | 〔裁〕 | 确认是否已被 S12 实现取代（`Services/Arbitration`、`Regulation` 均已存在）；若取代则删除该条 |
| D-35 | Gate G10 第 4 条 | "每增加一个角色都需用 benchmark 证明'质量增益 > 成本 + 延迟 + 协调复杂度'（Docs/Agent/03 §7）" | `Benchmarks/datasets/sampleTasks.json`/`adversarialSeeds.json` 无角色维度对比实验；`Benchmarks/baselines/metrics.json:1-23` 只有 2026-09-14 汇总快照，无 per-role 指标；`Scripts/experimentMatrix.cjs` 42 格里无该维度 | 〔未〕 | 建立角色增删的 benchmark 模板，或把该判据降级为"评审要求" |
| D-36 | Gate G11 第 1 条 | ✅"4 个 Worker 并行改同一仓库 → 各自 worktree，验证通过后才合并" | `Src/Infra/Sandbox/gitWorktreeManager.ts:6` 自述"**Phase 0-2：内存模拟（不依赖真实 Git）；Phase 3 接真实 git worktree**"；文件内无 `git`/`exec`/`spawn` 调用；`Tests/Parallel/parallelCollaboration.spec.ts:143-182` 用 **2 个**模拟 worktree 断言 | 〔错〕 | ✅ 改为 ⚠️"目录级隔离已达成，真实 git worktree 属 Phase 3"；用例数与文档口径（4）对齐 |
| D-37 | S11 | 隔离目录 `Data/Workspace/{session}/{taskId}/{agentId}/` | `Data/Workspace/.gitkeep` 存在，但同时存在运行时 `Data/workspaces/`（小写复数，10-03 仍在写入）→ 两套工作区根并存；`workspaceIsolator.ts` 与 `sessionKeyGenerator` 分别落哪一套需核对 | 〔裁〕 | 统一目录约定并收敛（Windows 大小写不敏感会掩盖冲突） |
| D-38 | S13 清单第 2 行 | "`Interface/WebSocket: [wsServer.ts, wsHandler.ts]` ⚠️ 历史：**2026-09-28 已删除**，现为 `Interface/IpcBridge/ipcBridge.ts`" | 实删 **3** 个文件（另含 `wsGateway.ts`，见 `git status`：`D Src/Interface/WebSocket/ws{Gateway,Handler,Server}.ts`）；**删除动作尚未提交**（HEAD 停在 `493b005`/2026-09-23）；空目录 `Src/Interface/WebSocket/.gitkeep` 仍在；`ipcBridge.ts:4-9` 自述替代三者 | 〔裁〕 | 提交后把"三者 + 日期"写实，或改为"2026-Q4 工作区变更（未提交）" |
| D-39 | S13 清单 | `Interface/RestApi: [5 文件]`、`Interface/WebServer: [webServer.ts, routes.ts]` | RestApi 实有 **14** 文件（另 `chatApi/configApi/memoryApi/placeholderApi/router/skillsApi/syncApi/toolsApi`）；WebServer 实有 **4**（另 `httpServer.ts`、`apiRateLimiter.ts`）；`Data` 侧还新增 `Interface/EventStore/aiEventStore.ts` | 〔过〕 | 重写 S13 清单，或改指 `Docs/Agent/16-开发规范/Interfaces/interfaceInterfaces.md` 为唯一事实源 |
| D-40 | §9 开篇前提 | "S13 交付的接口层为函数级契约（`webServer.ts` 不绑端口、`wsServer.ts` 为内存事件桥、`main.ts` **未装配接口层**），因此 M3 后首要任务是把契约提升为网络服务（=F0）" | 前提已失效：`Src/Interface/WebServer/httpServer.ts:51,93` 用 `createServer().listen(port,host)` 真绑 3000；`Src/main.ts:54-55` 导入、`:365` 启 HTTP、`:368` 启 IPC 桥（`ipcBridge.ts` 32 处命令/事件处理）；`webServer.ts` 已退化为 `handleRequest` 分发器（:29）。即 **F0 已落地** | 〔过〕 | §9 改写为"F0 已完成，F1~F6 进度见 Docs/Client/02"，并修正 `Docs/Client/02-…/前端改造方案与构建顺序.md:98` 的 G0 判据状态 |
| D-41 | Gate G13 第 4 条 | ✅"端到端跑通 PRD 中的完整用户故事（含**架构师被扣违约金**、前端 Agent 死循环被挂起）" | `Tests/E2E/` 9 个 spec 均为模式级（delegation/assemblyLine/consortium/directExecution/litigation/regulationAudit/loopConvergence/crashRecovery/conflictArbitration），无 PRD 用户故事脚本；"违约金/penalty"在 Src 仅剩类型字段 `Src/Services/Arbitration/types.ts:76`，无结算/扣减实现路径 | 〔未〕 | 建 PRD 用户故事 E2E 用例；违约金链路（罚没→国库）实现后再勾 |
| D-42 | Gate G14 第 1 条 | ✅"基线登记完成，**CI 可检测劣化并告警**" | `ci.yml` 无任何 benchmark/劣化步骤；`Configs/benchBaseline.json:4-6` 与 `Benchmarks/baselines/metrics.json:4-8` 仍记 2026-09-14 的 `testCount 582 / testFilesCount 24`，实测 **1041 / 73**（差 79%）→ 基线已失真，`degradationThreshold` 无从比对 | 〔未〕 | 重写基线生成脚本并加 CI 步骤（`node Scripts/experimentMatrix.cjs` 可作前置门禁，目前仅本地可跑） |
| D-43 | Gate G14 第 3 条 | ✅"故障注入全覆盖（含网络分区、DB 满盘、Provider 全挂）" | `experimentMatrix.json`：`ENV-NETPART`、`ENV-PDOWN` `status=declared-only`、`anchor.kind=none`（"需混沌网络环境/需多 provider 故障编排"）；"DB 满盘"的 DUR-006 用例名不副实——`Tests/Durable/faultInjection.spec.ts:209-229` 实为"Effect Journal **正常写入**可验证"；`Tests/Infra/durable.spec.ts:5` 头注声称覆盖 DUR-003/005/006，但文件内只有 :276 与 :320 两项 | 〔错〕 | 修正三处标注为 ⚠️；真补满盘/断网/全挂注入用例 |
| D-44 | Gate G14 第 2 条 | ✅"LLM Judge 用人工标注集重校准，一致率 ≥ 85%" | 计算逻辑就位（`Scripts/rubricRecalibrate.ts:73,91,103`），但输入只有 5 条样本（见 D-26）、`package.json:10-40` 无调用入口、仓库内无校准结果产物 | 〔裁〕 | 裁定"S14 未达成"还是"脚本存在即交付"；建议以产出物（校准报告）为判据 |
| D-45 | §6.2 交付要求 | 接口文档路径固定为 `Docs/接口文档/{层名}层接口文档.md` | 该目录**不存在**（`ls Docs/接口文档` → No such file）；实际在 `Docs/Agent/16-开发规范/Interfaces/{infra,tools,services,core,interface}Interfaces.md` | 〔过〕 | 更新路径；与 `Docs/Agent/16` 的差别清单（Agent-16）交叉引用 |
| D-46 | §6.1 交付要求 + CI | "覆盖率不低于 `Configs/coverageBaseline.json` 基线"，并由 CI 强制执行 | `Configs/coverageBaseline.json` 的 `coverageMinimum=80` 存在，但 `ci.yml:38-43` 读 `./coverage/coverage-summary.json`，而 `vitest.config.ts:25` 的 reporter 是 `['text','json','html']`（**无 json-summary**）→ 该文件永不生成（`ls coverage/` 确认缺失）→ 门禁步骤必然 `Cannot find module` 失败。参考值：`coverage/index.html`（2026-09-28 生成，已过期 5 天）总覆盖率 **82.39%** > 80 | 〔错〕 | vitest reporter 加 `json-summary`；同时把 `excludePatterns`（coverageBaseline.json:4-8）与 vitest 的 exclude 对齐 |
| D-47 | 全文 ✅ 语义 | 各 Gate 以"✅ + 断言"书写，形似"已通过"状态标记 | 现状混合：类型检查 0 错、1041 测试全绿**成立**；lint **8 errors**、层规越层 5 处、`layer-check` 崩溃、coverage 门禁断链、真实调用 CI 跳过 → 门禁"错误数 0"只对 tsc/vitest 成立。`.husky/pre-commit` 第 2 步 `npx eslint … \|\| true` **显式吞掉 lint 失败**，是本地能提交的直接原因 | 〔裁〕 | 建议引入显式三态标记（✅达成 / ⚠️部分 / ⛔未达成）并把 pre-commit 的 eslint 去掉 `\|\| true` |
| D-48 | §1 阶段总览；§8 对应关系 | 全量范围 = S0~S14（+ §9 F0~F6） | 仓库已存在**第三极**且不在任何阶段：`Server/`（Fastify + PostgreSQL + argon2 + jose 的自托管账号/数据服务，独立 `package.json`、`Server/migrations/004_rate_limit_buckets.sql`、`Server/vitest.config.ts`，经 `package.json:21-26` 的 `server:*` 脚本调用）与 `electron/` 桌面壳（`tsconfig.electron.json`、`package.json:11` build 链）；对应设计文档 `Docs/Server/01~03`、`Docs/Client/03~04` 也未进 §8 表 | 〔过〕 | 增设 S15/F7 或"扩展线 F'：服务端与桌面壳"阶段，并在 §8 建依赖映射 |
| D-49 | 文档"2026-09-22 校准"体系 | 各条校准以 git 史为锚（"自 2026-09-15 修订后…"等） | 2026-09-22 之后仅 8 次提交（末次 `493b005`，2026-09-23）；10-01~10-03 之间 **366 项变更未提交**（含迁移 v21~v28、`IpcBridge`、Client 改版、`Server/`、`todoWriter` 工具）→ 任何"已完成"标注都缺少可核验的提交锚点，文档校准日期体系随之失效 | 〔裁〕 | 先落一次分批提交，再重建校准锚（建议以 commit hash 而非日期标注） |

---

## 未发现差异的抽查项

以下 24 项逐条核对后**与代码一致**，说明文档主干清单质量较高，问题集中在"状态"与"门禁可判定性"：

1. **S0 脚手架/lockfile**：`package.json`、`tsconfig.json`、`tsconfig.build.json`、`vitest.config.ts`、`package-lock.json` 均在；全仓 `package.json`（根/Client/Server）**无 `"latest"` 字面量**版本声明。
2. **S1 建表范围**：`Src/Infra/Db/migrations.ts:57-137` 恰好为文档所列 7 张基础表（`sessions/agents/tasks/subtasks/token_wallets/token_transactions/system_config`），Loop/Durable 表留待 S2/S6（v8~v15）✓。
3. **S1 三库 + 单写者**：`database.ts:7,145-147`（main/events/memory 三库，main 库 synchronous=FULL）。
4. **Gate G1 时钟回拨**：`Src/Infra/Time/timeService.ts:30-46`（`driftMs/driftCount` 与回拨事件）。
5. **Gate G1 session_key 碰撞**：`Src/Infra/Workspace/sessionKeyGenerator.ts:44-74`（`SHA-256` 输入 + `:retry:` 后缀重试）。
6. **S2 文件清单**：`Infra/DurableExecution/` 5 文件 + `schemas/` 3 文件（`EffectRecord.ts/Checkpoint.ts/RecoveryPlan.ts`）与文档**逐一对应**，无缺无多。
7. **S2 建表与 DDL**：`effect_journal`(v10)、`idempotency_cache`(v11) 已落；`Configs/durable.json` `writeSynchronous:"FULL"`；"Docs/Agent/09 §8.2 第 6)、7) 两段 DDL" 与 `migrations.ts:169-192` 对应 ✓。
8. **S3 Provider 清单与缺失项**：`Infra/Llm/Provider/` 恰为 `openaiProvider/providerBase/retryPolicy`，`anthropicProvider.ts`/`aliyunProvider.ts`/`contextWindowRegistry.ts` 确实不存在 → **2026-09-22 校准仍有效**。
9. **Gate G3 重试语义（参数层）**：`retryPolicy.ts:24-30` 401/403 `maxRetries:0`；:36-37 429 退避 `[5000]` 重试 1 次；:42-43 网络错误 `[1000,2000]`。
10. **Gate G3 流式取消写 EffectJournal**：`Src/Core/Model/abortSignal.ts:7` "流式取消时写 EffectJournal 的桥接"（+ `createTimeoutSignal`）。
11. **S4 目录与统一返回格式**：`Traits/{toolSpec,specValidator,index}`、`Registry/{toolRegistry,index}`、`Factory/toolFactory`、`Builtin/{Read,Write,Execute,Search}` 全部文件与清单同名；`Tests/Tools/tool.spec.ts:237-240` 断言所有工具 `additionalProperties:false`、:243-247 断言输出含 `status + recoverable` → Gate G4 第 4 条的"Schema 严格校验"部分**成立**。
12. **Gate G4 fail-closed**：`toolSafetyGate.ts:260-268` INTENT 写失败即拒绝执行并记 error（判据口径见 D-18）。
13. **S5 清单（除 hooks/）**：Context（partitions/appendWriter/scoring/assembler/truncation）、Cache、Supervision 六件套、Hook（Services `hookRegistry` + Infra `hookExecutor`）、Pipeline 三件套、Retrieval、Core/Loop 三件套、Session 两件套 **全部存在**。
14. **Gate G5 四条**：`Tests/Runtime/runtime.spec.ts:644,654,728`（十步序列 + 乱序检出）、:368（中间件不可替代监管）、:566-580（LoopConfig 缺字段/超硬上限）、:91-157（S/L/M/H=0.05/0.5/0.3/1.0、92% 才截断、S 区受保护）；`Src/Services/Context/truncation.ts:44,62,124` 阈值 0.92 ✓；`Tests/Core/promptPrefixStability.spec.ts` 对应"S 区前缀哈希不变" ✓。
15. **S6 迁移清单**：`loops(v8)/loop_checkpoints(v9)/verifier_results(v12)/failure_feedbacks(v13)/strategies_ledger(v14)/pending_approvals(v15)/action_fingerprints(events v2)` **7 张表全部存在**且 up/down 齐备。
16. **Gate G6 指纹切换策略**：`Src/Services/LoopControl/actionFingerprint.ts:75,125-126` 连续 `consecutiveDuplicateRounds` 次 → `switch_strategy`；`Configs/loopConfig.json` `consecutiveDuplicateRounds: 3` ✓；死锁保护 :68,77 ✓。
17. **Gate G6 LoopState 不可变区**：`Src/Services/LoopControl/loopState.ts` + ADR-0005 语义（`goal/immutableConstraints` 与可变区分离）落地。
18. **S6 Verifier 四级**：`verifier/{hardVerifier,ruleVerifier,llmJudge,humanGateCore,antiGaming}.ts` 五文件与清单一致；L3 结构化输出含 `{pass, evidence, defectCategory}`（`hardVerifier.ts:167` 的 defect 联合类型、`llmJudge.ts:52,65`）。
19. **S7 清单**：`Services/TokenEconomy/` 六文件（walletManager/tokenLedger/consumptionRecorder/dualBudget/taxCollector/profitDistributor）全在。
20. **Gate G8 四条**：`Tests/EventBus/eventBus.spec.ts:343`（并发写 VERSION_CONFLICT 完整流程）、:274/:373（60s 内 100 次触发 → 熔断）、:177（`MEMORY_VERSION_CONFLICT` 事件断言）；红线 `Src/Services/SharedMemory/writeGuard.ts:21-22` 明确禁写 `goal/immutable_constraints/successCriteria` ✓。
21. **S9/S10/S11/S12 文件清单**：`Core/AgentRuntime/{agentRuntime,agentFactory,agentRegistry,stateMachine}`、`Services/ReviewerAgent/reviewerAgent`、`Core/Decision/{complexityAssessor,routeDecision(+routingRules),taskDecomposer,orchestrator(+progressTracker,resultAggregator,mergePhase,conflictPrecheck)}`、`Services/Recruitment/{recruiter,terminationRationale}`、`Infra/Sandbox/{workspaceIsolator,gitWorktreeManager}`、`Services/Arbitration` 5 件、`Services/Regulation` 4 件、`Services/Audit` 4 件 **全部存在**（目录大小写见 D-11/D-23）。
22. **Gate G9/G10 局部判据**：`Src/Core/AgentRuntime/agentRuntime.ts:150 isTaskApproved` 为唯一"标记成功"入口；`stateMachine.ts` 含审批/失败态；死锁升级 `tribunal.ts:176,347` + `finalArbiter.ts:25,39`（`reason:'deadlock'|'timeout'|'escalation'`）+ `Configs/arbitration.json deadlockTimeoutSec:120` ✓；`Prompts/roles/{worker,reviewer,arbitrator,auditor,regulator}.md` 五份角色提示词齐备。
23. **Gate G12 三条**：`Tests/Judicial/judicialSupervision.spec.ts:117-291` 覆盖六步闭环（含 :198 "律师函 5 分钟内只挂一次"、:268 端到端）；审批超时默认拒绝 `Src/Services/LoopControl/approvalPersistence.ts:13`（"重启残留 PENDING 一律 TIMEOUT，禁止默认通过"）；ADR-0001/0002 文件在。
24. **Gate G13 前两条 + S14 清单**：`approvalGate.ts:54,211-223` 支持 `allRoles`（多角色全覆盖）与 `majority` → CRITICAL 双角色审批**具备**；`RestApi/loopApi.ts:18-25,77` 支持 `traceId` 过滤 → LoopDebugger 回放**具备**；`Client/src/components/` 下 **Dashboard/ TaskPanel/ AgentMonitor/ ArbitrationView/ ApprovalQueue/ LoopDebugger/ TraceReplay/** 七个目录**全部存在**；`Tests/E2E/{loopConvergence,crashRecovery,conflictArbitration}.spec.ts`、`Tests/Durable/faultInjection.spec.ts`、`Benchmarks/{datasets,baselines}/`、`Configs/benchBaseline.json`、`Scripts/{traceAnalysis.ts,rubricRecalibrate.ts}` 与 S14 清单逐条对应（其"有效性"另见 D-41/D-43/D-44）。

> 另：文档引用的上游章节经核对**仍然有效** —— `Docs/Agent/10 §6`（v2 工具契约）、`Docs/Agent/11 §2.2`（判定优先级）、`Docs/Agent/12 §4/§12`（Effect Journal / 测试要求）、`Docs/Agent/09 §8.2`（完整 DDL）、`Docs/Agent/03 §7A`（隔离工作区）、`Docs/Agent/04 §5.2.1`（双预算）、`Docs/Agent/06 §5.1`（防风暴）、`Docs/Client/02-前端改造基础/前端改造方案与构建顺序.md`（F0~F6 定义文件存在）。唯一随重编号失效的是 D-01 的"14 步"。

---

## 回写记录（2026-10-03）

已逐条重新核实并回写 `Docs/Agent/13-构建与实施/项目构建顺序.md`：回写 48/49（D-20 半由代码追平）、【需人工裁定】登记 11（D-09/18/21/24/32/34/37/38/44/47/49）、清单外新差异 1（abortSignal 无实现→Gate G3 改判 ⛔）、未处理 0。工具数 11→14、Configs 14→16 按实测更新。
