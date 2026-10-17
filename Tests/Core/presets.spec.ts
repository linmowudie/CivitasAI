/**
 * 5 个 RoutingMode 预设 + 组合子测试（Seq / Par / Branch / Fallback）
 *
 * 设计出处：22-执行件-三种模式.md §7（迁移策略 + A/B 前提）· 02（算子闭集）
 * 纪律（25 §1）：负向用例必须真实调用。
 */
import { describe, it, expect } from "vitest";

import {
  branch,
  fallback,
  par,
  seq,
} from "../../Src/Core/Patterns/combinators.js";
import { ROUTING_MODES } from "../../Src/Core/Decision/types.js";
import {
  presetFor,
  presetDescriptors,
  MODES_WITH_BASELINE,
  MODES_WITHOUT_BASELINE,
  type PresetParts,
} from "../../Src/Core/Patterns/presets.js";
import type {
  Executable,
  ReactInput,
  ReactOutput,
} from "../../Src/Core/Orchestration/outerLoop.js";
import { ok, err, type Result } from "../../Src/Infra/types.js";

function mkInput(): ReactInput {
  return {
    state: "running",
    control: { shouldContinue: true, budgetRemaining: 100, cycle: 0 },
    observation: { contextSections: [], history: [], upstream: {}, events: [] },
    grants: {
      tools: [],
      plugins: [],
      visible: { sections: [], history: { recentTurns: 1 } },
    },
  };
}

function mkExec(
  id: string,
  behavior: "ok" | "fail",
  produced: Record<string, unknown> = {},
): { exe: Executable; calls: ReactInput[] } {
  const calls: ReactInput[] = [];
  return {
    calls,
    exe: {
      id,
      contract: {
        inputSet: { sections: [], history: { recentTurns: 1 } },
        outputSet: ["outer"],
        toolSet: [],
      },
      step: async (input: ReactInput): Promise<Result<ReactOutput>> => {
        calls.push(input);
        if (behavior === "fail") return err(id + " 失败");
        return ok({
          produced: { ...produced, by: id },
          events: [],
          needsDecision: [],
          usage: { tokens: 1, iterations: 1 },
        });
      },
    },
  };
}

describe("组合子 · Seq", () => {
  it("顺序执行且上游产物传给下一件", async () => {
    const a = mkExec("a", "ok");
    const b = mkExec("b", "ok");
    const s = seq("s", [a.exe, b.exe]);
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    const res = await s.value.step(mkInput());
    expect(res.ok).toBe(true);
    expect(a.calls.length).toBe(1);
    expect(b.calls.length).toBe(1);
    const upstream = b.calls[0]!.observation.upstream as {
      part0?: { by?: string };
    };
    expect(upstream.part0?.by).toBe("a");
  });

  it("【负向】中间失败 ⇒ 中止并原样返回失败", async () => {
    const a = mkExec("a", "ok");
    const b = mkExec("b", "fail");
    const c = mkExec("c", "ok");
    const s = seq("s", [a.exe, b.exe, c.exe]);
    if (!s.ok) return;
    const res = await s.value.step(mkInput());
    expect(res.ok).toBe(false);
    expect(c.calls.length).toBe(0);
  });

  it("【负向】空子件 ⇒ 拒绝创建", () => {
    expect(seq("s", []).ok).toBe(false);
  });
});

describe("组合子 · Par（join 语义）", () => {
  it("all：全部成功 ⇒ 成功；二者都被调用", async () => {
    const a = mkExec("a", "ok");
    const b = mkExec("b", "ok");
    const p = par("p", [a.exe, b.exe], "all");
    if (!p.ok) return;
    const res = await p.value.step(mkInput());
    expect(res.ok).toBe(true);
    expect(a.calls.length).toBe(1);
    expect(b.calls.length).toBe(1);
  });

  it("【负向】all：任一失败 ⇒ 整体失败", async () => {
    const p = par("p", [mkExec("a", "ok").exe, mkExec("b", "fail").exe], "all");
    if (!p.ok) return;
    expect((await p.value.step(mkInput())).ok).toBe(false);
  });

  it("settled：个别失败不影响整体（收集成功项）", async () => {
    const p = par(
      "p",
      [mkExec("a", "ok").exe, mkExec("b", "fail").exe],
      "settled",
    );
    if (!p.ok) return;
    const res = await p.value.step(mkInput());
    expect(res.ok).toBe(true);
  });

  it("【负向】any：全部失败 ⇒ 失败", async () => {
    const p = par(
      "p",
      [mkExec("a", "fail").exe, mkExec("b", "fail").exe],
      "any",
    );
    if (!p.ok) return;
    expect((await p.value.step(mkInput())).ok).toBe(false);
  });

  it("【负向】join 语义非法 / 空子件 ⇒ 拒绝创建", () => {
    expect(par("p", [mkExec("a", "ok").exe], "whatever" as never).ok).toBe(
      false,
    );
    expect(par("p", [], "all").ok).toBe(false);
  });
});

describe("组合子 · Branch / Fallback", () => {
  it("【负向】未命中分支 ⇒ 拒绝（不静默走默认）", async () => {
    const b = branch(
      "b",
      [{ when: "x", executable: mkExec("x", "ok").exe }],
      () => null,
    );
    if (!b.ok) return;
    const res = await b.value.step(mkInput());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("未命中任何分支");
  });

  it("【负向】选择的键没有对应分支 ⇒ 拒绝", async () => {
    const b = branch(
      "b",
      [{ when: "x", executable: mkExec("x", "ok").exe }],
      () => "zzz",
    );
    if (!b.ok) return;
    expect((await b.value.step(mkInput())).ok).toBe(false);
  });

  it("Fallback：首个成功即返回；全部失败返回最后一个错误", async () => {
    const a = mkExec("a", "fail");
    const b = mkExec("b", "ok");
    const c = mkExec("c", "ok");
    const f = fallback("f", [a.exe, b.exe, c.exe]);
    if (!f.ok) return;
    const res = await f.value.step(mkInput());
    expect(res.ok).toBe(true);
    expect(c.calls.length).toBe(0); // 命中 b 后不再尝试 c

    const allFail = fallback("f2", [
      mkExec("a", "fail").exe,
      mkExec("b", "fail").exe,
    ]);
    if (!allFail.ok) return;
    const r2 = await allFail.value.step(mkInput());
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error).toContain("b 失败");
  });
});

describe("RoutingMode 预设 · 六个模式都真实可构建", () => {
  const ZONE = "sha256:zone-v1";

  /** 期望可构建：构造失败必须**响**，不能 `return` 掉（否则负向纪律形同虚设） */
  function must<T>(r: Result<T>): T {
    if (!r.ok) throw new Error("期望构建成功但被拒绝: " + r.error);
    return r.value;
  }

  function fullParts(): PresetParts {
    return {
      body: mkExec("body", "ok").exe,
      workers: [mkExec("w1", "ok").exe, mkExec("w2", "ok").exe],
      stages: [mkExec("s1", "ok").exe, mkExec("s2", "ok").exe],
      partners: [mkExec("p1", "ok").exe, mkExec("p2", "ok").exe],
      claim: mkExec("claim", "ok").exe,
      defense: mkExec("defense", "ok").exe,
      arbiter: mkExec("arbiter", "ok").exe,
      approval: {
        id: "g",
        statement: "合规",
        criteria: "有审批证据",
        immutableZoneDigest: ZONE,
      },
      zoneDigestOf: () => ZONE,
    };
  }

  it("六个模式各自可构建为组合执行件（id 体现结构）", () => {
    const ids: Record<string, string> = {};
    for (const mode of ROUTING_MODES) {
      ids[mode] = must(presetFor(mode, fullParts())).id;
    }
    expect(ids.DIRECT!.startsWith("workflow(")).toBe(true);
    expect(ids.DELEGATION!.startsWith("par(")).toBe(true);
    expect(ids.ASSEMBLY_LINE!.startsWith("seq(")).toBe(true);
    expect(ids.CONSORTIUM!.startsWith("fallback(")).toBe(true);
    expect(ids.LITIGATION!.startsWith("fallback(")).toBe(true);
    expect(ids.REGULATION!.startsWith("workflow(")).toBe(true);
  });

  it("【负向】缺件时各模式拒绝构建（不产出半成品）", () => {
    expect(presetFor("DIRECT", {}).ok).toBe(false);
    expect(presetFor("DELEGATION", {}).ok).toBe(false);
    expect(presetFor("ASSEMBLY_LINE", {}).ok).toBe(false);
    expect(presetFor("CONSORTIUM", {}).ok).toBe(false);
    expect(presetFor("LITIGATION", {}).ok).toBe(false);
    expect(presetFor("REGULATION", { body: mkExec("b", "ok").exe }).ok).toBe(
      false,
    ); // 缺 approval
    expect(
      presetFor("REGULATION", {
        body: mkExec("b", "ok").exe,
        approval: {
          id: "g",
          statement: "合规",
          criteria: "有审批证据",
          immutableZoneDigest: ZONE,
        },
      }).ok,
    ).toBe(false); // 缺不可变区摘要观测通道
  });

  it("DELEGATION 真并行：两个 worker 都被调用；单个失败 ⇒ 整体失败（join=all）", async () => {
    const w1 = mkExec("w1", "ok");
    const w2 = mkExec("w2", "fail");
    const r = presetFor("DELEGATION", { workers: [w1.exe, w2.exe] });
    if (!r.ok) return;
    const res = await r.value.step(mkInput());
    expect(res.ok).toBe(false);
    expect(w1.calls.length).toBe(1);
    expect(w2.calls.length).toBe(1);

    const tolerant = presetFor("DELEGATION", {
      workers: [w1.exe, w2.exe],
      join: "settled",
    });
    if (!tolerant.ok) return;
    expect((await tolerant.value.step(mkInput())).ok).toBe(true);
  });

  it("ASSEMBLY_LINE 真流水线：阶段顺序与上游传递", async () => {
    const s1 = mkExec("s1", "ok");
    const s2 = mkExec("s2", "ok");
    const r = presetFor("ASSEMBLY_LINE", { stages: [s1.exe, s2.exe] });
    if (!r.ok) return;
    const res = await r.value.step(mkInput());
    expect(res.ok).toBe(true);
    const up = s2.calls[0]!.observation.upstream as { part0?: { by?: string } };
    expect(up.part0?.by).toBe("s1");
  });

  it("CONSORTIUM：仲裁件失败时回落到汇聚结果（Fallback 真实生效）", async () => {
    const p1 = mkExec("p1", "ok");
    const p2 = mkExec("p2", "ok");
    const arbiter = mkExec("arbiter", "fail");
    const r = presetFor("CONSORTIUM", {
      partners: [p1.exe, p2.exe],
      arbiter: arbiter.exe,
    });
    if (!r.ok) return;
    const res = await r.value.step(mkInput());
    expect(res.ok).toBe(true); // 仲裁失败 ⇒ 用汇聚结果
    expect(arbiter.calls.length).toBe(1);
  });

  it("LITIGATION：按选择键走主张或抗辩；仲裁失败回落", async () => {
    const claim = mkExec("claim", "ok");
    const defense = mkExec("defense", "ok");
    const defenseMode = presetFor("LITIGATION", {
      claim: claim.exe,
      defense: defense.exe,
      chooseLitigation: () => "defense",
    });
    if (!defenseMode.ok) return;
    await defenseMode.value.step(mkInput());
    expect(claim.calls.length).toBe(0);
    expect(defense.calls.length).toBe(1);

    const arbiter = mkExec("arbiter", "fail");
    const withArbiter = presetFor("LITIGATION", {
      claim: claim.exe,
      defense: defense.exe,
      arbiter: arbiter.exe,
    });
    if (!withArbiter.ok) return;
    expect((await withArbiter.value.step(mkInput())).ok).toBe(true);
  });

  it("【负向】REGULATION：声称达成但无证据 ⇒ 审批门拒绝", async () => {
    const body = mkExec("body", "ok", { goalSatisfied: true }); // 无 evidence
    const r = presetFor("REGULATION", {
      body: body.exe,
      approval: {
        id: "g",
        statement: "合规",
        criteria: "有审批证据",
        immutableZoneDigest: ZONE,
      },
      zoneDigestOf: () => ZONE,
    });
    if (!r.ok) throw new Error("REGULATION 应可构建: " + r.error);
    const res = await r.value.step(mkInput());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("拒绝该断言");
  });

  it("【负向】REGULATION：审批依据的不可变区被改 ⇒ 即便有证据也拒绝收口", async () => {
    const body = mkExec("body", "ok", {
      goalSatisfied: true,
      evidence: "审批单#1",
    });
    const r = presetFor("REGULATION", {
      body: body.exe,
      approval: {
        id: "g",
        statement: "合规",
        criteria: "有审批证据",
        immutableZoneDigest: ZONE,
      },
      zoneDigestOf: () => "sha256:zone-tampered", // 外层观测到不可变区已漂移
    });
    if (!r.ok) throw new Error("REGULATION 应可构建: " + r.error);
    const res = await r.value.step(mkInput());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("不可变区摘要");
  });

  it("基线归属如实：4 个有 A 侧基线（可 A/B）· 2 个无基线（新设计）", () => {
    expect([...MODES_WITH_BASELINE]).toEqual([
      "DIRECT",
      "DELEGATION",
      "ASSEMBLY_LINE",
      "CONSORTIUM",
    ]);
    expect([...MODES_WITHOUT_BASELINE]).toEqual(["LITIGATION", "REGULATION"]);
    const ds = presetDescriptors({});
    for (const d of ds) {
      if (MODES_WITHOUT_BASELINE.includes(d.mode)) {
        expect(d.baseline.kind).toBe("absent");
        if (d.baseline.kind === "absent")
          expect(d.baseline.note).toContain("A 侧基线不存在");
      } else {
        expect(d.baseline.kind).toBe("implemented");
        if (d.baseline.kind === "implemented")
          expect(d.baseline.at).toContain("orchestrator.ts:");
      }
    }
  });
});
