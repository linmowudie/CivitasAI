# Benchmarks — Agent 能力评估与问题诊断

> **与 `Tests/` 的分工（务必先读）**
>
> | | [`Tests/`](../Tests/) | `Benchmarks/` |
> |---|---|---|
> | 实验对象 | 函数 / 模块 / 接口 | **一个 Agent 跑一个任务**（能力轴）／**系统判定点**（系统轴） |
> | 测什么 | 传统 bug 与业务正确性 | Agent **行为** + 九系统**判定点** |
> | 判据 | 断言返回值 / 状态 / 事件 | 行为观测 + L0 静态对账 + 指标阈值 |
> | 输出 | 红 / 绿 | **指标 + 轨迹 + 问题诊断 + 能力评分** |
> | 驱动方式 | 直接调函数 / `vi.mock` | **桩 Provider 驱动真实 `executeLoop`**（可选真实模型） |
>
> 两者**不是一套系统**：把 Benchmark 当成"给测试套一层矩阵"，就会把平台就绪检查
> （"启动配置齐备"）和 Agent 行为（"会不会空转"）混在一张表里，判据也接不上被评估对象。
>
> 依据：《[九系统检验方案与实验矩阵扩展](../Docs/Agent/15-实验矩阵与评估/检验方案与实验矩阵扩展-qodercn-20261011T234339.md)》（§2 方法论 / §3 九系统 / §5 资产）。
>
> **分工的权威措辞（项目负责人裁定 2026-10-14）**：
> **Benchmark 测的是 Agent 的数据流转问题，确保 Agent 没有问题；Tests 测的是接口能不能正常调用、代码有没有写漏内容。**
> 由此推出两条硬约束：
> 1. **调用层规**——只能调用**被测层之上**的接口驱动实验（测工具 → 经 Core/Loop 调；测单 Agent → 从 Core/Interface 调）；
>    **层下探针只用于监控、不用于驱动**。
> 2. **静态形态核对归 Tests 领域**——「代码里还有这段形态」属「代码有没有写漏」，在矩阵里只能记 `attestation=static`，
>    不得计入 Benchmark 落地率。

## 两层结构

```
场景（Benchmarks/scenarios/*.json）+ 探针 + 检索套件
   │
   ▼
【第 1 层 · 实验矩阵】Experiment Matrix —— 准入
   逐 cell 判定通过与否 + 观测值
   · 未过 → 只出诊断（诊断 Agent 问题），不进评分
   · 过了 ↓
【第 2 层 · 打分矩阵】Scoring Matrix
   按**适用**维度加权 → 0-1 总分 + 等级（A/B/C/D/E）+ 报告
```

**「过了实验矩阵才到打分矩阵」是硬闸门**：未放行场景不进评分分布。

## 双轴

第一层由**两条轴**构成，共用一张 `cells` 表（`axis` 字段区分、`surface` 分组）：

| 轴 | 问的问题 | 面 | 锚点形态 |
|---|---|---|---|
| **能力轴**（18 cell） | 一个 Agent 跑一个任务，**行为**对不对？ | 6 | `kind:"scenario"` |
| **系统轴**（47 cell） | 文档 §3 九系统逐节的**判定点**成不成立？ | 9 | `kind:"static"`（L0）／`scenario`／`none` |

能力面：目标收敛 · 工具使用 · 约束保持 · 故障恢复 · 治理行为 · 成本纪律
系统面：工具系统 · 检索系统 · 监管系统 · 单 Agent 记忆系统 · 单 Agent 系统 · 子 Agent 系统 · Agent 分裂系统 · 多 Agent 记忆系统 · 完整多模态与可观测

每个面至少一个 BEN（非对抗）与一个 ENV/SEC（对抗）；六类对抗家族
（injection / integrity / availability / privilege-escalation / governance-manipulation / data-poisoning）全覆盖。

**为什么系统轴多用静态锚**：九系统里大量判定点是**静态事实**（「`sandboxMode` 无消费方」「`freezeWallet` 零调用者」），
任何场景都压不到。用场景去"证"这类事实，只会得到"看起来跑了但其实没测到"的假覆盖。

## 四种实验形态

| 形态 | 声明方式 | 测什么 | 例子 |
|---|---|---|---|
| **回路实验**（11） | 默认 | Agent 行为（收敛/工具/约束/成本…） | `scn-convergence-basic` |
| **记忆探针**（1） | `memoryProbes` | 记忆写侧红线 / 乐观锁 / 治理键分级 | `scn-memory-governance` |
| **检索套件**（1） | `retrievalSuite` | golden set 上的 Recall@K / MRR | `scn-retrieval-golden` |
| **混沌注入**（2） | `closeDbAfterIteration` / `clockSkewProbe` | DB 不可用、时钟回拨 | `scn-db-unavailable`、`scn-clock-rewind` |

后三种用于压**判定点**（检索结果当前不进 prompt，Agent 行为层压不到写侧/检索侧），
与能力轴的分工一致：**能力轴测行为，系统轴测判定点**。

## 文件

| 路径 | 内容 |
|---|---|
| `experimentMatrix.json` | **第 1 层**：`cells`（双轴）；`prerequisites`（42 条平台就绪前置，锚 `Tests/**`，与两轴严格分开） |
| `scoringMatrix.json` | **第 2 层**：维度 / 权重 / 等级阈值 / 适用性铁律 |
| `scenarios/*.json` | 场景：任务 + 桩模型脚本 + 注入的故障 + 判据（`expect`）；`matrixCells` 声明承载哪些 cell |
| `runner/stubProvider.ts` | 脚本化 `LlmProvider`：注册进路由后**真实主循环照跑**；无 API Key、可复现 |
| `runner/probeTools.ts` | 探针工具（`bench.echo/read/fail`）：把路径守卫、沙箱权限等**环境因素排除出被判对象** |
| `runner/retrieval.ts` | 检索质量套件（seeding + Recall@K / MRR） |
| `runner/harness.ts` | 组合根子集（三库+迁移+事件总线+路由+工具表+缓存端口+Token 经济+Loop 规则+时间服务）→ 采集轨迹 |
| `runner/run.ts` | 两层 CLI：准入判定 → 诊断 → 评分 → JSON/Markdown 报告 |
| `runner/selftest.ts` | **实验台自测**（43 项断言） |
| `runner/types.ts` | 场景 / 轨迹 / 判据 / 诊断 / 评分契约 |
| `reports/latest.json` · `latest.md` | 最近一次**全量**运行的机读 / 人读报告（单场景运行只写时间戳文件，不污染指针） |
| `baselines/metrics.json` | 基线：Agent 指标 + 矩阵覆盖 + **NOT-RUN** + **检索质量** |
| `baselines/notRun.json` | 缺凭据 NOT-RUN 清单与**有效通过数**（§2.2 铁律 1 的产物） |
| `datasets/` | `retrievalGoldenSet.json`（36 查询）/ `memoryPoison.json`（20 种子）/ `adversarialSeeds.json` / `sampleTasks.json` |

## 运行

```bash
npm run bench:run                       # 跑全部场景（两层流程 + JSON/Markdown 报告）
npm run bench:run -- --scenario=<id>    # 只跑一个场景（不覆盖 latest.* 指针）
npm run bench:run -- --json             # 只输出机读结果

npm run bench:matrix                    # 实验矩阵守门（结构 + 锚点 + 双向一致性）
npm run bench:matrix:strict             # 严格模式：弱锚（仅文件存在）也判违规
npm run bench:static                    # L0 静态对账（九系统判定点）
npm run bench:metrics                   # 重新采集基线
npm run bench:metrics:check             # 基线一致性（CI 用）
npm run bench:notrun                    # NOT-RUN 汇总（缺凭据用例不计通过）
npm run bench:selftest                  # 实验台自测（保护测量仪器本身）
npm run bench:typecheck                 # 运行器类型检查（tsx 只转译，必须显式跑 tsc）
npm run bench                           # = selftest + matrix + metrics:check
```

## Agent 数据流转链路视图（裁定⑤）

> **Benchmark 测的是 Agent 的数据流转问题，确保 Agent 没有问题；Tests 测的是接口能不能正常调用、代码有没有写漏内容。**
>
> 因此系统轴的 cell 按**链路阶段**组织：每个 cell 必须说明它测链条的哪一环（守门强制）。
> 纯静态形态核对（`attestation=static`，**6 条**）只证明"那段代码还在"，属 **Tests 领域**，
> **不计入落地率**，也不在此视图中冒充链路覆盖。

| 阶段 | 含义 | cell 数 | 其中实测落地 | cell |
|---|---|---|---|---|
| `input` | 输入：进入 Agent 的东西（时间源、外部输入） | 5 | 2 | `AGENT-BEN-STATE` · `AGENT-SEC-IDREUSE` · `AGENT-ENV-SUBMITGATE` · `AGENT-ENV-L3REAL` · `MEM1-ENV-CLOCK` |
| `decide` | 决策：监管/循环控制/编排/模型调用/上下文装配 | 8 | 1 | `RET-ENV-EMBDOWN` · `SUP-BEN-APPROVAL` · `SUP-ENV-HUMANGATE` · `SUP-ENV-DEADLOCKWIRE` · `MEM1-BEN-COMPRESSVETO` · `SUB-BEN-RECLAIM` … |
| `act` | 执行：工具契约、注册、派发、守卫 | 9 | 2 | `TOOL-BEN-SCHEMA` · `TOOL-SEC-L4GATE` · `TOOL-SEC-EGRESS` · `TOOL-SEC-SANDBOX` · `TOOL-SEC-RATE` · `TOOL-ENV-TIMEOUT` … |
| `remember` | 记忆：共享记忆、长期记忆、检索、分区 | 12 | 5 | `RET-BEN-GOLDEN` · `RET-SEC-SOURCE` · `RET-ENV-LATENCY` · `MEM1-GAP-PARTITION` · `MEMN-BEN-CONSOLIDATE` · `MEMN-SEC-READAUTH` … |
| `emit` | 留痕：事件、trace、审计、账本、幂等/检查点 | 7 | 1 | `SUP-SEC-FREEZEPERSIST` · `SUP-SEC-FREEZEWALLET` · `SUP-SEC-AUDITCHAIN` · `MEM1-GAP-RESTORE` · `MM-GAP-TRACE` · `MM-GAP-EVENTSTABLE` … |
| `output` | 输出：面向外界的产出（当前系统轴暂无独立 cell） | 0 | 0 |  |

**无实现的 16 条**（`flowStage=none`，`module=（待实现）`）：没有代码就没有链路位置，不硬塞。
其中 15 条为分裂/多模态声明态（面 H/I），另 1 条为跨 Agent 检索等缺口。

**断点提示**：`output` 阶段**没有任何 cell** —— 当前系统轴不度量"Agent 的产出是否正确交到外界"，
这是链路视图暴露出的一个真实空白（不是缺陷，是尚未建面）。


## 状态与证据模型（三态 + 静态/实测裁开）

两个**正交**维度，禁止混用：

| 维度 | 取值 | 含义 |
|---|---|---|
| **status** | `existing-covered` | 由**既有**测试/实验承载 |
| | `new-scaffold` | 由**新写**的实验骨架承载（`// @matrix:<ID>` 标签锚） |
| | `gap` | **产品缺失**：oracle 今天必红，用于登记代码债（不进 CI 阻断） |
| | `declared-only` | 产品零实现，只登记语义与验收契约 |
| **attestation** | `executed` | Benchmark 场景**真实跑过**（锚点 `kind=scenario`） |
| | `static` | 仅 L0 静态对账（锚点 `kind=static`；归 Tests 领域的"代码有没有写漏"） |
| | `tests` | 由 `Tests/**` 承载（锚点 `kind=spec/tag`） |
| | `none` | 无承载物 |

**硬绑定**：`attestation` 必须与 `anchor.kind` 一致，守门会拦下不符的组合。

```
落地率 = existing-covered ∧ attestation=executed      ← 只计实测
static-attested 单列                                  ← 不算落地
```

**为什么必须裁开**：一条 cell 可以"代码里确实有这段形态"却"从未真跑过"。
若把两者都记作"已覆盖"，就会重演本项目反复出现的假绿——**覆盖声明建立在静态形态之上**。

另有一维**与 status 正交**的信息：`blockerSide`（仅 `gap`）——
`product`（改产品才能转绿）/ `benchmark`（补场景即可转绿）。它不进 status，
因为 status 只表达"覆盖状态"，而"阻塞在哪一侧"是另一回事。

守门输出的交叉统计可直接读：

```
existing-covered/executed = 23   ← 实测落地
existing-covered/static   =  9   ← 仅静态对账
existing-covered/tests    = 21   ← 由 Tests 承载
gap/static                = 20   ← 缺口（锚点是"为红的静态检查"）
gap/executed              =  1   ← 缺口已被场景复现
new-scaffold/tests        = 17   ← 新写骨架承载
declared-only/none        = 10
```

（**注意**：不能只报 `attestation` 的合计——`gap` 的锚点也是 static，
单看会把 20 条缺口读成"静态对账通过"。必须 status × attestation 交叉统计。）

## 守门规则（`Scripts/experimentMatrix.cjs`）

1. 结构：必填字段、id 唯一、`cls`/`status`/`axis` 取值合法、`surface` 已声明、`dim` 在六维内
2. 每面齐备：每个面 ≥1 BEN 且 ≥1 ENV/SEC；六类对抗家族全覆盖
3. 锚点可解析：`scenario`（场景存在**且** `matrixCells` 声明承载）／`static`（检查存在）／`tag`／`spec`／`none`
4. **双向一致性**：`existing-covered` ↔ 检查必须**通过**；`gap` ↔ 检查必须**失败**；
   检查转绿却仍标 `gap` → 违规（防"债已还但矩阵未转正"）
5. **孤儿声明**：场景声明的 `matrixCells` 必须在矩阵里存在（防"cell 没落地、场景却以为承载了"）

## 准入判据（20 条固定 + 1 类动态）

下表的 `CHK-*` 是固定判据（20 条，逐场景按 `expect` 启用）；另有按 `memoryExpect` **逐条生成**的 `CHK-MEM-<id>`。

| 判据 | 触发 | 判定什么 |
|---|---|---|
| `CHK-NO-FATAL` | 恒开 | 运行期无异常（有异常 = **实验无效**，不是 Agent 失败） |
| `CHK-EXIT-REASON` / `-ONE-OF` | `expect.exitReason` / `exitReasonOneOf` | 退出类别是否与期望一致（"如实终止即可"用多选） |
| `CHK-CONVERGENCE` | `expect.maxIterations` | 轮数是否在上限内 |
| `CHK-REQUIRED-TOOLS` / `CHK-FORBIDDEN-TOOLS` | `mustCallTools` / `forbiddenTools` | 该用的用了没有、不该碰的碰了没有 |
| `CHK-TOOL-RESULTS` / `CHK-TOOL-PAIRING` | `minToolResults` / 恒开 | 结果条数、**调用与结果成对**（孤儿结果会让供应商判非法请求） |
| `CHK-STEP-ORDER` | 恒开 | 十步主循环序列未被破坏 |
| `CHK-NO-FORBIDDEN-DIAGNOSIS` | `forbidDiagnoses` | 不只看期望**命中**，也看**没有出现已知问题形态** |
| `CHK-REQUEST-CONTAINS` | `requestMustContain` | 约束保持：压缩后请求里是否出现重锚段 |
| `CHK-GOAL-INTACT` | `goalMustBeIntact` | ADR-0005：不可变区未被改动 |
| `CHK-LEDGER-CLEAN` | `ledgerClean` | P0-3：Token 四源账本对账无差异 |
| `CHK-APPROVAL-GATE` | `approvalGateRequired` | 危险工具确实落在审批门的阻塞路径上 |
| `CHK-REQUIRED-EVENTS` | `requiredEvents` | 指定事件类型确实产出 |
| `CHK-IDEMPOTENT-REPLAY` | `idempotentReplay` | **执行体**调用次数 ≤ 上限（缓存命中也返回结果，只有执行体计数能证幂等） |
| `CHK-MEM-<id>` | `memoryExpect` | 写侧红线 / 乐观锁 / 治理键分级逐条判定（含 `mustStore` 对照组） |
| `CHK-RETRIEVAL-RECALL` / `-MRR` | `retrieval` | Recall@K / MRR 阈值（阈值来自基线首跑） |
| `CHK-DB-FAILURE-LOGGED` | `dbFailureMustBeLogged` | DB 不可用期间持久化失败**留痕**（不静默丢弃） |
| `CHK-CLOCK-SKEW` | `clockSkewDetected` | 时钟回拨被检出，且单调时钟未倒退 |

**全部判据通过才放行到打分矩阵**；有判据未过 = 只出诊断，不进评分。

## 打分矩阵的适用性铁律

场景**没压到的维度，既不给分也不占权重**（`N/A`）：

- `resilience` 适用 ⟺ 真的注入了故障（工具失败 / 中间件短路 / 场景声明 `allowDiagnoses`）
- `governance` 适用 ⟺ 审批门被触发 **或** 产出了 `governance:` / `loop:approval` 事件
- `maintainability` 恒不适用（无自动化测量手段，权重 0）

```
总分 = Σ(适用的 分×权重) / Σ(适用的 权重)
```

理由：否则"没测过的能力"会被算成"满分的能力"——与旧基线里手写的 `0.85~1.0` 是同一类伪分数。

## 报告

- `reports/latest.json` — 机读：完整轨迹、判据、诊断、评分；基线采集读它
- `reports/latest.md` — **人读**：汇总 + 逐场景 判定/判据/**诊断（含修复方向）**/评分表（N/A 标注）

两者只由**全量运行**更新；`--scenario=` 只写时间戳文件（否则一次单场景运行就会让基线指针失真）。

## 诊断的问题类型

`no_progress`（空转）· `tool_loop`（极限环）· `tool_misuse`（选型/参数错误）·
`tool_pairing`（调用与结果不成对）· `context_drift`（上下文漂移）· `budget_leak`（成本口径失真）·
`false_success`（退出类别与真实终止原因不符）· `step_order`（十步序列被破坏）· `recovery_missing`（注入故障后未自愈）

每种类型在 Markdown 报告里都带**修复方向**；场景可用 `expect.allowDiagnoses` 声明"这些形态是本场景故意制造的"（降级为 info）。

## 检验栈现状（诚实口径）

| 层 | 状态 |
|---|---|
| **L0 静态对账** | ✅ `Scripts/staticRecon.cjs`：32 条（11 lock + 21 gap），接入守门并逐 cell 交叉校验 |
| L1 契约单测 / L2 组件集成 | 由 [`Tests/`](../Tests/) 承载（172 文件 / 2057 用例），不属本目录 |
| **L3 真实模型端到端** | ❌ **环境不可执行**：本机无 `HUAWEI_MAAS_API_KEY`，受门禁的 12 条用例全部登记 NOT-RUN。凭据注入机制已就绪（`Tests/setup/credentials.ts` + vitest `setupFiles`，读 `.env`/`.env.local`），缺的只是凭据 —— 矩阵 cell `AGENT-ENV-L3REAL` 已如实登记 |
| **L4 对抗注入** | ⚠️ 部分：`adversarialSeeds.json` + `memoryPoison.json` 已交付；已驱动间接注入（中英双载荷）、记忆写侧红线与治理键分级；其余语料条目尚未全部驱动成场景 |
| **L5 混沌与恢复** | ⚠️ 部分：工具失败/模型失败/DB 不可用/时钟回拨已覆盖；**崩溃重放**卡在产品侧（`iterationCheckpoint` 只有写路径、无 load/resume API → cell `AG-BEN-RESUME` 为 gap） |

## 数据集资产与凭据注入

| 资产 | 用途 |
|---|---|
| `retrievalGoldenSet.json` | 20 条语料 / 36 条查询（中文 20、英文 10、中英混排 6；极性冲突 2、低相关边界 2、多期望 2）→ Recall@5 / MRR |
| `memoryPoison.json` | 记忆面投毒种子 20 条，六家族全覆盖（`adversarialSeeds.json` 只覆盖工具与运行时） |
| `Tests/setup/credentials.ts` | 从 `.env`/`.env.local` 注入真实凭据；**已存在的环境变量优先**；缺失不失败，但相关用例记 NOT-RUN |

**评测卫生（§2.3）**：`searchMemories` 会写 `accessCount`/`lastAccessedAt`（≥5 触发 `MEMORY_SELF_REINFORCING`），
因此检索类实验**全程跑在实验台临时数据根**，不污染开发机记忆。该副作用由 `SC-LOCK-SEARCH-WRITE-SIDE-EFFECT` 锁定。

## NOT-RUN 口径（§2.2 铁律 1）

缺真实凭据的用例**不得记 SKIP-pass**。本仓 13 处"缺 key 即 `console.log('SKIP'); return;`"已改为
`Tests/Helpers/credentialGate.ts` 的 `notRun()`：既不是 FAIL（CI 无 key 不该红），也**绝不是 PASS**。

```
vitest 报 80 passed   →   NOT-RUN 12 条   →   **有效通过 68**
口径：effectivePassed = vitest.passed − notRunCount；NOT-RUN 计入分母
```

`npm run bench:notrun` 汇总并写入 `baselines/notRun.json`；基线记录 `effectivePassed`。

## 实验台自测（为什么必需）

实验台的诊断规则、判据、打分如果坏了，表现是"场景跑出错误的结论"——而读报告的人只会看到
**"这个 Agent 不行"**。**测量仪器的 bug 会被记成被测对象的缺陷**，且不会有任何测试自然覆盖它。

`runner/selftest.ts` 对 `run.ts` 的纯函数喂**合成轨迹**（不启 DB、不跑主循环，毫秒级），共 **43 项断言**：

- **误报回归锁**：工具调用轮正文本就为空 → 不得判 `context_drift`；早退场景 → 不得判 `no_progress`
  （两者都是真实踩过的误报）
- **守门负向测试**：场景不存在 / 未声明承载 / 缺对抗 cell / 家族非法 / static 锁不成立 /
  债已还却标 gap / static 锚无法解析 / 缺 `axis` / **孤儿声明** —— 逐条断言守门**真的会拦**
- **基线漂移**：用**临时副本**造漂移基线验证 `--check` 报错，再断言真实基线未被污染

`run.ts` 只在**直接执行**时跑 CLI（ESM 版的 `require.main === module`），否则自测一 import 就会跑整套场景。

## 约定

- **实验台缺陷不算 Agent 失败**：探针注册失败、缺端口装配、环境缺失等一律记为 `fatalError` → "实验无效，不打分"。
  （踩过的坑：`toolDispatcher` 对未注入的 `toolResultCache` 端口**静默跳过**，于是"幂等失效"其实是实验台没装配
  —— 已由 `SC-LOCK-HARNESS-PORTS` 锁定。）
- **未落地的 cell 用 `gap`**（缺口证明实验，oracle 今天必红，**不进 CI 阻断**），不写伪断言。
  gap 的 `method` 里必须写明**实测依据**（日期 + 代码位置/证据），不许只写"待补"。
- 改 `Tests/`、改场景、改矩阵后须 `npm run bench:metrics` 重采基线，否则 CI 的 `bench:metrics:check` 会红。
- 设计文档：[Docs/Agent/15-实验矩阵与评估](../Docs/Agent/15-实验矩阵与评估/)。
