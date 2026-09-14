# ADR-0003: Verifier 四级不可跨越

## 状态
已接受（Accepted）

## 背景
验证器分为四级：L1 硬验证、L2 规则验证、L3 LLM Judge、L4 人工审批。为防止 Reward Hacking 和成本失控，必须严格禁止跳级调用。

## 决策
- L1 未通过时，**禁止**直接调用 L3 LLM Judge
- 必须按 L1 → L2 → L3 → L4 顺序逐层递进
- `verifier.minLevelsRequired >= 2`：每个 Loop 至少通过 L1 + 一层更高
- 运行期跳级调用 → 抛错终止

## 后果
- 防止低成本验证被绕过导致高成本验证滥用
- 保证验证结果的可信度
- L3 Judge 需定期用人工标注集校准（一致率 ≥ 85%）
