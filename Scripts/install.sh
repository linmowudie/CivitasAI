#!/usr/bin/env bash
# Civitas-AI 一键安装脚本（Linux/macOS）
# 用法: bash Scripts/install.sh

set -e

echo "═══════════════════════════════════════════"
echo "  Civitas-AI 安装向导"
echo "═══════════════════════════════════════════"
echo ""

# 1. 检查 Node.js
echo "[1/6] 检查 Node.js..."
if ! command -v node &> /dev/null; then
    echo "  错误: Node.js 未安装"
    echo "  请安装 Node.js >= 20.0.0: https://nodejs.org/"
    exit 1
fi
NODE_VERSION=$(node --version)
echo "  Node.js $NODE_VERSION ✓"

# 2. 检查 npm
echo "[2/6] 检查 npm..."
NPM_VERSION=$(npm --version)
echo "  npm v$NPM_VERSION ✓"

# 3. 安装依赖
echo "[3/6] 安装 npm 依赖..."
npm install
echo "  依赖安装完成 ✓"

# 4. 创建环境变量文件
echo "[4/6] 配置环境变量..."
if [ ! -f ".env" ]; then
    cp .env.example .env
    echo "  已创建 .env 文件，请编辑填入 API Key"
else
    echo "  .env 文件已存在 ✓"
fi

# 5. 创建必要目录
echo "[5/6] 创建数据目录..."
mkdir -p Data/{Cache,Decisions,Loops,Operations,Sessions,Workspace,db,Hooks} Logs
echo "  数据目录就绪 ✓"

# 6. 类型检查
echo "[6/6] 类型检查..."
if npx tsc --noEmit 2>/dev/null; then
    echo "  类型检查通过 ✓"
else
    echo "  警告: 类型检查有问题（不阻塞安装）"
fi

echo ""
echo "═══════════════════════════════════════════"
echo "  安装完成！"
echo "═══════════════════════════════════════════"
echo ""
echo "下一步："
echo "  1. 编辑 .env 文件，填入 HUAWEI_MAAS_API_KEY"
echo "  2. 运行 npm run dev 启动开发模式"
echo "  3. 访问 http://localhost:5173 查看界面"
echo ""
