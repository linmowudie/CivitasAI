# Configs — 运行时配置

15 个 JSON 配置文件，三层覆盖（优先级固定）：`local.json > {env}.json > default.json`。
`{env}` 由环境变量 `CIVITAS_ENV` 决定（缺省 `dev`）；`local.json` 不提交 git。**空配置下系统必须可直接启动**（`default.json` 提供所有键默认值）。

## 文件清单

> 表中"L0/L2"为**设计分级**（Docs/11 §1.3）；运行期热重载尚未接线，见下文"热加载（现状）"。

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

`main.ts` 第 ⑨ 步调用 `initConfigWatcher({ watchDir: 'Configs/', pollIntervalMs: 5000 })` **仅登记参数**；`Infra/Watcher/configWatcher.ts` 的扫描逻辑为注释桩，`startWatching` / `onConfigChange` 无任何调用者——**当前不存在真正的运行期热重载**，所有配置改动均需重启生效（2026-09-22 与 Docs/11 同步校准）。L0/L2 分级与 `mutationLevels.ts` 判定函数亦未接线（见 Docs/11 §1.3 校准注记）。

另一已知问题：`configLoader` 在三层合并后会把 11 个功能 JSON 无条件覆盖到 merged，`local.json` 对同名键的覆盖实际会被吃掉；且多数功能键（约 51%）在 `Src/` 中无消费者，属"登记未接线"参数。

详细语义见 [Docs/11-配置体系与安全](../Docs/11-配置体系与安全/配置体系与安全设计.md) 与 [Docs/04-使用指南/configuration.md](../Docs/04-使用指南/configuration.md)。
