/**
 * @vitest-environment jsdom
 *
 * `ui.*` 设置项是否真的接到消费方（REV-265 收口口径：面板能改的键必须有消费者）。
 *
 * 这里锁死三件事，顺序错位就会让"改了没用"重新发生：
 * 1. **键解析**：schema 里 ui.* 的 path 自带段名（`ui.maxEventBufferSize`），
 *    FIELD_MAP 的 key 因此是 `default::ui.maxEventBufferSize`。消费点传短名，
 *    归一化没做对就读不到后端值 —— 面板改了、界面仍是出厂默认，且没有任何报错。
 * 2. **优先级**：本地期望值 > 后端运行态值 > 出厂默认。
 * 3. **降级不崩**：未声明的键 / 非法值落回调用方 fallback，只点名一次。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useConfigStore, FIELD_MAP } from "@/stores/configStore";
import { uiNumber, useUiNumber } from "@/config/uiSettings";

/** 消费点实际使用的四个短名 + schema 里的出厂默认 */
const UI_FIELDS = [
  {
    short: "dashboardPollIntervalSec",
    key: "default::ui.dashboardPollIntervalSec",
    def: 5,
  },
  {
    short: "approvalQueueRefreshSec",
    key: "default::ui.approvalQueueRefreshSec",
    def: 30,
  },
  {
    short: "streamFlushIntervalMs",
    key: "default::ui.streamFlushIntervalMs",
    def: 100,
  },
  {
    short: "maxEventBufferSize",
    key: "default::ui.maxEventBufferSize",
    def: 500,
  },
] as const;

function seed(
  loaded: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) {
  useConfigStore.setState({ loaded, overrides } as never);
}

beforeEach(() => {
  seed({}, {});
  vi.restoreAllMocks();
});

describe("ui.* 键解析", () => {
  it("四个消费点的短名都能解析到 schema 里真实存在的 key", () => {
    for (const f of UI_FIELDS) {
      expect(FIELD_MAP[f.key], `schema 缺少 ${f.key}`).toBeDefined();
      expect(FIELD_MAP[f.key]?.path).toBe(f.key.split("::")[1]);
    }
  });

  it("后端运行态值能被消费点读到（改短名归一化就会退化成出厂默认）", () => {
    seed({ [UI_FIELDS[0].key]: 60, [UI_FIELDS[3].key]: 2000 });
    expect(uiNumber("dashboardPollIntervalSec", 5)).toBe(60);
    expect(uiNumber("maxEventBufferSize", 500)).toBe(2000);
  });

  it("短名与全路径等价", () => {
    seed({ [UI_FIELDS[2].key]: 250 });
    expect(uiNumber("streamFlushIntervalMs", 100)).toBe(250);
    expect(uiNumber("ui.streamFlushIntervalMs", 100)).toBe(250);
  });

  it("后端没答（loaded 为空）→ 落到 schema 出厂默认，且与面板默认一致", () => {
    for (const f of UI_FIELDS) {
      expect(uiNumber(f.short, 0)).toBe(f.def);
    }
  });
});

describe("取值优先级", () => {
  it("本地期望值 > 后端运行态值：改完立刻反映到消费点，不等后端回执", () => {
    seed({ [UI_FIELDS[1].key]: 30 }, { [UI_FIELDS[1].key]: 120 });
    expect(uiNumber("approvalQueueRefreshSec", 30)).toBe(120);
  });

  it("「重置」= DEFAULT_MARK → 回落后端当前值，不锁死在旧期望值上", () => {
    seed({ [UI_FIELDS[0].key]: 45 }, { [UI_FIELDS[0].key]: "@@default@@" });
    expect(uiNumber("dashboardPollIntervalSec", 5)).toBe(45);
  });
});

describe("降级不崩", () => {
  it("未声明的键：落回调用方 fallback 并点名一次，不抛异常（抛会打断渲染与流式定时器）", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => uiNumber("noSuchField", 77)).not.toThrow();
    expect(uiNumber("noSuchField", 77)).toBe(77);
    uiNumber("noSuchField", 77);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toBe("default::ui.noSuchField");
  });

  it("非法值（0 / 负数 / NaN / 空串）→ fallback，避免 0 ms 定时器打爆渲染", () => {
    seed({
      "default::ui.streamFlushIntervalMs": 0,
      "default::ui.maxEventBufferSize": -1,
      "default::ui.dashboardPollIntervalSec": "x",
      "default::ui.approvalQueueRefreshSec": null,
    });
    expect(uiNumber("streamFlushIntervalMs", 100)).toBe(100);
    expect(uiNumber("maxEventBufferSize", 500)).toBe(500);
    expect(uiNumber("dashboardPollIntervalSec", 5)).toBe(5);
    expect(uiNumber("approvalQueueRefreshSec", 30)).toBe(30);
  });

  it("数字字符串按数值接受（后端把 number 序列化成字符串时不该退默认）", () => {
    seed({ "default::ui.maxEventBufferSize": "1200" });
    expect(uiNumber("maxEventBufferSize", 500)).toBe(1200);
  });
});

describe("useUiNumber 订阅", () => {
  it("配置变化会重渲染消费组件（轮询周期改了要重建定时器）", async () => {
    seed({ [UI_FIELDS[0].key]: 60 });
    const { result } = renderHook(() =>
      useUiNumber("dashboardPollIntervalSec", 5),
    );
    expect(result.current).toBe(60);

    act(() =>
      useConfigStore.setState((s) => ({
        loaded: { ...s.loaded, [UI_FIELDS[0].key]: 90 },
      })),
    );
    await waitFor(() => expect(result.current).toBe(90));
  });
});
