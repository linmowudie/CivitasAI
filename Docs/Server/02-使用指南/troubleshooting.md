# 故障排除指南

> 常见问题与解决方案

---

## 1. 启动问题

### 1.1 配置加载失败

**症状**：`[FATAL] 配置加载失败: ...`

**排查**：
1. 确认 `Configs/` 目录下所有 JSON 文件格式正确（无语法错误）
2. 确认 `Configs/default.json` 存在
3. 检查 `loopConfig.json` 中 `roleOverrides` 是否包含全部 8 个角色

**解决**：
```bash
# 验证 JSON 格式
node -e "JSON.parse(require('fs').readFileSync('Configs/default.json','utf8'))"
```

### 1.2 数据库初始化失败

**症状**：`数据库初始化失败: ...` 或 `数据库迁移失败: ...`

**排查**：
1. 确认 `Data/db/` 目录存在且有写权限
2. 检查磁盘空间是否充足
3. 如果是升级导致的迁移失败，检查 CHANGELOG 中的迁移说明

**解决**：
```bash
# 重置数据库（会丢失所有数据）
rm Data/db/civitas_*.db*
# 重启后自动重建
```

### 1.3 端口冲突

**症状**：`Error: listen EADDRINUSE: address already in use 0.0.0.0:3000`

**解决**：
```bash
# 查找占用端口的进程
netstat -ano | findstr :3000
# 或修改配置
# Configs/default.json → server.httpPort 改为其他端口
```

### 1.4 LLM Provider 不可用

**症状**：`无可用 LLM Provider` 或模型调用超时

**排查**：
1. 检查 `.env` 中的 API Key 是否正确
2. 确认网络能访问 LLM 端点
3. 检查 `Configs/modelRouter.json` 中的 `base_url` 是否正确

## 2. 运行时问题

### 2.1 Loop 不收敛

**症状**：Agent 反复执行相同操作，进度为零

**原因**：StopRules 的 `noProgress` 检测触发

**解决**：
1. 检查 `loopConfig.json` 中 `stopRules.noProgress.stagnationWindowRounds`（默认 3）
2. 系统会自动触发策略切换（`switch_strategy`）
3. 如果所有策略都失败，会自动升级到人工决策（`escalate_human`）

### 2.2 Token 预算耗尽

**症状**：Loop 因 Token 超限被强制终止

**排查**：
1. 检查 `loopConfig.json` 中 `loopDefaults.token_budget`
2. 检查上下文是否过大（`context.truncationUsageRatio`）
3. 查看审计日志确认是否有 Token 浪费

**解决**：
- 增大 `token_budget`
- 降低 `context.truncationUsageRatio`（更早截断上下文）
- 优化任务拆解，减少单 Loop 范围

### 2.3 工具执行失败

**症状**：工具调用返回错误，连续失败 3 次后 Agent 停止

**排查**：
1. 检查工具参数是否正确
2. 确认工具所需的权限（危险级别）
3. 检查 EffectJournal 中的状态（INTENT → EXECUTING → ?）

### 2.4 审批门超时

**症状**：DANGEROUS 工具调用等待审批超时，默认被拒绝

**解决**：
- 确认审批人在线
- 调整 `loopConfig.json` 中审批超时时间
- 注意：超时默认行为是 **拒绝**（安全优先），不可改为默认通过

## 3. 性能问题

### 3.1 响应缓慢

**排查**：
1. 检查 LLM 调用延迟（日志中的 `llmLatency` 指标）
2. 检查上下文大小（是否接近 Token 上限）
3. 检查并发 Loop 数量

### 3.2 内存占用过高

**排查**：
1. 检查共享记忆容量（`memory.json` → `maxEntries`）
2. 检查事件队列大小（`maxQueueSize`）
3. 检查 SQLite WAL 文件大小

## 4. 安全事件

### 4.1 注入检测告警

**症状**：日志中出现 `INJECTION_DETECTED` 事件

**处理**：
1. 检查输入内容是否包含可疑指令
2. 确认前置监管（`preSupervision`）正常工作
3. 如为误报，调整 `supervision.json` 中的检测阈值

### 4.2 Token 守恒异常

**症状**：审计局报告守恒验证失败

**处理**：
1. 这是严重事件，立即检查所有活跃 Loop
2. 查看审计日志定位异常来源
3. 必要时暂停系统并重启
