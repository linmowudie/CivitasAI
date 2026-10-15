/**
 * REV-337 · 落库失败信号分级（`Src/Infra/Db/dbFailureLog.ts`）
 *
 * 登记的缺陷是"信号被淹没"：真实 Agent 三轮跑单文件即 9 行 `Agent 落库失败` ERROR、
 * 全量跑 165 行，而用例 4/4 通过——因为 harness 根本没初始化库，
 * "库里真的没有"与"读库失败"、"真故障"与"纯内存运行"在日志里长得一模一样。
 *
 * 因此本文件锁住三条口径（按 §16.6，单测只证明分级逻辑本身，真实进程噪声由 realAgent 跑实测）：
 *  ① 库未初始化 ⇒ warn 级、按来源去重、并写明兜底动作；
 *  ② 库已初始化仍失败 ⇒ error 级、**逐条**、带原始错误；
 *  ③ 各来源互不吞没（去重键是来源，不是全局一条）。
 *
 * ②的"真故障"用**已连接但未跑迁移**的库制造（`no such table`），
 * 这是最贴近生产的形态：连接是好的，坏在磁盘上的东西不完整。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve, join } from "node:path";
import { mkdirSync, existsSync, rmSync, readFileSync } from "node:fs";

import { initDatabase, closeDatabase } from "../../Src/Infra/Db/database.js";
import {
  logDbFailure,
  resetDbFailureWarnings,
} from "../../Src/Infra/Db/dbFailureLog.js";
import {
  upsertAgent,
  updateAgentRow,
  maxAgentIdSeq,
  countLiveAgentsByTrace,
  parentOf,
} from "../../Src/Infra/Db/Repositories/agentRepository.js";
import {
  updateSubtaskStatus,
  listSubtasksByTask,
} from "../../Src/Infra/Db/Repositories/subtaskRepository.js";
import {
  updateTaskRow,
  getTaskRow,
} from "../../Src/Infra/Db/Repositories/taskRepository.js";
import { initLogger, shutdownLogger } from "../../Src/Infra/Logging/logger.js";

const DB_DIR = resolve(import.meta.dirname, "../../Data/_test_db_failure_log");
const LOG_DIR = resolve(import.meta.dirname, "../../Logs/_test_db_failure_log");

const MEMORY_SUFFIX = "（数据库未初始化，按纯内存运行）";

/** 把两条轨道的日志合并读（分级断言只关心"出现过几次"，不依赖具体落哪个文件） */
function readAllLogs(): string {
  const parts: string[] = [];
  for (const name of ["business.log", "system.log"]) {
    const p = join(LOG_DIR, name);
    if (existsSync(p)) parts.push(readFileSync(p, "utf-8"));
  }
  return parts.join("\n");
}

/** 统计含指定子串的日志行数 */
function countLinesWith(text: string, needle: string): number {
  return text.split("\n").filter((line) => line.includes(needle)).length;
}

function startLogger(): void {
  if (existsSync(LOG_DIR)) rmSync(LOG_DIR, { recursive: true, force: true });
  mkdirSync(LOG_DIR, { recursive: true });
  shutdownLogger();
  expect(initLogger({ logDir: LOG_DIR, level: "info" })).toBe(true);
}

describe("REV-337 · 落库失败信号分级", () => {
  beforeEach(() => {
    // 纯内存运行形态：连接不存在（realAgent harness 等的真实状态）
    closeDatabase();
    resetDbFailureWarnings();
    startLogger();
  });

  afterEach(() => {
    shutdownLogger();
    closeDatabase();
    if (existsSync(DB_DIR)) rmSync(DB_DIR, { recursive: true, force: true });
    if (existsSync(LOG_DIR)) rmSync(LOG_DIR, { recursive: true, force: true });
  });

  describe("① 库未初始化 = 运行形态，不是故障", () => {
    it("按来源降为一条 warn，且写明兜底动作", () => {
      expect(maxAgentIdSeq()).toBe(0);
      countLiveAgentsByTrace("trace-x");
      parentOf("agent-worker-1");
      shutdownLogger();

      const logs = readAllLogs();
      expect(countLinesWith(logs, "agentRepository/maxAgentIdSeq")).toBe(1);
      expect(logs).toContain(MEMORY_SUFFIX);
      // 兜底动作必须可见，否则空结果会被读成"库里真的没有"
      expect(logs).toContain("按 0 处理，ID 可能复用");
      expect(logs).toContain("返回 null（hydrate 不回灌父子关系）");
    });

    it("同一来源重复失败只提示一次（不再逐行刷屏）", () => {
      for (let i = 0; i < 20; i++) {
        upsertAgent({
          agentId: `agent-worker-${i}`,
          traceId: "trace-noise",
          role: "worker",
        });
      }
      updateAgentRow("agent-worker-0", { status: "completed" });
      shutdownLogger();

      const logs = readAllLogs();
      expect(countLinesWith(logs, "agentRepository/upsertAgent")).toBe(1);
      expect(countLinesWith(logs, "agentRepository/updateAgentRow")).toBe(1);
      expect(logs).toContain("仅内存注册，重启即消失");
      expect(logs).toContain("库里状态与内存状态漂移（审计行可能陈旧）");
    });

    it("各来源互不吞没，且失败绝不改变返回值语义", () => {
      expect(maxAgentIdSeq()).toBe(0);
      expect(countLiveAgentsByTrace("trace-a")).toBe(0);
      expect(parentOf("agent-worker-9")).toBeNull();
      expect(getTaskRow("task-none")).toBeUndefined();
      expect(listSubtasksByTask("task-none")).toEqual([]);
      // 这三个调用不抛错——分级只改日志级别，不把降级路径变成中断
      expect(() =>
        updateTaskRow("task-none", { status: "completed" }),
      ).not.toThrow();
      expect(() =>
        updateSubtaskStatus("subtask-none", "completed"),
      ).not.toThrow();
      shutdownLogger();

      const logs = readAllLogs();
      for (const source of [
        "agentRepository/maxAgentIdSeq",
        "agentRepository/countLiveAgentsByTrace",
        "agentRepository/parentOf",
        "taskRepository/getTaskRow",
        "taskRepository/updateTaskRow",
        "subtaskRepository/listSubtasksByTask",
        "subtaskRepository/updateSubtaskStatus",
      ]) {
        expect(logs, `来源 ${source} 应各提示一次`).toContain(source);
        expect(countLinesWith(logs, source)).toBe(1);
      }
      expect(countLinesWith(logs, MEMORY_SUFFIX)).toBe(7);
    });

    it("resetDbFailureWarnings 后重新提示（测试与长进程复用的边界）", () => {
      maxAgentIdSeq();
      maxAgentIdSeq();
      resetDbFailureWarnings();
      maxAgentIdSeq();
      shutdownLogger();

      expect(
        countLinesWith(readAllLogs(), "agentRepository/maxAgentIdSeq"),
      ).toBe(2);
    });
  });

  describe("② 库已连接但读写失败 = 真故障，仍逐条 error", () => {
    it("连接存在而未建表：每次失败都落一条，带原始错误与兜底动作", () => {
      if (existsSync(DB_DIR)) rmSync(DB_DIR, { recursive: true, force: true });
      mkdirSync(DB_DIR, { recursive: true });
      // 只建立连接、不跑迁移 ⇒ isDatabaseInitialized() 为真，而 SQL 必然失败
      initDatabase({
        mainPath: join(DB_DIR, "m.db"),
        eventsPath: join(DB_DIR, "e.db"),
        memoryPath: join(DB_DIR, "mm.db"),
        walMode: true,
        busyTimeoutMs: 5000,
      });

      maxAgentIdSeq();
      maxAgentIdSeq();
      updateTaskRow("task-1", { status: "failed" });
      shutdownLogger();

      const logs = readAllLogs();
      expect(countLinesWith(logs, "agentRepository/maxAgentIdSeq")).toBe(2);
      expect(logs).not.toContain(MEMORY_SUFFIX);
      expect(logs).toContain("no such table: agents");
      expect(logs).toContain(
        "库里终态未落（任务行停在旧状态，重启后读侧仍见旧状态）",
      );
    });
  });

  describe("③ logDbFailure 自身契约", () => {
    it("纯内存态下 error 分支绝不触发", () => {
      logDbFailure(
        "手工失败",
        "spec/onlyWarn",
        { taskId: "task-x" },
        new Error("磁盘满"),
        "按默认值返回",
      );
      shutdownLogger();

      const logs = readAllLogs();
      expect(logs).toContain("spec/onlyWarn");
      // 未初始化时原始错误不再逐条写入（它描述的是"这次调用的失败"，非系统故障）
      expect(logs).not.toContain("磁盘满");
    });
  });
});
