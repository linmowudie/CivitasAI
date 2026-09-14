# 用户 Hook 目录

> 用户可在此目录下创建自定义 Hook 脚本。
> Hook 脚本在对应事件触发时执行，支持拦截（intercept）和观察（observe）两种模式。

## 目录结构

```
Data/Hooks/{HookName}/
├── manifest.json    # Hook 声明（事件类型、拦截/观察模式、超时）
├── handler.ts       # Hook 处理逻辑
└── config.json      # Hook 配置（可选）
```

## manifest.json Schema

```json
{
  "name": "my-hook",
  "version": "1.0.0",
  "event": "PreToolExecute",
  "mode": "observe|intercept",
  "timeout": 5000,
  "onError": "fail-open|fail-closed"
}
```

## 安全约束

- Hook 脚本在沙箱中执行
- 不可访问 `Data/Auth/` 目录
- 拦截模式（intercept）可阻止事件传播
- 观察模式（observe）仅记录，不影响事件流
- `onError` 为 `fail-closed` 时，Hook 执行失败会阻止事件
