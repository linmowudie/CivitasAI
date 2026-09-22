# Tests — 测试套件

Vitest，36 个 `*.spec.ts`（609+ 用例）按被测分层组织，另有联调诊断脚本。

## 目录结构

| 目录 | 覆盖 |
|------|------|
| `Infra/` | 配置加载、DB、持久执行、FS、LLM、日志、安全、时间、工作区（9 spec） |
| `Tools/` | 工具注册表 / 工厂 / Trait 契约 |
| `Services/` `TokenEconomy/` `LoopControl/` `EventBus/` `Judicial/` | 各服务层：经济、Loop 控制、事件总线、司法监管 |
| `Core/` `AgentRuntime/` `Decision/` `Runtime/` | 引擎层：主循环、Agent 运行时（含 `realAgent` 真实调用）、编排决策 |
| `Interface/` | 前后端集成与交互可观测性 |
| `Durable/` | 故障注入下的持久执行恢复 |
| `E2E/` | 七种工作方式（direct / delegation / assemblyLine / consortium / litigation / regulationAudit）+ 冲突仲裁、崩溃恢复、Loop 收敛 |
| `Integration/` | 权限拆分等跨层集成；`realAgentCallTest.ts` 为真实模型联调（非 CI 门禁） |
| `Parallel/` | 并行协作 |
| `Experiments/` | 实验矩阵脚手架：`adversarial/`（安全攻击 + 环境故障）、`benign/`（非对抗冒烟），对应 `Benchmarks/experimentMatrix.json` |
| `gateG0.spec.ts` | G0 启动门禁：空配置可启动、层边界、基础健康检查 |

## 运行

```bash
npm test                 # 全量（vitest run）
npm run test:watch       # 监听模式
npm run test:coverage    # 覆盖率（基线见 Configs/coverageBaseline.json）
node Scripts/experimentMatrix.cjs   # 实验矩阵覆盖门禁
```

## 约定

- 集成/E2E 测试打真实 SQLite 与真实模型接口，不在测试内 mock 数据库
- 新增 `Experiments/` 用例须同步登记 `Benchmarks/experimentMatrix.json` 对应 cell，禁止写伪断言（未实现的检测点标 `declared-only`）
