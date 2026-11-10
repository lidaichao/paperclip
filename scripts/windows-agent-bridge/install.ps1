param(
  [Parameter(Mandatory = $true)][string]$Config,
  [switch]$RepairExisting
)
$ErrorActionPreference = 'Stop'
$configPath = (Resolve-Path $Config).Path
$bridgeConfig = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($bridgeConfig.agents.Count -ne 1) { throw '每个本机工作器只能配置一名智能体。' }
$taskName = 'AliceWorker_' + $bridgeConfig.agents[0].remoteAgentId
$startupLink = Join-Path ([Environment]::GetFolderPath('Startup')) ($taskName + '.lnk')
$existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
$existingLink = Test-Path -LiteralPath $startupLink
if (($existingTask -or $existingLink) -and -not $RepairExisting) {
  throw "$taskName 已存在；使用 -RepairExisting 只修复这一名智能体的入口。"
}

$lockPath = [System.IO.Path]::GetFullPath((Join-Path $bridgeConfig.workerHome 'claim-state.json.lock'))
if (Test-Path -LiteralPath $lockPath) {
  $lock = Get-Content -LiteralPath $lockPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($lock.pid)" -ErrorAction SilentlyContinue
  if ($process) { throw "$taskName 仍在运行；先安全停止后再修复入口。" }
  throw "$taskName 存在陈旧锁；必须先核对 claim-state 和服务器租约再人工清理。"
}

$dist = Join-Path $PSScriptRoot 'dist'
New-Item -ItemType Directory -Path $dist -Force | Out-Null
& node.exe (Join-Path $PSScriptRoot 'build.mjs')
if ($LASTEXITCODE -ne 0) { throw '桥接程序构建失败。' }

$supervisorBuild = Join-Path $PSScriptRoot 'supervisor\build.ps1'
& $supervisorBuild
if ($LASTEXITCODE -ne 0) { throw 'Windows 进程监管器构建失败。' }

$launcherSource = Join-Path $dist 'launcher.bundle.mjs'
$bridgeSource = Join-Path $dist 'bridge.bundle.mjs'
$runtimeResources = @(
  'codex-auth-merge-extract.sh',
  'codex-auth-merge-decision.cjs',
  'credential-helper.ps1'
)
$supervisorSource = Join-Path $PSScriptRoot 'supervisor\out\PaperclipRunSupervisor.exe'
foreach ($required in @($launcherSource, $bridgeSource, $supervisorSource) + ($runtimeResources | ForEach-Object { Join-Path $dist $_ })) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "运行文件缺失：$required" }
}

$launcherHash = (Get-FileHash -LiteralPath $launcherSource -Algorithm SHA256).Hash.Substring(0, 12).ToLowerInvariant()
$supervisorHash = (Get-FileHash -LiteralPath $supervisorSource -Algorithm SHA256).Hash.Substring(0, 12).ToLowerInvariant()
$runtimeDir = Join-Path (Join-Path $bridgeConfig.workerHome 'runtime') "$launcherHash-$supervisorHash"
$runtimeDist = Join-Path $runtimeDir 'dist'
New-Item -ItemType Directory -Path $runtimeDist -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'run-hidden.ps1') -Destination (Join-Path $runtimeDir 'run-hidden.ps1') -Force
Copy-Item -LiteralPath $launcherSource -Destination (Join-Path $runtimeDist 'launcher.bundle.mjs') -Force
Copy-Item -LiteralPath $bridgeSource -Destination (Join-Path $runtimeDist 'bridge.bundle.mjs') -Force
foreach ($resource in $runtimeResources) {
  Copy-Item -LiteralPath (Join-Path $dist $resource) -Destination (Join-Path $runtimeDist $resource) -Force
}
$runtimeSupervisor = Join-Path $runtimeDir 'PaperclipRunSupervisor.exe'
Copy-Item -LiteralPath $supervisorSource -Destination $runtimeSupervisor -Force

$runtimeConfig = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
$runtimeConfig.supervisorExecutable = $runtimeSupervisor
$runtimeConfigPath = Join-Path $runtimeDir 'runtime-config.json'
$runtimeConfig | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $runtimeConfigPath -Encoding UTF8

& (Join-Path $PSScriptRoot 'doctor.ps1') -Config $runtimeConfigPath -DryRun | Out-Host

if ($RepairExisting) {
  if ($existingTask) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop }
  if ($existingLink) { Remove-Item -LiteralPath $startupLink -Force -ErrorAction Stop }
}

$runner = Join-Path $runtimeDir 'run-hidden.ps1'
$argument = "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runner`" -Config `"$runtimeConfigPath`""
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argument
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
try {
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
    -Principal $principal -Description 'Paperclip 本机智能体安全桥接（显式安装）' -ErrorAction Stop | Out-Null
  Write-Output "已注册 $taskName；将在下次登录后隐藏运行。"
} catch {
  if ($_.FullyQualifiedErrorId -notlike 'HRESULT 0x80070005,*') { throw }
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($startupLink)
  $shortcut.TargetPath = (Get-Command powershell.exe).Source
  $shortcut.Arguments = $argument
  $shortcut.WorkingDirectory = $runtimeDir
  $shortcut.WindowStyle = 7
  $shortcut.Description = 'Paperclip 本机智能体安全桥接（当前用户隐藏启动）'
  $shortcut.Save()
  Write-Output "任务计划程序无权限；已安装当前用户隐藏启动项 $taskName（运行目录：$runtimeDir）。"
}
