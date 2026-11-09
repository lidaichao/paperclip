param([Parameter(Mandatory = $true)][string]$Config)
$ErrorActionPreference = 'Stop'
$configPath = (Resolve-Path $Config).Path
$bridgeConfig = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
if ($bridgeConfig.agents.Count -ne 1) { throw '每个本机工作器只能配置一名智能体。' }
$taskName = 'AliceWorker_' + $bridgeConfig.agents[0].remoteAgentId
$startupLink = Join-Path ([Environment]::GetFolderPath('Startup')) ($taskName + '.lnk')
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
  throw "$taskName 已存在；请先运行 uninstall.ps1，避免覆盖未知配置。"
}
if (Test-Path -LiteralPath $startupLink) {
  throw "$startupLink 已存在；请先运行 uninstall.ps1，避免覆盖未知配置。"
}

& (Join-Path $PSScriptRoot 'doctor.ps1') -Config $configPath -DryRun | Out-Host

$dist = Join-Path $PSScriptRoot 'dist'
New-Item -ItemType Directory -Path $dist -Force | Out-Null
& node.exe (Join-Path $PSScriptRoot 'build.mjs')
if ($LASTEXITCODE -ne 0) { throw '桥接程序构建失败。' }

$runner = Join-Path $PSScriptRoot 'run-hidden.ps1'
$argument = "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runner`" -Config `"$configPath`""
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argument
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
try {
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
    -Principal $principal -Description 'Paperclip 本机智能体安全桥接（显式安装）' -ErrorAction Stop | Out-Null
  Write-Output "已注册 $taskName；将在下次登录后隐藏运行。"
} catch [System.UnauthorizedAccessException] {
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($startupLink)
  $shortcut.TargetPath = (Get-Command powershell.exe).Source
  $shortcut.Arguments = $argument
  $shortcut.WorkingDirectory = $PSScriptRoot
  $shortcut.WindowStyle = 7
  $shortcut.Description = 'Paperclip 本机智能体安全桥接（当前用户隐藏启动）'
  $shortcut.Save()
  Write-Output "任务计划程序无权限；已安装当前用户隐藏启动项 $taskName。"
}
