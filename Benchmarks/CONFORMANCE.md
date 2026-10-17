# 对照表：九系统检验方案 × 当前实现

> **本文件回答一个问题**：`检验方案与实验矩阵扩展-qodercn-20261011T234339.md` 逐条要求，今天落到哪一步？
>
> 生成依据：当前 `experimentMatrix.json`（74 cell）、`benchMetrics` 基线、`staticRecon` 输出、`benchGapReport` 登记册。
> **口径声明**：本表不美化。凡"未做"或"设计偏离"都单列，并写明原因。

## 一、§2.1 五层检验栈

| 层 | 文档要求 | 现状 | 说明 |
|---|---|---|---|
| **L0 静态对账** | 导出符号存在性、文档与实现差、零调用者扫描；适用全部 9 系统 | ✅ **已做且超出** | `Scripts/staticRecon.cjs`：**32 条检查**（11 lock + 21 gap），接入矩阵守门并逐 cell **双向交叉校验**；`--json` 供基线采集 |
| L1 契约单测 | `Tests/**` 单文件跑 | ➖ 由 [`Tests/`](../Tests/) 承载 | 172 文件 / 2057 用例，不属本目录职责 |
| L2 组件集成 | `Tests/LoopControl`、`Tests/A2A` | ➖ 同上 | — |
| **L3 真实模型端到端** | 真实 API Key，≥3 轮真实 Agent 调用 | ⚠️ **可执行，CI 侧 NOT-RUN** | 凭据就绪时**已真跑通**：2026-10-17 实测 `realAgent.spec.ts` **4/4**（221s）+ `llm.spec.ts` 30/30，均为真实 `/plan/v2` 调用。CI 未注入 `HUAWEI_MAAS_API_KEY` secret ⇒ `npm test` 下 12 条仍登记 **NOT-RUN**（是 CI 配置问题，非"不可执行"）。`AGENT-ENV-L3REAL` 的 oracle 要求 12 条**全部**真实执行且 NOT-RUN 归零，5 个 E2E 模式 spec 尚未在凭据下执行 ⇒ 保持 `gap` |
| **L4 对抗注入** | 语料驱动（`adversarialSeeds.json`） | ⚠️ **部分** | 已驱动：间接注入（**中英双载荷**同轮投递）、记忆写侧红线/治理键分级/inferred 拒入。`memoryPoison.json`（20 种子）已交付但**多数条目尚未驱动成场景** |
| **L5 混沌与恢复** | 崩溃 / 满盘 / 时钟回拨 / 分区 + checkpoint 恢复 | ⚠️ **部分** | ✅ 工具失败、模型失败、**DB 不可用**、**时钟回拨**；❌ 崩溃重放（卡在产品侧：`iterationCheckpoint` 只有写路径，无 load/resume → cell `AG-BEN-RESUME` 为 gap）、分区 |

## 二、§2.2 四条反假绿铁律

| # | 要求 | 现状 | 证据 |
|---|---|---|---|
| 1 | 缺 Key 记 FAIL 或 NOT-RUN，**不记 SKIP-pass**；13 处重登记并计入落地率分母 | ✅ | `Tests/Helpers/credentialGate.ts` 的 `notRun()`；`Scripts/credentialNotRun.cjs` 汇总：`vitest 报 80 passed → NOT-RUN 12 → 有效通过 68` |
| 2 | 锚点升级为断言级；新面用 `@matrix:<ID>` 标签锚，禁用纯文件锚 | ✅ | 守门支持 `scenario`/`static`/`tag` 锚并可解析；`--strict` 下弱锚即违规。**注意**：作用对象是 **Benchmark 矩阵**，不是文档原本指的那个矩阵 |
| 3 | **每个 oracle 必须可证伪（同 cell 附反例输入）** | ⚠️ **部分** | 已做：守门**9 条负向自测**（场景不存在/未声明承载/缺对抗 cell/家族非法/static 锁不成立/债已还却标 gap/static 锚无法解析/缺 axis/孤儿声明）+ 1 条基线漂移、`expect.forbidDiagnoses`（准入不只看命中，也看没出现已知问题形态）、`mustStore` 对照组。**未做**：能力轴 cell **逐条**配反例输入 |
| 4 | 缺口用 `gap`/`declared-only` 标注，不写伪断言；第 7、9 面只登记声明 | ✅ | `gap` 状态 + 不进 CI 阻断；`GAP-REGISTER.md` 登记 32 条红灯并分四类；分裂 5 条 + 多模态 1 条为 `declared-only` |

## 三、§2.3 实验执行前置阻断

| 项 | 现状 | 证据 |
|---|---|---|
| **REV-429**（`secretsStore.spec.ts` 对本机真实凭据 copy→rm） | ✅ **已修** | 改为 `mkdtempSync` + `CIVITAS_DATA_ROOT` + `resetPathCache()` 沙箱；含**安全断言**（路径未落沙箱即抛错）。实测：真实 `Data/.secrets/providers.json.enc` mtime 未变（2026-10-08）、无 `.testbak` 遗留。因此文档"批 0"的另一选项（全程禁跑全量 `npm test`）不再需要 |
| **评测卫生**（`searchMemories` 的 `accessCount` 写副作用） | ✅ **已做** | 检索实验全程跑在实验台临时数据根；副作用由 `SC-LOCK-SEARCH-WRITE-SIDE-EFFECT` 锁定（含阈值 5） |
| `fileParallelism: false` | ❌ **未加** | 因 REV-429 已修（根因消除），未采纳该兜底；若后续出现"测试写真实 `Data/`"的新场景，应重新评估 |

## 四、§3 逐系统检验方案（九系统）

| # | 系统 | 面是否建立 | 落地上限 | 说明 |
|---|---|---|---|---|
| 1 | 工具系统 | ✅ 6 cell | 2 落地 | 幂等重放（新）、schema 拒注 ✓；egress/sandbox/ratelimit 为 gap |
| 2 | 检索系统 | ✅ 4 cell | 1 落地 | **golden set 真跑通**：Recall@5 = 0.9118 / MRR = 0.9118 |
| 3 | 监管系统 | ✅ 6 cell | 2 落地 | 审批门 ✓；冻结持久化/钱包/审计链/死锁接线为 gap |
| 4 | 单 Agent 记忆系统 | ✅ 4 cell | 3 落地 | 压缩监管否决 ✓、DB 失败留痕 ✓、时钟回拨 ✓；分区未接线为 gap |
| 5 | 单 Agent 系统 | ✅ 3 cell | 2 落地 | 状态机 ✓、ID 不复用 ✓；L3 不可执行 + Review 链路未装配为 gap |
| 6 | 子 Agent 系统 | ✅ 4 cell | 2 落地 | 存活上限 ✓、孤儿回收 ✓；深度/环路、工具权限为 gap |
| 7 | **Agent 分裂系统** | ✅ **13 cell** | 0（全声明态） | 全部 `declared-only`：登记语义与验收契约，**不写伪断言**。2026-10-14 按负责人**口述流程**重写 9 条 oracle 并新增 4 条（`CONFLICTDOMAIN`/`PEER`/`ONEPERSTEP`/`MERGEKIND`） |
| 8 | 多 Agent 记忆系统 | ✅ 7 cell | 4 落地 | 红线 ✓、治理键分级 ✓、乐观锁**检出但未拒写**（gap，有事件实证） |
| 9 | **完整多模态多 Agent** | ✅ 5 cell | 0 | 文档结论"完全不存在，仅一条文本侧信道"；多模态为声明态，vision/trace/事件表为 gap |

**九系统全部建面**，共 56 cell（能力轴另 18 cell，两轴合计 74 cell）。

> 计数口径（2026-10-14）：面 H（Agent 分裂）**13 cell**、面 I（多模态）**5 cell**；此前记为 5/4（甚至更早的 5/4）均为新增前的旧口径。

## 五、§4 实验矩阵扩展（**设计偏离，必须说明**）

| 文档要求 | 现状 | 偏离原因 |
|---|---|---|
| 15 面、**88 cell** | **15 面、74 cell** | 用户在第 11–12 轮重新裁定了范围：**"Benchmark 和 Test 不是一个系统"**——文档方案的 cell 锚 `Tests/**` 的 spec，而那正是用户否掉的形态；随后又明确"实验矩阵是 benchmark 的配套系统，过了才到打分矩阵"。据此重建为**双轴**（能力轴 6 面 18 cell + 系统轴 9 面 56 cell） |
| 保留并扩面：启动与配置 / 持久执行 / LLM 通道 / Loop 控制 / Token 经济 / 并行与隔离 / 交互与可观测 | ⚠️ **降级为 `prerequisites`** | 这 7 个面的原 42 cell 保留在 `prerequisites`（锚 `Tests/**`，作为**平台就绪前置**），但**未按文档 §4 扩 cell**。它们是"对象=模块/接口"的检查，按用户口径属 Tests 领域 |
| 状态分布：existing 12 / new-scaffold 15 / gap 16 / declared-only 8 | 现状：**existing-covered 32 / gap 27 / declared-only 15**（**无 new-scaffold**）——2026-10-17 复核对齐 JSON 实测值 | 我未使用 `new-scaffold` 状态：能跑的已直接落为 `existing-covered`，跑不了的落为 `gap`。**少了一个中间态**，这是简化，但与文档三态口径不完全一致。declared-only 由 6 增至 15：分裂面按 2026-10-14 裁定拆成 13 条声明（`SPLIT-SEM-*`）+ 多模态 2 条 |

## 六、§5 实验所缺资产

| 资产 | 现状 |
|---|---|
| `retrievalGoldenSet.json` | ✅ 20 语料 / 36 查询（中 20、英 10、混排 6；极性冲突 2、边界 2、多期望 2），**已真跑并录入阈值** |
| `memoryPoison.json` | ✅ 20 种子 / 六家族全覆盖（记忆面，`adversarialSeeds` 只覆盖工具与运行时） |
| 指标采集 runner | ✅ `Scripts/benchMetrics.cjs`（采集）+ `experimentMatrix.cjs`（守门）+ `credentialNotRun.cjs` + `benchGapReport.cjs`，全部接入 CI |
| 真实凭据注入机制 | ✅ `Tests/setup/credentials.ts` + `vitest.config.ts` `setupFiles`（无 dotenv 依赖；已有环境变量优先；缺失不失败） |
| **双层 trace 写入方** | ❌ **产品接线缺失**：`traceContext.runInSpan` 零生产调用者、`events`/`domain_events` 表零写入。已由 `MM-GAP-TRACE` / `MM-GAP-EVENTSTABLE` 登记。**补齐须改 `Src/`，超出 Benchmark 系统边界** |
| `gap` cell 的 CI 策略 | ✅ `gap` 不进 CI 阻断（守门非 `--strict` 即只报告）；`GAP-REGISTER.md` 汇总；登记册条数与矩阵一致性纳入基线漂移检测 |

## 七、§6 执行顺序（六批）

| 批 | 文档内容 | 现状 |
|---|---|---|
| 0 | REV-429 修复 **或** 全程禁跑全量；卫生标准 | ✅ 选了"修复" |
| 1 | 重锚 6 条过度声称 / 13 处改判 NOT-RUN / MMAS-BEN-GREEN 真实绿灯基线 | ✅ 6 条已逐条复检处置；NOT-RUN ✅ | **复检结论（2026-10-13）**：3 条确为弱锚或锚错文件，已重锚 —— `BEN-TOOL` → `Tests/Durable/faultInjection.spec.ts`（DUR-005/006 真断言）、`ENV-DEADLOCK` → `Tests/LoopControl/loopControl.spec.ts`（⑤ 风险退出）、`SEC-ARBMANIP` → `Tests/Judicial/judicialSupervision.spec.ts`（强制裁决 + 重复挂起抑制两个半句都在）；**另 3 条文档判断已过时** —— `SEC-SPY`/`SEC-FREEZEEVADE`/`SEC-CONF` 的断言与 oracle 完全相符，已从 `new-scaffold` 转正为 `existing-covered`。`--strict` 弱锚 **11 → 9** |
| 2 | 约 15 条 new-scaffold（L1/L2 可运行） | ⚠️ 我未新增 `Tests/**` 用例；而是新建 **15 个 Benchmark 场景**（回路 11 / 记忆 1 / 检索 1 / 混沌 2） |
| 3 | 16 条 gap 证明实验，红灯产出即代码债清单 | ✅ 26 条 gap + 6 条 declared-only，`GAP-REGISTER.md` 分四类（产品缺失 19 / 不可达 6 / 设计态 6 / 行为缺陷 1） |
| 4 | L3 真实端到端（凭据就绪后） | ⚠️ **部分执行**：2026-10-17 在凭据下实测 `realAgent` 4/4 + `llm.spec` 30/30 通过（221s）。仍未执行的是 5 个 E2E 模式 spec；CI 未注入 secret ⇒ CI 侧恒 NOT-RUN。`AGENT-ENV-L3REAL` 保持 `gap`（oracle 要求 12 条全执行、NOT-RUN 归零） |
| 5 | 面 H（分裂）/ 面 I（多模态）产品语义裁定 | ✅ **已于 2026-10-14 裁定并录入**（见 §10.4）。**剩下的是产品实现**，不是语义裁定 —— 语义已定，缺的是代码 |

## 八、证据强度审计（Round 15–16 反向审计）

> 前面各节回答「做了没有」；本节回答**「凭什么算做了」**。

### 分类：behavioral vs symbol

| 强度 | 含义 | 能否支撑 `existing-covered` |
|---|---|---|
| `behavioral` | 检查**行为或取值**（常量被引用且上限真被强制 / 阈值与写门都在 / 返回值被钉住） | ✅ |
| `symbol` | 只证明**符号或文件存在**（`/PENDING/.test(file)`） | ❌ 它只说「这段代码还在」，说不了「这个性质成立」 |

11 条 lock 检查现已**全部为 behavioral 级**（Round 15 把 6 条 symbol 级改写为 behavioral，Round 16 同步分类表）。

### 案例：一条建立在**注释**上的覆盖声明

`TOOL-SEC-L4GATE` 的原 oracle 是「DANGEROUS+IRREVERSIBLE 在校验期即要求 L4 HumanGate」，锚 `SC-GAP-TOOL-L4GATE`。原检查是：

```js
/IRREVERSIBLE[\s\S]{0,500}?(L4|HumanGate|humanGate)/
```

它命中了这段**注释**（`Src/Tools/Traits/specValidator.ts:109-114`）：

```ts
// 11. 自动门禁：DANGEROUS + IRREVERSIBLE → 需要 L4 HumanGate
if (spec.dangerLevel === 'DANGEROUS' && spec.reversibility === 'IRREVERSIBLE') {
  // 标记但不阻断——L4 HumanGate 在 S6 的 approvalGate 中强制
  // 此处仅记录警告
}   // ← 空 if 块，块内没有任何 errors.push
```

于是该 cell 被标 `existing-covered` —— **覆盖声明建立在「注释里写了会强制」之上**。文档 §3.1 的判断（`:111-114 为空 if 块`）是对的。

修正经过两次失败才做对：窗口法先后被**注释**、以及**邻近规则的 `errors.push`** 骗过；
最终改为只取该 if 块的**花括号体内**再判有无 `errors.push` → 如实为红 →
守门的双向一致性规则迫使该 cell 从 `existing-covered` 降级为 `gap`。

### 由此确立的两条规则（均配负向验证）

1. **每条 lock 检查必须显式声明证据强度**（`EVIDENCE_STRENGTH` 表）。缺声明不是警告，
   而是一条失败的检查 `SC-SELF-EVIDENCE-DECLARED` → 经守门让 CI 变红。
   动机：Round 15 实测发生过「改了检查实现、忘了同步分类表」——分类一脱节，
   下面第 2 条规则就形同虚设。
2. **`symbol` 级证据不得支撑 `existing-covered`**：守门对该组合直接判违规。
   修法只有两条 —— 把检查写强（去看真行为），或把 cell 如实降级。

负向验证（守卫必须真的会拦，不能只看它"能过"）：

```
删掉 SC-LOCK-CLOCK-SKEW 的证据强度声明      → ✗ SC-SELF-EVIDENCE-DECLARED（lock 失败 1 条）
把 SC-LOCK-AGENTID-MONOTONIC 降为 symbol    → ✗ AGENT-SEC-IDREUSE 的 static 锚是 symbol 级证据
```

### 同轮的另一半：读代码**推翻**了粗 grep 的判断

我一度据 `whitelist.ts` / `specValidator.ts` 的粗 grep 判定「FORBIDDEN 无拒注路径」，
**读代码后发现规则 12 确实存在**：

```ts
// 12. FORBIDDEN 工具不应注册
if (spec.dangerLevel === 'FORBIDDEN') { errors.push('FORBIDDEN 级别工具不允许注册'); }
```

`TOOL-BEN-SCHEMA` 的覆盖声明**成立**，保持 `existing-covered`。

**结论**：粗 grep 会同时产生假阳性与假阴性；**只有读代码能定论**，
而 L0 的价值在于把「读过一次」固化成可复跑的断言。

## 九、我做了但文档没要求的（附带产出）

- **实验台自测 43 项**（含 2 条误报回归锁 + 9 条守门负向测试 + 1 条基线漂移）
- **代码债登记册** `GAP-REGISTER.md`，且条数纳入基线漂移检测（防"没人读的过期文档"）
- **记忆治理探针 / 检索套件 / 混沌注入** 三种新实验形态（系统轴判定点只能这样压到）
- 守门的**孤儿声明**与 **axis 缺标**校验（各配负向自测）

## 十、方法学裁定与落实（2026-10-14）

项目负责人对七项疑问的裁定，以及本轮落实状态。

### 10.1 分工的权威措辞

> **Benchmark 测的是 Agent 的数据流转问题，确保 Agent 没有问题；
> Tests 测的是接口能不能正常调用、代码有没有写漏内容。**

| 由谁测 | 对象 | 典型问题 |
|---|---|---|
| **Benchmarks** | Agent 的**数据流转**（输入→决策→工具→记忆→事件→输出） | Agent 有没有问题 |
| **Tests** | 函数 / 模块 / 接口 | 接口能不能正常调用、代码有没有写漏 |

### 10.2 七条裁定与落实状态

| # | 裁定 | 落实状态 |
|---|---|---|
| 1 | **调用层规**：只调**被测层之上**的接口驱动实验；**层下探针只用于监控、不用于驱动** | ⏳ 待做（现存的 `memoryProbes` 直调 Services 写 API、`retrievalSuite` 直调 `createMemoryRetriever`、`clockSkewProbe` 直调 `Time` 均违反此规） |
| 2 | **关键检查改为真实调用**（真注册 FORBIDDEN 工具、真跑状态转换、真写版本冲突） | ✅ **5 条已实测**（见 §10.2.1）；余 4 条待先核实 API 形状 |
| 3 | **静态与实测裁开 + 恢复三态** | ✅ **本轮完成**：新增 `attestation`（executed/static/tests/none）并与 `anchor.kind` 硬绑定；`new-scaffold` 恢复"新写骨架承载"语义；落地率只计 `existing-covered ∧ executed`（23/65 = 35.4%），`static-attested` 单列（9 条） |
| 4 | **录入产品语义**：多模态 = 视觉工具 `sightUse` 或原生多模态；分裂 = 自分裂 + **自合并** | ✅ **本轮完成**（见 §10.4）：9 条分裂 cell 的 oracle 按裁定改写；新建 **4 条分裂 cell**（含重点 cell `SPLIT-SEM-SELFMERGE`）+ **1 条 `MM-DECL-SIGHTUSE`**。产品对两者**零实现**，故一律 `declared-only` |
| 5 | 按「Benchmark = Agent 数据流转」重新定性系统轴 | ✅ **本轮完成**（见 §10.5）：系统轴 56 条 cell 全部标注 **`flowStage`**（input/decide/act/remember/emit/output/none），守门**强制**已落地 cell 必须声明链路阶段；README 新增「Agent 数据流转链路视图」 |
| 6 | 全程不改 `Server/` 与 `Docs/Server/`；最终 typecheck/lint/test/bench 全绿 | ✅ 本轮 bench 全绿（自测 44 项 + 守门 + 基线一致性 + 审计 16/16） |
| 7 | 同步 README 与 CONFORMANCE 口径 | ✅ 本轮完成（含 11.1 分工措辞、`Benchmarks/README.md` 的状态与证据模型小节） |

#### 10.2.1 裁定② 真实调用进度（2026-10-14）

**已由真实调用驱动（5 条）** —— 全部在 `scn-assembly-probes` 里实跑并放行，
探针实现在 `Benchmarks/runner/assertProbes.ts`（每条都带 `whyThisEntry` 层规自述）：

| 探针 | 被测层 | 驱动入口 | 读回的返回值 |
|---|---|---|---|
| `TOOL-FORBIDDEN-REGISTER` | Tools（注册期守卫） | `registerTool`（装配期公共 API） | `Result.ok === false` |
| `AGENT-ILLEGAL-TRANSITION` | Core/AgentRuntime 状态机 | `transition` | `Result.ok === false` |
| `MEM-CONSOLIDATE-GATE` | Services（记忆写侧） | `consolidateLoopKnowledge`（**在 Core，位于被测层之上**） | `null`（不沉淀） |
| `AGENT-ID-MONOTONIC` | Core/AgentRuntime 身份分配 | `createAgent` ×2 | `agentId` 不同且序号递增 |
| `SUP-HUMANGATE-PENDING` | Services/LoopControl L4 门 | `runHumanGate` | `pass=false` + `evidence.data.status=PENDING_APPROVAL` |

由此 5 条 cell 的 `attestation` 由 `static` 升为 `executed`（静态检查保留为 CI 守门锁，但**不再是覆盖声明的主要证据**）。

**仍为 `static-attested`（4 条）** —— 升级前必须先核实 API 形状，**不许猜**（本轮已多次证明照抄/猜 API 会写坏：
`registerTool` 的同名双 API、`contentOutputSchema` 是函数、`LongTermMemoryEntry.memoryId`、`ToolSpec` 五个必填字段、
`inputSchema.additionalProperties:false`、`VerifierSpec` 是联合类型）：

| cell | 需先核实 |
|---|---|
| `RET-SEC-SOURCE` | ✅**已侦察**：`source: 'long-term-memory'` 由 `Src/Services/Retrieval/retriever.ts:69/92/107` **硬编码写入**，并不存在独立的"过滤函数"；该 cell 的 oracle 实为"结果来源取值被钉死"。⏳**仍缺**：经 **Core 入口** `retrieveForContextAssembly` 驱动时，返回值是 `ContextSection`（已格式化为文本），**拿不到 `source` 字段** —— 需在 port 包装里记录（监控）再断言，或先裁定该 cell 是否真属 Benchmark（它更像接口级取值断言） |
| `MEM1-BEN-COMPRESSVETO` | 压缩否决的可驱动路径（需构造超阈值上下文） |
| `SUB-BEN-RECRUIT` | ✅**已侦察**：`RecruitmentPort`（`Src/Tools/Registry/toolServicePorts.ts:88`）= `{ getRecruitedAgents(traceId), recruitAgent({ role: RecruitableRolePort, domain, taskPrompt, requiredTools, ... }) }`。⏳**仍缺**：(a) `recruitAgent` 完整入参（读到第 5 个字段处被截断）；(b) **存活上限常量的实名与位置** —— 用 `MAX_SUBAGENTS|MAX_SUB_AGENT|SUBAGENT_CAP|maxSubAgents` 全库**均无命中**，需另行定位上限在哪强制；(c) **层规判定**：该端口属 Tools 层，而"子 Agent 系统"在 Services/Recruitment —— 用端口驱动是否算"上层入口"**需先定**（不宜默认） |
| `SUB-BEN-RECLAIM` | 孤儿回收的触发路径 |

**执行顺序（2026-10-14 补）**：先侦察、再写探针 —— 每升级一条前必须先读到该 API 的**完整签名**与**被读回的字段名**，
否则宁可不做。本轮已有 6 次"猜/照抄 API 写坏"的实例（见 §10.2.1 表下注）。

**原则**：与其猜着写一条"看起来通过"的探针，不如如实留着 `static-attested` ——
它已单列、不计入落地率，口径是诚实的。

#### 10.2.2 层规归属判定（避免同类疑问反复）

| 情形 | 判定 | 依据 |
|---|---|---|
| 属性在**装配期**成立（如 FORBIDDEN 工具不得注册） | 允许调该层**自己的公共 API**（须标 `assemblyTime: true`） | 无上层入口可驱动：工具进不了注册表，循环无从调度 |
| 属性在**运行期**由工具实现（如子 Agent 存活上限 8） | **必须由 Agent 经 Core/Loop 调工具**；直接调工具 `execute` **不合规** | 裁定①："测工具，只能调用工具以上的接口" |
| 被测层是 **Services**，且存在 Core 入口（如检索 `retrieveForContextAssembly`） | 走该 Core 入口；端口包装记录返回值 = 监控 | 裁定① + "层下探针只用于监控" |
| 被测层是 **Services**，**不存在**上层入口（如 GlobalWorkspace 写入守卫） | 属 Tests 领域，或产品侧补入口（**待裁定 a1/a2/a3**） | 无合规驱动方即无合法 Benchmark 位置 |


#### 10.2.3 裁定② 剩余两条的侦察结论（2026-10-14 补）

**`MEM1-BEN-COMPRESSVETO`（压缩否决）**

| 项 | 结论 |
|---|---|
| 现状锚点 | 静态检查 `SC-LOCK-COMPRESS-VETO` —— 只验证 `contextCompression.ts` 里**调用了** `runCompressSupervision` |
| 可驱动入口 | `configureContextCompression(partial, deps)`（已导出）与内部 `maybeCompressContext`（`Src/Core/Loop/contextCompression.ts`） |
| ⏳ 仍缺 | **超阈值上下文的构造方式**（需知道 `ContextCompressionConfig` 的阈值字段与 `messages` 形状），以及"不可变区未被丢弃"的**可观测判据**（哪个返回值/副作用能证明否决生效） |

**`SUB-BEN-RECLAIM`（孤儿回收）—— 查到一处语义错配**

| 项 | 结论 |
|---|---|
| 现状锚点 | `SC-GAP-SUB-RECLAIM`，其 `kind` 是 **`gap`**（设计用来**证明缺口成立**：`expelAgent` / `detectAllAnomalies` 的**生产调用者数为 0** 时判"孤儿无回收"） |
| 错配 | 该 cell 却是 `existing-covered + static` —— **用一个"证明缺口"的检查去支撑"已有覆盖"**。检查当前是**通过**状态，说明"至少有一处调用者"，但那只能证明**有调用点**，证明不了"异常子 Agent 确实被检出并回收" |
| 相关入口 | `expelAgent`（`Src/Services/Recruitment/recruiter.ts`）、`detectAllAnomalies`（`Src/Core/Decision/orchestrator/progressTracker.ts`，**Core 层**） |
| ⏳ 待做 | (a) 真实调用探针：`detectAllAnomalies` 在 Core 层，可直接驱动（合规）→ 构造异常状态、断言检出；(b) `expelAgent` 在 Services 层，须经上层驱动或裁定归属；(c) **把该 cell 从 gap 类锚点换掉**，否则它的"覆盖"永远建立在"有调用点"之上 |

**由此抽象出一条待加守门规则（尚未实现）**：
> 声明 `existing-covered` 的 cell **不应**锚定 `kind=gap` 的静态检查 ——
> `gap` 检查的语义是"证明缺口成立"，与"证明已有覆盖"方向相反；混用会让通过的含义发生漂移。


#### 10.2.4 `SUB-BEN-RECLAIM` 换锚点所需入口清单（2026-10-15 侦察）

锚点错配的修法 = 用**真实调用**替代 `SC-GAP-SUB-RECLAIM`。**驱动层合规**：
`detectAllAnomalies` 位于 `Src/Core/Decision/orchestrator/progressTracker.ts`（**Core 层**），
按 §10.2.2 可直接驱动 —— 无需经工具，也不违反裁定①。

该文件已确认的导出：

| 导出 | 签名 | 用途 |
|---|---|---|
| `initProgressTracker()` | `(): void` | 建订阅、置 initialized |
| `registerAssignment(assignment)` | `(TaskAssignment): void` | 注册一个待跟踪的分配 |
| `updateProgress(...)` | 多行签名（**需再读**） | 推进进度（构造"连续失败"用） |
| `detectAllAnomalies(timeLimitMs?)` | `(number?) => AnomalyReport[]` | **被测入口**：超时 + 停滞 + 连续失败三类检出 |
| `checkTimeouts` / `checkStagnation` / `checkConsecutiveFailures` | 各自独立可调 | 可只驱动其中一类，缩小构造面 |
| `resetProgressTracker()` | `(): void` | 清理（探针收尾用） |
| `TRACKER_THRESHOLDS` | 常量对象 | 阈值真源 |
| `AnomalyReport` | interface | 断言目标形状 |

**⏳ 仍缺（构造异常状态所必需）**：
1. `TaskAssignment` 的形状（`registerAssignment` 的入参）
2. `updateProgress` 的完整签名（构造"连续失败"要按它的形状喂输入）

**建议做法**：探针内 `initProgressTracker()` → `registerAssignment(...)` → 按阈值喂若干次失败
`updateProgress(...)` → `detectAllAnomalies()` 断言返回非空且类别正确 → `resetProgressTracker()`。
断言"**检出**异常"；"回收"那一半（`expelAgent`，在 Services/Recruitment）须另按 §10.2.2 判归属。

**同时**：换锚点后，原 `SC-GAP-SUB-RECLAIM` 将不再被任何 cell 引用 ——
需确认"未被引用的检查"在本仓是否允许存在（否则该检查应改为 `lock` 语义或删除）。


#### 10.2.5 系统级有效性验证查出的问题（2026-10-15）

跑 `npm run bench:run` 做系统级验收时，发现 **4 条 cell 声称 `attestation=executed`，
但它们的锚点场景并未通过准入**（`未过`）：

| cell | 状态 | 锚点场景 | 场景准入 |
|---|---|---|---|
| `AG-ENV-TOOLLOOP` | existing-covered / **executed** | `scn-tool-loop` | **未过**（3 条判据未过） |
| `MEMN-SEC-FORBIDDEN` | existing-covered / **executed** | `scn-memory-governance` | **未过** |
| `MEMN-SEC-GOVKEY` | existing-covered / **executed** | `scn-memory-governance` | **未过** |
| `MEM1-SEC-ASSERTION` | existing-covered / **executed** | `scn-memory-governance` | **未过** |
| `MEMN-SEC-VERSION` | gap / executed | `scn-memory-governance` | **未过** |

**为什么会发生**：守门对 `existing-covered + scenario` 的检查只验证
「**场景存在**且**声明了该 cell**」，**没有验证该场景是否放行**。
于是"锚点存在"被当成了"锚点通过" —— **锚点存在 ≠ 锚点通过**。

**这一条使落地率被高估**：

```
原报：29 / 74 = 39.2%
扣除锚在未放行场景上的 4 条（gap 的那条本就不计入）→ 25 / 74 = 33.8%
```

**建议新增守门规则（尚未实现，因涉及执行顺序）**：

> `existing-covered ∧ attestation=executed ∧ anchor.kind=scenario`
> ⇒ 该场景必须在**最近一次运行**（`Benchmarks/reports/latest.json`）里为**放行**。

**为什么没立刻加**：这条规则依赖"先跑 bench:run 再跑守门"，而当前 CI 顺序是
`selftest → notrun → static → matrix → metrics → typecheck → conformance → bench:run` ——
守门（matrix）在 bench:run **之前**，加了会因缺少最新运行结果而误报。
要加就必须**同时调整 CI 顺序**（把 bench:run 提到 matrix 之前，或让守门在缺失运行结果时明确报"未知"而非通过）。
这是一个需要与既有流水线一起改的改动，不宜单独加。

**系统级覆盖的另一面**（本次同批测出，供参考）：15 面中 **3 面零实测**——
`子 Agent 系统`（实测 0 / 静态 2 / 缺口 2）、`Agent 分裂系统`（实测 0 / 声明 13）、
`完整多模态与可观测`（实测 0 / 缺口 3 / 声明 2）；缺口最重的三面是
`工具系统`（5）、`监管系统`（4）、`多 Agent 记忆系统`（4）。


### 10.3 裁定①（调用层规）落地结论

层规登记表见 [`Benchmarks/layerRules.json`](layerRules.json)（守门强制字段齐备，非合规项必须带 `reason`+`blockerSide`+`migration`）。
当前 **5 条实验设施：合规 3 / 违规 2**。

| 设施 | 被测层 | 驱动入口 | 合规 |
|---|---|---|---|
| 场景驱动主循环 | Core/Loop 及以下数据流转 | **Core**（`executeLoop`） | ✅ |
| 真实调用探针 | 逐条自述 | 逐条自述（装配期允许调本层公共 API 并标注） | ✅ |
| 时钟回拨混沌 | Core 在时钟异常下的行为 | **Core**（循环）+ Infra 层故障注入（只注入不驱动） | ✅ |
| 记忆红线探针 | Services/SharedMemory 写侧 | ❌ **Services 本层** | ❌ |
| 检索质量套件 | Services/Retrieval | ❌ **Services 本层** | ❌ |

**关键推论（需要口径裁定）**：这两条违规**没有合法的上层入口可改**，原因是**产品里不存在对应链路**：

- 记忆写：唯一的 `Core→记忆写` 路径是 `consolidateLoopKnowledge`（仅 `success` 且长度达标的沉淀），
  **产生不了** FORBIDDEN 键、治理键、任意 version 冲突这类被测输入；
- 检索：真实工具 `VectorSearch` 位于 **Tools 层（在 Services 之下）**，且检索器**未接入 prompt**（`AG-SEC-POISON` 已登记），
  产品里不存在「Agent 从上方驱动检索」的链路。

按已裁定的分工（**Benchmark 测 Agent 数据流转；Tests 测接口能不能正常调用**），这两处度量**本质属 Tests 领域**：

> 它们是「接口调用 + 质量/红线断言」，不是「Agent 的数据流转」。

**因此给出两条待选口径**（不擅自定）：

- **(a) 产品侧补上层入口** —— 让记忆写与检索经 Agent 可达（属产品改动），Benchmark 再改为上层驱动，这些 cell 保持 `executed`；
- **(b) 承认属 Tests 领域** —— 把这些 cell 的 `attestation` 由 `executed` 改为 `tests`/`static`，**从 Benchmark 落地率中移出**
  （落地率会从 38.5% 相应下降，但口径变得无争议）。

在口径确定前，这两条设施**如实标为「非合规」并登记为可追踪的债**，不静默存在。

#### 10.3.1 两条上层入口的现状（2026-10-14）

被裁定为「违反层规」的两条设施，上层入口**都已建好**；迁移进度不同：

| 设施 | 上层入口 | 生产启用 | 迁移状态 |
|---|---|---|---|
| **检索** `FAC-RETRIEVAL-SUITE` | `IterationContext.memorySearchPort`，在 ⑷ ContextAssembly 消费（`Src/Core/Loop/runIteration.ts`）；稳定键 `ctx:memory:retrieval` 进追加式上下文，不破坏前缀缓存 | ❌ 未注入（`main.ts` 未改）→ 行为逐字节不变 | ⏳ **待迁移**（设计见 10.3.2） |
| **记忆写** `FAC-MEMORY-PROBES` | 内置工具 `MemoryWrite`（`Src/Tools/Builtin/Memory/memoryWrite.ts`）+ 端口 `ToolServicePorts.memoryWrite`；实验侧有包装探针 `BenchMemWrite`（转交真实执行体、只记录结果） | ✅ 已注入（`main.ts`） | ⚠️ **部分**：机制就绪；场景迁移见 10.3.3 |

#### 10.3.2 检索迁移设计（下一步可直接执行）

1. 把 `runIteration` 里内联的检索块抽成**Core 层入口函数**（如 `Src/Core/Loop/memoryRetrievalEntry.ts` 的
   `retrieveForContextAssembly(port, query, limit): Promise<ContextSection | null>`），loop 与 Benchmark **共用同一入口**；
2. `Benchmarks/runner/retrieval.ts` 改为调该函数（注入真实检索实现包成的 port + 记录每次返回的 hits），
   **不再直调 `createMemoryRetriever`**；
3. 记录即"层下探针只用于监控"：port 是边界，读它返回什么不构成驱动；
4. 迁移后 `layerRules.json` 的 `FAC-RETRIEVAL-SUITE` 由 `compliant:false` 转 `true`，
   相关 cell 的 `attestation` 保持 `executed`（驱动方在 Services 之上）。

**注意**：36 条 golden 查询无法靠"跑循环"覆盖（同一场景每轮的 user 消息相同 → 查询相同），
故质量扫描用**同一个 Core 入口函数**逐条驱动；**另需**一个循环驱动的场景证明"这条入口真的接在 ⑷ 步上"（二者互补）。

#### 10.3.3 记忆写迁移的阻塞点（需裁定）

`scn-memory-governance` 的 5 条探针里，**只有 1 条**（`MP-INT-05` inferred 不入长期记忆）能被
`MemoryWrite` 覆盖；另外 4 条测的是 **GlobalWorkspace 写入守卫**（`MP-INT-01` FORBIDDEN 键、
`MP-GOV-01` 治理键前缀、`MP-CTL-01` 正常对照、`MP-INT-04` 乐观锁 version 冲突）——
那是**另一个存储、另一条写入路径**，当前没有 Agent 可触达的入口。

三个选项（**待项目负责人裁定**，见 §10.2 裁定①）：

- **(a1)** 再给 GlobalWorkspace 补 Agent 可触达的写入口。
  **代价**：等于让 Agent 有能力改写共享上下文 —— 与 `MEMN-SEC-GOVKEY`/`MP-INT-01` 要防的事直接冲突。
- **(a2)** 承认这 4 条属 **Tests 领域**（接口级守卫验证），在 Benchmark 内降级为 `tests`/`static`，
  从落地率移出；`MP-INT-05` 走新的 Agent 入口。
- **(a3)** 折中：Agent 只获得共享记忆的**只读**能力；写入仍只由 Core 内部路径（仲裁/沉淀）驱动，
  这 4 条记为"无上层入口的内部守卫"。

**在裁定之前，本设施如实保留 `compliant: false`**（守门要求非合规项带 reason/blockerSide/migration）。

### 10.4 裁定④（产品语义）落实

**取证结论（本轮实测）**：产品对分裂/自合并与视觉多模态**零实现** ——
`sightUse|multimodal|多模态` 与 `selfSplit|splitAgent|自合并|selfMerge|mergeAgent` 全库**均无命中**
（grep 到的 "vision" 是 `supervision` 的子串，假阳性）。
因此这些 cell 只能是 `declared-only`（登记语义与验收契约）或 `gap`（缺口证明），**不能**是 executed。

#### 分裂 = 自分裂 + 自合并（**负责人 2026-10-14 口述的权威语义**）

> **触发**：当前 Agent 认为任务过于艰难、**即使召唤子代理也无法解决**
> → 把任务**按冲突域拆分**、确保工作内容**高度隔离**
> → 用**工具**召唤**一个新的同级别 Agent**（**不是**下级子代理）
> → 把拆分后的一份任务交给它；**每次只能分裂一个 Agent**。
>
> **合并触发**：监管系统**或 Agent 自身**在**共享上下文拉取与自己相关的文件**时，
> 发现某 Agent 与自己的工作内容**高度相关** → **向监管请求合并**（需批准）
> → 形态二选一：**(a) 完全合并**、**(b) 相关子代理归属转换**。

> **我此前的记录有两处根本错误**（已修正）：
> ① 写成"产出**子代理**续跑" —— 实为**同级别** Agent；
> ② 漏了触发条件"**召唤子代理也无法解决**" —— 这正是**自分裂与招募子代理的分界**。

| cell | cls | oracle |
|---|---|---|
| `SPLIT-SEM-SELFSPLIT` | BEN | 任务过于艰难且**召唤子代理也无法解决**时，agent 可自行发起分裂：用**工具**召唤**一个同级别的新 Agent**，并把按冲突域拆出的一份任务交给它 |
| `SPLIT-SEM-CONFLICTDOMAIN` | BEN | 拆分依据是**冲突域**：拆出的各部分工作内容**高度隔离**（不共享可写资源），隔离性可验证 |
| `SPLIT-SEM-PEER` | BEN | 召唤的是**同级别 Agent**（不是下级子代理）；被召唤者不被纳入父的任务树逐级指派 |
| `SPLIT-SEM-BLOODLINE` | BEN | 分裂产出可追溯：能查出"新 Agent 承接的是哪个父任务的哪个冲突域"；合并（含归属转换）后承接链仍连续 |
| `SPLIT-SEM-SELFMERGE` | BEN | 监管系统**或 agent 自身**在共享上下文拉取相关文件时，发现工作内容**高度相关** → **向监管请求合并** → 批准后执行**完全合并**或**相关子代理归属转换** |
| `SPLIT-SEM-MERGEKIND` | BEN | 合并两形态的判定条件有定义：(a) 完全合并 (b) 相关子代理归属转换 |
| `SPLIT-SEM-INHERIT` | SEC | 分裂体与父为**同级**；其权限/预算/可见范围初始值有确定定义，**不得默认继承父的全部权限** |
| `SPLIT-SEM-DEPTH` | SEC | 分裂不得无界：**每次只能分裂一个**，且分裂链总数有上限并被强制 |
| `SPLIT-SEM-ONEPERSTEP` | SEC | **每次只能分裂一个 Agent**：一次请求产生且仅产生 1 个新 Agent，超量被拒 |
| `SPLIT-SEM-SIMILARITY` | SEC | "工作内容高度相关"的判据**可复算**：基于共享上下文中文件重叠的度量 + 阈值 |
| `SPLIT-SEM-AUTH` | SEC | 分裂所用工具受治理约束；**合并必须向监管请求并经批准** |
| `SPLIT-SEM-VISIBILITY` | SEC | 共享上下文可见范围有确定语义：只能拉取**与自己相关**的文件，不得越权扩大 |
| `SPLIT-SEM-CLOSURE` | ENV | 分裂⋈合并闭环稳定：每次只分裂一个 + 合并需批准 + 两形态，使 Agent 总数与授权范围收敛 |

**闭环为何依赖自合并**：若只有分裂没有合并，Agent 数量只增不减，分裂系统退化为"无界复制"。

#### 设计文档与本次裁定的一处分歧（如实登记）

`Docs/Agent/01-系统概览/系统设计总览.md:19` 写的是
"入口级 Agent（Prime Director / Partner，L1）**可自分裂（招募 Partner / Worker）**" ——
**把"自分裂"与"招募子代理"写成了一件事**。而负责人的裁定把二者明确分开：
招募产生**下级**子代理（角色由入参决定、从零初始化、不复制父 context/wallet）；
**自分裂**召唤的是**同级别** Agent，且触发条件是"连子代理都解决不了"。

本表按**负责人裁定**为准；设计文档该处建议后续按此措辞校准（未擅自改设计文档）。

#### 多模态 = 两条确定路径

| cell | cls | oracle |
|---|---|---|
| `MM-DECL-MULTIMODAL` | BEN（已更新） | (a) 主模型（文本）经**视觉工具 sightUse** 操作；(b) **多模态模型原生**支持内容块 |
| `MM-DECL-SIGHTUSE` | BEN（新建） | 文本主模型可通过视觉工具 `sightUse` 处理图像；图像内容经**工具层回传**而非内联进 prompt |

`MM-DECL-SIGHTUSE` 的验收要点与层规一致：sightUse 作为工具被 Agent 调用（**由 Core/Loop 驱动**），
符合"测工具经 Core/Loop 调"。

**待产品实现后**：这些 cell 才能从 `declared-only` 转为 `gap`（缺口证明）→ 最终 `executed`。
转换前需要产品先定义语义并落地最小实现。

### 10.5 裁定⑤（按 Agent 数据流转重组系统轴）落实

系统轴 **56 条** cell 现已全部标注 **`flowStage`**，并写入矩阵的 `flowStages` 元数据。

| 阶段 | 含义 | cell 数 |
|---|---|---|
| `input` | 输入（时间源、外部输入） | 5 |
| `decide` | 决策（监管/循环控制/编排/模型调用/上下文装配） | 8 |
| `act` | 执行（工具契约、注册、派发、守卫） | 9 |
| `remember` | 记忆（共享记忆、长期记忆、检索、分区、A2A 引用） | 12 |
| `emit` | 留痕（事件、trace、审计、账本、幂等/检查点） | 7 |
| `output` | 输出（面向外界的产出） | **0** |
| `none` | 无实现（`module=（待实现）`） | 15 |

派生规则按 `module` 语义（可复核，见 `Scripts` 的一次性脚本），**不靠模糊判断**；
无实现的 cell 标 `none` —— **没有代码就没有链路位置，不硬塞**。

**守门新增硬规则**：系统轴 cell 必须声明合法 `flowStage`；
**已落地（`existing-covered`）且 `module` 非"待实现"的 cell 不得为 `none`** ——
否则"这个 cell 测链条哪一环"会变成没人回答的问题。

**链路视图暴露的两件事**：

1. `output` 阶段**零 cell** —— 当前不度量"Agent 的产出是否正确交到外界"，是尚未建面的真实空白；
2. 纯静态形态核对（`attestation=static`，**6 条**）已在 README 中**明确标注属 Tests 领域**，
   不计入落地率，也不在链路视图中冒充链路覆盖。

### 10.6 本轮新增的守门规则（均配负向自测）

1. `attestation` **必填**且与 `anchor.kind` **硬绑定**；不符即违规（自测 Q13）
2. `new-scaffold` 恢复三态语义：必须由标签锚承载（自测 Q14）
3. **落地率只计实测**；`static-attested` 单列 — 守门输出 `status × attestation` **交叉统计**
   （不能只报 attestation 合计：`gap` 的锚点也是 static，单看会把 20 条缺口读成"静态对账通过"）

---

## 十一、要收口需你裁定的三件事

1. **双层 trace（§5 最后一项）**：需要动 `Src/`（把 `runInSpan` 接到真实调用链、给 `events`/`domain_events` 落写入方）。这是产品改动，非 Benchmark 系统内可完成。
2. **面 H（分裂）/ 面 I（多模态）的产品实现**（§6 批 5）：语义已于 2026-10-14 裁定并录入（§10.4），
   缺的是产品实现 —— 从 `declared-only` 升级需要先有代码，不再是"等裁定"。
3. **§4 的 7 个保留面是否要按文档扩 cell**：若"启动与配置 / 持久执行 / LLM 通道 / Loop 控制 / Token 经济 / 并行与隔离 / 交互与可观测"也要进矩阵扩面，那是把 Tests 领域的检查重新纳入 Benchmark——与你在第 11 轮的裁定相冲突，需要你确认口径。
