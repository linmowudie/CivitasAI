# Civitas-AI（智体城邦）

> 社会驱动型自治智能体系统 — 以 Token 经济、仲裁治理与 Loop 控制为核心的多 Agent 协作平台

Civitas-AI 是一个**生产级多 Agent 编排引擎**，通过十步主循环、双预算控制与仲裁治理机制，实现复杂任务的自主分解、执行与自我修复。系统将 LLM 调用封装为可审计、可恢复、可观测的工作流，适用于需要长期运行、高可靠性与人机协作的智能体场景。

[![CI](https://github.com/linmowudie/CivitasAI/actions/workflows/ci.yml/badge.svg)](https://github.com/linmowudie/CivitasAI/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node.js-%3E%3D20-green)](package.json)

---

## 适用场景

- **复杂任务自动化**：将模糊的用户需求拆解为多步骤工作流，自动调度不同能力的 Agent 协同完成
- **长期运行的智能体服务**：通过 Checkpoint 持久化与崩溃恢复，支持数小时乃至数天的连续任务执行
- **人机协作审核**：Verifier 四级验证门（硬验证 → 规则 → LLM Judge → 人类审批）确保关键操作的可控性
- **多角色权限治理**：8 种 Agent 角色映射到 3 级信任体系（L0 系统级 / L1 入口级 / L2 执行级），细粒度控制工具可见性与执行权
- **资源成本管控**：Token 双预算机制（warm/soft/expandRequest/hard 四档）防止单次任务超支

---

## 核心特性

### 执行引擎
- **十步主循环**：输入接收 → 前置监管 → 中间件管线 → 上下文组装 → 监管懒监听 → 模型调用 → 输出解析 → 工具执行 → 后置监管 → 迭代判定
- **Durable Execution**：EffectJournal 副作用追踪 + Checkpoint 原子写入 + 幂等缓存 + 崩溃恢复，支持进程重启后从断点继续
- **Token 双预算**：warm(0.36) / soft(0.6) / expandRequest(0.8) / hard(1.0) 四档渐进控制，防止单次任务超支

### 治理与权限
- **仲裁六步治理**：立案 → 胶囊组装 → 裁决 → 律师函挂起 → 现场恢复 → 知识沉淀，处理 Agent 间冲突与异常
- **多角色信任体系**：8 种 Agent 角色（Prime Director / Partner / Worker / Assembly Line / Reviewer / Arbitrator / Regulator / Auditor）映射到 3 级信任（L0/L1/L2），细粒度控制工具可见性与执行权
- **Maker-Checker 硬分离**：producerModel ≠ verifierModel（ADR-0004），避免"既当运动员又当裁判"

### 架构约束
- **五层单向依赖**：Interface → Core → Services → Tools → Infra，ESLint 封死反向依赖，确保架构清晰可维护
- **LoopState 不可变区**：goal / immutableConstraints 禁被压缩修改（ADR-0005），保证任务目标不被漂移
- **Verifier 四级分层**：L1 硬验证 → L2 规则 → L3 LLM Judge → L4 人类审批门（ADR-0003 不可跨越）

---

## 架构速览

```
┌─────────────────────────────────────────────────┐
│              Interface Layer                     │
│   WebSocket Server | REST API | Web Server       │
└──────────────────────┬──────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────┐
│                Core Layer                        │
│   Loop Engine | Middleware Pipeline | Decision   │
│   (Input → PreCheck → MW → Context → Model →    │
│    Parse → ToolExec → PostCheck → Iterate)       │
└──────────────────────┬──────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────┐
│              Services Layer                      │
│   LoopControl | Supervision | TokenEconomy |     │
│   Arbitration | AgentRuntime | Memory            │
└──────────────────────┬──────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────┐
│               Tools Layer                        │
│   Registry | Factory | Builtin | Custom          │
│   (Shell / Code Eval / File I/O / Network ...)   │
└──────────────────────┬──────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────┐
│             Infrastructure Layer                 │
│   SQLite DB | Logging | Security | DurableExec  │
│   LLM Client | Config Loader                    │
└─────────────────────────────────────────────────┘
```

## 技术栈

| 层 | 技术 |
|---|------|
| 语言 | TypeScript 5.x (strict) |
| 运行时 | Node.js ≥ 20 |
| 数据库 | SQLite (better-sqlite3) |
| 前端 | React 18 + Zustand + Vite |
| 桌面 | Electron |
| 通信 | WebSocket + REST (原生 http) |
| 测试 | Vitest (609+ 项) |
| LLM | 华为云 MaaS OpenAI 兼容接口 |

## 快速开始

```bash
# 1. 克隆仓库
git clone https://github.com/linmowudie/CivitasAI.git
cd CivitasAI

# 2. 安装依赖
npm install

# 3. 配置环境变量
cp .env.example .env
# 编辑 .env 填入 HUAWEI_MAAS_API_KEY

# 4. 启动
npm run dev        # 开发模式（后端 + 前端）
npm run start      # 生产模式
```

## 项目结构

```
CivitasAI/
├── Src/
│   ├── Core/           # 引擎层（Loop / Middleware / Model / AgentRuntime / Decision）
│   ├── Services/       # 服务层（LoopControl / Supervision / TokenEconomy / Arbitration / ...）
│   ├── Tools/          # 工具层（Builtin / Custom / Registry / Factory / Traits）
│   ├── Infra/          # 基础设施层（Db / Logging / Security / DurableExecution / Llm / ...）
│   ├── Interface/      # 交互层（WebSocket / RestApi / WebServer / InputDeduplication）
│   └── main.ts         # 启动入口
├── Client/             # React 前端
├── Configs/            # 15 个 JSON 配置文件（空配置可启动）
├── Docs/               # 设计文档 + 审查记录 + CHANGELOG
├── Tests/              # 36 spec / 609+ 测试
├── Prompts/            # 提示词外置（roles / system / tasks / versions）
├── Skills/             # 策略与评分标准（playbooks / rubrics / rules / strategies）
├── ADR/                # 架构决策记录（0001~0006）
├── Benchmarks/         # 基准评估（实验矩阵 / baselines / datasets）
├── Scripts/            # 构建 / 生成 / 诊断脚本
├── electron/           # Electron 桌面壳
├── Data/               # 运行时数据（SQLite / 会话 / 检查点 / 沙箱，不入库）
├── Logs/               # JSON Lines 日志（不入库）
└── Imgs/               # 验证截图归档（不入库）
```

## 文档索引

完整索引见 [Docs/README](Docs/README.md)。

### 🚀 新手入门

| 文档 | 说明 |
|------|------|
| [快速上手](Docs/04-使用指南/quickStart.md) | 5 分钟启动系统，配置 LLM API Key |
| [使用指南](Docs/04-使用指南/guide.md) | 完整功能说明与排障手册 |
| [部署运维](Docs/05-部署运维/Deployment/local.md) | 本地 / Windows / Docker 部署 + Runbook |

### 📐 架构深入

| 文档 | 说明 |
|------|------|
| [系统设计总览](Docs/01-系统概览/系统设计总览.md) | 全局架构 + 模块索引 + 核心隐喻 |
| [核心架构设计](Docs/02-核心架构/核心架构设计.md) | 五层架构 + 十步主循环 + 六钩子中间件 |
| [Loop 控制系统](Docs/12-循环控制系统/循环控制系统设计.md) | Verifier / StopRules / Fingerprint / ApprovalGate |
| [持久执行与恢复](Docs/13-持久执行与恢复/持久执行与恢复设计.md) | EffectJournal / Checkpoint / Recovery |
| [配置体系与安全](Docs/11-配置体系与安全/配置体系与安全设计.md) | 15 个配置文件 + 三层覆盖 + 热重载 |

### 🔧 工程实践

| 文档 | 说明 |
|------|------|
| [项目构建顺序](Docs/14-构建与实施/项目构建顺序.md) | S0~S14 十四阶段 + 验证门禁 |
| [开发规范](Docs/03-开发规范/) | 接口契约 / 代码风格 / 测试约定 |
| [ADR 决策记录](ADR/README.md) | 0001~0006 架构决策（不可变历史） |
| [CHANGELOG](Docs/CHANGELOG.md) | 完整变更记录（唯一事实源） |

### 📂 目录 README

[Src](Src/README.md)（五层与启动 18 步）· [Client](Client/README.md) · [Configs](Configs/README.md) · [Tests](Tests/README.md) · [Prompts](Prompts/README.md) · [Skills](Skills/README.md) · [Benchmarks](Benchmarks/README.md) · [ADR](ADR/README.md) · [Scripts](Scripts/README.md) · [electron](electron/README.md) · [Data](Data/README.md) · [Logs](Logs/README.md) · [Imgs](Imgs/README.md)

---

## 开发

```bash
npm run build        # TypeScript 编译
npm test             # 运行全部测试
npm run lint         # ESLint 检查
npm run test:watch   # 测试监听模式
```

### 贡献指南

1. **阅读架构文档**：先读 [系统设计总览](Docs/01-系统概览/系统设计总览.md) 理解五层依赖与主循环
2. **遵循开发规范**：接口契约见 [Docs/03](Docs/03-开发规范/)，代码风格通过 `npm run lint` 验证
3. **编写测试**：新功能需配套 Vitest 用例，确保 `npm test` 全绿
4. **更新文档**：修改核心逻辑时同步更新对应设计文档（向代码看齐，未实现目标标 ⚠️）
5. **提交 PR**：分支命名 `feat/<功能>` / `fix/<问题>`，附带清晰的变更说明与测试截图

---

## 许可

[MIT License](LICENSE) © 2026 马宏宇
