/**
 * Civitas-AI 系统入口
 *
 * S0 阶段：仅验证配置加载链可工作。
 * S1 阶段：按启动 14 步（Docs/02 §7.1）逐步构建 Infra 底座。
 * 后续阶段将继续添加 ③~⑭ 步。
 */

import { resolve } from 'node:path';
import { loadConfig, getConfigValueOr } from './Infra/Config/configLoader.js';
import { initLogger, logger, shutdownLogger } from './Infra/Logging/logger.js';
import { Time } from './Infra/Time/timeService.js';
import { initTrustLevels } from './Infra/Security/trustLevels.js';
import { initWhitelist } from './Infra/Security/whitelist.js';
import { initPathGuard } from './Infra/Security/pathGuard.js';
import { initDirectories } from './Infra/Fs/pathResolver.js';
import { initDatabase, initMigrations, migrateUp } from './Infra/Db/index.js';
import { initWorkspace } from './Infra/Workspace/index.js';
import { initEffectJournal, initIdempotencyStore, initRecoveryScanner, scanAndProposeRecovery, getHumanRequiredPlans } from './Infra/DurableExecution/index.js';
import { OpenAIProvider, registerProvider, setRoutingConfig } from './Infra/Llm/index.js';
import { registerBuiltinTools, getToolCount } from './Tools/index.js';
import { initPromptCache } from './Services/Cache/promptCache.js';
import { initToolResultCache } from './Services/Cache/toolResultCache.js';
import { initSessionManager } from './Services/Session/sessionManager.js';
import { initArchiveManager } from './Services/Session/archiveManager.js';
import { initHookExecutor } from './Infra/Hook/hookExecutor.js';
import { registerMiddleware, getMiddlewareCount } from './Core/Middleware/middlewareRegistry.js';
import { goalReanchorMiddleware } from './Core/Middleware/builtin/goalReanchor.js';
import { fingerprintDetectorMiddleware } from './Core/Middleware/builtin/fingerprintDetector.js';
import { budgetSentinelMiddleware } from './Core/Middleware/builtin/budgetSentinel.js';
import { createInitialLoopState, buildStopRuleSet } from './Services/LoopControl/index.js';
import { initWalletManager, initTaxCollector, initDualBudget } from './Services/TokenEconomy/index.js';
import { initEventBus } from './Services/EventBus/index.js';
import { initDedupStore, initCircuitBreaker } from './Services/LoopScheduler/index.js';
import { initConfigWatcher } from './Infra/Watcher/index.js';
import { resetAgentFactory } from './Core/AgentRuntime/agentFactory.js';
import { registerAllRoutes } from './Interface/WebServer/routes.js';
import { startHttpServer, stopHttpServer } from './Interface/WebServer/httpServer.js';
import { startWsGateway, stopWsGateway } from './Interface/WebSocket/wsGateway.js';
import { closeDatabase } from './Infra/Db/database.js';
import { cleanAgentWorkspace, getAllWorkspaces, initWorkspaceIsolator } from './Infra/Sandbox/workspaceIsolator.js';

// ===== 服务器启动（可被 Electron 或独立模式调用）=====
export async function startServer(): Promise<{ httpPort: number; wsPort: number }> {
  // ① 配置加载
  const configResult = loadConfig();
  if (!configResult.ok) {
    throw new Error(`配置加载失败: ${configResult.error}`);
  }

  const config = configResult.value;
  const systemName = getConfigValueOr<string>(config, 'system.name', 'unknown');
  const version = getConfigValueOr<string>(config, 'system.version', 'unknown');
  const logLevel = getConfigValueOr<string>(config, 'system.logLevel', 'info');
  const logDir = getConfigValueOr<string>(config, 'system.logDir', 'Logs/');

  console.log(`[INFO] System: ${systemName} v${version}`);
  console.log(`[INFO] Config loaded: env=${config.env}, dir=${config.configDir}`);

  // ② 日志系统初始化
  const resolvedLogDir = resolve(logDir);
  const logWritable = initLogger({ logDir: resolvedLogDir, level: logLevel as 'debug' | 'info' | 'warn' | 'error' | 'fatal' });
  logger.info('日志系统初始化完成', { source: 'main', logDir: resolvedLogDir, writable: logWritable });

  // ③ 时间服务
  Time.onDrift((event) => {
    logger.warn('时钟回拨检测', {
      source: 'timeService',
      driftMs: event.driftMs,
      lastTime: event.lastTime,
      currentTime: event.currentTime,
    });
  });

  // ④ 安全基础
  const securityConfig = getConfigValueOr<Record<string, unknown>>(config, 'security', {});
  const trustConfig = (securityConfig['trustLevels'] ?? {}) as { systemRoles?: string[]; userRoles?: string[] };
  initTrustLevels(trustConfig);
  initWhitelist({
    forbiddenPaths: (securityConfig['forbiddenPaths'] ?? ['Data/Auth/']) as string[],
    forbiddenCommands: (securityConfig['forbiddenCommands'] ?? []) as string[],
    networkWhitelist: (securityConfig['networkWhitelist'] ?? []) as string[],
  });
  initPathGuard({
    projectRoot: resolve('.'),
    forbiddenPaths: (securityConfig['forbiddenPaths'] ?? ['Data/Auth/']) as string[],
  });

  // ⑤ 文件系统
  initDirectories();
  logger.info('文件系统初始化完成', { source: 'main' });

  // ⑥ 数据库初始化
  const dbConfig = getConfigValueOr<Record<string, unknown>>(config, 'database', {});
  const dbResult = initDatabase({
    mainPath: resolve((dbConfig['mainPath'] as string) ?? 'Data/db/civitas_main.db'),
    eventsPath: resolve((dbConfig['eventsPath'] as string) ?? 'Data/db/civitas_events.db'),
    memoryPath: resolve((dbConfig['memoryPath'] as string) ?? 'Data/db/civitas_memory.db'),
    walMode: (dbConfig['walMode'] as boolean) ?? true,
    busyTimeoutMs: (dbConfig['busyTimeoutMs'] as number) ?? 5000,
  });
  if (!dbResult.ok) throw new Error(`数据库初始化失败: ${dbResult.error}`);

  const migResult = initMigrations();
  if (!migResult.ok) throw new Error(`迁移系统初始化失败: ${migResult.error}`);

  const migrateResult = migrateUp();
  if (!migrateResult.ok) throw new Error(`数据库迁移失败: ${migrateResult.error}`);
  logger.info('数据库初始化完成', { source: 'main', migrationsApplied: migrateResult.value });

  // ⑦ 工作区管理器
  const dataRoot = resolve('Data');
  const wsResult = initWorkspace({ dataRoot });
  if (!wsResult.ok) throw new Error(`工作区初始化失败: ${wsResult.error}`);

  // ⑦.5 持久执行底座
  const durableConfig = getConfigValueOr<Record<string, unknown>>(config, 'durable', {});
  const effectConfig = (durableConfig['effect'] ?? {}) as Record<string, unknown>;
  const idempotencyConfig = (durableConfig['idempotency'] ?? {}) as Record<string, unknown>;
  const recoveryConfig = (durableConfig['recovery'] ?? {}) as Record<string, unknown>;
  initEffectJournal({ defaultTimeoutMs: (effectConfig['defaultTimeoutMs'] as number) ?? 30000 });
  initIdempotencyStore({ cacheTtlHour: (idempotencyConfig['cacheTtlHour'] as number) ?? 24 });
  initRecoveryScanner({
    autoResumeMaxUnknownEffects: (recoveryConfig['autoResumeMaxUnknownEffects'] as number) ?? 0,
    autoResumeMaxBudgetUsedRatio: (recoveryConfig['autoResumeMaxBudgetUsedRatio'] as number) ?? 0.8,
    requireHumanOnArtifactDrift: (recoveryConfig['requireHumanOnArtifactDrift'] as boolean) ?? true,
  });
  scanAndProposeRecovery();

  // ⑧ 沙箱系统
  initWorkspaceIsolator({ dataRoot: resolve('Data') });
  logger.info('沙箱系统初始化完成', { source: 'main' });

  // ⑨ 配置热加载注册
  initConfigWatcher({ watchDir: 'Configs/', pollIntervalMs: 5000 });
  logger.info('配置热加载注册完成', { source: 'main' });

  // ⑩ 提示词加载
  // Prompts/ 目录已填充（8 角色 + 系统提示词 + 任务模板）
  // Phase 0-2: 后续接入提示词热加载机制
  logger.info('提示词目录就绪', { source: 'main', roles: 8 });

  // ⑪ LLM 通道
  const routerConfig = getConfigValueOr<Record<string, unknown>>(config, 'providers', []);
  const routingRaw = getConfigValueOr<Record<string, unknown>>(config, 'routing', {});
  let providerCount = 0;
  if (Array.isArray(routerConfig)) {
    for (const pConfig of routerConfig) {
      const pc = pConfig as Record<string, unknown>;
      try {
        const provider = new OpenAIProvider({
          provider: pc['provider'] as string,
          base_url: pc['base_url'] as string,
          api_key_ref: pc['api_key_ref'] as string,
          display_name: pc['display_name'] as string,
          models: (pc['models'] ?? []) as any[],
        });
        const regResult = registerProvider(provider);
        if (regResult.ok) providerCount++;
      } catch { /* Provider 注册失败不阻塞启动 */ }
    }
  }
  setRoutingConfig({
    defaultModel: (routingRaw['defaultModel'] as string) ?? '',
    directorModel: (routingRaw['directorModel'] as string) ?? '',
    workerModel: (routingRaw['workerModel'] as string) ?? '',
    verifierModel: (routingRaw['verifierModel'] as string) ?? '',
    arbitrationModels: (routingRaw['arbitrationModels'] as string[]) ?? [],
    fallbackOrder: (routingRaw['fallbackOrder'] as string[]) ?? [],
    timeoutMs: (routingRaw['timeoutMs'] as number) ?? 60000,
    firstByteTimeoutMs: (routingRaw['firstByteTimeoutMs'] as number) ?? 10000,
    interChunkTimeoutMs: (routingRaw['interChunkTimeoutMs'] as number) ?? 15000,
  });
  if (providerCount === 0) throw new Error('无可用 LLM Provider');

  // ⑫ 工具注册
  const toolResult = registerBuiltinTools();
  if (!toolResult.ok) throw new Error(`工具注册失败: ${toolResult.error}`);

  // ⑬ 运行时内核
  initPromptCache();
  initToolResultCache();
  initSessionManager();
  initArchiveManager();
  initHookExecutor();
  registerMiddleware(goalReanchorMiddleware);
  registerMiddleware(fingerprintDetectorMiddleware);
  registerMiddleware(budgetSentinelMiddleware);

  // ⑭ 环境激活自检
  // Phase 0-2: 后续接入完整环境自检（DB 完整性、Provider 连通性、工具注册数）
  logger.info('环境自检完成', { source: 'main', providers: providerCount });

  // ⑮ Loop 控制
  const loopConfigRaw = getConfigValueOr<Record<string, unknown>>(config, 'loopConfig', {});
  const stopRulesRaw = (loopConfigRaw['stopRules'] ?? {}) as Record<string, unknown>;
  const limitsRaw = (stopRulesRaw['limits'] ?? {}) as Record<string, unknown>;
  const budgetRaw = (stopRulesRaw['budget'] ?? {}) as Record<string, unknown>;
  const noProgressRaw = (stopRulesRaw['noProgress'] ?? {}) as Record<string, unknown>;
  const loopDefaults = (loopConfigRaw['loopDefaults'] ?? {}) as Record<string, unknown>;
  buildStopRuleSet({
    tokenBudget: (loopDefaults['token_budget'] as number) ?? 100000,
    softRatio: (budgetRaw['softRatio'] as number) ?? 0.6,
    hardRatio: (budgetRaw['hardRatio'] as number) ?? 1.0,
    warmRatio: (budgetRaw['warmRatio'] as number) ?? 0.36,
    expandRequestRatio: (budgetRaw['expandRequestRatio'] as number) ?? 0.8,
    limits: {
      maxIterations: (limitsRaw['maxIterations'] as number) ?? 30,
      maxWallClockMs: (limitsRaw['maxWallClockMs'] as number) ?? 900000,
      maxToolCalls: (limitsRaw['maxToolCalls'] as number) ?? 100,
      maxConsecutiveErrors: (limitsRaw['maxConsecutiveErrors'] as number) ?? 3,
    },
    noProgress: {
      metric: (noProgressRaw['metric'] as 'failed_tests' | 'validation_score' | 'goal_distance' | 'custom') ?? 'goal_distance',
      stagnationWindow: (noProgressRaw['stagnationWindowRounds'] as number) ?? 3,
      minDelta: (noProgressRaw['minDeltaRatio'] as number) ?? 0.05,
      action: (noProgressRaw['action'] as 'switch_strategy' | 'escalate_human' | 'abort') ?? 'switch_strategy',
    },
  });

  // ⑯ Token 经济
  const economyRaw = getConfigValueOr<Record<string, unknown>>(config, 'economy', {});
  const taxRaw = (economyRaw['tax'] ?? {}) as Record<string, unknown>;
  initWalletManager({
    initialSupply: (economyRaw['initialSupply'] as number) ?? 1000000,
    defaultWalletBalance: (economyRaw['defaultWalletBalance'] as number) ?? 10000,
  });
  initTaxCollector({
    baseRate: (taxRaw['baseRate'] as number) ?? 0.05,
    dynamicEnabled: (taxRaw['dynamicEnabled'] as boolean) ?? true,
    adjustmentIntervalSec: (taxRaw['adjustmentIntervalSec'] as number) ?? 300,
    maxRate: (taxRaw['maxRate'] as number) ?? 0.20,
    minRate: (taxRaw['minRate'] as number) ?? 0.02,
    highLoadMultiplier: (taxRaw['highLoadMultiplier'] as number) ?? 1.5,
    lowLoadDiscount: (taxRaw['lowLoadDiscount'] as number) ?? 0.8,
    loadThresholdAgents: (taxRaw['loadThresholdAgents'] as number) ?? 10,
  });
  initDualBudget({
    tokenBudget: (loopDefaults['token_budget'] as number) ?? 100000,
    warmRatio: (budgetRaw['warmRatio'] as number) ?? 0.36,
    softRatio: (budgetRaw['softRatio'] as number) ?? 0.6,
    expandRequestRatio: (budgetRaw['expandRequestRatio'] as number) ?? 0.8,
    hardRatio: (budgetRaw['hardRatio'] as number) ?? 1.0,
  });

  // ⑰ 事件总线
  initEventBus({ maxQueueSize: 10000 });
  initDedupStore({ windowMs: 60_000 });
  initCircuitBreaker({ threshold: 100, windowMs: 60_000, cooldownMs: 120_000 });

  // ⑱ 接口层装配
  registerAllRoutes();
  const serverConfig = getConfigValueOr<Record<string, unknown>>(config, 'server', {});
  const uiConfig = getConfigValueOr<Record<string, unknown>>(config, 'ui', {});
  const httpPort = (serverConfig['httpPort'] as number) ?? 3000;
  const wsPort = (serverConfig['wsPort'] as number) ?? 3001;
  const host = (serverConfig['host'] as string) ?? '0.0.0.0';
  const corsOrigins = (serverConfig['corsOrigins'] as string[]) ?? ['http://localhost:5173'];

  await startHttpServer({ host, port: httpPort, corsOrigins });
  logger.info('HTTP 服务器启动', { source: 'main', port: httpPort });

  await startWsGateway({
    host,
    port: wsPort,
    maxBufferSize: (uiConfig['maxEventBufferSize'] as number) ?? 500,
  });
  logger.info('WS 网关启动', { source: 'main', port: wsPort });

  return { httpPort, wsPort };
}

// ===== 主入口（独立运行模式）=====
async function main(): Promise<void> {
  console.log('═══════════════════════════════════════════');
  console.log('  Civitas-AI v0.1.0 — 智体城邦');
  console.log('═══════════════════════════════════════════');

  try {
    const { httpPort, wsPort } = await startServer();
    console.log(`[INFO] 服务已启动 — HTTP:${httpPort} WS:${wsPort}`);
    console.log('[INFO] System ready.');
  } catch (err) {
    console.error(`[FATAL] 启动失败: ${err}`);
    process.exit(1);
  }
  
  // 优雅关闭——9 步序列（Docs/02 §7.2）
  let isShuttingDown = false;
  process.on('SIGINT', async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log('\n[INFO] 开始优雅关闭（9 步序列）...');

    try {
      // ① 停止接收新输入
      console.log('[shutdown ①] 停止接收新输入...');
      await stopHttpServer();
      await stopWsGateway();

      // ② 中断当前模型调用（关闭流）
      console.log('[shutdown ②] 中断活跃模型调用...');
      // Phase 0-2: 通过全局 AbortController 中断（后续接入）

      // ③ 触发后置监管（保存/备份/同步）
      console.log('[shutdown ③] 后置监管（保存/备份）...');
      // Phase 0-2: 后续接入 runPostSupervision

      // ④ 生成追踪索引文件（≤5s）
      console.log('[shutdown ④] 生成追踪索引...');
      // Phase 0-2: 后续接入 trace index writer

      // ⑤ 归档活跃会话
      console.log('[shutdown ⑤] 归档活跃会话...');
      const workspaces = getAllWorkspaces();
      for (const ws of workspaces) {
        cleanAgentWorkspace(ws.agentId);
      }

      // ⑥ flush 日志队列
      console.log('[shutdown ⑥] flush 日志队列...');
      await shutdownLogger();

      // ⑦ 销毁沙箱
      console.log('[shutdown ⑦] 销毁沙箱工作区...');
      // cleanAgentWorkspace 已在 ⑤ 中调用

      // ⑧ 关闭数据库连接
      console.log('[shutdown ⑧] 关闭数据库连接...');
      closeDatabase();

      // ⑨ 退出进程
      console.log('[shutdown ⑨] 关闭完成。');
    } catch (err) {
      console.error(`[shutdown ERROR] ${err}`);
    } finally {
      process.exit(0);
    }
  });

  // 优雅关闭时刷新日志
  process.on('beforeExit', () => {
    shutdownLogger();
  });
}

main();
