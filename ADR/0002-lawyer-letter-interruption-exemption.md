# ADR-0002: 律师函挂起为合法中断豁免

## 状态
已接受（Accepted）

## 背景
监管局（Regulatory Authority）或审计局（Resource Audit Bureau）可向运行中的 Agent 发送 `SUSPEND_AND_NOTIFY`（律师函），要求立即冻结。此挂起属于合法中断来源（ADR 豁免），不应被视为错误。

## 决策
- Agent 收到 `SUSPEND_AND_NOTIFY` 后，状态从 `running` → `suspended`
- `LoopState` 完整冻结，不丢失
- 收到 `RESTORATION_ACK` 后从 `last_checkpoint_id` 续接
- 同一 `(loopId, conflictId)` 5 分钟内只挂一次（去重）

## 后果
- 监管干预不会导致数据丢失
- 挂起期间资源释放，但状态可恢复
- 与 Docs/12 §6 审批门机制一致
