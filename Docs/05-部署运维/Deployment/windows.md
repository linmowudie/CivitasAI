# Windows 部署指南

> Windows 环境下的特殊注意事项

---

## 前置要求

- **Windows 10/11**
- **Node.js** ≥ 20.0.0（推荐通过 [nvm-windows](https://github.com/coreybutler/nvm-windows) 安装）
- **Git for Windows**
- **Visual Studio Build Tools**（better-sqlite3 编译需要）

## 安装步骤

```powershell
# 1. 安装 Node.js（通过 nvm-windows）
nvm install 20
nvm use 20

# 2. 安装 Visual Studio Build Tools
# 下载地址：https://visualstudio.microsoft.com/visual-cpp-build-tools/
# 安装时勾选 "Desktop development with C++"

# 3. 克隆仓库
git clone https://github.com/linmowudie/CivitasAI.git
cd CivitasAI

# 4. 安装依赖
npm install

# 5. 配置环境变量
Copy-Item .env.example .env
# 编辑 .env，填入 API Key

# 6. 启动
npm run dev
```

## Electron 桌面模式

```powershell
# 开发模式
npm run dev:electron

# 打包为便携版
npm run electron:build
# 输出：release/CivitasAI-Portable.exe
```

## 常见问题

### better-sqlite3 编译失败

```powershell
# 确保安装了 Visual Studio Build Tools
npm install --build-from-source
```

### 路径长度超限

```powershell
# 启用长路径支持（管理员权限）
reg add "HKLM\SYSTEM\CurrentControlSet\Control\FileSystem" /v LongPathsEnabled /t REG_DWORD /d 1 /f
```

### PowerShell 执行策略

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```
