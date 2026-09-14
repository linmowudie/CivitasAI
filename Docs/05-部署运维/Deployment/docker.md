# Docker 部署指南

> 使用 Docker 容器化部署 Civitas-AI

---

## Dockerfile（参考）

```dockerfile
FROM node:20-slim

WORKDIR /app

# 安装系统依赖
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# 复制依赖文件
COPY package.json package-lock.json ./
RUN npm ci --production=false

# 复制源码
COPY . .

# 编译
RUN npm run build:server

# 暴露端口
EXPOSE 3000 3001

# 启动
CMD ["npm", "run", "start"]
```

## docker-compose.yml（参考）

```yaml
version: '3.8'
services:
  civitasai:
    build: .
    ports:
      - "3000:3000"
      - "3001:3001"
    volumes:
      - ./Data:/app/Data
      - ./Logs:/app/Logs
      - ./Configs:/app/Configs:ro
    env_file:
      - .env
    restart: unless-stopped
```

## 构建与运行

```bash
# 构建镜像
docker build -t civitasai:latest .

# 运行容器
docker run -d \
  --name civitasai \
  -p 3000:3000 \
  -p 3001:3001 \
  -v $(pwd)/Data:/app/Data \
  -v $(pwd)/Logs:/app/Logs \
  --env-file .env \
  civitasai:latest

# 查看日志
docker logs -f civitasai
```

## 注意事项

- `Data/` 和 `Logs/` 目录需挂载到宿主机，确保数据持久化
- `Configs/` 目录建议只读挂载
- SQLite 数据库不支持并发写入，单容器运行即可
