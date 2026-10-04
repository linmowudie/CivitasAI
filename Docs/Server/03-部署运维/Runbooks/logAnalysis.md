# 日志分析 Runbook

> 日志结构说明与常用分析方法

---

## 日志结构

日志位于 `Logs/` 目录，JSON Lines 格式：

```json
{
  "timestamp": "2026-09-14T10:30:00.000Z",
  "level": "info",
  "message": "模型调用完成",
  "source": "modelCaller",
  "trace_id": "uuid-v4",
  "operation_id": "1726300200000-a1b2",
  "metadata": { "model": "gpt-4o", "tokensUsed": 1500, "latencyMs": 2300 }
}
```

## 常用分析

### 1. 按 trace_id 追踪完整链路

```bash
grep "trace-xxx" Logs/*.log | jq -c '{timestamp, level, source, message}'
```

### 2. 统计错误分布

```bash
grep '"level":"error"' Logs/*.log | jq -r '.source' | sort | uniq -c | sort -rn
```

### 3. 模型调用延迟分析

```bash
grep "模型调用完成" Logs/*.log | jq -r '.metadata.latencyMs' | sort -n | tail -20
```

### 4. Token 消耗趋势

```bash
grep "tokensUsed" Logs/*.log | jq -r '[.timestamp, .metadata.tokensUsed] | @tsv'
```

## 日志级别

| 级别 | 含义 | 处理方式 |
|------|------|---------|
| debug | 调试信息 | 开发环境使用 |
| info | 正常操作 | 无需处理 |
| warn | 潜在问题 | 关注但不阻塞 |
| error | 操作失败 | 需要排查 |
| fatal | 系统级错误 | 立即处理 |
