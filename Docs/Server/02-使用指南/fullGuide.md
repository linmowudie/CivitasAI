# 完整使用指南

> 从零到一掌握 Civitas-AI 的核心概念与高级用法

---

## 1. 架构概览

Civitas-AI 采用 **五层单向依赖** 架构：

```
Interface → Core → Services → Tools → Infra
```

- **Interface 层**：HTTP 接口 + Electron IPC 桥接，接收用户输入

  > 2026-10-03 校准：命令通道当前**以 Electron IPC 为准**（`Src/Interface/IpcBridge/ipcBridge.ts`，替代 2026-09-28 已删除的 WebSocket）；浏览器（非 Electron）模式下前端 `send()` 走 Phase 0 降级分支，命令被**静默丢弃**并仅打印告警（`Client/src/services/eventBusBridge.ts:71-80`），REST（:3000）侧目前仅承担查询/落库类请求。
  >
  > 【需人工裁定·登记】浏览器模式定位（只读观测 vs 完整操作）尚未裁定；裁定前本指南按"浏览器侧仅可观测、发起任务/审批须 Electron 壳"的现状描述。对应工单：Server-02 差别清单 QS-4 / FG-4。
- **Core 层**：Agent 运行时、主循环执行器、中间件注册表
- **Services 层**：监管、仲裁、Token 经济、上下文管理等业务逻辑
- **Tools 层**：内置工具 + 自定义工具 + 工具注册表
- **Infra 层**：数据库、日志、LLM 调用、安全、配置等基础设施

## 2. 核心概念

### 2.1 Loop（循环）

Loop 是 Civitas-AI 的核心执行单元。每次用户任务对应一个 Loop，包含多轮迭代。

每轮迭代执行 **十步序列**：

| 步骤 | 名称 | 说明 |
|------|------|------|
| ① | 输入接收 | Interface → Core |
| ② | 前置监管 | 注入检测 + 频率限制 + 权限验证 |
| ③ | 中间件管线 | beforeAgent / beforeModel 钩子 |
| ④ | 上下文组装 | 四级分区（S/L/M/H）上下文装配 |
| ⑤ | 监管懒监听 | compress/summary/reasoning/loop 四监管 |
| ⑥ | 模型调用 | wrapModelCall 中间件包裹 |
| ⑦ | 输出解析 | 文本/工具调用/混合解析 |
| ⑧ | 工具执行 | wrapToolCall + 危险分级管控 |
| ⑨ | 后置监管 | 异常扫描 + 退出决策 |
| ⑩ | 迭代判定 | StopRules 五类退出判定 |

### 2.2 Agent 角色

> 2026-10-03 校准：原表信任级写反（曾标 Prime Director=L0、Worker/Reviewer/Assembly Node=L1）。以下为 `Src/Infra/Security/trustLevels.ts:132-145` + `Configs/security.json:4-6` 的实态映射，启动期由 `Src/main.ts:102 initTrustLevels(trustConfig)` 注入。

| 角色 | 信任级别 | 职责 |
|------|---------|------|
| Regulator | L0 治理级 | 行为监管 |
| Auditor | L0 治理级 | 资源审计 |
| Arbitrator | L0 治理级 | 冲突裁决 |
| Prime Director | L1 入口级 | 任务分解与调度 |
| Partner | L1 入口级 | 协同推理与方案评审 |
| Worker | L2 执行子级 | 具体任务执行 |
| Reviewer | L2 执行子级 | 产出质量审核 |
| Assembly Node | L2 执行子级 | 流水线处理节点 |

三级模型（`trustLevels.ts:5-12`）：L0 治理级（监管/审计/仲裁，最高权限）、L1 入口级（接收用户输入、递归派发子 Agent）、L2 执行子级（仅执行上级派发任务，不可接收外部输入）。未知角色默认按 L2 最小权限处理（`trustLevels.ts:155-157`）。

信任级的权限后果（`trustLevels.ts:199-207`，详见 §4.2）：

- **L0**：可使用除 FORBIDDEN 外的全部工具
- **L1**：仅可使用 SAFE / CONTROLLED
- **L2**：仅可使用 SAFE

### 2.3 Token 经济

系统采用双预算制：
- **warm 区间**（36%）：正常执行
- **soft 区间**（60%）：预警，开始收敛
- **expand 区间**（80%）：可申请扩展
- **hard 区间**（100%）：强制停止

### 2.4 Verifier 四级验证

L1 硬验证（test/schema/numeric）→ L2 规则验证 → L3 LLM Judge → L4 人类审批门

四级实现位于 `Src/Services/LoopControl/verifier/`（`hardVerifier.ts` / `ruleVerifier.ts` / `llmJudge.ts` / `humanGateCore.ts` / `antiGaming.ts`）。

> 2026-10-03 校准：通过判据**不是四级全跑**。实态约束（`Configs/loopConfig.json:48-51`）：
> - `minLevelsRequired: 2` —— 最少需运行并通过 2 个验证层级，禁止只用 L3（校验点 `Src/Services/LoopControl/verifier/index.ts:47,97-99`）
> - `l3MinAgreementWithHuman: 0.85` —— L3 LLM Judge 与人工评分一致率下限 85%
> - `l3CalibrationDataset: "Tests/GoldenSets/review-50"` —— ⚠️ 未实现/目标态：该标注集目录当前**不在仓库中**（仅配置引用），重校准周期 `l3RecalibrateIntervalDay: 90`，对应脚本 `Scripts/rubricRecalibrate.ts`（`npx tsx Scripts/rubricRecalibrate.ts`，目标一致率 ≥ 85%）

## 3. 配置详解

详见 [configuration.md](configuration.md)。

## 4. 工具开发

### 4.1 创建自定义工具

在 `Src/Tools/Custom/` 下创建工具定义文件。

> 2026-10-03 校准：类型实态为 `ToolDefinition = { spec: ToolSpec, execute: ToolExecutor }`（`Src/Tools/Traits/toolSpec.ts:198-201`），`name/version/dangerLevel/...` 等字段**必须包在 `spec` 内**；`execute` 签名为 `(input, context) => Promise<ToolResult>`（`:190-193`）。`ToolSpec` 除 `idempotencyKeyFields`（`idempotency != 'NO'` 时必填）与 `rateLimitPerAgent` 外**全部字段必填，缺一即 Registry 拒注**（`:47-86`）。旧示例无 `spec` 包裹层，照抄无法编译也无法注册，已按仓库真实工具改写：

```typescript
import type { ToolDefinition } from '../Traits/toolSpec.js';
import { toolSuccess } from '../Traits/toolSpec.js';
import { contentOutputSchema } from '../Builtin/_shared.js';

export const myTool: ToolDefinition = {
  spec: {
    name: 'my.custom_tool',
    version: '1.0.0',
    description: '单一职责简述（展示给模型）',
    inputSchema: {
      type: 'object',
      properties: { target: { type: 'string', description: '处理对象' } },
      required: ['target'],
      additionalProperties: false,   // 严格 Schema，禁止 additionalProperties:true
    },
    // 输出 Schema 必须包含 status + recoverable（toolSpec.ts:61）
    outputSchema: contentOutputSchema('{ result }'),
    dangerLevel: 'CONTROLLED',
    idempotency: 'NO',               // 'YES' | 'NO' | 'CONDITIONAL'
    reversibility: 'REVERSIBLE',     // 'REVERSIBLE' | 'PARTIAL' | 'IRREVERSIBLE'
    sideEffectScope: 'workspace',    // 'none'|'workspace'|'filesystem'|'network'|'process'|'external'
    requiredRoles: ['worker'],       // 可调用的最低角色集合
    sandboxMode: 'standard',         // 'strict' | 'standard' | 'none'
    timeoutMs: 30_000,
  },
  execute: async (input, context) => {
    // input: Record<string, unknown>
    // context: ToolExecutionContext（operationId / agentId / agentRole / sessionId / workDir / signal ...）
    const target = String(input.target);
    // 工具逻辑…
    return toolSuccess(context.operationId, { result: `已处理 ${target}` });
  },
};
```

参考实现：`Src/Tools/Custom/agentRecruiter.ts:39`（DANGEROUS + 审批链路示例）、`Src/Tools/Custom/submitForReview.ts`；内置工具批量见 `Src/Tools/Builtin/`。

### 4.2 工具危险分级

| 级别 | 说明 | 执行约束 |
|------|------|---------|
| SAFE | 无副作用 | 直接执行 |
| CONTROLLED | 有副作用但可逆 | 走 EffectJournal |
| DANGEROUS | 高危险 | 需 ApprovalGate |
| FORBIDDEN | 禁止使用 | 系统拒绝 |

> 2026-10-03 校准：四级枚举与"FORBIDDEN 系统拒绝、DANGEROUS 建审批"的表述与代码一致（`Src/Infra/Security/trustLevels.ts:35,195-207`；`Src/Services/LoopControl/middleware/toolSafetyGate.ts:129-144`）。补充两条实态约束：
>
> **① 工具可见性（2026-10-04 修订，FE-051）**：可见性唯一真相源 = `ToolSpec.requiredRoles`（谓词 `Src/Tools/Factory/toolFactory.ts · isSpecVisibleForRole`；装配侧 `toolHeader.buildToolHeader` 与执行侧 `toolRegistry.executeTool` 同一口径）。原"信任级 × 危险级 二次裁剪"矩阵（`isToolAllowed`）**已废弃并标注 `@deprecated`，不再参与普通工具裁剪**；危险工具的执行管控由审批与副作用分流承担（见 ②），与可见性两轴正交。
>
> **② 审批/副作用分流细节**（`toolSafetyGate.ts:7-8,129-144`）：仅 **DANGEROUS + IRREVERSIBLE** 走阻塞式 ApprovalGate（超时默认**拒绝**，窗口秒数取 `Configs/security.json → security.approvalTimeoutSec`，当前 300，消费点 `Src/main.ts:121`）；CONTROLLED 与 DANGEROUS+REVERSIBLE 走 EffectJournal 副作用日志。
>
> **③ autoApprove 白名单（现状记录）**：`Configs/security.json:19-23` 存在 `security.autoApprove.tools` 白名单，命中的 DANGEROUS+IRREVERSIBLE 工具将**跳过人工确认**、仅播放"审查中"动画后自动通过（`toolSafetyGate.ts:186-195`，启动期由 `Src/main.ts:115-119` 注入）。当前 `tools: []` 为空，即**全部仍需人工确认**；`delayMs: 600` 为动画时长。
>
> 【需人工裁定·登记】`autoApprove` 涉安全语义，是否在对外指南明示由产品/工程裁定；本节暂按现状如实登记。对应工单：Server-02 差别清单 FG-3。

## 5. 提示词管理

详见 [Prompts 目录文档](../../../Prompts/README.md)。

- 角色提示词：`Prompts/roles/{role}.md`
- 系统提示词：`Prompts/system/mainLoop.md`
- 任务模板：`Prompts/tasks/defaultTask.md`
- 版本清单：`Prompts/versions/manifest.json`

## 6. 监控与调试

### 6.1 日志

日志位于 `Logs/` 目录，JSON Lines 格式，支持文件轮转。

### 6.2 事件追踪

每个操作都有 `trace_id`，可通过事件总线查询完整链路。

### 6.3 数据库

SQLite 数据库位于 `Data/db/`：
- `civitas_main.db`：主数据（Loop、Agent、策略等）
- `civitas_events.db`：事件日志
- `civitas_memory.db`：共享记忆
