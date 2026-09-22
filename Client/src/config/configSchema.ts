/**
 * 核心行为参数 Schema —— 数据
 *
 * 每个字段的 default / 区间 / 枚举取值 / 硬约束均取自唯一事实源
 * `Docs/15-参数总典与接口契约/参数总典.md`（§2 配置键全集 + §4 枚举全集 + §7 硬约束）。
 *
 * 覆盖范围：核心行为参数（循环 / 经济 / 监管 / 仲裁 / 审计 / 路由 / 模型 / 记忆 / 持久 / 系统 / 安全）。
 * 未纳入：benchBaseline / coverageBaseline / dataStorage（属基准记录与非交互运维项）。
 */
import type { FieldDef, ConfigGroup } from './schemaTypes';

/** 分组元数据（侧边栏顺序即此顺序） */
export const CONFIG_GROUPS: ConfigGroup[] = [
  { id: 'loop',   label: '循环控制',   icon: 'RefreshCw',  source: 'loopConfig',   desc: '主循环上限 · 停止规则 · 验证器 · 指纹 · 上下文分区（最高频查阅）' },
  { id: 'model',  label: '模型路由',   icon: 'Cpu',        source: 'modelRouter',  desc: '模型调用超时 · 推理三明治档位 · 角色模型选择' },
  { id: 'routing',label: '编排路由',   icon: 'GitBranch',  source: 'routingRules', desc: '6 种工作方式的命中阈值（DIRECT / DELEGATION / CONSORTIUM / ASSEMBLY_LINE）' },
  { id: 'economy',label: 'Token 经济', icon: 'Wallet',     source: 'economyRules', desc: '发行量 · 税率 · 分润权重 · 滚动窗口 · 预算上限' },
  { id: 'supervision', label: '监管', icon: 'ShieldCheck', source: 'supervision',  desc: '质量阈值 · 并发上限 · 熔断 · 审批超时（fail-closed）' },
  { id: 'arbitration', label: '仲裁', icon: 'Scale',       source: 'arbitration',  desc: '仲裁者池容量 · 扩缩容 · 死锁超时 · 快照存储' },
  { id: 'audit',  label: '审计',       icon: 'Search',     source: 'audit',        desc: '死循环检测 · 巡检 · 自动解冻 · 稽查取数' },
  { id: 'memory', label: '共享记忆',   icon: 'Database',   source: 'memory',       desc: '冲突相似度 · 胶囊预算 · 向量维度 · 事件总线' },
  { id: 'durable',label: '持久执行',   icon: 'HardDrive',  source: 'durable',      desc: '检查点 · 副作用日志 · 幂等 · 恢复策略' },
  { id: 'session',label: '会话与保留', icon: 'History',    source: 'session',      desc: '会话键长 · 归档 · 各类数据保留天数' },
  { id: 'system', label: '系统基础',   icon: 'Settings',   source: 'default',      desc: '日志级别 · 服务端口 · 数据库 · UI 轮询节流' },
  { id: 'security', label: '安全策略', icon: 'Lock',       source: 'security',     desc: '信任分级 · 禁用路径/命令 · 沙箱模式', l0: true },
];

/** 工厂：source 由所属组注入，key 自动生成 */
type FieldInput = Omit<FieldDef, 'key' | 'source'>;
const mk = (source: string) => (f: FieldInput): FieldDef => ({
  ...f, source, key: `${source}::${f.path}`,
});

/* ─────────────────────────── 循环控制 loopConfig.json ─────────────────────────── */
const loop = mk('loopConfig');
const LOOP_FIELDS: FieldDef[] = [
  loop({ path: 'loopDefaults.max_iterations', label: '默认最大轮次', type: 'number', control: 'slider', default: 30, min: 1, max: 200, step: 1, unit: '轮', section: '循环默认值 (LoopConfig)', description: '单层 Loop 迭代轮次上限', constraint: '≤ hardLimits.maxIterationsCeiling (200)' }),
  loop({ path: 'loopDefaults.timeout_ms', label: '单次调用超时', type: 'number', control: 'slider', default: 60000, min: 1000, max: 600000, step: 1000, unit: 'ms', section: '循环默认值 (LoopConfig)', description: '单次模型调用超时（非整轮墙钟）', constraint: '≤ hardLimits.timeoutMsCeiling (600000)' }),
  loop({ path: 'loopDefaults.temperature', label: '默认温度', type: 'number', control: 'slider', default: 0.2, min: 0, max: 2, step: 0.05, section: '循环默认值 (LoopConfig)', description: '采样温度，0 最确定 2 最随机' }),
  loop({ path: 'loopDefaults.token_budget', label: 'Loop 硬预算', type: 'number', control: 'number', default: 100000, min: 1000, max: 2000000, step: 1000, unit: 'token', section: '循环默认值 (LoopConfig)', description: '该 Loop 的 token_budget，四档比例全部相对它', constraint: '≤ hardLimits.tokenBudgetCeiling (2000000)' }),
  loop({ path: 'loopDefaults.stream', label: '流式输出', type: 'boolean', control: 'toggle', default: true, section: '循环默认值 (LoopConfig)', description: '是否以流式方式产出回复' }),
  loop({ path: 'loopDefaults.model', label: '角色模型别名', type: 'enum', control: 'select', default: 'workerModel', options: ['workerModel', 'directorModel', 'verifierModel'], section: '循环默认值 (LoopConfig)', description: '非模型 ID，指向 modelRouter.routing.*' }),

  loop({ path: 'stopRules.limits.maxIterations', label: '停止·最大轮次', type: 'number', control: 'slider', default: 30, min: 1, max: 200, step: 1, unit: '轮', section: '停止规则 (StopRules)', description: '退出类别②上限' }),
  loop({ path: 'stopRules.limits.maxWallClockMs', label: '停止·整轮墙钟', type: 'number', control: 'number', default: 900000, min: 60000, max: 3600000, step: 30000, unit: 'ms', section: '停止规则 (StopRules)', description: '整轮墙钟唯一源', constraint: '≤ maxWallClockMsCeiling (3600000)' }),
  loop({ path: 'stopRules.limits.maxToolCalls', label: '停止·工具调用上限', type: 'number', control: 'number', default: 100, min: 1, max: 1000, step: 10, unit: '次', section: '停止规则 (StopRules)' }),
  loop({ path: 'stopRules.limits.maxConsecutiveErrors', label: '停止·连续错误', type: 'number', control: 'slider', default: 3, min: 1, max: 20, step: 1, unit: '次', section: '停止规则 (StopRules)', description: '单 Loop 内连续失败次数（≠ 开除阈值）' }),

  loop({ path: 'stopRules.budget.warmRatio', label: '预算·预热比例', type: 'number', control: 'slider', default: 0.36, min: 0, max: 1, step: 0.01, section: '预算档位比例', description: '仅记 BUDGET_WARMING，不阻断', constraint: 'warm < soft < expand < hard ≤ 1.0' }),
  loop({ path: 'stopRules.budget.softRatio', label: '预算·软预算比例', type: 'number', control: 'slider', default: 0.6, min: 0, max: 1, step: 0.01, section: '预算档位比例', description: '降级 + 并行÷2 + 继续' }),
  loop({ path: 'stopRules.budget.expandRequestRatio', label: '预算·扩展审批比例', type: 'number', control: 'slider', default: 0.8, min: 0, max: 1, step: 0.01, section: '预算档位比例', description: '触发 budget_expand 审批' }),
  loop({ path: 'stopRules.budget.hardRatio', label: '预算·硬预算比例', type: 'number', control: 'slider', default: 1.0, min: 0, max: 1, step: 0.01, section: '预算档位比例', description: '中止 + 回滚 lastCheckpointId', constraint: '≤ 1.0' }),

  loop({ path: 'stopRules.noProgress.metric', label: '无进展·度量', type: 'enum', control: 'select', default: 'goal_distance', options: ['failed_tests', 'validation_score', 'goal_distance', 'custom'], enumLabels: { failed_tests: '失败用例数', validation_score: '校验得分', goal_distance: '目标距离', custom: '自定义' }, section: '无进展判定 (noProgress)' }),
  loop({ path: 'stopRules.noProgress.stagnationWindowRounds', label: '无进展·停滞窗口', type: 'number', control: 'slider', default: 3, min: 1, max: 20, step: 1, unit: '轮', section: '无进展判定 (noProgress)' }),
  loop({ path: 'stopRules.noProgress.minDeltaRatio', label: '无进展·最小增益', type: 'number', control: 'slider', default: 0.05, min: 0, max: 1, step: 0.01, section: '无进展判定 (noProgress)' }),
  loop({ path: 'stopRules.noProgress.action', label: '无进展·动作', type: 'enum', control: 'segmented', default: 'switch_strategy', options: ['switch_strategy', 'escalate_human', 'abort'], enumLabels: { switch_strategy: '换策略', escalate_human: '转人工', abort: '中止' }, section: '无进展判定 (noProgress)', description: 'NextAction 子集（无进展时请求审批无意义）' }),

  loop({ path: 'verifier.minLevelsRequired', label: '验证·最低层级数', type: 'number', control: 'slider', default: 2, min: 2, max: 4, step: 1, unit: '层', section: '验证器 (Verifier)', description: '每 Loop 至少 L1 + 一层更高（禁只用 L3）', constraint: '≥ 2' }),
  loop({ path: 'verifier.l3MinAgreementWithHuman', label: '验证·L3 人机一致率', type: 'number', control: 'slider', default: 0.85, min: 0, max: 1, step: 0.01, section: '验证器 (Verifier)', constraint: '不得 < 0.8（Judge 校准下限）' }),
  loop({ path: 'verifier.l3RecalibrateIntervalDay', label: '验证·L3 再校准周期', type: 'number', control: 'number', default: 90, min: 1, max: 365, step: 1, unit: '天', section: '验证器 (Verifier)', description: '超期未校准 → L3 不可用，降级 L2' }),
  loop({ path: 'verifier.antiGamingMaxChangedFiles', label: '验证·防刷改动上限', type: 'number', control: 'slider', default: 8, min: 1, max: 50, step: 1, unit: '文件', section: '验证器 (Verifier)', description: '单轮改动文件数超过即视为绕过' }),

  loop({ path: 'fingerprint.consecutiveDuplicateRounds', label: '指纹·连续重复轮', type: 'number', control: 'slider', default: 3, min: 1, max: 20, step: 1, unit: '轮', section: '行为指纹 (Fingerprint)', description: '连续 N 轮完全相同 → 强制终止（引擎层）' }),
  loop({ path: 'fingerprint.windowRounds', label: '指纹·滑动窗口', type: 'number', control: 'slider', default: 5, min: 1, max: 30, step: 1, unit: '轮', section: '行为指纹 (Fingerprint)' }),
  loop({ path: 'fingerprint.windowHitThreshold', label: '指纹·窗内命中阈值', type: 'number', control: 'slider', default: 3, min: 1, max: 30, step: 1, unit: '次', section: '行为指纹 (Fingerprint)' }),

  loop({ path: 'goalReanchor.reanchorEveryRounds', label: '目标重锚·周期', type: 'number', control: 'slider', default: 5, min: 1, max: 30, step: 1, unit: '轮', section: '目标重锚 / 上下文' }),
  loop({ path: 'goalReanchor.alwaysOnAfterCompression', label: '目标重锚·压缩后必重锚', type: 'boolean', control: 'toggle', default: true, section: '目标重锚 / 上下文', description: '防目标漂移' }),
  loop({ path: 'context.outputReserveTokens', label: '上下文·输出预留', type: 'number', control: 'number', default: 4096, min: 256, max: 32000, step: 256, unit: 'token', section: '目标重锚 / 上下文', description: '先从 context_window 扣除，余量为分区预算基数' }),
  loop({ path: 'context.truncationUsageRatio', label: '上下文·截断触发线', type: 'number', control: 'slider', default: 0.92, min: 0, max: 1, step: 0.01, section: '目标重锚 / 上下文' }),
  loop({ path: 'context.summaryTriggerUsageRatio', label: '上下文·压缩监听线', type: 'number', control: 'slider', default: 0.80, min: 0, max: 1, step: 0.01, section: '目标重锚 / 上下文', description: 'skill 强制 80%' }),
  loop({ path: 'context.scoreCompressThreshold', label: '上下文·低分丢弃线', type: 'number', control: 'slider', default: 0.30, min: 0, max: 1, step: 0.01, section: '目标重锚 / 上下文' }),
];

/* ─────────────────────────── 模型路由 modelRouter.json ─────────────────────────── */
const model = mk('modelRouter');
const MODEL_FIELDS: FieldDef[] = [
  model({ path: 'routing.timeoutMs', label: '模型调用超时', type: 'number', control: 'slider', default: 60000, min: 5000, max: 300000, step: 5000, unit: 'ms', section: '路由超时' }),
  model({ path: 'routing.firstByteTimeoutMs', label: '流式首字节超时', type: 'number', control: 'slider', default: 10000, min: 1000, max: 60000, step: 1000, unit: 'ms', section: '路由超时', description: 'skill 强制' }),
  model({ path: 'routing.interChunkTimeoutMs', label: '块间超时', type: 'number', control: 'slider', default: 15000, min: 1000, max: 120000, step: 1000, unit: 'ms', section: '路由超时' }),
  model({ path: 'routing.defaultModel', label: '默认模型', type: 'enum', control: 'select', default: 'huawei-maas/DeepSeek-V4-Flash', options: ['huawei-maas/GLM-5.1', 'huawei-maas/DeepSeek-V4-Flash', 'huawei-maas/Kimi-K2.6'], section: '角色模型选择' }),
  model({ path: 'routing.directorModel', label: 'Director 模型', type: 'enum', control: 'select', default: 'huawei-maas/GLM-5.1', options: ['huawei-maas/GLM-5.1', 'huawei-maas/DeepSeek-V4-Flash', 'huawei-maas/Kimi-K2.6'], section: '角色模型选择' }),
  model({ path: 'routing.workerModel', label: 'Worker 模型', type: 'enum', control: 'select', default: 'huawei-maas/DeepSeek-V4-Flash', options: ['huawei-maas/GLM-5.1', 'huawei-maas/DeepSeek-V4-Flash', 'huawei-maas/Kimi-K2.6'], section: '角色模型选择' }),
  model({ path: 'routing.verifierModel', label: 'Verifier 模型', type: 'enum', control: 'select', default: 'huawei-maas/GLM-5.1', options: ['huawei-maas/GLM-5.1', 'huawei-maas/DeepSeek-V4-Flash', 'huawei-maas/Kimi-K2.6'], section: '角色模型选择', description: 'Maker≠Checker', constraint: '必须 ≠ producerModel (ADR-0004)' }),
  model({ path: 'reasoningSandwich.enabled', label: '推理三明治总开关', type: 'boolean', control: 'toggle', default: true, section: '推理三明治' }),
  model({ path: 'reasoningSandwich.planningTier', label: '规划档位', type: 'enum', control: 'segmented', default: 'strong', options: ['strong', 'economic'], enumLabels: { strong: '强模型', economic: '经济模型' }, section: '推理三明治' }),
  model({ path: 'reasoningSandwich.actingTier', label: '执行档位', type: 'enum', control: 'segmented', default: 'economic', options: ['strong', 'economic'], enumLabels: { strong: '强模型', economic: '经济模型' }, section: '推理三明治' }),
  model({ path: 'reasoningSandwich.verifyingTier', label: '验证档位', type: 'enum', control: 'segmented', default: 'strong', options: ['strong', 'economic'], enumLabels: { strong: '强模型', economic: '经济模型' }, section: '推理三明治', locked: '不得降为 economic（软预算降级也必须保留强验证）' }),
];

/* ─────────────────────────── 编排路由 routingRules.json ─────────────────────────── */
const routing = mk('routingRules');
const ROUTING_FIELDS: FieldDef[] = [
  routing({ path: 'routing.directExecMaxTokens', label: 'DIRECT 上限 Token', type: 'number', control: 'number', default: 10000, min: 1000, max: 50000, step: 1000, unit: 'token', section: '工作方式命中阈值', description: '≤ 则走 Direct 直执' }),
  routing({ path: 'routing.consortiumTokenThreshold', label: 'CONSORTIUM Token 阈值', type: 'number', control: 'number', default: 50000, min: 10000, max: 500000, step: 10000, unit: 'token', section: '工作方式命中阈值', description: '≥ 则升 Consortium（多专家并联）' }),
  routing({ path: 'routing.consortiumDomainThreshold', label: 'CONSORTIUM 领域阈值', type: 'number', control: 'slider', default: 2, min: 1, max: 8, step: 1, unit: '域', section: '工作方式命中阈值', description: '≥ 则需跨领域协作' }),
  routing({ path: 'routing.delegationMaxCouplingScore', label: 'DELEGATION 耦合度上限', type: 'number', control: 'slider', default: 0.3, min: 0, max: 1, step: 0.05, section: '工作方式命中阈值', description: '≤ 才可拆给多 Worker' }),
  routing({ path: 'routing.delegationMinSubtaskCount', label: 'DELEGATION 最少子任务', type: 'number', control: 'slider', default: 2, min: 1, max: 20, step: 1, unit: '个', section: '工作方式命中阈值', description: '< 则不值得委派，走 Direct' }),
  routing({ path: 'routing.assemblyLineSopRequired', label: 'ASSEMBLY_LINE 强制 SOP', type: 'boolean', control: 'toggle', default: true, section: '工作方式命中阈值', description: '流水线模式强制匹配 SOP（Skills/playbooks/）' }),
];

/* ─────────────────────────── Token 经济 economyRules.json ─────────────────────────── */
const econ = mk('economyRules');
const ECONOMY_FIELDS: FieldDef[] = [
  econ({ path: 'economy.initialSupply', label: '初始发行量', type: 'number', control: 'number', default: 1000000, min: 100000, max: 10000000, step: 100000, unit: 'token', section: '货币与钱包' }),
  econ({ path: 'economy.defaultWalletBalance', label: '新 Agent 默认余额', type: 'number', control: 'number', default: 10000, min: 1000, max: 1000000, step: 1000, unit: 'token', section: '货币与钱包' }),
  econ({ path: 'economy.tax.dynamicEnabled', label: '动态税率开关', type: 'boolean', control: 'toggle', default: true, section: '税收' }),
  econ({ path: 'economy.tax.baseRate', label: '基础税率', type: 'number', control: 'slider', default: 0.05, min: 0, max: 1, step: 0.01, section: '税收', constraint: 'minRate ≤ baseRate ≤ maxRate' }),
  econ({ path: 'economy.tax.minRate', label: '最低税率', type: 'number', control: 'slider', default: 0.02, min: 0, max: 1, step: 0.01, section: '税收' }),
  econ({ path: 'economy.tax.maxRate', label: '最高税率', type: 'number', control: 'slider', default: 0.20, min: 0, max: 1, step: 0.01, section: '税收' }),
  econ({ path: 'economy.tax.highLoadMultiplier', label: '高负载倍率', type: 'number', control: 'slider', default: 1.5, min: 1, max: 5, step: 0.1, unit: '×', section: '税收' }),
  econ({ path: 'economy.tax.lowLoadDiscount', label: '低负载折扣', type: 'number', control: 'slider', default: 0.8, min: 0, max: 1, step: 0.05, unit: '×', section: '税收' }),
  econ({ path: 'economy.tax.loadThresholdAgents', label: '负载阈值 Agent 数', type: 'number', control: 'slider', default: 10, min: 1, max: 100, step: 1, unit: '个', section: '税收' }),
  econ({ path: 'economy.profitSharing.qualityWeight', label: '分润·质量权重', type: 'number', control: 'slider', default: 0.5, min: 0, max: 1, step: 0.05, section: '分润权重', constraint: '质量+数量+效率 = 1.0' }),
  econ({ path: 'economy.profitSharing.quantityWeight', label: '分润·数量权重', type: 'number', control: 'slider', default: 0.3, min: 0, max: 1, step: 0.05, section: '分润权重' }),
  econ({ path: 'economy.profitSharing.efficiencyWeight', label: '分润·效率权重', type: 'number', control: 'slider', default: 0.2, min: 0, max: 1, step: 0.05, section: '分润权重' }),
  econ({ path: 'economy.rollingWindow.tokens', label: '滚动窗口·消耗上限', type: 'number', control: 'number', default: 10000, min: 1000, max: 200000, step: 1000, unit: 'token', section: '滚动窗口' }),
  econ({ path: 'economy.rollingWindow.windowSec', label: '滚动窗口·时长', type: 'number', control: 'number', default: 300, min: 30, max: 3600, step: 30, unit: '秒', section: '滚动窗口' }),
  econ({ path: 'economy.rollingWindow.deviationMultiplierWarn', label: '偏离告警倍数', type: 'number', control: 'slider', default: 3, min: 1, max: 20, step: 0.5, unit: '×', section: '滚动窗口' }),
  econ({ path: 'economy.rollingWindow.deviationMultiplierCritical', label: '偏离危险倍数', type: 'number', control: 'slider', default: 5, min: 1, max: 20, step: 0.5, unit: '×', section: '滚动窗口' }),
  econ({ path: 'economy.budgetLimits.singleCallMaxTokens', label: '单次调用上限', type: 'number', control: 'number', default: 5000, min: 500, max: 100000, step: 500, unit: 'token', section: '预算上限' }),
  econ({ path: 'economy.budgetLimits.globalTraceHardTokens', label: 'trace 级硬预算', type: 'number', control: 'number', default: 200000, min: 10000, max: 2000000, step: 10000, unit: 'token', section: '预算上限', description: '整 trace_id 硬预算（跨 Loop）' }),
  econ({ path: 'economy.budgetLimits.globalTraceSoftRatio', label: 'trace 级软预算比例', type: 'number', control: 'slider', default: 0.6, min: 0, max: 1, step: 0.01, section: '预算上限' }),
];

/* ─────────────────────────── 监管 supervision.json ─────────────────────────── */
const sup = mk('supervision');
const SUPERVISION_FIELDS: FieldDef[] = [
  sup({ path: 'supervision.qualityThreshold', label: '质量阈值', type: 'number', control: 'slider', default: 0.60, min: 0, max: 1, step: 0.01, section: '质量与淘汰', description: '低于此 → 质量告警' }),
  sup({ path: 'supervision.agentConsecutiveFailuresToExpel', label: '开除·连续失败次数', type: 'number', control: 'slider', default: 3, min: 1, max: 20, step: 1, unit: '次', section: '质量与淘汰', description: '跨任务次数（≠ 单 Loop 内 maxConsecutiveErrors）' }),
  sup({ path: 'supervision.patrolEnabled', label: '巡检开关', type: 'boolean', control: 'toggle', default: true, section: '质量与淘汰' }),
  sup({ path: 'supervision.maxConcurrentLoopsGlobal', label: '全局并发 Loop 上限', type: 'number', control: 'slider', default: 20, min: 1, max: 200, step: 1, unit: '个', section: '并发与熔断' }),
  sup({ path: 'supervision.maxConcurrentLoopsPerUser', label: '单会话并发上限', type: 'number', control: 'slider', default: 5, min: 1, max: 100, step: 1, unit: '个', section: '并发与熔断' }),
  sup({ path: 'supervision.stormBreakerThresholdPerMin', label: '熔断触发线', type: 'number', control: 'number', default: 100, min: 1, max: 10000, step: 10, unit: '次/分', section: '并发与熔断' }),
  sup({ path: 'supervision.stormBreakerOpenSec', label: '熔断保持时间', type: 'number', control: 'number', default: 60, min: 5, max: 3600, step: 5, unit: '秒', section: '并发与熔断' }),
  sup({ path: 'supervision.broadcastAckTimeoutSec', label: '广播 ACK 期限', type: 'number', control: 'number', default: 300, min: 10, max: 3600, step: 10, unit: '秒', section: '触发去重' }),
  sup({ path: 'supervision.triggerDedupWindowSec', label: '触发去重窗', type: 'number', control: 'number', default: 300, min: 10, max: 3600, step: 10, unit: '秒', section: '触发去重', description: '防风暴' }),
  sup({ path: 'supervision.triggerCooldownSec', label: '同规则冷却', type: 'number', control: 'number', default: 30, min: 1, max: 3600, step: 5, unit: '秒', section: '触发去重' }),
  sup({ path: 'supervision.lawyerLetterDedupWindowSec', label: '律师函去重窗', type: 'number', control: 'number', default: 300, min: 10, max: 3600, step: 10, unit: '秒', section: '触发去重' }),
  sup({ path: 'supervision.approvalTimeoutSec', label: '审批超时（全局唯一源）', type: 'number', control: 'number', default: 60, min: 5, max: 3600, step: 5, unit: '秒', section: '审批' }),
  sup({ path: 'supervision.approvalDefaultOnTimeout', label: '审批超时默认动作', type: 'enum', control: 'segmented', default: 'reject', options: ['reject', 'abort_loop'], enumLabels: { reject: '拒绝', abort_loop: '中止 Loop' }, section: '审批', locked: '禁止 approve（fail-closed）' }),
  sup({ path: 'supervision.criticalApprovalRoles', label: 'CRITICAL 审批角色数', type: 'number', control: 'slider', default: 2, min: 1, max: 5, step: 1, unit: '个', section: '审批', description: 'risk_level=CRITICAL 时强制 unanimous' }),
];

/* ─────────────────────────── 仲裁 arbitration.json ─────────────────────────── */
const arb = mk('arbitration');
const ARBITRATION_FIELDS: FieldDef[] = [
  arb({ path: 'arbitration.coreArbitrators', label: '核心层常驻数', type: 'number', control: 'slider', default: 1, min: 1, max: 15, step: 1, unit: '个', section: '仲裁者池', description: '不随负载缩' }),
  arb({ path: 'arbitration.caseArbitratorCount', label: '单案并发裁决数', type: 'number', control: 'slider', default: 3, min: 1, max: 15, step: 1, unit: '个', section: '仲裁者池', description: '多数决需 ≥3', constraint: '多数决前提 ≥ 3' }),
  arb({ path: 'arbitration.minArbitrators', label: '辅助池下限', type: 'number', control: 'slider', default: 1, min: 1, max: 15, step: 1, unit: '个', section: '仲裁者池' }),
  arb({ path: 'arbitration.maxArbitrators', label: '辅助池上限', type: 'number', control: 'slider', default: 15, min: 1, max: 64, step: 1, unit: '个', section: '仲裁者池' }),
  arb({ path: 'arbitration.frequencyThreshold', label: '扩容触发线', type: 'number', control: 'slider', default: 5, min: 1, max: 100, step: 1, unit: '次/窗', section: '扩缩容' }),
  arb({ path: 'arbitration.frequencyWindowSec', label: '频率窗口', type: 'number', control: 'number', default: 300, min: 30, max: 3600, step: 30, unit: '秒', section: '扩缩容' }),
  arb({ path: 'arbitration.scaleUpFactor', label: '扩容倍率', type: 'number', control: 'slider', default: 2.0, min: 1, max: 5, step: 0.1, unit: '×', section: '扩缩容' }),
  arb({ path: 'arbitration.scaleDownFactor', label: '缩容倍率', type: 'number', control: 'slider', default: 0.5, min: 0, max: 1, step: 0.05, unit: '×', section: '扩缩容' }),
  arb({ path: 'arbitration.monitoringIntervalSec', label: '监控周期', type: 'number', control: 'number', default: 60, min: 5, max: 3600, step: 5, unit: '秒', section: '扩缩容' }),
  arb({ path: 'arbitration.deadlockTimeoutSec', label: '死锁超时', type: 'number', control: 'number', default: 120, min: 10, max: 3600, step: 10, unit: '秒', section: '扩缩容', description: '裁决超时 → ARBITRATION_DEADLOCK' }),
  arb({ path: 'arbitration.memoryPerArbitratorMb', label: '每仲裁者内存', type: 'number', control: 'number', default: 256, min: 64, max: 4096, step: 64, unit: 'MB', section: '资源配额' }),
  arb({ path: 'arbitration.cpuPerArbitratorCores', label: '每仲裁者 CPU', type: 'number', control: 'slider', default: 0.1, min: 0.1, max: 8, step: 0.1, unit: '核', section: '资源配额' }),
  arb({ path: 'arbitration.snapshotStore', label: '快照存储', type: 'enum', control: 'segmented', default: 'sqlite', options: ['sqlite', 'redis'], section: '资源配额', locked: 'Phase 0–2 强制 sqlite（禁 Redis 三连）' }),
];

/* ─────────────────────────── 审计 audit.json ─────────────────────────── */
const aud = mk('audit');
const AUDIT_FIELDS: FieldDef[] = [
  aud({ path: 'audit.loopSimilarityThreshold', label: '行为指纹相似度', type: 'number', control: 'slider', default: 0.85, min: 0, max: 1, step: 0.01, section: '死循环检测', description: '≠ memory.conflictSimilarityThreshold（同值不同义）' }),
  aud({ path: 'audit.loopConsecutiveRounds', label: '连续重复轮（审计层）', type: 'number', control: 'slider', default: 5, min: 1, max: 30, step: 1, unit: '轮', section: '死循环检测', description: '审计维度告警（引擎层 3 轮硬终止并存）' }),
  aud({ path: 'audit.patrolIntervalSec', label: '巡检周期', type: 'number', control: 'number', default: 86400, min: 300, max: 604800, step: 3600, unit: '秒', section: '巡检' }),
  aud({ path: 'audit.patrolTopPercentile', label: '巡检·消耗 Top 分位', type: 'number', control: 'slider', default: 0.1, min: 0, max: 1, step: 0.05, section: '巡检', description: 'Top 10% 标"需关注"' }),
  aud({ path: 'audit.patrolFailureRateThreshold', label: '巡检·失败率阈值', type: 'number', control: 'slider', default: 0.3, min: 0, max: 1, step: 0.05, section: '巡检' }),
  aud({ path: 'audit.patrolWindowHours', label: '巡检窗口', type: 'number', control: 'number', default: 24, min: 1, max: 720, step: 1, unit: '小时', section: '巡检' }),
  aud({ path: 'audit.freezeAutoUnfreezeSec', label: '自动解冻时限', type: 'number', control: 'number', default: 3600, min: 60, max: 86400, step: 60, unit: '秒', section: '冻结', description: "initiator='system'" }),
  aud({ path: 'audit.auditRecentOpsCount', label: '稽查·近期操作条数', type: 'number', control: 'slider', default: 50, min: 1, max: 500, step: 10, unit: '条', section: '稽查取数' }),
  aud({ path: 'audit.auditRecentTxCount', label: '稽查·近期事务条数', type: 'number', control: 'slider', default: 20, min: 1, max: 500, step: 10, unit: '条', section: '稽查取数' }),
];

/* ─────────────────────────── 共享记忆 memory.json ─────────────────────────── */
const mem = mk('memory');
const MEMORY_FIELDS: FieldDef[] = [
  mem({ path: 'memory.conflictSimilarityThreshold', label: '写入冲突相似度', type: 'number', control: 'slider', default: 0.85, min: 0, max: 1, step: 0.01, section: '记忆', description: '写入冲突检测唯一阈值' }),
  mem({ path: 'memory.capsuleBudgetTokens', label: '冲突胶囊总预算', type: 'number', control: 'number', default: 4000, min: 500, max: 100000, step: 500, unit: 'token', section: '记忆' }),
  mem({ path: 'memory.capsuleMemoryTopK', label: '语义召回 Top K', type: 'number', control: 'slider', default: 5, min: 1, max: 50, step: 1, unit: '条', section: '记忆' }),
  mem({ path: 'memory.vectorDim', label: '向量维度', type: 'number', control: 'number', default: 1536, min: 1, max: 8192, step: 1, unit: '维', section: '记忆', constraint: '换 embedding 模型必须同步改；不符 → 启动失败' }),
  mem({ path: 'memory.privateStateTtlSec', label: '私有态 TTL', type: 'number', control: 'number', default: 3600, min: 60, max: 86400, step: 60, unit: '秒', section: '记忆' }),
  mem({ path: 'memory.supersedeGraceSec', label: '版本取代宽限期', type: 'number', control: 'number', default: 60, min: 0, max: 3600, step: 10, unit: '秒', section: '记忆' }),
  mem({ path: 'eventBus.maxQueueSize', label: '事件总线·队列上限', type: 'number', control: 'number', default: 10000, min: 100, max: 1000000, step: 100, unit: '条', section: '事件总线', description: '满则丢弃 + WARN，不阻塞主流程' }),
  mem({ path: 'eventBus.consumerTimeoutMs', label: '事件总线·消费超时', type: 'number', control: 'number', default: 30000, min: 1000, max: 300000, step: 1000, unit: 'ms', section: '事件总线' }),
  mem({ path: 'eventBus.retryMaxAttempts', label: '事件总线·重试次数', type: 'number', control: 'slider', default: 1, min: 0, max: 10, step: 1, unit: '次', section: '事件总线', description: '事件不保证 exactly-once' }),
  mem({ path: 'eventBus.deadLetterKeepDays', label: '事件总线·死信保留', type: 'number', control: 'number', default: 7, min: 1, max: 365, step: 1, unit: '天', section: '事件总线' }),
  mem({ path: 'eventBus.store', label: '事件总线存储', type: 'enum', control: 'segmented', default: 'in-memory', options: ['in-memory', 'redis'], section: '事件总线', locked: 'Phase 0–2 强制 in-memory' }),
];

/* ─────────────────────────── 持久执行 durable.json ─────────────────────────── */
const dur = mk('durable');
const DURABLE_FIELDS: FieldDef[] = [
  dur({ path: 'durable.checkpoint.everyIteration', label: '每轮必写', type: 'boolean', control: 'toggle', default: true, section: '检查点', description: '失败轮也写，供回滚' }),
  dur({ path: 'durable.checkpoint.afterEachEffect', label: '每个副作用后写', type: 'boolean', control: 'toggle', default: true, section: '检查点' }),
  dur({ path: 'durable.checkpoint.beforeCompression', label: '压缩前写', type: 'boolean', control: 'toggle', default: true, section: '检查点', description: '防 State 与 Context 脱节' }),
  dur({ path: 'durable.checkpoint.fallbackIntervalSec', label: '兜底写入周期', type: 'number', control: 'number', default: 60, min: 5, max: 3600, step: 5, unit: '秒', section: '检查点' }),
  dur({ path: 'durable.checkpoint.keepLastCount', label: '每 Loop 保留检查点数', type: 'number', control: 'slider', default: 20, min: 1, max: 200, step: 1, unit: '个', section: '检查点', description: 'loop_checkpoints 保留策略唯一源' }),
  dur({ path: 'durable.effect.defaultTimeoutMs', label: '副作用默认超时', type: 'number', control: 'number', default: 30000, min: 1000, max: 300000, step: 1000, unit: 'ms', section: '副作用日志' }),
  dur({ path: 'durable.effect.journalRetentionDays', label: '日志保留天数', type: 'number', control: 'number', default: 180, min: 1, max: 3650, step: 30, unit: '天', section: '副作用日志', description: 'effect_journal 保留策略唯一源' }),
  dur({ path: 'durable.effect.pendingAlertThreshold', label: 'PENDING 堆积告警', type: 'number', control: 'slider', default: 100, min: 1, max: 1000, step: 10, unit: '条', section: '副作用日志' }),
  dur({ path: 'durable.effect.unknownAlertThreshold', label: 'UNKNOWN 告警阈值', type: 'number', control: 'slider', default: 1, min: 1, max: 100, step: 1, unit: '条', section: '副作用日志', description: '出现 1 条 UNKNOWN 即告警（最严）' }),
  dur({ path: 'durable.effect.writeSynchronous', label: 'SQLite synchronous', type: 'enum', control: 'segmented', default: 'FULL', options: ['OFF', 'NORMAL', 'FULL'], section: '副作用日志', locked: '不得降为 NORMAL/OFF（掉电丢 journal = 失去 UNKNOWN 恢复能力）' }),
  dur({ path: 'durable.idempotency.cacheTtlHour', label: '幂等缓存 TTL', type: 'number', control: 'number', default: 24, min: 1, max: 720, step: 1, unit: '小时', section: '幂等与恢复', description: 'idempotency_cache 保留策略唯一源' }),
  dur({ path: 'durable.idempotency.store', label: '幂等存储', type: 'enum', control: 'segmented', default: 'sqlite', options: ['sqlite', 'redis'], section: '幂等与恢复', locked: 'Phase 0–2 强制 sqlite' }),
  dur({ path: 'durable.recovery.autoResumeMaxUnknownEffects', label: '自动恢复容忍 UNKNOWN 数', type: 'number', control: 'slider', default: 0, min: 0, max: 10, step: 1, unit: '条', section: '幂等与恢复', locked: '硬规则：存在任何 UNKNOWN → 禁自动恢复，不得 > 0' }),
  dur({ path: 'durable.recovery.autoResumeMaxBudgetUsedRatio', label: '自动恢复预算上限比例', type: 'number', control: 'slider', default: 0.8, min: 0, max: 1, step: 0.05, section: '幂等与恢复' }),
  dur({ path: 'durable.recovery.requireHumanOnArtifactDrift', label: '产物漂移需人工', type: 'boolean', control: 'toggle', default: true, section: '幂等与恢复', description: 'AUTO_RESUME 前置④' }),
];

/* ─────────────────────────── 会话与保留 session.json ─────────────────────────── */
const ses = mk('session');
const SESSION_FIELDS: FieldDef[] = [
  ses({ path: 'session.sessionKeyHexLength', label: 'session_key 十六进制位', type: 'number', control: 'slider', default: 16, min: 8, max: 64, step: 1, unit: '位', section: '会话', description: 'SHA-256 前 N 位' }),
  ses({ path: 'session.archiveInactiveDays', label: '不活跃归档天数', type: 'number', control: 'number', default: 30, min: 1, max: 3650, step: 1, unit: '天', section: '会话' }),
  ses({ path: 'session.historyMaxMessagesInMemory', label: '内存驻留消息上限', type: 'number', control: 'number', default: 200, min: 10, max: 10000, step: 10, unit: '条', section: '会话' }),
  ses({ path: 'retention.tasksActiveDays', label: 'tasks 保留', type: 'number', control: 'number', default: 30, min: 1, max: 3650, step: 1, unit: '天', section: '数据保留 (retention)' }),
  ses({ path: 'retention.agentsDestroyedDays', label: 'agents（已销毁）保留', type: 'number', control: 'number', default: 90, min: 1, max: 3650, step: 1, unit: '天', section: '数据保留 (retention)' }),
  ses({ path: 'retention.operationHistoryDays', label: 'operation_history 保留', type: 'number', control: 'number', default: 180, min: 1, max: 3650, step: 1, unit: '天', section: '数据保留 (retention)' }),
  ses({ path: 'retention.eventsDays', label: 'events 保留', type: 'number', control: 'number', default: 90, min: 1, max: 3650, step: 1, unit: '天', section: '数据保留 (retention)' }),
  ses({ path: 'retention.loopsCompletedDays', label: 'loops（终态）保留', type: 'number', control: 'number', default: 90, min: 1, max: 3650, step: 1, unit: '天', section: '数据保留 (retention)' }),
  ses({ path: 'retention.longTermMemoryPermanent', label: '长期记忆永久保留', type: 'boolean', control: 'toggle', default: true, section: '数据保留 (retention)', locked: '审计要求，建议恒为 true' }),
  ses({ path: 'retention.tokenTransactionsPermanent', label: 'Token 流水永久保留', type: 'boolean', control: 'toggle', default: true, section: '数据保留 (retention)', locked: '审计法定留存，建议恒为 true' }),
];

/* ─────────────────────────── 系统基础 default.json ─────────────────────────── */
const sys = mk('default');
const SYSTEM_FIELDS: FieldDef[] = [
  sys({ path: 'system.logLevel', label: '日志级别', type: 'enum', control: 'segmented', default: 'info', options: ['debug', 'info', 'warn', 'error', 'fatal'], section: '系统', description: '热更新会重开日志句柄' }),
  sys({ path: 'server.httpPort', label: 'HTTP 端口', type: 'number', control: 'number', default: 3000, min: 1, max: 65535, step: 1, section: '服务端口' }),
  sys({ path: 'server.wsPort', label: 'WebSocket 端口', type: 'number', control: 'number', default: 3001, min: 1, max: 65535, step: 1, section: '服务端口', description: '与 HTTP 分离，便于独立限流' }),
  sys({ path: 'database.walMode', label: 'SQLite WAL 模式', type: 'boolean', control: 'toggle', default: true, section: '数据库', description: '关闭会导致恢复能力降级' }),
  sys({ path: 'database.busyTimeoutMs', label: 'busy 超时', type: 'number', control: 'number', default: 5000, min: 100, max: 60000, step: 100, unit: 'ms', section: '数据库' }),
  sys({ path: 'ui.dashboardPollIntervalSec', label: '大屏轮询周期', type: 'number', control: 'number', default: 5, min: 1, max: 300, step: 1, unit: '秒', section: 'UI 节流' }),
  sys({ path: 'ui.approvalQueueRefreshSec', label: '审批队列刷新', type: 'number', control: 'number', default: 3, min: 1, max: 300, step: 1, unit: '秒', section: 'UI 节流' }),
  sys({ path: 'ui.streamFlushIntervalMs', label: '流式批量合并', type: 'number', control: 'number', default: 100, min: 16, max: 5000, step: 16, unit: 'ms', section: 'UI 节流', description: '禁逐 token 推送' }),
  sys({ path: 'ui.maxEventBufferSize', label: '事件缓冲上限', type: 'number', control: 'number', default: 500, min: 50, max: 10000, step: 50, unit: '条', section: 'UI 节流', description: '超限丢最旧，不阻断' }),
  sys({ path: 'ui.wsReconnectBackoffMs', label: 'WS 重连退避基数', type: 'number', control: 'number', default: 1000, min: 100, max: 30000, step: 100, unit: 'ms', section: 'UI 节流', description: '指数退避基数' }),
  sys({ path: 'ui.wsReconnectMaxAttempts', label: 'WS 重连最大次数', type: 'number', control: 'slider', default: 5, min: 1, max: 50, step: 1, unit: '次', section: 'UI 节流', description: '耗尽后降级纯轮询 + 离线横幅' }),
];

/* ─────────────────────────── 安全策略 security.json（L0） ─────────────────────────── */
const sec = mk('security');
const SECURITY_FIELDS: FieldDef[] = [
  sec({ path: 'security.trustLevels.systemRoles', label: '系统信任角色', type: 'string[]', control: 'tags', default: ['prime_director', 'arbitrator', 'regulator', 'auditor'], section: '信任分级' }),
  sec({ path: 'security.trustLevels.userRoles', label: '用户信任角色', type: 'string[]', control: 'tags', default: ['partner', 'worker', 'assembly_node', 'reviewer'], section: '信任分级' }),
  sec({ path: 'security.sandboxDefaultMode', label: '沙箱默认模式', type: 'enum', control: 'segmented', default: 'standard', options: ['strict', 'standard', 'none'], enumLabels: { strict: '严格', standard: '标准', none: '关闭' }, section: '沙箱', description: '生产建议 strict' }),
  sec({ path: 'security.forbiddenPaths', label: '禁用路径', type: 'string[]', control: 'tags', default: ['Data/Auth/', '~/.ssh/'], section: '黑名单' }),
  sec({ path: 'security.forbiddenCommands', label: '禁用命令', type: 'string[]', control: 'tags', default: ['rm -rf /', ':(){ :|:& };:'], section: '黑名单' }),
  sec({ path: 'security.networkWhitelist', label: '网络白名单', type: 'string[]', control: 'tags', default: [], section: '黑名单', description: '空 = 依沙箱模式默认策略' }),
];

/* ─────────────────────────── 汇总导出 ─────────────────────────── */
export const CONFIG_SCHEMA: Record<string, FieldDef[]> = {
  loop: LOOP_FIELDS,
  model: MODEL_FIELDS,
  routing: ROUTING_FIELDS,
  economy: ECONOMY_FIELDS,
  supervision: SUPERVISION_FIELDS,
  arbitration: ARBITRATION_FIELDS,
  audit: AUDIT_FIELDS,
  memory: MEMORY_FIELDS,
  durable: DURABLE_FIELDS,
  session: SESSION_FIELDS,
  system: SYSTEM_FIELDS,
  security: SECURITY_FIELDS,
};

export const ALL_FIELDS: FieldDef[] = Object.values(CONFIG_SCHEMA).flat();

/** 按 source 分组字段（供导出时重建 JSON） */
export const FIELDS_BY_SOURCE: Record<string, FieldDef[]> = ALL_FIELDS.reduce<Record<string, FieldDef[]>>((acc, f) => {
  (acc[f.source] ||= []).push(f);
  return acc;
}, {});
