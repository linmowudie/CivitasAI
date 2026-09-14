# ADR-0004: Maker-Checker 模型多样性

## 状态
已接受（Accepted）

## 背景
在 Maker-Checker 模式下，产出者（Producer）与验证者（Checker）必须使用不同模型，以防止同一模型的盲区同时影响产出和验证。

## 决策
- `producerModel === verifierModel` → CI 拒收
- 验证者模型（`routing.verifierModel`）必须与产出者模型不同
- 验证者使用独立提示词、不共享上下文
- reviewer/arbitrator/auditor 角色 `temperature` 强制为 0，保证可重现性

## 后果
- 产出与验证形成真正的交叉检查
- 验证结果具备可重现性（temperature=0）
- CI 层面可自动检测违规
