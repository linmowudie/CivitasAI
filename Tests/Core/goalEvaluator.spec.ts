/**
 * P2 · `GoalEvaluator` 纯判定原语 —— §P2 五条反例的**逐条证伪**
 *
 * 设计出处：Docs/Dev/L1编排设计/23-原语补齐与监管快照.md §P2（反例表 1–5）
 *   · 27-判据执行者覆盖.md 第 7 行（「Goal 未声明出口判定」的执行者）
 * 纪律（25 §1）：负向用例必须真实调用。
 *
 * 为什么单独一份（不并进 `patterns.spec.ts`）：约束件（E4）的测试只能验证**接入后**的行为，
 * 而 §P2 的三条纪律（无状态、可复算、不接受执行端口）属于**原语自身**，
 * 必须在原语层面证伪，否则"约束件委托原语"这句话里没有可验的内容。
 */
import { describe, it, expect } from "vitest";

import {
  createGoalEvaluator,
  evaluateGoal,
  type GoalDecl,
  type GoalSuggestion,
} from "../../Src/Core/Goal/goalEvaluator.js";

const DIGEST = "sha256:immutable-zone-v1";

function goal(over: Partial<GoalDecl> = {}): GoalDecl {
  return {
    id: "g-1",
    statement: "接口全部返回 2xx",
    criteria: "存在 3 条通过的真实响应记录",
    immutableZoneDigest: DIGEST,
    ...over,
  };
}

function evaluator(over: Partial<GoalDecl> = {}) {
  const r = createGoalEvaluator(goal(over));
  if (!r.ok) throw new Error("原语应可创建: " + r.error);
  return r.value;
}

describe("P2 · 反例 1：原语不执行动作来「验证」目标", () => {
  it("【负向】塞入任何执行端口 ⇒ 构造期即拒", () => {
    for (const ports of [
      { toolExec: () => undefined },
      { modelPort: {} },
      { spawn: () => undefined },
    ]) {
      const r = createGoalEvaluator(goal(), ports);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("不接受执行/副作用端口");
    }
  });

  it("端口表为空对象 ⇒ 不算注入（不误伤正常构造）", () => {
    expect(createGoalEvaluator(goal(), {}).ok).toBe(true);
  });
});

describe("P2 · 反例 2：只给建议，不产生状态转移", () => {
  it("裁决取值闭集内，且**没有**任何状态转移字段", () => {
    const v = evaluator().evaluate(
      { goalSatisfied: true, evidence: "3 records" },
      DIGEST,
    );
    if (!v.ok) throw new Error("判定应成功: " + v.error);
    const allowed: GoalSuggestion[] = ["running", "terminate", "degrade"];
    expect(allowed).toContain(v.value.suggestion);
    // 状态归 C1：裁决里不得出现 next/state/decision 之类的转移指令
    const keys = Object.keys(v.value).sort();
    expect(keys).toEqual(["gaps", "needsReanchor", "satisfied", "suggestion"]);
  });
});

describe("P2 · 反例 3：未声明判定口径 ⇒ 无法判定", () => {
  it.each(["", "   ", "\t"])("【负向】criteria=%j ⇒ 构造期拒绝", (criteria) => {
    const r = createGoalEvaluator(goal({ criteria }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("判定口径");
  });

  it("【负向】未声明不可变区摘要 ⇒ 构造期拒绝", () => {
    const r = createGoalEvaluator(goal({ immutableZoneDigest: "" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("不可变区摘要");
  });
});

describe("P2 · 反例 4：同一输入必得同一结论（可复算）", () => {
  it("同一实例、同一输入 ⇒ 两次裁决深相等", () => {
    const e = evaluator();
    const produced = { goalSatisfied: true, evidence: "3 records" };
    expect(e.evaluate(produced, DIGEST)).toEqual(e.evaluate(produced, DIGEST));
  });

  it("两个实例、同一 Goal ⇒ 结论相同（原语不持有实例状态）", () => {
    const produced = { goalSatisfied: false };
    expect(evaluator().evaluate(produced, DIGEST)).toEqual(
      evaluator().evaluate(produced, DIGEST),
    );
  });

  it("判定**不修改**入参 produced", () => {
    const produced = { goalSatisfied: true, evidence: "3 records" };
    const before = JSON.stringify(produced);
    const v = evaluator().evaluate(produced, DIGEST);
    if (!v.ok) throw new Error("判定应成功: " + v.error);
    expect(JSON.stringify(produced)).toBe(before);
  });

  it("纯函数入口与实例入口同形（同一份判定体）", () => {
    const produced = { goalSatisfied: true, evidence: "e" };
    expect(
      evaluateGoal({ goal: goal(), produced, immutableZoneDigest: DIGEST }),
    ).toEqual(evaluator().evaluate(produced, DIGEST));
  });
});

describe("P2 · 反例 5：不得忽略不可变区摘要", () => {
  it("【负向】摘要漂移 ⇒ 即便证据齐备也不得判为达成", () => {
    const v = evaluator().evaluate(
      { goalSatisfied: true, evidence: "3 records" },
      "sha256:mutated-zone",
    );
    if (!v.ok) throw new Error("判定应成功: " + v.error);
    expect(v.value.satisfied).toBe(false);
    expect(v.value.suggestion).toBe("degrade"); // 判定基础被污染：既非 running 也非 terminate
    expect(v.value.gaps[0]!.what).toContain("不可变区摘要");
  });

  it("【负向】未传入当前摘要（空串）⇒ 拒绝判定，而不是默认达成", () => {
    for (const digest of ["", "   "]) {
      const r = evaluator().evaluate(
        { goalSatisfied: true, evidence: "e" },
        digest,
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("不可变区摘要");
    }
  });

  it("【负向】声称达成但无证据 ⇒ 不达成（03 §6 第 15 行：组件自称 success 不被接受）", () => {
    const v = evaluator().evaluate({ goalSatisfied: true }, DIGEST);
    if (!v.ok) throw new Error("判定应成功: " + v.error);
    expect(v.value.satisfied).toBe(false);
    expect(v.value.suggestion).toBe("running");
    expect(v.value.gaps[0]!.what).toContain("证据");
  });

  it("达成需要**同时**满足：声明达成 + 非空证据 + 摘要一致", () => {
    const v = evaluator().evaluate(
      { goalSatisfied: true, evidence: "3 records" },
      DIGEST,
    );
    if (!v.ok) throw new Error("判定应成功: " + v.error);
    expect(v.value.satisfied).toBe(true);
    expect(v.value.suggestion).toBe("terminate");
    expect(v.value.gaps).toEqual([]);
  });
});

describe("P2 · 重锚信号如实转记（复用既有机制，不自造）", () => {
  it("⑤ 步压缩后置位 ⇒ needsReanchor=true", () => {
    const v = evaluator().evaluate(
      { goalSatisfied: true, evidence: "e", needsGoalReanchor: true },
      DIGEST,
    );
    if (!v.ok) throw new Error("判定应成功: " + v.error);
    expect(v.value.needsReanchor).toBe(true);
  });

  it("未置位 ⇒ false（原语不自行决定要重锚）", () => {
    const v = evaluator().evaluate(
      { goalSatisfied: true, evidence: "e" },
      DIGEST,
    );
    if (!v.ok) throw new Error("判定应成功: " + v.error);
    expect(v.value.needsReanchor).toBe(false);
  });

  it("摘要漂移时同样转记重锚信号（两件事互不遮蔽）", () => {
    const v = evaluateGoal({
      goal: goal(),
      produced: { needsGoalReanchor: true },
      immutableZoneDigest: "sha256:mutated-zone",
    });
    if (!v.ok) throw new Error("判定应成功: " + v.error);
    expect(v.value.satisfied).toBe(false);
    expect(v.value.needsReanchor).toBe(true);
  });
});
