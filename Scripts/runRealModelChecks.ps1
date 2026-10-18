# 真实模型门控用例的运行脚本
#
# 背景：项目的真实模型用例（realAgent.spec.ts / realAgentKernelG7.spec.ts）通过
# `HUAWEI_MAAS_API_KEY` 门控；该变量可能只存在于 **Machine/User 级持久环境变量**，
# 而当前 shell 进程未继承（实测 pwsh 的 $env: 为空、注册表 Machine 级存在）。
# 本脚本从不静默通过：缺 key 时由用例自身登记 NOT-RUN。
#
# 用法： pwsh -File Scripts/runRealModelChecks.ps1

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

function Get-PersistentEnv([string]$name) {
  foreach ($scope in @('Machine', 'User')) {
    $v = [Environment]::GetEnvironmentVariable($name, $scope)
    if ($v) { return $v }
  }
  return $null
}

$key = Get-PersistentEnv 'HUAWEI_MAAS_API_KEY'
if ($key) {
  $env:HUAWEI_MAAS_API_KEY = $key
  Write-Host "[real-model] HUAWEI_MAAS_API_KEY 已注入（长度 $($key.Length)）"
} else {
  Write-Host '[real-model] 未找到 HUAWEI_MAAS_API_KEY（Machine/User 均无）⇒ 用例将登记 NOT-RUN'
}

Push-Location $root
try {
  npx vitest run Tests/AgentRuntime/realAgent.spec.ts Tests/AgentRuntime/realAgentKernelG7.spec.ts --reporter=verbose
  exit $LASTEXITCODE
} finally {
  Pop-Location
}

