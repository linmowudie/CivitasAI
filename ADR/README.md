# ADR — 架构决策记录

编号递增，不可修改已接受决策的语义；推翻旧决策需新增 ADR 并标注 supersede 关系。

| 编号 | 标题 | 一句话结论 |
|------|------|-----------|
| [0001](0001-approval-gate-pause-signal.md) | 审批门暂停信号为合法中断来源 | ApprovalGate 触发的暂停不计入异常中断/失败统计 |
| [0002](0002-lawyer-letter-interruption-exemption.md) | 律师函挂起为合法中断豁免 | 仲裁律师函挂起导致的循环中断豁免于停滞/失败判定 |
| [0003](0003-verifier-four-tier-non-skip.md) | Verifier 四级不可跨越 | L1 硬验证 → L2 规则 → L3 LLM Judge → L4 人类审批门，任何配置不得跳级 |
| [0004](0004-maker-checker-model-diversity.md) | Maker-Checker 模型多样性 | producerModel ≠ verifierModel，生成与验证必须异模型 |
| [0005](0005-loopstate-immutable-from-compression.md) | LoopState 不可变区禁止压缩触及 | goal / immutableConstraints 不得被上下文压缩修改 |
| [0006](0006-middleware-contract-relocated-to-infra.md) | 中间件类型契约下沉至 Infra 共享内核 | 中间件类型定义迁至 `Src/Infra/Contracts/`，解除 Core↔Services 类型互引 |

## 关联文档

- 主循环与中间件：[Docs/02-核心架构](../Docs/02-核心架构/核心架构设计.md)、[Docs/12-循环控制系统](../Docs/12-循环控制系统/循环控制系统设计.md)
- 参数取值：[Docs/15-参数总典](../Docs/15-参数总典与接口契约/参数总典.md)
