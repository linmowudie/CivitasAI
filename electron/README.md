# electron — 桌面壳

Electron 主进程与预加载脚本，将后端以内嵌方式拉起并展示 Web 前端。

## 文件

| 文件 | 职责 |
|------|------|
| `main.ts` | 动态 import `Src/main.ts` 的 `startServer()` 启动内嵌后端 → 创建 BrowserWindow（1400×900，contextIsolation）→ 开发模式加载 Vite（:5173），生产加载 `dist/renderer/index.html`；`--portable` 或打包态下把 `Data/ Logs/ Configs/ Prompts/ Skills/` 重定向到程序目录（`CIVITAS_DATA_DIR` 等环境变量） |
| `preload.ts` | IPC 桥（渲染进程无 nodeIntegration，仅经 preload 暴露最小 API） |

## 命令（在仓库根目录执行）

```bash
npm run start:electron    # 后端+前端已起时直接开窗口
npm run dev:electron      # 一键：后端 watch + Vite + Electron（wait-on 就绪后启动）
npm run electron:build    # build:all 后 electron-builder 打 Windows 便携版
```

打包指南见根目录 [ELECTRON.md](../ELECTRON.md)；图标占位约定见 [assets/README.md](../assets/README.md)。
