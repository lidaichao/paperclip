param([Parameter(Mandatory = $true)][string]$Config)
$ErrorActionPreference = 'Stop'
$configPath = (Resolve-Path $Config).Path
$settings = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
$taskName = 'AliceWorker_' + $settings.agents[0].remoteAgentId
$startupLink = Join-Path ([Environment]::GetFolderPath('Startup')) ($taskName + '.lnk')
$lockPath = [System.IO.Path]::GetFullPath((Join-Path $settings.workerHome 'claim-state.json.lock'))
$bundlePath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'dist\bridge.bundle.mjs'))

if (Test-Path -LiteralPath $lockPath) {
  $lock = Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($lock.pid)" -ErrorAction SilentlyContinue
  if ($process -and $process.CommandLine -like "*$bundlePath*" -and $process.CommandLine -like "*$configPath*") {
    Stop-Process -Id $lock.pid -ErrorAction Stop
  }
}

$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($task) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false }
if (Test-Path -LiteralPath $startupLink) { Remove-Item -LiteralPath $startupLink -Force }
Write-Output "已移除 $taskName；配置、凭据、日志、Alice 和本地 Paperclip 均已保留。"
