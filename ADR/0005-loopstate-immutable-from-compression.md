# ADR-0005: LoopState 不可变区禁止压缩触及

## 状态
已接受（Accepted）

## 背景
`LoopState` 包含不可变区（`goal`、`immutableConstraints`）和可变区。上下文压缩/摘要算法不得修改不可变区内容，否则会导致目标漂移——Agent 在长任务中逐渐偏离原始目标。

## 决策
- `LoopState.goal` 和 `LoopState.immutableConstraints` 不在任何压缩机制的可写集
- 压缩/摘要算法尝试修改不可变区 → 写入被拒（运行期抛错）
- `LoopState` 独立持久化到 `Data/Loops/{session_key}/state.json`，不在上下文分区中
- 压缩后必须触发 `GoalReanchorMiddleware`（下轮开头重锚目标）

## 后果
- 30 轮长任务中原始约束始终保留在上下文中
- 压缩不会破坏任务事实
- Context ≠ State 红线得到保障
