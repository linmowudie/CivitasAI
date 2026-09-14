# Civitas-AI 一键安装脚本（Windows PowerShell）
# 用法: .\Scripts\install.ps1

$ErrorActionPreference = "Stop"

Write-Host "═══════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  Civitas-AI 安装向导" -ForegroundColor Cyan
Write-Host "═══════════════════════════════════════════" -ForegroundColor Cyan
Write-Host ""

# 1. 检查 Node.js
Write-Host "[1/6] 检查 Node.js..." -ForegroundColor Yellow
try {
    $nodeVersion = node --version
    Write-Host "  Node.js $nodeVersion ✓" -ForegroundColor Green
} catch {
    Write-Host "  错误: Node.js 未安装" -ForegroundColor Red
    Write-Host "  请安装 Node.js >= 20.0.0: https://nodejs.org/" -ForegroundColor Red
    exit 1
}

# 2. 检查 npm
Write-Host "[2/6] 检查 npm..." -ForegroundColor Yellow
$npmVersion = npm --version
Write-Host "  npm v$npmVersion ✓" -ForegroundColor Green

# 3. 安装依赖
Write-Host "[3/6] 安装 npm 依赖..." -ForegroundColor Yellow
npm install
if ($LASTEXITCODE -ne 0) {
    Write-Host "  错误: npm install 失败" -ForegroundColor Red
    exit 1
}
Write-Host "  依赖安装完成 ✓" -ForegroundColor Green

# 4. 创建环境变量文件
Write-Host "[4/6] 配置环境变量..." -ForegroundColor Yellow
if (-not (Test-Path ".env")) {
    Copy-Item ".env.example" ".env"
    Write-Host "  已创建 .env 文件，请编辑填入 API Key" -ForegroundColor Yellow
} else {
    Write-Host "  .env 文件已存在 ✓" -ForegroundColor Green
}

# 5. 创建必要目录
Write-Host "[5/6] 创建数据目录..." -ForegroundColor Yellow
$dirs = @("Data/Cache", "Data/Decisions", "Data/Loops", "Data/Operations", "Data/Sessions", "Data/Workspace", "Data/db", "Logs", "Data/Hooks")
foreach ($dir in $dirs) {
    if (-not (Test-Path $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
}
Write-Host "  数据目录就绪 ✓" -ForegroundColor Green

# 6. 类型检查
Write-Host "[6/6] 类型检查..." -ForegroundColor Yellow
npx tsc --noEmit
if ($LASTEXITCODE -ne 0) {
    Write-Host "  警告: 类型检查有问题（不阻塞安装）" -ForegroundColor Yellow
} else {
    Write-Host "  类型检查通过 ✓" -ForegroundColor Green
}

Write-Host ""
Write-Host "═══════════════════════════════════════════" -ForegroundColor Green
Write-Host "  安装完成！" -ForegroundColor Green
Write-Host "═══════════════════════════════════════════" -ForegroundColor Green
Write-Host ""
Write-Host "下一步：" -ForegroundColor Cyan
Write-Host "  1. 编辑 .env 文件，填入 HUAWEI_MAAS_API_KEY"
Write-Host "  2. 运行 npm run dev 启动开发模式"
Write-Host "  3. 访问 http://localhost:5173 查看界面"
Write-Host ""
