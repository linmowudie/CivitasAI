# 任务执行 Playbook

> Worker 执行任务时的标准操作流程（SOP）。

---

## 1. 接收任务

1. 解析 Assignment 中的 `description`、`requiredTools`、`tokenBudget`、`maxIterations`。
2. 确认自身角色和信任级别是否满足工具使用要求。
3. 初始化 LoopState，记录 `goal` 和 `immutableConstraints`。

## 2. 规划阶段（第 1 轮迭代）

1. 分析任务复杂度，判断是否需要拆解。
2. 选择初始策略（从 `Skills/strategies/candidates.json` 中选取）。
3. 记录策略到 StrategyLedger：`recordStrategy(loopId, { strategy, expectedOutcome })`。

## 3. 执行阶段（第 2~N-1 轮迭代）

每轮迭代遵循主循环十步序列：

```
① 输入接收 → ② 前置监管 → ③ 中间件管线 → ④ 上下文组装
→ ⑤ 监管懒监听 → ⑥ 模型调用 → ⑦ 输出解析
→ ⑧ 工具执行 → ⑨ 后置监管 → ⑩ 迭代判定
```

### 工具执行规范

| 步骤 | 操作 | 说明 |
|------|------|------|
| 1 | 检查危险级别 | SAFE → 直接执行；CONTROLLED → EffectJournal；DANGEROUS → ApprovalGate |
| 2 | 生成幂等键 | `makeIdempotencyKey(toolName, args, loopId)` |
| 3 | 查幂等缓存 | `lookup(idemKey)` → 命中则跳过执行 |
| 4 | 记录意图 | `recordIntent({ kind: 'tool_call', ... })` |
| 5 | 执行工具 | 更新状态为 EXECUTING → SUCCEEDED/FAILED |
| 6 | 存储结果 | `store(idemKey, loopId, result)` |

### 异常处理

- 工具调用失败 → 记录到 `consecutiveErrors`，达 3 次则停止。
- 策略无效 → `backfillStrategyResult` 记录失败 → `selectNextStrategy` 选取替代。
- Token 接近 `softRatio` → 触发 warm 预警，开始收敛。

## 4. 收尾阶段（最后一轮迭代）

1. 执行后置监管（`runPostSupervision`）。
2. 写 Checkpoint（`checkpointWriterMiddleware`）。
3. 提交审核（`submitForReview`）。
4. 等待 Reviewer 反馈。

## 5. 审核响应

- 审核通过 → 任务完成，状态转为 `ready`。
- 审核拒绝 → 根据反馈调整，进入新一轮迭代。
- 连续 3 次拒绝 → 升级至 Director 重新规划。
