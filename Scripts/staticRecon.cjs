#!/usr/bin/env node
/*
 * L0 静态对账检查器（per-systems static reconciliation）
 *
 * 为什么需要它（文档 §2.1「L0 静态对账」，适用全部 9 个系统，尤其第 7、9 两个纯文档面）：
 *   九系统里大量判定点是**静态事实**，不是行为可观测的：
 *     ·「`sandboxMode` 字段无消费方」——跑任何场景都观测不到；
 *     ·「`freezeWallet` 零生产调用者」——只能扫符号引用；
 *     ·「`supports_vision` 是死字段」——只能查字段读取方。
 *   这类事实用场景实验去证，只会得到"看起来跑了但其实没测到"的假覆盖。
 *   所以它们是 **L0 静态对账**的职责：导出符号存在性 / 零调用者扫描 / 字段消费方扫描。
 *
 * 两类检查（这是本文件的核心语义，不能混）：
 *   · lock —— 锁定**当前行为**（哪怕这个行为本身是缺陷），防止静默漂移。
 *            例：检索 fragment 的 `source` 恒为字面量 'long-term-memory'，
 *            锁定它是为了"哪天有人改了，矩阵立刻知道"。
 *   · gap  —— 声明**应有但当前没有**的性质（守卫存在性）。
 *            今天必须为红；变绿即意味着产品把这条债还了，此时矩阵里的 `gap` 要转正。
 *
 * 退出码：lock 失败 → 非 0（回归）；gap 红 → 不算失败（它本来就是缺口证明）。
 *
 * 用法：
 *   node Scripts/staticRecon.cjs            # 人类可读报告
 *   node Scripts/staticRecon.cjs --json     # 机读（供 experimentMatrix.cjs 双向一致性校验）
 *   node Scripts/staticRecon.cjs --only=SC-GAP-TOOL-EGRESS
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'Src');

// ── 静态分析基础设施 ────────────────────────────────────────────────

/** 递归收集目录下的 .ts 文件（排除 .d.ts） */
function tsFiles(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) tsFiles(full, acc);
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) acc.push(full);
  }
  return acc;
}

/** 在 Src（或指定目录集）里按行匹配正则 */
function grep(patterns, opts = {}) {
  const dirs = (opts.dirs ?? [SRC]).map(d => path.resolve(ROOT, d));
  const re = patterns instanceof RegExp ? patterns : new RegExp(patterns);
  const out = [];
  for (const dir of dirs) {
    for (const f of tsFiles(dir)) {
      const rel = path.relative(ROOT, f).replace(/\\/g, '/');
      if (opts.exclude && opts.exclude.some(e => rel.includes(e))) continue;
      const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
      lines.forEach((line, i) => {
        if (re.test(line)) out.push({ file: rel, line: i + 1, text: line.trim() });
      });
    }
  }
  return out;
}

/** 符号在 Src 里的**生产引用**（排除定义文件自身与该符号的测试文件） */
function productionRefs(symbol, definitionFile) {
  const hits = grep(new RegExp(`\\b${symbol}\\b`), { exclude: [definitionFile] });
  return hits;
}

/**
 * 判定一行是否只是"声明 / 导入 / 再导出" —— 它们**不是消费方**。
 *
 * 这是 L0 最容易出错的地方（实测踩到）：`export { freezeWallet } from './walletManager'`
 * 是**再导出**，`readonly sandboxMode: SandboxMode` 是**声明**，`validSandbox.includes(spec.sandboxMode)`
 * 是**枚举校验**；三者都不构成"该字段/能力被使用"。
 * 符号出现 ≠ 被消费 —— 文档 §2.2 铁律 3（oracle 必须可证伪）在静态层的对应要求。
 */
function isDeclOrReexport(line) {
  const t = line.trim();
  if (/^import\b|^import\s+type\b/.test(t)) return true;
  if (/^export\s*(\{|\*|type\s*\{)/.test(t)) return true;          // 再导出 / barrel
  if (/^\s*(readonly\s+)?\w+\??:\s*[^=]*;?\s*$/.test(t)) return true; // 纯字段声明
  if (/^\s*(export\s+)?(const|let|var|function|abstract|class|interface|type)\b/.test(t)) return true;
  if (/\bfrom\s+['"]/.test(t)) return true;                       // 任何 from 子句
  return false;
}

/**
 * 真正的**调用点**：`symbol(` 形式，且该行不是声明/导入/再导出。
 * @param scope 限定目录前缀（相对仓库根，如 'Src/Services/Governance/'）
 */
function callSites(symbol, opts = {}) {
  const re = new RegExp(`\\b${symbol}\\s*\\(`);
  let hits = grep(re, { exclude: opts.exclude });
  if (opts.scope) hits = hits.filter(h => opts.scope.some(s => h.file.startsWith(s)));
  return hits.filter(h => !isDeclOrReexport(h.text));
}

function readText(rel) {
  const p = path.join(ROOT, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

function readJson(rel) {
  const t = readText(rel);
  return t === null ? null : JSON.parse(t);
}

/** 统一的检查结果 */
const R = (passed, detail) => ({ passed, detail });

/**
 * 证据强度（决定一条检查能否支撑 cell 的 `existing-covered` 声明）
 *
 *   behavioral —— 检查的是**行为或取值**（如"常量被引用且上限真被强制"、"阈值与写路径都在"）；
 *                 通过 ⇒ 可以支撑行为性 oracle 的覆盖声明。
 *   symbol     —— 只证明**符号/文件存在**（如 `/PENDING/.test(file)`）。
 *                 **不足以**支撑行为性 oracle：它只能说"这段代码还在"，说不了"这个性质成立"。
 *
 * 为什么要把这件事显式化：守门会拒绝 `existing-covered` + `symbol` 级 static 锚
 * —— 否则"覆盖声明"会建立在"那个词还在文件里"之上，这正是本项目反复要防的假绿。
 * 修法只有两条：把检查写强（去看真的行为），或把 cell 如实降级。
 */
const EVIDENCE_STRENGTH = {
  'SC-LOCK-FRAGMENT-SOURCE': 'behavioral',
  'SC-LOCK-HUMANGATE-PENDING': 'behavioral',
  'SC-LOCK-SPECVALIDATOR-FORBIDDEN': 'behavioral',
  'SC-LOCK-AGENTID-MONOTONIC': 'behavioral',
  'SC-LOCK-STATE-TRANSITIONS': 'behavioral',
  'SC-LOCK-SUBAGENT-CAP': 'behavioral',
  'SC-LOCK-CONSOLIDATE-GATE': 'behavioral',
  'SC-LOCK-HARNESS-PORTS': 'behavioral',
  'SC-LOCK-SEARCH-WRITE-SIDE-EFFECT': 'behavioral',
  'SC-LOCK-CLOCK-SKEW': 'behavioral',
  'SC-LOCK-COMPRESS-VETO': 'behavioral',
};

// ── 检查注册表 ──────────────────────────────────────────────────────
//
// 每条 = 一个 cell 的 L0 锚点。id 与矩阵 cell 的 anchor.ref 一一对应。

const CHECKS = {

  // ═══ lock：锁定当前行为，防静默漂移 ═══════════════════════════════

  'SC-LOCK-FRAGMENT-SOURCE': {
    kind: 'lock',
    title: '检索 fragment 的 source 恒为字面量 long-term-memory',
    run() {
      const t = readText('Src/Services/Retrieval/retriever.ts');
      if (t === null) return R(false, 'retriever.ts 不存在');
      const has = /source:\s*'long-term-memory'/.test(t);
      return R(has, has ? '仍为硬编码字面量（任何其它 sources 取值会把结果清零）' : 'source 已改为可配置 —— 需复核 RET 相关 cell 的 oracle');
    },
  },

  'SC-LOCK-HUMANGATE-PENDING': {
    kind: 'lock',
    title: 'runHumanGate 仍恒返 PENDING（未接人工裁决）',
    run() {
      const t = readText('Src/Services/LoopControl/verifier/humanGateCore.ts');
      if (t === null) return R(false, 'humanGateCore.ts 不在 Src/Services/LoopControl/verifier/ —— 判定点已迁移，需重新定位（文档写的是 verifier/humanGateCore.ts，未含 LoopControl 前缀）');
      // behavioral：钉住**返回值**，而不是文件里出现过 PENDING 这个词
      //（旧写法 /PENDING/.test(t) 连注释都能满足）
      const returnsPending = /status:\s*'PENDING_APPROVAL'/.test(t);
      return R(returnsPending, returnsPending ? 'runHumanGate 仍返回 PENDING_APPROVAL（不自动通过）' : '返回值不再是 PENDING_APPROVAL —— 治理面 oracle 需更新');
    },
  },

  'SC-LOCK-SPECVALIDATOR-FORBIDDEN': {
    kind: 'lock',
    title: 'specValidator 仍在注册期拒绝 FORBIDDEN 工具',
    run() {
      const t = readText('Src/Tools/Traits/specValidator.ts');
      if (t === null) return R(false, 'specValidator.ts 不存在');
      // 复检（Round 15）：本文件里 FORBIDDEN 只出现在 validDangerLevels 的**枚举校验**中，不是拒绝路径。
      // whitelist.ts 的 FORBIDDEN 命中全为小写 forbiddenPaths/Commands（另一回事）。
      // 因此改为「真的去找 FORBIDDEN 的拒绝路径」——找不到就如实为红，
      // 由守门迫使 TOOL-BEN-SCHEMA 从 existing-covered 降级。
      // 精确到**规则 12 的实际形态**（`dangerLevel === 'FORBIDDEN'` → errors.push），
      // 否则紧邻的「枚举校验 errors.push」会被窗口吃到（实测踩过这个假阳性）
      const refuses = /dangerLevel\s*===\s*'FORBIDDEN'[\s\S]{0,160}?errors\.push/.test(t);
      return R(refuses, refuses ? '规则 12 存在：FORBIDDEN 级别工具不允许注册' : '未找到 FORBIDDEN 拒注规则 —— 覆盖声明不成立');
    },
  },

  'SC-LOCK-AGENTID-MONOTONIC': {
    kind: 'lock',
    title: 'agentId 只增不复用',
    run() {
      const t = readText('Src/Core/AgentRuntime/agentFactory.ts');
      if (t === null) return R(false, 'agentFactory.ts 不存在');
      // behavioral：钉住只增的实现（自增 + 与库内最大序号对齐），而不是函数名存在
      const increments = /\+\+agentCounter/.test(t);
      const alignsWithStore = /Math\.max\(agentCounter,\s*maxAgentIdSeq\(\)\)/.test(t);
      return R(increments && alignsWithStore,
        increments
          ? (alignsWithStore ? '自增且与库内最大序号对齐（重启后不复用）' : '自增存在但与库内序号未对齐 —— 重启可能复用')
          : '未找到只增实现 —— ID 复用防线需复核');
    },
  },

  'SC-LOCK-STATE-TRANSITIONS': {
    kind: 'lock',
    title: 'Agent 状态机为表驱动（VALID_TRANSITIONS）',
    run() {
      const t = readText('Src/Core/AgentRuntime/stateMachine.ts');
      if (t === null) return R(false, 'stateMachine.ts 不存在');
      // behavioral：声明 + 被用于查表（VALID_TRANSITIONS[currentStatus]）才叫表驱动校验
      const declared = /const VALID_TRANSITIONS\s*:/.test(t);
      const used = /VALID_TRANSITIONS\[[^\]]+\]/.test(t);
      return R(declared && used,
        declared ? (used ? '表驱动声明且被查表使用' : '声明存在但未被查表 —— 校验可能不生效') : 'VALID_TRANSITIONS 声明消失');
    },
  },

  'SC-LOCK-SUBAGENT-CAP': {
    kind: 'lock',
    title: '子 Agent 每 trace 存活上限 8 被强制',
    run() {
      const t = readText('Src/Tools/Custom/agentRecruiter.ts');
      if (t === null) return R(false, 'agentRecruiter.ts 不存在');
      const decl = /MAX_LIVE_SUBAGENTS_PER_TRACE\s*=\s*8/.test(t);
      const used = (t.match(/MAX_LIVE_SUBAGENTS_PER_TRACE/g) || []).length >= 2;
      return R(decl && used, decl ? (used ? '常量声明且被引用（上限真被强制）' : '常量已声明但未被引用 —— 上限未强制') : '常量声明消失');
    },
  },

  'SC-LOCK-CONSOLIDATE-GATE': {
    kind: 'lock',
    title: 'observed→记忆 的唯一通道仍要求 success 且 ≥50 字符',
    run() {
      const t = readText('Src/Core/Loop/loopKnowledge.ts');
      if (t === null) return R(false, 'loopKnowledge.ts 不存在');
      // behavioral：钉住两个闸门的具体形态 —— 常量 50（由 MIN_SUMMARY_CHARS 引用）与 success 判定
      const threshold = /MIN_SUMMARY_CHARS\s*=\s*50/.test(t);
      const successGate = /exitReason\s*!==\s*'success'\s*\)\s*return null/.test(t);
      const lengthGate = /length\s*<\s*MIN_SUMMARY_CHARS\s*\)\s*return null/.test(t);
      return R(threshold && successGate && lengthGate,
        `阈值常量 ${threshold ? 'OK' : 'MISS'} / success 闸门 ${successGate ? 'OK' : 'MISS'} / 长度闸门 ${lengthGate ? 'OK' : 'MISS'}`);
    },
  },

  // ═══ gap：应有而当前没有（今天必须为红）═══════════════════════════

  'SC-GAP-TOOL-EGRESS': {
    kind: 'gap',
    title: 'WebSearch 联网前经 isNetworkAllowed 白名单校验',
    run() {
      const t = readText('Src/Tools/Builtin/Search/webSearch.ts');
      if (t === null) return R(false, 'webSearch.ts 不存在（判定点已迁移，需重新定位）');
      const guarded = /isNetworkAllowed/.test(t);
      return R(guarded, guarded ? '已接入白名单校验' : 'webSearch.ts 未经 isNetworkAllowed —— 空白名单下任意外联（文档 §3.1 断链）');
    },
  },

  'SC-GAP-TOOL-SANDBOX': {
    kind: 'gap',
    title: 'ToolSpec.sandboxMode 有执行方（声明即生效）',
    run() {
      // 陷阱：`specValidator` 里的 `validSandbox.includes(spec.sandboxMode)` 是**枚举校验**，
      // `Builtin/**` 里的 `sandboxMode: 'none'` 是**声明** —— 两者都不是"执行方"。
      // 真正的消费方必须在执行链上读它并**改变行为**（否则它就不是安全边界，只是文档字段）。
      const refs = productionRefs('sandboxMode', 'Src/Tools/Traits/toolSpec.ts')
        .filter(h => !h.file.startsWith('Src/Tools/Builtin/')
          && !h.file.includes('specValidator.ts'));
      const consumers = refs.filter(h => !isDeclOrReexport(h.text));
      return R(consumers.length > 0, consumers.length > 0
        ? `存在消费方：${consumers.slice(0, 3).map(c => `${c.file}:${c.line}`).join(', ')}`
        : '仅声明与枚举校验、无执行方 —— sandboxMode 不是安全边界（文档 §3.1）');
    },
  },

  'SC-GAP-TOOL-L4GATE': {
    kind: 'gap',
    title: 'DANGEROUS+IRREVERSIBLE 在校验期即要求 L4 HumanGate',
    run() {
      const t = readText('Src/Tools/Traits/specValidator.ts');
      if (t === null) return R(false, 'specValidator.ts 不存在');
      // 必须"同一条 IRREVERSIBLE 分支上下文里"出现 L4/HumanGate 要求；
      // 只判两个词共处一个文件是假阳性（该文件其它规则里也有 humanGate 字样）。
      // 必须真的**产生错误**：空 if 块里只写注释的情况不算（实测踩过——
      // 旧写法被 'L4 HumanGate 在 approvalGate 中强制' 这句注释满足，于是把空实现判成了已还）
      // 只取该 if 块的**花括号体内**再判 —— 窗口法会吃到后面 `// 12. FORBIDDEN` 规则的 errors.push
      // （实测踩过两次：先是注释满足、后是邻近规则的 errors.push 满足）
      const branch = t.match(/dangerLevel\s*===\s*'DANGEROUS'[^)]*\)\s*\{([\s\S]*?)\}/);
      const enforced = branch !== null && /errors\.push/.test(branch[1]);
      return R(enforced, enforced ? '校验期对 DANGEROUS+IRREVERSIBLE 真的产生校验错误' : '校验期不拦截（:111-114 为空 if 块，仅注释）—— 文档 §3.1 的判断成立');
    },
  },

  'SC-GAP-TOOL-RATE': {
    kind: 'gap',
    title: 'ToolSpec.rateLimitPerAgent 有执行方',
    run() {
      const hits = productionRefs('rateLimitPerAgent', 'Src/Tools/Traits/toolSpec.ts');
      const consumers = hits.filter(h => !/^\s*(readonly\s+)?rateLimitPerAgent/.test(h.text));
      return R(consumers.length > 0, consumers.length > 0
        ? `存在消费方：${consumers.slice(0, 3).map(c => `${c.file}:${c.line}`).join(', ')}`
        : '无实现承载点（文档 §3.1）');
    },
  },

  'SC-GAP-SUP-FREEZE-PERSIST': {
    kind: 'gap',
    title: '冻结状态落库（重启不丢）',
    run() {
      const hits = grep(/getMainDb|dbFailureLog|mainDb/).filter(h => h.file.startsWith('Src/Services/Audit/'));
      return R(hits.length > 0, hits.length > 0
        ? `已落库：${hits.slice(0, 2).map(h => `${h.file}:${h.line}`).join(', ')}`
        : 'Audit 目录零 DB 引用 —— 冻结状态重启即丢（文档 §3.3 缺口）');
    },
  },

  'SC-GAP-SUP-FREEZE-WALLET': {
    kind: 'gap',
    title: '冻结期钱包同步冻结（freezeWallet 有生产调用者）',
    run() {
      // 陷阱：`TokenEconomy/index.ts` 是 **barrel 再导出**（`export { freezeWallet }`），不是调用方。
      const hits = callSites('freezeWallet')
        .filter(h => !h.file.includes('walletManager.ts') && !h.file.includes('TokenEconomy/index.ts'));
      return R(hits.length > 0, hits.length > 0
        ? `存在调用方：${hits.slice(0, 3).map(h => `${h.file}:${h.line}`).join(', ')}`
        : 'freezeWallet 零生产调用方（barrel 再导出不算）—— 冻结期 token 仍可扣（文档 §3.3 缺口）');
    },
  },

  'SC-GAP-SUP-AUDIT-CHAIN': {
    kind: 'gap',
    title: '审计日志有完整性链（prevHash / hashChain / merkle）',
    run() {
      // 陷阱：`a2aApi/a2aIpc` 里的 `prevHash` 是 **A2A 信封链**（`signEnvelope`），
      // 与"治理审计记录不可篡改"是两回事。必须限定在治理记录写入路径上。
      const hits = grep(/prevHash|hashChain|merkle/i, {
        dirs: ['Src/Services/Governance', 'Src/Infra/Db'],
      });
      return R(hits.length > 0, hits.length > 0
        ? `治理/DB 路径存在：${hits.slice(0, 3).map(h => `${h.file}:${h.line}`).join(', ')}`
        : '治理审计路径零命中（A2A 信封链不算）—— governance_records 可被 UPDATE/DELETE 且无篡改痕迹（文档 §3.3 缺口）');
    },
  },

  'SC-GAP-SUP-DEADLOCK-WIRED': {
    kind: 'gap',
    title: 'detectDeadlock 有生产调用者（死锁检测已接线）',
    run() {
      const hits = productionRefs('detectDeadlock', 'Src/Services/Supervision/index.ts')
        .filter(h => !h.file.startsWith('Src/Services/Supervision/'));
      return R(hits.length > 0, hits.length > 0
        ? `已接线：${hits.slice(0, 3).map(h => `${h.file}:${h.line}`).join(', ')}`
        : '零生产调用者 —— 互等死锁无检测方（文档 §3.3 / ENV-DEADLOCK）');
    },
  },

  'SC-GAP-MEM1-PARTITION': {
    kind: 'gap',
    title: 'S/L/M/H 分区与 assembleContext 已接线',
    run() {
      // 陷阱：`Src/Services/Context/assembler.ts` 里有个**同名但不同模块**的 `assembleContext`，
      // 它不是 `Src/Context/partitions/*` 那套分区实现。判据必须是"分区模块被生产侧 import"。
      const hits = grep(/from\s+['"][^'"]*Context\/partitions\//)
        .filter(h => !h.file.startsWith('Src/Context/partitions/'));
      return R(hits.length > 0, hits.length > 0
        ? `分区模块被引入：${hits.slice(0, 3).map(h => `${h.file}:${h.line}`).join(', ')}`
        : 'Context/partitions/** 零生产引入（Services/Context 的同名 assembleContext 不算）—— 分区未接线（文档 §3.4 事实 2）');
    },
  },

  'SC-GAP-MEM1-RESTORE-DIALOG': {
    kind: 'gap',
    title: '恢复链包含对话内容（不只是 iteration/phase）',
    run() {
      const t = readText('Src/Infra/DurableExecution/schemas/Checkpoint.ts');
      if (t === null) return R(false, 'schemas/Checkpoint.ts 不存在（判定点已迁移）');
      const hasDialog = /messages|chatMessages|dialog|conversation/i.test(t);
      return R(hasDialog, hasDialog ? '快照已含对话内容' : 'LoopStateSnapshot 仅 iteration/phase/completedSteps/failedAttempts（文档 §3.4 事实 3）');
    },
  },

  'SC-GAP-SUB-DEPTH': {
    kind: 'gap',
    title: '派生深度/层级字段与环路检测存在',
    run() {
      const hits = grep(/\bdepth\b|\blevel\b|deriveDepth|parentDepth/i)
        .filter(h => h.file.startsWith('Src/Core/Decision/orchestrator/') || h.file.startsWith('Src/Services/Recruitment/'));
      const cycle = grep(/cycle|loopDetect|circular/i)
        .filter(h => h.file.startsWith('Src/Services/Recruitment/'));
      return R(hits.length > 0 && cycle.length > 0,
        `深度字段命中 ${hits.length} 处，环路检测命中 ${cycle.length} 处 —— 均需 >0（文档 §3.6：partner 可再招募 partner，唯一约束是存活数 8）`);
    },
  },

  'SC-GAP-SUB-TOOLPERM': {
    kind: 'gap',
    title: 'isToolAllowedForRole 有生产调用者（工具权限非装饰）',
    run() {
      const hits = productionRefs('isToolAllowedForRole', 'Src/Infra/Security/whitelist.ts');
      return R(hits.length > 0, hits.length > 0
        ? `已接入：${hits.slice(0, 3).map(h => `${h.file}:${h.line}`).join(', ')}`
        : '零生产调用者 —— allowed_tools 仅落库、执行侧不按它判（文档 §3.6 缺口）');
    },
  },

  'SC-GAP-SUB-RECLAIM': {
    kind: 'gap',
    title: '孤儿子 Agent 可回收（expelAgent / detectAllAnomalies 有调用者）',
    run() {
      const a = productionRefs('expelAgent', 'Src/Services/Recruitment/recruiter.ts')
        .filter(h => !h.file.startsWith('Src/Services/Recruitment/'));
      const b = productionRefs('detectAllAnomalies', 'Src/Core/Decision/orchestrator/progressTracker.ts')
        .filter(h => !h.file.startsWith('Src/Core/Decision/orchestrator/'));
      return R(a.length > 0 || b.length > 0,
        `expelAgent 生产调用 ${a.length} 处 / detectAllAnomalies ${b.length} 处 —— 均零则孤儿无回收（文档 §3.6）`);
    },
  },

  'SC-GAP-MEMN-READAUTH': {
    kind: 'gap',
    title: '共享记忆读侧有 agent 级鉴权',
    run() {
      const t = readText('Src/Services/SharedMemory/globalWorkspace.ts');
      if (t === null) return R(false, 'globalWorkspace.ts 不存在');
      const readBody = t.slice(Math.max(0, t.indexOf('export function read')));
      const hasAuth = /agentId[\s\S]{0,200}(denied|forbidden|not permitted|不可|鉴权)/i.test(readBody.slice(0, 1200));
      return R(hasAuth, hasAuth ? '读侧含 agent 级鉴权' : '读侧仅按 owner_user_id 过滤 —— 同属主下任意 agent 可读回全部条目（文档 §3.8 缺口 3）');
    },
  },

  'SC-GAP-MEMN-MEMREF': {
    kind: 'gap',
    title: 'A2A 校验 memoryRefs 指向条目的存在性与版本',
    run() {
      const t = readText('Src/Services/A2A/a2aBroker.ts');
      if (t === null) return R(false, 'a2aBroker.ts 不存在');
      // 陷阱：文件里出现 `lookupMemory` 只说明**可选依赖被解构**，不代表生产注入。
      // 判据必须是"组合根真的把它传进去了"。
      const injectedAtRoot = grep(/lookupMemory/).some(h => h.file === 'Src/main.ts' || h.file.startsWith('Src/Services/A2A/attach'));
      return R(injectedAtRoot, injectedAtRoot
        ? '组合根已注入 lookupMemory（memoryRefs 可校验存在性/版本）'
        : '`deps.lookupMemory` 仅为可选注入且生产未接 —— memoryRefs 不校验（文档 §3.8 缺口 6）');
    },
  },

  'SC-GAP-MEMN-EVENTSUB': {
    kind: 'gap',
    title: '存在 MEMORY_WRITTEN 的订阅链（observed 事件→记忆）',
    run() {
      // 陷阱：`globalWorkspace.ts` 里的 `MEMORY_WRITTEN` 是 **publisher**（发布方），不是订阅链。
      // 判据必须是"有订阅者"：`subscribe(`/`on(` 位置上出现该事件类型。
      const hits = grep(/(subscribe|onEvent|addListener)\s*\(\s*EventType\.MEMORY_WRITTEN|EventType\.MEMORY_WRITTEN\s*,\s*(\(|async)/)
        .filter(h => !h.file.includes('eventTypes.ts'));
      return R(hits.length > 0, hits.length > 0
        ? `存在订阅方：${hits.slice(0, 3).map(h => `${h.file}:${h.line}`).join(', ')}`
        : '除 UI 落库外无订阅者（发布方 globalWorkspace 不算）—— 不存在 observed 事件→记忆 的订阅链（文档 §3.8 缺口 7）');
    },
  },

  'SC-GAP-MM-VISION': {
    kind: 'gap',
    title: 'supports_vision 被模型路由读取（非死字段）',
    run() {
      // 陷阱：`providerProbe.ts` / `secretsStore.ts` 里出现 supports_vision 是**供应商自述探测**，
      // 不是"路由按视觉能力分流"。判据限定在路由/模型选择层。
      const hits = productionRefs('supports_vision', 'Src/Infra/Llm/Provider/providerBase.ts')
        .filter(h => h.file.startsWith('Src/Infra/Llm/Router/'));
      return R(hits.length > 0, hits.length > 0
        ? `路由层读取：${hits.slice(0, 3).map(h => `${h.file}:${h.line}`).join(', ')}`
        : '路由层零读取（供应商探测不算）—— 视觉能力声明既不生效也不报错（文档 §3.9）');
    },
  },

  'SC-GAP-MM-TRACE': {
    kind: 'gap',
    title: '双层 trace 的 span 层已接线（runInSpan 有生产调用者）',
    run() {
      const hits = productionRefs('runInSpan', 'Src/Infra/Logging/traceContext.ts');
      return R(hits.length > 0, hits.length > 0
        ? `已接线：${hits.slice(0, 3).map(h => `${h.file}:${h.line}`).join(', ')}`
        : '零生产调用者 —— span 层未接线，多 Agent 实验缺度量前提（文档 §3.9）');
    },
  },

  'SC-GAP-RET-EMBEDDING-REG': {
    kind: 'gap',
    title: '已注册嵌入模型（语义重排可用）',
    run() {
      const cfg = readJson('Configs/modelRouter.json');
      if (cfg === null) return R(false, 'Configs/modelRouter.json 不存在');
      const text = JSON.stringify(cfg);
      const has = /embed/i.test(text);
      return R(has, has ? '配置含嵌入模型' : '未注册任何嵌入模型 —— 语义重排默认关闭（文档 §3.2）');
    },
  },

  'SC-GAP-RET-DURATION': {
    kind: 'gap',
    title: '检索耗时真实上报（durationMs 非硬编码 0）',
    run() {
      const t = readText('Src/Services/Retrieval/retriever.ts');
      if (t === null) return R(false, 'retriever.ts 不存在');
      const hardcoded = /durationMs:\s*0\b/.test(t);
      return R(!hardcoded, hardcoded ? 'durationMs 硬编码 0 —— 召回延迟不可测（文档 §3.2）' : '耗时已真实上报');
    },
  },

  'SC-GAP-AUDIT-EVENTS-TABLE': {
    kind: 'gap',
    title: 'events / domain_events 表有写入方（非孤岛表）',
    run() {
      const hits = grep(/INSERT\s+INTO\s+(events|domain_events)/i);
      return R(hits.length > 0, hits.length > 0
        ? `存在写入方：${hits.slice(0, 3).map(h => `${h.file}:${h.line}`).join(', ')}`
        : '零写入方 —— 实际有数据的只有 ai_events（文档 §3.9）');
    },
  },

  'SC-LOCK-HARNESS-PORTS': {
    kind: 'lock',
    title: '实验台注入了组合根端口（否则"产品缺口"其实是实验台没装配）',
    run() {
      // 真实踩过：`toolDispatcher` 对未注入的 `toolResultCache` 端口是**静默跳过**
      // （源码注释明写"不伪造命中"），于是"幂等重放"实验测到的是"实验台没装端口"，
      // 报告却显示成"产品幂等缓存未生效"。这类错误会把装配缺口伪装成产品缺陷。
      const t = readText('Benchmarks/runner/harness.ts');
      if (t === null) return R(false, '实验台 harness.ts 不存在');
      const checks = [
        ['toolResultCache', /toolResultCache:\s*\{/],
        ['configureToolServicePorts', /configureToolServicePorts\(/],
        ['initToolResultCache', /initToolResultCache\(/],
      ];
      const missing = checks.filter(([, re]) => !re.test(t)).map(([n]) => n);
      return R(missing.length === 0,
        missing.length === 0
          ? '端口装配齐备（toolResultCache / configureToolServicePorts / initToolResultCache）'
          : `缺端口装配：${missing.join(', ')} —— 相关实验会测到"实验台没装配"而非产品行为`);
    },
  },

  'SC-LOCK-SEARCH-WRITE-SIDE-EFFECT': {
    kind: 'lock',
    title: 'searchMemories 仍有访问计数写副作用（检索实验必须处理）',
    run() {
      // 文档 §2.3 评测卫生：`longTermMemory.ts:searchMemories` 会写 `accessCount`/`lastAccessedAt`，
      // 累计 ≥5 触发 `MEMORY_SELF_REINFORCING`。因此**检索类实验必须在副本上做，或关闭计数**，
      // 否则"召回质量"会被上一轮实验自己抬高。这里锁住该事实，防有人把副作用删了却
      // 仍按"有副作用"去设计实验（或反过来：副作用在、实验却没隔离）。
      const t = readText('Src/Services/SharedMemory/longTermMemory.ts');
      if (t === null) return R(false, 'longTermMemory.ts 不存在');
      const writes = /accessCount/.test(t) && /lastAccessedAt/.test(t);
      const threshold = /SELF_REINFORCING_THRESHOLD\s*=\s*5/.test(t);
      return R(writes && threshold,
        writes
          ? (threshold ? '副作用与阈值(5)均在 —— 检索实验必须隔离或关计数' : '阈值常量变了 —— 需复核 MEMORY_SELF_REINFORCING 判据')
          : '访问计数写副作用消失 —— 检索实验的隔离要求需重估（可能是产品改动）');
    },
  },

  'SC-LOCK-CLOCK-SKEW': {
    kind: 'lock',
    title: '时钟回拨检测与单调时钟仍在（timeService）',
    run() {
      const t = readText('Src/Infra/Time/timeService.ts');
      if (t === null) return R(false, 'timeService.ts 不存在');
      const detect = /Date\.now\(\)\s*<\s*lastKnownTime|时钟回拨检测/.test(t);
      const monotonic = /monotonicMs/.test(t) && /performance\.now/.test(t);
      return R(detect && monotonic,
        detect
          ? (monotonic ? '回拨检测 + 单调时钟（performance.now）均在' : '单调时钟实现变了 —— 需复核 MEM1-ENV-CLOCK 判据')
          : '时钟回拨检测消失 —— L5 的时钟回拨判据失去被测对象');
    },
  },

  'SC-LOCK-COMPRESS-VETO': {
    kind: 'lock',
    title: '压缩前经监管否决（runCompressSupervision 已接线）',
    run() {
      // 文档 §3.4 事实 4 明说这是**正例**：压缩监管回退有真接线，所以它是 lock 而不是 gap。
      const t = readText('Src/Core/Loop/contextCompression.ts');
      if (t === null) return R(false, 'contextCompression.ts 不存在');
      // behavioral：必须是调用（带括号），只写名字不算接线（旧写法接受仅 import 或注释里提到）
      const called = /runCompressSupervision\s*\(|runSummarySupervision\s*\(/.test(t);
      return R(called, called ? '压缩监管否决已被调用（ADR-0005 红线有执行体）' : '仅出现名称、未见调用 —— 监管否决未真正接线');
    },
  },
};

// ── 主流程 ──────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const jsonOut = args.includes('--json');
  const only = args.find(a => a.startsWith('--only='))?.split('=')[1];

  // ── 自检：每条 lock 检查都必须显式声明证据强度 ──
  // 为何强制声明：Round 15 实测发生过「改了检查实现、忘了同步分类表」—— 分类一旦脱节，
  // 守门的「symbol 级不得支撑覆盖声明」规则就形同虚设。所以缺声明不是警告，
  // 而是一条**失败的检查**（经守门让 CI 变红）。
  const undeclared = Object.entries(CHECKS)
    .filter(([id, c]) => c.kind === 'lock' && EVIDENCE_STRENGTH[id] === undefined)
    .map(([id]) => id);

  const results = [];
  for (const [id, check] of Object.entries(CHECKS)) {
    if (only && only !== id) continue;
    let r;
    try {
      r = check.run();
    } catch (e) {
      r = R(false, `检查抛异常：${e instanceof Error ? e.message : String(e)}`);
    }
    results.push({ id, kind: check.kind, title: check.title, passed: r.passed, detail: r.detail, evidence: EVIDENCE_STRENGTH[id] ?? (check.kind === 'lock' ? 'symbol' : 'behavioral') });
  }

  if (undeclared.length > 0 && !only) {
    results.push({
      id: 'SC-SELF-EVIDENCE-DECLARED',
      kind: 'lock',
      title: '所有 lock 检查均已显式声明证据强度',
      passed: false,
      detail: `未声明：${undeclared.join(', ')}（缺声明会让「symbol 级不得支撑覆盖声明」规则失效）`,
      evidence: 'behavioral',
    });
  }

  if (jsonOut) {
    process.stdout.write(JSON.stringify({
      total: results.length,
      lockFailed: results.filter(r => r.kind === 'lock' && !r.passed).map(r => r.id),
      gapOpen: results.filter(r => r.kind === 'gap' && !r.passed).map(r => r.id),
      gapClosed: results.filter(r => r.kind === 'gap' && r.passed).map(r => r.id),
      checks: results,
    }, null, 2) + '\n');
  } else {
    const locks = results.filter(r => r.kind === 'lock');
    const gaps = results.filter(r => r.kind === 'gap');
    console.log('=== L0 静态对账（九系统）===');
    console.log(`检查 ${results.length} 条：lock ${locks.length} / gap ${gaps.length}`);
    console.log(`\n-- lock（锁定当前行为，必须全绿）--`);
    for (const r of locks) console.log(`  ${r.passed ? '✓' : '✗'} ${r.id}  ${r.title}\n      ${r.detail}`);
    console.log(`\n-- gap（应有而当前没有；红=缺口成立，绿=债已还，矩阵需转正）--`);
    for (const r of gaps) console.log(`  ${r.passed ? '🟢已还' : '🔴缺口'} ${r.id}  ${r.title}\n      ${r.detail}`);
    const lockFailed = locks.filter(r => !r.passed);
    console.log(`\nlock 失败 ${lockFailed.length} 条；gap 成立 ${gaps.filter(r => !r.passed).length} 条；gap 已还 ${gaps.filter(r => r.passed).length} 条`);
    if (lockFailed.length) console.log('（lock 失败 = 被锁定的行为漂移了，需复核矩阵 oracle，不是产品缺陷）');
  }

  // 退出码只由 lock 决定：gap 红是设计内的（缺口证明实验不进 CI 阻断）
  const lockFailed = results.filter(r => r.kind === 'lock' && !r.passed);
  if (lockFailed.length > 0) process.exit(1);
}

main();
