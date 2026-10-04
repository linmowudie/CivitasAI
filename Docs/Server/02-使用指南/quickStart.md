# 快速开始指南

> 5 分钟内跑起来 Civitas-AI

## 前置要求

- Node.js ≥ 20.0.0
- npm ≥ 10
- 华为云 MaaS API Key（[获取地址](https://console.huaweicloud.com/maas)）

## 安装

```bash
git clone https://github.com/linmowudie/CivitasAI.git
cd CivitasAI
npm install
```

## 配置

```bash
cp .env.example .env
```

编辑 `.env`，填入你的 API Key：

```
HUAWEI_MAAS_API_KEY=your_actual_key_here
```

## 启动

```bash
# 开发模式（后端 + 前端热重载）
npm run dev

# 或生产模式
npm run build
npm run start
```

启动成功后：
- 后端 API：`http://localhost:3000`
- WebSocket：`ws://localhost:3001`
- 前端界面：`http://localhost:5173`

## 验证

```bash
# 运行测试
npm test

# 类型检查
npx tsc --noEmit

# ESLint
npm run lint
```

## 常见问题

### 模型调用失败
检查 `.env` 中的 `HUAWEI_MAAS_API_KEY` 是否正确，以及网络是否能访问华为云 MaaS 端点。

### 端口冲突
默认端口 3000/3001/5173 被占用时，修改 `Configs/default.json` 中的端口配置。

### 数据库初始化
首次启动自动创建 SQLite 数据库（`Data/db/`），无需手动操作。
