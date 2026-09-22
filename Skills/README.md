# Skills — 策略与评分知识库

Agent 决策所需的外置"技能"：执行剧本、行为准则、评分标准、策略候选。

## 结构

| 目录/文件 | 用途 |
|-----------|------|
| `playbooks/taskExecution.md` | 任务执行剧本（各类任务的标准打法） |
| `rules/behaviorCode.md` | Agent 行为准则（约束与禁止事项） |
| `rubrics/verifierL3Calibration.json` | Verifier L3（LLM Judge）评分标准与校准数据 |
| `strategies/candidates.json` | 策略候选池（noProgress 触发 `switch_strategy` 时的切换来源） |

## 关联

- 评分标准由 `Scripts/rubricRecalibrate.ts` 定期重校准（Docs/14 §S14）
- L3 rubric 变更须与 [ADR-0003](../ADR/0003-verifier-four-tier-non-skip.md)（四级不可跨越）保持一致：L1/L2 硬规则不因评分调整而放松
- 通过 `Configs/dataStorage.json` 约定的路径与保留策略访问
