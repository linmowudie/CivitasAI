# 任务提示词模板

> 本模板由 Prime Director 在任务拆解时填充，作为 Worker 的任务上下文。

---

## 任务描述

{{taskDescription}}

## 输入上下文

{{contextFromPreviousIterations}}

## 成功标准

{{successCriteria}}

## 可用工具

{{availableTools}}

## 约束

- Token 预算：{{tokenBudget}}
- 最大迭代：{{maxIterations}}
- 时间限制：{{timeLimitMs}}ms

## 期望输出

{{expectedOutput}}
