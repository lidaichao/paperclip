param([Parameter(Mandatory = $true)][string]$Config)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$runtime = Join-Path $PSScriptRoot 'dist\launcher.bundle.mjs'
$settings = Get-Content -LiteralPath (Resolve-Path $Config).Path -Raw | ConvertFrom-Json
$logDir = Join-Path $settings.workerHome 'logs'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$stdout = Join-Path $logDir 'bridge.stdout.log'
$stderr = Join-Path $logDir 'bridge.stderr.log'
$process = Start-Process -FilePath (Get-Command node.exe).Source `
  -ArgumentList @($runtime, (Resolve-Path $Config).Path, '--service') `
  -WindowStyle Hidden -PassThru -Wait `
  -RedirectStandardOutput $stdout -RedirectStandardError $stderr
exit $process.ExitCode
