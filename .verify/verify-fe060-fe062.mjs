/**
 * FE-060 / FE-061 / FE-062 真实调用验证脚本
 *
 * 运行：npx tsx .verify/verify-fe060-fe062.mjs
 * 前置：环境变量 HUAWEI_MAAS_API_KEY 已设置。
 *
 * 轮次设计：
 *  R1 监管域 HTTP：添加 tool.forbid 规则（立法）→ 查询行为准则
 *  R2 行为法典真实执行：真实 LLM Agent 尝试调用 shell.exec → 安全门被法典阻断（含规则依据）
 *  R3 审计域 HTTP：冻结 → 状态查询 → 手动巡检 → 解冻
 *  R4 仲裁域 HTTP：手动驱动六步闭环 → 案件完成 + new_wins → 恢复计划可查
 */

import { resolve, join } from 'node:path';
import { existsSync, rmSync, mkdirSync } from 'node:fs';

import { loadConfig, getConfigValueOr } from '../Src/Infra/Config/configLoader.js';
import { initLogger, shutdownLogger } from '../Src/Infra/Logging/logger.js';
import { initDatabase, closeDatabase } from '../Src/Infra/Db/database.js';
import { initMigrations, clearMigrations, migrateUp } from '../Src/Infra/Db/migrations.js';
import { OpenAIProvider } from '../Src/Infra/Llm/Provider/openaiProvider.js';
import { registerProvider, setRoutingConfig, getRoutingConfig } from '../Src/Infra/Llm/Router/modelRouter.js';
import { initEventBus, resetEventBus } from '../Src/Services/EventBus/eventBus.js';
import { registerAllRoutes } from '../Src/Interface/WebServer/routes.js';
import { startHttpServer, stopHttpServer } from '../Src/Interface/WebServer/httpServer.js';
import { setActiveOwner, LOCAL_OWNER } from '../Src/Services/AccountScope/activeAccount.js';
import { initRegulatoryAuthority } from '../Src/Services/Regulation/regulatoryAuthority.js';
import {
  initWalletManager, resetWalletManager, createWallet,
} from '../Src/Services/TokenEconomy/walletManager.js';
import { registerPricing, clearConsumptionRecords } from '../Src/Services/TokenEconomy/consumptionRecorder.js';
import { initTaxCollector, resetTaxCollector } from '../Src/Services/TokenEconomy/taxCollector.js';
import { initDualBudget, resetDualBudget } from '../Src/Services/TokenEconomy/dualBudget.js';
import { registerBuiltinTools } from '../Src/Tools/index.js';
import { clearRegistry } from '../Src/Tools/Registry/toolRegistry.js';
import { executeLoop } from '../Src/Core/Loop/runIteration.js';
import { createLoopState } from '../Src/Core/Loop/loopEngine.js';
import { createLoopConfig } from '../Src/Core/Loop/loopConfig.js';
import { clearMiddlewares } from '../Src/Core/Middleware/middlewareRegistry.js';
import { resetAgentRegistry } from '../Src/Core/AgentRuntime/agentRegistry.js';
import { resetAgentFactory, createAgent } from '../Src/Core/AgentRuntime/agentFactory.js';
import { resetRolePrompts } from '../Src/Services/Prompts/promptRegistry.js';
import { resetTribunal } from '../Src/Services/Arbitration/tribunal.js';
import { resetGlobalWorkspace } from '../Src/Services/SharedMemory/globalWorkspace.js';
import { resetLongTermMemory } from '../Src/Services/SharedMemory/longTermMemory.js';
import { resetFreezeManager, setAutoUnfreezeSec } from '../Src/Services/Audit/freezeManager.js';
import { resetPatrolScheduler } from '../Src/Services/Audit/patrolScheduler.js';
import { resetAnomalyDetector } from '../Src/Services/Audit/anomalyDetector.js';
import { resetResourceAuditBureau } from '../Src/Services/Audit/resourceAuditBureau.js';
import { resetBehaviorCode } from '../Src/Services/Regulation/behaviorCode.js';

// ── 结果收集 ───────────────────────────────────────────────────────

const results = [];
function record(name, pass, evidence) {
  results.push({ name, pass });
  console.log(`\n[${pass ? 'PASS' : 'FAIL'}] ${name}`);
  if (evidence) console.log(`       ${evidence}`);
}
function fatal(msg) {
  console.error(`[FATAL] ${msg}`);
  process.exit(2);
}

// ── 装配 ────────────────────────────────────────────────────────────

try { process.loadEnvFile?.(resolve('.env')); } catch { /* 依赖外部环境变量 */ }
if (!process.env.HUAWEI_MAAS_API_KEY) fatal('HUAWEI_MAAS_API_KEY 未设置');

const DIR = resolve('.verify/_fe060_fe062_data');
const LOG_DIR = join(DIR, 'logs');
rmSync(DIR, { recursive: true, force: true });
mkdirSync(LOG_DIR, { recursive: true });

const cfgResult = loadConfig();
if (!cfgResult.ok) fatal(`配置加载失败: ${cfgResult.error}`);
const config = cfgResult.value;
initLogger({ logDir: LOG_DIR, level: 'warn' });

const dbResult = initDatabase({
  mainPath: join(DIR, 'main.db'),
  eventsPath: join(DIR, 'events.db'),
  memoryPath: join(DIR, 'memory.db'),
  walMode: true,
  busyTimeoutMs: 5000,
});
if (!dbResult.ok) fatal(`数据库初始化失败: ${dbResult.error}`);
initMigrations();
const upResult = migrateUp();
if (!upResult.ok) fatal(`迁移失败: ${upResult.error}`);
setActiveOwner(LOCAL_OWNER);

resetEventBus();
initEventBus();
resetWalletManager();
initWalletManager({ initialSupply: 1_000_000, defaultWalletBalance: 10_000 });
resetTaxCollector();
initTaxCollector({
  baseRate: 0.05, dynamicEnabled: false, adjustmentIntervalSec: 300,
  maxRate: 0.2, minRate: 0.02, highLoadMultiplier: 1.5, lowLoadDiscount: 0.8,
  loadThresholdAgents: 10,
});
resetDualBudget();
initDualBudget({ tokenBudget: 100_000, warmRatio: 0.36, softRatio: 0.6, expandRequestRatio: 0.8, hardRatio: 1.0 });
clearConsumptionRecords();
resetGlobalWorkspace();
resetLongTermMemory();
resetTribunal();
resetFreezeManager();
resetPatrolScheduler();
resetAnomalyDetector();
resetResourceAuditBureau();
resetBehaviorCode();
resetAgentRegistry();
resetAgentFactory();
resetRolePrompts();
clearMiddlewares();
clearRegistry();

// Provider + 路由 + 定价（真实模型，供 R2）
const providersRaw = getConfigValueOr(config, 'providers', []);
for (const pc of Array.isArray(providersRaw) ? providersRaw : []) {
  try {
    registerProvider(new OpenAIProvider({
      provider: pc['provider'], base_url: pc['base_url'], api_key_ref: pc['api_key_ref'],
      display_name: pc['display_name'], models: pc['models'] ?? [],
    }));
    for (const m of pc['models'] ?? []) {
      registerPricing({
        provider: pc['provider'], modelId: m['id'],
        costPer1kInput: m['cost_per_1k_input'] ?? 0,
        costPer1kOutput: m['cost_per_1k_output'] ?? 0,
        contextWindow: m['context_window'] ?? 0,
      });
    }
  } catch { /* skip */ }
}
const routingRaw = getConfigValueOr(config, 'routing', {});
setRoutingConfig({
  defaultModel: routingRaw['defaultModel'] ?? '', directorModel: routingRaw['directorModel'] ?? '',
  workerModel: routingRaw['workerModel'] ?? '', verifierModel: routingRaw['verifierModel'] ?? '',
  arbitrationModels: routingRaw['arbitrationModels'] ?? [], fallbackOrder: routingRaw['fallbackOrder'] ?? [],
  timeoutMs: routingRaw['timeoutMs'] ?? 60000,
  firstByteTimeoutMs: routingRaw['firstByteTimeoutMs'] ?? 10000,
  interChunkTimeoutMs: routingRaw['interChunkTimeoutMs'] ?? 15000,
});
const MODEL = getRoutingConfig().workerModel || getRoutingConfig().defaultModel;

// 监管初始化 + REST 全量注册 + HTTP 服务（127.0.0.1:3865，避免与常规 3000 冲突）
initRegulatoryAuthority();
registerAllRoutes();
const PORT = 3865;
await startHttpServer({ host: '127.0.0.1', port: PORT, corsOrigins: [] });

const BASE = `http://127.0.0.1:${PORT}`;
async function api(method, path, body) {
  const resp = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let payload = null;
  try { payload = await resp.json(); } catch { /* 非 JSON */ }
  return { status: resp.status, payload };
}

console.log('══════════════════════════════════════════════════════');
console.log('  FE-060/061/062 真实调用验证');
console.log(`  HTTP: ${BASE}`);
console.log(`  workerModel=${MODEL}`);
console.log('══════════════════════════════════════════════════════');

const RULE_ID = 'gov-verify-forbid-shell';
/** R2 创建的 Agent（R3 审计用例复用其真实 agentId） */
let verifiedAgentId = '';

// ── R1：监管域 HTTP（立法 + 查询）───────────────────────────────────

async function round1() {
  console.log('\n──────── R1 监管域 HTTP：立法 + 行为准则查询 ────────');
  const created = await api('POST', '/api/regulation/rules', {
    actorRole: 'user',
    rule: {
      ruleId: RULE_ID,
      category: 'safety',
      description: '验证封禁：禁止 shell.exec（行为法典执行演练）',
      condition: 'tool.forbid(shell.exec)',
      action: 'forbid',
      severity: 'critical',
      enforceable: true,
    },
  });
  console.log(`       POST /api/regulation/rules → ${created.status} ${JSON.stringify(created.payload?.data ?? created.payload)?.slice(0, 120)}`);
  record('R1 立法端点（添加 tool.forbid 规则）',
    created.status === 200 && created.payload?.ok === true,
    `status=${created.status}`);

  const code = await api('GET', '/api/regulation/behavior-code');
  const rules = code.payload?.data?.code?.rules ?? [];
  const hit = rules.some(r => r.ruleId === RULE_ID);
  console.log(`       GET /api/regulation/behavior-code → 规则数 ${rules.length}，命中新规则=${hit}`);
  record('R1 行为准则可查（含新规则）', code.status === 200 && hit, `rules=${rules.length}`);

  const denied = await api('POST', '/api/regulation/rules', {
    actorRole: 'worker',
    rule: { ruleId: 'gov-denied', category: 'safety', description: 'x', condition: 'tool.forbid(x)', action: 'forbid', severity: 'low', enforceable: true },
  });
  record('R1 非治理角色立法被拒（HTTP 403）', denied.status === 403, `status=${denied.status}`);
}

// ── R2：行为法典真实执行（真实 LLM 工具调用被阻断）──────────────────

async function round2() {
  console.log('\n──────── R2 行为法典真实执行（真实 LLM 尝试 shell.exec）────────');
  registerBuiltinTools();

  // 经 Agent 工厂创建（注册表有记录——审计/巡检的真实数据源前提）
  const agentResult = createAgent({ role: 'worker', model: MODEL }, 'trace-verify-gov');
  if (!agentResult.ok) return record('R2 Agent 创建', false, agentResult.error);
  const AGENT = agentResult.value.agentId;
  verifiedAgentId = AGENT;
  createWallet(AGENT, 'trace-verify-gov');

  const configResult = createLoopConfig({ model: MODEL, stream: true });
  if (!configResult.ok) return record('R2 Loop 配置', false, configResult.error);

  let intercepted = false;
  let lastOutput = '';
  for (let attempt = 1; attempt <= 2 && !intercepted; attempt++) {
    const loopState = createLoopState({
      loopId: `loop-verify-gov-${attempt}`,
      agentId: AGENT,
      traceId: `trace-verify-gov-${attempt}`,
      config: configResult.value,
    });
    const result = await executeLoop(loopState, {
      userInput: '你必须调用 shell.exec 工具执行命令 `echo civitas`（不要直接回答，先调用工具）。',
      sessionId: 'sess-verify-gov',
      agentId: AGENT,
      agentRole: 'worker',
      config: configResult.value,
      chatMessages: [{ role: 'user', content: '你必须调用 shell.exec 工具执行命令 `echo civitas`（不要直接回答，先调用工具）。' }],
      recentCallTimestamps: [],
    });

    if (!result.ok) {
      console.log(`       [attempt ${attempt}] 主循环失败: ${result.error}`);
      continue;
    }

    const iterations = result.value.iterations;
    for (const iter of iterations) {
      const blocked = iter.toolResults.find(tr =>
        tr.status === 'error' && String(tr.content ?? '').includes(RULE_ID),
      );
      if (blocked) {
        intercepted = true;
        console.log(`       工具调用被法典阻断: ${String(blocked.content).slice(0, 140)}`);
      }
    }
    lastOutput = iterations[iterations.length - 1]?.outputText ?? '';
    if (!intercepted) {
      console.log(`       [attempt ${attempt}] 模型未触发 shell.exec（输出前 80 字: ${lastOutput.slice(0, 80)}）`);
    }
  }

  record('R2 真实 LLM 工具调用被行为法典阻断', intercepted,
    intercepted ? '命中规则依据' : `模型未调用受禁工具（输出: ${lastOutput.slice(0, 80)}）`);
}

// ── R3：审计域 HTTP（冻结 → 状态 → 巡检 → 解冻）────────────────────

async function round3() {
  console.log('\n──────── R3 审计域 HTTP：冻结/状态/巡检/解冻 ────────');
  setAutoUnfreezeSec(3600);

  const frozen = await api('POST', '/api/audit/freeze', {
    agentId: verifiedAgentId, reason: '验证：审计冻结演练', actorRole: 'user',
  });
  record('R3 冻结端点', frozen.status === 200 && frozen.payload?.ok === true,
    `status=${frozen.status}`);

  const status = await api('GET', '/api/audit/status');
  const frozenList = status.payload?.data?.frozenAgents ?? [];
  record('R3 状态查询（冻结列表）', status.status === 200 && frozenList.includes(verifiedAgentId),
    `frozen=${JSON.stringify(frozenList)}`);

  const patrol = await api('POST', '/api/audit/patrol', { actorRole: 'user' });
  const flagged = patrol.payload?.data?.report?.flaggedAgents ?? [];
  console.log(`       POST /api/audit/patrol → totalAgents=${patrol.payload?.data?.report?.totalAgents} flagged=${flagged.length}`);
  record('R3 手动巡检（真实快照出报告）',
    patrol.status === 200 && (patrol.payload?.data?.report?.totalAgents ?? 0) >= 1,
    `totalAgents=${patrol.payload?.data?.report?.totalAgents}`);

  const unfrozen = await api('POST', '/api/audit/unfreeze', {
    agentId: verifiedAgentId, actorRole: 'user',
  });
  record('R3 解冻端点', unfrozen.status === 200 && unfrozen.payload?.ok === true,
    `status=${unfrozen.status}`);

  const denied = await api('POST', '/api/audit/freeze', {
    agentId: 'x', reason: 'y', actorRole: 'worker',
  });
  record('R3 非治理角色冻结被拒（HTTP 403）', denied.status === 403, `status=${denied.status}`);
}

// ── R4：仲裁域 HTTP（手动驱动六步闭环）───────────────────────────────

async function round4() {
  console.log('\n──────── R4 仲裁域 HTTP：手动驱动六步闭环 ────────');
  const created = await api('POST', '/api/arbitration/cases', {
    conflictId: 'verify-conflict-1',
    conflictType: 'semantic_opposition',
    plaintiffAgentId: 'agent-new',
    defendantAgentId: 'agent-old',
    newMemoryContent: '允许访问生产数据库',
    oldMemoryContent: '禁止访问生产数据库',
    taskDescription: '生产库权限策略冲突（HTTP 验证）',
    restorerAgentId: 'agent-new',
  });
  const c = created.payload?.data?.case;
  console.log(`       POST /api/arbitration/cases → ${created.status} case=${c?.caseId} status=${c?.status} verdict=${c?.finalVerdict?.verdict}`);
  record('R4 六步闭环执行完成（completed + 有裁决）',
    created.status === 200 && c?.status === 'completed' && !!c?.finalVerdict,
    `case=${c?.caseId} verdict=${c?.finalVerdict?.verdict}`);

  const restorations = await api('GET', `/api/arbitration/restorations?caseId=${encodeURIComponent(c?.caseId ?? '')}`);
  const plans = restorations.payload?.data?.items ?? [];
  console.log(`       恢复计划: ${plans.length} 条（status=${plans[0]?.status}）`);
  record('R4 恢复计划可查（restorationManager 接线）',
    restorations.status === 200 && plans.length >= 1 && plans[0]?.status === 'completed',
    `plans=${plans.length}`);

  const interventions = await api('GET', '/api/arbitration/interventions');
  record('R4 监管干预查询端点可用', interventions.status === 200, `status=${interventions.status}`);
}

// ── 主流程 ──────────────────────────────────────────────────────────

try {
  await round1();
  await round2();
  await round3();
  await round4();
} catch (e) {
  record('验证流程异常', false, e instanceof Error ? e.message : String(e));
}

const failed = results.filter(r => !r.pass);
console.log('\n══════════════════════════════════════════════════════');
console.log(`  验证结果: ${results.length - failed.length}/${results.length} PASS`);
for (const f of failed) console.log(`  - FAIL: ${f.name}`);
console.log('══════════════════════════════════════════════════════');

await stopHttpServer();
closeDatabase();
clearMigrations();
await shutdownLogger();
rmSync(DIR, { recursive: true, force: true });

process.exit(failed.length === 0 ? 0 : 1);
