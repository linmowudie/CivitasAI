# 健康检查 Runbook

> 系统健康状态检查流程

---

## 快速检查清单

| 检查项 | 命令/方法 | 正常状态 |
|--------|----------|---------|
| 进程存活 | `curl http://localhost:3000/health` | 200 OK |
| WebSocket | `ws://localhost:3001` 连接测试 | 连接成功 |
| 数据库 | `Scripts/dbPeek.cjs` 检查表结构 | 表存在 |
| 磁盘空间 | `Data/db/` 文件大小 | < 1GB |
| 日志 | `Logs/` 目录下最新日志时间 | < 5 分钟前 |

## 详细检查

### 1. 服务存活

```bash
# HTTP 健康检查
curl -s http://localhost:3000/health | jq .

# WebSocket 连接
node -e "const ws=new(require('ws'))('ws://localhost:3001');ws.on('open',()=>{console.log('OK');ws.close()})"
```

### 2. 数据库完整性

```bash
# 使用 dbPeek 脚本检查
node Scripts/dbPeek.cjs --check
```

### 3. Token 守恒验证

检查审计日志中最近的守恒验证结果：

```bash
# 查看最近的审计事件
grep "token_conservation" Logs/*.log | tail -5
```

### 4. 活跃 Loop 状态

```bash
# 查看当前活跃 Loop 数量
grep "loop_started\|loop_terminated" Logs/*.log | tail -20
```

## 告警阈值

| 指标 | 警告 | 严重 |
|------|------|------|
| HTTP 响应时间 | > 5s | > 30s |
| 数据库文件大小 | > 500MB | > 1GB |
| 日志错误率 | > 1% | > 5% |
| Token 守恒偏差 | > 0.01% | > 0.1% |
