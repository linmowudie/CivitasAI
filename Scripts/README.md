# Scripts — 构建与诊断脚本

| 脚本 | 用途 | 调用方式 |
|------|------|---------|
| `build.cjs` | esbuild 打包后端到 `dist/main/`（不依赖严格类型检查） | `npm run build:server` |
| `genEventTypes.ts` | 从后端 `EventType` 枚举生成前端 `Client/src/shared/eventTypes.ts` | `npm run gen:event-types` |
| `experimentMatrix.cjs` | 实验矩阵守门：校验 `Benchmarks/experimentMatrix.json` 四条覆盖规则 | `node Scripts/experimentMatrix.cjs` |
| `rubricRecalibrate.ts` | 评分标准重校准（Docs/14 §S14，更新 `Skills/rubrics/`） | `tsx Scripts/rubricRecalibrate.ts` |
| `traceAnalysis.ts` | Trace 回放分析（Docs/14 §S14） | `tsx Scripts/traceAnalysis.ts` |
| `dbPeek.cjs` | 诊断：查看某会话最近消息 | `node Scripts/dbPeek.cjs` |
| `dupCheck.cjs` | 诊断：检测后端是否对同一 chunk 双重推送 | `node Scripts/dupCheck.cjs` |
| `wsDiagnose.cjs` | 联调诊断：模拟前端 WS 行为，测 `generate_reply` 全链路时序 | `node Scripts/wsDiagnose.cjs <sessionId>` |
| `llmLatency.cjs` | 诊断：实测华为云 MaaS 各模型流式首响延迟 | `node Scripts/llmLatency.cjs` |
| `install.sh` / `install.ps1` | 一键安装（Linux/macOS / Windows） | `bash Scripts/install.sh` / `.\Scripts\install.ps1` |

## 约定

- 诊断脚本直连真实运行中的服务/数据库，只读为主，不写业务数据
- 门禁类脚本（`experimentMatrix.cjs`）在 CI 中执行，失败以非 0 退出码阻断
