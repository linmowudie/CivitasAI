/**
 * 裁决超时兜底测试（不干等）
 *
 * 背景：六步闭环中途失败会让案件停在 filed/assembling/reasoning，且同 conflictId 拒绝新案
 * ⇒ 表现为"裁决一直不裁定"、调用方无限期干等。
 * 兜底口径（保守）：超时未裁 ⇒ 判 old_wins（维持现状）+ 既有终态 'timeout'，随后可重新立案。
 */
import { describe, it, expect } from "vitest";

import {
  fileCase,
  settleStaleCases,
  getCaseByConflictId,
} from "../../Src/Services/Arbitration/tribunal.js";

const uniq = (s: string) =>
  `${s}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

function fileOne(conflictId: string) {
  return fileCase({
    conflictId,
    traceId: "trace-" + conflictId,
    conflictType: "semantic_opposition",
    plaintiffAgentId: "agent-new",
    defendantAgentId: "agent-old",
  });
}

describe("裁决超时兜底 · settleStaleCases", () => {
  it("【负向】超时未裁 ⇒ 按保守默认结案（old_wins + timeout 终态），不再无限期挂起", () => {
    const conflictId = uniq("stale");
    const filed = fileOne(conflictId);
    expect(filed.ok).toBe(true);
    if (!filed.ok) return;
    const caseId = filed.value.caseId;
    expect(filed.value.status).toBe("filed");

    // 注入未来时钟 ⇒ 视为已超时
    const r = settleStaleCases({ deadlineMs: 1000, now: Date.now() + 60_000 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.settled).toContain(caseId);

    const c = getCaseByConflictId(conflictId);
    expect(c?.status).toBe("timeout");
    expect(c?.finalVerdict?.verdict).toBe("old_wins"); // 保守：维持现状
    expect(c?.finalVerdict?.winnerId).toBe("agent-old");
    expect(c?.completedAt).toBeGreaterThan(0);
  });

  it("【负向】新案（未超时）不被兜底、终态案件不被重复处理", () => {
    const conflictId = uniq("fresh");
    const filed = fileOne(conflictId);
    expect(filed.ok).toBe(true);
    if (!filed.ok) return;

    const r = settleStaleCases({ deadlineMs: 600_000 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.settled).not.toContain(filed.value.caseId);
    expect(getCaseByConflictId(conflictId)?.status).toBe("filed");

    // 换一个已超时的时钟再扫 ⇒ 这次应被兜底（这是正确语义：超时即保守结案）
    const r2 = settleStaleCases({ deadlineMs: 1, now: Date.now() + 60_000 });
    if (!r2.ok) return;
    expect(r2.value.settled).toContain(filed.value.caseId);
    expect(getCaseByConflictId(conflictId)?.status).toBe("timeout");

    // 幂等：已结案（timeout 终态）不再被二次处理
    const r3 = settleStaleCases({ deadlineMs: 1, now: Date.now() + 120_000 });
    if (!r3.ok) return;
    expect(r3.value.settled).not.toContain(filed.value.caseId);
  });

  it("【负向】兜底结案后，同冲突**可以重新立案**（此前会永久拒绝）", () => {
    const conflictId = uniq("refile");
    const first = fileOne(conflictId);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // 未兜底前：同冲突再立案应被拒
    expect(fileOne(conflictId).ok).toBe(false);

    settleStaleCases({ deadlineMs: 1, now: Date.now() + 60_000 });
    const again = fileOne(conflictId);
    expect(again.ok).toBe(true);
  });

  it("【负向】非法 deadlineMs ⇒ 拒绝（不静默按 0 处理）", () => {
    expect(settleStaleCases({ deadlineMs: 0 }).ok).toBe(false);
    expect(settleStaleCases({ deadlineMs: -1 }).ok).toBe(false);
  });
});
