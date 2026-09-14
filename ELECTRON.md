# Civitas-AI 打包指南

本文档说明如何将 Civitas-AI 打包为 Windows 便携版桌面应用。

## 前置要求

- Node.js 20+
- npm 10+

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 构建应用

```bash
# 构建后端 + 前端
npm run build:all
```

构建产物：
- `dist/main/` — 后端编译代码
- `dist/renderer/` — 前端构建产物

### 3. 打包 Electron 应用

```bash
# 打包为 Windows 便携版（单文件 exe）
npm run electron:build

# 或打包为目录形式（便于调试）
npm run electron:build:dir
```

产物位置：`release/CivitasAI-Portable.exe`（约 150-200MB）

## 开发模式

### 仅后端开发

```bash
npm run dev
```

### 前后端联调（Electron）

```bash
npm run dev:electron
```

这会同时启动：
- 后端服务（HTTP 3000 + WS 3001）
- Electron 窗口（加载 Vite dev server）

## 目录结构

```
CivitasAI-Portable/
├── CivitasAI.exe          # 主程序
├── resources/
│   └── app/
│       ├── dist/
│       │   ├── main/      # 后端代码
│       │   └── renderer/  # 前端代码
│       ├── Configs/       # 配置文件
│       ├── Prompts/       # 提示词
│       └── Skills/        # 技能
├── Data/                  # 运行时数据（自动创建）
└── Logs/                  # 日志（自动创建）
```

## 便携模式说明

打包后的应用默认以**便携模式**运行：
- 数据存储在程序目录下的 `Data/` 和 `Logs/`
- 可整体拷贝到 U 盘或其他位置使用
- 不写入注册表，不创建用户目录

如需切换到**安装模式**（数据存 `%APPDATA%/CivitasAI`），可移除 `electron/main.ts` 中的便携模式检测逻辑。

## 应用图标

打包前需在 `assets/` 目录放置图标文件：
- `icon.ico` — Windows 图标（256x256）
- `icon.png` — 通用图标（512x512）

详见 `assets/README.md`。

## 常见问题

### Q: 打包后启动白屏

A: 检查 `dist/renderer/index.html` 是否存在，以及 `electron/main.ts` 中的路径是否正确。

### Q: 数据库文件找不到

A: 便携模式下数据目录为程序目录下的 `Data/`。确保首次运行时自动创建。

### Q: 原生模块（better-sqlite3）报错

A: 需要针对 Electron 版本重编译：
```bash
npx @electron/rebuild
```

### Q: 产物体积过大

A: Electron 自带 Chromium 运行时，体积无法避免。可考虑：
- 使用 UPX 压缩（需额外工具）
- 或改用 Tauri（Rust + 系统 WebView，体积约 10-30MB）

## 构建脚本说明

| 命令 | 说明 |
|------|------|
| `npm run build:server` | 使用 esbuild 打包后端 |
| `npm run build:client` | 使用 Vite 构建前端 |
| `npm run build:all` | 同时构建前后端 |
| `npm run electron:dev` | Electron 开发模式 |
| `npm run electron:build` | 打包 Windows 便携版 |
| `npm run electron:build:dir` | 打包为目录形式 |

## 技术栈

- **后端**: Node.js 20 + TypeScript + better-sqlite3
- **前端**: React 19 + Vite + TypeScript
- **桌面**: Electron + electron-builder
- **打包**: esbuild（后端）+ Vite（前端）

## 后续扩展

- [ ] 自动更新（electron-updater）
- [ ] 代码签名（避免 SmartScreen 警告）
- [ ] macOS / Linux 跨平台支持
- [ ] 安装包版本（NSIS）
