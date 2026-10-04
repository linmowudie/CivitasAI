# 回滚 Runbook

> 版本回滚与数据恢复流程

---

## 回滚决策

| 情况 | 操作 |
|------|------|
| 代码 Bug（无数据库变更） | 直接回退代码 |
| 数据库迁移后发现问题 | 回退代码 + 数据库备份恢复 |
| 配置变更导致问题 | 恢复配置文件 |

## 回滚步骤

### 1. 代码回滚

```bash
# 查看历史版本
git log --oneline -10

# 回退到指定版本
git checkout <commit-hash>

# 重新安装依赖
npm install
```

### 2. 数据库恢复

```bash
# 如果有备份
cp Data/db/backup/civitas_main.db.bak Data/db/civitas_main.db

# 如果无备份，重置数据库
rm Data/db/civitas_*.db*
# 重启后自动重建（数据会丢失）
```

### 3. 配置恢复

```bash
# 恢复配置文件
git checkout <commit-hash> -- Configs/
```

## 预防措施

1. 每次部署前备份数据库
2. 使用 Git tag 标记稳定版本
3. 数据库迁移前创建快照
4. 保持配置的版本控制
