/**
 * 崩溃恢复**续跑**的生产链路验证（⑥ 生产消费方）。
 *
 * 验证的不是"API 存在"，而是恢复链的三段真实衔接：
 *   ① 迭代快照写入归属/目标/对话（writeIterationCheckpoint）
 *   ② 启动扫描把 AUTO_RESUME 计划带上归属/目标/断点轮次（scanAndProposeRecovery）
 *   ③ 恢复执行器消费断点，返回可续跑的对话（executeRecovery → ResumeResult.messages）
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initDatabase, closeDatabase } from "../../Src/Infra/Db/database.js";
import { initMigrations, migrateUp } from "../../Src/Infra/Db/migrations.js";
import { writeIterationCheckpoint } from "../../Src/Infra/DurableExecution/iterationCheckpoint.js";
import {
  scanAndProposeRecovery,
  getAutoResumePlans,
  initRecoveryScanner,
} from "../../Src/Infra/DurableExecution/recoveryScanner.js";
import { executeRecovery } from "../../Src/Infra/DurableExecution/recoveryExecutor.js";

let dir = "";

describe("崩溃恢复续跑（生产链路）", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "civitas-recovery-"));
    mkdirSync(dir, { recursive: true });
    initDatabase({
      mainPath: join(dir, "main.db"),
      eventsPath: join(dir, "events.db"),
      memoryPath: join(dir, "memory.db"),
      walMode: true,
      busyTimeoutMs: 5_000,
    });
    initMigrations();
    migrateUp();
    initRecoveryScanner({ autoResumeMaxUnknownEffects: 0 });
  });

  afterEach(() => {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });

  it("快照携带归属/目标/对话；扫描给 AUTO_RESUME 计划；执行器取回断点对话", () => {
    const loopId = "loop-recovery-probe";
    const wrote = writeIterationCheckpoint({
      loopId,
      iteration: 2,
      decision: "continue",
      completedSteps: 2,
      failedAttempts: 0,
      agentId: "agent-recovery-probe",
      traceId: "trace-recovery-probe",
      goal: "完成数据库迁移",
      userInput: "请继续迁移",
      messages: [
        { role: "user", content: "请继续迁移" },
        { role: "assistant", content: "步骤一完成" },
      ],
    });
    expect(wrote).toBe(true);

    const plans = scanAndProposeRecovery();
    expect(plans.ok).toBe(true);
    const auto = plans.ok ? getAutoResumePlans(plans.value) : [];
    const plan = auto.find((p) => p.loopId === loopId);
    expect(plan).toBeDefined();
    expect(plan?.agentId).toBe("agent-recovery-probe");
    expect(plan?.goal).toBe("完成数据库迁移");
    expect(plan?.resumedIteration).toBe(2);

    const recovered = executeRecovery(plan!);
    expect(recovered.ok).toBe(true);
    if (recovered.ok) {
      expect(recovered.value.messages).toHaveLength(2);
      expect(recovered.value.nextIteration).toBe(3);
    }
  });
});
