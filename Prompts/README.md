# Prompts — 外置提示词库

提示词与代码分离，按用途分目录；启动时由 `main.ts` 第 ⑩ 步加载（热加载机制规划中）。

## 结构

```
roles/      # 8 个角色提示词：prime_director（总编排）、worker、partner、assembly_node、
            # arbitrator（仲裁）、auditor（审计）、regulator（监管）、reviewer（评审）
system/     # mainLoop.md —— 十步主循环的系统提示词
tasks/      # defaultTask.md —— 通用任务模板
versions/   # manifest.json —— 提示词版本清单（文件 → 版本哈希/生效记录）
```

## 约定

- 文件名即角色/用途标识，与 `Configs/loopConfig.json` 的 `roleOverrides` 中 `model`/提示词引用对应
- 修改提示词后须在 `versions/manifest.json` 登记版本，保证可回溯（Maker-Checker 验证依赖同一版本）
- 模板内可用 `{{placeholder}}` 占位符，由上下文组装阶段填充
