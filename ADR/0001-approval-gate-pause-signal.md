# ADR-0001: 审批门暂停信号为合法中断来源

## 状态
已接受（Accepted）

## 背景
当 Loop 运行中命中审批门（`ApprovalGate`）时，系统需要暂停当前 Loop 等待人工审批。此暂停必须被识别为合法中断来源，而非错误或超时。

## 决策
- 审批门触发时，Loop 进入 `awaiting_approval` 阶段（`loops.phase`），Agent 状态不变
- 审批超时行为由 `supervision.approvalDefaultOnTimeout` 控制，**默认 `reject`**（fail-closed）
- 禁止任何"无应答自动通过"机制
- `pending_approvals.default_on_timeout` 只允许 `reject` 或 `abort_loop`

## 后果
- 审批超时不会导致危险操作被执行
- Loop 可正确区分"审批暂停"与"错误终止"
- 恢复后从 `PendingApproval.payload` 续接
