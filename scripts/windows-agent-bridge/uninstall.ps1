param([Parameter(Mandatory = $true)][string]$Config)
$ErrorActionPreference = 'Stop'
$taskName = 'AliceWindowsAgentBridge'
$configPath = (Resolve-Path $Config).Path
$settings = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$lockPath = [System.IO.Path]::GetFullPath($settings.stateFile + '.lock')
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
Write-Output "已移除 $taskName；配置、凭据、日志、Alice 和本地 Paperclip 均已保留。"
