param([Parameter(Mandatory = $true)][string]$Config)
$ErrorActionPreference = 'Stop'
$taskName = 'AliceWindowsAgentBridge'
$configPath = (Resolve-Path $Config).Path
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
  throw "$taskName 已存在；请先运行 uninstall.ps1，避免覆盖未知配置。"
}

& (Join-Path $PSScriptRoot 'doctor.ps1') -Config $configPath -DryRun | Out-Host

$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$dist = Join-Path $PSScriptRoot 'dist'
New-Item -ItemType Directory -Path $dist -Force | Out-Null
& node.exe (Join-Path $root 'node_modules\esbuild\bin\esbuild') `
  (Join-Path $PSScriptRoot 'main.ts') --bundle --platform=node --format=esm `
  --packages=external --outfile=(Join-Path $dist 'bridge.bundle.mjs')
if ($LASTEXITCODE -ne 0) { throw '桥接程序构建失败。' }

$runner = Join-Path $PSScriptRoot 'run-hidden.ps1'
$argument = "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runner`" -Config `"$configPath`""
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argument
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
  -Principal $principal -Description 'Alice 本机智能体安全桥接（显式安装）' | Out-Null
Write-Output "已注册 $taskName；将在下次登录后隐藏运行。"
