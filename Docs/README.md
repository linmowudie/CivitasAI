# Docs — 文档总索引

Civitas-AI（智体城邦）全部设计文档、使用指南与审查记录。编号 01-17 为设计主线，03/04/05 的"开发规范/使用指南/部署运维"为工程支撑线。

## 设计主线

| 编号 | 文档 | 内容 |
|------|------|------|
| 01 | [系统设计总览](01-系统概览/系统设计总览.md) | 全局架构 + 模块索引 |
| 02 | [核心架构设计](02-核心架构/核心架构设计.md) | 五层架构 + 十步主循环 + 六钩子中间件 + 启动 18 步/关闭 9 步 |
| 03 | [Agent 编排引擎设计](03-Agent编排引擎/Agent编排引擎设计.md) | orchestrator 七种工作方式编排 |
| 04 | [Token 经济系统设计](04-Token经济系统/Token经济系统设计.md) | 钱包 / 税收 / 双预算 |
| 05 | [仲裁系统设计](05-仲裁系统/仲裁系统设计.md) | 六步治理闭环 / 律师函挂起 |
| 06 | [监管与审计系统设计](06-监管与审计系统/监管与审计系统设计.md) | 前置/懒监听/后置监管 + 审计 |
| 07 | [共享记忆与上下文系统设计](07-共享记忆与上下文系统/共享记忆与上下文系统设计.md) | 写入守卫 / 冲突检测 / 裁决优先级 |
| 08 | [Agent 间通信协议设计](08-Agent间通信协议/Agent间通信协议设计.md) | 消息协议与事件总线 |
| 09 | [用户界面与可观测性设计](09-用户界面与可观测性/用户界面与可观测性设计.md) | 前端信息架构与 trace |
| 10 | [数据模型与持久化设计](10-数据模型与持久化/数据模型与持久化设计.md) | 三库 schema 与迁移 |
| 11 | [配置体系与安全设计](11-配置体系与安全/配置体系与安全设计.md) | 三层配置 / 命名例外 / 信任级别 |
| 12 | [循环控制系统设计](12-循环控制系统/循环控制系统设计.md) | Verifier / StopRules / Fingerprint / ApprovalGate |
| 13 | [持久执行与恢复设计](13-持久执行与恢复/持久执行与恢复设计.md) | EffectJournal / Checkpoint / Recovery |
| 14 | [项目构建顺序](14-构建与实施/项目构建顺序.md) | S0~S14 阶段与验证门禁 |
| 15 | [参数总典](15-参数总典与接口契约/参数总典.md) | 全量参数与接口契约速查 |
| 16 | [前端改造基础文件](16-前端改造基础/前端改造基础文件.md) · [改造方案与构建顺序](16-前端改造基础/前端改造方案与构建顺序.md) | F0.x 前端任务 |
| 17 | [实验矩阵设计](17-实验矩阵与评估/实验矩阵设计.md) | 12 面 × BEN/ENV/SEC 覆盖模型 |

## 工程支撑线

- **03-开发规范**：五层接口契约（[core](03-开发规范/Interfaces/coreInterfaces.md) / [services](03-开发规范/Interfaces/servicesInterfaces.md) / [tools](03-开发规范/Interfaces/toolsInterfaces.md) / [infra](03-开发规范/Interfaces/infraInterfaces.md) / [interface](03-开发规范/Interfaces/interfaceInterfaces.md)）、[docs 迁移计划](03-开发规范/docsMigrationPlan.md)（状态：计划中）
- **04-使用指南**：[quickStart](04-使用指南/quickStart.md) · [configuration](04-使用指南/configuration.md) · [fullGuide](04-使用指南/fullGuide.md) · [troubleshooting](04-使用指南/troubleshooting.md)
- **05-部署运维**：部署（[local](05-部署运维/Deployment/local.md) · [windows](05-部署运维/Deployment/windows.md) · [docker](05-部署运维/Deployment/docker.md)）、Runbook（[healthCheck](05-部署运维/Runbooks/healthCheck.md) · [logAnalysis](05-部署运维/Runbooks/logAnalysis.md) · [rollback](05-部署运维/Runbooks/rollback.md) · [commonIssues](05-部署运维/Runbooks/commonIssues.md)）
- **99-审查记录**：[设计审查报告-Loop与Harness工程](99-审查记录/设计审查报告-Loop与Harness工程.md) · [后端Harness与Loop工程合规审查报告](99-审查记录/后端Harness与Loop工程合规审查报告.md)
- **[CHANGELOG](CHANGELOG.md)**：项目完整变更记录（唯一事实源）

## 相关外部文档

- 根 [README](../README.md)（项目入口）· [CONTRIBUTING](../CONTRIBUTING.md) · [ELECTRON 打包指南](../ELECTRON.md)
- [ADR/](../ADR/README.md)（架构决策 0001~0006）· 各目录 README：[Src](../Src/README.md) · [Client](../Client/README.md) · [Configs](../Configs/README.md) · [Tests](../Tests/README.md) · [Prompts](../Prompts/README.md) · [Skills](../Skills/README.md) · [Benchmarks](../Benchmarks/README.md) · [Scripts](../Scripts/README.md) · [electron](../electron/README.md) · [Data](../Data/README.md) · [Logs](../Logs/README.md)

## 维护约定

- 本目录只存放 Markdown 文档；截图归档于根目录 `Imgs/`（不入库），图标资源在 `assets/`
- 文档间引用一律使用相对路径；重命名/移动目录前先 `grep -r` 全量更新引用（见迁移计划注意事项）
- 每次设计变更同步登记 `Docs/CHANGELOG.md`
