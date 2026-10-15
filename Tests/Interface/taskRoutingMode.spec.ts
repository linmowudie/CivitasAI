/**
 * 工作方式（workingMode / routingMode）真实生效——P0-4 收口测试。
 *
 * 修复前的事实链：前端把 workingMode 发给后端，后端**从不读取**；`forceRoute()` 零调用点；
 * 编排器永远按复杂度自动决策。于是"用户选的工作方式"是一个纯装饰控件。
 *
 * 现在要求：
 * 1. `POST /api/tasks` 接受 `routingMode` 并原样回执；不可执行的（LITIGATION/REGULATION，
 *    编排器 switch 无分支 = S12 未实现）在**边界**上就 400 拒绝，而不是收下后静默失败。
 * 2. 未传 / 传空串 = 交给复杂度评估自动决定（保持既有行为）。
 * 3. `receiveTask(..., { forcedMode })` 真的走 `forceRoute`，用户选择压过自动决策。
 * 4. `SUBMITTABLE_MODES` 与前端 `workingModeLabels.WORKING_MODE_OPTIONS` 必须同源同集合，
 *    否则界面会提供后端必然拒绝的选项。
 */

import { describe, it, expect, afterEach } from "vitest";

import {
  submitTask,
  listTasks,
  registerTaskRoutes,
  resetTaskApi,
  SUBMITTABLE_MODES,
  isSubmittableMode,
  type TaskRecord,
} from "../../Src/Interface/RestApi/taskApi.js";
import {
  matchRoute,
  clearRoutes,
  type ApiRequest,
} from "../../Src/Interface/RestApi/router.js";
import { WORKING_MODE_LABELS } from "../../Client/src/components/Chat/workingModeLabels";

async function postTasks(
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const match = matchRoute("POST", "/api/tasks");
  if (!match) throw new Error("POST /api/tasks 未注册");
  const req: ApiRequest = {
    method: "POST",
    path: "/api/tasks",
    params: {},
    query: {},
    body,
  };
  const res = await match.handler(req);
  return { status: res.status, json: res.body as Record<string, unknown> };
}

describe("POST /api/tasks · routingMode 边界校验", () => {
  afterEach(() => {
    resetTaskApi();
    clearRoutes();
  });

  it("可选的工作方式被接受，并在响应里回执", async () => {
    registerTaskRoutes();
    const res = await postTasks({
      description: "把两个独立模块拆开实现",
      routingMode: "DELEGATION",
    });

    expect(res.status).toBe(201);
    const data = res.json.data as TaskRecord;
    expect(data.routingMode).toBe("DELEGATION");
  });

  it("不可执行的工作方式在边界上 400，并说明原因与可选项", async () => {
    registerTaskRoutes();
    const res = await postTasks({
      description: "任意任务",
      routingMode: "LITIGATION",
    });

    expect(res.status).toBe(400);
    const msg = String(res.json.error);
    expect(msg).toContain("LITIGATION");
    expect(msg).toContain("S12");
    expect(msg).toContain(SUBMITTABLE_MODES.join(" / "));
    // 被拒的请求不能留下任务记录，否则面板里出现一条永远不会执行的僵尸任务
    expect(listTasks()).toHaveLength(0);
  });

  it("不传 routingMode 时保持既有行为：自动按复杂度决定", async () => {
    registerTaskRoutes();
    const res = await postTasks({ description: "修改按钮颜色" });

    expect(res.status).toBe(201);
    expect((res.json.data as TaskRecord).routingMode).toBeUndefined();
  });

  it('空串等价于"未指定"', async () => {
    registerTaskRoutes();
    const res = await postTasks({
      description: "修改按钮颜色",
      routingMode: "",
    });

    expect(res.status).toBe(201);
    expect((res.json.data as TaskRecord).routingMode).toBeUndefined();
  });
});

describe("工作方式集合的三端一致性", () => {
  it("后端 SUBMITTABLE_MODES 与前端可选项完全一致", () => {
    expect([...SUBMITTABLE_MODES].sort()).toEqual(
      Object.keys(WORKING_MODE_LABELS).sort(),
    );
  });

  it("isSubmittableMode 只放行这几种", () => {
    for (const mode of SUBMITTABLE_MODES)
      expect(isSubmittableMode(mode)).toBe(true);
    for (const bad of [
      "LITIGATION",
      "REGULATION",
      "AUDIT",
      "direct",
      "",
      null,
      42,
    ]) {
      expect(isSubmittableMode(bad)).toBe(false);
    }
  });

  it("submitTask 回执带上用户选择的工作方式（任务面板据此显示）", () => {
    const task = submitTask({ description: "测试", routingMode: "CONSORTIUM" });

    expect(task.routingMode).toBe("CONSORTIUM");
    expect(listTasks()[0]?.routingMode).toBe("CONSORTIUM");
    resetTaskApi();
  });
});
