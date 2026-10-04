# Agent/15 实验矩阵设计 — 文档-代码差别清单

> 审查日期 2026-10-03 · 审查基准：当前工作区代码（含未提交改动，HEAD=493b005/2026-09-23）
> 文档：`Docs/Agent/15-实验矩阵与评估/实验矩阵设计.md`（18.4 KB / 200 行，含 2026-09-22 校准注 5 条 + 修订记录 1 条）
> 比对对象：`Benchmarks/experimentMatrix.json`、`Scripts/experimentMatrix.cjs`、`Scripts/rubricRecalibrate.ts`、`Scripts/traceAnalysis.ts`、`Tests/Experiments/**` + 13 个 existing-covered 锚定 spec、`Src/**`、`Configs/{security,benchBaseline,durable}.json`、`Docs/Agent/{02,03,07,10,11,13}`

## 摘要

| 分类 | 条数 |
|------|:---:|
| 【文档过时】9-22 校准后代码已变（10-01 审批/安全门改造、10-02 long_term_memory 落库、synchronous FULL、ai_events），文档未跟 | 11 |
| 【声明错误】文档以现状口径陈述，代码实态相反或过度声称 | 5 |
| 【代码未实现】声明的守门/评估能力在代码侧缺失或失效 | 2 |
| 【需人工裁定】口径/语义冲突，须先裁定再决定改文或改码 | 4 |
| **合计差异条目** | **22** |

**总体判断**：本文档 9-22 校准的**六条实质结论没有一条被整体推翻**，但**四条带着需要重做的尾巴**——仍原样成立的有：G0-G13 上界（42 cell 实测最大 G13）、Tools 层 0 处 EffectJournal 引用（四处注释行号一字未变）、ENV-401 真实路径（`Infra/Llm/index.ts:11`/`modelCaller.ts:16` 行号精确）、keyStore 9 导出 + 0 生产调用者、benchBaseline 回填链路 0 消费者、四条 declared-only。需要重做的是：① BEN-TOOL 注里的"fail-open 代码债"子结论已被 10-01 改造**翻转**、② ENV-DBFULL 待办漏了第二处同名用例、③④⑤ 引用的行号（`effectJournal.ts:81-83`、`security.json:19`、`toolSafetyGate.ts:136/152/160`）全部漂移、⑥ §3.3 两处裸 `§x.y` 门禁引用无宿主文档。`node Scripts/experimentMatrix.cjs` 退出码 0 且 §2.2 全部计数逐项复现，13 个 existing-covered 锚定测试**当前全部通过**（14 文件 / 341 例 / 0 失败）——矩阵的"骨架"没有腐烂。

腐烂集中在**两个方向**：

1. **9-22 校准注自身已被 10 月初改造作废一条**：§3.1 BEN-TOOL 注把"INTENT 写失败 fail-open"记为"现状＋代码债"，工作区代码已改为 **fail-closed**（`toolSafetyGate.ts:259-269`，注释"拒绝执行（fail-closed）"；HEAD 版本 `:145-153` 才是 fail-open）。连带影响 §3.2 ENV-DBFULL——"满盘拒绝并**停 Loop**"的运行期证据链在 10-01 之后**实质成立**，但文档仍按"部分覆盖"记，且补断言待办漏掉了第二处同名 DUR-006 用例。
2. **两条 existing-covered 是过度声称，而守门脚本永远查不出来**：BEN-TOOL 锚 `Tests/Tools/tool.spec.ts`（31 例，0 条断言 journal/INTENT）、ENV-DEADLOCK 锚 `Tests/Decision/multiAgentOrchestration.spec.ts`（30 例，无死锁用例，grep `死锁|deadlock` 0 命中）。根因是 `experimentMatrix.cjs:81` 的 anchor 校验只验**文件存在**，不验"该文件是否含对应断言"。

最需要先裁定的语义冲突：**BEN-ORCH 的"五模式"**（代码 `RoutingMode` 6 种、复杂度路由只产出 4 种、E2E 有 6 个模式 spec，"5"两头都对不上）与 **SEC-APPROVAL 未覆盖 10-01 新增的自动审批绕过面**（`forceApprove` 注释明写"忽略多人/双角色策略"，family 恰是 `governance-manipulation`-审批绕过）。

## 差别清单

| 编号 | 文档章节 | 文档声明 | 代码实态(文件:行) | 分类 | 建议处理 |
|----|---------|---------|-----------------|------|---------|
| 1 | §3.1 BEN-TOOL 注（现状＋代码债） | "该处 journal 写入失败为 **fail-open**（`toolSafetyGate.ts:145-153`，INTENT 写失败仅记 error 日志后仍放行 `next(input)` 执行，见 `:149` 注释）…本矩阵只观测不修改" | 工作区已改 **fail-closed**：`Src/Services/LoopControl/middleware/toolSafetyGate.ts:259-269` `if (!intentResult.ok)` → `logger.error('EffectJournal INTENT 写入失败，拒绝执行（fail-closed）')` + `return {status:'error'}`；不再有 `next(input)`。HEAD 版才是文档所述 fail-open（`git show HEAD:…` :145-153，注释"fail-open for journal errors"） | 【文档过时】 | 把该注改写为"已于 2026-10 清偿为 fail-closed（`toolSafetyGate.ts:259-269`）"，代码债条目撤销；在修订记录追加一行说明本次翻转，避免后续审查按旧口径重跑 |
| 2 | §3.2 ENV-DBFULL 注① + §5 末段 | "但锚定测试**未注入满盘**…在此之前，矩阵 JSON 与 §2.2 脚本汇总仍按 `existing-covered` 计数"；判据后半"拒绝并停 Loop"仅记为待验证 | 满盘**拒绝分支**仍在（`Src/Infra/DurableExecution/effectJournal.ts:86-88` → `err('…(DUR-006)…','FATAL')`）；而"停 Loop"侧证据 10-01 起已由 fail-closed 提供（`toolSafetyGate.ts:259-269` 拒绝执行＝该轮副作用被中止）。仍**无**任何测试注入 `disk full` | 【文档过时】 | 注①改为"拒绝分支 + 运行期停 Loop（fail-closed）两侧成立，唯缺满盘注入断言"；待办保留但收窄为"仅需补注入用例" |
| 3 | §3.2 ENV-DBFULL 待办（补断言） | 待办只指 `Tests/Durable/faultInjection.spec.ts:211` 一处 | 第二处同名用例存在且同样过度命名：`Tests/E2E/crashRecovery.spec.ts:167` `it('DUR-006: Effect Journal 满盘 → 拒绝新副作用')` 内部注释 `:169-171`"由于无法直接模拟磁盘满…通过正常写入验证 journal 工作"，断言 `expect(r.ok).toBe(true)` | 【文档过时】 | 待办改为"两处 DUR-006 用例（faultInjection.spec.ts:211 / crashRecovery.spec.ts:167）均需注入满盘或改名"；后者命名与断言不符本身是独立测试债 |
| 4 | §3.1 行号锚 | `toolSafetyGate.ts:16`（import）/`:136`（写 INTENT）/`:152`/`:160`（更新状态） | `:16` 仍精确命中 ✓；其余漂移：`if (dangerLevel !== 'SAFE')` 现 `:243`、`recordIntent` `:248`、`updateEffectStatus` `:272` 与 `:279`。中间新增 FORBIDDEN 硬拒（`:102-111`）与自动审批分支（`:132-207`） | 【文档过时】 | 行号刷新为 `:16/:243/:248/:272/:279`，并改为"符号锚"（函数名+语句）以降漂移敏感度 |
| 5 | §3.2 注① 行号锚 | 满盘分支在 `effectJournal.ts:81-83` | 实际 `:86-88`（新增 `toolCallId` 列写入 FE-027 使 `recordIntent` 变长，`:67-68`/`:79`） | 【文档过时】 | 刷新为 `:83-90`（整个 catch 块）或按 `DUR-006` 字面量定位 |
| 6 | §5 注③ 行号锚 | "`KEY_LEAKAGE` 仅作为 `Configs/security.json:19` 的 `criticalSecurityEvents` 配置标签存在" | 结论成立，行号已漂：`Configs/security.json:24-27`（`criticalSecurityEvents` 块因 10-01 新增 `security.autoApprove`（`:20-24`）整体下移） | 【文档过时】 | 行号刷新；结论无需改动 |
| 7 | §3.1 BEN-BOOT（假设列/JSON objective） | "空配置可启动，**14 步**无 FATAL"（JSON `BEN-BOOT.objective` 同写"14 步初始化链"） | `Src/main.ts` 启动序列实际编号到 **⑱**（`:68`①、`:123`⑤、`:268`⑭、`:272`⑮、`:324`⑯、`:349`⑰、`:358`⑱）；`Docs/Agent/02 §7.1` 已改为"**启动 18 步**（与 `Src/main.ts` 实际代码对齐）"（`:478-502`） | 【文档过时】 | 文档表格与 `experimentMatrix.json` 的 BEN-BOOT 文本统一改 18 步（或改述为"启动全链无 FATAL"以规避数字漂移） |
| 8 | §3.1 BEN-MEM / §3.3 SEC-CTXPOISON（模块列） | 模块列 = `Services/SharedMemory/writeGuard`；SEC-CTXPOISON 方法 = "isEligibleForLongTerm(inferred) + interceptWrite inferred 警告" | "进/不进长期记忆"的**真实执行点**已在 10-02 落库改造后上移到 `Src/Services/SharedMemory/longTermMemory.ts:82-85`（`if (!isEligibleForLongTerm(assertion)) return err('…§8.4：仅 observed 可入')`）+ `longTermMemoryStore.ts:114 persistMemory`（写 `long_term_memory` 表，migration v17/v21）。writeGuard 只提供资格谓词 | 【文档过时】 | 模块列扩为 `Services/SharedMemory/{writeGuard,longTermMemory,longTermMemoryStore}`；BEN-MEM 判据补"落库行存在"一项 |
| 9 | §1.4/§3 全表（隐含）矩阵与测试资产同步 | 文档声明 `existing-covered`＝"既有测试已覆盖" | 10 月新增的落库/事件测试**完全未纳入矩阵锚定**：`Tests/Services/longTermMemoryPersistence.spec.ts`（写入即落库/重启回灌/计数器恢复/`fail-safe：数据库不可用时写入仍成功`）、`Tests/Services/longTermMemoryOwnership.spec.ts`、`Tests/LoopControl/toolSafetyGate.spec.ts`（含 `:187` 自动审批白名单用例）、`Tests/Interface`（`ai_events` 链路）。`Benchmarks/README.md:25` 要求"新增/删除测试须同步更新 experimentMatrix.json"，未执行 | 【文档过时】 | 为 BEN-MEM/SEC-CTXPOISON/SEC-APPROVAL/BEN-API 重锚或增补锚点；在 §2.2 后加"锚定资产清单快照日期" |
| 10 | §3.1 BEN-TOOL（状态列 `existing` / JSON `existing-covered`） | "既有测试已覆盖"，锚 `Tests/Tools/tool.spec.ts` | 该文件 31 例**无一条**断言 EffectJournal：`grep 'INTENT\|effectJournal' Tests/Tools/tool.spec.ts` 仅命中头注释 `:8`；`:326` 断言的是 `result.effects`（工具自声明列表，非 journal）。真实写入方在 middleware，而 `Tests/LoopControl/toolSafetyGate.spec.ts`（234 行 / 6 例）也只 `import { initEffectJournal }`（`:22`），**不断言** INTENT/SUCCEEDED/幂等键。即"读写均落 EffectJournal + 幂等键正确"在全仓 0 断言 | 【声明错误】 | 状态降级为 `new-scaffold`（并在 `toolSafetyGate.spec.ts` 补 INTENT 断言 + `@matrix:BEN-TOOL` 标签）或 `declared-only`；同时 §3.1 状态列与 JSON 必须同改 |
| 11 | §3.2 ENV-DEADLOCK（状态 `existing`） | "既有测试已覆盖"，锚 `Tests/Decision/multiAgentOrchestration.spec.ts`，方法"构造 A 等 B、B 等 A" | 该文件 30 例覆盖 ComplexityAssessor / RouteDecision / TaskDecomposer / ProgressTracker / ResultAggregator / TerminationRationale，`grep '死锁\|deadlock\|DEADLOCK'` **0 命中**。"命中风险退出"的实际可断言点是 `Src/Services/LoopControl/stopRules.ts:112-120 checkRisk`，其测试在 `Tests/E2E/loopConvergence.spec.ts:151`（`riskSignals:['disk_full']` → `reason==='risk'`）——**另一文件** | 【声明错误】 | 二选一：改锚到 `Tests/E2E/loopConvergence.spec.ts`（诚实但降级为"风险退出"而非"互相回传"），或把该 cell 改 `new-scaffold` 并在 `Tests/Experiments/adversarial/envFault.spec.ts` 补 A↔B 用例 |
| 12 | §3.2 ENV-429（判据列） | 判据"退避后**切换备选 provider 成功**" | `Tests/Infra/llm.spec.ts:99-104` 断言的是决策标志 `decision.fallbackToNext === true`（`getRetryDecision`），未驱动 `modelRouter.getFallbackProviders()` 完成真实切换（`:228-237` 另例只验证 fallback 列表构造）。候选真锚：`Tests/Infra/providerMultiInstance.spec.ts`（未被矩阵引用） | 【声明错误】 | 判据改述为"退避决策置 fallbackToNext=true"，或把 anchor 扩到 providerMultiInstance.spec.ts 后保留原文 |
| 13 | §1.2 注（2026-09-22 校准） | "gate 取值上界为 **G0-G13**…**G14** **仅**见于 `Docs/Agent/13-构建与实施/项目构建顺序.md`" | "上界 G13"经脚本与 JSON 双向复核**成立**（42 cell 的 gate 全集实测最大 `G13`，无 G14）；但"仅见"不成立：`Benchmarks/README.md:9` 仍写"每个 cell 锚定…门禁（**G0-G14** / DUR-*）"，`Docs/CHANGELOG.md:344` 同写 G0-G14 | 【声明错误】 | 文档内"仅见于"改为"另见 Benchmarks/README.md:9 与 Docs/CHANGELOG.md:344 的过期口径"；建议同批改这两处（属本条待办的连带清偿） |
| 14 | 前言 line 7 | "机器可读的单一事实源为 `Benchmarks/experimentMatrix.json`，**本文所有表格与之对齐**" | 至少 3 处分叉且文档自己已在注中承认：`BEN-TOOL.module`（文档 `Infra/DurableExecution + Services/LoopControl/middleware` vs JSON `Tools, Infra/DurableExecution`）、`ENV-401/ENV-NETPART.module`（文档 `Infra/Llm/Provider/retryPolicy` vs JSON `Core/Model/retryPolicy`）、`ENV-DBFULL.status`（文档 `existing（部分）` vs JSON `existing-covered`） | 【声明错误】 | 前言加一句"以下 N 行文档口径已领先 JSON，JSON 待回写（保持 §2.2 计数不变）"，或直接把三处回写 JSON 后恢复"完全对齐" |
| 15 | §2.2 校验结果 | 引用块 5 行，末行"✓ 覆盖校验通过：每面 BEN+对抗齐备、六类对抗家族全覆盖、anchor 可解析。" | 实际 stdout 多 2 段且末行不同：标题行 `=== Civitas-AI 实验矩阵覆盖报告 ===`、`-- declared-only 缺口（后续排期）--` + 4 条明细；末行为"✓ **实验矩阵**覆盖校验通过：…"（`Scripts/experimentMatrix.cjs:114/:122-125/:133`）。**全部计数一致**：42/12/6、BEN13/ENV12/SEC17、20/18/4、25/29 ✓ 退出码 0 ✓ | 【文档过时】 | 引用块替换为真实全量输出（含缺口清单），或在块上标"（省略标题行与缺口明细）" |
| 16 | §2.1 四条硬规则 | 列规则 1~4，称"由脚本强制，违反则退出码非 0" | 脚本另有文档未列的**规则 0：逐 cell 结构校验**（`experimentMatrix.cjs:62-88`：必填 11 字段、id 去重、cls/status/surface/dim/family 合法性），且规则 4（`:104-125`）只是**汇总打印**、不产生非 0 退出 | 【文档过时】 | §2.1 补"规则 0（结构校验）"并标注"规则 4 为汇总、不参与判定" |
| 17 | §2.1 规则 3 / §1.5 anchor 语义 | "每个 cell 必须有 `oracle`，且 `anchor` 可解析（spec **文件存在** / tag 出现 / declared-only）"——文档措辞与脚本一致，但矩阵语义把"文件存在"等同于"已覆盖" | `experimentMatrix.cjs:79-81` `existing-covered` 仅做 `fs.existsSync(ref)`。差异条目 10/11/12 正是此漏口；42 cell 中 18 条走该分支，**无一条**被验证含对应断言 | 【代码未实现】 | 守门脚本升级：对 spec 锚做 oracle 关键字/用例名 grep 断言（最低要求：文件内含 `it(` 标题命中 cell 的 DUR/G/safety ID 或 oracle 关键词），使本次这类过度声称下次能被机器捕获 |
| 18 | §6 如何运行 / 结果回填链路（配套评估资产） | §6 只列 vitest + experimentMatrix.cjs（两者**均可运行**✓）；六维指标链路的另一半是 S14 的 `Scripts/rubricRecalibrate.ts`（`Docs/Agent/13:397`、`Scripts/README.md:8` 声明可运行并更新 `Skills/rubrics/`） | **该脚本无法执行**：`Scripts/rubricRecalibrate.ts:113` `result.consistencyRate.toFixed(1%)` 语法错误 → `npx tsx Scripts/rubricRecalibrate.ts` 抛 `Transform failed with 1 error: …:113:67: ERROR: Unexpected ")"`。`Skills/rubrics/verifierL3Calibration.json` 存在但无生成方 | 【代码未实现】 | 修 `:113` 为 `toFixed(1)`；本 doc §6 或"已知缺口"补一句"S14 评分重校准脚本当前不可运行 ⇒ 六维回填无上游" |
| 19 | §6 末段回填链路 | "结果应回填 `Configs/benchBaseline.json` 的六维评分与劣化阈值告警链路"，注中标为流程性/待建（**已核实仍成立**） | 同注复核通过（见抽查项）。补充事实：`Scripts/traceAnalysis.ts` 虽可运行，但独立进程里读的是**进程内内存事件表**（`eventBus.ts:117 getEventLog`），CLI 实跑输出 `totalTraces: 0`；10 月落库的事件持久层 `ai_events`（`migrations.ts:453`，`Interface/EventStore/aiEventStore.ts:96`）**未被 traceAnalysis 读取** ⇒ 评估侧无法离线回放 trace | 【需人工裁定】 | 裁定 traceAnalysis 的数据源：改读 `ai_events`（持久层）还是保留内存态（仅进程内诊断）；并在 §6 注明"回填需先解决 trace 数据源" |
| 20 | §3.3 Gate 列 | `SEC-REWHACK` 门禁写 `§3.4`、`SEC-CTXPOISON` 门禁写 `§8.4`（JSON 分别为 `G6/§3.4`、`G8/§8.4`），文档未标宿主 | 本文档**无 §3.4 / §8.4**（仅 3.1/3.2/3.3）。真实所指：`Docs/Agent/11-循环控制系统` §3.4 "Reward Hacking 防御"（`:280`）、`Docs/Agent/07-共享记忆与上下文系统` §8.4 "Self-Reinforcing 防御"（`:652`，且 `longTermMemory.ts:82` 注释即引 §8.4）。三分类重构后裸 §x.y 的归属更易误读 | 【需人工裁定】 | 在 §1.2 `gate` 字段说明中定义 `§x.y` 语义并要求带文档前缀（如 `Agent/11 §3.4`），表内两格同步改写 |
| 21 | §3.1 BEN-ORCH（假设列/JSON objective） | "**五模式**按复杂度路由聚合"（JSON："五种编排模式按复杂度正确路由与聚合"） | 三个数都对不上：`Src/Core/Decision/types.ts:12-18` `RoutingMode` 为 **6** 种（DIRECT/DELEGATION/CONSORTIUM/ASSEMBLY_LINE/LITIGATION/REGULATION，注释自标"Docs/Agent/03 §3.3 · 6 种"）；而复杂度路由器 `routeDecision/routeDecision.ts:31-88` 只产出 **4** 种（优先级 1~5 兜底 DELEGATION）；E2E 侧 `Tests/E2E/` 有 6 个模式 spec（directExecution/delegationMode/consortiumMode/assemblyLineMode/litigationMode/regulationAuditMode） | 【需人工裁定】 | 先裁定口径：若 cell 意在"复杂度可路由集合"→改 4 并注明 LITIGATION/REGULATION 为治理触发；若意在"编排模式全集"→改 6。改定后同步 JSON 与 `multiAgentOrchestration.spec.ts:133-206` 覆盖度 |
| 22 | §3.3 SEC-APPROVAL（假设/判据/方法） | "审批超时无应答默认拒绝（禁自动通过）"，判据"状态 TIMEOUT 非 APPROVED；CRITICAL 需 2 角色 unanimous" | 超时默认拒绝 ✓（`approvalGate.ts:265-285`）；CRITICAL ≥2 角色 ✓（`createApproval` 校验，`Tests/Experiments/adversarial/security.spec.ts` @matrix:SEC-APPROVAL 断言单角色创建失败）。**但 10-01 新增了运行期审批绕过面**：`toolSafetyGate.ts:186-207` 命中 `autoApproveTools` 即 `forceApprove(...)`，`approvalGate.ts:236-261` 注释明写"**策略性通过：忽略多人/双角色策略**，直接落 APPROVED"（配置入口 `Configs/security.json:20-24 security.autoApprove`）。该 cell family=`governance-manipulation`（审批绕过）却不覆盖此面 | 【需人工裁定】 | 裁定"自动审批白名单"是否属允许设计：若是，SEC-APPROVAL 需增补第二条 oracle（白名单为空/未命中时不得绕过 + `autoApproved` 标记可审计）；若否，属代码缺陷（另立 P1）。`Tests/LoopControl/toolSafetyGate.spec.ts:187` 已有正例、无对抗例 |

## 未发现差异的抽查项

以下声明逐条 grep/read/ls 复核后**与当前工作区代码一致**（9-22 六条校准注中被推翻的只是子结论，其主体结论在此复验仍成立）：

**矩阵骨架与脚本**
- §2.2 全部计数：`node Scripts/experimentMatrix.cjs` 退出码 0，输出 `cells 42 | 面 12 | 家族 6`、`BEN=13 ENV=12 SEC=17`、`new-scaffold=20 existing-covered=18 declared-only=4`、对抗落地率 `25/29` —— 与文档逐字一致。
- §1.2 `gate` 上界：42 cell 的 gate 全集实测 `{G0…G13, M1, M2, DUR-001/003/006, ADR-0003/0004/0005, safety-001/002, security.json, §3.4, §8.4}`，**最大 G13**（BEN-API `G13/M2`），无任何 cell 锚 G14 ✓。
- §1.3 六类对抗家族、§1.4 十二系统面与 JSON `adversarialFamilies`/`surfaces` 字面完全一致；§1.5 三态与 `anchor.kind` 的绑定关系由 `experimentMatrix.cjs:79-87` 逐条强制 ✓。
- 20 条 `new-scaffold` 的 `@matrix:` 标签全部存在且无多余：`Tests/Experiments/{benign/matrixBenign,adversarial/envFault,adversarial/security}.spec.ts` 命中 20/20，missing=∅、extra=∅；`npx vitest run Tests/Experiments` → **20 passed**。
- §6 两条命令均可运行（vitest 通过、校验器退出码 0）。

**13 条 existing-covered 锚定测试当前全绿**（14 文件 / 341 例 / 0 失败，含 `Tests/gateG0.spec.ts` 8、`Tests/Tools/tool.spec.ts` 31、`Tests/Durable/faultInjection.spec.ts` 9、`Tests/Infra/llm.spec.ts` 30、`Tests/Infra/security.spec.ts` 等；`realAgent.spec.ts` 4 例为真实 LLM 调用、耗时 150 s 仍通过）。

**§3.1 BEN-TOOL 注的模块/引用面结论仍成立**
- `Src/Tools/` 子目录仍恰为 `Builtin/ Custom/ Factory/ Registry/ Traits/`（+ `index.ts`/`builtinLoader.ts`），`Tools/Durable` 不存在 ✓。
- Tools 层 `EffectJournal` 引用仍为 **0 import / 4 注释**，四处行号一字未变：`Builtin/Write/fileWriter.ts:4`、`Builtin/Write/fileEditor.ts:4`、`Traits/specValidator.ts:8`、`Traits/toolSpec.ts:100` ✓。
- 更正后的模块列 `Infra/DurableExecution + Services/LoopControl/middleware` 与实际相符；`Src/Infra/DurableExecution/effectJournal.ts` 存在 ✓。

**§3.2 注② ENV-401/ENV-NETPART 四处锚点全部命中**
- `Src/Core/Model/` 下确无 `retryPolicy.ts`（仅 `abortSignal/contextHistory/index/modelCaller/sessionNamer/streamParser`）；ENV-TIMEOUT 的 `Core/Model/abortSignal` 反而真实存在 ✓。
- 真实文件 `Src/Infra/Llm/Provider/retryPolicy.ts` ✓；`Src/Infra/Llm/index.ts:11` 转发 `getRetryDecision/delay/classifyNetworkError` ✓（行号精确）；`Src/Core/Model/modelCaller.ts:16` import 消费 ✓（行号精确）。
- ENV-429 模块 `Infra/Llm/Router/modelRouter.ts` 存在 ✓。

**§5 SEC-KEYLEAK / 注③ keyStore（含行号）全部命中**
- `Src/Infra/Security/keyStore.ts` 实导出 9 函数 + 3 类型，9 个行号逐个一致：`registerKey:61 / resolveKey:76 / isKeyAvailable:114 / getMaskedKey:123 / resolveSingleRef:138 / isKeyRef:156 / clearKeyStore:163 / getRegisteredKeyNames:171 / scanAndRegisterRefs:181`，类型 `KeyRef:22 / ResolvedKey:25 / KeyEntry:35` ✓。
- `grep 'KEY_LEAKAGE|leakage|redact|maskSecret|scanSecret' Src/**/*.ts` → **0 命中** ✓；`keyStore` 在 `Src/` 生产调用者 **0**，全仓唯一引用者 `Tests/Infra/security.spec.ts:20` ✓。
- 四条 declared-only（ENV-TIMEOUT/ENV-NETPART/ENV-PDOWN/SEC-KEYLEAK）与 JSON 的 status/anchor.kind=none 一一对应，§5 表 4 行无多无漏 ✓。

**§6 末段回填链路（9-22 注）**
- `Configs/benchBaseline.json:19` `degradationThreshold{alertRatio:0.05, blockRatio:0.10}` ✓ 行号精确。
- `Src/ Scripts/ electron/ Client/src/ Server/` 对 `benchBaseline / degradationThreshold / alertRatio / blockRatio` **0 读取** ✓（唯二命中：`Client/src/config/configSchema.ts:8` 注释声明"未纳入"、`Tests/gateG0.spec.ts:30` 文件存在性校验）。
- `configLoader` 只加载 `default.json`（`:56`）与 `local.json`（`:73`），benchBaseline 不在清单内 ✓；交叉引用 `Docs/Agent/10 §1.1`（`:43-44`）确实声明同一结论 ✓。

**§4 实现约定的契约面（8 项逐一核实存在且签名相符）**
- `checkPath.allowed`（`pathGuard.ts:99` + `PathCheckResult.allowed:44`）、`isToolAllowed`（`trustLevels.ts:199`，被 `Tools/Factory/toolFactory.ts:14/51/97` 消费）、`checkAntiGaming → {passed, violations}`（`antiGaming.ts:45-49`）、`checkViolation → violated` + `safety-001/safety-002`（`behaviorCode.ts:46/55/134-135`）、`interceptWrite`（`writeGuard.ts:33`）、`checkTimeoutApprovals → status='TIMEOUT'`（`approvalGate.ts:265-285`）、`isFrozen`（`freezeManager.ts:137`）、`runVerifierPipeline → levelsRun/allPassed` 且 L1 不过禁跳 L3（`verifier/index.ts:44-99`、ADR-0003 注释 `:5`）。
- "Maker-Checker 有运行时点"：`verifier/llmJudge.ts:42` `if (spec.payload.model === ctx.producerModel)` → err ✓（注释 `:28` 引 ADR-0004）。
- "不引用不存在的 EventType"：`security.json:24-27` 的三标签在 `eventTypes.ts` 中确不存在 ✓（§4 告诫成立）。
- "测试隔离"：`writeGuard/dualBudget/circuitBreaker/timeService` 无 DB import ✓；`Tests/Experiments/adversarial/envFault.spec.ts:61` 用 `vi.spyOn(Date,'now')`、`:22 afterEach → vi.restoreAllMocks()` ✓；`approvalGate` 的落库写穿为 fail-safe（`approvalPersistence.ts:91-131` 包 try/catch + `isDatabaseInitialized` 门 `:16`），实测 security.spec 无落库噪声 ✓。
- "不触碰 Src"：矩阵资产确为纯新增，但**反向已被违反其前提**——Src 自身在同期被改（见差异 1/22），文档"本矩阵只观测不修改"的表述应限定为"矩阵不改动 Src"而非"Src 不变"。

**§3.2/§3.3 其余行**
- ENV-CRASHMID/ENV-CHKPTTORN 的 DUR-001/002/003/004/005 用例与 `checkpointStore.ts`、`recoveryScanner.ts` 均在位，`faultInjection.spec.ts` 9 例通过 ✓。
- BEN-CONV "五类退出"与 `stopRules.ts:72` `['risk','limits','budget_hard','no_progress','success']` + `loopConvergence.spec.ts:163-165` 优先级链断言一致 ✓；BEN-LOOPSEQ "10 步严格按序"与 `Src/Core/Loop/runIteration.ts:7/322`（十步主循环）+ `Tests/Runtime/runtime.spec.ts:644/654/728` 一致 ✓。
- BEN-GOV "六步治理闭环"与 `Tests/Judicial/judicialSupervision.spec.ts:123-268`（Step1 立案→Step6 知识沉淀 + 端到端六步）逐一对应 ✓。
- §4 "PRAGMA synchronous FULL"未被本文档声称，实测已生效（`Configs/durable.json:18 writeSynchronous:"FULL"` → `main.ts:129-138` → `database.ts:60/146-147`），属 Agent/12 的口径，与本文档无冲突 ✓。

**Docs/ 编号引用（三分类重构后）**
- 前言 `../../../Benchmarks/experimentMatrix.json`、`../../../Scripts/experimentMatrix.cjs`、`../../../Configs/benchBaseline.json` 三个链接**在当前深度（Docs/Agent/15/）才可解析**——文档由 `Docs/17-…` 迁入 `Docs/Agent/15-…` 后层级 +1，链接恰好转正（原层级会越出仓库根）✓ 无需改动。
- `../13-构建与实施/项目构建顺序.md`（文档内引用为 `Docs/Agent/13`，原 `Docs/14`）与 `../10-配置体系与安全/配置体系与安全设计.md`（文档内引用为 `Docs/Agent/10`，原 `Docs/11`）两处编号已按新目录体系改写正确、目标文件均存在 ✓。

---

## 回写记录（2026-10-03）

已逐条重新核实并回写 `Docs/Agent/15-实验矩阵与评估/实验矩阵设计.md`：回写 18/22、【需人工裁定】登记 4（#19/20/21/22）、未处理 0。fail-open→fail-closed 翻案、ENV-DBFULL 降级、G14 过期口径等已按实态更正；修订历史追加 2026-10-03 行。
