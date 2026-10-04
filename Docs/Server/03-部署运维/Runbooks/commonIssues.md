# 常见问题 Runbook

> 运维中常见问题的快速处理方案

---

## 1. 系统无法启动

**症状**：`npm run start` 后立即退出

**排查步骤**：
1. 检查端口是否被占用
2. 检查 `.env` 中 API Key 是否配置
3. 检查 `Data/db/` 目录权限
4. 查看控制台输出的具体错误信息

## 2. 数据库锁定

**症状**：`SQLITE_BUSY: database is locked`

**原因**：SQLite 不支持并发写入

**解决**：
1. 确认只有一个进程在写数据库
2. 检查 `busyTimeoutMs` 配置（默认 5000ms）
3. 必要时重启进程

## 3. 内存泄漏

**症状**：进程内存持续增长

**排查**：
1. 检查共享记忆 `maxEntries` 是否过大
2. 检查事件队列 `maxQueueSize` 是否过大
3. 检查是否有未关闭的 WebSocket 连接
4. 使用 `--inspect` 启动并用 Chrome DevTools 抓 heap snapshot

## 4. LLM 调用全部超时

**症状**：所有模型调用返回超时

**排查**：
1. 检查网络连接
2. 检查 API Key 是否有效
3. 检查 `modelRouter.json` 中的 `timeoutMs` 是否过短
4. 检查 LLM Provider 服务状态

## 5. 回滚操作

**场景**：新版本出现严重问题，需要回滚

**步骤**：
```bash
# 1. 停止当前服务
# 2. 回退代码
git checkout <last-known-good-commit>
# 3. 重新安装依赖（如有变更）
npm install
# 4. 重启
npm run start
```

**注意**：数据库迁移不可回退，如需回退版本，可能需要重置数据库。
