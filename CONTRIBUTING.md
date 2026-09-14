# 贡献指南

## 开发流程

1. Fork 本仓库并克隆到本地
2. 创建功能分支：`git checkout -b feat/your-feature`
3. 编码并编写测试
4. 确保 `npm run lint` 和 `npm test` 通过
5. 提交（遵循 [Conventional Commits](https://www.conventionalcommits.org/)）
6. 推送并创建 Pull Request

## 代码规范

- **五层单向依赖**：Interface → Core → Services → Tools → Infra，禁止反向依赖
- **命名规范**：目录 PascalCase，文件 camelCase，标识符跟随语言惯例
- **所有可配置项必须有默认值**，空配置下系统可直接启动
- **不允许留未定义行为**：遇到文档未覆盖的场景，必须先补充文档再实现

## 提交规范

```
feat: 新功能
fix: 修复 Bug
docs: 文档变更
test: 测试相关
refactor: 重构（不改变功能）
chore: 构建/工具链
```

## 架构决策

重大变更需提交 ADR（Architecture Decision Record）至 `ADR/` 目录。
