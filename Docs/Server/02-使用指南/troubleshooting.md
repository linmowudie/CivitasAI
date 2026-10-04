# 故障排除指南

> 常见问题与解决方案

---

## 1. 启动问题

### 1.1 配置加载失败

**症状**：终端输出 `[FATAL] 启动失败: Error: 配置加载失败: ...`

> 2026-10-03 校准：原症状串 `[FATAL] 配置加载失败` 是内部 throw 文本（`Src/main.ts:72`）；用户实际看到的是统一 catch 打印的 `[FATAL] 启动失败: ${err}`（`Src/main.ts:392`），`配置加载失败` 作为子串用于定位根因。

**排查**：
1. 确认 `Configs/` 目录下所有 JSON 文件格式正确（无语法错误）
2. 确认 `Configs/default.json` 存在
3. 检查 `loopConfig.json` 中 `roleOverrides` 是否包含全部 8 个角色

**解决**：
```bash
# 验证 JSON 格式
node -e "JSON.parse(require('fs').readFileSync('Configs/default.json','utf8'))"
```

### 1.2 数据库初始化失败

**症状**：`数据库初始化失败: ...` 或 `数据库迁移失败: ...`

**排查**：
1. 确认 `Data/db/` 目录存在且有写权限
2. 检查磁盘空间是否充足
3. 如果是升级导致的迁移失败，检查 CHANGELOG 中的迁移说明

**解决**：

> 2026-10-03 校准：`Data/db/` 实有 `civitas_main.db`、`civitas_events.db`、`civitas_memory.db` 各带 `-shm`/`-wal`（共 9 个文件，已核实）。原 `rm` 写法仅 POSIX 语义可用，cmd.exe 会失败，现按平台分列。

```bash
# 前置：先停止后端进程（Electron 壳或 tsx Src/main.ts），否则 WAL/SHM 句柄占用会导致删除失败
# 前置（建议）：Data/ 整体被 .gitignore 忽略（.gitignore:12），删除后**无法从 git 恢复**，需先自行备份
```

| 平台 | 重置命令 |
|------|---------|
| bash (Linux/macOS/Git Bash) | `rm Data/db/civitas_*.db*` |
| PowerShell | `Remove-Item Data/db/civitas_*.db*` |
| cmd.exe | `del Data\db\civitas_*.db*` |

重启后 SQLite 自动重建（含 `-wal`/`-shm`，无需单独处理，会随主库重建）。

**可用诊断脚本**：重置前后均可以 `node Scripts/dbPeek.cjs` 只读查看库内数据辅助确认状态。

【需人工裁定·登记】跨平台命令的文档口径（是否全部平台并列 / 以哪个为默认）待裁定；本节暂按三平台并列登记现状。对应工单：Server-02 差别清单 TS-2。

### 1.3 端口冲突

**症状**：`Error: listen EADDRINUSE: address already in use 0.0.0.0:3000`

**解决**：

```bash
# 查找占用端口的进程（按平台选择，2026-10-03 校准：原文仅给 Windows 命令）
netstat -ano | findstr :3000     # Windows cmd / PowerShell
ss -lntp | grep :3000            # Linux
lsof -i :3000                    # macOS / Linux
```

或修改配置：`Configs/default.json → server.httpPort`（当前 3000，`:12`；消费点 `Src/main.ts` 读取 `config.server.httpPort`）。

> 2026-10-03 校准，两条注意：
> 1. **勿删除同文件 `server.wsPort` 键**（`:13`，值 3001）：WebSocket 服务已于 2026-09-28 删除，但配置校验器仍强制该键为整数（`Src/Infra/Config/configValidator.ts:52-53`），删键会 FATAL。仅作历史遗留保留。
> 2. 改端口后需**同步两处**：`Configs/default.json → server.corsOrigins`（`:14`）与 `Client/vite.config.ts` 中 dev server `proxy` 的 target（`:42-44`，当前指向 `http://localhost:3000`；Vite 自身端口在 `:40`，且 `strictPort: true`）。

【需人工裁定·登记】端口查询命令的平台口径同 TS-2，待裁定；现按三平台并列登记。对应工单：Server-02 差别清单 TS-3。

### 1.4 LLM Provider 不可用

**症状**：`无可用 LLM Provider` 或模型调用超时

**排查**：
1. 检查 `.env` 中的 API Key 是否正确
2. 确认网络能访问 LLM 端点
3. 检查 `Configs/modelRouter.json` 中的 `base_url` 是否正确

**可用诊断脚本**：`node Scripts/llmLatency.cjs`（实测各模型流式首响延迟，判断是端点不通还是首响过慢）

## 2. 运行时问题

### 2.1 Loop 不收敛

**症状**：Agent 反复执行相同操作，进度为零

**原因**：StopRules 的 `noProgress` 检测触发

**解决**：
1. 检查 `loopConfig.json` 中 `stopRules.noProgress.stagnationWindowRounds`（默认 3）
2. 系统会自动触发策略切换（`switch_strategy`）
3. 如果所有策略都失败，会自动升级到人工决策（`escalate_human`）

### 2.2 Token 预算耗尽

**症状**：Loop 因 Token 超限被强制终止

**排查**：
1. 检查 `loopConfig.json` 中 `loopDefaults.token_budget`
2. 检查上下文是否过大（`context.truncationUsageRatio`）
3. 查看审计日志确认是否有 Token 浪费

**解决**：
- 增大 `token_budget`
- 降低 `context.truncationUsageRatio`（更早截断上下文）
- 优化任务拆解，减少单 Loop 范围

### 2.3 工具执行失败

**症状**：工具调用返回错误，连续失败 3 次后 Agent 停止

**排查**：
1. 检查工具参数是否正确
2. 确认工具所需的权限（危险级别，见 fullGuide §4.2 信任级×危险级矩阵）
3. 检查 EffectJournal 中的状态（INTENT → EXECUTING → ?）

**可用诊断脚本**：`tsx Scripts/traceAnalysis.ts`（按 trace 回放工具调用链）、`node Scripts/dbPeek.cjs`（查看该会话落库消息）

### 2.4 审批门超时

**症状**：DANGEROUS 工具调用等待审批超时，默认被拒绝

**解决**：
- 确认审批人在线
- 调整审批超时时间：`Configs/security.json → security.approvalTimeoutSec`（当前 300，`:18`；消费链 `Src/main.ts:121` → `Src/Services/LoopControl/middleware/toolSafetyGate.ts:141`，未配置时兜底 60 秒，`toolSafetyGate.ts:43`）
- 注意：超时默认行为是 **拒绝**（安全优先），且该行为由 `toolSafetyGate.ts:142` **硬编码** `defaultOnTimeout: 'reject'`，当前不可配置为默认通过

> 2026-10-03 校准：原文指向的 `loopConfig.json` 中**不存在**任何审批超时键（全文件无 `approval` 相关键，已核实），正确键在 `Configs/security.json`。
>
> 【需人工裁定·登记】`Configs/supervision.json:15-16` 另有同名的 `approvalTimeoutSec: 60` 与 `approvalDefaultOnTimeout: "reject"`，二者在 `Src/` 中**全无消费者**（grep 核实），实际生效值为 security.json 的 **300s** 而非 60s。权威键归属（保留 `security.*` 删除/接线 `supervision.*`）待工程裁定；裁定前调参请以 `security.json` 为准。对应工单：Server-02 差别清单 TS-5 / TS-6。

**可用诊断脚本/日志**：审批创建时后端会写一条 warn 日志（`toolSafetyGate.ts:161-167`，`Logs/business.log` 可按 `ToolSafetyGate` 检索），同时发布 `APPROVAL_REQUESTED` 事件（`:169-184`）；落库记录可经 `node Scripts/dbPeek.cjs` 查看。

## 3. 性能问题

### 3.1 响应缓慢

**排查**：
1. 检查 LLM 调用延迟：日志中**没有** `llmLatency` 指标（2026-10-03 校准：该字段在 `Src/`、`Scripts/` 中不存在）；日志行固定字段为 `timestamp/epochMs/level/track/message/traceId/spanId/operationId/source/data`（`Src/Infra/Logging/logger.ts:186-195`）。测模型真实延迟请用离线压测脚本：`node Scripts/llmLatency.cjs`（实测华为云 MaaS 各模型流式首响延迟，见 `Scripts/README.md`）
2. 检查上下文大小（是否接近 Token 上限）
3. 检查并发 Loop 数量（`Configs/supervision.json` 的 `maxConcurrentLoopsGlobal: 20` / `maxConcurrentLoopsPerUser: 5`）

**可用诊断脚本**：`tsx Scripts/traceAnalysis.ts`（Trace 回放定位单请求耗时链路）、`node Scripts/llmLatency.cjs`（模型首响延迟）

### 3.2 内存占用过高

**排查**（2026-10-03 校准：原两条键指向有误，已按实态改写）：
1. 共享记忆相关缓存：`maxEntries` **不是** `memory.json` 的配置键（该文件无此键），实际是内置默认值、当前**不可经 JSON 配置**——提示词缓存 100（`Src/Services/Cache/promptCache.ts:46`）、工具结果缓存 200（`Src/Services/Cache/toolResultCache.ts:38`）、会话归档 1000（`Src/Services/Session/archiveManager.ts:38`）
2. 事件队列大小：`Configs/memory.json:14` 虽有 `eventBus.maxQueueSize: 10000`，但 EventBus 初始化在 `Src/main.ts:357` **硬编码** `initEventBus({ maxQueueSize: 10000 })`（模块默认同为 10000，`Src/Services/EventBus/eventBus.ts:25,31`），**改配置不生效**；如需调整须改代码
3. 检查 SQLite WAL 文件大小（`Data/db/*.db-wal`）

**可用诊断脚本**：`node Scripts/dbPeek.cjs`（查看库内数据定位增长源）

## 4. 安全事件

### 4.1 注入检测告警

**症状**（2026-10-03 校准）：前置监管拒绝该输入——`rejectReason: 'PROMPT_INJECTION_DETECTED'` 经 `Src/Core/Loop/runIteration.ts:400,403` 写入 Loop 退出消息 / 短路原因（`Pre-supervision rejected: ...`），**不是**独立事件类型。

> 原表述"日志中出现 `INJECTION_DETECTED` **事件**"不实：EventBus 的 `EventType` 枚举中**无** INJECTION 项（`Src/Services/EventBus/eventTypes.ts` 全枚举核实）。真实产出是 `runPreSupervision` 返回体中的 `rejectReason: 'PROMPT_INJECTION_DETECTED'` 与 `injectionDetected: true`（`Src/Services/Supervision/preSupervision.ts:70-74`）。`Configs/security.json:24-28` 的 `criticalSecurityEvents` 里的 `INJECTION_DETECTED` 只是标签字符串，非事件类型（`Tests/Experiments/adversarial/security.spec.ts:4` 亦注记此点）。

**处理**：
1. 检查输入内容是否包含可疑指令（当前检测为 5 条硬编码正则：ignore previous instructions / you are now a / system: you are / `<|im_start|>system` / override safety，`preSupervision.ts:56-62`）
2. 确认前置监管（`runPreSupervision`）正常工作
3. 如为误报：**无配置化阈值可调**（2026-10-03 校准：`supervision.json` 全文无注入检测键，已核实）——须修改 `Src/Services/Supervision/preSupervision.ts` 的 `INJECTION_PATTERNS`（⚠️ "检测规则可配化"为目标态，当前未实现）

### 4.2 Token 守恒异常

**症状**：Token 账本守恒校验失败。

> 2026-10-03 校准·现状记录：原表述"审计局报告守恒验证失败"当前**不成立**——守恒校验本身存在（`Src/Services/TokenEconomy/tokenLedger.ts:49-62` 的 `verifyLedgerConservation`、`Src/Services/TokenEconomy/walletManager.ts:259-267` 的 `verifyConservation`），但**告警链未接线**：`EventType.LEDGER_MISMATCH = 'token:ledger_mismatch'` 已定义（`Src/Services/EventBus/eventTypes.ts:48`），全仓**无任何发射点**（grep 仅命中枚举定义与注释；两个校验函数当前仅经 `Src/Services/TokenEconomy/index.ts:18,26` 桶导出，无运行期调用方）。失败实际只以返回值文本呈现：`LEDGER_MISMATCH #<次数>: expected=..., actual=..., delta=...`（`tokenLedger.ts:62`）或 `Token 守恒异常: expected=..., actual=..., delta=...`（`walletManager.ts:266`）。因此当前去日志里搜 `token:ledger_mismatch` **必然找不到**。
>
> 【需人工裁定·登记】是否将 `LEDGER_MISMATCH` 真正接入 EventBus 广播由工程裁定；接线落地后再回填"搜索 `token:ledger_mismatch`"排查步骤。对应工单：Server-02 差别清单 TS-11。

**处理**：
1. 这是严重事件，立即检查所有活跃 Loop
2. 当前无自动告警，可经测试或 `tsx` 主动调用 `verifyLedgerConservation()` / `verifyConservation()`，核对返回文本中的 `expected/actual/delta`
3. 查看审计日志（`Logs/business.log`）与主库账本表定位异常来源
4. 必要时暂停系统并重启

**可用诊断脚本**（各节通用指路，2026-10-03 校准·TS-12 登记）：

| 脚本 | 用途 | 调用 |
|------|------|------|
| `Scripts/dbPeek.cjs` | 查看某会话最近消息 / 库内数据 | `node Scripts/dbPeek.cjs` |
| `Scripts/dupCheck.cjs` | 检测后端是否对同一 chunk 双重推送 | `node Scripts/dupCheck.cjs` |
| `Scripts/llmLatency.cjs` | 实测模型流式首响延迟 | `node Scripts/llmLatency.cjs` |
| `Scripts/traceAnalysis.ts` | Trace 回放分析 | `tsx Scripts/traceAnalysis.ts` |
| `Scripts/experimentMatrix.cjs` | 实验矩阵守门校验 | `node Scripts/experimentMatrix.cjs` |

> ⚠️ `Scripts/wsDiagnose.cjs` 针对**已删除的 WebSocket 通道**（连接 `ws://localhost:3001`，`Scripts/wsDiagnose.cjs:11`），当前后端无 WS 服务，按文档使用必然失败——**请勿使用**；遗留清理（删除或改造为 IPC 诊断）待工程裁定（对应工单 QS-6）。
