/**
 * FE-058 / FE-059 / FE-065 / FE-067 / FE-068 真实调用验证脚本
 *
 * 运行：npx tsx .verify/verify-fe058-fe068.mjs
 * 前置：环境变量 HUAWEI_MAAS_API_KEY 已设置。
 *
 * 轮次设计：
 *  R1 记忆检索真实链路：写入记忆 → vector.search 工具命中（文本打分，恒空桩已修）
 *  R2 Loop 真实调用：executeLoop 真实模型 → 成功退出 → 知识沉淀（GW+长期记忆）+ 经济记账（钱包扣费）
 *  R3 沉淀可检索闭环：R2 沉淀的记忆可被 vector.search 检索到
 *  R4 web.search 诚实失败：未配置搜索服务 → NOT_ENABLED（不再伪造“成功空结果”）
 */

import { resolve, join } from 'node:path';
import { existsSync, rmSync, mkdirSync } from 'node:fs';

import { loadConfig, getConfigValueOr } from '../Src/Infra/Config/configLoader.js';
import { initLogger, shutdownLogger } from '../Src/Infra/Logging/logger.js';
import { initDatabase, closeDatabase } from '../Src/Infra/Db/database.js';
import { initMigrations, clearMigrations, migrateUp } from '../Src/Infra/Db/migrations.js';
import { OpenAIProvider } from '../Src/Infra/Llm/Provider/openaiProvider.js';
import { registerProvider, setRoutingConfig, getRoutingConfig } from '../Src/Infra/Llm/Router/modelRouter.js';
import { initEventBus, resetEventBus, getEventLog } from '../Src/Services/EventBus/eventBus.js';
import { EventType } from '../Src/Services/EventBus/eventTypes.js';
import {
  initWalletManager, createWallet, getWallet, resetWalletManager,
} from '../Src/Services/TokenEconomy/walletManager.js';
import {
  initTaxCollector, resetTaxCollector,
} from '../Src/Services/TokenEconomy/taxCollector.js';
import { registerPricing, clearConsumptionRecords } from '../Src/Services/TokenEconomy/consumptionRecorder.js';
import { initDualBudget, resetDualBudget } from '../Src/Services/TokenEconomy/dualBudget.js';
import { setActiveOwner, LOCAL_OWNER } from '../Src/Services/AccountScope/activeAccount.js';
import {
  resetLongTermMemory, listAllMemories, writeMemory,
} from '../Src/Services/SharedMemory/longTermMemory.js';
import { resetGlobalWorkspace, read as readWorkspace } from '../Src/Services/SharedMemory/globalWorkspace.js';
import { resetMemoryEmbeddings } from '../Src/Services/SharedMemory/memoryEmbeddings.js';
import { executeLoop } from '../Src/Core/Loop/runIteration.js';
import { createLoopState } from '../Src/Core/Loop/loopEngine.js';
import { createLoopConfig } from '../Src/Core/Loop/loopConfig.js';
import { clearMiddlewares } from '../Src/Core/Middleware/middlewareRegistry.js';
import { resetAgentRegistry } from '../Src/Core/AgentRuntime/agentRegistry.js';
import { resetRolePrompts } from '../Src/Services/Prompts/promptRegistry.js';

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

// ── 环境与装配 ─────────────────────────────────────────────────────

try { process.loadEnvFile?.(resolve('.env')); } catch { /* 依赖外部环境变量 */ }
if (!process.env.HUAWEI_MAAS_API_KEY) fatal('HUAWEI_MAAS_API_KEY 未设置，无法进行真实调用验证');

const DIR = resolve('.verify/_fe058_fe068_data');
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
initEventBus({ maxQueueSize: 10000 });
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
resetLongTermMemory();
resetGlobalWorkspace();
resetMemoryEmbeddings();
clearMiddlewares();
resetRolePrompts();
resetAgentRegistry();

// Provider + 路由 + 定价（与 main.ts 同口径）
const providersRaw = getConfigValueOr(config, 'providers', []);
let providerCount = 0;
const registeredModels = [];
for (const pc of Array.isArray(providersRaw) ? providersRaw : []) {
  try {
    registerProvider(new OpenAIProvider({
      provider: pc['provider'],
      base_url: pc['base_url'],
      api_key_ref: pc['api_key_ref'],
      display_name: pc['display_name'],
      models: pc['models'] ?? [],
    }));
    providerCount++;
    for (const m of pc['models'] ?? []) {
      registeredModels.push({ provider: pc['provider'], model: m });
      registerPricing({
        provider: pc['provider'],
        modelId: m['id'],
        costPer1kInput: m['cost_per_1k_input'] ?? 0,
        costPer1kOutput: m['cost_per_1k_output'] ?? 0,
        contextWindow: m['context_window'] ?? 0,
      });
    }
  } catch { /* skip */ }
}
const routingRaw = getConfigValueOr(config, 'routing', {});
setRoutingConfig({
  defaultModel: routingRaw['defaultModel'] ?? '',
  directorModel: routingRaw['directorModel'] ?? '',
  workerModel: routingRaw['workerModel'] ?? '',
  verifierModel: routingRaw['verifierModel'] ?? '',
  arbitrationModels: routingRaw['arbitrationModels'] ?? [],
  fallbackOrder: routingRaw['fallbackOrder'] ?? [],
  timeoutMs: routingRaw['timeoutMs'] ?? 60000,
  firstByteTimeoutMs: routingRaw['firstByteTimeoutMs'] ?? 10000,
  interChunkTimeoutMs: routingRaw['interChunkTimeoutMs'] ?? 15000,
});
if (providerCount === 0) fatal('无可用 LLM Provider');

const routing = getRoutingConfig();
const MODEL = routing.workerModel || routing.defaultModel;
console.log('══════════════════════════════════════════════════════');
console.log('  FE-058/059/065/067/068 真实调用验证');
console.log(`  workerModel=${MODEL}`);
console.log(`  registeredModels=${registeredModels.map(r => `${r.provider}/${r.model.id}`).join(', ')}`);
console.log('══════════════════════════════════════════════════════');

const { vectorSearch } = await import('../Src/Tools/Builtin/Search/vectorSearch.js');
const { webSearch } = await import('../Src/Tools/Builtin/Search/webSearch.js');

// 分层修正（2026-10-04）：vector.search 经端口注入检索器（Tools 不可直连 Services）
const { configureToolServicePorts } = await import('../Src/Tools/Registry/toolServicePorts.js');
const { createMemoryRetriever } = await import('../Src/Services/Retrieval/retriever.js');
configureToolServicePorts({ memoryRetrieverFactory: createMemoryRetriever });

const toolCtx = {
  operationId: 'op-verify-p2',
  agentId: 'agent-verify-p2',
  agentRole: 'worker',
  loopId: 'loop-verify-p2',
  traceId: 'trace-verify-p2',
};

// ── R1：记忆检索真实链路 ────────────────────────────────────────────

async function round1() {
  console.log('\n──────── R1 记忆检索（vector.search 实装）────────');
  writeMemory({
    title: '幂等性设计规范',
    content: '幂等性指同一操作执行多次与一次的效果一致：写接口以 idempotencyKey 去重，网络重试安全。',
    category: 'rule',
    sourceTraceIds: ['trace-seed-1'],
  });
  writeMemory({
    title: '深色主题配色',
    content: '界面使用深色主题：背景 #0D1117，主色 #1F6FEB，卡片圆角 8px。',
    category: 'rule',
    sourceTraceIds: ['trace-seed-2'],
  });

  const result = await vectorSearch.execute({ query: '幂等性 idempotencyKey', topK: 3 }, toolCtx);
  if (result.status !== 'success') return record('R1 vector.search 执行', false, JSON.stringify(result.error));
  const payload = JSON.parse(String(result.content));
  console.log(`       命中 ${payload.count} 条；首条得分 ${payload.results[0]?.score}`);
  console.log(`       首条内容（前 80 字）: ${String(payload.results[0]?.content ?? '').slice(0, 80)}`);

  record('R1 检索命中目标记忆（恒空桩已修）',
    payload.count >= 1 && String(payload.results[0]?.content ?? '').includes('幂等'),
    `count=${payload.count}`);
  record('R1 无关记忆未被召回', !payload.results.some(r => String(r.content).includes('深色主题')),
    `contents=${payload.results.map(r => String(r.content).slice(0, 20)).join(' | ')}`);
}

// ── R2：Loop 真实调用 + 沉淀 + 记账 ─────────────────────────────────

async function round2() {
  console.log('\n──────── R2 真实主循环（沉淀 + 经济记账）────────');
  const AGENT = 'agent-verify-loop';
  const TRACE = 'trace-verify-loop';
  createWallet(AGENT, TRACE);
  const balanceBefore = getWallet(AGENT)?.balance ?? 0;
  const memoriesBefore = listAllMemories().length;

  const configResult = createLoopConfig({ model: MODEL, stream: true });
  if (!configResult.ok) return record('R2 Loop 配置', false, configResult.error);

  const loopState = createLoopState({
    loopId: 'loop-verify-r2',
    agentId: AGENT,
    traceId: TRACE,
    config: configResult.value,
  });

  const result = await executeLoop(loopState, {
    userInput: '请用不少于 80 个字的中文解释“幂等性”及其在接口设计中的应用。',
    sessionId: 'sess-verify-r2',
    agentId: AGENT,
    agentRole: 'worker',
    config: configResult.value,
    chatMessages: [{ role: 'user', content: '请用不少于 80 个字的中文解释“幂等性”及其在接口设计中的应用。' }],
    recentCallTimestamps: [],
  });

  if (!result.ok) return record('R2 主循环执行（真实模型）', false, result.error);

  const out = result.value.iterations[result.value.iterations.length - 1]?.outputText ?? '';
  console.log(`       退出: ${result.value.exitReason} | tokens=${result.value.totalTokensConsumed}`);
  console.log(`       输出（前 100 字）: ${out.slice(0, 100)}`);

  record('R2 主循环真实执行成功', out.length > 0 && result.value.exitReason === 'success',
    `exitReason=${result.value.exitReason} output.length=${out.length}`);

  // 沉淀：GW 观察 + 长期记忆
  const wsEntries = readWorkspace({ traceId: TRACE, assertion: 'observed', status: 'active' });
  const memoriesAfter = listAllMemories().length;
  console.log(`       沉淀: GW 条目=${wsEntries.length} | 长期记忆 ${memoriesBefore} → ${memoriesAfter}`);
  record('R2 知识沉淀（GW + 长期记忆）', wsEntries.length >= 1 && memoriesAfter > memoriesBefore,
    `ws=${wsEntries.length} memories=${memoriesAfter}`);

  // 经济记账：钱包扣费 + TOKEN_CONSUMED
  const balanceAfter = getWallet(AGENT)?.balance ?? 0;
  const consumedEvents = getEventLog({ eventType: EventType.TOKEN_CONSUMED });
  console.log(`       记账: 余额 ${balanceBefore} → ${balanceAfter} | TOKEN_CONSUMED=${consumedEvents.length}`);
  record('R2 经济记账（钱包扣费 + 事件）', balanceAfter < balanceBefore && consumedEvents.length >= 1,
    `deducted=${balanceBefore - balanceAfter} events=${consumedEvents.length}`);
}

// ── R3：沉淀可检索闭环 ──────────────────────────────────────────────

async function round3() {
  console.log('\n──────── R3 沉淀可检索（闭环）────────');
  const result = await vectorSearch.execute({ query: '幂等性 接口设计', topK: 5 }, toolCtx);
  if (result.status !== 'success') return record('R3 检索执行', false, JSON.stringify(result.error));
  const payload = JSON.parse(String(result.content));
  console.log(`       命中 ${payload.count} 条；条目来源: ${payload.results.map(r => r.source).join(', ')}`);

  // R2 沉淀的 loop-completion 观察已被提炼为长期记忆（title 含 contentType:status 前缀或内容含“幂等”）
  const hitLoopMemory = payload.results.some(r =>
    String(r.content).includes('幂等') && String(r.category) === 'fact',
  );
  record('R3 检索可命中沉淀链路产生的记忆', hitLoopMemory,
    `results=${payload.results.length}`);
}

// ── R4：web.search 诚实失败 ─────────────────────────────────────────

async function round4() {
  console.log('\n──────── R4 web.search 诚实失败（无配置环境）────────');
  const hasKey = !!(process.env.CIVITAS_WEB_SEARCH_API_KEY ?? process.env.SERPER_API_KEY);
  const result = await webSearch.execute({ query: 'Civitas-AI' }, toolCtx);

  if (hasKey) {
    // 环境配置了搜索服务：断言真实调用成功或明确的失败（不伪造）
    const ok = result.status === 'success';
    record('R4 web.search 真实调用（环境已配置）', ok,
      ok ? `count=${JSON.parse(String(result.content)).count}` : `error=${JSON.stringify(result.error)}`);
    return;
  }

  console.log(`       未配置搜索服务 → code=${result.error?.code}`);
  record('R4 未配置 → NOT_ENABLED（不伪造成功空结果）',
    result.status === 'error' && result.error?.code === 'NOT_ENABLED',
    `code=${result.error?.code}`);
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

closeDatabase();
await shutdownLogger();
rmSync(DIR, { recursive: true, force: true });

process.exit(failed.length === 0 ? 0 : 1);
