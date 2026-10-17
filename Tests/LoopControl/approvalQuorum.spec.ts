/**
 * 审批法定人数与超时链路（2026-10-08 P0-1 收口，真实验证同型的回归锁）
 *
 * 锁住四件在静态审查里被写错、由真实运行纠正的事：
 * ① CRITICAL 双人控制必须由两位**不同身份**满足，且第二票来自另一账号时**必须放行**
 *    （此前按当前属主硬拒 → 双人控制唯一的合法路径被封死，退回"永久 PENDING 到超时"）；
 * ② 同一身份换角色重复提交当场拒绝并说明原因（不再返回 200 + PENDING 让前端猜）；
 * ③ 无人等待的僵尸审批由巡检落定，且超时**广播** `loop:approval_timeout_rejected`；
 * ④ `toolCallId` 随审批落库 → 重启后内嵌审批卡可按它重链。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve, join } from "node:path";
import { existsSync, rmSync, mkdirSync } from "node:fs";

import { initDatabase, closeDatabase } from "../../Src/Infra/Db/database.js";
import {
  initMigrations,
  clearMigrations,
  migrateUp,
} from "../../Src/Infra/Db/migrations.js";
import {
  configureApprovalPolicy,
  createApproval,
  registerApproval,
  decideApproval,
  checkTimeoutApprovals,
  getApproval,
  getPendingApprovals,
  clearApprovalQueue,
} from "../../Src/Services/LoopControl/approvalGate.js";
import { listPersistedApprovals } from "../../Src/Services/LoopControl/approvalPersistence.js";
import { setActiveOwner } from "../../Src/Services/AccountScope/activeAccount.js";
import { subscribe } from "../../Src/Services/EventBus/eventBus.js";
import { EventType } from "../../Src/Services/EventBus/eventTypes.js";

const TEST_DB_DIR = resolve(
  import.meta.dirname,
  "../../.tmp/test-db-approval-quorum",
);

function criticalApproval(approvalOverrides: {
  loopId: string;
  timeoutSec: number;
}) {
  const created = createApproval({
    loopId: approvalOverrides.loopId,
    traceId: `trace-${approvalOverrides.loopId}`,
    iteration: 1,
    requestedBy: "agent-worker-1",
    kind: "irreversible_action",
    riskLevel: "CRITICAL",
    timeoutSec: approvalOverrides.timeoutSec,
    deciders: [
      { role: "user", weight: 1 },
      { role: "prime_director", weight: 1 },
    ],
    payload: { toolName: "ShellExec", arguments: { command: "dir" } },
  });
  expect(created.ok).toBe(true);
  return created.value;
}

beforeEach(() => {
  // 本文件专门验证"双人控制"：显式关闭"人工同意即放行"（默认为开启）
  configureApprovalPolicy({ humanApprovalSuffices: false });
  closeDatabase();
  clearMigrations();
  if (existsSync(TEST_DB_DIR))
    rmSync(TEST_DB_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DB_DIR, { recursive: true });
  expect(
    initDatabase({
      mainPath: join(TEST_DB_DIR, "test_main.db"),
      eventsPath: join(TEST_DB_DIR, "test_events.db"),
      memoryPath: join(TEST_DB_DIR, "test_memory.db"),
      walMode: true,
      busyTimeoutMs: 5000,
    }).ok,
  ).toBe(true);
  initMigrations();
  migrateUp();
  clearApprovalQueue();
  setActiveOwner(null);
});

afterEach(() => {
  closeDatabase();
  clearApprovalQueue();
  setActiveOwner(null);
});

describe("CRITICAL 双人控制（按不同身份判定）", () => {
  it("两位不同账号的操作者分别裁决 → APPROVED", () => {
    const approval = criticalApproval({ loopId: "loop-q-1", timeoutSec: 60 });
    registerApproval({
      ...approval,
      toolCallId: "tc-q-1",
      sessionId: "sess-q",
    });

    const first = decideApproval({
      approvalId: approval.approvalId,
      decidedBy: "user:local",
      approve: true,
    });
    expect(first.ok).toBe(true);
    expect(first.value!.status).toBe("PENDING");
    expect(first.value!.quorumBlocked).toMatchObject({
      required: 2,
      matched: 1,
      remainingIdentities: 1,
    });

    setActiveOwner("account-b");
    const second = decideApproval({
      approvalId: approval.approvalId,
      decidedBy: "prime_director:account-b",
      approve: true,
    });
    expect(second.ok).toBe(true);
    expect(second.value!.status).toBe("APPROVED");
    expect(second.value!.decidedBy).toEqual([
      "user:local",
      "prime_director:account-b",
    ]);
    expect(second.value!.quorumBlocked).toBeUndefined();
  });

  it("同一身份换角色重复提交 → 当场拒绝且说明仍缺几位", () => {
    const approval = criticalApproval({ loopId: "loop-q-2", timeoutSec: 60 });
    registerApproval({
      ...approval,
      toolCallId: "tc-q-2",
      sessionId: "sess-q",
    });

    expect(
      decideApproval({
        approvalId: approval.approvalId,
        decidedBy: "user:local",
        approve: true,
      }).ok,
    ).toBe(true);

    const again = decideApproval({
      approvalId: approval.approvalId,
      decidedBy: "prime_director:local",
      approve: true,
    });
    expect(again.ok).toBe(false);
    expect(again.error).toContain("裁决未计入");
    expect(again.error).toContain("双人控制要求 2 位不同身份");
    expect(again.error).toContain("当前已满足 1 位");
  });

  it("待裁决审批对其他账号可见可裁；已决条目仍按属主隔离", () => {
    const approval = criticalApproval({ loopId: "loop-q-3", timeoutSec: 60 });
    registerApproval({
      ...approval,
      toolCallId: "tc-q-3",
      sessionId: "sess-q",
    });

    setActiveOwner("account-b");
    expect(getPendingApprovals().map((a) => a.approvalId)).toContain(
      approval.approvalId,
    );
    expect(getApproval(approval.approvalId)?.status).toBe("PENDING");

    setActiveOwner(null);
    decideApproval({
      approvalId: approval.approvalId,
      decidedBy: "user:local",
      approve: false,
    });

    setActiveOwner("account-b");
    expect(getApproval(approval.approvalId)).toBeUndefined();
  });

  it("系统身份只能拒绝，不能凑票放行", () => {
    const approval = criticalApproval({ loopId: "loop-q-4", timeoutSec: 60 });
    registerApproval({
      ...approval,
      toolCallId: "tc-q-4",
      sessionId: "sess-q",
    });

    const auto = decideApproval({
      approvalId: approval.approvalId,
      decidedBy: "system-timeout:loop",
      approve: true,
    });
    expect(auto.ok).toBe(false);
    expect(auto.error).toContain("系统角色不得自动通过");
  });
});

describe("超时默认拒绝", () => {
  it("无人等待的僵尸审批由巡检落定并广播超时事件", async () => {
    const events: Array<Record<string, unknown>> = [];
    const sub = subscribe(EventType.APPROVAL_TIMEOUT_REJECTED, (e) => {
      events.push(
        (e as unknown as { payload: Record<string, unknown> }).payload,
      );
    });

    const approval = criticalApproval({ loopId: "loop-q-5", timeoutSec: 1 });
    registerApproval({
      ...approval,
      toolCallId: "tc-q-5",
      sessionId: "sess-q",
    });
    await new Promise((r) => setTimeout(r, 1_100));

    const timedOut = checkTimeoutApprovals();
    expect(timedOut.map((a) => a.approvalId)).toContain(approval.approvalId);
    expect(getApproval(approval.approvalId)?.status).toBe("TIMEOUT");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      approvalId: approval.approvalId,
      toolCallId: "tc-q-5",
      status: "TIMEOUT",
    });
    sub.unsubscribe();
  });

  it("toolCallId 随审批落库 → 重启后可按它重链内嵌卡", () => {
    const approval = criticalApproval({ loopId: "loop-q-6", timeoutSec: 60 });
    registerApproval({
      ...approval,
      toolCallId: "tc-q-6",
      sessionId: "sess-q",
      toolName: "ShellExec",
    });
    decideApproval({
      approvalId: approval.approvalId,
      decidedBy: "user:local",
      approve: true,
    });

    // 从库里读（内存队列清空 = 模拟进程重启）
    clearApprovalQueue();
    const rows = listPersistedApprovals("local", 20);
    const row = rows.find((r) => r.approvalId === approval.approvalId);
    expect(row?.toolCallId).toBe("tc-q-6");
    expect(row?.sessionId).toBe("sess-q");
    expect(row?.decidedBy).toEqual(["user:local"]);
    expect(row?.status).toBe("PENDING");
  });
});
