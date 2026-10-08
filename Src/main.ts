/**
 * Civitas-AI 系统入口
 *
 * S0 阶段：仅验证配置加载链可工作。
 * S1 阶段：按启动 14 步（Docs/Agent/02 §7.1）逐步构建 Infra 底座。
 * 后续阶段将继续添加 ③~⑭ 步。
 */

import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';

import { loadConfig, getConfigValueOr } from './Infra/Config/configLoader.js';
import { initLogger, logger, shutdownLogger } from './Infra/Logging/logger.js';
import { Time } from './Infra/Time/timeService.js';
import { initTrustLevels } from './Infra/Security/trustLevels.js';
import { initWhitelist } from './Infra/Security/whitelist.js';
import { initPathGuard } from './Infra/Security/pathGuard.js';
import { scanAndRegisterRefs, resolveSingleRef } from './Infra/Security/keyStore.js';
import { registerHookHandler, dispatchHook, type HookEvent } from './Services/Hook/hookRegistry.js';
import { systemAuditHook, systemMetricsHook } from './Infra/Hook/System/auditHook.js';
import { configureToolSafetyGate } from './Services/LoopControl/middleware/toolSafetyGate.js';
import {
  initDirectories,
  getAppRoot,
  getDataDir,
  getLogDir,
  getConfigDir,
  getBundledConfigDir,
  getPromptsDir,
  getSkillsDir,
  getWorkspaceRoot,
  getSecretsDir,
  getEnvFilePaths,
  getInstallMode,
  describePathsBrief,
  describePaths,
  resolveDataPath,
  probeWrite,
  resetPathCache,
} from './Infra/Fs/pathResolver.js';
import { initDatabase, initMigrations, migrateUp, getMainDb, getCurrentVersion } from './Infra/Db/index.js';
import { initWorkspace } from './Infra/Workspace/index.js';
import { initEffectJournal, initIdempotencyStore, initRecoveryScanner, scanAndProposeRecovery, purgeExpired } from './Infra/DurableExecution/index.js';
import { OpenAIProvider, registerProvider, setRoutingConfig } from './Infra/Llm/index.js';
import { registerBuiltinTools } from './Tools/index.js';
import { setToolHeaderConfig } from './Tools/Registry/toolHeader.js';
import { initPromptCache } from './Services/Cache/promptCache.js';
import { initToolResultCache, getCachedToolResult, cacheToolResult, clearToolResultCache } from './Services/Cache/toolResultCache.js';
import { initSessionManager } from './Services/Session/sessionManager.js';
import { initArchiveManager } from './Services/Session/archiveManager.js';
import { initHookExecutor } from './Infra/Hook/hookExecutor.js';
import { registerMiddleware } from './Core/Middleware/middlewareRegistry.js';
import { goalReanchorMiddleware } from './Core/Middleware/builtin/goalReanchor.js';
import { fingerprintDetectorMiddleware } from './Core/Middleware/builtin/fingerprintDetector.js';
import { budgetSentinelMiddleware } from './Core/Middleware/builtin/budgetSentinel.js';
import { rateLimiterMiddleware, initRateLimiter } from './Core/Middleware/builtin/rateLimiter.js';
import { initApiRateLimiter } from './Interface/WebServer/apiRateLimiter.js';
import { initPreSupervisionRateLimit } from './Services/Supervision/preSupervision.js';
import { buildStopRuleSet, setActiveStopRuleSet } from './Services/LoopControl/index.js';
import { expireStaleApprovals } from './Services/LoopControl/approvalPersistence.js';
import { setRoleOverrides, setLoopLimits, type LoopConfig } from './Core/Loop/loopConfig.js';
import { configureAssessor } from './Core/Decision/complexityAssessor/complexityAssessor.js';
import { configureContextCompression } from './Core/Loop/contextCompression.js';
import { initWalletManager, initTaxCollector, initDualBudget } from './Services/TokenEconomy/index.js';
import { registerPricing } from './Services/TokenEconomy/consumptionRecorder.js';
import { startTaxAdjustment, stopTaxAdjustment } from './Services/TokenEconomy/taxCollector.js';
import { initEventBus } from './Services/EventBus/index.js';
import { startAiEventPersistence, stopAiEventPersistence } from './Interface/EventStore/aiEventStore.js';
import { writeTraceIndex } from './Interface/EventStore/traceIndex.js';
import { initDedupStore, initCircuitBreaker } from './Services/LoopScheduler/index.js';
import { initConfigWatcher, onConfigChange, startWatching } from './Infra/Watcher/index.js';
import { registerAllRoutes } from './Interface/WebServer/routes.js';
import { hydrateLongTermMemory } from './Services/SharedMemory/longTermMemory.js';
import { configureMemoryEmbedding } from './Services/SharedMemory/memoryEmbeddings.js';
import { hydrateGlobalWorkspace } from './Services/SharedMemory/globalWorkspace.js';
import { hydrateGovernanceLedger } from './Services/Governance/governanceAudit.js';
import { loadRolePrompts, loadSystemAssets } from './Services/Prompts/promptRegistry.js';
import { loadSkillsAssets, getStrategyCandidates } from './Services/Prompts/skillsAssets.js';
import { configureStrategyCandidates } from './Services/LoopControl/strategyLedger.js';
import { resetSystemPromptCache } from './Core/Loop/runIteration.js';
import { getToolCount } from './Tools/Registry/toolRegistry.js';
import { configureReviewer, ensureReviewerAgent, performReview } from './Services/ReviewerAgent/reviewerAgent.js';
import { configureToolServicePorts } from './Tools/Registry/toolServicePorts.js';
import { replaceTodos, listTodosForAgent, MAX_TODOS_PER_AGENT } from './Services/Planning/todoStore.js';
import { createMemoryRetriever } from './Services/Retrieval/retriever.js';
import { recruitAgent, getRecruitedAgents } from './Services/Recruitment/recruiter.js';
import { submitForReview as submitReviewRuntime } from './Core/AgentRuntime/agentRuntime.js';
import { markSubtaskReviewed } from './Core/Decision/orchestrator/subtaskDispatcher.js';
import { callModel } from './Core/Model/modelCaller.js';
import { initRegulatoryAuthority } from './Services/Regulation/regulatoryAuthority.js';
import { initArbitrationWiring, stopArbitrationWiring } from './Services/Arbitration/arbitrationWiring.js';
import { attachA2AGovernance, detachA2AGovernance } from './Services/A2A/attach.js';
import {
  startAuditCycle, stopAuditCycle,
} from './Services/Audit/auditScheduler.js';
import { initPatrolScheduler } from './Services/Audit/patrolScheduler.js';
import { setAutoUnfreezeSec, resetFreezeManager } from './Services/Audit/freezeManager.js';
import { initAnomalyDetector } from './Services/Audit/anomalyDetector.js';
import { initArbitratorPool, getPoolStats, startIdleRecycling, stopIdleRecycling } from './Services/Arbitration/arbitratorPool.js';
import { initDynamicScaling, startAutoScaling, stopAutoScaling } from './Services/Arbitration/dynamicScaling.js';
import { hydrateAgents, getStatusSummary } from './Core/AgentRuntime/agentRegistry.js';
import { startHttpServer, stopHttpServer } from './Interface/WebServer/httpServer.js';
import { startIpcBridge, stopIpcBridge, abortAllActiveStreams, setIpcMainProvider, setWindowBroadcaster } from './Interface/IpcBridge/ipcBridge.js';
import { setSafeStorageProvider } from './Infra/Security/secretsStore.js';
import { closeDatabase } from './Infra/Db/database.js';
import { cleanAgentWorkspace, getAllWorkspaces, initWorkspaceIsolator } from './Infra/Sandbox/workspaceIsolator.js';

// ===== Electron 主进程运行时注入 =====

/** Electron 主进程侧可注入的运行时能力（结构类型，避免 Src 侧引用 electron 类型） */
export interface ElectronRuntime {
  ipcMain?: unknown;
  safeStorage?: {
    isEncryptionAvailable(): boolean;
    encryptString(plain: string): Buffer;
    decryptString(encrypted: Buffer): string;
  };
  /**
   * 向所有渲染进程窗口广播一条消息（返回成功发送的窗口数）。
   *
   * 必须由主进程注入：后端 ESM 侧拿不到可用的 `BrowserWindow`（见 ipcBridge 的
   * `setWindowBroadcaster` 注释，那里记录了"广播整条失效"的历史 bug）。
   */
  broadcastToWindows?: (channel: string, payload: unknown) => number;
}

/**
 * 由 `electron/main.ts`（CommonJS）注入 Electron 主进程真身。
 *
 * 为什么必须注入：后端被打包为 **ESM**，而 `electron` 是 **CJS** 模块。
 * 在 Electron 44 / Node 24 上实测：
 * - `import { ipcMain } from 'electron'` → `SyntaxError: does not provide an export named ...`；
 * - `await import('electron')` → 命名空间里 `ipcMain`/`safeStorage` 均为 `undefined`。
 * 后果是**打包后 IPC 全部失效、API Key 退化为 Base64 明文存储**。
 * CJS 主进程 `require('electron')` 能拿到真身，因此在 `startServer()` 之前注入。
 */
export function setElectronRuntime(runtime: ElectronRuntime): void {
  if (runtime.ipcMain) setIpcMainProvider(runtime.ipcMain);
  if (runtime.safeStorage) setSafeStorageProvider(runtime.safeStorage);
  if (runtime.broadcastToWindows) setWindowBroadcaster(runtime.broadcastToWindows);
}

// ===== 服务器启动（可被 Electron 或独立模式调用）=====
export async function startServer(): Promise<{ httpPort: number }> {
  // ⓪ .env 加载（FE-011）：.env.example 承诺「复制为 .env 并填入实际值」即可生效。
  // Node ≥20.12 提供 process.loadEnvFile；文件不存在/不可读时忽略（环境变量可由外部注入）。
  // 查找顺序：<数据根>/.env（安装态用户可写位置）→ <程序根>/.env（开发态仓库根）。
  // 注：已在 process.env 中的变量优先（与 --env-file 语义一致），不覆盖 Electron 注入的 CIVITAS_* 目录。
  for (const envFile of getEnvFilePaths()) {
    try {
      process.loadEnvFile?.(envFile);
    } catch { /* 该 .env 不存在或不可读：继续尝试下一个 */ }
  }

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

  // ①.0 用户配置层可指定工作空间根（首启引导里选过目录 → **本次启动即生效**）。
  //      必须在任何路径解析/建目录之前写入环境变量并清缓存。
  const workspaceRootFromConfig = getConfigValueOr<string>(config, 'workspace.root', '');
  if (workspaceRootFromConfig && !process.env['CIVITAS_WORKSPACE_ROOT']) {
    process.env['CIVITAS_WORKSPACE_ROOT'] = workspaceRootFromConfig;
    resetPathCache();
    console.log(`[INFO] 工作空间根（来自用户配置 workspace.root）：${workspaceRootFromConfig}`);
  }

  console.log(`[INFO] System: ${systemName} v${version}`);
  console.log(`[INFO] Config loaded: env=${config.env}, dir=${config.configDir}`);
  console.log(`[INFO] Paths: ${describePathsBrief()}`);

  // ①.1 目录契约自检（安装态排障的关键一行：数据/工作空间/日志实际落在哪、是否可写）
  const pathDiag = describePaths();
  for (const w of pathDiag.warnings) console.warn(`[WARN] ${w}`);

  // ② 日志系统初始化
  // 开发态保持历史行为（`system.logDir` 相对仓库根），安装/便携态改用统一契约的日志目录，
  // 避免日志落到 cwd（安装态 cwd 不是程序目录 → 日志"消失"）。
  const resolvedLogDir = getInstallMode() === 'development'
    ? resolve(logDir)
    : (logDir && logDir !== 'Logs/' && logDir !== 'Logs' ? resolveDataPath(logDir, 'Logs') : getLogDir());
  const logWritable = initLogger({ logDir: resolvedLogDir, level: logLevel as 'debug' | 'info' | 'warn' | 'error' | 'fatal' });
  logger.info('日志系统初始化完成', { source: 'main', logDir: resolvedLogDir, writable: logWritable });
  logger.info('目录契约就绪', {
    source: 'main',
    mode: pathDiag.mode,
    appRoot: pathDiag.appRoot,
    dataRoot: pathDiag.dataRoot,
    workspaceRoot: pathDiag.workspaceRoot,
    configDir: pathDiag.configDir,
    writable: pathDiag.writable,
    warnings: pathDiag.warnings,
  });
  if (!logWritable) {
    console.warn(`[WARN] 日志目录不可写：${resolvedLogDir}（请检查目录权限，或设置 CIVITAS_LOG_DIR 指向可写位置）`);
  }

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
  const trustConfig = (securityConfig['trustLevels'] ?? {}) as { systemRoles?: string[]; userRoles?: string[]; externalRoles?: string[] };
  initTrustLevels(trustConfig);
  initWhitelist({
    forbiddenPaths: (securityConfig['forbiddenPaths'] ?? ['Data/Auth/']) as string[],
    forbiddenCommands: (securityConfig['forbiddenCommands'] ?? []) as string[],
    networkWhitelist: (securityConfig['networkWhitelist'] ?? []) as string[],
  });
  initPathGuard({
    // 程序根（只读资源）——安装态即安装目录；写入能力由 allowedRoots 中的可写目录提供
    projectRoot: getAppRoot(),
    forbiddenPaths: [
      ...((securityConfig['forbiddenPaths'] ?? ['Data/Auth/']) as string[]),
      // 密钥目录：无论安装态/便携态都不允许业务代码直接读写（只经 secretsStore + safeStorage）
      getSecretsDir(),
    ],
    // 安装态数据/工作空间/配置位于 %APPDATA% 与安装目录两处，均不在"项目根"内，需显式放行
    allowedRoots: [
      getDataDir(),
      getLogDir(),
      getConfigDir(),
      getBundledConfigDir(),
      getWorkspaceRoot(),
      getPromptsDir(),
      getSkillsDir(),
      getSecretsDir(),
    ],
  });

  // 工具安全门：自动审批白名单与"L0 审查"动画时长（security.autoApprove）
  const autoApproveRaw = (securityConfig['autoApprove'] ?? {}) as Record<string, unknown>;
  configureToolSafetyGate({
    autoApproveTools: (autoApproveRaw['tools'] as string[]) ?? [],
    autoApproveDelayMs: (autoApproveRaw['delayMs'] as number) ?? 600,
    // 人工确认窗口：太短会让人还没看到审批就超时默认拒绝（工具一直阻塞到超时）
    approvalTimeoutSec: (securityConfig['approvalTimeoutSec'] as number) ?? 300,
  });

  // ⑤ 文件系统
  initDirectories();
  const dirProbe = probeWrite(getDataDir());
  if (!dirProbe.ok) {
    throw new Error(
      `数据目录不可写：${getDataDir()}（${dirProbe.error ?? '未知原因'}）。`
      + '请改用可写的数据根：设置环境变量 CIVITAS_DATA_ROOT 指向用户目录，'
      + '或把程序安装到用户可写位置（默认安装路径 %LOCALAPPDATA%\\Programs\\CivitasAI 即无需管理员）。',
    );
  }
  logger.info('文件系统初始化完成', { source: 'main', dataRoot: getDataDir(), workspaceRoot: getWorkspaceRoot() });

  // ⑥ 数据库初始化
  const dbConfig = getConfigValueOr<Record<string, unknown>>(config, 'database', {});
  // readable：main 库 synchronous 级别（Docs/Agent/12 §10 须读 durable.effect.writeSynchronous）
  const durableEffectRaw = getConfigValueOr<Record<string, unknown>>(config, 'durable.effect', {});
  const writeSynchronous = (durableEffectRaw['writeSynchronous'] as string) ?? 'FULL';
  const dbResult = initDatabase({
    // 相对路径一律以数据根为基准（安装态 = %APPDATA%\CivitasAI），不再依赖 cwd
    mainPath: resolveDataPath(dbConfig['mainPath'] as string, 'Data/db/civitas_main.db'),
    eventsPath: resolveDataPath(dbConfig['eventsPath'] as string, 'Data/db/civitas_events.db'),
    memoryPath: resolveDataPath(dbConfig['memoryPath'] as string, 'Data/db/civitas_memory.db'),
    walMode: (dbConfig['walMode'] as boolean) ?? true,
    busyTimeoutMs: (dbConfig['busyTimeoutMs'] as number) ?? 5000,
    writeSynchronous,
  });
  if (!dbResult.ok) throw new Error(`数据库初始化失败: ${dbResult.error}`);

  const migResult = initMigrations();
  if (!migResult.ok) throw new Error(`迁移系统初始化失败: ${migResult.error}`);

  const migrateResult = migrateUp();
  if (!migrateResult.ok) throw new Error(`数据库迁移失败: ${migrateResult.error}`);
  logger.info('数据库初始化完成', { source: 'main', migrationsApplied: migrateResult.value });

  // ⑦.1 审批队列残留清理（FE-004）：重启后内存队列已空，上次未决的审批不可能再被放行，
  // 一律落 TIMEOUT（默认拒绝，禁止默认通过），保留在历史中供「已决」栏回溯（FE-005）。
  expireStaleApprovals();

  // ⑦ 工作区管理器（工作空间数据：安装态落安装目录，见 pathResolver 契约）
  const dataRoot = getWorkspaceRoot();
  const wsResult = initWorkspace({ dataRoot });
  if (!wsResult.ok) throw new Error(`工作区初始化失败: ${wsResult.error}`);

  // ⑦.2 长时记忆回灌（Docs/Agent/07 §3.4）
  // 记忆此前仅存进程内 Map：重启即丢，且 ID 计数器归零会导致 memory_id 重用
  // （进而污染云端按 clientMemoryId 的幂等对齐）。这里在数据库就绪后回灌并恢复计数器。
  const ltmHydrate = hydrateLongTermMemory();
  if (ltmHydrate.ok) {
    logger.info('长时记忆已回灌', { source: 'main', count: ltmHydrate.value });
  } else {
    logger.warn('长时记忆回灌失败（记忆将不持久）', { source: 'main', error: ltmHydrate.error });
  }

  // ⑦.3 Agent 注册表回灌（多 Agent 核心，2026-10-03）
  // 修复前注册表纯内存：重启后招募出的 Agent 全部消失，"多 Agent"既不可持久也不可审计。
  // 现在按 owner 载入未销毁的 Agent；崩溃时状态为 running/creating 的实例降级为 suspended。
  const agentHydrate = hydrateAgents();
  logger.info('Agent 注册表已回灌', { source: 'main', count: agentHydrate });

  // ⑦.4 共享工作区（GlobalWorkspace）回灌（2026-10-04，G-13③）
  // 修复前该表**全仓无读写方**（纯内存 Map）：治理广播等共享记忆重启即丢，且无属主隔离。
  // 现按 owner 载入条目并恢复 ID 计数器；读取按属主过滤（跨账号不可见）。
  // ⑦.4b 治理台账回灌（2026-10-04）：治理留痕此前仅存内存，重启即丢 → 现落库并回灌
  const govHydrate = hydrateGovernanceLedger();
  if (govHydrate.ok) {
    logger.info('治理台账已回灌', { source: 'main', count: govHydrate.value });
  }

  const gwHydrate = hydrateGlobalWorkspace();
  if (gwHydrate.ok) {
    logger.info('共享工作区已回灌', { source: 'main', count: gwHydrate.value });
  } else {
    logger.warn('共享工作区回灌失败（共享记忆将不持久）', { source: 'main', error: gwHydrate.error });
  }

  // ⑦.4c 仲裁者池初始化（2026-10-04，G-20）：给 `initArbitratorPool` 一个**生产调用者**，
  //   并让每个池位绑定**真实注册 Agent**（此前池位只是内存模拟、且无生产调用者）。
  const arbPoolConfig = getConfigValueOr<Record<string, unknown>>(config, 'arbitration.pool', {});
  const coreCount = typeof arbPoolConfig['coreCount'] === 'number' ? arbPoolConfig['coreCount'] : 1;
  const auxiliaryCount = typeof arbPoolConfig['auxiliaryCount'] === 'number' ? arbPoolConfig['auxiliaryCount'] : 2;
  initArbitratorPool({ coreCount, auxiliaryCount });
  logger.info('仲裁者池已初始化', {
    source: 'main',
    requestedCore: coreCount,
    requestedAuxiliary: auxiliaryCount,
    stats: getPoolStats(),
  });

  // ⑦.4d 仲裁池自动监测 + 空闲回收接线（FE-049，2026-10-04）：
  //   此前 `startAutoScaling` / `recycleIdleArbitrators` 全仓无生产调用者，
  //   运行期池位除手动缩容外只增不减；现接入启动序列的周期任务。
  const arbConfig = getConfigValueOr<Record<string, unknown>>(config, 'arbitration', {});
  const numCfg = (key: string, fallback: number): number =>
    typeof arbConfig[key] === 'number' ? (arbConfig[key] as number) : fallback;
  const monitoringIntervalMs = numCfg('monitoringIntervalSec', 60) * 1000;
  initDynamicScaling({
    // 配置键映射：scaleUpFactor → scalingFactor（f = k·n^m 的 k）
    scalingFactor: numCfg('scaleUpFactor', 1.5),
    frequencyThreshold: numCfg('frequencyThreshold', 5),
    consecutiveHighCount: numCfg('consecutiveHighCount', 3),
    consecutiveLowCount: numCfg('consecutiveLowCount', 3),
    monitoringIntervalMs,
    maxArbitrators: numCfg('maxArbitrators', 15),
    minArbitrators: numCfg('minArbitrators', 1),
  });
  startAutoScaling();
  startIdleRecycling(monitoringIntervalMs);
  logger.info('仲裁池自动监测已启动', {
    source: 'main',
    monitoringIntervalMs,
    idleRecycle: true,
  });

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

  // ⑧ 沙箱系统（沙箱工作区同样属于"工作空间数据"）
  initWorkspaceIsolator({ dataRoot: getWorkspaceRoot() });
  logger.info('沙箱系统初始化完成', { source: 'main', workspaceRoot: getWorkspaceRoot() });

  // ⑨ 配置热加载注册（监听目录统一为解析后的绝对路径；此前用相对 cwd 的 'Configs/' 等）
  initConfigWatcher({
    watchDir: getConfigDir(),
    watchDirs: [getBundledConfigDir(), getPromptsDir(), getSkillsDir()],
    pollIntervalMs: 5000,
  });
  logger.info('配置热加载注册完成', { source: 'main' });

  // ⑩ 提示词加载（FE-052：roles/*.md 装配；FE-069：system/tasks 资产 + manifest 校验齐接入）
  const roleCount = loadRolePrompts(getPromptsDir());
  const promptAssets = loadSystemAssets(getPromptsDir());
  // ⑩.2 Skills 资产装载（FE-071：playbook/rubric/strategy/法典文档的运行期消费源）
  const skillsAssets = loadSkillsAssets(getSkillsDir());
  configureStrategyCandidates(getStrategyCandidates().map(c => c.strategy));
  logger.info('提示词目录就绪', {
    source: 'main',
    roles: roleCount,
    manifestVersion: promptAssets.version,
    missingPromptFiles: promptAssets.missingFiles.length,
    skillsPlaybooks: skillsAssets.playbooks,
    skillsStrategies: skillsAssets.strategies,
    skillsRubric: skillsAssets.rubricLoaded,
  });

  // ⑩.1 提示词热加载接线（FE-069：修改 Prompts/ 后自动重载角色词表与系统资产，
  //     并失效系统提示缓存；此前“修改提示词后需重启生效”）
  onConfigChange((filePath, changeType) => {
    logger.info('配置/提示词文件变更', { source: 'main/configWatcher', filePath, changeType });
    if (filePath.includes('Prompts')) {
      const roles = loadRolePrompts(getPromptsDir());
      loadSystemAssets(getPromptsDir());
      resetSystemPromptCache();
      logger.info('提示词已热重载（角色 + 系统资产，缓存已失效）', {
        source: 'main/configWatcher',
        roles,
      });
    }
    // FE-071：Skills 资产热重载（playbook/rubric/strategy/法典文档）
    if (filePath.includes('Skills')) {
      const loaded = loadSkillsAssets(getSkillsDir());
      configureStrategyCandidates(getStrategyCandidates().map(c => c.strategy));
      logger.info('Skills 资产已热重载', { source: 'main/configWatcher', ...loaded });
    }
  });
  const watchResult = startWatching();
  logger.info('文件监控已启动（Configs/ + Prompts/ + Skills/）', { source: 'main', ok: watchResult.ok });

  // ⑪ LLM 通道
  const routerConfig = getConfigValueOr<Record<string, unknown>[]>(config, 'providers', []);
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

  // ⑪.2 密钥引用统一注册与预检（FE-066：keyStore 接入——此前零消费）
  //   把 providers/routing 中的 env: 引用登记到密钥注册表，并对每个 provider 的
  //   api_key_ref 做可解析性预检（缺失时立即告警，而不是等到首次调用失败）。
  scanAndRegisterRefs({ providers: Array.isArray(routerConfig) ? routerConfig : [], routing: routingRaw });
  if (Array.isArray(routerConfig)) {
    for (const pConfig of routerConfig) {
      const pc = pConfig as Record<string, unknown>;
      const ref = pc['api_key_ref'];
      if (typeof ref === 'string' && ref.startsWith('env:')) {
        const probe = resolveSingleRef(ref);
        if (probe.ok) {
          logger.info(`密钥就绪: ${String(pc['provider'])} (${probe.value.envVar})`, { source: 'main/keystore' });
        } else {
          logger.warn(`密钥未设置: ${String(pc['provider'])} ← ${ref}`, { source: 'main/keystore', error: probe.error });
        }
      }
    }
  }

  // ⑪.1 记忆检索嵌入配置（FE-058：配置了 routing.embeddingModel 时启用语义重排；
  //   未配置时检索走确定性文本打分——不强依赖嵌入模型）
  const embeddingModel = (routingRaw['embeddingModel'] as string) ?? '';
  if (embeddingModel) {
    configureMemoryEmbedding({ model: embeddingModel });
    logger.info('记忆语义检索已启用', { source: 'main', embeddingModel });
  }

  // ⑫ 工具注册
  const toolResult = registerBuiltinTools();
  if (!toolResult.ok) throw new Error(`工具注册失败: ${toolResult.error}`);

  // ⑫.5 工具头部配置注入（T3：热工具清单配置化，同一会话内恒定）
  const toolsConfig = getConfigValueOr<Record<string, unknown>>(config, 'tools', {});
  const hotTools = Array.isArray(toolsConfig['hot']) ? toolsConfig['hot'].map(String) : undefined;
  const maxHeaderTools = typeof toolsConfig['maxHeaderTools'] === 'number' ? toolsConfig['maxHeaderTools'] : undefined;
  setToolHeaderConfig({ hotTools, maxHeaderTools });

  // ⑫.6 工具服务端口注入（分层收口：Tools 层不可 import Services/Core——实现由组合根注入，
  //   门禁保持 import/no-restricted-paths 红线不放松）。覆盖：
  //   FE-064 工具结果缓存 / FE-066 Pre·PostToolExecute Hook 审计链路 /
  //   todo.write（Planning/todoStore）/ vector.search（Retrieval）/ agent.recruit / agent.submit_review。
  configureToolServicePorts({
    toolResultCache: {
      get: getCachedToolResult,
      put: cacheToolResult,
      clear: clearToolResultCache,
    },
    dispatchHook: (event, data) => dispatchHook(event as HookEvent, data),
    todoStore: {
      maxTodos: MAX_TODOS_PER_AGENT,
      replaceTodos,
      listTodosForAgent,
    },
    memoryRetrieverFactory: createMemoryRetriever,
    recruitment: {
      getRecruitedAgents,
      recruitAgent,
    },
    review: {
      submitForReview: submitReviewRuntime,
      ensureReviewerAgent,
      performReview,
      markSubtaskReviewed,
    },
  });
  logger.info('工具服务端口已注入', { source: 'main' });

  // ⑬ 运行时内核
  initPromptCache();
  initToolResultCache();
  initSessionManager();
  initArchiveManager();
  initHookExecutor();

  // ⑬.1 系统内置 Hook 注册（FE-066：auditHook 接入——审计/指标消费）
  //   触发点：UserInputReceived（runIteration ①）/ Pre·PostToolExecute（toolDispatcher 收口层）。
  //   注：systemBackupHook（SessionEnd）暂未注册——当前无 SessionEnd 的 dispatch 触发点（待后续接入）。
  registerHookHandler({
    name: 'system-audit-input',
    event: 'UserInputReceived',
    priority: 100,
    timeoutMs: 1000,
    handle: async (payload) => {
      systemAuditHook({
        eventType: payload.event,
        traceId: payload.data['traceId'] as string | undefined,
        source: 'hookRegistry',
        payload: payload.data,
      });
      return {};
    },
  });
  registerHookHandler({
    name: 'system-audit-pre-tool',
    event: 'PreToolExecute',
    priority: 100,
    timeoutMs: 1000,
    handle: async (payload) => {
      systemAuditHook({
        eventType: payload.event,
        traceId: payload.data['traceId'] as string | undefined,
        source: 'hookRegistry',
        payload: { toolName: payload.data['toolName'] },
      });
      return {};
    },
  });
  registerHookHandler({
    name: 'system-audit-post-tool',
    event: 'PostToolExecute',
    priority: 100,
    timeoutMs: 1000,
    handle: async (payload) => {
      systemMetricsHook({
        eventType: payload.event,
        latencyMs: payload.data['durationMs'] as number | undefined,
      });
      return {};
    },
  });
  registerMiddleware(goalReanchorMiddleware);
  registerMiddleware(fingerprintDetectorMiddleware);
  registerMiddleware(budgetSentinelMiddleware);
  registerMiddleware(rateLimiterMiddleware);

  // 初始化限流器——FE-040 配置解耦：监管与 HTTP API 两层各用独立配置键
  // · supervision.rateLimit    → 监管侧：前置监管频率 + 工具调用限流（Agent 侧）
  // · supervision.apiRateLimit → HTTP API 层限流（UI 侧；为其放宽不影响监管阈值）
  const supervisionRaw = getConfigValueOr<Record<string, unknown>>(config, 'supervision', {});
  const rateLimitRaw = (supervisionRaw['rateLimit'] ?? {}) as Record<string, unknown>;
  const rateLimitConfig = {
    maxRequestsPerMinute: (rateLimitRaw['maxRequestsPerMinute'] as number) ?? undefined,
    maxTokensPerMinute: (rateLimitRaw['maxTokensPerMinute'] as number) ?? undefined,
    maxToolCallsPerMinute: (rateLimitRaw['maxToolCallsPerMinute'] as number) ?? undefined,
    burstAllowance: (rateLimitRaw['burstAllowance'] as number) ?? undefined,
  };
  initRateLimiter(rateLimitConfig);
  initPreSupervisionRateLimit(rateLimitConfig);
  const apiRateLimitRaw = (supervisionRaw['apiRateLimit'] ?? {}) as Record<string, unknown>;
  initApiRateLimiter({
    maxRequestsPerMinute: (apiRateLimitRaw['maxRequestsPerMinute'] as number) ?? undefined,
    burstAllowance: (apiRateLimitRaw['burstAllowance'] as number) ?? undefined,
  });

  // ⑭ 环境激活自检（FE-069 实装：DB / Provider / 工具注册 / 提示词四项；
  //   关键项（前3）失败 → 启动失败（fail-fast），提示词缺失仅告警）
  const selfChecks: Array<{ name: string; ok: boolean; critical: boolean; detail: string }> = [];
  let dbOk = false;
  let dbDetail = '';
  try {
    getMainDb().prepare('SELECT 1 AS ok').get();
    dbOk = true;
    dbDetail = `migrations=${getCurrentVersion()}`;
  } catch (e) {
    dbDetail = e instanceof Error ? e.message : String(e);
  }
  const toolCount = getToolCount();
  selfChecks.push({ name: 'database', ok: dbOk, critical: true, detail: dbDetail });
  selfChecks.push({ name: 'providers', ok: providerCount > 0, critical: true, detail: `${providerCount} provider(s)` });
  selfChecks.push({ name: 'tools', ok: toolCount > 0, critical: true, detail: `${toolCount} tool(s)` });
  selfChecks.push({ name: 'prompts', ok: roleCount > 0, critical: false, detail: `roles=${roleCount}, manifest=${promptAssets.version}` });
  for (const check of selfChecks) {
    if (check.ok) {
      logger.info(`环境自检·${check.name} OK`, { source: 'main/selfCheck', detail: check.detail });
    } else {
      logger.warn(`环境自检·${check.name} 失败`, { source: 'main/selfCheck', detail: check.detail, critical: check.critical });
    }
  }
  const criticalFailed = selfChecks.filter(c => c.critical && !c.ok);
  if (criticalFailed.length > 0) {
    throw new Error(`环境自检失败（关键项）：${criticalFailed.map(c => c.name).join(', ')}`);
  }
  logger.info('环境自检完成', { source: 'main', providers: providerCount, tools: toolCount, roles: roleCount });

  // ⑮ Loop 控制
  // loopConfig.json 的顶层键（loopDefaults/hardLimits/stopRules/roleOverrides/verifier/…）
  // 已被 configLoader 平铺进 merged 根（无 loopConfig 这一层），故直接读顶层键。
  const loopDefaultsRaw = getConfigValueOr<Record<string, unknown>>(config, 'loopDefaults', {});
  const hardLimitsRaw = getConfigValueOr<Record<string, unknown>>(config, 'hardLimits', {});
  const stopRulesConfigRaw = getConfigValueOr<Record<string, unknown>>(config, 'stopRules', {});
  const limitsRaw = (stopRulesConfigRaw['limits'] ?? {}) as Record<string, unknown>;
  const budgetRaw = (stopRulesConfigRaw['budget'] ?? {}) as Record<string, unknown>;
  const noProgressRaw = (stopRulesConfigRaw['noProgress'] ?? {}) as Record<string, unknown>;

  // 注入硬上限（消除 LOOP_LIMITS 与 hardLimits 的双源漂移）
  setLoopLimits({
    maxIterationsHardCap: (hardLimitsRaw['maxIterationsCeiling'] as number) ?? 200,
    maxTokenBudget: (hardLimitsRaw['tokenBudgetCeiling'] as number) ?? 2_000_000,
    maxTimeoutMs: (hardLimitsRaw['timeoutMsCeiling'] as number) ?? 600_000,
    // minTimeoutMs 无配置键，保留默认 5000
  });

  // 构建并登记全局 StopRuleSet（runIteration 据此判定，不再硬重建）
  const activeStopRuleSet = buildStopRuleSet({
    tokenBudget: (loopDefaultsRaw['token_budget'] as number) ?? 100000,
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
    // FE-070：风险触发器装配（此前恒空——risk 类退出只能由子监管异常间接触发）；
    // 配置 `stopRules.riskTriggers` 可覆盖；缺省内置一条“不可恢复工具错误 → 中止”。
    riskTriggers: (stopRulesConfigRaw['riskTriggers'] as Array<{ condition: string; action: 'pause_and_request_approval' | 'abort' | 'rollback_and_abort' }> | undefined) ?? [
      { condition: 'signal == "UNRECOVERABLE_TOOL_ERROR"', action: 'abort' },
    ],
  });
  setActiveStopRuleSet(activeStopRuleSet);

  // ⑮.3 SOP 模板注入（FE-070：complexityAssessor 硬编码外部化；配置缺省用内置默认）
  const sopTemplates = getConfigValueOr<Array<Record<string, unknown>>>(config, 'sopTemplates', []);
  if (Array.isArray(sopTemplates) && sopTemplates.length > 0) {
    configureAssessor({
      knownSops: sopTemplates
        .map((s) => ({
          id: String(s['id'] ?? ''),
          keywords: Array.isArray(s['keywords']) ? (s['keywords'] as unknown[]).map(String) : [],
          domain: String(s['domain'] ?? 'general'),
        }))
        .filter((s) => s.id !== '' && s.keywords.length > 0),
    });
  }

  // 注入 roleOverrides（从 loopConfig.json 读取，消除硬编码）
  const roleOverridesRaw = getConfigValueOr<Record<string, Record<string, unknown>>>(config, 'roleOverrides', {});
  const roleOverrides: Record<string, Partial<LoopConfig>> = {};
  for (const [role, overrides] of Object.entries(roleOverridesRaw)) {
    roleOverrides[role] = {
      max_iterations: typeof overrides['max_iterations'] === 'number' ? overrides['max_iterations'] : undefined,
      token_budget: typeof overrides['token_budget'] === 'number' ? overrides['token_budget'] : undefined,
      temperature: typeof overrides['temperature'] === 'number' ? overrides['temperature'] : undefined,
    };
  }
  setRoleOverrides(roleOverrides);

  // ⑮.1 评审验证配置（FE-056：四级验证管线的 minLevelsRequired 对齐 loopConfig.json 的 verifier 段；
  //   FE-057 分层修正：L3 Judge 调用器由组合根注入——Services 不可直接 import Core/Model）
  const verifierRaw = getConfigValueOr<Record<string, unknown>>(config, 'verifier', {});
  configureReviewer({
    minLevelsRequired: (verifierRaw['minLevelsRequired'] as number) ?? 2,
    callModelFn: async (model, prompt) => {
      const result = await callModel(model, [{ role: 'user', content: prompt }], { temperature: 0 });
      if (!result.ok) throw new Error(result.error);
      return result.value.content;
    },
  });

  // ⑮.2 上下文压缩配置（FE-055：复用 loopConfig.json 的 context 段——
  //   summaryTriggerUsageRatio/outputReserveTokens 推导触发阈值；context.compression 可进一步覆盖）
  const contextRaw = getConfigValueOr<Record<string, unknown>>(config, 'context', {});
  const compressionRaw = (contextRaw['compression'] ?? {}) as Record<string, unknown>;
  configureContextCompression({
    enabled: (compressionRaw['enabled'] as boolean) ?? true,
    triggerTokens: typeof compressionRaw['triggerTokens'] === 'number'
      ? (compressionRaw['triggerTokens'] as number)
      : undefined,
    contextWindowRatio: (compressionRaw['contextWindowRatio'] as number)
      ?? (contextRaw['summaryTriggerUsageRatio'] as number) ?? 0.8,
    outputReserveTokens: (compressionRaw['outputReserveTokens'] as number)
      ?? (contextRaw['outputReserveTokens'] as number) ?? 4096,
    fallbackTriggerTokens: (compressionRaw['fallbackTriggerTokens'] as number) ?? 32_000,
    keepRecentMessages: (compressionRaw['keepRecentMessages'] as number) ?? 6,
    minMessagesToCompress: (compressionRaw['minMessagesToCompress'] as number) ?? 8,
    summaryMaxTokens: (compressionRaw['summaryMaxTokens'] as number) ?? 800,
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
    tokenBudget: (loopDefaultsRaw['token_budget'] as number) ?? 100000,
    warmRatio: (budgetRaw['warmRatio'] as number) ?? 0.36,
    softRatio: (budgetRaw['softRatio'] as number) ?? 0.6,
    expandRequestRatio: (budgetRaw['expandRequestRatio'] as number) ?? 0.8,
    hardRatio: (budgetRaw['hardRatio'] as number) ?? 1.0,
  });

  // ⑯.1 模型定价注册（FE-065：从 providers 段加载——此前 0 注册方，记账因“未注册定价”恒失败）
  if (Array.isArray(routerConfig)) {
    for (const pConfig of routerConfig) {
      const pc = pConfig as Record<string, unknown>;
      const providerName = pc['provider'] as string;
      for (const m of (pc['models'] as Array<Record<string, unknown>> | undefined) ?? []) {
        registerPricing({
          provider: providerName,
          modelId: m['id'] as string,
          costPer1kInput: (m['cost_per_1k_input'] as number) ?? 0,
          costPer1kOutput: (m['cost_per_1k_output'] as number) ?? 0,
          contextWindow: (m['context_window'] as number) ?? 0,
        });
      }
    }
  }

  // ⑯.2 税率周期评估（FE-065：动态调税此前 0 调用方；心跳 60s，内部按 adjustmentIntervalSec 节流）
  startTaxAdjustment(() => {
    const summary = getStatusSummary();
    return (summary.ready ?? 0) + (summary.running ?? 0);
  });

  // ⑲ 治理执法域接线（FE-060/061/062）
  //   · 监管：行为准则初始化（规则集可查 + 工具门可执行）
  //   · 审计：巡检调度/自动解冻/异常检测初始化（周期任务在 HTTP 启动后运行）
  //   · 仲裁：CONFLICT_DETECTED → 六步闭环自动接线（此前 executeFullArbitration 0 生产调用）
  initRegulatoryAuthority();
  const auditRaw = getConfigValueOr<Record<string, unknown>>(config, 'audit', {});
  initAnomalyDetector({
    loopSimilarityThreshold: (auditRaw['loopSimilarityThreshold'] as number) ?? 0.85,
    loopConsecutiveRounds: (auditRaw['loopConsecutiveRounds'] as number) ?? 5,
  });
  resetFreezeManager();
  setAutoUnfreezeSec((auditRaw['freezeAutoUnfreezeSec'] as number) ?? 3600);
  initPatrolScheduler({
    intervalMs: ((auditRaw['patrolIntervalSec'] as number) ?? 86400) * 1000,
    topPercentile: (auditRaw['patrolTopPercentile'] as number) ?? 0.1,
    failureRateThreshold: (auditRaw['patrolFailureRateThreshold'] as number) ?? 0.3,
    windowHours: (auditRaw['patrolWindowHours'] as number) ?? 24,
  });
  // supervision.patrolEnabled=false 时仅保留手动巡检能力（REST），不启周期任务
  const patrolEnabled = (supervisionRaw['patrolEnabled'] as boolean) ?? true;
  if (patrolEnabled) {
    startAuditCycle(((auditRaw['patrolIntervalSec'] as number) ?? 86400) * 1000);
  }
  initArbitrationWiring();
// A2A 治理面（2026-10-05）：注册表↔卡片同步 + 记忆侧通道守卫（设计 §18 #2 / §16）
attachA2AGovernance();
  logger.info('治理执法域接线完成', {
    source: 'main',
    auditIntervalSec: (auditRaw['patrolIntervalSec'] as number) ?? 86400,
  });

  // ⑰ 事件总线
  initEventBus({ maxQueueSize: 10000 });
  initDedupStore({ windowMs: 60_000 });
  initCircuitBreaker({ threshold: 100, windowMs: 60_000, cooldownMs: 120_000 });

  // ⑰.2 AI 组件事件持久化（重启后重建思考/工具卡/分段等组件，v23）
  //   组件族是事件驱动的：事件不落库，重启后组件全部消失（只剩消息正文）。
  startAiEventPersistence();

  // ⑱ 接口层装配
  registerAllRoutes();
  const serverConfig = getConfigValueOr<Record<string, unknown>>(config, 'server', {});
  const httpPort = (serverConfig['httpPort'] as number) ?? 3000;
  const host = (serverConfig['host'] as string) ?? '0.0.0.0';
  const corsOrigins = (serverConfig['corsOrigins'] as string[]) ?? ['http://localhost:5173'];

  await startHttpServer({
    host,
    port: httpPort,
    corsOrigins,
    // 静态托管目录：开发态 = 仓库 `Client/dist`；打包态 = asar 内 `dist/renderer`。
    // 桌面端走 `loadFile`，此处主要服务"浏览器模式/局域网访问"。
    staticDir: [join(getAppRoot(), 'Client', 'dist'), join(getAppRoot(), 'dist', 'renderer')]
      .find(dir => existsSync(dir)),
  });
  logger.info('HTTP 服务器启动', { source: 'main', port: httpPort });

  await startIpcBridge();
  logger.info('IPC 桥接启动', { source: 'main' });

  return { httpPort };
}

// ===== 服务器停止（与 startServer 同实例，供 Electron 主进程调用）=====

/**
 * 关闭后端接口层（HTTP + IPC 桥接）。
 *
 * 由 `electron/main.ts` 在 `window-all-closed` 时调用。
 * 关键：必须走本模块导出的函数，保证停的是**同一个**后端实例——
 * 历史写法在 Electron 侧各自 `import` 一次，拿到的是另一份模块副本，
 * `stopHttpServer()` 实际作用于空对象（服务没停、只是随进程退出）。
 */
export async function stopServer(): Promise<void> {
  await stopHttpServer();
  stopIpcBridge();
}

// ===== 主入口（独立运行模式）=====
async function main(): Promise<void> {
  console.log('═══════════════════════════════════════════');
  console.log('  Civitas-AI v0.1.0 — 智体城邦');
  console.log('═══════════════════════════════════════════');

  try {
    const { httpPort } = await startServer();
    console.log(`[INFO] 服务已启动 — HTTP:${httpPort}`);
    console.log('[INFO] System ready.');
  } catch (err) {
    console.error(`[FATAL] 启动失败: ${err}`);
    process.exit(1);
  }
  
  // 优雅关闭——9 步序列（Docs/Agent/02 §7.2）
  let isShuttingDown = false;
  process.on('SIGINT', async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log('\n[INFO] 开始优雅关闭（9 步序列）...');

    try {
      // ① 停止接收新输入
      console.log('[shutdown ①] 停止接收新输入...');
      await stopHttpServer();
      stopIpcBridge();
      // FE-049：停止仲裁池周期任务（自动扩缩监测 / 空闲回收定时器）
      stopAutoScaling();
      stopIdleRecycling();
      // FE-065：停止税率周期评估
      stopTaxAdjustment();
      // FE-060/061/062：停止治理执法域周期任务与事件接线
      stopAuditCycle();
      stopArbitrationWiring();
    detachA2AGovernance();

      // ② 中断当前模型调用（FE-069：全局中断收口——abort 在途流；中断回复由流 finally 兵底落库）
      console.log('[shutdown ②] 中断活跃模型调用...');
      const abortedStreams = abortAllActiveStreams();
      console.log(`[shutdown ②] 已中断活跃流 ${abortedStreams} 个`);

      // ③ 后置监管（保存/备份）：等待在途流释放（限时 400ms，中断流在 finally 落库后收敛），
      //   随后停事件持久化订阅（此后不再写库）（FE-069 实装，此前为空壳）
      console.log('[shutdown ③] 后置监管（保存/备份）...');
      await new Promise((r) => setTimeout(r, 400));
      stopAiEventPersistence();

      // ④ 生成追踪索引文件（FE-069：trace index writer 实装，≤5s）
      console.log('[shutdown ④] 生成追踪索引...');
      try {
        const traceResult = writeTraceIndex(getLogDir());
        if (traceResult.ok) {
          console.log(`[shutdown ④] 追踪索引已生成: ${traceResult.value}`);
        } else {
          console.warn(`[shutdown ④] 追踪索引生成失败: ${traceResult.error}`);
        }
      } catch (e) {
        console.warn(`[shutdown ④] 追踪索引异常: ${e}`);
      }

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

      // ⑦.5 持久执行底座清理（Docs/Agent/12 §7.3 待办：挂载 purgeExpired）
      // 清理过期幂等缓存，阻止 idempotency_cache 单调增长。
      try {
        const purged = purgeExpired();
        if (purged.ok) {
          console.log(`[shutdown ⑦.5] 清理过期幂等缓存 ${purged.value} 条`);
        }
      } catch (e) {
        console.warn(`[shutdown ⑦.5] 幂等缓存清理失败: ${e}`);
      }

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

/**
 * 独立运行入口守卫。
 *
 * Scripts/build.cjs 会把 Src/main.ts 与 electron/main.ts 一起打包，
 * 因此 Electron 主进程 bundle 会内联本模块；若无条件自启动，
 * 就会与 electron/main.ts 的 startServer() 重复初始化后端
 * （工具重复注册 → "所有工具注册失败" → Electron 启动即退出）。
 *
 * 故：仅在非 Electron 运行时自启动；Electron 下由主进程显式调用 startServer()。
 */
if (!process.versions.electron) {
  main();
}
