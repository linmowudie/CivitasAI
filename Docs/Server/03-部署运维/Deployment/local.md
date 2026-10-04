# 本地部署指南

> 在本地开发环境中部署 Civitas-AI

---

## 前置要求

- **Node.js** ≥ 20.0.0
- **npm** ≥ 10.0.0
- **Git**
- 华为云 MaaS API Key（或其他 LLM Provider）

## 安装步骤

```bash
# 1. 克隆仓库
git clone https://github.com/linmowudie/CivitasAI.git
cd CivitasAI

# 2. 安装依赖
npm install

# 3. 配置环境变量
cp .env.example .env
# 编辑 .env，填入 API Key

# 4. 启动
npm run dev
```

## 服务端口

| 服务 | 默认端口 | 配置项 |
|------|---------|--------|
| HTTP API | 3000 | `server.httpPort` |
| WebSocket | 3001 | `server.wsPort` |
| 前端（Vite） | 5173 | Client 内置 |

## 开发模式

```bash
# 后端 + 前端热重载
npm run dev

# 仅后端
npm run dev:server

# Electron 桌面模式
npm run dev:electron
```

## 生产模式

```bash
# 编译
npm run build:all

# 启动
npm run start
```

## 验证安装

```bash
# 类型检查
npx tsc --noEmit

# 运行测试
npm test

# ESLint
npm run lint
```
