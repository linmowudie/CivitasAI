# Civitas-AI（智体城邦）

> 社会驱动型自治智能体系统 — 以 Token 经济、仲裁治理与 Loop 控制为核心的多 Agent 协作平台

[![CI](https://github.com/linmowudie/CivitasAI/actions/workflows/ci.yml/badge.svg)](https://github.com/linmowudie/CivitasAI/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node.js-%3E%3D20-green)](package.json)

---

## 核心特性

- **十步主循环**：输入接收 → 前置监管 → 中间件管线 → 上下文组装 → 监管懒监听 → 模型调用 → 输出解析 → 工具执行 → 后置监管 → 迭代判定
- **五层单向依赖**：Interface → Core → Services → Tools → Infra，ESLint 封死反向依赖
- **Verifier 四级分层**：L1 硬验证 → L2 规则 → L3 LLM Judge → L4 人类审批门（ADR-0003 不可跨越）
- **Durable Execution**：EffectJournal 副作用追踪 + Checkpoint 原子写入 + 幂等缓存 + 崩溃恢复
- **Token 双预算**：warm(0.36) / soft(0.6) / expandRequest(0.8) / hard(1.0) 四档渐进控制
- **仲裁六步治理**：立案 → 胶囊组装 → 裁决 → 律师函挂起 → 现场恢复 → 知识沉淀
- **Maker-Checker 硬分离**：producerModel ≠ verifierModel（ADR-0004）
- **LoopState 不可变区**：goal / immutableConstraints 禁被压缩修改（ADR-0005）

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
├── Configs/            # 14 个 JSON 配置文件（空配置可启动）
├── Docs/               # 设计文档 + 审查记录 + CHANGELOG
├── Tests/              # 26 spec 文件 / 609+ 测试
├── Prompts/            # 提示词外置（roles / system / tasks / versions）
├── Skills/             # 策略与评分标准（playbooks / rubrics / rules / strategies）
├── ADR/                # 架构决策记录（0001~0005）
└── Benchmarks/         # 基准评估（baselines / datasets）
```

## 文档索引

| 文档 | 说明 |
|------|------|
| [系统设计总览](Docs/01-系统概览/系统设计总览.md) | 全局架构 + 模块索引 |
| [核心架构设计](Docs/02-核心架构/核心架构设计.md) | 五层架构 + 十步主循环 + 六钩子中间件 |
| [Loop 控制系统设计](Docs/12-循环控制系统/循环控制系统设计.md) | Verifier / StopRules / Fingerprint / ApprovalGate |
| [持久执行与恢复](Docs/13-持久执行与恢复/持久执行与恢复设计.md) | EffectJournal / Checkpoint / Recovery |
| [项目构建顺序](Docs/14-构建与实施/项目构建顺序.md) | S0~S14 十四阶段 + 验证门禁 |
| [CHANGELOG](Docs/CHANGELOG.md) | 完整变更记录 |

## 开发

```bash
npm run build        # TypeScript 编译
npm test             # 运行全部测试
npm run lint         # ESLint 检查
npm run test:watch   # 测试监听模式
```

## 许可

[MIT License](LICENSE) © 2026 马宏宇
