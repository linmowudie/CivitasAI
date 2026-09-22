# Client — React 前端

Vite + React 18 + TypeScript + Zustand 单页应用，通过 REST（:3000）与 WebSocket（:3001）与后端通信。

## 目录结构

```
src/
├── views/          # 11 个页面：Dashboard / ChatView / AgentMonitor / ApprovalQueue /
│                   # ArbitrationView / LoopDebugger / TaskPanel / TokenLedger /
│                   # TraceReplay / WorkingModes / SystemConfig
├── components/     # 按功能域分组：Chat / Layout / Dashboard / AgentMonitor / Approval /
│                   # ApprovalQueue / ArbitrationView / LoopDebugger / TaskPanel /
│                   # TraceReplay / Settings / WorkingModes
├── stores/         # Zustand：chatStore / agentStore / taskStore / tokenStore /
│                   # loopStore / approvalStore / systemStore / configStore
├── hooks/          # useWebSocket / useTaskStream / useAlerts / useDashboardData
├── services/       # api.ts（REST 封装）、ws.ts（WS 网关封装）
├── shared/         # eventTypes.ts —— 由 `npm run gen:event-types` 从后端生成，勿手改
├── config/         # configSchema.ts / schemaTypes.ts —— 系统设置面板的元数据驱动 schema
└── data/           # 静态数据
```

## 开发

```bash
# 在仓库根目录
npm run dev            # 后端 + Vite（前端 http://localhost:5173）
npm run build:client   # 产出 dist/renderer/
```

## 约定

- 事件类型唯一事实源在后端 `Src/Services/EventBus/eventTypes.ts`，前端副本必须经生成脚本同步
- 聊天流式渲染走 WS（`useWebSocket`），配置读写走 REST `/api/config*`，模型列表 `/api/models`
- 路由入口在 `src/App.tsx` / `main.tsx`，页面级组件一一对应侧边栏导航
