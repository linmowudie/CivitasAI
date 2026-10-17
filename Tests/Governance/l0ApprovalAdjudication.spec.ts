/**
 * L0 审批裁决链路（回归：出现审批事件却没有可裁决的 L0 实例，整个 L0 未生效）
 *
 * 三件事必须同时成立，否则审批只能靠"人类 + 第二账号"凑齐：
 *  ① 决策池的 L0 角色（auditor / regulatory_authority）**有真实 Agent 实例**；
 *  ② 存在让 **Agent 投票**的路径（此前 `decideApproval` 只有人类 REST 端点一个调用者）；
 *  ③ "人工同意即放行"是**人类专属**：单个 Agent 不能单独通过双人控制。
 */
import { describe, it, expect, beforeEach } from "vitest";

import { ensureAgentsForRoles } from "../../Src/Services/Governance/governanceProvisioning.js";
import {
  getAgentsByRole,
  resetAgentRegistry,
} from "../../Src/Core/AgentRuntime/agentRegistry.js";
import { resetAgentFactory } from "../../Src/Core/AgentRuntime/agentFactory.js";
import { resetAgentRuntime } from "../../Src/Core/AgentRuntime/agentRuntime.js";
import {
  createApproval,
  adjudicateApprovalByAgent,
  decideApproval,
  getApproval,
  registerApproval,
  configureApprovalPolicy,
} from "../../Src/Services/LoopControl/approvalGate.js";

function makeApproval(overrides: Record<string, unknown> = {}) {
  // createApproval 只构造记录，**登记入队由调用方负责**（生产里是工具安全门）：
  // 少了这一步，adjudicateApprovalByAgent 会查不到审批（本单测早期就踩了这个坑）。
  const created = createApproval({
    loopId: "loop-l0",
    traceId: "trace-l0",
    iteration: 1,
    requestedBy: "agent-worker-1",
    kind: "irreversible_action",
    payload: { toolName: "ShellExec" },
    riskLevel: "CRITICAL",
    timeoutSec: 300,
    defaultOnTimeout: "reject",
    deciders: [
      { role: "user", weight: 1 },
      { role: "auditor", weight: 1 },
      { role: "regulatory_authority", weight: 1 },
    ],
    requiredApprovals: 2,
    ...overrides,
  } as never);
  if (created.ok) registerApproval(created.value);
  return created;
}

describe("L0 治理实例供给", () => {
  beforeEach(() => {
    resetAgentRegistry();
    resetAgentFactory();
    resetAgentRuntime();
  });

  it("ensureAgentsForRoles 为审批池角色建出**真实** Agent 实例", () => {
    const ensured = ensureAgentsForRoles(["auditor", "regulatory_authority"], {
      traceId: "test-l0-provision",
      reason: "单测：审批决策池 L0 实例",
    });
    // 角色会被规范化：regulatory_authority ⇒ canonical regulator
    expect([...ensured.keys()].sort()).toEqual(["auditor", "regulator"]);
    expect(getAgentsByRole("auditor").length).toBeGreaterThanOrEqual(1);
    expect(getAgentsByRole("regulator").length).toBeGreaterThanOrEqual(1);
  });

  it('【负向】非法角色不会被"假装建成功"（映射里没有该键）', () => {
    const ensured = ensureAgentsForRoles(["not_a_real_role"], {
      reason: "单测：非法角色",
    });
    expect(ensured.has("not_a_real_role")).toBe(false);
    expect(ensured.size).toBe(0);
  });
});

describe("L0 Agent 裁决通道", () => {
  beforeEach(() => {
    resetAgentRegistry();
    resetAgentFactory();
    resetAgentRuntime();
    configureApprovalPolicy({
      humanApprovalSuffices: true,
      autoApproveAll: false,
    });
  });

  it("Agent 可在决策池内投票（记账到 role:agentId），单票不满足双人控制", () => {
    const created = makeApproval();
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const id = created.value.approvalId;

    const vote = adjudicateApprovalByAgent({
      approvalId: id,
      agentId: "agent-auditor-1",
      role: "auditor",
      approve: true,
    });
    expect(vote.ok).toBe(true);
    if (!vote.ok) return;
    // 已记账
    expect(vote.value.decidedBy).toContain("auditor:agent-auditor-1");
    // 双人控制：单个 Agent 通过**不**等于审批通过
    expect(vote.value.status).toBe("PENDING");
    expect(getApproval(id)?.status).toBe("PENDING");
  });

  it("【负向】Agent 越池裁决 → 明确拒绝（不静默记账）", () => {
    const created = makeApproval({
      deciders: [
        { role: "user", weight: 1 },
        { role: "auditor", weight: 1 },
      ],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const out = adjudicateApprovalByAgent({
      approvalId: created.value.approvalId,
      agentId: "agent-arbitrator-9",
      role: "arbitrator",
      approve: true,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("不在本审批的决策池中");
  });

  it("【负向】审批不存在 → 拒绝", () => {
    const out = adjudicateApprovalByAgent({
      approvalId: "no-such-approval",
      agentId: "agent-auditor-1",
      role: "auditor",
      approve: true,
    });
    expect(out.ok).toBe(false);
  });

  it("人类 + L0 Agent 各一票 ⇒ 达法定人数通过（L0 真正参与裁决）", () => {
    const created = makeApproval();
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const id = created.value.approvalId;

    // L0 Agent 投一票（PENDING）
    const agentVote = adjudicateApprovalByAgent({
      approvalId: id,
      agentId: "agent-auditor-1",
      role: "auditor",
      approve: true,
    });
    expect(agentVote.ok).toBe(true);

    // 人类操作者（非 agent 身份）批准 → 达 2 个不同身份，通过
    const human = decideApproval({
      approvalId: id,
      decidedBy: "regulatory_authority:human-owner",
      approve: true,
      reason: "人类确认",
    });
    expect(human.ok).toBe(true);
    if (!human.ok) return;
    expect(human.value.status).toBe("APPROVED");
  });

  it('【负向】Agent 身份**不享受**"人工同意即放行"（否则单票即绕过双人控制）', () => {
    const created = makeApproval({
      deciders: [
        { role: "auditor", weight: 1 },
        { role: "regulatory_authority", weight: 1 },
      ],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const out = adjudicateApprovalByAgent({
      approvalId: created.value.approvalId,
      agentId: "agent-auditor-7",
      role: "auditor",
      approve: true,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.status).toBe("PENDING");
  });
});
