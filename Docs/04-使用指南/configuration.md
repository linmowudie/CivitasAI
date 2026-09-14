# 配置指南

> Civitas-AI 所有可配置项均有默认值，空配置可直接启动。本文档说明如何按需调整。

---

## 1. 配置文件体系

配置文件位于 `Configs/` 目录，JSON 格式：

| 文件 | 用途 |
|------|------|
| `default.json` | 系统基础配置（名称、版本、日志级别、端口） |
| `loopConfig.json` | Loop 参数（迭代上限、Token 预算、StopRules） |
| `modelRouter.json` | LLM 模型路由（Provider、模型选择、超时） |
| `routingRules.json` | 任务路由规则（复杂度→模式映射） |
| `supervision.json` | 监管参数（注入检测、频率限制） |
| `security.json` | 安全配置（信任级别、白名单、路径守卫） |
| `session.json` | 会话参数（超时、最大消息数） |
| `memory.json` | 共享记忆配置（容量、衰减率） |
| `arbitration.json` | 仲裁参数（仲裁庭规模、超时） |
| `audit.json` | 审计参数（巡逻间隔、冻结阈值） |
| `economyRules.json` | Token 经济规则（税率、分润比例） |
| `durable.json` | 持久执行参数（EffectJournal 超时、幂等缓存 TTL） |
| `coverageBaseline.json` | 测试覆盖率基线 |
| `benchBaseline.json` | 性能基准基线 |

## 2. 配置优先级

```
环境变量 > 本地覆盖 > 配置文件 > 默认值
```

- 环境变量格式：`CIVITAS_` 前缀 + 大写键名（如 `CIVITAS_LOG_LEVEL=debug`）
- `modelRouter.json` 中的 `env:XXX` 引用会自动从 `.env` 读取

## 3. 常用配置调整

### 3.1 调整 Token 预算

编辑 `Configs/loopConfig.json`：

```json
{
  "loopDefaults": {
    "token_budget": 200000  // 默认 100000，调大可处理更复杂任务
  },
  "stopRules": {
    "budget": {
      "softRatio": 0.6,      // 60% 时预警
      "hardRatio": 1.0        // 100% 时强制停止
    }
  }
}
```

### 3.2 调整角色参数

```json
{
  "roleOverrides": {
    "worker": {
      "max_iterations": 50,    // 默认 30
      "token_budget": 150000,  // 默认 100000
      "temperature": 0.3       // 默认 0.2
    }
  }
}
```

### 3.3 切换 LLM Provider

编辑 `Configs/modelRouter.json`：

```json
{
  "providers": [
    {
      "provider": "openai",
      "base_url": "https://your-api-endpoint/v1",
      "api_key_ref": "env:YOUR_API_KEY",
      "models": [{ "id": "gpt-4o", "inputPrice": 0.005, "outputPrice": 0.015 }]
    }
  ]
}
```

### 3.4 调整监管阈值

编辑 `Configs/supervision.json`：

```json
{
  "rateLimit": {
    "maxRequestsPerMinute": 30,  // 默认 60
    "maxTokensPerMinute": 100000
  }
}
```

## 4. 环境变量

所有 `env:XXX` 引用需要在 `.env` 文件中配置：

```bash
# LLM API Key
HUAWEI_MAAS_API_KEY=your_key_here

# 可选：覆盖默认配置
CIVITAS_LOG_LEVEL=debug
CIVITAS_HTTP_PORT=3000
CIVITAS_WS_PORT=3001
```

详见 `.env.example`。
