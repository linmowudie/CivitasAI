# Configs — 运行时配置

15 个 JSON 配置文件，三层覆盖（优先级固定）：`local.json > {env}.json > default.json`。
`{env}` 由环境变量 `CIVITAS_ENV` 决定（缺省 `dev`）；`local.json` 不提交 git。**空配置下系统必须可直接启动**（`default.json` 提供所有键默认值）。

## 文件清单

> 表中"L0/L2"为**设计分级**（Docs/Agent/10 §1.3）；运行期热重载尚未接线，见下文"热加载（现状）"。

| 文件 | 内容 | 加载级别 |
|------|------|---------|
| `default.json` | 全局默认（系统名 / 日志 / 服务器端口 / 数据库路径等） | L0 启动锁定 |
| `security.json` | 信任级别、禁止路径/命令、网络白名单 | L0 启动锁定 |
| `loopConfig.json` | 各角色 LoopConfig 与 StopRules（内层键 snake_case，契约强制） | L2 热重载 |
| `durable.json` | 持久执行：EffectJournal / 幂等 / 恢复策略 | L2 热重载 |
| `session.json` | 会话与归档参数 | L2 热重载 |
| `modelRouter.json` | Provider 与模型注册（`providers[]` 内层 snake_case：`base_url`/`api_key_ref` 等） | L2 热重载 |
| `routingRules.json` | 路由判定规则 | L2 热重载 |
| `economyRules.json` | Token 经济规则（初始供给 / 税率） | L2 热重载 |
| `supervision.json` | 监管参数 | L2 热重载 |
| `memory.json` | 共享记忆与事件总线参数 | L2 热重载 |
| `arbitration.json` | 仲裁系统参数 | L2 热重载 |
| `audit.json` | 审计系统参数 | L2 热重载 |
| `dataStorage.json` | 七类数据的保留期 / 上限 / 清理策略（对应 `Data/` 各子目录） | L2 热重载 |
| `coverageBaseline.json` | 测试覆盖率基线 | L2 CI 读写 |
| `benchBaseline.json` | 基准评估基线 | L2 CI 读写 |

## 热加载（现状：未生效）

`main.ts` 第 ⑨ 步调用 `initConfigWatcher({ watchDir: getConfigDir(), watchDirs: [内置 Configs, Prompts, Skills] })` **仅登记参数**；`Infra/Watcher/configWatcher.ts` 的扫描逻辑为注释桩，`startWatching` / `onConfigChange` 无任何调用者——**当前不存在真正的运行期热重载**，所有配置改动均需重启生效（2026-09-22 与 Docs/Agent/10 同步校准）。L0/L2 分级与 `mutationLevels.ts` 判定函数亦未接线（见 Docs/Agent/10 §1.3 校准注记）。

## 目录契约与覆盖层（2026-10-06 校准）

- **内置种子**：`<APP_ROOT>/Configs`（随安装包分发，只读）。
- **用户覆盖层**：`<DATA_ROOT>/Configs`（安装态 = `%APPDATA%\CivitasAI\Configs`，可写）。
- 加载顺序（低 → 高）：`内置 default → 内置 {env} → 内置功能文件 → 内置 local → 用户 {env} → 用户功能文件 → 用户 local`。
- ✅ **已修复**：原实现把 11 个功能 JSON **无条件覆盖到最后**，`local.json` 覆盖不了 `modelRouter.routing` 等键（本文件上一版自认的已知问题）。现在 `local.json` 为最高层——首次运行引导只需写用户层 `local.json` 即可选中供应商与默认模型。
- ⚠️ **仍然存在**：多数功能键（约 51%）在 `Src/` 中无消费者，属"登记未接线"参数（各自在设计与差别清单中登记）。

详细语义见 [Docs/Agent/10-配置体系与安全](../Docs/Agent/10-配置体系与安全/配置体系与安全设计.md)、[Docs/Server/02-使用指南/configuration.md](../Docs/Server/02-使用指南/configuration.md)（环境变量与目录契约）与 [ELECTRON.md](../ELECTRON.md)（安装包）。
