# Benchmarks — 基准与实验矩阵

系统性覆盖评估的单一事实源：12 个系统面 × 3 类实验（BEN 非对抗 / ENV 环境故障 / SEC 恶意攻击）。

## 文件

| 文件 | 内容 |
|------|------|
| `experimentMatrix.json` | 42 个实验 cell 的单一事实源（BEN=13 / ENV=12 / SEC=17；status 三态：`existing-covered` / `new-scaffold` / `declared-only`），每个 cell 锚定真实模块导出与门禁（G0-G14 / DUR-*） |
| `datasets/sampleTasks.json` | 非对抗基准任务集 |
| `datasets/adversarialSeeds.json` | 攻击与故障语料种子（目录遍历 / 禁止命令 / 越权工具 / 注入文本 / 超预算 / 风暴 / 死锁等） |
| `baselines/metrics.json` | 指标基线（与 `Configs/benchBaseline.json` 联动，CI 读写） |

## 运行

```bash
node Scripts/experimentMatrix.cjs   # 矩阵守门：强制四条覆盖规则，违反非 0 退出
npm test                            # 执行 Tests/Experiments/ 下锚定用例
```

设计文档：[Docs/17-实验矩阵与评估/实验矩阵设计.md](../Docs/17-实验矩阵与评估/实验矩阵设计.md)。

## 约定

- 矩阵与用例不允许漂移：新增/删除测试须同步更新 `experimentMatrix.json`
- 检测点尚不存在的项只登记为 `declared-only`（声明方法与判据），**不写伪断言**
