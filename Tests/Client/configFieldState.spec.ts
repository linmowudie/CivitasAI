/**
 * 设置项"生效口径"的前端推导（`Client/src/stores/configStore.ts` 的纯函数面）。
 *
 * REV-265/266 的收口要求是"界面不自行宣称生效"：`deriveFieldState` 只读后端回传的
 * running/onDisk/restartPending/policy 与本地期望值，按下述优先级给出唯一结论。
 * 这里锁死优先级本身——顺序错位就会把"没保存上"显示成"已生效"。
 */

import { describe, it, expect } from "vitest";
import {
  deriveFieldState,
  isPathAccepted,
  DEFAULT_MARK,
  type FieldEffectInput,
} from "@/stores/configStore";

const POLICY = {
  allowedPrefixes: ["ui.", "routing.", "loopDefaults.", "supervision."],
  neverWritable: ["server.apiToken", "supervision.approvalDefaultOnTimeout"],
};

function input(overrides: Partial<FieldEffectInput> = {}): FieldEffectInput {
  return {
    path: "loopDefaults.token_budget",
    hasDesired: false,
    desired: undefined,
    running: 100000,
    disk: 100000,
    pendingRestart: false,
    saving: false,
    error: undefined,
    policy: POLICY,
    backendReachable: true,
    ...overrides,
  };
}

describe("deriveFieldState 优先级", () => {
  it('保存中优先于一切（避免同一行同时出现"保存中"和"待重启"）', () => {
    expect(
      deriveFieldState(
        input({ saving: true, error: "boom", hasDesired: true, desired: 1 }),
      ).kind,
    ).toBe("saving");
  });

  it('写失败时区分"后端不收这个键"与"值被拒绝"', () => {
    expect(
      deriveFieldState(
        input({ error: "nope", path: "hardLimits.maxIterationsCeiling" }),
      ).kind,
    ).toBe("not-accepted");
    expect(
      deriveFieldState(input({ error: "nope", hasDesired: true, desired: 1 }))
        .kind,
    ).toBe("rejected");
  });

  it("后端不可达时不把未提交的改动说成已生效", () => {
    expect(deriveFieldState(input({ backendReachable: false })).kind).toBe(
      "live",
    );
    expect(
      deriveFieldState(
        input({ backendReachable: false, hasDesired: true, desired: 1 }),
      ).kind,
    ).toBe("backend-offline");
  });

  it("白名单外的键永远标 not-accepted（即使值恰好相等）", () => {
    expect(
      deriveFieldState(
        input({
          path: "security.sandboxDefaultMode",
          running: "standard",
          disk: "standard",
        }),
      ).kind,
    ).toBe("not-accepted");
    expect(deriveFieldState(input({ path: "server.apiToken" })).kind).toBe(
      "not-accepted",
    );
    expect(isPathAccepted(POLICY, "supervision.qualityThreshold")).toBe(true);
    expect(isPathAccepted(POLICY, "supervision.approvalDefaultOnTimeout")).toBe(
      false,
    );
  });

  it('ui.* 是本机渲染层直接消费：写入即生效，不进"待重启"', () => {
    expect(
      deriveFieldState(
        input({
          path: "ui.dashboardPollIntervalSec",
          hasDesired: true,
          desired: 11,
          running: 5,
          disk: 5,
        }),
      ).kind,
    ).toBe("live");
  });

  it("running 已等于期望值 → live；只有磁盘变了 → pending-restart；两者都不是 → queued", () => {
    expect(
      deriveFieldState(input({ hasDesired: true, desired: 100000 })).kind,
    ).toBe("live");
    expect(
      deriveFieldState(
        input({
          hasDesired: true,
          desired: 200000,
          disk: 200000,
          running: 100000,
        }),
      ).kind,
    ).toBe("pending-restart");
    expect(
      deriveFieldState(
        input({
          hasDesired: true,
          desired: 300000,
          disk: 100000,
          running: 100000,
        }),
      ).kind,
    ).toBe("queued");
  });

  it("「重置」= 要求后端删除覆盖：按后端答复显示，不谎称已恢复默认", () => {
    expect(
      deriveFieldState(
        input({ hasDesired: true, desired: DEFAULT_MARK as unknown as number }),
      ).kind,
    ).toBe("live");
    expect(
      deriveFieldState(
        input({
          hasDesired: true,
          desired: DEFAULT_MARK as unknown as number,
          disk: 100000,
          pendingRestart: true,
        }),
      ).kind,
    ).toBe("pending-restart");
  });

  it("无本地期望值但后端报告该键待重启 → 如实显示 pending-restart", () => {
    expect(deriveFieldState(input({ pendingRestart: true })).kind).toBe(
      "pending-restart",
    );
  });

  it('数组值按内容比较（同一份 arbitrationModels 不算"有改动"）', () => {
    expect(
      deriveFieldState(
        input({
          path: "routing.arbitrationModels",
          hasDesired: true,
          desired: ["a", "b"] as unknown as number,
          running: ["a", "b"] as unknown as number,
          disk: ["a", "b"] as unknown as number,
        }),
      ).kind,
    ).toBe("live");
  });
});
