# 代码债登记册（Code-Debt Register）

> **由实验矩阵自动生成** —— 生成时间 2026-10-17T11:13:08.830Z
> 来源：`Benchmarks/experimentMatrix.json`（`status` ∈ {gap, declared-only} 的 cell）
> 生成器：`Scripts/benchGapReport.cjs`（`npm run bench:gaps`）。**不要手改本文件**，改矩阵后重新生成。

## 汇总

落地状态：**实测 executed 65** 条 ｜ 仅静态对账 static-attested 3 条（单列，不计入落地率）
红灯 cell 共 **0** 条（gap 0 + declared-only 0），占全部 74 条 cell 的 0.0%。

| 阻塞类型 | 条数 | 含义 |
|---|---:|---|

分类由 `status` + `anchor.kind` **推导**（不手写），因此不会与矩阵不同步。

---

## 使用方式

1. **修一条** → 在矩阵里把该 cell 从 `gap` 改成 `existing-covered` 并换上可解析的锚点；
   守门的**双向一致性规则**会在"债已还但矩阵未转正"时报违规，反之亦然。
2. **确认无法修** → 在 cell 的 `method` 里补上更硬的实测依据（日期 + 代码位置），而不是留"待补"。
3. **本册不是 CI 阻断项**：`gap` 按设计不进 CI 阻断（缺口证明实验），
   但登记册的**条数与矩阵必须一致** —— `npm run bench:metrics` 会校验，不一致即视为陈旧。
