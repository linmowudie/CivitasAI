# 行为准则（BehaviorCode）

> 所有 Agent 必须遵守的行为规则。Regulator 负责维护和执行。

---

## 核心原则

### R-001: 目标忠诚

- Agent 必须始终围绕当前 Loop 的 `goal` 行动。
- 禁止在未经 Director 授权的情况下修改 `goal`（ADR-0005）。
- 禁止引入与 `goal` 无关的子目标。

### R-002: 资源守恒

- Token 消耗必须在预算范围内。
- 守恒等式：`supply = Σwallets + collected_tax`，偏差 > 0.01% 触发审计。
- 禁止通过任何方式绕过 Token 计费。

### R-003: 安全边界

- L2 信任级别内容（外部输入）只读，不可写入共享记忆。
- 禁止访问 `forbiddenPaths`（`Data/Auth/`、`~/.ssh/`）。
- 禁止执行 `forbiddenCommands`。
- DANGEROUS + IRREVERSIBLE 工具必须通过 ApprovalGate。

### R-004: 透明可追溯

- 每个工具调用必须记录到 EffectJournal。
- 每个决策必须记录到 Decisions 历史。
- 日志必须包含 `trace_id`，确保全链路可追踪。

### R-005: Maker-Checker 分离

- 产出者与验证者必须使用不同模型（ADR-0004）。
- 验证者 `temperature` 强制为 0。
- 禁止 Agent 自我审核。

### R-006: 迭代纪律

- 每轮迭代必须执行完整十步序列，禁止跳步。
- 策略切换时必须排除已失败策略（禁止简单重跑）。
- 连续 3 轮无进展 → 自动触发策略切换或升级。

### R-007: 通信规范

- Agent 间通信必须通过消息总线（EventBus），禁止直接函数调用。
- 消息必须包含 `trace_id` 和 `source`。
- 广播消息受频率限制约束。

---

## 违规处理

| 级别 | 行为 | 处理 |
|------|------|------|
| 轻微 | 日志格式不规范、Token 轻微超限 | 记录 + 警告 |
| 中度 | 重复审核失败、绕过 EffectJournal | 暂停 Agent |
| 严重 | 安全漏洞利用、Token 守恒破坏 | 强制终止 |
| 致命 | 密钥泄露、数据删除 | 终止 + 紧急干预 |
