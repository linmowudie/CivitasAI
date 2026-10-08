# Civitas-AI 打包指南

本文档说明如何将 Civitas-AI 打包为 Windows 桌面应用。分发形态**以 NSIS 安装包为主**（用户自选安装目录、向导式一键安装），**便携版单文件作为备选**（免安装、可放 U 盘）。

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

### 3. 一键打包

```bash
# 一键打包（= 预检 → 构建前后端 → 产物校验 → electron-builder → 体积/SHA256 核验）
# 默认打 NSIS 安装包
npm run package

# 等价写法 / 其它形态
npm run package:nsis       # NSIS 安装包（主）
npm run package:portable   # 便携版单文件（次）
npm run package:dir        # 只展开免安装目录（调试用）
npm run package:check      # 只做打包前预检，不构建、不打包
```

也可以直接调用编排脚本，附加参数：

```bash
node Scripts/package.cjs [--nsis|--portable|--dir|--all] [--skip-build] [--no-verify] [--check]
```

产物位置（`release/` 已在 `.gitignore` 中排除）：

| 形态 | 产物路径 | 说明 |
|------|----------|------|
| NSIS 安装包（主） | `release/CivitasAI-Setup-<version>.exe` | 发给用户双击安装，向导中可自选安装目录 |
| 便携版（次） | `release/CivitasAI-Portable.exe` | 单文件免安装，双击即用 |
| 免安装目录 | `release/win-unpacked/` | 仅用于本地调试，不对外分发 |

命令跑完会打印每个产物的**绝对路径、字节数、SHA256**——发版时把 SHA256 一起贴给用户即可校验下载完整性。

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

安装版（NSIS，默认装到 `%LOCALAPPDATA%\Programs\CivitasAI`，用户可在向导中改到 D 盘等任意目录）：

```
<安装目录>/
├── CivitasAI.exe          # 主程序（卸载器 Uninstall CivitasAI.exe 同目录）
├── resources/
│   └── app/
│       ├── dist/
│       │   ├── main/      # 后端代码
│       │   └── renderer/  # 前端代码
│       ├── Configs/       # 配置文件（随包分发）
│       ├── Prompts/       # 提示词
│       └── Skills/        # 技能
└── locales/ ...           # Electron 运行时文件
```

便携版则是单个 `CivitasAI-Portable.exe`：运行时会自解压到临时目录后启动，行为与安装版一致，只是不留安装痕迹。

## 安装版与便携版说明

产品决策：**Windows NSIS 安装包为主，便携版保留**。

### 安装版（`CivitasAI-Setup-<version>.exe`）

- 向导式安装：可选安装目录（`allowToChangeInstallationDirectory: true`）、创建桌面快捷方式（`Civitas AI`）与开始菜单项（分类 `CivitasAI`），安装完成可直接勾选运行。
- **无需管理员权限**：`perMachine: false`，默认按用户级安装到 `%LOCALAPPDATA%\Programs\CivitasAI`；只有用户把目录改到需要更高权限的位置（如 `C:\Program Files`）时，`allowElevation: true` 才会触发一次 UAC 提权。
- 数据落点：**全局数据在 `%APPDATA%\CivitasAI`；工作空间数据在安装目录**（由路径层实现）。
- 卸载默认**不删除** `%APPDATA%\CivitasAI`（`deleteAppDataOnUninstall: false`），避免误删用户配置与数据；需要彻底清理时手动删除该目录。

### 便携版（`CivitasAI-Portable.exe`）

- 单文件、免安装，可整体拷贝到 U 盘或其他位置使用；同样不写注册表。
- 适合试用或临时环境；正式分发请用 NSIS 安装包。

## 应用图标

打包前需在 `assets/` 目录准备图标文件：

- `icon.ico` — Windows 图标，内含 16/24/32/48/64/128/256 多尺寸（安装包、快捷方式、卸载器都用它）
- `icon.png` — 通用图标，512x512

图标可重复生成（深色底 `#11111b` + 紫色 `#8b5cf6` 街区网格 + 中心亮点，无文字、无字体依赖）：

```bash
python Scripts/genIcons.py                 # 生成 assets/icon.ico + assets/icon.png + .tmp/icon-preview.png 预览图
python Scripts/genIcons.py --preview-only  # 只重出预览图，人工确认观感
```

> 图标缺失时 `npm run package` 会在预检阶段直接失败并提示运行上面的命令，不会打出一个没有图标的包。

详见 `assets/README.md`。

## 代码签名（本地自签，自用）

> 目标：**不花钱、不把发布权交给第三方**，让本机（或已部署该根证书的内部设备）双击安装不再出现"未知发布者"。
> 当前发布者：**`Ma Hongyu (Self-Signed)`**（指纹 `7A8BEB8ED9F01B33402B53EE2E5871B7206A1338`，有效至 2031-10-06）。

三步，全部在仓库内完成；证书与私钥都不入库（`.gitignore` 已排除 `*.pfx` / `*.p12` / `signing.env.json` / `*selfsigned.cer`）：

```powershell
# ① 生成本机自签代码签名证书（CurrentUser 存储；导出到 .tmp\signing\，含随机 PFX 密码）
npm run sign:setup
#    想让本机直接认可该签名（无需管理员，仅当前用户；随时可撤销）：
npm run sign:setup -- -InstallTrustedRoot -TrustScope CurrentUser

#    自定义/更换发布者（主体含空格时**不要**走 npm：npm 在 Windows 经 cmd.exe 转发，
#    单引号不是引号，参数会被空格切开 —— 直接用 pwsh 调脚本）：
pwsh -NoProfile -ExecutionPolicy Bypass -File Scripts/setupSelfSignedCert.ps1 `
    -Subject 'CN=Ma Hongyu (Self-Signed)' -Force -InstallTrustedRoot -TrustScope CurrentUser

# ② 签名打包（应用本体 / elevate / 卸载器 / 安装包 / 便携版 **全链签名**）
npm run package:signed                  # 默认 NSIS
npm run package:signed -- --all         # NSIS + 便携版
npm run package:signed -- --skip-build  # 只重签、不重构建

# ③ 校验签名（发布前门禁）
npm run sign:verify                                        # 明细
npm run sign:verify -- -Require                            # 有未签名产物即失败
npm run sign:verify -- -Require -RequireTrusted            # 连"链不可信"也判失败
```

> 脚本默认主体即 `CN=Ma Hongyu (Self-Signed)`，所以不带 `-Subject` 的 `npm run sign:setup` 会**复用**同一张证书
> （按主体匹配），不会产生第二张证书、也不会让发布者漂移；改主体时务必用 `-Force` 并重装根证书。

> **手工装根证书时用 certutil，不要用 `Import-Certificate`**：往"受信任根"写入会弹模态"安全警告"确认框，
> 在非交互会话/脚本/CI 里会**挂起等人工点确认**（或报"此操作中不允许使用 UI"）。
> 静默路径：`certutil -f -user -addstore Root .tmp\signing\CivitasAI-selfsigned.cer`
> （脚本里的 `-InstallTrustedRoot` 已改用这条路径。）

**原理**：`Scripts/packageSigned.cjs` 读取 `.tmp\signing\signing.env.json`，把 PFX 路径与密码写进
`CSC_LINK` / `CSC_KEY_PASSWORD`（Windows 上同时写 `WIN_CSC_*`），然后调用既有一键打包 `package.cjs`。
签名配置**不写进 `package.json`** —— 仓库里没有任何证书信息，不签名也能正常 `npm run package`，
换证书只需重跑 `sign:setup`。因为证书在本地，electron-builder 能在一次构建里把
「应用 exe → elevate → 卸载器 → 安装包」整条链签完（这是本地证书相对远程签名服务如 SignPath 的最大优势）。

**本机实测结果**（`Scripts/verifySign.ps1` 输出，装根证书前后对比）：

| 产物 | 未装根证书 | 装根证书后 | 签名者 | 时间戳 |
|------|-----------|-----------|--------|--------|
| `CivitasAI-Setup-0.1.0.exe` | `UnknownError`（已签名但链不可信） | **`Valid`** | Ma Hongyu (Self-Signed) | 有 |
| `CivitasAI-Portable.exe` | 同上 | **`Valid`** | 同上 | 有 |
| `win-unpacked\CivitasAI.exe` | 同上 | **`Valid`** | 同上 | 有 |
| `win-unpacked\resources\elevate.exe` | 同上 | **`Valid`** | 同上 | 有 |

即：`npm run package:signed` 一次构建就把**应用本体 → elevate → 卸载器 → 安装包/便携版**整条链签完
（本地证书相对远程签名服务如 SignPath 的最大优势）；装根证书后本机双击安装不再提示"未知发布者"。

**边界与撤销**：

- 自签**只对已装该根证书的机器有效**；别人下载后仍是"未知发布者"（对外分发场景下自签与不签差别不大）。
- 撤销本机信任（当前发布者；旧的 `Civitas AI (Self-Signed)` 根证书已在换名时删除）：
  `certutil -user -delstore Root 7A8BEB8ED9F01B33402B53EE2E5871B7206A1338`
  或 `Get-ChildItem Cert:\CurrentUser\Root | Where-Object { $_.Subject -eq 'CN=Ma Hongyu (Self-Signed)' } | Remove-Item`
- 删除签名证书（`CurrentUser\My`）：`Get-ChildItem Cert:\CurrentUser\My | Where-Object Thumbprint -eq <指纹> | Remove-Item`
- **更换发布者**的顺序（重要）：先用 `-Force` 生成新证书 → `certutil -user -delstore Root <旧指纹>` 清掉旧的信任项 →
  `-InstallTrustedRoot` 装新的 → `npm run package:signed -- --all` 重签（旧签名的产物必须重签，否则发布者不一致）。
- 将来换正式证书：**不要**改 `package.json`，继续用环境变量（CI 里用 Secret 注入 `CSC_LINK` 的 base64 或路径 + `CSC_KEY_PASSWORD`）；`verifySign.ps1` 无需改动。

## 常见问题

### Q: 双击安装包时 SmartScreen 提示"未知发布者"，怎么处理？

A: 未签名、或自签但本机没装根证书时，Windows 都会这样提示。三条路：

| 目标 | 做法 | 代价 |
|------|------|------|
| **自用 / 内部** | 本地自签 + 把根证书装进本机受信任根（见上一节） | 免费；对外分发无效 |
| 对外分发、开源 | SignPath Foundation（免费 OV 级；但证书主体是 SignPath Foundation，每次发布需人工批准） | 发布权登记在对方名下 |
| 对外分发、自有品牌 | OV 证书（云 HSM，$150–300/年）；**EV 自 2024 起不再有额外 SmartScreen 优势** | 花钱 |

只想装一次可以点"更多信息 → 仍要运行"，但每次都会提示，且企业安全软件可能直接拦。

### Q: 打包后启动白屏

A: 检查 `dist/renderer/index.html` 是否存在，以及 `electron/main.ts` 中的路径是否正确。

### Q: 数据库文件找不到

A: 全局数据在 `%APPDATA%\CivitasAI`，工作空间数据在安装目录（详见上文"安装版与便携版说明"）。首次运行会自动创建目录。

### Q: 原生模块（better-sqlite3）报错

A: 需要针对 Electron 版本重编译：
```bash
npx @electron/rebuild
```

### Q: 双击安装包后 Windows 弹出"已保护你的电脑"（SmartScreen）

A: **当前安装包未做代码签名**，Windows 会对未签名来源的 exe 给出 SmartScreen 提示。用户可点"更多信息 → 仍要运行"继续安装；要根治需购买代码签名证书并在 electron-builder 中配置 `win.certificateFile` / `certificatePassword`（或用 `win.signtoolOptions` 接入云签名）。签名后再配合 SHA256 校验，分发体验最完整。

### Q: `npm run package` 报 `connect ETIMEDOUT`（下载 Electron / NSIS 资源失败）

A: 首次打包需要下载 Electron 运行时 zip 与 NSIS 资源，部分网络下 GitHub Releases 不可达（本机实测即为此情况）。`Scripts/package.cjs` 已**默认注入 npmmirror 镜像**（仅当外部未设置同名环境变量时生效），可关闭或自行覆盖：

```bash
node Scripts/package.cjs --nsis --no-mirror        # 关闭镜像，走官方源

# 或自行指定镜像（PowerShell）
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
```

> 注意：旧的 `npm run electron:build` 不经过该脚本，因此不会自动注入镜像。

### Q: `/S` 静默安装（企业批量部署）行为如何？

A: 本安装包是"辅助式"安装器（`oneClick: false`）。实测 `/S` 静默安装会**正确释放程序文件**（约 410MB：`CivitasAI.exe`、`resources/app.asar`、`resources/app/{Configs,Prompts,Skills}`、`Uninstall CivitasAI.exe`），但**不会创建快捷方式、也不写卸载注册表项**，因此静默装完后"设置 → 应用"里看不到该应用，此状态下静默卸载也不会删除文件。批量部署前请自行验证，或补充 NSIS 自定义脚本；`/S` 之外请用交互式向导安装。

### Q: 产物体积过大

A: Electron 自带 Chromium 运行时，体积无法避免（安装包约 100-200MB）。已做的瘦身：`files` 里排除了 `*.map` 与 `node_modules/*/{test,tests,example,examples,docs,doc}`；`nsis.differentialPackage: false` 关闭差分包以保证单文件安装包可用。可进一步考虑：
- 使用 UPX 压缩（需额外工具）
- 或改用 Tauri（Rust + 系统 WebView，体积约 10-30MB）

## 构建脚本说明

| 命令 | 说明 |
|------|------|
| `npm run build:server` | 使用 esbuild 打包后端 |
| `npm run build:client` | 使用 Vite 构建前端 |
| `npm run build:all` | 同时构建前后端 |
| `npm run package` | **一键打包**（默认 NSIS 安装包） |
| `npm run package:nsis` | 一键打包 NSIS 安装包 |
| `npm run package:portable` | 一键打包便携版单文件 |
| `npm run package:dir` | 只展开免安装目录（调试） |
| `npm run package:check` | 只做打包前预检，不打包 |
| `node Scripts/verifyPackage.cjs` | 单独校验打包所需产物是否齐备 |
| `npm run electron:dev` | Electron 开发模式 |
| `npm run electron:build` | 旧写法：`build:all` + 便携版（保留兼容） |
| `npm run electron:build:dir` | 旧写法：打包为目录形式（保留兼容） |

## 技术栈

- **后端**: Node.js 20 + TypeScript + better-sqlite3
- **前端**: React 19 + Vite + TypeScript
- **桌面**: Electron + electron-builder
- **打包**: esbuild（后端）+ Vite（前端）+ NSIS（Windows 安装包）

## 后续扩展

- [ ] 自动更新（electron-updater）
- [ ] 代码签名（避免 SmartScreen 警告，见上方 FAQ）
- [ ] macOS / Linux 跨平台支持
- [x] 安装包版本（NSIS，`npm run package`）
