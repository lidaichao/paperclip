$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'resolve-release.ps1')
$lock = Enter-PaperclipLauncherLock
try {
    $release = Resolve-PaperclipRelease
    $paperclipRoot = $script:PaperclipDataRoot
    $listener = @(Get-NetTCPConnection -LocalPort 3100 -State Listen -ErrorAction SilentlyContinue)
    if ($listener.Count -gt 0) {
        foreach ($item in $listener) {
            $existing = Get-CimInstance Win32_Process -Filter "ProcessId=$($item.OwningProcess)"
            $runningRelease = Resolve-PaperclipServerProcess $existing
            if ($runningRelease.directory -ne $release.directory) { throw 'A different Paperclip release is running. Stop it before starting the selected release.' }
        }
        $health = Invoke-RestMethod 'http://127.0.0.1:3100/api/health' -TimeoutSec 5
        if ($health.status -eq 'ok' -and $health.version -eq $script:PaperclipBackendVersion) {
            Write-Output "Paperclip already running ($($release.releaseId)): http://127.0.0.1:3100/LUN/issues"
            return
        }
        throw 'Port 3100 is occupied by an unhealthy or incompatible service.'
    }
    $env:PAPERCLIP_NO_BROWSER = 'true'
    $env:PAPERCLIP_OPEN_ON_LISTEN = 'false'
    $env:PAPERCLIP_HOME = $paperclipRoot
    $logDir = Join-Path $paperclipRoot 'launcher-logs'
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $launchArgs = @(('"' + $release.entrypoint + '"'), 'run', '--data-dir', ('"' + $paperclipRoot + '"'))
    $process = Start-Process -FilePath $script:PaperclipNodePath -ArgumentList $launchArgs -WorkingDirectory $release.directory -WindowStyle Hidden -RedirectStandardOutput "$logDir/$stamp.out.log" -RedirectStandardError "$logDir/$stamp.err.log" -PassThru
    $process.Id | Set-Content -LiteralPath "$paperclipRoot/server.pid"
    for ($attempt = 0; $attempt -lt 45; $attempt++) {
        Start-Sleep -Milliseconds 500
        $process.Refresh()
        if ($process.HasExited) { throw "Paperclip exited. Inspect $logDir/$stamp.err.log" }
        try {
            $health = Invoke-RestMethod 'http://127.0.0.1:3100/api/health' -TimeoutSec 1
            if ($health.status -eq 'ok' -and $health.version -eq $script:PaperclipBackendVersion) {
                Write-Output "Paperclip running ($($release.releaseId), PID $($process.Id)): http://127.0.0.1:3100/LUN/issues"
                return
            }
        } catch {}
    }
    throw "Paperclip is still starting. Inspect $logDir/$stamp.out.log"
} finally { $lock.ReleaseMutex(); $lock.Dispose() }
