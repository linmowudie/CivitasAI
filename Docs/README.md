# Docs — 文档总索引

Civitas-AI（智体城邦）全部设计文档、使用指南与审查记录。按**三端主分类**组织：`Agent/`（多智能体编排引擎与后端五层）、`Client/`（前端与 Electron 客户端）、`Server/`（账号服务端与使用/部署运维），每个分类内独立编号。`Dev/` 为开发文档区（文档-代码差别清单，2026-10-03 起），`99-审查记录/` 为跨端历史审查快照，保留原位。

> **📌 文档与代码的关系**：本目录设计文档向代码看齐（代码为唯一事实源）；未实现的目标态一律标 `⚠️ 未实现/目标态`。项目**灵感来源**（非现状契约）见根目录三份文件，见文末「灵感来源文件」。
>
> **🔢 引用记法**：正文中 `Docs/Agent/11 §2` 表示 Agent 分类 11 号文档第 2 节。2026-10-03 前的旧文档使用全局 01-20 编号，新旧对照见 [CHANGELOG](CHANGELOG.md) 与 [迁移计划](Agent/16-开发规范/docsMigrationPlan.md)。

## Agent — 编排引擎与后端（16 篇）

| 编号 | 文档 | 内容 |
|------|------|------|
| 01 | [系统设计总览](Agent/01-系统概览/系统设计总览.md) | 全局架构 + 模块索引（跨三端总览） |
| 02 | [核心架构设计](Agent/02-核心架构/核心架构设计.md) | 五层架构 + 十步主循环 + 六钩子中间件 + 启动 18 步/关闭 9 步 |
| 03 | [Agent 编排引擎设计](Agent/03-Agent编排引擎/Agent编排引擎设计.md) | orchestrator 编排（后端 RoutingMode 6 成员 / 前端 WorkingMode 7 值 / 实际可路由 4 种） |
| 04 | [Token 经济系统设计](Agent/04-Token经济系统/Token经济系统设计.md) | 钱包 / 税收 / 双预算 |
| 05 | [仲裁系统设计](Agent/05-仲裁系统/仲裁系统设计.md) | 六步治理闭环 / 律师函挂起 |
| 06 | [监管与审计系统设计](Agent/06-监管与审计系统/监管与审计系统设计.md) | 前置/懒监听/后置监管 + 审计 |
| 07 | [共享记忆与上下文系统设计](Agent/07-共享记忆与上下文系统/共享记忆与上下文系统设计.md) | 写入守卫 / 冲突检测 / 裁决优先级 |
| 08 | [Agent 间通信协议设计](Agent/08-Agent间通信协议/Agent间通信协议设计.md) | 消息协议与事件总线 |
| 09 | [数据模型与持久化设计](Agent/09-数据模型与持久化/数据模型与持久化设计.md) | 三库 schema 与迁移 |
| 10 | [配置体系与安全设计](Agent/10-配置体系与安全/配置体系与安全设计.md) | 三层配置 / 命名例外 / 信任级别 |
| 11 | [循环控制系统设计](Agent/11-循环控制系统/循环控制系统设计.md) | Verifier / StopRules / Fingerprint / ApprovalGate |
| 12 | [持久执行与恢复设计](Agent/12-持久执行与恢复/持久执行与恢复设计.md) | EffectJournal / Checkpoint / Recovery |
| 13 | [项目构建顺序](Agent/13-构建与实施/项目构建顺序.md) | S0~S14 阶段与验证门禁 |
| 14 | [参数总典](Agent/14-参数总典与接口契约/参数总典.md) | 全量参数与接口契约速查 |
| 15 | [实验矩阵设计](Agent/15-实验矩阵与评估/实验矩阵设计.md) | 12 面 × BEN/ENV/SEC 覆盖模型 |
| 16 | [开发规范](Agent/16-开发规范/) | 五层接口契约（[core](Agent/16-开发规范/Interfaces/coreInterfaces.md) / [services](Agent/16-开发规范/Interfaces/servicesInterfaces.md) / [tools](Agent/16-开发规范/Interfaces/toolsInterfaces.md) / [infra](Agent/16-开发规范/Interfaces/infraInterfaces.md) / [interface](Agent/16-开发规范/Interfaces/interfaceInterfaces.md)）、[docs 迁移计划](Agent/16-开发规范/docsMigrationPlan.md) |

## Client — 前端与 Electron 客户端（4 篇）

| 编号 | 文档 | 内容 |
|------|------|------|
| 01 | [用户界面与可观测性设计](Client/01-用户界面与可观测性/用户界面与可观测性设计.md) | 前端信息架构与 trace |
| 02 | [前端改造基础文件](Client/02-前端改造基础/前端改造基础文件.md) · [改造方案与构建顺序](Client/02-前端改造基础/前端改造方案与构建顺序.md) · [三栏自适应工作界面设计规格](Client/02-前端改造基础/三栏自适应工作界面设计规格.md) · [前端验收缺陷清单](Client/02-前端改造基础/前端验收缺陷清单.md)（FE-xxx） | F0.x 前端任务与验收 |
| 03 | [AI 组件族架构设计](Client/03-AI组件族架构/AI组件族架构设计.md) · [后端接口契约](Client/03-AI组件族架构/后端接口契约.md) · [测试策略设计](Client/03-AI组件族架构/测试策略设计.md) | 前端 AI 组件族分层 / 契约 / 测试 |
| 04 | [客户端接入服务端](Client/04-客户端接入账号与同步/客户端接入设计.md) | Electron 接入：账号面板 / 令牌安全存储 / 偏好·长时记忆·统计同步 |

## Server — 账号服务端与运维（3 组）

| 编号 | 文档 | 内容 |
|------|------|------|
| 01 | [服务端设计文档](Server/01-服务端/服务端设计文档.md) · [服务端缺陷清单](Server/01-服务端/服务端缺陷清单.md)（SV-xxx） | 账号登录 / 设置 / 个人统计 / 记忆存储 / 备份恢复（服务端权威，支持卸载重装重建） |
| 02 | [使用指南](Server/02-使用指南/) | [quickStart](Server/02-使用指南/quickStart.md) · [configuration](Server/02-使用指南/configuration.md) · [fullGuide](Server/02-使用指南/fullGuide.md) · [troubleshooting](Server/02-使用指南/troubleshooting.md) |
| 03 | [部署运维](Server/03-部署运维/) | 部署（[local](Server/03-部署运维/Deployment/local.md) · [windows](Server/03-部署运维/Deployment/windows.md) · [docker](Server/03-部署运维/Deployment/docker.md)）、Runbook（[healthCheck](Server/03-部署运维/Runbooks/healthCheck.md) · [logAnalysis](Server/03-部署运维/Runbooks/logAnalysis.md) · [rollback](Server/03-部署运维/Runbooks/rollback.md) · [commonIssues](Server/03-部署运维/Runbooks/commonIssues.md)） |

## Dev — 开发文档区

[文档-代码差别清单总索引](Dev/README.md)：2026-10-03 对全部 23 组设计文档逐篇审查代码，共 806 条差异（含跨文档共性问题与处理约定）。

## 99-审查记录（跨端历史快照）

[设计审查报告-Loop与Harness工程](99-审查记录/设计审查报告-Loop与Harness工程.md) · [后端Harness与Loop工程合规审查报告](99-审查记录/后端Harness与Loop工程合规审查报告.md) · [设计审查报告-AI组件族架构](99-审查记录/设计审查报告-AI组件族架构.md)

> 审查报告为撰写时点的快照，其中的旧编号路径（`Docs/03-开发规范/`、`Docs/04-使用指南/` 等）不回改。

- **[CHANGELOG](CHANGELOG.md)**：设计文档集完整变更记录（唯一事实源）
- **注意**：根目录另有 [`../CHANGELOG.md`](../CHANGELOG.md)，是**代码/工程变更记录**（前端/后端实现）；二者分工不同（改代码看根 CHANGELOG，查设计演进看本 CHANGELOG）

## 灵感来源文件（根目录，非现状契约）

| 文件 | 内容定位 | 已提炼到 |
|------|---------|---------|
| [`../产品需求文档：Civitas-AI（智体城邦）自治智能体系统.md`](../产品需求文档：Civitas-AI（智体城邦）自治智能体系统.md) | 早期 PRD（含 AI 生成）— 角色与 6 种路由模式设想 | Agent/01 系统总览 / Agent/03 编排 |
| [`../一些思考.md`](../一些思考.md) | 论文《动态控制仲裁者数量》 | Agent/01 §4.7 动态仲裁者数量 |
| [`../一些思考2.md`](../一些思考2.md) | 《治理型多 Agent 共享记忆系统架构设计》 | Agent/01 §4.8 / Agent/05 仲裁 / Agent/07 共享记忆 |

> 这三份为项目**灵感的原始来源**；其内容可能与现状代码有出入（如"6 种路由模式"），现状准据一律以 `README` 与本目录设计文档（代码为唯一事实源）为准。

## 相关外部文档

- 根 [README](../README.md)（项目入口）· [CONTRIBUTING](../CONTRIBUTING.md) · [ELECTRON 打包指南](../ELECTRON.md)
- [ADR/](../ADR/README.md)（架构决策 0001~0006）· 各目录 README：[Src](../Src/README.md) · [Client](../Client/README.md) · [Server](../Server/README.md) · [Configs](../Configs/README.md) · [Tests](../Tests/README.md) · [Prompts](../Prompts/README.md) · [Skills](../Skills/README.md) · [Benchmarks](../Benchmarks/README.md) · [Scripts](../Scripts/README.md) · [electron](../electron/README.md) · [Data](../Data/README.md) · [Logs](../Logs/README.md)

## 维护约定

- 本目录只存放 Markdown 文档；截图归档于根目录 `Imgs/`（不入库），图标资源在 `assets/`
- 三分类内文档各自独立编号；新增文档在对应分类末尾追加编号
- 文档间引用一律使用相对路径或 `Docs/<分类>/<编号>` 记法；重命名/移动目录前先 `grep -r` 全量更新引用（含 Src/Client/Server 代码注释中的 `Docs/` 引用）
- 每次设计变更同步登记 `Docs/CHANGELOG.md`
