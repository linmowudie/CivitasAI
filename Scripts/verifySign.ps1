#requires -Version 5.1
<#
.SYNOPSIS
    校验打包产物的 Windows Authenticode 签名状态（自签/正式证书通用）。

.DESCRIPTION
    逐个检查：
      - release\CivitasAI-Setup-<version>.exe   安装程序（用户双击的那个）
      - release\CivitasAI-Portable.exe          便携版
      - release\win-unpacked\CivitasAI.exe      应用本体
      - release\win-unpacked\Uninstall CivitasAI.exe  卸载器
      - release\win-unpacked\resources\elevate.exe    提权助手（存在则查）

    对每个文件打印：签名状态 / 签名者 / 证书有效期 / 是否带时间戳 / 链校验结果。
    自签证书在**未把 .cer 装进受信任根**的机器上会显示 UntrustedRoot —— 这是预期的，
    脚本会明确区分"没签名"与"签了但根不受信任"。

.PARAMETER Require
    只要存在"未签名"或"签名无效"的产物就以退出码 1 结束（CI/发布前门禁用）。
    注意：自签 + 未安装根证书时，UntrustedRoot 视为"已签名但不可信"，默认**不算失败**，
    除非同时传 -RequireTrusted。

.PARAMETER RequireTrusted
    连"链不可信（UntrustedRoot 等）"也判为失败。适合在已部署根证书的机器上做发布门禁。

.PARAMETER ReleaseDir
    产物目录，默认 <仓库>\release。

.EXAMPLE
    npm run sign:verify
    npm run sign:verify -- -Require
#>
[CmdletBinding()]
param(
    [switch]$Require,
    [switch]$RequireTrusted,
    [string]$ReleaseDir = '',
    # 只校验本次打包实际产出的目标：nsis / portable / all / dir / auto(默认=找到什么查什么)
    [ValidateSet('auto', 'nsis', 'portable', 'all', 'dir')]
    [string]$Targets = 'auto'
)

$ErrorActionPreference = 'Continue'
$repoRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($ReleaseDir)) { $ReleaseDir = Join-Path $repoRoot 'release' }

Write-Host '=== Civitas AI · 签名校验 ===' -ForegroundColor Cyan
if (-not (Test-Path $ReleaseDir)) {
    Write-Host "  ❌ 产物目录不存在：$ReleaseDir（先跑 npm run package）" -ForegroundColor Red
    exit 1
}

# ── 收集待检文件（按本次目标过滤，避免把上一次遗留的旧产物算进来）────
# 注意：PowerShell 变量名大小写不敏感 —— 局部集合**不能**再叫 $Targets，否则会覆盖参数。
$wantNsis = $Targets -in @('auto', 'nsis', 'all')
$wantPortable = $Targets -in @('auto', 'portable', 'all')
$wantUnpacked = $Targets -in @('auto', 'nsis', 'portable', 'all', 'dir')
Write-Host ("  校验目标：{0}" -f $Targets)

$checkFiles = @()
if ($wantNsis) {
    $checkFiles += Get-ChildItem -Path $ReleaseDir -Filter 'CivitasAI-Setup-*.exe' -File -ErrorAction SilentlyContinue
}
if ($wantPortable) {
    $checkFiles += Get-ChildItem -Path $ReleaseDir -Filter 'CivitasAI-Portable.exe' -File -ErrorAction SilentlyContinue
}
$unpacked = Join-Path $ReleaseDir 'win-unpacked'
if ($wantUnpacked -and (Test-Path $unpacked)) {
    $checkFiles += Get-ChildItem -Path $unpacked -Filter '*.exe' -File -ErrorAction SilentlyContinue
    $elevate = Join-Path $unpacked 'resources\elevate.exe'
    if (Test-Path $elevate) { $checkFiles += Get-Item $elevate }
}
$checkFiles = $checkFiles | Where-Object { $_ -and $_.Name -notlike '*.map' } | Sort-Object -Property FullName -Unique

if ($checkFiles.Count -eq 0) {
    Write-Host "  ❌ 没有找到任何待检 exe（$ReleaseDir）" -ForegroundColor Red
    exit 1
}

# ── 逐个校验 ────────────────────────────────────────────────────────
$failed = 0
$rows = @()

foreach ($file in $checkFiles) {
    $sig = Get-AuthenticodeSignature -FilePath $file.FullName
    $status = $sig.Status.ToString()

    $signer = '—'
    $notAfter = '—'
    if ($sig.SignerCertificate) {
        $signer = ($sig.SignerCertificate.Subject -replace '^CN=', '') -replace ',.*$', ''
        $notAfter = $sig.SignerCertificate.NotAfter.ToString('yyyy-MM-dd')
    }

    # 时间戳：签名块里的计数器签名
    $timestamped = '—'
    if ($sig.SignerCertificate) {
        $timestamped = if ($sig.TimeStamperCertificate) { '有' } else { '无' }
    }

    $badSignature = ($status -eq 'NotSigned')
    $badTrust = ($status -ne 'Valid' -and $status -ne 'NotSigned' -and $status -ne 'UnknownError')
    # UnknownError 常见于"根不受信任"；单独用 RequireTrusted 才判失败
    if ($Require -and $badSignature) { $failed++ }
    if ($RequireTrusted -and ($badSignature -or $status -ne 'Valid')) { $failed++ }

    $icon = switch ($status) {
        'Valid' { '✅' }
        'NotSigned' { '❌' }
        default { '⚠️ ' }
    }
    Write-Host ''
    Write-Host ("  {0} {1}" -f $icon, $file.Name) -ForegroundColor $(if ($status -eq 'Valid') { 'Green' } elseif ($status -eq 'NotSigned') { 'Red' } else { 'Yellow' })
    Write-Host ("      状态      : {0}" -f $status)
    Write-Host ("      签名者    : {0}" -f $signer)
    Write-Host ("      证书到期  : {0}" -f $notAfter)
    Write-Host ("      时间戳    : {0}" -f $timestamped)
    if ($sig.StatusMessage) {
        $msg = ($sig.StatusMessage -split "`n")[0].Trim()
        Write-Host ("      说明      : {0}" -f $msg) -ForegroundColor DarkGray
    }
    $rows += [pscustomobject]@{ File = $file.Name; Status = $status; Signer = $signer }
}

Write-Host ''
Write-Host '=== 汇总 ===' -ForegroundColor Cyan
$rows | Format-Table -AutoSize | Out-String | Write-Host

$signedCount = ($rows | Where-Object { $_.Status -ne 'NotSigned' }).Count
$validCount = ($rows | Where-Object { $_.Status -eq 'Valid' }).Count
Write-Host ("  已签：{0}/{1}    链可信：{2}/{1}" -f $signedCount, $rows.Count, $validCount)
if ($validCount -lt $rows.Count -and $signedCount -gt 0) {
    Write-Host '  提示：链不可信通常是"自签根证书未安装"。让本机信任（无需管理员，仅当前用户）：' -ForegroundColor Yellow
    $cer = Join-Path $repoRoot '.tmp\signing\CivitasAI-selfsigned.cer'
    Write-Host "    Import-Certificate -FilePath '$cer' -CertStoreLocation Cert:\CurrentUser\Root" -ForegroundColor White
}

if ($failed -gt 0) {
    Write-Host ''
    Write-Host ("  ❌ 校验未通过：{0} 个产物不满足要求（Require={1} RequireTrusted={2}）" -f $failed, [bool]$Require, [bool]$RequireTrusted) -ForegroundColor Red
    exit 1
}

Write-Host ''
Write-Host '  ✅ 校验通过' -ForegroundColor Green
exit 0
