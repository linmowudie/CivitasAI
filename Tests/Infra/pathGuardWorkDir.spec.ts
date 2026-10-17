/**
 * 当前工作空间 = 信任边界（2026-10-16 用户裁定）
 *
 * 真实现象：`DirList` 对用户新建任务时选的 `F:\TestAgent`（项目根之外）全部失败：
 * `PATH_DENIED：路径越界：'F:\TestAgent' 不在允许的根目录内`。
 *
 * 设计结论：用户选定该文件夹 ⇒ 里面的文件默认可浏览/可操作。
 * 因此包含性检查以**当前工作空间根**为准，而不是"先把目录追加进全局白名单"
 * （后者会清单膨胀，且与 workspaceGuard 形成两套互相打架的边界）。
 * 但**敏感红线不受影响**：禁止路径在任何根内都仍然拒绝。
 */
import { describe, it, expect, beforeEach } from "vitest";

import {
  initPathGuard,
  checkPath,
  setWorkspaceRoot,
  getWorkspaceRoot,
  resetPathGuard,
} from "../../Src/Infra/Security/pathGuard.js";

const PROJECT = "F:\\ProjectCode\\CivitasAI";
const WORKDIR = "F:\\TestAgent";

describe("当前工作空间根", () => {
  beforeEach(() => {
    resetPathGuard();
    // 禁止路径按相对项目根解析；`..\..\TestAgent\secret` ⇒ F:\TestAgent\secret（用于验证红线）
    initPathGuard({
      projectRoot: PROJECT,
      forbiddenPaths: ["..\\..\\TestAgent\\secret"],
    });
    setWorkspaceRoot(WORKDIR);
  });

  it("用户选定的工作目录内：读/写/列 全部放行（本次故障的直接回归）", () => {
    expect(checkPath(WORKDIR, "list").allowed).toBe(true);
    expect(checkPath(WORKDIR + "\\a.txt", "read").allowed).toBe(true);
    expect(checkPath(WORKDIR + "\\sub\\b.txt", "write").allowed).toBe(true);
    expect(getWorkspaceRoot()).toBe(WORKDIR);
  });

  it('【负向】工作空间之外仍拒绝 —— 边界是"这个目录"，不是"全放行"', () => {
    const out = checkPath("E:\\SomewhereElse", "list");
    expect(out.allowed).toBe(false);
    expect(out.reason ?? "").toContain("不在允许的根目录内");
    // 前缀相似但不属于该目录，也不能借光
    expect(checkPath("F:\\TestAgent-evil", "list").allowed).toBe(false);
  });

  it("【负向】敏感红线绝对生效：工作空间**内部**的禁止路径同样拒绝", () => {
    const out = checkPath(WORKDIR + "\\secret\\credentials.json", "read");
    expect(out.allowed).toBe(false);
    expect(out.reason ?? "").toContain("禁止路径访问");
  });

  it("换任务即替换当前工作空间（不是累积清单：旧目录不再被放行）", () => {
    const NEXT = "F:\\AnotherProject";
    setWorkspaceRoot(NEXT);
    expect(getWorkspaceRoot()).toBe(NEXT);
    expect(checkPath(NEXT, "list").allowed).toBe(true);
    expect(checkPath(WORKDIR, "list").allowed).toBe(false);
  });

  it("项目根始终可用（回归：换工作空间不该弄丢项目自身可达性）", () => {
    expect(checkPath(PROJECT, "list").allowed).toBe(true);
    expect(checkPath(PROJECT + "\\Src\\main.ts", "read").allowed).toBe(true);
  });

  it("清除工作空间根（null）后回落到白名单判定", () => {
    setWorkspaceRoot(null);
    expect(getWorkspaceRoot()).toBeNull();
    expect(checkPath(WORKDIR, "list").allowed).toBe(false);
    expect(checkPath(PROJECT, "list").allowed).toBe(true);
  });
});
