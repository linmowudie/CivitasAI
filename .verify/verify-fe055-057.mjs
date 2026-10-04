/**
 * FE-055 / FE-056 / FE-057 真实调用验证脚本（≥3 轮真实 LLM 调用）
 *
 * 运行：npx tsx .verify/verify-fe055-057.mjs
 * 前置：环境变量 HUAWEI_MAAS_API_KEY 已设置（与 realAgent.spec.ts 同一口径）。
 *
 * 轮次设计：
 *  R1 真实评审·合格成果 → 四级管线（L1+L2+L3 真实 Judge）→ 输出判定
 *  R2 真实评审·空泛成果 → L3 Judge 真实判定（期望拒绝；如实报告实际判定）
 *  R3 真实上下文压缩 → 低阈值 + 长历史 + 真实主循环 → CONTEXT_COMPRESSED 事件 + 摘要产出
 *  R4 压缩后连贯性 → 第 2 轮真实迭代（基于压缩后历史）→ 结构证据 + 回答供人工核验
 *
 * 断言口径：机制层硬断言（事件/结构/API 成功/层级运行）；
 * 模型判定内容（通过或拒绝）如实输出，不强行断言模型主观结论。
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
import { initWalletManager } from '../Src/Services/TokenEconomy/walletManager.js';
import { setActiveOwner, LOCAL_OWNER } from '../Src/Services/AccountScope/activeAccount.js';
import { createAgent, resetAgentFactory } from '../Src/Core/AgentRuntime/agentFactory.js';
import { resetAgentRegistry } from '../Src/Core/AgentRuntime/agentRegistry.js';
import { assignTask, submitForReview, isTaskApproved, resetAgentRuntime } from '../Src/Core/AgentRuntime/agentRuntime.js';
import { performReview, configureReviewer, resetReviewer } from '../Src/Services/ReviewerAgent/reviewerAgent.js';
import { callModel } from '../Src/Core/Model/modelCaller.js';
import { createLoopState } from '../Src/Core/Loop/loopEngine.js';
import { createLoopConfig } from '../Src/Core/Loop/loopConfig.js';
import { runIteration } from '../Src/Core/Loop/runIteration.js';
import { configureContextCompression, resetContextCompression } from '../Src/Core/Loop/contextCompression.js';

// ── 测试基础设施 ────────────────────────────────────────────────────

const DIR = resolve('.verify/_fe055_fe057_data');
const LOG_DIR = join(DIR, 'logs');
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

// ── 启动装配（与 main.ts 同口径）────────────────────────────────────

try { process.loadEnvFile?.(resolve('.env')); } catch { /* 无 .env，依赖外部环境变量 */ }

if (!process.env.HUAWEI_MAAS_API_KEY) {
  fatal('HUAWEI_MAAS_API_KEY 未设置，无法进行真实调用验证');
}

// 分层修正（2026-10-04）：L3 Judge 调用器由组合根注入（Services 不可直连 Core/Model）
configureReviewer({
  callModelFn: async (model, prompt) => {
    const r = await callModel(model, [{ role: 'user', content: prompt }], { temperature: 0 });
    if (!r.ok) throw new Error(typeof r.error === 'string' ? r.error : JSON.stringify(r.error));
    return r.value.content;
  },
});

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
resetAgentRegistry();
resetAgentFactory();
resetAgentRuntime();
resetReviewer();
resetContextCompression();
initWalletManager({ initialSupply: 1_000_000, defaultWalletBalance: 10_000 });

// Provider 注册（同 main.ts ⑪）
const providersRaw = getConfigValueOr(config, 'providers', []);
let providerCount = 0;
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
  } catch { /* 注册失败不阻塞 */ }
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
console.log('══════════════════════════════════════════════════════');
console.log('  FE-055/056/057 真实调用验证');
console.log(`  providers=${providerCount}`);
console.log(`  workerModel=${routing.workerModel}`);
console.log(`  verifierModel=${routing.verifierModel}`);
console.log('══════════════════════════════════════════════════════');

const WORKER_MODEL = routing.workerModel || routing.defaultModel;

async function realCall(model, messages, opts, retries = 2) {
  let last = null;
  for (let i = 0; i <= retries; i++) {
    last = await callModel(model, messages, opts);
    if (last.ok) return last;
    console.log(`       [retry ${i + 1}] 真实调用失败: ${last.error}`);
    await new Promise(r => setTimeout(r, 3000 * (i + 1)));
  }
  return last;
}

// ── R1：真实评审·合格成果 ───────────────────────────────────────────

async function round1() {
  console.log('\n──────── R1 真实评审·合格成果 ────────');
  const gen = await realCall(WORKER_MODEL, [
    { role: 'system', content: '你是一名后端工程师。请用简短的中文回答。' },
    { role: 'user', content: '写一个 TypeScript debounce 函数（带类型签名），并附一句用途说明。' },
  ], { max_tokens: 400 });
  if (!gen.ok) return record('R1 成果生成（真实 LLM）', false, gen.error);
  console.log(`       Worker 成果（前 120 字）: ${gen.value.content.slice(0, 120)}...`);

  const worker = createAgent({ role: 'worker', model: WORKER_MODEL }, 'trace-r1');
  const reviewer = createAgent({ role: 'reviewer', model: routing.verifierModel || 'reviewer-model' }, 'trace-r1');
  if (!worker.ok || !reviewer.ok) return record('R1 Agent 创建', false, 'createAgent 失败');

  assignTask(worker.value.agentId, 'task-r1', 'trace-r1');
  submitForReview({
    taskId: 'task-r1',
    workerAgentId: worker.value.agentId,
    payload: { summary: gen.value.content.slice(0, 800), artifacts: ['src/debounce.ts'] },
  });

  const t0 = Date.now();
  const review = await performReview({ taskId: 'task-r1', reviewerAgentId: reviewer.value.agentId });
  const elapsed = Date.now() - t0;
  if (!review.ok) return record('R1 评审执行', false, review.error);

  const comment = review.value.reviewerComment ?? '';
  console.log(`       评审耗时: ${elapsed}ms | 判定: ${review.value.status}`);
  console.log(`       评审意见: ${comment.slice(0, 220)}`);

  const l3Ran = comment.includes('L1+L2+L3');
  record('R1 四级管线运行（L1+L2+L3 真实 Judge）', l3Ran, `comment=${comment.slice(0, 160)}`);
  record('R1 判定与台账状态一致', isTaskApproved('task-r1') === (review.value.status === 'accepted'),
    `isTaskApproved=${isTaskApproved('task-r1')}`);
}

// ── R2：真实评审·空泛成果 ───────────────────────────────────────────

async function round2() {
  console.log('\n──────── R2 真实评审·空泛成果 ────────');
  const worker = createAgent({ role: 'worker', model: WORKER_MODEL }, 'trace-r2');
  const reviewer = createAgent({ role: 'reviewer', model: routing.verifierModel || 'reviewer-model' }, 'trace-r2');
  if (!worker.ok || !reviewer.ok) return record('R2 Agent 创建', false, 'createAgent 失败');

  assignTask(worker.value.agentId, 'task-r2', 'trace-r2');
  submitForReview({
    taskId: 'task-r2',
    workerAgentId: worker.value.agentId,
    payload: { summary: '做完了' }, // 空泛成果：L1/L2 可过（非空），由 L3 真实判定
  });

  const review = await performReview({ taskId: 'task-r2', reviewerAgentId: reviewer.value.agentId });
  if (!review.ok) return record('R2 评审执行', false, review.error);

  const comment = review.value.reviewerComment ?? '';
  console.log(`       判定: ${review.value.status}`);
  console.log(`       评审意见: ${comment.slice(0, 260)}`);

  // L3 运行的标志：通过路径含层级汇总，拒绝路径含失败层 [L3 llm_judge]
  const l3Ran = comment.includes('L1+L2+L3') || comment.includes('[L3 llm_judge]');
  record('R2 L3 真实 Judge 运行', l3Ran, `comment=${comment.slice(0, 160)}`);
  record('R2 判定与台账状态一致', isTaskApproved('task-r2') === (review.value.status === 'accepted'),
    `isTaskApproved=${isTaskApproved('task-r2')}`);
  // 模型主观结论如实输出：期望 rejected，但不作为硬断言
  console.log(`       [信息] 模型对空泛成果的实际判定: ${review.value.status === 'rejected' ? '拒绝（符合预期）' : '通过（模型主观判定，如实报告）'}`);
}

// ── R3：真实上下文压缩 ──────────────────────────────────────────────

async function round3() {
  console.log('\n──────── R3 真实上下文压缩（真实主循环）────────');
  // 低阈值确保触发：历史 4 条 × ~1400 字符 ≈ 1400 tokens，阈值 800 必触发；
  // 真实调用仍有真实摘要（fail-soft 保证不阻断）
  configureContextCompression({ triggerTokens: 800, keepRecentMessages: 2, minMessagesToCompress: 4 });

  const configResult = createLoopConfig({ model: WORKER_MODEL, stream: false });
  if (!configResult.ok) return record('R3 Loop 配置', false, configResult.error);

  const chatMessages = [
    { role: 'user', content: `项目代号「凤凰计划」。需求一：${'整理历史会话内容。'.repeat(150)}` },
    { role: 'assistant', content: `收到。我将开始处理第一步：${'梳理已有信息与约束。'.repeat(150)}` },
    { role: 'user', content: `补充要求：${'所有产物写入 src/ 目录并保持编号。'.repeat(150)}` },
    { role: 'assistant', content: `明白，正在执行。${'已完成初步整理并准备输出。'.repeat(150)}` },
  ];

  // 真实调用可能偶发网络失败：最多尝试 2 次（每次新建 loopState）
  let result = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const loopState = createLoopState({
      loopId: `loop-verify-r3-${attempt}`,
      agentId: 'agent-worker-verify',
      traceId: `trace-verify-r3-${attempt}`,
      config: configResult.value,
    });

    result = await runIteration(loopState, {
      userInput: '请简短确认当前进度（一句话）',
      sessionId: 'sess-verify-r3',
      agentId: 'agent-worker-verify',
      agentRole: 'worker',
      config: configResult.value,
      currentIteration: 1,
      totalTokensConsumed: 0,
      chatMessages,
      recentCallTimestamps: [],
    });

    if (result.ok && result.value.outputText.length > 0) break;
    console.log(`       [retry ${attempt}] 主循环未产出文本（exit=${result.ok ? result.value.decision.exitMessage : result.error}）`);
    await new Promise(r => setTimeout(r, 4000));
  }

  if (!result || !result.ok) return record('R3 主循环执行（真实模型）', false, result ? result.error : 'no result');

  const events = getEventLog({ eventType: EventType.CONTEXT_COMPRESSED });
  const compressed = events.length > 0;
  record('R3 CONTEXT_COMPRESSED 事件发布', compressed, `events=${events.length}`);
  if (compressed) {
    const p = events[0].payload;
    console.log(`       压缩: ${p.messagesBefore} 条 → ${p.messagesAfter} 条 | tokens ${p.tokensBefore} → ${p.tokensAfter} | reanchor=${p.reanchorInjected}`);
  }

  // 压缩回写共享历史（内容断言，避免与初始长度相同的假阳性）：首条为摘要消息
  const writtenBack = chatMessages.length === 4 && chatMessages[0].content.includes('[上下文压缩摘要]');
  record('R3 共享历史原位替换（跨轮生效）', writtenBack,
    `len=${chatMessages.length} first=${chatMessages[0].content.slice(0, 40)}`);
  if (writtenBack) {
    console.log(`       摘要（前 100 字）: ${chatMessages[0].content.slice(0, 100)}...`);
    console.log(`       重锚: ${chatMessages[1].content.slice(0, 80)}`);
  }

  // ⑥ 步模型调用成功（压缩后上下文仍可正常推理）
  record('R3 压缩后真实模型调用成功', result.value.outputText.length > 0,
    `output=${result.value.outputText.slice(0, 100)}`);

  return chatMessages; // 供 R4 复用压缩后的历史
}

// ── R4：压缩后连贯性（第 2 轮真实迭代）────────────────────────────

async function round4(compressedHistory) {
  console.log('\n──────── R4 压缩后连贯性（第 2 轮真实迭代）────────');
  if (!compressedHistory || compressedHistory.length !== 4) {
    return record('R4 前置压缩历史', false, '压缩历史不可用，跳过');
  }

  const configResult = createLoopConfig({ model: WORKER_MODEL, stream: false });
  if (!configResult.ok) return record('R4 Loop 配置', false, configResult.error);

  const chatMessages = [
    ...compressedHistory.map(m => ({ ...m })),
    { role: 'assistant', content: '进度确认：继续推进中。' },
    { role: 'user', content: '基于你掌握的上下文，用一句话说明这个项目与主要约束。' },
  ];

  const loopState = createLoopState({
    loopId: 'loop-verify-r4',
    agentId: 'agent-worker-verify',
    traceId: 'trace-verify-r4',
    config: configResult.value,
  });

  const result = await runIteration(loopState, {
    userInput: '基于你掌握的上下文，用一句话说明这个项目与主要约束。',
    sessionId: 'sess-verify-r4',
    agentId: 'agent-worker-verify',
    agentRole: 'worker',
    config: configResult.value,
    currentIteration: 2,
    totalTokensConsumed: 0,
    chatMessages,
    recentCallTimestamps: [],
  });

  if (!result.ok) return record('R4 第 2 轮迭代（真实模型）', false, result.error);

  const answer = result.value.outputText;
  console.log(`       第 2 轮回答: ${answer.slice(0, 200)}`);

  record('R4 压缩后真实迭代成功', answer.length > 0, `output.length=${answer.length}`);
  // 软证据：回答是否引用（压缩摘要或被保留的历史中的）事实——不硬断言模型措辞
  const mentionsPhoenix = answer.includes('凤凰') || answer.includes('计划');
  console.log(`       [信息] 回答引用上下文事实（凤凰计划/约束）: ${mentionsPhoenix ? '命中' : '未命中（模型主观措辞）'}`);
}

// ── 主流程 ──────────────────────────────────────────────────────────

try {
  await round1();
  await round2();
  const compressedHistory = await round3();
  await round4(compressedHistory);
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
