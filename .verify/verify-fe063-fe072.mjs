/**
 * FE-063 / FE-064 / FE-066 / FE-069 ~ FE-072 真实调用验证脚本
 *
 * 运行：npx tsx .verify/verify-fe063-fe072.mjs
 * 前置：环境变量 HUAWEI_MAAS_API_KEY 已设置。
 *
 * 轮次设计：
 *  R1 装配验证：提示词角色 + 系统资产 + Skills 资产真实装载（⑩/⑩.2 链路）
 *  R2 三轮真实 Agent 调用（FE-072 执行入口）：recruit → executor 驱动（worker ×2 + assembly_node ×1）
 *  R3 工具结果缓存真实命中（FE-064）：file.read 同参二次命中 + 写操作后失效
 *  R4 运维面（FE-069）：trace 索引真实生成
 *  R5 密钥预检（FE-066）：keyStore 注册与解析
 */

import { resolve, join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import { loadConfig, getConfigValueOr } from '../Src/Infra/Config/configLoader.js';
import { initLogger, shutdownLogger } from '../Src/Infra/Logging/logger.js';
import { initDatabase, closeDatabase } from '../Src/Infra/Db/database.js';
import { initMigrations, clearMigrations, migrateUp } from '../Src/Infra/Db/migrations.js';
import { OpenAIProvider } from '../Src/Infra/Llm/Provider/openaiProvider.js';
import { registerProvider, setRoutingConfig, getRoutingConfig } from '../Src/Infra/Llm/Router/modelRouter.js';
import { initEventBus, resetEventBus } from '../Src/Services/EventBus/eventBus.js';
import { setActiveOwner, LOCAL_OWNER } from '../Src/Services/AccountScope/activeAccount.js';
import { scanAndRegisterRefs, resolveSingleRef } from '../Src/Infra/Security/keyStore.js';
import { initPathGuard } from '../Src/Infra/Security/pathGuard.js';
import { loadRolePrompts, loadSystemAssets, getLoadedRoles } from '../Src/Services/Prompts/promptRegistry.js';
import { loadSkillsAssets } from '../Src/Services/Prompts/skillsAssets.js';
import { agentRecruiter } from '../Src/Tools/Custom/agentRecruiter.js';
import { executeAssignedTask } from '../Src/Core/AgentRuntime/agentExecutor.js';
import { getAgent, resetAgentRegistry } from '../Src/Core/AgentRuntime/agentRegistry.js';
import { resetAgentFactory } from '../Src/Core/AgentRuntime/agentFactory.js';
import {
  initWalletManager, resetWalletManager, getWallet,
} from '../Src/Services/TokenEconomy/walletManager.js';
import { registerPricing, clearConsumptionRecords } from '../Src/Services/TokenEconomy/consumptionRecorder.js';
import { initTaxCollector, resetTaxCollector } from '../Src/Services/TokenEconomy/taxCollector.js';
import { initDualBudget, resetDualBudget } from '../Src/Services/TokenEconomy/dualBudget.js';
import { registerBuiltinTools } from '../Src/Tools/index.js';
import { clearRegistry } from '../Src/Tools/Registry/toolRegistry.js';
import { dispatchToolCall } from '../Src/Tools/Registry/toolDispatcher.js';
import {
  initToolResultCache, clearToolResultCache, getToolResultCacheStats,
  getCachedToolResult, cacheToolResult,
} from '../Src/Services/Cache/toolResultCache.js';
import { writeTraceIndex, buildTraceIndex } from '../Src/Interface/EventStore/traceIndex.js';
import { configureToolServicePorts } from '../Src/Tools/Registry/toolServicePorts.js';
import { dispatchHook } from '../Src/Services/Hook/hookRegistry.js';
import { replaceTodos, listTodosForAgent, MAX_TODOS_PER_AGENT } from '../Src/Services/Planning/todoStore.js';
import { createMemoryRetriever } from '../Src/Services/Retrieval/retriever.js';
import { recruitAgent, getRecruitedAgents } from '../Src/Services/Recruitment/recruiter.js';
import { submitForReview as submitReviewRuntime } from '../Src/Core/AgentRuntime/agentRuntime.js';
import { ensureReviewerAgent, performReview, configureReviewer } from '../Src/Services/ReviewerAgent/reviewerAgent.js';
import { markSubtaskReviewed } from '../Src/Core/Decision/orchestrator/subtaskDispatcher.js';
import { callModel } from '../Src/Core/Model/modelCaller.js';
import { clearMiddlewares } from '../Src/Core/Middleware/middlewareRegistry.js';
import { getSkillsDir, getPromptsDir } from '../Src/Infra/Fs/pathResolver.js';

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

const DIR = resolve('.verify/_fe063_fe072_data');
rmSync(DIR, { recursive: true, force: true });
mkdirSync(join(DIR, 'logs'), { recursive: true });
mkdirSync(join(DIR, 'work'), { recursive: true });

const cfgResult = loadConfig();
if (!cfgResult.ok) fatal(`配置加载失败: ${cfgResult.error}`);
const config = cfgResult.value;
initLogger({ logDir: join(DIR, 'logs'), level: 'warn' });

const dbResult = initDatabase({
  mainPath: join(DIR, 'main.db'), eventsPath: join(DIR, 'events.db'), memoryPath: join(DIR, 'memory.db'),
  walMode: true, busyTimeoutMs: 5000,
});
if (!dbResult.ok) fatal(`数据库初始化失败: ${dbResult.error}`);
initMigrations();
if (!migrateUp().ok) fatal('迁移失败');
setActiveOwner(LOCAL_OWNER);

resetEventBus();
initEventBus();
resetWalletManager();
initWalletManager({ initialSupply: 1_000_000, defaultWalletBalance: 10_000 });
resetTaxCollector();
initTaxCollector({
  baseRate: 0.05, dynamicEnabled: false, adjustmentIntervalSec: 300,
  maxRate: 0.2, minRate: 0.02, highLoadMultiplier: 1.5, lowLoadDiscount: 0.8, loadThresholdAgents: 10,
});
resetDualBudget();
initDualBudget({ tokenBudget: 100_000, warmRatio: 0.36, softRatio: 0.6, expandRequestRatio: 0.8, hardRatio: 1.0 });
clearConsumptionRecords();
resetAgentRegistry();
resetAgentFactory();
clearMiddlewares();
clearRegistry();
initToolResultCache();
clearToolResultCache();
initPathGuard({ projectRoot: resolve('.'), forbiddenPaths: [], allowedRoots: [resolve('.'), DIR] });

const providersRaw = getConfigValueOr(config, 'providers', []);
let providerCount = 0;
for (const pc of Array.isArray(providersRaw) ? providersRaw : []) {
  try {
    registerProvider(new OpenAIProvider({
      provider: pc['provider'], base_url: pc['base_url'], api_key_ref: pc['api_key_ref'],
      display_name: pc['display_name'], models: pc['models'] ?? [],
    }));
    providerCount++;
    for (const m of pc['models'] ?? []) {
      registerPricing({
        provider: pc['provider'], modelId: m['id'],
        costPer1kInput: m['cost_per_1k_input'] ?? 0, costPer1kOutput: m['cost_per_1k_output'] ?? 0,
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
if (providerCount === 0) fatal('无可用 LLM Provider');
const MODEL = getRoutingConfig().workerModel || getRoutingConfig().defaultModel;

registerBuiltinTools();

// 工具服务端口注入（与 main.ts ⑫.6 同构：Tools 层不可 import Services/Core，实现由组合根注入）
configureToolServicePorts({
  toolResultCache: { get: getCachedToolResult, put: cacheToolResult, clear: clearToolResultCache },
  dispatchHook: (event, data) => dispatchHook(event, data),
  todoStore: { maxTodos: MAX_TODOS_PER_AGENT, replaceTodos, listTodosForAgent },
  memoryRetrieverFactory: createMemoryRetriever,
  recruitment: { getRecruitedAgents, recruitAgent },
  review: { submitForReview: submitReviewRuntime, ensureReviewerAgent, performReview, markSubtaskReviewed },
});

// L3 Judge 调用器注入（与 main.ts ⑮.1 同构：Services 不可直连 Core/Model）
configureReviewer({
  callModelFn: async (model, prompt) => {
    const r = await callModel(model, [{ role: 'user', content: prompt }], { temperature: 0 });
    if (!r.ok) throw new Error(typeof r.error === 'string' ? r.error : JSON.stringify(r.error));
    return r.value.content;
  },
});

console.log('══════════════════════════════════════════════════════');
console.log('  FE-063/064/066/069~072 真实调用验证');
console.log(`  workerModel=${MODEL}`);
console.log('══════════════════════════════════════════════════════');

const recruitCtx = {
  operationId: 'op-verify-p4',
  agentId: 'agent-verify-parent',
  agentRole: 'prime_director',
  loopId: 'loop-verify-p4',
  traceId: 'trace-verify-p4',
};

// ── R1：装配验证（提示词 + 资产装载链路）────────────────────────────

function round1() {
  console.log('\n──────── R1 装配验证（⑩ 提示词 / ⑩.2 Skills）────────');
  const roleCount = loadRolePrompts(getPromptsDir());
  const assets = loadSystemAssets(getPromptsDir());
  const skills = loadSkillsAssets(getSkillsDir());

  console.log(`       角色=${roleCount}（${getLoadedRoles().length} 装载）| 资产 v${assets.version} | playbooks=${skills.playbooks} strategies=${skills.strategies} rubric=${skills.rubricLoaded}`);
  record('R1 提示词与 Skills 资产真实装载',
    roleCount >= 8 && assets.version === '1.0.0' && skills.rubricLoaded && skills.playbooks >= 1,
    `roles=${roleCount} manifest=${assets.version}`);
}

// ── R2：三轮真实 Agent 调用（recruit → executor）────────────────────

async function round2() {
  console.log('\n──────── R2 真实 Agent 执行入口（三轮）────────');

  // [2a] 招募 worker（dispatch=manual）
  const recruited = await agentRecruiter.execute(
    { role: 'worker', task: `用一句话说明什么是幂等性（模型=${MODEL}）`, tokenBudget: 50_000, maxIterations: 2 },
    recruitCtx,
  );
  if (recruited.status !== 'success') return record('R2a 招募', false, JSON.stringify(recruited.error));
  const payload = JSON.parse(String(recruited.content));
  console.log(`       招募: agentId=${payload.agentId} dispatch=${payload.dispatch}`);
  record('R2a recruit 如实标注 dispatch=manual', payload.dispatch === 'manual', `hint=${String(payload.hint).slice(0, 60)}`);

  const workerId = payload.agentId;
  const balanceBefore = getWallet(workerId)?.balance ?? 0;

  // [2b] 真实执行 ①（worker，playbook 注入生效前提下）
  const exec1 = await executeAssignedTask({ agentId: workerId, instruction: '用一句话（30 字内）说明什么是幂等性。', maxIterations: 2 });
  if (!exec1.ok) return record('R2b 第一轮执行', false, exec1.error);
  console.log(`       ① exit=${exec1.value.exitReason} tokens=${exec1.value.tokensConsumed} out=${exec1.value.output.slice(0, 60)}`);
  record('R2b 真实执行 ①（worker）', exec1.value.exitReason === 'success' && exec1.value.output.length > 0,
    `tokens=${exec1.value.tokensConsumed}`);

  // [2c] 真实执行 ②（worker 连续任务）
  const exec2 = await executeAssignedTask({ agentId: workerId, instruction: '用一句话（30 字内）说明什么是幂等键（idempotency key）。', maxIterations: 2 });
  if (!exec2.ok) return record('R2c 第二轮执行', false, exec2.error);
  const balanceAfter = getWallet(workerId)?.balance ?? 0;
  console.log(`       ② exit=${exec2.value.exitReason} tokens=${exec2.value.tokensConsumed} 余额 ${balanceBefore}→${balanceAfter}`);
  record('R2c 真实执行 ②（worker）+ 经济记账', exec2.value.exitReason === 'success' && balanceAfter < balanceBefore,
    `deducted=${balanceBefore - balanceAfter}`);

  // [2d] 真实执行 ③（assembly_node，playbook 覆盖角色）
  const node = await agentRecruiter.execute(
    { role: 'assembly_node', task: '用一句话说明组装节点职责', maxIterations: 2 },
    { ...recruitCtx, traceId: 'trace-verify-p4b' },
  );
  if (node.status !== 'success') return record('R2d 招募 assembly_node', false, JSON.stringify(node.error));
  const nodeId = JSON.parse(String(node.content)).agentId;
  const exec3 = await executeAssignedTask({ agentId: nodeId, instruction: '用一句话（30 字内）说明你的角色职责。', maxIterations: 2 });
  if (!exec3.ok) return record('R2d 第三轮执行', false, exec3.error);
  console.log(`       ③ exit=${exec3.value.exitReason} tokens=${exec3.value.tokensConsumed} out=${exec3.value.output.slice(0, 60)}`);
  record('R2d 真实执行 ③（assembly_node）', exec3.value.exitReason === 'success' && exec3.value.output.length > 0,
    `tokens=${exec3.value.tokensConsumed}`);

  // 状态核查：执行后 agent 处于 running（等待评审/后续驱动）
  record('R2e Agent 状态驱动（ready→running）', getAgent(workerId)?.status === 'running', `status=${getAgent(workerId)?.status}`);
}

// ── R3：工具结果缓存真实命中 ────────────────────────────────────────

async function round3() {
  console.log('\n──────── R3 工具结果缓存（真实派发）────────');
  const file = join(DIR, 'work', 'cache-probe.txt');
  writeFileSync(file, 'cache-probe-content-v1');

  const ctx = {
    operationId: 'op-cache', agentId: 'agent-verify-parent', agentRole: 'prime_director',
    loopId: 'loop-cache', traceId: 'trace-cache',
  };
  const read1 = await dispatchToolCall({ toolName: 'file.read', arguments: { path: file }, context: ctx });
  const read2 = await dispatchToolCall({ toolName: 'file.read', arguments: { path: file }, context: ctx });
  record('R3 二次同参读取命中缓存（结果一致 + 缓存条目存在）',
    read1.result.status === 'success' && read2.result.status === 'success'
      && String(read1.text) === String(read2.text) && getToolResultCacheStats().size === 1,
    `size=${getToolResultCacheStats().size}`);

  // 写操作 → 缓存保守清空
  const write = await dispatchToolCall({
    toolName: 'file.write', arguments: { path: file, content: 'cache-probe-content-v2' }, context: ctx,
  });
  record('R3 写操作后读缓存失效（防脏读）',
    write.result.status === 'success' && getToolResultCacheStats().size === 0,
    `size=${getToolResultCacheStats().size}`);
}

// ── R4：trace 索引真实生成 ──────────────────────────────────────────

async function round4() {
  console.log('\n──────── R4 运维面（trace 索引）────────');
  const indexResult = writeTraceIndex(join(DIR, 'logs'));
  const ok = indexResult.ok && existsSync(indexResult.value);
  let traceCount = 0;
  if (ok) {
    const parsed = JSON.parse(readFileSync(indexResult.value, 'utf-8'));
    traceCount = parsed.traceCount ?? 0;
  }
  console.log(`       索引文件: ${ok ? indexResult.value : indexResult.error} traces=${traceCount}`);
  record('R4 trace 索引真实落盘', ok && traceCount >= 1, `traces=${traceCount}`);
}

// ── R5：密钥预检 ────────────────────────────────────────────────────

async function round5() {
  console.log('\n──────── R5 密钥预检（keyStore）────────');
  scanAndRegisterRefs({ providers: Array.isArray(getConfigValueOr(config, 'providers', [])) ? getConfigValueOr(config, 'providers', []) : [] });
  const probe = resolveSingleRef('env:HUAWEI_MAAS_API_KEY');
  console.log(`       env:HUAWEI_MAAS_API_KEY → ${probe.ok ? 'OK' : probe.error}`);
  record('R5 密钥引用可解析（预检链路）', probe.ok, probe.ok ? `envVar=${probe.value.envVar}` : probe.error);
}

// ── 主流程 ──────────────────────────────────────────────────────────

try {
  round1();
  await round2();
  await round3();
  await round4();
  await round5();
} catch (e) {
  record('验证流程异常', false, e instanceof Error ? e.message : String(e));
}

const failed = results.filter(r => !r.pass);
console.log('\n══════════════════════════════════════════════════════');
console.log(`  验证结果: ${results.length - failed.length}/${results.length} PASS`);
for (const f of failed) console.log(`  - FAIL: ${f.name}`);
console.log('══════════════════════════════════════════════════════');

closeDatabase();
clearMigrations();
await shutdownLogger();
rmSync(DIR, { recursive: true, force: true });

process.exit(failed.length === 0 ? 0 : 1);
