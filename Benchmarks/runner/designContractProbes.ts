/**
 * 设计契约探针（designContractProbes）
 *
 * 定位（2026-10-17 用户裁定）：
 * - **Benchmark 依赖设计，不依赖 Src 实现。**
 * - 本文件只按设计文档声明的**接口/语义**写断言：动态 import 设计声明的模块、调用设计声明的入口，
 *   断言设计的 oracle。
 * - 接口今天不存在、签名不对、行为没实现 —— 都返回 **红**（passed:false），detail 写清缺什么。
 *   这**不是**"实验做不了"，而是产品缺口被实验如实复现；对齐接口是产品侧后续的事。
 * - 禁止：读 Src 实现细节来反推实验、或改 Src 让实验能过。
 *
 * 每个探针必须声明 `whyThisEntry`（层规）：被测层 / 驱动入口在哪一层。
 */

type ProbeRun = () => Promise<{ passed: boolean; detail: string }>;

/** 探针构造工具型样本时需要真实工具契约（toolSuccess / 输出 schema） */
import { toolSuccess } from "../../Src/Tools/Traits/toolSpec.js";
import { contentOutputSchema } from "../../Src/Tools/Builtin/_shared.js";

export interface DesignProbe {
  layerUnderTest: string;
  driverEntry: string;
  assemblyTime?: boolean;
  whyThisEntry: string;
  run: ProbeRun;
}

const pass = (detail: string) => ({ passed: true, detail });
const fail = (detail: string) => ({ passed: false, detail });

/** 按设计声明动态加载模块；加载失败 ⇒ 红（设计接口不可用） */
async function load(
  cell: string,
  path: string,
): Promise<Record<string, unknown>> {
  try {
    return (await import(path)) as unknown as Record<string, unknown>;
  } catch (e) {
    throw new Error(
      `[${cell}] 设计模块不可用: ${path} — ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/** 设计声明的导出必须是函数，否则红 */
function needFn(
  mod: Record<string, unknown>,
  cell: string,
  name: string,
): (...a: unknown[]) => unknown {
  const v = mod[name];
  if (typeof v !== "function") {
    throw new Error(`[${cell}] 设计接口缺失: ${name}() 未导出`);
  }
  return v as (...a: unknown[]) => unknown;
}

/** 设计声明的导出必须存在（常量/对象） */
function needValue(
  mod: Record<string, unknown>,
  cell: string,
  name: string,
): unknown {
  const v = mod[name];
  if (v === undefined) {
    throw new Error(`[${cell}] 设计接口缺失: ${name} 未导出`);
  }
  return v;
}

function probe(
  layerUnderTest: string,
  whyThisEntry: string,
  run: ProbeRun,
  driverEntry = "装配期公共 API（设计声明的模块导出）",
  assemblyTime = true,
): DesignProbe {
  return { layerUnderTest, driverEntry, assemblyTime, whyThisEntry, run };
}

// 常用设计模块（路径取自矩阵 cell 的 `module` 字段 = 设计声明的模块位置）
const M = {
  freeze: "../../Src/Services/Audit/freezeManager.js",
  audit: "../../Src/Services/Governance/governanceAudit.js",
  supervision: "../../Src/Services/Supervision/index.js",
  retriever: "../../Src/Services/Retrieval/retriever.js",
  contextPartitions: "../../Src/Services/Context/partitions/partitions.js",
  checkpoint: "../../Src/Infra/DurableExecution/checkpointStore.js",
  agentRuntime: "../../Src/Core/AgentRuntime/agentRuntime.js",
  agentRegistry: "../../Src/Core/AgentRuntime/agentRegistry.js",
  agentFactory: "../../Src/Core/AgentRuntime/agentFactory.js",
  recruiter: "../../Src/Services/Recruitment/recruiter.js",
  whitelist: "../../Src/Infra/Security/whitelist.js",
  longTermMemory: "../../Src/Services/SharedMemory/longTermMemory.js",
  globalWorkspace: "../../Src/Services/SharedMemory/globalWorkspace.js",
  a2aBroker: "../../Src/Services/A2A/a2aBroker.js",
  eventBus: "../../Src/Services/EventBus/eventBus.js",
  modelRouter: "../../Src/Infra/Llm/Router/modelRouter.js",
  traceContext: "../../Src/Infra/Logging/traceContext.js",
  migrations: "../../Src/Infra/Db/migrations.js",
  split: "../../Src/Core/AgentRuntime/agentFactory.js",
  providerBase: "../../Src/Infra/Llm/Provider/providerBase.js",
} as const;

/**
 * 探针表：键 = 矩阵 cell id。
 *
 * 说明：全部按设计 oracle 断言；失败（红）即"该设计点在产品侧未成立"。
 */
export const DESIGN_CONTRACT_PROBES: Record<string, DesignProbe> = {
  // ═══ 能力轴（目标收敛 / 约束保持 / 故障恢复 / 单 Agent） ═══════
  "AG-SEC-POISON": probe(
    "Services/Retrieval + SharedMemory（约束保持）",
    "设计 AG-3：被污染/被取代的记忆不得进入上下文。" +
      "驱动入口=记忆写侧/检索侧公共 API（写入→可召回→deprecate→必须从召回结果消失）。",
    async () => {
      const mem = await load("AG-SEC-POISON", M.longTermMemory);
      const write = needFn(mem, "AG-SEC-POISON", "writeMemory");
      const deprecate = needFn(mem, "AG-SEC-POISON", "deprecateMemory");
      const search = needFn(mem, "AG-SEC-POISON", "searchMemories");
      const marker = `投毒条目-${Date.now()}`;
      const w = (await write({
        title: marker,
        content: `被污染的记忆内容 ${marker}`,
        category: "fact",
        assertion: "observed",
      })) as
        | { ok?: boolean; value?: { memoryId?: string }; error?: string }
        | undefined;
      const id = w?.value?.memoryId;
      if (!id)
        return fail(
          `writeMemory 未返回 memoryId（无法构造投毒样本）：${w?.error ?? "unknown"}`,
        );

      // searchMemories(query: string, options) → Array<{ entry, score }>
      const before = (await search(marker, { limit: 5 })) as
        Array<{ entry?: { memoryId?: string } }> | undefined;
      const visibleBefore =
        Array.isArray(before) && before.some((x) => x.entry?.memoryId === id);
      if (!visibleBefore)
        return fail("新鲜记忆未被召回（检索链本身不通，无法验证污染隔离）");

      await deprecate(id, "probe: 标记为已取代");
      const after = (await search(marker, { limit: 5 })) as
        Array<{ entry?: { memoryId?: string } }> | undefined;
      const visibleAfter =
        Array.isArray(after) && after.some((x) => x.entry?.memoryId === id);
      return visibleAfter
        ? fail("deprecated 记忆仍被召回（污染可进入上下文）")
        : pass("被取代记忆从召回结果中消失（污染隔离生效）");
    },
  ),
  "AG-BEN-RESUME": probe(
    "Infra/DurableExecution（故障恢复）",
    "设计 AG-4：迭代边界 checkpoint 可**从断点恢复续跑**，且不重复已完成副作用。" +
      "驱动入口=快照写入 API + 恢复 API（写入→中断→resume 取回断点与对话）。",
    async () => {
      const writeMod = await load(
        "AG-BEN-RESUME",
        "../../Src/Infra/DurableExecution/iterationCheckpoint.js",
      );
      const write = needFn(
        writeMod,
        "AG-BEN-RESUME",
        "writeIterationCheckpoint",
      );
      const mod = await load("AG-BEN-RESUME", M.checkpoint);
      const resume = needFn(mod, "AG-BEN-RESUME", "resumeFromCheckpoint");

      const loopId = `probe-resume-${Date.now()}`;
      const wrote = (await write({
        loopId,
        iteration: 2,
        decision: "continue",
        completedSteps: 2,
        failedAttempts: 0,
        nextStepHint: "继续第 3 轮",
        messages: [
          { role: "user", content: "第一轮输入" },
          { role: "assistant", content: "第一轮输出" },
        ],
      })) as unknown;
      const r = (await resume({ loopId })) as
        | {
            ok?: boolean;
            value?: {
              resumed?: boolean;
              iteration?: number;
              nextIteration?: number;
              messages?: unknown[];
            };
          }
        | undefined;
      const missing = (await resume({ loopId: `probe-none-${Date.now()}` })) as
        | { ok?: boolean; value?: { resumed?: boolean; reason?: string } }
        | undefined;

      if (!r || r.ok !== true)
        return fail(`恢复入口不可用（write=${String(wrote)}）`);
      const v = r.value;
      if (v?.resumed !== true)
        return fail("有快照却未判定可续跑（resumed !== true）");
      if (v.nextIteration !== 3)
        return fail(
          `断点轮次错误（iteration=${String(v.iteration)}，期望 next=3）`,
        );
      if (!Array.isArray(v.messages) || v.messages.length !== 2) {
        return fail('恢复未带回对话内容（无法"接着说"）');
      }
      if (!missing || missing.ok !== true || missing.value?.resumed !== false) {
        return fail('无快照时未如实报告"不可续跑"');
      }

      // 生产消费方：恢复执行器必须真的用这个断点（不是只有 API 存在）
      const loadLatest = needFn(mod, "AG-BEN-RESUME", "loadLatestCheckpoint");
      const latest = (await loadLatest(loopId)) as
        { ok?: boolean; value?: { checkpointId?: string } | null } | undefined;
      const checkpointId = latest?.value?.checkpointId;
      if (!checkpointId)
        return fail("读不到刚写入的 checkpoint（恢复执行器无输入）");
      const execMod = await load(
        "AG-BEN-RESUME",
        "../../Src/Infra/DurableExecution/recoveryExecutor.js",
      );
      const executeRecovery = needFn(
        execMod,
        "AG-BEN-RESUME",
        "executeRecovery",
      );
      const recovered = (await executeRecovery({
        strategy: "AUTO_RESUME",
        loopId,
        lastCheckpointId: checkpointId,
        reason: "probe",
      })) as
        | {
            ok?: boolean;
            value?: { nextIteration?: number; messages?: unknown[] };
            error?: string;
          }
        | undefined;
      if (!recovered || recovered.ok !== true) {
        return fail(`恢复执行器未消费断点：${recovered?.error ?? "unknown"}`);
      }
      if (recovered.value?.nextIteration !== 3) {
        return fail(
          `恢复执行器断点轮次错误（nextIteration=${String(recovered.value?.nextIteration)}）`,
        );
      }
      if (
        !Array.isArray(recovered.value?.messages) ||
        recovered.value.messages.length !== 2
      ) {
        return fail("恢复执行器未带回对话内容（ResumeResult.messages 缺失）");
      }
      return pass(
        "断点恢复可用：API 往返 + 恢复执行器真实消费（轮次/对话均带回）",
      );
    },
  ),
  "AGENT-ENV-SUBMITGATE": probe(
    "Core/AgentRuntime（单 Agent）",
    "设计 G9/M1：未 submit_for_review 时 isTaskApproved 恒 false，退出类别不得为 success。" +
      "驱动入口=AgentRuntime 公共 API。",
    async () => {
      const mod = await load("AGENT-ENV-SUBMITGATE", M.agentRuntime);
      const approved = needFn(mod, "AGENT-ENV-SUBMITGATE", "isTaskApproved");
      needFn(mod, "AGENT-ENV-SUBMITGATE", "submitForReview");
      const never = await approved("probe-agent-never-submitted");
      return never === false
        ? pass("未提交评审的 Agent 不被判成功")
        : fail("未提交评审却被判成功（提交门未生效）");
    },
  ),

  // ═══ 监管系统 ═══════════════════════════════════════════════════
  "SUP-SEC-FREEZEPERSIST": probe(
    "Services/Audit（监管）",
    "设计 §3.3：冻结状态跨重启存活（落库 + 启动回灌）。驱动入口=冻结管理器的公共 API；" +
      "本探针只调用设计声明的持久化/回灌入口，不读实现。",
    async () => {
      const mod = await load("SUP-SEC-FREEZEPERSIST", M.freeze);
      const freezeAgent = needFn(mod, "SUP-SEC-FREEZEPERSIST", "freezeAgent");
      const hydrate = needFn(
        mod,
        "SUP-SEC-FREEZEPERSIST",
        "hydrateFreezeState",
      );
      const isFrozen = needFn(mod, "SUP-SEC-FREEZEPERSIST", "isFrozen");
      const resetState = needFn(
        mod,
        "SUP-SEC-FREEZEPERSIST",
        "resetFreezeManager",
      );
      const agentId = `probe-freeze-${Date.now()}`;
      const frozen = (await freezeAgent(
        agentId,
        "设计契约探针：验证跨重启存活",
        "user",
      )) as { ok?: boolean; error?: string } | undefined;
      if (!frozen || frozen.ok === false) {
        return fail(
          `无法构造冻结样本：${frozen?.error ?? "freezeAgent 未返回判定"}`,
        );
      }
      // 模拟进程重启：清空内存态（库保留）→ 启动期回灌 → 查询仍为冻结
      await resetState();
      await hydrate();
      const stillFrozen = await isFrozen(agentId);
      return stillFrozen === true
        ? pass("冻结状态经落库+回灌后跨重启存活")
        : fail("重启（内存清空+回灌）后冻结状态丢失");
    },
  ),
  "SUP-SEC-AUDITCHAIN": probe(
    "Services/Governance（监管）",
    "设计 §3.3：治理审计记录有完整性链（prevHash/hash），篡改可检出。" +
      "驱动入口=治理审计的公共 API（写入 + 校验 + 读库视图）。",
    async () => {
      const mod = await load("SUP-SEC-AUDITCHAIN", M.audit);
      const record = needFn(
        mod,
        "SUP-SEC-AUDITCHAIN",
        "recordGovernanceAction",
      );
      const verify = needFn(mod, "SUP-SEC-AUDITCHAIN", "verifyAuditChain");
      const loadPersisted = needFn(
        mod,
        "SUP-SEC-AUDITCHAIN",
        "loadPersistedGovernanceRecords",
      );
      const rec = (await record({
        action: "audit.patrol",
        actorRole: "user",
        outcome: "allowed",
        reason: `设计契约探针:${Date.now()}`,
      })) as { recordId?: string } | undefined;
      const persisted = (await loadPersisted()) as Array<
        Record<string, unknown>
      >;
      if (!Array.isArray(persisted) || persisted.length === 0) {
        return fail("落库视图为空（无法构造审计链样本）");
      }
      const fresh = (await verify(persisted)) as
        { ok?: boolean; tampered?: boolean; reason?: string } | undefined;
      if (!fresh || fresh.ok !== true) {
        return fail(`新链自校验失败：${fresh?.reason ?? "unknown"}`);
      }
      const targetId = rec?.recordId;
      const tampered = persisted.map((r) =>
        r["recordId"] === targetId
          ? { ...r, reason: "被篡改（设计契约探针）" }
          : r,
      );
      const bad = (await verify(tampered)) as
        { ok?: boolean; tampered?: boolean } | undefined;
      return bad && bad.ok === false && bad.tampered === true
        ? pass("审计链完整且内容篡改可检出")
        : fail("篡改未被检出（无有效哈希链）");
    },
  ),
  "SUP-ENV-DEADLOCKWIRE": probe(
    "Services/Supervision（监管）",
    "设计 §3.3：互等死锁有检测方，命中风险退出而非挂起。" +
      "驱动入口=监管公共 API（有向图环检测 + 运行期看门入口）。",
    async () => {
      const mod = await load("SUP-ENV-DEADLOCKWIRE", M.supervision);
      const check = needFn(mod, "SUP-ENV-DEADLOCKWIRE", "checkLoopDeadlock");
      const detectWait = needFn(
        mod,
        "SUP-ENV-DEADLOCKWIRE",
        "detectWaitDeadlock",
      );
      const resetWatch = needFn(
        mod,
        "SUP-ENV-DEADLOCKWIRE",
        "resetDeadlockWatch",
      );
      needFn(mod, "SUP-ENV-DEADLOCKWIRE", "registerAgentWait");
      needFn(mod, "SUP-ENV-DEADLOCKWIRE", "collectWaitingPairs");

      const mutual = [
        { waiter: "a", waitingFor: "b" },
        { waiter: "b", waitingFor: "a" },
      ];
      const chain = [
        { waiter: "a", waitingFor: "b" },
        { waiter: "b", waitingFor: "c" },
      ];
      if ((await detectWait(mutual)) !== true)
        return fail("环检测未识别 A↔B 互等死锁");
      if ((await detectWait(chain)) !== false)
        return fail("链式等待（A→B→C）被误判为死锁");

      await resetWatch();
      const r = (await check({
        loopId: "probe-loop",
        waitingPairs: mutual,
      })) as
        | { ok?: boolean; value?: { deadlocked?: boolean; cycle?: string[] } }
        | undefined;
      if (r?.ok !== true || r.value?.deadlocked !== true) {
        return fail("运行期入口未检出死锁（无接线）");
      }

      // 生产写方验证：审批**真实阻塞等待**必须登记/清除等待边（不是只有检测函数）
      const approvalMod = await load(
        "SUP-ENV-DEADLOCKWIRE",
        "../../Src/Services/LoopControl/approvalGate.js",
      );
      const registerApproval = needFn(
        approvalMod,
        "SUP-ENV-DEADLOCKWIRE",
        "registerApproval",
      );
      const waitDecision = needFn(
        approvalMod,
        "SUP-ENV-DEADLOCKWIRE",
        "waitForApprovalDecision",
      );
      const clearApprovals = approvalMod["clearApprovalQueue"];
      const collect = needFn(
        mod,
        "SUP-ENV-DEADLOCKWIRE",
        "collectWaitingPairs",
      );
      await resetWatch();
      (registerApproval as (a: unknown) => void)({
        approvalId: "probe-approval-edge",
        loopId: "probe-loop",
        traceId: "probe-trace",
        iteration: 1,
        requestedAt: Date.now(),
        requestedBy: "probe-requester",
        kind: "tool_execute",
        payload: { targetAgentId: "probe-peer" },
        riskLevel: "MEDIUM",
        timeoutSec: 30,
        defaultOnTimeout: "reject",
        deciders: [{ role: "user", weight: 1 }],
        decisionPolicy: "majority",
        status: "PENDING",
      });
      const ac = new AbortController();
      const pendingDecision = waitDecision("probe-approval-edge", {
        signal: ac.signal,
        timeoutMs: 5_000,
      }) as Promise<unknown>;
      await new Promise((resolve) => setTimeout(resolve, 0));
      const edge = (
        (await collect()) as Array<{ waiter?: string; waitingFor?: string }>
      ).some(
        (w) => w.waiter === "probe-requester" && w.waitingFor === "probe-peer",
      );
      ac.abort();
      await pendingDecision;
      const cleared = !((await collect()) as Array<{ waiter?: string }>).some(
        (w) => w.waiter === "probe-requester",
      );
      if (typeof clearApprovals === "function") {
        (clearApprovals as () => void)();
      }
      if (!edge) return fail("审批阻塞期间未登记等待边（生产写方缺失）");
      if (!cleared) return fail("审批等待结束后等待边未清除（死锁看门会误报）");

      return pass(
        `死锁看门：环检测有效、运行期入口检出（${(r.value.cycle ?? []).join(" → ")}）、审批阻塞真实登记/清理等待边`,
      );
    },
  ),

  // ═══ 单 Agent 记忆系统 ══════════════════════════════════════════
  "MEM1-GAP-PARTITION": probe(
    "Services/Context（记忆）",
    "设计 §3.4：S/L/M/H 分区与**分区预算截断**在执行链上生效。" +
      "驱动入口=上下文装配公共 API（构造超预算的分区条目，断言按上限截断且 S 区不丢）。",
    async () => {
      const mod = await load("MEM1-GAP-PARTITION", M.contextPartitions);
      needValue(mod, "MEM1-GAP-PARTITION", "PARTITION_CONFIG");
      const assemble = needFn(mod, "MEM1-GAP-PARTITION", "assembleContext");
      const makeEntry = (
        id: string,
        partition: string,
        tokens: number,
        ts: number,
      ) => ({
        id,
        partition,
        type: "PROBE",
        metadata: {},
        timestamp: ts,
        content: "x".repeat(tokens),
        tokenEstimate: tokens,
        accessCount: 0,
        markedForDrop: false,
      });
      const entries = [
        makeEntry("e-s", "S", 100, 1),
        ...Array.from({ length: 20 }, (_, i) =>
          makeEntry(`e-h-${i}`, "H", 100, 10 + i),
        ),
      ];
      const out = (await assemble({ entries, budgetTokens: 1000 })) as
        | {
            partitions?: Record<string, unknown[]>;
            totalTokens?: number;
            dropped?: string[];
          }
        | undefined;
      if (!out || !out.partitions || !Array.isArray(out.partitions.H)) {
        return fail("assembleContext 未产出分区结果（分区未接入装配链）");
      }
      if (!Array.isArray(out.dropped) || out.dropped.length === 0) {
        return fail("分区预算未生效：超预算条目一条未丢");
      }
      if (!Array.isArray(out.partitions.S) || out.partitions.S.length !== 1) {
        return fail("S 区静态前缀被丢弃（静态区不可变）");
      }
      if (typeof out.totalTokens !== "number" || out.totalTokens > 1000) {
        return fail(
          `装配结果超出总预算（totalTokens=${String(out.totalTokens)}）`,
        );
      }
      return pass(
        `分区装配生效：H 区超上限丢 ${out.dropped.length} 条、S 区保留、总量 ${out.totalTokens}/1000`,
      );
    },
  ),
  "MEM1-GAP-RESTORE": probe(
    "Infra/DurableExecution（持久执行）",
    "设计 §3.4：恢复链包含**对话内容**（不只是轮次/阶段）。" +
      "驱动入口=迭代快照写入 API + checkpoint 读取 API（跨模块往返）。",
    async () => {
      const writeMod = await load(
        "MEM1-GAP-RESTORE",
        "../../Src/Infra/DurableExecution/iterationCheckpoint.js",
      );
      const write = needFn(
        writeMod,
        "MEM1-GAP-RESTORE",
        "writeIterationCheckpoint",
      );
      const mod = await load("MEM1-GAP-RESTORE", M.checkpoint);
      const loadCp = needFn(mod, "MEM1-GAP-RESTORE", "loadIterationCheckpoint");
      const loopId = `probe-restore-${Date.now()}`;
      const wrote = (await write({
        loopId,
        iteration: 3,
        decision: "continue",
        completedSteps: 3,
        failedAttempts: 0,
        messages: [
          { role: "user", content: "请继续完成任务" },
          { role: "assistant", content: "我已完成第一步" },
        ],
      })) as unknown;
      const loaded = (await loadCp(loopId)) as
        | {
            ok?: boolean;
            value?: { messages?: unknown[] } | null;
            error?: string;
          }
        | undefined;
      if (!loaded || loaded.ok === false) {
        return fail(
          `快照读取失败：${loaded?.error ?? "无返回值"}（write=${String(wrote)}）`,
        );
      }
      const cp = loaded.value;
      if (!cp)
        return fail(
          `快照未落库（write=${String(wrote)}，按 loopId 查不到记录）`,
        );
      if (!Array.isArray(cp.messages) || cp.messages.length !== 2) {
        return fail(
          `checkpoint 恢复链不含对话内容（实际 messages=${JSON.stringify(cp.messages)?.slice(0, 80)}）`,
        );
      }
      return pass("checkpoint 往返后带完整对话内容（2 条）");
    },
  ),

  // ═══ 子 Agent 系统 ══════════════════════════════════════════════
  "SUB-SEC-DEPTH": probe(
    "Services/Recruitment（子 Agent）",
    "设计 §3.6：派生有深度上限（partner 不可无限再招募 partner）。" +
      "驱动入口=招募公共 API + 父链查询（构造 depth=2 的父链后招募必须被拒）。",
    async () => {
      const recruiter = await load("SUB-SEC-DEPTH", M.recruiter);
      const depthOf = needFn(recruiter, "SUB-SEC-DEPTH", "getDeriveDepth");
      const recruit = needFn(recruiter, "SUB-SEC-DEPTH", "recruitAgent");
      const reg = await load("SUB-SEC-DEPTH", M.agentRegistry);
      const setParent = needFn(reg, "SUB-SEC-DEPTH", "setAgentParent");
      const factory = await load("SUB-SEC-DEPTH", M.agentFactory);
      const createAgent = needFn(factory, "SUB-SEC-DEPTH", "createAgent");

      const traceId = `probe-depth-${Date.now()}`;
      const made: string[] = [];
      const createOne = (): string => {
        const r = createAgent(
          { role: "partner", model: "probe/model" },
          traceId,
        ) as { ok?: boolean; value?: { agentId?: string } } | undefined;
        return r?.value?.agentId ?? "";
      };
      const root = createOne();
      const mid = createOne();
      const leaf = createOne();
      if (!root || !mid || !leaf)
        return fail("无法创建深度探针 Agent 链（createAgent 失败）");
      made.push(root, mid, leaf);
      setParent(mid, root);
      setParent(leaf, mid);

      const dRoot = (await depthOf(root)) as unknown;
      const dLeaf = (await depthOf(leaf)) as unknown;
      if (dRoot !== 0)
        return fail(`根 Agent 深度应为 0（实际 ${String(dRoot)}）`);
      if (dLeaf !== 2) return fail(`孙代深度应为 2（实际 ${String(dLeaf)}）`);

      const tooDeep = (await recruit({
        role: "partner",
        domain: "probe",
        traceId,
        parentAgentId: leaf,
        tokenBudget: 1000,
        maxIterations: 3,
      })) as { ok?: boolean; error?: string } | undefined;
      if (tooDeep?.ok !== false) {
        return fail("深度超限仍招募成功（深度无强制 / 可无限再招募）");
      }
      return pass("派生深度模型生效：根 0 / 孙代 2，超限招募被拒");
    },
  ),
  "SUB-SEC-TOOLPERM": probe(
    "Infra/Security + Tools（工具权限）",
    "设计 §3.6：执行侧按 allowed_tools 裁剪（权限非装饰）。" +
      "驱动入口=执行器公共 API：同一次调用在白名单内/外必须行为不同。",
    async () => {
      const reg = await load(
        "SUB-SEC-TOOLPERM",
        "../../Src/Tools/Registry/toolRegistry.js",
      );
      const register = needFn(reg, "SUB-SEC-TOOLPERM", "registerTool");
      const execute = needFn(reg, "SUB-SEC-TOOLPERM", "executeTool");
      const spec = {
        name: "ProbePermTool",
        version: "0.1.0",
        description: "设计契约探针：白名单裁剪验证",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        outputSchema: contentOutputSchema("{ ok: boolean }"),
        dangerLevel: "SAFE",
        idempotency: "YES",
        idempotencyKeyFields: ["tool"],
        reversibility: "REVERSIBLE",
        sideEffectScope: "none",
        requiredRoles: [
          "worker",
          "partner",
          "prime_director",
          "arbitrator",
          "auditor",
          "assembly_node",
          "reviewer",
          "regulator",
        ],
        sandboxMode: "none",
        timeoutMs: 5_000,
      };
      const registered = (await register({
        spec,
        execute: async (_i: unknown, context: { operationId: string }) =>
          toolSuccess(context.operationId, { ok: true }),
      })) as { ok?: boolean; error?: string } | undefined;
      if (!registered || registered.ok === false) {
        return fail(
          `无法注册权限探针工具：${registered?.error ?? "组合根拒绝"}`,
        );
      }
      const baseCtx = {
        operationId: `probe-perm-${Date.now()}`,
        agentId: "probe-agent-perm",
        agentRole: "worker",
        loopId: "probe-loop",
        traceId: "probe-trace",
      };
      const denied = (await execute(
        "ProbePermTool",
        {},
        {
          ...baseCtx,
          allowedTools: [],
        },
      )) as { status?: string; error?: { code?: string } } | undefined;
      if (denied?.error?.code !== "TOOL_NOT_ALLOWED") {
        return fail(
          `白名单为空时工具仍被执行（错误码=${denied?.error?.code ?? "无"}）—— allowed_tools 未在执行侧生效`,
        );
      }
      const allowed = (await execute(
        "ProbePermTool",
        {},
        {
          ...baseCtx,
          allowedTools: ["ProbePermTool"],
        },
      )) as { status?: string } | undefined;
      if (allowed?.status !== "success") {
        return fail("白名单内工具被执行器拒绝（权限过严）");
      }
      return pass(
        "allowed_tools 执行侧强制生效：清单外拒绝（TOOL_NOT_ALLOWED）、清单内放行",
      );
    },
  ),

  // ═══ 多 Agent 记忆系统 ══════════════════════════════════════════
  "MEMN-SEC-READAUTH": probe(
    "Services/SharedMemory（多 Agent 记忆）",
    "设计 §3.8：共享记忆读侧有 agent 级鉴权（同属主下不可读回他人条目）。" +
      "驱动入口=globalWorkspace 公共 API：写入两个 Agent 各自署名条目，再以不同 requester 读。",
    async () => {
      const mod = await load("MEMN-SEC-READAUTH", M.globalWorkspace);
      const read = needFn(mod, "MEMN-SEC-READAUTH", "read");
      const write = needFn(mod, "MEMN-SEC-READAUTH", "write");
      const tag = Date.now();
      const key = `probe.readauth.${tag}`;
      const written = (await write({
        key,
        content: "probe-a 的私有观察",
        contentType: "observation",
        assertion: "observed",
        traceId: `probe-trace-${tag}`,
        agentId: "probe-agent-a",
      })) as { ok?: boolean; error?: string } | undefined;
      if (!written || written.ok === false) {
        return fail(`无法构造读鉴权样本：${written?.error ?? "写入被拒"}`);
      }
      const byOther = (await read({
        key,
        agentId: "probe-agent-a",
        requesterAgentId: "probe-agent-b",
      })) as unknown[] | undefined;
      const bySelf = (await read({
        key,
        agentId: "probe-agent-a",
        requesterAgentId: "probe-agent-a",
      })) as unknown[] | undefined;
      if (!Array.isArray(byOther)) return fail("read() 未返回数组（契约不符）");
      if (byOther.length > 0) {
        return fail(
          "同属主下 Agent-B 读回了 Agent-A 署名的条目（读侧无 agent 级鉴权）",
        );
      }
      if (!Array.isArray(bySelf) || bySelf.length === 0) {
        return fail("Agent 读不回自己署名的条目（鉴权过严，误伤自身读取）");
      }
      return pass("读侧 agent 级鉴权生效：他人条目不可见、自己的条目可见");
    },
  ),
  "MEMN-SEC-MEMREF": probe(
    "Services/A2A（多 Agent 记忆）",
    "设计 §3.8：A2A 记忆引用必须校验存在性与版本（无法校验 ≠ 校验通过）。" +
      "驱动入口=A2A broker 公共 API（memoryRefs + lookupMemoryRef 依赖注入）。",
    async () => {
      const mod = await load("MEMN-SEC-MEMREF", M.a2aBroker);
      const send = needFn(mod, "MEMN-SEC-MEMREF", "sendA2A");
      type Decision = { verdict?: string; reasons?: string[] };
      type Res = { decision?: Decision } | undefined;
      const base = {
        sourceAgentId: "probe-a",
        targetAgentId: "probe-b",
        kind: "inform",
        taskId: "probe-task",
        payload: {},
      };

      // ① 未注入校验器 → 不得谎称"已校验"（不出现 memory_ref_* 断言的放行/拒绝）
      const noDeps = (await send({
        ...base,
        memoryRefs: [{ key: "probe.missing.key", version: 1 }],
      })) as Res;
      const noDepsReasons = noDeps?.decision?.reasons ?? [];
      if (noDepsReasons.some((r) => r.startsWith("memory_ref"))) {
        return fail(
          `未注入校验器却给出了记忆引用判定（reasons=${JSON.stringify(noDepsReasons)}）`,
        );
      }
      // ② 校验器判定不存在 → 拒绝
      const missing = (await send(
        { ...base, memoryRefs: [{ key: "probe.missing.key", version: 1 }] },
        { lookupMemoryRef: () => ({ exists: false }) },
      )) as Res;
      if (
        !(missing?.decision?.reasons ?? []).some((r) =>
          r.startsWith("memory_ref_not_found"),
        )
      ) {
        return fail("不存在的记忆引用未被拒");
      }
      // ③ 版本不符 → 拒绝
      const mismatch = (await send(
        { ...base, memoryRefs: [{ key: "probe.key", version: 1 }] },
        { lookupMemoryRef: () => ({ exists: true, version: 2 }) },
      )) as Res;
      if (
        !(mismatch?.decision?.reasons ?? []).some((r) =>
          r.startsWith("memory_ref_version_mismatch"),
        )
      ) {
        return fail("版本不符的记忆引用未被拒");
      }
      // ④ 校验通过 → 不得因 memoryRefs 被拒（后续卡片校验属另一条判据，不在本 cell 断言之列）
      const valid = (await send(
        { ...base, memoryRefs: [{ key: "probe.key", version: 2 }] },
        { lookupMemoryRef: () => ({ exists: true, version: 2 }) },
      )) as Res;
      if (
        (valid?.decision?.reasons ?? []).some((r) => r.startsWith("memory_ref"))
      ) {
        return fail("校验通过的 memoryRefs 仍被拒");
      }
      return pass(
        "memoryRefs 存在性/版本校验生效（缺校验器/不存在/版本不符均拒）",
      );
    },
  ),
  "MEMN-GAP-EVENTSUB": probe(
    "Services/EventBus + SharedMemory（多 Agent 记忆）",
    "设计 §3.8：存在 MEMORY_WRITTEN → 记忆沉淀的**订阅链**。" +
      '驱动入口=事件总线公共 API + 订阅器安装入口（断言"有订阅者"且"事件确实驱动消费"）。',
    async () => {
      const bus = await load("MEMN-GAP-EVENTSUB", M.eventBus);
      const getSubscribers = needFn(bus, "MEMN-GAP-EVENTSUB", "getSubscribers");
      const publish = needFn(bus, "MEMN-GAP-EVENTSUB", "publish");
      const createEvent = needFn(bus, "MEMN-GAP-EVENTSUB", "createEvent");
      const subMod = await load(
        "MEMN-GAP-EVENTSUB",
        "../../Src/Services/SharedMemory/memoryWriteSubscriber.js",
      );
      const install = needFn(
        subMod,
        "MEMN-GAP-EVENTSUB",
        "installMemoryWriteSubscriber",
      );
      const getRecent = needFn(
        subMod,
        "MEMN-GAP-EVENTSUB",
        "getRecentMemoryWrites",
      );

      await install();
      const subs = (await getSubscribers("memory:written")) as
        unknown[] | undefined;
      if (!Array.isArray(subs) || subs.length === 0) {
        return fail('MEMORY_WRITTEN 无订阅者（不存在"事件→记忆沉淀"订阅链）');
      }
      const before = ((await getRecent()) as unknown[]).length;
      await publish(
        (await createEvent({
          eventType: "memory:written",
          source: "probe",
          traceId: "probe-trace",
          payload: {
            entryId: "probe-entry",
            key: "probe.key",
            agentId: "probe-a",
          },
        })) as never,
      );
      const after = ((await getRecent()) as unknown[]).length;
      return after > before
        ? pass(
            `MEMORY_WRITTEN 有 ${subs.length} 个订阅者，且事件确实驱动消费（${before}→${after}）`,
          )
        : fail("订阅者已注册但未被事件驱动（订阅链未生效）");
    },
  ),
  "MEMN-SEC-VERSION": probe(
    "Services/SharedMemory（多 Agent 记忆）",
    "设计 §3.8：expectedVersion 不匹配 → 写侧返回 err 且内容不落库。驱动入口=写守卫公共 API。",
    async () => {
      const mod = await load("MEMN-SEC-VERSION", M.globalWorkspace);
      const write = needFn(mod, "MEMN-SEC-VERSION", "write");
      const r = (await write({
        ownerUserId: "u1",
        agentId: "a1",
        key: "task.summary",
        content: "并发冲突样本",
        expectedVersion: -1,
      })) as { ok?: boolean } | undefined;
      return r && r.ok === false
        ? pass("版本冲突被拒")
        : fail("expectedVersion 失配未被拒（乐观锁未生效）");
    },
  ),

  // ═══ 检索系统 ═══════════════════════════════════════════════════
  "RET-ENV-EMBDOWN": probe(
    "Services/Retrieval（检索）",
    "设计 §3.2：嵌入不可用时等价回落到纯文本分数且不抛错。驱动入口=检索器公共 API。",
    async () => {
      const mod = await load("RET-ENV-EMBDOWN", M.retriever);
      const create = needFn(mod, "RET-ENV-EMBDOWN", "createMemoryRetriever");
      const retriever = create() as {
        retrieve?: (o: unknown) => Promise<unknown>;
      };
      if (typeof retriever.retrieve !== "function")
        return fail("createMemoryRetriever() 未返回带 retrieve() 的检索器");
      const r = (await retriever.retrieve({
        query: "数据库",
        topK: 5,
        minScore: 0,
      })) as
        | {
            ok?: boolean;
            value?: { fragments?: unknown[]; durationMs?: number };
          }
        | undefined;
      return r && r.ok === true
        ? pass("无嵌入时检索正常返回（回落路径）")
        : fail("嵌入不可用时检索失败/抛错（未回落纯文本）");
    },
  ),

  // ═══ 工具系统 ═══════════════════════════════════════════════════
  "TOOL-SEC-SANDBOX": probe(
    "Tools（工具执行链）",
    "设计 §3.1：sandboxMode 是安全边界 —— 执行链必须按它改变行为：" +
      "承载不可用即 fail-closed（SANDBOX_UNAVAILABLE），承载可用才执行。" +
      "驱动入口=注册表 + 派发器 + 端口注入的公共 API（构造 strict 工具并派发两次）。",
    async () => {
      const reg = await load(
        "TOOL-SEC-SANDBOX",
        "../../Src/Tools/Registry/toolRegistry.js",
      );
      const register = needFn(reg, "TOOL-SEC-SANDBOX", "registerTool");
      const disp = await load(
        "TOOL-SEC-SANDBOX",
        "../../Src/Tools/Registry/toolDispatcher.js",
      );
      const dispatch = needFn(disp, "TOOL-SEC-SANDBOX", "dispatchToolCall");
      const portsMod = await load(
        "TOOL-SEC-SANDBOX",
        "../../Src/Tools/Registry/toolServicePorts.js",
      );
      const configure = needFn(
        portsMod,
        "TOOL-SEC-SANDBOX",
        "configureToolServicePorts",
      );

      const spec = {
        name: "ProbeSandboxTool",
        version: "0.1.0",
        description: "设计契约探针：声明 strict 沙箱的工具",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        outputSchema: contentOutputSchema("{ ok: boolean }"),
        dangerLevel: "SAFE",
        idempotency: "NO",
        reversibility: "REVERSIBLE",
        sideEffectScope: "process",
        requiredRoles: [
          "worker",
          "partner",
          "prime_director",
          "arbitrator",
          "auditor",
          "assembly_node",
          "reviewer",
          "regulator",
        ],
        sandboxMode: "strict",
        timeoutMs: 5_000,
      };
      const registered = (await register({
        spec,
        execute: async (_input: unknown, context: { operationId: string }) =>
          toolSuccess(context.operationId, { ok: true }),
      })) as { ok?: boolean; error?: string } | undefined;
      if (!registered || registered.ok === false) {
        return fail(
          `无法注册 strict 沙箱工具：${registered?.error ?? "组合根拒绝注册"}`,
        );
      }

      const ctx = {
        operationId: `probe-sandbox-${Date.now()}`,
        agentId: "probe-agent",
        agentRole: "worker",
        loopId: "probe-loop",
        traceId: "probe-trace",
      };
      const setGate = configure as (p: Record<string, unknown>) => void;
      try {
        // ① 承载不可用 → 必须 fail-closed（拒绝执行，给出 SANDBOX_* 错误码）
        setGate({ sandboxGate: { isAvailable: () => false } });
        const denied = (await dispatch({
          toolName: "ProbeSandboxTool",
          arguments: {},
          context: ctx,
          iteration: 1,
        })) as
          | { result?: { status?: string; error?: { code?: string } } }
          | undefined;
        const code = denied?.result?.error?.code ?? "";
        if (!/SANDBOX/.test(code)) {
          return fail(
            `沙箱承载不可用时工具仍被执行（错误码=${code || "无"}）—— sandboxMode 未在执行链生效`,
          );
        }
        // ② 承载可用 → 行为必须切换为执行
        setGate({ sandboxGate: { isAvailable: () => true } });
        const allowed = (await dispatch({
          toolName: "ProbeSandboxTool",
          arguments: {},
          context: ctx,
          iteration: 2,
        })) as { result?: { status?: string } } | undefined;
        if (allowed?.result?.status !== "success") {
          return fail(
            "沙箱承载可用时工具未执行（执行链未按 sandboxMode 切换行为）",
          );
        }
        return pass(
          `执行链按 sandboxMode 切换：不可用 fail-closed（${code}）、可用即执行`,
        );
      } finally {
        setGate({ sandboxGate: undefined });
      }
    },
  ),

  // ═══ 可观测 ════════════════════════════════════════════════════
  "MM-GAP-VISION": probe(
    "Infra/Llm/Router（可观测/多模态）",
    "设计 §3.9：supports_vision 被路由读取（非死字段）。驱动入口=模型路由公共 API。",
    async () => {
      const mod = await load("MM-GAP-VISION", M.modelRouter);
      const can = needFn(mod, "MM-GAP-VISION", "supportsVision");
      return can("huawei-maas/GLM-5.1") === false
        ? pass("路由按 supports_vision 判定（读到能力位）")
        : fail("路由未读取 supports_vision（视觉声明既不生效也不报错）");
    },
  ),
  "MM-GAP-TRACE": probe(
    "Infra/Logging（可观测）",
    "设计 §3.9：**双层 trace**（trace + span）必须接线 —— 既有执行期上下文，也有可检索的 span 产物。" +
      "驱动入口=traceContext 公共 API：`runInTrace` / `runInSpan` / `currentSpanId`，" +
      "以及 span 记录/检索面（若不存在，则只有上下文、没有可观测产物）。",
    async () => {
      const mod = await load("MM-GAP-TRACE", M.traceContext);
      const runInTrace = needFn(mod, "MM-GAP-TRACE", "runInTrace");
      const span = needFn(mod, "MM-GAP-TRACE", "runInSpan");
      const currentSpanId = needFn(mod, "MM-GAP-TRACE", "currentSpanId");
      const currentTraceId = needFn(mod, "MM-GAP-TRACE", "currentTraceId");

      let observedSpanId = "";
      let observedTraceId = "";
      await (
        runInTrace as (
          o: unknown,
          f: () => Promise<unknown>,
        ) => Promise<unknown>
      )({}, async () =>
        (span as (o: unknown, f: () => Promise<unknown>) => Promise<unknown>)(
          { type: "llm_call" },
          async () => {
            observedSpanId = String((await currentSpanId()) ?? "");
            observedTraceId = String((await currentTraceId()) ?? "");
            return "ok";
          },
        ),
      );
      if (!observedSpanId || !observedTraceId) {
        return fail("span 层未建立/未传播上下文（trace/span id 为空）");
      }
      // 双层 trace 的判据不止"能执行"：span 必须是**可检索的产物**（落盘/导出/列表），
      // 否则只有执行期上下文，重启后无迹可循，等于没接线。
      const retrieval = [
        "listSpans",
        "getTraceSpans",
        "exportTrace",
        "getSpansForTrace",
      ].filter((n) => typeof mod[n] === "function");
      return retrieval.length > 0
        ? pass(`span 上下文传播可用且存在检索面（${retrieval.join("/")}）`)
        : fail(
            `span 层可执行（spanId=${observedSpanId.slice(0, 8)}…）但缺少 span 记录/检索面（无 listSpans/getTraceSpans 等入口）—— 双层 trace 仍未接线`,
          );
    },
  ),
  "MM-GAP-EVENTSTABLE": probe(
    "Services/EventBus + Infra/Db（可观测）",
    "设计 §3.9：事件必须**跨进程可回放**（events/domain_events 有写入方，非孤岛表）。" +
      "驱动入口=事件总线公共 API：publish → 从持久层回放读回同一条事件。",
    async () => {
      const bus = await load("MM-GAP-EVENTSTABLE", M.eventBus);
      const publish = needFn(bus, "MM-GAP-EVENTSTABLE", "publish");
      const createEvent = needFn(bus, "MM-GAP-EVENTSTABLE", "createEvent");
      const loadPersisted = needFn(
        bus,
        "MM-GAP-EVENTSTABLE",
        "loadPersistedEvents",
      );

      const traceId = `probe-events-${Date.now()}`;
      const event = (await createEvent({
        eventType: "memory:written",
        source: "probe/eventstable",
        traceId,
        payload: { entryId: "probe-event-entry", key: "probe.event.key" },
      })) as { eventId?: string };
      await publish(event as never);

      const replayed = (await loadPersisted({ traceId, limit: 10 })) as
        Array<{ eventId?: string; eventType?: string }> | undefined;
      if (!Array.isArray(replayed) || replayed.length === 0) {
        return fail(
          "发布的事件未落库（domain_events 无写入方 → 无法跨进程回放）",
        );
      }
      const found = replayed.some((e) => e.eventId === event.eventId);
      return found
        ? pass(
            `事件已落库并可回放（trace=${traceId}，回放 ${replayed.length} 条）`,
          )
        : fail("落库事件与发布事件不匹配（回放链路错位）");
    },
  ),

  // ═══ Agent 分裂（设计 §3.7 / §4.9：产品零实现，实验按语义契约） ═══
  ...splitProbes(),
  // ═══ 多模态（设计 §3.9 / §4.10） ═══════════════════════════════
  ...multimodalProbes(),
};

/** 分裂系统 13 条：设计 §3.7 / §4.9 的语义契约（**假设接口**，产品未实现时如实红） */
function splitProbes(): Record<string, DesignProbe> {
  const layer = "Core/AgentRuntime + Services/Recruitment（分裂）";
  const why =
    "设计 §3.7：分裂面产品尚未实现。本组探针按**设计声明的语义**假定接口形态并直接断言 oracle；" +
    "接口不存在 ⇒ 红（缺口复现），实现一旦落地即可逐条校验语义，接口对齐放到红转绿阶段。";
  const out: Record<string, DesignProbe> = {};

  const def = (cell: string, run: ProbeRun): void => {
    out[cell] = probe(layer, why, run);
  };

  // 1) 血缘：根 → 本节点的链，带深度与 rootId
  def("SPLIT-SEM-BLOODLINE", async () => {
    const mod = await load("SPLIT-SEM-BLOODLINE", M.split);
    const lineage = needFn(mod, "SPLIT-SEM-BLOODLINE", "querySplitLineage");
    const chain = (await lineage("probe-agent")) as Array<{
      agentId?: string;
      parentAgentId?: string | null;
      depth?: number;
      rootId?: string;
    }>;
    if (!Array.isArray(chain) || chain.length === 0)
      return fail("querySplitLineage 未返回血缘链数组");
    const head = chain[0];
    const tail = chain[chain.length - 1];
    if (typeof head?.depth !== "number" || head.depth !== 0)
      return fail("血缘链首节点 depth 必须为 0");
    if (typeof tail?.rootId !== "string" || tail.rootId !== head.agentId)
      return fail("rootId 未指向链根");
    if ((tail?.agentId ?? "") !== "probe-agent")
      return fail("血缘链末节点应为被查询 Agent");
    return pass("血缘链（根→本节点）含深度与 rootId");
  });

  // 2) 继承：目标/工具可继承，预算必须重置（防分裂放大总预算）
  def("SPLIT-SEM-INHERIT", async () => {
    const mod = await load("SPLIT-SEM-INHERIT", M.split);
    const policy = needFn(mod, "SPLIT-SEM-INHERIT", "splitInheritancePolicy");
    const p = (await policy("probe-agent")) as Record<string, unknown>;
    if (!p || typeof p !== "object")
      return fail("splitInheritancePolicy 未返回策略对象");
    if (p["inheritGoal"] !== true)
      return fail("派生未继承目标（继承策略缺失）");
    if (p["resetBudget"] !== true)
      return fail("派生未重置预算（分裂会线性放大总预算）");
    return pass("派生策略：继承目标、重置预算");
  });

  // 3) 深度：有上限，且能算当前深度
  def("SPLIT-SEM-DEPTH", async () => {
    const mod = await load("SPLIT-SEM-DEPTH", M.split);
    const limit = needFn(mod, "SPLIT-SEM-DEPTH", "splitDepthLimit");
    const depthOf = needFn(mod, "SPLIT-SEM-DEPTH", "splitDepthOf");
    const max = (await limit()) as unknown;
    if (typeof max !== "number" || !Number.isFinite(max) || max <= 0) {
      return fail("splitDepthLimit 未返回有限正数（无深度上限）");
    }
    const d = (await depthOf("probe-agent")) as unknown;
    if (typeof d !== "number" || d < 0)
      return fail("splitDepthOf 未返回有效深度");
    return pass(`深度模型可用（上限 ${max}，当前 ${d}）`);
  });

  // 4) 授权：分裂必须走审批单，且不得自称已批准
  def("SPLIT-SEM-AUTH", async () => {
    const mod = await load("SPLIT-SEM-AUTH", M.split);
    const request = needFn(mod, "SPLIT-SEM-AUTH", "requestSplitApproval");
    const r = (await request({
      agentId: "probe-agent",
      domain: "probe",
      parts: [{ id: "a" }, { id: "b" }],
    })) as
      | { ok?: boolean; value?: { approvalId?: string; status?: string } }
      | undefined;
    if (!r || r.ok !== true || !r.value?.approvalId)
      return fail("requestSplitApproval 未返回审批单号");
    if (r.value.status !== "pending")
      return fail("分裂授权不得自称已批准（必须 pending）");
    return pass(`分裂授权单已登记（${r.value.approvalId}）`);
  });

  // 5) 可见性：只看自己分片的文件，其它分片进入 hidden
  def("SPLIT-SEM-VISIBILITY", async () => {
    const mod = await load("SPLIT-SEM-VISIBILITY", M.split);
    const scope = needFn(mod, "SPLIT-SEM-VISIBILITY", "splitVisibilityScope");
    const s = (await scope({
      agentId: "a",
      parts: [
        { id: "a", files: ["src/a.ts"] },
        { id: "b", files: ["src/b.ts"] },
      ],
    })) as { visible?: string[]; hidden?: string[] } | undefined;
    if (!s || !Array.isArray(s.visible) || !Array.isArray(s.hidden))
      return fail("splitVisibilityScope 未返回 {visible, hidden}");
    const hidden = s.hidden;
    if (!s.visible.includes("src/a.ts")) return fail("本分片文件不可见");
    if (!hidden.includes("src/b.ts"))
      return fail("其它分片文件未隐藏（可见性未收窄）");
    if (s.visible.some((f) => hidden.includes(f)))
      return fail("visible 与 hidden 存在重叠");
    return pass("可见性收窄到本分片");
  });

  // 6) 自分裂：按分片创建同级 Agent；空分片必须拒绝
  def("SPLIT-SEM-SELFSPLIT", async () => {
    const mod = await load("SPLIT-SEM-SELFSPLIT", M.split);
    const selfSplit = needFn(mod, "SPLIT-SEM-SELFSPLIT", "agentSelfSplit");
    const empty = (await selfSplit({
      agentId: "probe-agent",
      task: "x",
      parts: [],
    })) as { ok?: boolean } | undefined;
    if (empty?.ok !== false)
      return fail("空分片未被拒绝（自分裂缺少输入校验）");
    const r = (await selfSplit({
      agentId: "probe-agent",
      task: "拆分任务",
      parts: [
        { id: "a", writePaths: ["src/a.ts"] },
        { id: "b", writePaths: ["src/b.ts"] },
      ],
    })) as { ok?: boolean; value?: { siblings?: string[] } } | undefined;
    if (r?.ok !== true) return fail("自分裂未返回成功（无法创建同级 Agent）");
    if ((r.value?.siblings ?? []).length !== 2)
      return fail("分片数（2）与创建出的同级 Agent 数不一致");
    return pass("自分裂按分片创建同级 Agent");
  });

  // 7) 自合并：只允许同级/同根；返回合并形态
  def("SPLIT-SEM-SELFMERGE", async () => {
    const mod = await load("SPLIT-SEM-SELFMERGE", M.split);
    const request = needFn(mod, "SPLIT-SEM-SELFMERGE", "agentRequestMerge");
    const unrelated = (await request({
      agentId: "probe-a",
      peerId: "probe-b",
    })) as { ok?: boolean } | undefined;
    if (unrelated?.ok !== false) return fail("无关 Agent 的合并申请未被拒绝");
    return pass("自合并拒绝无关 Agent（仅同级/同根可申请）");
  });

  // 8) 相似度：0–1，且同文=1、无关=0
  def("SPLIT-SEM-SIMILARITY", async () => {
    const mod = await load("SPLIT-SEM-SIMILARITY", M.split);
    const sim = needFn(mod, "SPLIT-SEM-SIMILARITY", "measureWorkSimilarity");
    const same = (await sim("数据库迁移脚本", "数据库迁移脚本")) as unknown;
    const disjoint = (await sim("数据库迁移脚本", "前端主题配色")) as unknown;
    if (typeof same !== "number" || typeof disjoint !== "number")
      return fail("measureWorkSimilarity 未返回数值");
    if (same < 0 || same > 1 || disjoint < 0 || disjoint > 1)
      return fail("相似度越界（应在 [0,1]）");
    if (same < 0.99) return fail(`相同工作的相似度应≈1（实际 ${same}）`);
    if (disjoint > 0.01) return fail(`无关工作相似度应≈0（实际 ${disjoint}）`);
    return pass(`相似度可用（同文 ${same}，无关 ${disjoint}）`);
  });

  // 9) 闭环：分片必须覆盖原任务要件
  def("SPLIT-SEM-CLOSURE", async () => {
    const mod = await load("SPLIT-SEM-CLOSURE", M.split);
    const validate = needFn(mod, "SPLIT-SEM-CLOSURE", "validateSplitClosure");
    const covered = (await validate({
      task: "数据库 迁移",
      parts: [
        { id: "a", task: "数据库" },
        { id: "b", task: "迁移" },
      ],
    })) as { closed?: boolean; missing?: string[] } | undefined;
    const missing = (await validate({
      task: "数据库 迁移 回滚",
      parts: [{ id: "a", task: "数据库" }],
    })) as { closed?: boolean; missing?: string[] } | undefined;
    if (covered?.closed !== true) return fail("全覆盖的分片被判为不闭环");
    if (missing?.closed !== false || !(missing.missing ?? []).length) {
      return fail("未覆盖的要件未被识别（闭环校验恒真）");
    }
    return pass("闭环校验可识别未覆盖要件");
  });

  // 10) 冲突域：共享可写路径必须被检出
  def("SPLIT-SEM-CONFLICTDOMAIN", async () => {
    const mod = await load("SPLIT-SEM-CONFLICTDOMAIN", M.split);
    const detect = needFn(
      mod,
      "SPLIT-SEM-CONFLICTDOMAIN",
      "detectConflictDomain",
    );
    const conflict = (await detect([
      { id: "a", writePaths: ["src/shared.ts"] },
      { id: "b", writePaths: ["src/shared.ts"] },
    ])) as unknown;
    const clean = (await detect([
      { id: "a", writePaths: ["src/a.ts"] },
      { id: "b", writePaths: ["src/b.ts"] },
    ])) as unknown;
    if (!Array.isArray(conflict) || !conflict.includes("src/shared.ts")) {
      return fail("共享可写路径未被识别为冲突域");
    }
    if (!Array.isArray(clean) || clean.length !== 0)
      return fail("无冲突分片被误报冲突");
    return pass("冲突域检出共享可写路径");
  });

  // 11) 同级判定：同父为同级，无父子关系不是同级
  def("SPLIT-SEM-PEER", async () => {
    const mod = await load("SPLIT-SEM-PEER", M.split);
    const isPeer = needFn(mod, "SPLIT-SEM-PEER", "isPeerSplit");
    const self = (await isPeer("probe-agent", "probe-agent")) as unknown;
    const unrelated = (await isPeer("probe-a", "probe-b")) as unknown;
    if (self !== false) return fail("同一 Agent 被判为同级分裂");
    if (unrelated !== false) return fail("无父子关系的 Agent 被判为同级");
    return pass("同级判定语义成立（反例不误判）");
  });

  // 12) 每步一个：同一 step 内多次分裂非法
  def("SPLIT-SEM-ONEPERSTEP", async () => {
    const mod = await load("SPLIT-SEM-ONEPERSTEP", M.split);
    const check = needFn(mod, "SPLIT-SEM-ONEPERSTEP", "splitOnePerStep");
    const two = (await check({
      stepIndex: 3,
      splits: [{ stepIndex: 3 }, { stepIndex: 3 }],
    })) as unknown;
    const one = (await check({
      stepIndex: 3,
      splits: [{ stepIndex: 3 }, { stepIndex: 4 }],
    })) as unknown;
    if (two !== false) return fail("同一步两次分裂未被拒绝（数量可指数增长）");
    if (one !== true) return fail("每步一次的分裂被误拒");
    return pass("每步至多一次分裂");
  });

  // 13) 合并形态：自合并 / 同级 / 吸收 / 不可合并
  def("SPLIT-SEM-MERGEKIND", async () => {
    const mod = await load("SPLIT-SEM-MERGEKIND", M.split);
    const kindOf = needFn(mod, "SPLIT-SEM-MERGEKIND", "mergeKindOf");
    const selfKind = (await kindOf("probe-agent", "probe-agent")) as unknown;
    const noneKind = (await kindOf("probe-a", "probe-b")) as unknown;
    if (selfKind !== "self_merge")
      return fail(`自合并形态判定错误（${String(selfKind)}）`);
    if (noneKind !== "none")
      return fail(`不可合并关系判定错误（${String(noneKind)}）`);
    return pass("合并形态判定：self_merge / none");
  });

  return out;
}

/** 多模态 2 条：内容块通路 + sightUse 视觉工具 */
function multimodalProbes(): Record<string, DesignProbe> {
  return {
    "MM-DECL-MULTIMODAL": probe(
      "Infra/Llm/Provider（多模态）",
      "设计 §4.10：多模态输入有两条确定路径（内容块原生 / 视觉工具 sightUse）。" +
        "探针做**线上报文级**黑盒观测：内容块必须原样进入 wire payload（数组 + image_url），" +
        "被字符串化/丢弃即视为无多模态通路。",
      async () => {
        const ops = await load(
          "MM-DECL-MULTIMODAL",
          "../../Src/Infra/Llm/Provider/openaiProvider.js",
        );
        const create = needFn(
          ops,
          "MM-DECL-MULTIMODAL",
          "createOpenAIProvider",
        );
        const provider = create({
          provider: "probe",
          base_url: "https://probe.invalid",
          api_key_ref: "inline:x",
          display_name: "probe",
          models: [
            {
              id: "m",
              context_window: 4096,
              max_output: 64,
              supports_vision: true,
              supports_tools: false,
              cost_per_1k_input: 0,
              cost_per_1k_output: 0,
            },
          ],
        }) as { chat?: (o: unknown) => Promise<unknown> };
        if (typeof provider.chat !== "function")
          return fail("Provider chat 入口缺失");

        // 黑盒：拦 fetch 看**线上报文**，不读实现
        let wire: unknown = null;
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (async (
          _url: unknown,
          init?: { body?: unknown },
        ) => {
          wire = JSON.parse(String(init?.body ?? "{}"));
          return {
            ok: true,
            status: 200,
            json: async () => ({
              model: "m",
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: "" },
                  finish_reason: "stop",
                },
              ],
              usage: {
                prompt_tokens: 1,
                completion_tokens: 1,
                total_tokens: 2,
              },
            }),
          };
        }) as unknown as typeof fetch;
        try {
          await provider.chat({
            model: "m",
            max_tokens: 1,
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "image_url",
                    image_url: { url: "data:image/png;base64,AA==" },
                  },
                ],
              },
            ],
          });
        } finally {
          globalThis.fetch = originalFetch;
        }

        const body = wire as { messages?: Array<{ content?: unknown }> } | null;
        const content = body?.messages?.[0]?.content;
        const isBlocks =
          Array.isArray(content) &&
          content.some(
            (c) => (c as { type?: string } | null)?.type === "image_url",
          );
        return isBlocks
          ? pass("内容块原样进入 wire payload（image_url 数组）")
          : fail(
              `内容块被字符串化/丢弃（wire content=${JSON.stringify(content)?.slice(0, 80)}）—— 无原生多模态通路`,
            );
      },
    ),
    "MM-DECL-SIGHTUSE": probe(
      "Tools（多模态）",
      "设计 §4.10 / 用户裁定（2026-10-14）：文本主模型可经**视觉工具 SightUse** 处理图像，图像经工具层返回。" +
        "**假设接口**：注册表中存在 `SightUse`（入参必填 image/prompt，SAFE）；缺失即红（缺口复现）。",
      async () => {
        const mod = await load(
          "MM-DECL-SIGHTUSE",
          "../../Src/Tools/Registry/toolRegistry.js",
        );
        const getTool = needFn(mod, "MM-DECL-SIGHTUSE", "getTool");
        const t = (await getTool("SightUse")) as
          | {
              spec?: {
                name?: string;
                dangerLevel?: string;
                inputSchema?: { required?: string[] };
              };
            }
          | undefined;
        if (!t) {
          return fail(
            "视觉工具 SightUse 未实现（假设落点：Tools/Builtin/Multimodal/sightUse.ts）",
          );
        }
        const required = t.spec?.inputSchema?.required ?? [];
        if (!required.includes("image") || !required.includes("prompt")) {
          return fail("SightUse 入参未声明 image/prompt 为必填");
        }
        if (t.spec?.dangerLevel !== "SAFE") {
          return fail(
            `SightUse 危险级应为 SAFE（实际 ${String(t.spec?.dangerLevel)}）`,
          );
        }
        return pass(
          "视觉工具 SightUse 已注册且契约完整（image/prompt 必填，SAFE）",
        );
      },
    ),
  };
}
