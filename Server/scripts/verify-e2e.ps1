# Civitas 服务端端到端验证脚本（可复现）
#
# 前置：服务端运行中，且已建库/迁移。用法：
#   $env:SERVER_BASE = 'http://127.0.0.1:8787'
#   $env:PGURL     = 'postgres://user@host:5432/db'   # 用于在"模拟数据丢失"步骤清空数据
#   pwsh -File Scripts/verify-e2e.ps1
#
# 覆盖：注册 → 写设置/记忆/统计 → 导出备份 → 新设备登录 → 清空 → 一键恢复 → 令牌重用检测 → 校验与响应头
# 端到端验证 v2：真实 HTTP 走通"注册 → 写入 → 备份 → 重装登录 → 恢复"
# 说明：请求体统一用 ConvertTo-Json 生成，避免手写转义出错
$ErrorActionPreference = 'Stop'
$base = if ($env:SERVER_BASE) { $env:SERVER_BASE } else { 'http://127.0.0.1:8787' }
$v = if ($env:VERIFY_OUT) { $env:VERIFY_OUT } else { Join-Path $PSScriptRoot '..\.verify-out' }
New-Item -ItemType Directory -Force -Path $v | Out-Null
$email = 'verify@example.com'
$password = 'Passw0rd123'

# 清理上一次运行留下的账号（保证可重复执行）
& psql -h 127.0.0.1 -p 55432 -U postgres -d civitas_server_test -q -c `
  "DELETE FROM users WHERE email_lower = '$email';" | Out-Null

function Api {
  param(
    [string]$Method,
    [string]$Path,
    $Body = $null,
    [string]$Token = '',
    [string]$BodyFile = ''
  )
  $args = @('-s', '-X', $Method, "$base$Path", '-H', 'Content-Type: application/json')
  if ($Token) { $args += @('-H', "Authorization: Bearer $Token") }
  $tmp = $null
  if ($BodyFile) {
    $args += @('--data-binary', "@$BodyFile")
  } elseif ($null -ne $Body) {
    $tmp = Join-Path $v ('req-' + [guid]::NewGuid().ToString('N') + '.json')
    [System.IO.File]::WriteAllText($tmp, ($Body | ConvertTo-Json -Depth 20 -Compress))
    $args += @('--data-binary', "@$tmp")
  }
  $raw = & curl.exe @args
  if ($tmp) { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
  try { return ($raw | Out-String | ConvertFrom-Json) } catch { return $raw }
}

function Head($t) { Write-Host "`n── $t" -ForegroundColor Cyan }

Write-Host "`n============ ① 注册账号 ============" -ForegroundColor Yellow
$reg = Api -Method POST -Path '/v1/auth/register' -Body @{
  email = $email; password = $password; displayName = '验证用户'; deviceLabel = '设备 A'
}
Head '注册结果'
Write-Host "userId=$($reg.data.user.id)  email=$($reg.data.user.email)  displayName=$($reg.data.user.displayName)"
$access = $reg.data.tokens.accessToken
$refreshA = $reg.data.tokens.refreshToken
Write-Host "accessToken 前 36 位: $($access.Substring(0,36))…"
Write-Host "refreshToken 前 20 位: $($refreshA.Substring(0,20))…  (access 有效期 $($reg.data.tokens.expiresIn)s)"

Write-Host "`n============ ② 写入设置（两次修订）/ 记忆 / 统计 ============" -ForegroundColor Yellow
$null = Api -Method PUT -Path '/v1/settings' -Token $access -Body @{
  data = @{ theme = 'dark'; language = 'zh-CN'; providers = @{ default = 'GLM-5.1' } }
}
$s2 = Api -Method PATCH -Path '/v1/settings' -Token $access -Body @{ patch = @{ fontScale = 1.15 } }
Head '设置（PATCH 后）'
Write-Host "revision=$($s2.data.revision)  data=$($s2.data.data | ConvertTo-Json -Compress)"

foreach ($i in 1..3) {
  $null = Api -Method POST -Path '/v1/memories' -Token $access -Body @{
    clientMemoryId = "local-memory-$i"; title = "记忆 $i"; content = "这是第 $i 条记忆内容"; category = 'fact'
  }
}
$memList = Api -Method GET -Path '/v1/memories' -Token $access
Write-Host "记忆: $($memList.data.items.Count) 条 → $(($memList.data.items.title) -join ' / ')"

$stats = Api -Method POST -Path '/v1/stats/events' -Token $access -Body @{
  events = @(
    @{ kind = 'chat.turn'; value = 100; occurredAt = '2026-03-01T01:00:00.000Z'; clientEventId = 'v1' },
    @{ kind = 'chat.turn'; value = 200; occurredAt = '2026-03-01T02:00:00.000Z'; clientEventId = 'v2' },
    @{ kind = 'tool.call'; value = 1;   occurredAt = '2026-03-01T03:00:00.000Z'; clientEventId = 'v3' }
  )
}
Write-Host "统计上报: accepted=$($stats.data.accepted)/$($stats.data.submitted)"

Write-Host "`n============ ③ 导出备份包（含统计）============" -ForegroundColor Yellow
$backupPath = "$v\backup-verify.json"
# /v1/backup 返回 { ok, data } 外壳；/v1/backup/download 返回原始备份包（附件）。这里取外壳内的 data 作为备份包
& curl.exe -s "$base/v1/backup?includeStats=true" -H "Authorization: Bearer $access" -o $backupPath
$bundleEnvelope = Get-Content $backupPath -Raw | ConvertFrom-Json
$bundle = $bundleEnvelope.data
Write-Host "备份文件: $backupPath  ($((Get-Item $backupPath).Length) 字节)"
Write-Host "format=$($bundle.format)  version=$($bundle.version)  account=$($bundle.account.email)"
Write-Host "settings.revision=$($bundle.settings.revision)  记忆=$($bundle.memories.Count) 条  统计事件=$($bundle.stats.events.Count) 条"

Write-Host "`n============ ④ 模拟重装：新设备登录（服务端数据仍在）============" -ForegroundColor Yellow
$login = Api -Method POST -Path '/v1/auth/login' -Body @{
  email = $email; password = $password; deviceLabel = '重装后的新设备'
}
$newAccess = $login.data.tokens.accessToken
Write-Host "新设备登录成功  lastLoginAt=$($login.data.user.lastLoginAt)"
$settingsAfter = Api -Method GET -Path '/v1/settings' -Token $newAccess
$memAfter = Api -Method GET -Path '/v1/memories' -Token $newAccess
$sumAfter = Api -Method GET -Path '/v1/stats/summary?from=2026-03-01T00:00:00.000Z&to=2026-03-02T00:00:00.000Z' -Token $newAccess
Write-Host "设置: revision=$($settingsAfter.data.revision) data=$($settingsAfter.data.data | ConvertTo-Json -Compress)"
Write-Host "记忆: $($memAfter.data.items.Count) 条"
Write-Host "统计: 事件=$($sumAfter.data.totalEvents) 合计值=$($sumAfter.data.totalValue) 活跃天=$($sumAfter.data.activeDays)"

Write-Host "`n============ ⑤ 模拟服务端数据丢失（清空该账号数据）============" -ForegroundColor Yellow
& psql -h 127.0.0.1 -p 55432 -U postgres -d civitas_server_test -q -c `
  "DELETE FROM user_settings WHERE user_id=(SELECT id FROM users WHERE email_lower='$email');
   DELETE FROM memories      WHERE user_id=(SELECT id FROM users WHERE email_lower='$email');
   DELETE FROM usage_events  WHERE user_id=(SELECT id FROM users WHERE email_lower='$email');" | Out-Null
$empty = Api -Method GET -Path '/v1/backup' -Token $newAccess
Write-Host "清空后: settings=$($empty.data.settings)  记忆=$($empty.data.memories.Count) 条"

Write-Host "`n============ ⑥ 一键恢复（mode=replace）============" -ForegroundColor Yellow
$payloadPath = "$v\restore-payload.json"
[System.IO.File]::WriteAllText($payloadPath, (@{ bundle = $bundle; mode = 'replace' } | ConvertTo-Json -Depth 20 -Compress))
$restore = Api -Method POST -Path '/v1/restore' -Token $newAccess -BodyFile $payloadPath
Head '恢复报告'
Write-Host "mode=$($restore.data.mode)  settings.restored=$($restore.data.settings.restored)"
Write-Host "记忆: created=$($restore.data.memories.created) updated=$($restore.data.memories.updated) total=$($restore.data.memories.total)"
Write-Host "统计: accepted=$($restore.data.stats.accepted)"

$settingsBack = Api -Method GET -Path '/v1/settings' -Token $newAccess
$memBack = Api -Method GET -Path '/v1/memories' -Token $newAccess
$sumBack = Api -Method GET -Path '/v1/stats/summary?from=2026-03-01T00:00:00.000Z&to=2026-03-02T00:00:00.000Z' -Token $newAccess
Write-Host "恢复后 设置=$($settingsBack.data.data | ConvertTo-Json -Compress)"
Write-Host "恢复后 记忆=$($memBack.data.items.Count) 条  clientMemoryId=$(($memBack.data.items.clientMemoryId | Sort-Object) -join ',')"
Write-Host "恢复后 统计事件=$($sumBack.data.totalEvents) 合计值=$($sumBack.data.totalValue)"

$okSettings = ($settingsBack.data.data.theme -eq 'dark' -and $settingsBack.data.data.fontScale -eq 1.15)
$okMemories = ($memBack.data.items.Count -eq 3)
$okStats = ($sumBack.data.totalEvents -eq 3 -and $sumBack.data.totalValue -eq 301)
Write-Host ""
if ($okSettings -and $okMemories -and $okStats) {
  Write-Host "★★ 重建校验通过：设置 ✔  记忆 ✔  统计 ✔" -ForegroundColor Green
} else {
  Write-Host "★★ 重建校验失败：设置=$okSettings 记忆=$okMemories 统计=$okStats" -ForegroundColor Red
}

Write-Host "`n============ ⑦ 安全：令牌轮换 + 重用检测 ============" -ForegroundColor Yellow
$r1 = Api -Method POST -Path '/v1/auth/refresh' -Body @{ refreshToken = $refreshA }
Write-Host "刷新成功，新 refreshToken 前 20 位: $($r1.data.tokens.refreshToken.Substring(0,20))…"
$reuse = Api -Method POST -Path '/v1/auth/refresh' -Body @{ refreshToken = $refreshA }
Write-Host "旧令牌再用 → code=$($reuse.error.code)" -ForegroundColor Red
$afterRevoke = Api -Method POST -Path '/v1/auth/refresh' -Body @{ refreshToken = $r1.data.tokens.refreshToken }
Write-Host "整族已吊销 → code=$($afterRevoke.error.code)（新令牌同样失效）" -ForegroundColor Red

Write-Host "`n============ ⑧ 校验与隔离 ============" -ForegroundColor Yellow
$weak = Api -Method POST -Path '/v1/auth/register' -Body @{ email = 'weak@example.com'; password = 'short' }
Write-Host "弱密码注册 → code=$($weak.error.code) message=$($weak.error.message)"
$dup = Api -Method POST -Path '/v1/auth/register' -Body @{ email = $email; password = $password }
Write-Host "重复邮箱 → code=$($dup.error.code) message=$($dup.error.message)"
$unauth = & curl.exe -s -o NUL -w '%{http_code}' "$base/v1/memories"
Write-Host "未鉴权访问 /v1/memories → HTTP $unauth"

Write-Host "`n============ ⑨ 响应头与概览 ============" -ForegroundColor Yellow
$headers = & curl.exe -s -D - -o NUL "$base/healthz"
($headers | Select-String -Pattern 'x-content-type-options|x-frame-options|cache-control') | ForEach-Object { Write-Host $_.Line.Trim() }
$overview = Api -Method GET -Path '/v1/stats/overview' -Token $newAccess
Write-Host "概览: 终身事件=$($overview.data.lifetime.events) 记忆=$($overview.data.memories.total) 设置版本=$($overview.data.settings.revision) 活跃设备=$($overview.data.sessions.active)"

