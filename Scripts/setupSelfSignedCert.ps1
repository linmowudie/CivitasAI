#requires -Version 5.1
<#
.SYNOPSIS
    生成本机自用的代码签名证书（自签），导出 PFX/CER，并写出签名环境配置。

.DESCRIPTION
    面向"自用/内部"场景：不购买 CA 证书，也不把发布权交给第三方（如 SignPath Foundation）。
    生成的证书主体由你指定（默认 CN=Civitas AI (Self-Signed)），发布者显示的就是这个名称。

    产物（默认落在 <仓库>\.tmp\signing\，该目录已被 .gitignore 忽略）：
      - CivitasAI-selfsigned.pfx        含私钥，供 electron-builder 签名（请勿外传/入库）
      - CivitasAI-selfsigned.cer        仅公钥，用于把根证书装进"受信任的根"
      - signing.env.json                供 Scripts/packageSigned.cjs 读取的签名配置

    重要边界（`-InstallTrustedRoot` 才会动信任设置）：
      - 自签证书**默认不被任何机器信任**：不装根证书时，用户会看到"未知发布者"，
        SmartScreen 与安装体验仍是未签名水平；
      - 把 .cer 装进"受信任的根"后，**该机器**才认可此签名（CurrentUser 范围无需管理员，
        只影响当前用户；LocalMachine 范围需要管理员，且会影响本机所有用户）；
      - 对外分发：别人没装你的根证书，仍然是"未知发布者"——自签只适合自用/内部受管设备。

.PARAMETER Subject
    证书主体（X.500）。例如 'CN=Civitas AI (Self-Signed)' 或 'CN=Your Name'。

.PARAMETER OutDir
    导出目录，默认 <仓库>\.tmp\signing。

.PARAMETER Years
    有效期年数，默认 5。

.PARAMETER PfxPassword
    PFX 密码；不传则随机生成（写入 signing.env.json）。

.PARAMETER InstallTrustedRoot
    同时把导出的 .cer 导入受信任根（默认不做）。

.PARAMETER TrustScope
    CurrentUser（默认，无需管理员）或 LocalMachine（需管理员）。

.PARAMETER Force
    已存在同名证书时重新生成（否则复用现有证书）。

.EXAMPLE
    npm run sign:setup
    # 主体含空格时**不要**走 npm（npm 在 Windows 上经 cmd.exe 转发，单引号不是引号会被切开），
    # 直接用 pwsh 调用本脚本：
    pwsh -NoProfile -ExecutionPolicy Bypass -File Scripts/setupSelfSignedCert.ps1 `
        -Subject 'CN=Ma Hongyu (Self-Signed)' -Force -InstallTrustedRoot -TrustScope CurrentUser
#>
[CmdletBinding()]
param(
    # 发布者显示名（默认与当前仓库已签发的证书一致；改这里会更换发布者，需重新打包并重装根证书）
    [string]$Subject = 'CN=Ma Hongyu (Self-Signed)',
    [string]$OutDir = '',
    [int]$Years = 5,
    [string]$PfxPassword = '',
    [switch]$InstallTrustedRoot,
    [ValidateSet('CurrentUser', 'LocalMachine')]
    [string]$TrustScope = 'CurrentUser',
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($OutDir)) {
    $OutDir = Join-Path $repoRoot '.tmp\signing'
}
$OutDir = [System.IO.Path]::GetFullPath($OutDir)
if (-not (Test-Path $OutDir)) {
    New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
}

$pfxPath = Join-Path $OutDir 'CivitasAI-selfsigned.pfx'
$cerPath = Join-Path $OutDir 'CivitasAI-selfsigned.cer'
$envPath = Join-Path $OutDir 'signing.env.json'

Write-Host '=== Civitas AI · 自签代码签名证书 ===' -ForegroundColor Cyan
Write-Host "  主体      : $Subject"
Write-Host "  导出目录  : $OutDir"
Write-Host "  有效期    : $Years 年"
Write-Host ''

# ── 1. 查找/生成证书 ────────────────────────────────────────────────
$existing = Get-ChildItem Cert:\CurrentUser\My |
    Where-Object { $_.Subject -eq $Subject -and $_.HasPrivateKey } |
    Sort-Object NotAfter -Descending |
    Select-Object -First 1

if ($existing -and -not $Force) {
    Write-Host "[1/4] 复用已有证书：$($existing.Thumbprint)" -ForegroundColor Green
    $cert = $existing
} else {
    if ($existing -and $Force) {
        Write-Host "[1/4] -Force 指定：移除旧证书 $($existing.Thumbprint)" -ForegroundColor Yellow
        Remove-Item -Path "Cert:\CurrentUser\My\$($existing.Thumbprint)" -Force
    }
    Write-Host '[1/4] 生成新的自签代码签名证书...' -ForegroundColor Green
    $cert = New-SelfSignedCertificate `
        -Type CodeSigningCert `
        -Subject $Subject `
        -KeyUsage DigitalSignature `
        -KeyAlgorithm RSA `
        -KeyLength 3072 `
        -KeyExportPolicy Exportable `
        -CertStoreLocation Cert:\CurrentUser\My `
        -NotAfter (Get-Date).AddYears($Years)
    Write-Host "      指纹：$($cert.Thumbprint)"
}

if (-not $PfxPassword) {
    # 本地自用：随机密码写入 .tmp\signing\signing.env.json（不入库）
    $bytes = New-Object byte[] 24
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $PfxPassword = [Convert]::ToBase64String($bytes)
    Write-Host '[2/4] 未提供 -PfxPassword，已随机生成并写入 signing.env.json' -ForegroundColor Yellow
} else {
    Write-Host '[2/4] 使用提供的 PFX 密码'
}

# ── 2. 导出 PFX / CER ──────────────────────────────────────────────
$secure = ConvertTo-SecureString -String $PfxPassword -AsPlainText -Force
Export-PfxCertificate -Cert $cert -FilePath $pfxPath -Password $secure | Out-Null
Export-Certificate -Cert $cert -FilePath $cerPath | Out-Null
Write-Host "[3/4] 已导出：$pfxPath" -ForegroundColor Green
Write-Host "             $cerPath"

# ── 3. 可选：装进受信任根 ───────────────────────────────────────────
$trustedNow = $false
if ($InstallTrustedRoot) {
    $storeName = if ($TrustScope -eq 'LocalMachine') { 'LocalMachine' } else { 'CurrentUser' }
    try {
        # 优先 certutil：往"受信任根"写入时 Windows 会弹模态"安全警告"确认框，
        # Import-Certificate / X509Store.Add 在非交互会话里会**挂起等人工确认**，或直接报
        # "此操作中不允许使用 UI"。`certutil -f -user -addstore Root` 是静默路径，脚本/CI 都能跑。
        $certutilArgs = @('-f')
        if ($storeName -eq 'CurrentUser') { $certutilArgs += '-user' }
        $certutilArgs += @('-addstore', 'Root', $cerPath)
        $output = & certutil @certutilArgs 2>&1 | Out-String
        if ($LASTEXITCODE -ne 0 -and $output -notmatch '成功') {
            throw "certutil 退出码 $LASTEXITCODE"
        }
        $trustedNow = $true
        Write-Host "[4/4] 已把根证书导入 $storeName\Root（本机该范围内签名将被视为可信）" -ForegroundColor Green
    } catch {
        Write-Host "[4/4] 导入失败：$($_.Exception.Message)" -ForegroundColor Red
        Write-Host '      可手动执行（CurrentUser 无需管理员，会弹一次确认框）：' -ForegroundColor Yellow
        Write-Host "      certutil -f -user -addstore Root `"$cerPath`""
    }
} else {
    Write-Host '[4/4] 未修改信任设置（如需本机无提示，见下方命令）' -ForegroundColor Yellow
}

# ── 4. 写签名配置（供 packageSigned.cjs 使用）────────────────────────
$envPayload = [ordered]@{
    subject    = $Subject
    thumbprint = $cert.Thumbprint
    pfxPath    = $pfxPath
    pfxPassword = $PfxPassword
    cerPath    = $cerPath
    notAfter   = $cert.NotAfter.ToString('o')
    createdAt  = (Get-Date).ToString('o')
    trustedRoot = $trustedNow
}
$envPayload | ConvertTo-Json -Depth 4 | Set-Content -Path $envPath -Encoding UTF8

Write-Host ''
Write-Host '=== 完成。下一步 ===' -ForegroundColor Cyan
Write-Host '  1) 签名打包（会用到上面的 PFX 与密码）：'
Write-Host '       npm run package:signed' -ForegroundColor White
Write-Host '  2) 校验产物签名：'
Write-Host '       npm run sign:verify' -ForegroundColor White
if (-not $trustedNow) {
    Write-Host '  3) 想让本机显示"已验证的发布者"（无管理员，仅当前用户）：'
    Write-Host "       Import-Certificate -FilePath '$cerPath' -CertStoreLocation Cert:\CurrentUser\Root" -ForegroundColor White
    Write-Host ('     （撤销：Get-ChildItem Cert:\CurrentUser\Root | Where-Object { $_.Subject -eq "' + $Subject + '" } | Remove-Item）')
}
Write-Host ''
Write-Host '  注意：PFX 与 signing.env.json 含私钥/密码，切勿入库或外传（.tmp 已被忽略）。' -ForegroundColor Yellow

# 供调用方（如 future 的 sign:setup 包装）消费
[pscustomobject]@{
    Subject     = $Subject
    Thumbprint  = $cert.Thumbprint
    PfxPath     = $pfxPath
    CerPath     = $cerPath
    EnvPath     = $envPath
    TrustedRoot = $trustedNow
}
